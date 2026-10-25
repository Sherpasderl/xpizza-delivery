// REVIEW ONLY — S1b fidelity: every state, the frozen prototype v6 (left) beside the build (right), real headless-Chrome render
// at 390×844 (DPR 2), into review/capp-s1/shots/{rid}.{state}.{proto|build}.png + review/capp-s1/index.html (the pairs).
// The prototype's device bezel is stripped so both sides are the same 390 px phone. The build runs the REAL customer-app/ modules
// on the REAL served envelopes (the S0 rig's real publish). Run: node review/capp-s1/shoot.mjs   (CHROME_BIN overrides)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PROTO = path.join(os.homedir(), 'Downloads/xpizza-D4c-grill/customer-app-prototype/APPROVED-v6');
const OUT = path.join(HERE, 'shots');
const W = 390, H = 844;
const STATES = [
  ['x_pizza', 'store-top'], ['x_pizza', 'store-scrolled'], ['x_pizza', 'store-pickup'], ['x_pizza', 'sheet-dish'], ['x_pizza', 'sheet-dressed'],
  ['x_pizza', 'cart'], ['x_pizza', 'cart-empty'], ['la_musa', 'store-top'], ['la_musa', 'sheet-launcher'], ['la_musa', 'sheet-launcher-chosen'], ['la_musa', 'cart'],
];
const PR = { x_pizza: 'xp', la_musa: 'lm' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };

// the served envelopes, from the S0 rig's real publish
const { provisionBrand } = await import(path.join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const envs = {}; for (const rid of ['x_pizza', 'la_musa']) envs[rid] = (await quiet(() => provisionBrand(rid))).envelope;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(HERE, 'envelopes.json'), JSON.stringify(envs));

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
  const file = rel.startsWith('proto/') ? path.join(PROTO, rel.slice(6)) : path.join(ROOT, rel);
  if (!(file.startsWith(ROOT) || file.startsWith(PROTO)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-s1-shoot-'));
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
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the prototype in one state, through its OWN globals
const protoScript = (rid, st) => `(async () => {
  const r = '${PR[rid]}';
  document.head.insertAdjacentHTML('beforeend', '<style>.rail-head,.panel,.simbar,.rail-foot{display:none!important}.wrap{padding:0!important;max-width:none!important}.stage{padding:0!important;justify-content:flex-start!important}.device{width:${W}px!important;height:${H}px!important;padding:0!important;border-radius:0!important;box-shadow:none!important}.device .frame{border-radius:0!important}</style>');
  setEntry('link', r); S.clock = 19 * 60 + 5; S.day = 2; render();
  const st = '${st}';
  if (st === 'store-pickup') { S.mode[r] = 'pickup'; render(); }
  if (st === 'store-scrolled') { const sc = document.getElementById('scroller'); sc.scrollTop = 700; sc.dispatchEvent(new Event('scroll')); }
  if (st === 'sheet-dish') openDetail(r, '2');
  if (st === 'sheet-dressed') { sampleCart('xp'); render(); openDetail('xp', '2'); }
  if (st === 'sheet-launcher') openDetail('lm', 'noodle_01');
  if (st === 'sheet-launcher-chosen') { openDetail('lm', 'noodle_01'); S.open.staged.choice = 'noodle_01_pollo'; renderDetail(); }
  if (st === 'cart') { sampleCart(r); render(); openCart(r, false); }
  if (st === 'cart-empty') openCart(r, false);
  await new Promise((x) => setTimeout(x, 150));
  const b = document.querySelector('.device').getBoundingClientRect(); return { x: b.x, y: b.y };
})()`;

const errors = [];
for (const [rid, st] of STATES) {
  for (const side of ['proto', 'build']) {
    await send('Emulation.setDeviceMetricsOverride', { width: side === 'proto' ? 1200 : W, height: side === 'proto' ? 1400 : H, deviceScaleFactor: 2, mobile: side === 'build' }, sessionId);
    const url = side === 'proto' ? `${base}/proto/customer-app-prototype-v6-APPROVED.html` : `${base}/review/capp-s1/harness.html?rid=${rid}&state=${st}`;
    await send('Page.navigate', { url }, sessionId);
    await wait(900);
    let clip = { x: 0, y: 0 };
    if (side === 'proto') clip = await ev(protoScript(rid, st));
    else { for (let i = 0; i < 100; i++) { if (await ev('window.__ready === true')) break; await wait(50); } const t = await ev("document.getElementById('app').innerText.slice(0, 200)"); if (/harness error/.test(t || '')) errors.push(`${rid}.${st}: ${t}`); }
    await wait(500);   // fonts + images
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: clip.x, y: clip.y, width: W, height: H, scale: 1 } }, sessionId);
    fs.writeFileSync(path.join(OUT, `${rid}.${st}.${side}.png`), Buffer.from(data, 'base64'));
  }
}
// every visual diff, classified (prototype v6 → build); "identical" lists what was checked
const COMMON_STORE = ['P1 data gap: category display names (served id shown) and dish photo URLs (envelope img is form-relative) — advisor ruling (a)+(b), routed to 5f',
  'S5 data: social-proof pills («N+ volvieron a pedir»), «Lo más pedido» section + «#k más pedido» tags, liked % — no stats served yet',
  'S3 scope: the ⓘ fee-detail sheet and the guest promo pill «Envío gratis con tu cuenta» (envío/promo data + sheet)'];
const NOTES = {
  'store-top': ['identical: hero, avatar, name, kicker, open/closes facts, ETA, «Envío desde» (config), Delivery/Pickup segment, slim bar, tabs, section head + count, rows, thumbs, «+», cart pill «Tu pedido · L 0»', ...COMMON_STORE,
    'P1 data gap (x_pizza): «La casa recomienda» — the prototype curates it (r.house); the build shows it only from catalog tags with a photo'],
  'store-scrolled': ['identical: the collapsed slim bar (name + search), the tabs bar, scrollspy on the first section', ...COMMON_STORE.slice(0, 2)],
  'store-pickup': ['identical: Pickup pressed, «Listo en ≈ N min», «Recogé en <dirección>», pickup-only flag hidden', ...COMMON_STORE.slice(0, 2)],
  'sheet-dish': ['identical: sheet header, 4:3 photo, 24px name, price, description, stepper + «Agregar · L p»', 'S5 data: the rank / liked line under the price'],
  'sheet-dressed': ['identical: «Pizza 1 / Pizza 2» sections, «SALSAS & QUESO · Opcional», toggle rows «+L p», «Guardar · L 730»', 'S5 data: the rank / liked line'],
  'cart': ['identical: «Tu pedido», «3 pizzas · Delivery», grouped lines (plain / «+ Pepperoni»), «Editar», per-configuration stepper (trash at 1), line totals, Subtotal, «Ir al checkout»',
    'S2/S3 scope: Envío row, «Creá tu cuenta y tu envío es gratis», Total — the plan renders Subtotal only in S1', 'la_musa: «+ Arroz Blanco» once — S1 is TOGGLES ONLY (ruling); the v6 sample shows «2×» (a stepper)'],
  'cart-empty': ['identical: «Tu pedido está vacío.» + «Ver el menú»'],
  'sheet-launcher': ['identical: «PROTEÍNA» + «Elegí 1 · Requerido», choices + deltas, disabled «Elegí tu proteína»', 'P1 data gap: no photo URL → the prototype\'s own empty photo frame', 'S5 data: rank / liked line'],
  'sheet-launcher-chosen': ['identical: «Requerido» (done), Pollo selected, «Agregar · L 342»', 'P1 data gap: no photo URL → the empty photo frame', 'S5 data: rank / liked line'],
};
const page = `<!doctype html><meta charset="utf-8"><title>S1b fidelity</title><style>body{font:14px system-ui;background:#EDEAE4;margin:24px}h2{margin:28px 0 8px}
.p{display:flex;gap:24px}.p figure{margin:0}.p img{width:${W}px;height:${H}px;border:1px solid #D7D3CB;border-radius:18px}figcaption{font-weight:700;margin-bottom:6px}</style>
<h1>S1b — prototype v6 (left) vs build (right), ${W}×${H}</h1>${STATES.map(([r, s]) => `<h2>${r} · ${s}</h2><ul>${(NOTES[s] || []).map((x) => `<li>${x.replace(/</g, '&lt;')}</li>`).join('')}</ul><div class="p"><figure><figcaption>prototype v6</figcaption><img src="shots/${r}.${s}.proto.png"></figure><figure><figcaption>build</figcaption><img src="shots/${r}.${s}.build.png"></figure></div>`).join('')}`;
fs.writeFileSync(path.join(HERE, 'index.html'), page);
ws.close(); chrome.kill('SIGTERM'); server.close();
setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : `shots: ${STATES.length * 2} → review/capp-s1/shots/`); process.exit(errors.length ? 1 : 0); }, 300);
