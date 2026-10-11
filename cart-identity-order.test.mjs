// Portal 1D · D2 — THE ORDER ROUND-TRIP: the id rides, and nothing that decides or is stored sees it.
// Run: node cart-identity-order.test.mjs
//
// cart-identity.test.mjs proves the three client SIGNATURES are id-blind. This file proves the other
// half, and it does it at RUNTIME rather than by reading the source:
//   · a real submit, both payment endpoints, both brands — the createOrder body captured off the wire
//   · items_text, which two server bindings hash and the KDS, WhatsApp and tracker render verbatim,
//     asserted to contain neither id VALUE (a census that the builder never NAMES an identity field is
//     a lint; this is the proof, and the distinction is one this project has paid for before)
//   · a quote token signed over a PRE-backfill cart, verified against the SAME cart after the ids
//     appear, through the real gate — the customer-not-blocked proof that byte-equality of pieces
//     does not give you
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { cartFingerprint, normalizeCartForFingerprint, signQuoteToken } = require('./quote-token');
const { gateInputFromRequest, gateConfirmedNet } = require('./token-gate');
const { computeServerNet } = require('./compute-server-net');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { orderContentKey } = require('./order-dedup');
const { redemptionFingerprint, computeRedemption } = require('./rewards-redeem');
const { orderFingerprint } = require('./pixelpay-charge');

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const STASH_KEY = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
const SECRET = 'd2-roundtrip-secret';

function bodyFor(dir, w, withIds) {
  const body = BRAND[dir].menu(w);
  body.dishes = body.dishes.map((d) => (withIds ? { ...d, dish_id: `ID_dish_${d.id}` } : { ...d }));
  body.extras = body.extras.map((e) => (withIds ? { ...e, extra_id: `ID_extra_${e.id}` } : { ...e }));
  return body;
}

/* A page with a real cart AND a fillable form, submitted through the form's own entry points. The
   createOrder request body is captured off the fetch. Stated precisely: that body is what the server
   RECEIVES and persists the order FROM, and is the input to every durable surface — it is the wire
   format, not a read-back of a stored document. Nothing here proves Firestore wrote it; what it proves
   is that nothing carrying an id value was ever sent, which is the claim D2 needs. */
async function submitted(dir, { withIds, card = false }) {
  const w = loadForm(dir);
  const sent = {};
  w.__respond = (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('createOrder')) { sent.createOrder = body; return new Promise(() => {}); }
    if (u.includes('chargeOnlineOrder')) { sent.charge = body; return new Promise(() => {}); }
    if (u.includes('quoteOrder')) { sent.quote = body; return new Promise(() => {}); }
    return new Promise(() => {});
  };
  const prepared = w.liveMenuPrepare(bodyFor(dir, w, withIds));
  w.liveMenuGlobalSet('MENU', prepared.MENU);
  w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();

  const dish = prepared.MENU.find((d) => d.price > 0);
  w.chg(dish.id, 2);
  await settle();
  w.toggleDetailExtra(prepared.EXTRAS[0].id, dish.id, 0);
  await settle();

  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn'], ['notes', '']]) {
    if (g(id)) g(id).value = v;
  }
  const built = w.buildOrder();
  assert.strictEqual(built, true, `${dir}: premise — the order composes (withIds=${withIds}, card=${card})`);
  const pending = card ? (w.selectPay('online'), w.processPixelPay()) : w.submitOrder('confirmed');
  if (pending && pending.catch) pending.catch(() => {});
  await settle(); await settle();
  return { w, sent, dish, prepared };
}

/* ── THE FROZEN GOLDEN ───────────────────────────────────────────────────────────────────────
   🔴 WHY A LITERAL AND NOT A RECOMPUTATION. Every "order(with id) == order(without id)" in this file
   is vacuous PER FIELD: both sides run the same code, so making any single field constant leaves the
   two sides equal and the assertion green. Patching that field by field is why each gate round found
   the next uncovered one — items_text, then the canonical, then total and phone, then the net, then
   extrasTotal. The defect is the SHAPE of the comparison, not the coverage of the list.
   So the id-less artifact is frozen here as a LITERAL, captured once from a real run. A constant
   items_text, a zeroed extrasTotal, a constant total, phone, net or canonical now fails against a real
   value in a single assertion, and it covers fields nobody has thought to enumerate yet.
   THE TRADEOFF, stated: this is brittle to legitimate catalog changes. That is the price of a golden
   and it is deliberate — a golden that recomputes itself is not a golden. Scoped to the
   money-and-identity-critical fields rather than the whole body, so an unrelated field gaining a
   property does not break it. If the catalog moves and these fail, re-capture: the values are exactly
   what a cart of 2× the first priced dish plus its first option emits. */
const GOLDEN = {
  'xpizza-orders': {
    items: [{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680,
      extras: [{ instance: 0, name: 'Salsa Roja', price: 39 }], extrasTotal: 39 }],
    items_text: '2x Carnivora (L340) [Pizza 1: Salsa Roja]',
    total: 719, phone: '+504 9876-5432', net: 71900,
    canonical: { restaurant_id: 'x_pizza', model: 'add_free', type: 'free_pizza_choice',
      config_version: 2, cost: 8, discount_cents: 0, free_item_key: 'Carnivora' },
  },
  'la-musa-orders': {
    items: [{ id: 'dimsum_01', name: 'Sichuan Spicy Wonton', cat: 'dim_sum', qty: 2, price: 223, subtotal: 496,
      extras: [{ id: 'rice_white', name: 'Arroz Blanco', price: 50, qty: 1 }], extrasTotal: 50 }],
    items_text: '2x Sichuan Spicy Wonton (L223) [+ Arroz Blanco]',
    total: 496, phone: '+504 9876-5432', net: 49600,
    canonical: { restaurant_id: 'la_musa', model: 'add_free', type: 'points_ala_carte',
      config_version: 2, discount_cents: 0, total_cost: 743,
      items: [{ free_item_key: 'dimsum_01', cost: 743, qty: 1, price_cents: 22300 }] },
  },
};

/* ── THE COMPLETE ORDER GOLDEN ───────────────────────────────────────────────────────────────
   🔴 THE SELECTED-FIELD GOLDEN LEFT A HOLE, AND THE HOLE WAS THE WHOLE-ORDER CLAIM. The assertion
   said "the two orders differ by ONLY the identity fields", but what backed it was a golden over
   chosen fields plus an a-vs-b equality — and a-vs-b cannot fail for a field both sides get wrong.
   A constant customer_email passed both suites.
   So the golden is now the COMPLETE sent order, frozen as a literal per brand and per payment method
   (payment_status differs: confirmed for cash, pending for card). Every field is pinned against a real
   value whether or not anyone thought to enumerate it.

   🔴 EXACTLY TWO FIELDS ARE NORMALIZED, AND BOTH ARE MEASURED NONCES, NOT ASSUMED ONES. Each of the
   four brand×method payloads was captured TWICE and diffed; order_id and timestamp were the only
   fields that varied, so they are the only ones frozen to a placeholder. A normalized field is a
   documented exception — order_id embeds a timestamp and a random suffix, `timestamp` is the wall
   clock — and both are asserted PRESENT before being replaced, so normalizing cannot hide a field
   that vanished. Everything else, customer_email included, is compared for real.

   Brittle to legitimate order-shape changes by design. Re-capture recipe: a cart of 2× the first
   priced dish plus its first option, name "Cliente Prueba", phone 98765432, email cliente@test.hn. */
const ORDER_GOLDEN = {
  "xpizza-orders": {
    "cash": {
      "order_id": "<frozen>",
      "customer_name": "Cliente Prueba",
      "customer_phone": "+504 9876-5432",
      "customer_email": "cliente@test.hn",
      "items": [
        {
          "name": "Carnivora",
          "qty": 2,
          "price": 340,
          "subtotal": 680,
          "extrasTotal": 39,
          "extras": [
            {
              "instance": 0,
              "name": "Salsa Roja",
              "price": 39
            }
          ]
        }
      ],
      "items_text": "2x Carnivora (L340) [Pizza 1: Salsa Roja]",
      "total": 719,
      "notes": "—",
      "lat": null,
      "lng": null,
      "maps_link": "https://www.google.com/maps?q=null,null",
      "address_detected": "",
      "address_details": "",
      "waze_link": "https://waze.com/ul?ll=null,null&navigate=yes",
      "payment_method": null,
      "order_type": "delivery",
      "pickup_time": null,
      "scheduled_for": null,
      "payment_status": "confirmed",
      "timestamp": "<frozen>",
      "razon_social": "",
      "rtn_cliente": "",
      "expected_net_cents": 71900
    },
    "card": {
      "order_id": "<frozen>",
      "customer_name": "Cliente Prueba",
      "customer_phone": "+504 9876-5432",
      "customer_email": "cliente@test.hn",
      "items": [
        {
          "name": "Carnivora",
          "qty": 2,
          "price": 340,
          "subtotal": 680,
          "extrasTotal": 39,
          "extras": [
            {
              "instance": 0,
              "name": "Salsa Roja",
              "price": 39
            }
          ]
        }
      ],
      "items_text": "2x Carnivora (L340) [Pizza 1: Salsa Roja]",
      "total": 719,
      "notes": "—",
      "lat": null,
      "lng": null,
      "maps_link": "https://www.google.com/maps?q=null,null",
      "address_detected": "",
      "address_details": "",
      "waze_link": "https://waze.com/ul?ll=null,null&navigate=yes",
      "payment_method": null,
      "order_type": "delivery",
      "pickup_time": null,
      "scheduled_for": null,
      "payment_status": "pending",
      "timestamp": "<frozen>",
      "razon_social": "",
      "rtn_cliente": "",
      "expected_net_cents": 71900
    }
  },
  "la-musa-orders": {
    "cash": {
      "restaurant_id": "la_musa",
      "order_id": "<frozen>",
      "customer_name": "Cliente Prueba",
      "customer_phone": "+504 9876-5432",
      "items": [
        {
          "id": "dimsum_01",
          "name": "Sichuan Spicy Wonton",
          "cat": "dim_sum",
          "qty": 2,
          "price": 223,
          "subtotal": 496,
          "extrasTotal": 50,
          "extras": [
            {
              "id": "rice_white",
              "name": "Arroz Blanco",
              "price": 50,
              "qty": 1
            }
          ]
        }
      ],
      "items_text": "2x Sichuan Spicy Wonton (L223) [+ Arroz Blanco]",
      "total": 496,
      "notes": "—",
      "lat": null,
      "lng": null,
      "maps_link": "https://www.google.com/maps?q=null,null",
      "address_detected": "",
      "address_details": "",
      "waze_link": "https://waze.com/ul?ll=null,null&navigate=yes",
      "payment_method": null,
      "order_type": "delivery",
      "pickup_time": null,
      "scheduled_for": null,
      "payment_status": "confirmed",
      "timestamp": "<frozen>",
      "customer_email": "cliente@test.hn",
      "razon_social": "",
      "rtn_cliente": "",
      "expected_net_cents": 49600
    },
    "card": {
      "restaurant_id": "la_musa",
      "order_id": "<frozen>",
      "customer_name": "Cliente Prueba",
      "customer_phone": "+504 9876-5432",
      "items": [
        {
          "id": "dimsum_01",
          "name": "Sichuan Spicy Wonton",
          "cat": "dim_sum",
          "qty": 2,
          "price": 223,
          "subtotal": 496,
          "extrasTotal": 50,
          "extras": [
            {
              "id": "rice_white",
              "name": "Arroz Blanco",
              "price": 50,
              "qty": 1
            }
          ]
        }
      ],
      "items_text": "2x Sichuan Spicy Wonton (L223) [+ Arroz Blanco]",
      "total": 496,
      "notes": "—",
      "lat": null,
      "lng": null,
      "maps_link": "https://www.google.com/maps?q=null,null",
      "address_detected": "",
      "address_details": "",
      "waze_link": "https://waze.com/ul?ll=null,null&navigate=yes",
      "payment_method": null,
      "order_type": "delivery",
      "pickup_time": null,
      "scheduled_for": null,
      "payment_status": "pending",
      "timestamp": "<frozen>",
      "customer_email": "cliente@test.hn",
      "razon_social": "",
      "rtn_cliente": "",
      "expected_net_cents": 49600
    }
  }
};

// The identity fields removed, so an id-bearing order can be compared to the id-less golden.
const withoutIdentity = (items) => (items || []).map((l) => {
  const { dish_id, extras, ...rest } = l;
  return { ...rest, extras: (extras || []).map(({ extra_id, ...e }) => e) };
});

const payload = (s) => s.sent.createOrder || s.sent.charge;

(async () => {
  for (const dir of DIRS) {
    const rid = BRAND[dir].rid;

    for (const card of [false, true]) {
      const method = card ? 'card' : 'cash';
      const A = await submitted(dir, { withIds: true, card });
      const B = await submitted(dir, { withIds: false, card });
      const a = payload(A); const b = payload(B);
      assert.ok(a, `${dir}/${method}: premise — a request actually left the form`);
      assert.ok(b, `${dir}/${method}: premise — the id-less order sent too`);

      // ── THE ID RIDES ──────────────────────────────────────────────────────────────────────
      const line = (a.items || [])[0];
      assert.ok(line && line.dish_id, `${dir}/${method}: 🔴 the sent order carries dish_id`);
      assert.ok(line.extras && line.extras[0] && line.extras[0].extra_id,
        `${dir}/${method}: 🔴 …and the nested extra_id`);
      assert.ok(!/dish_id|extra_id/.test(JSON.stringify(b.items || [])), `${dir}/${method}: premise — the other order carries neither`);

      /* ── …AND items_text DOES NOT, BY VALUE ───────────────────────────────────────────────
         Two server bindings hash this string and the KDS ticket, the WhatsApp message and the
         customer tracker render it verbatim. An id here changes a server hash AND puts an opaque
         token in front of a kitchen. The VALUES are searched for, not the field names. */
      assert.ok(typeof a.items_text === 'string' && a.items_text.length > 0,
        `${dir}/${method}: premise — items_text was built (${a.items_text})`);
      /* BY VALUE FIRST, deliberately. The equality below would also catch a leak, but it would report
         it as "items_text changed" — true, and one step removed from the thing that matters. Searching
         for the VALUE names the defect directly, and that is what a failure should say. */
      assert.ok(!a.items_text.includes(line.dish_id),
        `${dir}/${method}: 🔴 the dish id VALUE ${line.dish_id} is in items_text — hashed by two server bindings and printed on the KDS ticket`);
      assert.ok(!a.items_text.includes(line.extras[0].extra_id),
        `${dir}/${method}: 🔴 the extra id VALUE ${line.extras[0].extra_id} is in items_text`);
      assert.strictEqual(a.items_text, b.items_text,
        `${dir}/${method}: 🔴 identity changed items_text — the KDS ticket and two server hashes with it`);

      /* ── ALL SIX SERVER BINDINGS, BY VALUE ───────────────────────────────────────────────
         🔴 AND THE ADAPTER IS THE REAL ONE. This previously spread the request payload straight into
         orderContentKey — which reads { phone, itemsText, orderType, scheduledFor } in camelCase,
         while the payload is snake_case. Every field arrived undefined, so the function hashed four
         empty strings and returned the SAME key for any two orders on earth. It agreed with itself and
         proved nothing. The mapping is explicit now, and a positive control below proves the adapter
         actually feeds it. */
      const dedupKey = (o) => orderContentKey({
        phone: o.customer_phone, itemsText: o.items_text, orderType: o.order_type,
        scheduledFor: Number.isFinite(o.scheduled_for) ? o.scheduled_for : undefined,
      });
      assert.strictEqual(dedupKey(a), dedupKey(b),
        `${dir}/${method}: 🔴 identity moved orderContentKey — the server's duplicate-order defence`);
      assert.notStrictEqual(dedupKey(a), dedupKey({ ...a, items_text: a.items_text + ' EXTRA' }),
        `${dir}/${method}: 🔴 non-vacuity — a DIFFERENT items_text must give a different dedup key, or the adapter is feeding undefineds again`);

      // orderFingerprint — hashes items_text, and is what the charge path binds to.
      assert.strictEqual(
        orderFingerprint('ORD-1', a.total, a.items_text),
        orderFingerprint('ORD-1', b.total, b.items_text),
        `${dir}/${method}: 🔴 identity moved orderFingerprint`);
      assert.notStrictEqual(orderFingerprint('ORD-1', a.total, a.items_text), orderFingerprint('ORD-1', a.total, a.items_text + 'X'),
        `${dir}/${method}: non-vacuity — orderFingerprint does discriminate its items_text`);

      // The redemption canonical, its fingerprint, and the reservation binding built on top of it.
      {
        const t = { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] };
        const raw = rid === 'la_musa'
          ? { type: 'points_ala_carte', items: [{ id: (b.items[0] || {}).id, qty: 1 }] }
          : { type: 'free_pizza_choice', item_id: (b.items[0] || {}).name };
        const ra = computeRedemption({ redeem: raw, items: a.items, restaurantId: rid });
        const rb = computeRedemption({ redeem: raw, items: b.items, restaurantId: rid });
        assert.ok(rb && rb.ok, `${dir}/${method}: premise — the reward resolves (${rb && rb.reason})`);
        assert.deepStrictEqual(ra.canonical, GOLDEN[dir].canonical,
          `${dir}/${method}: 🔴 the redemption CANONICAL does not match the frozen golden — a constant canonical fails here, where comparing it to itself could not`);
        assert.strictEqual(redemptionFingerprint(ra.canonical), redemptionFingerprint(rb.canonical),
          `${dir}/${method}: 🔴 identity moved the REDEMPTION fingerprint`);
        /* 🔴 THE RESERVATION BINDING, ASSERTED THROUGH ITS INPUTS — AND WHY. bindingFp is not exported
           from rewards-reserve.js. Calling it directly would mean widening a production module's
           surface for a test's benefit, and re-implementing it here would put a second copy of a money
           binding in the suite — the fake-laxer-than-production hazard this project has paid for
           repeatedly. It is a pure function of exactly three things: the redemption canonical, the
           order fingerprint, and a config version that identity cannot touch. Both varying inputs are
           asserted byte-equal immediately above and below, so the binding cannot move unless one of
           them does. Stated as the inference it is, not dressed up as a measurement. */
        assert.strictEqual(JSON.stringify(ra.canonical), JSON.stringify(rb.canonical),
          `${dir}/${method}: 🔴 the redemption canonical moved — the RESERVATION binding is built from it`);
        assert.notStrictEqual(redemptionFingerprint(ra.canonical), redemptionFingerprint({ ...ra.canonical, __x: 1 }),
          `${dir}/${method}: non-vacuity — the redemption fingerprint discriminates its canonical`);
      }

      // The quote HMAC — the signature itself, over the same cart with and without identity.
      {
        const na = normalizeCartForFingerprint(a.items, rid);
        const nb = normalizeCartForFingerprint(b.items, rid);
        assert.ok(na && nb, `${dir}/${method}: premise — both carts normalize`);
        const sign = (n) => signQuoteToken({ quote_id: 'fixed', rid, net_total_cents: 1000,
          cart_fingerprint: cartFingerprint(n, null), issued_at: 1700000000000, expires_at: 1700000900000 }, SECRET);
        assert.strictEqual(sign(na), sign(nb),
          `${dir}/${method}: 🔴 identity moved the signed QUOTE TOKEN — every issued token would fail to verify`);
      }

      // ── NO OTHER DURABLE FIELD CARRIES AN ID VALUE ────────────────────────────────────────
      /* Everything the server persists or renders, minus the items array the id is SUPPOSED to ride
         in. If a value leaked anywhere else, this finds it without needing to know which field. */
      const { items: _ignored, ...rest } = a;
      const flat = JSON.stringify(rest);
      assert.ok(!flat.includes(line.dish_id) && !flat.includes(line.extras[0].extra_id),
        `${dir}/${method}: 🔴 an id VALUE reached a field outside items[] — ${flat.slice(0, 200)}`);

      // ── THE ORDER IS OTHERWISE THE SAME ORDER ─────────────────────────────────────────────
      /* 🔴 THE TWO NONCES ARE FROZEN, NOT IGNORED. order_id embeds a timestamp and a random suffix and
         `timestamp` is the wall clock, so two submissions a millisecond apart differ in exactly those
         two fields whatever identity does. Blanking them is what makes the rest of the comparison
         meaningful; asserting they are PRESENT first is what stops the blanking from hiding a field
         that vanished. Everything else — every customer field, the totals, the links, the fiscal
         fields, expected_net_cents — is compared byte for byte. */
      for (const o of [a, b]) {
        assert.ok(o.order_id && o.timestamp, `${dir}/${method}: premise — both nonces are present before being frozen`);
      }
      /* 🔴 BOTH ORDERS AGAINST THE COMPLETE GOLDEN — which subsumes the a-vs-b equality that used to
         stand here and could not fail for a field both sides got wrong. Pinning each side to the same
         literal proves they agree AND that what they agree on is right. */
      const normalized = (o) => ({ ...o, order_id: '<frozen>', timestamp: '<frozen>',
        items: withoutIdentity(o.items) });
      assert.deepStrictEqual(normalized(a), ORDER_GOLDEN[dir][method],
        `${dir}/${method}: 🔴 the id-bearing order does not match the COMPLETE frozen golden — every field is in here, enumerated or not`);
      assert.deepStrictEqual(normalized(b), ORDER_GOLDEN[dir][method],
        `${dir}/${method}: 🔴 …and neither does the id-less one`);
      /* ── AGAINST THE FROZEN GOLDEN ─────────────────────────────────────────────────────────
         The assertion the per-field equalities could not make. Each of these fails if its value is
         constant, zeroed or broken, because the other side is a literal rather than the same code
         run twice. */
      /* The COMPLETE golden above already pins every field of the order body — items, items_text,
         total, phone, email and the rest — so the per-field assertions that used to sit here are gone
         rather than left as a second, narrower copy that can drift from it. What remains is the two
         values that are DERIVED from the order rather than carried in it, which no body golden can
         cover: the server's net, and the redemption canonical below. */
      const G = GOLDEN[dir];
      assert.strictEqual(computeServerNet({ items: a.items, reward: null, rid,
        tables: { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] } }).net_total_cents, G.net,
        `${dir}/${method}: 🔴 the server net does not match the golden`);

      /* 🔴 AND order_id IS A REAL NONCE. It cannot be frozen — it embeds a timestamp and a random
         suffix — so it gets the sensitivity control instead: two independently composed orders must
         carry DIFFERENT ids. A constant producer would satisfy every "the resume reused the id"
         assertion in this file, because the saved and the resent order would share the constant. */
      assert.notStrictEqual(a.order_id, b.order_id,
        `${dir}/${method}: 🔴 two separate orders share an order_id — the producer is constant, and every id-reuse assertion here would pass on it`);
      ok(`${dir}/${method}: the order matches the frozen id-less golden field for field, carries both ids, and its order_id is a real nonce`);
    }

    // ── A PRE-BACKFILL TOKEN STILL VERIFIES AFTER THE IDS APPEAR ────────────────────────────
    /* 🔴 THE CUSTOMER-NOT-BLOCKED PROOF. Byte-equality of fingerprints is a property of two values;
       this is the whole refusal path, through the real gate: a token signed over the cart as it was
       BEFORE the backfill, presented with the same cart AFTER the ids appear. If the id reached the
       server's fingerprint this returns refuse_invalid with cart_mismatch and a real customer is told
       their order cannot be placed. */
    {
      const before = await submitted(dir, { withIds: false });
      const after = await submitted(dir, { withIds: true });
      const legacyItems = payload(before).items;
      const idItems = payload(after).items;
      const tables = { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] };

      const netOut = computeServerNet({ items: legacyItems, reward: null, rid, tables });
      assert.ok(!netOut.error, `${dir}: premise — the pre-backfill cart prices server-side (${netOut.error})`);
      const net = netOut.net_total_cents;
      assert.ok(Number.isSafeInteger(net) && net > 0, `${dir}: premise — a real net in cents (${net})`);
      const norm = normalizeCartForFingerprint(legacyItems, rid);
      assert.ok(norm, `${dir}: premise — the pre-backfill cart normalizes`);
      const token = signQuoteToken({
        quote_id: 'd2-rt', rid, net_total_cents: net,
        cart_fingerprint: cartFingerprint(norm, null),
        issued_at: Date.now(), expires_at: Date.now() + 15 * 60 * 1000,
      }, SECRET);

      // …presented with the identity-bearing cart, which is what the customer's browser now sends.
      const gate = gateConfirmedNet(gateInputFromRequest(
        { items: idItems, quote_token: token, expected_net_cents: net },
        { rid, tables, secret: SECRET, enforce: true, nowMs: Date.now() },
      ));
      assert.notStrictEqual(gate.action, 'refuse_invalid',
        `${dir}: 🔴 a token issued before the backfill was REFUSED after it — reason ${gate.reason}. A customer mid-order would be blocked.`);
      assert.ok(!/cart_mismatch/.test(String(gate.reason || '')),
        `${dir}: 🔴 cart_mismatch — the id reached the server's cart fingerprint (${gate.reason})`);
      assert.strictEqual(gate.action, 'charge', `${dir}: it charges, as it would have pre-D2 (${gate.reason})`);

      /* 🔴 NON-VACUITY, AND IT HAS TO PIN THE FINGERPRINT SPECIFICALLY. Bumping a quantity does make
         the gate refuse — but it also raises the price, so the refusal could come from the independent
         net-ceiling check and the assertion would hold even if cartFingerprint returned a constant.
         That is the vacuity: "some refusal happened" is not "the fingerprint discriminated".
         So the discriminating control changes the cart WITHOUT changing the money: one option swapped
         for another at an identical price. The total is unmoved, the ceiling is satisfied, and the ONLY
         thing that can object is the fingerprint — so the refusal must be cart_mismatch by name. */
      /* 🔴 THE PAIR COMES FROM THE SERVER'S OWN TABLES, not the served menu. My first attempt
         equalized two options in the body the FORM was served — which changed nothing about how the
         server prices them, so the "price-neutral" swap moved the net by 3500 cents and the premise
         failed. The server prices extras from EXTRAS_BY_RESTAURANT, so a swap is price-neutral only
         between two keys that table prices identically. Both brands have such a group. */
      const serverExtras = EXTRAS_BY_RESTAURANT[rid];
      const groups = Object.entries(serverExtras).reduce((m, [k, v]) => ((m[v] = m[v] || []).push(k), m), {});
      const pair = Object.values(groups).find((ks) => ks.length > 1);
      assert.ok(pair, `${dir}: premise — the server prices at least two options identically`);
      const setExtraKey = (line, key) => {
        // x_pizza keys an option by NAME, la_musa by its slug id — the same asymmetry itemPricingKey owns.
        if (line.extras[0].id !== undefined) line.extras[0].id = key;
        else line.extras[0].name = key;
        if (line.extras[0].id !== undefined) line.extras[0].name = key;
        line.extras[0].price = serverExtras[key];
      };
      const cartA = JSON.parse(JSON.stringify(idItems));
      const cartB = JSON.parse(JSON.stringify(idItems));
      setExtraKey(cartA[0], pair[0]);
      setExtraKey(cartB[0], pair[1]);

      const netA = computeServerNet({ items: cartA, reward: null, rid, tables });
      const netB = computeServerNet({ items: cartB, reward: null, rid, tables });
      assert.ok(!netA.error && !netB.error, `${dir}: premise — both swap carts price (${netA.error || netB.error})`);
      assert.strictEqual(netA.net_total_cents, netB.net_total_cents,
        `${dir}: premise — the swap is PRICE-NEUTRAL, so a refusal below cannot be the ceiling talking`);

      // The fingerprint must move, or nothing downstream can tell these two carts apart.
      assert.notStrictEqual(
        cartFingerprint(normalizeCartForFingerprint(cartA, rid), null),
        cartFingerprint(normalizeCartForFingerprint(cartB, rid), null),
        `${dir}: 🔴 cartFingerprint does NOT discriminate an equal-priced option swap — it could be returning a constant and every equality asserted above would still hold`);

      // A token bound to cart A, presented with cart B: same money, different cart.
      const tokenA = signQuoteToken({
        quote_id: 'd2-swap', rid, net_total_cents: netA.net_total_cents,
        cart_fingerprint: cartFingerprint(normalizeCartForFingerprint(cartA, rid), null),
        issued_at: Date.now(), expires_at: Date.now() + 15 * 60 * 1000,
      }, SECRET);
      const swapped = cartB;
      const net2 = netB.net_total_cents;
      const bad = gateConfirmedNet(gateInputFromRequest(
        { items: swapped, quote_token: tokenA, expected_net_cents: net2 },
        { rid, tables, secret: SECRET, enforce: true, nowMs: Date.now() },
      ));
      assert.notStrictEqual(bad.action, 'charge',
        `${dir}: 🔴 a different cart at the same price charged on the old token (got ${bad.action}/${bad.reason})`);
      assert.ok(/cart_mismatch/.test(String(bad.reason || '')),
        `${dir}: 🔴 …and it must refuse for the FINGERPRINT specifically, not some other reason (got ${bad.reason})`);
      ok(`${dir}: a quote token signed before the backfill still charges after it, and a real cart change still does not`);
    }

    // ── THE REAL RESTORE — A SAVED ORDER, RESUMED, WITH IDENTITY FLIPPING ACROSS IT ───────────
    /* 🔴 THIS CELL REPLACES ONE THAT NEVER RESTORED ANYTHING. Its predecessor built a fresh cart and
       called restoreRedeem(null, null, null) — no saved order, no restoreOrderForm, no token, no
       order_id comparison. Neutering restoreOrderForm entirely left the suite green, which is the
       definition of a test that is not testing.
       The real path: a customer composes an order, the form stashes it on the way to hosted payment,
       they come back to a fresh page — and in D2's rollout the backfill may have landed in between, so
       the menu they return to serves ids where the stashed one did not. What must hold is that the
       resume REUSES the original order_id (a fresh one would double-reserve the reward) and that a
       quote token still attaches. */
    {
      const first = await submitted(dir, { withIds: false });
      const saved = payload(first);
      assert.ok(saved && saved.order_id, `${dir}/restore: premise — an order was composed and sent`);

      /* The stash, built from the page's OWN writers — snapshotForm() and the order body it just
         sent — in exactly the shape processPixelPay persists. Not a shape invented here. */
      const stash = JSON.stringify({
        order_id: saved.order_id, t: 'poll-token-test', order: saved,
        form: first.w.snapshotForm(), ts: Date.now(),
      });

      // The return trip: a FRESH page, and the menu now carries ids. Identity flips across the resume.
      const w2 = loadForm(dir);
      let quoteBody = null;
      w2.__respond = (url, init) => {
        const u = String(url);
        if (u.includes('quoteOrder')) {
          quoteBody = init && init.body ? JSON.parse(init.body) : null;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            ok: true, total_cents: 50000, quote_id: 'restore-q1', quote_token: 'restore-token', net_total_cents: 50000 }) });
        }
        return new Promise(() => {});
      };
      w2.localStorage.setItem(STASH_KEY[dir], stash);
      /* 🔴 THE RETURN MENU IS REPRICED, which is what makes the agreed-price assertion below mean
         anything. Serving the same prices would make "the restored line still costs 340" true whether
         the restore honoured the captured price or silently took today's — the invariance would hold
         for the wrong reason. The dish is +75 on return; the restored line must still be the old
         price, because that is the number the customer accepted. */
      const returnBody = bodyFor(dir, w2, true);
      returnBody.dishes = returnBody.dishes.map((d) => ({ ...d, price: d.price + 75 }));
      const prepared = w2.liveMenuPrepare(returnBody);      // ids present on return, and REPRICED
      w2.liveMenuGlobalSet('MENU', prepared.MENU);
      w2.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
      await settle();

      w2.restoreOrderForm();
      await settle(); await settle();

      /* 🔴 THE RESTORED CART IS ASSERTED BEFORE ANYTHING TOUCHES IT. The previous version changed a
         quantity and toggled an option first, which REPOPULATED the cart — so removing
         cartRestore(snap.cart) entirely left the cell green: the test repaired the thing it was
         meant to be checking. Nothing is edited until the snapshot has been compared. */
      const restoredItems = w2.redeemCartItems();
      const legacyOf = (arr) => JSON.stringify((arr || []).map((l) => [l.name, l.qty, l.price,
        (l.extras || []).map((e) => [e.name, e.price])]));
      assert.ok(restoredItems.length > 0, `${dir}/restore: 🔴 the cart did not come back at all`);
      assert.strictEqual(legacyOf(restoredItems), legacyOf(saved.items),
        `${dir}/restore: 🔴 the restored cart is not the saved cart`);
      assert.strictEqual(w2.document.getElementById('cname').value, 'Cliente Prueba',
        `${dir}/restore: …and the form came back with it`);

      /* 🔴 WHAT A RESTORED CART CARRIES — MEASURED, AFTER THREE WRONG GUESSES, AND IT DEPENDS ON
         WHETHER THE RECORD STILL MATCHES. I claimed in turn that the restored cart stays id-less
         (hydrate restores the captured record), that only the option gains an id, and then that both
         do. Each failed against the real page. What governs it is 1B's reconciliation: a line whose
         live record still matches re-resolves and picks up whatever the menu now carries; a line whose
         record has MOVED keeps the one it was added with, because `added` is the agreed price and
         adopting today's record would adopt today's price with it.
         This return menu is REPRICED, so the DISH keeps its captured id-less record while the OPTION —
         untouched by the reprice — re-resolves and gains its extra_id. That is a genuinely mixed line,
         and it is the strongest shape to sign: identity present at one level and absent at the other,
         which is precisely where a shallow projection shows through. */
      assert.ok(!restoredItems[0].dish_id,
        `${dir}/restore: the repriced DISH keeps its captured record, so no dish_id — taking the live record would take the live price with it`);

      /* ── 1. THE AGREED PRICE SURVIVES, AND THE LIVE ONE IS REFUSED ─────────────────────────
         Invariance plus SENSITIVITY: the restored line must equal what the customer accepted AND must
         differ from what the menu charges today. Without the second half a restore that quietly
         adopted the live price would pass — which is the failure cartRestore's own comment says it
         exists to prevent (250→340 reproduced on both forms). */
      const livePrice = prepared.MENU.find((d) => d.name === saved.items[0].name).price;
      assert.strictEqual(restoredItems[0].price, saved.items[0].price,
        `${dir}/restore: 🔴 the AGREED price did not survive the resume`);
      assert.notStrictEqual(restoredItems[0].price, livePrice,
        `${dir}/restore: 🔴 the restore took TODAY's price (${livePrice}) as the agreed one — the customer would be charged a price they never accepted`);
      const restoredNet = computeServerNet({ items: restoredItems, reward: null, rid, tables: { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] } });
      assert.ok(!restoredNet.error, `${dir}/restore: the restored cart still prices server-side`);

      /* ── 2. THE RESTORED OPTION KEEPS ITS IDENTITY ─────────────────────────────────────────
         Asserted positively rather than inferred from a regex over the whole cart: dropping the
         option's extra_id on restore would leave every id-blindness assertion here green while the
         nested identity D3/D4 will read silently vanished on the resume path. */
      assert.ok(restoredItems[0].extras && restoredItems[0].extras.length > 0,
        `${dir}/restore: premise — the restored line still carries its option`);
      assert.ok(restoredItems[0].extras[0].extra_id,
        `${dir}/restore: 🔴 the restored option lost its extra_id — identity dropped on the resume path`);
      assert.ok(!/dish_id|extra_id/.test(w2.serverQuoteCartKey()),
        `${dir}/restore: 🔴 the restored cart's quote key carries identity`);
      assert.ok(!/dish_id|extra_id/.test(w2.confirmQuoteCartSig()),
        `${dir}/restore: 🔴 …and neither does the token signature, which is what must still attach`);

      // The re-quote the resume performs, on the cart as restored — no edits.
      w2.requestServerQuote(true);
      await settle(); await settle();
      assert.ok(quoteBody, `${dir}/restore: 🔴 the resumed page never re-quoted — the pre-existing revalidation did not fire`);
      assert.strictEqual(legacyOf(quoteBody.items), legacyOf(saved.items),
        `${dir}/restore: the re-quote asks about the restored cart, not some other one`);

      /* 🔴 AND THE TOKEN ATTACHES. current() hands back the token only if the stored signature matches
         what this cart computes now — precisely the comparison identity could break. */
      const attached = w2.__confirmQuote && w2.__confirmQuote.current(w2.confirmQuoteCartSig());
      assert.ok(attached && attached.token,
        `${dir}/restore: 🔴 no quote token attached after the resume — identity broke the signature match`);
      assert.strictEqual(attached.token, 'restore-token', `${dir}/restore: …and it is the token the server issued`);
      /* 🔴 AND THE ATTACH PATH ACTUALLY CHECKS THE SIGNATURE. current() handing a token back proves
         nothing on its own — a current() that ignored its argument would return one for ANY cart, and
         every "the token still attaches" assertion in this file would pass while the token had stopped
         being bound to the cart at all. Asking with a signature that does not match must return
         nothing; that is what makes the assertion above evidence. */
      assert.ok(!w2.__confirmQuote.current('a-signature-for-some-other-cart'),
        `${dir}/restore: 🔴 the attach path returned a token WITHOUT checking the cart signature — it is not bound to this cart`);

      /* NOW identity enters: the customer adds a line on the returned page, which captures from the
         id-BEARING menu. The cart becomes mixed — a restored id-less line beside a new id-bearing one,
         which is exactly what a mid-rollout resume produces — and the signatures must still be the
         ones an all-legacy cart would compute. */
      const dish = prepared.MENU.find((d) => d.price > 0 && !saved.items.some((l) => l.name === d.name));
      assert.ok(dish, `${dir}/restore: premise — a second, different dish exists to add`);
      w2.chg(dish.id, 1);
      await settle();
      const grown = w2.redeemCartItems();
      assert.ok(grown.length > restoredItems.length, `${dir}/restore: premise — the added line is on the cart`);
      /* The cart is now MIXED at the line level too: the restored line kept its captured, id-less
         record (its dish was repriced) while the newly added one captured from the id-bearing menu.
         That is what a mid-rollout resume actually produces, and it is what gets signed below. */
      assert.ok(grown.some((l) => l.dish_id), `${dir}/restore: 🔴 the newly added line captured identity from the live menu`);
      assert.ok(grown.some((l) => !l.dish_id), `${dir}/restore: 🔴 …beside the restored line, which kept its own — a genuinely mixed cart`);
      assert.ok(!/dish_id|extra_id/.test(w2.serverQuoteCartKey()),
        `${dir}/restore: 🔴 the grown cart's quote key carries identity`);

      /* 🔴 THE REPRICED RETURN CANNOT SEND, AND THAT IS THE POINT. buildOrder refuses while a line's
         agreed price disagrees with the live menu — 1B's rule, and the reason the agreed price is kept
         in the first place. So the resume-and-resend half needs a return where nothing was repriced,
         which is the ordinary case. Both are real; asserting only one would leave the other's
         behaviour unstated. */
      assert.strictEqual(w2.buildOrder(), false,
        `${dir}/restore: 🔴 a repriced line must BLOCK the send rather than compose an order at a price the customer never accepted`);

      /* ── THE ORDINARY RESUME: same prices, ids now served, order resent ─────────────────────
         🔴 AND THE ID IS READ OFF THE WIRE. Reading __resumeOrderId proves only that restoreOrderForm
         set a variable; orderIdForThisCart consumes it inside buildOrder, and swapping that branch for
         a fresh genOrderId() left the old assertion green. What matters is the id on the request. */
      {
        const w3 = loadForm(dir);
        let resent = null;
        w3.__respond = (url, init) => {
          const u = String(url);
          if (u.includes('quoteOrder')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
              ok: true, total_cents: 50000, quote_id: 'rq2', quote_token: 'restore-token-2', net_total_cents: 50000 }) });
          }
          if (u.includes('createOrder') || u.includes('chargeOnlineOrder')) { resent = init && init.body ? JSON.parse(init.body) : null; }
          return new Promise(() => {});
        };
        w3.localStorage.setItem(STASH_KEY[dir], stash);
        const same = w3.liveMenuPrepare(bodyFor(dir, w3, true));     // ids present, prices UNCHANGED
        w3.liveMenuGlobalSet('MENU', same.MENU);
        w3.liveMenuGlobalSet('EXTRAS', same.EXTRAS);
        await settle();
        w3.restoreOrderForm();
        await settle(); await settle();

        const back = w3.redeemCartItems();
        assert.strictEqual(legacyOf(back), legacyOf(saved.items), `${dir}/resume: the same saved cart came back`);
        assert.ok(back[0].dish_id,
          `${dir}/resume: 🔴 an unchanged record re-resolves and picks up the id the menu now serves — this is the customer who left before the backfill and returned after`);
        assert.ok(!/dish_id|extra_id/.test(w3.serverQuoteCartKey()),
          `${dir}/resume: 🔴 …and the quote key still carries none of it`);

        w3.requestServerQuote(true);
        await settle(); await settle();
        const gg = (id) => w3.document.getElementById(id);
        for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn']]) { if (gg(id)) gg(id).value = v; }
        assert.strictEqual(w3.buildOrder(), true, `${dir}/resume: the unchanged resume composes`);
        const pend = w3.submitOrder('confirmed');
        if (pend && pend.catch) pend.catch(() => {});
        await settle(); await settle();
        assert.ok(resent, `${dir}/resume: premise — the resumed order was actually sent`);
        assert.strictEqual(resent.order_id, saved.order_id,
          `${dir}/resume: 🔴 the SENT order carries a NEW order_id — the reward would be reserved a second time`);
      }
      ok(`${dir}: a saved order resumes on an id-bearing menu — same order_id, re-quote fires, token attaches`);
    }
  }
  console.log(`\ncart-identity-order: ${count()} checks passed across both forms`);
  closeAll();
  process.exit(0);
})().catch((e) => { console.error('cart-identity-order FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
