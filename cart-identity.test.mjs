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
      ok(`${dir}: the two serverQuoteCartKey sites produce the same key`);
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
      sw.toggleDetailExtra(swap.extra.id, swap.dish.id, 0);   // off
      sw.toggleDetailExtra(alt.id, swap.dish.id, 0);          // on — identical price, different option
      await settle();
      const swapped = sigsOf(sw);
      assert.strictEqual(sw.redeemCartItems()[0].extrasTotal, swap.w.redeemCartItems()[0].extrasTotal,
        `${dir}: premise — the swap really is price-neutral, so only the legacy option identity differs`);
      assert.notStrictEqual(swapped.B, beforeSwap.B, `${dir}: 🔴 a SAME-PRICE option swap must still move B — the legacy selection survived the projection`);
      assert.notStrictEqual(swapped.C, beforeSwap.C, `${dir}: 🔴 …and C`);
      assert.notStrictEqual(swapped.D, beforeSwap.D, `${dir}: 🔴 …and D`);
      ok(`${dir}: qty and a SAME-PRICE option swap still invalidate B, C and D (${swap.extra.name} → ${alt.name}, both @ ${alt.price})`);
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

      // THE CHARGED TOTAL.
      const a = computeServerTotal(withIds, rid, tables);
      const b = computeServerTotal(without, rid, tables);
      assert.ok(!b.error, `${dir}: premise — the id-less cart prices cleanly (${b.error})`);
      assert.deepStrictEqual(a, b, `${dir}: 🔴 identity moved the CHARGED TOTAL`);
      assert.ok(b.total > 0, `${dir}: …of a real amount (${b.total})`);

      // THE REWARD and its canonical — the thing a reservation binds to.
      const raw = rid === 'la_musa'
        ? { type: 'points_ala_carte', items: [{ id: without[0].id, qty: 1 }] }
        : { type: 'free_pizza_choice', item_id: without[0].name };
      const ra = computeRedemption({ redeem: raw, items: withIds, restaurantId: rid });
      const rb = computeRedemption({ redeem: raw, items: without, restaurantId: rid });
      assert.ok(rb && rb.ok, `${dir}: premise — the reward resolves without identity (${rb && rb.reason})`);
      assert.deepStrictEqual(ra, rb, `${dir}: 🔴 identity moved the REWARD resolution`);
      assert.ok(!JSON.stringify(ra.canonical).includes('ID_'), `${dir}: 🔴 …and no id value reached its canonical`);

      // THE FACTURA — asserted per brand, so flipping the predicate cannot silently skip it.
      assert.strictEqual(usesPlatformFactura(rid), rid === 'x_pizza',
        `${dir}: 🔴 platform-factura eligibility moved — the fiscal comparison would stop running`);
      if (usesPlatformFactura(rid)) {
        const fa = pricedLineItems(withIds, tables.menu, tables.extras);
        const fb = pricedLineItems(without, tables.menu, tables.extras);
        assert.ok(!fb.error && fb.items.length > 0, `${dir}: premise — fiscal lines exist (${fb.error})`);
        assert.deepStrictEqual(fa, fb, `${dir}: 🔴 identity moved the FACTURA lines`);
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
  }

  console.log(`\ncart-identity: ${count()} checks passed across both forms`);
  closeAll();
  process.exit(0);
})().catch((e) => { console.error('cart-identity FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
