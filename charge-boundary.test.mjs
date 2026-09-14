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
async function realPayload(dir, { failQuote = false } = {}) {
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
  try { await w.submitOrder('confirmed'); } catch (_) {}
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

closeAll();
console.log(`\n${count()} charge-boundary checks passed.`);
