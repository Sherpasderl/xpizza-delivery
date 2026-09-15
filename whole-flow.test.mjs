// Portal 1B Task 9 — THE WHOLE-FLOW MATRIX. Run: node whole-flow.test.mjs
//
// 🔴 WHY A WHOLE-FLOW SUITE AND NOT AN ELEVENTH PER-TASK SLICE. Eight clean per-task gates still left
// money-moving defects at the boundaries BETWEEN the tasks. Each piece was correct about its own
// contract and wrong about what the next piece assumed. So this suite asserts ONE invariant across the
// composition of all of them:
//
//     THE AMOUNT CHARGED EQUALS THE NET TOTAL THE CUSTOMER CONFIRMED
//
// …through a live menu replacement, on both forms, in every state the form can be in when the
// replacement lands.
//
// HOW THAT IS MADE CHECKABLE. The chain is: redeemCartItems() serializes the cart → quoteOrder prices
// THAT payload and the price is what the customer is shown → createOrder / chargeOnlineOrder send the
// SAME payload → the server re-prices it. So the fake server below prices a payload the way the real
// one does — by looking the item up in the CURRENT menu, x_pizza by NAME and la_musa by ID, never by
// trusting the price the payload carries. Then "charged == confirmed" is a comparison of two numbers
// this suite computed independently, not a restatement of one of them.
//
// TWO KINDS OF CELL, LABELLED, because claiming one kind for both would overstate what is proved:
//
//   CHARGE-OUTCOME cells run a real submit and end in exactly one of two acceptable outcomes — the send
//   is REFUSED, or it happens and the server-priced amount EQUALS the confirmed total. "A total was
//   displayed" is never an outcome, and neither is "the gate returned true": the assertions are made
//   against the payload that actually reached a charge endpoint.
//
//   INVARIANT cells do not submit at all. They assert a hold, a no-op, or a non-withdrawal — which is
//   the right test for what they cover, and is NOT evidence about any charge. They are marked
//   [invariant] in their header so a reader counting "charge proofs" cannot count them by mistake.
//   An earlier version of this comment claimed every cell ended in a charge outcome; six did not.
import assert from 'node:assert';
import { counter, settle, stageSettle, envelope, loadForm, res, loadAvail, BRAND,
         closeAll, containersOfFor, paintedFor } from './form-harness.mjs';

const { ok, count } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;

/* THE SERVER'S PRICE, computed the way the server computes it: from the menu in force, keyed the way
   the brand keys. An item the current menu cannot price returns null — which is the server refusing,
   not a zero. Returning 0 there would have made a dropped dish look free and every total still "agree". */
function serverPrice(dir, menu, item) {
  const dishes = menu.dishes || [];
  const rec = dir === 'la-musa-orders'
    ? dishes.find((d) => String(d.id) === String(item.id))
    : dishes.find((d) => d.name === item.name);
  if (!rec) return null;
  /* 🔴 EVERY EXTRA IS PRICED INDEPENDENTLY, NOT TAKEN FROM item.extrasTotal. Adding the payload's own
     extras subtotal was a hole straight through this suite's premise: the fake quote and the fake
     charge both consumed the SAME client-supplied number, so a wrong extras subtotal contaminated both
     sides equally and "charged == confirmed" passed against the wrong figure. An oracle that trusts a
     field the code under test produced is not an oracle. Keyed the way each brand keys — x_pizza's
     options are name-keyed and count once, la_musa's are id-keyed and qty-aware — because getting THAT
     wrong would silently re-introduce the same class one level down. */
  const opts = menu.extras || [];
  let extras = 0;
  for (const e of item.extras || []) {
    const er = dir === 'la-musa-orders'
      ? opts.find((x) => String(x.id) === String(e.id))
      : opts.find((x) => x.name === e.name);
    if (!er) return null;                          // an option the menu cannot price refuses the line
    extras += er.price * (dir === 'la-musa-orders' ? (Number(e.qty) || 0) : 1);
  }
  return rec.price * (Number(item.qty) || 0) + extras;
}
function serverTotalCents(dir, menu, items) {
  let sum = 0;
  for (const it of items || []) {
    const p = serverPrice(dir, menu, it);
    if (p === null) return null;                 // unpriceable → the server would refuse
    sum += p;
  }
  return sum * 100;
}

/* The form under test, wired to a fake back end that PRICES. `menuNow` is what the server would price
   against at this instant — the test moves it exactly when it publishes a new snapshot, which is what
   makes "a publish landed between the quote and the charge" expressible at all. */
async function boot(dir) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const st = { menuNow: null, quotes: 0, charges: [] };
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, st.menuNow));
    if (url.includes('quoteOrder')) {
      st.quotes += 1;
      const items = JSON.parse((init && init.body) || '{}').items || [];
      const cents = serverTotalCents(dir, st.menuNow, items);
      return res(cents === null ? { ok: false } : { ok: true, total_cents: cents });
    }
    if (CHARGE_RE.test(url)) {
      // The URL is recorded with the body: the two charge endpoints take DIFFERENT payload shapes, and
      // "items was undefined" is unreadable without knowing which one answered.
      st.charges.push({ url, ...JSON.parse((init && init.body) || '{}') });
      return res({ ok: true, order_id: 'T9' });
    }
    return idle;                                  // everything else hangs — see the harness note
  };
  return { w, B, st };
}

/* Publish a snapshot: the server's pricing basis and the form's feed move TOGETHER, in that order,
   because that is the real sequence — the catalog is live before a form can fetch it. */
async function publish(ctx, menu) {
  ctx.st.menuNow = menu;
  /* Refreshed through the feed rather than via the harness's serve(), which installs its OWN
     menu-only responder and would silently unplug the quote and charge endpoints this suite depends
     on — the cart would then look unquoted for a reason that has nothing to do with the code. */
  await ctx.w.__liveMenu.feed.refresh();
  await settle();
}

// Put a real line in the cart through the form's own writer, then let the quote settle.
async function addToCart(ctx, dish, qty = 1) {
  ctx.w.chg(dish.id, qty);
  ctx.w.requestServerQuote();
  await settle();
}

/* THE ASSERTION EVERY CELL ENDS WITH. Drives the REAL submit path and then judges the outcome against
   the two acceptable ones. Deliberately does not take an expectation of WHICH — a cell that refuses
   when it should charge is caught by its own non-vacuity, and forcing every cell to declare an
   expected branch is how a test starts asserting the behaviour it observed rather than the rule. */
async function sendAndJudge(ctx, dir, label) {
  const before = ctx.st.charges.length;
  const confirmed = ctx.w.getServerQuoteTotalCents();
  /* THE REAL SEQUENCE, not a call to the gate. buildOrder() composes the payload and is the ENTRY
     refusal; refuseConflictedSend is the one immediately before the fetch. Both are asked, because the
     property is "no charge leaves", and a suite that only drove submitOrder() would have passed
     vacuously — submitOrder bails without a composed order, so "no charge" would have been true for a
     reason that has nothing to do with any gate. That is exactly the shape of check this programme
     keeps finding was never evidence. */
  const built = ctx.w.buildOrder();
  const gated = ctx.w.refuseConflictedSend('t9-matrix');
  const refused = !built || gated;
  if (built) {
    try { await ctx.w.submitOrder('confirmed'); } catch (_) { /* the fetch record is the assertion */ }
  }
  await settle();
  const sent = ctx.st.charges.slice(before);
  if (refused) {
    assert.strictEqual(sent.length, 0,
      `${dir}/${label}: 🔴 the send was refused, so NOTHING may have reached a charge endpoint`);
    return { outcome: 'refused', confirmed };
  }
  assert.strictEqual(sent.length, 1,
    `${dir}/${label}: non-vacuity — an unrefused send must actually reach a charge endpoint (got ${sent.length})`);
  const charged = serverTotalCents(dir, ctx.st.menuNow, sent[0].items);
  assert.notStrictEqual(charged, null,
    `${dir}/${label}: 🔴 every line the form sent must be priceable by the server`);
  assert.notStrictEqual(confirmed, null,
    `${dir}/${label}: 🔴 a charge went out with NO confirmed total on screen — the customer agreed to nothing`);
  assert.strictEqual(charged, confirmed,
    `${dir}/${label}: 🔴 CHARGED ${charged} !== CONFIRMED ${confirmed} — ${sent[0].url} sent ${JSON.stringify(sent[0].items)}`);
  return { outcome: 'charged', confirmed, charged };
}

for (const dir of Object.keys(BRAND)) {
  console.log(`\n══ ${dir} ══`);
  const B = BRAND[dir];
  const painted = paintedFor(B);
  const baseMenu = (w) => B.menu(w);

  // A dish that is an ordinary, orderable line on both brands — not a variant launcher, not a
  // zero-priced "próximamente" placeholder, either of which would make the cell test something else.
  const plainDish = (w) => w.liveMenuGlobalGet('MENU').find((d) =>
    d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));

  // ── CELL 1: REPRICE ──────────────────────────────────────────────────────────────────────────
  // The one the whole task exists for: a price moves under a quoted cart.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const first = ctx.w.getServerQuoteTotalCents();
    assert.ok(first > 0, `${dir}/reprice: non-vacuity — the cart quoted a real total (${first})`);

    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 137 } : x));
    await publish(ctx, up);
    ctx.w.requestServerQuote();
    await settle();

    /* 🔴 A REPRICE BLOCKS. This is the answer the matrix was written to find out, and it is NOT the one
       I expected: the cart classifies a price move as 'repriced' → unresolved → blocked, so the line
       cannot be charged at the price the customer agreed to NOR at the new one. That is the correct
       money behaviour and it is worth stating as an invariant rather than leaving implicit — silently
       charging 477 for something added at 340 is the defect this whole decoupling exists to prevent,
       and silently charging 340 for something now priced 477 is the merchant's half of it. */
    const r = await sendAndJudge(ctx, dir, 'reprice');
    assert.strictEqual(r.outcome, 'refused',
      `${dir}/reprice: 🔴 a repriced line is NEVER charged silently — at the old price or the new one`);

    // …and the customer's way out is the ordinary one: drop the line, add it again, pay the new price.
    ctx.w.chg(d.id, -1);
    await settle();
    ctx.w.chg(d.id, 1);
    ctx.w.requestServerQuote();
    await settle();
    const again = await sendAndJudge(ctx, dir, 'reprice-readd');
    assert.strictEqual(again.outcome, 'charged',
      `${dir}/reprice: re-adding at the new price is orderable again`);
    assert.strictEqual(again.confirmed, first + 137 * 100,
      `${dir}/reprice: 🔴 …and what they confirm is the NEW price (${again.confirmed} vs old ${first})`);
    ok(`${dir}: reprice — the line blocks rather than charging either price, and re-adding charges the new one`);
  }

  // ── CELL 2: REPRICE WITH NO RE-QUOTE [invariant] ────────────────────────────────────────────────────────────────────────────
  // The dangerous half of the same cell: the price moves and nothing asks for a new quote. The stale
  // total must NOT be displayed — an invalidated quote is what stands between the old number and the
  // customer's eyes.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const before = ctx.w.getServerQuoteTotalCents();
    assert.ok(before > 0, `${dir}/stale: premise — a total is on screen (${before})`);

    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 90 } : x));
    await publish(ctx, up);                         // …and deliberately no requestServerQuote()

    /* 🔴 THE PROPERTY IS "THE OLD NUMBER IS NEVER SHOWN", not "the total is null". Asserting null was
       too strong and would have failed for a correct reason: the apply's invalidation drops the cache,
       and the repaint that follows legitimately asks for a fresh quote, so a NEW total can be standing
       again by the time this runs. What must never be true is that the figure on screen is the one
       priced before the change — that is the number a customer would confirm and a merchant would
       under-collect on. Stated as the invariant rather than as the mechanism, so a future change to
       WHEN the re-quote fires does not make this cell wrong. */
    const shown = ctx.w.getServerQuoteTotalCents();
    assert.notStrictEqual(shown, before,
      `${dir}/stale: 🔴 the total on screen is NEVER the one priced before the change (${shown})`);
    assert.ok(shown === null || shown === before + 90 * 100,
      `${dir}/stale: it is either withdrawn or re-priced from the new menu — never anything else (${shown})`);
    ok(`${dir}: reprice with no re-quote — the pre-change total is never left standing`);
  }

  // ── CELL 3: REMOVAL ──────────────────────────────────────────────────────────────────────────
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.filter((x) => String(x.id) !== String(d.id));
    await publish(ctx, up);
    const r = await sendAndJudge(ctx, dir, 'removal');
    assert.strictEqual(r.outcome, 'refused',
      `${dir}/removal: 🔴 a line the menu no longer carries BLOCKS the send`);
    ok(`${dir}: removal — an unresolved line blocks the charge entirely`);
  }

  // ── CELL 4: NEW ITEM ─────────────────────────────────────────────────────────────────────────
  // A dish appearing must not disturb a quoted cart — the total is the cart's, not the menu's.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const first = ctx.w.getServerQuoteTotalCents();
    const up = baseMenu(ctx.w);
    const fresh = { ...up.dishes[0], id: dir === 'la-musa-orders' ? 'nuevo_t9' : 99901, name: 'Nuevo T9', price: 777 };
    up.dishes = up.dishes.concat([fresh]);
    await publish(ctx, up);
    ctx.w.requestServerQuote();
    await settle();
    const r = await sendAndJudge(ctx, dir, 'new-item');
    assert.strictEqual(r.outcome, 'charged', `${dir}/new-item: an addition is not a conflict`);
    assert.strictEqual(r.confirmed, first,
      `${dir}/new-item: 🔴 a dish the customer did not add changes nothing about their total`);
    ok(`${dir}: new item — the quoted cart is untouched and charged as confirmed`);
  }

  // ── CELL 5: MODAL OPEN [invariant] ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    ctx.w.openDetailModal(d.id);
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 50 } : x));
    await publish(ctx, up);
    assert.ok(ctx.w.__liveMenu.applier.hasPending(),
      `${dir}/modal-open: 🔴 the menu does not change under an open modal — the snapshot is HELD`);
    ctx.w.closeDetailModal();
    await settle();
    assert.ok(!ctx.w.__liveMenu.applier.hasPending(), `${dir}/modal-open: and it lands on close`);
    const live = ctx.w.liveMenuGlobalGet('MENU').find((x) => String(x.id) === String(d.id));
    assert.strictEqual(live.price, d.price + 50,
      `${dir}/modal-open: 🔴 …and what lands is the held snapshot, in full`);
    ok(`${dir}: modal open — the apply defers under the modal and lands intact on close`);
  }

  // ── CELL 6: CHECKOUT OPEN [invariant] ───────────────────────────────────────────────────────────────────────────────────────
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    ctx.w.showStage('s2', 50);
    await stageSettle();      // the stage cross-dissolve is driven by a 170ms fallback in jsdom
    assert.strictEqual(ctx.w.activeStageId(), 's2',
      `${dir}/checkout-open: non-vacuity — checkout really is open`);
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 60 } : x));
    await publish(ctx, up);
    assert.ok(ctx.w.__liveMenu.applier.hasPending(),
      `${dir}/checkout-open: 🔴 a menu change never lands under the customer mid-checkout`);
    ok(`${dir}: checkout open — the snapshot is held while the customer is paying`);
  }

  // ── CELL 7: POST-SUBMIT [invariant] ─────────────────────────────────────────────────────────────────────────────────────────
  // The order is placed. What the menu does afterwards is not this customer's business.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    ctx.w.showStage('s5', 100);
    await stageSettle();
    assert.strictEqual(ctx.w.activeStageId(), 's5',
      `${dir}/post-submit: non-vacuity — the receipt really is showing`);
    const painted5 = painted(ctx.w);
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.filter((x) => String(x.id) !== String(d.id));
    await publish(ctx, up);
    assert.strictEqual(painted(ctx.w), painted5,
      `${dir}/post-submit: 🔴 a completed order's screen does not change under it`);
    assert.ok(!ctx.w.__liveMenu.applier.hasPending(),
      `${dir}/post-submit: and the snapshot is DROPPED, not queued for a customer who has gone`);
    ok(`${dir}: post-submit — the apply is ignored and nothing is held`);
  }

  // ── CELL 8: OVERLAPPING FETCH ────────────────────────────────────────────────────────────────
  // Two snapshots in flight: the LATEST must win, and no cart may be priced against a blend.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const a = baseMenu(ctx.w);
    a.dishes = a.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: 111 } : x));
    const b = baseMenu(ctx.w);
    b.dishes = b.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: 222 } : x));
    /* 🔴 ACTUALLY OVERLAPPING. The previous version awaited A before publishing B, which is two
       sequential fetches — it could not have observed an out-of-order application because there was
       never more than one request in flight. A's response is held until B has been ISSUED and then
       released, so A lands LAST while B is the newer snapshot: the exact ordering the coordinator has
       to refuse, and the one a sequential test can never produce. */
    let releaseA;
    const heldA = new Promise((r) => { releaseA = r; });
    const realRespond = ctx.w.__respond;
    let first = true;
    ctx.w.__respond = (url, init) => {
      if (url.includes('/menu/') && first) { first = false; return heldA.then(() => res(envelope(B.rid, a))); }
      return realRespond(url, init);
    };
    ctx.st.menuNow = a;
    const pA = ctx.w.__liveMenu.feed.refresh();     // in flight, unresolved
    ctx.st.menuNow = b;
    const pB = ctx.w.__liveMenu.feed.refresh();     // issued while A is still outstanding
    await settle();
    releaseA();                                      // …and now A answers, LAST
    await Promise.all([pA, pB]);
    await settle();
    ctx.w.__respond = realRespond;
    ctx.w.requestServerQuote();
    await settle();
    const live = ctx.w.liveMenuGlobalGet('MENU').find((x) => String(x.id) === String(d.id));
    assert.strictEqual(live.price, 222, `${dir}/overlap: 🔴 the LATEST snapshot is the one in force`);
    // Re-added so the cell can reach a CHARGE and compare numbers: the reprice blocked it, per cell 1.
    ctx.w.chg(d.id, -1); await settle(); ctx.w.chg(d.id, 1);
    ctx.w.requestServerQuote();
    await settle();
    const r = await sendAndJudge(ctx, dir, 'overlapping-fetch');
    assert.strictEqual(r.outcome, 'charged', `${dir}/overlap: orderable once re-added`);
    assert.strictEqual(r.confirmed, 222 * 100,
      `${dir}/overlap: 🔴 priced from the LATEST snapshot alone, never a blend of the two (${r.confirmed})`);
    ok(`${dir}: overlapping fetch — the latest snapshot wins and prices the cart by itself`);
  }

  // ── CELL 9: 304 NOT MODIFIED [invariant] ────────────────────────────────────────────────────────────────────────────────────
  // Nothing changed, so nothing may move — including the quote, whose invalidation would silently
  // withdraw the total the customer is looking at.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const before = painted(ctx.w);
    const quoted = ctx.w.getServerQuoteTotalCents();
    assert.ok(quoted > 0, `${dir}/304: premise — there is a quote to preserve`);
    const applied = ctx.w.__liveMenu.applier.state().counts.applied;
    ctx.w.__respond = (url) => (url.includes('/menu/')
      ? Promise.resolve({ ok: false, status: 304, headers: { get: () => '"t1"' }, json: () => Promise.resolve(null) })
      : new Promise(() => {}));
    await ctx.w.__liveMenu.feed.refresh();
    await settle();
    assert.strictEqual(ctx.w.__liveMenu.applier.state().counts.applied, applied,
      `${dir}/304: 🔴 a 304 applies nothing`);
    assert.strictEqual(painted(ctx.w), before, `${dir}/304: the screen is untouched`);
    assert.strictEqual(ctx.w.getServerQuoteTotalCents(), quoted,
      `${dir}/304: 🔴 …and the customer's confirmed total SURVIVES it`);
    ok(`${dir}: 304 — nothing applies, nothing repaints, and the quote is not withdrawn`);
  }

  // ── CELL 10: AVAILABILITY REAPPLY ────────────────────────────────────────────────────────────
  // A dish 86'd by the kitchen must block the send even though the MENU still carries it — the two
  // feeds are independent and the cart has to answer to both.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    // The real map shape and the real key derivation — availKey() is the form's own, and the brands key
    // differently (x_pizza by NAME, la_musa by ID), which is the whole reason this is asked per brand.
    await loadAvail(ctx.w, { [ctx.w.availKey(dir === 'xpizza-orders' ? d.name : d.id)]: { available: false } });
    assert.ok(ctx.w.isSoldOut(d), `${dir}/availability: non-vacuity — the dish really is 86'd`);
    const r = await sendAndJudge(ctx, dir, 'availability');
    assert.strictEqual(r.outcome, 'refused',
      `${dir}/availability: 🔴 an 86'd line blocks the charge even though the menu still lists it`);
    // …and the customer is told the RIGHT thing. "Review it" sends them looking for a change that is
    // not there; the only action that helps is removing it.
    const err = ctx.w.document.getElementById('err3') || ctx.w.document.getElementById('err1');
    assert.match((err && err.textContent) || '', /Agotado/,
      `${dir}/availability: 🔴 …and it is named as SOLD OUT, not as "changed"`);
    assert.match((err && err.textContent) || '', new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${dir}/availability: 🔴 …with the line named, so the customer knows which one`);
    ok(`${dir}: availability reapply — a sold-out line blocks the charge and is named as agotado`);
  }

  /* ── CELL 12: A SYNCHRONOUS FAILURE IN THE APPLY PATH ITSELF [invariant] ─────────────────────────────────
     Carried into T9 as a known limitation: `capture()` runs OUTSIDE the applier's try, so if it throws
     the applier never gets to attempt or recover, and the coordinator records the throw as a feed error
     instead of a fatal. Item 1's broken-blocks-the-charge fix therefore does NOT cover this path, which
     is exactly why it needed its own look rather than being assumed covered.
     What is asserted is that the failure is a NO-OP: capture throwing means nothing was applied, so the
     screen still shows the menu the customer has been looking at and the total they confirmed is still
     the total for what is in their cart. A display that is merely UNCHANGED is not a stale display —
     nothing moved to become stale. That is the difference between this and the broken case, and it is
     why blocking the charge here would be wrong rather than cautious. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const before = painted(ctx.w);
    const confirmed = ctx.w.getServerQuoteTotalCents();
    assert.ok(confirmed > 0, `${dir}/sync-throw: premise — a total is confirmed`);

    const realSnap = ctx.w.liveMenuQuoteSnapshot;
    ctx.w.liveMenuQuoteSnapshot = () => { throw new Error('capture exploded'); };
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 40 } : x));
    await publish(ctx, up);
    ctx.w.liveMenuQuoteSnapshot = realSnap;

    assert.strictEqual(painted(ctx.w), before,
      `${dir}/sync-throw: 🔴 nothing was applied — the screen is the one the customer was already reading`);
    assert.ok(!ctx.w.__liveMenu.applier.state().fatal,
      `${dir}/sync-throw: the applier is not FATAL — it never got far enough to break anything`);
    /* 🔴 THE 1C ENTRY POINT — MEASURED HERE, DELIBERATELY NOT ASSERTED EITHER WAY.
       Sending at this moment charges the CURRENT catalog price while the screen and the cached quote
       still hold the previous one: confirmed 34000, charged 38000. The mismatch is not specific to a
       capture throw — it is what happens whenever the catalog has moved and the form has not caught up,
       because a failed or DEFERRED apply does not invalidate the quote. That is by design: nothing on
       screen changed, so the quote still matches the SCREEN. It just no longer matches the SERVER.

       THIS IS 1C's GUARANTEE, NOT A 1B DEFECT, and the distinction is the design grill's, not a
       convenience. Finding #9 reframed the invariant precisely because pricing caches and the
       deliberate checkout-hold make live tile-to-charge parity impossible: the rule is not "tile ==
       charge, live" but "the customer is charged exactly the net total they CONFIRMED", and enforcing
       that equality is 1C's confirmed-quote gate. 1B's job was to make the display live and safe and to
       prove the live menu never DETERMINES a charge — both of which the other 23 checks here do.

       The most reachable trigger is a publish while the customer is at checkout, where cell 6 asserts
       the snapshot is HELD so the menu does not move under them. That hold is correct; the gap is that
       nothing re-validates the quote at the send.

       Unasserted on purpose. Asserting the current behaviour would pin a displayed-vs-charged mismatch
       as correct; asserting the opposite would fail this suite over a decision that belongs to 1C's
       design. The no-op properties above ARE asserted, because they hold whichever way 1C goes. When
       1C's expected-total gate lands, THIS is the cell that turns into its regression test. */
    assert.strictEqual(ctx.w.getServerQuoteTotalCents(), confirmed,
      `${dir}/sync-throw: the cached quote is untouched by a failed apply — this is the input to the finding`);
    ok(`${dir}: a synchronous capture failure applies NOTHING and leaves the screen intact (see the stale-quote finding)`);
  }

  /* ── CELL 13: AN 86'd OPTION ───────────────────────────────────────────────────────────────────
     The cell-10 fix one level down, and the more dangerous half: the server's availability gate
     iterates TOP-LEVEL ITEMS only, so unlike an 86'd dish there is no server backstop underneath an
     86'd extra. Fixing the dish and leaving the option would have been the containment-in-one-direction
     failure this project keeps producing — the dish is fine, the chorizo is off, the line submits WITH
     it and the kitchen cannot make it. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const ex = ctx.w.liveMenuGlobalGet('EXTRAS')[0];
    if (dir === 'xpizza-orders') ctx.w.toggleDetailExtra(ex.id, d.id, 0);
    else ctx.w.chgDetailExtra(ex.id, d.id, 1);
    ctx.w.requestServerQuote();
    await settle();
    const withExtra = await sendAndJudge(ctx, dir, 'extra-ok');
    assert.strictEqual(withExtra.outcome, 'charged',
      `${dir}/extra-86: non-vacuity — the line with the option is orderable BEFORE the option is 86'd`);

    // …now the kitchen runs out of the OPTION, and the dish is untouched.
    const ctx2 = await boot(dir);
    await publish(ctx2, baseMenu(ctx2.w));
    const d2 = plainDish(ctx2.w);
    await addToCart(ctx2, d2);
    const ex2 = ctx2.w.liveMenuGlobalGet('EXTRAS')[0];
    if (dir === 'xpizza-orders') ctx2.w.toggleDetailExtra(ex2.id, d2.id, 0);
    else ctx2.w.chgDetailExtra(ex2.id, d2.id, 1);
    ctx2.w.requestServerQuote();
    await settle();
    await loadAvail(ctx2.w, { [ctx2.w.availKey(dir === 'xpizza-orders' ? ex2.name : ex2.id)]: { available: false } });
    assert.ok(ctx2.w.isSoldOut(ex2), `${dir}/extra-86: non-vacuity — the OPTION really is 86'd`);
    assert.ok(!ctx2.w.isSoldOut(d2), `${dir}/extra-86: non-vacuity — and the DISH is not`);
    const r = await sendAndJudge(ctx2, dir, 'extra-86');
    assert.strictEqual(r.outcome, 'refused',
      `${dir}/extra-86: 🔴 an 86'd OPTION blocks the line it sits on — there is no server backstop here`);
    ok(`${dir}: an 86'd option blocks the charge on the line that carries it`);
  }

  /* ── CELL 14: AN ACTIVE REWARD IS RE-PRICED BY A LIVE APPLY ────────────────────────────────────
     redeemAdjustedTotal() prefers the REWARD quote over the order quote, and the live apply invalidated
     only the order quote. So a reprice landing under an active reward left the reward's total standing
     and the customer confirmed a discounted figure computed against prices that had moved — a
     displayed-vs-charged window with NO held apply anywhere in it, which is why it is 1B's and not
     1C's. Two properties, because either alone is insufficient: the apply must ASK for a new reward
     price, and until one exists the send must refuse rather than show an undiscounted figure as though
     it were the reward total. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);

    // A reward that is ACTIVE and priced. Stubbed at the account boundary on purpose: what is under
    // test is the form's reaction to a live apply, not the rewards module's own quoting.
    let requoted = 0, priced = 5000;
    ctx.w.__ACCOUNT = Object.assign({}, ctx.w.__ACCOUNT, {
      getRedeemPayload: () => ({ type: 'points_ala_carte', items: [] }),
      getRedeemQuoteTotalCents: () => priced,
      requoteRedeem: (items) => { requoted += 1; priced = null; return Promise.resolve(null); },
    });
    assert.strictEqual(ctx.w.redeemAdjustedTotal(), 50,
      `${dir}/reward: premise — the REWARD total is what the customer is shown (${ctx.w.redeemAdjustedTotal()})`);

    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 70 } : x));
    await publish(ctx, up);

    assert.strictEqual(requoted, 1,
      `${dir}/reward: 🔴 the live apply RE-REQUESTS the reward price — invalidating only the order quote left it standing`);
    const r = await sendAndJudge(ctx, dir, 'reward-unpriced');
    assert.strictEqual(r.outcome, 'refused',
      `${dir}/reward: 🔴 …and while the reward has no price the send refuses, rather than confirming an undiscounted total`);
    const err = ctx.w.document.getElementById('err3') || ctx.w.document.getElementById('err1');
    assert.match((err && err.textContent) || '', /premio/i,
      `${dir}/reward: 🔴 …and says so in terms of the reward, not a generic conflict`);
    ok(`${dir}: a live apply re-prices an active reward, and an unpriced reward blocks the charge`);
  }

  /* ── CELL 15: A PUBLISH LANDS MID-SUBMIT ───────────────────────────────────────────────────────
     The matrix named a mid-submit cell and did not have one. The charge is held in flight while a new
     snapshot arrives, which is the narrowest and worst-timed window there is: the payload is already
     composed and gone, and anything that changed it now would change an order the customer has already
     authorised. What must hold is that the request in flight is untouched and no second charge is
     produced — the retry loop re-asks refuseConflictedSend precisely so a menu change between attempts
     cannot be charged, and that guard must not turn one order into two either. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const confirmed = ctx.w.getServerQuoteTotalCents();

    let releaseCharge;
    const heldCharge = new Promise((r) => { releaseCharge = r; });
    const realRespond = ctx.w.__respond;
    ctx.w.__respond = (url, init) => {
      if (CHARGE_RE.test(url)) { ctx.st.charges.push({ url, ...JSON.parse((init && init.body) || '{}') });
        return heldCharge.then(() => res({ ok: true })); }
      return realRespond(url, init);
    };
    assert.ok(ctx.w.buildOrder(), `${dir}/mid-submit: the order composes`);
    const submitting = ctx.w.submitOrder('confirmed');
    await settle();
    assert.strictEqual(ctx.st.charges.length, 1, `${dir}/mid-submit: non-vacuity — a charge really is in flight`);
    const sentAtDispatch = JSON.stringify(ctx.st.charges[0].items);

    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 90 } : x));
    await publish(ctx, up);                          // the merchant publishes WHILE the charge is out

    assert.strictEqual(JSON.stringify(ctx.st.charges[0].items), sentAtDispatch,
      `${dir}/mid-submit: 🔴 the payload already in flight is untouched by a snapshot landing behind it`);
    releaseCharge();
    await submitting.catch(() => {});
    await settle();
    assert.strictEqual(ctx.st.charges.length, 1,
      `${dir}/mid-submit: 🔴 …and exactly ONE charge was made — the in-flight publish produced no second order`);
    const charged = serverTotalCents(dir, ctx.st.menuNow, ctx.st.charges[0].items);
    assert.ok(charged !== confirmed,
      `${dir}/mid-submit: the server would price this at the NEW catalog — recorded, and 1C's gate is what closes it`);
    ctx.w.__respond = realRespond;
    ok(`${dir}: a publish mid-submit leaves the in-flight payload alone and produces exactly one charge`);
  }

  // ── CELL 11: RENAME ──────────────────────────────────────────────────────────────────────────
  // The brands diverge here BY DESIGN and the matrix must say so rather than assert one answer:
  // x_pizza prices by NAME, so a rename is a different product and the line cannot be charged;
  // la_musa prices by ID, so the same dish keeps its identity and is simply relabelled.
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, name: 'Renombrada T9' } : x));
    await publish(ctx, up);
    ctx.w.requestServerQuote();
    await settle();
    const r = await sendAndJudge(ctx, dir, 'rename');
    if (dir === 'xpizza-orders') {
      assert.strictEqual(r.outcome, 'refused',
        `${dir}/rename: 🔴 priced BY NAME — a renamed dish is a different product and must not charge`);
      ok(`${dir}: rename — priced by name, so the line blocks rather than charging under a new identity`);
    } else {
      assert.strictEqual(r.outcome, 'charged',
        `${dir}/rename: priced BY ID — identity survives a relabel`);
      ok(`${dir}: rename — priced by id, so the dish keeps its identity and charges as confirmed`);
    }
  }
}

closeAll();
console.log(`\n${count()} whole-flow checks passed across both forms.`);
