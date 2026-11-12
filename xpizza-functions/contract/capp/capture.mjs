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
//   • a fetch RECORDER installed over the harness stub BEFORE any page script, so a request made during
//     start-up is recorded like any other (window.__capAll); every recorded URL must be one this rig knows;
//   • a network trap: XMLHttpRequest / WebSocket / EventSource / sendBeacon record into
//     window.__netEscapes and throw. Every window a suite opens is checked for both.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadForm, settle, res } from '../../../form-harness.mjs';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const FN = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const T0 = Date.UTC(2026, 9, 22, 0, 0, 0);          // Wed 2026-10-21 18:00 America/Tegucigalpa
export const PLAN_ETAG = {                                // PLAN-shared-order-form.FINAL §10.3
  x_pizza: '"ce08dc10eb5ac354087f42e3b849999ffd3b912ba6ea2f4256b083dec7916098"',   // S2-core (§1.6 / R3): the served body carries extras_by_item {} when empty — was "80284300…12db2" (S1d)
  la_musa: '"27fae80408b4f08da43b0fdaf4837c31904abd8bd65c866c1c3406ad9693961a"',   // S2-core (R3): the public deny lists only extras inside each dish's offered groups — was "cea5849b…5b1e" (S1d)
};

export const PREAMBLE = `(function(){
  window.__capAll = [];
  var stub = window.fetch;
  window.fetch = function(url, init){
    var h = {}; try { if (init && init.headers) for (var k in init.headers) h[k] = String(init.headers[k]); } catch (_) {}
    window.__capAll.push({ url: String(url), method: (init && init.method) || 'GET', headers: h, body: init && typeof init.body === 'string' ? init.body : null });
    return stub.apply(this, arguments);
  };
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
  // the PUBLISHED catalog's pricing tables + reward allowlist (plan §10.3), for the reward server below
  const { getRestaurantMenu } = require(join(FN, 'catalog/catalog-menu'));
  const { buildTablesFromDocs } = require(join(FN, 'catalog/catalog-transform'));
  const { redeemEligibleFrom } = require(join(FN, 'catalog/menu-gates'));
  const built = await getRestaurantMenu(db, rid);
  return { rid, etag: m.etag, envelope: { rid: m.rid, representation_version: m.representation_version, menu: m.body },
    tables: { restaurantId: rid, ...buildTablesFromDocs(built.items, built.extras) }, eligible: redeemEligibleFrom(rid, built) };
}

/* THE REWARD SERVER: the real quoteRedemptionCore (rewards-redeem-intake.js) over the PUBLISHED catalog's tables
   and allowlist, against an in-memory RTDB provisioned with the account's balance, the global redemption flag
   and an empty 86 list. The caller is verified the way the handler verifies it: only the ID token this rig
   installs maps to a uid; anything else is a guest and the core refuses it (login_required). Quotes are issued
   by the real issuer under a TEST-ONLY secret, so the token the page receives is a real one. */
export const QUOTE_TEST_SECRET = 'capp-s0-test-only-quote-secret';
export function rewardServer(prov, balance) {
  const { quoteRedemptionCore } = require(join(FN, 'rewards-redeem-intake'));
  const { fakeRtdb } = require(join(FN, 'test/_fake-rtdb'));
  const rt = fakeRtdb({ config: { redemption_enabled: true }, user_rewards: { 'u-capp': { [prov.rid]: { balance, reserved: 0 } } }, restaurants: { [prov.rid]: { item_availability: {} } } });
  const db = { ref: (p) => { const r = rt.ref(p); return { ...r, get: r.once }; } };
  return async (body, headers) => {
    if (!process.env.QUOTE_TOKEN_SECRET) process.env.QUOTE_TOKEN_SECRET = QUOTE_TEST_SECRET;
    if (process.env.QUOTE_TOKEN_SECRET !== QUOTE_TEST_SECRET) throw new Error('capp: refusing to issue quotes under a non-test QUOTE_TOKEN_SECRET');
    const customerUid = headers['X-Firebase-ID-Token'] === 'test-id-token' ? 'u-capp' : null;
    const q = await quoteRedemptionCore(db, { redeem: body.redeem, items: body.items, restaurantId: prov.rid, customerUid, tables: prov.tables, eligible: prov.eligible });
    return q.ok ? { status: 200, json: q } : { status: q.status, json: { ok: false, ...q.body } };
  };
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

/* The rewards each brand runs TODAY, in the shape the page's own account module stores (plan §10.2), and the
   balance the account is provisioned with (enough for exactly that reward). */
export const REWARD = {
  punch: { payload: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, balance: 8 },
  points: { payload: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 2, name: 'Arroz Blanco' }] }, balance: 400 },
};
const reply = (status, json) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: () => Promise.resolve(json), text: () => Promise.resolve(JSON.stringify(json)) });

/* ONE CELL, driven through the page's own writers and UI handlers:
   cart = the first priced dish ×2 with the first extra its detail modal offers (a real delegated click);
   contact fields; order type; for delivery a pin 1–2 km from the restaurant (the page's own placePin);
   then the cell's variation; then the real send (submitOrder / processPixelPay). */
export async function driveCell(dir, prov, cell, { transforms } = {}) {
  const server = cell.reward ? rewardServer(prov, REWARD[cell.reward].balance) : null;
  const answer = (u, body, headers) => {
    if (/quoteRedemption$/.test(u)) {
      if (!server) throw new Error(`capp cell ${dir}/${cell.id}: a reward quote was requested by a cell with no reward`);
      return server(body || {}, headers).then((r) => reply(r.status, r.json));
    }
    return null;
  };
  /* A reward cell is a SIGNED-IN session: the account module's own customerIdToken() runs through the gstatic seam
     (the fake auth hands it the ID token the reward server verifies). cell.marker is the brand's account key. */
  const signedIn = cell.reward ? { transforms: { ...(transforms || {}), ...GSTATIC }, preamble: rewardsPreamble(cell.marker, { balance: REWARD[cell.reward].balance, reserved: 0 }) } : { transforms };
  const { w } = await boot(dir, prov.envelope, { ...signedIn, answer });
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
    if (w.__ACCOUNT.CONFIG.MARKER !== cell.marker) throw new Error(`capp cell ${dir}/${cell.id}: the signed-in marker ${cell.marker} is not this page's (${w.__ACCOUNT.CONFIG.MARKER})`);
    w.__ACCOUNT.restoreRedeem(REWARD[cell.reward].payload, null, null);
    await w.__ACCOUNT.requoteRedeem(w.redeemCartItems()); await settle();
  }
  w.selectPay(cell.card ? 'online' : 'cash'); await settle();
  if (w.buildOrder() !== true) throw new Error(`capp cell ${dir}/${cell.id}: the page refused to compose the order`);
  const pend = cell.card ? w.processPixelPay() : w.submitOrder('confirmed');
  if (pend && pend.catch) pend.catch(() => {});
  await settle(); await settle();
  return { w, dish, extra };
}

/* The cart every cell uses: the first priced dish ×2 and, when the catalog offers any, the first extra its
   detail modal shows, added by a real (delegated) click on instance 0. A catalog with no extras at all
   (the third brand publishes none) gets the dish alone; `extra` says which happened, and the real-brand
   suites assert it is true so the extras path is never silently skipped. */
export async function composeCart(w) {
  const doc = w.document;
  const priced = w.liveMenuGlobalGet('MENU').filter((x) => x.price > 0);
  if (!priced.length) throw new Error('capp: the served menu has no priced dish');
  // A catalog that publishes no extras cannot offer one: no search (each probe would add a quote request
  // that is this rig's artefact, not the page's contract).
  const offersExtras = (w.liveMenuGlobalGet('EXTRAS') || []).length > 0;
  for (const d of offersExtras ? priced : []) {
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

/* THE ONE DECLARED MASK LIST. A masked field is never just hidden: on every request it applies to it must be
   PRESENT and pass its format/consistency check, or the capture throws. Only then is it replaced by a stable
   placeholder, and the placeholder itself is pinned by the golden (so a field that disappears, or appears,
   is a golden difference). Anything not listed here is pinned byte-for-byte. `when` limits a mask to the
   requests that carry the field by contract (quote_token rides only a reward-quoted send). */
const HN_DATE = '261021';                                   // the fixed clock's Honduras date (YYMMDD)
const isSend = (ep) => ep === 'createOrder' || ep === 'chargeOnlineOrder';
export const MASKS = [
  { name: 'order_id', path: ['body', 'order_id'], applies: (ep) => isSend(ep),
    why: 'genOrderId(): PREFIX + Honduras date/time at the fixed clock + an 8-char CSPRNG suffix',
    check: (v) => typeof v === 'string' && new RegExp(`^[A-Z]{2,5}-${HN_DATE}-18\\d{4}-[0-9A-Z]{8}$`).test(v) },   // the prefix is DATA (§A3); each suite asserts its brand's
  { name: 'timestamp', path: ['body', 'timestamp'], applies: (ep) => isSend(ep),
    why: 'new Date().toISOString() at the send, on the fixed clock (advances with real elapsed time)',
    check: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Date.parse(v) >= T0 && Date.parse(v) < T0 + 15 * 60000 },
  { name: 'order_secret', path: ['headers', 'Authorization'], applies: (ep) => isSend(ep),
    why: 'Bearer ORDER_SECRET: a constant in the public page, never written into a golden file',
    check: (v) => typeof v === 'string' && /^Bearer [0-9a-f]{64}$/.test(v) },
  { name: 'quote_token', path: ['body', 'quote_token'], applies: (ep, req) => isSend(ep) && req.body && req.body.redeem != null,
    why: 'the reward quote token the real issuer signed (issued_at = the real clock); verified against the test secret',
    check: (v) => { const { verifyQuoteToken } = require(join(FN, 'quote-token')); const r = verifyQuoteToken(v, QUOTE_TEST_SECRET, Date.now());
      return !!(r && r.ok && r.payload && /^[a-z][a-z0-9_]*$/.test(r.payload.rid) && Number.isInteger(r.payload.net_total_cents)); } },
];

export const endpointOf = (url) => {
  const u = String(url);
  if (/^https:\/\/us-central1-xpizza-delivery\.cloudfunctions\.net\/getPublicMenu\/menu\/[a-z0-9_]+$/.test(u)) return 'getPublicMenu';
  const m = /^https:\/\/us-central1-xpizza-delivery\.cloudfunctions\.net\/(quoteOrder|createOrder|chargeOnlineOrder|quoteRedemption|paymentStatus|claimPrefill|claimOrder|reportClientVersion)$/.exec(u);
  if (m) return m[1];
  // the account module's endpoints (account.js CONFIG: Cloud Run hosts), query string allowed
  const a = /^https:\/\/(requestotp|verifyotp|deleteaccount|getsignupconfig|googlestart|googlesignin|completeprofile|setpromos)-m7syoovdsa-uc\.a\.run\.app(\?[^#]*)?$/.exec(u);
  if (a) return a[1];
  if (/^https:\/\/xpizza-delivery-default-rtdb\.firebaseio\.com\/restaurants\/[a-z0-9_]+\/item_availability\.json$/.test(u)) return 'item_availability';
  return null;
};

function maskOne(ep, req) {
  const out = JSON.parse(JSON.stringify(req));
  for (const m of MASKS) {
    if (!m.applies(ep, req)) continue;
    let o = out;
    for (const k of m.path.slice(0, -1)) o = o && o[k];
    const last = m.path[m.path.length - 1];
    if (!o || !Object.prototype.hasOwnProperty.call(o, last)) throw new Error(`capp mask ${m.name}: ${ep} carries no ${m.path.join('.')} — a mask never hides a MISSING field`);
    if (!m.check(o[last], req)) throw new Error(`capp mask ${m.name}: ${ep} ${m.path.join('.')} = ${m.name === 'order_secret' ? '<redacted>' : JSON.stringify(o[last])} fails its format check — a mask never hides a MALFORMED field`);
    o[last] = `<masked:${m.name}>`;
  }
  return out;
}

/* Every request the window made, from the recorder installed BEFORE its first script. Throws on a network
   escape or on any request this rig does not know. Returns the raw list (bodies parsed) for leak checks. */
export function netCheck(w) {
  if (!Array.isArray(w.__capAll)) throw new Error('capp: the fetch recorder is not installed (boot through capture.mjs preambles)');
  if (w.__netEscapes.length) throw new Error(`capp: network escaped the fetch stub: ${w.__netEscapes.join(' | ')}`);
  return Array.from(w.__capAll, (r) => {
    const ep = endpointOf(r.url);
    if (!ep) throw new Error(`capp: an UNKNOWN request left the page: ${r.method} ${r.url}`);
    let body = r.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { /* kept as the raw string */ } }
    return { endpoint: ep, url: r.url, method: r.method, headers: { ...r.headers }, body, rawBody: r.body };
  });
}

/* A cell's record: EVERY request in order (masked), collapsing only a request byte-identical to the one
   right before it (the number of identical debounced quote refreshes is timing, not contract). Distinct
   payloads to the same endpoint are all kept. The menu and availability reads are inputs, not output. */
export function recordCell(w) {
  const all = netCheck(w);
  const requests = [];
  for (const r of all) {
    if (r.endpoint === 'getPublicMenu' || r.endpoint === 'item_availability') continue;
    const m = { endpoint: r.endpoint, ...maskOne(r.endpoint, { method: r.method, headers: r.headers, body: r.body }) };
    const prev = requests[requests.length - 1];
    if (prev && JSON.stringify(prev) === JSON.stringify(m)) continue;
    requests.push(m);
  }
  return { requests, raw: all };
}
export const lastOf = (rec, ep) => { for (let i = rec.requests.length - 1; i >= 0; i--) if (rec.requests[i].endpoint === ep) return rec.requests[i]; return null; };

/* Boot a page with the clock, recorder and trap; serve its catalog through the form's OWN live-menu feed.
   Requests other than the menu never settle (the harness rule: page state stays exactly where the code
   under test left it). `answer(url, body, headers)` may return a response for a specific request. */
export async function boot(dir, envelope, { transforms, answer, preamble } = {}) {
  const w = loadForm(dir, { preamble: preamble || PREAMBLE, ...(transforms ? { transforms } : {}) });
  w.__respond = (url, init) => {
    const u = String(url);
    if (u.includes('/menu/')) return res(envelope);
    let body = null; try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (_) {}
    const h = {}; try { if (init && init.headers) for (const k of Object.keys(init.headers)) h[k] = String(init.headers[k]); } catch (_) {}
    const a = answer && answer(u, body, h);
    return a || new Promise(() => {});
  };
  await w.__liveMenu.feed.refresh();
  await settle();
  return { w };
}
