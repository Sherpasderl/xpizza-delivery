'use strict';
// CUSTOMER APP S0-prod §A1 — THE SERVER CANNOT TELL THE DIFFERENCE (advisor ruling Q3, 2026-10-22).
// Since S0-prod the live X. Pizza form sends restaurant_id:'x_pizza' on quoteOrder / createOrder / chargeOnlineOrder;
// before, it sent nothing and the server defaulted (restaurant-id.js). This proves, with the REAL handlers on the
// emulator, that explicit 'x_pizza' and the field ABSENT produce the same result: the same HTTP status and body, the
// same price (quote totals, the stored order, the amount handed to PixelPay), the same factura decision and routing
// (both are fields of the stored order) — in fact the same ENTIRE database delta, compared path by path after
// normalising only what is request-local (the order id, and values the server mints per request). It also checks
// that no endpoint rejects or strips the field. The server default is NOT retired (not this slice).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:capp-a1
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capp-a1-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'capp-a1-test-only-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
// The external boundaries only (the same stubs as test/extra-price-edit.emulator.test.js): WhatsApp, PixelPay's
// hosted checkout (records the amount handed to it), and ID-token verification.
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push({ amount: q.amountLempiras, email: q.email }); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const db = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { verifyQuoteToken } = require('../quote-token');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('capp-a1-equivalence: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}` }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 15.507489753573818, lng: -88.0398486953722 };
async function seed(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'capp-a1' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: 'X. Pizza', phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 7, version: 1, hours: HOURS });
}

// ── the whole-database DELTA of one request, normalised ──────────────────────────────────────────────────────────
// Everything under RTDB and the Firestore collections a request can write is snapshotted before and after; the delta is
// the UNION of both path sets: every leaf that appeared, changed, or was DELETED (marked <deleted>). Normalisation is by
// EXACT VALUE, never by shape: this run's own order id → <oid>, its hosted attempt id (orders/<oid>/active_attempt_id) →
// <attempt>, its tracking token (orders/<oid>/tracking_token) → <tracking>, its attempt's poll token → <poll>, in path
// segments, values and the response alike; a numeric
// leaf within ±1 day of now → <time>. Two raw paths that normalise to the same key THROW (cardinality is preserved).
// The two runs are then compared leaf by leaf over the union of their keys: every leaf must be byte-equal, except the
// NAMED per-request mints below (each must be present, as a string, on BOTH sides).
const flat = (v, p, out) => { if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) flat(x, p ? `${p}/${k}` : k, out); } else out[p] = v; return out; };
async function snapshot() {
  const out = flat((await rtdb.ref().get()).val() || {}, 'rtdb', {});
  for (const c of await db.listCollections()) {
    if (c.id === 'restaurants') continue;                    // the catalog seed (read-only to these handlers)
    for (const d of (await c.get()).docs) flat(JSON.parse(JSON.stringify(d.data())), `fs/${c.id}/${d.id}`, out);
  }
  return out;
}
const MINTED = [                                            // the ONLY leaves allowed to differ between the two runs
  /^rtdb\/orders\/<oid>\/payment_fingerprint$/,             // a hash over the order id (pixelpay-charge orderFingerprint)
];
const isMinted = (k) => MINTED.some((re) => re.test(k));
function idsOf(after, oid) {
  const ids = [[oid, '<oid>']];
  const att = after[`rtdb/orders/${oid}/active_attempt_id`]; if (typeof att === 'string' && att) ids.push([att, '<attempt>']);
  const poll = att && after[`rtdb/payment_attempts/${att}/poll_token`]; if (typeof poll === 'string' && poll) ids.push([poll, '<poll>']);
  const trk = after[`rtdb/orders/${oid}/tracking_token`]; if (typeof trk === 'string' && trk) ids.push([trk, '<tracking>']);
  return ids;
}
const subst = (v, ids) => { if (typeof v !== 'string') return v; let out = v; for (const [raw, tag] of ids) out = out.split(raw).join(tag); return out; };
function normalise(before, after, oid) {
  const now = Date.now(); const ids = idsOf(after, oid);
  const val = (v) => (typeof v === 'number' && Math.abs(v - now) < 86400000 ? '<time>' : subst(v, ids));
  const d = {}; const from = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const inA = Object.prototype.hasOwnProperty.call(after, k), inB = Object.prototype.hasOwnProperty.call(before, k);
    if (inA && inB && before[k] === after[k]) continue;
    const nk = k.split('/').map((seg) => subst(seg, ids)).join('/');
    if (Object.prototype.hasOwnProperty.call(d, nk)) throw new Error(`capp-a1: two paths normalise to ${nk} (${from[nk]} and ${k}) — cardinality would be lost`);
    d[nk] = inA ? val(after[k]) : '<deleted>'; from[nk] = k;
  }
  return { delta: d, ids };
}
function compareDeltas(a, e) {
  const diffs = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(e)])) {
    const inA = k in a, inE = k in e;
    if (inA && inE && JSON.stringify(a[k]) === JSON.stringify(e[k])) continue;
    if (inA && inE && isMinted(k) && typeof a[k] === 'string' && typeof e[k] === 'string' && a[k] !== '<deleted>' && e[k] !== '<deleted>') continue;
    diffs.push(`${k}: ${inA ? JSON.stringify(a[k]) : '(absent)'} vs ${inE ? JSON.stringify(e[k]) : '(absent)'}`);
  }
  return diffs;
}

const CART = [{ name: 'Carnivora', qty: 2, price: 340, extras: [{ name: 'Salsa Roja', price: 39 }] }];
const PIN = { lat: HUB.lat + 0.01, lng: HUB.lng + 0.01 };
const order = (oid, method, withRid) => ({ ...(withRid ? { restaurant_id: 'x_pizza' } : {}), order_id: oid, customer_name: 'Cliente Prueba', customer_phone: '+504 9876-5432',
  customer_email: 'cliente@prueba.hn', items: CART, items_text: '2x Carnivora (L340) [Pizza 1: Salsa Roja]', total: 719, notes: '—', order_type: 'delivery', lat: PIN.lat, lng: PIN.lng,
  maps_link: `https://www.google.com/maps?q=${PIN.lat},${PIN.lng}`, address_detected: '', address_details: 'Casa azul', payment_method: method,
  pickup_time: null, scheduled_for: null, payment_status: method === 'cash' ? 'confirmed' : 'pending', razon_social: 'Empresa Prueba', rtn_cliente: '08011999123456' });
const between = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };

async function run(handler, body, oid) {
  await between();
  const before = await snapshot();
  CHARGED.length = 0;
  const r = await post(handler, body);
  await new Promise((res) => setTimeout(res, 400));       // let any trigger the emulator runs settle its writes
  const after = await snapshot();
  const { delta, ids } = normalise(before, after, oid);
  const resp = JSON.parse(JSON.stringify(r.json === null ? r.text : r.json), (k, v) => subst(v, ids));   // the same EXACT substitutions
  return { status: r.status, resp, delta, charged: CHARGED.slice() };
}

(async () => {
  await wipe();
  await seed('x_pizza');

  // ── quoteOrder ──
  {
    const absent = await post(app.quoteOrder, { items: CART });
    const explicit = await post(app.quoteOrder, { restaurant_id: 'x_pizza', items: CART });
    assert.strictEqual(absent.status, 200, `quote (absent): ${absent.text.slice(0, 200)}`);
    assert.strictEqual(explicit.status, 200, `quote (explicit): ${explicit.text.slice(0, 200)} — the field is NOT rejected`);
    const strip = (j) => { const { quote_token, ...rest } = j; return rest; };
    assert.deepStrictEqual(strip(explicit.json), strip(absent.json), 'quoteOrder: identical totals/body with and without restaurant_id');
    const tok = (j) => { const v = verifyQuoteToken(j.quote_token, process.env.QUOTE_TOKEN_SECRET, Date.now()); assert.ok(v.ok, `the quote token verifies (${v.reason})`); const { issued_at, expires_at, quote_id, ...p } = v.payload; return p; };
    assert.deepStrictEqual(tok(explicit.json), tok(absent.json), 'quoteOrder: the signed token binds the same rid, net and cart fingerprint');
    assert.strictEqual(tok(explicit.json).rid, 'x_pizza', 'the quote is issued for x_pizza in both');
    ok(`quoteOrder: explicit 'x_pizza' ≡ absent — status 200 both, same body (total_cents ${absent.json.total_cents}), same signed rid/net/fingerprint`);
  }

  // ── createOrder (cash, delivery, RTN — the factura path) and chargeOnlineOrder (card) ──
  for (const [name, handler, method] of [['createOrder', app.createOrder, 'cash'], ['chargeOnlineOrder', app.chargeOnlineOrder, 'online']]) {
    const tag = Date.now();
    const a = await run(handler, order(`a1abs${tag}`, method, false), `a1abs${tag}`);
    const e = await run(handler, order(`a1exp${tag}`, method, true), `a1exp${tag}`);
    assert.strictEqual(a.status, 200, `${name} (absent): ${JSON.stringify(a.resp).slice(0, 300)}`);
    assert.strictEqual(e.status, 200, `${name} (explicit): ${JSON.stringify(e.resp).slice(0, 300)} — the field is NOT rejected`);
    assert.deepStrictEqual(e.resp, a.resp, `${name}: identical response body (this run's own oid/attempt/tracking substituted by exact value)`);
    assert.deepStrictEqual(e.charged, a.charged, `${name}: identical amount handed to PixelPay`);
    assert.ok(Object.keys(a.delta).length > 5, `${name}: non-vacuity — the request wrote ${Object.keys(a.delta).length} leaves`);
    const diff = compareDeltas(a.delta, e.delta);
    assert.deepStrictEqual(diff, [], `${name}: the database deltas differ: ${diff.join('; ')}`);
    const minted = Object.keys(a.delta).filter((k) => JSON.stringify(a.delta[k]) !== JSON.stringify(e.delta[k]));
    const stored = Object.entries(e.delta).filter(([k]) => k.startsWith('rtdb/orders/<oid>/'));
    const rid = stored.find(([k]) => k === 'rtdb/orders/<oid>/restaurant_id');
    if (method === 'cash') {
      assert.ok(rid && rid[1] === 'x_pizza', `${name}: the stored order carries restaurant_id 'x_pizza' (not stripped): ${JSON.stringify(rid)}`);
      for (const f of ['total_cents', 'factura_status']) assert.ok(stored.some(([k]) => k === `rtdb/orders/<oid>/${f}`), `${name}: non-vacuity — the stored order has ${f}`);
    }
    ok(`${name}: explicit 'x_pizza' ≡ absent — status 200 both, same response, same PixelPay amount ${JSON.stringify(a.charged.map((c) => c.amount))}, and the SAME ${Object.keys(a.delta).length}-leaf database delta (price, factura_status, routing, every stored field incl. deletions; ${minted.length} NAMED per-request mint(s) differ: ${minted.join(', ') || 'none'})`);
  }

  // ── the comparator is not blind (codex r1): a different dish id, a different driver, a deletion on one side each FAIL ──
  {
    const O = 'negO';
    const base = { [`rtdb/orders/${O}/status`]: 'new' };
    const runOf = (after) => normalise(base, after, O).delta;
    const A = { ...base, [`rtdb/orders/${O}/items/0/dish_id`]: 'D9XRZ89WJ6', [`rtdb/tasks/${O}_delivery/driver_uid`]: 'driver_A', [`rtdb/orders/${O}/tracking_token`]: 'TrkAAAA1111' };
    const sameButToken = { ...A, [`rtdb/orders/${O}/tracking_token`]: 'TrkBBBB2222' };
    assert.deepStrictEqual(compareDeltas(runOf(A), runOf(sameButToken)), [], 'control: a run differing only in its OWN tracking token is equal');
    assert.ok(compareDeltas(runOf(A), runOf({ ...A, [`rtdb/orders/${O}/items/0/dish_id`]: 'SBMGAMAGJQ' })).some((x) => /dish_id/.test(x)), 'a different dish_id FAILS');
    assert.ok(compareDeltas(runOf(A), runOf({ ...A, [`rtdb/tasks/${O}_delivery/driver_uid`]: 'driver_B' })).some((x) => /driver_uid/.test(x)), 'a different driver FAILS');
    const { [`rtdb/orders/${O}/status`]: _gone, ...deleted } = A;
    assert.ok(compareDeltas(runOf(A), runOf(deleted)).some((x) => /status: \(absent\) vs "<deleted>"/.test(x)), 'a leaf DELETED on one side FAILS');
    assert.throws(() => normalise({}, { [`rtdb/x/${O}`]: 1, 'rtdb/x/<oid>': 2 }, O), /cardinality/, 'two paths collapsing to one key THROW');
    ok('comparator: a different dish_id, a different driver and a one-sided deletion each FAIL; only the run\'s own minted ids are substituted; collapsing paths throw');
  }

  // sensitivity: the comparison is not blind — a different restaurant_id is refused or diverges
  {
    const bad = await post(app.quoteOrder, { restaurant_id: 'no_such_brand', items: CART });
    assert.ok(bad.status >= 400 || (bad.json && bad.json.ok === false), `sensitivity: an unknown restaurant_id is refused (${bad.status} ${bad.text.slice(0, 120)})`);
    ok(`sensitivity: an unknown restaurant_id is refused by quoteOrder (${bad.status}) — the field is read, so equivalence is meaningful`);
  }

  FINISHED = true;
  console.log(`\ncapp-a1-equivalence: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('capp-a1-equivalence FAILED:', e && (e.stack || e)); process.exit(1); });
