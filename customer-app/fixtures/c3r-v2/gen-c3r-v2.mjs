// C-3r v2 — THE RECEIPT FIXTURE, produced by 3a's REAL price_snapshot v2 writer and getMyOrders handler (feat/snapshot-v2-3a) — never
// hand-written. 3a's tree is not in this base, so this generator runs against an extracted tree of that commit:
//   git archive <sha> | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/c3r-v2/gen-c3r-v2.mjs <dir>/xpizza-functions <full sha>
// Real pieces: the placement (customer-app/test/place-real.mjs — ONE source with the capp suites) over 3a's delivery-pricing /
// delivery-wire / factura pricing / create-order-build (attachCustomerAttribution → reorderPriceSnapshot v2) / materialize; then 3a's
// my-orders.js makeMyOrders getMyOrders handler in its RECEIPT mode (?context=platform&order_id=…), whose 200 body is recorded verbatim.
// The one stand-in: the RTDB handle (a plain store whose reads return exactly what the placement wrote — val() + exists(), all the
// handler calls) and the token check (verifyIdToken → { uid, customer: true }, the member claim the handler requires).
// Scenario XP-V1 = the capp suites' G1 order: 2× Margherita, Mozzarella on one (x_pizza, name-keyed options).
// Scenario LM-V1 (advisor 11-14, the la_musa gap) = an ID-keyed order: 2× Sichuan Spicy Wonton with ONE «rice_white» (qty 1 — la_musa
// extras carry their own qty) + 1× Pork Belly Buns (plain) — the v2 snapshot's k is the extra's ID.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeRealWith } from '../../test/place-real.mjs';

const FN = process.argv[2], SHA = process.argv[3];
if (!FN || !/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage: gen-c3r-v2.mjs <extracted xpizza-functions> <full commit sha>');
const require = createRequire(join(FN, 'x.js'));
const RC = { P: require('./delivery/delivery-pricing'), DW: require('./delivery/delivery-wire'), FP: require('./factura/pricing'), MP: require('./menu-pricing'), CB: require('./create-order-build'), MZ: require('./materialize') };
const MO = require('./my-orders.js');
const blob = (rel) => { const b = readFileSync(join(FN, rel)); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };   // = git hash-object

const T0 = Date.UTC(2026, 9, 21, 1, 5);   // the receipt's own clock only (the capp cells read its price_snapshot, never its times)
const db = {}, orders = {};
const { e, o } = placeRealWith(RC, T0, db, orders, 'u_ana', 'XP-V1', { ts: T0 - 86400e3 });
if (!e.price_snapshot || e.price_snapshot.v !== 2) throw new Error('premise: 3a\'s writer emits price_snapshot v2');
const LM_BODY = [{ id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 1 }] }, { id: 'dimsum_02', qty: 1 }];
for (const l of LM_BODY) if (!Object.prototype.hasOwnProperty.call(RC.MP.MENU_BY_RESTAURANT.la_musa, l.id)) throw new Error('premise: 3a\'s la_musa menu has ' + l.id);
if (!Object.prototype.hasOwnProperty.call(RC.MP.EXTRAS_BY_RESTAURANT.la_musa, 'rice_white')) throw new Error('premise: 3a\'s la_musa extras have rice_white');
const lm = placeRealWith(RC, T0, db, orders, 'u_ana', 'LM-V1', { rid: 'la_musa', type: 'pickup', pay: 'card_delivery', ts: T0 - 2 * 86400e3, items_text: '2x Sichuan Spicy Wonton (L249) [+ 1x Arroz blanco], 1x Pork Belly Buns (L248)', body: LM_BODY });
if (!lm.e.price_snapshot || lm.e.price_snapshot.v !== 2 || !(lm.e.price_snapshot.lines[0].extras || []).some((x) => x.k === 'rice_white')) throw new Error('premise: the la_musa v2 snapshot keys the extra by its ID: ' + JSON.stringify(lm.e.price_snapshot));

const data = { user_orders: { u_ana: db.u_ana }, orders };
const at = (p) => p.split('/').reduce((x, k) => (x == null ? undefined : x[k]), data);
const rtdb = { ref: (p) => ({ once: async () => { const v = at(p); const c = v === undefined ? null : JSON.parse(JSON.stringify(v)); return { val: () => c, exists: () => c !== null }; } }) };
const { getMyOrders } = MO.makeMyOrders({ getDatabase: () => rtdb, getAuth: () => ({ verifyIdToken: async (t) => { if (t !== 'tok_u_ana') throw new Error('foreign'); return { uid: 'u_ana', customer: true }; } }),
  checkRateLimit: async () => ({ allowed: true }), resolveContext: async () => null });
async function call(query) {
  const r = { status: null, headers: {}, body: null };
  const res = { set(k, v) { r.headers[k] = v; return res; }, status(c) { r.status = c; return res; }, json(b) { r.body = JSON.parse(JSON.stringify(b)); return res; } };
  await getMyOrders({ method: 'GET', query, body: {}, get: (h) => (h.toLowerCase() === 'x-firebase-id-token' ? 'tok_u_ana' : undefined) }, res);
  return r;
}
const receipt = await call({ context: 'platform', order_id: 'XP-V1' }), lmReceipt = await call({ context: 'platform', order_id: 'LM-V1' });
if (lmReceipt.status !== 200 || !lmReceipt.body.receipt || lmReceipt.body.receipt.price_snapshot === undefined) throw new Error('premise: the la_musa receipt carries the snapshot');
if (receipt.status !== 200 || !receipt.body.receipt || receipt.body.receipt.price_snapshot === undefined) throw new Error('premise: the receipt carries the snapshot (3a step 1): ' + JSON.stringify(receipt).slice(0, 200));

const out = { source: { commit: SHA, blobs: Object.fromEntries(['create-order-build.js', 'reorder-normalize.js', 'my-orders.js', 'member-auth.js', 'menu-pricing.js', 'factura/pricing.js'].map((f) => [f, blob(f)])) },
  scenarios: { 'XP-V1': { items: e.items, price_snapshot: e.price_snapshot, receipt: { status: receipt.status, body: receipt.body } },
    'LM-V1': { body: LM_BODY, items: lm.e.items, price_snapshot: lm.e.price_snapshot, receipt: { status: lmReceipt.status, body: lmReceipt.body } } } };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
out.scenarios_sha256 = createHash('sha256').update(canon(out.scenarios)).digest('hex');
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'c3r-v2.json'), JSON.stringify(out, null, 1) + '\n');
console.log('LM-V1 items', JSON.stringify(lm.e.items), '\nsnapshot', JSON.stringify(lm.e.price_snapshot));
console.log('XP-V1 items', JSON.stringify(e.items), '\nsnapshot', JSON.stringify(e.price_snapshot), '\nreceipt keys', Object.keys(receipt.body.receipt).join(','));
