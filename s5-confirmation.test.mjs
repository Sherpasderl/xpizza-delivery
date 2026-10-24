// PLAN-S5 §3 / §6 — the live "Pedido recibido" screen on the REAL pages (form-harness). Run: node s5-confirmation.test.mjs
// Only the network boundary is faked: the three gstatic Firebase modules (account.js's REAL ensureFirebase runs — its three
// dynamic imports are the one transform) and google.maps. form-live-status.js, status-view.js, showSuccess, the order-number
// line and the rewards card all execute as shipped. Long timers (≥ 30 s: deadlineTimer, etaTimer) are captured and fired by
// hand; everything else runs on real timers.
//   1  REAL submissions → one controller subscribed to order_tracking/<the createOrder token>; the window paints from the
//      snapshot + the public leaf; the WhatsApp note survives pending → number; delivery details / pickup card; Ayuda
//   2  hosted-card returns (fresh page, the real handlePaymentReturn): paid → a live screen on the paid token; scheduled_paid →
//      NO controller (the slot message + hidden number); closed_refunded / scheduled_review → no confirmation, no controller;
//      a foreign stash → the screen of the returning order only, no controller; S2's stash rules unchanged (B kept / A removed)
//   3  scheduled cash → start() never called (no subscription), the scheduled paint as the base golden
//   4  G2: the typed order_exists refusal → the recovery screen, ZERO controllers / subscriptions
//   5  lifecycle: "Hacer otro pedido" / pagehide / a second confirmation → unsubscribed, timers cleared; the OLD controller's
//      retained callbacks (snapshot, Directions result, deadline timer) fired by hand paint NOTHING on the new screen
//   6  boundaries: the SDK import rejected / delayed past a reset / never resolving; onValue's error callback; a throwing
//      snapshot handler (no unhandledrejection, no error); Maps never ready → the 12-min drive; a malformed Directions
//      response; ≤ 2 Directions per confirmation (placement + ready), none for pickup / after pickup
//   7  overdue: the deadlineTimer fires with NO new snapshot → the approved overdue copy; stop() clears it; a status change
//      re-arms it for the next stage
//   8  the anchor: created_at from the snapshot, stable across repeated snapshots
//   9  brands: X. Pizza, La Musa and a THIRD brand (X's page with its own coords, contact line and public leaf — no code
//      change): the map coords, the store label, Ayuda and Directions all come from that brand's own data
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { counter, settle, stageSettle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const { ok, count } = counter();
const WATCHDOG = setTimeout(() => { console.error('s5-confirmation: FAILED — watchdog'); process.exit(1); }, 600000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOK = 'TrkTok12345678', TOK2 = 'TrkTokSecond99';
const MIN = 60000;
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });

// ── the third brand: X's page, its own constants + contact line (no code change) ──
const THIRD = 'node_modules/.s5-third-brand';
{
  const src = readFileSync(new URL('./xpizza-orders/index.html', import.meta.url), 'utf8');
  const lat = src.match(/const RESTAURANT_LAT = ([0-9.-]+);/)[1], lng = src.match(/const RESTAURANT_LNG = ([0-9.-]+);/)[1];
  const out = src.replace(`const RESTAURANT_LAT = ${lat};`, 'const RESTAURANT_LAT = 14.0723;').replace(`const RESTAURANT_LNG = ${lng};`, 'const RESTAURANT_LNG = -87.1921;')
    .split('https://wa.me/50497952893').join('https://wa.me/50431112222');
  mkdirSync(new URL(`./${THIRD}/third-orders/`, import.meta.url), { recursive: true });
  writeFileSync(new URL(`./${THIRD}/third-orders/index.html`, import.meta.url), out);
  for (const f of ['form-live-status.js', 'status-view.js', 'form-order-number.js', 'form-order-exists.js', 'account.js']) writeFileSync(new URL(`./${THIRD}/third-orders/${f}`, import.meta.url), readFileSync(new URL(`./xpizza-orders/${f}`, import.meta.url)));
  // every other local script the page loads, from X's folder
  for (const m of out.matchAll(/<script src="(?!https?:)([^"]+)"><\/script>/g)) { try { writeFileSync(new URL(`./${THIRD}/third-orders/${m[1]}`, import.meta.url), readFileSync(new URL(`./xpizza-orders/${m[1]}`, import.meta.url))); } catch (_) {} }
}
process.on('exit', () => { try { rmSync(new URL(`./${THIRD}`, import.meta.url), { recursive: true, force: true }); } catch (_) {} });
const PAGES = {
  'xpizza-orders': { dir: 'xpizza-orders', rid: 'x_pizza', pub: { display_name: 'X. Pizza', branch_name: 'Los Próceres', prep_eta_min: 20 }, wa: '50497952893', menuRid: 'x_pizza' },
  'la-musa-orders': { dir: 'la-musa-orders', rid: 'la_musa', pub: { display_name: 'La Musa', branch_name: 'Colonia Palmira', prep_eta_min: 25 }, wa: '50493736607', menuRid: 'la_musa' },
  third: { dir: `${THIRD}/third-orders`, rid: 'r3_synth', pub: { display_name: 'Sushi Sur HN', branch_name: 'Lomas', prep_eta_min: 15 }, wa: '50431112222', menuRid: 'x_pizza', coords: { lat: 14.0723, lng: -87.1921 } },
};

// ── the boundary fakes ──
const GSTATIC = { 'account.js': (code) => {
  const re = /import\(`\$\{V\}\/(firebase-(?:app|auth|database)\.js)`\)/g;
  assert.strictEqual((code.match(re) || []).length, 3, 'premise: account.js imports exactly the three gstatic modules');
  return code.replace(re, 'window.__gstatic(`${V}/$1`)');
} };
function installFakes(w, P, opts = {}) {
  const F = { subs: [], gets: [], directions: [], tracking: {}, overlays: [], polylines: [], pub: opts.pub !== undefined ? opts.pub : P.pub, importMode: opts.importMode || 'ok', release: null };
  const db = {
    getDatabase: () => ({ fake: true }),
    ref: (_db, p) => ({ path: p }),
    onValue: (r, cb, err) => { const s = { path: r.path, cb, err, active: true }; F.subs.push(s); return () => { s.active = false; }; },
    get: async (r) => { F.gets.push(r.path); const m = /^restaurants\/([^/]+)\/public$/.exec(r.path); return { val: () => (m ? (m[1] === P.rid ? F.pub : null) : null) }; },
    update: async () => {},
  };
  const mods = { 'firebase-app.js': { initializeApp: () => ({}) }, 'firebase-auth.js': { getAuth: () => ({ currentUser: null }), setPersistence: async () => {}, browserLocalPersistence: {}, signInWithCustomToken: async () => ({}), signOut: async () => {} }, 'firebase-database.js': db };
  w.__gstatic = (url) => {
    const m = mods[url.split('/').pop()];
    if (F.importMode === 'reject') return Promise.reject(new Error('gstatic unreachable'));
    if (F.importMode === 'hold') return new Promise((r) => { const prev = F.release; F.release = () => { if (prev) prev(); r(m); }; });
    if (F.importMode === 'never') return new Promise(() => {});
    return Promise.resolve(m);
  };
  // long timers (≥ 30 s) are captured; the rest run for real
  const realST = w.setTimeout.bind(w), realCT = w.clearTimeout.bind(w); let seq = 1e7;
  F.long = new Map();
  w.setTimeout = (fn, ms, ...a) => { if (ms >= 30000) { const id = ++seq; F.long.set(id, { fn, ms, src: String(fn) }); return id; } return realST(fn, ms, ...a); };
  w.clearTimeout = (id) => { if (F.long.has(id)) { F.long.delete(id); return; } realCT(id); };
  F.timers = (kind) => [...F.long.values()].filter((t) => t.src.includes(`c.${kind} = null`));
  F.fire = (kind) => { const t = [...F.long.entries()].filter(([, x]) => x.src.includes(`c.${kind} = null`)); for (const [id, x] of t) { F.long.delete(id); x.fn(); } return t.length; };
  F.live = () => F.subs.filter((s) => s.active && s.path.startsWith('order_tracking/'));
  F.push = (rec, path) => { for (const s of F.subs.filter((x) => x.path === (path || `order_tracking/${TOK}`))) s.cb({ val: () => rec }); };
  if (opts.maps !== false && opts.maps !== 'later') installMaps(w, F);
  F.installMaps = () => installMaps(w, F);
  const errs = []; w.addEventListener('error', (e) => errs.push(String(e.message))); w.addEventListener('unhandledrejection', (e) => errs.push('unhandled: ' + String(e.reason && e.reason.message)));
  F.errs = errs;
  return F;
}
function installMaps(w, F) {
  function LatLng(lat, lng) { this.lat = () => lat; this.lng = () => lng; }
  function OverlayView() {}
  OverlayView.prototype.setMap = function (m) {
    this.map = m; this.attached = !!m; if (!F.overlays.includes(this)) F.overlays.push(this);
    if (m && this.onAdd) { this.getPanes = () => ({ overlayMouseTarget: w.document.getElementById('ls-map-canvas') }); this.getProjection = () => ({ fromLatLngToDivPixel: () => ({ x: 11, y: 22 }) }); this.onAdd(); if (this.draw) this.draw(); }
    if (!m && this.onRemove) this.onRemove();
  };
  function Polyline(o) { this.o = o; this.attached = true; F.polylines.push(this); }
  Polyline.prototype.setMap = function (m) { this.attached = !!m; };
  w.google = { maps: {
    Map: function (el, o) { this.el = el; this.o = o; this.fitBounds = () => {}; F.map = this; },
    OverlayView, LatLng, LatLngBounds: function () { this.extend = () => {}; }, Polyline,
    TravelMode: { DRIVING: 'DRIVING' },
    DirectionsService: function () { this.route = (req, cb) => { F.directions.push({ req, cb }); }; },
  } };
}
const plain = (x) => JSON.parse(JSON.stringify(x));   // page-realm objects → plain (deepStrictEqual compares prototypes)
const leg = (sec) => ({ routes: [{ legs: [{ duration_in_traffic: { value: sec }, duration: { value: sec + 60 } }] }] });

// ── a page + a REAL cash submit ──
async function page(key, opts = {}) {
  const P = PAGES[key];
  const w = loadForm(P.dir, { transforms: GSTATIC });
  const F = installFakes(w, P, opts);
  const sent = [];
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(P.menuRid, { dishes: [], extras: [] }));
    if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (url.includes('/order_tracking/')) return new Promise(() => {});
    if (url.includes('createOrder')) { const b = JSON.parse(init.body); sent.push(b); return opts.create ? opts.create(b) : res({ ok: true, order_id: b.order_id, tracking_token: opts.token || TOK }); }
    return new Promise(() => {});
  };
  if (opts.member) w.localStorage.setItem(P.dir.includes('musa') ? 'lamusa_acct' : 'xpizza_acct', JSON.stringify({ uid: 'u1', name: 'Ana', phone: '+50499990000' }));
  await settle();
  w.isOpen = () => true;   // the forms' hard-coded HOURS would disable ASAP outside the shop's hours (memory: xp-form-hardcoded-hours)
  return { w, F, P, sent };
}
async function cashSubmit(ctx, { pickup = false, at = { lat: 15.5102, lng: -88.0251 } } = {}) {
  const { w } = ctx;
  if (pickup) w.setOrderType('pickup');
  else w.eval(`lat = ${at.lat}; lng = ${at.lng}; isWithinDeliveryZone = true;`);
  const d = w.document.getElementById('address-detected'); if (d && !pickup) d.value = 'Col. Los Próceres, calle 4, casa 12';
  const dd = w.document.getElementById('address-details'); if (dd && !pickup) dd.value = 'Portón negro';
  const dish = w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && !x.variantOf && !w.itemIsLauncher(x));
  w.chg(dish.id, 1); w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), 'premise: the cart composes an order');
  const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
  for (let i = 0; i < 80 && !(ctx.sent.length && w.document.querySelector('#s5.stage.active')); i++) await wait(25);
  assert.ok(ctx.sent.length && w.document.querySelector('#s5.stage.active'), 'premise: the real cash send reached createOrder and the confirmation shows');
  await settle(); await wait(30); await settle();
}
const $ = (w, id) => w.document.getElementById(id);
// ADVISOR 2026-10-15 (S5 timers): the reviewed live timers (deadlineTimer, etaTimer) may change ONLY the declared live nodes — read
// from contract/timer-bounds.json (the single source the R3 journey blanks). steadyS5 = #s5 with exactly those nodes blanked.
const TBJ = JSON.parse(readFileSync(new URL('./xpizza-functions/contract/timer-bounds.json', import.meta.url), 'utf8'));
const LIVE_SELS = [...new Set([...TBJ.sites, ...TBJ.chains].filter((x) => /^xpizza-orders\/form-live-status\.js#/.test(x.key) && x.reachesAsserted === false).flatMap((x) => x.mayChangeSelectors || []))].sort();
assert.deepStrictEqual(LIVE_SELS, ['#ls-seg', '#ls-status', '#ls-store-label', '#success-sub'], 'premise: the declared live nodes');
const steadyS5 = (w) => { const c = w.document.getElementById('s5').cloneNode(true); for (const sel of LIVE_SELS) for (const e of c.querySelectorAll(sel)) e.textContent = ''; return c.innerHTML; };
const arrival = (w) => $(w, 'success-sub').textContent;
const statusLine = (w) => $(w, 'ls-status').textContent;
const FALLBACK = 'Te avisaremos por WhatsApp en cuanto tu pedido salga.';
const OVERDUE = 'Está tardando un poco más de lo normal. Te dejaremos saber por WhatsApp en cuanto salga.';

for (const key of Object.keys(PAGES)) {
  // ═══ 1. a real cash submit ═══
  {
    const ctx = await page(key); const { w, F, P } = ctx;
    await cashSubmit(ctx);
    assert.strictEqual(arrival(w), FALLBACK, `${key}: before the first snapshot → the static fallback, at once`);
    assert.deepStrictEqual(F.live().map((s) => s.path), [`order_tracking/${TOK}`], `${key}: ONE subscription, on THIS order's token (from the createOrder response)`);
    assert.ok(!JSON.stringify(ctx.sent[0]).includes(TOK), `${key}: the token never enters the order body`);
    const now = Date.now();
    F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN });
    await settle(); await wait(20);
    assert.deepStrictEqual(F.gets, [`restaurants/${P.rid}/public`], `${key}: the public leaf is read once, for the record's restaurant`);
    assert.ok(/^Llega \d{1,2}:\d\d – \d{1,2}:\d\d [ap]\. m\.$|^Llega \d{1,2}:\d\d [ap]\. m\. – \d{1,2}:\d\d [ap]\. m\.$/.test(arrival(w)), `${key}: the window paints (${arrival(w)})`);
    assert.strictEqual(statusLine(w), 'Estamos por empezar a preparar tu pedido');
    assert.strictEqual($(w, 'ls-seg').children.length, 5);
    assert.strictEqual($(w, 'ls-store-label').textContent, `${P.pub.display_name} · ${P.pub.branch_name}`);
    assert.strictEqual($(w, 'ls-receipt-store').textContent, `· ${P.pub.display_name}`);
    const det = $(w, 'ls-details'); assert.ok(!det.hidden && /Detalles de entrega/.test(det.textContent) && /Col\. Los Próceres/.test(det.textContent), `${key}: the delivery details card`);
    assert.strictEqual($(w, 'ls-help').getAttribute('href').split('?')[0], `https://wa.me/${P.wa}`, `${key}: Ayuda → the page's own contact line`);
    // Directions: one placement request, from THIS brand's store to the order's pin
    assert.strictEqual(F.directions.length, 1, `${key}: one placement Directions request`);
    const rq = F.directions[0].req; const store = P.coords || null;
    if (store) assert.deepStrictEqual(plain(rq.origin), store, 'third brand: its own coords');
    assert.deepStrictEqual(plain(rq.destination), { lat: 15.5102, lng: -88.0251 }); assert.strictEqual(rq.drivingOptions.trafficModel, 'bestguess');
    assert.ok(F.map && F.map.o.center.lat === rq.origin.lat, `${key}: the live map is drawn at the store`);
    const before = arrival(w);
    F.directions[0].cb(leg(25 * 60), 'OK'); await settle();
    assert.notStrictEqual(arrival(w), before, `${key}: the Directions drive moves the window (25 min vs the 12 fallback)`);
    // the WhatsApp note survives every number paint
    const num = () => w.document.querySelector('.ls-num').textContent.replace(/\s+/g, ' ').trim();
    assert.ok(/^Orden # asignando número… · Te avisamos por WhatsApp$/.test(num()), `${key}: pending + the note (${num()})`);
    w.paintOrderNumber('number', 47); assert.strictEqual(num(), 'Orden #47 · Te avisamos por WhatsApp');
    w.paintOrderNumber('hidden'); assert.ok($(w, 'order-id-display').textContent === '' && num() === '· Te avisamos por WhatsApp', `${key}: hidden → the note alone (its separator is CSS-hidden below)`);
    assert.strictEqual(w.getComputedStyle(w.document.querySelector('.ord-sep')).display, 'none', `${key}: the separator hides with the number`);
    assert.deepStrictEqual(F.errs, []);
    ok(`${key}: a REAL cash submit → the static fallback at once; ONE subscription on order_tracking/<createOrder token> (never in the body); the snapshot + the public leaf paint the window, segbar, status, store label; details card; Ayuda → wa.me/${P.wa}; one placement Directions request from the brand's store; the WhatsApp note survives pending / number / hidden`);

    // ═══ 6b. ≤ 2 Directions: the ready transition is the second (and last) ═══
    F.push({ status: 'preparing', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN }); await settle();
    assert.strictEqual(F.directions.length, 1, 'preparing → no request');
    F.push({ status: 'ready', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, ready_at: now - MIN }); await settle();
    assert.strictEqual(F.directions.length, 2, 'the ready transition → the second request');
    F.directions[1].cb({ routes: [] }, 'OK'); await settle();   // a malformed result → no throw, the window stays
    assert.ok(/^Llega /.test(arrival(w)), `${key}: a malformed Directions result keeps the window`);
    F.push({ status: 'ready', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, ready_at: now - MIN }); await settle();
    F.push({ status: 'preparing', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, ready_at: now - MIN }); await settle();   // a recall…
    F.push({ status: 'ready', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, ready_at: now }); await settle();               // …and ready again: a NEW transition, still no third request
    F.push({ status: 'out_for_delivery', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, ready_at: now - MIN, picked_up_at: now - 3 * MIN, driver_name: 'Carlos' }); await settle();
    assert.strictEqual(F.directions.length, 2, `${key}: never a third request (a repeat ready, a ready→preparing→ready recall, pickup)`);
    assert.strictEqual(arrival(w), 'Llega en ~22 min', `${key}: after pickup the timestamp ETA with the form's own drive: the ready request was malformed → the placement 25 min − 3 min since pickup`);
    assert.strictEqual(statusLine(w), 'Tu pedido va en camino', 'F4 (BC2 parity): the tracker\'s calm words — a name, no live location');
    assert.strictEqual(F.timers('etaTimer').length, 1, 'the etaTimer re-renders the countdown');
    { const before = steadyS5(w); assert.strictEqual(F.fire('etaTimer'), 1); await settle(); assert.strictEqual(steadyS5(w), before, `${key}: the etaTimer changed an #s5 node OUTSIDE the declared live set (ADVISOR 2026-10-15)`); assert.strictEqual(F.timers('etaTimer').length, 1, 'and re-arms'); }
    // DRIVER C (OWNER-APPROVED mockup, frame 6): the driver tapped «Llegué» — «{Nombre} llegó» in ls-status, «Ya está afuera con tu
    // pedido» in the arrival line (ls-window), never «En ruta a tu dirección» / an ETA; an arrival bound to another driver never shows
    {
      const ofd = { status: 'out_for_delivery', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, ready_at: now - MIN, picked_up_at: now - 3 * MIN, driver_name: 'Carlos', is_active_drop: true };
      F.push({ ...ofd, arrived: { at: now - MIN, owner_tag: 'tb_tag', name: 'Carlos' } }); await settle();
      assert.strictEqual(statusLine(w), 'Carlos llegó', `DRVC-FORM-STATUS ${key}: ls-status reads «Carlos llegó»`);
      assert.strictEqual(arrival(w), 'Ya está afuera con tu pedido', `DRVC-FORM-WINDOW ${key}: the arrival line reads the arrival copy, never an ETA`);
      assert.ok($(w, 'success-sub').classList.contains('ls-window'), `${key}: premise — the arrival line IS ls-window`);
      F.push({ ...ofd, driver_name: 'Ana', arrived: { at: now - MIN, owner_tag: 'tb_tag', name: 'Carlos' } }); await settle();
      assert.notStrictEqual(statusLine(w), 'Carlos llegó', `DRVC-FORM-MISMATCH ${key}: an arrival for another driver never shows`);
      assert.notStrictEqual(arrival(w), 'Ya está afuera con tu pedido', `DRVC-FORM-MISMATCH-WINDOW ${key}`);
      assert.deepStrictEqual(F.errs, []);
      ok(`${key}: arrived → ls-status «Carlos llegó», ls-window «Ya está afuera con tu pedido»; an arrival for another driver never shows`);
    }
    F.push({ status: 'delivered', order_type: 'delivery', restaurant_id: P.rid, created_at: now - 2 * MIN, delivered_at: now }); await settle();
    assert.strictEqual(arrival(w), 'Entregado'); assert.strictEqual(F.live().length, 0, `${key}: a terminal status unsubscribes`);
    assert.strictEqual(F.timers('etaTimer').length + F.timers('deadlineTimer').length, 0, 'and clears the timers');
    assert.deepStrictEqual(F.errs, []);
    ok(`${key}: ≤ 2 Directions per confirmation (placement + the ready transition; none on a repeat ready or after pickup); a malformed result keeps the window; after pickup the timestamp ETA + etaTimer; delivered → "Entregado", unsubscribed, timers cleared`);
    w.close();
  }
}

// ═══ 2. hosted-card returns (fresh page, the real handlePaymentReturn) — X. Pizza + La Musa ═══
const KEY = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
async function realStash(key, pick, token) {
  const ctx = await page(key, { maps: false }); const { w, P } = ctx;
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(P.menuRid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (url.includes('chargeOnlineOrder')) { const b = JSON.parse((init && init.body) || '{}'); return res({ ok: true, checkout_url: 'https://pay.test/checkout', order_id: b.order_id, poll_token: token }); }
    return new Promise(() => {});
  };
  w.eval('lat = 15.5102; lng = -88.0251; isWithinDeliveryZone = true;');
  const dishes = w.liveMenuGlobalGet('MENU').filter((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  for (const i of pick) { w.chg(dishes[i].id, 1); await settle(); }
  w.requestServerQuote(); await settle(); w.selectPay('online');
  assert.ok(w.buildOrder(), 'premise: the card cart composes');
  const pr = w.processPixelPay(); if (pr && pr.catch) pr.catch(() => {});
  for (let i = 0; i < 40 && !w.localStorage.getItem(KEY[key]); i++) await wait(25);
  const raw = w.localStorage.getItem(KEY[key]); assert.ok(raw, 'premise: the real checkout stashed the order');
  w.close(); return { raw, id: JSON.parse(raw).order_id, t: token };
}
async function returnPage(key, { url, stored, tokens, state }) {
  const P = PAGES[key];
  const w = loadForm(P.dir, { transforms: GSTATIC });
  const F = installFakes(w, P);
  w.__respond = (u) => {
    if (u.includes('/menu/')) return res(envelope(P.menuRid, { dishes: [], extras: [] }));
    if (u.includes('paymentStatus')) { const q = new URL(u).searchParams; const id = q.get('order_id'), t = q.get('t'); if (!id || !t || tokens[id] !== t) return json(403, { error: 'forbidden' }); return json(200, state(id)); }
    return new Promise(() => {});
  };
  await settle();
  w.history.replaceState({}, '', url);
  if (stored === null) w.localStorage.removeItem(KEY[key]); else w.localStorage.setItem(KEY[key], stored);
  await w.handlePaymentReturn(); await stageSettle(); await settle();
  return { w, F };
}
const BODY = (st, id) => (st === 'scheduled_paid' || st === 'scheduled_review'
  ? { ok: true, state: st, scheduled_for: '2026-10-20T19:00', tracking_token: null, order_id: id, total_cents: 31750 }
  : { ok: true, state: st, tracking_token: st === 'paid' ? 'PaidTok1234567' : null, order_id: id, total_cents: 31750 });
for (const key of ['xpizza-orders', 'la-musa-orders']) {
  const A = await realStash(key, [0], 'tokA_123456789'), B = await realStash(key, [1, 2], 'tokB_987654321');
  const tokens = { [A.id]: A.t, [B.id]: B.t };
  const complete = `/?pay=complete&order=${encodeURIComponent(A.id)}&t=${encodeURIComponent(A.t)}`;
  const cancel = `/?pay=cancel&order=${encodeURIComponent(A.id)}`;
  const s5on = (w) => !!w.document.querySelector('#s5.stage.active');
  { const r = await returnPage(key, { url: complete, stored: A.raw, tokens, state: (id) => BODY('paid', id) });
    assert.ok(s5on(r.w)); assert.deepStrictEqual(r.F.live().map((x) => x.path), ['order_tracking/PaidTok1234567'], `${key}: paid return → the live screen on the PAID token`);
    assert.strictEqual(r.w.localStorage.getItem(KEY[key]), null, `${key}: S2 — A's own stash removed`); r.w.close(); }
  { const r = await returnPage(key, { url: cancel, stored: A.raw, tokens, state: (id) => BODY('paid', id) });
    assert.ok(s5on(r.w)); assert.deepStrictEqual(r.F.live().map((x) => x.path), ['order_tracking/PaidTok1234567'], `${key}: the cancel-return URL that turns out paid → the live screen`); r.w.close(); }
  { const r = await returnPage(key, { url: complete, stored: A.raw, tokens, state: (id) => BODY('scheduled_paid', id) });
    assert.ok(s5on(r.w) && /programado/.test(arrival(r.w)), `${key}: scheduled_paid → the scheduled slot message`);
    assert.strictEqual(r.F.subs.filter((x) => x.path.startsWith('order_tracking/')).length, 0, `${key}: scheduled_paid → start() never subscribes`);
    assert.strictEqual($(r.w, 'order-id-display').style.display, 'none', 'the number hidden'); r.w.close(); }
  for (const st of ['closed_refunded', 'scheduled_review']) {
    const r = await returnPage(key, { url: complete, stored: A.raw, tokens, state: (id) => BODY(st, id) });
    assert.strictEqual(r.F.subs.filter((x) => x.path.startsWith('order_tracking/')).length, 0, `${key}: ${st} → no controller`); r.w.close();
  }
  { const r = await returnPage(key, { url: complete, stored: B.raw, tokens, state: (id) => BODY('paid', id) });   // a FOREIGN stash
    assert.strictEqual(r.F.subs.filter((x) => x.path.startsWith('order_tracking/')).length, 0, `${key}: foreign stash → A's screen as today, no controller`);
    assert.strictEqual(r.w.localStorage.getItem(KEY[key]), B.raw, `${key}: S2 — B byte-identical`); r.w.close(); }
  { const r = await returnPage(key, { url: complete, stored: null, tokens, state: (id) => BODY('paid', id) });   // a MISSING stash
    assert.strictEqual(r.F.subs.filter((x) => x.path.startsWith('order_tracking/')).length, 0, `${key}: missing stash → no controller`); r.w.close(); }
  ok(`${key}: hosted-card returns — paid (complete and cancel URLs) → the live screen on the PAID token; scheduled_paid → the slot message, hidden number, no subscription; closed_refunded / scheduled_review / a foreign or missing stash → no controller; S2's stash rules unchanged (A removed, B byte-identical)`);
}

for (const key of ['xpizza-orders', 'la-musa-orders', 'third']) {
  // ═══ 3. scheduled cash ═══
  {
    const ctx = await page(key, { create: (b) => res({ ok: true, scheduled: true, order_id: b.order_id, scheduled_for: b.scheduled_for, release_at: 1 }) });
    ctx.w.eval("window.__timeMode = 'schedule'; window.__scheduledFor = '2026-10-20T19:00';");   // the customer chose a slot (the scheduler's own globals)
    await cashSubmit(ctx);
    assert.strictEqual(ctx.sent[0].scheduled_for, '2026-10-20T19:00', 'premise: a scheduled order was sent');
    assert.strictEqual(ctx.F.subs.filter((x) => x.path.startsWith('order_tracking/')).length + ctx.F.gets.length, 0, `${key}: scheduled → no subscription, no public read`);
    assert.ok(/programado/.test(arrival(ctx.w)) && $(ctx.w, 'order-id-display').style.display === 'none', `${key}: the scheduled slot message + the hidden number`);
    assert.strictEqual(ctx.F.timers('deadlineTimer').length + ctx.F.timers('etaTimer').length, 0);
    ctx.w.close();
  }
  // ═══ 4. G2 ═══
  {
    const ctx = await page(key, { create: () => json(409, { error: 'order_exists' }) });
    const { w, F } = ctx; w.eval('lat = 15.5102; lng = -88.0251; isWithinDeliveryZone = true;');
    const dish = w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && !x.variantOf && !w.itemIsLauncher(x));
    w.chg(dish.id, 1); w.requestServerQuote(); await settle();
    const pr = w.submitOrder('confirmed'); if (pr && pr.catch) pr.catch(() => {});
    for (let i = 0; i < 80 && !ctx.sent.length; i++) await wait(25); await stageSettle(); await settle();
    assert.ok(!w.document.querySelector('#s5.stage.active') && w.document.querySelector('#s4.stage.active'), `${key}: premise — the G2 recovery screen (s4)`);
    assert.strictEqual(F.subs.filter((x) => x.path.startsWith('order_tracking/')).length, 0, `${key}: G2 → ZERO controllers / subscriptions`);
    w.close();
  }
  ok(`${key}: scheduled cash → start() never called (no subscription, no public read, no timer), the slot message + hidden number; the G2 typed refusal → the recovery screen with ZERO controllers`);

  // ═══ 5. lifecycle ═══
  {
    const ctx = await page(key); const { w, F, P } = ctx;
    await cashSubmit(ctx);
    const now = Date.now(); const rec = { status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: now };
    F.push(rec); await settle(); await wait(20);
    const oldSub = F.subs.find((x) => x.path === `order_tracking/${TOK}`); const oldDir = F.directions[0];
    const oldDeadline = [...F.long.values()].find((t) => t.src.includes('c.deadlineTimer = null'));
    assert.ok(oldSub && oldDir && oldDeadline, 'premise: the first controller holds a subscription, a Directions callback and a deadline');
    w.startAnotherOrder(); await settle();
    assert.strictEqual(F.live().length, 0, `${key}: "Hacer otro pedido" unsubscribes`);
    assert.strictEqual(F.timers('deadlineTimer').length + F.timers('etaTimer').length, 0, `${key}: …and clears the timers`);
    // the second order
    ctx.sent.length = 0; const second = { ...ctx }; w.__respond = ((orig) => (u, i) => (u.includes('createOrder') ? (ctx.sent.push(JSON.parse(i.body)), res({ ok: true, order_id: JSON.parse(i.body).order_id, tracking_token: TOK2 })) : orig(u, i)))(w.__respond);
    await cashSubmit(second);
    F.push({ status: 'preparing', order_type: 'delivery', restaurant_id: P.rid, created_at: now }, `order_tracking/${TOK2}`); await settle(); await wait(20);
    const painted = [arrival(w), statusLine(w), $(w, 'ls-seg').innerHTML];
    // the OLD controller's retained callbacks, fired by hand
    oldSub.cb({ val: () => ({ status: 'cancelled', order_type: 'delivery', restaurant_id: P.rid, created_at: now }) });
    oldSub.err && oldSub.err(new Error('late'));
    oldDir.cb(leg(60), 'OK');
    oldDeadline.fn();
    await settle();
    assert.deepStrictEqual([arrival(w), statusLine(w), $(w, 'ls-seg').innerHTML], painted, `${key}: the old controller's late snapshot / error / Directions / deadline paint NOTHING on the new screen`);
    assert.deepStrictEqual(F.live().map((x) => x.path), [`order_tracking/${TOK2}`]);
    // a second confirmation WITHOUT "Hacer otro pedido" replaces the controller
    w.eval(`__confirmTrackingToken = '${TOK}'; showSuccess();`); await settle(); await wait(20);
    assert.deepStrictEqual(F.live().map((x) => x.path), [`order_tracking/${TOK}`], `${key}: a second showSuccess replaces the controller`);
    // pagehide
    w.dispatchEvent(new w.Event('pagehide')); await settle();
    assert.strictEqual(F.live().length, 0, `${key}: pagehide unsubscribes`); assert.strictEqual(F.timers('deadlineTimer').length + F.timers('etaTimer').length, 0);
    assert.deepStrictEqual(F.errs, []);
    ok(`${key}: lifecycle — "Hacer otro pedido", a second showSuccess and pagehide each leave zero subscriptions and zero module timers; the old controller's retained snapshot / error / Directions / deadline callbacks paint nothing on the next order's screen`);
    w.close();
  }

  // ═══ 6. boundaries ═══
  {
    for (const mode of ['reject', 'never']) {
      const ctx = await page(key, { importMode: mode }); await cashSubmit(ctx); await wait(30);
      assert.strictEqual(arrival(ctx.w), FALLBACK, `${key}: SDK ${mode} → the fallback stays`);
      assert.strictEqual(ctx.F.live().length, 0); assert.deepStrictEqual(ctx.F.errs, [], `${key}: SDK ${mode} → no error, no unhandled rejection`);
      assert.ok(ctx.w.document.querySelector('#s5.stage.active') && $(ctx.w, 'acct-success-rewards').innerHTML, `${key}: the confirmation and rewards card are untouched`);
      ctx.w.close();
    }
    { // the import resolves AFTER a reset → no subscription, nothing paints
      const ctx = await page(key, { importMode: 'hold' }); await cashSubmit(ctx);
      ctx.w.startAnotherOrder(); await settle();
      const before = arrival(ctx.w);
      ctx.F.importMode = 'ok'; ctx.F.release && ctx.F.release(); await settle(); await wait(30);
      assert.strictEqual(ctx.F.subs.filter((x) => x.path.startsWith('order_tracking/')).length, 0, `${key}: an SDK that resolves after a reset subscribes to nothing`);
      assert.strictEqual(arrival(ctx.w), before); ctx.w.close();
    }
    { // onValue's error callback; a throwing snapshot handler
      const ctx = await page(key); await cashSubmit(ctx); const { w, F, P } = ctx;
      F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: Date.now() }); await settle(); await wait(20);
      assert.ok(/^Llega /.test(arrival(w)));
      F.subs.find((x) => x.path === `order_tracking/${TOK}`).err(new Error('permission_denied')); await settle();
      assert.strictEqual(arrival(w), FALLBACK, `${key}: onValue error → the fallback`);
      const bad = {}; Object.defineProperty(bad, 'status', { get() { throw new Error('boom'); } });
      F.subs.find((x) => x.path === `order_tracking/${TOK}`).cb({ val: () => bad }); await settle();
      assert.strictEqual(arrival(w), FALLBACK, `${key}: a throwing snapshot handler → the fallback`);
      assert.deepStrictEqual(F.errs, [], `${key}: …and nothing escapes (no error, no unhandledrejection)`);
      w.close();
    }
    { // Maps never ready → the 12-minute drive, after mapsWaitTimer (5 s)
      const ctx = await page(key, { maps: false }); await cashSubmit(ctx); const { w, F, P } = ctx;
      const A = Date.now() - 2 * MIN;
      F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: A }); await settle(); await wait(20);
      const FL = w.FormLiveStatus;
      const want = FL.windowFor({ stage: 'placement', anchorMs: A, prep: FL.prepFor(P.pub, A, Date.now()), driveMin: 12 });
      assert.strictEqual(arrival(w), `Llega ${FL.fmtRange(want.low, want.high)}`, `${key}: no Maps → the 12-min drive`);
      await wait(5400);
      assert.strictEqual(F.directions.length, 0); assert.strictEqual(arrival(w), `Llega ${FL.fmtRange(want.low, want.high)}`, `${key}: still the 12-min window after mapsWaitTimer gave up`);
      assert.ok(!$(w, 'ls-map').classList.contains('ls-map--live'), 'the illustrated layer stays');
      w.close();
    }
    ok(`${key}: boundaries — the SDK rejected / never resolving → the fallback, no error; resolving after a reset → no subscription; onValue's error callback and a throwing snapshot handler → the fallback with nothing escaping; Maps never ready → the 12-min drive and the illustrated map`);
  }

  // ═══ 7. overdue + 8. the anchor ═══
  {
    const ctx = await page(key); await cashSubmit(ctx); const { w, F, P } = ctx;
    const A = Date.now() - 10 * MIN;   // the window is still ahead for every brand (an already-passed window paints the overdue copy at once — by design)
    const rec = { status: 'preparing', order_type: 'delivery', restaurant_id: P.rid, created_at: A };
    F.push(rec); await settle(); await wait(20);
    const FL = w.FormLiveStatus;
    const at = (anchor, drive = 12) => { const x = FL.windowFor({ stage: 'placement', anchorMs: anchor, prep: FL.prepFor(P.pub, anchor, Date.now()), driveMin: drive }); return `Llega ${FL.fmtRange(x.low, x.high)}`; };
    assert.strictEqual(arrival(w), at(A), `${key}: the window is anchored at created_at`);
    assert.notStrictEqual(at(A), at(Date.now()), 'non-vacuity: an anchor at `now` would differ');
    F.push(rec); F.push(rec); await settle(); assert.strictEqual(arrival(w), at(A), `${key}: stable across repeated snapshots`);
    assert.strictEqual(F.timers('deadlineTimer').length, 1, 'one deadlineTimer');
    const steadyBefore = steadyS5(w);
    assert.strictEqual(F.fire('deadlineTimer'), 1); await settle();
    assert.strictEqual(steadyS5(w), steadyBefore, `${key}: the deadlineTimer changed an #s5 node OUTSIDE the declared live set (ADVISOR 2026-10-15)`);
    assert.strictEqual(arrival(w), OVERDUE, `${key}: the deadline passes with NO new snapshot → the overdue copy`);
    assert.strictEqual(statusLine(w), 'Te avisaremos cuando vaya en camino', 'the status line keeps the true status');
    // a status change → the next stage's window, re-armed
    F.push({ ...rec, status: 'ready', ready_at: Date.now() }); await settle();
    assert.ok(/^Llega /.test(arrival(w)), `${key}: the ready stage paints its own window`); assert.strictEqual(F.timers('deadlineTimer').length, 1, 're-armed');
    w.startAnotherOrder(); await settle();
    assert.strictEqual(F.timers('deadlineTimer').length, 0, `${key}: stop() clears the deadlineTimer`);
    ok(`${key}: overdue — the deadlineTimer fires with no new snapshot → "${OVERDUE.slice(0, 30)}…", the status line keeps the truth; a status change re-arms it for the ready window; stop() clears it. The anchor is created_at (≠ now), stable across repeated snapshots`);
    w.close();
  }

  // ═══ 8b. the daypart is frozen at the anchor (a pinned page clock just past the lunch → dinner boundary) ═══
  {
    const T = Date.UTC(2026, 9, 13, 16 + 6, 5), A = Date.UTC(2026, 9, 13, 15 + 6, 58);   // Tue 16:05 HN; placed 15:58 (lunch)
    const pub = { ...PAGES[key].pub, prep_stats: { weekday_lunch: { median_min: 10, p80_min: 20, n: 20 }, weekday_dinner: { median_min: 40, p80_min: 50, n: 20 }, updated_at: T - 3600000 } };
    const ctx = await page(key, { pub }); await cashSubmit(ctx); const { w, F, P } = ctx;
    w.Date.now = () => T;
    F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: A }); await settle(); await wait(20);
    assert.strictEqual(arrival(w), 'Llega 4:20 – 4:30 p. m.', `${key}: the LUNCH bucket of the anchor (15:58 + 10 + 12 → 16:20), never the dinner bucket of now (would be 4:50 – 5:00)`);
    ok(`${key}: the daypart is frozen at the anchor — placed 15:58 (lunch, median 10) and viewed 16:05 (dinner, median 40) → "Llega 4:20 – 4:30 p. m."`);
    w.close();
  }

  // ═══ 9. pickup + layout ═══
  {
    const ctx = await page(key); await cashSubmit(ctx, { pickup: true }); const { w, F, P } = ctx;
    F.push({ status: 'new', order_type: 'pickup', restaurant_id: P.rid, created_at: Date.now() }); await settle(); await wait(20);
    assert.ok(/^Listo para recoger \d/.test(arrival(w)), `${key}: pickup → "Listo para recoger <window>"`);
    assert.strictEqual(F.directions.length, 0, `${key}: pickup → no Directions request`);
    assert.strictEqual($(w, 'ls-seg').children.length, 3);
    assert.ok($(w, 'ls-map').classList.contains('ls-map--pickup'));
    const det = $(w, 'ls-details'); assert.ok(/Recoger en/.test(det.textContent) && $(w, 'ls-pickup-store').textContent === `${P.pub.display_name} · ${P.pub.branch_name}`, `${key}: the "Recoger en" card names the store from the public leaf`);
    const links = [...det.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    const ll = `${w.eval('RESTAURANT_LAT')},${w.eval('RESTAURANT_LNG')}`;
    assert.deepStrictEqual(links, [`https://www.google.com/maps/dir/?api=1&destination=${ll}`, `https://waze.com/ul?ll=${ll}&navigate=yes`], `${key}: "Cómo llegar" from the page's own coords`);
    F.push({ status: 'ready', order_type: 'pickup', restaurant_id: P.rid, created_at: Date.now() }); await settle();
    assert.strictEqual(arrival(w), 'Listo para recoger');
    // the layout order (the final mockup): window, number line, segbar, status, rewards, details, receipt, payment, again
    const order = ['success-sub', 'order-id-display', 'ls-seg', 'ls-status', 'acct-success-rewards', 'ls-details', 'receipt-toggle', 'receipt-payment'].map((id) => $(w, id));
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1].compareDocumentPosition(order[i]) & 4, `${key}: layout order ${order[i - 1].id} before ${order[i].id}`);
    assert.ok($(w, 'ls-map').compareDocumentPosition($(w, 'success-sub')) & 4, 'the map leads');
    assert.ok(w.document.body.classList.contains('s5-active'), 'the brand header hides on s5');
    w.startAnotherOrder(); await stageSettle();
    assert.ok(!w.document.body.classList.contains('s5-active'), 'and returns after');
    ok(`${key}: pickup → "Listo para recoger <window>", 3 segments, no Directions, "Recoger en <store>" + Cómo llegar (Maps · Waze) from the page's coords, ready → "Listo para recoger"; the layout order is the mockup's (map, window, number, segbar, status, rewards, details, receipt, payment); the header hides on s5 only`);
    w.close();
  }
}

// ═══ codex S5 build r1 — each reproduction, both brands + the third ═══
const legOnly = (sec) => ({ routes: [{ legs: [{ duration: { value: sec } }] }] });   // NO duration_in_traffic
for (const key of Object.keys(PAGES)) {
  // P1: a previous confirmation's live DOM never leaks into the next — cancelled delivery → another order → SCHEDULED pickup;
  //     and a live (new) delivery → another order → scheduled delivery
  for (const [prevStatus, nextPickup] of [['cancelled', true], ['new', false]]) {
    const ctx = await page(key); const { w, F, P } = ctx;
    await cashSubmit(ctx);
    F.push({ status: prevStatus, order_type: 'delivery', restaurant_id: P.rid, created_at: Date.now() }); await settle(); await wait(20);
    assert.ok($(w, 'ls-seg').children.length === 5 && $(w, 'ls-map').classList.contains('ls-map--live') && (prevStatus === 'cancelled' || !$(w, 'ls-store-label').hidden), 'premise — the first screen is live (segbar, map; the label once the public leaf lands — a cancelled first snapshot stops before it)');
    w.startAnotherOrder(); await stageSettle();
    ctx.sent.length = 0;
    w.__respond = ((orig) => (u, i) => (u.includes('createOrder') ? (ctx.sent.push(JSON.parse(i.body)), res({ ok: true, scheduled: true, order_id: JSON.parse(i.body).order_id, scheduled_for: JSON.parse(i.body).scheduled_for })) : orig(u, i)))(w.__respond);
    w.eval("window.__timeMode = 'schedule'; window.__scheduledFor = '2026-10-20T19:00';");
    await cashSubmit(ctx, { pickup: nextPickup });
    const s5t = $(w, 's5').textContent;
    assert.ok(/programado/.test(arrival(w)), `${key}: the scheduled slot message`);
    assert.ok(!/Si pagaste|Estamos por empezar|Recibimos tu pedido/.test(s5t), `🔴 ${key}: the previous order's status copy leaked into the scheduled screen ("${s5t.replace(/\s+/g, ' ').slice(0, 160)}")`);
    assert.strictEqual($(w, 'ls-seg').children.length, 0, `🔴 ${key}: the previous segbar leaked`);
    assert.strictEqual(statusLine(w), '', `🔴 ${key}: the previous status line leaked`);
    assert.ok($(w, 'ls-store-label').hidden && !$(w, 'ls-store-label').textContent, `🔴 ${key}: the previous store label leaked`);
    assert.ok(!$(w, 'ls-map').classList.contains('ls-map--live') && $(w, 'ls-map-canvas').children.length === 0, `🔴 ${key}: the previous live map leaked`);
    assert.strictEqual($(w, 'ls-map').classList.contains('ls-map--pickup'), nextPickup, `${key}: the map layout is THIS order's`);
    assert.ok(F.overlays.every((o) => !o.attached) && F.polylines.every((p) => !p.attached), `${key}: the previous map's overlays + polyline are detached`);
    w.close();
  }
  ok(`${key}: codex r1 P1 — a cancelled delivery → "Hacer otro pedido" → a scheduled pickup, and a live delivery → a scheduled delivery: no previous status copy, segbar, status line, store label or live map; the old overlays + polyline detached`);

  // P2-2: Maps loaded FIRST, the label arrives later → the VISIBLE overlay label shows it
  {
    const ctx = await page(key); const { w, F, P } = ctx; await cashSubmit(ctx);
    const ov = F.overlays.find((o) => o.node && o.node.querySelector('.ls-label'));
    assert.ok(ov && ov.node.querySelector('.ls-label').hidden, 'premise — the overlay was drawn before the label existed (hidden)');
    F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: Date.now() }); await settle(); await wait(20);
    const lab = ov.node.querySelector('.ls-label');
    assert.ok(!lab.hidden && lab.textContent === `${P.pub.display_name} · ${P.pub.branch_name}`, `🔴 ${key}: the live map's overlay label stays hidden (${lab.hidden} "${lab.textContent}")`);
    assert.ok($(w, 'ls-map-canvas').contains(lab), 'it is the overlay inside the live map (the illustrated label is hidden by ls-map--live)');
    w.close();
  }
  ok(`${key}: codex r1 P2-2 — Maps loaded first, the store label arriving later: the VISIBLE overlay label shows "<store> · <branch>"`);

  // P2-3: an out_for_delivery snapshot BEFORE Maps → no request when Maps arrives; a ready transition during an outstanding
  //       placement request → the ready request follows its completion
  {
    const ctx = await page(key, { maps: 'later' }); const { w, F, P } = ctx; await cashSubmit(ctx);
    F.push({ status: 'out_for_delivery', order_type: 'delivery', restaurant_id: P.rid, created_at: Date.now() - 30 * MIN, picked_up_at: Date.now() - 3 * MIN, driver_name: 'Carlos' }); await settle(); await wait(20);
    F.installMaps(); await wait(600); await settle();
    assert.ok(F.map, 'premise — Maps arrived and the map was drawn');
    assert.strictEqual(F.directions.length, 0, `🔴 ${key}: a Directions request was issued AFTER pickup (Maps arrived late)`);
    w.close();
  }
  {
    const ctx = await page(key); const { w, F, P } = ctx; await cashSubmit(ctx);
    const now = Date.now();
    F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: now }); await settle();
    assert.strictEqual(F.directions.length, 1, 'premise — the placement request is outstanding');
    F.push({ status: 'ready', order_type: 'delivery', restaurant_id: P.rid, created_at: now, ready_at: now }); await settle();
    assert.strictEqual(F.directions.length, 1, 'in flight → suppressed for now');
    F.directions[0].cb(leg(20 * 60), 'OK'); await settle();
    assert.strictEqual(F.directions.length, 2, `🔴 ${key}: the ready transition during an outstanding request was lost`);
    F.directions[1].cb(leg(15 * 60), 'OK'); await settle();
    F.push({ status: 'ready', order_type: 'delivery', restaurant_id: P.rid, created_at: now, ready_at: now }); await settle();
    assert.strictEqual(F.directions.length, 2, 'never a third');
    w.close();
  }
  ok(`${key}: codex r1 P2-3 — out_for_delivery before Maps → no request when Maps arrives; a ready transition while the placement request is outstanding → the ready request follows its completion (2 total, never 3)`);

  // P2-4: a successful answer with ONLY `duration` → the 12-min fallback stands (the approved contract)
  {
    const ctx = await page(key); const { w, F, P } = ctx; await cashSubmit(ctx);
    const A = Date.now() - MIN;
    F.push({ status: 'new', order_type: 'delivery', restaurant_id: P.rid, created_at: A }); await settle(); await wait(20);
    const FL = w.FormLiveStatus;
    const at12 = (() => { const x = FL.windowFor({ stage: 'placement', anchorMs: A, prep: FL.prepFor(P.pub, A, Date.now()), driveMin: 12 }); return `Llega ${FL.fmtRange(x.low, x.high)}`; })();
    assert.strictEqual(arrival(w), at12, 'premise — the 12-min window');
    F.directions[0].cb(legOnly(2 * 60), 'OK'); await settle();
    assert.strictEqual(arrival(w), at12, `🔴 ${key}: a duration-only answer (2 min) moved the window`);
    w.close();
  }
  ok(`${key}: codex r1 P2-4 — a Directions answer with only \`duration\` (no duration_in_traffic) keeps the 12-min window`);

  // P2-5: map resources are disposed on replacement / "Hacer otro pedido" / pagehide; a retained overlay callback is inert
  {
    const ctx = await page(key); const { w, F, P } = ctx; await cashSubmit(ctx);
    const live = () => [F.overlays.filter((o) => o.attached).length, F.polylines.filter((p) => p.attached).length];
    assert.deepStrictEqual(live(), [2, 1], 'premise — two overlays + the route attached');
    const old = F.overlays.slice();
    w.eval(`__confirmTrackingToken = '${TOK2}'; showSuccess();`); await settle();
    assert.ok(old.every((o) => !o.attached) && F.polylines.slice(0, 1).every((p) => !p.attached), `🔴 ${key}: a second confirmation left the old overlays / polyline attached`);
    const node = old[0].node; node.style.left = '-999px'; old[0].draw(); old[0].onAdd && old[0].onAdd();
    assert.strictEqual(node.style.left, '-999px', `🔴 ${key}: a retained overlay draw callback repositioned a disposed pin`);
    assert.deepStrictEqual(live(), [2, 1], 'the new confirmation has its own map');
    w.startAnotherOrder(); await stageSettle();
    assert.deepStrictEqual(live(), [0, 0], `🔴 ${key}: "Hacer otro pedido" left map resources attached`);
    ctx.sent.length = 0; await cashSubmit(ctx);   // a REAL second order (after "Hacer otro pedido" there is no current order)
    assert.deepStrictEqual(live(), [2, 1], 'premise — the new order has its map');
    w.dispatchEvent(new w.Event('pagehide')); await settle();
    assert.deepStrictEqual(live(), [0, 0], `🔴 ${key}: pagehide left map resources attached`);
    w.close();
  }
  ok(`${key}: codex r1 P2-5 — a second confirmation, "Hacer otro pedido" and pagehide each detach every overlay + the polyline (counted); a retained overlay draw / onAdd of the replaced map is inert`);
}
closeAll(); clearTimeout(WATCHDOG);
console.log(`\ns5-confirmation: OK (${count()})`);
