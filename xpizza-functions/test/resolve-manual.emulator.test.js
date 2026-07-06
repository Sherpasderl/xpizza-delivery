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

// ── deps factories ──
const clientVoid = (result) => ({ voidTransaction: async () => result });            // {ok:true}=anulada, {ok:false}=else
const clientThrow = () => ({ voidTransaction: async () => { throw new Error('412 PreconditionalResponse'); } });
function mkDeps(client, overDb) {
  const alerts = [];
  const deps = {
    db: overDb || db, client, buildMaterializeUpdates, restaurant: RESTAURANT,
    genToken: () => 'TOK', alert: async (k, d) => { alerts.push([k, d]); },
    sanitizeText: (s) => String(s || '').slice(0, 200), serverTimestamp: 111,
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

  console.log(`\nresolve-manual.emulator: OK (${n} scenarios)`);
  process.exit(0);
})().catch((e) => { console.error('resolve-manual.emulator: FAIL\n', e && e.stack || e); process.exit(1); });
