'use strict';
// Portal 1D · D4-P1 — P1 MOVES NO MONEY, MEASURED THROUGH THE REAL ORDER HANDLER AGAINST PRE-P1.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4p1-money
//
// 🔴 THE CONTROL IS PRE-P1 CODE, AND IT CANNOT BE RE-RUN. §8(a) asks for pre-P1 vs P1 on the same
// input, and pre-P1 cannot execute in the same process as P1 — one module registry, one index.js. So
// the control is a LITERAL captured once, through this same real handler, on pristine pre-P1 code
// (dc7d9f7) by test/d4p1-capture-order-control.js, and committed. Regenerating it against P1 would
// make it agree with whatever P1 does, which is exactly what it exists to refuse.
//
// 🔴 AND THE FLAG-OFF BUILD IS NOT A CONTROL EITHER: P1a with identity_rename_enabled OFF still mints,
// retires and stamps. Only pre-P1 is the control.
//
// 🔴 THE NORMALIZED FIELDS WERE MEASURED, NOT CHOSEN. The capture ran the same logical order TWICE and
// diffed the two stored orders; whatever differed is volatile and is listed in the golden itself. A
// hand-picked skip list is how a real difference gets normalized away by accident.
require('./_emulator-required')('database', 'firestore');   // refuse if the emulator host vars are unset (would hit real infrastructure, or a foreign emulator)

const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capture-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const SECRET = process.env.MAKE_SECRET;

const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [],
  exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };

const app = require('../index.js');
const admin = require('firebase-admin');
const db = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const GOLDEN = require('../catalog/d4p1-order-precontrol.golden.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-money(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2,
  delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: res.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}

// 🔴 CATALOG-AUTHORITATIVE, NOT THE RETIRED CODE PRICE TABLES. An earlier version of this cart read
// the pre-2c in-code price constants and catalog/no-code-authority.guard.test.js refused the file —
// correctly: pricing from them would mean the control was captured against a source the server no
// longer treats as authoritative. The catalog is the source; the names and prices below come out of it.
// (Written as line comments deliberately: the guard strips `//` before scanning but not `/* */`, so a
// block comment explaining the rule trips the very rule it explains.)
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
let seq = 0;
const cartFor = (rid) => {
  const snap = catalogSnapshot(rid);
  const [i0, i1] = snap.items;
  const e0 = snap.extras[0];
  const line = (rec, qty, extras) => (rid === 'la_musa'
    ? { id: rec.display.id, name: rec.display.name, cat: rec.display.cat, qty, price: rec.price, extras }
    : { name: rec.display.name, qty, price: rec.price, extras });
  return [
    line(i0, 2, [rid === 'la_musa'
      ? { id: e0.display.id, name: e0.display.name, price: e0.price, qty: 1 }
      : { instance: 0, name: e0.display.name, price: e0.price }]),
    line(i1, 1, []),
  ];
};

const bodyFor = (rid, orderId, items) => ({
  restaurant_id: rid, order_id: orderId, customer_name: 'Control', customer_phone: `9999${String(3000 + (seq += 1))}`,
  items_text: 'control order', order_type: 'pickup', payment_method: 'cash', items: items || cartFor(rid),
});

const strip = (o, volatile) => {
  const c = JSON.parse(JSON.stringify(o));
  for (const p of volatile) {
    const parts = p.split('.'); let cur = c;
    for (let i = 0; i < parts.length - 1 && cur; i += 1) cur = cur[parts[i]];
    if (cur) delete cur[parts[parts.length - 1]];
  }
  return c;
};

(async () => {
  const { publishVersion } = require('../catalog/catalog-publish');
  for (const rid of ['x_pizza', 'la_musa']) {
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'd4p1-control' });
    await publishVersion(fs, rid, input, { expected: { activeVersionId: null } });
    await db.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
  }

  assert.match(GOLDEN._provenance.captured_from, /^[0-9a-f]{40}$/, 'the control records the commit it came from');
  ok(`the control is a frozen stored order captured through this handler at ${GOLDEN._provenance.captured_from.slice(0, 7)} (pre-P1)`);

  for (const rid of ['x_pizza', 'la_musa']) {
    const g = GOLDEN.brands[rid];
    const id = `P1-${rid}`;
    const res = await post(app.createOrder, bodyFor(rid, id));
    assert.strictEqual(res.status, 200, `${rid}: the order succeeded: ${res.text}`);
    const stored = (await db.ref(`orders/${id}`).once('value')).val();

    assert.deepStrictEqual(strip(stored, g.volatile_fields), strip(g.stored_order, g.volatile_fields),
      `🔴 ${rid}: P1 changed the STORED ORDER against the pre-P1 control — every field, not just the money ones`);
    ok(`${rid}: the whole stored order is byte-identical to pre-P1 (${Object.keys(g.stored_order).length} fields, ${g.volatile_fields.length} measured-volatile normalized)`);

    /* 🔴 SENSITIVITY — the comparison is between things that CAN differ. Without this, a golden that
       had frozen a constant (or a strip() that removed everything) would pass forever. */
    const dearer = cartFor(rid); dearer[0].qty += 1;
    const id2 = `P1-${rid}-DEARER`;
    const res2 = await post(app.createOrder, bodyFor(rid, id2, dearer));
    assert.strictEqual(res2.status, 200, `${rid}: the dearer order succeeded: ${res2.text}`);
    const stored2 = (await db.ref(`orders/${id2}`).once('value')).val();
    assert.notDeepStrictEqual(strip(stored2, g.volatile_fields), strip(g.stored_order, g.volatile_fields),
      `🔴 ${rid}: one more unit changed NOTHING in the stored order — the comparison is vacuous`);
    assert.ok(stored2.total_cents > stored.total_cents,
      `🔴 ${rid}: …and it must cost more (${stored2.total_cents} vs ${stored.total_cents})`);
    ok(`${rid}: non-vacuity — one more unit moves the stored order and raises total_cents ${stored.total_cents} → ${stored2.total_cents}`);

    /* ── 🔴 THE SERVER MUST NOT TRUST THE CLIENT ABOUT MONEY, ON THE REAL HANDLER PATH ──────────────
       THE HOLE, found by an independent gate and reproduced before fixing: `cartFor` builds its lines
       with `price: rec.price` — THE CATALOG'S OWN PRICE — so the client's claim and the server's table
       agree, and a `computeServerTotal` mutated to read `it.price` stored the same total and passed
       every check above. The worst regression this system can have was invisible to the control named
       for money.
       This posts the SAME cart with every client price forged to 1 and requires the stored order to be
       byte-identical. Path exercised: client → createOrder → validateOrderPayload → computeServerTotal.
       🔴 Asserted as INDEPENDENCE rather than by making `cartFor` lie: a control whose sensitivity comes
       from fixture VALUES stops being sensitive the moment someone rebuilds the cart from a real order,
       where the client price legitimately DOES equal the menu's. This cannot rot that way. */
    const forged = cartFor(rid).map((it) => ({ ...it, price: 1,
      extras: (it.extras || []).map((e) => ({ ...e, price: 1 })) }));
    assert.ok(cartFor(rid).some((it) => it.price !== 1), `premise — ${rid}'s control cart carries real catalog prices to forge away from`);
    const id3 = `P1-${rid}-FORGED`;
    const res3 = await post(app.createOrder, bodyFor(rid, id3, forged));
    assert.strictEqual(res3.status, 200, `${rid}: the forged-price order was rejected outright (${res3.status}) — acceptable in itself, but then this control cannot compare stored orders: ${res3.text}`);
    const stored3 = (await db.ref(`orders/${id3}`).once('value')).val();
    assert.strictEqual(stored3.total_cents, stored.total_cents,
      `🔴 ${rid}: THE STORED TOTAL FOLLOWED THE CLIENT'S CLAIMED PRICE (${stored3.total_cents} vs ${stored.total_cents}) — the server is charging what the customer says it costs`);
    assert.deepStrictEqual(strip(stored3, g.volatile_fields), strip(stored, g.volatile_fields),
      `🔴 ${rid}: a forged client price changed the stored order beyond the total — something downstream is reading it`);
    ok(`${rid}: a cart claiming price=1 stores the IDENTICAL order and total_cents ${stored3.total_cents} — the handler prices from the catalog, not from the customer`);
  }

  FINISHED = true;
  console.log(`d4p1-money(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 MONEY (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
