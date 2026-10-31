// PLAN-portal-fonts r1.1 §4 — the portal's self-hosted Archivo, proven in a REAL browser (headless Chrome over CDP), both entry pages.
// Run at hand-back (HEAVY, slotted; not in the npm chain):  node portal-fonts.cdp.mjs [--cells=fast,slow,failed,ctrl,typing,same]
//   [--states=P-editor,…] [--views=1280,390] [--themes=light,dark]   CHROME_BIN overrides; FONTS_REPEATS (default 3).
// ONE Chrome at a time, only while the 1-min load is < 30 (platform/perf/cdp-fonts.mjs waitForLoad). Nothing leaves the machine: pages
// are served from loopback; every external https request is fulfilled from a fixture, failed, or held. Production is never touched.
// Reuses the forms harness's patterns (forms-fonts.cdp.mjs): the IN-PAGE paint snapshot at FCP + 1 rAF, the buffered whole-window CLS,
// font-ONLY release (a held non-font request is failed at teardown, never continued), page-error collection, equalized-history pixels.
// Cells (each entry page; FONTS_REPEATS repeats; every repeat must pass):
//   FF-fast    fonts at once                         ⇒ Archivo paints (census); 0 boxes move from FIRST PAINT to settled; CLS 0
//   FF-slow    Slow 4G + 4× CPU, fonts HELD ≥ 6000 ms ⇒ premise: no Archivo loaded at the FCP snapshot, the fallback painted before release;
//                                                     after completion + settle the fallback is KEPT and 0 boxes move; CLS 0
//   FF-failed  font requests FAIL                    ⇒ fallback kept; 0 move; no page errors beyond the expected font failures; usable
//                                                     (index: the editor rows render + a drawer opens and a price types; aceptar: the email
//                                                     step submits)
//   FF-ctrl    NEGATIVE CONTROL: the held load with the OLD policy (swap, no fallback faces / names) ⇒ fallback → Archivo AND boxes move
//   FF-typing  P-editor, FF-slow timing: a LIST-ROW price (render.js priceCell → .price input, Archivo 800, right-aligned), fixture value
//              1280, caret placed INSIDE (between «12» and «80»); the RENDERED caret x (sentinel caret-color, pixel-located) before vs
//              after release + settle ⇒ 0 px, the box unchanged, the value intact; its FF-ctrl twin (same target, same caret) must MOVE
//   FF-same    every §4 STATE, baseline (today's portal at BASELINE_REV with its Google css replaced by the COMMITTED baseline css, gstatic
//              served from the PINNED bytes) vs candidate (this tree), fonts fast, deterministic ⇒ gates (a)–(d) + FB-ctrl + FC-ctrl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, serveDir, router, census, attribute, runsOf, GEO, OBSERVER, sleep } from './platform/perf/cdp-fonts.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'xpizza-portal';
const BASELINE_REV = process.env.FONTS_BASELINE_REV || 'd23bef66';   // the base this slice stacks on: today's portal (Google Archivo)
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/fonts/baseline/portal.pin.json'), 'utf8'));
const BASELINE_CSS = fs.readFileSync(path.join(ROOT, 'platform/fonts/baseline/portal.google.css'));
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).split(',') : d; };
const CELLS = arg('cells', ['fast', 'clsctrl', 'slow', 'failed', 'ctrl', 'typing', 'same']);
const VIEWS = arg('views', ['1280', '390']).map(Number);
const THEMES = arg('themes', ['light', 'dark']);
const REPEATS = Number(process.env.FONTS_REPEATS || 3);
const OUT = path.join(os.tmpdir(), `portal-fonts-cdp-${process.pid}`); fs.mkdirSync(OUT, { recursive: true });
const RANGE = [600, 800];                       // the pinned baseline's ONE range descriptor per subset (no discrete faces)
const HOSTED = ['Archivo'];
const hostedOf = (name) => HOSTED.find((f) => name === f || name.startsWith(`${f} `)) || null;
const firstFamily = (stack) => (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isFontUrl = (u) => /fonts\.gstatic\.com\/s\/|\.woff2(\?|$)/.test(u);
// CSS Fonts 4 against ONE range face: a weight inside the range renders as itself, outside it clamps to the nearer end
export const matchWeight = (w) => Math.min(RANGE[1], Math.max(RANGE[0], w));
const fnOf = (url) => { const m = /cloudfunctions\.net\/([A-Za-z]+)/.exec(url); return m ? m[1] : null; };
const queryOf = (url) => Object.fromEntries(new URL(url).searchParams);

// ── fixtures: the brand the approved mockups draw (Pizzería Del Valle, three branches), as the endpoints answer ──
const OWNER = ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set',
  'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.pause', 'team.invite', 'team.revoke', 'brand.settings'];
const MGR_RO = ['availability.set', 'device.list', 'location.prep', 'location.pause'];
const BR = [['r_norte', 'Bulevar del Norte'], ['r_centro', 'Centro'], ['r_trejo', 'Col. Trejo']];
const T0 = Date.UTC(2026, 9, 27, 18, 30);
const row = ([rid, name], role, caps) => ({ rid, brand_id: 'marca_v', role, state: 'member', caps, name, identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50497128830' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 1, last_order_today: 120 });
const E1 = (role = 'owner', caps = OWNER) => ({ brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches: BR.map((b) => row(b, role, caps)), membership_writes_enabled: role === 'owner' });
const it = (key, cat, price, desc) => ({ key, price, display: { name: key, cat, price, ...(desc ? { desc } : {}) } });
// «Familiar» carries the multi-digit FF-typing price (1280)
const ITEMS = [it('Familiar', 'cl', 1280, 'La de compartir'), it('Margarita', 'cl', 280, 'Tomate, mozzarella fresca y albahaca'), it('Pepperoni', 'cl', 310, 'Pepperoni y mozzarella'),
  it('Cuatro quesos', 'es', 340, 'Mozzarella, gouda, parmesano y azul'), it('Suprema', 'es', 360, 'Carnes y vegetales'), it('Horchata', 'be', 45)];
const CATS = [{ id: 'cl', name: 'Clásicas' }, { id: 'es', name: 'Especiales' }, { id: 'be', name: 'Bebidas' }];
const MENU = () => ({ source: { restaurant_id: 'r_centro', schema_version: 1, items: JSON.parse(JSON.stringify(ITEMS)), extras: [],
  structure: { schema_version: 2, item_order: ITEMS.map((i) => i.key), categories: CATS } }, sourceUpdateTime: 'T1', activeVersionId: 'v142', usesPlatformFactura: false,
  renderedCategories: ['cl', 'es', 'be'], restaurantName: 'Pizzería Del Valle' });
const AVAIL = () => ({ branches: BR.map(([rid]) => ({ rid, published: true, resets_daily: true,
  items: ITEMS.map((i) => ({ key: i.key, name: i.key, price: i.price, description: i.display.desc || '', category_id: i.display.cat, category_name: CATS.find((c) => c.id === i.display.cat).name })),
  unavailable: { r_norte: [], r_centro: ['Pepperoni'], r_trejo: ['Suprema', 'Horchata'] }[rid] })) });
const DIFF = { changed: [{ surface: 'item', key: 'Margarita', field: 'price', old: 280, new: 290 }], added: [], removed: [], renamed: [], largeChangeSet: [] };
const TEAM = { ok: true, owner: { uid: 'uOwnerV', name: 'Marcela Pineda', email: 'duena@ejemplo.test' },
  managers: [{ uid: 'mgrV0001', name: 'Jorge Ayala', email: 'jorge@ejemplo.test', rids: ['r_centro'], can_edit_menu: false }],
  pending: [{ inviteId: 'inv_' + 'a'.repeat(20), name: 'Ana Reyes', email: 'ana@ejemplo.test', rids: ['r_trejo'], can_edit_menu: true, created_at: T0 - 2 * 3600e3, expires_at: T0 + 5 * 864e5 }],
  uses_platform_factura: false };
const dev = (uid, n) => ({ uid, n, paired_at: T0 - 864e6, last_seen: T0 - 60000, paired_by_name: null, paired_by_owner: true });
const DEVICES = { fetched_at: T0, pairing_enabled: true, branches: BR.map(([rid], i) => ({ rid, prep_ok: true, order_surface: 'handheld', devices: [dev(`hh_${i + 1}`, i + 1)] })) };
const STATS = { kpis: { sales_cents: 3814600, orders: 158, average_paid_ticket_cents: 24100 }, deltas: { sales_pct: 12.4, orders_pct: 8.2, average_paid_ticket_pct: -1.9 },
  comparison: { range: { from: '2026-10-13', to: '2026-10-19' }, kpis: {}, series: [] }, series: [], days: [], missing_days: [] };
const INVITE_OPEN = { state: 'open', brand_name: 'Pizzería Del Valle', branch_names: ['Bulevar del Norte'], inviter_name: 'Marcela Pineda' };
const INVITE_ID = 'inv_' + 'b'.repeat(24);   // INVITE_ID_RE /^[A-Za-z0-9_-]{22,64}$/ (aceptar.js:13)

// ── the seams: the review harnesses' (auth / firebase / invite-mail swapped in flight; Functions answered by the router) ──
const STUB = {
  'xpizza-portal/firebase.js': () => `export const app = {}; export const auth = { currentUser: null };`,
  'xpizza-portal/invite-mail.js': () => `export function inviteUrl() { return ''; } export function sendInviteLink() { return Promise.resolve(); }`,
  // signed-in or not per state; login() rejects with a real auth error code for L-error (auth-errors.js maps it)
  'xpizza-portal/auth.js': (st) => `export { authErrorMessage } from './auth-errors.js';
    export const login = async () => { const e = new Error('auth'); e.code = 'auth/invalid-credential'; throw e; };
    export const logout = async () => {};
    export const watchAuth = (cb) => { (window.__authGate || new Promise((r) => setTimeout(r, 0))).then(() => cb(${st.signedOut ? 'null' : `{ uid: ${JSON.stringify(st.uid || 'uOwnerV')}, email: 'duena@ejemplo.test' }`})); };
    export const token = () => Promise.resolve(${st.signedOut ? 'null' : "'T'"});`,
  // the invite page's DESIGNED seam (plan §4 r1.1): the REAL startAceptar with injected deps; the platform setTimeout (the real 31 s)
  'xpizza-portal/aceptar-boot.js': (st) => `import { startAceptar } from './aceptar.js';
    const S = ${JSON.stringify(st.invite || {})};
    const accepts = [...(S.accept || [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'Pizzería Del Valle', member: { name: 'Jorge Ayala', email: 'jorge@ejemplo.test' } }])];
    let session = null; const listeners = [];
    startAceptar({ doc: document, href: location.href, history, goPortal: () => {}, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
      auth: { ready: async () => session, isLink: () => true, signInWithLink: async (email) => { session = { email, uid: 'uInv' }; for (const cb of listeners) cb(session); },
        signOut: async () => { session = null; }, uid: () => (session ? session.uid : null), user: () => session, email: () => 'jorge@ejemplo.test',
        onChange: (cb) => { listeners.push(cb); cb(session); return () => {}; },
        updatePassword: async () => { if (S.pwRecent) { const e = new Error('recent'); e.code = 'auth/requires-recent-login'; throw e; } },
        sendReset: async () => {} },
      api: { preview: async () => { if (S.previewFail) { const e = new Error('x'); e.status = 503; throw e; } return ${JSON.stringify(INVITE_OPEN)}; },
        accept: () => (S.hold ? new Promise(() => {}) : Promise.resolve(accepts.length > 1 ? accepts.shift() : accepts[0])), passwordSet: async () => {} } });`,
};

// ── the §4 STATES (pane-level premises only). page: 'index' | 'aceptar'; drive(c) uses in-page helpers (__btn / __q / __type) ──
const H = `window.__q = (s) => [...document.querySelectorAll(s)];
  window.__btn = (t, root) => [...(root || document).querySelectorAll('button,a.btn')].find((b) => b.offsetParent !== null && (b.textContent.trim() === t || (b.getAttribute('aria-label') || '') === t));
  window.__click = (t, root) => { const b = __btn(t, root); if (!b) throw new Error('no button ' + t); b.click(); return true; };
  window.__type = (id, v) => { const i = document.getElementById(id); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); return true; };
  window.__submit = (id) => { document.getElementById(id).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; };`;
const at = (expr, ms = 400) => async (c) => { await c.ev(expr); await sleep(ms); };
const seq = (...steps) => async (c) => { for (const s of steps) await s(c); };
const nav = (id) => at(`(document.getElementById(${JSON.stringify(id)}).click(), true)`, 600);
const navLabel = (t) => at(`(() => { const b = [...document.querySelectorAll('.side .nav, #mnav .mn')].find((x) => x.offsetParent !== null && x.textContent.trim().startsWith(${JSON.stringify(t)})); if (!b) throw new Error('no nav ' + ${JSON.stringify(t)}); b.click(); return true; })()`, 700);
const rowChev = (n = 0) => at(`(__q('#detail .irow .rowchev')[${n}].click(), true)`, 500);
// P-review / P-receipt: one real edit (Margarita 280 → 290, the list-row price input) so «Revisar cambios» has a diff
const editPrice = async (c) => { await c.ev(`(() => { const i = __q('#detail .price input')[1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '290'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await sleep(150); };
const STATES = {
  'L-login':         { page: 'index', signedOut: true, container: '#loginform', drive: async () => {} },
  'L-error':         { page: 'index', signedOut: true, container: '#loginform', drive: seq(at("__type('email', 'duena@ejemplo.test')", 50), at("__type('pass', 'x1')", 50), at("__submit('loginform')", 600)) },
  'I-email':         { page: 'aceptar', invite: {}, container: '#st-email', drive: async () => {} },
  'I-busy':          { page: 'aceptar', invite: { hold: true }, container: '#st-busy', drive: seq(at("__type('correo', 'jorge@ejemplo.test')", 50), at("__submit('emailform')", 600)) },
  'I-busy-retry':    { page: 'aceptar', invite: { accept: [{ ok: false, code: 'pending' }] }, container: '#busy-retry', drive: seq(at("__type('correo', 'jorge@ejemplo.test')", 50), at("__submit('emailform')", 600)) },
  // the REAL 31 s auto-retry (RETRY_MS = 31000) gets a SECOND pending ⇒ the fallback (aceptar.js :74); waited, never faked
  'I-busy-fallback': { page: 'aceptar', invite: { accept: [{ ok: false, code: 'pending' }, { ok: false, code: 'pending' }] }, container: '#busy-fallback', drive: seq(at("__type('correo', 'jorge@ejemplo.test')", 50), at("__submit('emailform')", 32500)) },
  'I-password':      { page: 'aceptar', invite: {}, container: '#st-password', drive: seq(at("__type('correo', 'jorge@ejemplo.test')", 50), at("__submit('emailform')", 700)) },
  'I-reset-sent':    { page: 'aceptar', invite: { pwRecent: true }, container: '#reset-sent', drive: seq(at("__type('correo', 'jorge@ejemplo.test')", 50), at("__submit('emailform')", 700), at("__type('pw', 'unaclave-segura')", 50), at("__submit('pwform')", 700)) },
  'I-error':         { page: 'aceptar', invite: { previewFail: true }, container: '#st-error', drive: async () => {} },
  'I-invalid':       { page: 'aceptar', noInvite: true, container: '#st-invalid', drive: async () => {} },
  'P-editor':        { page: 'index', container: '#detail', drive: async () => {} },
  'P-drawer':        { page: 'index', container: '#drawer', drive: rowChev(1) },
  'P-review':        { page: 'index', container: '#scrim .modal', edit: { diff: DIFF }, drive: seq(editPrice, at("(document.getElementById('review').click(), true)", 800)) },
  'P-receipt':       { page: 'index', container: '#mbody .receipt', edit: { diff: DIFF }, drive: seq(editPrice, at("(document.getElementById('review').click(), true)", 800), at("(document.getElementById('pubbtn').click(), true)", 900)) },
  'P-conflict':      { page: 'index', container: '#mbody .conflict', edit: { status: 409, body: { error: 'stale_edit' } }, drive: seq(editPrice, at("(document.getElementById('review').click(), true)", 800)) },
  'P-readonly':      { page: 'index', role: 'manager', caps: MGR_RO, container: '#detail', drive: async () => {} },
  'A-drawer':        { page: 'index', role: 'manager', caps: MGR_RO, container: '#availdrawer', drive: rowChev(0) },
  'S-list':          { page: 'index', container: '#viewsuc', drive: nav('navsuc') },
  'S-detail':        { page: 'index', container: '#viewsuc', drive: seq(nav('navsuc'), at("(__q('#viewsuc .card.clk')[0].click(), true)", 600)) },
  'Z-pause':         { page: 'index', container: '#pausemodal', drive: seq(nav('navpausas'), at("__click('Pausar sucursal')", 500)) },
  'E-devices':       { page: 'index', container: '#viewequipos', drive: nav('navequipos') },
  'E-unlink':        { page: 'index', container: '#devmodal', drive: seq(nav('navequipos'), at("__click('Desvincular')", 500)) },
  'V-ventas':        { page: 'index', container: '#viewventas', drive: nav('navventas') },
  'T-team':          { page: 'index', container: '.main:not(.hidden)', drive: navLabel('Equipo de trabajo') },
  'T-invite':        { page: 'index', container: '.modal[role=dialog]', drive: seq(navLabel('Equipo de trabajo'), at("__click('Invitar gerente')", 500)) },
  'T-edit':          { page: 'index', container: '.modal[role=dialog]', drive: seq(navLabel('Equipo de trabajo'), at("__click('Editar')", 500)) },
  'T-sent':          { page: 'index', container: '.modal .tsent', drive: seq(navLabel('Equipo de trabajo'), at("__click('Invitar gerente')", 500),
    async (c) => { await c.ev(`(() => { const m = document.querySelector('.modal[role=dialog]'); const ins = [...m.querySelectorAll('input')];
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const i of ins) { if (i.type === 'email') { set.call(i, 'luis@ejemplo.test'); i.dispatchEvent(new Event('input', { bubbles: true })); }
        else if (i.type === 'text') { set.call(i, 'Luis Mejía'); i.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      const pick = m.querySelector('.tpick'); if (!pick) throw new Error('premise: no branch pick in the invite modal'); pick.click();   // the branch picks are .tpick buttons (team.js)
      return true; })()`); await sleep(200); }, at("__click('Enviar invitación')", 900)) },
  'T-remove':        { page: 'index', container: '.modal[role=dialog]', drive: seq(navLabel('Equipo de trabajo'), at("__click('Quitar acceso')", 500)) },
  // P-crop: only when the dish-photos B slice is in the build tip (it is not at this base); listed, then skipped with its reason
  'P-crop':          { page: 'index', requires: 'xpizza-portal/photo.js', container: '#drawer .phcrop', drive: async () => { throw new Error('P-crop needs the photos B tip'); } },
};

// ── the router: every external https request answered per state ──
function decideFor(st) {
  const ok = (body) => ({ body: JSON.stringify(body) });
  return (url, req) => {
    if (/fonts\.googleapis\.com\/css2/.test(url)) return st.baseline ? { body: BASELINE_CSS, headers: { 'content-type': 'text/css' } } : 'fail';
    if (/fonts\.gstatic\.com\/s\//.test(url)) {
      const f = st.baseline && PIN.files.find((x) => x.url === url.split('?')[0]);
      if (!f || st.fontGate === 'fail') return 'fail';
      if (st.fontGate === 'hold') return 'hold';
      return { body: pinnedBytes(f), headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' } };
    }
    const fn = fnOf(url);
    if (!fn) return 'fail';                                                        // the SDK host, the heartbeat, anything else
    if (fn === 'getMyBranches') return ok(E1(st.role || 'owner', st.caps || OWNER));
    if (fn === 'getEditableCatalog') return ok(MENU());
    if (fn === 'getBranchAvailability') return ok(AVAIL());
    if (fn === 'editCatalog') { const e = st.edit || {}; if (e.status) return { status: e.status, body: JSON.stringify(e.body) }; let src = null; try { src = JSON.parse(req.postData || '{}').source; } catch (_) {} return ok({ diff: e.diff || DIFF, token: 'tok', updateTime: 'T2', source: src }); }
    if (fn === 'publishEdited') return ok({ ok: true, versionId: 'v143' });
    if (fn === 'memberList') return ok(TEAM);
    if (fn === 'memberInvite') return ok({ ok: true, inviteId: 'inv_' + 'c'.repeat(24), email: 'luis@ejemplo.test', name: 'Luis Mejía' });
    if (fn === 'getBranchDevices') return ok(DEVICES);
    if (fn === 'getSalesStats') return ok(STATS);
    if (fn === 'reportClientVersion') return 'fail';
    return { status: 404, body: JSON.stringify({ error: 'not_found' }) };
  };
}
const PINNED = new Map();
function pinnedBytes(f) {   // the baseline's bytes: the PINNED files, found by full sha256 + length among the committed copies
  if (PINNED.has(f.url)) return PINNED.get(f.url);
  const dir = path.join(ROOT, SITE, 'fonts');
  for (const n of fs.readdirSync(dir)) { const b = fs.readFileSync(path.join(dir, n)); if (sha(b) === f.sha256 && b.length === f.bytes) { PINNED.set(f.url, b); return b; } }
  throw new Error(`no committed bytes match the pin for ${f.url}`);
}
let BASELINE_ROOT = null;
function baselineRoot() {   // today's portal, exported from the base (independent of the candidate tree)
  if (BASELINE_ROOT) return BASELINE_ROOT;
  BASELINE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-fonts-baseline-'));
  execFileSync('tar', ['-x', '-C', BASELINE_ROOT], { input: execFileSync('git', ['archive', BASELINE_REV, SITE], { cwd: ROOT, maxBuffer: 1 << 28 }) });
  process.once('exit', () => fs.rmSync(BASELINE_ROOT, { recursive: true, force: true }));
  return BASELINE_ROOT;
}

// ── in-page instruments (the forms harness's) ──
const PAINT_SNAP = `(() => { const GEO = () => [...document.querySelectorAll('body *')].filter((e) => !/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(e.tagName)).map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)).join(','); });
  try { new PerformanceObserver((l, obs) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint' && !window.__paintSnap) { obs.disconnect();
    requestAnimationFrame(() => { window.__paintSnap = { t: performance.now(), fcp: e.startTime, geo: GEO(), loaded: [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Archivo' && f.status === 'loaded').map((f) => 'Archivo ' + f.weight + ' ' + f.unicodeRange.slice(0, 12)) }; }); } }).observe({ type: 'paint', buffered: true }); } catch (_) {} })();`;
// per shift: when, how much, WHICH nodes moved (prev → current rect), and what each source is (text-bearing? its first family / weight),
// plus the page's FONT TIMELINE from document start (FontFaceSet loading / loadingdone / loadingerror per face) — the advisor's ruling
// (2026-10-31) classifies each entry from these; the hosted-font resource windows are read from Resource Timing at the end of the run
const SHIFT_SRC = `window.__shiftSrc = []; window.__fontEv = []; try {
  const key = (f) => f.family.replace(/["']/g, '') + '|' + f.weight + '|' + f.unicodeRange.slice(0, 16);
  for (const type of ['loading', 'loadingdone', 'loadingerror']) document.fonts.addEventListener(type, (ev) => { for (const f of ev.fontfaces) window.__fontEv.push({ t: performance.now(), type, face: key(f), family: f.family.replace(/["']/g, '') }); });
  const d = (n) => { if (!n || !n.nodeType) return '?'; const e = n.nodeType === 1 ? n : n.parentElement; if (!e) return '#text';
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 3).join('.') : ''); };
  const textOf = (n) => { if (!n) return []; const out = []; const w = document.createTreeWalker(n.nodeType === 1 ? n : n.parentNode || n, NodeFilter.SHOW_TEXT);
    for (let x = n.nodeType === 3 ? n : w.nextNode(); x && out.length < 40; x = w.nextNode()) { if (x.data.trim() && x.parentElement) { const cs = getComputedStyle(x.parentElement);
      out.push({ family: cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''), weight: cs.fontWeight }); } if (n.nodeType === 3) break; } return out; };
  const r = (x) => [x.x, x.y, x.width, x.height].map((v) => Math.round(v)).join(',');
  // a source inside #viewmenu: by its node when Chrome reports one, else (node already detached / null) by its rect inside #viewmenu's box
  const inVm = (s) => { const e = s.node && (s.node.nodeType === 1 ? s.node : s.node.parentElement); if (e && e.isConnected) return !!e.closest('#viewmenu');
    const vm = document.getElementById('viewmenu'); if (!vm) return false; const b = vm.getBoundingClientRect(), c = s.currentRect;
    return c.width > 0 && c.x >= b.x - 1 && c.y >= b.y - 1 && c.x + c.width <= b.right + 1 && c.y + c.height <= b.bottom + 1; };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shiftSrc.push({ t: e.startTime, v: e.value,
    fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded' && f.family.replace(/["']/g, '') === 'Archivo').length,
    sources: (e.sources || []).map((s) => ({ desc: d(s.node) + ' ' + r(s.previousRect) + '→' + r(s.currentRect), inViewmenu: inVm(s), text: textOf(s.node) })) }); }).observe({ type: 'layout-shift', buffered: true }); } catch (_) {}`;
const FONT_RES = `performance.getEntriesByType('resource').filter((e) => /\\.woff2(\\?|$)|fonts\\.gstatic\\.com\\/s\\//.test(e.name)).map((e) => ({ name: e.name.split('/').pop(), start: e.startTime, end: e.responseEnd || e.startTime + e.duration }))`;
const FRAME = 1000 / 60;
// The RULING: an entry is FONT-ATTRIBUTED (fails) iff (a) it starts while any hosted font request is in flight or within one frame after
// it completes (Resource Timing for the bytes; FontFaceSet loading → loadingdone|loadingerror for the face), OR (b) a source carries text
// whose first family is a hosted face AND a face of that family finished loading between the frame before the entry and the entry (its
// rendered family changed across the entry: fallback → hosted). Everything else is LOGGED against FINDING-portal-shell-late-shift.md.
// No selector list: a font shift inside the shell's containers is caught by (a)/(b) like any other.
export function classifyShifts(shifts, fontEv, fontRes) {
  const windows = fontRes.map((x) => ({ from: x.start, to: x.end, why: `font request ${x.name}` }));
  const open = new Map();
  for (const e of fontEv) { if (!hostedOf(e.family)) continue; if (e.type === 'loading') open.set(e.face, e.t); else { windows.push({ from: open.has(e.face) ? open.get(e.face) : e.t, to: e.t, why: `face ${e.face} ${e.type}` }); open.delete(e.face); } }
  for (const [face, t] of open) windows.push({ from: t, to: Infinity, why: `face ${face} still loading` });
  const loadedAt = fontEv.filter((e) => e.type === 'loadingdone' && hostedOf(e.family));
  return shifts.map((x) => {
    const a = windows.find((w) => x.t >= w.from && x.t <= w.to + FRAME);
    const b = x.sources.some((s) => s.text.some((tx) => hostedOf(tx.family) && loadedAt.some((e) => e.family === hostedOf(tx.family) && e.t > x.t - 2 * FRAME && e.t <= x.t + FRAME)));
    return { ...x, font: !!(a || b), armA: !!a, armB: !!b, why: a ? `(a) ${a.why}` : b ? '(b) a text source\'s hosted face finished loading across the entry' : 'shell content (no font in flight, no text source changed face)' };
  });
}
const showShifts = (cls) => { for (const x of cls) console.log(`      ${x.font ? 'FONT ' : 'shell'} shift @${Math.round(x.t)} ms ${+x.v.toPrecision(4)} [${x.why}] ${x.sources.slice(0, 4).map((s) => s.desc).join(' | ')}`); };
const FREEZE = `(() => { const T = ${T0}; const D = Date; class FD extends D { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } } window.Date = FD; })();`;
const QUIET = `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); });`;
const THEME = (t) => `document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}));`;
const settle = async (cdp) => { await cdp.ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
async function premisePane(cdp, sel) {
  const ok = await cdp.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing';
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) return 'hidden';
    return (e.innerText || '').trim() ? 'ok' : 'empty'; })()`);
  if (ok !== 'ok') throw new Error(`premise: ${sel} is ${ok}`);
}

// ── one run: boot an entry page in a state under a font policy ──
async function run({ side = 'candidate', fontGate, throttle = false, oldPolicy = false, stateName = 'P-editor', deterministic = false, holdMs = 6000, faceChange = false,
  view = 1280, theme = 'light', typing = false }) {
  const def = STATES[stateName];
  const load1 = os.loadavg()[0];   // the slot rule: load1 > 45 ⇒ UNTRUSTED STOP (checked before EVERY run, not only at launch)
  LOAD_MAX = Math.max(LOAD_MAX, load1);
  if (load1 > 45) { console.log(`\nUNTRUSTED STOP: 1-min load ${load1.toFixed(2)} > 45 before ${side} ${stateName} @${view}px`); process.exit(3); }
  const st = { ...def, baseline: side === 'baseline', fontGate };
  const root = side === 'baseline' ? baselineRoot() : ROOT;
  const srv = await serveDir(root, {
    gate: (rel) => (new RegExp(`^${SITE}/fonts/.*\\.woff2$`).test(rel) ? fontGate : undefined),
    rewrite: (rel, buf) => {
      let out;
      if (STUB[rel]) out = STUB[rel](st);
      if (oldPolicy) {   // the OLD policy, in flight: swap, no fallback faces, no fallback names in the stacks
        if (/portal-fonts\.css$/.test(rel)) out = String(out ?? buf).replace(/font-display:optional/g, 'font-display:swap').replace(/@font-face\{font-family:'Archivo Fallback[^']*';[^}]*\}/g, '');
        if (/(styles|aceptar)\.css$/.test(rel)) out = String(out ?? buf).replace(/,'Archivo Fallback( Roboto)?'/g, '');
      }
      if (faceChange && side === 'candidate' && /index\.html$/.test(rel)) out = String(out ?? buf).replace('</head>', '<style>.nm{font-weight:600!important}</style></head>');   // FC-ctrl
      return out;
    },
  });
  const cdp = await launch({ width: view, height: view < 600 ? 844 : 900, dpr: view < 600 ? 2 : 1, throttle });
  let rtRef = null;
  try {
    const errs = [];
    const decide = decideFor(st);
    const rt = await router(cdp, decide); rtRef = rt;
    cdp.on('Fetch.requestPaused', (p) => { const u = p.request.url; if (decide(u, p.request) === 'hold' && !isFontUrl(u)) errs.push(`unexpected hold: ${u}`); });
    await cdp.s('Log.enable');
    cdp.on('Runtime.exceptionThrown', (p) => errs.push(`exception: ${(p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text}`.slice(0, 200)));
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errs.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 200)); });
    cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errs.push({ log: p.entry.text.slice(0, 200), url: p.entry.url || '' }); });
    for (const src of [OBSERVER, SHIFT_SRC, PAINT_SNAP, THEME(theme), H.replace(/\n/g, ' ').replace(/^/, 'document.addEventListener("DOMContentLoaded", () => {').concat('});')]) await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: src });
    // FONTS_DELAY=getMyBranches:300 — the FINDING-portal-shell-late-shift acceptance test: the named endpoint's response is held IN PAGE
    // until <ms> after FCP (same on both sides), so late shell content always lands after a painted frame
    if (process.env.FONTS_DELAY) { const [fn, ms] = process.env.FONTS_DELAY.split(':'); await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      let fcpAt = null; const waiters = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint' && fcpAt === null) { fcpAt = e.startTime; for (const w of waiters.splice(0)) w(); } }).observe({ type: 'paint', buffered: true }); } catch (_) {}
      const afterFcp = () => new Promise((r) => (fcpAt !== null ? r() : waiters.push(r))).then(() => new Promise((r) => setTimeout(r, Math.max(0, fcpAt + ${Number(ms)} - performance.now()))));
      if (${JSON.stringify(fn)} === 'auth') { window.__authGate = afterFcp(); return; }   // FONTS_DELAY=auth:<ms>: the session resolves <ms> after FCP
      const f = window.fetch.bind(window); window.fetch = async (u, o) => { const res = await f(u, o); if (String(u).includes('/${fn}')) await afterFcp(); return res; }; })();` }); }
    if (deterministic) for (const src of [FREEZE, QUIET]) await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: src });
    const t0 = Date.now();
    const page = def.page === 'aceptar' ? `aceptar.html${def.noInvite ? '' : `?invite=${INVITE_ID}&mode=signIn&oobCode=fx&apiKey=fx`}` : 'index.html';
    await cdp.s('Page.navigate', { url: `${srv.base}/${SITE}/${page}` });
    for (let i = 0; i < 2400; i++) { if (await cdp.ev(`document.readyState !== 'loading' && !!window.__btn`).catch(() => false)) break; await sleep(25); }
    await settle(cdp); await sleep(def.page === 'index' && !def.signedOut ? 900 : 300);   // the shell's discovery + the editor's first paint
    const bootMs = Date.now() - t0;
    for (let i = 0; i < 400 && !(await cdp.ev('!!window.__paintSnap').catch(() => false)); i++) await sleep(25);
    const paintSnap = await cdp.ev('window.__paintSnap || null');
    await def.drive(cdp); await settle(cdp);
    // FF-typing: the list-row price «1280», caret INSIDE (after «12»), a sentinel caret colour on BOTH sides (byte-identical)
    let caret0 = null;
    if (typing) {
      await cdp.ev(`(() => { const i = [...document.querySelectorAll('#detail .price input')].find((x) => x.value === '1280'); if (!i) throw new Error('premise: no list-row price 1280');
        if (getComputedStyle(i).fontFamily.split(',')[0].replace(/["']/g, '').trim() !== 'Archivo' || getComputedStyle(i).fontWeight !== '800') throw new Error('premise: the target is not the Archivo 800 list-row price');
        i.id = '__typing'; const s = document.createElement('style'); s.textContent = '#__typing{caret-color:#ff00ff!important}'; document.head.appendChild(s);
        i.focus(); i.setSelectionRange(2, 2); return true; })()`);
      caret0 = await caretOf(cdp);
    }
    const before = { nodes: await census(cdp), geo: await cdp.ev(GEO), bootMs, cls: await cdp.ev('window.__cls'), caret: caret0 };
    let heldMs = 0;
    const fontUrls = () => [...rt.seen].filter((u) => isFontUrl(u));
    if (fontGate === 'hold') {
      if (srv.heldCount() + rt.holds.size === 0 && !fontUrls().length) throw new Error('premise: no font request was held — the cell would prove nothing');
      await sleep(Math.max(0, holdMs - (Date.now() - t0)));
      heldMs = Date.now() - t0;
      srv.release(); await rt.release(isFontUrl);   // ONLY font requests
    }
    for (let i = 0; ; i++) { const open = fontUrls().filter((u) => !rt.finished.has(u)); if (!open.length) break; if (i > 1200) throw new Error(`font requests never completed: ${open.join(', ')}`); await sleep(25); }
    await cdp.ev('document.fonts.ready.then(() => true)'); await sleep(250);
    let geo = await cdp.ev(GEO); for (let i = 0; i < 20; i++) { await settle(cdp); const g = await cdp.ev(GEO); if (JSON.stringify(g) === JSON.stringify(geo)) break; geo = g; }
    await premisePane(cdp, def.container);
    const caret1 = typing ? await caretOf(cdp) : null;
    const typedValue = typing ? await cdp.ev(`document.getElementById('__typing').value`) : null;
    const after = { heldMs, bootMs, paintSnap, paintGeo: paintSnap ? paintSnap.geo : null, errs, refused: [...rt.refused], nodes: await census(cdp), geo, cls: await cdp.ev('window.__cls'), shifts: await cdp.ev('window.__shiftSrc'), fontEv: await cdp.ev('window.__fontEv'), fontRes: await cdp.ev(FONT_RES),
      fontsFailed: fontUrls().filter((u) => rt.finished.get(u) === 'failed').length, caret: caret1, typedValue };
    const shot = async () => Buffer.from((await cdp.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
    const raw = deterministic ? await shot() : null;
    if (deterministic) { await cdp.ev(`(async () => { const ff = new FontFace('__Invalidate', "local('Arial')"); document.fonts.add(ff); await ff.load(); return true; })()`); await settle(cdp); await sleep(300); }
    const png = deterministic ? await shot() : null;
    const probe = await attribute(cdp, after.nodes);
    return { before, after, probe, png, raw };
  } finally {
    try { if (rtRef) await rtRef.failHeld(() => true); } catch (_) {}
    cdp.close(); srv.close();
  }
}
// the RENDERED caret: clip-screenshot the input's box until a frame shows the sentinel column (the blink's visible phase, ≤ 1.2 s)
async function caretOf(cdp) {
  const box = await cdp.ev(`(() => { const r = document.getElementById('__typing').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  for (let t = 0; t < 1200; t += 60) {
    const png = Buffer.from((await cdp.s('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })).data, 'base64');
    const { w, h, bpp, px } = decodePng(png);
    const cols = [];
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { const i = (y * w + x) * bpp; if (px[i] > 230 && px[i + 1] < 40 && px[i + 2] > 230) { cols.push(x); break; } }
    if (cols.length) return { x: box.x + Math.min(...cols), width: cols.length, box };
    await sleep(60);
  }
  throw new Error('premise: the caret never rendered (sentinel not found in 1.2 s)');
}

// ── PNG → RGBA (the forms harness's decoder) ──
function decodePng(buf) {
  let p = 8, w, h, ct; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[12] !== 0) throw new Error('png: unsupported depth/interlace'); ct = data[9]; }
    if (type === 'IDAT') idat.push(data); if (type === 'IEND') break; p += 12 + len; }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`png: color type ${ct}`); })();
  const rawb = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = rawb[y * (stride + 1)], src = rawb.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      out[y * stride + x] = (src[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255; } }
  return { w, h, bpp, px: out };
}
const pixelDiff = (a, b) => { const A = decodePng(a), B = decodePng(b); if (A.w !== B.w || A.h !== B.h) return Infinity; let d = 0;
  for (let i = 0; i < A.w * A.h; i++) for (let k = 0; k < 3; k++) if (A.px[i * A.bpp + k] !== B.px[i * B.bpp + k]) { d++; break; } return d; };

// ── census → faces / declarations (a RANGE face: gate (b) is evaluated per REQUESTED weight inside the range) ──
const nodeWeight = (n) => Number(n.weight) || 400;
function faceSet(r) {
  const set = new Set();
  for (const n of r.after.nodes) for (const f of n.fonts) if (f.glyphCount > 0) { const fam = hostedOf(f.familyName); set.add(fam ? `${fam}|${matchWeight(nodeWeight(n))}` : `${f.familyName}|system`); }
  return set;
}
function primaryDecls() {   // every PRIMARY @font-face the candidate ships (one range face per subset)
  const css = fs.readFileSync(path.join(ROOT, SITE, 'portal-fonts.css'), 'utf8');
  return [...css.matchAll(/@font-face\{font-family:'(Archivo)';font-style:(\w+);font-weight:(\d+) (\d+);[^}]*unicode-range:([^}]+)\}/g)]
    .map((m) => ({ family: m[1], style: m[2], lo: Number(m[3]), hi: Number(m[4]), range: m[5].split(',').map((r) => r.trim().replace(/^U\+/, '').split('-').map((x) => parseInt(x, 16))).map(([a, b]) => [a, b ?? a]), raw: m[5] }));
}
const inRange = (cp, range) => range.some(([lo, hi]) => cp >= lo && cp <= hi);
function requestedWeights() {   // r2's static scan: every weight a live --disp rule can request (both stylesheets)
  const w = new Set();
  for (const f of ['styles.css', 'aceptar.css']) {
    const css = fs.readFileSync(path.join(ROOT, SITE, f), 'utf8');
    for (const m of css.matchAll(/\{([^{}]*font-family\s*:\s*var\(--disp\)[^{}]*)\}/g)) for (const x of m[1].matchAll(/font-weight\s*:\s*(\d{3})/g)) w.add(Number(x[1]));
  }
  return w;
}
// For each declaration × each requested weight it serves: covered (a painted codepoint, attributed to Archivo at that weight, inside the
// declaration's unicode-range) | r1 subset-only (that weight painted, none of its codepoints in this range) | r2 weight-unrequested | FAIL
function gateB(byState, decls, reqW, without = new Set()) {
  const painted = new Set(); const cps = new Map();
  for (const [stn, r] of Object.entries(byState)) {
    if (without.has(stn)) continue;
    for (const n of r.after.nodes) for (const run of runsOf(n, r.probe).runs) {
      const fam = hostedOf(run.familyName); if (!fam) continue;
      const key = `${fam}|${matchWeight(nodeWeight(n))}|${n.style}`; painted.add(key);
      if (!cps.has(key)) cps.set(key, new Set()); for (const cp of run.codepoints) cps.get(key).add(cp);
    }
  }
  const out = [];
  for (const d of decls) for (let w = d.lo; w <= d.hi; w += 50) {
    const key = `${d.family}|${w}|${d.style}`;
    if (!reqW.has(w) && ![...reqW].some((x) => matchWeight(x) === w)) continue;   // a weight no rule requests needs no verdict
    const hit = [...(cps.get(key) || [])].some((cp) => inRange(cp, d.range));
    out.push({ ...d, weight: w, verdict: hit ? 'covered' : (painted.has(key) ? 'r1 subset-only' : 'FAIL (requested, painted nowhere — a missing state)') });
  }
  return out;
}
function gateD(r) {
  const ranges = primaryDecls().flatMap((d) => d.range); const bad = [];
  for (const n of r.after.nodes) {
    if (!hostedOf(firstFamily(n.family))) continue;
    for (const run of runsOf(n, r.probe).runs) if (!hostedOf(run.familyName) && run.codepoints.some((cp) => inRange(cp, ranges)))
      bad.push(`${n.path.slice(-50)}: ${run.familyName} draws ${JSON.stringify(String.fromCodePoint(...run.codepoints.filter((cp) => inRange(cp, ranges))))} inside Archivo's ranges`);
  }
  return bad;
}
const hostedPainted = (nodes) => nodes.some((n) => n.fonts.some((f) => hostedOf(f.familyName) && f.glyphCount > 0));
const moved = (a, b) => (a.length === b.length ? a.filter((g, i) => g !== b[i]).length : -1);
const fails = []; const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };
const fidelity = (r, label) => { const bad = r.after.nodes.flatMap((n) => runsOf(n, r.probe).fidelity.map((f) => `${n.path.slice(-40)} ${f}`)); check(!bad.length, `${label}: probe fidelity (${bad.length ? bad.slice(0, 3).join('; ') : 'every node'})`); };
const expectedErr = (e, r) => typeof e === 'object' && /^Failed to load resource/.test(e.log) && (isFontUrl(e.url) || r.after.refused.includes(e.url));

const SHELL_LOG = [];
let LOAD_MAX = 0;
const CELL_STATES = { index: 'P-editor', aceptar: 'I-email' };
for (let rep = 1; rep <= REPEATS; rep++) {
  for (const view of VIEWS) {
    console.log(`\n== repeat ${rep} · ${view}px`);
    for (const [page, stateName] of Object.entries(CELL_STATES)) {
      if (CELLS.includes('fast')) {
        const r = await run({ side: process.env.FONTS_FAST_SIDE || 'candidate', stateName, view });   // FONTS_FAST_SIDE=baseline: today's portal, the diagnostic reference
        check(hostedPainted(r.after.nodes), `[${page}] FF-fast: Archivo paints (census)`);
        check(!!r.after.paintSnap && r.after.paintGeo.length > 20, `[${page}] FF-fast premise: geometry captured in-page at FCP + 1 rAF (FCP ${r.after.paintSnap && Math.round(r.after.paintSnap.fcp)} ms; Archivo loaded then: ${r.after.paintSnap ? r.after.paintSnap.loaded.length : '?'})`);
        const m = moved(r.after.paintGeo, r.after.geo);
        if (stateName === 'P-editor') console.log(`    · P-editor's rows arrive after the shell's discovery — boxes added after FCP are content, not reflow; the FIRST-PAINT comparison is recorded (${m}), the settled comparison is FF-slow's`);
        else check(r.after.geo.length > 20 && m === 0, `[${page}] FF-fast: 0 of ${r.after.geo.length} boxes moved from FIRST PAINT to settled (${m})`);
        const cls = classifyShifts(r.after.shifts, r.after.fontEv, r.after.fontRes), fontCls = cls.filter((x) => x.font).reduce((a, x) => a + x.v, 0), shellCls = cls.filter((x) => !x.font).reduce((a, x) => a + x.v, 0);
        check(fontCls === 0, `[${page}] FF-fast: FONT-ATTRIBUTED CLS 0 over the whole window from navigation start (${+fontCls.toPrecision(3)}; total ${r.after.cls})`);
        if (shellCls) { console.log(`    · logged against FINDING-portal-shell-late-shift.md: shell-content CLS ${+shellCls.toFixed(4)}`); SHELL_LOG.push({ page, view, rep, cls: shellCls }); }
        if (cls.length) showShifts(cls);
      }
      if (CELLS.includes('clsctrl') && page === 'index') {   // NEGATIVE CONTROL for the ruling: a deliberate font SWAP inside #viewmenu must FAIL it
        const r = await run({ stateName, view, fontGate: 'hold', holdMs: 2500, oldPolicy: true });
        const cls = classifyShifts(r.after.shifts, r.after.fontEv, r.after.fontRes), font = cls.filter((x) => x.font);
        const inside = font.filter((x) => x.sources.some((s) => s.inViewmenu));
        check(hostedPainted(r.after.nodes) && !hostedPainted(r.before.nodes), `[${page}] CLS-ctrl premise: the old policy swapped fallback → Archivo at release (${r.after.heldMs} ms)`);
        check(inside.length > 0 && font.reduce((a, x) => a + x.v, 0) > 0, `[${page}] CLS-ctrl: the swap's shift inside #viewmenu is FONT-ATTRIBUTED, so the FF-fast rule FAILS it (${inside.length} entr${inside.length === 1 ? 'y' : 'ies'}; arm (a) ${inside.filter((x) => x.armA).length}, arm (b) ${inside.filter((x) => x.armB).length}; font CLS ${+font.reduce((a, x) => a + x.v, 0).toPrecision(3)})`);
        showShifts(cls);
      }
      if (CELLS.includes('slow')) {
        const r = await run({ stateName, view, fontGate: 'hold', throttle: true });
        check(!!r.after.paintSnap && r.after.paintSnap.loaded.length === 0, `[${page}] FF-slow premise: NO Archivo loaded at the FCP snapshot (${r.after.paintSnap ? JSON.stringify(r.after.paintSnap.loaded) : 'no snapshot'}) — else VOID`);
        check(!hostedPainted(r.before.nodes), `[${page}] FF-slow premise: the fallback is painted before release (fonts released at ${r.after.heldMs} ms)`);
        check(!hostedPainted(r.after.nodes), `[${page}] FF-slow: the fallback is KEPT after the held fonts complete`);
        const m = moved(r.before.geo, r.after.geo);
        check(r.after.geo.length > 20 && m === 0, `[${page}] FF-slow: 0 of ${r.after.geo.length} boxes moved (${m})`);
        check(r.after.cls - r.before.cls === 0, `[${page}] FF-slow: CLS across the font window 0 (${r.after.cls - r.before.cls})`); if (r.after.cls) showShifts(classifyShifts(r.after.shifts, r.after.fontEv, r.after.fontRes));
      }
      if (CELLS.includes('failed')) {
        const r = await run({ stateName: page === 'index' ? 'P-drawer' : 'I-password', view, fontGate: 'fail' });
        check(r.after.fontsFailed > 0, `[${page}] FF-failed premise: the font requests really failed (${r.after.fontsFailed})`);
        check(!hostedPainted(r.after.nodes), `[${page}] FF-failed: the fallback paints and is kept`);
        check(moved(r.before.geo, r.after.geo) === 0, `[${page}] FF-failed: 0 boxes move; usable (${page === 'index' ? 'a drawer opened' : 'the email step submitted → password'})`);
        const unexpected = r.after.errs.filter((e) => !expectedErr(e, r)).map((e) => (typeof e === 'object' ? `log: ${e.log} ${e.url}` : e));
        check(unexpected.length === 0, `[${page}] FF-failed: no page exceptions / console errors beyond the expected font failures (${unexpected.length ? unexpected.slice(0, 4).join(' | ') : 'none'})`);
      }
      if (CELLS.includes('ctrl')) {
        const r = await run({ stateName, view, fontGate: 'hold', throttle: true, oldPolicy: true });
        check(!!r.after.paintSnap && r.after.paintSnap.loaded.length === 0, `[${page}] FF-ctrl premise: NO Archivo loaded at the FCP snapshot — else VOID`);
        check(!hostedPainted(r.before.nodes) && hostedPainted(r.after.nodes), `[${page}] FF-ctrl: the OLD policy swaps (fallback → Archivo)`);
        const m = moved(r.before.geo, r.after.geo);
        check(m > 0, `[${page}] FF-ctrl: the geometry check SEES it — ${m} of ${r.after.geo.length} boxes moved`);
      }
    }
    if (CELLS.includes('typing')) {
      const r = await run({ stateName: 'P-editor', view, fontGate: 'hold', throttle: true, typing: true });
      check(!!r.before.caret && !!r.after.caret, `[typing] FF-typing premise: the caret rendered before and after (x ${r.before.caret && r.before.caret.x} → ${r.after.caret && r.after.caret.x})`);
      check(r.after.caret && r.before.caret && r.after.caret.x === r.before.caret.x, `[typing] FF-typing: the RENDERED caret did not move (0 px)`);
      check(r.after.caret && JSON.stringify(r.after.caret.box) === JSON.stringify(r.before.caret.box), '[typing] FF-typing: the input box unchanged');
      check(r.after.typedValue === '1280', `[typing] FF-typing: the value intact (${r.after.typedValue})`);
      check(moved(r.before.geo, r.after.geo) === 0, '[typing] FF-typing: 0 boxes move');
      const c = await run({ stateName: 'P-editor', view, fontGate: 'hold', throttle: true, typing: true, oldPolicy: true });
      check(c.after.caret && c.before.caret && c.after.caret.x !== c.before.caret.x, `[typing] FF-typing control: the SAME caret MOVES under the old policy (${c.before.caret && c.before.caret.x} → ${c.after.caret && c.after.caret.x}) — else the 0 above is void`);
    }
  }
  if (CELLS.includes('same')) {
    for (const view of VIEWS) for (const theme of THEMES) {
      console.log(`\n== FF-same · repeat ${rep} · ${view}px · ${theme}`);
      const byState = {};
      const states = Object.keys(STATES).filter((s) => !arg('states') || arg('states').includes(s));
      for (const stn of states) {
        if (STATES[stn].requires && !fs.existsSync(path.join(ROOT, STATES[stn].requires))) { console.log(`    · ${stn}: N/A — ${STATES[stn].requires} is not in this tip (listed, skipped)`); continue; }
        const base = await run({ side: 'baseline', stateName: stn, deterministic: true, view, theme });
        const cand = await run({ side: process.env.FONTS_SELF_CONTROL ? 'baseline' : 'candidate', stateName: stn, deterministic: true, view, theme });
        byState[stn] = cand;
        fidelity(base, `${stn} baseline`); fidelity(cand, `${stn} candidate`);
        check(hostedPainted(base.after.nodes) && hostedPainted(cand.after.nodes), `${stn}: Archivo paints on BOTH sides`);
        const A = [...faceSet(base)].sort(), B = [...faceSet(cand)].sort();
        check(JSON.stringify(A) === JSON.stringify(B), `${stn} gate (a): face sets identical (${B.length})${JSON.stringify(A) === JSON.stringify(B) ? '' : ` base ${JSON.stringify(A)} cand ${JSON.stringify(B)}`}`);
        const d = pixelDiff(base.png, cand.png), dRaw = pixelDiff(base.raw, cand.raw);
        if (d || process.env.FONTS_SAVE) for (const [k, b] of [['base', base.png], ['cand', cand.png]]) fs.writeFileSync(path.join(OUT, `${stn}-${view}-${theme}-${k}.png`), b);
        check(d === 0, `${stn} gate (c): pixel-exact, equalized history (${d} differing pixels; raw ${dRaw}, informational)`);
        for (const [side, r] of [['baseline', base], ['candidate', cand]]) { const bad = gateD(r); check(!bad.length, `${stn} gate (d) ${side}: no silent fallback${bad.length ? ` — ${bad.slice(0, 3).join('; ')}` : ''}`); }
      }
      if (byState['P-drawer']) {   // FC-ctrl: a REAL face change survives the normalization ⇒ the gate must fail
        const b0 = await run({ side: 'baseline', stateName: 'P-editor', deterministic: true, view, theme });
        const c0 = await run({ side: 'candidate', stateName: 'P-editor', deterministic: true, view, theme, faceChange: true });
        check(pixelDiff(b0.png, c0.png) > 0, 'FC-ctrl: a deliberate face change (.nm → the 600 weight) FAILS the normalized pixel gate');
      }
      const decls = primaryDecls(), reqW = requestedWeights();
      const vb = gateB(byState, decls, reqW);
      for (const v of vb) check(!/^FAIL/.test(v.verdict), `gate (b) ${v.family} ${v.weight} ${v.raw.slice(0, 18)}…: ${v.verdict}`);
      const coveredKeys = [...new Set(vb.filter((v) => v.verdict === 'covered').map((v) => `${v.family}|${v.weight}|${v.style}`))].sort();
      const pick = coveredKeys[0];
      const painters = new Set(Object.entries(byState).filter(([, r]) => r.after.nodes.some((n) => runsOf(n, r.probe).runs.some((x) => hostedOf(x.familyName) && `${hostedOf(x.familyName)}|${matchWeight(nodeWeight(n))}|${n.style}` === pick))).map(([s]) => s));
      const named = gateB(byState, decls, reqW, painters).filter((v) => /^FAIL/.test(v.verdict) && `${v.family}|${v.weight}|${v.style}` === pick);
      check(!!pick && named.length > 0, `FB-ctrl: removing ${painters.size} state(s) that paint ${pick} makes gate (b) FAIL, naming it (${named.length} declaration·weight)`);
      if (view === VIEWS[0] && theme === THEMES[0]) fs.writeFileSync(path.join(OUT, `portal.census.${rep}.json`), JSON.stringify({ rep, view, theme, gateB: vb.map(({ range, ...x }) => x),
        states: Object.fromEntries(Object.entries(byState).map(([s, r]) => [s, r.after.nodes.map((n) => ({ path: n.path, family: n.family, weight: n.weight, runs: runsOf(n, r.probe).runs.map((x) => ({ font: x.familyName, cps: x.codepoints.length })) }))])) }, null, 1));
    }
  }
}
if (SHELL_LOG.length) console.log(`\nshell-content CLS logged against FINDING-portal-shell-late-shift.md (not failed, advisor ruling 2026-10-31): ${SHELL_LOG.map((x) => `${x.page} ${x.view}px r${x.rep} ${+x.cls.toFixed(4)}`).join(' · ')}`);
console.log(`\nmax 1-min load at a run start: ${LOAD_MAX.toFixed(2)} (limit 45)`);
console.log(`\nartifacts: ${OUT}`);
console.log(fails.length ? `\nportal-fonts.cdp: ${fails.length} FAILED` : '\nportal-fonts.cdp: OK');
process.exit(fails.length ? 1 : 0);
