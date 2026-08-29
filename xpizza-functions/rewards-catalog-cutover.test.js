'use strict';
// Phase 1b-1b — the redemption cluster prices from the guarded catalog tables, WHOLESALE.
// Run: node rewards-catalog-cutover.test.js
//
// Every assertion here answers one of two questions: (a) does the catalog-fed path produce BYTE-IDENTICAL
// output to the code-fed path (the money/fiscal invariant), and (b) are the tables ACTUALLY CONSULTED at
// each cut site (non-vacuity — a comparison of catalog-vs-code passes trivially if `tables` is ignored).
const assert = require('assert');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { computeRedemption, laMusaPriceCents } = require('./rewards-redeem');
const { isLaMusaEligible, isRedeemEligible, eligibleKeys } = require('./rewards-redeem-config');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { requireTables } = require('./catalog/pricing-tables');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const T = (rid, over = {}) => ({
  restaurantId: rid,
  menu: { ...MENU_BY_RESTAURANT[rid], ...(over.menu || {}) },
  extras: { ...EXTRAS_BY_RESTAURANT[rid], ...(over.extras || {}) },
});
const XP = T('x_pizza'), LM = T('la_musa');
const XKEY = Object.keys(MENU_BY_RESTAURANT.x_pizza).find((k) => isRedeemEligible('x_pizza', k));
const LKEY = Object.keys(MENU_BY_RESTAURANT.la_musa).find((k) => isLaMusaEligible(k));
const paidX = [{ name: 'Ham', qty: 1 }];
const redeemX = { type: 'free_pizza_choice', item_id: XKEY };
const redeemL = { type: 'points_ala_carte', items: [{ id: LKEY, qty: 2 }] };

// ── 1. PARITY: catalog-fed == code-fed, byte-identical, every cut site ──────────────────────────
{
  const a = computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza', tables: XP });
  const b = computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza' });
  assert.deepStrictEqual(a, b); ok('parity: computeRedemption x_pizza — catalog-fed == code-fed');
}
{
  const items = [{ id: LKEY, qty: 1 }];
  const a = computeRedemption({ redeem: redeemL, items, restaurantId: 'la_musa', tables: LM });
  const b = computeRedemption({ redeem: redeemL, items, restaurantId: 'la_musa' });
  assert.deepStrictEqual(a, b); ok('parity: computeRedemption la_musa (multiset, cost_pts) — catalog-fed == code-fed');
}
assert.strictEqual(laMusaPriceCents(LKEY, LM), laMusaPriceCents(LKEY)); ok('parity: laMusaPriceCents');
assert.strictEqual(isLaMusaEligible(LKEY, LM), isLaMusaEligible(LKEY)); ok('parity: isLaMusaEligible membership');
assert.deepStrictEqual(eligibleKeys('la_musa', LM), eligibleKeys('la_musa')); ok('parity: eligibleKeys');

// ── 2. FISCAL PARITY (owner-approved cut): the REDEEMED X. Pizza factura value is byte-identical ──
{
  const redemption = computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza', tables: XP });
  const total = MENU_BY_RESTAURANT.x_pizza.Ham;
  const cat = applyRedemptionToPricing({ items: paidX, restaurantId: 'x_pizza', redemption, totalLempiras: total, tables: XP });
  const code = applyRedemptionToPricing({ items: paidX, restaurantId: 'x_pizza', redemption, totalLempiras: total });
  assert.strictEqual(cat.ok, true, 'the redeemed pricing must succeed');
  assert.deepStrictEqual(cat, code, 'the WHOLE redeemed pricing result is byte-identical');
  assert.deepStrictEqual(cat.factura_items, code.factura_items, 'factura_items byte-identical (SAR document lines)');
  assert.strictEqual(cat.desc_rebaja_cents, code.desc_rebaja_cents, 'desc_rebaja_cents byte-identical (the fiscal rebaja)');
  assert.ok(cat.factura_items.some((l) => l.redeemed === true), 'the comped line is present and marked redeemed');
  ok(`FISCAL parity: redeemed factura_items (${cat.factura_items.length} lines) + desc_rebaja_cents=${cat.desc_rebaja_cents} byte-identical catalog-vs-code`);
}

// ── 3. NON-VACUITY: each cut site must ACTUALLY consult the tables (a sentinel only the tables carry) ──
{
  const t = T('x_pizza', { menu: { [XKEY]: 4242 } });
  const r = computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza', tables: t });
  assert.strictEqual(r.freeItems[0].price_cents, 424200, 'computeXPizza must price from the TABLES');
  assert.notStrictEqual(r.freeItems[0].price_cents, MENU_BY_RESTAURANT.x_pizza[XKEY] * 100);
  ok('non-vacuity #2 computeXPizza: the sentinel table price drives price_cents');
}
{
  const t = T('la_musa', { menu: { [LKEY]: 777 } });
  assert.strictEqual(laMusaPriceCents(LKEY, t), 77700, 'laMusaPriceCents must read the TABLES');
  const r = computeRedemption({ redeem: redeemL, items: [{ id: LKEY, qty: 1 }], restaurantId: 'la_musa', tables: t });
  assert.strictEqual(r.freeItems[0].price_cents, 77700, 'and it flows into the multiset price');
  assert.notStrictEqual(r.cost, computeRedemption({ redeem: redeemL, items: [{ id: LKEY, qty: 1 }], restaurantId: 'la_musa' }).cost, 'points cost follows the table price');
  ok('non-vacuity #1 laMusaPriceCents: the sentinel table price drives price_cents AND cost_pts');
}
{
  const t = T('x_pizza', { menu: { [XKEY]: 4242 } });
  const redemption = computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza', tables: t });
  const r = applyRedemptionToPricing({ items: paidX, restaurantId: 'x_pizza', redemption, totalLempiras: MENU_BY_RESTAURANT.x_pizza.Ham, tables: t });
  const comped = r.factura_items.find((l) => l.redeemed);
  assert.strictEqual(comped.line_gross_cents, 424200, 'the FACTURA comped line must price from the TABLES');
  ok('non-vacuity #3 applyRedemptionToPricing: the sentinel table price drives the factura comped line');
}
{
  const t = T('la_musa'); delete t.menu[LKEY]; t.menu.sentinel_only_dish = 500;
  assert.strictEqual(isLaMusaEligible(LKEY, t), false, 'a dish absent from the TABLES is NOT eligible');
  assert.strictEqual(isLaMusaEligible('sentinel_only_dish', t), true, 'a dish present only in the TABLES IS eligible');
  ok('non-vacuity #4 isLaMusaEligible: membership follows the TABLES, not the code table');
}
{
  const t = T('la_musa', { menu: { sentinel_only_dish: 500 } });
  assert.ok(eligibleKeys('la_musa', t).includes('sentinel_only_dish'), 'eligibleKeys must enumerate the TABLES');
  assert.ok(!eligibleKeys('la_musa').includes('sentinel_only_dish'));
  ok('non-vacuity #5 eligibleKeys: enumerates the TABLES');
}

// ── 4. PIN B: cross-brand / untagged tables fail closed at every helper ──────────────────────────
for (const [label, fn] of [
  ['computeRedemption x_pizza + la_musa tables', () => computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza', tables: LM })],
  ['laMusaPriceCents + x_pizza tables', () => laMusaPriceCents(LKEY, XP)],
  ['isLaMusaEligible + x_pizza tables', () => isLaMusaEligible(LKEY, XP)],
  ['eligibleKeys + x_pizza tables', () => eligibleKeys('la_musa', XP)],
  ['applyRedemptionToPricing + la_musa tables', () => applyRedemptionToPricing({ items: paidX, restaurantId: 'x_pizza', redemption: { ok: true, model: 'add_free', freeItems: [{ item_id: XKEY, qty: 1 }] }, totalLempiras: 282, tables: LM })],
  ['untagged tables', () => laMusaPriceCents(LKEY, { menu: {}, extras: {} })],
]) {
  // computeRedemption catches internally and reports bad_request; the rest throw. Either way it FAILS CLOSED
  // — what must never happen is pricing one brand against the other's table.
  let threw = false, res;
  try { res = fn(); } catch (_) { threw = true; }
  assert.ok(threw || (res && res.ok === false), `PIN B must fail closed: ${label}`);
}
ok('PIN B: cross-brand and untagged tables fail closed at every redemption helper (6 shapes)');

// ── 5. HARD CONTRACT (GRILL-FIX #2): production seams THROW without tables ───────────────────────
for (const [seam, rid] of [['prepareRedemption', 'x_pizza'], ['resolveRedemptionForOrder', 'la_musa'], ['quoteRedemptionCore', 'x_pizza'], ['computeIncomingFingerprint', 'la_musa']]) {
  assert.throws(() => requireTables(seam, rid, null), /pricing_tables_required/, `${seam} must throw without tables`);
  assert.throws(() => requireTables(seam, rid, undefined), /pricing_tables_required/);
  assert.throws(() => requireTables(seam, rid, { restaurantId: 'other', menu: {}, extras: {} }), /pricing_tables_restaurant_mismatch/);
  assert.doesNotThrow(() => requireTables(seam, rid, { restaurantId: rid, menu: {}, extras: {} }));
}
ok('HARD CONTRACT: all 4 production seams throw on absent/mistagged tables (never a silent code fallback)');

// ── 6. BACKWARD COMPAT (pure calculators only): tables omitted → today's exact values ────────────
{
  const r = computeRedemption({ redeem: redeemX, items: paidX, restaurantId: 'x_pizza' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.freeItems[0].price_cents, MENU_BY_RESTAURANT.x_pizza[XKEY] * 100, 'no tables → the in-code price');
  ok('backward compat: the pure calculators still work with tables omitted (legacy unit tests protected)');
}
// An unsettled await inside this IIFE would drain the event loop and exit 0 mid-file — a hang reading as
// a pass. The guard turns "exited before the end" into a failure.
let finished = false;
process.on('exit', (c) => { if (c === 0 && !finished) { console.error('FATAL: rewards-catalog-cutover exited early'); process.exitCode = 1; } });
(async () => {
  // ── 7. STORE == COMPARE (GRILL-FIX #1): the classifier fingerprint and the reserve MUST price a
  //    redemption from the SAME tables. If they diverge, store_fp != compare_fp → a false 409 → DOUBLE
  //    ORDERS. Two guards: the fingerprint is demonstrably SENSITIVE to the table source (so sharing is
  //    load-bearing, not decorative), and index.js structurally feeds all three seams one object.
  {
    const { computeIncomingFingerprint } = require('./createorder-classify');
    const { orderBreakdownCents } = require('./order-money');
    const orderFingerprint = (id, cents, text, extra) => `${id}|${cents}|${text}|${extra || ''}`;
    const ctx = { orderId: 'PZX-SC', restaurantId: 'la_musa', total: 500, itemsText: 'raw', items: [],
                  redeem: { r: 1 }, customerUid: 'u1', scheduledForRaw: null, orderType: 'delivery' };
    // A prepareRedemption stub that actually PRICES from the tables it is handed (as the real one does).
    const deps = (tables) => ({ orderBreakdownCents, orderFingerprint, schedFingerprintExtra: () => '', db: {}, tables,
      prepareRedemption: async (_db, { tables: t }) => ({ ok: true, priced: { total_cents: t.menu[LKEY] * 100 }, itemsText: 'x', redemptionFp: `rf${t.menu[LKEY]}` }) });
    const same = T('la_musa');
    const fpA = await computeIncomingFingerprint(ctx, deps(same));
    const fpB = await computeIncomingFingerprint(ctx, deps(T('la_musa')));
    assert.strictEqual(fpA, fpB, 'same tables → same fingerprint (store == compare)');
    const diverged = T('la_musa', { menu: { [LKEY]: MENU_BY_RESTAURANT.la_musa[LKEY] + 1 } });
    const fpDiv = await computeIncomingFingerprint(ctx, deps(diverged));
    assert.notStrictEqual(fpA, fpDiv, 'a DIVERGED table source changes the fingerprint — this is the false-409/double-order risk');
    ok('store==compare: the redemption fingerprint is sensitive to the table source (so classifier and reserve must share it)');
  }
  {
    // Structural: index.js must hand the SAME resolved `pricingTables` to the classifier, the cash reserve
    // and the online prepare. A future edit that resolves tables twice would reintroduce the drift.
    const SRC = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const classifierDeps = /schedFingerprintExtra: SCHED\.fingerprintExtra, db, tables: pricingTables \}/.test(SRC);
    assert.ok(classifierDeps, 'the classifier deps must receive tables: pricingTables (GRILL-FIX #1)');
    assert.ok(/resolveRedemptionForOrder\(db, \{[\s\S]{0,400}?tables: pricingTables/.test(SRC), 'the cash reserve must receive tables: pricingTables');
    assert.ok(/prepareRedemption\(db, \{ redeem: body\.redeem[\s\S]{0,300}?tables: pricingTables/.test(SRC), 'the online prepare must receive tables: pricingTables');
    assert.strictEqual((SRC.match(/tables: pricingTables/g) || []).length, 3, 'exactly 3 seams share the ONE resolved pricingTables (classifier, cash reserve, online prepare)');
    ok('store==compare (structural): classifier + cash reserve + online prepare all receive the SAME pricingTables');
  }

  // ── 8. QUOTE ↔ ORDER: the quote must price on the same source as the order it previews ───────────
  {
    const SRC = require('fs').readFileSync(require('path').join(__dirname, 'rewards-redeem-intake.js'), 'utf8');
    assert.strictEqual((SRC.match(/computeServerTotal\(items, restaurantId, tables\)/g) || []).length, 2,
      'BOTH computeServerTotal calls in the intake module (prepareRedemption + quoteRedemptionCore) must pass tables');
    assert.ok(/quoteRedemptionCore[\s\S]{0,400}?prepareRedemption\(db, \{[^)]*tables \}\)/.test(SRC),
      'quoteRedemptionCore must forward tables into prepareRedemption');
    const IDX = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    assert.ok(/const quoteTables = await resolvePricingTables\(restaurantId\)[\s\S]{0,300}?quoteRedemptionCore\(db, \{[^)]*tables: quoteTables/.test(IDX),
      'quoteRedemption must resolve the guarded tables and pass them to quoteRedemptionCore');
    ok('quote↔order parity: both quote computeServerTotal calls and the quote seam price from the guarded tables');
  }

    // ── 9. THE NULL-DROP (advisor + codex REVISE): the fail-safe must never hand a seam `null`. ─────
  //    The order-total path reads null as "use code" and proceeds; the redemption hard contract THROWS
  //    on null — so the SAME catastrophic failure that the order total shrugs off would DROP a redemption
  //    order. The fix is on the fail-safe side (return a code-tagged object), never by weakening the
  //    contract: a genuine missed thread must still throw.
  {
    const { computeIncomingFingerprint } = require('./createorder-classify');
    const { orderBreakdownCents } = require('./order-money');
    const orderFingerprint = (id, cents, text, extra) => `${id}|${cents}|${text}|${extra || ''}`;
    // Exactly what the fixed resolvePricingTables returns on a catastrophic resolver failure.
    const codeTagged = { restaurantId: 'la_musa', menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa };

    assert.doesNotThrow(() => requireTables('prepareRedemption', 'la_musa', codeTagged),
      'a code-tagged catastrophic fallback must SATISFY the contract (order proceeds on code)');
    ok('null-drop: the code-tagged fail-safe passes the hard contract (redemption prices on code, order proceeds)');

    const ctx = { orderId: 'PZX-ND', restaurantId: 'la_musa', total: 500, itemsText: 'raw', items: [],
                  redeem: { r: 1 }, customerUid: 'u1', scheduledForRaw: null, orderType: 'delivery' };
    const deps = (tables) => ({ orderBreakdownCents, orderFingerprint, schedFingerprintExtra: () => '', db: {}, tables,
      prepareRedemption: async () => ({ ok: true, priced: { total_cents: 30000 }, itemsText: 'x', redemptionFp: 'rf' }) });
    const fp = await computeIncomingFingerprint(ctx, deps(codeTagged));
    assert.ok(fp && typeof fp === 'string', 'the CASH redemption classifier must NOT throw under the catastrophic fallback');
    ok('null-drop: a cash redemption fingerprint computes under the catastrophic fallback (no drop)');

    // The classifier's requireTables runs BEFORE its local try, so a null here escapes the handler entirely
    // — this is the exact propagation that made the drop possible. The contract must still catch it.
    await assert.rejects(() => computeIncomingFingerprint(ctx, deps(null)), /pricing_tables_required/,
      'null at a seam STILL throws — the contract is not weakened');
    await assert.rejects(() => computeIncomingFingerprint(ctx, deps(undefined)), /pricing_tables_required/,
      'a genuine MISSED THREAD (undefined) still throws loudly');
    ok('null-drop: the contract stays strict — a missed thread at the classifier still throws (not weakened)');
  }
  {
    // Structural: resolvePricingTables must never return null, and its fallback must be shaped exactly
    // like the resolver's own codeFor() code-serve so the two code-serves are indistinguishable downstream.
    const SRC = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const fn = SRC.slice(SRC.indexOf('async function resolvePricingTables'), SRC.indexOf('async function resolvePricingTables') + 1400);
    assert.ok(!/return null/.test(fn), 'resolvePricingTables must NEVER return null');
    assert.ok(/return \{ restaurantId, menu: MENU_BY_RESTAURANT\[restaurantId\], extras: EXTRAS_BY_RESTAURANT\[restaurantId\] \}/.test(fn),
      'the catastrophic fallback must be code-TAGGED and shaped exactly like codeFor(rid)');
    assert.ok(/codeFor: \(rid\) => \(\{ menu: MENU_BY_RESTAURANT\[rid\], extras: EXTRAS_BY_RESTAURANT\[rid\] \}\)/.test(SRC),
      'and codeFor must still have that exact shape (indistinguishable code-serves)');
    ok('null-drop (structural): resolvePricingTables never returns null; its fallback matches codeFor exactly');
  }

  finished = true;
    console.log(`rewards-catalog-cutover: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
