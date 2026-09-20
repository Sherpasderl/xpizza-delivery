require('./_emulator-required')('firestore');   // refuse if the emulator host vars are unset (would hit real infrastructure, or a foreign emulator)

/**
 * D4-P1 Slice D — the activation generation, proven through the REAL flip.
 * Run: npm run test:d4p1-activation
 *
 * 🔴 WHAT THIS EXISTS TO CATCH. The pointer write is a full REPLACE — tx.set({version, at}) — so it
 * deleted any `generation` field, and pointerStateOf reads an ABSENT generation as 0. A real
 * activation therefore reset the fence to zero, and a claim bound at generation 0 would pass a check
 * the activation had just defeated. Harmless while nothing wrote a generation; a fence that opens
 * itself the moment D starts using one.
 *
 * The generation is written inside the flip's own transaction, which makes two properties structural
 * rather than remembered: it advances exactly when the pointer moves, and an activation that ABORTS
 * advances nothing, because the whole transaction is discarded.
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { buildPublishCandidate } = require('../tools/publish-version');

admin.initializeApp({ projectId: 'demo-xpizza' });   // FIRESTORE_EMULATOR_HOST set by the runner
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', () => { if (!FINISHED) { console.error('\n🔴 D4P1 ACTIVATION (EMULATOR) EXITED EARLY — treat as FAILED'); process.exitCode = 1; } });

const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf } = require('../catalog/source-store');

const RID = 'x_pizza';
const seedSource = async () => { await sourceRefOf(db, RID).set(buildSourceFromCode(RID)); };
const publish = async (expectedActive, tag) => {
  const { input } = buildPublishCandidate(RID, { activeVersionId: expectedActive }, { source_sha: tag });
  const r = await publishVersion(db, RID, input, { expected: { activeVersionId: expectedActive } });
  return r.versionId || r.version_id || r;
};

(async () => {
  await seedSource();

  // ── 1. THE GENERATION SURVIVES A FLIP AND STRICTLY INCREASES ACROSS TWO REAL ONES ───────────
  /* Driven through publishVersion, not by writing the pointer directly: the defect was in the flip's
     own write, so a cell that set the pointer itself would have proven nothing about it. */
  {
    const v1 = await publish(null, 'gen-1');
    const afterFirst = await getActivePointer(db, RID);
    assert.strictEqual(afterFirst.version, v1, 'premise — the first publish is live');
    assert.ok(Number.isInteger(afterFirst.generation), 'the pointer carries an integer generation');
    assert.ok(afterFirst.generation >= 1,
      '🔴 the flip wrote no generation — a full-REPLACE pointer write dropped it, and an absent generation reads as 0');

    const v2 = await publish(v1, 'gen-2');
    const afterSecond = await getActivePointer(db, RID);
    assert.strictEqual(afterSecond.version, v2, 'premise — the second publish is live');
    assert.strictEqual(afterSecond.generation, afterFirst.generation + 1,
      '🔴 the generation did not strictly increase across two REAL consecutive flips — the fence is not advancing with activations');
    ok(`the generation is written by the flip and strictly increases across two real activations (${afterFirst.generation} → ${afterSecond.generation})`);
  }

  // ── 2. 🔴 A FAILED PUBLISH DOES NOT ADVANCE IT — DRIVEN, NOT ASSERTED FROM A LITERAL ─────────
  /* The carry list called for a REAL failed-publish-then-retry rather than a written-down number,
     because "a failed attempt must not bump" is exactly the kind of claim that stays true in a
     comment while the code drifts. A stale-CAS publish is a real failure with a real abort. */
  {
    const before = await getActivePointer(db, RID);
    await assert.rejects(
      () => publish('v-does-not-exist', 'gen-fail'),
      /flip_cas_stale|publish/,
      'premise — the attempt really failed',
    );
    const afterFailure = await getActivePointer(db, RID);
    assert.strictEqual(afterFailure.generation, before.generation,
      '🔴 a FAILED activation advanced the generation — every retry after a transient failure would then force a re-review');
    assert.strictEqual(afterFailure.version, before.version, 'and the pointer did not move');

    // …and the retry that follows DOES advance it, so the fence is not simply stuck.
    const v3 = await publish(before.version, 'gen-retry');
    const afterRetry = await getActivePointer(db, RID);
    assert.strictEqual(afterRetry.version, v3);
    assert.strictEqual(afterRetry.generation, before.generation + 1,
      'the retry advances it by exactly one — the failure consumed nothing');
    ok('a failed publish advances nothing; the retry after it advances by exactly one');
  }

  // ── 3. 🔴 ROLLBACK ADVANCES IT TOO — `seq` CANNOT FENCE A ROLLBACK ───────────────────────────
  /* A rollback moves the pointer BACKWARDS to a version whose seq is lower than the one it replaces,
     so a seq-based fence reads a rollback as going backwards in time. The activation generation is
     what makes "something was activated" monotonic regardless of which version won. */
  {
    const current = await getActivePointer(db, RID);
    const history = await db.collection('restaurants').doc(RID).collection('versions')
      .orderBy('__name__').get();
    const target = history.docs.map((d) => d.id).find((id) => id !== current.version);
    assert.ok(target, 'premise — there is an earlier version to roll back to');

    await rollbackVersion(db, RID, target, { expected: { activeVersionId: current.version } });
    const afterRollback = await getActivePointer(db, RID);
    assert.strictEqual(afterRollback.version, target, 'premise — the rollback moved the pointer back');
    assert.strictEqual(afterRollback.generation, current.generation + 1,
      '🔴 a rollback did not advance the generation — a fence that only counts forward publishes cannot see a rollback at all');
    ok('a rollback advances the generation like any other activation, even though it moves the pointer backwards');
  }

  FINISHED = true;
  console.log(`d4p1-activation(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 ACTIVATION (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
