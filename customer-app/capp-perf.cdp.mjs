// Customer app — the CDP performance harness (PLAN-capp-S7a r3.3 / PLAN-capp-S4 r5.3: ONE tool, both slices). Run at hand-back:
//   node customer-app/capp-perf.cdp.mjs            (CHROME_BIN overrides the browser; no emulator, no network beyond 127.0.0.1)
// Cell F4 (this slice): the self-hosted fonts NEVER move layout. The REAL customer-app/index.html (its own <head>: preloads,
// capp-fonts.css, capp.css) is served with ONE host script appended that mounts the REAL CappUI on the REAL served envelope
// (review/capp-s2b/envelopes.json), at 390×844 DPR 2. Layout shifts are read from the page's own PerformanceObserver.
// "No reflow" is proven on RAW GEOMETRY, not on CLS alone: the bounding box of EVERY element under .app is captured after the mount
// and again after the font has landed; a moved / resized box is a reflow. (CLS is also recorded, but a font swap can re-wrap text
// inside a box without firing layout-shift — the first control run showed exactly that: swap, CLS 0 — so CLS cannot be the proof.)
//   F4-fast   fonts served at once                                   ⇒ the Red Hat faces ARE used; 0 boxes move; CLS = 0
//   F4-slow   Slow 4G + 4× CPU, fonts HELD 6000 ms (past the mount: text is painted BEFORE the font exists)
//             ⇒ the metric-matched fallback is painted and KEPT after the font lands; 0 boxes move; CLS = 0
//   F4-ctrl   NEGATIVE CONTROL: the same held load with the OLD policy (font-display:swap, no fallback faces), rewritten in flight
//             ⇒ it swaps AND boxes move — proves the geometry check sees a font reflow, so the zeros above are not vacuous
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 390, H = 844;
const chromeBin = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse())
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
};

// the host: the store page of the review envelope with a neutral store config (DATA; brand-agnostic: no restaurant literal); no request leaves the page
const HOST = `<script>(async () => {
  try { localStorage.clear(); } catch (_) {}
  const env = Object.values(await (await fetch('/review/capp-s2b/envelopes.json')).json())[0];
  const CFG = { name: 'Tienda de prueba', kicker: 'Restaurante', unit: ['pizza', 'pizzas'], hours: Array(7).fill([12, 0, 22, 45]),
    addr: 'Calle 1, Colonia Centro', branch: 'Centro', etaDel: [30, 45], etaPick: [15, 20], feeFromCents: 4500,
    entry: 'link', restaurantId: 'rid_perf', orderIdPrefix: 'XPZ', pendingPayKey: 'perf_pending_pay', intakeKey: 'k_perf',
    endpoints: { quoteOrder: '/x/q', createOrder: '/x/c', chargeOnlineOrder: '/x/p', paymentStatus: '/x/s' } };
  CappUI.mount(document, { envelope: env, config: CFG, now: () => new Date(2026, 9, 20, 19, 5), apiOpts: { fetch: () => new Promise(() => {}) } });
  window.__mounted = true;
})();</script>`;
// every element under .app, in document order: its box to 0.01 px (a font reflow re-wraps text ⇒ widths/heights/positions change)
const GEO = `[...document.querySelectorAll('.app *')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)).join(','); })`;
const OBSERVER = `window.__cls = 0; window.__shifts = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(e.value); } }).observe({ type: 'layout-shift', buffered: true });`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
function serve({ fontDelayMs, oldPolicy }) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (rel === 'customer-app/index.html') body = Buffer.from(String(body).replace('</body>', `${HOST}</body>`));
    if (oldPolicy && rel === 'customer-app/capp-fonts.css') body = Buffer.from(String(body).replace(/font-display:optional/g, 'font-display:swap').replace(/@font-face\{[^}]*src:local\([^}]*\}/g, ''));
    if (oldPolicy && rel === 'customer-app/capp.css') body = Buffer.from(String(body).replace(/'Red Hat (Text|Display) Fallback( Roboto)?',\s*/g, ''));
    const send = () => { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); };
    if (file.endsWith('.woff2') && fontDelayMs) setTimeout(send, fontDelayMs); else send();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function run(name, { fontDelayMs = 0, throttle = false, oldPolicy = false }) {
  const srv = await serve({ fontDelayMs, oldPolicy });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-perf-'));
  const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const wsUrl = await new Promise((resolve, reject) => { let b = ''; const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000); chrome.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); });
    const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Page.enable'); await s('Runtime.enable'); await s('DOM.enable'); await s('CSS.enable'); await s('Network.enable');
    await s('Network.setCacheDisabled', { cacheDisabled: true });
    await s('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    if (throttle) {
      await s('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      await s('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
    const ev = async (expression) => { const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const font = async (sel) => {
      const { root } = await s('DOM.getDocument', { depth: -1 });
      const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (!nodeId) throw new Error(`no node ${sel}`);
      const { fonts } = await s('CSS.getPlatformFontsForNode', { nodeId });
      return fonts.map((f) => f.familyName).join(',');
    };
    await s('Page.navigate', { url: `${base}/customer-app/index.html` });
    const t0 = Date.now();
    for (let i = 0; i < 400 && !(await ev('window.__mounted === true').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 25));
    const mountedAt = Date.now() - t0;
    if (fontDelayMs && mountedAt >= fontDelayMs) throw new Error(`premise: the page mounted (${mountedAt} ms) after the held font (${fontDelayMs} ms) — the cell would prove nothing`);
    const SEL = '.app h1, .app h2';
    await new Promise((r) => setTimeout(r, 300));
    const before = await font(SEL);
    const geo0 = await ev(GEO);
    await new Promise((r) => setTimeout(r, Math.max(0, fontDelayMs - mountedAt) + 2500));   // the fonts have landed (or been given up on) and settled
    const after = await font(SEL);
    const geo1 = await ev(GEO);
    const moved = geo0.length === geo1.length ? geo0.filter((g, i) => g !== geo1[i]).length : -1;
    const out = { name, mountedAt, before, after, boxes: geo0.length, moved, cls: await ev('window.__cls'), shifts: await ev('window.__shifts') };
    ws.close();
    return out;
  } finally {
    chrome.kill('SIGTERM');   // OUR child, by handle — never a pattern kill
    srv.close();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300);
  }
}

const isRedHat = (f) => /Red Hat/.test(f);
const fails = [];
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

const fast = await run('F4-fast', {});
console.log(JSON.stringify(fast));
check(isRedHat(fast.after), `F4-fast: the heading renders in the self-hosted face (${fast.after})`);
check(fast.boxes > 50 && fast.moved === 0, `F4-fast: 0 of ${fast.boxes} boxes moved (${fast.moved})`);
check(fast.cls === 0, `F4-fast: CLS = 0 (${fast.cls})`);

const slow = await run('F4-slow', { fontDelayMs: 6000, throttle: true });
console.log(JSON.stringify(slow));
check(!isRedHat(slow.before), `F4-slow: the font missed the window ⇒ the fallback is painted (${slow.before})`);
check(slow.before === slow.after, `F4-slow: NO swap after the font lands (${slow.before} → ${slow.after})`);
check(slow.boxes > 50 && slow.moved === 0, `F4-slow: 0 of ${slow.boxes} boxes moved when the font landed (${slow.moved})`);
check(slow.cls === 0, `F4-slow: CLS = 0 (${slow.cls})`);

const ctrl = await run('F4-ctrl', { fontDelayMs: 6000, throttle: true, oldPolicy: true });
console.log(JSON.stringify(ctrl));
check(!isRedHat(ctrl.before) && isRedHat(ctrl.after), `F4-ctrl: the old swap policy DOES swap (${ctrl.before} → ${ctrl.after})`);
check(ctrl.moved > 0, `F4-ctrl: and the geometry check SEES its reflow, ${ctrl.moved} of ${ctrl.boxes} boxes moved — the zeros above are not vacuous (CLS ${ctrl.cls}, recorded only)`);

console.log(fails.length ? `\ncapp-perf: ${fails.length} FAILED` : '\ncapp-perf: F4 OK (3 cells)');
process.exit(fails.length ? 1 : 0);
