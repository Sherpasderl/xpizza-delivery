// Portal 1D · D2 — THE CART CARRIES THE ID, AND THE THREE CLIENT SIGNATURES DO NOT SEE IT.
// Run: node cart-identity.test.mjs
//
// 🔴 WHAT IS ACTUALLY AT RISK. D1 kept the catalog id out of the browser entirely. D2 lets it into
// every cart line and every order and quote body — and three client signatures hash the RAW emitted
// items. If the id reaches them, all three move, and each one is customer-visible:
//   B confirmQuoteCartSig  → the quote token fails to attach
//   C redeemSig            → a valid reward order is blocked from sending as a "stale quote"
//   D serverQuoteCartKey   → an equivalent cached total is discarded and re-quoted needlessly
// So each hashes a DEEP legacy projection instead. Every cell below compares a page served an
// identity-bearing menu against a page served the same menu without ids, and demands the signatures
// be the same STRING — not merely the same fields, because these are JSON.stringify output and key
// order is part of the value.
//
// The nested extra is the trap and gets its own cells: D1's stripIdentity is shallow, so a projection
// that reused it would pass every dish-level test and leave the option half live.
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
const { computeRedemption } = require('./rewards-redeem');
const { pricedLineItems } = require('./factura/pricing');
const { usesPlatformFactura } = require('./factura/eligibility');

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];

/* A served body, with identity on the dish, on the nested extra, on both, or on neither. Built from
   the page's OWN live menu (BRAND[dir].menu) so it is the shape the real applier validates. */
function bodyFor(dir, w, { dishIds, extraIds, equalizeExtras }) {
  const body = BRAND[dir].menu(w);
  body.dishes = body.dishes.map((d) => (dishIds ? { ...d, dish_id: `ID_dish_${d.id}` } : { ...d }));
  body.extras = body.extras.map((e) => (extraIds ? { ...e, extra_id: `ID_extra_${e.id}` } : { ...e }));
  /* 🔴 THE SAME-PRICE PAIR IS CONSTRUCTED WHERE THE CATALOG DOES NOT HAPPEN TO OFFER ONE. x_pizza has
     two options at 39; la_musa has no natural pair. The control it enables — swapping one option for
     another of identical price — is the only way to show the projection did not take the legacy option
     SELECTION along with the identity, so it is built rather than skipped on the brand that lacks one.
     Pricing a served option is exactly the portal's own prerogative, so this is a menu the system can
     really serve, not a shape invented to make a test pass. */
  if (equalizeExtras && body.extras.length > 1) {
    body.extras = body.extras.map((e, i) => (i === 1 ? { ...e, price: body.extras[0].price } : e));
  }
  return body;
}

/* One page, carrying one cart, with the menu applied through the REAL refresh adapter and installed
   through the real setter — not by assigning globals a test invented. Then the cart is built with the
   form's own quantity control and its own extra toggle, so what is signed below is what a customer's
   taps would have produced. */
async function pageWithCart(dir, identity) {
  const w = loadForm(dir);
  const prepared = w.liveMenuPrepare(bodyFor(dir, w, identity));
  w.liveMenuGlobalSet('MENU', prepared.MENU);
  w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();

  const dish = prepared.MENU.find((d) => d.price > 0);
  w.chg(dish.id, 1);
  await settle();
  const extra = prepared.EXTRAS[0];
  w.toggleDetailExtra(extra.id, dish.id, 0);        // the real UI setter
  await settle();
  return { w, dish, extra };
}

const sigsOf = (w) => ({
  B: w.confirmQuoteCartSig(),
  C: w.__ACCOUNT.redeemSig(w.redeemCartItems(), null, 'v1'),
  D: w.serverQuoteCartKey(),
});

(async () => {
  for (const dir of DIRS) {
    // ── 1. THE PREMISE: the cart really does carry both ids ─────────────────────────────────────
    /* Every stability claim below is worthless if the ids never arrived. This is the cell that makes
       the rest non-vacuous, and it is also D2's own deliverable. */
    const both = await pageWithCart(dir, { dishIds: true, extraIds: true });
    const emitted = both.w.redeemCartItems();
    assert.ok(emitted.length > 0, `${dir}: premise — the cart has a line`);
    assert.ok(emitted[0].dish_id, `${dir}: 🔴 the emitted line carries dish_id — this is what D2 is for`);
    assert.ok(emitted[0].extras.length > 0, `${dir}: premise — the line has an option on it`);
    assert.ok(emitted[0].extras[0].extra_id, `${dir}: 🔴 …and the NESTED option carries extra_id`);
    ok(`${dir}: the emitted cart carries dish_id AND a nested extra_id`);

    // ── 2. THE CORE — B/C/D ARE BYTE-IDENTICAL WITH AND WITHOUT IDENTITY ───────────────────────
    const none = await pageWithCart(dir, { dishIds: false, extraIds: false });
    const dishOnly = await pageWithCart(dir, { dishIds: true, extraIds: false });
    const extraOnly = await pageWithCart(dir, { dishIds: false, extraIds: true });

    const base = sigsOf(none.w);
    assert.ok(base.B && base.C && base.D, `${dir}: premise — all three signatures compute (${JSON.stringify(base)})`);

    for (const [label, page] of [['dish id only', dishOnly], ['NESTED EXTRA id only', extraOnly], ['both ids', both]]) {
      const got = sigsOf(page.w);
      assert.strictEqual(got.B, base.B, `${dir}/${label}: 🔴 confirmQuoteCartSig moved — the quote token would fail to attach`);
      assert.strictEqual(got.C, base.C, `${dir}/${label}: 🔴 redeemSig moved — a valid reward order would be blocked from sending`);
      assert.strictEqual(got.D, base.D, `${dir}/${label}: 🔴 serverQuoteCartKey moved — an equivalent cached total would be discarded`);
    }
    /* 🔴 THE SHALLOW-STRIP TRAP, NAMED. The extra-only page is the one that catches a projection
       built on stripIdentity: with no dish_id anywhere, a shallow strip is a no-op and the nested
       extra_id goes straight into all three signatures. */
    ok(`${dir}: B, C and D are byte-identical across dish-only, EXTRA-only and both-ids carts`);

    // ── 3. BOTH D SITES AGREE ──────────────────────────────────────────────────────────────────
    /* The producer stores its key on __serverQuote; the consumer recomputes it. Two spellings of "the
       same cart" would make every cached total look stale and re-quote forever — a live defect with
       no error message, so it is asserted rather than assumed. */
    {
      const w = both.w;
      /* 🔴 READ THE PRODUCER'S OWN KEY, not a reconstruction of it. requestServerQuote stamps the key
         it computed onto __serverQuote.inflightKey the moment it issues, so this is literally the
         string that site produced — no network needed, and no second implementation in the test that
         could agree with the consumer while the real producer disagreed. */
      w.requestServerQuote(true);
      await settle();
      const producer = w.__serverQuote && w.__serverQuote.inflightKey;
      assert.ok(producer, `${dir}: premise — the producer computed and stamped a key`);
      assert.ok(!/dish_id|extra_id/.test(producer),
        `${dir}: 🔴 the PRODUCER's key carries identity — the request-dedup key would change under a backfill: ${producer}`);

      /* 🔴 THE EQUALITY ITSELF, WHICH THIS CELL PREVIOUSLY ONLY CLAIMED IN ITS LABEL. Checking that the
         producer's key exists and names no identity field does not make it the CONSUMER's key: append
         anything to one site and both of those assertions still hold while the two sites disagree —
         and disagreement is the actual defect, a cached total that never matches and therefore
         re-quotes forever. Asserted for every identity shape, because the two sites could agree on a
         dish-only cart and diverge on a nested extra. */
      for (const [label, page] of [['dish id only', dishOnly], ['NESTED EXTRA id only', extraOnly], ['both ids', both]]) {
        page.w.requestServerQuote(true);
        await settle();
        const p = page.w.__serverQuote && page.w.__serverQuote.inflightKey;
        assert.ok(p, `${dir}/${label}: premise — the producer stamped a key`);
        assert.strictEqual(p, page.w.serverQuoteCartKey(),
          `${dir}/${label}: 🔴 the requestServerQuote PRODUCER and the serverQuoteCartKey CONSUMER disagree — every cached total would look stale`);
        assert.strictEqual(p, base.D,
          `${dir}/${label}: 🔴 …and both must equal the key an id-less cart produces`);
      }
      ok(`${dir}: the producer and consumer keys are EQUAL, and equal to the id-less key, for all three identity shapes`);
    }

    // ── 4. POSITIVE CONTROLS — THE PROJECTION TOOK ONLY IDENTITY ───────────────────────────────
    /* A projection that over-stripped would make these signatures stable across changes that MUST
       invalidate them, which is far worse than the bug it was written to prevent: the token would keep
       attaching to a cart it no longer describes. */
    {
      const w = both.w;
      const before = sigsOf(w);

      w.chg(both.dish.id, +1);                      // chg() is a DELTA, not a setter
      await settle();
      const afterQty = sigsOf(w);
      assert.notStrictEqual(afterQty.B, before.B, `${dir}: 🔴 a quantity change MUST move B`);
      assert.notStrictEqual(afterQty.C, before.C, `${dir}: 🔴 …and C`);
      assert.notStrictEqual(afterQty.D, before.D, `${dir}: 🔴 …and D`);
      w.chg(both.dish.id, -1);
      await settle();
      assert.strictEqual(sigsOf(w).B, before.B,
        `${dir}: …and putting the quantity back restores B exactly — the control moves it, it does not just perturb it`);

      /* 🔴 THE SAME-PRICE EXTRA SWAP — the control that proves the strip did not take the legacy
         option SELECTION with it. Swapping one option for another of EQUAL price changes nothing a
         total would notice, so only the option's legacy identity distinguishes the two carts. If the
         projection had removed that too, these signatures would be identical and a customer could
         swap an option after the quote without invalidating it. */
      const swap = await pageWithCart(dir, { dishIds: true, extraIds: true, equalizeExtras: true });
      const sw = swap.w;
      const alt = sw.liveMenuGlobalGet('EXTRAS').find((e) => e.id !== swap.extra.id && e.price === swap.extra.price);
      assert.ok(alt, `${dir}: premise — an equal-priced alternative option exists to swap to`);
      const beforeSwap = sigsOf(sw);
      const totalBeforeSwap = sw.redeemCartItems()[0].extrasTotal;   // captured BEFORE — see below
      sw.toggleDetailExtra(swap.extra.id, swap.dish.id, 0);   // off
      sw.toggleDetailExtra(alt.id, swap.dish.id, 0);          // on — identical price, different option
      await settle();
      const swapped = sigsOf(sw);
      /* 🔴 PRE VERSUS POST. This read the same page twice AFTER the swap and compared it to itself,
         which is true of any cart and proved nothing — the premise that makes this control meaningful
         (that the swap moved no money, so only the legacy option identity differs) was never actually
         checked. */
      assert.strictEqual(sw.redeemCartItems()[0].extrasTotal, totalBeforeSwap,
        `${dir}: premise — the swap really is price-neutral, so only the legacy option identity differs`);
      assert.notStrictEqual(swapped.B, beforeSwap.B, `${dir}: 🔴 a SAME-PRICE option swap must still move B — the legacy selection survived the projection`);
      assert.notStrictEqual(swapped.C, beforeSwap.C, `${dir}: 🔴 …and C`);
      assert.notStrictEqual(swapped.D, beforeSwap.D, `${dir}: 🔴 …and D`);
      /* 🔴 THE REST OF THE CONTROLS. Quantity and an option swap are two ways a cart can change; a
         projection that over-stripped could still be stable across the others. Each of these must move
         the binding that owns it, or the token would keep attaching to a cart it no longer describes. */
      {
        /* A PRICE change, applied to the menu the cart is built FROM. Re-pricing the live menu after a
           line is already in the cart deliberately does NOT move these signatures — form-cart captures
           the record at add time so a live re-price cannot silently change what the customer agreed
           to, which is 1B's design and not something D2 may undo. So the control prices the dish
           differently at the point the cart is built, which is the change that must invalidate. */
        const pricedPage = loadForm(dir);
        const pricedBody = bodyFor(dir, pricedPage, { dishIds: true, extraIds: true });
        pricedBody.dishes = pricedBody.dishes.map((d) => ({ ...d, price: d.price + 25 }));
        const pp = pricedPage.liveMenuPrepare(pricedBody);
        pricedPage.liveMenuGlobalSet('MENU', pp.MENU);
        pricedPage.liveMenuGlobalSet('EXTRAS', pp.EXTRAS);
        await settle();
        const pd = pp.MENU.find((x) => x.price > 0);
        pricedPage.chg(pd.id, 1);
        await settle();
        pricedPage.toggleDetailExtra(pp.EXTRAS[0].id, pd.id, 0);
        await settle();
        const afterPrice = sigsOf(pricedPage);
        assert.notStrictEqual(afterPrice.B, base.B, `${dir}: 🔴 a PRICE change must move B`);
        assert.notStrictEqual(afterPrice.D, base.D, `${dir}: 🔴 …and D`);
        assert.notStrictEqual(afterPrice.C, base.C, `${dir}: 🔴 …and C`);

        // AN ORDER FIELD — cartSig is the binding that owns customer fields, and it must move.
        const fieldPage = await pageWithCart(dir, { dishIds: true, extraIds: true });
        const beforeField = fieldPage.w.cartSig();
        const nameEl = fieldPage.w.document.getElementById('cname');
        nameEl.value = 'Otro Cliente';
        await settle();
        assert.notStrictEqual(fieldPage.w.cartSig(), beforeField,
          `${dir}: 🔴 an ORDER FIELD change must move cartSig — otherwise the same cart returns a stale order`);

        // A REWARD SELECTION — B and C both carry the pending reward.
        const rw = await pageWithCart(dir, { dishIds: true, extraIds: true });
        const beforeReward = sigsOf(rw.w);
        const reward = { type: 'free_pizza_choice', item_id: 'X' };
        /* B reads the pending reward off __ACCOUNT, so it moves when the selection does. C takes the
           pending reward as an ARGUMENT — sigsOf passes null deliberately, so that every identity
           comparison in this file isolates the cart — which means the control has to supply it the way
           the real caller does rather than by monkey-patching a getter C never consults. */
        rw.w.__ACCOUNT.getRedeemPayload = () => reward;
        await settle();
        assert.notStrictEqual(sigsOf(rw.w).B, beforeReward.B, `${dir}: 🔴 a REWARD selection must move B`);
        assert.notStrictEqual(
          rw.w.__ACCOUNT.redeemSig(rw.w.redeemCartItems(), reward, 'v1'),
          beforeReward.C,
          `${dir}: 🔴 …and C, which gates the send`);
      }
      ok(`${dir}: qty, a SAME-PRICE option swap, a price change, an order field and a reward selection each still invalidate the binding that owns it`);
    }

    // ── 5. THE BODY CARRIES THE IDS WHILE THE KEY DOES NOT — FROM THE SAME CALL ────────────────
    /* 🔴 THE WHOLE POINT OF D2 IN ONE ASSERTION. requestServerQuote serializes the cart twice: once
       into the dedup KEY (projected) and once into the request BODY (not). If the projection leaked
       into the body, D2 would have shipped a cart that still carries no identity and D3/D4 would have
       nothing to read — with every test above still green, because they only ever look at signatures.
       Captured from the real fetch, not reconstructed. */
    {
      /* 🔴 THE REQUEST THE APP MAKES ON ITS OWN, not one forced afterwards. Adding a line already
         fires a quote, and requestServerQuote then returns early for that same cart
         (`inflightKey === key`) — so a forced second call issues nothing and this cell would fail its
         own premise. The responder is therefore installed BEFORE the cart is built, and what is
         asserted below is the body of the customer's real first quote. */
      const w = loadForm(dir);
      let sentBody = null;
      w.__respond = (url, init) => { if (String(url).includes('quoteOrder')) sentBody = init && init.body; return new Promise(() => {}); };
      const prepared = w.liveMenuPrepare(bodyFor(dir, w, { dishIds: true, extraIds: true }));
      w.liveMenuGlobalSet('MENU', prepared.MENU);
      w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
      await settle();
      const d5 = prepared.MENU.find((x) => x.price > 0);
      w.chg(d5.id, 1);
      await settle();
      w.toggleDetailExtra(prepared.EXTRAS[0].id, d5.id, 0);
      await settle();
      w.requestServerQuote(true);
      await settle();
      assert.ok(sentBody, `${dir}: premise — a quote request was actually issued`);
      const parsed = JSON.parse(sentBody);
      const line = (parsed.items || [])[0];
      assert.ok(line, `${dir}: premise — the body carries the cart`);
      assert.ok(line.dish_id, `${dir}: 🔴 the request BODY must carry dish_id — this is what D3/D4 will read`);
      assert.ok(line.extras && line.extras[0] && line.extras[0].extra_id,
        `${dir}: 🔴 …and the NESTED extra_id, which is the half a shallow projection would have eaten`);
      const key = w.__serverQuote.inflightKey;
      assert.ok(!/dish_id|extra_id/.test(key),
        `${dir}: 🔴 …while the KEY computed in the same call carries neither`);
      ok(`${dir}: one call, two serializations — the body carries both ids, the dedup key carries neither`);
    }

    // ── 6. THE PROJECTION DOES NOT MUTATE THE CART IT PROJECTS ────────────────────────────────
    /* A mutating projection would strip the ids out of the very array about to be sent, and cell 5
       would still pass on whichever call happened to run first. */
    {
      const w = both.w;
      const items = w.redeemCartItems();
      const snapshot = JSON.stringify(items);
      w.confirmQuoteCartSig(); w.serverQuoteCartKey(); w.__ACCOUNT.redeemSig(items, null, 'v1');
      assert.strictEqual(JSON.stringify(items), snapshot,
        `${dir}: 🔴 computing all three signatures left the cart array untouched`);
      assert.ok(/dish_id/.test(snapshot) && /extra_id/.test(snapshot), `${dir}: non-vacuity — it had ids to lose`);
      ok(`${dir}: computing B, C and D mutates nothing — the body still carries what it carried`);
    }

    // ── 7. A MENU SERVED WITHOUT IDS STILL EMITS A LEGACY-VALID CART ──────────────────────────
    /* The pre-backfill and overlay-failure case, which is a real serving state: D1's overlay serves
       id-absent whenever the registry read fails. The cart must then be byte-identical to what a
       pre-D2 client emitted — no `dish_id: undefined` key, no empty string. */
    {
      const bare = none.w.redeemCartItems();
      assert.ok(!('dish_id' in bare[0]), `${dir}: 🔴 no dish_id KEY at all when the menu carries none`);
      assert.ok(bare[0].extras.length && !('extra_id' in bare[0].extras[0]),
        `${dir}: 🔴 …and none on the nested option either`);
      const projectedFromIdentity = JSON.parse(both.w.serverQuoteCartKey());
      assert.deepStrictEqual(JSON.parse(JSON.stringify(bare)), projectedFromIdentity,
        `${dir}: 🔴 an id-less cart and a projected identity-bearing cart are the SAME object`);
      ok(`${dir}: a menu served without ids emits exactly the pre-D2 cart`);
    }

    // ── 8. THE SERVER IS UNMOVED BY THE ID — OVER THE REAL EMITTED CARTS ──────────────────────
    /* The six server bindings are id-blind by construction: they project fields or hash items_text.
       "By construction" is the argument; this is the measurement, and it is taken over the carts the
       FORM actually emitted rather than shapes composed here — the whole D1 lesson was that a fixture
       built from an imagined producer agrees with the code and proves nothing. */
    {
      const rid = BRAND[dir].rid;
      const withIds = both.w.redeemCartItems();
      const without = none.w.redeemCartItems();
      const tables = { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] };

      assert.ok(JSON.stringify(withIds).includes('dish_id') && JSON.stringify(withIds).includes('extra_id'),
        `${dir}: premise — the identity-bearing cart really carries both ids`);
      assert.ok(!/dish_id|extra_id/.test(JSON.stringify(without)), `${dir}: premise — the other one carries neither`);

      // THE QUOTE FINGERPRINT — what a signed token binds to. A shift here is a token that cannot verify.
      assert.strictEqual(
        cartFingerprint(normalizeCartForFingerprint(withIds, rid), null),
        cartFingerprint(normalizeCartForFingerprint(without, rid), null),
        `${dir}: 🔴 identity moved the server's cart fingerprint — every issued token would fail`);
      // SENSITIVITY: the same cart at a different quantity must fingerprint differently.
      assert.notStrictEqual(
        cartFingerprint(normalizeCartForFingerprint(JSON.parse(JSON.stringify(without)).map((l, i) => (i ? l : { ...l, qty: l.qty + 1 })), rid), null),
        cartFingerprint(normalizeCartForFingerprint(without, rid), null),
        `${dir}: 🔴 the cart FINGERPRINT is not sensitive to a quantity change — it could be a constant`);

      // THE CHARGED TOTAL.
      const a = computeServerTotal(withIds, rid, tables);
      const b = computeServerTotal(without, rid, tables);
      assert.ok(!b.error, `${dir}: premise — the id-less cart prices cleanly (${b.error})`);
      assert.deepStrictEqual(a, b, `${dir}: 🔴 identity moved the CHARGED TOTAL`);
      assert.ok(b.total > 0, `${dir}: …of a real amount (${b.total})`);
      /* 🔴 SENSITIVITY. An invariance assertion alone cannot fail when its mechanism is broken: make
         computeServerTotal return a constant and BOTH sides go constant and stay equal. So every
         "identity changed nothing about X" in this file is paired with a legitimate change that X MUST
         notice. Together they say what is actually claimed — X is sensitive to real changes and blind
         to the id — where either alone says almost nothing. */
      const moreQty = JSON.parse(JSON.stringify(without));
      moreQty[0].qty += 1;
      assert.notStrictEqual(computeServerTotal(moreQty, rid, tables).total, b.total,
        `${dir}: 🔴 the CHARGED TOTAL is not sensitive to a quantity change — it could be a constant and the equality above would still hold`);

      // THE REWARD and its canonical — the thing a reservation binds to.
      const raw = rid === 'la_musa'
        ? { type: 'points_ala_carte', items: [{ id: without[0].id, qty: 1 }] }
        : { type: 'free_pizza_choice', item_id: without[0].name };
      const ra = computeRedemption({ redeem: raw, items: withIds, restaurantId: rid });
      const rb = computeRedemption({ redeem: raw, items: without, restaurantId: rid });
      assert.ok(rb && rb.ok, `${dir}: premise — the reward resolves without identity (${rb && rb.reason})`);
      assert.deepStrictEqual(ra, rb, `${dir}: 🔴 identity moved the REWARD resolution`);
      // SENSITIVITY: a different reward request must resolve differently.
      const otherRaw = rid === 'la_musa'
        ? { type: 'points_ala_carte', items: [{ id: without[0].id, qty: 2 }] }
        : { type: 'free_pizza_choice', item_id: 'Not A Real Dish' };
      const rOther = computeRedemption({ redeem: otherRaw, items: without, restaurantId: rid });
      assert.notDeepStrictEqual(rOther, rb,
        `${dir}: 🔴 the REWARD resolution is not sensitive to the reward asked for — it could be a constant`);
      assert.ok(!JSON.stringify(ra.canonical).includes('ID_'), `${dir}: 🔴 …and no id value reached its canonical`);

      // THE FACTURA — asserted per brand, so flipping the predicate cannot silently skip it.
      assert.strictEqual(usesPlatformFactura(rid), rid === 'x_pizza',
        `${dir}: 🔴 platform-factura eligibility moved — the fiscal comparison would stop running`);
      if (usesPlatformFactura(rid)) {
        const fa = pricedLineItems(withIds, tables.menu, tables.extras);
        const fb = pricedLineItems(without, tables.menu, tables.extras);
        assert.ok(!fb.error && fb.items.length > 0, `${dir}: premise — fiscal lines exist (${fb.error})`);
        assert.deepStrictEqual(fa, fb, `${dir}: 🔴 identity moved the FACTURA lines`);
        // SENSITIVITY: more of the same dish must move the fiscal lines.
        assert.notDeepStrictEqual(pricedLineItems(moreQty, tables.menu, tables.extras), fb,
          `${dir}: 🔴 the FACTURA lines are not sensitive to a quantity change — they could be constant`);
        assert.ok(!JSON.stringify(fa).includes('ID_'), `${dir}: 🔴 …and no id VALUE reached a fiscal line`);
      }
      ok(`${dir}: fingerprint, charged total, reward canonical and factura are byte-identical with the id present`);
    }

    // ── 9. THE TRANSITION — THE BACKFILL LANDS WHILE A CUSTOMER IS MID-ORDER ──────────────────
    /* THE REAL D2 ROLLOUT EVENT. A customer builds a cart against a menu with no ids; the live-menu
       refresh then brings the same menu WITH ids, because the backfill just ran. That is not a
       hypothetical — it is what the deploy does.
       The claim is precise, and deliberately not "seamless": a live apply ALREADY clears the displayed
       quote cache and requests a re-quote, identity or not. What D2 must not add is NEW friction — so
       every signature must be unchanged across the transition. If they moved, the token would fail to
       attach and the reward send would be blocked, on top of the re-quote that always happens.
       cartSig is checked too: it drives order_id reuse, so a shift would give the same customer a
       second order id for the same cart. */
    {
      const w = none.w;                                  // a cart built on an id-less menu
      const beforeSigs = sigsOf(w);
      const beforeCartSig = w.cartSig();
      const beforeItems = JSON.stringify(w.redeemCartItems());

      const enriched = w.liveMenuPrepare(bodyFor(dir, w, { dishIds: true, extraIds: true }));
      w.liveMenuGlobalSet('MENU', enriched.MENU);
      w.liveMenuGlobalSet('EXTRAS', enriched.EXTRAS);
      await settle();

      const afterSigs = sigsOf(w);
      assert.strictEqual(afterSigs.B, beforeSigs.B, `${dir}/transition: 🔴 the quote token would stop attaching mid-order`);
      assert.strictEqual(afterSigs.C, beforeSigs.C, `${dir}/transition: 🔴 the reward send would be blocked mid-order`);
      assert.strictEqual(afterSigs.D, beforeSigs.D, `${dir}/transition: 🔴 the displayed total would be discarded and re-quoted needlessly`);
      assert.strictEqual(w.cartSig(), beforeCartSig,
        `${dir}/transition: 🔴 cartSig moved — the same cart would be handed a SECOND order_id`);

      /* NON-VACUITY: the transition really happened. The cart is unchanged in its legacy fields and
         the MENU genuinely gained identity — otherwise every equality above is trivially true. */
      assert.ok(enriched.MENU.every((d) => d.dish_id), `${dir}/transition: premise — the refreshed menu really carries ids`);
      const afterItems = w.redeemCartItems();
      assert.strictEqual(JSON.stringify(afterItems.map((l) => [l.name, l.qty, l.price])),
        JSON.stringify(JSON.parse(beforeItems).map((l) => [l.name, l.qty, l.price])),
        `${dir}/transition: the cart's legacy content is unchanged across the apply`);
      ok(`${dir}: a backfill landing mid-order changes no signature — B, C, D and cartSig all hold`);
    }

    // ── 10. THE RESUME/RELOAD TRANSITION — IN-MEMORY STATE GONE, CART REBUILT ─────────────────
    /* The other two lifecycle paths the spec names. Both ALREADY re-quote pre-D2 — a reload starts the
       token store empty (form-confirm-quote) and drops the saved reward quote (account.js), and a full
       restore calls restoreRedeem and re-quotes even within a live page. So the claim is NOT that
       nothing happens; it is that identity adds nothing ON TOP.
       Modelled by rebuilding the same cart on a FRESH page, which is what a reload leaves you with,
       and demanding its signatures equal the id-less page's. If identity had leaked into any of them,
       the rebuilt page would disagree with its own pre-backfill self and the customer would meet a
       token that will not attach on top of the re-quote they already expected. */
    {
      const reloaded = await pageWithCart(dir, { dishIds: true, extraIds: true });
      const after = sigsOf(reloaded.w);
      assert.strictEqual(after.B, base.B, `${dir}/reload: 🔴 the rebuilt cart's token signature differs from its pre-backfill self`);
      assert.strictEqual(after.C, base.C, `${dir}/reload: 🔴 …and the reward-freshness signature, which gates SENDING`);
      assert.strictEqual(after.D, base.D, `${dir}/reload: 🔴 …and the quote key`);
      assert.strictEqual(reloaded.w.cartSig(), none.w.cartSig(),
        `${dir}/reload: 🔴 cartSig differs — the resumed customer would be given a NEW order_id`);

      /* THE FULL-RESTORE HALF LIVES IN cart-identity-order.test.mjs, not here. What stood in this
         spot called restoreRedeem(null, null, null) on a freshly built cart — no saved order, no
         restoreOrderForm, no token, no order_id comparison — so neutering restoreOrderForm entirely
         left it green. It has been replaced by a real saved-order resume over there: the stash is
         built by the page's own snapshotForm(), the return page is served a menu that GAINED ids, and
         the assertions are that the original order_id is reused and a token still attaches. This cell
         keeps only what it can honestly claim — the rebuild half. */
      ok(`${dir}: a reload/restore rebuild produces identical B, C, D and cartSig — no friction beyond the re-quote that always fires`);
    }

    // ── 11. THE INLINE FALLBACK IS DEEP TOO — MODULE GONE, NESTED EXTRA PRESENT ───────────────
    /* 🔴 THE FALLBACK IS A SECOND IMPLEMENTATION, SO IT GETS THE SAME TRAP. If the page's and
       account.js's inline projections were shallow, a module-load failure on a cart with an option —
       which is most carts — would reopen exactly the friction the deep projection closes, and only
       for the customers unlucky enough to hit the 404. Driven end-to-end with the module omitted:
       every signature must still match the id-less baseline. */
    {
      const w = loadForm(dir, { omit: ['form-identity-strip.js'] });
      assert.strictEqual(typeof w.legacyCartForSig, 'undefined', `${dir}/no-module: premise — the module is absent`);
      const prepared = w.liveMenuPrepare(bodyFor(dir, w, { dishIds: true, extraIds: true }));
      w.liveMenuGlobalSet('MENU', prepared.MENU);
      w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
      await settle();
      const d = prepared.MENU.find((x) => x.price > 0);
      w.chg(d.id, 1);
      await settle();
      w.toggleDetailExtra(prepared.EXTRAS[0].id, d.id, 0);
      await settle();

      const emitted = w.redeemCartItems();
      assert.ok(emitted[0].dish_id && emitted[0].extras[0].extra_id,
        `${dir}/no-module: premise — the cart still CARRIES both ids (emission does not depend on the module)`);
      const got = sigsOf(w);
      assert.strictEqual(got.B, base.B, `${dir}/no-module: 🔴 B moved — the inline fallback is not projecting`);
      assert.strictEqual(got.C, base.C, `${dir}/no-module: 🔴 C moved — account.js's inline fallback is not projecting`);
      assert.strictEqual(got.D, base.D, `${dir}/no-module: 🔴 D moved`);
      ok(`${dir}: with the module missing, the inline fallbacks still project DEEP — B, C and D all hold`);
    }

  }

  console.log(`\ncart-identity: ${count()} checks passed across both forms`);
  closeAll();
  process.exit(0);
})().catch((e) => { console.error('cart-identity FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
