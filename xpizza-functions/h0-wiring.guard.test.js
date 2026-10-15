'use strict';
// PLAN-H0 (detect + alert + never auto-close over unaccounted card money / uncertain reversals) — wiring guard.
// Run: node h0-wiring.guard.test.js
//   1. PROOF: tools/h0-inverse.js turns index.js back into 8f1e017 BYTE-FOR-BYTE (4 delimited, byte-pinned blocks) and each
//      pinned module (pixelpay-hosted-webhook.js, cancel-order-core.js, resolve-manual.js) back into its base. An edit inside
//      a block / hunk, a missing or extra block, a duplicated hunk and a byte outside are each detected.
//   2. PLACEMENT: the cancel guard sits AFTER the claim and BEFORE B.6 (which flags the attempt); the reconciler's no-uuid
//      guard precedes its voidOrRefund call; the daily pass is the LAST step of reconcilePayments, in its own try/catch;
//      the webhook's no-uuid guard is the first statement of voidPaid and calls no voidOrRefund.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyH0Index, unapplyH0Module, BLOCKS, HUNKS, FILES, BASE } = require('./tools/h0-inverse');
const { unapplyS1aIndex } = require('./tools/s1a-inverse');   // S1a now sits ON TOP of H0 — strip it FIRST so unapplyH0Index reaches H0's base

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1a. index.js ──
{
  const real = unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(read('index.js'))));   // the H0-layer index.js (S1a's edits removed; it is the newest layer, reversed first)
  assert.notStrictEqual(unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(read('index.js')))), read('index.js'), 'non-vacuity: S1a sits on top and is stripped before the H0 check');
  const base = baseOf('index.js');
  assert.notStrictEqual(unapplyH0Index(real), real, 'non-vacuity: the blocks are present and removed');
  assert.strictEqual(unapplyH0Index(real), base, `🔴 index.js minus the h0 blocks is not ${BASE}:index.js`);
  assert.strictEqual(BLOCKS.length, 4, '4 blocks');
  assert.deepStrictEqual(BLOCKS.map((b) => b.id), ['require', 'reconcile-daily', 'sweep-fn', 'reconciler-no-uuid']);   // file order
  assert.throws(() => unapplyH0Index(real.replace('H0.parkReconcilerNoUuid(db, attemptId, now)', 'H0.parkReconcilerNoUuid(db, attemptId, now )')), /pinned bytes/, 'an edit INSIDE a block');
  assert.throws(() => unapplyH0Index(real.replace('/* h0:end require */', '')), /exactly 4/, 'a missing delimiter');
  assert.throws(() => unapplyH0Index(real.replace('exports.verifyOtp', '/* h0:begin x */\n/* h0:end x */\nexports.verifyOtp')), /exactly 4/, 'a fifth block');
  assert.notStrictEqual(unapplyH0Index(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the blocks survives (the base pin catches it)');
  ok(`index.js: unapplyH0Index → ${BASE}:index.js byte-for-byte (4 blocks); an edit inside, a missing delimiter, a fifth block and a byte outside are each caught`);
}
// ── 1b. the pinned modules ──
{
  assert.deepStrictEqual([...FILES].sort(), ['cancel-order-core.js', 'pixelpay-hosted-webhook.js', 'resolve-manual.js']);
  for (const f of FILES) {
    const src = read(f);
    assert.notStrictEqual(unapplyH0Module(f, src), src, `non-vacuity: ${f} carries h0 hunks`);
    assert.strictEqual(unapplyH0Module(f, src), baseOf(f), `🔴 ${f} minus the h0 hunks is not ${BASE}:${f}`);
    const h = HUNKS.find((x) => x.file === f && /H0/.test(x.now));
    assert.ok(h, `${f}: a hunk mentions H0`);
    assert.throws(() => unapplyH0Module(f, src.replace(h.now, h.now.replace('H0', 'H0x'))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyH0Module(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
    assert.notStrictEqual(unapplyH0Module(f, '\n' + src), baseOf(f), `${f}: a byte OUTSIDE every hunk`);
  }
  ok(`modules: unapplyH0Module → ${BASE} byte-for-byte for ${FILES.length} files (${HUNKS.length} hunks); inside / duplicate / outside each caught`);
}

// ── 2. placement ──
{
  const core = read('cancel-order-core.js');
  const claim = core.indexOf('const claimed = claimTx.snapshot.val();');
  const guard = core.indexOf('H0.unresolvedMoneyOnOrder(db, orderId, claimed)');
  const b6 = core.indexOf('// B.6 close BOTH capture-in-flight paths');
  assert.ok(claim > 0 && guard > claim && b6 > guard, 'cancel guard: after the claim, before B.6');
  assert.ok(core.slice(guard, b6).includes('releaseCancelClaim(orderRef, claimId)'), 'the guard releases the claim on refusal');
  assert.ok(!core.slice(guard, b6).includes('cancel_pending'), 'the guard sets no attempt flag');
  ok('cancel-order-core: the H0 guard runs after the claim and BEFORE B.6, releases the claim and sets no attempt flag');

  const idx = read('index.js');
  const rStart = idx.indexOf('exports.refundReconciler = onSchedule(');
  const noUuid = idx.indexOf('if (!a.payment_uuid) { await H0.parkReconcilerNoUuid(db, attemptId, now); continue; }', rStart);
  const voidCall = idx.indexOf("reason: 'xpizza_refund_retry'", rStart);
  assert.ok(rStart > 0 && noUuid > rStart && voidCall > noUuid, 'refundReconciler: the no-uuid guard precedes voidOrRefund');
  const recStart = idx.indexOf('exports.reconcilePayments = onSchedule(');
  const recEnd = idx.indexOf('\n);\n', recStart);
  const daily = idx.indexOf('H0.dailyPass(db, { orders, attempts, invocationStartedAt: now, now })', recStart);
  const lastWork = idx.lastIndexOf("console.error('reconcilePayments: redemption sweep failed'", recEnd);
  assert.ok(daily > lastWork && daily < recEnd, 'reconcilePayments: the daily pass is the LAST step');
  const dailyTry = idx.lastIndexOf('try {', daily);
  assert.ok(dailyTry > lastWork, 'reconcilePayments: the daily pass has its own try/catch');
  ok('index.js: the reconciler no-uuid guard precedes voidOrRefund; the daily pass is reconcilePayments\' LAST step in its own try/catch');

  const wh = read('pixelpay-hosted-webhook.js');
  const vp = wh.indexOf('async function voidPaid(');
  const g = wh.indexOf('if (!uuid) {', vp);
  const firstVoid = wh.indexOf('deps.voidOrRefund(', vp);
  assert.ok(vp > 0 && g > vp && firstVoid > g, 'voidPaid: the no-uuid guard comes before any voidOrRefund');
  const guardBody = wh.slice(g, wh.indexOf('let voided = false;', g));
  assert.ok(!guardBody.includes('voidOrRefund'), 'the no-uuid branch never calls voidOrRefund');
  assert.ok(guardBody.includes("no_uuid_paid_callback") && guardBody.includes("'manual_review'"), 'it parks manual_review with the durable marker');
  ok('webhook: voidPaid\'s no-uuid guard precedes any reversal, never calls voidOrRefund, and leaves the durable marker');
}

console.log(`\nh0-wiring.guard: OK (${n})`);
