// Portal 1B Task 9 — THE CHARGE BOUNDARY. Run: node charge-boundary.test.mjs
//
// 🔴 THE CLAIM 1B RESTS ON: the live menu never determines a charge. Everything T1–T8 built moves
// prices onto the customer's screen from a live feed; the only thing standing between that and the
// money is that the SERVER re-prices what it is sent. This suite tries to make the client's numbers
// matter and asserts that they cannot.
//
// WHY THE PAYLOAD IS NOT HAND-BUILT. A hand-written order proves the repricer ignores a field that a
// hand-written order happens to contain. What has to be true is that the repricer ignores the fields
// THE REAL FORM ACTUALLY SENDS — which is a different claim, and the only way to make it is to let the
// form serialize its own cart and then tamper with the bytes it produced. So every payload below comes
// out of a booted form: cart written through chg(), composed through buildOrder(), captured off the
// wire at the fetch the form makes to createOrder. Tampering happens after that, on the captured body.
//
// The two charge paths are asymmetric and both are covered:
//   cash   — createOrder recomputes the total with computeServerTotal(body.items, rid, tables).
//   online — chargeOnlineOrder never takes an amount from the browser at all; it charges
//            order.total_cents, which was itself written from the same server recompute.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { readFileSync } = require('node:fs');

const { ok, count } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;

// Boot a form, put a real line in the cart, and capture the payload IT sends — not one we composed.
async function realPayload(dir, { failQuote = false, card = false } = {}) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const sent = [];
  const idle = new Promise(() => {});
  const menu = { dishes: [], extras: [] };
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, menu));
    if (url.includes('quoteOrder')) return res(failQuote ? { ok: false } : { ok: true, total_cents: 1 });
    if (CHARGE_RE.test(url)) { sent.push(JSON.parse((init && init.body) || '{}')); return res({ ok: true }); }
    return idle;
  };
  await settle();
  const live = w.liveMenuGlobalGet('MENU');
  const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 2);                       // qty 2 so a per-unit price error cannot coincide with the total
  w.requestServerQuote();
  await settle();
  assert.ok(w.buildOrder(), `${dir}: premise — a clean cart composes an order`);
  /* 🔴 WHICH SERIALIZER. selectedPayment is a LEXICAL binding inside the form script, so assigning
     window.selectedPayment changes nothing the form reads — selectPay() is its own setter. The two
     endpoints do not send the same body, and until this revise every payload here came from the cash
     one while the file claimed to cover both charge paths. */
  if (card) { w.selectPay('online'); const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
  else { try { await w.submitOrder('confirmed'); } catch (_) {} }
  await settle();
  assert.strictEqual(sent.length, 1, `${dir}: premise — the form really sent ONE charge request`);
  return { w, B, dish, body: sent[0] };
}

for (const dir of Object.keys(BRAND)) {
  console.log(`\n══ ${dir} ══`);
  const B = BRAND[dir];

  // ── 1. THE HONEST BASELINE ───────────────────────────────────────────────────────────────────
  // Everything below is "tamper, then assert UNCHANGED", which is vacuous unless the untampered
  // payload prices to something real in the first place.
  const base = await realPayload(dir);
  const honest = computeServerTotal(base.body.items, B.rid);
  assert.ok(!honest.error,
    `${dir}: the form's own payload prices cleanly server-side (${honest.error})`);
  assert.ok(honest.total > 0, `${dir}: …to a real amount (${honest.total})`);
  assert.strictEqual(honest.total, base.dish.price * 2,
    `${dir}: …and that amount is the SERVER's price times the quantity, not the payload's`);
  ok(`${dir}: the real form serializer produces a payload the server prices to ${honest.total}`);

  // ── 2. 🔴 EVERY CLIENT-SIDE MONEY FIELD IS TAMPERED, AND NOTHING MOVES ───────────────────────
  {
    const tampers = {
      'the top-level total': (b) => { b.total = 1; },
      'the per-item price': (b) => { b.items.forEach((i) => { i.price = 1; }); },
      'the per-item subtotal': (b) => { b.items.forEach((i) => { i.subtotal = 1; }); },
      'items_text (the human-readable line)': (b) => { b.items_text = 'GRATIS'; },
      'the extras total': (b) => { b.items.forEach((i) => { i.extrasTotal = -9999; }); },
      'a fabricated discount field': (b) => { b.discount_cents = 999999; b.free_order = true; },
      'every money field at once': (b) => {
        b.total = 1; b.discount_cents = 999999;
        b.items.forEach((i) => { i.price = 1; i.subtotal = 1; i.extrasTotal = -9999; });
      },
    };
    for (const [label, tamper] of Object.entries(tampers)) {
      const b = JSON.parse(JSON.stringify(base.body));
      tamper(b);
      const got = computeServerTotal(b.items, B.rid);
      assert.ok(!got.error, `${dir}: tampering ${label} must not break pricing (${got.error})`);
      assert.strictEqual(got.total, honest.total,
        `${dir}: 🔴 tampering ${label} changed the charge — ${got.total} instead of ${honest.total}`);
    }
    ok(`${dir}: ${Object.keys(tampers).length} client money fields tampered — the server-repriced amount never moves`);
  }

  // ── 3. 🔴 AN UNKNOWN ITEM IS REFUSED, NOT PRICED AT ZERO ─────────────────────────────────────
  // The failure mode that matters more than a wrong number: an item the server cannot price must stop
  // the order. Pricing it as nothing would make a tampered name the cheapest possible attack.
  {
    const b = JSON.parse(JSON.stringify(base.body));
    if (dir === 'la-musa-orders') b.items[0].id = 'no_such_dish'; else b.items[0].name = 'No Such Dish';
    const got = computeServerTotal(b.items, B.rid);
    assert.ok(got.error, `${dir}: 🔴 an item the server cannot price is an ERROR, never a free line`);
    assert.ok(Number.isNaN(got.total), `${dir}: …and the total is NaN, not 0 (${got.total})`);
    ok(`${dir}: an unpriceable item refuses the order rather than costing nothing`);
  }

  // ── 4. 🔴 THE QUANTITY IS THE SERVER'S BUSINESS TOO ──────────────────────────────────────────
  {
    for (const [label, qty] of Object.entries({ zero: 0, negative: -3, fractional: 1.5, absurd: 9999 })) {
      const b = JSON.parse(JSON.stringify(base.body));
      b.items[0].qty = qty;
      const got = computeServerTotal(b.items, B.rid);
      assert.ok(got.error, `${dir}: 🔴 a ${label} quantity is refused (${got.total})`);
    }
    ok(`${dir}: zero, negative, fractional and absurd quantities are all refused`);
  }

  // ── 5. 🔴 A FAILED QUOTE NEVER DETERMINES THE CHARGE ─────────────────────────────────────────
  // The quote is a DISPLAY. If it fails the customer falls back to the client-side arithmetic on
  // screen — but what is sent, and what the server charges for it, must be identical either way.
  {
    const noQuote = await realPayload(dir, { failQuote: true });
    assert.strictEqual(noQuote.w.getServerQuoteTotalCents(), null,
      `${dir}: premise — the quote really did fail, so nothing is quoted`);
    const got = computeServerTotal(noQuote.body.items, B.rid);
    assert.ok(!got.error, `${dir}: the order still prices (${got.error})`);
    assert.strictEqual(got.total, honest.total,
      `${dir}: 🔴 a failed quote charges the SAME server amount — the quote is a display, not an input`);
    assert.deepStrictEqual(
      noQuote.body.items.map((i) => [i.name, i.qty]),
      base.body.items.map((i) => [i.name, i.qty]),
      `${dir}: 🔴 …and the same items were sent, quote or no quote`);
    ok(`${dir}: a failed quote changes neither what is sent nor what it costs`);
  }

  base.w.__dom && null;
}

/* ── 6. 🔴 THE STRUCTURAL HALF: THE HANDLERS NEVER READ A CLIENT AMOUNT ───────────────────────────
   Behavioural tests above prove computeServerTotal ignores the payload's numbers. They cannot prove
   the HANDLER does not read one somewhere else and use it — a future edit could take body.total and
   every test above would still pass. This is a census over the two charge handlers, and it is the
   documented-lint kind: precise, comment-stripped, and paired with probes that prove it can still
   fire. */
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const idx = strip(readFileSync(new URL('./xpizza-functions/index.js', import.meta.url), 'utf8'));

  // A client-supplied money field being READ (not merely assigned into a response) is what matters.
  const READS = /\bbody\.(total|total_cents|subtotal|subtotal_cents|amount|price|discount_cents|free_order)\b/g;
  const hits = [...idx.matchAll(READS)].map((m) => m[0]);

  /* 🔴 body.free_order IS READ, AND IT IS THE ONE SAFE READ — so it is excluded BY NAME, with the
     reason, and then pinned separately. The server derives `freeOrder` itself from the re-priced
     breakdown (`!!redemptionPriced && total_cents === 0`); the client's flag is only ever compared
     against that and can only cause a REJECTION (409 free_order_stale) when the two disagree. A claim
     of "this order is free" therefore cannot make one free — it can only stop a stale one.
     Excluding it silently would have been a hole big enough to drive a free order through, so the
     exclusion is paired with an assertion that the usage is still exactly that shape. */
  const SAFE = new Set(['body.free_order']);
  const unsafe = hits.filter((h) => !SAFE.has(h));
  assert.deepStrictEqual(unsafe, [],
    `🔴 a charge handler reads a client-supplied money field as an INPUT: ${unsafe.join(', ')}`);
  assert.strictEqual(hits.filter((h) => h === 'body.free_order').length, 1,
    'body.free_order is read in exactly ONE place — a second read needs its own justification');
  assert.ok(/const freeOrder = !!redemptionPriced && priceBreakdown\.total_cents === 0;/.test(idx),
    '🔴 freeOrder must be DERIVED from the server-re-priced breakdown, never taken from the request');
  assert.ok(/if \(body\.free_order === true && !freeOrder\)[\s\S]{0,400}free_order_stale/.test(idx),
    '🔴 …and the client flag may only REFUSE a mismatch, never zero a total');

  // NON-VACUITY: the census can see the shapes it claims to look for, and does not fire on innocent ones.
  for (const probe of ['const t = body.total;', 'if (body.total_cents > 0) {', 'pay(body.amount)', 'body.discount_cents']) {
    assert.ok(new RegExp(READS.source).test(probe), `non-vacuity: the census sees ${JSON.stringify(probe)}`);
  }
  for (const innocent of ['body.items', 'body.order_id', 'order.total_cents', 'body.customer_name']) {
    assert.ok(!new RegExp(READS.source).test(innocent), `non-vacuity: the census ignores ${JSON.stringify(innocent)}`);
  }
  // …and the recompute really is what the handler uses.
  assert.ok(/computeServerTotal\(\s*body\.items\s*,/.test(idx),
    '🔴 createOrder must recompute the total from body.items — not from anything the client priced');
  ok('the charge handlers read NO client-supplied money field — the total is recomputed, never accepted');
}

/* ══ 1C: THE TOKEN IS A CEILING, NEVER THE CHARGE ══════════════════════════════════════════════════
   1B proved the server never takes a price FROM the client. 1C adds a field that looks, to a casual
   reader, like exactly the thing 1B forbids: the client now sends a number (expected_net_cents) and a
   signed token carrying another (net_total_cents). The whole money argument for 1C rests on those two
   being CEILINGS — compared against, never charged — so this file, which exists to prove client
   numbers cannot become money, is where that has to be shown.
   Same discipline as everything above it: the payload comes out of a booted form's own serializer and
   is tampered with afterwards, so what is proved is that the REAL payload's fields cannot move the
   charge — not that a hand-built one happens not to. */
{
  const { gateConfirmedNet } = require('./token-gate');
  const { signQuoteToken, cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
  const { computeServerNet } = require('./compute-server-net');
  const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
  const SECRET = 'charge-boundary-1c';

  for (const dir of Object.keys(BRAND)) {
    const B = BRAND[dir];
    const base = await realPayload(dir);
    const tables = { restaurantId: B.rid, menu: MENU_BY_RESTAURANT[B.rid], extras: EXTRAS_BY_RESTAURANT[B.rid] };
    const items = base.body.items;
    const honest = computeServerNet({ items, rid: B.rid, tables }).net_total_cents;
    assert.ok(honest > 0, `${dir}: premise — the real payload prices to a real net (${honest})`);

    const mint = (netCents, cart = items, reward = null) => {
      const norm = normalizeCartForFingerprint(cart, B.rid);
      return signQuoteToken({
        quote_id: 'cb1', rid: B.rid, net_total_cents: netCents,
        cart_fingerprint: cartFingerprint(norm, reward),
        issued_at: Date.now(), expires_at: Date.now() + 900000,
      }, SECRET);
    };
    const gate = (over = {}) => gateConfirmedNet({
      submittedCart: items, reward: null, rid: B.rid, tables, secret: SECRET, nowMs: Date.now(), ...over,
    });

    /* 🔴 A VALID TOKEN CLAIMING A HIGHER NUMBER DOES NOT RAISE THE CHARGE. This is the one that would
       matter if the gate had been written the obvious way — "charge what was confirmed" — because a
       token is client-held and a customer could keep an old, dearer one. The charge is the server's
       recompute; the token only ever says how high it may go. */
    {
      const g = gate({ token: mint(honest + 50_000) });
      assert.strictEqual(g.action, 'charge', `${dir}: a token above the server net still charges`);
      assert.strictEqual(g.chargeNet, honest,
        `${dir}: 🔴 a signed token claiming ${honest + 50_000} must NOT raise the charge above the server's ${honest}`);
      assert.strictEqual(g.confirmedNet, honest + 50_000, `${dir}: …the ceiling is recorded, distinct from the charge`);
    }
    // …and one claiming a LOWER number cannot undercharge either: it refuses the sale instead.
    {
      const g = gate({ token: mint(honest - 1) });
      assert.strictEqual(g.action, 'refuse_increase', `${dir}: 🔴 a token below the server net refuses — it never undercharges`);
      assert.strictEqual(g.chargeNet, honest, `${dir}: …and reports the server's number`);
    }
    // The unsigned ceiling behaves identically in both directions.
    for (const [label, expected, action] of [
      ['an inflated unsigned ceiling', honest + 50_000, 'charge'],
      ['a deflated unsigned ceiling', honest - 1, 'refuse_increase'],
    ]) {
      const g = gate({ expectedNetCents: expected });
      assert.strictEqual(g.action, action, `${dir}: ${label} → ${action}`);
      assert.strictEqual(g.chargeNet, honest, `${dir}: 🔴 ${label} must not move the charge off ${honest}`);
    }

    /* 🔴 TAMPERING WITH THE CART WHILE HOLDING A VALID TOKEN. The token is real and its ceiling is
       generous; only the cart is edited. The fingerprint is what notices — and on la_musa a reward is
       net-invariant, so the amount alone never could. */
    {
      const dearer = JSON.parse(JSON.stringify(items));
      dearer.push(JSON.parse(JSON.stringify(items[0])));           // a second line the token never saw
      const g = gateConfirmedNet({ token: mint(honest + 50_000), submittedCart: dearer, reward: null,
        rid: B.rid, tables, secret: SECRET, nowMs: Date.now() });
      assert.strictEqual(g.action, 'refuse_invalid', `${dir}: 🔴 a cart the token never described is refused`);
      assert.strictEqual(g.reason, 'cart_mismatch', `${dir}: …on the fingerprint, not the amount`);
    }
    // …and the client's own money fields still cannot move it, token or no token.
    {
      const tampered = JSON.parse(JSON.stringify(items));
      tampered.forEach((i) => { i.price = 1; i.subtotal = 1; i.extrasTotal = -9999; });
      const g = gateConfirmedNet({ token: mint(honest + 50_000), submittedCart: tampered, reward: null,
        rid: B.rid, tables, secret: SECRET, nowMs: Date.now() });
      assert.ok(g.action === 'refuse_invalid' || g.chargeNet === honest,
        `${dir}: 🔴 repriced client money fields cannot move the charge even with a valid token (${g.action}/${g.chargeNet})`);
    }
    /* 🔴 THE CARD PAYLOAD, TAMPERED WHILE HOLDING A VALID TOKEN. Everything above ran on the CASH
       serializer's payload, and the two endpoints do not send the same shape — chargeOnlineOrder was
       the path 1C T5 found a real defect on, and the one the whole-flow matrix was silently skipping
       until this revise. So the card body is composed by the form and tampered afterwards, exactly as
       the cash one is, and the identity checks are made against it. */
    {
      const card = await realPayload(dir, { card: true });
      const cardItems = card.body.items;
      assert.ok(Array.isArray(cardItems) && cardItems.length > 0,
        `${dir}: premise — the card serializer produced a payload with items`);
      const cardNet = computeServerNet({ items: cardItems, rid: B.rid, tables }).net_total_cents;
      assert.ok(cardNet > 0, `${dir}: premise — the card payload prices to a real net (${cardNet})`);
      const cardTok = (cart, reward = null) => signQuoteToken({
        quote_id: 'cb-card', rid: B.rid, net_total_cents: cardNet + 50_000,
        cart_fingerprint: cartFingerprint(normalizeCartForFingerprint(cart, B.rid), reward),
        issued_at: Date.now(), expires_at: Date.now() + 900000,
      }, SECRET);

      const gateCard = (cart, reward = null, token = cardTok(cardItems)) => gateConfirmedNet({
        token, submittedCart: cart, reward, rid: B.rid, tables, secret: SECRET, nowMs: Date.now(),
      });

      // the honest card payload still charges the server's net, not the generous ceiling
      const honestCard = gateCard(cardItems);
      assert.strictEqual(honestCard.action, 'charge', `${dir}/card: premise — the untampered card body charges`);
      assert.strictEqual(honestCard.chargeNet, cardNet,
        `${dir}/card: 🔴 the card charge is the SERVER's net, not the token's ${cardNet + 50_000}`);

      // …and each identity edit is refused on the fingerprint
      const qtyBumped = JSON.parse(JSON.stringify(cardItems));
      qtyBumped[0].qty = (qtyBumped[0].qty || 1) + 1;
      assert.strictEqual(gateCard(qtyBumped).action, 'refuse_invalid',
        `${dir}/card: 🔴 a changed QUANTITY is refused even with a valid, generous token`);

      /* 🔴 SUBSTITUTED FOR A REAL DISH, NOT A MADE-UP ONE. Appending "(otra)" makes the item
         UNPRICEABLE, so the gate refuses at bad_cart and never reaches the fingerprint — the check
         passed while testing a different rule entirely. Swapping in a genuinely priceable dish is what
         forces the identity comparison to be the thing that objects. */
      const swapped = JSON.parse(JSON.stringify(cardItems));
      const keys = Object.keys(tables.menu);
      if (swapped[0].id !== undefined) {
        const other = keys.find((k) => String(k) !== String(swapped[0].id));
        assert.ok(other, `${dir}/card: premise — the menu has a second dish to swap to`);
        swapped[0].id = other;
        if (swapped[0].name) swapped[0].name = String(other);
      } else {
        const other = keys.find((k) => k !== swapped[0].name);
        assert.ok(other, `${dir}/card: premise — the menu has a second dish to swap to`);
        swapped[0].name = other;
      }
      const swappedNet = computeServerNet({ items: swapped, rid: B.rid, tables });
      assert.ok(!swappedNet.error,
        `${dir}/card: 🔴 premise — the substitute must be PRICEABLE, or the gate refuses at bad_cart and the fingerprint is never consulted`);
      const swapRes = gateCard(swapped);
      assert.strictEqual(swapRes.action, 'refuse_invalid',
        `${dir}/card: 🔴 a changed ITEM IDENTITY is refused — x_pizza prices by name, la_musa by id`);
      assert.strictEqual(swapRes.reason, 'cart_mismatch',
        `${dir}/card: 🔴 …on the FINGERPRINT, not because the cart stopped pricing`);

      /* 🔴 AND A REWARD SWAPPED IN UNDER A REWARD-FREE TOKEN. On both brands the reward is
         net-invariant (add_free, discount 0), so the amount is identical and only the fingerprint can
         object — which is precisely why it hashes the resolved reward. */
      const { computeRedemption } = require('./rewards-redeem');
      const raw = dir === 'la-musa-orders'
        ? { type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }] }
        : { type: 'free_pizza_choice', item_id: cardItems[0].name };
      const rr = computeRedemption({ redeem: raw, items: cardItems, restaurantId: B.rid });
      /* ASSERTED, NOT CONDITIONAL. `if (rr && rr.ok)` silently skipped this whole check whenever the
         fixture stopped resolving — the cell would keep passing while testing nothing. */
      assert.ok(rr && rr.ok, `${dir}/card: premise — the reward resolves (${rr && rr.reason})`);
      {
        const netWithReward = computeServerNet({ items: cardItems, reward: rr, rid: B.rid, tables }).net_total_cents;
        assert.strictEqual(netWithReward, cardNet,
          `${dir}/card: premise — the reward is net-invariant, so the amount cannot distinguish it`);
        assert.strictEqual(gateCard(cardItems, rr).action, 'refuse_invalid',
          `${dir}/card: 🔴 a reward added under a reward-free token is refused on the FINGERPRINT — the net is identical`);
      }
      /* 🔴 AND A REFUSAL MINTS NO CHECKOUT. The gate answers are the rule; this is the consequence the
         customer would actually feel — a PixelPay checkout created for an amount the gate just
         refused. Driven through the composed flow with the gateway injected, so "no checkout" is
         observed rather than inferred from the gate's return value. */
      {
        const { resolveAndIssueHostedCheckout } = require('./hosted-charge-flow');
        const { applyConfirmedNetGate, gateInputFromRequest } = require('./token-gate');
        const created = [];
        const out = await resolveAndIssueHostedCheckout({
          acq: { outcome: 'claimed', attempt_id: 'CB-A', expires_at: 1 },
          orderId: 'CB-1', totalCents: cardNet, toLempiras: (c) => (c / 100).toFixed(2),
          chargeRequest: { pixelpayOrderId: 'CB-1-A' },
          log: { log() {}, warn() {}, error() {} },
          releaseHold: async () => {}, retireAttempt: async () => {},
          stampProvenance: async () => {}, attachReservation: null,
          createCheckout: async (req) => { created.push(req); return { ok: true, url: 'https://pay/x' }; },
          persistCreated: async () => {},
          runGate: (recorded) => applyConfirmedNetGate({
            gateInput: gateInputFromRequest({ items: swapped, quote_token: cardTok(cardItems), expected_net_cents: cardNet },
              { reward: null, rid: B.rid, tables, secret: SECRET, enforce: false, nowMs: Date.now() }),
            recordedTotalCents: recorded, releaseHold: async () => {}, orderId: 'CB-1',
            log: { log() {}, warn() {}, error() {} },
          }),
        });
        assert.ok(out.respond && out.respond.status === 409,
          `${dir}/card: the refused cart answers 409 (got ${out.respond && out.respond.status})`);
        assert.strictEqual(created.length, 0,
          `${dir}/card: 🔴 a refused card order must create NO PixelPay checkout — a checkout at a refused amount is the charge itself`);
      }
      ok(`${dir}: the CARD payload — a valid token does not license a changed cart, quantity, or reward, and mints no checkout`);
    }
    ok(`${dir}: the confirmed-quote token is a CEILING — it can refuse a sale, it can never set the price`);
  }
}

closeAll();
console.log(`\n${count()} charge-boundary checks passed.`);
