// REVIEW ONLY — «Marca» + the F-2 notice side-by-side. For every frame of the two owner-approved mockups (copied into ./mockup):
//   MOCKUP-portal-marca.html (R1pshGArpS5Af2tzcdCvTW)                  B1, B2, B3, B4 (1280) and P1 (390)
//   MOCKUP-portal-platform-changes-notice.html (ENrjdkJmw3mzy9PkFCy4D1)  N1, N2 (1280) and P1 (390) — here «np1»
// the MOCKUP's own frame (its iframe for that frame + theme, shown at scale 1, pinned to the top-left of the viewport) beside the
// REAL portal (xpizza-portal/index.html with its real modules and styles.css; firebase.js / auth.js / invite-mail.js swapped for
// ./stubs, ./fixture.js answering the Cloud Functions calls in the servers' shapes), in headless Chrome over the DevTools protocol,
// LIGHT and DARK, at each frame's own width × height. Not shot: C1 / C2 / P2 (the menu rules — parked, not built).
// Output: shots/{frame}.{theme}.{mock|build}.png (raw, git-ignored) and shots/{frame}.{theme}.pair.png = mockup | build | 50 % overlay;
// index.html lists them.
// Run: node review/portal-marca/shoot.mjs        (SHOOT_ONLY=b2,n1 → just those frames, merged into the last report)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'shots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const STUB = { '/xpizza-portal/firebase.js': 'stubs/firebase.js', '/xpizza-portal/auth.js': 'stubs/auth.js', '/xpizza-portal/invite-mail.js': 'stubs/invite-mail.js' };
const MARCA = 'MOCKUP-portal-marca.html';
const NOTICE = 'MOCKUP-portal-platform-changes-notice.html';

// ── the mockups' sample data ────────────────────────────────────────────────────────────────────────────────────────────────
const OWNER = ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read',
  'availability.set', 'device.pair', 'device.revoke', 'device.list', 'location.prep', 'location.pause', 'location.hours', 'team.invite', 'team.revoke', 'brand.settings'];
const BR = [['r_norte', 'Bulevar del Norte'], ['r_centro', 'Centro'], ['r_trejo', 'Col. Trejo']];
const row = ([rid, name], role, caps) => ({ rid, brand_id: 'marca_v', role, state: 'member', caps, name, identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50497128830' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 1, last_order_today: 120 });
const E1 = () => ({ brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches: BR.map((b) => row(b, 'owner', OWNER)), membership_writes_enabled: false });
const NOTE = 'Pasá por la ventanilla de la izquierda y decí tu número de pedido.';

// page helpers (evaluated in the portal)
const H = `
  window.__vis = (els) => Array.from(els).find((e) => e.offsetParent !== null);
  window.__btn = (t, root) => Array.from((root || document).querySelectorAll('button')).find((b) => b.offsetParent !== null && (b.textContent.trim() === t || (b.getAttribute('aria-label') || '') === t));
  window.__marca = () => __vis(Array.from(document.querySelectorAll('button.nav, button.mn')).filter((b) => b.textContent.trim() === 'Marca'));
  window.__type = (id, v) => { const i = document.getElementById(id); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const openMarca = '__marca().click()';
const terracota = "document.querySelector('.mk-sw[data-accent=\"terracota\"]').click()";
const note = `__type('mk-note', ${JSON.stringify(NOTE)})`;
const save = "__btn('Guardar cambios').click()";
// B4: the mockup scrolls the page so «Datos de Sherpa» sits 24 px under the top
const toDatos = "(() => { const p = document.getElementById('mk-datos'); p.scrollIntoView({ block: 'start' }); const se = document.scrollingElement || document.documentElement; se.scrollTop -= 24; })()";
const reset = "__btn('Volver al menú publicado', document.querySelector('#detail .unpub')).click()";
const WAIT = (ms) => ({ wait: ms });

// [frame id, mockup file, mockup frame key, [w, h] (the mockup frame's own size), scenario, steps]
const FRAMES = [
  ['b1', MARCA, 'B1', [1280, 1480], { e1: E1() }, [openMarca, WAIT(500)]],
  ['b2', MARCA, 'B2', [1280, 1480], { e1: E1() }, [openMarca, WAIT(500), terracota, note]],   // the mockup's uploaded logo is M2 (LOGO_ENABLED = false)
  ['b3', MARCA, 'B3', [1280, 760], { e1: E1() }, [openMarca, WAIT(500), terracota, note, save, WAIT(350)]],
  ['b4', MARCA, 'B4', [1280, 560], { e1: E1() }, [openMarca, WAIT(500), toDatos]],
  ['p1', MARCA, 'P1', [390, 2080], { e1: E1() }, [openMarca, WAIT(500)]],
  ['n1', NOTICE, 'N1', [1280, 760], { e1: E1(), menu: { pending: true } }, []],
  ['n2', NOTICE, 'N2', [1280, 760], { e1: E1(), menu: { unpublishable: true }, reset409: true }, [reset, WAIT(400)]],
  ['np1', NOTICE, 'P1', [390, 1180], { e1: E1(), menu: { pending: true } }, []],
];
const THEMES = ['light', 'dark'];
const ONLY = process.env.SHOOT_ONLY ? process.env.SHOOT_ONLY.split(',') : null;

// ── server ──
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = STUB[p] ? path.join(HERE, STUB[p]) : path.join(ROOT, p.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (p === '/xpizza-portal/index.html') {
    body = body.toString('utf8').replace('<script src="sherpa-client.js"></script>', '<script src="/review/portal-marca/fixture.js"></script>\n<script src="sherpa-client.js"></script>');
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marca-shoot-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalIn = async (s, expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text); return r.result.value; };

async function page(w, h, theme) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  return { targetId, sessionId };
}
async function shot(s, file, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, s);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}
// the mockup page draws every frame as an iframe titled `${key} ${label}, ${w} px, ${theme}` (srcdoc carries its data-theme),
// scaled down inside a .fbox. Pin THAT iframe's box to the viewport's top-left at scale 1 (no reparenting: the iframe keeps its document).
const PIN = (key, theme, w, h) => `(() => {
  const f = Array.from(document.querySelectorAll('.fbox iframe')).find((x) => x.title.startsWith(${JSON.stringify(`${key} `)}) && x.title.endsWith(${JSON.stringify(`, ${theme}`)}));
  if (!f) return false;
  const box = f.parentElement; f.style.transform = 'none';
  box.style.cssText = 'position:fixed;left:0;top:0;width:${w}px;height:${h}px;z-index:2147483647;border:0;border-radius:0;overflow:hidden';
  document.documentElement.style.overflow = 'hidden'; window.scrollTo(0, 0);
  return f.contentDocument && f.contentDocument.readyState === 'complete';
})()`;

fs.mkdirSync(OUT, { recursive: true });
const report = [];
for (const [frame, mockFile, key, [w, h], scn, steps] of FRAMES) {
  if (ONLY && !ONLY.includes(frame)) continue;
  for (const theme of THEMES) {
    // the mockup's frame
    const m = await page(w, h, theme);
    await send('Page.navigate', { url: `${base}/review/portal-marca/mockup/${mockFile}` }, m.sessionId);
    await sleep(1500);
    let mock = false;
    try { mock = await evalIn(m.sessionId, PIN(key, theme, w, h)); } catch (e) { mock = false; }
    // the page's own resize listener re-scales on viewport changes; re-pin after a beat in case it ran
    await sleep(300);
    if (mock) { await evalIn(m.sessionId, PIN(key, theme, w, h)); await sleep(200); await shot(m.sessionId, path.join(OUT, `${frame}.${theme}.mock.png`), { x: 0, y: 0, width: w, height: h }); }
    await send('Target.closeTarget', { targetId: m.targetId });
    // the real portal
    const b = await page(w, h, theme);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__SCN = ${JSON.stringify(scn)};` }, b.sessionId);
    await send('Page.navigate', { url: `${base}/xpizza-portal/index.html` }, b.sessionId);
    await sleep(1600);
    // the portal ships data-theme="light" on <html>; set the theme the way its toggle does
    await evalIn(b.sessionId, `document.documentElement.setAttribute('data-theme', '${theme}')`);
    await evalIn(b.sessionId, H);
    const errs = [];
    for (const st of steps) {
      try {
        if (typeof st === 'string') { await evalIn(b.sessionId, st); await sleep(180); }
        else if (st.wait) await sleep(st.wait);
      } catch (e) { errs.push(`${JSON.stringify(st).slice(0, 80)}: ${e.message}`); }
    }
    await sleep(400);
    // the clip is in DOCUMENT coordinates: a scrolled frame (B4) is clipped at its scroll offset, not at the top
    const sy = Number(await evalIn(b.sessionId, 'String(Math.round((document.scrollingElement || document.documentElement).scrollTop))')) || 0;
    await shot(b.sessionId, path.join(OUT, `${frame}.${theme}.build.png`), { x: 0, y: sy, width: w, height: h });
    const posts = await evalIn(b.sessionId, 'JSON.stringify(window.__brandPosts || [])');
    await send('Target.closeTarget', { targetId: b.targetId });
    report.push({ frame, mockup: `${mockFile}#${key}`, theme, w, h, mock: !!mock, errs, brandPosts: JSON.parse(posts) });
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
    if not os.path.exists(os.path.join(out, stem + '.build.png')): continue
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
fs.writeFileSync(path.join(HERE, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Marca y aviso de Sherpa · lado a lado</title><style>body{font-family:system-ui;margin:16px;background:#f4f4f2}img{max-width:100%;border:1px solid #ccc}h2{font-size:15px}</style>
${report.map((r) => `<h2>${r.frame} · ${r.mockup} · ${r.theme} · ${r.w}</h2><img src="shots/${r.frame}.${r.theme}.pair.png" alt="${r.frame} ${r.theme}">`).join('\n')}`);
ws.close(); chrome.kill(); server.close();
console.log(JSON.stringify(report.filter((r) => r.errs.length || !r.mock)));
console.log(`shots: ${report.length} → ${OUT}`);
