// Solio reader — run on https://fpl.solioanalytics.com (signed in) by the scheduled Claude task.
// Reads the planner's Projections table (Name, Team, Price, GW columns) and sends it to the club
// backend, where the GitHub sync picks it up. Usage: paste the file, then `await __solioSend(BACKEND_URL)`.
window.__solioScrape = async function () {
  // MessageChannel yields keep working when the page is in a hidden pane (timers are throttled there).
  const mc = new MessageChannel(); let wake = null; mc.port1.onmessage = () => wake && wake();
  const tick = () => new Promise(r => { wake = r; mc.port2.postMessage(0); });
  const wait = async ms => { const t = performance.now() + ms; while (performance.now() < t) await tick(); };
  let sc = null;
  for (let i = 0; i < 300; i++) { sc = document.querySelector('.dvn-scroller'); if (sc && document.querySelector('table tbody tr')) break; sc = null; await wait(100); }
  if (!sc) throw new Error('Solio projections table not found (signed out, or the Projections tab is not showing)');
  const table = () => document.querySelector('table');
  const head = [...table().querySelectorAll('thead th, thead td')].map(t => t.textContent.trim());
  const gwCols = head.map((h, i) => [h, i]).filter(([h]) => /^GW\d+$/.test(h));
  const iName = head.indexOf('Name'), iTeam = head.indexOf('Team'), iPrice = head.indexOf('Price');
  if (iName < 0 || iTeam < 0 || !gwCols.length) throw new Error('Unexpected table columns: ' + head.join(','));
  const rows = new Map();
  const first = () => (table().querySelector('tbody tr td') || {}).textContent;
  const grab = () => table().querySelectorAll('tbody tr').forEach(tr => {
    const c = [...tr.children].map(td => td.textContent.trim());
    if (!c[iName] || gwCols.some(([, i]) => c[i] === '' || isNaN(parseFloat(c[i])))) return;
    rows.set(c[iName] + '|' + c[iTeam] + '|' + c[iPrice], [c[iName], c[iTeam], +c[iPrice], ...gwCols.map(([, i]) => Math.round(parseFloat(c[i]) * 100) / 100)]);
  });
  const go = async y => { const before = first(); sc.scrollTop = y; sc.dispatchEvent(new Event('scroll')); const t0 = performance.now(); while (performance.now() - t0 < 3000 && first() === before) await wait(40); await wait(120); grab(); };
  sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); await wait(300); grab();
  for (let y = 480; y < sc.scrollHeight; y += 480) await go(y);
  await go(sc.scrollHeight); sc.scrollTop = 0;
  return { source: 'Solio', url: 'https://fpl.solioanalytics.com', fetched: new Date().toISOString(), gws: gwCols.map(([h]) => +h.slice(2)), rows: [...rows.values()] };
};
window.__solioSend = async function (backendUrl) {
  const data = await window.__solioScrape();
  if (data.rows.length < 300) throw new Error('Only ' + data.rows.length + ' players read; not sending');
  const r = await fetch(backendUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'solio', data }) });
  const j = await r.json();
  return { sent: data.rows.length, gws: data.gws, backend: j };
};
