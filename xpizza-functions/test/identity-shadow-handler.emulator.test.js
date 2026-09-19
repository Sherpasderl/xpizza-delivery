'use strict';
// Portal 1D · D3 fast-follow — THE HEARTBEAT, THROUGH THE REAL ORDER HANDLERS.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:identity-shadow-handler
//
// 🔴 WHAT NOTHING ELSE COVERS. D3's guarantees are split across three files and one gap:
//   · catalog/identity-shadow.test.js runs the VERDICT against a fixture;
//   · test/identity-shadow.emulator.test.js proves a real check RESOLVES against a real registry;
//   · identity-shadow-placement.test.js locks WHERE the calls sit inside the two ~500-line handlers —
//     and says so explicitly: "It locks the wiring; it does not execute the handler."
// So every claim that is a property of the HANDLER RUNNING — one heartbeat per issuance and not two,
// a rotation emitting two distinguishable ones, the response not waiting on a registry that never
// answers, silence on a charge that never issued — was argued from source reading alone. This file
// executes them. It is the difference between "the collect sits after the notify await" and "the
// customer's response went out while the registry was hanging".
//
// The handlers are the REAL exported onRequest functions, mounted behind express.json on an ephemeral
// server exactly as test/intake-availability.emulator.test.js drives them, against REAL Firestore and
// RTDB emulators with a REALLY backfilled registry. Only three things are substituted, each because
// the property under test is about timing or failure that production cannot be asked for on demand:
// the WhatsApp send (so the notify's duration is known rather than incidental), the Firestore handle
// (so the registry — and ONLY the registry — can be made to hang), and the PixelPay call (so a
// checkout can be made to fail without a gateway).
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'harness-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const SECRET = process.env.MAKE_SECRET;

/* ── THE SUBSTITUTIONS, SEEDED BEFORE index.js IS REQUIRED ───────────────────────────────────────
   index.js binds these at module load, so the cache has to hold the replacement before that runs. */
function stub(modPath, exports) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

// (1) WhatsApp — real templates, controllable duration. The cash path's whole latency design is that
// the registry read rides UNDER this await, so a notify that returns instantly (the default here,
// with WhatsApp disabled) means every sample is legitimately dropped and `reported` can never be
// observed. Making the duration explicit is what turns that from luck into a fixture.
const WA = { ms: 0, sent: 0 };
const realWhatsapp = require('../whatsapp');
stub('../whatsapp', {
  ...realWhatsapp,
  isEnabledForRestaurant: async () => true,
  sendMessage: async () => { WA.sent += 1; await new Promise((r) => setTimeout(r, WA.ms)); return { ok: true }; },
});

// (2) The Firestore handle — real in every respect except that reads of the IDENTITY subtree can be
// made to hang. Hanging the whole handle would hang PRICING too and the handler would never reach the
// seam under test, so the block is scoped to the registry's own path. Everything not named here falls
// through to the real client untouched.
const FS = { hangIdentity: false };
const realFirestoreMod = require('firebase-admin/firestore');
function wrapFs(real) {
  const wrap = (target, path) => new Proxy(target, {
    get(t, prop) {
      const v = t[prop];
      if (prop === 'collection' || prop === 'doc') return (...a) => wrap(v.apply(t, a), `${path}/${a[0]}`);
      if (prop === 'get' && typeof v === 'function') {
        return (...a) => (FS.hangIdentity && path.includes('/identity/')
          ? new Promise(() => {})                       // never settles — a registry that does not answer
          : v.apply(t, a));
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return wrap(real, '');
}
stub('firebase-admin/firestore', { ...realFirestoreMod, getFirestore: (...a) => wrapFs(realFirestoreMod.getFirestore(...a)) });

// (3) PixelPay's hosted checkout — so a checkout FAILURE is producible without a gateway.
const PP = { fail: false, calls: 0 };
const realHosted = require('../pixelpay-hosted');
stub('../pixelpay-hosted', {
  ...realHosted,
  /* 🔴 THE REAL RETURN SHAPE, `ok` INCLUDED. The caller refuses on `!hosted.ok || !hosted.url` with the
     same 502 a thrown call produces, so a stub that omits `ok` fails every issuance — and the
     checkout-FAILURE cell below would then pass whether or not its injected failure did anything. */
  createHostedCharge: async () => {
    PP.calls += 1;
    if (PP.fail) throw new Error('pixelpay: simulated checkout creation failure');
    const url = `https://pay.example/checkout/${PP.calls}`;
    return { ok: true, httpStatus: 200, url, errors: null, raw: { success: true, url } };
  },
});

const app = require('../index.js');                    // owns initializeApp; reaches the emulators
const admin = require('firebase-admin');
const db = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { backfillIdentities, liveKeys } = require('../catalog/identity-backfill');
const { lookupByLegacyKeys, _resetResolveCache, RESOLVE_TIMEOUT_MS } = require('../catalog/identity-registry');
const { SHADOW_INTERNAL_TIMEOUT_MS } = require('../catalog/identity-shadow-validate');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { keyOf } = require('../catalog/identity-overlay');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-shadow-handler(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

/* The heartbeat is a synchronous structured log and IS the record (the alert is best-effort), so the
   log is what this suite counts — the same surface the deploy is watched on. */
const HB = [];
const realLog = console.log;
console.log = (...a) => {
  if (a[0] === 'order_identity_shadow_checked') { try { HB.push(JSON.parse(a[1])); } catch (_) {} return; }
  realLog(...a);
};
const heartbeats = (orderId) => HB.filter((h) => h.order_id === orderId);

const OPEN_ALL_DAY = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({
  name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN_ALL_DAY, mon: OPEN_ALL_DAY, tue: OPEN_ALL_DAY, wed: OPEN_ALL_DAY, thu: OPEN_ALL_DAY, fri: OPEN_ALL_DAY, sat: OPEN_ALL_DAY },
});

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const wrapped = express();
    wrapped.use(express.json());
    wrapped.use(handler);
    const server = http.createServer(wrapped).listen(0, async () => {
      const t0 = Date.now();
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        const ms = Date.now() - t0;
        server.close(() => resolve({ status: res.status, json, text, ms }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

(async () => {
  const { publishVersion } = require('../catalog/catalog-publish');
  const RID = 'x_pizza';
  const { input } = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'd3-handler' });
  await publishVersion(fs, RID, input, { expected: { activeVersionId: null } });
  await db.ref(`restaurants/${RID}/identity`).set(identityFor(RID));

  const menu = catalogSnapshot(RID);
  await backfillIdentities(fs, RID, menu);
  const keys = liveKeys(RID, menu);
  const ids = await lookupByLegacyKeys(fs, { rid: RID, kind: 'dish', legacyKeys: keys.dish });
  const rec = menu.items[0];
  const dishId = ids.get(keyOf(RID, rec.display));
  assert.ok(dishId, 'premise — the REAL backfill registered the dish this cart carries');

  const cart = (extra = {}) => ([{ name: rec.display.name, qty: 1, price: rec.price, extras: [], dish_id: dishId, ...extra }]);
  /* 🔴 A DISTINCT PHONE PER ORDER. The per-PHONE rate limit is 4 per 10 minutes and this suite places
     more than four orders; the 5th would come back 429 with no heartbeat, which is indistinguishable
     from the heartbeat being missing — a red cell for a reason that has nothing to do with D3. */
  let phoneSeq = 0;
  const cashBody = (orderId, items) => ({
    restaurant_id: RID, order_id: orderId, customer_name: 'Harness', customer_phone: `9999${String(1000 + (phoneSeq += 1))}`,
    items_text: `1x ${rec.display.name}`, order_type: 'pickup', payment_method: 'cash',
    items: items || cart(),
  });
  const cardBody = (orderId) => ({ ...cashBody(orderId), payment_method: 'online' });

  // ── 1. 🔴 ONE HEARTBEAT PER ORDER, AND IT RESOLVED — LIVENESS THROUGH THE HANDLER ───────────
  /* The wrong-handle bug reports a clean "no mismatches" forever while checking nothing, and the only
     thing that separates working from silently-broken is `resolved > 0` on a real read. That has been
     proven of the VALIDATOR; this proves it of the validator AS THE HANDLER CALLS IT — the handle the
     handler actually passes, on the path it actually takes, for an order that really got written. */
  {
    WA.ms = 400;                       // the read rides under the notify, as the design intends
    const r = await post(app.createOrder, cashBody('CASH-1'));
    assert.strictEqual(r.status, 200, `the order succeeded: ${r.text}`);
    assert.ok((await db.ref('orders/CASH-1').once('value')).exists(), 'premise — the order was written');

    const hb = heartbeats('CASH-1');
    assert.strictEqual(hb.length, 1, `🔴 ${hb.length} heartbeats for one order — coverage is counted per issuance`);
    assert.strictEqual(hb[0].outcome, 'reported', `🔴 the sample was ${hb[0].outcome}, so nothing was actually checked`);
    /* EXACT, because the label below claims 1/1 and a cart with one line carrying one id can only be
       1/1 — `> 0` would let an inflated count through while still reading as a pass. */
    assert.strictEqual(hb[0].checked, 1, '🔴 the one id-carrying occurrence in this cart must be checked exactly once');
    assert.strictEqual(hb[0].resolved, 1,
      '🔴 checked without resolved is exactly the wrong-handle shape — the handler passed a handle that reads nothing');
    assert.strictEqual(hb[0].mismatches, 0, 'a correctly-claimed id is not a mismatch');
    ok(`cash: one heartbeat, outcome reported, checked ${hb[0].checked} / resolved ${hb[0].resolved} — live through the real handler`);
  }

  // ── 2. 🔴 AN ID-LESS CART IS NOT A BROKEN VALIDATOR — THE SENSITIVITY PARTNER ────────────────
  /* `absent` is what a menu served before the backfill produces, and it is not an anomaly. Without
     this cell, cell 1's "resolved > 0" has nothing to distinguish it from a constant. */
  {
    WA.ms = 400;
    const r = await post(app.createOrder, cashBody('CASH-2', [{ name: rec.display.name, qty: 1, price: rec.price, extras: [] }]));
    assert.strictEqual(r.status, 200, `the order succeeded: ${r.text}`);
    const hb = heartbeats('CASH-2');
    assert.strictEqual(hb.length, 1, 'still exactly one heartbeat');
    assert.strictEqual(hb[0].checked, 0, 'an id-less cart checks nothing…');
    assert.ok(hb[0].absent > 0, '…and says so as ABSENT rather than as a failure');
    assert.strictEqual(hb[0].mismatches, 0, 'and it is never a mismatch');
    ok(`cash: an id-less cart reports absent ${hb[0].absent}, checked 0 — distinguishable from both clean and broken`);
  }

  // ── 3. 🔴 THE RESPONSE NEVER WAITS ON THE REGISTRY ──────────────────────────────────────────
  /* Contract B, as a latency fact rather than a code-shape argument. The registry is made to never
     answer; the customer's response must still go out on the notify's clock, and the sample must be
     reported DROPPED rather than silently lost — a drop that emitted nothing would understate coverage
     and look identical to an order that carried no ids. */
  /* 🔴 THE CACHE IS RESET SO THE MEASUREMENT IS THE ORDER'S, NOT THE SUITE'S. D4's forward resolver
     caches for a minute, so by this point the cells above have already warmed it and a hung run would
     issue no D4 read at all — the number would look clean for a reason that has nothing to do with
     what is being asserted, and would move if a cell above it changed. Both runs start cold.
     🔴 AND THE BOUND NAMES BOTH DEADLINES. With a cold cache and a dead registry BOTH stages are hit,
     and they are not the same promise: D4's grace resolve is AWAITED before pricing and may legitimately
     spend up to RESOLVE_TIMEOUT_MS, while D3's check must add NOTHING. So the response must land inside
     one D4 deadline of the healthy baseline, and nowhere near D3's — the gap between those two numbers
     is the whole of contract B, and asserting only "under a second" would have covered it up. */
  {
    WA.ms = 150;
    _resetResolveCache();
    const baseline = await post(app.createOrder, cashBody('CASH-3A'));
    assert.strictEqual(baseline.status, 200, 'baseline order succeeded');

    _resetResolveCache();
    FS.hangIdentity = true;
    const hung = await post(app.createOrder, cashBody('CASH-3B'));
    FS.hangIdentity = false;

    assert.strictEqual(hung.status, 200, `🔴 a hanging REGISTRY failed an order: ${hung.text}`);
    assert.ok((await db.ref('orders/CASH-3B').once('value')).exists(), 'and the order was still written');
    const budget = baseline.ms + RESOLVE_TIMEOUT_MS + 400;          // D4's awaited resolve, plus slack
    /* The one bound that can actually fail: it sits BELOW baseline + D4's resolve + D3's own
       ${SHADOW_INTERNAL_TIMEOUT_MS}ms internal timeout, so awaiting D3's check overshoots it by about
       that whole timeout. A second assertion against the larger figure was here and is gone — it was
       ~1.1s looser, so it could never fire before this one, and an assertion that cannot fail is not a
       safeguard. The number it documented lives in this comment instead. */
    assert.ok(hung.ms < budget,
      `🔴 the response waited on D3's check — ${hung.ms}ms hung vs ${baseline.ms}ms healthy (budget ${budget}ms = baseline + D4's ${RESOLVE_TIMEOUT_MS}ms resolve, still ${SHADOW_INTERNAL_TIMEOUT_MS}ms below D3's own timeout); D3 must add nothing`);
    const hb = heartbeats('CASH-3B');
    assert.strictEqual(hb.length, 1, '🔴 a dropped sample must still emit a heartbeat, or coverage loss is invisible');
    assert.strictEqual(hb[0].outcome, 'dropped', `the unsettled sample is reported as dropped (got ${hb[0].outcome})`);
    ok(`cash: a registry that never answers → 200 in ${hung.ms}ms (healthy ${baseline.ms}ms), order written, one DROPPED heartbeat`);
  }

  // ── 4. 🔴 A CHARGE THAT NEVER ISSUED IS SILENT ──────────────────────────────────────────────
  /* `if (flow.respond) return` is the single line that makes a refusal, a reuse AND a checkout failure
     emit nothing — without it being a rule anyone has to remember. Here the checkout itself fails. */
  {
    WA.ms = 0;
    PP.fail = true;
    const before = HB.length;
    const r = await post(app.chargeOnlineOrder, cardBody('CARD-FAIL'));
    PP.fail = false;
    assert.strictEqual(r.status, 502, `a failed checkout is a gateway error, not a success: ${r.text}`);
    assert.strictEqual(HB.length, before,
      `🔴 ${HB.length - before} heartbeat(s) for a charge that never issued — the coverage denominator is issuances`);
    /* SENSITIVITY: without this the cell passes for any reason the request fails, including a
       malformed stub — which is exactly what it did before the shape above was corrected. The very
       next cell issues the SAME request successfully and gets its heartbeat, so the silence here is
       attributable to the injected failure and nothing else. */
    ok(`card: a checkout-creation failure issues nothing and emits NO heartbeat (status ${r.status})`);
  }

  // ── 5. 🔴 ONE HEARTBEAT PER ISSUANCE — A ROTATION EMITS TWO, TOLD APART BY attempt_id ───────
  /* The reason the card report is keyed by attempt as well as order: an expired checkout ROTATES into
     a fresh attempt for the SAME order, each issuance is its own check, and without the attempt id two
     legitimate heartbeats would be indistinguishable from one order double-reporting. */
  {
    WA.ms = 0;
    const first = await post(app.chargeOnlineOrder, cardBody('CARD-ROT'));
    assert.strictEqual(first.status, 200, `first issuance succeeded: ${first.text}`);
    const attempt1 = first.json.attempt_id;

    /* Expire the attempt so the next request cannot reuse it and must rotate — the real resume-safe
       path, not a second unrelated order. */
    /* 🔴 hosted_expires_at, which is the field acquireHostedAttempt reads — expiring anything else
       leaves the checkout LIVE, the call takes the `reuse` path, and `flow.respond` returns before the
       report. The cell would then be asserting two heartbeats against a request that deliberately
       issues nothing, and the honest failure would look like a missing heartbeat. */
    await db.ref(`payment_attempts/${attempt1}`).update({ hosted_expires_at: Date.now() - 60000 });
    const second = await post(app.chargeOnlineOrder, cardBody('CARD-ROT'));
    assert.strictEqual(second.status, 200, `the rotation issued: ${second.text}`);
    const attempt2 = second.json.attempt_id;
    assert.notStrictEqual(attempt2, attempt1, 'premise — it really rotated into a FRESH attempt');

    const hb = heartbeats('CARD-ROT');
    assert.strictEqual(hb.length, 2, `🔴 ${hb.length} heartbeats for two issuances of one order`);
    assert.deepStrictEqual([...new Set(hb.map((h) => h.attempt_id))].sort(), [attempt1, attempt2].sort(),
      '🔴 the two heartbeats are not distinguishable by attempt_id — a rotation reads as a double-report');
    ok(`card: a rotation emits exactly 2 heartbeats, one per issuance, told apart by attempt_id`);
  }

  FINISHED = true;
  realLog(`identity-shadow-handler(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { realLog('IDENTITY SHADOW HANDLER (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
