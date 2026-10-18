// REVIEW ONLY — captures every harness state, prototype beside build, at 360×720 (DPR 2) into review/h1b/shots/{state}.{proto|build}.png
// and writes review/h1b/index.html (the pairs side by side). Run: node review/h1b/shoot.mjs   (CHROME_BIN overrides the browser)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'shots');
const STATES = ['login', 'branch', 'checks', 'pin', 'empty', 'alert', 'alertAmber', 'alertRed', 'detailNew', 'reject', 'rejectItems', 'prepList', 'detailPrep',
  'more', 'ready', 'status', 'busySheet', 'pauseSheet', 'busyDetail', 'offline', 'agotados', 'pinPrompt', 'settings', 'logout'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };

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
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'h1b-shoot-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

fs.mkdirSync(OUT, { recursive: true });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 720, deviceScaleFactor: 2, mobile: true }, sessionId);
await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Tegucigalpa' }, sessionId);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
const errors = [];
for (const st of STATES) {
  for (const side of ['proto', 'build']) {
    await send('Page.navigate', { url: `${base}/review/h1b/harness.html?side=${side}&state=${st}` }, sessionId);
    for (let i = 0; i < 100; i++) {
      const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true }, sessionId);
      if (r.result.value) break; await new Promise((x) => setTimeout(x, 50));
    }
    const txt = (await send('Runtime.evaluate', { expression: "document.getElementById('app').innerText.slice(0, 200)", returnByValue: true }, sessionId)).result.value;
    if (/harness error/.test(txt)) errors.push(`${st}.${side}: ${txt}`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 360, height: 720, scale: 1 } }, sessionId);
    fs.writeFileSync(path.join(OUT, `${st}.${side}.png`), Buffer.from(data, 'base64'));
  }
}
const page = `<!doctype html><meta charset="utf-8"><title>H1b fidelity</title><style>body{font:14px system-ui;background:#EDEAE4;margin:24px}h2{margin:28px 0 8px}
.p{display:flex;gap:24px}.p figure{margin:0}.p img{width:360px;height:720px;border:1px solid #D7D3CB;border-radius:18px}figcaption{font-weight:700;margin-bottom:6px}</style>
<h1>H1b — prototype (left) vs build (right), 360×720</h1>${STATES.map((s) => `<h2>${s}</h2><div class="p"><figure><figcaption>prototype</figcaption><img src="shots/${s}.proto.png"></figure><figure><figcaption>build</figcaption><img src="shots/${s}.build.png"></figure></div>`).join('')}`;
fs.writeFileSync(path.join(HERE, 'index.html'), page);
ws.close(); chrome.kill('SIGTERM'); server.close();
setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : `shots: ${STATES.length * 2} → review/h1b/shots/`); process.exit(errors.length ? 1 : 0); }, 300);
