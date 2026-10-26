// REVIEW ONLY — S2b fidelity: every drawn checkout state, the frozen prototype v6 (or, for the Q9 states, the approved mockup
// figure) on the LEFT beside the build on the RIGHT, real headless-Chrome render at 390×844 (DPR 2), into
// review/capp-s2b/shots/{state}.{ref|build}.png + review/capp-s2b/index.html (the pairs + the classified NOTES).
// Left: the prototype driven into the state through its OWN globals / functions (bezel stripped); the mockup figure's own frame.
// Right: the REAL customer-app/ modules (harness.html) with a config fixture + a scripted fetch (no network).
// Run: node review/capp-s2b/shoot.mjs   (CHROME_BIN overrides)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GRILL = path.join(os.homedir(), 'Downloads/xpizza-D4c-grill');
const PROTO = path.join(GRILL, 'customer-app-prototype/APPROVED-v6');
const MOCK = path.join(GRILL, 'MOCKUP-capp-S2-payment-states.html');
const OUT = path.join(HERE, 'shots');
const W = 390, H = 844;
// [state, title, reference: 'proto' | mockup figure id | 'forms']
const STATES = [
  ['asap-width', 'OWNER DECISION — the ASAP card alone in the drawn .opts grid', 'proto'],
  ['checkout-guest', 'Guest checkout · delivery', 'proto'],
  ['checkout-guest-bottom', 'Guest checkout · delivery, scrolled to Tu pedido / Pago', 'proto'],
  ['checkout-member', 'Member checkout', 'proto'],
  ['checkout-member-bottom', 'Member checkout, scrolled to Tu pedido / Pago', 'proto'],
  ['pickup', 'Pickup', 'proto'],
  ['closed', 'Closed (G0)', 'proto'],
  ['geo-denied', 'Location denied', 'proto'],
  ['out-of-zone', 'Out of zone', 'proto'],
  ['pin', 'Pin step', 'proto'],
  ['tip-empty', 'Tip · nothing chosen', 'proto'],
  ['tip-chosen', 'Tip · L 20', 'proto'],
  ['tip-other', 'Tip · «Otro» keypad', 'proto'],
  ['placing', '«Realizando pedido…»', 'proto'],
  ['sending-spinner', '«Enviando tu pedido…» · spinner', 'proto'],
  ['sending-check', '«Enviando tu pedido…» · check', 'proto'],
  ['sending-confirming', '«Enviando» · confirming .shint', 'mk-sending-b'],
  ['offline', '«Sin conexión»', 'proto'],
  ['closure', 'Closure «… cerró a las …»', 'proto'],
  ['payfail', '«Pago no completado»', 'proto'],
  ['price', '«El precio cambió» (the forms\' ported sheet)', 'forms'],
  ['refund', 'Refund sheet', 'mk-refunded'],
  ['exists', 'Existing-order recovery sheet', 'mk-exists'],
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };

const { provisionBrand } = await import(path.join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(HERE, 'envelopes.json'), JSON.stringify({ x_pizza: (await quiet(() => provisionBrand('x_pizza'))).envelope }));

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
  const file = rel.startsWith('proto/') ? path.join(PROTO, rel.slice(6)) : rel === 'mock.html' ? MOCK : path.join(ROOT, rel);
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
const STRIP = '.rail-head,.panel,.simbar,.rail-foot{display:none!important}.wrap{padding:0!important;max-width:none!important}.stage{padding:0!important;justify-content:flex-start!important}.device{width:390px!important;height:844px!important;padding:0!important;border-radius:0!important;box-shadow:none!important}.device .frame{border-radius:0!important}';

// the prototype in one state, through its OWN globals and functions (the rail's own recipes, :2365-2366)
const protoScript = (st) => `(async () => {
  document.head.insertAdjacentHTML('beforeend', '<style>${STRIP}</style>');
  const st = '${st}', nap = (ms) => new Promise((x) => setTimeout(x, ms));
  setEntry('link', 'xp'); S.clock = st === 'closed' ? 22 * 60 + 30 : 19 * 60 + 5; S.day = 2; S.client = st.startsWith('checkout-member') ? 'member' : 'guest'; S.geo = 'ok'; S.zone = 'in';
  if (st === 'geo-denied') { S.geo = 'denied'; S.locDenied = true; }
  if (st === 'out-of-zone') S.zone = 'out';
  if (typeof syncControls === 'function') syncControls();
  sampleCart('xp'); if (st === 'pickup') S.mode.xp = 'pickup';
  S.flow = freshFlow('xp');
  if (st === 'payfail') { Object.assign(S.flow, { pay: 'online', details: 'Portón negro', name: 'Ana', phone: '9612-3344' }); go('checkout', { rid: 'xp' }); go('pixel', { rid: 'xp' }); S.confirmCase = 'declined'; pixelPay('xp'); }
  else if (st === 'sending-spinner' || st === 'sending-check') { S.flow.tip = 20; S.flow.tipChoice = 20; S.holdSending = st === 'sending-spinner' ? true : 'check'; go('sending', { rid: 'xp' }); }
  else {
    go('checkout', { rid: 'xp' });
    if (st === 'pin') { S.layerKind = 'pin'; renderLayer(); }
    if (['tip-empty', 'tip-chosen', 'tip-other', 'placing', 'offline', 'closure'].includes(st)) {
      if (st !== 'tip-empty') { S.flow.tip = 20; S.flow.tipChoice = 20; }
      go('tip', { rid: 'xp' });
      if (st === 'tip-other') { S.tipDraft = '150'; S.layerKind = 'tipother'; S.layerRid = 'xp'; renderLayer(); }
      if (st === 'placing') { placeTap('xp'); placingStop(); }
      if (st === 'offline') { S.confirmCase = 'offline'; placeTap('xp'); }
      if (st === 'closure') { S.confirmCase = 'closed'; placeTap('xp'); }
    }
    if (st === 'price') {   // the forms' own module (the byte-identical source of capp-confirm-quote.js), shown inside the phone frame
      await new Promise((ok) => { const s = document.createElement('script'); s.src = '/xpizza-orders/form-confirm-quote.js'; s.onload = ok; document.head.appendChild(s); });
      window.confirmPriceSheet({ document, oldCents: 109400, newCents: 99900 });
      const w = document.querySelector('.cq-sheet'); document.querySelector('.device .frame').appendChild(w); w.style.position = 'absolute';
    }
  }
  await nap(250);
  if (/-bottom$/.test(st)) { const f = document.getElementById('flow'); f.scrollTop = f.scrollHeight; await nap(100); }
  const b = document.querySelector('.device').getBoundingClientRect(); return { x: b.x, y: b.y };
})()`;
const mockScript = (fig) => `(async () => {
  document.head.insertAdjacentHTML('beforeend', '<style>.mk .device{padding:0!important;border-radius:0!important;box-shadow:none!important}.mk .device .frame{border-radius:0!important}</style>');
  await new Promise((x) => setTimeout(x, 250));
  const el = document.querySelector('#${fig} .device'); el.scrollIntoView({ block: 'start' }); await new Promise((x) => setTimeout(x, 100));
  const b = el.getBoundingClientRect(); return { x: b.x + window.scrollX, y: b.y + window.scrollY };
})()`;

const errors = [];
for (const [st, , ref] of STATES) {
  for (const side of ['ref', 'build']) {
    const isBuild = side === 'build';
    await send('Emulation.setDeviceMetricsOverride', { width: isBuild ? W : 1300, height: isBuild ? H : 1600, deviceScaleFactor: 2, mobile: isBuild }, sessionId);
    const url = isBuild ? `${base}/review/capp-s2b/harness.html?state=${st}` : ref.startsWith('mk-') ? `${base}/mock.html` : `${base}/proto/customer-app-prototype-v6-APPROVED.html`;
    await send('Page.navigate', { url }, sessionId);
    await wait(900);
    let clip = { x: 0, y: 0 };
    try {
      if (!isBuild) clip = await ev(ref.startsWith('mk-') ? mockScript(ref) : protoScript(st));
      else { for (let i = 0; i < 200; i++) { if (await ev('window.__ready === true')) break; await wait(50); } const t = await ev("document.getElementById('app').innerText.slice(0, 300)"); if (/harness error/.test(t || '')) errors.push(`${st}: ${t}`); }
    } catch (e) { errors.push(`${st}.${side}: ${e.message}`); }
    await wait(500);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !isBuild, clip: { x: clip.x, y: clip.y, width: W, height: H, scale: 1 } }, sessionId);
    fs.writeFileSync(path.join(OUT, `${st}.${side}.png`), Buffer.from(data, 'base64'));
  }
}
const NOTES = JSON.parse(fs.readFileSync(path.join(HERE, 'notes.json'), 'utf8'));
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const refName = (r) => (r === 'proto' ? 'prototype v6' : r === 'forms' ? 'the forms\' sheet (form-confirm-quote.js) over prototype v6' : `MOCKUP Q9 #${r}`);
const page = `<!doctype html><meta charset="utf-8"><title>S2b fidelity</title><style>body{font:14px system-ui;background:#EDEAE4;margin:24px}h2{margin:32px 0 8px}
.p{display:flex;gap:24px}.p figure{margin:0}.p img{width:${W}px;height:${H}px;border:1px solid #D7D3CB;border-radius:18px}figcaption{font-weight:700;margin-bottom:6px}
li b{display:inline-block;min-width:150px}.BUG{color:#B9323A}.OWNER{color:#8A5A00}</style>
<h1>S2b — reference (left) vs build (right), ${W}×${H}</h1>${STATES.map(([s, title, r]) => `<h2 id="${s}">${esc(title)}</h2><ul>${(NOTES[s] || ['UNCLASSIFIED']).map((x) => { const k = x.split(':')[0]; return `<li class="${/BUG/.test(k) ? 'BUG' : /OWNER/.test(k) ? 'OWNER' : ''}"><b>${esc(k)}</b>${esc(x.slice(k.length))}</li>`; }).join('')}</ul><div class="p"><figure><figcaption>${esc(refName(r))}</figcaption><img src="shots/${s}.ref.png"></figure><figure><figcaption>build</figcaption><img src="shots/${s}.build.png"></figure></div>`).join('')}`;
fs.writeFileSync(path.join(HERE, 'index.html'), page);
ws.close(); chrome.kill('SIGTERM'); server.close();
setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : `shots: ${STATES.length * 2} → review/capp-s2b/shots/`); process.exit(errors.length ? 1 : 0); }, 300);
