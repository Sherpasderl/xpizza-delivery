// Customer app — G7 member Cuenta, frame 4b «sin saltos» (advisor ruling A, 2026-10-31): the no-cache header reserves the REAL header's
// geometry, so when the profile lands nothing below it moves. Run at hand-back, in a Chrome slot:
//   node review/capp-perf/capp-g7-cuenta.cdp.mjs       (CHROME_BIN overrides the browser; no emulator, no network beyond 127.0.0.1)
// The REAL customer-app/shell.html is served with ONE host script appended that mounts the REAL shell (runtime.signup set) as a
// restored member, at 390×844 DPR 2, on the Cuenta tab. Two renders of the SAME member, each from the real writer:
//   4b   the uid only (capp:member_complete names it; no cached profile) ⇒ the placeholders
//   4a   the profile cached by CappDeviceAccount.rememberProfile (the writer «Listo» uses) ⇒ the name, phone and email
// The proof is RAW GEOMETRY (the capp-perf method): the header's box and the box of EVERY element after it (the rows, the session
// group, the version line) and the tab bar, to 0.01 px — 4b must equal 4a.
//   G7-4b-ctrl   NEGATIVE CONTROL: the same pair with capp.css served WITHOUT the ruling-A lines ⇒ the header is shorter and the
//                rows move — proves the comparison sees the reflow, so the equality above is not vacuous
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');   // review/capp-perf/ → the repo (never under customer-app/: that folder deploys)
const W = 390, H = 844;
const chromeBin = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse())
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
};

// the host: a restored member (a fake Firebase auth module; no request leaves the page), the Cuenta tab; ?profile=1 caches the profile
const HOST = `<script>(async () => {
  const withProfile = new URLSearchParams(location.search).get('profile') === '1';
  try { localStorage.clear(); } catch (_) {}
  localStorage.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_g7' }));
  CappDeviceAccount.remember(localStorage, '+50496123344');
  if (withProfile) CappDeviceAccount.rememberProfile(localStorage, { uid: 'u_g7', name: 'Ana Pérez', phone: '+50496123344', email: 'ana.perez@correo.test', promos: true });
  const FX = await (await fetch('/customer-app/fixtures/s7a2/directory.json')).json(), dir = FX.scenarios.complete;
  const user = { uid: 'u_g7', getIdToken: async () => 'id:u_g7' };
  const authMod = { browserLocalPersistence: 'LOCAL', getAuth: () => ({ get currentUser() { return user; } }), setPersistence: async () => {},
    onAuthStateChanged: (a, n) => { Promise.resolve().then(() => n({ uid: user.uid })); return () => {}; }, signInWithCustomToken: async () => ({ user }), signOut: async () => {} };
  const EP = Object.fromEntries(CappSignupApi.ENDPOINTS.map((k) => [k, '/su/' + k]));
  CappShellUI.mount(document, { fetchDirectory: async () => ({ status: dir.status, body: dir.body, etag: dir.headers.ETag }), fetchEnvelope: () => new Promise(() => {}), readAvailability: async () => [],
    runtime: { endpoints: { quoteOrder: '/x/q', createOrder: '/x/c', chargeOnlineOrder: '/x/p', paymentStatus: '/x/s' }, intakeKey: 'k_g7', guestCardOnly: true, signup: { firebase: { apiKey: 'k' }, endpoints: EP } },
    auth: { state: () => 'unresolved' }, now: () => new Date(2026, 9, 20, 13, 5).getTime(), loadSdk: async () => ({ initializeApp: () => ({}), authMod }),
    signupFetch: () => new Promise(() => {}), google: { getIdToken: async () => null }, uiOpts: { apiOpts: { fetch: () => new Promise(() => {}) } } });
  window.__mounted = true;
})();</script>`;
// the header and everything after it in the Cuenta, plus the tab bar: [selector-path, box] to 0.01 px
const GEO = `(() => { const h = document.querySelector('.acct-hero'); if (!h) return null; const out = [];
  const box = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)).join(','); };
  out.push(['hero', box(h)]); let n = h.nextElementSibling, i = 0;
  while (n) { out.push(['sib' + i, box(n)]); n.querySelectorAll('*').forEach((c, j) => out.push(['sib' + i + '.' + j, box(c)])); n = n.nextElementSibling; i++; }
  document.querySelectorAll('.tabbar, .tabbar *').forEach((c, j) => out.push(['tab' + j, box(c)]));
  return { out, placeholder: !!h.querySelector('.bar'), text: (h.querySelector('.t b') || {}).textContent || '' }; })()`;
const RULING_A = /^\/\* advisor ruling A[\s\S]*?\*\/\n(\.acct-hero \.t:has\(>\.bar\)[^\n]*\n)+/m;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
function serve({ stripA }) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (rel === 'customer-app/shell.html') body = Buffer.from(String(body).replace('</body>', `${HOST}</body>`));
    if (stripA && rel === 'customer-app/capp.css') { const css = String(body); if (!RULING_A.test(css)) throw new Error('premise: the ruling-A block is not in capp.css'); body = Buffer.from(css.replace(RULING_A, '')); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let live = null;   // the running browser, reaped on any exit — never a pattern kill
process.on('exit', () => { if (live) try { live.kill('SIGTERM'); } catch (_) {} });
async function pair(name, { stripA = false } = {}) {
  const srv = await serve({ stripA });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-g7-'));
  const chrome = live = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const wsUrl = await new Promise((resolve, reject) => { let b = ''; const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000); chrome.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); });
    const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Page.enable'); await s('Runtime.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    const ev = async (expression) => { const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const render = async (withProfile) => {
      await s('Page.navigate', { url: `${base}/customer-app/shell.html${withProfile ? '?profile=1' : ''}` });
      for (let i = 0; i < 400 && !(await ev('window.__mounted === true').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 25));
      await ev('document.fonts.ready.then(() => true)'); await new Promise((r) => setTimeout(r, 400));
      await ev(`document.querySelector('.tabbar [data-tab="account"]').click()`);
      for (let i = 0; i < 200 && !(await ev(`!!document.querySelector('.acct-hero')`)); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 400));
      return ev(GEO);
    };
    const b = await render(false), a = await render(true);
    const loaded = await ev(`document.fonts.check('400 16px "Red Hat Text"')`);
    ws.close();
    const moved = b && a && b.out.length === a.out.length ? b.out.filter((g, i) => g[0] !== a.out[i][0] || g[1] !== a.out[i][1]).map((g) => g[0]) : null;
    return { name, b4: b && { placeholder: b.placeholder, hero: b.out[0][1] }, a4: a && { placeholder: a.placeholder, text: a.text, hero: a.out[0][1] }, boxes: b ? b.out.length : 0, moved, loaded };
  } finally {
    chrome.kill('SIGTERM'); live = null;   // OUR child, by handle
    srv.close();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300);
  }
}

const fails = [];
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };
const g = await pair('G7-4b');
console.log(JSON.stringify(g));
check(!!g.b4 && g.b4.placeholder === true && !!g.a4 && g.a4.placeholder === false && g.a4.text === 'Ana Pérez', `G7-4b premise: 4b draws the placeholders, 4a the cached profile (${g.a4 && g.a4.text})`);
check(g.loaded === true, 'G7-4b premise: the Red Hat face is loaded (the real line boxes are measured)');
check(!!g.b4 && !!g.a4 && g.b4.hero === g.a4.hero, `G7-4b: the header box is EQUAL before and after the profile lands (${g.b4 && g.b4.hero} | ${g.a4 && g.a4.hero})`);
check(g.boxes > 10 && Array.isArray(g.moved) && g.moved.length === 0, `G7-4b: 0 of ${g.boxes} boxes after the header moved (${g.moved && g.moved.length})`);
const c = await pair('G7-4b-ctrl', { stripA: true });
console.log(JSON.stringify(c));
check(!!c.b4 && !!c.a4 && c.b4.hero !== c.a4.hero && Array.isArray(c.moved) && c.moved.length > 0, `G7-4b-ctrl: WITHOUT ruling A the header differs and ${c.moved && c.moved.length} of ${c.boxes} boxes move — the equality above is not vacuous`);
console.log(fails.length ? `\ncapp-g7-cuenta: ${fails.length} FAILED` : '\ncapp-g7-cuenta: G7-4b OK (2 cells)');
process.exit(fails.length ? 1 : 0);
