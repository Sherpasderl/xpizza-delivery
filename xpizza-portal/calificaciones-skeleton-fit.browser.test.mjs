// Calificaciones LOADING at a 390 px phone (post-RC SBS 11-16, rule 16b): the skeleton must fit the column — the page never scrolls
// sideways. The fixed «52ch» text bone was a min-content width, and the phone grid (`.app` 1fr = minmax(auto,1fr)) grew to it: the
// document was 549 px wide at 390 (slot-1114 run 20261116-005823, calificaciones-step2 loading@390, fit-probe hscroll).
// Real headless Chrome over the shipped index.html + styles.css + modules (the runner of category-name.browser.test.mjs, verbatim); only
// auth and the network are stubbed, and the reviews calls NEVER answer, so the page holds its loading state. The probe reads
// documentElement.scrollWidth against documentElement.clientWidth (CDP mobile emulation grows innerWidth to the content) with a POSITIVE
// CONTROL: an uncapped 52ch bone dropped into the same list must make the same probe go red. No browser → the suite FAILS (never skips).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// the three modules that reach the Firebase CDN, replaced; every other file is the shipped one
const STUBS = {
  'firebase.js': 'export const auth = null;\n',
  'invite-mail.js': 'export const sendInviteLink = async () => {};\n',
  'auth.js': 'export const login = async () => {}; export const logout = async () => {}; export const authErrorMessage = () => "";\nexport const token = async () => "TK"; export const watchAuth = (cb) => { setTimeout(() => cb({ uid: "uCalifSk01", email: "dueno@marca-s.test" }), 20); };\n',
};

let server, chrome, ws, base, profile;
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
before(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    if (STUBS[rel] !== undefined) { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }); res.end(STUBS[rel]); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const bin = chromeBin();
  assert.ok(fs.existsSync(bin), `🔴 no headless Chrome at ${bin} (set CHROME_BIN): the real-render checks cannot run`);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-califsk-'));
  chrome = spawn(bin, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const mm = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (mm) resolve(mm[1]); }); });
  ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('error', () => {});   // a socket error at teardown is not a test result
  ws.addEventListener('message', (e) => { const mm = JSON.parse(e.data); if (mm.id && pending.has(mm.id)) { const p = pending.get(mm.id); pending.delete(mm.id); if (mm.error) p.reject(new Error(mm.error.message)); else p.resolve(mm.result); } });
});
after(async () => {
  pending.clear();
  try { ws && ws.close(); } catch (_) { /* closing */ }
  if (chrome) { const gone = new Promise((r) => chrome.once('exit', r)); chrome.kill(); await gone; }   // the child this suite spawned, by its handle
  if (server) server.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function openPage(url, mock, width = 1280) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mock }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  const close = () => send('Target.closeTarget', { targetId });
  const reload = () => send('Page.reload', {}, sessionId);
  return { ev, close, reload };
}

const MOCK = `(() => {
  // the branch list in the CURRENT discovery shape (portal-fonts.cdp.mjs's E1: owner caps, three branches, membership_writes_enabled)
  const CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set',
    'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.pause', 'team.invite', 'team.revoke', 'brand.settings'];
  const row = ([rid, name]) => ({ rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: CAPS, name, identity_version: 2,
    editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
    control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 1, last_order_today: 120 });
  const E1 = { brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches: [['r_s', 'Centro'], ['r_s2', 'Norte']].map(row), membership_writes_enabled: true };
  const json = (b, st) => Promise.resolve(new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url) => {
    const fn = new URL(String(url), location.href).pathname.split('/').pop();
    if (fn === 'getMyBranches') return json(E1);
    if (fn === 'getMerchantReviews' || fn === 'getMerchantRatingComments') return new Promise(() => {});   // the loading state, held
    return json({ error: 'not_found' }, 404);
  };
})();`;
const FIT = `(() => { const d = document.documentElement; return { scroll: d.scrollWidth, client: d.clientWidth }; })()`;

test('REAL Chrome @390: the Calificaciones loading skeleton fits the column — no sideways scroll (positive control: an uncapped 52ch bone does scroll)', async () => {
  const p = await openPage(`${base}/index.html?fresh=${Math.random().toString(36).slice(2)}`, MOCK, 390);
  try {
    for (let i = 0; i < 80 && !(await p.ev("!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden') && [...document.querySelectorAll('button,a')].some((e) => e.textContent.trim() === 'Calificaciones')")); i++) await wait(100);
    assert.ok(await p.ev("[...document.querySelectorAll('button,a')].some((e) => e.textContent.trim() === 'Calificaciones')"), 'premise: the portal booted and shows the «Calificaciones» nav');
    await p.ev("[...document.querySelectorAll('button,a')].find((e) => e.textContent.trim() === 'Calificaciones').click()");
    for (let i = 0; i < 50 && !(await p.ev("!!document.querySelector('.calif .kfigs.ov.sk') && !!document.querySelector('.calif .skrow .skb.t')")); i++) await wait(100);
    assert.ok(await p.ev("!!document.querySelector('.calif .kfigs.ov.sk')"), 'premise: the loading skeleton is on screen (the reviews calls never answered)');
    assert.equal(await p.ev("document.querySelectorAll('.calif .skrow .skb.t').length >= 4"), true, 'premise: the text bones rendered');
    await wait(200);
    const fit = await p.ev(FIT);
    assert.equal(await p.ev('document.documentElement.clientWidth'), 390, 'premise: a 390 px layout viewport');
    // the positive control FIRST, on this very page: a bare 52ch box in the same list (the defect's class — a fixed width that is NOT
    // contained) — the probe must see the page widen
    const ctl = await p.ev(`(() => { const l = document.querySelector('.calif .clist'); const r = document.createElement('div'); r.id = 'ctlrow'; r.style.width = '52ch'; r.style.height = '1px'; l.append(r);
      const d = document.documentElement; const o = { scroll: d.scrollWidth, client: d.clientWidth }; r.remove(); return o; })()`);
    assert.ok(ctl.scroll > ctl.client + 1, `positive control: an uncontained 52ch box widens the page (${ctl.scroll} > ${ctl.client}) — the probe can see the defect`);
    assert.ok(fit.scroll <= fit.client + 1, `🔴 16b: the loading page scrolls sideways at 390 — document ${fit.scroll} px wide in a ${fit.client} px viewport`);
    const over = await p.ev("[...document.querySelectorAll('.calif .skb')].filter((b) => b.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).length");
    assert.equal(over, 0, 'every bone ends inside the viewport');
  } finally { await p.close(); }
});
