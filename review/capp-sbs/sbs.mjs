// Customer app — the Chrome side-by-side harness (advisor 11-02, the Chrome batch; owner usage rule: automatic diffs, ONE review page).
//   node review/capp-sbs/sbs.mjs --pkg <package-capp web bundle> --out <dir> [--only a,b] [--mock <D4c-grill dir>] [--set main|s2|tip]
//   (--set s2: the S2 checkout + adjustment scenes, scenes-s2.mjs — the bundle packaged WITH the sdkPay flag)
// What it does, per scene in scenes.mjs:
//   · serves the PACKAGED bundle (package-capp at the tip) and the mockups on 127.0.0.1 only;
//   · drives headless Chrome over raw CDP (no npm dependency); EVERY request leaving 127.0.0.1 is fulfilled from the fixture router
//     (fixtures.mjs: committed fixtures + the committed menu provisioner) — an UNMAPPED request fails the run (zero prod traffic);
//   · shoots the real scene and its mockup scene at the same CSS size and DPR 2, light and dark where asked;
//   · computes, in the browser, a pixel diff (% of pixels whose RGB distance > 48) + a highlighted overlay, the rendered-pair contrast
//     of every visible text node (WCAG: < 4.5:1, or < 3:1 large text), and — where a scene asks — the layout-shift total (CLS);
//   · writes the PNGs + results.json + ONE review page (index.html: real | mockup | diff, with the numbers). No image is ever read back
//     by the operator unless a scene is flagged.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { router, DIRECTORY_ENDPOINT, CLOCK_SHIM } from './fixtures.mjs';
import { SCENES } from './scenes.mjs';
import { S2_SCENES } from './scenes-s2.mjs';
import { TIP_SCENES } from './scenes-tip.mjs';   // --set tip: PLAN-capp-tip-step r6 vs MOCKUP-capp-tip-step-r2 (a bundle WITH the sdkPay flag)   // --set s2: a bundle packaged WITH the sdkPay flag (S2 method (A), advisor 11-09)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PKG = path.resolve(arg('--pkg')), OUT = path.resolve(arg('--out')), MOCK = path.resolve(arg('--mock', path.join(os.homedir(), 'Downloads/xpizza-D4c-grill')));
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(path.join(PKG, 'index.html'))) throw new Error(`--pkg ${PKG} is not a packaged bundle`);
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });

// ── the server: the bundle at /, the mockups at /__mock/ (read-only), SPA fallback as the bundle's _redirects says ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
// inside root ONLY: root itself or root + separator (a bare startsWith admitted a sibling sharing the prefix — Codex r1 P2-4); a bad
// %-escape is a 404, never a throw
const safeJoin = (root, p) => { let d; try { d = decodeURIComponent(p); } catch (_) { return null; } const f = path.normalize(path.join(root, d)); return f === root || f.startsWith(root + path.sep) ? f : null; };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = u.pathname.startsWith('/__mock/') ? safeJoin(MOCK, u.pathname.slice('/__mock/'.length)) : safeJoin(PKG, u.pathname === '/' ? '/index.html' : u.pathname);
  if (file && !u.pathname.startsWith('/__mock/') && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) file = path.join(PKG, 'index.html');   // _redirects: /* /index.html 200
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  if (fs.statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><title>blank</title>'); }   // the seed / diff pages
  // ruling (A): production has no directory endpoint yet (a launch gap, routed to 3a) — the ONE change to the packaged entry is this
  // runtime field, served from the committed s7a2 directory fixture; stated on every frame of the review page
  if (file === path.join(PKG, 'capp-runtime.js')) {
    const src = fs.readFileSync(file, 'utf8'), out = src.replace('"menu_endpoint":"getPublicMenu"', `"menu_endpoint":"getPublicMenu","directory_endpoint":"${DIRECTORY_ENDPOINT}"`);
    if (out === src) { res.writeHead(500); return res.end('runtime injection anchor missing'); }
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); return res.end(out);
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ── Chrome + a minimal CDP client ──
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-sbs-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
let port = null; for (let i = 0; i < 100 && !port; i++) { await new Promise((r) => setTimeout(r, 100)); try { port = fs.readFileSync(path.join(udd, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (_) {} }
if (!port) throw new Error('Chrome did not start');
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pend = new Map(), handlers = new Set();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.j(new Error(`${p.m}: ${d.error.message}`)) : p.r(d.result); } else for (const h of handlers) h(d); };
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const id = ++seq; pend.set(id, { r, j, m: method }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unmapped = [];
async function openPage({ width, height, dark }) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });   // the pinned NOW (fixtures.mjs) — before any page script
  await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  const onPaused = async (d) => {
    if (d.sessionId !== sessionId || d.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = d.params;
    try {
      // S2 method (A), advisor 11-09: a scene's runtime injection (mode 'native') is applied HERE, per page, to the served capp-runtime.js
      if (page.rtPatch && request.url.startsWith(ORIGIN) && new URL(request.url).pathname === '/capp-runtime.js') {
        const src = await (await fetch(request.url)).text(), out = page.rtPatch(src);
        if (out === src) throw new Error('S2 runtime injection anchor missing');
        return void await S('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(out).toString('base64') });
      }
      if (request.url.startsWith(ORIGIN) || request.url.startsWith('data:') || request.url.startsWith('blob:')) return void await S('Fetch.continueRequest', { requestId });
      let hit = null;
      try { hit = page.route ? await page.route(request) : null; }   // a route may be async (the real-composed quoteOrder)
      catch (e) { hit = null; request.__routeError = String(e && e.message || e).slice(0, 120); }   // a throwing route is UNMAPPED, never a hung request (Codex r1 P2-5)
      page.trace.push(`${hit ? hit.status || 200 : 'UNMAPPED'} ${request.method} ${request.url.replace(/^https?:\/\//, '').slice(0, 110)}`);
      if (!hit) { unmapped.push(`${page.scene}: ${request.method} ${request.url.slice(0, 160)}${request.__routeError ? ` (route threw: ${request.__routeError})` : ''}`); return void await S('Fetch.fulfillRequest', { requestId, responseCode: 599, body: '' }); }
      const body = Buffer.isBuffer(hit.body) || typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body ?? null);   // a Buffer = a committed image file
      if (hit.delay) await sleep(hit.delay);   // a slow read (memberExtra's receiptDelay: the cold-miss CLS scene)
      await S('Fetch.fulfillRequest', { requestId, responseCode: hit.status || 200, responseHeaders: [{ name: 'Content-Type', value: hit.type || 'application/json' }, { name: 'Access-Control-Allow-Origin', value: ORIGIN }, ...(hit.headers || [])], body: Buffer.from(body).toString('base64') });
    } catch (_) {}
  };
  handlers.add(onPaused);
  const page = { S, sessionId, browserContextId, scene: '', route: null, rtPatch: null, trace: [],
    async eval(expr) { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`); return r.result.value; },
    async until(expr, ms = 15000) { const t0 = Date.now(); for (;;) { if (await page.eval(`!!(${expr})`).catch(() => false)) return; if (Date.now() - t0 > ms) throw new Error(`until timed out: ${expr}`); await sleep(100); } },
    async shot(clip) { const r = await S('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: !!clip }); return Buffer.from(r.data, 'base64'); },
    async close() { handlers.delete(onPaused); await send('Target.closeTarget', { targetId }); await send('Target.disposeBrowserContext', { browserContextId }); } };
  return page;
}

// ── in-browser measurements ──
const DIFF = (a, b) => `(async () => {
  const load = (s) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = s; });
  const [A, B] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
  const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
  const c = (img) => { const k = document.createElement('canvas'); k.width = w; k.height = h; const x = k.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h); };
  const da = c(A), db = c(B), o = document.createElement('canvas'); o.width = w; o.height = h; const ox = o.getContext('2d'), od = ox.createImageData(w, h);
  let n = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2]);
    if (d > 48) { n++; od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 170; od.data[i + 3] = 255; }
    else { const g = 255 - (255 - (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3) * 0.25; od.data[i] = od.data[i + 1] = od.data[i + 2] = g; od.data[i + 3] = 255; }
  }
  ox.putImageData(od, 0, 0);
  return { pct: +(100 * n / (w * h)).toFixed(2), size: [A.width, A.height, B.width, B.height], png: o.toDataURL('image/png').split(',')[1] };
})()`;
// WCAG contrast of every VISIBLE text node against its effective background (opacity composited; a background image ⇒ «unknown»)
const CONTRAST = `(() => {
  const parse = (c) => { const m = c && c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  function bgOf(el) { const stack = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let b = { r: 255, g: 255, b: 255, a: 1 }; for (let i = stack.length - 1; i >= 0; i--) b = over(stack[i], b); return b; }
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true') return false; }
    const e = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2))); return !!e && (e === el || el.contains(e) || e.contains(el)); };
  const out = { checked: 0, unknown: 0, fails: [] }, seen = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    const el = t.parentElement; if (!el || seen.has(el) || !t.nodeValue.trim() || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue; seen.add(el);
    if (!visible(el)) continue;
    const cs = getComputedStyle(el); let fg = parse(cs.color); const bg = bgOf(el); if (!fg || !bg) { out.unknown++; continue; }
    let op = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= +getComputedStyle(n).opacity; fg = over({ ...fg, a: fg.a * op }, bg);
    const l1 = L(fg), l2 = L(bg), ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700); out.checked++;
    if (ratio < (large ? 3 : 4.5)) out.fails.push({ text: t.nodeValue.trim().slice(0, 40), ratio: +ratio.toFixed(2), need: large ? 3 : 4.5, sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') });
  }
  return out;
})()`;

// the LAYOUT mask: text transparent, images / SVG hidden, backgrounds kept ⇒ a structure-only comparison beside the raw one
const MASK = `(() => { const s = document.createElement('style'); s.id = '__mask'; s.textContent = '*{color:transparent!important;text-shadow:none!important;caret-color:transparent!important;-webkit-text-fill-color:transparent!important} img,svg,video,canvas,picture{opacity:0!important}'; document.head.appendChild(s); })()`;
const UNMASK = `(() => { const s = document.getElementById('__mask'); if (s) s.remove(); })()`;
async function diffPair(id, a, b, tag) {
  const d = await openPage({ width: 400, height: 300, dark: false }); d.scene = `${id}-${tag}`; d.route = () => null;
  await d.S('Page.navigate', { url: `${ORIGIN}/__mock/` }); await sleep(200);
  const r = await d.eval(DIFF(`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`)); await d.close();
  return r;
}
// ── the run ──
const results = [];
const SET = arg('--set', 'main');
if (!['main', 's2', 'tip'].includes(SET)) throw new Error(`--set ${SET}: main | s2 | tip`);
const want = (SET === 's2' ? S2_SCENES : SET === 'tip' ? TIP_SCENES : SCENES).filter((s) => !ONLY.length || ONLY.includes(s.name));
const write = (f, buf) => fs.writeFileSync(path.join(OUT, 'img', f), buf);
for (const sc of want) {
  for (const theme of sc.themes || ['light']) {
    const id = `${sc.name}-${theme}`, row = { scene: sc.name, theme, width: sc.width, height: sc.height, note: sc.note || '', ...(sc.injections ? { injections: sc.injections } : {}) }; let p = null;
    try {
      // the REAL scene, from the packaged entry
      p = await openPage({ width: sc.width, height: sc.height, dark: theme === 'dark' }); p.scene = id; p.route = router(sc.fixtures || {});
      // S2 method (A): the scene's stated injections — runtime mode 'native' (the bundle must already carry the sdkPay flag), the stand-in
      // pay binding (standin-paysdk.mjs, before any page script), a device position (the checkout's delivery pin)
      if (sc.native) p.rtPatch = (src) => (src.includes('"sdkPay":true') ? src.replace('"mode":"web"', '"mode":"native"') : src);
      if (sc.preboot) await p.S('Page.addScriptToEvaluateOnNewDocument', { source: typeof sc.preboot === 'function' ? sc.preboot(theme) : sc.preboot });
      if (sc.geo) { await send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['geolocation'], browserContextId: p.browserContextId }); await p.S('Emulation.setGeolocationOverride', { ...sc.geo, accuracy: 10 }); }
      if (sc.seed) { await p.S('Page.navigate', { url: `${ORIGIN}/__mock/` }); await sleep(300); await p.eval(sc.seed); }   // same-origin storage BEFORE the app boots
      if (sc.cls) await p.S('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });' });
      await p.S('Page.navigate', { url: `${ORIGIN}${sc.path || '/'}` });
      for (const step of sc.steps || []) { if (step.until) await p.until(step.until, step.ms); if (step.run) await p.eval(step.run); if (step.wait) await sleep(step.wait); }
      await sleep(sc.settle || 600);
      if (sc.cls) { await p.eval('window.__cls = 0'); for (const step of sc.cls) { if (step.until) await p.until(step.until, step.ms); if (step.run) await p.eval(step.run); if (step.wait) await sleep(step.wait); } await sleep(800); row.cls = +(await p.eval('window.__cls')).toFixed(4); }
      row.contrast = await p.eval(CONTRAST);
      const real = await p.shot(); write(`${id}-real.png`, real);
      const mk = typeof sc.mock === 'function' ? sc.mock(theme) : sc.mock;   // a mockup scene of THIS theme, else none (contrast only)
      let realL = null; if (mk) { await p.eval(MASK); await sleep(150); realL = await p.shot(); await p.eval(UNMASK); }
      await p.close(); p = null;
      // its MOCKUP scene (when it has one): the same CSS size, DPR 2
      if (mk) {
        const m = await openPage({ width: mk.vw || sc.mockWidth || 1600, height: mk.vh || sc.mockHeight || 1200, dark: theme === 'dark' }); m.scene = `${id}-mock`; m.route = () => ({ status: 404, body: '' });
        await m.S('Page.navigate', { url: `${ORIGIN}/__mock/${mk.file}` }); await m.until('document.readyState === "complete"');
        if (mk.run) await m.eval(mk.run); await sleep(500);
        await m.eval(`document.querySelectorAll('.vp .mk, .phin .mk').forEach((e) => e.remove())`);   // the mockup's numbered annotation markers
        const box = await m.eval(mk.clip);   // → { x, y, width, height } of the isolated scene, in CSS px
        const mock = await m.shot(box); write(`${id}-mock.png`, mock);
        await m.eval(MASK); await sleep(150); const mockL = await m.shot(box); await m.close();
        const r = await diffPair(id, real, mock, 'diff'); write(`${id}-diff.png`, Buffer.from(r.png, 'base64')); row.diffPct = r.pct; row.sizes = r.size;
        const l = await diffPair(id, realL, mockL, 'ldiff'); write(`${id}-ldiff.png`, Buffer.from(l.png, 'base64')); row.layoutPct = l.pct;
        row.mock = mk.label || mk.file;
      }
    } catch (e) {
      row.error = String(e.message || e).slice(0, 300);
      // the failing page's own state, for the operator (the page is still open when a step times out)
      try { if (p) { row.errorText = String(await p.eval('document.body ? document.body.innerText.slice(0, 500) : ""')); row.trace = p.trace.slice(-40); write(`${id}-error.png`, await p.shot()); await p.close(); } } catch (_) {}
    }
    results.push(row); process.stdout.write(`${id}: ${row.error ? 'ERROR ' + row.error : `diff ${row.diffPct ?? '—'}% layout ${row.layoutPct ?? '—'}%  contrast fails ${row.contrast ? row.contrast.fails.length : '—'}${row.cls !== undefined ? '  CLS ' + row.cls : ''}`}\n`);
  }
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ origin: 'package-capp bundle at the tip', unmapped, results }, null, 1));
// ── the ONE review page ──
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rows = results.map((r) => { const id = `${r.scene}-${r.theme}`; return `<section><h2>${esc(r.scene)} · ${r.theme} · ${r.width}×${r.height}</h2><p class="n">${r.error ? `<b class="bad">ERROR</b> ${esc(r.error)}` : `pixels <b>${r.diffPct ?? '—'}%</b> · layout (text + images masked) <b>${r.layoutPct ?? '—'}%</b>${r.mock ? ` vs ${esc(r.mock)}` : ' (no mockup of this theme: contrast only)'} · contrast fails <b>${r.contrast.fails.length}</b> of ${r.contrast.checked} (${r.contrast.unknown} on images)${r.cls !== undefined ? ` · CLS <b>${r.cls}</b>` : ''}`}${r.note ? ` · ${esc(r.note)}` : ''} · <i>runtime + directory_endpoint (injected)${r.injections ? ' + ' + esc(r.injections) : ''}</i></p>
  <div class="row"><figure><img src="img/${id}-real.png" loading="lazy"><figcaption>real (packaged)</figcaption></figure>${fs.existsSync(path.join(OUT, 'img', `${id}-mock.png`)) ? `<figure><img src="img/${id}-mock.png" loading="lazy"><figcaption>mockup</figcaption></figure><figure><img src="img/${id}-diff.png" loading="lazy"><figcaption>pixel diff (magenta = differs)</figcaption></figure><figure><img src="img/${id}-ldiff.png" loading="lazy"><figcaption>layout diff (text + images masked)</figcaption></figure>` : ''}</div>
  ${r.contrast && r.contrast.fails.length ? `<details><summary>contrast failures</summary><ul>${r.contrast.fails.map((f) => `<li>«${esc(f.text)}» ${f.ratio}:1 (needs ${f.need}) <code>${esc(f.sel)}</code></li>`).join('')}</ul></details>` : ''}</section>`; }).join('\n');
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capp side-by-sides</title>
<style>:root{--bg:#fff;--ink:#16202c;--mute:#5d6b7a;--line:#e3e8ee}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d1420;--ink:#e8edf3;--mute:#9aa7b6;--line:#243142}}:root[data-theme="dark"]{--bg:#0d1420;--ink:#e8edf3;--mute:#9aa7b6;--line:#243142}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}section{border-top:1px solid var(--line);padding:14px 0}h2{font-size:16px;margin:0 0 4px}.n{color:var(--mute);margin:0 0 8px}.bad{color:#c0392b}
.row{display:flex;gap:12px;overflow-x:auto}figure{margin:0;flex:none}figure img{display:block;max-width:min(520px,80vw);height:auto;border:1px solid var(--line)}figcaption{font-size:12px;color:var(--mute)}</style>
<h1>Customer app · side-by-sides</h1><p class="n">The PACKAGED bundle (package-capp at the tip) + ONE injected runtime field, <code>directory_endpoint</code> (production has no directory endpoint yet — a launch gap; ruling (A)), every outside request served from fixtures${unmapped.length ? ` — <b class="bad">${unmapped.length} unmapped request(s)</b>` : ' (0 unmapped)'}. Diff = % of pixels whose RGB distance exceeds 48.</p>${rows}`);
console.log(`\n${results.length} renders · ${unmapped.length} unmapped request(s) · ${path.join(OUT, 'index.html')}`);
ws.close(); chrome.kill('SIGTERM'); server.close(); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {}
// Codex r1 P2: a scene error (a step timeout, a failed in-page check such as S2ck-1's bar height) FAILS the run like an unmapped request
const errored = results.filter((r) => r.error);
if (errored.length) console.error(`SCENE ERRORS (the run FAILS):\n  ` + errored.map((r) => `${r.scene}-${r.theme}: ${r.error}`).join('\n  '));
if (unmapped.length) console.error('UNMAPPED (the run FAILS):\n  ' + unmapped.join('\n  '));
if (errored.length || unmapped.length) process.exit(1);
