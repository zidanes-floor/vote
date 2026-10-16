/**
 * Murder on Zidane's Floor — club backend for the GitHub Pages site.
 *
 * Lives in a Google Sheet you own (Extensions → Apps Script) and is deployed as a web app that
 * anyone with the link can use. It keeps the club's GW lineups, member-list changes and votes in
 * this spreadsheet, stores the latest Solio projections, and reads FPL team screenshots with
 * Google's Gemini API (free tier).
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
  solio: ['name', 'team', 'price']
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'ping') return out({ ok: true, canRead: !!prop_('GEMINI_API_KEY'), readsLeft: readsLeft_() });
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
