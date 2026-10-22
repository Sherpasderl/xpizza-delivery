// CUSTOMER APP S0-test — THE CAPTURE RIG: three brands, real catalogs, real forms, no network.
//
// CATALOG (real writers, seeded): x_pizza and la_musa publish their code-bootstrapped catalog through the
// real publishVersion (tools/publish-version buildPublishCandidate), exactly the recipe of
// plan-fixtures/gen-fixtures2.js; the third brand comes from third-brand-fork.mjs. Each is served as the
// real getPublicMenu body. The etags are pinned to the plan's appendix (§10), which is what proves the
// seeded allocator here is the plan's allocator.
//
// PAGE: the shared form-harness, plus two preamble scripts that run before any page script:
//   • a fixed clock (Wednesday 18:00 Honduras, both restaurants open), advancing with real elapsed time
//     so timers still behave;
//   • a network trap: XMLHttpRequest / WebSocket / EventSource / sendBeacon record into
//     window.__netEscapes and throw. fetch is the harness stub. A cell asserts zero escapes, so no
//     PixelPay, Maps or Firebase request can leave the process unseen.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadForm, settle, res } from '../../../form-harness.mjs';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const FN = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const T0 = Date.UTC(2026, 9, 22, 0, 0, 0);          // Wed 2026-10-21 18:00 America/Tegucigalpa
export const PLAN_ETAG = {                                // PLAN-shared-order-form.FINAL §10.3
  x_pizza: '"ae86a305a2ef6182f69bca11154e853cd46a4eaa48eb41cb780713675fafc22e"',
  la_musa: '"cdc6aacb177948ea8b7f5ca2aadee58f7e4b81b5ba210191138d44ba31ef7e94"',
};

export const PREAMBLE = `(function(){
  var R = Date, start = R.now(), T0 = ${T0};
  function D(){ var a = Array.prototype.slice.call(arguments);
    return a.length ? new (Function.prototype.bind.apply(R, [null].concat(a)))() : new R(T0 + (R.now() - start)); }
  D.prototype = R.prototype; D.now = function(){ return T0 + (R.now() - start); }; D.UTC = R.UTC; D.parse = R.parse;
  window.Date = D;
  window.__netEscapes = [];
  var trap = function(kind){ return function(u){ window.__netEscapes.push(kind + ' ' + String(u)); throw new Error('capp: network escape via ' + kind); }; };
  window.XMLHttpRequest = function(){ return { open: trap('XMLHttpRequest'), send: function(){}, setRequestHeader: function(){}, addEventListener: function(){} }; };
  window.WebSocket = trap('WebSocket'); window.EventSource = trap('EventSource');
  try { Object.defineProperty(window.navigator, 'sendBeacon', { value: trap('sendBeacon'), configurable: true }); } catch (_) {}
})();`;

function seededMint(fn) {
  const real = crypto.randomBytes;
  let ctr = 0;
  crypto.randomBytes = (n) => {
    const out = Buffer.alloc(n);
    for (let off = 0, blk = 0; off < n; blk += 1) {
      const h = crypto.createHash('sha256').update(`det:${ctr}:${blk}`).digest();
      const take = Math.min(h.length, n - off); h.copy(out, off, 0, take); off += take;
    }
    ctr += 1;
    return out;
  };
  return Promise.resolve().then(fn).finally(() => { crypto.randomBytes = real; });
}

// x_pizza / la_musa: the plan-fixtures recipe (real publish, seeded), served as getPublicMenu sends it.
export async function provisionBrand(rid) {
  const { makeDb } = require(join(FN, 'catalog/firestore-fake'));
  const { publishVersion } = require(join(FN, 'catalog/catalog-publish'));
  const { buildPublishCandidate } = require(join(FN, 'tools/publish-version'));
  const { buildPublicMenu } = require(join(FN, 'catalog/public-menu'));
  const db = makeDb();
  await seededMint(async () => {
    const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: '1b' });
    await publishVersion(db, rid, input, { expected });
  });
  const m = await buildPublicMenu(db, rid, { known: new Set([rid]), isActive: async () => true });
  return { rid, etag: m.etag, envelope: { rid: m.rid, representation_version: m.representation_version, menu: m.body } };
}

// The same minimal google.maps the location suites use, so initMap/placePin run (the Maps script is stripped).
function installMaps(w) {
  const marker = { setMap() {}, setPosition() {}, addListener() {}, getPosition() { return null; } };
  const mkMap = () => ({ setCenter() {}, setZoom() {}, setMapTypeId() {}, addListener() {}, getCenter() { return { lat: () => 0, lng: () => 0 }; } });
  w.google = { maps: {
    Map: function () { return mkMap(); }, Marker: function () { return marker; },
    Geocoder: function () { return { geocode(req, cb) { try { cb([], 'ZERO_RESULTS'); } catch (_) {} } }; },
    Animation: { DROP: 1 }, Size: function () {}, Point: function () {},
    places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) }, Place: function () {} },
  } };
}

/* The rewards each brand runs TODAY, in the shape the page's own account module stores (plan §10.2). */
export const REWARD = {
  punch: { payload: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, cost: 8 },
  points: { payload: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 2, name: 'Arroz Blanco' }] }, cost: 334 },
};

/* ONE CELL, driven through the page's own writers and UI handlers:
   cart = the first priced dish ×2 with the first extra its detail modal offers (a real delegated click);
   contact fields; order type; for delivery a pin 1–2 km from the restaurant (the page's own placePin);
   then the cell's variation; then the real send (submitOrder / processPixelPay). */
export async function driveCell(dir, envelope, cell, { transforms } = {}) {
  const answer = (u, body) => {
    if (/quoteRedemption/.test(u)) {
      const r = REWARD[cell.reward];
      // priced by the REAL server pricer over the cart as sent; today's rewards are add-free (no discount, plan §10.2)
      const { computeServerTotal } = require(join(FN, 'menu-pricing'));
      const priced = computeServerTotal((body && body.items) || [], body && body.restaurant_id);
      if (!priced || priced.error || typeof priced.total !== 'number') throw new Error(`capp: the real pricer refused the reward cart (${JSON.stringify(priced)})`);
      return res({ ok: true, total_cents: Math.round(priced.total * 100), savings_cents: 0, free_items: [], remaining: 0, total_cost: r ? r.cost : 0 });
    }
    return null;
  };
  const { w, sent } = await boot(dir, envelope, { transforms, answer });
  installMaps(w);
  const doc = w.document;
  const { dish, extra } = await composeCart(w);
  const set = (id, v) => { const el = doc.getElementById(id); if (!el) throw new Error(`capp cell ${dir}/${cell.id}: no #${id}`); el.value = v; };
  set('cname', 'Cliente Prueba'); set('cphone', '98765432'); set('cemail', cell.email === undefined ? 'cliente@prueba.hn' : cell.email); set('notes', '');
  w.setOrderType(cell.pickup ? 'pickup' : 'delivery'); await settle();
  if (!cell.pickup) {
    w.initMap(); await settle();
    w.placePin(w.eval('RESTAURANT_LAT') + 0.01, w.eval('RESTAURANT_LNG') + 0.01, false); await settle();
    set('address-details', 'Casa azul, portón negro');
  }
  if (cell.rtn) { doc.getElementById('rtn-toggle').checked = true; w.toggleRtn(); set('razon-social', 'Empresa Prueba S. de R.L.'); set('rtn-cliente', '08011999123456'); }
  if (cell.scheduled) {
    w.openSched(); await settle();
    const first = doc.querySelector('#sched-slots .sched-slot');
    if (!first) throw new Error(`capp cell ${dir}/${cell.id}: no schedulable slot at the fixed clock`);
    first.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); w.confirmSched(); await settle();
  }
  if (cell.reward) {
    w.localStorage.setItem(w.__ACCOUNT.CONFIG.MARKER, JSON.stringify({ uid: 'u-capp', name: 'Cliente Prueba' }));
    w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { customerIdToken: () => Promise.resolve('test-id-token') });
    w.__ACCOUNT.restoreRedeem(REWARD[cell.reward].payload, null, null);
    await w.__ACCOUNT.requoteRedeem(w.redeemCartItems()); await settle();
  }
  w.selectPay(cell.card ? 'online' : 'cash'); await settle();
  if (w.buildOrder() !== true) throw new Error(`capp cell ${dir}/${cell.id}: the page refused to compose the order`);
  const pend = cell.card ? w.processPixelPay() : w.submitOrder('confirmed');
  if (pend && pend.catch) pend.catch(() => {});
  await settle(); await settle();
  return { w, sent, dish, extra };
}

/* The cart every cell uses: the first priced dish ×2 and, when the catalog offers any, the first extra its
   detail modal shows, added by a real (delegated) click on instance 0. A catalog with no extras at all
   (the third brand publishes none) gets the dish alone; `extra` says which happened, and the real-brand
   suites assert it is true so the extras path is never silently skipped. */
export async function composeCart(w) {
  const doc = w.document;
  const priced = w.liveMenuGlobalGet('MENU').filter((x) => x.price > 0);
  if (!priced.length) throw new Error('capp: the served menu has no priced dish');
  for (const d of priced) {
    w.chg(d.id, 2); await settle(); w.openDetailModal(d.id); await settle();
    const row = doc.querySelector('#detail-modal [data-act="extra"]');
    if (row) { row.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); w.closeDetailModal(); await settle(); return { dish: d, extra: true }; }
    w.closeDetailModal(); await settle(); w.chg(d.id, -2); await settle();
  }
  w.chg(priced[0].id, 2); await settle();
  return { dish: priced[0], extra: false };
}

/* REWARDS SESSION (DOM cells only). account.js loads Firebase by dynamic https import, which jsdom cannot
   run; the s5-confirmation seam rewrites exactly those three imports to window.__gstatic, and the fake
   modules below answer the two reads the rewards UI makes: user_rewards/{uid}/{rid} (the balance) and
   config/rewards_public/redemption_live. The marker and the fake are installed in the PREAMBLE, before
   account.js runs, because its start-up subscribes immediately. Everything past the import runs as shipped. */
export const GSTATIC = { 'account.js': (code) => {
  const re = /import\(`\$\{V\}\/(firebase-(?:app|auth|database)\.js)`\)/g;
  const n = (code.match(re) || []).length;
  if (n !== 3) throw new Error(`capp: account.js should import exactly three gstatic modules, found ${n}`);
  return code.replace(re, 'window.__gstatic(`${V}/$1`)');
} };
export function rewardsPreamble(marker, state) {
  return `${PREAMBLE}
(function(){
  try { localStorage.setItem(${JSON.stringify(marker)}, JSON.stringify({ uid: 'u-capp', name: 'Cliente Prueba' })); } catch (_) {}
  var STATE = ${JSON.stringify(state)};
  var db = { getDatabase: function(){ return {}; }, ref: function(_d, p){ return { path: p }; },
    onValue: function(r, cb){ if (/^user_rewards\\/u-capp\\//.test(r.path)) setTimeout(function(){ cb({ val: function(){ return STATE; } }); }, 0); return function(){}; },
    get: function(r){ return Promise.resolve({ val: function(){ return r.path === 'config/rewards_public/redemption_live' ? true : null; } }); },
    update: function(){ return Promise.resolve(); } };
  var auth = { currentUser: { uid: 'u-capp', getIdToken: function(){ return Promise.resolve('test-id-token'); } }, authStateReady: function(){ return Promise.resolve(); } };
  var mods = { 'firebase-app.js': { initializeApp: function(){ return {}; } },
    'firebase-auth.js': { getAuth: function(){ return auth; }, setPersistence: function(){ return Promise.resolve(); }, browserLocalPersistence: {}, signOut: function(){ return Promise.resolve(); }, onAuthStateChanged: function(a, cb){ setTimeout(function(){ cb(auth.currentUser); }, 0); return function(){}; } },
    'firebase-database.js': db };
  window.__gstatic = function(url){ return Promise.resolve(mods[url.split('/').pop()]); };
})();`;
}

/* THE ONE DECLARED MASK LIST. A masked field is never just hidden: it must be PRESENT on every request of
   the named endpoints and pass its format/consistency check, or the capture throws. Only then is it
   replaced by a stable placeholder in the golden. Anything not listed here is pinned byte-for-byte. */
const HN_DATE = '261021';                                   // the fixed clock's Honduras date (YYMMDD)
export const MASKS = [
  { endpoints: /^(createOrder|chargeOnlineOrder)$/, path: ['body', 'order_id'], name: 'order_id',
    why: 'genOrderId(): PREFIX + Honduras date/time at the fixed clock + an 8-char CSPRNG suffix',
    check: (v) => typeof v === 'string' && new RegExp(`^PZX-${HN_DATE}-18\\d{4}-[0-9A-Z]{8}$`).test(v) },
  { endpoints: /^(createOrder|chargeOnlineOrder)$/, path: ['body', 'timestamp'], name: 'timestamp',
    why: 'new Date().toISOString() at the send, on the fixed clock (advances with real elapsed time)',
    check: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Date.parse(v) >= T0 && Date.parse(v) < T0 + 15 * 60000 },
  { endpoints: /^(createOrder|chargeOnlineOrder)$/, path: ['headers', 'Authorization'], name: 'order_secret',
    why: 'Bearer ORDER_SECRET: a constant in the public page, never written into a golden file',
    check: (v) => typeof v === 'string' && /^Bearer [0-9a-f]{64}$/.test(v) },
];

export const endpointOf = (url) => {
  const u = String(url);
  if (/\/getPublicMenu\/menu\/[a-z0-9_]+$/.test(u)) return 'getPublicMenu';
  const m = /\/(quoteOrder|createOrder|chargeOnlineOrder|quoteRedemption)$/.exec(u);
  if (m) return m[1];
  if (/\/restaurants\/[a-z0-9_]+\/item_availability\.json$/.test(u)) return 'item_availability';
  return null;
};

function maskOne(ep, req) {
  const out = JSON.parse(JSON.stringify(req));
  for (const m of MASKS) {
    if (!m.endpoints.test(ep)) continue;
    let o = out;
    for (const k of m.path.slice(0, -1)) o = o && o[k];
    const last = m.path[m.path.length - 1];
    if (!o || !Object.prototype.hasOwnProperty.call(o, last)) throw new Error(`capp mask ${m.name}: ${ep} carries no ${m.path.join('.')} — a mask never hides a MISSING field`);
    if (!m.check(o[last])) throw new Error(`capp mask ${m.name}: ${ep} ${m.path.join('.')} = ${m.name === 'order_secret' ? '<redacted>' : JSON.stringify(o[last])} fails its format check — a mask never hides a MALFORMED field`);
    o[last] = `<masked:${m.name}>`;
  }
  return out;
}

/* A cell's record: the endpoint sequence (consecutive repeats collapsed: the number of debounced quote
   refreshes is timing, not contract) and the LAST request each endpoint received, masked. Throws on a
   network escape or on any request this rig does not know. */
export function recordCell(w, sent) {
  if (w.__netEscapes.length) throw new Error(`capp: network escaped the fetch stub: ${w.__netEscapes.join(' | ')}`);
  const sequence = []; const requests = {};
  for (const s of sent) {
    const ep = endpointOf(s.url);
    if (!ep) throw new Error(`capp: an UNKNOWN request left the page: ${s.method} ${s.url}`);
    if (ep === 'getPublicMenu' || ep === 'item_availability') continue;
    if (sequence[sequence.length - 1] !== ep) sequence.push(ep);
    requests[ep] = maskOne(ep, { method: s.method, headers: s.headers, body: s.body });
  }
  return { sequence, requests };
}

/* Boot a page with the clock + trap, serve its catalog through the form's OWN live-menu feed, and record
   every request. Requests other than the menu never settle (the harness rule: page state stays exactly
   where the code under test left it). `answer(url, body)` may return a response for a specific request. */
export async function boot(dir, envelope, { transforms, answer, preamble } = {}) {
  const w = loadForm(dir, { preamble: preamble || PREAMBLE, ...(transforms ? { transforms } : {}) });
  const sent = [];
  w.__respond = (url, init) => {
    const u = String(url);
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ url: u, method: (init && init.method) || 'GET', headers: { ...((init && init.headers) || {}) }, body });
    if (u.includes('/menu/')) return res(envelope);
    const a = answer && answer(u, body);
    return a || new Promise(() => {});
  };
  await w.__liveMenu.feed.refresh();
  await settle();
  return { w, sent };
}
