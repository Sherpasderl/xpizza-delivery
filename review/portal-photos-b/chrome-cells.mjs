// REVIEW ONLY — DISH PHOTOS B real-Chrome cells (PLAN-dish-photos r2 §4.2): the things jsdom cannot show, on the REAL portal
// (same server, stubs and fixture as shoot.mjs) in headless Chrome:
//   1. crop: a pointer DRAG, the ARROW keys and the ZOOM slider move the rect E-P2 receives (real layout, real pointer events)
//   2. progress + Cancelar: the bar reports the upload in place; Cancelar aborts the PUT and E-P2 never runs
//   3. preview renewal: a preview that fails to LOAD (a real broken image) triggers one getEditableCatalog re-read
//   4. 390: the phone zone (Tomar foto / Elegir de la galería) is what shows; the desktop zone is display:none — and back at 1280
//   5. CSP (P2-10): under netlify.toml's REAL policy, an <img> / a PUT inside the scoped prefixes raise NO violation; outside
//      them (another bucket, virtual-hosted, an order site, the uploads prefix as an image) the browser raises one
// Exits 1 on any failed cell. Run: node review/portal-photos-b/chrome-cells.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg' };
const STUB = { '/xpizza-portal/firebase.js': 'stubs/firebase.js', '/xpizza-portal/auth.js': 'stubs/auth.js', '/xpizza-portal/invite-mail.js': 'stubs/invite-mail.js' };
const CSP = /Content-Security-Policy = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'xpizza-portal', 'netlify.toml'), 'utf8'))[1];
const PH = (f) => `/review/portal-photos-b/mockup/mockup-dish-photo/${f}`;
const JPG = path.join(HERE, 'mockup', 'mockup-dish-photo', '09-pepperoni.jpg');

const OWNER = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'availability.set'];
const E1 = { brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches: [{ rid: 'r_centro', brand_id: 'marca_v', role: 'owner', state: 'member', caps: OWNER, name: 'Centro', identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50497128830' }, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 1, last_order_today: 1 }], membership_writes_enabled: false };
const ITEMS = [{ key: 'Pepperoni', price: 310, display: { name: 'Pepperoni', cat: 'cl', price: 310, desc: 'Pepperoni y mozzarella' } }, { key: 'Margarita', price: 280, display: { name: 'Margarita', cat: 'cl', price: 280 } }];

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/csp-probe.html') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': CSP }); res.end('<!doctype html><title>csp</title><script src="/review/portal-photos-b/csp-probe.js"></script>'); return; }
  const file = STUB[p] ? path.join(HERE, STUB[p]) : path.join(ROOT, p.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (p === '/xpizza-portal/index.html') body = body.toString('utf8').replace('<script src="sherpa-client.js"></script>', '<script src="/review/portal-photos-b/fixture.js"></script>\n<script src="/review/portal-photos-b/cells-spy.js"></script>\n<script src="sherpa-client.js"></script>');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const chromeBin = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const q = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(q)) return q; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
};
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-b-cells-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (s, expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text); return r.result.value; };
async function open(scn, w = 1280, h = 900) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const d of ['Page', 'Runtime', 'DOM']) await send(`${d}.enable`, {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__SCN = ${JSON.stringify(scn)};` }, sessionId);
  await send('Page.navigate', { url: `${base}/xpizza-portal/index.html` }, sessionId);
  await sleep(1500);
  return { targetId, sessionId };
}
async function pick(s, file) {
  const { root } = await send('DOM.getDocument', { depth: 1 }, s);
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' }, s);
  await send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] }, s);
  await sleep(500);
}
const ROW = (n) => `Array.from(document.querySelectorAll('#detail .irow')).find((r) => r.querySelector('.nm') && r.querySelector('.nm').firstChild.textContent === ${JSON.stringify(n)})`;
const results = [];
const cell = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const MENU = { items: ITEMS, enabled: true };

await cell('1 crop: drag + arrows + zoom move the rect E-P2 receives', async () => {
  const p = await open({ e1: E1, menu: MENU });
  await ev(p.sessionId, `${ROW('Pepperoni')}.querySelector('button.thumb').click()`);
  await pick(p.sessionId, JPG);
  const box = await ev(p.sessionId, `(() => { const r = document.querySelector('.phcrop').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  ok(box && box.w > 300, `the crop area is laid out (${JSON.stringify(box)})`);
  ok(Math.abs(box.w / box.h - 4 / 3) < 0.01, 'the card frame is 4:3 on screen');
  // zoom 150 %, then drag the photo 60 px right and press ArrowUp twice
  await ev(p.sessionId, `(() => { const r = document.querySelector('#drawer input[type=range]'); r.value = '150'; r.dispatchEvent(new Event('input')); })()`);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }, p.sessionId);
  for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + i * 10, y: cy, button: 'left', buttons: 1 }, p.sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 60, y: cy, button: 'left', clickCount: 1 }, p.sessionId);
  await ev(p.sessionId, `document.querySelector('.phcrop').focus()`);
  for (let i = 0; i < 2; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }, p.sessionId); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }, p.sessionId); }
  await ev(p.sessionId, `Array.from(document.querySelectorAll('#drawer button')).find((b) => b.textContent.trim() === 'Listo').click()`);
  await sleep(500);
  const body = await ev(p.sessionId, `window.__calls.find((c) => c.fn === 'photoProcess').body`);
  const c = body.crops.card;
  // 800×600 at 150 %: a 533×400 rect, centred at x=133 before the drag; the drag (60 screen px ≈ 60·533/box.w image px) moved it LEFT
  ok(c.w === 533 && c.h === 400, `zoom 150 % → 533×400 (${JSON.stringify(c)})`);
  ok(c.x < 133 && c.x >= 0, `the drag moved the frame (x ${c.x} < 133)`);
  ok(c.y > 100, `ArrowUp twice moved the frame down over the photo (y ${c.y} > 100)`);
  ok(JSON.stringify(body.crops.hero) === JSON.stringify({ x: 0, y: 50, w: 800, h: 500 }), `the hero kept its own (untouched) view: ${JSON.stringify(body.crops.hero)}`);
  await send('Target.closeTarget', { targetId: p.targetId });
});

await cell('2 progress in place + Cancelar aborts the PUT; E-P2 never runs', async () => {
  const p = await open({ e1: E1, menu: MENU, put: 'hold' });
  await ev(p.sessionId, `${ROW('Pepperoni')}.querySelector('button.thumb').click()`);
  await pick(p.sessionId, JPG);
  await ev(p.sessionId, `Array.from(document.querySelectorAll('#drawer button')).find((b) => b.textContent.trim() === 'Listo').click()`);
  await sleep(500);
  const st = await ev(p.sessionId, `({ now: document.querySelector('.phbar').getAttribute('aria-valuenow'), w: getComputedStyle(document.querySelector('.phbar i')).width, bw: getComputedStyle(document.querySelector('.phbar')).width, rev: document.getElementById('review').disabled })`);
  ok(st.now === '62', `aria-valuenow 62 (${st.now})`);
  ok(Math.abs(parseFloat(st.w) / parseFloat(st.bw) - 0.62) < 0.02, `the bar is 62 % wide (${st.w} of ${st.bw})`);
  ok(st.rev === true, 'the review waits for the upload');
  await ev(p.sessionId, `Array.from(document.querySelectorAll('#drawer .phov button')).find((b) => b.textContent.trim() === 'Cancelar').click()`);
  await sleep(400);
  const after = await ev(p.sessionId, `({ aborted: window.__aborts, process: window.__calls.filter((c) => c.fn === 'photoProcess').length, zone: !!document.querySelector('#drawer button.uploader.phdesk'), rev: document.getElementById('review').disabled })`);
  ok(after.aborted === 1, `the XHR was aborted (${after.aborted})`);
  ok(after.process === 0, 'no E-P2');
  ok(after.zone && after.rev === false, 'back to the zone; the review is free again');
  await send('Target.closeTarget', { targetId: p.targetId });
});

await cell('3 a preview that fails to load → ONE getEditableCatalog re-read; a second failure shows no broken image', async () => {
  const p = await open({ e1: E1, menu: { ...MENU, photos: { Pepperoni: { state: 'pid', pid: 'pidX' } }, previews: { pidX: { card: '/nope/broken.webp', hero: '/nope/broken.webp', expiresAt: Date.now() + 3600e3 } } } });
  await sleep(800);
  const s = await ev(p.sessionId, `({ reads: window.__calls.filter((c) => c.fn === 'getEditableCatalog').length, img: !!${ROW('Pepperoni')}.querySelector('button.thumb img'), cam: ${ROW('Pepperoni')}.querySelector('button.thumb').title })`);
  ok(s.reads === 2, `boot + exactly one renewal (${s.reads})`);
  ok(!s.img && s.cam === 'Subir foto', `after the renewal still fails: the camera, no broken image (${JSON.stringify(s)})`);
  await send('Target.closeTarget', { targetId: p.targetId });
});

await cell('4 at 390 the drawer opens on the plain zone (P1 cajón); a tap expands it in place (P2); at 1280 the zone opens the picker', async () => {
  for (const [w, want] of [[390, 'phone'], [1280, 'desk']]) {
    const p = await open({ e1: E1, menu: MENU }, w, 844);
    await ev(p.sessionId, `${ROW('Pepperoni')}.querySelector('.rowchev').click()`);
    await sleep(300);
    const first = await ev(p.sessionId, `({ desk: !!document.querySelector('#drawer .uploader.phdesk'), ph: !!document.querySelector('#drawer .uploader.phph2') })`);
    ok(first.desk && !first.ph, `${w}: the plain zone first (${JSON.stringify(first)})`);
    await ev(p.sessionId, `document.querySelector('#drawer .uploader.phdesk').click()`);
    await sleep(300);
    const s = await ev(p.sessionId, `({ desk: !!document.querySelector('#drawer .uploader.phdesk'), inputs: document.querySelectorAll('input[type=file]').length,
      btns: Array.from(document.querySelectorAll('#drawer .phph2b .btn')).map((b) => [b.textContent.trim(), b.getBoundingClientRect().height]) })`);
    if (want === 'phone') {
      ok(!s.desk && s.inputs === 0, `390: expanded in place, no picker yet (${JSON.stringify(s)})`);
      ok(s.btns.length === 2 && s.btns.every(([, hh]) => hh >= 44), `two ≥44 px buttons (${JSON.stringify(s.btns)})`);
      ok(s.btns[0][0] === 'Tomar foto' && s.btns[1][0] === 'Elegir de la galería', 'their labels');
      await ev(p.sessionId, `document.querySelectorAll('#drawer .phph2b .btn')[0].click()`);
      const cap = await ev(p.sessionId, `(() => { const i = Array.from(document.querySelectorAll('input[type=file]')).pop(); return i ? i.getAttribute('capture') : 'none'; })()`);
      ok(cap === 'environment', `«Tomar foto» opens the camera picker (capture=${cap})`);
    } else ok(s.desk && s.inputs === 1 && s.btns.length === 0, `1280: the zone opened the system picker (${JSON.stringify(s)})`);
    await send('Target.closeTarget', { targetId: p.targetId });
  }
});

await cell('5 CSP — inside the scoped prefixes: no violation; outside: the browser blocks it', async () => {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: `${base}/csp-probe.html` }, sessionId);
  let r = null;
  for (let i = 0; i < 40 && !r; i++) { await sleep(250); r = await ev(sessionId, 'window.__csp || null'); }   // the probes run one by one
  const want = {
    'img https://storage.googleapis.com/sherpa-delivery-photos/photos/r/P-card.webp': false,
    'img https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/drafts/r/P-card.webp?X-Goog-Signature=x': false,
    'img blob:': false,
    'put https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/uploads/r/u1?X-Goog-Signature=x': false,
    'img https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/uploads/r/u1': true,
    'img https://storage.googleapis.com/other-bucket/photos/r/P.webp': true,
    'img https://sherpa-delivery-photos.storage.googleapis.com/photos/r/P.webp': true,
    'img https://xpizza-orders.netlify.app/images/a.jpg': true,
    'put https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/drafts/r/x': true,
    'put https://storage.googleapis.com/other-bucket/uploads/r/u1': true,
  };
  for (const [k, blocked] of Object.entries(want)) ok(r && r[k] === blocked, `${k}: ${blocked ? 'BLOCKED' : 'allowed'} expected, got ${r ? r[k] : '—'}`);
  await send('Target.closeTarget', { targetId });
});

ws.close(); chrome.kill(); server.close();
for (const r of results) console.log(r.join(' · '));
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
