// The side-by-side harness's network: EVERY request that leaves 127.0.0.1 is answered here, from committed sources only, or it is
// UNMAPPED (null ⇒ the run fails). The bodies are the real servers' shapes:
//   · the directory  — customer-app/fixtures/s7a2/directory.json (the committed s7a2 fixture, scenario «complete»), served at the ONE
//                      injected `directory_endpoint` (advisor ruling (A), 11-02: production has no directory endpoint yet — a launch
//                      gap routed to 3a; the review page states the injection on every frame);
//   · the menus      — the committed provisioner (xpizza-functions/contract/capp/capture.mjs provisionBrand: the real publish, seeded),
//                      served as getPublicMenu sends them (/getPublicMenu/menu/<rid>, an ETag);
//   · availability   — the RTDB item_availability node (none sold, unless a scene says which);
//   · getSignupConfig / quoteOrder — the shapes the capp suites fake from the real contracts (capp-signup.test, capp-s7a2 quoteOk);
//   · Google Maps    — 503 (the app's own fallback: the schematic map, which is what the mockups draw).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// the harness's injected runtime field (ruling (A)) — mirrors 3a's APPROVED contract: GET …/getRestaurantDirectory, no query; ETag /
// If-None-Match ⇒ 304; Cache-Control max-age=30 when complete (a partial body: 200 no-store); 503 retryable; the directory-2 envelope
export const DIRECTORY_ENDPOINT = 'getRestaurantDirectory';
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'customer-app/fixtures/s7a2/directory.json'), 'utf8'));
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
const { provisionBrand } = await import(path.join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const PROV = {};
for (const rid of ['x_pizza', 'la_musa']) PROV[rid] = await quiet(() => provisionBrand(rid));

const json = (body, status = 200, headers = []) => ({ status, body, type: 'application/json', headers });
// opts: { directory: 'complete' | <scenario>, sold: { rid: [dish keys…] }, quote: true }
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
      if (m) { const sold = (opts.sold || {})[m[1]] || []; return json(sold.length ? Object.fromEntries(sold.map((k) => [k, false])) : null); }
      if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
      return null;
    }
    if (host === 'maps.googleapis.com') return { status: 503, body: '', type: 'text/javascript' };
    if (opts.extra) { const x = opts.extra(req, u); if (x) return x; }
    return null;
  };
}
export { PROV };

// ── a restored MEMBER (Ana) ──
// The packaged app restores a member from (a) the Firebase SDK's browserLocalPersistence record and (b) the capp's own completion
// marker + device profile. MEMBER_SEED writes both on the app's origin BEFORE it boots: (b) through the REAL writer
// (CappDeviceAccount, loaded from the bundle itself), (a) as the SDK persists a signed-in user (its access token unexpired, so the
// SDK needs no refresh; a lookup / refresh still answers from here). The orders and ratings are the getMyOrders / getMyRating
// contracts' shapes (NOTE-getMyOrders §3, its receipt mode; 3a's my-rating bodies), with times relative to NOW (the packaged
// app runs on the real clock).
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const memberToken = () => { const now = Math.floor(Date.now() / 1000);
  return `${b64u({ alg: 'RS256', kid: 'sbs', typ: 'JWT' })}.${b64u({ iss: 'https://securetoken.google.com/xpizza-delivery', aud: 'xpizza-delivery', auth_time: now - 60, user_id: 'u_ana', sub: 'u_ana', iat: now - 60, exp: now + 3600, customer: true, firebase: { identities: {}, sign_in_provider: 'custom' } })}.sig`; };
export const MEMBER_SEED = () => `(async () => {
  const load = (src) => new Promise((r, j) => { const s = document.createElement('script'); s.src = src; s.onload = r; s.onerror = j; document.head.appendChild(s); });
  await load('/capp-runtime.js'); await load('/capp-device-account.js');
  localStorage.clear();
  localStorage.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_ana' }));
  CappDeviceAccount.remember(localStorage, '+50496123344');
  CappDeviceAccount.rememberProfile(localStorage, { uid: 'u_ana', name: 'Ana Pérez', phone: '+50496123344', email: 'ana.perez@gmail.com', promos: true });
  const rt = self.CAPP_RUNTIME, now = Date.now();
  localStorage.setItem('firebase:authUser:' + rt.firebase.apiKey + ':[DEFAULT]', JSON.stringify({ uid: 'u_ana', email: 'ana.perez@gmail.com', emailVerified: true, isAnonymous: false, providerData: [],
    stsTokenManager: { refreshToken: 'sbs-refresh', accessToken: ${JSON.stringify(memberToken())}, expirationTime: now + 3600e3 }, createdAt: '1', lastLoginAt: String(now), apiKey: rt.firebase.apiKey, appName: '[DEFAULT]' }));
  return true;
})()`;
const dishId = (rid, name) => { const d = PROV[rid].envelope.menu.dishes.find((x) => x.name === name); return d ? String(d.dish_id) : null; };
export function memberRows() {
  const now = Date.now(), h = 3600e3;
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
// opts.receiptDelay (ms): the receipt read is SLOW — a cold miss (the CLS scene)
export function memberExtra({ receiptDelay = 0 } = {}) {
  const rows = memberRows(), W = 7 * 24 * 3600e3;
  return (req, u) => {
    if (u.host === 'identitytoolkit.googleapis.com' && u.pathname.endsWith('/accounts:lookup')) return json({ kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: 'u_ana', email: 'ana.perez@gmail.com', emailVerified: true, providerUserInfo: [], validSince: '0', lastLoginAt: String(Date.now()), createdAt: '1' }] });
    if (u.host === 'securetoken.googleapis.com') { const t = memberToken(); return json({ access_token: t, id_token: t, expires_in: '3600', token_type: 'Bearer', refresh_token: 'sbs-refresh', user_id: 'u_ana', project_id: 'xpizza-delivery' }); }
    if (!u.host.endsWith('cloudfunctions.net')) return null;
    if (u.pathname.endsWith('/getMyOrders') && req.method === 'GET') {
      const oid = u.searchParams.get('order_id');
      if (oid) { const row = rows.find((r) => r.order_id === oid); const res = row ? json({ ok: true, receipt: RECEIPT(row) }) : json({ ok: false, reason: 'not_found' }, 404); return receiptDelay ? { ...res, delay: receiptDelay } : res; }
      return json({ ok: true, active: [], past: rows, next_cursor: null });
    }
    if (u.pathname.endsWith('/getMyRating') && req.method === 'GET') {
      const oid = u.searchParams.get('order_id'), row = rows.find((r) => r.order_id === oid);
      if (!row) return json({ ok: false, error: 'not_allowed' }, 403);
      if (row.order_id === 'LMS261030-DONE02') return json({ ok: true, rating: { store: 5, dishes: {}, delivery: null, comment: 'Muy rica', legacy_thumb: null, rated_at: row.ts + 3600e3, edited_at: null }, can_rate: true, editable_until: row.ts + W });
      return json({ ok: true, rating: null, can_rate: Date.now() <= row.ts + W, editable_until: row.ts + W });
    }
    return null;
  };
}
