// NEVER-SHIP (browser half): proves — as a REAL computed style, not a source scan — that the WINNING --accent and
// every .slide-confirm track/fill/thumb background resolve to the Cuadra azul-acero, never an orange, in all four
// DOM contexts a live slide appears in (bare / #screen-onshift / .action-zone / .incoming-banner). This is what makes
// the finding robust against specificity (:root:not(.x)), @media ordering, rgb()/hsl() forms, and later <style>
// overrides that a static last-hex scan cannot see.
//
// Drives chrome-headless-shell over a harness page that embeds BOTH real <style> blocks verbatim + synthetic slides.
// Resolve the binary via $CHROME_HEADLESS_SHELL / $CHROME, else the puppeteer cache. REQUIRES a headless Chrome — it
// throws (never silently skips) if none is found, so the scheduled slot runs it where Chrome exists.
// Run: `node fa4400-render.browser.test.js`  (CHROME_HEADLESS_SHELL=/path/to/chrome-headless-shell to override).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';
import { offerScreenHtml, incomingBannerHtml } from './stacked-view.js';
import { singleOrderCardHtml } from './single-order-view.js';

const __dir = dirname(fileURLToPath(import.meta.url));

function resolveChrome() {
  for (const e of [process.env.CHROME_HEADLESS_SHELL, process.env.CHROME]) if (e && existsSync(e)) return e;
  const root = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (existsSync(root)) {
    for (const ver of readdirSync(root)) {
      for (const sub of (existsSync(join(root, ver)) ? readdirSync(join(root, ver)) : [])) {
        const bin = join(root, ver, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  throw new Error('chrome-headless-shell not found — set CHROME_HEADLESS_SHELL=/path/to/chrome-headless-shell (browser test REQUIRES a headless Chrome).');
}

// orange = hue 10–45°, saturation ≥ .45, lightness .2–.7 → covers #FA4400 and every derived slide orange; excludes
// steel rgb(47,95,184) (hue ~220) and the translucent whites.
function rgbIsOrange(r, g, b) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h >= 10 && h <= 45 && s >= 0.45 && l >= 0.2 && l <= 0.7;
}
// scan EVERY rgb/rgba token in a computed value — a solid colour OR every stop of a computed gradient string
// (getComputedStyle normalises linear-gradient(...) colour stops to rgb()/rgba()).
function isOrange(css) {
  if (!css) return false;
  const re = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/gi;
  let m;
  while ((m = re.exec(css))) if (rgbIsOrange(+m[1], +m[2], +m[3])) return true;
  return false;
}

const STYLE = [...readFileSync(join(__dir, 'index.html'), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  .map((m) => m[1]).join('\n');

const STATES = ['accept', 'pickup', 'delivered'];
const slide = (id, st) => `<div class="slide-confirm ${st}" id="${id}"><div class="slide-fill"></div><div class="slide-text">X</div><div class="slide-thumb">t</div></div>`;
const ctx = {
  bare: (st) => slide(`bare-${st}`, st),
  onshift: (st) => `<div id="screen-onshift">${slide(`onshift-${st}`, st)}</div>`,
  zone: (st) => `<div id="screen-onshift"><div class="action-zone">${slide(`zone-${st}`, st)}</div></div>`,
  banner: (st) => `<div class="incoming-banner">${slide(`banner-${st}`, st)}</div>`,
};
const CONTEXTS = Object.keys(ctx);

const body = CONTEXTS.map((c) => STATES.map((st) => ctx[c](st)).join('')).join('');
// resolve --accent through a probe's computed background (custom props return their raw token, not resolved rgb)
const html = `<!doctype html><html><head><meta charset="utf8"><style>${STYLE}</style></head><body>${body}
<div id="accent-probe" style="background:var(--accent)"></div>
<script>
  // sample BOTH the solid background colour and the background-image (gradient) — a slide element can carry an
  // orange gradient while its backgroundColor is translucent white.
  const samp=(s)=>{const e=document.querySelector(s);if(!e)return 'MISSING';const c=getComputedStyle(e);return c.backgroundColor+' || '+c.backgroundImage;};
  const bg=(s)=>{const e=document.querySelector(s);return e?getComputedStyle(e).backgroundColor:'MISSING';};
  const out={ accent:bg('#accent-probe') };
  for (const c of ${JSON.stringify(CONTEXTS)}) for (const st of ${JSON.stringify(STATES)}) {
    out[c+'/'+st+'/track']=samp('#'+c+'-'+st);
    out[c+'/'+st+'/fill']=samp('#'+c+'-'+st+' .slide-fill');
    out[c+'/'+st+'/thumb']=samp('#'+c+'-'+st+' .slide-thumb');
    out[c+'/'+st+'/track-bgc']=bg('#'+c+'-'+st);
  }
  document.title='PROBE'+JSON.stringify(out);
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'fa4400-render-'));
const page = join(dir, 'probe.html');
writeFileSync(page, html);
let out;
try {
  const CHS = resolveChrome();
  const dom = execFileSync(CHS, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=2500', '--dump-dom', `file://${page}`], { encoding: 'utf8', maxBuffer: 1e8 });
  out = JSON.parse(dom.match(/PROBE(\{[\s\S]*?\})<\/title>/)[1]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

t('the WINNING computed --accent is azul-acero, never an orange', () => {
  assert.ok(!isOrange(out.accent), `computed --accent is orange: ${out.accent}`);
  // steel is rgb(47, 95, 184); normalise spacing before comparing
  assert.equal(out.accent.replace(/\s+/g, ''), 'rgb(47,95,184)', `computed --accent = ${out.accent}, expected steel rgb(47, 95, 184)`);
});

t('no .slide-confirm track / fill / thumb computes to orange (solid OR gradient) in any of the 4 contexts × 3 states', () => {
  const bad = [];
  for (const [k, v] of Object.entries(out)) {
    if (k === 'accent' || k.endsWith('/track-bgc')) continue;   // samp keys carry colour || background-image
    assert.notEqual(v, 'MISSING', `probe element missing for ${k}`);
    if (isOrange(v)) bad.push(`${k} = ${v}`);
  }
  assert.deepEqual(bad, [], `slide element(s) render orange:\n  ${bad.join('\n  ')}`);
});

t('every slide-confirm track computes to the steel track colour (the prototype .slide background)', () => {
  const bad = [];
  for (const [k, v] of Object.entries(out)) {
    if (!k.endsWith('/track-bgc')) continue;
    if (v.replace(/\s+/g, '') !== 'rgb(47,95,184)') bad.push(`${k} = ${v}`);
  }
  assert.deepEqual(bad, [], `slide track(s) not steel rgb(47, 95, 184):\n  ${bad.join('\n  ')}`);
});

// ---------- 2e F-1: the REAL shared attachSlideConfirm gate, driven END TO END in real Chrome ----------
// The cells above prove COLOUR only. These lift the real SLICE3 shared single-fire gate (attachSlideConfirm) from
// index.html and drive a real pointer DRAG, a TAP, and keyboard Enter/Space against real accept/start/end-shift/
// cuadre slides in real Chrome — coverage jsdom node tests cannot give (no real pointer/focus/keyboard + layout).
const INDEX_SRC = readFileSync(join(__dir, 'index.html'), 'utf8');
function extractBalanced(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('extractBalanced: not found: ' + sig);
  let depth = 0, open = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; open = true; }
    else if (src[j] === '}') { depth--; if (open && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('extractBalanced: unbalanced');
}
const ATTACH_SRC = extractBalanced(INDEX_SRC, 'function attachSlideConfirm(elementId, onConfirm) {');

// ====== Codex #306: the 5 REAL slides are produced by EXECUTING their real writers (no scraped fragments), then
// driven with REAL Chrome input over CDP (Input.dispatchMouseEvent / dispatchKeyEvent) through the lifted shared
// attachSlideConfirm gate, with hit-test + focus preconditions asserted. ======
const nodeReq = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = nodeReq('jsdom');
const esc0 = (s) => String(s == null ? '' : s);
function liftConstLine(name) {
  const m = INDEX_SRC.match(new RegExp('const ' + name + " = '[^']*';"));
  if (!m) throw new Error('liftConstLine: not found ' + name);
  return m[0];
}
// Pull one element (by id) out of a writer's EMITTED html string — using jsdom, not a source scan.
function sliceEl(html, id) {
  const el = new JSDOM('<!doctype html><body>' + html + '</body>').window.document.getElementById(id);
  if (!el) throw new Error('sliceEl: writer output has no #' + id);
  return el.outerHTML;
}
// EXECUTE cuadreConfirmFootHtml (string writer; one dep).
function emitCuadre() {
  const body = liftConstLine('CUADRE_ARROW_SVG') + '\n' + extractBalanced(INDEX_SRC, 'function cuadreConfirmFootHtml() {') + '\nreturn cuadreConfirmFootHtml();';
  return sliceEl((new Function(body))(), 'cuadre-confirm');  // eslint-disable-line no-new-func
}
// RUN a real DOM-mutating renderer in jsdom and read the slide element it emits.
function runRenderer(fnName, hostHtml, slideId, stubs) {
  const dom = new JSDOM('<!doctype html><html><body>' + hostHtml + '</body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const names = ['document', '$', 'escapeHtml', 'window', ...Object.keys(stubs)];
  const vals = [document, $, esc0, window, ...Object.keys(stubs).map((k) => stubs[k])];
  const body = extractBalanced(INDEX_SRC, 'function ' + fnName + '() {') + '\n' + fnName + '(); return (document.getElementById("' + slideId + '") || {}).outerHTML || "";';
  const out = (new Function(...names, body))(...vals);  // eslint-disable-line no-new-func
  if (!out) throw new Error(fnName + ' emitted no #' + slideId);
  return out;
}
function emitStart() {
  return runRenderer('renderOffshift', '<div id="screen-offshift"></div>', 'btn-start-shift', {
    companionSuspended: false, driverState: { active: false, status: 'off_shift' }, currentUser: { uid: 'u' },
    computeShiftCash: () => ({ cashOwed: 350 }), allOrders: {}, PAGOS_LIVE: false, drv2DayEarned: () => ({ cents: null }),
    driverIdentityCutoverMs: 0, first: 'Driver', drv2ClearReturnTarget: () => {}, todayMidnightMs: () => 0,
    openCuenta: () => {}, attachSlideConfirm: () => {}, companionSyncSuspendedNotice: () => {}, updateNotifBanners: () => {},
  });
}
function emitEndshift() {
  return runRenderer('renderDisponible',
    '<div id="idle-state"><div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg"></div><div class="idle-sub" id="idle-sub"></div><button id="idle-help-link"></button><button id="arrive-btn"></button></div>',
    'btn-end-shift-slide', {
      DRV2_ENDSHIFT_SLIDE: true, DRV2_PAUSE_ENABLED: false, DRV2_SLIDE_ARROW: '<svg></svg>',
      drv2SoloCancel: null, optimisticShift: null, shiftBusy: false, authGen: 1,
      renderPausa: () => {}, renderSoloCancel: () => {}, drv2GetReturnTarget: () => null, drv2ClearReturnTarget: () => {},
      attachSlideConfirm: () => {}, handleEndShift: () => {}, NAVP_ICONS: {}, navBtnHtml: () => '', drv2ReadNavPref: () => 'Waze',
      ICONS: new Proxy({}, { get: () => '<svg></svg>' }), driverState: { status: 'available', active: true, last_ping: Date.now() },
      currentUser: { uid: 'u' }, XPD: { isStalePing: () => false, RESTAURANT: {} },
    });
}

// The 5 live slides: { key -> { id, html } } where html is the REAL emitted slide outerHTML.
const LIVE = {
  acceptCard: { id: 'btn-accept', html: sliceEl(singleOrderCardHtml({ order: { total: 350, customer_name: 'x', items_text: 'y' }, phase: 'awaiting_acceptance', pickupTask: { destination_lat: 15.5, destination_lng: -88, assignment_deadline: Date.now() + 36000 }, deliveryTask: { destination_lat: 15.5, destination_lng: -88 } }, { esc: String }), 'btn-accept') },   // the MOST-seen single-order accept card (singleOrderCardHtml, index.html import)
  acceptMain: { id: 'btn-accept', html: sliceEl(offerScreenHtml([{ orderId: 'o1', order: { total: 350 }, pickupTask: {} }, { orderId: 'o2', order: { total: 250 }, pickupTask: {} }], { esc: String }, {}), 'btn-accept') },
  acceptInc:  { id: 'btn-accept-inc-o1', html: sliceEl(incomingBannerHtml([{ orderId: 'o1', order: { total: 350 }, pickupTask: { assignment_deadline: Date.now() + 36000 } }], { esc: String }), 'btn-accept-inc-o1') },
  cuadre:     { id: 'cuadre-confirm', html: emitCuadre() },
  start:      { id: 'btn-start-shift', html: emitStart() },
  endshift:   { id: 'btn-end-shift-slide', html: emitEndshift() },
};
for (const [k, s] of Object.entries(LIVE)) {
  assert.ok(/class="[^"]*slide/.test(s.html) && /slide-fill/.test(s.html) && /slide-thumb/.test(s.html),
    `LIVE slide ${k} from its real writer is malformed (writer structure changed?): ${s.html.slice(0, 120)}`);
}
const KEYS = Object.keys(LIVE);

// ---------- CDP harness: real Chrome input against the real emitted slides ----------
function cdpConnect() {
  const port = 9300 + Math.floor(Math.random() * 400);
  const proc = spawn(resolveChrome(),
    ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { proc, port };
}
async function wsFor(port) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('CDP: no ws endpoint on ' + port);
}
// Build the harness page: real styles + each slide instance (emitted html, id rewritten unique) + the lifted gate.
function harnessHtml(attachSrc, slides, thumbMutantKey) {
  let body = '';
  for (const k of KEYS) {
    for (const meth of ['drag', 'tap', 'enter', 'space', 'mix']) {
      const uid = k + '__' + meth;
      let h = slides[k].html.replace(/id="[^"]*"/, 'id="' + uid + '"');
      if (thumbMutantKey === k) h = h.replace('class="slide-thumb"', 'class="slide-thumb-BROKEN"');
      body += '<div style="width:358px;margin:10px;position:relative">' + h + '</div>';
    }
  }
  const script = [
    'window.__fired = {};',
    'const $=(id)=>document.getElementById(id);',
    'let slidingEl=null,renderPending=false;',
    'function renderActiveAndQueue(){} function toast(){}',
    attachSrc,
    'window.__attach=(uid)=>{ window.__fired[uid]=0; attachSlideConfirm(uid, async()=>{ window.__fired[uid]++; }); };',
    'window.__rect=(uid)=>{ const el=$(uid); if(!el) return null; el.scrollIntoView({block:"center"}); const t=el.querySelector(".slide-thumb"); const r=el.getBoundingClientRect(); const tr=t?t.getBoundingClientRect():null; return { el:r, thumb:tr }; };',
    'window.__hit=(uid,x,y)=>{ const el=$(uid); if(!el) return false; const t=el.querySelector(".slide-thumb"); const e=document.elementFromPoint(x,y); return !!(t && e && t.contains(e)); };',   // STRICT: (x,y) must resolve to THIS slide’s OWN .slide-thumb (or its child), not any .slide-thumb
    'window.__focus=(uid)=>{ const el=$(uid); el.focus(); return document.activeElement===el; };',
  ].join('\n');
  return '<!doctype html><html><head><meta charset="utf8"><style>' + STYLE + '</style><style>html,body{margin:0}</style></head><body><div id="wrap">' + body + '</div><script>' + script + '</script></body></html>';
}
async function driveGate(attachSrc, opts = {}) {
  const { thumbMutantKey = null } = opts;
  const { proc, port } = cdpConnect();
  let ws;
  try {
    const wsUrl = await wsFor(port);
    ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const t0 = await rpc('Target.createTarget', { url: 'about:blank' });
    const sid = (await rpc('Target.attachToTarget', { targetId: t0.result.targetId, flatten: true })).result.sessionId;
    function rpc(method, params) { return new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); }
    function rpcS(method, params) { return new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, sessionId: sid, method, params })); }); }
    async function evalJs(expr) { const r = await rpcS('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) throw new Error('evalJs: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200)); return r.result.result.value; }
    await rpcS('Page.enable', {});
    const html = harnessHtml(attachSrc, LIVE, thumbMutantKey);
    const d = mkdtempSync(join(tmpdir(), 'fa4400-gate-')); const p = join(d, 'g.html'); writeFileSync(p, html);
    await rpcS('Page.navigate', { url: 'file://' + p });
    await new Promise((r) => setTimeout(r, 400));
    async function mouse(type, x, y) { await rpcS('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }); }
    async function key(code, vk, keyName) { await rpcS('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, code, key: keyName }); await rpcS('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key: keyName }); }
    async function doDrag(uid) {
      const r = await evalJs('JSON.stringify(window.__rect("' + uid + '"))'); const rect = JSON.parse(r); if (!rect || !rect.thumb) return { noThumb: true };
      const sx = rect.thumb.x + rect.thumb.width / 2, sy = rect.thumb.y + rect.thumb.height / 2;
      const hit = await evalJs('window.__hit("' + uid + '",' + sx + ',' + sy + ')');
      if (hit !== true) return { hit };   // strict precondition: skip the mouse input unless (sx,sy) is THIS slide's own thumb
      await mouse('mousePressed', sx, sy); await mouse('mouseMoved', rect.el.x + rect.el.width - 4, sy); await mouse('mouseReleased', rect.el.x + rect.el.width - 4, sy);
      return { hit };
    }
    async function doTap(uid) { const r = JSON.parse(await evalJs('JSON.stringify(window.__rect("' + uid + '"))')); if (!r || !r.thumb) return; const sx = r.thumb.x + r.thumb.width / 2, sy = r.thumb.y + r.thumb.height / 2; await mouse('mousePressed', sx, sy); await mouse('mouseReleased', sx, sy); }
    async function doKey(uid, which) { const ok = await evalJs('window.__focus("' + uid + '")'); if (which === 'enter') await key('Enter', 13, 'Enter'); else await key('Space', 32, ' '); return { focused: ok }; }
    const hits = {}; const focus = {};
    for (const k of KEYS) {
      await evalJs('["drag","tap","enter","space","mix"].forEach(m=>window.__attach("' + k + '__"+m))');
      hits[k] = (await doDrag(k + '__drag')).hit;
      await doTap(k + '__tap');
      focus[k + '-enter'] = (await doKey(k + '__enter', 'enter')).focused;
      focus[k + '-space'] = (await doKey(k + '__space', 'space')).focused;
      // single-fire MIX on one element: drag + Enter + Space, count must stay 1
      await doDrag(k + '__mix'); await doKey(k + '__mix', 'enter'); await doKey(k + '__mix', 'space');
    }
    await new Promise((r) => setTimeout(r, 300));
    const fired = JSON.parse(await evalJs('JSON.stringify(window.__fired)'));
    rmSync(d, { recursive: true, force: true });
    return { fired, hits, focus };
  } finally { try { ws && ws.close(); } catch (_) {} proc.kill(); }
}

// Strip the shared keydown (a11y) / the confirmed guard from the lifted gate for the mutants.
const NO_KEYDOWN = ATTACH_SRC.replace(/el\.addEventListener\('keydown',[\s\S]*?\}\);/, '/* keydown removed */');
assert.notEqual(NO_KEYDOWN, ATTACH_SRC, 'mutant setup: shared keydown not found');
const NO_CONFIRMED = ATTACH_SRC.replace(/if \(confirmed\) return;\s*\n\s*confirmed = true;/, '/* confirmed guard removed */');
assert.notEqual(NO_CONFIRMED, ATTACH_SRC, 'mutant setup: confirmed guard not found');

const base = await driveGate(ATTACH_SRC);
const planted = await driveGate(NO_KEYDOWN);
const noGuard = await driveGate(NO_CONFIRMED);
const thumbMut = await driveGate(ATTACH_SRC, { thumbMutantKey: 'acceptMain' });
const thumbMutCard = await driveGate(ATTACH_SRC, { thumbMutantKey: 'acceptCard' });

t('Codex306: the real writers executed — every live slide emitted real markup, thumb hit-testable, el focusable', () => {
  for (const k of KEYS) {
    assert.strictEqual(base.hits[k], true, `${k}: drag start point is NOT this slide's own .slide-thumb (strict hit-test === that slide's thumb; got ${base.hits[k]})`);
    assert.equal(base.focus[k + '-enter'], true, `${k}: el not focusable before Enter`);
    assert.equal(base.focus[k + '-space'], true, `${k}: el not focusable before Space`);
  }
});
t('Codex306: real CDP DRAG fires onConfirm exactly once — single-order card, accept-main, accept-incoming, start, end-shift, cuadre', () => {
  const bad = KEYS.filter((k) => base.fired[k + '__drag'] !== 1).map((k) => `${k}=${base.fired[k + '__drag']}`);
  assert.deepEqual(bad, [], `drag not single-fire: ${bad.join(', ')}`);
});
t('Codex306: real CDP TAP never fires (tap-nudge only) — all 6 slides', () => {
  const bad = KEYS.filter((k) => base.fired[k + '__tap'] !== 0).map((k) => `${k}=${base.fired[k + '__tap']}`);
  assert.deepEqual(bad, [], `tap fired: ${bad.join(', ')}`);
});
t('Codex306: real CDP keyboard Enter AND Space each fire once (Codex #278 a11y) — all 6 slides', () => {
  const bad = [];
  for (const k of KEYS) { if (base.fired[k + '__enter'] !== 1) bad.push(`${k}-enter=${base.fired[k + '__enter']}`); if (base.fired[k + '__space'] !== 1) bad.push(`${k}-space=${base.fired[k + '__space']}`); }
  assert.deepEqual(bad, [], `Enter/Space not single-fire: ${bad.join(', ')}`);
});
t('Codex306: SINGLE-FIRE — drag + Enter + Space mixed on the SAME element stays 1 — all 6 slides', () => {
  const bad = KEYS.filter((k) => base.fired[k + '__mix'] !== 1).map((k) => `${k}=${base.fired[k + '__mix']}`);
  assert.deepEqual(bad, [], `mixed inputs double-fired: ${bad.join(', ')}`);
});
t('Codex306 MUTANT A: stripping the shared keydown kills every keyboard confirm (Enter/Space→0); drag still 1', () => {
  const live = [];
  for (const k of KEYS) { if (planted.fired[k + '__enter'] !== 0) live.push(`${k}-enter=${planted.fired[k + '__enter']}`); if (planted.fired[k + '__space'] !== 0) live.push(`${k}-space=${planted.fired[k + '__space']}`); }
  assert.deepEqual(live, [], `keyboard still fired: ${live.join(', ')}`);
  assert.deepEqual(KEYS.filter((k) => planted.fired[k + '__drag'] !== 1), [], 'drag broke in the keydown-stripped variant');
});
t('Codex306 MUTANT B: removing the shared `confirmed` guard makes the mixed single-fire count EXCEED 1', () => {
  const stillOne = KEYS.filter((k) => noGuard.fired[k + '__mix'] <= 1);
  assert.deepEqual(stillOne, [], `the single-fire cell would MISS a confirmed-guard regression (mix still ≤1 for: ${stillOne.join(', ')})`);
});
t('Codex306 MUTANT C: a RENDERER markup change (drop .slide-thumb) makes that slide’s gate cells fail; others unaffected', () => {
  // acceptMain (offerScreenHtml) mutant
  assert.equal(thumbMut.fired['acceptMain__drag'], 0, `acceptMain drag still fired after breaking .slide-thumb (${thumbMut.fired['acceptMain__drag']})`);
  assert.equal(thumbMut.fired['acceptMain__enter'], 0, 'acceptMain Enter still fired after breaking .slide-thumb');
  for (const k of KEYS.filter((x) => x !== 'acceptMain')) assert.equal(thumbMut.fired[k + '__drag'], 1, `${k} drag should be unaffected by the acceptMain mutant`);
  // acceptCard (singleOrderCardHtml) mutant — the most-seen single-order accept card
  assert.equal(thumbMutCard.fired['acceptCard__drag'], 0, `acceptCard drag still fired after breaking .slide-thumb (${thumbMutCard.fired['acceptCard__drag']})`);
  assert.equal(thumbMutCard.fired['acceptCard__enter'], 0, 'acceptCard Enter still fired after breaking .slide-thumb');
  for (const k of KEYS.filter((x) => x !== 'acceptCard')) assert.equal(thumbMutCard.fired[k + '__drag'], 1, `${k} drag should be unaffected by the acceptCard mutant`);
});

console.log(`✓ fa4400-render (browser): ${passed} checks passed`);
