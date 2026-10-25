// Pull the club's FPL data from the official FPL API into raw/catalog.json and raw/managers.json.
// Runs in GitHub Actions (node scripts/sync.mjs); scripts/build.py then merges it into site/data/fpl.json.
// Member IDs come from raw/club.json plus any IDs added on the site (the backend's "pending" list).
// Solio projections (sent to the backend by the scheduled Solio reader) are matched to FPL players into raw/xp_solio.json.
import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://fantasy.premierleague.com/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; zidanes-floor-sync/1.0; +https://github.com/zidanes-floor/vote)', Accept: 'application/json' };

async function j(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers: HEADERS });
      if (r.ok) return r.json();
      if (r.status === 404) return { __err: 404 };
      if (i === tries - 1) return { __err: r.status };
    } catch (e) { if (i === tries - 1) return { __err: String(e.message || e) }; }
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
}

async function backendUrl() {
  try { const cfg = await readFile('site/config.js', 'utf8'); return (cfg.match(/backendUrl:\s*'([^']*)'/) || [])[1] || ''; } catch (e) { return ''; }
}

async function clubIds() {
  const club = JSON.parse(await readFile('raw/club.json', 'utf8'));
  const ids = club.map(c => c.id);
  try {
    const url = await backendUrl();
    if (url) {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=state');
      const s = await r.json();
      const pending = ((s.roster || {}).pending || []).map(Number).filter(n => n > 0 && !ids.includes(n));
      if (pending.length) console.log('IDs added on the site:', pending.join(', '));
      ids.push(...pending);
    }
  } catch (e) { console.log('Backend not reachable, using raw/club.json only:', e.message); }
  return ids;
}

const b = await j('/bootstrap-static/');
if (b.__err || !Array.isArray(b.events)) { console.error('FPL bootstrap failed:', b.__err || 'unexpected response'); process.exit(1); }
const cur = b.events.find(e => e.is_current) || b.events.filter(e => e.finished).pop();
const nxt = b.events.find(e => e.is_next) || null;
const live = await j(`/event/${cur.id}/live/`);
const fx = await j('/fixtures/?future=1');
if (live.__err || fx.__err) { console.error('FPL live/fixtures failed:', live.__err, fx.__err); process.exit(1); }
const gw = {}; live.elements.forEach(e => { gw[e.id] = e.stats.total_points; });
const flag = p => { if (p.status === 'a') return ''; const s = p.status; return (s === 'd' || s === 'i' || s === 's') ? (s + (p.chance_of_playing_next_round ?? '') + ':' + (p.news || '')).slice(0, 48) : s; };
const players = b.elements.map(p => [p.id, p.web_name.replace(/\|/g, '/'), p.team, p.element_type, p.now_cost, p.total_points,
  Math.round(parseFloat(p.form || 0) * 10), Math.round(parseFloat(p.selected_by_percent || 0) * 10), Math.round(parseFloat(p.ep_next || 0) * 10), gw[p.id] ?? 0, flag(p)]);
const start = nxt ? nxt.id : cur.id + 1;
const fixtures = {}; b.teams.forEach(t => { fixtures[t.id] = []; });
fx.filter(f => f.event && f.event >= start && f.event < start + 5)
  .sort((a, c) => a.event - c.event || new Date(a.kickoff_time) - new Date(c.kickoff_time))
  .forEach(f => { fixtures[f.team_h].push([f.event, f.team_a, 1, f.team_h_difficulty]); fixtures[f.team_a].push([f.event, f.team_h, 0, f.team_a_difficulty]); });
const y = b.events[0].deadline_time.slice(0, 4);
const catalog = {
  v: 1,
  meta: { season: y + '/' + (parseInt(y.slice(2), 10) + 1), gw: cur.id, gwFinished: cur.finished, gwAvg: cur.average_entry_score, gwHigh: cur.highest_score, next: nxt ? nxt.id : null, deadline: nxt ? nxt.deadline_time : null, synced: new Date().toISOString() },
  teams: b.teams.map(t => [t.id, t.short_name, t.name]), fixtures, players
};

const one = async id => {
  const e = await j(`/entry/${id}/`);
  if (e.__err) return { id, err: e.__err };
  const [h, p, t] = await Promise.all([j(`/entry/${id}/history/`), j(`/entry/${id}/event/${cur.id}/picks/`), j(`/entry/${id}/transfers/`)]);
  return {
    id, mgr: `${e.player_first_name || ''} ${e.player_last_name || ''}`.trim(), team: e.name,
    ovPts: e.summary_overall_points, ovRank: e.summary_overall_rank, bank: e.last_deadline_bank, value: e.last_deadline_value, start: e.started_event,
    hist: (h.current || []).map(x => [x.event, x.points, x.total_points, x.rank, x.overall_rank, x.event_transfers, x.event_transfers_cost, x.points_on_bench, x.value, x.bank]),
    chips: (h.chips || []).map(c => [c.name, c.event]),
    picks: p.__err ? null : p.picks.map(x => [x.element, x.position, x.multiplier, x.is_captain ? 1 : 0, x.is_vice_captain ? 1 : 0]),
    chip: p.__err ? null : (p.active_chip || null),
    subs: p.__err ? [] : (p.automatic_subs || []).map(s => [s.element_in, s.element_out]),
    tr: Array.isArray(t) ? t.filter(x => x.event === cur.id).map(x => [x.element_in, x.element_out]) : []
  };
};
const ids = await clubIds();
const managers = [];
for (let i = 0; i < ids.length; i += 4) managers.push(...await Promise.all(ids.slice(i, i + 4).map(one)));
const bad = managers.filter(m => m.err);
if (bad.length === managers.length) { console.error('Every manager failed to load; keeping the old data.'); process.exit(1); }

await writeFile('raw/catalog.json', JSON.stringify(catalog));
await solio(b);
await sklwTeams(cur).catch(e => console.log('SKLW teams: skipped,', e.message));
await writeFile('raw/managers.json', JSON.stringify(managers));
console.log(`GW${cur.id}${cur.finished ? ' (finished)' : ''}, next GW${nxt ? nxt.id : '-'}; ${players.length} players; ${managers.length} managers` + (bad.length ? `; failed: ${bad.map(m => m.id + ':' + m.err).join(', ')}` : ''));

// ---------- Solio: names from the projections table → FPL element ids ----------
async function solio(b) {
  const url = await backendUrl();
  if (!url) return;
  let d;
  try { d = await (await fetch(url + (url.includes('?') ? '&' : '?') + 'action=solio')).json(); } catch (e) { console.log('Solio: backend not reachable:', e.message); return; }
  if (!d.ok || !d.rows || d.rows.length < 100) { console.log('Solio: nothing stored yet'); return; }
  let prev = null; try { prev = JSON.parse(await readFile('raw/xp_solio.json', 'utf8')); } catch (e) { /* first run */ }
  if (prev && prev.fetched && d.fetched && prev.fetched >= d.fetched) { console.log('Solio: no newer projections (' + d.fetched + ')'); return; }
  const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ø/gi, 'o').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z]/g, '');
  const team = Object.fromEntries(b.teams.map(t => [t.short_name, t.id]));
  const els = b.elements.map(p => ({ id: p.id, k: fold(p.web_name), t: p.team, c: p.now_cost / 10 }));
  const used = new Set(), rows = [];
  let missed = [];
  for (const r of d.rows) {
    const [name, tm, price] = r, k = fold(name), t = team[tm];
    const pool = els.filter(e => e.t === t && !used.has(e.id));
    let hit = pool.filter(e => e.k === k);
    if (hit.length > 1) hit = hit.filter(e => Math.abs(e.c - price) < 0.05);
    if (hit.length !== 1) { const loose = pool.filter(e => e.k.length > 2 && (e.k.includes(k) || k.includes(e.k))); if (loose.length === 1) hit = loose; }
    if (hit.length !== 1) { const byPrice = pool.filter(e => Math.abs(e.c - price) < 0.05 && e.k[0] === k[0]); if (byPrice.length === 1) hit = byPrice; }
    if (hit.length !== 1) { missed.push(name + ' ' + tm); continue; }
    used.add(hit[0].id);
    rows.push([hit[0].id, ...d.gws.map((g, i) => Math.round((Number(r[3 + i]) || 0) * 100) / 10)]);
  }
  await writeFile('raw/xp_solio.json', JSON.stringify({ source: 'Solio', url: 'https://fpl.solioanalytics.com', fetched: d.fetched, gws: d.gws, rows }));
  console.log(`Solio: ${rows.length} players for GW${d.gws.join('/')}, read ${d.fetched}` + (missed.length ? `; unmatched ${missed.length}: ${missed.slice(0, 12).join(', ')}` : ''));
}

// ---------- SKLW: every manager in this gameweek's SKLW team sheets → their FPL team ----------
// The team sheets are the tournament's public live score sheet (one tab per match). The teams are fixed once the
// deadline passes, so each is fetched once per gameweek into site/data/sklw.json; the site's web app uses it for
// live scoring when FPL is slow to answer it, and the page uses it to list the players left to play.
async function sklwTeams(cur) {
  const LIVE = '1E8TGqNufhI9YDaWLoet_SIhjYDoZQbKNQR7ivwUIXFQ';
  const sheet = async name => {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${LIVE}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`the ${name} sheet answered ${r.status}`);
    return parseCSV(await r.text());
  };
  const ls = await sheet('LiveScores');
  const gw = Number(((ls[0] || [])[2] || '').trim());
  if (gw !== cur.id) { console.log(`SKLW teams: the live sheet is on GW${gw || '?'} and FPL on GW${cur.id}, nothing to collect`); return; }
  const tabs = ls.filter(r => /^M\d+$/.test((r[2] || '').trim()) && (r[3] || '').trim() && (r[7] || '').trim()).map(r => r[2].trim());
  const ids = new Set();
  for (const tab of tabs) {
    const rows = await sheet(tab);
    const s = rows.findIndex(r => /^\d+$/.test((r[2] || '').trim()) && (r[3] || '').trim());
    if (s < 1) continue;
    rows.slice(s, s + 17).forEach(r => [r[2], r[11]].forEach(v => { if (/^\d+$/.test((v || '').trim())) ids.add(Number(v)); }));
  }
  let prev = null;
  try { prev = JSON.parse(await readFile('site/data/sklw.json', 'utf8')); } catch (e) { /* first run */ }
  const picks = prev && prev.gw === gw && prev.picks ? prev.picks : {};
  const todo = [...ids].filter(id => picks[id] === undefined);
  let got = 0, failed = 0;
  const pack = d => {
    const p = (d.picks || []).slice().sort((a, c) => a.position - c.position);
    const find = k => (p.find(x => x[k]) || {}).element || 0;
    return p.map(x => x.element).join(',') + '|' + find('is_captain') + '|' + find('is_vice_captain') + '|' + (d.active_chip || '') + '|' + ((d.entry_history || {}).event_transfers_cost || 0);
  };
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async id => {
      const d = await j(`/entry/${id}/event/${gw}/picks/`);
      if (d.__err === 404) picks[id] = '';
      else if (d.__err) failed++;
      else { picks[id] = pack(d); got++; }
    }));
  }
  if (!todo.length && prev && prev.gw === gw) { console.log(`SKLW teams: all ${ids.size} GW${gw} teams already collected`); return; }
  await writeFile('site/data/sklw.json', JSON.stringify({ gw, fetched: new Date().toISOString(), matches: tabs.length, picks }));
  console.log(`SKLW teams: GW${gw}, ${tabs.length} matches, ${ids.size} managers; fetched ${got} now` + (failed ? `, ${failed} failed (next run retries)` : ''));
}

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
