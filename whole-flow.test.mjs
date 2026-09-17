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

import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
/* 🔴 1C: THE REAL SIGNING AND THE REAL FINGERPRINT, over this suite's own pricing oracle.
   gateConfirmedNet is deliberately NOT used here: it reprices through the real catalog tables, while
   every cell in this suite moves a SYNTHETIC menu around to create the states under test — the two
   would disagree about the price for reasons that have nothing to do with the property being tested.
   What IS taken from the shipping code is the half the client has to match exactly and cannot fake:
   the token's signature and the cart fingerprint. The price comparison stays with serverTotalCents,
   the independent oracle this suite was built on, so "charged == confirmed" remains a comparison of
   two numbers computed separately rather than the fake agreeing with itself. */
const { signQuoteToken, verifyQuoteToken, cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
/* 🔴 THE REWARD MUST BE RESOLVED BEFORE IT IS FINGERPRINTED. cartFingerprint reads model and
   freeItems — the RESOLVED shape the server computes — not the raw {type, items} a client sends. An
   earlier version here hashed the raw request, so every reward produced the same empty {m:'', f:[]}
   and two genuinely different rewards fingerprinted identically: the fake could not tell them apart,
   which is precisely the distinction the fingerprint exists to make. Resolved through the real
   computeRedemption, so the fake hashes what production hashes. */
const { computeRedemption } = require('./rewards-redeem');
const { computeServerNet } = require('./compute-server-net');
const { gateConfirmedNet, gateInputFromRequest } = require('./token-gate');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
function resolveReward(redeem, items, rid) {
  if (!redeem) return null;
  try {
    const r = computeRedemption({ redeem, items, restaurantId: rid });
    return r && r.ok ? r : null;
  } catch (_) { return null; }
}

const { ok, count } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const T9_SECRET = 'whole-flow-1c-secret';
/* 🔴 THE REWARD'S PRICE, AS A RULE THIS SUITE OWNS. The reward quote and the charge both apply the
   SAME rule — cart price minus a fixed discount — but at different moments, over whatever menu is in
   force then. That is what keeps the oracle independent: the two numbers are not copied from one
   another, they are the same function of two different inputs, which is exactly the relationship the
   real server has between a quote and the charge that follows it. A fake that echoed the quoted total
   back at charge time would agree with itself no matter what the menu did, and the reward skew this
   cell exists to catch is precisely a menu that moved in between. */
/* 🔴 WHAT A TOKEN IS WORTH, MODELLED THE WAY PRODUCTION DOES IT — and this is the correction that
   matters most in this file. The first version refused EVERY verification failure, which looks strict
   and is precisely how a fake hides a defect: production treats an EXPIRED token as ordinary (a
   customer left checkout open; a clock is off) and falls back to whatever ceiling the request states.
   Refusing it here made the residual cells green while a real grace-window order overcharged. A fake
   that is stricter than production does not test production — it tests a server nobody deployed.
   So: a FORGED signature refuses (it is the one signal of tampering); an EXPIRED one falls to the
   ceiling if the request carries one, exactly like a token-less request; a cart the token never
   described refuses on the fingerprint. */
function judgeToken(body, rid, reward) {
  const stated = typeof body.expected_net_cents === 'number' ? body.expected_net_cents : null;
  if (!body.quote_token) return { ceiling: stated, signed: false };
  const v = verifyQuoteToken(body.quote_token, T9_SECRET, Date.now());
  if (!v.ok) {
    if (v.reason === 'bad_signature' || v.reason === 'bad_format') {
      return { refuse: { error: 'quote_invalid', reason: v.reason } };
    }
    return { ceiling: stated, signed: false };          // expired / unclocked → the ceiling stands in
  }
  const norm = normalizeCartForFingerprint(body.items || [], rid);
  if (!norm || cartFingerprint(norm, reward) !== v.payload.cart_fingerprint) {
    return { refuse: { error: 'quote_invalid', reason: 'cart_mismatch' } };
  }
  return { ceiling: v.payload.net_total_cents, signed: true };
}

const T9_REWARD_DISCOUNT = 4000;
function rewardNetCents(dir, menu, items) {
  const base = serverTotalCents(dir, menu, items);
  return base === null ? null : Math.max(0, base - T9_REWARD_DISCOUNT);
}
// The shared harness's res() is 200-only; the 1C gate answers 409, so the fake needs its own.
const rej = (body, status = 409) => Promise.resolve({
  ok: false, status, headers: { get: () => null }, json: () => Promise.resolve(body),
});

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
  const st = { menuNow: null, quotes: 0, charges: [], gated: [], redeemQuotes: 0, redeemLive: false, rewardPayload: null, tokenTtlMs: 15 * 60 * 1000,
               redeemReply: { ok: true, total_cents: 5000, savings_cents: 1000, free_items: [], remaining: 0, total_cost: 0 } };
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, st.menuNow));
    if (url.includes('quoteRedemption')) {
      st.redeemQuotes += 1;
      if (!st.redeemLive) return res(st.redeemReply);        // the fixed fixture, for the cells that want it
      /* 1C: price the reward from the menu IN FORCE and sign a token bound to the cart AND the reward.
         cartFingerprint takes the reward, so a token issued for a reward-bearing cart cannot authorise
         the same cart without it — the one thing the amount alone can never witness, since a la_musa
         add_free reward is net-invariant. */
      const body = JSON.parse((init && init.body) || '{}');
      const items = body.items || [];
      const cents = rewardNetCents(dir, st.menuNow, items);
      if (cents === null) return res({ ok: false, error: 'reward_unavailable' });
      const norm = normalizeCartForFingerprint(items, B.rid);
      const token = norm ? signQuoteToken({
        quote_id: 'rq' + st.redeemQuotes, rid: B.rid, net_total_cents: cents,
        cart_fingerprint: cartFingerprint(norm, resolveReward(body.redeem || st.rewardPayload || null, items, B.rid)),
        issued_at: Date.now(), expires_at: Date.now() + st.tokenTtlMs,   // the REAL field names — iat/exp fail verification and fall to grace
      }, T9_SECRET) : null;
      return res({ ...st.redeemReply, ok: true, total_cents: cents, net_total_cents: cents,
        ...(token ? { quote_token: token } : {}) });
    }
    if (url.includes('quoteOrder')) {
      st.quotes += 1;
      const items = JSON.parse((init && init.body) || '{}').items || [];
      const cents = serverTotalCents(dir, st.menuNow, items);
      if (cents === null) return res({ ok: false });
      // 1C: sign the quote the way the server does, over the cart as submitted and the price in force.
      const norm = normalizeCartForFingerprint(items, B.rid);
      const token = norm ? signQuoteToken({
        quote_id: 'q' + (st.quotes), rid: B.rid, net_total_cents: cents,
        cart_fingerprint: cartFingerprint(norm, null),
        // st.tokenTtlMs, not a constant: the expired cells quote through THIS endpoint, and with a
        // hardcoded 15 minutes their tokens verified as ok — the cells passed without ever exercising
        // expiry, which is the whole thing they were written to exercise.
        issued_at: Date.now(), expires_at: Date.now() + st.tokenTtlMs,
      }, T9_SECRET) : null;
      return res({ ok: true, total_cents: cents, net_total_cents: cents,
        ...(token ? { quote_token: token } : {}) });
    }
    if (CHARGE_RE.test(url)) {
      // The URL is recorded with the body: the two charge endpoints take DIFFERENT payload shapes, and
      // "items was undefined" is unreadable without knowing which one answered.
      const body = JSON.parse((init && init.body) || '{}');
      st.charges.push({ url, ...body });
      /* 🔴 THE 1C GATE, as the server applies it: the charge is the SERVER's recompute against the
         menu in force, and it is refused when that exceeds what the customer confirmed. A signed token
         supplies the ceiling and must describe THIS cart; an unsigned expected_net_cents supplies it
         without that proof; neither ever becomes the price. */
      const nowCents = serverTotalCents(dir, st.menuNow, body.items || []);
      if (nowCents === null) return rej({ error: 'bad_cart' });
      /* 🔴 A REWARD-BEARING ORDER IS NOT GATED HERE, and saying so is the point. serverTotalCents is
         this suite's independent oracle and it prices the CART — it knows nothing about redemptions,
         and a la_musa add_free reward is net-invariant while a punch reward is not. Comparing a
         reward-discounted ceiling against a full-price oracle would report a price increase on every
         reward order: a fake disagreeing with itself, dressed up as a finding. The reward's own
         confirmed-net path is covered where it can be computed honestly — token-gate.test.js and
         compute-server-net.test.js, over the real tables. */
      if (body.redeem) {
        /* 🔴 A REWARD ORDER IS GATED TOO, on the reward-inclusive net — the same rule the reward quote
           applied, over the menu in force NOW. Without this the reward path would be the one place a
           displayed-vs-charged skew could still pass through this suite unremarked, which is exactly
           the residual recorded below. Cells that use the fixed fixture reply (st.redeemLive false)
           opt out, because that reply is a constant and gating a constant against a live oracle would
           report an increase on every order for a reason that has nothing to do with the code. */
        if (!st.redeemLive) { st.gated.push({ signed: !!body.quote_token, ceiling: null, charged: nowCents, reward: true });
          return res({ ok: true, order_id: 'T9' }); }
        const rewardNow = rewardNetCents(dir, st.menuNow, body.items || []);
        if (rewardNow === null) return rej({ error: 'bad_cart' });
        const rJudged = judgeToken(body, B.rid, resolveReward(body.redeem, body.items || [], B.rid));
        if (rJudged.refuse) return rej(rJudged.refuse);
        const rCeil = rJudged.ceiling;
        if (rCeil !== null && rewardNow > rCeil) return rej({ error: 'price_increased', net_total_cents: rewardNow });
        st.gated.push({ signed: !!body.quote_token, ceiling: rCeil, charged: rewardNow, reward: true });
        return res({ ok: true, order_id: 'T9', charged_cents: rewardNow });
      }
      const judged = judgeToken(body, B.rid, null);
      if (judged.refuse) return rej(judged.refuse);
      const { ceiling, signed } = judged;
      if (ceiling !== null && nowCents > ceiling) {
        return rej({ error: 'price_increased', net_total_cents: nowCents });
      }
      st.gated.push({ signed, ceiling, charged: nowCents });
      return res({ ok: true, order_id: 'T9', charged_cents: nowCents });
    }
    return idle;                                  // everything else hangs — see the harness note
  };
  return { w, B, st };
}

/* 🔴 AN AUTHENTICATED SESSION, so a blocked send is attributable to the REWARD gate. Both charge paths
   guard on the ID token BEFORE the send gate — with a reward pending and no token they bail at
   "No pudimos verificar tu sesión". A reward cell without a session would therefore observe "nothing
   charged" and prove nothing about the gate under test: the auth guard would have done it. */
const ACCT_MARKER = { 'xpizza-orders': 'xpizza_acct', 'la-musa-orders': 'lamusa_acct' };
function authenticate(ctx, dir) {
  /* 🔴 THE LOCAL MARKER, NOT JUST A TOKEN. account.js decides guest-vs-customer from the localStorage
     marker — `if (!m || !m.name)` clears any pending reward outright — so a fixture with only an ID
     token is still a GUEST to the redeem code. Cell 14 previously observed a reward clearing on a cart
     change and reported it as general behaviour; it was the guest branch, and the cell was describing
     the fixture rather than the form. The token is still installed because both charge paths check it
     BEFORE the send gate, and without it a reward send bails at the session guard instead. */
  try { ctx.w.localStorage.setItem(ACCT_MARKER[dir], JSON.stringify({ uid: 'u-test', name: 'Cliente Prueba' })); } catch (_) {}
  ctx.w.__ACCOUNT = Object.assign({}, ctx.w.__ACCOUNT, {
    customerIdToken: () => Promise.resolve('test-id-token'),
  });
}

/* Install a reward AND a legitimately-stamped quote through the module's OWN writers: restoreRedeem
   sets the pending reward and deliberately drops any saved quote, then requoteRedeem fetches and stamps
   one against the current cart and menu version. Hand-stamping would be inventing the very state the
   gate is supposed to derive. */
async function installReward(ctx, reward) {
  const acct = ctx.w.__ACCOUNT;
  acct.restoreRedeem(reward, null, null);
  await acct.requoteRedeem(ctx.w.redeemCartItems());
  await settle();
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
async function sendAndJudge(ctx, dir, label, opts = {}) {
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
    /* NOT awaited, since 1C. When the gate refuses on a price increase the form raises a re-confirm
       sheet and submitOrder does not settle until the customer answers — awaiting it here would
       deadlock the suite against a dialog nobody is going to click. The fetch record, and the presence
       of that sheet, are the assertions. */
    /* 🔴 WHICH ENDPOINT, DRIVEN FOR REAL. `selectedPayment` is a LEXICAL binding inside the form
       script, so setting window.selectedPayment changes nothing the form reads — an earlier version of
       the matrix did exactly that and every "card" row went to createOrder, leaving chargeOnlineOrder
       (a different handler, with different bailouts, where 1C T5 found a card-only defect) untested
       while claiming both endpoints. selectPay() is the form's own setter. */
    const pending = opts.card
      ? (ctx.w.selectPay('online'), ctx.w.processPixelPay())
      : ctx.w.submitOrder('confirmed');
    if (pending && pending.catch) pending.catch(() => {});
  }
  await settle(); await settle();
  /* 🔴 A PRICE-INCREASE SHEET IS AN OUTCOME, NOT A FAILURE TO SEND. It is 1C refusing to charge more
     than the customer agreed to, and it is the outcome the two residual cells below were written to
     wait for. Reported as its own kind so a cell must say which it expects — a cell that wanted a
     charge and got a sheet should fail loudly, not silently count zero charges. */
  const sheet = ctx.w.document.querySelector('.cq-sheet');
  if (sheet) {
    const shown = sheet.textContent.replace(/\s+/g, ' ');
    return { outcome: 'increase_sheet', confirmed, shown, sheet };
  }
  const sent = ctx.st.charges.slice(before);
  if (refused) {
    assert.strictEqual(sent.length, 0,
      `${dir}/${label}: 🔴 the send was refused, so NOTHING may have reached a charge endpoint`);
    return { outcome: 'refused', confirmed };
  }
  /* 🔴 1C CHANGED THE SHAPE OF "ONE SEND". A body whose cart moved after it was quoted now meets the
     confirmed-quote gate, is refused on its fingerprint, and is resent SILENTLY with the displayed net
     as an unsigned ceiling — so an unrefused outcome can legitimately be two requests. The invariant
     this suite exists for is unchanged and is asserted on the one that actually charged: the customer
     pays what they confirmed. Bounded at two, because a third would mean the single-retry guard has
     stopped holding and the recovery is looping. */
  assert.ok(sent.length >= 1 && sent.length <= 2,
    `${dir}/${label}: non-vacuity — an unrefused send must reach a charge endpoint, at most once retried (got ${sent.length})`);
  const paid = sent[sent.length - 1];
  const charged = serverTotalCents(dir, ctx.st.menuNow, paid.items);
  assert.notStrictEqual(charged, null,
    `${dir}/${label}: 🔴 every line the form sent must be priceable by the server`);
  assert.notStrictEqual(confirmed, null,
    `${dir}/${label}: 🔴 a charge went out with NO confirmed total on screen — the customer agreed to nothing`);
  /* 🔴 1C REFINES THIS INVARIANT, and the refinement is in the customer's favour. 1B asserted
     charged == confirmed, which was right when nothing could move the price between the two. 1C
     reprices at the send: a DROP is passed on, so the customer pays LESS than they confirmed, and
     asserting equality here would fail the suite for the one outcome nobody could object to. What must
     never happen is the other direction. So: never more than confirmed, and exactly the server's own
     recompute — two assertions where there was one, because "charged == confirmed" was doing both jobs
     and only one of them survives repricing. */
  assert.ok(charged <= confirmed,
    `${dir}/${label}: 🔴 CHARGED ${charged} > CONFIRMED ${confirmed} — ${paid.url} sent ${JSON.stringify(paid.items)}`);
  const accepted = ctx.st.gated[ctx.st.gated.length - 1];
  if (accepted && !accepted.reward) {
    assert.strictEqual(accepted.charged, charged,
      `${dir}/${label}: 🔴 the amount accepted by the gate is the server's own recompute, not the payload's`);
  }
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

    const chargedBefore12 = ctx.st.gated.length;   // ACCEPTED charges — reaching the endpoint is not being charged
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
    /* ── 🔴 THE 1C RESIDUAL, NOW CLOSED ─────────────────────────────────────────────────────────
       This cell was written in 1B as 1C's regression test, in so many words: "when 1C's expected-total
       gate lands, THIS is the cell that turns into its regression test." It is that now.

       The state is unchanged: the catalog has moved and the form has not caught up, because a failed
       or deferred apply deliberately does not invalidate the quote — nothing on screen changed, so the
       quote still matches the SCREEN. It just no longer matches the SERVER. In 1B, sending here
       charged the CURRENT catalog price against a stale confirmation: confirmed 34000, charged 38000,
       and neither the customer nor the form had any way to notice.
       1C makes that impossible in the only way that survives a pricing cache and a checkout hold: not
       "tile == charge, live", which the hold makes unachievable, but "the customer is charged exactly
       what they CONFIRMED". The token says what was confirmed, the server reprices, and a figure above
       the confirmed one is refused rather than charged. */
    assert.strictEqual(ctx.w.getServerQuoteTotalCents(), confirmed,
      `${dir}/sync-throw: the cached quote is untouched by a failed apply — this is the input to the finding`);

    const serverNow = serverTotalCents(dir, ctx.st.menuNow, ctx.w.redeemCartItems());
    assert.ok(serverNow > confirmed,
      `${dir}/sync-throw: premise — the server's price has moved ABOVE the confirmed one (${serverNow} vs ${confirmed})`);

    const out = await sendAndJudge(ctx, dir, 'sync-throw-1c');
    assert.strictEqual(out.outcome, 'increase_sheet',
      `${dir}/sync-throw: 🔴 THE 1B RESIDUAL, CLOSED — a stale confirmation must be REFUSED at the send, not charged at the new price`);
    assert.ok(out.shown.includes((serverNow / 100).toFixed(2)),
      `${dir}/sync-throw: …and the customer is shown the new price, not asked to agree to a number nobody named (${out.shown})`);
    /* st.gated, not st.charges: the request DOES reach the endpoint — that is where the gate lives —
       and is refused there. What must not happen is a charge, and the fake records those separately
       precisely so "it was sent" cannot be mistaken for "it was charged". */
    assert.strictEqual(ctx.st.gated.length, chargedBefore12,
      `${dir}/sync-throw: 🔴 …with NOTHING charged while they decide`);

    /* 🔴 WHAT ACTUALLY CLOSES THIS, pinned rather than left incidental. Removing the signed token
       alone does NOT reopen the residual: the send falls to T6's unsigned ceiling and the stale
       confirmation is still refused. Removing BOTH reproduces it exactly — charged 38000 against a
       confirmed 34000, the 1B finding verbatim. So the guarantee is "the send states what the customer
       confirmed", by signature or by ceiling, and the cell asserts THAT rather than the presence of a
       token that happens to be one of two ways to satisfy it. */
    const stated = ctx.st.charges[ctx.st.charges.length - 1];
    assert.ok(stated && (stated.quote_token || typeof stated.expected_net_cents === 'number'),
      `${dir}/sync-throw: 🔴 the send must STATE what was confirmed — a token or an explicit ceiling; with neither, 1B's 34000-confirmed/38000-charged returns`);
    ok(`${dir}: 🔴 1C CLOSES THE 1B RESIDUAL — a stale confirmation is refused at the send, never charged at the new price`);

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

  /* ── CELL 14: A REWARD QUOTE IS ONLY GOOD FOR THE CART IT WAS PRICED FOR ──────────────────────
     Driven through the REAL account module — restoreRedeem() puts a genuine reward + server quote in
     place and stamps it with the cart it was priced for, exactly as the live redeem flow does. An
     earlier version of this cell stubbed __ACCOUNT and cleared the price by hand, which tested the stub
     and left the cart conflicted so the refusal it observed was the conflict, not the reward.

     THE REPRODUCTION THIS CLOSES: reward active on a cart → the cart reprices → the reward's total is
     still the one computed before the change → the customer confirms it and is charged the new one
     (L340 shown, L410 charged). Re-quoting on apply narrows that window; it cannot close it, because a
     re-quote is asynchronous and a stale answer can still be standing when the tap lands. The signature
     closes it: a quote not priced for the cart in front of the customer does not count. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);

    const items = ctx.w.redeemCartItems();
    const reward = { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] };
    authenticate(ctx, dir);
    await installReward(ctx, reward);
    assert.strictEqual(ctx.w.__ACCOUNT.getRedeemQuoteTotalCents(), 5000,
      `${dir}/reward: premise — a real reward quote is standing`);
    assert.strictEqual(ctx.w.__ACCOUNT.redeemQuoteMatches(ctx.w.redeemCartItems()), true,
      `${dir}/reward: premise — and it matches the cart it was priced for`);
    assert.strictEqual(ctx.w.refuseConflictedSend('reward-fresh'), false,
      `${dir}/reward: 🔴 a reward priced for THIS cart does not block anything`);

    /* Now the cart changes underneath it — by quantity, so the line stays perfectly RESOLVED. That
       matters: a reprice would also mark the line conflicted, and the refusal below would then prove
       nothing about the reward. Here the only thing wrong is that the reward was priced for a cart
       that no longer exists. */
    /* 🔴 WHAT AN AUTHENTICATED CUSTOMER'S CART CHANGE ACTUALLY DOES — and the earlier version of this
       cell got it wrong in a way worth recording. It asserted that a cart change CLEARS the pending
       reward, so "there is nothing left to go stale". That is the GUEST branch: account.js decides from
       the localStorage marker, and the fixture installed only an ID token, so the redeem code treated
       the session as a guest and cleared the reward. The cell was describing its own fixture.
       With a real marker the reward SURVIVES the cart change — which is the case that matters, since a
       reward only exists for a signed-in customer. The quote is then stale by CART, and the gate
       refuses it. So the gate's coverage is BROADER than the old cell claimed, not narrower: it handles
       the survivor rather than relying on the reward having been cleared. */
    ctx.w.chg(d.id, 1);
    await settle();
    assert.ok(ctx.w.__ACCOUNT.getRedeemPayload(),
      `${dir}/reward: an AUTHENTICATED customer's reward SURVIVES a cart change — it is not cleared`);
    assert.strictEqual(ctx.w.__ACCOUNT.getRedeemQuoteTotalCents(), 5000,
      `${dir}/reward: …and its total is still standing, priced for the cart before the change`);
    assert.notDeepStrictEqual(items.map((i) => [i.name, i.qty]),
      ctx.w.redeemCartItems().map((i) => [i.name, i.qty]),
      `${dir}/reward: non-vacuity — the cart really did change under it`);
    assert.strictEqual([...ctx.w.cartConflicts()].length, 0,
      `${dir}/reward: non-vacuity — the cart is UNCONFLICTED, so only the reward can refuse the send`);
    assert.strictEqual(ctx.w.__ACCOUNT.redeemQuoteMatches(ctx.w.redeemCartItems()), false,
      `${dir}/reward: 🔴 the surviving quote no longer matches the cart it was priced for`);
    const r = await sendAndJudge(ctx, dir, 'reward-stale-cart');
    assert.strictEqual(r.outcome, 'refused',
      `${dir}/reward: 🔴 …and the send is refused — the gate handles the SURVIVOR, it does not rely on a clear`);
    const err = ctx.w.document.getElementById('err3') || ctx.w.document.getElementById('err1');
    assert.match((err && err.textContent) || '', /premio/i,
      `${dir}/reward: 🔴 …naming the reward, not a generic conflict`);
    ok(`${dir}: an authenticated customer's reward SURVIVES a cart change and the gate refuses the stale quote`);
  }

  /* ── CELL 14c: THE REPRICE-THEN-ROLLBACK ESCAPE ────────────────────────────────────────────────
     The reproduction that defeated the first signature. A reprice followed by a rollback leaves the
     CART byte-identical — same dish, same quantity, same reward — while the PRICES moved and came back.
     Hashing (items + reward) matched throughout, so a quote computed against the intermediate menu
     passed as fresh. Hashing the priced-menu VERSION is what makes it mismatch, and this cell is the
     proof: the signature must differ at v2 and the send must refuse there.
     Note it also asserts the RETURN to v1 matches again — a version digest that never re-matched would
     block every order forever and would pass a test that only checked the mismatch. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const reward = { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] };
    authenticate(ctx, dir);
    const itemsAt1 = ctx.w.redeemCartItems();
    await installReward(ctx, reward);
    const v1 = ctx.w.liveMenuPriceVersion();
    assert.ok(v1, `${dir}/rollback: premise — the priced-menu version is computable`);
    assert.strictEqual(ctx.w.__ACCOUNT.redeemQuoteMatches(ctx.w.redeemCartItems()), true,
      `${dir}/rollback: premise — the reward quote matches at v1`);

    /* The price is moved DIRECTLY on the live MENU record rather than through a publish, and that is
       deliberate: it changes exactly one thing — the priced-menu version — which is the variable this
       cell exists to isolate. A publish would also re-render the menu and, if it touched the cart's own
       dish, conflict that line, so the refusal could no longer be attributed to the reward.
       (An earlier note here said an apply CLEARS the reward. That was observed against a guest fixture
       and is not true of the authenticated path this file now tests — the reward survives. The reason
       for mutating directly is isolation, not preservation.) */
    /* 🔴 THE DISH MOVED IS ONE THAT IS **NOT IN THE CART**. Repricing the cart's own dish would ALSO
       mark its line conflicted, and then the send gate would refuse for two reasons at once — the
       assertion below would pass on the conflict and say nothing about the reward. Moving an unrelated
       dish changes the priced-menu version and leaves the cart perfectly resolved, so the reward is the
       only thing that can refuse. This is the same attribution trap as the auth guard, one layer in. */
    const rec = ctx.w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && String(x.id) !== String(d.id));
    assert.ok(rec, `${dir}/rollback: premise — there is an unrelated dish to reprice`);
    const priceAt1 = rec.price;
    assert.deepStrictEqual(
      ctx.w.redeemCartItems().map((i) => [i.name, i.qty]), itemsAt1.map((i) => [i.name, i.qty]),
      `${dir}/rollback: non-vacuity — the CART is unchanged, which is why an items-only signature matched`);

    rec.price = priceAt1 + 70;                       // v2 — the merchant reprices; the cart is untouched
    assert.notStrictEqual(ctx.w.liveMenuPriceVersion(), v1,
      `${dir}/rollback: 🔴 the priced-menu version MOVED with the reprice`);
    assert.strictEqual(ctx.w.__ACCOUNT.redeemQuoteMatches(ctx.w.redeemCartItems()), false,
      `${dir}/rollback: 🔴 …so the reward quote no longer matches, and cannot reach a charge`);
    assert.strictEqual([...ctx.w.cartConflicts()].length, 0,
      `${dir}/rollback: non-vacuity — the CART is unconflicted, so only the reward can refuse`);
    assert.strictEqual(ctx.w.refuseConflictedSend('rollback-v2'), true,
      `${dir}/rollback: 🔴 …and the send gate refuses at v2, on the reward alone`);

    rec.price = priceAt1;                            // …rolled back: the CART never changed at any point
    assert.strictEqual(ctx.w.liveMenuPriceVersion(), v1,
      `${dir}/rollback: the version returns to v1 on rollback`);
    assert.strictEqual(ctx.w.__ACCOUNT.redeemQuoteMatches(ctx.w.redeemCartItems()), true,
      `${dir}/rollback: 🔴 …and the v1-stamped quote matches again — the digest is not a one-way latch`);
    /* ── 🔴 THE REWARD RESIDUAL, NOW CLOSED ────────────────────────────────────────────────────
       Everything above is what the BROWSER can observe, and 1B closed all of it. What it could not
       close is stated exactly: the client stamp is taken from what the browser has seen, so when the
       SERVER's catalog has moved and this form has not fetched it yet, the stamp is self-consistent,
       the client gate allows, and the reward total can still differ from the charge. No client-side
       signature can close that — the comparison has to happen where both numbers exist.
       1C puts it there. The reward quote is SIGNED over the cart AND the reward (cartFingerprint takes
       the reward, which is the only witness that survives a la_musa add_free reward being
       net-invariant), and the server reprices the reward-inclusive net at the charge. A confirmation
       that no longer describes what the server would charge is refused.
       THIS CELL CARRIES THE REWARD PATH'S WHOLE-FLOW WEIGHT, deliberately: the synthetic gate excludes
       reward orders priced from the fixed fixture reply, so without a live-priced reward cell the
       reward path would be the one place a displayed-vs-charged skew could cross this suite unremarked.
       Here the reward is priced live, by the same rule, over two different menus. */
    ok(`${dir}: reprice-then-rollback — the priced-menu version is what makes a stale reward quote mismatch (browser-observed)`);
  }

  /* ── CELL 14g: 🔴 AN EXPIRED TOKEN MUST NOT THROW AWAY THE CONFIRMATION ───────────────────────
     The defect the closing gate found, and the one the per-task gates could not: under GRACE an
     expired token returned "no opinion" and the order charged whatever the catalog said now. The
     customer confirmed 340, sat at checkout past the issuance window, the price moved to 380, and they
     were charged 380 — the founding displayed-vs-charged bug, reachable for the whole grace period,
     which is the state this ships in.
     It survived every per-task gate because each was right about its own contract: the gate's expiry
     handling was correct in isolation (expiry IS ordinary, and refusing it under grace would block
     orders that work today), and the client's ceiling was correct in isolation (it is the fallback for
     having no token). Neither owned the case where a token EXISTS but has gone stale. That is the
     boundary this suite exists for.
     Asserted on BOTH endpoints and BOTH brands, because it is a money rule and the two handlers are
     different code. */
  for (const method of ['cash', 'card']) {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    ctx.st.tokenTtlMs = -60 * 1000;                  // issued already expired: the pay-tap-after-idle shape
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const confirmed = ctx.w.getServerQuoteTotalCents();
    assert.ok(confirmed > 0, `${dir}/expired-${method}: premise — a total is confirmed on screen`);

    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 40 } : x));
    ctx.st.menuNow = up;                             // the catalog moves; the form never hears
    const serverNow = serverTotalCents(dir, ctx.st.menuNow, ctx.w.redeemCartItems());
    assert.ok(serverNow > confirmed,
      `${dir}/expired-${method}: premise — the server is now dearer than the confirmation (${serverNow} vs ${confirmed})`);

    const gatedBefore = ctx.st.gated.length;
    assert.strictEqual(ctx.w.buildOrder(), true, `${dir}/expired-${method}: the order composes`);
    const out = await sendAndJudge(ctx, dir, `expired-${method}`, { card: method === 'card' });

    const wire = ctx.st.charges[ctx.st.charges.length - 1];
    assert.ok(wire && wire.url.includes(method === 'card' ? 'chargeOnlineOrder' : 'createOrder'),
      `${dir}/expired-${method}: the ${method} endpoint answered`);
    /* 🔴 NON-VACUITY: the token that actually travelled must verify as EXPIRED. An earlier version of
       this cell set a TTL that only reached the reward issuer, so the dispatched token verified as ok
       and the cell asserted the expired path while never taking it. */
    assert.ok(wire.quote_token, `${dir}/expired-${method}: premise — a token was dispatched`);
    assert.strictEqual(verifyQuoteToken(wire.quote_token, T9_SECRET, Date.now()).reason, 'expired',
      `${dir}/expired-${method}: 🔴 the dispatched token must genuinely be EXPIRED, not merely intended to be`);
    /* 🔴 THE CEILING MUST BE ON THE WIRE ALONGSIDE THE TOKEN. It is what the server falls back to when
       the token turns out to be stale, and without it there is nothing to fall back TO. */
    assert.strictEqual(typeof wire.expected_net_cents, 'number',
      `${dir}/expired-${method}: 🔴 the send must carry its ceiling alongside the token — an expired token with no ceiling is an open door`);
    assert.strictEqual(out.outcome, 'increase_sheet',
      `${dir}/expired-${method}: 🔴 an expired token + a risen price must REFUSE, not charge the new number`);
    assert.strictEqual(ctx.st.gated.length, gatedBefore,
      `${dir}/expired-${method}: 🔴 …and nothing is charged`);
  }
  ok(`${dir}: 🔴 an EXPIRED token keeps its confirmation — a risen price is refused on both endpoints, not charged`);

  /* ── CELL 14h: 🔴 A NET-INVARIANT REWARD — WHERE ONLY THE FINGERPRINT CAN TELL ────────────────
     Both brands' rewards resolve to model add_free with discount_cents 0: the reward ADDS a free line
     and a fiscal rebaja, and does not reduce the charged total. So a cart with the reward and the same
     cart without it price to the SAME net — the amount is blind to the difference, by construction and
     not by accident. The fingerprint is the only witness, which is the entire reason it hashes the
     resolved reward's model and freeItems rather than just the cart.
     Asserted end to end: a token signed for the reward-bearing cart must not authorise the same cart
     with the reward removed, even though nothing about the money changed. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const items = ctx.w.redeemCartItems();
    const norm = normalizeCartForFingerprint(items, BRAND[dir].rid);

    const raw = dir === 'la-musa-orders'
      ? { type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }] }
      : { type: 'free_pizza_choice', item_id: items[0].name };
    const resolved = resolveReward(raw, items, BRAND[dir].rid);
    assert.ok(resolved && resolved.model === 'add_free' && resolved.discount_cents === 0,
      `${dir}/net-invariant: premise — the reward really is net-invariant (add_free, no discount)`);

    /* 🔴 THE PREMISE THAT MAKES THIS CELL MEAN ANYTHING: with and without the reward, the money is
       identical. If these ever differ the amount could distinguish them and the fingerprint would not
       be the only witness — so it is asserted, not assumed. */
    /* 🔴 THE PREMISE, COMPUTED THROUGH REAL PRICING WITH AND WITHOUT THE REWARD. The first version of
       this called the same helper twice with the same arguments and compared the results — trivially
       equal, and equal for a reason that had nothing to do with the reward. That is a tautology
       wearing the clothes of a premise: it would have held just as well if the reward halved the bill.
       Priced through the real computeServerNet, once with the RESOLVED reward and once without, so the
       equality is a fact about add_free and not about my arithmetic. */
    const realTables = { restaurantId: BRAND[dir].rid,
      menu: MENU_BY_RESTAURANT[BRAND[dir].rid], extras: EXTRAS_BY_RESTAURANT[BRAND[dir].rid] };
    const netWithReward = computeServerNet({ items, reward: resolved, rid: BRAND[dir].rid, tables: realTables });
    const netWithout = computeServerNet({ items, reward: null, rid: BRAND[dir].rid, tables: realTables });
    assert.ok(!netWithReward.error && !netWithout.error,
      `${dir}/net-invariant: premise — both price cleanly (${netWithReward.error || netWithout.error})`);
    assert.strictEqual(netWithReward.net_total_cents, netWithout.net_total_cents,
      `${dir}/net-invariant: 🔴 premise — the reward is NET-INVARIANT: ${netWithReward.net_total_cents} with it, ${netWithout.net_total_cents} without`);
    assert.strictEqual(netWithReward.components.reward_discount_cents, 0,
      `${dir}/net-invariant: …because add_free discounts nothing — it adds a free line and a rebaja`);
    const withR = netWithReward.net_total_cents;

    const fpWith = cartFingerprint(norm, resolved);
    const fpWithout = cartFingerprint(norm, null);
    assert.notStrictEqual(fpWith, fpWithout,
      `${dir}/net-invariant: 🔴 the fingerprint MUST distinguish them — nothing else can`);

    // A token issued for the reward-bearing cart, presented for the same cart WITHOUT the reward.
    const tok = signQuoteToken({
      quote_id: 'ni1', rid: BRAND[dir].rid, customer_id: null, net_total_cents: withR,
      cart_fingerprint: fpWith, components: {}, redemption_ref: null,
      issued_at: Date.now(), expires_at: Date.now() + 900000,
    }, T9_SECRET);
    /* 🔴 THROUGH THE REAL COMPOSED PATH, not this file's judgeToken. judgeToken exists to MODEL the
       server for the cells that move a synthetic menu around; using it here would have this assertion
       check the model rather than the thing being shipped — and the fingerprint's reward binding is
       precisely the mechanism a model can get wrong without anyone noticing. The real adapter and the
       real gate, over the real pricing tables. */
    const realGateInput = (reward) => gateInputFromRequest(
      { items, quote_token: tok, expected_net_cents: withR },
      { reward, rid: BRAND[dir].rid, tables: realTables, secret: T9_SECRET, enforce: false, nowMs: Date.now() });
    const refused = gateConfirmedNet(realGateInput(null));
    assert.strictEqual(refused.action, 'refuse_invalid',
      `${dir}/net-invariant: 🔴 a reward-bound token must NOT authorise the reward-free cart (got ${refused.action})`);
    assert.strictEqual(refused.reason, 'cart_mismatch',
      `${dir}/net-invariant: 🔴 …refused on the FINGERPRINT, since the amount is identical either way`);
    // …and the converse, so the refusal is not just "this token never works".
    const honoured = gateConfirmedNet(realGateInput(resolved));
    assert.strictEqual(honoured.action, 'charge',
      `${dir}/net-invariant: non-vacuity — the same token IS honoured for the cart it describes`);
    assert.strictEqual(honoured.degraded, false,
      `${dir}/net-invariant: …through the SIGNED path, not the unsigned floor`);
    ok(`${dir}: 🔴 a net-invariant reward is distinguished by the FINGERPRINT alone — the amount cannot see it`);
  }

  /* ── CELL 14f: THE CONFIRMED-NET MATRIX, ON BOTH MONEY ENDPOINTS ──────────────────────────────
     The three answers 1C can give, asserted on each charge path rather than on one and assumed for the
     other. Cash and card are DIFFERENT handlers with different bailouts — 1C T5 found a real defect on
     the card path that the cash path did not have — so "both endpoints" is a claim that has to be made
     twice, not once. */
  for (const method of ['cash', 'card']) {
    for (const [label, delta, expect] of [
      ['equal',    0,   'charged'],
      ['drop',    -50,  'charged'],
      ['increase', +60, 'increase_sheet'],
    ]) {
      const ctx = await boot(dir);
      await publish(ctx, baseMenu(ctx.w));
      const d = plainDish(ctx.w);
      await addToCart(ctx, d);
      const confirmed = ctx.w.getServerQuoteTotalCents();
      assert.ok(confirmed > 0, `${dir}/${method}-${label}: premise — a total is confirmed on screen`);

      /* The SERVER's catalog moves; the form is deliberately not refreshed, so the confirmation the
         customer is holding is the one from before. delta 0 leaves it equal. */
      if (delta !== 0) {
        const up = baseMenu(ctx.w);
        up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + delta } : x));
        ctx.st.menuNow = up;
      }
      const serverNow = serverTotalCents(dir, ctx.st.menuNow, ctx.w.redeemCartItems());
      if (delta > 0) assert.ok(serverNow > confirmed, `${dir}/${method}-${label}: premise — the server is now dearer`);
      if (delta < 0) assert.ok(serverNow < confirmed, `${dir}/${method}-${label}: premise — the server is now cheaper`);

      const gatedBefore = ctx.st.gated.length;
      assert.strictEqual(ctx.w.buildOrder(), true, `${dir}/${method}-${label}: the order composes`);
      const out = await sendAndJudge(ctx, dir, `${method}-${label}`, { card: method === 'card' });
      /* 🔴 THE ROW ASSERTS WHICH ENDPOINT ANSWERED. Without this the matrix can claim both paths while
         sending everything to one, which is precisely what it was doing. */
      const wire = ctx.st.charges[ctx.st.charges.length - 1];
      assert.ok(wire && wire.url.includes(method === 'card' ? 'chargeOnlineOrder' : 'createOrder'),
        `${dir}/${method}-${label}: 🔴 the ${method} row must reach ${method === 'card' ? 'chargeOnlineOrder' : 'createOrder'} (got ${wire && wire.url})`);
      assert.strictEqual(out.outcome, expect,
        `${dir}/${method}-${label}: 🔴 expected ${expect}, got ${out.outcome}`);

      if (expect === 'charged') {
        const acc = ctx.st.gated.slice(gatedBefore);
        assert.strictEqual(acc.length, 1, `${dir}/${method}-${label}: exactly one accepted charge`);
        assert.strictEqual(acc[0].charged, serverNow,
          `${dir}/${method}-${label}: 🔴 the SERVER's own recompute is what is charged`);
        assert.ok(acc[0].ceiling === null || acc[0].charged <= acc[0].ceiling,
          `${dir}/${method}-${label}: 🔴 …and never above what the customer confirmed (${acc[0].charged} vs ${acc[0].ceiling})`);
        if (delta < 0) assert.ok(acc[0].charged < confirmed,
          `${dir}/${method}-${label}: 🔴 a DROP is passed on — the customer pays the lower number, silently`);
      } else {
        assert.strictEqual(ctx.st.gated.length, gatedBefore, `${dir}/${method}-${label}: 🔴 an increase charges NOTHING`);
        assert.ok(out.shown.includes((serverNow / 100).toFixed(2)),
          `${dir}/${method}-${label}: …and names the new price (${out.shown})`);
      }
    }
  }
  ok(`${dir}: confirmed-net on BOTH money endpoints — equal and drop charge the server net, an increase refuses`);

  /* ── CELL 14e: SERVER-SIDE REWARD SKEW — the 1C closure ────────────────────────────────────────*/
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));           // the server's pricing basis — boot leaves it unset
    ctx.st.redeemLive = true;                      // price the reward from the menu in force, and sign it
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    authenticate(ctx, dir);
    const reward = { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] };
    ctx.st.rewardPayload = reward;
    await installReward(ctx, reward);
    assert.ok(ctx.w.__ACCOUNT.getRedeemPayload(), `${dir}/reward-skew: premise — a reward is active`);

    const confirmedReward = ctx.w.__ACCOUNT.getRedeemQuoteTotalCents();
    assert.ok(typeof confirmedReward === 'number' && confirmedReward > 0,
      `${dir}/reward-skew: premise — the customer has a priced reward total on screen (${confirmedReward})`);
    assert.strictEqual(confirmedReward, rewardNetCents(dir, ctx.st.menuNow, ctx.w.redeemCartItems()),
      `${dir}/reward-skew: premise — and it is the reward-inclusive net for the menu in force`);

    /* 🔴 THE SERVER'S CATALOG MOVES AND THE FORM NEVER HEARS ABOUT IT. Exactly the residual: the feed
       is not refreshed, so every client-side signature still matches — same cart, same reward, same
       menu version as far as the browser knows. Only the server knows the price changed. */
    const up = baseMenu(ctx.w);
    up.dishes = up.dishes.map((x) => (String(x.id) === String(d.id) ? { ...x, price: x.price + 60 } : x));
    ctx.st.menuNow = up;                           // server-side only — deliberately NOT published to the feed
    assert.strictEqual(ctx.w.__ACCOUNT.redeemQuoteMatches(ctx.w.redeemCartItems()), true,
      `${dir}/reward-skew: 🔴 premise — every CLIENT check still says fresh; this skew is invisible to the browser`);
    const serverRewardNow = rewardNetCents(dir, ctx.st.menuNow, ctx.w.redeemCartItems());
    assert.ok(serverRewardNow > confirmedReward,
      `${dir}/reward-skew: premise — the server's reward net has moved above the confirmed one (${serverRewardNow} vs ${confirmedReward})`);

    const chargedBefore = ctx.st.gated.length;
    assert.strictEqual(ctx.w.buildOrder(), true, `${dir}/reward-skew: the order composes`);
    const out = await sendAndJudge(ctx, dir, 'reward-skew');
    assert.strictEqual(out.outcome, 'increase_sheet',
      `${dir}/reward-skew: 🔴 THE 1B REWARD RESIDUAL, CLOSED — a reward confirmation the server would no longer honour is refused, not charged`);
    assert.strictEqual(ctx.st.gated.length, chargedBefore,
      `${dir}/reward-skew: 🔴 …and nothing was charged`);
    const lastSent = ctx.st.charges[ctx.st.charges.length - 1];
    assert.ok(lastSent && lastSent.redeem, `${dir}/reward-skew: non-vacuity — the refused send really carried the reward`);
    assert.ok(lastSent.quote_token || typeof lastSent.expected_net_cents === 'number',
      `${dir}/reward-skew: 🔴 the send stated what was confirmed — by signature or ceiling`);
    /* 🔴 WHAT THIS CELL ADDS, STATED HONESTLY. It is closed by the SAME mechanism as cell 12 — the
       send states what was confirmed — and I could not construct a mutation that only this cell
       catches: removing the token alone falls to the ceiling, removing the ceiling alone falls to the
       token, and removing both is caught by cell 12 first because it runs earlier. That shared
       mechanism is an architectural result, not a gap, and pretending otherwise would be the
       over-claim this suite's own header warns about.
       What this cell independently establishes is that the mechanism holds where the CONFIRMED NUMBER
       IS A REWARD NET — a figure the cart alone cannot produce, carried by a token whose fingerprint
       binds the reward (the only witness that survives a la_musa add_free reward being net-invariant)
       — and where the skew is invisible to every client-side check, which the premises above assert
       rather than assume: redeemQuoteMatches still answers true, and the server's reward net has
       genuinely moved above the confirmed one. */
    ok(`${dir}: 🔴 1C CLOSES THE REWARD RESIDUAL — a server-side reward skew the browser cannot see is refused at the send`);
  }

  /* ── CELL 14d: THE GATE FAILS CLOSED ───────────────────────────────────────────────────────────
     Both directions that were open: a MISSING matcher defaulted to "fresh", and an exception inside
     the reward check was swallowed and the send proceeded. Neither is evidence a total is current. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const reward = { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] };
    authenticate(ctx, dir);
    await installReward(ctx, reward);
    assert.strictEqual(ctx.w.refuseConflictedSend('probe'), false, `${dir}/fail-closed: premise — fresh, allowed`);

    const realMatch = ctx.w.__ACCOUNT.redeemQuoteMatches;
    delete ctx.w.__ACCOUNT.redeemQuoteMatches;       // an older account module than this form
    assert.strictEqual(ctx.w.refuseConflictedSend('no-matcher'), true,
      `${dir}/fail-closed: 🔴 a priced reward with NO matcher blocks — it used to default to fresh`);
    ctx.w.__ACCOUNT.redeemQuoteMatches = () => { throw new Error('boom'); };
    assert.strictEqual(ctx.w.refuseConflictedSend('matcher-throws'), true,
      `${dir}/fail-closed: 🔴 an exception in the reward check blocks — it used to be swallowed`);
    ctx.w.__ACCOUNT.redeemQuoteMatches = realMatch;
    assert.strictEqual(ctx.w.refuseConflictedSend('restored'), false,
      `${dir}/fail-closed: non-vacuity — with the matcher back, the same cart is allowed again`);
    ok(`${dir}: the reward check fails CLOSED — a missing matcher and a throwing one both block`);
  }

  /* ── CELL 14b: AND THE HAPPY PATH STILL CHARGES ──────────────────────────────────────────────
     A gate that refuses everything would pass the cell above. Re-stamping for the CURRENT cart — what
     a completed re-quote does — must let the order through again, or A-minimal would have closed the
     window by making rewards unusable. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    const reward = { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] };
    authenticate(ctx, dir);
    await installReward(ctx, reward);
    /* Made stale by a reprice of an UNRELATED dish: that moves the priced-menu version while leaving the
       cart line resolved, so the reward is provably the only thing that can refuse the send. */
    const other = ctx.w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && String(x.id) !== String(d.id));
    other.price = other.price + 55;      // an UNRELATED dish — the cart line stays resolved
    assert.strictEqual([...ctx.w.cartConflicts()].length, 0,
      `${dir}/reward-happy: non-vacuity — the cart is unconflicted, so the reward is the only blocker`);
    assert.strictEqual(ctx.w.refuseConflictedSend('probe'), true, `${dir}/reward-happy: premise — stale, so blocked`);
    await ctx.w.__ACCOUNT.requoteRedeem(ctx.w.redeemCartItems());   // the re-quote lands, at the new version
    assert.strictEqual(ctx.w.refuseConflictedSend('probe'), false,
      `${dir}/reward-happy: 🔴 a reward re-priced for the current cart is orderable again`);
    assert.strictEqual(ctx.w.buildOrder(), true,
      `${dir}/reward-happy: 🔴 …and the order composes, so the gate is not a blanket refusal`);
    /* Deliberately stops at the composition rather than driving the charge. A pending reward routes
       submitOrder through the redemption plumbing, which a synthetic quote cannot supply faithfully —
       and a cell that drove it would be asserting against a fixture, not the code. What this cell owes
       the matrix is that A-minimal does not make rewards unusable, and that is exactly what the gate
       and the composition show. The reward-NET charged==confirmed path is 1C's, with the confirmed-
       total gate; the server-side redemption pricing is covered by rewards-redeem*.test.js today. */
    ok(`${dir}: a reward re-priced for the current cart passes the gate and composes — not a blanket refusal`);
  }

  /* ── CELL 14e: THE REWARD GATE AT THE SUBMIT, WITH A POSITIVE DISPATCH CONTROL ─────────────────
     Every reward cell above stops at the gate or at the composition. That leaves submit-level
     attribution unestablished: "nothing charged" is also what an auth bail, an empty cart or a
     conflicted line produce, so a refusal observed at the send proves nothing on its own.
     This cell pairs the two halves. A FRESH reward must actually DISPATCH — the control, without which
     every negative here is vacuous and a blanket refusal would pass — and then the same cart, with the
     reward made stale by an unrelated reprice, must NOT. Same window, same session, same cart, one
     variable changed: the freshness of the reward quote. */
  {
    const ctx = await boot(dir);
    await publish(ctx, baseMenu(ctx.w));
    const d = plainDish(ctx.w);
    await addToCart(ctx, d);
    authenticate(ctx, dir);
    await installReward(ctx, { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] });
    assert.ok(ctx.w.__ACCOUNT.getRedeemPayload(), `${dir}/reward-submit: premise — a reward is active`);

    // ── CONTROL: a FRESH reward dispatches through the real send path.
    const before = ctx.st.charges.length;
    assert.strictEqual(ctx.w.buildOrder(), true, `${dir}/reward-submit: the order composes with a reward`);
    { const pd = ctx.w.submitOrder('confirmed'); if (pd && pd.catch) pd.catch(() => {}); }
    await settle(); await settle();
    const dispatched = ctx.st.charges.slice(before);
    assert.strictEqual(dispatched.length, 1,
      `${dir}/reward-submit: 🔴 CONTROL — a fresh reward DISPATCHES; without this every refusal below is vacuous`);
    assert.ok(dispatched[0].redeem, `${dir}/reward-submit: …and the charge actually carries the redemption`);

    // ── And the same order with a STALE reward does not, for the reward's reason and no other.
    const ctx2 = await boot(dir);
    await publish(ctx2, baseMenu(ctx2.w));
    const d2 = plainDish(ctx2.w);
    await addToCart(ctx2, d2);
    authenticate(ctx2, dir);
    await installReward(ctx2, { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] });
    const other = ctx2.w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && String(x.id) !== String(d2.id));
    other.price = other.price + 33;                    // UNRELATED dish → the cart line stays resolved
    assert.strictEqual([...ctx2.w.cartConflicts()].length, 0,
      `${dir}/reward-submit: non-vacuity — the cart is unconflicted`);
    assert.ok(ctx2.w.__ACCOUNT.getRedeemPayload(), `${dir}/reward-submit: non-vacuity — the reward is still active`);
    assert.strictEqual(ctx2.w.__ACCOUNT.redeemQuoteMatches(ctx2.w.redeemCartItems()), false,
      `${dir}/reward-submit: non-vacuity — and its quote is stale`);
    const before2 = ctx2.st.charges.length;
    ctx2.w.buildOrder();
    await ctx2.w.submitOrder('confirmed');
    await settle();
    assert.strictEqual(ctx2.st.charges.length, before2,
      `${dir}/reward-submit: 🔴 a stale reward reaches NO charge endpoint through the real submit path`);

    /* 🔴 …AND A GENUINE INTERNAL RETRY, which is the only version of this that proves anything.
       Calling submitOrder twice does NOT exercise the loop: each call starts at attempt 1 and returns
       on refusal, so a gate accidentally hoisted OUT of the loop would still pass. The loop re-sends
       createOrder WITHOUT rebuilding the order, and that is precisely the bypass that defeated two
       earlier caller-side gates in T4 — first request 5xx, the merchant republishes during the backoff,
       the retry sends the stale cart. So: the first request really fails, the reward really goes stale
       during the real 1500ms backoff, and attempt 2 must be refused by the gate INSIDE the loop. */
    const ctx3 = await boot(dir);
    await publish(ctx3, baseMenu(ctx3.w));
    const d3 = plainDish(ctx3.w);
    await addToCart(ctx3, d3);
    authenticate(ctx3, dir);
    await installReward(ctx3, { type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] });

    let attempts = 0;
    const passthru = ctx3.w.__respond;
    ctx3.w.__respond = (url, init) => {
      if (CHARGE_RE.test(url)) {
        attempts += 1;
        ctx3.st.charges.push({ url, ...JSON.parse((init && init.body) || '{}') });
        // Attempt 1 fails with a RETRYABLE 5xx, so the loop backs off and comes round again.
        if (attempts === 1) return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: () => Promise.resolve({}) });
        return res({ ok: true });
      }
      return passthru(url, init);
    };
    /* The gate logs where it refused. Capturing that is what distinguishes "attempt 2 was refused by the
       gate inside the loop" from "the loop never came round at all" — without it, a loop that exited
       early for an unrelated reason would satisfy the attempt-count assertion just as well. */
    const warned = [];
    const realWarn = ctx3.w.console.warn;
    ctx3.w.console.warn = (...a) => { warned.push(a.join(' ')); };
    assert.strictEqual(ctx3.w.buildOrder(), true, `${dir}/reward-retry: the order composes`);
    const inflight = ctx3.w.submitOrder('confirmed');
    await settle();
    assert.strictEqual(attempts, 1,
      `${dir}/reward-retry: non-vacuity — attempt 1 really was dispatched and really failed`);

    // The merchant republishes DURING the backoff: an unrelated dish, so the cart line stays resolved
    // and the reward quote — not a cart conflict — is the only thing that has gone stale.
    const other3 = ctx3.w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && String(x.id) !== String(d3.id));
    other3.price = other3.price + 41;
    assert.strictEqual([...ctx3.w.cartConflicts()].length, 0,
      `${dir}/reward-retry: non-vacuity — the cart is unconflicted during the backoff`);
    assert.strictEqual(ctx3.w.__ACCOUNT.redeemQuoteMatches(ctx3.w.redeemCartItems()), false,
      `${dir}/reward-retry: non-vacuity — the reward quote is stale by the time attempt 2 is due`);

    await new Promise((r) => setTimeout(r, 1800));   // outlast the real attempt*1500 backoff
    await settle();
    await inflight.catch(() => {});
    ctx3.w.console.warn = realWarn;
    assert.strictEqual(attempts, 1,
      `${dir}/reward-retry: 🔴 attempt 2 was REFUSED INSIDE THE LOOP — the retry never re-sent the stale reward`);
    const atCreate = warned.filter((l) => l.includes('cart_blocked_send_reward_unpriced') && l.includes('createOrder'));
    assert.ok(atCreate.length >= 1,
      `${dir}/reward-retry: 🔴 …and the refusal was logged AT createOrder, proving the loop came round and the gate inside it fired (saw ${JSON.stringify(warned.slice(-3))})`);
    ok(`${dir}: at the SUBMIT — a fresh reward dispatches, a stale one never does, retry included`);
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
    /* 🔴 NOT ASSERTED AS AN EXPECTATION — same reasoning as cell 12. The server would price this
       payload at the NEW catalog, so charged ≠ confirmed here; writing that down as `assert(charged !==
       confirmed)` would pin a displayed-vs-charged difference as the CORRECT outcome, and the whole
       point is that 1C's confirmed-total gate is going to make it false. Recorded as a value, not as a
       rule, so when that gate lands this line becomes its regression test rather than its obstacle. */
    const charged = serverTotalCents(dir, ctx.st.menuNow, ctx.st.charges[0].items);
    assert.strictEqual(typeof charged, 'number',
      `${dir}/mid-submit: the in-flight payload remains priceable by the server (charged ${charged}, confirmed ${confirmed})`);
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
