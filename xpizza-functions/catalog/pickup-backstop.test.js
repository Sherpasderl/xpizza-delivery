'use strict';
// S2-8 (D4c-grill/item-s1/S2-DESIGN.md §1.4 + the option-A addendum; §2 r1 B + C) — THE PICKUP-ONLY BACKSTOP, pure.
//   · binding endpoints (createOrder / chargeOnline): a pickup-only product is refused unless order_type === 'pickup'
//   · quotes (quoteOrder / quoteRedemption): refused ONLY on an explicit mode === 'delivery'; missing / invalid mode skips the
//     check (the frozen forms send no mode) — and never reads the gate
//   · judged on each line's RESOLVED key (the stamp; reward lines by the key the calculator consumes)
//   · the gate is the PRICED version's (served-version provenance), three states: unauthored (no check), ok, unavailable
//     (retryable 503 menu_updating — never a silent waiver)
// The gate reader is the REAL createGateReader over a real built catalog (x_pizza's live pickup-only section `ny`).
// Run: node catalog/pickup-backstop.test.js
const assert = require('assert');
const { pickupRefusal, pickupGateRefusal } = require('./pickup-backstop');
const { createGateReader } = require('./menu-gates');
const { PRICING_KEY_STAMP } = require('../menu-pricing');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pickup-backstop: FAILED — exited without completing'); process.exitCode = 1; } });

const { built: XB } = buildSourceCandidate('x_pizza', buildSourceFromCode('x_pizza'));
assert.deepStrictEqual(XB.structure.pickup_only_cats, ['ny'], 'premise: x_pizza\'s live pickup-only section');
const NY = XB.items.find((i) => i.display.cat === 'ny').key;
const IND = XB.items.find((i) => i.display.cat === 'individual').key;
const UNAUTH = { ...XB, structure: { ...XB.structure } }; delete UNAUTH.structure.pickup_only_cats;
const stamped = (line, key) => { Object.defineProperty(line, PRICING_KEY_STAMP, { value: key, enumerable: false, writable: true, configurable: true }); return line; };

// a gate reader over a catalog per version; counts reads; a version may fail
const readerOf = (byVersion, failing = new Set()) => {
  const reads = [];
  const r = createGateReader({ getMenu: async (rid, v) => { reads.push(v); if (failing.has(v)) throw new Error('boom'); return byVersion[v] || null; }, getVersionId: async () => 'v2' });
  return { r, reads };
};
const decide = (o) => pickupRefusal({ restaurantId: 'x_pizza', versionId: 'v1', ...o });

(async () => {
  // ── binding endpoints ──
  {
    const { r, reads } = readerOf({ v1: XB });
    const deliv = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: r });
    assert.deepStrictEqual(deliv, { status: 409, body: { ok: false, error: 'pickup_only_item', item_key: NY } }, 'S2P-BIND-DELIVERY a pickup-only item on a delivery order → 409 pickup_only_item naming it');
    assert.deepStrictEqual(reads, ['v1'], 'S2P-PROVENANCE the gate read is the PRICED version, not the active pointer (v2)');
    const pick = await decide({ kind: 'binding', body: { order_type: 'pickup', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: r });
    assert.strictEqual(pick, null, 'S2P-BIND-PICKUP a pickup order passes');
    const plain = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: IND, qty: 1 }, IND)] }, gates: r });
    assert.strictEqual(plain, null, 'S2P-BIND-PLAIN a delivery order without a pickup-only item passes');
    ok('binding: a delivery order with a pickup-only item → 409; pickup orders and plain carts pass; the priced version is read');
  }
  // ── the stamp decides; the reward line is judged too ──
  {
    const { r } = readerOf({ v1: XB });
    const byStamp = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: IND, item_key: NY, qty: 1 }, NY)] }, gates: r });
    assert.deepStrictEqual(byStamp && byStamp.body.item_key, NY, 'S2P-STAMP the RESOLVED key is judged, never the legacy name');
    const legacy = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [{ name: NY, qty: 1 }] }, gates: r });
    assert.deepStrictEqual(legacy && legacy.body.item_key, NY, 'S2P-LEGACY an unstamped legacy line is judged by its pricing key');
    const reward = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: IND, qty: 1 }, IND)], redeem: { type: 'free_pizza_choice', item_id: NY } }, gates: r });
    assert.deepStrictEqual(reward && reward.body.item_key, NY, 'S2P-REWARD a pickup-only REWARD item on a delivery order is refused');
    ok('the resolved key is judged (paid lines by the stamp, rewards by the key the calculator consumes)');
  }
  // ── quotes: only an explicit mode 'delivery' is judged; nothing else even reads the gate ──
  {
    const { r, reads } = readerOf({ v1: XB });
    const cart = () => [stamped({ name: NY, qty: 1 }, NY)];
    const q = await decide({ kind: 'quote', body: { mode: 'delivery', items: cart() }, gates: r });
    assert.deepStrictEqual(q, { status: 409, body: { ok: false, error: 'pickup_only_item', item_key: NY } }, 'S2P-QUOTE-DELIVERY an explicit delivery quote is refused early');
    for (const [body, label] of [[{ items: cart() }, 'missing'], [{ mode: 'drone', items: cart() }, 'invalid'], [{ mode: 'pickup', items: cart() }, 'pickup'], [{ order_type: 'delivery', items: cart() }, 'order_type only (a quote reads mode)']]) {
      reads.length = 0;
      assert.strictEqual(await decide({ kind: 'quote', body, gates: r }), null, `S2P-QUOTE-SKIP mode ${label}: not refused (option A)`);
      assert.deepStrictEqual(reads, [], `S2P-QUOTE-SKIP mode ${label}: the gate is never read`);
    }
    ok('quotes: only an explicit mode "delivery" is judged; missing / invalid / pickup modes are never refused and never read');
  }
  // ── three states: unauthored, unavailable, flat ──
  {
    const un = readerOf({ v1: UNAUTH });
    assert.strictEqual(await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: un.r }), null, 'S2P-UNAUTHORED no authored pickup gate → no check (today)');
    const bad = readerOf({}, new Set(['v1']));
    const u = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: bad.r });
    assert.strictEqual(u && u.status, 503, 'S2P-UNAVAILABLE a gate read failure → 503');
    assert.deepStrictEqual(u.body.error, 'menu_updating', 'S2P-UNAVAILABLE menu_updating (retryable), never a silent waiver');
    assert.strictEqual(u.body.retryable, true, 'S2P-UNAVAILABLE retryable');
    const flat = readerOf({ v1: XB });
    assert.strictEqual(await pickupRefusal({ restaurantId: 'x_pizza', versionId: null, kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: flat.r }), null, 'S2P-FLAT the flat route (no version) → unauthored');
    assert.deepStrictEqual(flat.reads, [], 'S2P-FLAT and reads nothing');
    ok('unauthored → no check; a read failure → 503 menu_updating; the flat route → no check, no read');
  }
  // ── a successful read whose WEEKEND gate is unauthored (la_musa has none) is NOT a read failure ──
  {
    const noWeekend = { ...XB, structure: { ...XB.structure } }; delete noWeekend.structure.weekend_only_cats;
    const { r } = readerOf({ v1: noWeekend });
    const d = await decide({ kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: r });
    assert.deepStrictEqual(d, { status: 409, body: { ok: false, error: 'pickup_only_item', item_key: NY } }, 'S2P-NOWEEKEND an unauthored weekend gate never reads as «unavailable» (the pickup gate is judged)');
    ok('a snapshot without a weekend gate is read normally: the pickup gate is judged, never 503');
  }
  // ── reads: one per version per instance (cached), served = active shares the intake cache ──
  {
    const { r, reads } = readerOf({ v1: XB, v2: XB });
    const body = () => ({ order_type: 'delivery', items: [stamped({ name: IND, qty: 1 }, IND)] });
    await decide({ kind: 'binding', body: body(), gates: r });
    await decide({ kind: 'binding', body: body(), gates: r });
    assert.deepStrictEqual(reads, ['v1'], 'S2P-READS a repeat of the same version reads once (cached)');
    await r.intakeGatesFor('x_pizza');
    await pickupRefusal({ restaurantId: 'x_pizza', versionId: 'v2', kind: 'binding', body: body(), gates: r });
    assert.deepStrictEqual(reads, ['v1', 'v2'], 'S2P-READS served = active: the intake warm-up\'s read serves the backstop (no new read)');
    ok('the gate is read once per version per instance; served = active adds no read');
  }
  // ── the card path's fresh gate: the { refuse } shape; the owned-only release runs once on a refusal, never on a pass ──
  {
    const { r } = readerOf({ v1: XB });
    let released = 0; const rel = async () => { released += 1; };
    const g = await pickupGateRefusal({ restaurantId: 'x_pizza', versionId: 'v1', kind: 'binding', body: { order_type: 'delivery', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: r }, rel);
    assert.deepStrictEqual(g, { refuse: { status: 409, body: { ok: false, error: 'pickup_only_item', item_key: NY } } }, 'S2P-CARD-REFUSE the gate shape');
    assert.strictEqual(released, 1, 'S2P-CARD-RELEASE the owned-only release runs on a refusal');
    const p = await pickupGateRefusal({ restaurantId: 'x_pizza', versionId: 'v1', kind: 'binding', body: { order_type: 'pickup', items: [stamped({ name: NY, qty: 1 }, NY)] }, gates: r }, rel);
    assert.strictEqual(p, null, 'S2P-CARD-PASS a pickup charge passes');
    assert.strictEqual(released, 1, 'S2P-CARD-PASS and releases nothing');
    ok('card fresh gate: refusal in the gate shape with the owned-only release; a pass releases nothing');
  }
  FINISHED = true;
  console.log(`\npickup-backstop: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
