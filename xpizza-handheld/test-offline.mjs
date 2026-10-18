// H1b T7 — offline cold start (codex P2-11). `npm --prefix xpizza-handheld run test:offline`
// A headless Chromium with an EMPTY profile (no cache) and every host but 127.0.0.1 unresolvable loads the app from a loopback
// static server, as a paired device (a session + PIN record seeded before the page runs). Asserts:
//   - every local request (modules, vendored Firebase, styles, the self-hosted font) succeeds — zero failed;
//   - the font really renders (document.fonts.check);
//   - the list shows the offline banner ("Sin conexión…") and NO "no orders" empty state (the feed never delivered a snapshot).
// No new dependency: the DevTools protocol over Node's built-in WebSocket. CHROME_BIN overrides the browser binary.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json' };

function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(cache, d))) {
        const p = path.join(cache, d, sub, 'chrome-headless-shell');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(app)) return app;
  throw new Error('no Chromium found (set CHROME_BIN)');
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'h1b-offline-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--window-size=360,720', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''; const t = setTimeout(() => reject(new Error('Chromium did not start')), 20000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }
  else if (m.method) events.push(m);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

let exitCode = 1;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Network.enable', {}, sessionId);
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 720, deviceScaleFactor: 2, mobile: true }, sessionId);
  // a paired device: session + PIN record (synthetic third brand), seeded before any app code runs
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('hh_session',JSON.stringify({uid:'hh_tb_norte_test',rid:'tb_norte',brand_id:'tb',location_name:'Norte',prep_default_min:18}));localStorage.setItem('hh_pin',JSON.stringify({v:1,iter:100000,salt:'AA==',hash:'AA=='}));}catch(e){}` }, sessionId);
  await send('Page.navigate', { url: `${base}/index.html` }, sessionId);
  await new Promise((r) => setTimeout(r, 6000));
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  const text = await ev('document.fonts.ready.then(() => document.body.innerText)');
  const fontOk = await ev("document.fonts.check('800 16px Manrope') && [...document.fonts].some((f) => f.family.replace(/\"/g, '') === 'Manrope' && f.status === 'loaded')");

  const reqs = new Map();
  for (const e of events) {
    const p = e.params || {};
    if (e.method === 'Network.requestWillBeSent') reqs.set(p.requestId, { url: p.request.url, status: null, failed: null });
    if (e.method === 'Network.responseReceived' && reqs.has(p.requestId)) reqs.get(p.requestId).status = p.response.status;
    if (e.method === 'Network.loadingFailed' && reqs.has(p.requestId)) reqs.get(p.requestId).failed = p.errorText;
  }
  const local = [...reqs.values()].filter((r) => r.url.startsWith(base));
  const external = [...reqs.values()].filter((r) => !r.url.startsWith(base) && !r.url.startsWith('data:'));
  const badLocal = local.filter((r) => r.failed || r.status !== 200);
  console.log(`local requests: ${local.length} (${local.map((r) => r.url.slice(base.length + 1)).sort().join(', ')})`);
  console.log(`external attempts (blocked, expected — Firebase reconnects): ${external.length}`);

  assert.deepEqual(badLocal, [], 'every module, vendored SDK file, stylesheet and font resolves locally');
  for (const need of ['index.html', 'app.js', 'styles.css', 'vendor/firebase-app.js', 'vendor/firebase-database.js', 'vendor/firebase-auth.js', 'vendor/firebase-functions.js', 'fonts/manrope-latin-var.woff2', 'model.js', 'tmpl.js']) {
    assert.ok(local.some((r) => r.url === `${base}/${need}`), `loaded ${need}`);
  }
  assert.ok(fontOk, 'Manrope renders from fonts/');
  assert.ok(text.includes('Sin conexión. Los pedidos nuevos pueden no llegar. Reintentando…'), `the offline banner is shown:\n${text}`);
  assert.ok(!text.includes('Sin pedidos nuevos'), 'and NOT the empty state (no snapshot yet ≠ no orders)');
  assert.ok(text.includes('Nuevos') && text.includes('En prep.') && text.includes('Listos'), 'the list (tabs) is up');
  console.log('  ok cold start: zero failed local requests; font loaded; offline banner, no empty state');

  // codex H1b r1 P1-4: the SAME persisted pairing inside a native shell whose plugin is missing → the checks screen, never the list
  const t2 = await send('Target.createTarget', { url: 'about:blank' });
  const s2 = (await send('Target.attachToTarget', { targetId: t2.targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, s2);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('hh_session',JSON.stringify({uid:'hh_tb_norte_test',rid:'tb_norte',brand_id:'tb',location_name:'Norte',prep_default_min:18}));localStorage.setItem('hh_pin',JSON.stringify({v:1,iter:100000,salt:'AA==',hash:'AA=='}));}catch(e){} window.Capacitor={isNativePlatform:()=>true,Plugins:{}};` }, s2);
  await send('Page.navigate', { url: `${base}/index.html` }, s2);
  await new Promise((r) => setTimeout(r, 4000));
  const text2 = (await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, s2)).result.value;
  assert.ok(text2.includes('Que no se pierda ningún pedido'), `a native shell without the plugin opens the checks screen:\n${text2}`);
  assert.ok(!text2.includes('En prep.'), 'and never the list (silent alarms)');
  console.log('  ok native-missing guard on a persisted pairing → the checks screen (P1-4)');
  console.log('test:offline: OK');
  exitCode = 0;
} catch (e) {
  console.error('test:offline FAILED:', e && e.message);
} finally {
  try { ws.close(); } catch (_) { /* closed */ }
  chrome.kill('SIGTERM');
  server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* best effort */ } process.exit(exitCode); }, 500);
}
