// REVIEW ONLY — Sucursales 1b side-by-side (PLAN-portal-ui-slice1b-sucursales r4 §6 «Real render»): for every frame, the
// APPROVED mockup (canvas CvvXXuDUijMvA1pRZ4L2rd v25, component SucV2e rendered by the canvas's own dc-runtime, copied into
// ./mockup) beside the REAL portal (xpizza-portal/index.html with its real modules and styles.css; only firebase.js / auth.js /
// invite-mail.js are swapped for ./stubs, and ./fixture.js answers the Cloud Functions calls), in headless Chrome over the
// DevTools protocol, at 1280 and 390 wide. Output: review/portal-1b/shots/{frame}.{w}.{mock|build}.png + {frame}.{w}.pair.png
// (side by side) and index.html. Sample names are the frames' own sample data. Run: node review/portal-1b/shoot.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'shots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const STUB = { '/xpizza-portal/firebase.js': 'stubs/firebase.js', '/xpizza-portal/auth.js': 'stubs/auth.js', '/xpizza-portal/invite-mail.js': 'stubs/invite-mail.js' };

// ── the frames' sample data, as E1+ replies ───────────────────────────────────────────────────────────────────────────────────
const D = (s, e) => ({ open: true, start: s, end: e });
const STD = { mon: D('11:00', '22:00'), tue: D('11:00', '22:00'), wed: D('11:00', '22:00'), thu: D('11:00', '22:00'), fri: D('11:00', '23:00'), sat: D('11:00', '23:00'), sun: D('12:00', '21:00') };
const PARTIAL = { mon: D('11:00', '22:00'), tue: D('11:00', '22:00'), wed: D('11:00', '22:00'), thu: D('11:00', '22:00'), fri: D('11:00', '22:00') };
const OWNER = ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.pause', 'location.contact', 'location.profile', 'team.invite', 'team.revoke', 'brand.settings'];
const OWNER_STAGED = ['availability.set', 'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.contact', 'location.profile', 'team.invite', 'team.revoke'];
const MANAGER = ['stats.read', 'availability.set', 'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.pause', 'location.contact'];
const CTRL = (state) => ({ state, paused_until: null, pause_reason: null, pause_since: null });
const BID = 'marca_v';
function row(rid, name, o = {}) {
  const prof = { location_name: name, phone: o.phone || '+50497128830', hours: o.hours || STD, prep_default_min: o.prep || 25 };
  const life = o.life || 'active';
  return { rid, brand_id: BID, role: o.role || 'owner', state: life === 'staged' ? 'staged' : 'member', caps: o.caps || (life === 'staged' ? OWNER_STAGED : OWNER), name,
    identity_version: 7, editable: { prep_default_min: prof.prep_default_min }, readonly: { active: life === 'active', radius_km: o.km || 3.5, hours: prof.hours, phone: prof.phone },
    control: CTRL(life === 'active' ? 'open' : 'inactive'), devices: o.devices ?? 1, last_order_today: 'last' in o ? o.last : 641, lifecycle: life, profile: prof,
    location: { address_line: o.addr || 'Bulevar Morazán, frente a Col. Trejo', address_reference: o.ref || 'Plaza comercial, local 4', hub: { lat: 15.5, lng: -88 }, zone_radius_km: o.km || 3.5 },
    version: 7, ...(o.legacy ? { legacy: true } : {}), ...(o.readiness ? { readiness: o.readiness } : {}) };
}
const TREJO = (o = {}) => row('r_trejo', 'Col. Trejo', o);
const CENTRO = row('r_centro', 'Centro', { addr: '3 Av., 5 Calle NO, Barrio Guamilito', km: 4, prep: 20, devices: 2, last: 1284, ref: 'Frente al parque central' });
const NORTE = row('r_norte', 'Bulevar del Norte', { life: 'inactive', addr: 'Col. Jardines del Valle, Blvd. del Norte', km: 5, last: 212, readiness: { unmet: [] } });
const ANDES = (readiness = { unmet: ['identity_invalid', 'no_handheld_online'], identity_gaps: ['hours'] }) => row('r_andes', 'Col. Los Andes', { life: 'staged', addr: 'Col. Los Andes, 1 Calle, local 2', ref: 'Frente al parque, local esquinero', km: 5, prep: 20, devices: 0, last: null, phone: '+50496017744', hours: PARTIAL, readiness });
const JARDINES = { rid: 'r_jardines', brand_id: BID, lifecycle: 'draft', profile: { location_name: 'Jardines del Valle', phone: '+50433905521', hours: STD, prep_default_min: 20 }, location: null, pending_location: true, version: 'd.op.1.1' };
const BRAND = (drafts = [JARDINES], caps = ['brand.locations']) => ({ brand_id: BID, name: 'Pizzería Del Valle', caps, activation: 'on', drafts });
const E1 = (branches, brands = [BRAND()]) => ({ brands, branches, membership_writes_enabled: true });
const ALL = E1([CENTRO, TREJO(), NORTE, ANDES()]);

// helpers evaluated in the page
const H = `
  window.__q = (sel) => Array.from(document.querySelectorAll(sel));
  window.__btn = (t) => __q('button').find((b) => b.offsetParent !== null && (b.getAttribute('aria-label') || '').startsWith(t) || (b.offsetParent !== null && b.textContent.trim() === t));
  window.__type = (id, v) => { const i = document.getElementById(id); i.focus(); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur(); };
`;
const open = (name) => `__btn(${JSON.stringify(name)}).click()`;
// frame → [ mockup screen, portal scenario { e1, writes?, steps: [js…] } ]
const FRAMES = {
  s2: { scn: { e1: [ALL] }, steps: [] },
  's2-empty': { scn: { e1: [E1([], [BRAND([])])] }, steps: [] },
  's2-onedraft': { scn: { e1: [E1([], [BRAND([JARDINES])])] }, steps: [] },
  s3: { scn: { e1: [ALL] }, steps: [open('Col. Trejo')] },
  's3-bad': { mock: 's3-bad', scn: { e1: [ALL] }, steps: [open('Col. Trejo'), "__type('f1b-tel', '2234-5678')"] },
  's3-legacy': { scn: { e1: [E1([CENTRO, TREJO({ legacy: true }), NORTE, ANDES()])] }, steps: [open('Col. Trejo')] },
  's3-inactive': { scn: { e1: [E1([CENTRO, TREJO({ life: 'inactive', readiness: { unmet: [] } }), NORTE, ANDES()])] }, steps: [open('Col. Trejo')] },
  s5: { scn: { e1: [ALL] }, steps: [open('Col. Trejo'), "__btn('Abre el Jue').click()", "__type('h1b-fri-start', '18:00')", "__type('h1b-fri-end', '01:00')", "__type('h1b-sat-start', '12:00')", "__type('h1b-sat-end', '11:30')"] },
  s7: { scn: { e1: [ALL] }, steps: [open('Col. Trejo'), "__btn('Desactivar Col. Trejo').click()"] },
  s8: { scn: { e1: [ALL] }, steps: [open('Col. Los Andes')] },
  s8b: { scn: { e1: [E1([CENTRO, ANDES({ unmet: ['identity_invalid', 'no_handheld_online'], identity_gaps: ['location', 'zone'] })])] }, steps: [open('Col. Los Andes')] },
  s8c: { scn: { e1: [E1([CENTRO, ANDES({ unmet: ['brand_not_on'] })])] }, steps: [open('Col. Los Andes')] },
  s9a: { scn: { e1: [ALL] }, steps: ["__btn('Agregar sucursal').click()", "__type('nv1b-nombre', 'Jardines del Valle')", "__type('nv1b-tel', '3390 5521')"] },
  's9a-bad': { mock: 's9a-bad', scn: { e1: [ALL] }, steps: ["__btn('Agregar sucursal').click()", "__type('nv1b-nombre', 'Jardines del Valle')", "__type('nv1b-tel', '2234-5678')"] },
  s9b: { scn: { e1: [E1([CENTRO, TREJO(), NORTE, ANDES()], [BRAND([])]), E1([CENTRO, TREJO(), NORTE, ANDES()], [BRAND([JARDINES])])], writes: { createBranchDraft: [200, { rid: 'r_jardines', state: 'draft', version: 'd.op.1.1' }] } },
    steps: ["__btn('Agregar sucursal').click()", "__type('nv1b-nombre', 'Jardines del Valle')", "__type('nv1b-tel', '3390 5521')", "document.getElementById('nv1b-go').click()"] },
  s10: { scn: { e1: [ALL] }, steps: [open('Jardines del Valle'), "__btn('Eliminar borrador').click()"] },
  s11a: { scn: { uid: 'uMgr', e1: [E1([TREJO({ role: 'manager', caps: MANAGER })], [{ brand_id: BID, name: 'Pizzería Del Valle', caps: [], activation: 'on' }])] }, steps: [] },
};
const WIDTHS = [1280, 390];

// ── server ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = STUB[p] ? path.join(HERE, STUB[p]) : path.join(ROOT, p.replace(/^\/+/, ''));
  if (p.startsWith('/mock/')) file = path.join(HERE, 'mockup', p.slice(6));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (p === '/xpizza-portal/index.html') {
    body = body.toString('utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<script src="sherpa-client.js"></script>', '<script src="/review/portal-1b/fixture.js"></script>\n<script src="sherpa-client.js"></script>');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const q = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(q)) return q; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-shoot-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalIn = async (s, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;

async function page(width) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
  await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Tegucigalpa' }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  return { targetId, sessionId };
}
async function shot(s, file, width) {
  const h = Math.min(2600, await evalIn(s, 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 700)'));
  await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: width < 600 }, s);
  await sleep(250);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: h, scale: 1 } }, s);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 }, s);
}
const waitFor = async (s, expr, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await evalIn(s, expr)) return true; await sleep(100); } return false; };

fs.mkdirSync(OUT, { recursive: true });
const report = [];
for (const [frame, f] of Object.entries(FRAMES)) {
  for (const w of WIDTHS) {
    // mockup: a board file rendering SucV2e with this screen (as the canvas boards do)
    const board = `board-${frame}.${w}.dc.html`;   // next to SucV2e.dc.html: the runtime resolves dc-import by name, relative to the board
    fs.writeFileSync(path.join(HERE, 'mockup', board), `<!doctype html><html lang="es"><head><meta charset="utf-8"><script src="./support.js"></script></head><body><x-dc><helmet><style>body{margin:0}</style></helmet>
<div style="width:100%;${w < 600 ? 'max-width:390px;' : ''}min-height:100vh;box-sizing:border-box;font-family:'Helvetica Neue',system-ui,sans-serif;background:#FFFFFF"><dc-import name="SucV2e" screen="${f.mock || frame}" narrow="{{ ${w < 600} }}" hint-size="100%,1180px"></dc-import></div>
</x-dc><script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":1180}}'>class Component extends DCLogic { renderVals() { return {}; } }</script></body></html>`);
    const m = await page(w);
    await send('Page.navigate', { url: `${base}/mock/${board}` }, m.sessionId);
    const mok = await waitFor(m.sessionId, "document.body.innerText.includes('Sucursales') || document.body.innerText.includes('Datos')");
    await sleep(900);
    await shot(m.sessionId, path.join(OUT, `${frame}.${w}.mock.png`), w);
    await send('Target.closeTarget', { targetId: m.targetId });
    // build: the real portal
    const b = await page(w);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__SCN = ${JSON.stringify(f.scn)};` }, b.sessionId);
    await send('Page.navigate', { url: `${base}/xpizza-portal/index.html` }, b.sessionId);
    const bok = await waitFor(b.sessionId, "!document.getElementById('app').classList.contains('hidden') && document.getElementById('shopname').textContent !== '—'");
    await evalIn(b.sessionId, H);
    await evalIn(b.sessionId, "(document.getElementById('navsuc').classList.contains('hidden') ? null : document.getElementById('navsuc').click(), true)");
    await sleep(300);
    const errs = [];
    for (const step of f.steps) { try { await evalIn(b.sessionId, step); } catch (e) { errs.push(`${step}: ${e.message}`); } await sleep(250); }
    const stepErr = await evalIn(b.sessionId, 'window.__stepErr || null');
    await sleep(500);
    await shot(b.sessionId, path.join(OUT, `${frame}.${w}.build.png`), w);
    await send('Target.closeTarget', { targetId: b.targetId });
    report.push({ frame, w, mockReady: mok, buildReady: bok, errs, stepErr });
  }
}
// pairs (mockup | build) via the system python (PIL) — the image the classification reads
execFileSync('python3', ['-c', `
import sys, os
from PIL import Image, ImageDraw
out = sys.argv[1]
for f in sorted(os.listdir(out)):
    if not f.endswith('.mock.png'): continue
    stem = f[:-9]
    a = Image.open(os.path.join(out, f)).convert('RGB'); b = Image.open(os.path.join(out, stem + '.build.png')).convert('RGB')
    gap = 24; W = a.width + b.width + gap; Hh = max(a.height, b.height) + 28
    c = Image.new('RGB', (W, Hh), (230, 230, 226)); c.paste(a, (0, 28)); c.paste(b, (a.width + gap, 28))
    d = ImageDraw.Draw(c); d.text((8, 8), 'APROBADO (canvas v25)', fill=(0, 0, 0)); d.text((a.width + gap + 8, 8), 'BUILD (portal real)', fill=(0, 0, 0))
    c.save(os.path.join(out, stem + '.pair.png'))
`, OUT]);
fs.writeFileSync(path.join(HERE, 'shots', 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
fs.writeFileSync(path.join(HERE, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Sucursales 1b side by side</title><style>body{font-family:system-ui;margin:16px;background:#f4f4f2}img{max-width:100%;border:1px solid #ccc}h2{font-size:15px}</style>
${report.map((r) => `<h2>${r.frame} · ${r.w}</h2><img src="shots/${r.frame}.${r.w}.pair.png" alt="${r.frame} ${r.w}">`).join('\n')}`);
console.log(JSON.stringify(report.filter((r) => !r.mockReady || !r.buildReady || r.errs.length), null, 1));
console.log(`shots: ${report.length} pairs → ${OUT}`);
ws.close(); chrome.kill(); server.close(); process.exit(0);
