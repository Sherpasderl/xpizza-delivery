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
    w.renderStage2Summary();
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, true,
      `${dir}: the silent refresh must be running while the customer is on the pay step`);
    w.showStage('s1', 0);
    await settle();
    assert.strictEqual(w.__confirmQuote.state(null).refreshing, false,
      `${dir}: 🔴 a timer left running on a page the customer left would re-quote forever`);
    ok(`${dir}: the silent refresh starts on the pay step and stops on leaving it`);
  }
}

closeAll();
console.log(`\n${count()} confirm-quote wiring checks passed across both forms.`);
