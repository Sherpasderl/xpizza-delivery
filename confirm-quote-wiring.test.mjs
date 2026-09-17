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
    // Arming re-quotes immediately; let that land before counting, or the first tick is correctly
    // suppressed by the in-flight guard and the count is short by one.
    await settle();
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

  // ── 10. 🔴 A ROUTINE RENDER MUST NOT ORPHAN AN IN-FLIGHT REFRESH ───────────────────────────────
  // The refresh fires a forced quote; before the reply lands, any ordinary renderStage2Summary() takes
  // the already-quoted exit, which superseded unconditionally — bumping the sequence so the refresh's
  // own reply failed its `inflight!==token` guard and was thrown away. Renders are frequent on the pay
  // step, so the refresh was cancelled over and over and the token never renewed.
  {
    const B = BRAND[dir];
    const w = loadForm(dir);
    const idle = new Promise(() => {});
    let nth = 0, release = null;
    w.__respond = (url) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) {
        nth += 1;
        const body = { ok: true, total_cents: 1, net_total_cents: 1, quote_token: 'TOK-' + nth };
        if (nth === 1) return res(body);
        return new Promise((r) => { release = () => r(res(body).then ? res(body) : res(body)); });
      }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();
    const sig = w.confirmQuoteCartSig();
    assert.strictEqual(w.__confirmQuote.current(sig).token, 'TOK-1', `${dir}: premise — token A is held`);

    w.requestServerQuote(true);                 // the refresh fires; its reply is deferred
    await settle();
    w.renderStage2Summary();                    // …and an ordinary render lands on the same cart
    await settle();
    assert.ok(release, `${dir}: premise — the forced refresh really was issued and is outstanding`);
    release(); await settle();
    assert.strictEqual(w.__confirmQuote.current(sig).token, 'TOK-2',
      `${dir}: 🔴 a same-cart render must not orphan the in-flight refresh — the token never renews`);
    ok(`${dir}: an ordinary render does not cancel an in-flight refresh for the same cart`);
  }

  // ── 11. 🔴 ENTERING CHECKOUT ISSUES A FRESH QUOTE, NOT ONE INTERVAL LATER ──────────────────────
  // A customer can idle on the menu step well past the issuance window. Entry renders from cache and
  // issues nothing, so without an arm-time re-quote the token at the pay-tap is already expired.
  {
    const B = BRAND[dir];
    const w = loadForm(dir);
    const quotes = []; const idle = new Promise(() => {});
    w.__respond = (url) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) { quotes.push(1); return res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: 'TOK-' + quotes.length }); }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();      // quoted on s1; the customer then idles
    const onS1 = quotes.length;
    const tokenOnS1 = w.__confirmQuote.current(w.confirmQuoteCartSig()).token;

    await stage(w, 's2');                        // …and walks into checkout
    w.renderStage2Summary();
    await settle();
    assert.ok(quotes.length > onS1,
      `${dir}: 🔴 entering checkout must issue a fresh quote, not wait a full interval`);
    assert.notStrictEqual(w.__confirmQuote.current(w.confirmQuoteCartSig()).token, tokenOnS1,
      `${dir}: …and the token actually held at the pay-tap must be the new one`);
    ok(`${dir}: entering checkout forces a fresh quote on arrival`);
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

// The shared harness's res() is 200-only; the T8 paths are all driven by 4xx answers, so a local
// rejecting response is needed. Same shape, different status.
const rej = (body, status = 409) => Promise.resolve({
  ok: false, status,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
});

// ══ T8 — THE VISIBLE LAYER ═══════════════════════════════════════════════════════════════════════
// The hard rule in one sentence: a genuine price increase is the ONLY thing the customer ever sees.
// Drops, expiry, quote outages and stale fingerprints are all recovered without a pixel changing, so
// most of what follows asserts that NOTHING appeared.
for (const dir of Object.keys(BRAND)) {
  console.log(`\n══ ${dir} (T8) ══`);
  const B = BRAND[dir];

  // Boot, seed a cart, and answer the charge however the case needs. Returns every body sent.
  async function order(over = {}) {
    const { reply, token = TOKEN, quoteOk = true } = over;
    const w = loadForm(dir);
    const sent = []; const idle = new Promise(() => {});
    let nth = 0;
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) {
        nth += 1;
        if (!quoteOk) return res({ ok: false });
        return res({ ok: true, total_cents: 1, net_total_cents: 1, ...(token ? { quote_token: token + '-' + nth } : {}) });
      }
      if (CHARGE_RE.test(url)) { sent.push(JSON.parse((init && init.body) || '{}')); return reply(sent.length); }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder(), `${dir}: premise — the cart composes`);
    return { w, sent, dish };
  }
  const sheetOf = (w) => w.document.querySelector('.cq-sheet');
  const ok200 = () => res({ ok: true });

  // ── 🔴 A GENUINE INCREASE IS THE ONE THING THE CUSTOMER SEES ───────────────────────────────────
  {
    const NEW = 31900;
    const { w, sent } = await order({ reply: (n) => n === 1
      ? rej({ error: 'price_increased', net_total_cents: NEW })
      : ok200() });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle();
    const sheet = sheetOf(w);
    assert.ok(sheet, `${dir}: 🔴 a price increase MUST be shown — silently charging more is the one thing this cannot do`);
    const copy = sheet.textContent.replace(/\s+/g, ' ');
    assert.ok(copy.includes('319.00'), `${dir}: …naming the NEW price from the server (${copy})`);
    assert.ok(/precio/i.test(copy), `${dir}: …in words the customer can act on`);
    assert.ok(!/<|&lt;script/i.test(sheet.innerHTML.replace(/<\/?(div|span|button|svg|path)[^>]*>/g, '')),
      `${dir}: the sheet carries no markup beyond its own chrome`);
    assert.strictEqual(sent.length, 1, `${dir}: nothing is re-sent until the customer agrees`);

    // …and a second tap resends, successfully.
    const buttons = [...sheet.querySelectorAll('button')];
    buttons[buttons.length - 1].click();
    await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}: 🔴 confirming must actually resend the order`);
    assert.ok(!sheetOf(w), `${dir}: …and the sheet is gone`);
    ok(`${dir}: a price increase shows the sheet with the new price, and confirming resends`);
  }

  // ── 🔴 DECLINING CHANGES NOTHING ───────────────────────────────────────────────────────────────
  {
    const { w, sent } = await order({ reply: () => rej({ error: 'price_increased', net_total_cents: 31900 }) });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle();
    const sheet = sheetOf(w);
    assert.ok(sheet, `${dir}: premise — the sheet appeared`);
    sheet.querySelectorAll('button')[0].click();          // Cancelar
    await settle(); await settle();
    assert.strictEqual(sent.length, 1, `${dir}: declining must not send anything`);
    assert.ok(!sheetOf(w), `${dir}: …and dismisses the sheet`);
    assert.ok(w.cartItems().length > 0, `${dir}: …leaving the cart intact so they can decide again`);
    ok(`${dir}: declining the new price sends nothing and keeps the cart`);
  }

  // ── 🔴 A PRICE DROP IS SILENT ──────────────────────────────────────────────────────────────────
  // The server charges the lower amount and answers 200; the silence is the absence of any branch.
  {
    const { w, sent } = await order({ reply: () => ok200() });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle();
    assert.ok(!sheetOf(w), `${dir}: 🔴 a drop must never interrupt anyone`);
    assert.strictEqual(sent.length, 1, `${dir}: …and is charged on the first send`);
    ok(`${dir}: a price drop completes silently — no sheet, one send`);
  }

  // ── 🔴 A STALE FINGERPRINT RECOVERS SILENTLY, ONCE ─────────────────────────────────────────────
  {
    const { w, sent } = await order({ reply: (n) => n === 1 ? rej({ error: 'quote_invalid' }) : ok200() });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle(); await settle();
    assert.ok(!sheetOf(w), `${dir}: 🔴 a bookkeeping mismatch is not the customer's problem — no sheet`);
    assert.strictEqual(sent.length, 2, `${dir}: …it re-quotes and resends by itself`);
    ok(`${dir}: a stale quote recovers silently with one resend`);
  }
  // …and exactly once: a server that keeps refusing must not loop.
  {
    const { w, sent } = await order({ reply: () => rej({ error: 'quote_invalid' }) });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle(); await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}: 🔴 the silent retry must fire ONCE, never loop`);
    ok(`${dir}: a persistently stale quote retries exactly once`);
  }

  // ── 🔴 A QUOTE OUTAGE SENDS THE DEGRADED FLOOR, NEVER BLOCKS ───────────────────────────────────
  // No token to be had. The body carries the net the customer was shown as an unsigned CEILING — T6
  // charges its own recompute against it, so this number can refuse a sale but never set a price.
  {
    const { w, sent } = await order({ reply: () => ok200(), quoteOk: false });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle();
    assert.strictEqual(sent.length, 1, `${dir}: 🔴 a quote outage must not block the order`);
    assert.ok(!('quote_token' in sent[0]), `${dir}: …there is no token to send`);
    assert.strictEqual(typeof sent[0].expected_net_cents, 'number',
      `${dir}: 🔴 …so the displayed net travels as the unsigned ceiling instead`);
    assert.ok(sent[0].expected_net_cents > 0, `${dir}: …and it is a real figure`);
    assert.ok(!sheetOf(w), `${dir}: …with nothing shown to the customer`);
    ok(`${dir}: a quote outage sends expected_net_cents immediately and shows nothing (${sent[0].expected_net_cents})`);
  }

  // ── 🔴 A REWARD ORDER RECOVERS VIA A NEW order_id ──────────────────────────────────────────────
  // The server's reward hold binds a fingerprint that includes the amount, so the same id answers
  // reservation_conflict and fails closed. Retrying the same id would strand the customer's points.
  {
    const { w, sent } = await order({ reply: (n) => n === 1
      ? rej({ error: 'price_increased', net_total_cents: 31900 })
      : ok200() });
    // NOT awaited: while a sheet is open submitOrder is waiting on the customer, so awaiting it
    // here would deadlock the test against its own click.
    const pending = w.submitOrder('confirmed'); if (pending && pending.catch) pending.catch(() => {});
    await settle();
    const sheet = sheetOf(w);
    assert.ok(sheet, `${dir}: premise — the increase sheet appeared`);
    const firstId = sent[0].order_id;
    const bs = [...sheet.querySelectorAll('button')]; bs[bs.length - 1].click();
    await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}: premise — it resent`);
    // Without a reward the id is REUSED (the server idempotent-returns it); the reward case is below.
    assert.strictEqual(sent[1].order_id, firstId,
      `${dir}: a non-reward order reuses its id — the server idempotent-returns it`);
    ok(`${dir}: a non-reward increase resends on the SAME order_id`);
  }

  // ── 🔴 …BUT A REWARD ORDER MUST MINT A FRESH ONE ───────────────────────────────────────────────
  // Driven through the real __ACCOUNT seam buildOrder reads, so currentOrder.redeem is set the way a
  // real reward sets it — not by reaching into the form's internals.
  {
    const w = loadForm(dir);
    const sent = []; const idle = new Promise(() => {});
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: TOKEN });
      if (CHARGE_RE.test(url)) {
        sent.push(JSON.parse((init && init.body) || '{}'));
        return sent.length === 1 ? rej({ error: 'price_increased', net_total_cents: 31900 }) : res({ ok: true });
      }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.__ACCOUNT = w.__ACCOUNT || {};
    w.__ACCOUNT.getRedeemPayload = () => ({ type: 'free_pizza_choice', item_id: 'x', name: 'X' });
    // A reward order is refused before the send without a verified session (the form will not submit a
    // logged-in reward as a guest). Stubbed at the seam the form itself reads.
    w.__ACCOUNT.customerIdToken = () => Promise.resolve('id-token-for-test');
    /* 1B's send gate refuses a reward order whose reward is unpriced or whose quote is stale (it fails
       CLOSED, deliberately). Both seams are stubbed so the order actually reaches the wire — this cell
       is about what happens to the order_id AFTER the server answers, not about that gate. */
    w.__ACCOUNT.getRedeemQuoteTotalCents = () => 29900;
    w.__ACCOUNT.redeemQuoteMatches = () => true;
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder(), `${dir}: premise — a reward cart composes`);
    const p2 = w.submitOrder('confirmed'); if (p2 && p2.catch) p2.catch(() => {});
    await settle();
    const sheet = sheetOf(w);
    assert.ok(sheet, `${dir}: premise — the increase sheet appeared for a reward order`);
    assert.ok(sent[0].redeem, `${dir}: premise — the order really carried a reward`);
    const firstId = sent[0].order_id;
    const bs = [...sheet.querySelectorAll('button')]; bs[bs.length - 1].click();
    await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}: premise — it resent`);
    assert.notStrictEqual(sent[1].order_id, firstId,
      `${dir}: 🔴 a reward order MUST resend on a FRESH order_id — the server's hold binds the amount, so the same id fails closed and strands the points`);
    ok(`${dir}: a reward increase resends on a NEW order_id, not the one the hold refuses`);
  }

  // ── 🔴 CONFIRMING SUCCEEDS ON THE FIRST TRY — THE RECOVERY DOES NOT RACE A RE-QUOTE ────────────
  // The resend used to carry the SAME token the server had just rejected (a body is reused, and the
  // token from the first send survived on it), so the server refused identically and the sheet came
  // back — forever. The re-quote it was implicitly relying on returns nothing awaitable and, on a
  // reward cart, does not even fire. The recovery now stands on its own degraded ceiling.
  {
    const w = loadForm(dir);
    const sent = []; const idle = new Promise(() => {});
    const NEW = 31900;
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      // The re-quote NEVER lands — the recovery must not depend on it.
      if (url.includes('quoteOrder')) return sent.length === 0
        ? res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: TOKEN }) : idle;
      if (CHARGE_RE.test(url)) {
        const b = JSON.parse((init && init.body) || '{}');
        sent.push(b);
        // A raw server gate: it accepts only a body that stands behind the NEW number and carries no
        // token it has already rejected.
        return (b.expected_net_cents === NEW && !b.quote_token) ? res({ ok: true })
          : rej({ error: 'price_increased', net_total_cents: NEW });
      }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder(), `${dir}: premise — the cart composes`);
    const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
    await settle();
    let confirmations = 0;
    for (let i = 0; i < 4; i++) {
      const sheet = w.document.querySelector('.cq-sheet');
      if (!sheet) break;
      const bs = [...sheet.querySelectorAll('button')]; bs[bs.length - 1].click();
      confirmations += 1;
      await settle(); await settle();
    }
    assert.strictEqual(confirmations, 1,
      `${dir}: 🔴 the customer must agree ONCE — a repeating sheet is the defect this recovery exists to avoid`);
    assert.strictEqual(sent.length, 2, `${dir}: one original send and one successful resend`);
    assert.ok(!('quote_token' in sent[1]),
      `${dir}: 🔴 the resend must not carry the token the server just rejected — the signed gate takes precedence over the ceiling`);
    assert.strictEqual(sent[1].expected_net_cents, NEW,
      `${dir}: 🔴 …and must stand behind the number the customer just agreed to`);
    assert.ok(!w.document.querySelector('.cq-sheet'), `${dir}: nothing is left on screen`);
    ok(`${dir}: confirming an increase succeeds on the first resend, with no re-quote landing`);
  }

  // ── 🔴 A SLOW REFRESH DOES NOT MAKE THE SILENT RECOVERY VISIBLE ────────────────────────────────
  // Same root: the stale-quote resend carried the rejected token, was refused again, spent its single
  // retry and dead-ended on the generic error banner — silence broken by a message the customer can do
  // nothing with.
  {
    const w = loadForm(dir);
    const sent = []; const idle = new Promise(() => {});
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) return sent.length === 0
        ? res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: TOKEN }) : idle;   // never lands
      if (CHARGE_RE.test(url)) {
        const b = JSON.parse((init && init.body) || '{}');
        sent.push(b);
        return b.quote_token ? rej({ error: 'quote_invalid' }) : res({ ok: true });
      }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder(), `${dir}: premise — the cart composes`);
    const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
    await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}: it resends once`);
    assert.ok(!('quote_token' in sent[1]), `${dir}: 🔴 …without the token that was just rejected`);
    assert.ok(!w.document.querySelector('.cq-sheet'), `${dir}: and shows no sheet`);
    const msg = (w.document.getElementById('sending-msg') || {}).textContent || '';
    assert.ok(!/No pudimos/i.test(msg),
      `${dir}: 🔴 suppressing the sheet is not silence — the recovery must SUCCEED, not surface an error (${msg.slice(0, 60)})`);
    ok(`${dir}: a stale quote recovers silently even when the re-quote never lands`);
  }

  // ── 🔴 THE CARD PATH, AT RUNTIME ───────────────────────────────────────────────────────────────
  // Previously the online branches were guarded by a census only, so a defect there survived every
  // test. Driven through processPixelPay with a real reward.
  for (const withReward of [false, true]) {
    const w = loadForm(dir);
    const sent = []; const idle = new Promise(() => {});
    const NEW = 31900;
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
      if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1, quote_token: TOKEN });
      if (url.includes('chargeOnlineOrder')) {
        const b = JSON.parse((init && init.body) || '{}');
        sent.push(b);
        return (b.expected_net_cents === NEW && !b.quote_token)
          ? res({ ok: true, checkout_url: 'https://pay/x', order_id: b.order_id })
          : rej({ error: 'price_increased', net_total_cents: NEW });
      }
      return idle;
    };
    await settle();
    const live = w.liveMenuGlobalGet('MENU');
    const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
    w.chg(dish.id, 1);
    w.__ACCOUNT = w.__ACCOUNT || {};
    if (withReward) {
      w.__ACCOUNT.getRedeemPayload = () => ({ type: 'free_pizza_choice', item_id: 'x', name: 'X' });
      w.__ACCOUNT.customerIdToken = () => Promise.resolve('id-token-for-test');
      w.__ACCOUNT.getRedeemQuoteTotalCents = () => 29900;
      w.__ACCOUNT.redeemQuoteMatches = () => true;
    }
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder(), `${dir}: premise — the cart composes (reward=${withReward})`);
    const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
    await settle(); await settle();
    const sheet = w.document.querySelector('.cq-sheet');
    assert.ok(sheet, `${dir}: 🔴 the ONLINE path must show the increase sheet too (reward=${withReward})`);
    const firstId = sent[0].order_id;
    const bs = [...sheet.querySelectorAll('button')]; bs[bs.length - 1].click();
    await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}: the card resend happened (reward=${withReward})`);
    assert.strictEqual(sent[1].expected_net_cents, NEW, `${dir}: …standing behind the agreed number`);
    assert.ok(!('quote_token' in sent[1]), `${dir}: …and not the rejected token`);
    if (withReward) {
      assert.ok(sent[0].redeem, `${dir}: premise — the card order carried a reward`);
      assert.notStrictEqual(sent[1].order_id, firstId,
        `${dir}: 🔴 a reward CARD order must resend on a FRESH order_id — the hold refuses the old one`);
    } else {
      assert.strictEqual(sent[1].order_id, firstId, `${dir}: a non-reward card order reuses its id`);
    }
    ok(`${dir}: the card path shows the sheet and resends correctly (reward=${withReward})`);
  }
}

closeAll();
console.log(`\n${count()} confirm-quote wiring checks passed across both forms.`);
