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

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const SECRET = 'd2-roundtrip-secret';

function bodyFor(dir, w, withIds) {
  const body = BRAND[dir].menu(w);
  body.dishes = body.dishes.map((d) => (withIds ? { ...d, dish_id: `ID_dish_${d.id}` } : { ...d }));
  body.extras = body.extras.map((e) => (withIds ? { ...e, extra_id: `ID_extra_${e.id}` } : { ...e }));
  return body;
}

/* A page with a real cart AND a fillable form, submitted through the form's own entry points. The
   createOrder request body is captured off the fetch — that body IS the stored order and the input to
   every durable surface, so asserting on it is asserting on what production would persist. */
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

      // …and the dedup key the server derives from it is therefore unmoved.
      assert.strictEqual(orderContentKey({ ...a, items_text: a.items_text }), orderContentKey({ ...b, items_text: b.items_text }),
        `${dir}/${method}: 🔴 identity moved orderContentKey — the server's duplicate-order defence`);

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
      const strip = (o) => JSON.stringify({ ...o, order_id: '<frozen>', timestamp: '<frozen>',
        items: (o.items || []).map((l) => {
          const { dish_id, extras, ...r } = l;
          return { ...r, extras: (extras || []).map(({ extra_id, ...e }) => e) };
        }) });
      assert.strictEqual(strip(a), strip(b),
        `${dir}/${method}: 🔴 the two orders differ by more than the identity fields`);
      ok(`${dir}/${method}: the order carries both ids, items_text carries neither by value, and the rest is byte-identical`);
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

      /* NON-VACUITY: the same gate DOES refuse when the cart really changes, so "not refused" above is
         the gate working rather than the gate being asleep. */
      const tampered = JSON.parse(JSON.stringify(idItems));
      tampered[0].qty += 1;
      const bad = gateConfirmedNet(gateInputFromRequest(
        { items: tampered, quote_token: token, expected_net_cents: net },
        { rid, tables, secret: SECRET, enforce: true, nowMs: Date.now() },
      ));
      assert.notStrictEqual(bad.action, 'charge',
        `${dir}: non-vacuity — a genuinely different cart must NOT charge on that token (got ${bad.action}/${bad.reason})`);
      ok(`${dir}: a quote token signed before the backfill still charges after it, and a real cart change still does not`);
    }
  }

  console.log(`\ncart-identity-order: ${count()} checks passed across both forms`);
  closeAll();
  process.exit(0);
})().catch((e) => { console.error('cart-identity-order FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
