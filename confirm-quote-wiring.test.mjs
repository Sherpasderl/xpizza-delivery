// Portal 1C Task 7 — THE WIRING, ON A REAL LOAD. Run: node confirm-quote-wiring.test.mjs
//
// 🔴 WHY THIS EXISTS ALONGSIDE THE UNIT TESTS. form-confirm-quote.test.mjs proves the module's rules
// against a harness it fully controls. It cannot prove that the FORM calls it — that the store sits
// inside the superseded guard, that the signature the store captures is the one the attach later
// recomputes, that `__confirmQuote` is even defined by the time a send runs. Those are load-time and
// ordering facts, and this repo has a history of exactly that failure: a temporal-dead-zone
// ReferenceError that took a whole form down, and a structural test that could not see it
// ([[structural-tests-blind-to-runtime]]).
//
// So these boot the real page, let the real quote land, and read the token off the wire at the real
// charge fetch.
import assert from 'node:assert';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const { ok, count } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const TOKEN = 'v1.signed.token.for.this.cart';

// showStage cross-dissolves: the actual swap runs on a transitionend or a 170ms fallback timer, so a
// plain settle() returns before the target stage is active. Waiting past that fallback is the only way
// to observe the real stage the wiring reads.
async function stage(w, id) { w.showStage(id, 50); await new Promise((r) => setTimeout(r, 260)); await settle(); }

// Boot a form, seed a cart, let the quote land, send — and hand back what the charge actually carried.
async function run(dir, { token = TOKEN, changeCartBeforeSend = false, quoteOk = true } = {}) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const sent = [];
  const quotes = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) {
      quotes.push(JSON.parse((init && init.body) || '{}'));
      if (!quoteOk) return res({ ok: false });
      return res({ ok: true, total_cents: 1, net_total_cents: 1,
        ...(token ? { quote_token: token } : {}) });
    }
    if (CHARGE_RE.test(url)) { sent.push(JSON.parse((init && init.body) || '{}')); return res({ ok: true }); }
    return idle;
  };
  await settle();
  const live = w.liveMenuGlobalGet('MENU');
  const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 1);
  w.requestServerQuote();
  await settle();
  if (changeCartBeforeSend) { w.chg(dish.id, 1); }     // cart moves AFTER the token was issued
  assert.ok(w.buildOrder(), `${dir}: premise — a clean cart composes an order`);
  try { await w.submitOrder('confirmed'); } catch (_) {}
  await settle();
  assert.strictEqual(sent.length, 1, `${dir}: premise — exactly one charge request was sent`);
  return { w, dish, body: sent[0], quotes };
}

for (const dir of Object.keys(BRAND)) {
  console.log(`\n══ ${dir} ══`);

  // ── 1. THE MODULE IS LOADED AND LIVE, AND NOTHING THREW ON THE WAY ──────────────────────────────
  {
    const { w, body } = await run(dir);
    assert.strictEqual(typeof w.createConfirmQuote, 'function', `${dir}: the module did not load`);
    assert.ok(w.__confirmQuote, `${dir}: the store was never constructed — a load-order fault`);
    assert.strictEqual(typeof w.confirmQuoteCartSig(), 'string', `${dir}: the signature must serialize`);
    ok(`${dir}: the module loads, the store constructs, and the signature serializes on a real page`);

    // ── 2. 🔴 A QUOTE'S TOKEN REACHES THE CHARGE ──────────────────────────────────────────────────
    assert.strictEqual(body.quote_token, TOKEN,
      `${dir}: 🔴 the token issued for this cart must travel with the order`);
    ok(`${dir}: a quote's token is stored on a real load and attached to the real send`);
  }

  // ── 3. 🔴 A CART CHANGE AFTER THE QUOTE MEANS NO TOKEN — NOT THE WRONG ONE ──────────────────────
  // The seamlessness rule, end to end: attaching the stale token here would 409 on the server's
  // fingerprint and put a re-confirm sheet in front of a customer. Sending none falls to the floor.
  {
    const { body } = await run(dir, { changeCartBeforeSend: true });
    assert.strictEqual(body.quote_token, undefined,
      `${dir}: 🔴 a token issued for a different cart must NOT be attached`);
    ok(`${dir}: a cart change after the quote sends NO token rather than a stale one`);
  }

  // ── 4. NO TOKEN FROM THE SERVER → THE SEND IS UNCHANGED FROM TODAY ─────────────────────────────
  // The grace premise. Both the token-less success and the failed quote must leave the body alone.
  for (const [label, over] of [['a token-less quote', { token: null }], ['a failed quote', { quoteOk: false }]]) {
    const { body } = await run(dir, over);
    assert.ok(!('quote_token' in body),
      `${dir}: ${label} must not add the field at all — not even as undefined`);
    assert.ok(Array.isArray(body.items) && body.items.length > 0,
      `${dir}: …and the order it sends is otherwise intact`);
    ok(`${dir}: ${label} sends no quote_token and an otherwise unchanged order`);
  }

  // ── 5. THE SIGNATURE FOLLOWS THE REWARD, NOT JUST THE ITEMS ────────────────────────────────────
  // redeemCartItems() serializes the cart only, so the same items with and without a reward share a
  // key. If the token's signature did too, a reward-active token would attach to a reward-off cart and
  // meet the server's fingerprint. Driven through the real __ACCOUNT seam the form reads.
  {
    const { w } = await run(dir);
    const before = w.confirmQuoteCartSig();
    const prev = w.__ACCOUNT && w.__ACCOUNT.getRedeemPayload;
    w.__ACCOUNT = w.__ACCOUNT || {};
    w.__ACCOUNT.getRedeemPayload = () => ({ type: 'free_pizza_choice', item_id: 'x', name: 'X' });
    const after = w.confirmQuoteCartSig();
    if (prev) w.__ACCOUNT.getRedeemPayload = prev; else delete w.__ACCOUNT.getRedeemPayload;
    assert.notStrictEqual(before, after,
      `${dir}: 🔴 the same cart with a reward applied must NOT share a signature with the reward-off cart`);
    ok(`${dir}: the token signature moves when the reward does, which redeemCartItems() alone would not`);
  }

  // ── 6. THE REFRESH RUNS ON THE PAY STEP AND STOPS ON LEAVING IT ────────────────────────────────
  {
    const { w } = await run(dir);
    await stage(w, 's2');     // the refresh is armed only while the pay step SHOWS
    w.renderStage2Summary();
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, true,
      `${dir}: the silent refresh must be running while the customer is on the pay step`);
    await stage(w, 's1');
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, false,
      `${dir}: 🔴 a timer left running on a page the customer left would re-quote forever`);
    ok(`${dir}: the silent refresh starts on the pay step and stops on leaving it`);
  }

  // ══ T7 REVISE — THE SIGNATURE-TIMING DEFECTS ═══════════════════════════════════════════════════
  // All four share one root: a token must describe the exact payload it rides with, and each signature
  // must be captured at the moment the payload it describes was FIXED — never re-read from live state
  // later. The unit tests feed signatures by hand, so they are blind to this by construction; the
  // defects live entirely in the wiring's timing.

  // ── 7. 🔴 THE SILENT REFRESH MUST ACTUALLY RE-QUOTE ────────────────────────────────────────────
  // requestServerQuote() short-circuits when the cart is already quoted, which is right for its own
  // job (don't re-ask about an unchanged cart) and fatal for this one: the customer who waits is
  // exactly the case refresh exists for, and their cart is unchanged BY DEFINITION. Inert, the token
  // expires under them and the pay-tap becomes the 409 this was built to remove.
  {
    // Boot a form and STOP at checkout — the scenario refresh exists for is a customer who has not
    // submitted. (Completing an order empties the cart, and an empty cart correctly quotes nothing.)
    const B = BRAND[dir];
    const w = loadForm(dir);
    const quotes = []; const idle = new Promise(() => {});
    let nth = 0;
    w.__respond = (url) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) { quotes.push(1); return res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: 'TOK-' + (++nth) }); }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();
    const firstToken = w.__confirmQuote.current(w.confirmQuoteCartSig()).token;

    await stage(w, 's2');
    w.renderStage2Summary();
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, true, `${dir}: premise — the pay step armed a refresh`);
    /* Re-arm through a stubbed setInterval so the captured callback is unambiguously the REFRESH's.
       Stubbing before the first arm captured whichever interval the page happened to schedule next —
       the form arms several — and calling that one proved nothing. */
    w.__confirmQuote.stopRefresh();
    let tick = null;
    w.setInterval = (fn) => { tick = fn; return 1; };
    w.renderStage2Summary();
    assert.strictEqual(typeof tick, 'function', `${dir}: premise — the refresh cadence was captured`);
    const before = quotes.length;
    for (let i = 0; i < 3; i++) { tick(); await settle(); }
    assert.strictEqual(quotes.length, before + 3,
      `${dir}: 🔴 each refresh must issue a NEW quote on an unchanged cart (got ${quotes.length - before} of 3)`);
    const laterToken = w.__confirmQuote.current(w.confirmQuoteCartSig()).token;
    assert.notStrictEqual(laterToken, firstToken,
      `${dir}: 🔴 …and the fresh token must REPLACE the old one, or the refresh bought nothing`);
    ok(`${dir}: the silent refresh forces a re-quote on an unchanged cart`);
  }

  // ── 8. 🔴 THE TOKEN MUST MATCH THE BODY, NOT LIVE STATE ────────────────────────────────────────
  // currentOrder is composed at buildOrder(); the send happens later, behind an auth await and a retry
  // loop. Reading the signature at the send binds the token to whatever the cart is THEN, so an edit in
  // that window ships cart A's body carrying cart B's token — a cart_mismatch 409 the server refuses
  // even under grace, on an order the customer never touched after confirming.
  {
    const B = BRAND[dir];
    const w = loadForm(dir);
    const sent = []; const idle = new Promise(() => {});
    let tok = 'TOKEN-A';
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: tok });
      if (CHARGE_RE.test(url)) { sent.push(JSON.parse((init && init.body) || '{}')); return res({ ok: true }); }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();            // cart A quoted, TOKEN-A stored
    assert.ok(w.buildOrder(), `${dir}: premise — cart A composes`);
    // currentOrder is a `let`, so it is not reachable as a window property; the transmitted body is
    // read off the wire below instead, which is the stronger reading anyway.
    const qtyA = w.redeemCartItems().reduce((n, i) => n + (i.qty || i.quantity || 1), 0);
    tok = 'TOKEN-B';
    w.chg(dish.id, 1);                                  // ← the cart moves AFTER the body was fixed
    w.requestServerQuote(); await settle();            // cart B quoted, TOKEN-B now stored
    try { await w.submitOrder('confirmed'); } catch (_) {}
    await settle();
    assert.strictEqual(sent.length, 1, `${dir}: premise — one send`);
    assert.notStrictEqual(sent[0].quote_token, 'TOKEN-B',
      `${dir}: 🔴 the body describes cart A — carrying cart B's token is a guaranteed cart_mismatch 409`);
    const qtySent = sent[0].items.reduce((n, i) => n + (i.qty || i.quantity || 1), 0);
    assert.strictEqual(qtySent, qtyA,
      `${dir}: premise — the body transmitted is cart A's (${qtySent} vs ${qtyA}), so the mismatch is real`);
    ok(`${dir}: an edit after buildOrder never puts the new cart's token on the old body`);
  }

  // ── 9. 🔴 A LATE REWARD QUOTE IS BOUND TO THE REWARD IT PRICED ─────────────────────────────────
  // The reward callback reads the signature live. A reward-active quote that resolves after the reward
  // was removed is then stored under the reward-OFF signature — so the next reward-off send attaches a
  // reward-active token, and the server's fingerprint refuses it.
  {
    const { w } = await run(dir);
    w.__ACCOUNT = w.__ACCOUNT || {};
    const reward = { type: 'free_pizza_choice', item_id: 'x', name: 'X' };
    w.__ACCOUNT.getRedeemPayload = () => reward;          // reward ACTIVE when the quote is requested
    w.__ACCOUNT.redeemQuoteMatches = () => true;
    const sigWithReward = w.confirmQuoteCartSig();
    // …the reward is removed while the request is in flight, so by the time the callback runs the
    // account module has no pending payload — exactly the state a late reward response resolves into.
    w.__ACCOUNT.getRedeemPayload = () => null;
    w.applyRedeemQuoteToTotals({ ok: true, total_cents: 1, quote_token: 'REWARD-TOKEN' });
    const sigWithout = w.confirmQuoteCartSig();
    assert.notStrictEqual(sigWithReward, sigWithout, 'premise — the two signatures really differ');
    const body = {};
    w.__confirmQuote.attach(body, sigWithout);
    assert.strictEqual(body.quote_token, undefined,
      `${dir}: 🔴 a reward-active token must not be attached to a reward-off cart`);
    ok(`${dir}: a reward quote resolving after the reward was removed is not stored against the reward-off cart`);
  }

  // ── 10. 🔴 THE REFRESH RUNS ONLY WHILE ON THE PAY STEP ─────────────────────────────────────────
  // renderStage2Summary() also runs on ordinary cart edits, so an unconditional start restarts the
  // timer from step 1 — a page the customer has left, re-quoting forever.
  {
    const { w, dish } = await run(dir);
    await stage(w, 's2'); w.renderStage2Summary();
    await stage(w, 's1');
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, false, 'premise — leaving stopped it');
    w.chg(dish.id, 1); await settle();                    // an ordinary cart edit, off-step
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, false,
      `${dir}: 🔴 a cart edit off the pay step must not restart the refresh timer`);
    ok(`${dir}: the refresh cannot be restarted from off the pay step`);
  }
}

closeAll();
console.log(`\n${count()} confirm-quote wiring checks passed across both forms.`);
