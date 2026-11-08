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
      if (p.endsWith('/quoteOrder') && req.method === 'POST' && opts.quote !== false) {
        let b = {}; try { b = JSON.parse(req.postData || '{}'); } catch (_) {}
        const food = (b.items || []).reduce((a, x) => a + Math.round((x.subtotal || 0) * 100), 0);
        return json({ ok: true, total_cents: food, net_total_cents: food + 4500, delivery: { mode: 'delivery', delivery_cents: 4500, promo_discount_cents: 0, policy_version: 'p1', from_cents: 3500, max_km: 6 } });
      }
      if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
      return null;
    }
    if (host.endsWith('firebaseio.com')) {
      const m = p.match(/\/restaurants\/([a-z0-9_-]+)\/item_availability\.json$/);
      if (m) return json((opts.sold || {})[m[1]] || null);
      if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
      return null;
    }
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
export const memberToken = () => { const now = Math.floor(nowMs() / 1000);
  return `${b64u({ alg: 'RS256', kid: 'sbs', typ: 'JWT' })}.${b64u({ iss: 'https://securetoken.google.com/xpizza-delivery', aud: 'xpizza-delivery', auth_time: now - 60, user_id: 'u_ana', sub: 'u_ana', iat: now - 60, exp: now + 3600, customer: true, firebase: { identities: {}, sign_in_provider: 'custom' } })}.sig`; };
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
