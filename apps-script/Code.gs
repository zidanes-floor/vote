/**
 * Murder on Zidane's Floor — club backend for the GitHub Pages site.
 *
 * Lives in a Google Sheet you own (Extensions → Apps Script) and is deployed as a web app that
 * anyone with the link can use. It keeps the team's GW lineups, member-list changes and votes in
 * this spreadsheet, stores the latest Solio projections, reads FPL team screenshots with
 * Google's Gemini API (free tier), and works out live SKLW scores from the official FPL site
 * (the browser can't call FPL directly, so the page asks this script).
 *
 * Script properties (Project Settings → Script properties):
 *   GEMINI_API_KEY  free key from aistudio.google.com → Get API key (needed only for screenshot reading)
 *   GEMINI_MODEL    optional; defaults to trying gemini-flash-latest, then gemini-2.5-flash, then gemini-flash-lite-latest
 *   READ_LIMIT      optional, screenshot reads allowed per day (default 100)
 */

const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];
const TABS = {
  plans: ['manager_id', 'lineup_json', 'updated'],
  roster: ['key', 'value_json', 'updated'],
  votes: ['vote_id', 'gameweek', 'voter', 'goalkeeper', 'strikers', 'bench', 'submitted', 'vote_json'],
  solio: ['name', 'team', 'price'],
  picks: ['gameweek', 'manager_id', 'picks', 'fetched']
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'ping') return out({ ok: true, canRead: !!prop_('GEMINI_API_KEY'), readsLeft: readsLeft_(), live: 1 });
  if (p.action === 'solio') return out(Object.assign({ ok: true }, solio_()));
  return out(Object.assign({ ok: true }, state_()));
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, code: 'bad_request' }); }
  try {
    switch (body.action) {
      case 'patch': return out(patch_(body));
      case 'vote': return out(vote_(body));
      case 'read': return out(readShot_(body));
      case 'solio': return out(saveSolio_(body));
      case 'live': return out(live_(body));
      default: return out({ ok: false, code: 'bad_request' });
    }
  } catch (err) {
    return out({ ok: false, code: 'server_error', message: String((err && err.message) || err).slice(0, 300) });
  }
}

/* ---------- lineups, member list, votes ---------- */

function state_() {
  const plans = {};
  rows_('plans').forEach(r => { if (r[0] !== '') plans[String(r[0])] = parse_(r[1]); });
  const roster = {};
  rows_('roster').forEach(r => { if (r[0] !== '') roster[String(r[0])] = parse_(r[1]); });
  const votes = rows_('votes').slice(-400).map(r => {
    const v = parse_(r[7]);
    return v && typeof v === 'object' ? Object.assign({ _id: String(r[0]) }, v) : null;
  }).filter(Boolean);
  return { rev: Number(prop_('REV') || 0), plans: plans, roster: roster, votes: votes };
}

function patch_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const plans = body.plans || {};
    Object.keys(plans).forEach(mid => {
      if (!/^\d{1,9}$/.test(mid)) throw new Error('bad manager id');
      const json = JSON.stringify(plans[mid] === undefined ? null : plans[mid]);
      if (json.length > 20000) throw new Error('lineup too large');
      upsert_('plans', mid, [mid, json, new Date()]);
    });
    const roster = body.roster || {};
    ['pending', 'hidden'].forEach(k => {
      if (roster[k] === undefined) return;
      if (!Array.isArray(roster[k]) || roster[k].length > 60) throw new Error('bad ' + k);
      const clean = roster[k].map(String).filter(x => /^\d{1,9}$/.test(x));
      upsert_('roster', k, [k, JSON.stringify(clean), new Date()]);
    });
    bump_();
  } finally { lock.releaseLock(); }
  return Object.assign({ ok: true }, state_());
}

function vote_(body) {
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { ok: false, code: 'bad_request' };
  const v = body.vote || {};
  const json = JSON.stringify(v);
  if (json.length > 4000) return { ok: false, code: 'bad_request' };
  const n = body.names || {};
  const list = a => (Array.isArray(a) ? a : []).join(', ');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    upsert_('votes', id, [id, v.gw || '', n.as || v.as || '', list(n.gk || v.gk), list(n.st || v.st), list(n.bench || v.bench), new Date(), json]);
    bump_();
  } finally { lock.releaseLock(); }
  return Object.assign({ ok: true }, state_());
}

/* ---------- Solio projections (sent by the scheduled reader, read by the GitHub sync) ---------- */

function saveSolio_(body) {
  const d = body.data || {};
  const gws = Array.isArray(d.gws) ? d.gws.map(Number).filter(g => g > 0 && g < 60).slice(0, 10) : [];
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!gws.length || rows.length < 100 || rows.length > 1500) return { ok: false, code: 'bad_request' };
  const clean = rows.map(r => [String(r[0]).slice(0, 40), String(r[1]).slice(0, 5), Number(r[2]) || 0].concat(gws.map((g, k) => Number(r[3 + k]) || 0)));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_('solio');
    sh.clearContents();
    const header = TABS.solio.concat(gws.map(g => 'GW' + g));
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.getRange(2, 1, clean.length, header.length).setValues(clean);
    PropertiesService.getScriptProperties().setProperty('SOLIO_META', JSON.stringify({ fetched: String(d.fetched || new Date().toISOString()), gws: gws, n: clean.length }));
  } finally { lock.releaseLock(); }
  return { ok: true, saved: clean.length };
}

function solio_() {
  const meta = parse_(prop_('SOLIO_META') || 'null');
  if (!meta) return { fetched: null, gws: [], rows: [] };
  const sh = sheet_('solio'), n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 3 + meta.gws.length).getValues() : [];
  return { source: 'Solio', url: 'https://fpl.solioanalytics.com', fetched: meta.fetched, gws: meta.gws, rows: rows };
}

/* ---------- screenshot reading (Gemini) ---------- */

function readShot_(body) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) return { ok: false, code: 'not_declared' };
  const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  const prompt = String(body.prompt || '');
  if (!images.length || prompt.length < 50 || prompt.length > 80000 || prompt.indexOf('Fantasy Premier League') < 0) return { ok: false, code: 'bad_request' };
  for (const im of images) {
    if (!/^image\/(png|jpeg|webp)$/.test(im.type || '') || typeof im.data !== 'string' || im.data.length > 6.5e6) return { ok: false, code: 'image_rejected' };
  }
  if (readsLeft_() <= 0) return { ok: false, code: 'rate_limited' };
  countRead_();

  const parts = images.map(im => ({ inline_data: { mime_type: im.type, data: im.data } }));
  parts.push({ text: prompt });
  const payload = JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  const models = prop_('GEMINI_MODEL') ? [prop_('GEMINI_MODEL')] : MODELS;
  let last = { ok: false, code: 'server_error' };
  for (const model of models) {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true, payload: payload
    });
    const status = res.getResponseCode(), text = res.getContentText();
    if (status === 404 || status === 429 || status >= 500) { last = { ok: false, code: status === 429 ? 'rate_limited' : 'server_error', message: text.slice(0, 200) }; continue; }
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(text)) return { ok: false, code: 'bad_key' };
    if (status === 401 || status === 403) return { ok: false, code: 'bad_key' };
    if (status >= 400) return { ok: false, code: 'server_error', message: text.slice(0, 300) };
    const data = JSON.parse(text);
    const cand = (data.candidates || [])[0];
    if (!cand) return { ok: false, code: (data.promptFeedback && data.promptFeedback.blockReason) ? 'refused' : 'empty_completion' };
    const answer = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('').trim();
    if (!answer) return { ok: false, code: cand.finishReason === 'SAFETY' ? 'refused' : 'empty_completion' };
    const a = answer.indexOf('{'), b = answer.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, code: 'invalid_json' };
    try { return { ok: true, model: model, json: JSON.parse(answer.slice(a, b + 1)) }; } catch (err) { return { ok: false, code: 'invalid_json' }; }
  }
  return last;
}

function readsLeft_() {
  const limit = Number(prop_('READ_LIMIT') || 100);
  return Math.max(0, limit - Number(prop_(dayKey_()) || 0));
}
function countRead_() {
  const k = dayKey_();
  PropertiesService.getScriptProperties().setProperty(k, String(Number(prop_(k) || 0) + 1));
}
function dayKey_() { return 'READS_' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'); }

/* ---------- SKLW live scores, worked out from the official FPL site ----------
 * The page sends the gameweek and the FPL IDs in the SKLW team sheets. Each manager is scored the way
 * SKLW counts it: FPL points with auto-subs and provisional bonus, captain ×2 (a Triple Captain counts
 * as a normal captain and a Bench Boost bench doesn't count), minus hits. Also returns how many of
 * each manager's players are still to play. FPL's live numbers are reused for a minute between
 * viewers; each manager's GW team is fetched from FPL once and kept in the "picks" tab. */

const FPL_API = 'https://fantasy.premierleague.com/api/';
const FPL_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; zidanes-floor/1.0)', Accept: 'application/json' };
const LIVE_TTL = 60;          // seconds
const PICKS_PER_CALL = 90;    // GW teams fetched per request; the rest arrive with the next refresh

function live_(body) {
  const gw = Number(body.gw);
  if (!(gw >= 1 && gw <= 38 && gw % 1 === 0)) return { ok: false, code: 'bad_request' };
  const ids = [], seen = {};
  (Array.isArray(body.ids) ? body.ids : []).forEach(x => { const n = Number(x); if (n > 0 && n < 1e9 && n % 1 === 0 && !seen[n]) { seen[n] = 1; ids.push(n); } });
  if (ids.length > 1200) return { ok: false, code: 'bad_request' };
  const boot = fplBoot_();
  const dl = boot.deadlines[gw];
  if (!dl || new Date(dl) > new Date()) return { ok: true, gw: gw, started: false };
  const base = liveBase_(gw, boot);
  const picks = livePicks_(gw, ids);
  const m = {};
  let waiting = 0;
  ids.forEach(id => {
    const p = picks[id];
    if (p === undefined) { m[id] = null; waiting++; } else m[id] = p ? sklwScore(p, base) : 0;
  });
  return { ok: true, gw: gw, started: true, at: base.at, fx: base.fx, m: m, waiting: waiting };
}

function fplGet_(path) {
  const r = UrlFetchApp.fetch(FPL_API + path, { headers: FPL_HEADERS, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('FPL answered ' + r.getResponseCode() + ' (' + path + ')');
  return JSON.parse(r.getContentText());
}

// Player → [club, position] and the GW deadlines, kept for 6 hours.
function fplBoot_() {
  const cache = CacheService.getScriptCache();
  const hit = parse_(cache.get('fpl:boot') || 'null');
  if (hit) return hit;
  const b = fplGet_('bootstrap-static/');
  const boot = { el: {}, deadlines: {} };
  b.elements.forEach(e => { boot.el[e.id] = [e.team, e.element_type]; });
  b.events.forEach(ev => { boot.deadlines[ev.id] = ev.deadline_time; });
  cache.put('fpl:boot', JSON.stringify(boot), 21600);
  return boot;
}

function liveBase_(gw, boot) {
  const cache = CacheService.getScriptCache(), key = 'fpl:live:' + gw;
  const hit = parse_(cache.get(key) || 'null');
  if (hit) return hit;
  const res = UrlFetchApp.fetchAll(['event/' + gw + '/live/', 'fixtures/?event=' + gw].map(p => ({ url: FPL_API + p, headers: FPL_HEADERS, muteHttpExceptions: true })));
  res.forEach(r => { if (r.getResponseCode() !== 200) throw new Error('FPL answered ' + r.getResponseCode()); });
  const base = sklwBase(JSON.parse(res[0].getContentText()), JSON.parse(res[1].getContentText()), boot.el);
  base.at = new Date().toISOString();
  try { cache.put(key, JSON.stringify(base), LIVE_TTL); } catch (e) { /* not cached: the next viewer fetches again */ }
  return base;
}

// Each manager's GW team as "e1,…,e15|captain|vice|chip|hit" ('' = no team this GW).
function livePicks_(gw, ids) {
  const cache = CacheService.getScriptCache(), key = 'fpl:picks:' + gw;
  let map = parse_(cache.get(key) || 'null');
  if (!map) {
    map = {};
    rows_('picks').forEach(r => { if (Number(r[0]) === gw) map[String(r[1])] = String(r[2]); });
  }
  const missing = ids.filter(id => map[id] === undefined);
  if (!missing.length) return map;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return map;   // another viewer's request is fetching them right now
  try {
    const batch = missing.slice(0, PICKS_PER_CALL);
    const res = UrlFetchApp.fetchAll(batch.map(id => ({ url: FPL_API + 'entry/' + id + '/event/' + gw + '/picks/', headers: FPL_HEADERS, muteHttpExceptions: true })));
    const rows = [];
    res.forEach((r, i) => {
      const code = r.getResponseCode();
      if (code === 200) { const p = sklwPack(JSON.parse(r.getContentText())); map[batch[i]] = p; rows.push([gw, batch[i], p, new Date()]); }
      else if (code === 404) map[batch[i]] = '';
    });
    if (rows.length) {
      const sh = sheet_('picks');
      if (sh.getLastRow() > 5000) {   // keep the tab small: drop older gameweeks
        const keep = rows_('picks').filter(r => Number(r[0]) === gw);
        sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
        if (keep.length) sh.getRange(2, 1, keep.length, 4).setValues(keep);
      }
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
    }
    try { cache.put(key, JSON.stringify(map), 21600); } catch (e) { /* read from the tab next time */ }
  } finally { lock.releaseLock(); }
  return map;
}

/* Pure scoring functions (no Google services), also used by the tests. */

// From FPL's live points and fixtures: player id → [points incl. provisional bonus, minutes, state, position]
// where state is 0 = still to play, 1 = playing now, 2 = done (or no game this GW).
function sklwBase(live, fixtures, el) {
  const fx = {}, byTeam = {}, bonus = {};
  let done = 0, now = 0;
  fixtures.forEach(f => {
    const st = (f.finished || f.finished_provisional) ? 2 : f.started ? 1 : 0;
    if (st === 2) done++; else if (st === 1) now++;
    fx[f.id] = st;
    [f.team_h, f.team_a].forEach(t => { (byTeam[t] = byTeam[t] || []).push(f.id); });
    const stat = id => (f.stats || []).filter(s => s.identifier === id)[0];
    const conf = stat('bonus'), bps = stat('bps');
    if (!f.started || !bps || (conf && (conf.h.length || conf.a.length))) return;
    // Provisional bonus from BPS: 3-2-1, ties share (two tied for first get 3 each and the next gets 1).
    const list = bps.h.concat(bps.a).sort((x, y) => y.value - x.value);
    let rank = 1, i = 0;
    while (i < list.length && rank <= 3) {
      let j = i;
      while (j < list.length && list[j].value === list[i].value) j++;
      for (let k = i; k < j; k++) bonus[list[k].element] = (bonus[list[k].element] || 0) + (4 - rank);
      rank += j - i; i = j;
    }
  });
  const e = {};
  (live.elements || []).forEach(p => {
    const info = el[p.id] || [0, 0];
    const sts = (byTeam[info[0]] || []).map(id => fx[id]);
    const state = sts.every(s => s === 2) ? 2 : sts.some(s => s === 1) ? 1 : 0;
    const s = p.stats || {};
    e[p.id] = [(s.total_points || 0) + (s.bonus ? 0 : (bonus[p.id] || 0)), s.minutes || 0, state, info[1]];
  });
  return { fx: { n: fixtures.length, done: done, now: now }, e: e };
}

function sklwPack(d) {
  const p = (d.picks || []).slice().sort((a, b) => a.position - b.position);
  const find = k => (p.filter(x => x[k])[0] || {}).element || 0;
  return p.map(x => x.element).join(',') + '|' + find('is_captain') + '|' + find('is_vice_captain') + '|' + (d.active_chip || '') + '|' + (((d.entry_history || {}).event_transfers_cost) || 0);
}

// → [SKLW points, players left to play, playing now, captain id, captain's points, hit, chip]
function sklwScore(packed, base) {
  const parts = String(packed).split('|');
  const ids = parts[0].split(',').map(Number);
  const c = Number(parts[1]), v = Number(parts[2]), chip = parts[3] || '', hit = Number(parts[4]) || 0;
  const E = id => base.e[id] || [0, 0, 2, 0];
  const pos = id => E(id)[3];
  const out = id => E(id)[2] === 2 && E(id)[1] === 0;   // all their games are done and they didn't play
  const team = ids.slice(0, 11), bench = ids.slice(11);
  let waiting = 0;
  if (chip !== 'bboost') {
    const used = {};
    for (let i = 0; i < team.length; i++) {
      if (!out(team[i])) continue;
      const gk = pos(team[i]) === 1;
      for (let k = 0; k < bench.length; k++) {
        const b = bench[k];
        if (used[b] || (pos(b) === 1) !== gk) continue;
        if (!gk) {
          const t = team.slice(); t[i] = b;
          const n = ty => t.filter(x => pos(x) === ty).length;
          if (n(2) < 3 || n(4) < 1) continue;   // formation must stay valid
        }
        if (E(b)[1] > 0) { team[i] = b; used[b] = 1; break; }
        if (E(b)[2] !== 2) { used[b] = 1; waiting++; break; }   // sub still to play: they'd come on
      }
    }
  }
  const inTeam = id => team.indexOf(id) >= 0;
  const cap = inTeam(c) && !out(c) ? c : inTeam(v) && !out(v) ? v : 0;
  let pts = cap ? E(cap)[0] : 0, left = waiting, now = 0;
  team.forEach(id => { const x = E(id); pts += x[0]; if (x[2] !== 2) left++; if (x[2] === 1) now++; });
  return [pts - hit, left, now, cap, cap ? E(cap)[0] : 0, hit, chip];
}

/* ---------- helpers ---------- */

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function parse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function bump_() { PropertiesService.getScriptProperties().setProperty('REV', String(Number(prop_('REV') || 0) + 1)); }

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(name) {
  const sh = sheet_(name), n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, TABS[name].length).getValues() : [];
}
function upsert_(name, key, row) {
  const sh = sheet_(name), n = sh.getLastRow() - 1;
  if (n > 0) {
    const keys = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === String(key)) { sh.getRange(i + 2, 1, 1, row.length).setValues([row]); return; }
    }
  }
  sh.appendRow(row);
}

/** Optional: run once from the editor (choose "setup" → Run) to create the tabs and check the key. */
function setup() {
  Object.keys(TABS).forEach(sheet_);
  Logger.log('Gemini key set: %s · screenshot reads left today: %s', !!prop_('GEMINI_API_KEY'), readsLeft_());
}
