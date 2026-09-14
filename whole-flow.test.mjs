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
// Every cell ends in one of exactly two acceptable outcomes, and says which:
//   • the send is REFUSED (the cart no longer resolves), or
//   • the send happens and the server-priced amount EQUALS the confirmed total.
// "A total was displayed" is never an outcome. Neither is "the gate returned true" — the assertions
// are made against the payload that actually reached a charge endpoint.
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
  const extras = Number(item.extrasTotal) || 0;
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

  // ── CELL 2: REPRICE WITH NO RE-QUOTE ─────────────────────────────────────────────────────────
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

  // ── CELL 5: MODAL OPEN ───────────────────────────────────────────────────────────────────────
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

  // ── CELL 6: CHECKOUT OPEN ────────────────────────────────────────────────────────────────────
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

  // ── CELL 7: POST-SUBMIT ──────────────────────────────────────────────────────────────────────
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
    await publish(ctx, a);
    await publish(ctx, b);
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

  // ── CELL 9: 304 NOT MODIFIED ─────────────────────────────────────────────────────────────────
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

  /* ── CELL 12: A SYNCHRONOUS FAILURE IN THE APPLY PATH ITSELF ─────────────────────────────────
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
    /* 🔴 FINDING — NOT ASSERTED AS CORRECT, BECAUSE IT IS NOT. Sending here charges the CURRENT
       catalog price while the screen and the cached quote still hold the previous one: confirmed 340,
       charged 380. The mismatch is not specific to a capture throw — it is what happens whenever the
       catalog has moved and the form has not caught up, because a FAILED apply does not invalidate the
       quote (by design: nothing on screen changed, so the quote still matches the screen — it just no
       longer matches the SERVER).
       Deliberately left unasserted rather than encoded either way: asserting the current behaviour
       would pin a displayed-vs-charged mismatch as correct, and asserting the opposite would fail a
       suite over a decision that is the advisor's to make. The no-op properties above ARE asserted,
       because they are true and worth keeping whichever way the decision goes. */
    assert.strictEqual(ctx.w.getServerQuoteTotalCents(), confirmed,
      `${dir}/sync-throw: the cached quote is untouched by a failed apply — this is the input to the finding`);
    ok(`${dir}: a synchronous capture failure applies NOTHING and leaves the screen intact (see the stale-quote finding)`);
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
