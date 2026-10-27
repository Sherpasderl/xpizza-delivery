// REVIEW ONLY — S2b-geo fidelity: each frame of the owner-approved MOCKUP-capp-S2b-geo-address.html (its own iframe, LEFT) beside the
// build (RIGHT, the S2b harness's addr-* states: the REAL customer-app/ modules + a stub Google Geocoder answering a recorded
// result shape), real headless-Chrome render at 390×844 (DPR 2) → review/capp-s2b-geo/shots/ + index.html (pairs + classified NOTES).
// Run: node review/capp-s2b-geo/shoot.mjs   (CHROME_BIN overrides)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GRILL = path.join(os.homedir(), 'Downloads/xpizza-D4c-grill');
const MOCK = path.join(GRILL, 'MOCKUP-capp-S2b-geo-address.html');   // owner-approved 2026-10-26 (A1 + b + b2 + c)
const OUT = path.join(HERE, 'shots');
const W = 390, H = 844;
// [harness state, title, mockup frame id]
const STATES = [
  ['addr-a1', 'a · A1 «Calle 10, Col. Jardines del Valle»', 'fr-a1'],
  ['addr-a-long', 'a · A1 long — the existing ellipsis', 'fr-a-long'],
  ['addr-b', 'b · street only «Calle 10»', 'fr-b'],
  ['addr-b2', 'b2 · colonia only «Col. Jardines del Valle»', 'fr-b2'],
  ['addr-c', 'c · no result — today\'s row', 'fr-c'],
  ['addr-placing', 'a · «Realizando pedido…»', 'fr-placing'],
  ['addr-sending', 'a · «Enviando tu pedido…»', 'fr-sending'],
  ['addr-placing-b2', 'b2 · «Realizando pedido…»', 'fr-placing-b2'],
  ['addr-sending-b2', 'b2 · «Enviando tu pedido…»', 'fr-sending-b2'],
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };

fs.mkdirSync(OUT, { recursive: true });   // the harness reads review/capp-s2b/envelopes.json (run review/capp-s2b/shoot.mjs once first)

function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = rel === 'mock.html' ? MOCK : path.join(ROOT, rel);
  if (!(file.startsWith(ROOT) || file.startsWith(GRILL)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-s2b-shoot-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Tegucigalpa' }, sessionId);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mockScript = (fig) => `(async () => {
  await new Promise((x) => setTimeout(x, 400));
  const el = document.querySelector('#${fig} iframe'); el.scrollIntoView({ block: 'start' }); await new Promise((x) => setTimeout(x, 150));
  const b = el.getBoundingClientRect(); return { x: b.x + window.scrollX, y: b.y + window.scrollY };
})()`;

const errors = [];
for (const [st, , fig] of STATES) {
  for (const side of ['ref', 'build']) {
    const isBuild = side === 'build';
    await send('Emulation.setDeviceMetricsOverride', { width: isBuild ? W : 1300, height: isBuild ? H : 1600, deviceScaleFactor: 2, mobile: isBuild }, sessionId);
    await send('Page.navigate', { url: isBuild ? `${base}/review/capp-s2b/harness.html?state=${st}` : `${base}/mock.html` }, sessionId);
    await wait(900);
    let clip = { x: 0, y: 0 };
    try {
      if (!isBuild) clip = await ev(mockScript(fig));
      else { for (let i = 0; i < 200; i++) { if (await ev('window.__ready === true')) break; await wait(50); } const t = await ev("document.getElementById('app').innerText.slice(0, 300)"); if (/harness error/.test(t || '')) errors.push(`${st}: ${t}`); }
    } catch (e) { errors.push(`${st}.${side}: ${e.message}`); }
    await wait(500);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !isBuild, clip: { x: clip.x, y: clip.y, width: W, height: H, scale: 1 } }, sessionId);
    fs.writeFileSync(path.join(OUT, `${st}.${side}.png`), Buffer.from(data, 'base64'));
  }
}
const NOTES = JSON.parse(fs.readFileSync(path.join(HERE, 'notes.json'), 'utf8'));
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const refName = (r) => `MOCKUP S2b-geo #${r}`;
const page = `<!doctype html><meta charset="utf-8"><title>S2b-geo fidelity</title><style>body{font:14px system-ui;background:#EDEAE4;margin:24px}h2{margin:32px 0 8px}
.p{display:flex;gap:24px}.p figure{margin:0}.p img{width:${W}px;height:${H}px;border:1px solid #D7D3CB;border-radius:18px}figcaption{font-weight:700;margin-bottom:6px}
li b{display:inline-block;min-width:150px}.BUG{color:#B9323A}.OWNER{color:#8A5A00}</style>
<h1>S2b-geo — mockup (left) vs build (right), ${W}×${H}</h1>${STATES.map(([s, title, r]) => `<h2 id="${s}">${esc(title)}</h2><ul>${(NOTES[s] || ['UNCLASSIFIED']).map((x) => { const k = x.split(':')[0]; return `<li class="${/BUG/.test(k) ? 'BUG' : /OWNER/.test(k) ? 'OWNER' : ''}"><b>${esc(k)}</b>${esc(x.slice(k.length))}</li>`; }).join('')}</ul><div class="p"><figure><figcaption>${esc(refName(r))}</figcaption><img src="shots/${s}.ref.png"></figure><figure><figcaption>build</figcaption><img src="shots/${s}.build.png"></figure></div>`).join('')}`;
fs.writeFileSync(path.join(HERE, 'index.html'), page);
ws.close(); chrome.kill('SIGTERM'); server.close();
setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : `shots: ${STATES.length * 2} → review/capp-s2b-geo/shots/`); process.exit(errors.length ? 1 : 0); }, 300);
