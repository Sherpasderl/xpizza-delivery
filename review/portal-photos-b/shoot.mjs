// REVIEW ONLY — DISH PHOTOS B side-by-side (PLAN-dish-photos r2 §4.2): for every frame of the owner-approved
// MOCKUP-portal-dish-photo.html (copied into ./mockup with its photos), the MOCKUP's own frame (the page isolates a frame with
// its #id target) beside the REAL portal (xpizza-portal/index.html with its real modules and styles.css; firebase.js / auth.js
// / invite-mail.js swapped for ./stubs, ./fixture.js answering the Cloud Functions calls and the signed PUT in §2.2's shapes),
// in headless Chrome over the DevTools protocol, in LIGHT and DARK, at 1280 and 390. A picked photo goes through the real
// <input type=file> (DOM.setFileInputFiles) with the mockup's own JPEGs. Output: shots/{frame}.{theme}.{mock|build}.png (raw,
// git-ignored) and shots/{frame}.{theme}.pair.png = mockup | build | 50 % overlay; index.html lists them.
// Run: node review/portal-photos-b/shoot.mjs        (SHOOT_ONLY=p1,p3 → just those frames, merged into the last report)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'shots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
const STUB = { '/xpizza-portal/firebase.js': 'stubs/firebase.js', '/xpizza-portal/auth.js': 'stubs/auth.js', '/xpizza-portal/invite-mail.js': 'stubs/invite-mail.js' };
const PH = (f) => `/review/portal-photos-b/mockup/mockup-dish-photo/${f}`;
const JPG = (f) => path.join(HERE, 'mockup', 'mockup-dish-photo', f);

// ── the mockup's sample data ────────────────────────────────────────────────────────────────────────────────────────────────
const OWNER = ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.pause', 'team.invite', 'team.revoke', 'brand.settings'];
const MGR_MENU = ['catalog.read_editor', 'catalog.edit', 'availability.set', 'device.list', 'location.prep', 'location.pause'];
const MGR_RO = ['availability.set', 'device.list', 'location.prep', 'location.pause'];
const BR = [['r_norte', 'Bulevar del Norte'], ['r_centro', 'Centro'], ['r_trejo', 'Col. Trejo']];
const row = ([rid, name], role, caps) => ({ rid, brand_id: 'marca_v', role, state: 'member', caps, name, identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50497128830' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 1, last_order_today: 120 });
const E1 = (role = 'owner', caps = OWNER) => ({ brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches: BR.map((b) => row(b, role, caps)), membership_writes_enabled: false });
const it = (key, cat, price, desc) => ({ key, price, display: { name: key, cat, price, ...(desc ? { desc } : {}) } });
const ITEMS = [it('Margarita', 'cl', 280, 'Tomate, mozzarella fresca y albahaca'), it('Pepperoni', 'cl', 310, 'Pepperoni y mozzarella'), it('Hawaiana', 'cl', 300, 'Jamón, piña y mozzarella'),
  it('Cuatro quesos', 'es', 340, 'Mozzarella, gouda, parmesano y azul'), it('Suprema', 'es', 360, 'Carnes y vegetales'), it('Horchata', 'be', 45)];
const AVAIL = (photos = {}) => ({ branches: BR.map(([rid]) => ({ rid, published: true, resets_daily: true,
  items: ITEMS.map((i) => ({ key: i.key, name: i.key, price: i.price, description: i.display.desc || '', category_id: i.display.cat, category_name: { cl: 'Clásicas', es: 'Especiales', be: 'Bebidas' }[i.display.cat] })),
  unavailable: { r_norte: [], r_centro: ['Hawaiana'], r_trejo: ['Suprema', 'Horchata'] }[rid], ...(Object.keys(photos).length ? { photos } : {}) })) });
const MENU = (o = {}) => ({ items: ITEMS, enabled: true, ...o });
const PUB = (pid, f) => ({ [pid]: { card: PH(f), hero: PH(f) } });
const DRAFT = (pid, f) => ({ [pid]: { card: PH(f), hero: PH(f), expiresAt: Date.now() + 3600e3 } });
const line = (key, o, n) => ({ surface: 'item', key, field: 'photo', old: o, new: n });

// page helpers (evaluated in the portal)
const H = `
  window.__q = (sel) => Array.from(document.querySelectorAll(sel));
  window.__btn = (t, root) => Array.from((root || document).querySelectorAll('button')).find((b) => b.offsetParent !== null && (b.textContent.trim() === t || (b.getAttribute('aria-label') || '') === t));
  window.__row = (n) => __q('#detail .irow').find((r) => r.querySelector('.nm') && r.querySelector('.nm').firstChild.textContent === n);
`;
const openDrawer = (n) => `__row(${JSON.stringify(n)}).querySelector('.rowchev').click()`;
const camera = (n) => `__row(${JSON.stringify(n)}).querySelector('button.thumb').click()`;
const zone = "document.querySelector('#drawer button.uploader.phdesk').click()";
const listo = "__btn('Listo', document.getElementById('drawer')).click()";
const GALLERY = "__btn('Elegir de la galería', document.getElementById('drawer')).click()";   // a phone: the expanded zone's picker
const zoom = (v) => `(() => { const r = document.querySelector('#drawer input[type=range]'); r.value = '${v}'; r.dispatchEvent(new Event('input')); })()`;
const FILE = (p) => ({ file: p });
const WAIT = (ms) => ({ wait: ms });

// [frame id, mockup selector (on the #target), viewport, scenario, steps, build clip selector?]
const FRAMES = [
  ['p1', '#p1 .mk-shell', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni')]],
  ['p1-nuevo', '#p1 .mk-drawerinset', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, ["__btn('Agregar producto').click()"], '#drawer'],
  ['p2', '#p2 .mk-shell', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni'), "document.querySelector('#drawer button.uploader.phdesk').focus()"]],
  ['p3', '#p3 .mk-shell', [1280, 1000], { e1: E1(), menu: MENU(), avail: AVAIL() }, [camera('Pepperoni'), FILE(JPG('09-pepperoni.jpg')), WAIT(300), zoom(118)]],
  ['p4', '#p4 .mk-shell', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL(), put: 'hold' }, [camera('Pepperoni'), FILE(JPG('09-pepperoni.jpg')), WAIT(300), listo, WAIT(200)]],
  ['p5', '#p5 .mk-shell', [1280, 820], { e1: E1(), menu: MENU({ photos: { Margarita: { state: 'pid', pid: 'pidMar' } }, previews: PUB('pidMar', '08-margherita.jpg') }), avail: AVAIL({ Margarita: { card: PH('08-margherita.jpg') } }), process: [503, { error: 'unavailable', retryable: true }] },
    [openDrawer('Margarita'), "__btn('Cambiar', document.getElementById('drawer')).click()", FILE(JPG('05-mushroom.jpg')), WAIT(300), listo, WAIT(300)]],
  ['p5-sinfoto', '#p5 .mk-drawerinset', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL(), process: [503, { error: 'unavailable', retryable: true }] },
    [camera('Pepperoni'), FILE(JPG('09-pepperoni.jpg')), WAIT(300), listo, WAIT(300)], '#drawer .dwb'],
  ['p6a', '#p6 .mk-drawerinset >>0', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni'), zone, FILE('BIG'), WAIT(200)], '#drawer .dwb'],
  ['p6b', '#p6 .mk-drawerinset >>1', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni'), zone, FILE('GIF'), WAIT(200)], '#drawer .dwb'],
  ['p6c', '#p6 .mk-drawerinset >>2', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni'), zone, FILE('SMALL'), WAIT(300)], '#drawer .dwb'],
  ['p7', '#p7 .mk-shell', [1280, 820], { e1: E1(), menu: MENU(), avail: AVAIL() }, [camera('Pepperoni'), FILE(JPG('09-pepperoni.jpg')), WAIT(300), listo, WAIT(400)]],
  ['p7-quitar', '#p7 .mk-drawerinset', [1280, 820], { e1: E1(), menu: MENU({ photos: { Hawaiana: { state: 'pid', pid: 'pidHam' } }, previews: PUB('pidHam', '16-ham.jpg') }), avail: AVAIL() },
    [openDrawer('Hawaiana'), "__btn('Quitar', document.getElementById('drawer')).click()"], '#drawer .dwb'],
  ['p7-fila', '#p7 .mk-rowinset', [1280, 820], { e1: E1(), menu: MENU({ photos: { Hawaiana: { state: 'pid', pid: 'pidHam' } }, previews: PUB('pidHam', '16-ham.jpg') }), avail: AVAIL() },
    [openDrawer('Hawaiana'), "__btn('Quitar', document.getElementById('drawer')).click()", "__btn('Cerrar', document.getElementById('drawer')).click()"], 'ROW:Hawaiana'],
  ['p8', '#p8 .mk-shell', [1280, 1000], { e1: E1(), menu: MENU({ fiscal: true, photos: { Pepperoni: { state: 'pid', pid: 'pidPep' }, Margarita: { state: 'pid', pid: 'pidMar' }, Hawaiana: { state: 'removed' } },
    previews: { ...DRAFT('pidPep', '09-pepperoni.jpg'), ...DRAFT('pidMar', '08-margherita.jpg'), ...PUB('pidMarOld', '05-mushroom.jpg'), ...PUB('pidHam', '16-ham.jpg') } }), avail: AVAIL(),
    diff: { changed: [line('Pepperoni', { kind: 'legacy' }, { kind: 'pid', pid: 'pidPep' }), line('Margarita', { kind: 'pid', pid: 'pidMarOld' }, { kind: 'pid', pid: 'pidMar' }), line('Hawaiana', { kind: 'pid', pid: 'pidHam' }, { kind: 'removed' })], added: [], removed: [], renamed: [], largeChangeSet: [] } },
    ["document.getElementById('review').click()", WAIT(400)]],
  ['p8-sinsello', '#p8 .mk-modalinset', [1280, 1000], { e1: E1(), menu: MENU({ photos: { Pepperoni: { state: 'pid', pid: 'pidPep' }, Margarita: { state: 'pid', pid: 'pidMar' }, Hawaiana: { state: 'removed' } },
    previews: { ...DRAFT('pidPep', '09-pepperoni.jpg'), ...DRAFT('pidMar', '08-margherita.jpg'), ...PUB('pidMarOld', '05-mushroom.jpg'), ...PUB('pidHam', '16-ham.jpg') } }), avail: AVAIL(),
    diff: { changed: [line('Pepperoni', { kind: 'legacy' }, { kind: 'pid', pid: 'pidPep' }), line('Margarita', { kind: 'pid', pid: 'pidMarOld' }, { kind: 'pid', pid: 'pidMar' }), line('Hawaiana', { kind: 'pid', pid: 'pidHam' }, { kind: 'removed' })], added: [], removed: [], renamed: [], largeChangeSet: [] } },
    ["document.getElementById('review').click()", WAIT(400)], '#scrim .modal'],
  ['p9', '#p9 .mk-shell', [1280, 820], { e1: E1(), menu: MENU({ photos: { Pepperoni: { state: 'pid', pid: 'pidPep' } }, previews: DRAFT('pidPep', '09-pepperoni.jpg') }), avail: AVAIL(),
    diff: { changed: [line('Pepperoni', { kind: 'legacy' }, { kind: 'pid', pid: 'pidPep' })], added: [], removed: [], renamed: [], largeChangeSet: [] } },
    ["document.getElementById('review').click()", WAIT(400), "document.getElementById('pubbtn').click()", WAIT(500)]],
  ['p10a', '#p10a .mk-shell', [1280, 820], { uid: 'uMgr', e1: E1('manager', MGR_MENU), menu: MENU({ viaRequest: true }), avail: AVAIL() },
    [camera('Pepperoni'), FILE(JPG('09-pepperoni.jpg')), WAIT(300), listo, WAIT(400)]],
  ['p10b', '#p10b .mk-shell', [1280, 560], { uid: 'uMgrRo', e1: E1('manager', MGR_RO), menu: MENU(), avail: AVAIL({ Margarita: { card: PH('08-margherita.jpg') }, Pepperoni: { card: PH('09-pepperoni.jpg') } }) }, []],
  // phone (390): the mockup's own phone frames
  ['s-p1', '#s-p1 .mk-shell', [390, 844], { e1: E1(), menu: MENU(), avail: AVAIL() }, []],
  ['s-p1d', '#s-p1d .mk-shell', [390, 844], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni')]],
  ['s-p2', '#s-p2 .mk-shell', [390, 844], { e1: E1(), menu: MENU(), avail: AVAIL() }, [openDrawer('Pepperoni'), zone]],   // a phone: the zone expands in place
  ['s-p3', '#s-p3 .mk-shell', [390, 844], { e1: E1(), menu: MENU(), avail: AVAIL() }, [camera('Pepperoni'), GALLERY, FILE(JPG('09-pepperoni.jpg')), WAIT(300), zoom(118)]],
  ['s-p7', '#s-p7 .mk-shell', [390, 844], { e1: E1(), menu: MENU(), avail: AVAIL() }, [camera('Pepperoni'), GALLERY, FILE(JPG('09-pepperoni.jpg')), WAIT(300), listo, WAIT(400)]],
];
const THEMES = ['light', 'dark'];
const ONLY = process.env.SHOOT_ONLY ? process.env.SHOOT_ONLY.split(',') : null;

// ── the P6 files (generated: a > 10 MB JPEG, a GIF, a 300×200 PNG) ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-b-files-'));
execFileSync('python3', ['-c', `
import sys
from PIL import Image
d = sys.argv[1]
Image.new('RGB', (300, 200), (200, 120, 60)).save(d + '/small.png')
Image.new('RGB', (600, 500), (90, 90, 90)).save(d + '/anim.gif')
with open(d + '/big.jpg', 'wb') as f:
    Image.new('RGB', (800, 600), (10, 10, 10)).save(f, 'JPEG')
    f.write(b'\\0' * (10485760 + 1))
`, TMP]);
const SPECIAL = { BIG: path.join(TMP, 'big.jpg'), GIF: path.join(TMP, 'anim.gif'), SMALL: path.join(TMP, 'small.png') };

// ── server ──
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = STUB[p] ? path.join(HERE, STUB[p]) : path.join(ROOT, p.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (p === '/xpizza-portal/index.html') {
    body = body.toString('utf8').replace('<script src="sherpa-client.js"></script>', '<script src="/review/portal-photos-b/fixture.js"></script>\n<script src="sherpa-client.js"></script>');
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-b-shoot-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalIn = async (s, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;

async function page(w, h, theme) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('DOM.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  return { targetId, sessionId };
}
async function clipOf(s, selector) {
  const [sel, nth] = selector.split(' >>');
  return evalIn(s, `(() => { const els = Array.from(document.querySelectorAll(${JSON.stringify(sel.trim())})); const e = els[${Number(nth || 0)}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
}
async function shot(s, file, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, s);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}
async function setFile(s, filePath) {
  const { root } = await send('DOM.getDocument', { depth: 1 }, s);
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' }, s);
  if (!nodeIds.length) throw new Error('no picker input open');
  await send('DOM.setFileInputFiles', { files: [filePath], nodeId: nodeIds[nodeIds.length - 1] }, s);
}

fs.mkdirSync(OUT, { recursive: true });
const report = [];
for (const [frame, mockSel, [w, h], scn, steps, buildSel] of FRAMES) {
  if (ONLY && !ONLY.includes(frame)) continue;
  for (const theme of THEMES) {
    // the mockup's frame
    const m = await page(w, h, theme);
    const target = mockSel.split(' ')[0];
    await send('Page.navigate', { url: `${base}/review/portal-photos-b/mockup/MOCKUP-portal-dish-photo.html${target}` }, m.sessionId);
    await sleep(900);
    // both pages pin data-theme="light" on <html>; the theme toggle switches it — so the theme is set the way the toggle does
    await evalIn(m.sessionId, `document.documentElement.setAttribute('data-theme', '${theme}')`);
    await sleep(200);
    const mclip = await clipOf(m.sessionId, mockSel);
    if (mclip) await shot(m.sessionId, path.join(OUT, `${frame}.${theme}.mock.png`), mclip);
    await send('Target.closeTarget', { targetId: m.targetId });
    // the real portal
    const b = await page(w, h, theme);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__SCN = ${JSON.stringify(scn)};` }, b.sessionId);
    await send('Page.navigate', { url: `${base}/xpizza-portal/index.html` }, b.sessionId);
    await sleep(1600);
    await evalIn(b.sessionId, `document.documentElement.setAttribute('data-theme', '${theme}')`);
    await evalIn(b.sessionId, H);
    const errs = [];
    for (const st of steps) {
      try {
        if (typeof st === 'string') { await evalIn(b.sessionId, st); await sleep(180); }
        else if (st.wait) await sleep(st.wait);
        else if (st.file) { await setFile(b.sessionId, SPECIAL[st.file] || st.file); await sleep(250); }
      } catch (e) { errs.push(`${JSON.stringify(st).slice(0, 80)}: ${e.message}`); }
    }
    await sleep(400);
    let bclip = null;
    if (buildSel && buildSel.startsWith('ROW:')) bclip = await evalIn(b.sessionId, `(() => { const r = __row(${JSON.stringify(buildSel.slice(4))}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    else if (buildSel) bclip = await clipOf(b.sessionId, buildSel);
    // an inset is a slice of a drawer (from its header, or from its body .dwb): the build's same part, clipped to the inset's height
    if (bclip && mclip && buildSel && !buildSel.startsWith('ROW:')) bclip = { ...bclip, height: Math.min(bclip.height, mclip.height) };
    await shot(b.sessionId, path.join(OUT, `${frame}.${theme}.build.png`), bclip);
    await send('Target.closeTarget', { targetId: b.targetId });
    report.push({ frame, theme, w, h, mock: !!mclip, errs });
  }
}
// mockup | build | 50 % overlay (system python + PIL)
execFileSync('python3', ['-c', `
import sys, os
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
try: font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 13)
except OSError: font = ImageFont.load_default()
for f in sorted(os.listdir(out)):
    if not f.endswith('.mock.png'): continue
    stem = f[:-9]
    a = Image.open(os.path.join(out, f)).convert('RGB'); b = Image.open(os.path.join(out, stem + '.build.png')).convert('RGB')
    W, H = max(a.width, b.width), max(a.height, b.height)
    pa = Image.new('RGB', (W, H), (255, 0, 255)); pa.paste(a, (0, 0)); pb = Image.new('RGB', (W, H), (255, 0, 255)); pb.paste(b, (0, 0))
    ov = Image.blend(pa, pb, 0.5)
    gap = 24; c = Image.new('RGB', (3 * W + 2 * gap, H + 28), (230, 230, 226))
    for i, (im, lab) in enumerate([(pa, 'APROBADO (mockup)'), (pb, 'BUILD (portal real)'), (ov, 'SUPERPUESTO 50 %')]):
        c.paste(im, (i * (W + gap), 28)); ImageDraw.Draw(c).text((i * (W + gap) + 8, 7), lab, fill=(0, 0, 0), font=font)
    c.save(os.path.join(out, stem + '.pair.png'))
`, OUT]);
if (ONLY) {
  const prev = fs.existsSync(path.join(OUT, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')) : [];
  report.unshift(...prev.filter((r) => !ONLY.includes(r.frame)));
}
fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
fs.writeFileSync(path.join(HERE, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Fotos de producto · lado a lado</title><style>body{font-family:system-ui;margin:16px;background:#f4f4f2}img{max-width:100%;border:1px solid #ccc}h2{font-size:15px}</style>
${report.map((r) => `<h2>${r.frame} · ${r.theme} · ${r.w}</h2><img src="shots/${r.frame}.${r.theme}.pair.png" alt="${r.frame} ${r.theme}">`).join('\n')}`);
ws.close(); chrome.kill(); server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify(report.filter((r) => r.errs.length || !r.mock)));
console.log(`shots: ${report.length} → ${OUT}`);
