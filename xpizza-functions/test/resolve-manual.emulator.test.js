'use strict';

/**
 * Stage 6 — the F-matrix. The LOAD-BEARING concurrency proof for the atomic-claim money state machine
 * (RECON_ATOMIC_CLAIM_PLAN.md rev-5). Drives the REAL resolveManualReconciliationCore + recoverStaleResolve
 * (resolve-manual.js) + handleHostedCallback (pixelpay-hosted-webhook.js) + confirmOnlinePayment against the
 * RTDB emulator, so two concurrent invocations produce genuine transaction contention — which a pure golden
 * cannot. Asserts the money invariants: exactly one terminal state + one claim_id-keyed audit per claim,
 * paid evidence honored in every state, no fake refunded, phase-aware recovery, no rollback after money.
 *
 * RUN (auditor's Java/emulator lane):
 *   JAVA_HOME=/opt/homebrew/opt/openjdk firebase emulators:exec --only database \
 *     --project demo-xpizza "node test/resolve-manual.emulator.test.js"
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { resolveManualReconciliationCore, recoverStaleResolve } = require('../resolve-manual');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { confirmOnlinePayment } = require('../pixelpay-confirm');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('MUST run under firebase emulators:exec --only database (no FIREBASE_DATABASE_EMULATOR_HOST)');
  process.exit(1);
}
const NS = 'demo-xpizza';
const URL = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}`;
admin.initializeApp({ databaseURL: URL });
const db = admin.database();

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';   // sandbox (webhook resolvePixelPayConfig default)
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
const NOW = 1700000000000;

// Hours for the materialize-time closed-kitchen re-check (getIdentity). Default OPEN so existing
// materialize behavior is unchanged; the paid-after-close case passes ALL_CLOSED.
const mk = (o) => ({ sun: o, mon: o, tue: o, wed: o, thu: o, fri: o, sat: o });
const ALL_OPEN = mk({ open: true, start: '00:00', end: '24:00' });
const ALL_CLOSED = mk({ open: false });

// ── deps factories ──
const clientVoid = (result) => ({ voidTransaction: async () => result });            // {ok:true}=anulada, {ok:false}=else
const clientThrow = () => ({ voidTransaction: async () => { throw new Error('412 PreconditionalResponse'); } });
/* `over` lets a cell replace one dep without hand-building the whole object. It is spread LAST so an
   override actually wins — a silently ignored override is how a cell ends up testing the default and
   reporting a pass; the premise assertion in the two-lookups cell caught exactly that. */
function mkDeps(client, overDb, hours, over = {}) {
  const alerts = [];
  const deps = {
    db: overDb || db, client, buildMaterializeUpdates, restaurant: RESTAURANT,
    genToken: () => 'TOK', alert: async (k, d) => { alerts.push([k, d]); },
    getIdentity: async () => ({ active: true, hours: hours || ALL_OPEN }),   // materialize-time hours re-check
    sanitizeText: (s) => String(s || '').slice(0, 200), serverTimestamp: 111,
    ...over,
  };
  return { deps, alerts };
}
const webhookDeps = (voidImpl) => ({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: voidImpl || (async () => ({ voided: true })) });

// ── seed/read helpers ──
const OID = 'PZXTEST';
const AID = 'a1b2c3d4e5f6a7b8';                                                       // 16-hex
const clearAll = () => db.ref('/').set(null);
async function seed(orderOver = {}, attemptOver = {}, { withAttempt = true } = {}) {
  await db.ref(`orders/${OID}`).set({
    order_id: OID, order_type: 'pickup', payment_method: 'online', payment_status: 'manual_reconciliation',
    status: 'pending_payment', total: 299, total_cents: 29900, customer_name: 'T', items_text: 'x',
    active_attempt_id: AID, created_at: 1000, ...orderOver,
  });
  if (withAttempt) await db.ref(`payment_attempts/${AID}`).set({ order_id: OID, hosted_order_id: `${OID}-${AID}`, hosted_state: 'manual_reconciliation', ...attemptOver });
}
const oVal = async () => (await db.ref(`orders/${OID}`).once('value')).val();
const aVal = async () => (await db.ref(`payment_attempts/${AID}`).once('value')).val();
const audits = async () => Object.values((await db.ref('payment_audit').once('value')).val() || {}).filter(a => a.order_id === OID);
const paidCb = (over = {}) => ({ order: `${OID}-${AID}`, status: 'paid', amount: 299, uuid: 'P-paid-1', transaction_id: 'TXN', payment_hash: paymentHash(`${OID}-${AID}`, KEY, SECRET), ...over });

let n = 0; const ok = (l) => { console.log(`  ✓ ${++n} ${l}`); };

(async () => {
  // ── #1 two concurrent resolvers on ONE order → exactly one 200 / one 409 / one terminal / one audit ──
  {
    await clearAll(); await seed();
    const [rA, rB] = await Promise.all([
      resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, action: 'abandon', actor: 'A', note: 'x', now: NOW, claimId: 'CID-A' }),
      resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, action: 'abandon', actor: 'B', note: 'y', now: NOW, claimId: 'CID-B' }),
    ]);
    const codes = [rA.status, rB.status].sort();
    assert.deepStrictEqual(codes, [200, 409], `expected one 200 one 409, got ${codes}`);
    assert.strictEqual((await oVal()).payment_status, 'abandoned');                   // exactly one terminal
    const term = (await audits()).filter(a => a.outcome === 'abandoned');
    assert.strictEqual(term.length, 1, `exactly one terminal audit, got ${term.length}`); // one claim_id-keyed audit
    ok('#1 two-resolver race → one 200 / one 409 / single terminal / single audit');
  }

  // ── #6a null-first UNCACHED claim (a679797 landmine) — a FRESH app whose tx callback sees [null → server] ──
  {
    await clearAll(); await seed();
    const app2 = admin.initializeApp({ databaseURL: URL }, 'fresh');                  // uncached: tx runs cur=null first
    const db2 = app2.database();
    const r = await resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true }), db2).deps, { orderId: OID, action: 'abandon', actor: 'A', note: 'x', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 200, `null-first claim must succeed cold, got ${r.status}`);
    assert.strictEqual((await oVal()).payment_status, 'abandoned');                   // claimed+terminal despite cold null-first
    await app2.delete();
    ok('#6a null-first uncached claim → claims correctly (returns null on cur===null, not abort)');
  }

  // ── #6b deleted/missing order → null no-op commits but claims nothing → 404 (not a phantom claim) ──
  {
    await clearAll();
    const r = await resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: 'GHOST', action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 404, `deleted-order null no-op must be 404, got ${r.status}`);
    ok('#6b deleted-order null no-op → 404 (claimLanded false, not "claimed")');
  }

  // ── #2 resolver-vs-confirm: once claimed (resolving_*), confirmOnlinePayment SKIPS (no double materialize) ──
  {
    await clearAll(); await seed({}, { payment_uuid: 'S-1', status: 'active' });
    // claim it (materialize path leaves resolving_materialize mid-flight only transiently; use abandon to hold resolving_abandon)
    await db.ref(`orders/${OID}`).set({ ...(await oVal()), payment_status: 'resolving_refund', resolving_claim_id: 'CID', resolving_action: 'refund', resolving_phase: 'claimed', resolving_claimed_at: NOW });
    const cDeps = { db, restaurant: RESTAURANT, buildMaterializeUpdates, getIdentity: async () => ({ active: true, hub_lat: 15.5, hub_lng: -88.0, name: 'X', phone: 'p', version: 1, delivery_radius_km: 7 }), alert: () => {} };
    const r = await confirmOnlinePayment(cDeps, { orderId: OID, paymentUuid: 'S-1', now: NOW, trackingToken: 'T' });
    assert.strictEqual(r.outcome, 'resolving_in_progress');
    assert.strictEqual((await oVal()).payment_status, 'resolving_refund');            // confirm did NOT transition it
    ok('#2 resolver-vs-confirm → confirmOnlinePayment skips (resolving_in_progress), no double-materialize');
  }

  // ── #8 duplicate/uncertain PixelPay void shapes → refunded ONLY on genuine anulada, else refund_pending ──
  {
    for (const [client, want] of [[clientVoid({ ok: true }), 'refunded'], [clientVoid({ ok: false }), 'refund_pending'], [clientThrow(), 'refund_pending']]) {
      await clearAll(); await seed({}, { payment_uuid: 'S-1' });
      const r = await resolveManualReconciliationCore(mkDeps(client).deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' });
      assert.strictEqual((await oVal()).payment_status, want, `void→${want}`);
      assert.strictEqual(r.status, want === 'refunded' ? 200 : 409, 'honest status (#9)');
    }
    ok('#8 void anulada→refunded(200); 412/false/throw→refund_pending(409) — never a fake refunded');
  }

  // ── #12 refund with NO persisted uuid → manual_review/409, NEVER a false refunded ──
  {
    await clearAll(); await seed({}, {}, { withAttempt: true }); // attempt exists but no payment_uuid
    const r = await resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.outcome, 'manual_review');
    assert.strictEqual((await oVal()).payment_status, 'manual_review');               // NOT refunded
    ok('#12 refund no-uuid → manual_review/409 (never fake refunded)');
  }

  // ── #7 phase-aware recovery: pre-side-effect stale → revert; post-side-effect stale → manual_review+alert ──
  {
    await clearAll(); await seed({ payment_status: 'resolving_refund', resolving_claim_id: 'OLD', resolving_action: 'refund', resolving_phase: 'claimed', resolving_claimed_at: NOW - 11 * 60 * 1000 });
    const { deps, alerts } = mkDeps(clientVoid({ ok: true }));
    await recoverStaleResolve(deps, OID, await oVal(), NOW, 10 * 60 * 1000);
    assert.strictEqual((await oVal()).payment_status, 'manual_reconciliation');       // pre-side-effect → safe revert
    assert.strictEqual(alerts.length, 0);
    ok('#7a pre-side-effect stale → revert to manual_reconciliation, no alert');

    await clearAll(); await seed({ payment_status: 'resolving_refund', resolving_claim_id: 'OLD', resolving_action: 'refund', resolving_phase: 'side_effect_started', resolving_claimed_at: NOW - 11 * 60 * 1000 });
    const d2 = mkDeps(clientVoid({ ok: true }));
    await recoverStaleResolve(d2.deps, OID, await oVal(), NOW, 10 * 60 * 1000);
    assert.strictEqual((await oVal()).payment_status, 'manual_review');               // post-side-effect → NEVER re-resolvable
    assert.strictEqual(d2.alerts.length, 1);
    ok('#7b post-side-effect stale → manual_review + alert (never back to manual_reconciliation)');

    // in-flight (not stale) → untouched
    await clearAll(); await seed({ payment_status: 'resolving_refund', resolving_claim_id: 'LIVE', resolving_action: 'refund', resolving_phase: 'claimed', resolving_claimed_at: NOW - 1000 });
    await recoverStaleResolve(mkDeps(clientVoid({ ok: true })).deps, OID, await oVal(), NOW, 10 * 60 * 1000);
    assert.strictEqual((await oVal()).payment_status, 'resolving_refund');            // live resolve untouched
    ok('#7c in-flight (age < threshold) → recovery leaves it alone');
  }

  // ── #13 atomic evidence: paid callback while manual_reconciliation → single update sets uuid AND paid_during_resolve ──
  {
    await clearAll(); await seed({ payment_status: 'manual_reconciliation' });
    const r = await handleHostedCallback(webhookDeps(), paidCb(), NOW);
    assert.strictEqual(r.outcome, 'paid_evidence_recorded');
    assert.strictEqual((await oVal()).paid_during_resolve, true);                     // both landed atomically
    assert.strictEqual((await aVal()).payment_uuid, 'P-paid-1');
    assert.strictEqual((await oVal()).payment_status, 'manual_reconciliation');       // status unchanged (queued)
    ok('#13/#14 paid-in-manual_reconciliation → atomic evidence (uuid + paid_during_resolve), status unchanged');
  }

  // ── #10 abandon-CAS gap: resolver(abandon) || paid webhook → NEVER (abandoned AND paid) ──
  {
    for (let i = 0; i < 5; i++) {                                                     // exercise interleavings
      await clearAll(); await seed({ payment_status: 'manual_reconciliation' });
      await Promise.all([
        resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, action: 'abandon', actor: 'A', note: 'x', now: NOW, claimId: 'CID' }),
        handleHostedCallback(webhookDeps(), paidCb(), NOW),
      ]);
      const o = await oVal();
      assert.ok(!(o.payment_status === 'abandoned' && o.paid_during_resolve === true),
        `SAFETY VIOLATION: paid order abandoned (iter ${i}) → ${JSON.stringify({ ps: o.payment_status, paid: o.paid_during_resolve })}`);
    }
    ok('#10 abandon-vs-paid-callback race → never (abandoned AND paid) across interleavings');
  }

  // ── #4 refund-vs-paid race: paid order always ends in a money-safe state (never a silently-lost charge) ──
  {
    await clearAll(); await seed({ payment_status: 'manual_reconciliation' });
    await Promise.all([
      resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' }),
      handleHostedCallback(webhookDeps(), paidCb(), NOW),
    ]);
    const ps = (await oVal()).payment_status;
    assert.ok(['refunded', 'refund_pending', 'manual_review'].includes(ps), `refund-vs-paid must be money-safe, got ${ps}`);
    ok('#4 refund-vs-paid race → money-safe terminal (refunded / refund_pending / manual_review)');
  }

  // ── #5 audit-fails-after-terminal → terminal money state PERSISTS (no rollback), returns 500 ──
  {
    await clearAll(); await seed({}, { payment_uuid: 'S-1' });
    const failAuditDb = new Proxy(db, { get(t, prop) {
      if (prop === 'ref') return (p) => (p === 'payment_audit' ? { push: async () => { throw new Error('audit down'); } } : db.ref(p));
      const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    const r = await resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true }), failAuditDb).deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    assert.strictEqual(r.status, 500);
    assert.strictEqual((await oVal()).payment_status, 'refunded');                    // money moved → terminal persists, NO rollback
    ok('#5 audit-fail after refunded → 500 but order stays refunded (no rollback after money)');
  }

  // ── Scheduled Orders (Codex-on-diff #2): manual 'materialize' of a SCHEDULED order HOLDS it, never
  //    materializes — the third pending→new path is scheduled-safe. Goes live only at release, via the claim.
  {
    await clearAll();
    await seed({ scheduled_for: 1800000000000, release_at: 1799998200000, order_type: 'delivery', lat: 15.6, lng: -88.1, address_detected: 'Calle 1', address_details: 'azul' }, { payment_uuid: 'S-1', status: 'captured', capture_verified: true });
    const r = await resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true })).deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    const o = await oVal();
    assert.strictEqual(o.status, 'scheduled', 'held, not new');
    assert.ok(!o.materialized_at, 'NOT materialized');
    assert.strictEqual((await db.ref(`tasks/${OID}_delivery`).once('value')).val(), null, 'no tasks (held)');
    assert.strictEqual((await db.ref('order_tracking').once('value')).val(), null, 'no tracking (held)');
    // Codex-on-diff #4: scheduled_held is a SUCCESS outcome — HTTP 200 + honest audit, not a 409/materialize_failed.
    assert.strictEqual(r.status, 200, 'HTTP 200 (not 409)');
    assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.outcome, 'scheduled_held');
    assert.ok((await audits()).some((a) => a.outcome === 'scheduled_held'), 'audit reflects held-success');
    assert.ok(!(await audits()).some((a) => a.outcome === 'materialize_failed'), 'NOT audited as failure');
    ok('scheduled order manual-materialize → HELD + HTTP 200 outcome:scheduled_held + honest audit (not a false failure)');
  }

  /* ── 🔴 PAID AFTER CLOSE, VIA THE DISPATCHER: PARK HONESTLY, MOVE NO MONEY ────────────────────
     This cell used to assert a hold contract that no longer exists (manual_review + scheduled_blocked
     + a paid_after_close alert), and it could not have passed anyway: resolveDeps supplies none of
     the deps the guard's refund path needs, so deps.voidOrRefund was undefined, the unguarded call
     threw, and the catch reported it as a PixelPay failure. The order came to rest blocked with
     refund_failed_paid_after_close and an alert claiming the refund had failed — with the provider
     never contacted.
     The fix here is deliberately NOT to make this path refund. It is to fail honestly: park for a
     human, name what they must do, and touch no money. Automating this reversal turned out to need a
     sound reversal machine, which is its own piece of work; the owner has accepted a human operator
     doing it, so this is a documented state rather than a stopgap. */
  {
    await clearAll();
    /* Seeded WITHOUT capture_verified/manual_verified on purpose: the resolver stamps both when it
       runs its confirm step, so their absence afterwards is the observable proof that nothing moved
       before the decision. With the seed pre-stamped, a decision made too late looks identical to one
       made in time. */
    await seed({ order_type: 'delivery', customer_phone: '50488887777', lat: 15.6, lng: -88.1, address_detected: 'Calle 1', address_details: 'azul' },
      { payment_uuid: 'S-1', status: 'captured' });
    let providerCalls = 0;
    const { deps, alerts } = mkDeps({ voidTransaction: async () => { providerCalls += 1; return { ok: true }; } }, undefined, ALL_CLOSED);
    const r = await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    const o = await oVal();

    // 🔴 no money moved, and nothing was even attempted at the provider
    assert.strictEqual(providerCalls, 0, '🔴 a provider call was made on a path that cannot complete a refund');
    assert.notStrictEqual(o.payment_status, 'refunded', '🔴 reported a refund this path cannot perform');
    assert.strictEqual((await aVal()).status, 'captured', 'the attempt is untouched — no reversal was begun');
    assert.ok(!(await aVal()).manual_verified,
      '🔴 the resolver stamped the attempt before anyone asked whether this path can refund — the decision came after the state changes it was supposed to prevent');
    // …and the order was NOT materialized onto a dark kitchen
    assert.notStrictEqual(o.status, 'new', 'NOT materialized');
    assert.strictEqual((await db.ref('order_tracking').once('value')).val(), null, 'no tracking');
    // 🔴 parked with a reason that says what is true, not one that blames the provider
    assert.strictEqual(o.payment_status, 'manual_reconciliation', 'parked for a human');
    assert.strictEqual(o.blocked_reason, 'manual_refund_required_paid_after_close',
      '🔴 the block reason does not name the real situation — refund_failed_paid_after_close blames PixelPay for a wiring gap');
    const alert = alerts.find(([k]) => k === 'paid_after_close_manual_refund_required');
    assert.ok(alert, '🔴 no alert telling a dispatcher this order needs them');
    assert.match(alert[1].action, /Reembolsar/, 'and the alert names the action they must take');
    assert.ok(!alerts.some(([k]) => k === 'refund_failed_paid_after_close'), 'and it does NOT claim a refund failed');
    ok('paid-after-close via the dispatcher → parked with an honest reason + actionable alert, zero provider calls, no money moved');
  }

  /* ── 🔴 THE HUMAN PATH IS INTACT — THE WHOLE BASIS OF ACCEPTING THIS ──────────────────────────
     Parking is only acceptable because a dispatcher can then finish the job with the Reembolsar
     action, which already works. If the park left the order unclaimable, this change would trade a
     silent crash for a stuck order, which is worse. So the cell drives the real refund action on the
     parked order and asserts the customer actually gets their money back. */
  {
    let providerCalls = 0;
    const { deps } = mkDeps({ voidTransaction: async () => { providerCalls += 1; return { ok: true }; } });
    const r = await resolveManualReconciliationCore(deps, { orderId: OID, action: 'refund', actor: 'A', note: '', now: NOW + 1000, claimId: 'CID-R' });
    const o = await oVal();
    assert.strictEqual(r.status, 200, '🔴 the parked order could not be refunded by a human — the park would be a dead end');
    assert.strictEqual(providerCalls, 1, 'exactly one provider reversal, issued by the human action');
    assert.strictEqual(o.payment_status, 'refunded', 'the customer gets their money back');
    assert.strictEqual(o.status, 'cancelled');
    ok('a parked order is still refundable by the dispatcher: Reembolsar → one provider call → refunded');
  }

  /* ── 🔴 THE PARK DECIDES BEFORE ANYTHING MOVES, AND NEVER LANDS ON AN IN-FLIGHT REFUND ────────
     P-1: the park used to happen inside the guard, by which point the resolver had already claimed
     the order, stamped the attempt captured and committed `confirmed`. That `confirmed` enables the
     automatic, fully-wired refund path — so a park applied afterwards could overwrite an order whose
     reversal was already in flight, hand it back to a dispatcher, and their Reembolsar would issue a
     SECOND provider call outside the attempt CAS. Here the order is mid-reversal when a dispatcher
     presses materialize: nothing may touch it. */
  {
    await clearAll();
    await seed({ payment_status: 'refunding_paid_after_close', refunding_at: NOW }, { payment_uuid: 'S-1', status: 'reversing', reversing_phase: 'side_effect_started', reversing_at: NOW });
    let providerCalls = 0;
    const { deps } = mkDeps({ voidTransaction: async () => { providerCalls += 1; return { ok: true }; } }, undefined, ALL_CLOSED);
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW + 1, claimId: 'CP1' });
    const o = await oVal();
    assert.strictEqual(o.payment_status, 'refunding_paid_after_close',
      '🔴 the park OVERWROTE an in-flight refund — the order is re-offered and a second provider call becomes possible');
    /* 🔴 THE LABEL MATTERS EVEN WHEN payment_status SURVIVES. The park writes blocked_reason, and
       stamping "a human must refund this" onto an order whose reversal is ALREADY RUNNING tells a
       dispatcher to do the one thing that would double-charge the customer. The claim rule happens to
       refuse such an order today, so the second provider call is blocked one layer further in — but
       the instruction would still be wrong, and correctness here should not rest on a different
       function's precondition. */
    assert.notStrictEqual(o.blocked_reason, 'manual_refund_required_paid_after_close',
      '🔴 an in-flight refund was LABELLED as needing a manual one — the dispatcher is told to refund an order that is already reversing');
    assert.strictEqual((await aVal()).status, 'reversing', 'the reversal is left alone');
    assert.strictEqual(providerCalls, 0, 'and nothing was sent to the provider');
    ok('a materialize on an order whose refund is IN FLIGHT parks nothing and issues zero provider calls');
  }

  /* ── 🔴 NOTHING MOVES BEFORE THE DECISION ────────────────────────────────────────────────────
     P-1 again, from the other side: the old placement left the order `confirmed` with a captured
     attempt and no materialization if the park write failed. Deciding before the claim means an
     unrefundable materialize never transitions the order at all — so even a failed park leaves it
     exactly where a human can still act on it. */
  {
    await clearAll();
    await seed({}, { payment_uuid: 'S-1', status: 'captured', capture_verified: true });
    const before = await oVal();
    const blindDb = new Proxy(db, {
      get(t, prop) {
        if (prop === 'ref') return (path) => (String(path) === `orders/${OID}`
          ? Object.assign(Object.create(Object.getPrototypeOf(t.ref(path))), t.ref(path), { transaction: async () => { throw new Error('park write failed'); } })
          : t.ref(path));
        const v = t[prop];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const { deps } = mkDeps(clientVoid({ ok: true }), blindDb, ALL_CLOSED);
    try { await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CP2' }); } catch (_) { /* the write failed; the point is what it left behind */ }
    const after = await oVal();
    assert.strictEqual(after.payment_status, before.payment_status,
      '🔴 a failed park left the order somewhere else — it must not have moved through confirmed');
    assert.notStrictEqual(after.payment_status, 'confirmed', 'never left confirmed with captured money and no food');
    assert.strictEqual((await aVal()).status, 'captured', 'and the attempt was not re-stamped');
    ok('a park write that FAILS leaves the order untouched and still actionable — no transitions happened first');
  }

  /* ── 🔴 THE TWO HOURS LOOKUPS CAN DISAGREE, AND THE ORDER MUST NOT BE STRANDED ───────────────
     There are two: the early one before the claim, and the guard's own, after the attempt is stamped
     captured and the order committed `confirmed`. If the early lookup THROWS (or the kitchen's hours
     change between them), only the guard sees "closed". I had called that branch unreachable and
     deleted its mutant; it is reachable, and it left HTTP 200, no park, no alert, a captured attempt
     and an unmaterialized CONFIRMED order — eligible for automatic recovery. */
  {
    await clearAll();
    await seed({}, { payment_uuid: 'S-1', status: 'captured', capture_verified: true });
    let lookups = 0;
    const { deps, alerts } = mkDeps(clientVoid({ ok: true }), undefined, ALL_CLOSED, {
      getIdentity: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error('config read failed');   // early lookup fails
        return { active: true, hours: ALL_CLOSED };                 // the guard's lookup sees closed
      },
    });
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CH1' });
    const o = await oVal();
    assert.ok(lookups >= 2, 'premise — both lookups really ran');
    assert.notStrictEqual(o.payment_status, 'confirmed',
      '🔴 the order was left CONFIRMED with captured money and no food — unmaterialized, unparked, and eligible for automatic recovery');
    assert.strictEqual(o.payment_status, 'manual_reconciliation', 'it is parked where a human can act on it');
    assert.strictEqual(o.blocked_reason, 'manual_refund_required_paid_after_close');
    assert.ok(alerts.some(([k]) => k === 'paid_after_close_manual_refund_required'), '🔴 nobody was told');
    assert.ok(!o.materialized_at, 'and it was not materialized onto a dark kitchen');
    ok('early hours lookup FAILS → the guard still parks the confirmed order and alerts, never strands it');
  }
  {
    /* 🔴 THE SECOND TRIGGER, DRIVEN RATHER THAN ASSUMED. The label above used to claim both cases
       while the cell exercised only the throw. Hours CHANGING between the two lookups reaches the
       same branch by a different route: the early lookup sees an open kitchen and permits the
       materialize, the guard's lookup sees it closed, and the order is already confirmed by then. */
    await clearAll();
    await seed({}, { payment_uuid: 'S-1', status: 'captured' });
    let lookups = 0;
    const { deps, alerts } = mkDeps(clientVoid({ ok: true }), undefined, undefined, {
      getIdentity: async () => {
        lookups += 1;
        return { active: true, hours: lookups === 1 ? ALL_OPEN : ALL_CLOSED };   // open, then closed
      },
    });
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CH2' });
    const o = await oVal();
    assert.ok(lookups >= 2, 'premise — both lookups really ran');
    assert.notStrictEqual(o.payment_status, 'confirmed',
      '🔴 hours closing between the two lookups left the order CONFIRMED with captured money and no food');
    assert.strictEqual(o.payment_status, 'manual_reconciliation', 'it is parked where a human can act on it');
    assert.strictEqual(o.blocked_reason, 'manual_refund_required_paid_after_close');
    assert.ok(alerts.some(([k]) => k === 'paid_after_close_manual_refund_required'), '🔴 nobody was told');
    assert.ok(!o.materialized_at, 'and it was not materialized onto a dark kitchen');
    ok('hours CHANGE between the two lookups → same park, same alert, never stranded');
  }

  /* ── 🔴 BOTH CALLERS RESOLVE THE SAME GRACE WINDOW FROM THE SAME CONFIG ───────────────────────
     materialize-guard falls back to a hardcoded 15 when the reader dep is absent. confirmDeps
     supplied the configured reader and resolveDeps did not, so at 20 minutes past close with a
     configured grace of 30 the dispatcher path required a refund while the automatic path permitted
     materialization — one "shared" decision reading two different inputs. Inert today because
     config/order_grace_minutes is unset in production and both resolve to 15, which is exactly why
     it could sit there unnoticed. */
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const bodyOf = (name) => {
      const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
      assert.notStrictEqual(at, -1, `premise — ${name} is in index.js`);
      let i = src.indexOf('{', at), depth = 0, end = i;
      for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}') { depth--; if (!depth) break; } }
      return src.slice(i, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    };
    for (const f of ['confirmDeps', 'resolveDeps']) {
      assert.match(bodyOf(f), /(^|[{,\s])getGraceMinutes\s*,/,
        `🔴 ${f} does not pass the shared getGraceMinutes — the two callers can resolve different windows from the same config`);
    }
    const grace = bodyOf('getGraceMinutes');
    assert.match(grace, /config\/order_grace_minutes/, 'it reads the configured key');
    assert.match(grace, /catch\s*\(_\)\s*\{\s*return 15;/,
      'and a config READ FAILURE falls back to the same 15 on both paths, because it is one function');
    ok('confirmDeps and resolveDeps pass the SAME grace reader; a config read failure resolves identically for both');
  }

  /* ── 🔴 ONE ALERT PER PARK, AND A REPEAT IS A TRUE NO-OP (P-3) ────────────────────────────────
     The previous idempotence cell compared selected final fields, so it passed while every repeat
     re-alerted and re-ran claim/capture/confirm — charged_at moved between two identical requests.
     A dispatcher pressing the button twice must not be paged twice, and must not move the order. */
  {
    await clearAll();
    await seed({}, { payment_uuid: 'S-1', status: 'captured', capture_verified: true });
    const { deps, alerts } = mkDeps(clientVoid({ ok: true }), undefined, ALL_CLOSED);
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CR1' });
    const first = await oVal();
    const firstAttempt = await aVal();
    await resolveManualReconciliationCore(deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW + 5000, claimId: 'CR2' });
    const second = await oVal();
    const parkAlerts = alerts.filter(([k]) => k === 'paid_after_close_manual_refund_required');
    assert.strictEqual(parkAlerts.length, 1, '🔴 a repeat re-alerted — a dispatcher is paged twice for one order');
    assert.strictEqual(second.blocked_reason, first.blocked_reason, 'the park is unchanged');
    assert.strictEqual(second.charged_at, first.charged_at, '🔴 a repeat re-ran the confirm path — charged_at moved on a no-op request');
    /* 🔴 THE WHOLE ORDER, NOT A LIST OF FIELDS I THOUGHT OF. Checking blocked_reason and charged_at
       is how the earlier drift hid: everything named was stable and everything unnamed was free to
       move. Comparing the entire record means a field nobody anticipated cannot change quietly. */
    assert.deepStrictEqual(second, first,
      '🔴 a repeat changed the order somewhere other than the fields this cell happened to name');
    assert.deepStrictEqual(await aVal(), firstAttempt, '🔴 a repeat re-stamped the attempt');
    /* 🔴 ONE THING A REPEAT DOES WRITE, ON PURPOSE: an audit row per press. The contract is "moves no
       money and does not disturb the order", not "writes nothing" — a second press is the only
       record that a human is stuck or has misread the queue, and this commit exists because a
       failure was invisible. Asserted explicitly so the choice is visible rather than inferred from
       a passing silence. */
    const parkAudits = (await audits()).filter((a) => a.outcome === 'manual_refund_required');
    assert.strictEqual(parkAudits.length, 2, 'each press is audited — the repeat is recorded, not swallowed');
    assert.strictEqual(parkAudits.filter((a) => a.repeat === true).length, 1, 'and the second is marked as a repeat');
    ok('repeat materialize → ONE alert, unchanged charged_at, attempt byte-identical, and one audit row per press (deliberate)');
  }

  // Same, but kitchen OPEN → materializes to new (normal flow unchanged).
  {
    await clearAll();
    await seed({ order_type: 'delivery', customer_phone: '50488887777', lat: 15.6, lng: -88.1, address_detected: 'Calle 1', address_details: 'azul' }, { payment_uuid: 'S-1', status: 'captured', capture_verified: true });
    const r = await resolveManualReconciliationCore(mkDeps(clientVoid({ ok: true }), undefined, ALL_OPEN).deps, { orderId: OID, action: 'materialize', actor: 'A', note: '', now: NOW, claimId: 'CID' });
    assert.strictEqual((await oVal()).status, 'new', 'materialized');
    assert.strictEqual(r.body.outcome, 'materialized');
    ok('unscheduled manual-materialize while OPEN → materializes to new (unchanged)');
  }

  console.log(`\nresolve-manual.emulator: OK (${n} scenarios)`);
  process.exit(0);
})().catch((e) => { console.error('resolve-manual.emulator: FAIL\n', e && e.stack || e); process.exit(1); });
