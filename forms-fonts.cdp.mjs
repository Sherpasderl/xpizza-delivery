// PLAN-forms-fonts-preconnect r6.1 §4.2 — the order forms' font proofs in a REAL browser (headless Chrome over CDP), both forms.
// Run at hand-back (not in the npm chain):  node forms-fonts.cdp.mjs [--cells=fast,slow,failed,ctrl,same] [--sites=xpizza-orders,…]
//   CHROME_BIN overrides the browser; FONTS_REPEATS (default 3). ONE Chrome at a time, only while the 1-min load is < 30
//   (cdp-fonts.mjs waitForLoad). Nothing leaves the machine: pages are served from loopback; every external https request is
//   fulfilled from a fixture, failed, or held. Production is never touched.
// Cells (each site; FONTS_REPEATS repeats; every repeat must pass):
//   FF-fast   fonts at once                          ⇒ the hosted faces paint (census); 0 boxes move after settle; CLS 0
//   FF-slow   Slow 4G + 4× CPU, fonts HELD 6000 ms   ⇒ premise: the fallback is painted (and booted) before release; after the held
//                                                       responses COMPLETE + settle the fallback is KEPT and 0 boxes move; CLS 0
//   FF-failed font requests FAIL                     ⇒ fallback kept; 0 boxes move; usable (add to cart → #s2 visible, non-empty)
//   FF-ctrl   NEGATIVE CONTROL: the held load with the OLD policy (swap, no fallback faces) ⇒ fallback→brand transition AND boxes
//             move (> 0) — else the zeros above are void
//   FF-same   every fixture STATE, baseline (today's page at the Plan 4 tip, its Google css replaced by the COMMITTED baseline css,
//             gstatic served from the PINNED bytes) vs candidate (this tree), fonts fast, deterministic ⇒ gates (a)–(d) + FB-ctrl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, serveDir, router, census, attribute, runsOf, GEO, OBSERVER, sleep } from './platform/perf/cdp-fonts.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_REV = process.env.FONTS_BASELINE_REV || '743277de';   // the Plan 4 tip: today's page, before any font change
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/fonts/baseline/orders-form.pin.json'), 'utf8'));
const BASELINE_CSS = fs.readFileSync(path.join(ROOT, 'platform/fonts/baseline/orders-form.google.css'));
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).split(',') : d; };
const CELLS = arg('cells', ['fast', 'slow', 'failed', 'ctrl', 'same']);
const SITES = arg('sites', ['xpizza-orders', 'la-musa-orders']);
const REPEATS = Number(process.env.FONTS_REPEATS || 3);
const OUT = path.join(os.tmpdir(), `forms-fonts-cdp-${process.pid}`); fs.mkdirSync(OUT, { recursive: true });
const BRAND = { 'xpizza-orders': { rid: 'x_pizza', marker: 'xpizza_acct' }, 'la-musa-orders': { rid: 'la_musa', marker: 'lamusa_acct' } };
const HOSTED = { 'DM Sans': [300, 400, 500, 600, 700, 800], 'Playfair Display': [600, 700, 900] };   // the pinned baseline's discrete descriptors
const hostedOf = (platformName) => Object.keys(HOSTED).find((f) => platformName === f || platformName.startsWith(`${f} `)) || null;   // "DM Sans 9pt" → DM Sans
const firstFamily = (stack) => (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isFontUrl = (u) => /fonts\.gstatic\.com\/s\/|\.woff2(\?|$)/.test(u);

// CSS Fonts 4 §5.2 weight matching against a discrete descriptor set (Codex r1's table: DM Sans 450→500 … 750→800; Playfair 750→900)
export function matchWeight(w, avail) {
  const a = [...avail].sort((x, y) => x - y); if (a.includes(w)) return w;
  const below = a.filter((x) => x < w).reverse(), above = a.filter((x) => x > w);
  if (w >= 400 && w <= 500) { const up = above.filter((x) => x <= 500); return up[0] ?? below[0] ?? above.find((x) => x > 500); }
  return w < 400 ? (below[0] ?? above[0]) : (above[0] ?? below[0]);
}

// ── fixtures (external https) ──
function decideFor(state) {
  return (url, req) => {
    if (/getPublicMenu/.test(url)) return 'hold';                                   // no live apply repaints during the window (Plan 4's slice)
    if (/firebaseio\.com/.test(url)) return { body: '{}' };                          // availability: none ⇒ everything available
    if (/createOrder/.test(url)) { let id = 'ORD-1'; try { id = JSON.parse(req.postData || '{}').order_id || id; } catch (_) {} return { body: JSON.stringify({ ok: true, order_id: id }) }; }
    if (/quoteRedemption/.test(url)) return { body: JSON.stringify({ ok: true, total_cents: 34000, net_total_cents: 34000, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 }) };
    if (/quoteOrder/.test(url)) return { body: JSON.stringify({ ok: true, total_cents: state.totalCents || 34000, net_total_cents: state.totalCents || 34000 }) };
    if (/fonts\.googleapis\.com\/css2/.test(url)) return state.baseline ? { body: BASELINE_CSS, headers: { 'content-type': 'text/css' } } : 'fail';
    if (/fonts\.gstatic\.com\/s\//.test(url)) {
      const f = state.baseline && PIN.files.find((x) => x.url === url.split('?')[0]);
      if (!f || state.fontGate === 'fail') return 'fail';
      if (state.fontGate === 'hold') return 'hold';
      return { body: pinnedBytes(f), headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' } };
    }
    return 'fail';                                                                     // Maps, the Firebase SDK, the heartbeat, anything else
  };
}
// the baseline's font bytes: the PINNED files, found by full sha256 + length among the committed copies (never via the candidate manifest)
const PINNED = new Map();
function pinnedBytes(f) {
  if (PINNED.has(f.url)) return PINNED.get(f.url);
  const dir = path.join(ROOT, 'xpizza-orders/fonts');
  for (const n of fs.readdirSync(dir)) { const b = fs.readFileSync(path.join(dir, n)); if (sha(b) === f.sha256 && b.length === f.bytes) { PINNED.set(f.url, b); return b; } }
  throw new Error(`no committed bytes match the pin for ${f.url}`);
}

// ── the baseline root: today's two forms, exported from the Plan 4 tip (independent of the candidate tree) ──
let BASELINE_ROOT = null;
function baselineRoot() {
  if (BASELINE_ROOT) return BASELINE_ROOT;
  BASELINE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fonts-baseline-'));
  execFileSync('tar', ['-x', '-C', BASELINE_ROOT], { input: execFileSync('git', ['archive', BASELINE_REV, ...SITES], { cwd: ROOT, maxBuffer: 1 << 28 }) });
  process.once('exit', () => fs.rmSync(BASELINE_ROOT, { recursive: true, force: true }));
  return BASELINE_ROOT;
}

// ── the account seam (Codex r2 P2): the signup suite's — one in-flight insert after `async function ensureFirebase() {` + a fake
//    auth / RTDB installed before any script; byte-identical on baseline and candidate ──
const SEAM = 'async function ensureFirebase() {';
const seamed = (buf) => { const s = String(buf); if (s.split(SEAM).length !== 2) throw new Error('premise: exactly one ensureFirebase'); return s.replace(SEAM, `${SEAM} if (window.__FB_FAKE) return window.__FB_FAKE;`); };
const UID = 'u_' + 'a'.repeat(24);
function fakeInit(site, rewards) {
  const tree = { user_profiles: { [UID]: { name: 'Ana Prueba', phone: '50499990000', phone_hash: 'ph', created_at: 1, last_login: 1 } },
    user_private: { [UID]: { consent: { [BRAND[site].rid]: { terms: { version: 't', privacy_version: 'p', at: 1 }, promos: { value: false, copy_version: 'c', at: 1 } } } } },
    user_rewards: { [UID]: { [BRAND[site].rid]: rewards } } };
  return `(() => {
    try { localStorage.setItem(${JSON.stringify(BRAND[site].marker)}, ${JSON.stringify(JSON.stringify({ uid: UID, name: 'Ana Prueba', phone: '+50499990000' }))}); } catch (_) {}
    const tree = ${JSON.stringify(tree)}; const get = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), tree);
    const snap = (v) => ({ exists: () => v != null, val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))) });
    const user = { uid: ${JSON.stringify(UID)}, getIdToken: async () => 'idt' };
    window.__FB_FAKE = { app: {}, db: {}, auth: { currentUser: user, authStateReady: async () => {} },
      authMod: { onAuthStateChanged: (a, cb) => { cb(user); return () => {}; }, signOut: async () => {}, setPersistence: async () => {}, browserLocalPersistence: {} },
      dbMod: { ref: (db, p) => ({ path: p || '' }), get: async (r) => snap(get(r.path)), update: async () => {}, set: async () => {}, remove: async () => {},
        onValue: (r, cb) => { cb(snap(get(r.path))); return () => {}; }, off: () => {} } };
  })();`;
}

// ── page boot + the fixture STATES (the coverage set; Codex r4 ruling: pane-level premises only) ──
const FREEZE = `(() => { const T = Date.UTC(2026, 9, 27, 18, 30); const D = Date; class FD extends D { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } } window.Date = FD; })();`;
const QUIET = `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); });`;
const settle = async (cdp) => { await cdp.ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
const addOne = `(() => { const d = MENU.find((x) => x.price > 0 && !x.variantOf && !(window.itemIsLauncher && itemIsLauncher(x))); chg(d.id, 1);
  while (calcTotal() < MIN_ORDER) chg(d.id, 1);                                   // the real minimum-order rule (goToLocation refuses below it)
  document.getElementById('cname').value = 'Ana Prueba';                         // the customer's own Paso 1 fields, as typed
  document.getElementById('cphone').value = '9'.repeat(phoneCountry().len);
  return d.id; })()`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); return true; })()`;
const order = async (cdp) => { await cdp.ev(addOne); await cdp.ev('requestServerQuote(true), true'); await sleep(300); await cdp.ev(`selectPay('cash'); if (!buildOrder()) throw new Error('premise: buildOrder refused'); submitOrder('confirmed'); true`);
  for (let i = 0; ; i++) {   // the REAL flow: createOrder (fixture) → showSuccess → #s5; wait for it, never a fixed sleep
    const st = await cdp.ev(`(document.querySelector('.stage.active') || {}).id || ''`);
    if (st === 's5') break;
    if (i > 600) throw new Error(`premise: the order never reached the success stage (still on ${st})`);
    await sleep(25);
  }
  await sleep(300); };
const typePhone = `(() => { const i = document.querySelector('#acct-pane-phone input'); if (!i) throw new Error('no phone input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '9999 0000'); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return true; })()`;

const STATES = {
  'S1':            { container: '#s1', drive: async () => {} },
  'S2':            { container: '#s2', drive: async (c) => { await c.ev(addOne); await c.ev('goToLocation(), true'); await sleep(400); } },
  'L-empty':       { container: '#acct-pane-phone', drive: async (c) => { await c.ev(click('#acct-chip button')); await sleep(400); } },
  'L-filled':      { container: '#acct-pane-phone', drive: async (c) => { await c.ev(click('#acct-chip button')); await sleep(400); await c.ev(typePhone); await sleep(150); } },
  'A-account':     { container: '#acct-pane-account', rewards: { balance: 5, reserved: 0 }, drive: async (c) => { await sleep(300); await c.ev(click('#acct-chip button')); await sleep(500); } },
  'A-rewards':     { container: '#acct-pane-rewards', rewards: { balance: 5, reserved: 0 }, drive: async (c) => { await sleep(300); await c.ev(click('#acct-chip button')); await sleep(500); await c.ev(click('#acct-row-rewards')); await sleep(500); } },
  'OK-guest':      { container: '#acct-success-rewards', drive: async (c) => { await order(c); } },
  'OK-logged':     { container: '#acct-success-rewards', rewards: { balance: 5, reserved: 0 }, drive: async (c) => { await sleep(300); await order(c); } },
  'G-musa-below':  { only: 'la-musa-orders', container: '#acct-success-rewards', totalCents: 24900, drive: async (c) => { await order(c); } },
  'R-picker':      { container: '#rk-sheet-root .rk-sheet', rewards: (site) => (BRAND[site].rid === 'la_musa' ? { balance: 100000, reserved: 0, canary: true } : { balance: 8, reserved: 0, canary: true }), drive: async (c) => { await openPicker(c); } },
  'R-picker-sel':  { only: 'la-musa-orders', container: '#rk-sheet-root .rk-sheet', rewards: () => ({ balance: 100000, reserved: 0, canary: true }), drive: async (c) => { await openPicker(c); await c.ev(click('#rk-sheet-root .rk-row:not(.rk-off)')); await sleep(300); } },
};
async function openPicker(c) {
  await sleep(300); await c.ev(addOne); await c.ev('goToLocation(), true'); await sleep(300);
  await c.ev(`(() => { if (typeof goToPayment === 'function') goToPayment(); if (typeof renderRedeemUI === 'function') renderRedeemUI(); return true; })()`); await sleep(800);
  const n = await c.ev(`(window.__ACCOUNT && __ACCOUNT.rkCatLength) ? __ACCOUNT.rkCatLength() : document.querySelectorAll('#acct-redeem .rk-tk[data-rk-open]').length`);
  if (!n) throw new Error('premise: the redemption ticket is not offered (eligible fixture not reached)');
  await c.ev(click('#acct-redeem .rk-tk[data-rk-open]')); await sleep(500);
}

async function premisePane(cdp, sel) {
  const ok = await cdp.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing';
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) return 'hidden';
    return (e.innerText || '').trim() ? 'ok' : 'empty'; })()`);
  if (ok !== 'ok') throw new Error(`premise: ${sel} is ${ok}`);
}

// ── one run: boot a site in a state under a font policy; returns everything the cells judge ──
async function run(site, { side = 'candidate', fontGate, throttle = false, oldPolicy = false, stateName = 'S1', deterministic = false, holdMs = 6000, faceChange = false }) {
  const def = STATES[stateName];
  const state = { ...def, baseline: side === 'baseline' || process.env.FONTS_HEAD === 'google', fontGate };
  const root = side === 'baseline' ? baselineRoot() : ROOT;
  const srv = await serveDir(root, {
    gate: (rel) => (/\/fonts\/.*\.woff2$/.test(rel) ? fontGate : undefined),
    rewrite: (rel, buf) => {
      let out;
      if (def.rewards && /account\.js$/.test(rel)) out = seamed(out ?? buf);
      if (process.env.FONTS_STRIP_NAMES && side === 'candidate' && /(index\.html|account\.js)$/.test(rel)) out = String(out ?? buf).replace(/,\s*'(DM Sans|Playfair Display) Fallback( Roboto| Noto)?'/g, '');   // diagnostic only
      if (process.env.FONTS_SWAP_ONLY && side === 'candidate' && /orders-fonts\.css$/.test(rel)) out = String(out ?? buf).replace(/font-display:optional/g, 'font-display:swap');   // diagnostic only
      if (process.env.FONTS_NO_PF_PRELOAD && side === 'candidate' && /index\.html$/.test(rel)) out = String(out ?? buf).replace(/<link rel="preload" href="fonts\/playfair-display-latin\.[^"]+"[^>]*>/, '');   // diagnostic only
      if (process.env.FONTS_INJECT_ERR && side === 'candidate' && /index\.html$/.test(rel))   // control: a page error must be caught by FF-failed
        out = String(out ?? buf).replace('</head>', '<script>console.error("injected control error")</script></head>');
      if (faceChange && side === 'candidate' && /index\.html$/.test(rel))   // FC-ctrl: a deliberate face change (.acct-nm 650→700 face becomes the 600 face)
        out = String(out ?? buf).replace('</head>', '<style>.acct-nm{font-weight:600!important}</style></head>');
      if (process.env.FONTS_SYNTH_NONE && side === 'candidate' && /index\.html$/.test(rel))   // diagnostic: Codex step 1 — scoped synthesis suppression, before first use
        out = String(out ?? buf).replace('</head>', '<style>.acct-nm{font-synthesis:none!important}</style></head>');
      if (process.env.FONTS_HEAD && side === 'candidate' && /index\.html$/.test(rel)) {   // diagnostic only: swap head line 25/26 variants
        const L = String(out ?? buf).split('\n');
        if (process.env.FONTS_HEAD === 'google') { L[24] = '<link rel="preconnect" href="https://fonts.googleapis.com"/>'; L[25] = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Playfair+Display:wght@600;700;900&family=DM+Sans:wght@300;400;500;600;700;800&display=swap"/>'; }
        if (process.env.FONTS_HEAD === 'nopreload') L[24] = L[24].replace(/<link rel="preload"[^>]*>/g, '');
        if (process.env.FONTS_HEAD === 'nopreconnect') L[25] = '';
        if (process.env.FONTS_HEAD === 'dmonly') L[24] = L[24].replace(/<link rel="preload" href="fonts\/playfair-display-[^"]+"[^>]*>/, '');
        if (process.env.FONTS_HEAD === 'pfonly') L[24] = L[24].replace(/<link rel="preload" href="fonts\/dm-sans-[^"]+"[^>]*>/, '');
        out = L.join('\n');
      }
      if (oldPolicy) {   // the OLD policy, rewritten in flight: font-display:swap and no fallback faces / stack names
        if (/orders-fonts\.css$/.test(rel)) out = String(out ?? buf).replace(/font-display:optional/g, 'font-display:swap').replace(/@font-face\{font-family:'[^']+ Fallback[^']*';[^}]*\}/g, '');
        if (/(index\.html|account\.js)$/.test(rel)) out = String(out ?? buf).replace(/,\s*'(DM Sans|Playfair Display) Fallback( Roboto| Noto)?'/g, '');
      }
      return out;
    },
  });
  const cdp = await launch({ throttle });
  let rtRef = null;
  try {
    // Codex r1 #3: page exceptions and console / log errors, recorded for every run (FF-failed asserts them)
    const errs = [];
    const rt = await router(cdp, decideFor(state)); rtRef = rt;
    // a hold may only ever be a font or the live-menu fetch (which is failed at teardown, never continued)
    cdp.on('Fetch.requestPaused', (p) => { const u = p.request.url; if (decideFor(state)(u, p.request) === 'hold' && !isFontUrl(u) && !/getPublicMenu/.test(u)) errs.push(`unexpected hold: ${u}`); });
    await cdp.s('Log.enable');
    cdp.on('Runtime.exceptionThrown', (p) => errs.push(`exception: ${(p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text}`.slice(0, 200)));
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errs.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 200)); });
    cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errs.push({ log: p.entry.text.slice(0, 200), url: p.entry.url || '' }); });
    await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
    if (deterministic) for (const src of [FREEZE, QUIET]) await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: src });
    if (def.rewards) await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: fakeInit(site, typeof def.rewards === 'function' ? def.rewards(site) : def.rewards) });
    const t0 = Date.now();
    await cdp.s('Page.navigate', { url: `${srv.base}/${site}/index.html` });
    // painted = the DOM parsed and #s1 present, then two frames. NOT readyState 'complete': the load event also waits for HELD fonts.
    for (let i = 0; i < 2400; i++) { if (await cdp.ev(`document.readyState !== 'loading' && !!document.getElementById('s1')`).catch(() => false)) break; await sleep(25); }
    await settle(cdp);
    const bootMs = Date.now() - t0;
    const paintGeo = await cdp.ev(GEO);   // Codex r1 #2: the geometry AT FIRST PAINT, before the drive and before any font completes
    await def.drive(cdp);
    await settle(cdp);
    if (process.env.FONTS_DEBUG_STAGE) console.log(`  [stage ${side} ${stateName}]`, JSON.stringify(await cdp.ev(`({ active: (document.querySelector('.stage.active') || {}).id, err1: (document.getElementById('err1') || {}).textContent, err3: (document.getElementById('err3') || {}).textContent, sx: (document.getElementById('acct-success-rewards') || {}).innerHTML?.length })`)), 'createOrder seen:', [...rt.seen].some((u) => /createOrder/.test(u)));
    const fontUrlsSeen = () => [...rt.seen].some((u) => /\.woff2(\?|$)/.test(u));
    const before = { nodes: await census(cdp), geo: await cdp.ev(GEO), bootMs, cls: await cdp.ev('window.__cls') };
    let heldMs = 0;
    if (fontGate === 'hold') {
      // EVENT-driven hold: the fonts stay held until the page has painted AND the before-capture (census + GEO) is done — and at
      // least holdMs from navigation — then they are released. The premise that matters (text painted BEFORE the font exists) is
      // asserted on the before-capture by the cell. A fixed timer from navigation cannot guarantee it on a page this size under
      // Slow 4G + 4× CPU (calibrated: paint + capture took ~25 s).
      if (srv.heldCount() + rt.holds.size === 0 && !fontUrlsSeen()) throw new Error('premise: no font request was held — the cell would prove nothing');
      await sleep(Math.max(0, holdMs - (Date.now() - t0)));
      heldMs = Date.now() - t0;
      srv.release(); await rt.release(isFontUrl);   // ONLY font requests (Codex r1 #1) — a held getPublicMenu is never continued toward production
    }
    // completion: every font request finished or failed; then fonts.ready, then frames until GEO stops changing
    const fontUrls = () => [...rt.seen].filter((u) => /\.woff2(\?|$)/.test(u));
    for (let i = 0; ; i++) { const open = fontUrls().filter((u) => !rt.finished.has(u)); if (!open.length) break; if (i > 1200) throw new Error(`font requests never completed: ${open.join(', ')}`); await sleep(25); }
    await cdp.ev('document.fonts.ready.then(() => true)'); await sleep(250);
    let geo = await cdp.ev(GEO); for (let i = 0; i < 20; i++) { await settle(cdp); const g = await cdp.ev(GEO); if (JSON.stringify(g) === JSON.stringify(geo)) break; geo = g; }
    await premisePane(cdp, def.container);
    const after = { heldMs, bootMs, paintGeo, errs, refused: [...rt.refused], nodes: await census(cdp), geo, cls: await cdp.ev('window.__cls'), fontsFailed: fontUrls().filter((u) => rt.finished.get(u) === 'failed').length };
    if (process.env.FONTS_INSPECT) console.log(`  [inspect ${side} ${stateName}]`, JSON.stringify(await cdp.ev(`[...document.querySelectorAll(${JSON.stringify(process.env.FONTS_INSPECT)})].map((e) => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return { text: e.textContent.slice(0, 20), ff: cs.fontFamily, fw: cs.fontWeight, fs: cs.fontSize, ls: cs.letterSpacing, x: r.x, y: r.y, w: r.width, h: r.height, op: cs.opacity, filter: cs.filter }; })`)));
    if (process.env.FONTS_INSPECT) { const { root } = await cdp.s('DOM.getDocument', { depth: -1, pierce: true }); const { nodeId } = await cdp.s('DOM.querySelector', { nodeId: root.nodeId, selector: process.env.FONTS_INSPECT });
      const d = await cdp.s('DOM.describeNode', { nodeId, depth: 1 }); const t = (d.node.children || []).find((c) => c.nodeType === 3);
      const { node: tn } = t ? await cdp.s('DOM.describeNode', { backendNodeId: t.backendNodeId }) : { node: null };
      const pushed = t ? (await cdp.s('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [t.backendNodeId] })).nodeIds[0] : nodeId;
      console.log(`  [inspect-font ${side}]`, JSON.stringify((await cdp.s('CSS.getPlatformFontsForNode', { nodeId: pushed })).fonts)); }
    if (deterministic && process.env.FONTS_RERASTER) {   // diagnostic: force EVERY layer to re-rasterize on BOTH sides (no font changes)
      await cdp.ev(`document.documentElement.style.filter = 'opacity(0.999)', true`); await settle(cdp); await sleep(150);
      await cdp.ev(`document.documentElement.style.filter = '', true`); await settle(cdp); await sleep(250);
    }
    if (deterministic && process.env.FONTS_REPAINT) {   // diagnostic: normalize raster history on BOTH sides (no font changes)
      await cdp.s('Emulation.setDeviceMetricsOverride', { width: 391, height: 844, deviceScaleFactor: 2, mobile: true }); await settle(cdp);
      await cdp.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await settle(cdp); await sleep(200);
    }
    if (process.env.FONTS_DEBUG_PATH) for (const n of after.nodes) if (n.path.includes(process.env.FONTS_DEBUG_PATH)) {
      const pr = await attribute(cdp, [n]);
      console.log(`  [debug ${side}]`, JSON.stringify({ path: n.path.slice(-60), family: n.family, weight: n.weight, style: n.style, spaces: n.spaces, text: String.fromCodePoint(...n.codepoints), fonts: n.fonts,
        probe: [...new Set(n.codepoints)].map((cp) => `${String.fromCodePoint(cp)}=${pr.get(`${n.family}|${n.weight}|${n.style}|${cp}`)}`).join(' ') }));
    }
    if (deterministic && process.env.FONTS_STEP2 === 'probe') {   // Codex step 2: a FRESH «Ana», same typography, opaque surface, same fractional coords
      await cdp.ev(`(() => { const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:250px;top:14px;width:80px;height:40px;background:#fff;z-index:2147483646';
        const t = document.createElement('span'); const cs = getComputedStyle(document.querySelector('.acct-nm'));
        t.style.cssText = 'position:fixed;left:274.359375px;top:26.5px;z-index:2147483647;white-space:pre;line-height:normal';
        t.style.fontFamily = cs.fontFamily; t.style.fontWeight = cs.fontWeight; t.style.fontSize = cs.fontSize; t.style.letterSpacing = cs.letterSpacing; t.style.color = '#17130F';
        t.textContent = 'Ana'; document.documentElement.append(box, t); return true; })()`); await settle(cdp); await sleep(200);
    }
    if (deterministic && process.env.FONTS_STEP2 === 'nooverlay') {   // Codex step 2: the dim overlay removed on BOTH sides (the sheet stays)
      await cdp.ev(`(() => { for (const o of document.querySelectorAll('.acct-overlay')) { o.style.background = 'transparent'; o.style.backdropFilter = 'none'; } return true; })()`); await settle(cdp); await sleep(200);
    }
    const shot = async () => Buffer.from((await cdp.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
    // r6.2 (advisor ruling, Option A): gate (c) compares EQUALIZED state history. The RAW capture is kept as an informational record;
    // then the SAME font-cache invalidation (a throwaway local() FontFace, which bumps the font-selector version so every existing
    // text run is re-shaped with all hosted faces available) is applied on BOTH sides, and the NORMALIZED capture is the gated one.
    // Evidence (x_pizza A-rewards «Ana»): raw 323 px from load order (a LATE Playfair load re-shapes existing text on the baseline);
    // a fresh probe of the same text = 0; the overlay is ruled out (344 without it); equal invalidation on both sides = 0.
    const raw = deterministic ? await shot() : null;
    if (deterministic) { await cdp.ev(`(async () => { const ff = new FontFace('__Invalidate', "local('Arial')"); document.fonts.add(ff); await ff.load(); return true; })()`); await settle(cdp); await sleep(300); }
    const png = deterministic ? await shot() : null;
    const probe = await attribute(cdp, after.nodes);
    // Codex r1 #1 guard: the live-menu fetch is HELD then FAILED at teardown — it must never have completed (that could only be prod)
    const menuDone = [...rt.finished].filter(([u, st]) => /getPublicMenu/.test(u) && st === 'ok').map(([u]) => u);
    if (menuDone.length) throw new Error(`🔴 a getPublicMenu request completed — it must never be continued toward production: ${menuDone.join(', ')}`);
    return { before, after, probe, png, raw };
  } finally {
    // nothing held is ever continued at teardown: every remaining hold (getPublicMenu, any font) is FAILED, then the browser closes
    try { if (rtRef) await rtRef.failHeld(() => true); } catch (_) {}
    cdp.close(); srv.close();
  }
}

// ── PNG → RGBA (8-bit, non-interlaced, color type 2 or 6 — what Chrome writes), for the pixel-exact gate ──
function decodePng(buf) {
  let p = 8, w, h, ct, idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[12] !== 0) throw new Error('png: unsupported depth/interlace'); ct = data[9]; }
    if (type === 'IDAT') idat.push(data); if (type === 'IEND') break; p += 12 + len; }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`png: color type ${ct}`); })();
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      out[y * stride + x] = (src[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255; } }
  return { w, h, bpp, px: out };
}
const pixelDiff = (a, b) => { const A = decodePng(a), B = decodePng(b); if (A.w !== B.w || A.h !== B.h) return Infinity; let d = 0;
  for (let i = 0; i < A.w * A.h; i++) for (let k = 0; k < 3; k++) if (A.px[i * A.bpp + k] !== B.px[i * B.bpp + k]) { d++; break; } return d; };

// ── census → faces / declarations ──
const nodeWeight = (n) => Number(n.weight) || 400;
function faceSet(r) {   // (a): the set of (rendered family, matched face) with glyphs > 0
  const set = new Set();
  for (const n of r.after.nodes) for (const f of n.fonts) if (f.glyphCount > 0) {
    const fam = hostedOf(f.familyName);
    set.add(fam ? `${fam}|${matchWeight(nodeWeight(n), HOSTED[fam])}` : `${f.familyName}|system`);
  }
  return set;
}
function primaryDecls() {   // (b): every PRIMARY @font-face the candidate ships
  const css = fs.readFileSync(path.join(ROOT, 'xpizza-orders/orders-fonts.css'), 'utf8');
  return [...css.matchAll(/@font-face\{font-family:'(DM Sans|Playfair Display)';font-style:(\w+);font-weight:(\d+);[^}]*unicode-range:([^}]+)\}/g)]
    .map((m) => ({ family: m[1], style: m[2], weight: Number(m[3]), range: m[4].split(',').map((r) => r.trim().replace(/^U\+/, '').split('-').map((h) => parseInt(h, 16))).map(([lo, hi]) => [lo, hi ?? lo]), raw: m[4] }));
}
const inRange = (cp, range) => range.some(([lo, hi]) => cp >= lo && cp <= hi);
// r2's static scan: every weight any live selector can request (numeric font-weight / font shorthand; bolder / <b> / <strong> ⇒ 700 and 900)
function requestedWeights() {
  const w = new Set();
  for (const site of SITES) for (const f of ['index.html', 'account.js']) {
    const src = fs.readFileSync(path.join(ROOT, site, f), 'utf8');
    for (const m of src.matchAll(/font-weight:\s*(\d{3})/g)) w.add(Number(m[1]));
    for (const m of src.matchAll(/font:\s*(\d{3})\s/g)) w.add(Number(m[1]));
    if (/bolder|<b[ >]|<strong[ >]/.test(src)) { w.add(700); w.add(900); }
  }
  w.add(400);   // the default
  return w;
}
function gateB(byState, decls, reqW, without = new Set()) {
  const painted = new Set(), covered = new Set(), cps = new Map();
  for (const [st, r] of Object.entries(byState)) {
    if (without.has(st)) continue;
    for (const n of r.after.nodes) {
      const mw = (fam) => matchWeight(nodeWeight(n), HOSTED[fam]);
      for (const run of runsOf(n, r.probe).runs) {
        const fam = hostedOf(run.familyName); if (!fam) continue;
        const key = `${fam}|${mw(fam)}|${n.style}`; painted.add(key);
        if (!cps.has(key)) cps.set(key, new Set()); for (const cp of run.codepoints) cps.get(key).add(cp);
      }
    }
  }
  const out = [];
  for (const d of decls) {
    const key = `${d.family}|${d.weight}|${d.style}`;
    const hit = [...(cps.get(key) || [])].some((cp) => inRange(cp, d.range));
    if (hit) { out.push({ ...d, verdict: 'covered' }); continue; }
    if (painted.has(key)) { out.push({ ...d, verdict: 'r1 subset-only' }); continue; }                // guarded: the face IS painted, just no codepoint in this range
    const unrequested = ![...reqW].some((w) => matchWeight(w, HOSTED[d.family]) === d.weight);
    out.push({ ...d, verdict: unrequested ? 'r2 weight-unrequested' : 'FAIL (painted nowhere, yet requested — a missing state)' });
  }
  return out;
}
function gateD(r) {   // per glyph run: a non-hosted run under a hosted-first stack must lie WHOLLY outside that family's declared ranges
  const decls = primaryDecls(); const bad = [];
  for (const n of r.after.nodes) {
    const fam = hostedOf(firstFamily(n.family)); if (!fam) continue;
    const ranges = decls.filter((d) => d.family === fam).flatMap((d) => d.range);
    for (const run of runsOf(n, r.probe).runs) if (!hostedOf(run.familyName) && run.codepoints.some((cp) => inRange(cp, ranges)))
      bad.push(`${n.path.slice(-50)}: ${run.familyName} draws ${JSON.stringify(String.fromCodePoint(...run.codepoints.filter((cp) => inRange(cp, ranges))))} inside ${fam}'s ranges`);
  }
  return bad;
}

const hostedPainted = (nodes) => nodes.some((n) => n.fonts.some((f) => hostedOf(f.familyName) && f.glyphCount > 0));
const moved = (a, b) => (a.length === b.length ? a.filter((g, i) => g !== b[i]).length : -1);
const fails = []; const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };
const fidelity = (r, label) => { const bad = r.after.nodes.flatMap((n) => runsOf(n, r.probe).fidelity.map((f) => `${n.path.slice(-40)} ${f}`)); check(!bad.length, `${label}: probe fidelity (${bad.length ? bad.slice(0, 3).join('; ') : 'every node'})`); };

for (const site of SITES) {
  console.log(`\n== ${site}`);
  for (let rep = 1; rep <= REPEATS; rep++) {
    if (CELLS.includes('fast')) {
      const r = await run(site, {});
      check(hostedPainted(r.after.nodes), `[${rep}] FF-fast: hosted faces paint (census)`);
      // Codex r1 #2: observed from FIRST PAINT (geometry snapshot at paint, before any font completes) through font completion,
      // and the layout-shift total over the WHOLE window from navigation start (buffered observer) must be 0
      const m = moved(r.after.paintGeo, r.after.geo);
      check(r.after.geo.length > 50 && m === 0, `[${rep}] FF-fast: 0 of ${r.after.geo.length} boxes moved from FIRST PAINT to settled (${m})`);
      check(r.after.cls === 0, `[${rep}] FF-fast: CLS 0 over the whole window from navigation start (${r.after.cls})`);
    }
    if (CELLS.includes('slow')) {
      const r = await run(site, { fontGate: 'hold', throttle: true });
      check(!hostedPainted(r.before.nodes), `[${rep}] FF-slow premise: the fallback is painted before release (painted at ${r.after.bootMs} ms, fonts released at ${r.after.heldMs} ms)`);
      check(!hostedPainted(r.after.nodes), `[${rep}] FF-slow: the fallback is KEPT after the held fonts complete`);
      const m = moved(r.before.geo, r.after.geo);
      check(r.after.geo.length > 50 && m === 0, `[${rep}] FF-slow: 0 of ${r.after.geo.length} boxes moved (${m})`);
      check(r.after.cls - r.before.cls === 0, `[${rep}] FF-slow: CLS across the font window 0 (${r.after.cls - r.before.cls}; page-load CLS before it ${r.before.cls}, recorded only)`);
    }
    if (CELLS.includes('failed')) {
      const r = await run(site, { fontGate: 'fail', stateName: 'S2' });
      check(r.after.fontsFailed > 0, `[${rep}] FF-failed premise: the font requests really failed (${r.after.fontsFailed})`);
      check(!hostedPainted(r.after.nodes), `[${rep}] FF-failed: the fallback paints and is kept`);
      check(moved(r.before.geo, r.after.geo) === 0, `[${rep}] FF-failed: 0 boxes move; usable (add → #s2 visible, non-empty)`);
      // Codex r1 #3: no page exception / console error / log error — except the EXPECTED font-network failures
      // exceptions / console.error: NONE allowed. Network-load errors: allowed ONLY for the font URLs (the cell's own failure) and for
      // the URLs the fixture router ITSELF refused (Maps, the Firebase SDK — never allowed to reach production; recorded by the router)
      const unexpected = r.after.errs.filter((e) => !(typeof e === 'object' && /^Failed to load resource/.test(e.log) && (isFontUrl(e.url) || r.after.refused.includes(e.url)))).map((e) => (typeof e === 'object' ? `log: ${e.log} ${e.url}` : e));
      if (process.env.FONTS_SHOW_ERRS) console.log('    errs:', JSON.stringify(r.after.errs));
      check(unexpected.length === 0, `[${rep}] FF-failed: no page exceptions / console errors beyond the expected font failures (${unexpected.length ? unexpected.slice(0, 4).join(' | ') : 'none'})`);
    }
    if (CELLS.includes('ctrl')) {
      const r = await run(site, { fontGate: 'hold', throttle: true, oldPolicy: true });
      check(!hostedPainted(r.before.nodes) && hostedPainted(r.after.nodes), `[${rep}] FF-ctrl: the OLD policy swaps (fallback → brand; fonts released at ${r.after.heldMs} ms)`);
      const m = moved(r.before.geo, r.after.geo);
      check(m > 0, `[${rep}] FF-ctrl: the geometry check SEES it — ${m} of ${r.after.geo.length} boxes moved (CLS ${r.after.cls}, recorded only)`);
    }
    if (CELLS.includes('same')) {
      const states = Object.keys(STATES).filter((st) => (!STATES[st].only || STATES[st].only === site) && (!arg('states') || arg('states').includes(st)));
      const byState = {}; const record = { site, rep, states: {} };
      for (const st of states) {
        const base = await run(site, { side: 'baseline', stateName: st, deterministic: true });
        // FONTS_SELF_CONTROL=1: the determinism control — the 'candidate' slot is ANOTHER baseline run (baseline vs baseline)
        const cand = await run(site, { side: process.env.FONTS_SELF_CONTROL ? 'baseline' : 'candidate', stateName: st, deterministic: true });
        byState[st] = cand;
        fidelity(base, `[${rep}] ${st} baseline`); fidelity(cand, `[${rep}] ${st} candidate`);
        check(hostedPainted(base.after.nodes) && hostedPainted(cand.after.nodes), `[${rep}] ${st}: brand faces paint on BOTH sides`);
        const A = [...faceSet(base)].sort(), B = [...faceSet(cand)].sort();
        check(JSON.stringify(A) === JSON.stringify(B), `[${rep}] ${st} gate (a): face sets identical (${B.length})${JSON.stringify(A) === JSON.stringify(B) ? '' : ` base ${JSON.stringify(A)} cand ${JSON.stringify(B)}`}`);
        const d = pixelDiff(base.png, cand.png), dRaw = pixelDiff(base.raw, cand.raw);
        if (d || dRaw || process.env.FONTS_SAVE) for (const [k, b] of [['base', base.png], ['cand', cand.png], ['base-raw', base.raw], ['cand-raw', cand.raw]]) fs.writeFileSync(path.join(OUT, `${site}-${st}-${k}.png`), b);
        check(d === 0, `[${rep}] ${st} gate (c): pixel-exact, equalized history (${d} differing pixels)`);
        console.log(`    · ${st} raw (un-normalized, informational): ${dRaw} differing pixels${dRaw ? ' — history-dependent; recorded' : ''}`);
        record.raw = { ...(record.raw || {}), [st]: dRaw }; record.normalized = { ...(record.normalized || {}), [st]: d };
        for (const [side, r] of [['baseline', base], ['candidate', cand]]) { const bad = gateD(r); check(!bad.length, `[${rep}] ${st} gate (d) ${side}: no silent fallback${bad.length ? ` — ${bad.slice(0, 3).join('; ')}` : ''}`); }
        record.states[st] = { candidate: cand.after.nodes.map((n) => ({ path: n.path, family: n.family, weight: n.weight, runs: runsOf(n, cand.probe).runs.map((x) => ({ font: x.familyName, cps: x.codepoints.length })) })) };
      }
      // FC-ctrl (r6.2 condition 3): the normalization cannot hide a REAL face change — inject one on the candidate ⇒ the NORMALIZED gate must FAIL
      if (states.includes('A-account')) {
        const b0 = await run(site, { side: 'baseline', stateName: 'A-account', deterministic: true });
        const c0 = await run(site, { side: 'candidate', stateName: 'A-account', deterministic: true, faceChange: true });
        const dc = pixelDiff(b0.png, c0.png);
        check(dc > 0, `[${rep}] FC-ctrl: a deliberate face change (.acct-nm → the 600 face) FAILS the normalized gate (${dc} differing pixels)`);
      }
      const decls = primaryDecls(), reqW = requestedWeights();
      const vb = gateB(byState, decls, reqW);
      for (const v of vb) check(!/^FAIL/.test(v.verdict), `[${rep}] gate (b) ${v.family} ${v.weight} ${v.raw.slice(0, 18)}…: ${v.verdict}`);
      // FB-ctrl (r6.1): the first painted (family, weight, style) in sorted order that r2 does not exempt; remove EVERY state that paints it
      const paintedKeys = [...new Set(vb.filter((v) => v.verdict === 'covered').map((v) => `${v.family}|${v.weight}|${v.style}`))].sort();
      const pick = paintedKeys[0];
      const painters = new Set(Object.entries(byState).filter(([, r]) => r.after.nodes.some((n) => runsOf(n, r.probe).runs.some((x) => hostedOf(x.familyName) && `${hostedOf(x.familyName)}|${matchWeight(nodeWeight(n), HOSTED[hostedOf(x.familyName)])}|${n.style}` === pick))).map(([st]) => st));
      const vctrl = gateB(byState, decls, reqW, painters);
      const named = vctrl.filter((v) => /^FAIL/.test(v.verdict) && `${v.family}|${v.weight}|${v.style}` === pick);
      check(!!pick && named.length > 0, `[${rep}] FB-ctrl: removing ${painters.size} state(s) that paint ${pick} makes gate (b) FAIL, naming it (${named.length} declaration(s))`);
      fs.writeFileSync(path.join(OUT, `census.${BRAND[site].rid}.${rep}.json`), JSON.stringify({ ...record, gateB: vb.map(({ range, ...x }) => x) }, null, 1));
    }
  }
}
console.log(`\nartifacts: ${OUT}`);
console.log(fails.length ? `\nforms-fonts.cdp: ${fails.length} FAILED` : '\nforms-fonts.cdp: OK');
process.exit(fails.length ? 1 : 0);
