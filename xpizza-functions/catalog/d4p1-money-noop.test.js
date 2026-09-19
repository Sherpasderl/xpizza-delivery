'use strict';
/**
 * Portal 1D · D4-P1 — THE MONEY CONTROL: P1 CHANGES NO AMOUNT, MEASURED AGAINST PRE-P1 CODE.
 * Run: `node catalog/d4p1-money-noop.test.js`
 *
 * 🔴 WHY A FROZEN GOLDEN AND NOT "RUN BOTH VERSIONS". §8(a) asks for a PRE-P1 control, and pre-P1 code
 * cannot be executed in the same process as P1 — one module registry, one menu-pricing. So the control
 * is a LITERAL captured once from the real producers on pristine pre-P1 code (dc7d9f7), committed, and
 * never regenerated. Regenerating it against P1 would make it agree with whatever P1 does, which is
 * the one thing it exists to refuse. The capture is the reason this file was written BEFORE the first
 * line of P1: after that edit, the control no longer exists to capture.
 *
 * 🔴 THE FLAG-OFF BUILD IS NOT A CONTROL. P1a with identity_rename_enabled OFF still mints, retires and
 * stamps — so comparing P1-flag-off against P1-flag-on would compare two P1s. Only pre-P1 is the control.
 *
 * 🔴 THE DISCOUNT IS FISCAL, NOT A PRICE CUT — and that nearly made this vacuous. add_free "never
 * discounts the CHARGED total... the comp is a FISCAL rebaja carried by desc_rebaja_cents"
 * (rewards-redeem-pricing.js). So computeServerNet is byte-identical with and without the reward: the
 * first version of this golden captured only the net, and its reward leg could not have failed for any
 * input. The observable surface is the redemption pricing — desc_rebaja_cents and the comped factura
 * line — and that is what is frozen here.
 */
const assert = require('assert');
const { computeServerTotal } = require('../menu-pricing');
const { computeServerNet } = require('../compute-server-net');
const { pricedLineItems } = require('../factura/pricing');
const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
const GOLDEN = require('./d4p1-money-precontrol.golden.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-money-noop: FAILED — exited without completing'); process.exitCode = 1; } });

const json = (v) => JSON.parse(JSON.stringify(v));

{
  assert.match(GOLDEN._provenance.captured_from, /^[0-9a-f]{40}$/, 'the golden records the commit it was captured from');
  assert.deepStrictEqual(Object.keys(GOLDEN.brands).sort(), ['la_musa', 'x_pizza'], 'both brands are controlled');
  ok(`the control is a frozen literal captured from ${GOLDEN._provenance.captured_from.slice(0, 7)} (pre-P1)`);
}

for (const rid of ['x_pizza', 'la_musa']) {
  const g = GOLDEN.brands[rid];
  const { cart, reward, tables } = g.input;

  /* Priced from the golden's OWN inputs, so the comparison cannot drift onto a different cart. */
  {
    assert.deepStrictEqual(json(computeServerTotal(json(cart), rid, tables)), g.total,
      `🔴 ${rid}: P1 moved the CHARGED TOTAL against pre-P1`);
    assert.deepStrictEqual(json(computeServerNet({ items: json(cart), reward: null, rid, tables })), g.net_plain,
      `🔴 ${rid}: P1 moved the 1C NET against pre-P1`);
    assert.deepStrictEqual(json(computeServerNet({ items: json(cart), reward, rid, tables })), g.net_reward,
      `🔴 ${rid}: P1 moved the 1C NET under a reward against pre-P1`);
    assert.deepStrictEqual(json(applyRedemptionToPricing({ items: json(cart), restaurantId: rid, redemption: reward, totalLempiras: g.total.total, tables })), g.redemption,
      `🔴 ${rid}: P1 moved the REDEMPTION pricing (desc_rebaja / comped factura line) against pre-P1`);
    if (rid === 'x_pizza') {
      assert.deepStrictEqual(json(pricedLineItems(json(cart), tables.menu, tables.extras)), g.factura,
        `🔴 ${rid}: P1 moved the FISCAL LINES against pre-P1`);
    }
    ok(`${rid}: charged total, 1C net (plain + reward), redemption pricing${rid === 'x_pizza' ? ' and factura lines' : ''} are byte-identical to pre-P1`);
  }

  /* 🔴 SENSITIVITY — the comparison above is between two things that CAN differ. A golden compared
     against a constant passes forever; these assert the frozen values respond to a real change. */
  {
    const dearer = json(cart); dearer[0].qty += 1;
    const moved = computeServerTotal(dearer, rid, tables);
    assert.notDeepStrictEqual(json(moved), g.total, `🔴 ${rid}: the total does not respond to quantity — the golden is a constant`);
    assert.deepStrictEqual(json(moved), g.sensitivity_dearer_total, `${rid}: …and it responds by exactly the pre-P1 amount`);
    assert.ok(g.redemption.ok === true, `${rid}: premise — the reward leg actually priced`);
    if (rid === 'x_pizza') {
      assert.ok(g.redemption.desc_rebaja_cents > 0,
        '🔴 x_pizza: the frozen discount is zero — the reward leg would pass for any input');
      assert.strictEqual(g.redemption.factura_items.length, g.factura.items.length + 1,
        '🔴 x_pizza: the comped line is not in the frozen factura — the discount is not observable');
    }
    ok(`${rid}: the golden is not a constant — quantity moves the total to the frozen dearer value, and the discount is observable`);
  }
}

FINISHED = true;
console.log(`\nd4p1-money-noop: ${n} checks passed`);
