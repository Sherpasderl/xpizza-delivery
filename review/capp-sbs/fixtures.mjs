// The side-by-side harness's network: EVERY request that leaves 127.0.0.1 is answered here, from committed sources only, or it is
// UNMAPPED (null ⇒ the run fails). The bodies are the real servers' shapes:
//   · the directory  — customer-app/fixtures/s7a2/directory.json (the committed s7a2 fixture, scenario «complete»), served at the ONE
//                      injected `directory_endpoint` (advisor ruling (A), 11-02: production has no directory endpoint yet — a launch
//                      gap routed to 3a; the review page states the injection on every frame);
//   · the menus      — the committed provisioner (xpizza-functions/contract/capp/capture.mjs provisionBrand: the real publish, seeded),
//                      served as getPublicMenu sends them (/getPublicMenu/menu/<rid>, an ETag);
//   · availability   — the RTDB item_availability node (none sold, unless a scene says which), WRITTEN by the real KDS writer
//                      (xpizza-kitchen/xpizza-delivery.js setItemAvailability, firebase stubbed as avail-write.test.mjs does);
//   · getSignupConfig / quoteOrder — the shapes the capp suites fake from the real contracts (capp-signup.test, capp-s7a2 quoteOk);
//   · Google Maps    — 503 (the app's own fallback: the schematic map, which is what the mockups draw).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as SDKF from '../../customer-app/test/fake-sdk-checkout.mjs';
import * as PAYF from '../../customer-app/test/fake-sdk-pay.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// the harness's injected runtime field (ruling (A)) — mirrors 3a's APPROVED contract: GET …/getRestaurantDirectory, no query; ETag /
// If-None-Match ⇒ 304; Cache-Control max-age=30 when complete (a partial body: 200 no-store); 503 retryable; the directory-2 envelope
export const DIRECTORY_ENDPOINT = 'getRestaurantDirectory';
// The s7a2 fixture's images live on a placeholder host (assets.sherpa.test) the PACKAGED CSP blocks (img-src 'self' data: maps +
// storage.googleapis.com), so no photo was ever requested. The harness serves the same paths under the CSP's photo host, from
// committed files: the dish photos (xpizza-orders/images/*) and both heroes. No restaurant logo file is committed ⇒ a 404 (stated).
const ASSET_HOST = 'https://assets.sherpa.test/', ASSET_SBS = 'https://storage.googleapis.com/sbs-fixture-assets/';
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'customer-app/fixtures/s7a2/directory.json'), 'utf8').split(ASSET_HOST).join(ASSET_SBS));
const ASSET_FILES = { 'img/xp-hero.jpg': 'xpizza-orders/hero.jpg', 'img/lm-hero.jpg': 'la-musa-orders/hero.jpg' };
const IMG_TYPES = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };
// F1/F2: the public menu's `photos` are on each brand's ORDER SITE (public-photos assetBaseFor). Served from that deployment's
// committed folder, mapped by the manifest (never a host literal); images/ only.
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/sites.json'), 'utf8'));
const ORDER_SITES = new Map(SITES.deployments.filter((d) => d.app === 'orders' && d.context !== 'platform' && Array.isArray(d.origins) && d.origins.length === 1).map((d) => [d.origins[0], d.folder]));
function orderSiteFile(origin, p) {
  const folder = ORDER_SITES.get(origin), rel = decodeURIComponent(p).replace(/^\//, '');
  if (!folder || !/^images\/[A-Za-z0-9_.-]+\.(jpg|webp|png)$/.test(rel) || !fs.existsSync(path.join(ROOT, folder, rel))) return { status: 404, body: '', type: 'text/plain' };
  return { status: 200, body: fs.readFileSync(path.join(ROOT, folder, rel)), type: IMG_TYPES[path.extname(rel)] };
}
function assetFile(rest) {
  const rel = ASSET_FILES[rest] || (/^xpizza-orders\/images\/[A-Za-z0-9_.-]+\.(jpg|webp|png)$/.test(rest) ? rest : null);
  if (!rel || !fs.existsSync(path.join(ROOT, rel))) return { status: 404, body: '', type: 'text/plain' };
  return { status: 200, body: fs.readFileSync(path.join(ROOT, rel)), type: IMG_TYPES[path.extname(rel)] };
}
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
const { provisionBrand } = await import(path.join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const PROV = {};
for (const rid of ['x_pizza', 'la_musa']) PROV[rid] = await quiet(() => provisionBrand(rid));

// the sold node from the REAL KDS writer: its one update() is captured and the item_availability records kept, the server timestamp
// resolved to a number (what RTDB stores). Never hand-placed: a hand-built {key: false} reads as AVAILABLE at every reader.
export async function kdsSoldNode(rid, raws) {
  const KITCHEN = path.join(ROOT, 'xpizza-kitchen'), writes = [];
  globalThis.__fbWrites = writes; globalThis.__fbTS = NOW_PIN - 3600e3;
  const stub = ['initializeApp', 'getAuth', 'getDatabase', 'onValue', 'query', 'orderByChild', 'equalTo', 'set', 'get', 'remove', 'runTransaction', 'off',
    'signInWithEmailAndPassword', 'signOut', 'onAuthStateChanged'].map((f) => `export function ${f}() { return Promise.resolve({ val: () => null, exists: () => false }); }`).join('\n')
    + '\nexport function ref(_d, p) { return { path: p == null ? "" : p }; }'
    + '\nexport function update(r, o) { globalThis.__fbWrites.push({ scope: r.path, payload: o }); return Promise.resolve(); }'
    + '\nexport function serverTimestamp() { return globalThis.__fbTS; }';
  const stubUrl = ('data:text/javascript,' + encodeURIComponent(stub)).replace(/'/g, '%27');
  await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(KITCHEN, 'avail-key.js'), 'utf8')));
  if (!globalThis.location) globalThis.location = { hostname: 'xpizza-kitchen.example' };
  const sdk = fs.readFileSync(path.join(KITCHEN, 'xpizza-delivery.js'), 'utf8')
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|auth|database)\.js/g, stubUrl)
    .replace(/from '\.\/([a-z-]+\.js)'/g, (_, f) => `from '${new URL(f, 'file://' + KITCHEN + '/').href}'`);
  const XPD = await import('data:text/javascript,' + encodeURIComponent(sdk));
  XPD.initDelivery({});
  for (const raw of raws) await XPD.setItemAvailability(rid, raw, false, 'sbs-kds');
  const pre = `restaurants/${rid}/item_availability/`, node = {};
  for (const w of writes) for (const [k, v] of Object.entries(w.payload)) if (k.startsWith(pre)) node[k.slice(pre.length)] = v;
  if (Object.keys(node).length !== raws.length) throw new Error(`kdsSoldNode: the KDS writer wrote ${Object.keys(node).length} of ${raws.length}`);
  return node;
}

const json = (body, status = 200, headers = []) => ({ status, body, type: 'application/json', headers });

// quoteOrder from the REAL pieces the handler composes (index.js quoteOrder; Codex r1 P2-6: the old fake trusted client subtotals and
// always priced a delivery): the food = computeServerTotal over the PUBLISHED catalog's tables (provisionBrand) → orderBreakdownCents,
// an unknown item → the handler's 200 {ok:false, error:'bad_cart'}; the envío = delivery-wire quoteDeliveryFor itself (mode, pin,
// coverage, member promo, refusals) over a pricing config matching the s7a2 directory (from L 45; x_pizza free for members; each
// identity's hub + radius = the directory row's hub / coverage_km). Only the I/O is stubbed: the config read, the identity read, and
// the ID-token check (the harness's member token → u_ana, anything else a guest — as getAuth refuses a foreign token). The signed-quote
// fields come from the REAL issuer (quote-issue.js issueQuote, as the handler calls it): with no QUOTE_TOKEN_SECRET in the harness it
// takes its own fallback — net_total_cents, quote_token null (omitted, as the handler spreads only a truthy token). Not the rate
// limit, extras gate or redemption path.
const FN = path.join(ROOT, 'xpizza-functions'), freq = createRequire(path.join(FN, 'index.js'));
const { computeServerTotal } = freq('./menu-pricing.js'), { orderBreakdownCents } = freq('./order-money.js'), { issueQuote } = freq('./quote-issue.js'), DW = freq('./delivery/delivery-wire.js'), DP = freq('./delivery/delivery-pricing.js');
const ROWS = Object.fromEntries(FX.scenarios.complete.body.restaurants.map((r) => [r.restaurant_id, r]));
const PRICING_RAW = { policy_version: 1, bands: [{ max_km: 4, cents: 4500 }, { max_km: 10, cents: 6500 }],
  restaurants: Object.fromEntries(Object.values(ROWS).map((r) => [r.restaurant_id, { active: true, free_delivery: !!(r.promo && r.promo.free_delivery) }])) };
async function quoteOrder(req) {
  let body; try { body = JSON.parse(req.postData || ''); } catch (_) { return json({ ok: false, error: 'bad_request' }, 400); }
  const rid = body && body.restaurant_id, prov = PROV[rid], row = ROWS[rid];
  if (!prov || !row) return json({ ok: false, error: 'bad_request', detail: 'restaurant_id' }, 400);
  const { total, error } = computeServerTotal(body.items, rid, prov.tables);
  if (error) return json({ ok: false, error: 'bad_cart' });
  const bd = orderBreakdownCents(total, rid);
  const tok = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === 'x-firebase-id-token');
  const dq = await DW.quoteDeliveryFor({ get: (h) => (h.toLowerCase() === 'x-firebase-id-token' && tok ? tok[1] : undefined) },
    { ref: () => ({ get: async () => ({ exists: () => false, val: () => null }) }) }, rid, body, {
      pricingP: Promise.resolve({ pricing: DP.readPricing(PRICING_RAW, rid) }),
      getIdentity: async () => ({ hub_lat: row.hub_lat, hub_lng: row.hub_lng, delivery_radius_km: row.coverage_km }),
      getAuth: () => ({ verifyIdToken: async (t) => { if (t !== MEMBER_TOKEN) throw new Error('foreign token'); return { uid: 'u_ana', customer: true }; } }),
      attributionUid: (dec, deleted) => (deleted ? null : dec.uid) });
  if (dq.refuse) return json(dq.refuse, dq.httpStatus || 200);
  if (process.env.QUOTE_TOKEN_SECRET) throw new Error('the harness runs the issuer\'s unsigned fallback — unset QUOTE_TOKEN_SECRET');
  const issued = issueQuote({ items: body.items, reward: null, rid, tables: prov.tables, deliveryContext: dq.ctx, customerId: dq.uid, nowMs: Date.now() });
  return json({ ok: true, total_cents: bd.total_cents, subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents,
    ...(issued.ok ? { net_total_cents: issued.net_total_cents } : {}), ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}), ...DW.quoteFields(dq.ctx) });
}
// opts: { directory: 'complete' | <scenario>, sold: { rid: <item_availability node from kdsSoldNode> }, quote: true }
export function router(opts = {}) {
  const scen = FX.scenarios[opts.directory || 'complete'];
  return (req) => {
    const u = new URL(req.url), p = u.pathname, host = u.host;
    if (host.endsWith('cloudfunctions.net')) {
      if (req.method === 'OPTIONS') {   // the CORS preflight every function answers (cors: an exact origin list) — echoes what was asked
        const ask = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === 'access-control-request-headers');
        return { status: 204, body: '', type: 'text/plain', headers: [{ name: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' }, { name: 'Access-Control-Allow-Headers', value: ask ? ask[1] : 'content-type' }, { name: 'Vary', value: 'Origin' }] };
      }
      if (p.endsWith(`/${DIRECTORY_ENDPOINT}`)) {
        if (req.method !== 'GET' || u.search) return null;   // the contract: GET, no query — anything else is unmapped (fails the run)
        const etag = scen.headers && scen.headers.ETag, inm = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === 'if-none-match');
        if (etag && inm && inm[1] === etag) return { status: 304, body: '', type: 'application/json', headers: [{ name: 'ETag', value: etag }] };
        const complete = !(scen.body && scen.body.partial === true);
        return json(scen.body, scen.status, [...(etag ? [{ name: 'ETag', value: etag }] : []), { name: 'Cache-Control', value: complete ? 'public, max-age=30' : 'no-store' }]);
      }
      const m = p.match(/\/getPublicMenu\/menu\/([a-z0-9_-]+)$/);
      if (m) { const pv = PROV[m[1]]; return pv ? json(pv.envelope, 200, [{ name: 'ETag', value: pv.etag }]) : json({ ok: false }, 404); }
      // the client-version heartbeat (main's P-SELFUPDATE telemetry): its accepted answer is 204, no body (client-version.js handleReport)
      if (p.endsWith('/reportClientVersion') && req.method === 'POST') return { status: 204, body: '', type: 'text/plain' };
      if (p.endsWith('/getSignupConfig')) return json({ ok: true, terms_url: 'https://legal.sherpa.test/terminos', privacy_url: 'https://legal.sherpa.test/privacidad', legal_ready: true, google_enabled: false });
      if (p.endsWith('/quoteOrder') && req.method === 'POST' && opts.quote !== false) return opts.quoteDelay ? quoteOrder(req).then((r) => ({ ...r, delay: opts.quoteDelay })) : quoteOrder(req);   // quoteDelay: the pre-quote state (S2ck-1q)
      if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
      return null;
    }
    if (host.endsWith('firebaseio.com')) {
      const m = p.match(/\/restaurants\/([a-z0-9_-]+)\/item_availability\.json$/);
      if (m) return json((opts.sold || {})[m[1]] || null);
      if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
      return null;
    }
    if (ORDER_SITES.has(u.origin)) return orderSiteFile(u.origin, p);
    if (req.url.startsWith(ASSET_SBS)) return assetFile(decodeURIComponent(req.url.slice(ASSET_SBS.length).split('?')[0]));
    if (host === 'maps.googleapis.com') return { status: 503, body: '', type: 'text/javascript' };
    if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
    return null;
  };
}
export { PROV };

// ── a restored MEMBER (Ana) ──
// The packaged app restores a member from (a) the Firebase SDK's browserLocalPersistence record (under the capp's own app name) and (b) the capp's own completion
// marker + device profile. MEMBER_SEED writes both on the app's origin BEFORE it boots: (b) through the REAL writer
// (CappDeviceAccount, loaded from the bundle itself), (a) as the SDK persists a signed-in user (its access token unexpired, so the
// SDK needs no refresh; a lookup / refresh still answers from here). The orders and ratings are the getMyOrders / getMyRating
// contracts' shapes (NOTE-getMyOrders §3, its receipt mode; 3a's my-rating bodies), with times relative to NOW.
// NOW is PINNED: every real-app page runs the CLOCK_SHIM (sbs.mjs openPage), so «open now», the schedule, the token expiry and the
// relative order times are the same on every run — Saturday 2026-11-07 18:30 at UTC−6: both restaurants open (12:00–20:45 and
// 17:00–21:45 in the s7a2 directory), the 60-min lead inside the close. On the wall clock a 01:53 run painted «Cerrado · Abre hoy 12:00 p.m.» and the disabled «Lo antes posible» where every mockup draws an open store.
export const NOW_PIN = Date.UTC(2026, 10, 8, 0, 30);
const T0 = Date.now(), nowMs = () => NOW_PIN + (Date.now() - T0);
export const CLOCK_SHIM = `(() => { const D = Date, off = ${NOW_PIN} - D.now();
  function P(...a) { if (!new.target) return new D(D.now() + off).toString(); return a.length ? new D(...a) : new D(D.now() + off); }
  P.prototype = D.prototype; P.now = () => D.now() + off; P.UTC = D.UTC; P.parse = D.parse; self.Date = P; })();`;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const memberToken = () => MEMBER_TOKEN;
const mintMemberToken = () => { const now = Math.floor(nowMs() / 1000);
  return `${b64u({ alg: 'RS256', kid: 'sbs', typ: 'JWT' })}.${b64u({ iss: 'https://securetoken.google.com/xpizza-delivery', aud: 'xpizza-delivery', auth_time: now - 60, user_id: 'u_ana', sub: 'u_ana', iat: now - 60, exp: now + 3600, customer: true, firebase: { identities: {}, sign_in_provider: 'custom' } })}.sig`; };
const MEMBER_TOKEN = mintMemberToken();   // ONE token per run: the seed installs it, the quote's getAuth stub recognizes it
export const MEMBER_SEED = () => `(async () => {
  const load = (src) => new Promise((r, j) => { const s = document.createElement('script'); s.src = src; s.onload = r; s.onerror = j; document.head.appendChild(s); });
  await load('/capp-runtime.js'); await load('/capp-device-account.js');
  localStorage.clear();
  localStorage.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_ana' }));
  CappDeviceAccount.remember(localStorage, '+50496123344');
  CappDeviceAccount.rememberProfile(localStorage, { uid: 'u_ana', name: 'Ana Pérez', phone: '+50496123344', email: 'ana.perez@gmail.com', promos: true });
  const rt = self.CAPP_RUNTIME, now = Date.now();
  // the SDK keys a persisted user by the APP name: the capp's adapter initializes its own app 'capp' (capp-auth-firebase.js), never [DEFAULT]
  localStorage.setItem('firebase:authUser:' + rt.firebase.apiKey + ':capp', JSON.stringify({ uid: 'u_ana', email: 'ana.perez@gmail.com', emailVerified: true, isAnonymous: false, providerData: [],
    stsTokenManager: { refreshToken: 'sbs-refresh', accessToken: ${JSON.stringify(memberToken())}, expirationTime: now + 3600e3 }, createdAt: '1', lastLoginAt: String(now), apiKey: rt.firebase.apiKey, appName: 'capp' }));
  return true;
})()`;
export const dishId = (rid, name) => { const d = PROV[rid].envelope.menu.dishes.find((x) => x.name === name); return d ? String(d.dish_id) : null; };
export function memberRows() {
  const now = nowMs(), h = 3600e3;
  const xpA = dishId('x_pizza', 'Margherita'), xpB = dishId('x_pizza', 'Crispy Bacon'), lmA = PROV.la_musa.envelope.menu.dishes[0];
  return [
    { order_id: 'XPZ261102-RATE01', ts: now - 2 * h, total: 615, order_type: 'delivery', restaurant: 'x_pizza', status: 'delivered', display_number: 4821,
      items_text: '1x Margherita (L250) | 1x Crispy Bacon (L320)', items: [{ dish_id: xpA, qty: 1, options: [] }, { dish_id: xpB, qty: 1, options: [] }] },
    { order_id: 'LMS261030-DONE02', ts: now - 3 * 24 * h, total: 515, order_type: 'pickup', restaurant: 'la_musa', status: 'completed', display_number: 4790,
      items_text: `1x ${lmA.name} (L${lmA.price})`, items: [{ dish_id: String(lmA.dish_id), qty: 1, options: [] }] },
    { order_id: 'XPZ261023-OLD003', ts: now - 10 * 24 * h, total: 1029, order_type: 'delivery', restaurant: 'x_pizza', status: 'delivered', display_number: 4602,
      items_text: '2x Margherita (L250)', items: [{ dish_id: xpA, qty: 2, options: [] }] },
  ];
}
const RECEIPT = (row) => ({ order_id: row.order_id, display_number: row.display_number, ts: row.ts, restaurant: row.restaurant, order_type: row.order_type, status: row.status,
  lines: row.items_text.split(' | ').map((t) => { const m = t.match(/^(\d+)x (.+) \(L(\d+)\)$/); return { qty: +m[1], description: m[2], line_cents: +m[1] * +m[3] * 100 }; }),
  items_text: row.items_text, totals: { subtotal_cents: Math.round(row.total * 100) - (row.order_type === 'delivery' ? 4500 : 0), ...(row.order_type === 'delivery' ? { delivery_cents: 4500 } : {}), total_cents: Math.round(row.total * 100) },
  tender: { method: 'cash', cash_tendered_cents: 100000 }, ...(row.order_type === 'delivery' ? { address: { detected: 'Col. Trejo, 12 calle', details: 'Portón negro, segunda casa', area: 'Trejo' } } : {}) });
// opts.receiptDelay (ms): the receipt read is SLOW — a cold miss (the CLS scene). opts.active: one server-side ACTIVE order (on its way),
// the row the Pedidos active card + its «Ayuda» sheet read (C-5) — no tracking stream needed (a server row is never trackable there)
export function memberActive() {
  const xpA = dishId('x_pizza', 'Margherita');
  return { order_id: 'XPZ261107-LIVE04', ts: nowMs() - 25 * 60e3, total: 295, order_type: 'delivery', restaurant: 'x_pizza', status: 'out_for_delivery', display_number: 4833,
    items_text: '1x Margherita (L250)', items: [{ dish_id: xpA, qty: 1, options: [] }] };
}
export function memberExtra({ receiptDelay = 0, active = false } = {}) {
  const rows = memberRows(), live = active ? [memberActive()] : [], W = 7 * 24 * 3600e3;
  return (req, u) => {
    if (u.host === 'identitytoolkit.googleapis.com' && u.pathname.endsWith('/accounts:lookup')) return json({ kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: 'u_ana', email: 'ana.perez@gmail.com', emailVerified: true, providerUserInfo: [], validSince: '0', lastLoginAt: String(nowMs()), createdAt: '1' }] });
    if (u.host === 'securetoken.googleapis.com') { const t = memberToken(); return json({ access_token: t, id_token: t, expires_in: '3600', token_type: 'Bearer', refresh_token: 'sbs-refresh', user_id: 'u_ana', project_id: 'xpizza-delivery' }); }
    if (!u.host.endsWith('cloudfunctions.net')) return null;
    if (u.pathname.endsWith('/getMyOrders') && req.method === 'GET') {
      const oid = u.searchParams.get('order_id');
      if (oid) { const row = rows.find((r) => r.order_id === oid); const res = row ? json({ ok: true, receipt: RECEIPT(row) }) : json({ ok: false, reason: 'not_found' }, 404); return receiptDelay ? { ...res, delay: receiptDelay } : res; }
      return json({ ok: true, active: live, past: rows, next_cursor: null });
    }
    if (u.pathname.endsWith('/getMyRating') && req.method === 'GET') {
      const oid = u.searchParams.get('order_id'), row = rows.find((r) => r.order_id === oid);
      if (!row) return json({ ok: false, error: 'not_allowed' }, 403);
      if (row.order_id === 'LMS261030-DONE02') return json({ ok: true, rating: { store: 5, dishes: {}, delivery: null, comment: 'Muy rica', legacy_thumb: null, rated_at: row.ts + 3600e3, edited_at: null }, can_rate: true, editable_until: row.ts + W });
      return json({ ok: true, rating: null, can_rate: nowMs() <= row.ts + W, editable_until: row.ts + W });
    }
    return null;
  };
}

// ── S2 (sdkPay): the SDK checkout + the order's payment view (advisor 11-09, SBS method (A)) ──
// Every body is built by the STRICT test fakes (customer-app/test/fake-sdk-checkout.mjs = CONTRACT-sdk-checkout r3/r3b; fake-sdk-pay.mjs
// = CONTRACT-sdk-customer r4 payViewOf) — exact keys and types, never laxer than the server. The order_tracking node is the REAL writer's
// (create-order-build.buildCreateOrderUpdates, as capp-s7a2's trackingRecordOf), on the status path index.js writes. Both RTDB nodes are
// served as the REST stream does: text/event-stream, ONE `put` at path "/" (the connection then ends; EventSource reconnects and
// receives the same snapshot — same seq, so the view is unchanged).
const FN_REQ = createRequire(path.join(ROOT, 'xpizza-functions/x.js'));
const S2_TOKEN = 'tok_sbsS2order01';
const sse = (data) => ({ status: 200, body: `event: put\ndata: ${JSON.stringify({ path: '/', data })}\n\n`, type: 'text/event-stream', headers: [{ name: 'Cache-Control', value: 'no-cache' }] });
function trackingNode(status) {
  const { buildCreateOrderUpdates } = FN_REQ('./create-order-build'), { orderBreakdownCents } = FN_REQ('./order-money');
  const fields = { customer_name: 'Ana', customer_phone: '96123344', customer_email: 'ana.perez@gmail.com', notes: '', pickup_time: 'standard', items_text: '1x Plato',
    payment_method: 'online', address_detected: 'Col. Jardines del Valle, SPS', address_details: 'Portón negro', maps_link: 'm', waze_link: 'w', items: [{ name: 'Plato', qty: 1 }] };
  const u = buildCreateOrderUpdates({ orderId: 'LMS-SBS-1', orderType: 'delivery', now: nowMs(), trackingToken: S2_TOKEN, total: 585, lat: 15.52, lng: -88.04, fields,
    hubSnap: { hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'La Musa', restaurant_phone: '+504' }, restaurantId: 'la_musa', priceBreakdown: orderBreakdownCents(585, 'la_musa'),
    facturaPriced: { items: [] }, cashTenderedCents: null, freeOrder: false, rewardStamp: {} });
  const rec = u[`order_tracking/${S2_TOKEN}`]; if (!rec || rec.status !== 'new') throw new Error('S2 fixture: the writer wrote no tracking node');
  return { ...rec, status };   // the status path index.js writes
}
// the A–G views — EXACTLY capp-pay-adjust.test.mjs's (which copy MOCKUP-capp-S2-adjustment r3's data)
const S2_CARD = { brand: 'visa', last4: '4242' };
const S2_EXP = 1762564980000;
const consentOf = (outcome) => ({ adjustment_id: 'adj-2', outcome, old_total_cents: 58500, new_total_cents: 62500, delta_cents: 4000, expires_at: S2_EXP, changes: [PAYF.line('line_added', 'Agua Pura 600 ml', 4000)] });
export const S2_VIEWS = {
  plain: () => PAYF.payView({ total_cents: 58500, card: S2_CARD }),
  A: () => PAYF.payView({ total_cents: 52000, revision: 1, card: S2_CARD, notice: { kind: 'decrease', revision: 1, old_total_cents: 58500, new_total_cents: 52000, changes: [PAYF.line('line_unavailable', 'Pan de ajo', -6500)] } }),
  C: () => PAYF.payView({ total_cents: 58500, card: S2_CARD, consent: consentOf('pending') }),
  D: () => PAYF.payView({ total_cents: 62500, card: S2_CARD, consent: consentOf('accepted') }),
  E: () => PAYF.payView({ total_cents: 58500, card: S2_CARD, consent: consentOf('action_required') }),
  F: () => PAYF.payView({ total_cents: 58500, card: S2_CARD, consent: consentOf('expired') }),
  G: () => PAYF.payView({ total_cents: 58500, card: S2_CARD, consent: consentOf('declined') }),
};
// opts: { cards: [listCards rows], available: bool, place: <outcome> | 'slow', decline: bucket, view: <S2_VIEWS key> (default plain; null = no node), status: tracking status }
export function s2Extra(opts = {}) {
  const cards = opts.cards || [{ card_id: 'c_visa', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028, expired: false }];
  const viewOf = () => (opts.view === null ? null : S2_VIEWS[opts.view || 'plain']());   // an SDK order's node exists (plain) unless a scene says none
  const placed = new Map();   // order_id → the outcome served (placeSdkStatus answers the same)
  const respOf = (id, att) => {
    const o = opts.place || 'placed';
    if (o === 'placed') return SDKF.placeResp('placed', { order_id: id, tracking_token: S2_TOKEN, card: S2_CARD });
    if (o === 'declined') return SDKF.placeResp('declined', { order_id: id, attempt_id: att, decline: opts.decline || 'retryable', pay_deadline_at: nowMs() + 10 * 60e3 });
    if (o === 'under_review') return SDKF.placeResp('under_review', { order_id: id });
    throw new Error(`S2 fixture: no placement outcome ${o}`);
  };
  return (req, u) => {
    if (u.host.endsWith('firebaseio.com')) {
      if (u.pathname === `/order_tracking/${S2_TOKEN}.json`) return sse(trackingNode(opts.status || 'preparing'));
      if (u.pathname === `/order_tracking/${S2_TOKEN}/display_number.json`) return json(4833);
      if (u.pathname === `/order_pay_view/${S2_TOKEN}.json`) return sse(viewOf());
      // the order screen's prep read (capp-shell-ui readPublic → form-live-status prepFor): no prep_stats / prep_eta_min written for the
      // store — a real production state (the nightly writer has not run for it); the window then comes from the fallback
      if (/^\/restaurants\/[a-z0-9_-]+\/public\.json$/.test(u.pathname)) return json(null);
      return null;
    }
    if (!u.host.endsWith('cloudfunctions.net')) return null;
    const ep = u.pathname.split('/').pop();
    // as strict as the contract (Codex r1 P2): §1.1 member authority on every SDK call (the harness's ONE member token → u_ana; a
    // missing / foreign token is refused, never served); §2.1 the placement body's SDK keys exact; A3 a saved card must be one of
    // THIS member's listed, usable cards, else the one identical 409; status / getPayAdjust only for an order this member placed
    const SDK_EPS = new Set(['listCards', 'placeSdkOrder', 'placeSdkStatus', 'getPayAdjust']);
    const hdr = (k) => { const e = Object.entries(req.headers || {}).find(([h]) => h.toLowerCase() === k); return e ? e[1] : undefined; };
    const uid = hdr('authorization') === `Bearer ${MEMBER_TOKEN}` ? 'u_ana' : null;
    if (SDK_EPS.has(ep) && !uid) return json({ error: 'auth_required' }, 401);
    if (ep === 'listCards' && req.method === 'GET') return json(SDKF.listCards(cards));
    if (ep === 'sdkPayStatus' && req.method === 'GET') return json(SDKF.sdkPayStatus(opts.available !== false, opts.available === false ? 300 : 0));
    if (ep === 'placeSdkOrder' && req.method === 'POST') {
      let b = null; try { b = JSON.parse(req.postData || 'null'); } catch (_) { b = null; }
      if (!b || typeof b.order_id !== 'string' || !b.card) return null;   // not the client's body ⇒ unmapped (fails the run)
      const bad = (why) => { throw new Error(`placeSdkOrder 400 (contract §2.1): ${why}`); };   // a route that throws is UNMAPPED ⇒ the run fails
      if (typeof b.attempt_id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(b.attempt_id)) bad(`attempt_id ${JSON.stringify(b.attempt_id)}`);
      if (!('replaces_order_id' in b) || !(b.replaces_order_id === null || typeof b.replaces_order_id === 'string')) bad('replaces_order_id');
      if ('amount_cents' in b || 'total_cents' in b) bad('the client never sends an amount');
      const ck = Object.keys(b.card).sort().join();
      if (b.card.kind === 'saved') {
        if (ck !== 'card_id,kind' || typeof b.card.card_id !== 'string') bad(`card keys ${ck}`);
        if (!cards.some((c) => c.card_id === b.card.card_id && !c.expired)) { const r = SDKF.savedCardUnavailable(); return json(r.json, r.status); }   // A3: the strict fake's exact 409
      } else if (b.card.kind === 'new') {
        if (ck !== 'authentication_identifier,display,kind,save,sdk_token') bad(`card keys ${ck}`);
      } else bad(`card.kind ${b.card.kind}`);
      if (opts.place === 'slow') return { ...json(SDKF.placeResp('bank_pending', { order_id: b.order_id, attempt_id: b.attempt_id })), delay: 60000 };   // frame 4: still answering at the shot
      const r = respOf(b.order_id, b.attempt_id); placed.set(b.order_id, r); return json(r);
    }
    if (ep === 'placeSdkStatus' && req.method === 'GET') { const id = u.searchParams.get('order_id'); const r = placed.get(id); if (!r) return json({ error: 'not_found' }, 404); return r ? json(SDKF.placeResp(r.outcome, Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'outcome' && k !== 'adjust_grant')), { replay: true })) : null; }
    if (ep === 'getPayAdjust' && req.method === 'GET') {
      if (![...placed.keys()].includes(u.searchParams.get('order_id'))) return json({ error: 'not_found' }, 404);   // only this member's order
      const v = viewOf(); return v ? json({ view: v, server_now: S2_EXP - 180000 }) : null;
    }
    return null;
  };
}
// two extras in order (a member's + the S2 surface)
export const chainExtra = (...fs) => (req, u) => { for (const f of fs) { const x = f && f(req, u); if (x) return x; } return null; };
