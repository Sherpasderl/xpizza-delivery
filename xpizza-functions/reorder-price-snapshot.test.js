'use strict';
// S-D (PLAN §S-D, advisor rulings 2026-11-02) — the reorder PRICE SNAPSHOT, an additive sibling of the recipe (recipe_format unchanged):
//   1. ONE pricer, EXACT: line_cents is the existing computeServerTotal on a one-line cart, so Σ line_cents === the cart's charged
//      subtotal × 100 — over the REAL form-captured request corpus (capp-s0-bodies goldens, both brands, client price fields included)
//      and a seeded generated corpus over BOTH brands' full menus (x_pizza count-once extras with repeats, la_musa qty extras), with
//      the in-code tables AND a restaurant-tagged catalog-tables variant (the committed tables are the ones used — never the code's);
//   2. aligned 1:1: items === normalizeReorderItems(body) byte-for-byte; unit_cents = the dish price; a dropped line drops from both;
//      a line the pricer refuses ⇒ NO snapshot (never a partial one); client price fields are never read;
//   3. the REAL writers compose: cash intake (attachCustomerAttribution) → the entry; the online pending record (index.js's
//      sd:begin hunk, lifted and run) → reorder_price_snapshot → materialize (buildMaterializeUpdates) and claim (claimOrderCore) copy
//      it VERBATIM into user_orders.price_snapshot — never re-priced, even after the menu changed; a legacy pending order without one
//      keeps today's entry byte-identical.
// Run: node reorder-price-snapshot.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'reorder-snapshot-test-salt-'.padEnd(40, 'x');   // claim-order's phone hash (test-only)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const RN = require('./reorder-normalize');
const { attachCustomerAttribution } = require('./create-order-build');
const { buildMaterializeUpdates } = require('./materialize');
const { claimOrderCore } = require('./claim-order');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
const RIDS = ['x_pizza', 'la_musa'];
const sum = (s) => s.lines.reduce((k, l) => k + l.line_cents, 0);

// a restaurant-TAGGED catalog-tables variant whose every price differs from the code's (×3 + 7): the committed tables are proven used
const tagged = (rid) => ({ restaurantId: rid,
  menu: Object.fromEntries(Object.entries(MENU_BY_RESTAURANT[rid]).map(([k, p]) => [k, p * 3 + 7])),
  extras: Object.fromEntries(Object.entries(EXTRAS_BY_RESTAURANT[rid] || {}).map(([k, p]) => [k, p * 3 + 7])) });

function check(cart, rid, tables, why) {
  const charged = computeServerTotal(cart, rid, tables);
  assert.strictEqual(charged.error, null, `premise (${why}): the cart charges — ${charged.error}`);
  const r = RN.normalizeReorderItemsWithPrices(cart, rid, tables);
  assert.deepStrictEqual(r.items, RN.normalizeReorderItems(cart, rid, tables), `🔴 ${why}: items === normalizeReorderItems byte-for-byte`);
  assert.ok(r.snapshot && r.snapshot.v === 1, `🔴 ${why}: a charged cart always has a snapshot`);
  assert.strictEqual(r.snapshot.lines.length, r.items.length, `🔴 ${why}: aligned 1:1 with the recipe`);
  assert.strictEqual(sum(r.snapshot), charged.total * 100, `🔴 ${why}: Σ line_cents ${sum(r.snapshot)} === the charged subtotal ${charged.total * 100}`);
  const menu = tables ? tables.menu : MENU_BY_RESTAURANT[rid];
  r.items.forEach((l, i) => assert.strictEqual(r.snapshot.lines[i].unit_cents, menu[l.key] * 100, `🔴 ${why}: line ${i} unit_cents = the dish price`));
  r.snapshot.lines.forEach((l) => assert.deepStrictEqual(Object.keys(l), ['unit_cents', 'line_cents'], 'exactly { unit_cents, line_cents }'));
  return r;
}

// ── 1a. the REAL form-captured request corpus (both brands; client price / subtotal / extrasTotal fields present) ──
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capp-s0-bodies.golden.json'), 'utf8'));
const bodies = [];
for (const cell of Object.values(golden.cells)) for (const q of cell.requests || []) {
  const b = q.body; if (b && Array.isArray(b.items) && b.items.length && RIDS.includes(b.restaurant_id)) bodies.push(b);
}
assert.ok(bodies.length >= 30 && RIDS.every((r) => bodies.some((b) => b.restaurant_id === r)), `premise: the golden corpus covers both brands (${bodies.length} bodies)`);
assert.ok(bodies.some((b) => b.items.some((it) => 'price' in it)), 'premise: the corpus carries client price fields');
for (const b of bodies) {
  const r = check(b.items, b.restaurant_id, null, `golden ${b.restaurant_id}`);
  // client prices are never read: zero / inflate every client price field ⇒ the same snapshot
  const forged = b.items.map((it) => ({ ...it, price: 1, subtotal: 1, extrasTotal: 1, extras: (it.extras || []).map((e) => ({ ...e, price: 99999 })) }));
  assert.deepStrictEqual(RN.normalizeReorderItemsWithPrices(forged, b.restaurant_id).snapshot, r.snapshot, '🔴 the snapshot never reads the body\'s client prices');
  check(b.items, b.restaurant_id, tagged(b.restaurant_id), `golden ${b.restaurant_id} on catalog tables`);
}
ok(`the REAL form corpus (${bodies.length} captured request bodies, both brands): Σ line_cents === the charged subtotal, aligned, unit = dish price, on the code AND tagged catalog tables; forged client prices change nothing`);

// ── 1b. a seeded generated corpus over BOTH brands' FULL menus ──
let seed = 0x5d5d;
const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
const pick = (a) => a[rnd(a.length)];
let carts = 0;
for (const rid of RIDS) {
  const dishes = Object.keys(MENU_BY_RESTAURANT[rid]); const extras = Object.keys(EXTRAS_BY_RESTAURANT[rid] || {});
  const keyOf = rid === 'la_musa' ? 'id' : 'name';
  for (const d of dishes) { check([{ [keyOf]: d, qty: 1 }], rid, null, `${rid} ${d}`); carts++; }   // every dish
  for (const e of extras) { check([{ [keyOf]: dishes[0], qty: 2, extras: rid === 'la_musa' ? [{ id: e, qty: 3 }] : [{ name: e }, { name: e }] }], rid, null, `${rid} extra ${e}`); carts++; }
  for (let i = 0; i < 1500; i++) {
    const cart = [];
    for (let j = 0, m = 1 + rnd(8); j < m; j++) {
      const qty = rnd(10) === 0 ? 1 + rnd(50) : 1 + rnd(4);
      const line = { [keyOf]: pick(dishes), qty };
      if (extras.length && rnd(2)) {
        if (rid === 'la_musa') { const ids = [...new Set(Array.from({ length: 1 + rnd(3) }, () => pick(extras)))]; line.extras = ids.map((id) => ({ id, qty: 1 + rnd(5) })); }
        else line.extras = Array.from({ length: 1 + rnd(2 * qty) }, () => ({ name: pick(extras) }));   // repeats: priced once PER ENTRY
      }
      cart.push(line);
    }
    check(cart, rid, rnd(2) ? null : tagged(rid), `${rid} generated #${i}`); carts++;
  }
}
ok(`a seeded generated corpus (${carts} carts — every dish, every extra, then random carts with x_pizza repeated count-once extras and la_musa qty extras, half on tagged catalog tables): Σ line_cents === the charged subtotal, always`);

// ── 2. alignment + refusal edges ──
{
  const x = Object.keys(MENU_BY_RESTAURANT.x_pizza); const xe = Object.keys(EXTRAS_BY_RESTAURANT.x_pizza);
  const r = RN.normalizeReorderItemsWithPrices([{ name: x[0], qty: 1 }, { name: 'NO SUCH DISH', qty: 1 }, { name: x[1], qty: 0 }, { name: x[1], qty: 2 }], 'x_pizza');
  assert.deepStrictEqual(r.items.map((l) => l.key), [x[0], x[1]], 'unknown dish + invalid qty dropped from the recipe');
  assert.deepStrictEqual(r.snapshot.lines.map((l) => l.unit_cents), [MENU_BY_RESTAURANT.x_pizza[x[0]] * 100, MENU_BY_RESTAURANT.x_pizza[x[1]] * 100], '🔴 … and from the snapshot, in the same order');
  // a line the normalizer KEEPS but the pricer refuses (an unknown extra is dropped from the recipe, rejected by the charge) ⇒ no snapshot
  assert.strictEqual(RN.normalizeReorderItemsWithPrices([{ name: x[0], qty: 1, extras: [{ name: xe[0] }, { name: 'NOPE' }] }], 'x_pizza').snapshot, null, '🔴 a refused line ⇒ NO snapshot (never partial)');
  const l = Object.keys(MENU_BY_RESTAURANT.la_musa)[0]; const le = Object.keys(EXTRAS_BY_RESTAURANT.la_musa)[0];
  assert.strictEqual(RN.normalizeReorderItemsWithPrices([{ id: l, qty: 1, extras: [{ id: le, qty: 1 }, { id: le, qty: 1 }] }], 'la_musa').snapshot, null, 'a la_musa duplicate extra (deduped by the recipe, refused by the charge) ⇒ no snapshot');
  for (const bad of [null, undefined, 'x', {}, []]) assert.deepStrictEqual(RN.normalizeReorderItemsWithPrices(bad, 'x_pizza'), { items: [], snapshot: null }, `${JSON.stringify(bad)} ⇒ no recipe, no snapshot`);
  const big = Array.from({ length: 101 }, () => ({ name: x[0], qty: 1 }));
  const rb = RN.normalizeReorderItemsWithPrices(big, 'x_pizza');
  assert.strictEqual(rb.items.length, 100, 'the recipe keeps its MAX_LINES cap (placement unchanged)');
  assert.strictEqual(rb.snapshot, null, '🔴 Codex S-D r1: 101 charged lines vs a 100-line recipe ⇒ NO snapshot (Σ line_cents would not equal the charge)');
  assert.strictEqual(RN.reorderPriceSnapshot(big, 'x_pizza'), null);
  const exact = RN.normalizeReorderItemsWithPrices(big.slice(0, 100), 'x_pizza');
  assert.ok(exact.snapshot && exact.snapshot.lines.length === 100, 'exactly 100 lines (no truncation) still snapshots');
  const dropped = RN.normalizeReorderItemsWithPrices([...big.slice(0, 100), { name: 'NOT ON MENU', qty: 1 }], 'x_pizza');
  assert.ok(dropped.snapshot && dropped.snapshot.lines.length === 100, 'a 101st line the recipe DROPS anyway is not a truncation');
  assert.deepStrictEqual(RN.reorderPriceSnapshot([{ name: x[0], qty: 2 }], 'x_pizza'), RN.normalizeReorderItemsWithPrices([{ name: x[0], qty: 2 }], 'x_pizza').snapshot, 'reorderPriceSnapshot = the snapshot half');
  assert.throws(() => RN.normalizeReorderItemsWithPrices([{ name: x[0], qty: 1 }], 'x_pizza', tagged('la_musa')), /pricing_tables_restaurant_mismatch/, 'PIN B: mismatched tables throw');
}
ok('alignment: a dropped line drops from both, in order; a line the charge refuses ⇒ NO snapshot; malformed input ⇒ none; a TRUNCATED recipe (> MAX_LINES charged lines) ⇒ NO snapshot; PIN B holds');

// ── 3. the REAL writers compose end to end ──
const IDX = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const B = '  /* sd:begin reorder-price-snapshot */\n', E = '  /* sd:end reorder-price-snapshot */\n';
assert.ok(IDX.split(B).length === 2 && IDX.split(E).length === 2, 'premise: the index.js hunk is present once');
const HUNK = IDX.slice(IDX.indexOf(B), IDX.indexOf(E) + E.length);
const at = IDX.indexOf(B);
assert.ok(IDX.slice(0, at).endsWith("{ reorder_items: normalizeReorderItems(body.items, restaurantId, pricingTables) } : {})   // 2a: allowlist = the CATALOG menu\n  };\n"), '🔴 the hunk sits right after the pending record that carries reorder_items (same body.items, restaurantId, pricingTables)');
const runHunk = (ctx) => { vm.runInNewContext(HUNK, { require: (m) => require(m.startsWith('./') ? path.join(__dirname, m) : m), ...ctx }); return ctx.pendingOrderRecord; };
const realNormalize = RN.normalizeReorderItems;
const A = 'u_' + 'a'.repeat(24);
(async () => {
for (const rid of RIDS) {
  const body = bodies.find((b) => b.restaurant_id === rid); const T = tagged(rid);
  // the online pending record, as chargeOnlineOrder builds it (the base line) + the S-D hunk (run as written)
  const pending = runHunk({ customer_uid: A, body, restaurantId: rid, pricingTables: T,
    pendingOrderRecord: { customer_uid: A, total: 1, order_type: 'delivery', items_text: 'x', restaurant_id: rid, payment_method: 'online', status: 'pending_payment', reorder_items: realNormalize(body.items, rid, T) } });
  assert.ok(pending.reorder_price_snapshot, `🔴 ${rid}: the online pending record carries reorder_price_snapshot`);
  assert.strictEqual(sum(pending.reorder_price_snapshot), computeServerTotal(body.items, rid, T).total * 100, `🔴 ${rid}: priced from THIS charge's committed tables`);
  assert.strictEqual(pending.reorder_price_snapshot.lines.length, pending.reorder_items.length, `🔴 ${rid}: aligned with the base line's reorder_items`);
  const guest = runHunk({ customer_uid: null, body, restaurantId: rid, pricingTables: T, pendingOrderRecord: { status: 'pending_payment' } });
  assert.ok(!('reorder_price_snapshot' in guest), `${rid}: a guest pending record carries none (as reorder_items)`);

  // materialize at confirm — VERBATIM (the stored snapshot is the catalog-tables one; a re-price would give the code tables' cents)
  const u = buildMaterializeUpdates({ orderId: 'XPZ-o', order: clone(pending), trackingToken: 'trk123', now: 5, restaurant: rid, paymentMethod: 'online' });
  const entry = u[`user_orders/${A}/XPZ-o`];
  assert.deepStrictEqual(entry.price_snapshot, pending.reorder_price_snapshot, `🔴 ${rid}: materialize copies the snapshot VERBATIM`);
  assert.notDeepStrictEqual(entry.price_snapshot, RN.reorderPriceSnapshot(body.items, rid), `premise ${rid}: a re-price from the code tables would differ`);
  assert.deepStrictEqual(entry.items, pending.reorder_items, 'the recipe beside it');
  const legacy = clone(pending); delete legacy.reorder_price_snapshot;
  const le = buildMaterializeUpdates({ orderId: 'XPZ-o', order: legacy, trackingToken: 'trk123', now: 5, restaurant: rid, paymentMethod: 'online' })[`user_orders/${A}/XPZ-o`];
  assert.ok(!('price_snapshot' in le), `${rid}: a legacy pending order (no snapshot) ⇒ no price_snapshot key — today's entry`);

  // claim — VERBATIM from the committed order
  const tree = { user_profiles: { [A]: { phone: '50499990000', phone_hash: require('./otp-lib').phoneHash('50499990000') } },
    orders: { 'XPZ-c': { customer_phone: '50499990000', status: 'out_for_delivery', total: 99, order_type: 'delivery', items_text: 'x', restaurant_id: rid, created_at: 1,
      reorder_items: pending.reorder_items, reorder_price_snapshot: pending.reorder_price_snapshot } } };
  const db = memDb(tree);
  await claimOrderCore(db, { uid: A, orderId: 'XPZ-c', now: 10 });
  const ce = db.get(`user_orders/${A}/XPZ-c`);
  assert.ok(ce, `premise ${rid}: claim wrote the entry`);
  assert.deepStrictEqual(ce.price_snapshot, pending.reorder_price_snapshot, `🔴 ${rid}: claim copies the snapshot VERBATIM`);
  const t2 = clone(tree); delete t2.user_orders; delete t2.orders['XPZ-c'].reorder_price_snapshot; const d2 = memDb(t2);
  await claimOrderCore(d2, { uid: A, orderId: 'XPZ-c', now: 10 });
  assert.ok(d2.get(`user_orders/${A}/XPZ-c`) && !('price_snapshot' in d2.get(`user_orders/${A}/XPZ-c`)), `${rid}: a legacy order claims with no price_snapshot key`);

  // cash intake: the snapshot from the SAME committed tables that charged it
  const uc = { [`orders/XPZ-k`]: { status: 'new' } };
  attachCustomerAttribution(uc, 'XPZ-k', A, { now: 1, total: 1, orderType: 'delivery', items_text: 'x', restaurantId: rid, items: body.items, tables: T });
  const ke = uc[`user_orders/${A}/XPZ-k`];
  assert.deepStrictEqual(ke.price_snapshot, RN.reorderPriceSnapshot(body.items, rid, T), `🔴 ${rid}: cash intake writes the committed-tables snapshot`);
  assert.strictEqual(ke.price_snapshot.lines.length, ke.items.length, 'aligned with the entry\'s items');
  assert.ok(!('recipe_format' in ke), 'recipe_format is NOT bumped (absent, as today)');
}
ok('the REAL writers compose: cash intake and the online pending hunk capture the committed-tables snapshot aligned with the recipe (guests carry none); materialize and claim copy it VERBATIM (never re-priced); a legacy order keeps today\'s entry; recipe_format untouched');
console.log(`reorder-price-snapshot: OK (${n})`);
})().catch((e) => { process.stderr.write(`reorder-price-snapshot: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });

function memDb(tree) {
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v == null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  const ref = (p = '') => ({ once: async () => snap(get(p)), get: async () => snap(get(p)), set: async (v) => set(p, v),
    update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); },
    transaction: async (fn) => { const next = fn(get(p) == null ? null : clone(get(p))); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; set(p, next); return { committed: true, snapshot: snap(get(p)) }; } });
  return { get, ref };
}
