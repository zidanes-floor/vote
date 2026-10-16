/* Murder on Zidane's Floor — public-site backend.
 *
 * The squad room page was built as a Claude artifact and talks to `window.claude.use(...)` for saving
 * lineups (artifact), votes (db), who is viewing (user) and reading screenshots (sample).
 * On GitHub Pages this file provides the same calls, backed by the club's Google Sheet web app
 * (apps-script/Code.gs); anyone with the link can save, vote and upload. Without a backend URL in
 * config.js the page stays view-only.
 */
(function () {
  'use strict';
  const CFG = window.MOZF_CONFIG || {};
  const API = String(CFG.backendUrl || '').trim();
  const ON = /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(API) || /^http:\/\/localhost(:\d+)?\//.test(API);
  const POLL_MS = 45000;
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  const fail = (code, message) => Object.assign(new Error(message || code), { code });
  const nativeFetch = window.fetch.bind(window);

  let info = { canRead: false };
  let seed = null, server = null, lastEdits = null, lastRev = -1;
  const listeners = [];

  /* ---------- transport ---------- */
  async function getState() {
    const r = await nativeFetch(API + (API.includes('?') ? '&' : '?') + 'action=state&t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw fail('server_error');
    const j = await r.json();
    if (!j.ok) throw fail(j.code || 'server_error');
    return j;
  }
  async function send(body, opts) {
    opts = opts || {};
    let r;
    try {
      r = await nativeFetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: opts.signal });
    } catch (e) { throw fail(e && e.name === 'AbortError' ? 'cancelled' : 'network'); }
    if (!r.ok) throw fail(r.status === 429 ? 'rate_limited' : 'server_error');
    const j = await r.json();
    if (!j.ok) throw fail(j.code || 'server_error', j.message);
    if (j.rev != null) absorb(j);
    return j;
  }

  /* ---------- lineups & member list (the page's data/edits.json) ---------- */
  function merged() {
    const e = { v: 1, plans: Object.assign({}, seed && seed.plans), pending: (seed && seed.pending) || [], hidden: (seed && seed.hidden) || [] };
    if (server) {
      Object.keys(server.plans || {}).forEach(k => { const v = server.plans[k]; if (v == null) delete e.plans[k]; else e.plans[k] = v; });
      const ro = server.roster || {};
      if (Array.isArray(ro.pending)) e.pending = ro.pending;
      if (Array.isArray(ro.hidden)) e.hidden = ro.hidden;
    }
    return e;
  }
  function absorb(state, quiet) {
    server = state;
    if (state.rev === lastRev) return;
    lastRev = state.rev;
    const next = merged();
    const changed = JSON.stringify(next) !== JSON.stringify(lastEdits);
    lastEdits = next;
    emitVotes();
    if (changed && !quiet && typeof window.__mozfRemote === 'function') window.__mozfRemote(next);
  }
  async function loadEdits() {
    seed = await nativeFetch('data/edits.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (ON) { try { absorb(await getState(), true); } catch (e) { /* show the page without club data */ } }
    lastEdits = merged();
    return lastEdits;
  }
  window.fetch = function (u, o) {
    const path = typeof u === 'string' ? u.split('?')[0] : '';
    if (/(^|\/)data\/edits\.json$/.test(path)) {
      return loadEdits().then(e => new Response(JSON.stringify(e), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return nativeFetch(u, o);
  };
  const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  async function publish(files) {
    const txt = files && files['data/edits.json'];
    if (txt == null) return {};
    const next = JSON.parse(txt), base = lastEdits || merged();
    const plans = {}, roster = {};
    new Set([...Object.keys(base.plans || {}), ...Object.keys(next.plans || {})]).forEach(k => {
      const a = (base.plans || {})[k], b = (next.plans || {})[k];
      if (!same(a, b)) plans[k] = b == null ? null : b;
    });
    ['pending', 'hidden'].forEach(k => { if (!same(base[k] || [], next[k] || [])) roster[k] = next[k] || []; });
    if (!Object.keys(plans).length && !Object.keys(roster).length) return {};
    await send({ action: 'patch', plans, roster });
    // Anything other people saved in the meantime comes back with the response; hand it to the page.
    setTimeout(() => { if (typeof window.__mozfRemote === 'function') window.__mozfRemote(lastEdits); }, 0);
    return {};
  }

  /* ---------- votes ---------- */
  function snapshot() {
    return { docs: ((server && server.votes) || []).map(v => ({ id: v._id, exists: true, data: () => { const o = Object.assign({}, v); delete o._id; return o; } })) };
  }
  function emitVotes() { if (server) listeners.forEach(l => { try { l(snapshot()); } catch (e) { /* page error */ } }); }
  const db = {
    collection: () => ({
      onSnapshot(fn, onErr) {
        listeners.push(fn);
        if (server) setTimeout(() => fn(snapshot()), 0);
        else getState().then(s => absorb(s)).catch(e => { if (onErr) onErr({ code: e.code || 'unavailable' }); });
        return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
      }
    }),
    doc: path => ({
      async set(data) {
        const id = String(path).split('/').pop();
        const names = typeof window.__mozfNames === 'function' ? window.__mozfNames(data) : null;
        await send({ action: 'vote', id, vote: data, names });
      }
    })
  };

  /* ---------- screenshots ---------- */
  const toB64 = blob => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); res({ type: blob.type || 'image/jpeg', data: s.slice(s.indexOf(',') + 1) }); };
    fr.onerror = () => rej(fail('image_rejected'));
    fr.readAsDataURL(blob);
  });
  const sample = {
    async limits() { return { images: { maxCount: 3, maxInputBytes: 3.5e6, mediaTypes: ['image/png', 'image/jpeg'] } }; },
    async json(prompt, opts) {
      opts = opts || {};
      const images = await Promise.all((opts.images || []).map(toB64));
      const j = await send({ action: 'read', prompt, images }, { signal: opts.signal });
      return j.json;
    }
  };

  /* ---------- the runtime the page asks for ---------- */
  const deviceId = ls.get('mozf:device') || (() => { const v = 'web-' + Math.random().toString(36).slice(2, 10); ls.set('mozf:device', v); return v; })();
  const user = {
    async isOwner() { return false; },
    async id() { return deviceId; },
    async canEdit() { return ON; },
    async can() { return ON; }
  };
  const ready = ON
    ? nativeFetch(API + (API.includes('?') ? '&' : '?') + 'action=ping', { cache: 'no-store' }).then(r => r.json()).then(j => { if (j && j.ok) info = j; }).catch(() => { /* backend unreachable: view-only */ })
    : Promise.resolve();

  window.claude = {
    open: true,
    async use(name) {
      await ready;
      if (!ON) return null;
      if (name === 'artifact') return { publish };
      if (name === 'user') return user;
      if (name === 'db') return db;
      if (name === 'sample') return info.canRead ? sample : null;
      return null;
    }
  };

  // Keep votes and lineups fresh while the page is open.
  if (ON) {
    const poll = () => { if (document.visibilityState !== 'hidden') getState().then(s => absorb(s)).catch(() => { /* try again next time */ }); };
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  }
})();
