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
const { computeRedemption } = require('../rewards-redeem');
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

  /* ── 🔴 THE SERVER MUST NOT TRUST THE CLIENT ABOUT MONEY, AND THIS CONTROL COULD NOT SEE IT ──────
     THE HOLE, found by an independent gate on 2026-09-26 and reproduced before fixing: every check
     above passes with `computeServerTotal` MUTATED TO READ `it.price` — the client's own claim —
     because THE GOLDEN'S CART CARRIES PRICES EQUAL TO THE SERVER TABLES. 385 and 385. So the single
     worst regression this system can have, the server starting to believe the client about money, was
     invisible to the control built to prove money did not move. Both brands, and the emulator control
     had the same blind spot.

     🔴 WHY THIS IS A FORGED-INPUT ASSERTION AND NOT A CHANGE TO THE FIXTURE'S PRICES. Making the
     golden's cart carry differing prices would make the five checks above sensitive today — and would
     silently stop being sensitive the moment anyone REGENERATES the golden from a real order, because a
     real cart's client prices DO equal the menu's. The sensitivity would be an accident of fixture
     values again, one regeneration away from gone. Asserting independence directly cannot rot that way:
     it says what must be true rather than arranging for it to show.
     Verified before writing it: forging every client price to 1 leaves all five outputs byte-identical,
     so this asserts a property the code already has rather than pinning a behaviour it lacks. */
  {
    const forged = json(cart).map((it) => ({ ...it, price: 1, extras: (it.extras || []).map((e) => ({ ...e, price: 1 })) }));
    /* premise: the forgery is real — the cart really did carry the server's prices before it. */
    assert.ok(json(cart).some((it) => it.price !== 1), `premise — ${rid}'s golden cart carries real prices to forge away from`);

    assert.deepStrictEqual(json(computeServerTotal(json(forged), rid, tables)), g.total,
      `🔴 ${rid}: THE CHARGED TOTAL CHANGED WHEN THE CLIENT CLAIMED price=1 — the server is trusting the client about money, which is the worst regression in this system`);
    assert.deepStrictEqual(json(computeServerNet({ items: json(forged), reward: null, rid, tables })), g.net_plain,
      `🔴 ${rid}: the 1C NET moved on a forged client price`);
    assert.deepStrictEqual(json(computeServerNet({ items: json(forged), reward, rid, tables })), g.net_reward,
      `🔴 ${rid}: the 1C NET under a reward moved on a forged client price`);
    assert.deepStrictEqual(json(applyRedemptionToPricing({ items: json(forged), restaurantId: rid, redemption: reward, totalLempiras: g.total.total, tables })), g.redemption,
      `🔴 ${rid}: the REDEMPTION pricing moved on a forged client price — a discount computed from a client-supplied price is a discount the client chooses`);
    if (rid === 'x_pizza') {
      assert.deepStrictEqual(json(pricedLineItems(json(forged), tables.menu, tables.extras)), g.factura,
        '🔴 x_pizza: THE FISCAL LINES moved on a forged client price — the SAR line would carry a number the client picked');
    }
    ok(`${rid}: every priced output is IDENTICAL when the cart claims price=1 — the server prices from its own tables, and a regression that trusted the client would fail here`);
  }

  /* ── 🔴 THE REWARD MUST BE RESOLVED BY THE REAL PRODUCER, NOT SUPPLIED ALREADY-RESOLVED ──────────
     THE HOLE: `g.input.reward` is an already-resolved redemption, so every reward assertion above
     drives only the DOWNSTREAM pricing. Reward SELECTION and its own pricing — `computeRedemption`,
     the thing that decides which item is free and what it is worth — were outside the control
     entirely. A control that proves "no money moved" while never redeeming anything is proving
     something narrower than its name.
     🔴 WHAT IS FROZEN HERE IS THE REQUEST, NOT A NEW EXPECTED VALUE. The golden is a pre-P1 capture;
     adding an expected output captured from TODAY's code would freeze P1's behaviour while claiming
     pre-P1 provenance, which is the one thing the control exists to refuse. So the `redeem` request is
     derived from the golden's own frozen reward, `computeRedemption` is driven with it, and the
     comparison is still against the PRE-P1 values: if P1 had moved reward selection or reward pricing,
     the derived reward would price differently downstream and these would fail.
     Verified before writing: the real producer returns a SUPERSET of the golden's reward
     (`cost`, `discount_cents`, `canonical`), and the extra fields change no downstream output — so the
     golden's trimmed literal was harmless, and this asserts the same numbers through the real path. */
  {
    const redeem = rid === 'x_pizza'
      ? { type: 'free_pizza_choice', item_id: reward.freeItems[0].item_id }
      : { type: 'points_ala_carte', items: reward.freeItems.map((f) => ({ id: f.item_id, qty: f.qty })) };
    const resolved = computeRedemption({ redeem, items: json(cart), restaurantId: rid });

    assert.strictEqual(resolved.ok, true, `🔴 ${rid}: the REAL reward producer refused the golden's own redemption — ${JSON.stringify(resolved).slice(0, 200)}`);
    assert.strictEqual(resolved.model, reward.model, `🔴 ${rid}: the resolved reward MODEL moved against pre-P1`);
    /* 🔴 EVERY FIELD THE GOLDEN FROZE, NOT EVERY FIELD THE PRODUCER EMITS. The pre-P1 capture was
       hand-trimmed: la_musa's real freeItems carry `cost_pts` and x_pizza's do not appear in the golden
       with `cost`/`discount_cents` either. A deepStrictEqual here fails on the TRIMMING rather than on
       money moving — I wrote it that way first and la_musa refused, which is the assertion being wrong
       about the golden rather than the code being wrong about the reward. So: the real output must agree
       on every field the control actually froze, and may carry more. Extra fields were verified not to
       change any downstream output, which is why they were safe to trim and are safe to ignore. */
    assert.strictEqual(resolved.freeItems.length, reward.freeItems.length,
      `🔴 ${rid}: the real producer chose a DIFFERENT NUMBER of free items than the pre-P1 control`);
    reward.freeItems.forEach((frozen, i) => {
      for (const k of Object.keys(frozen)) {
        assert.deepStrictEqual(json(resolved.freeItems[i][k]), json(frozen[k]),
          `🔴 ${rid}: REWARD SELECTION OR ITS PRICING MOVED — freeItems[${i}].${k} is ${JSON.stringify(resolved.freeItems[i][k])}, pre-P1 froze ${JSON.stringify(frozen[k])}`);
      }
    });

    /* …and the downstream legs re-run on the DERIVED reward rather than the stored literal, so the
       whole chain selection → pricing → net/factura is inside the control. */
    assert.deepStrictEqual(json(computeServerNet({ items: json(cart), reward: resolved, rid, tables })), g.net_reward,
      `🔴 ${rid}: the 1C NET moved when the reward came from the REAL producer instead of the stored literal`);
    assert.deepStrictEqual(json(applyRedemptionToPricing({ items: json(cart), restaurantId: rid, redemption: resolved, totalLempiras: g.total.total, tables })), g.redemption,
      `🔴 ${rid}: the REDEMPTION pricing moved when the reward came from the REAL producer`);
    ok(`${rid}: the reward is RESOLVED by computeRedemption from a frozen request — selection, reward pricing and the downstream net/redemption all match pre-P1`);
  }
}

FINISHED = true;
console.log(`\nd4p1-money-noop: ${n} checks passed`);
