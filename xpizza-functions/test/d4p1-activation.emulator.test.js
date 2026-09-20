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
    /* 🔴 THIS PROVES THE MECHANISM, NOT WHAT IT PROTECTS — and the difference was a real gate finding.
       The publishes here pass no draftRevision, so they never enter the flip's claim-validation branch
       and no deletion claim is ever bound before the failure. So this cell shows the NUMBER does not
       move; it cannot show that a merchant's standing deletion survives the failure and is still
       accepted on the retry, which is the property the number exists for and the one
       identity-partition.js declares as a contract it depends on and cannot enforce.
       That half is proven in d4p1-claim-flip's last cell, which binds a real claim, fails a real
       publish underneath it and retries. It lives there because the certified-baseline and
       claim-declaring fixtures already exist in that suite; duplicating them here would be two copies
       that have to agree forever. Cross-referenced rather than moved, so the pair reads as one
       property split across the two suites that can each only prove half. */
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

  // ── 4. THE RECORD TRANSITIONS pending → activated IN THE FLIP'S OWN TRANSACTION ─────────────
  /* Reservation ownership cannot reject an abandoned rename-only or price-only candidate: it mints
     nothing, owns no reservations, and therefore looks activatable forever. The record is what makes
     eligibility a fact about THIS attempt. It must also move in the same transaction as the pointer,
     so "activated" cannot be true of a version the pointer never reached. */
  {
    const live = await getActivePointer(db, RID);
    const v = await publish(live.version, 'rec-1');
    const doc = await db.collection('restaurants').doc(RID).collection('versions').doc(v).get();
    const rec = (doc.data() || {}).identity_activation;
    assert.ok(rec, '🔴 the candidate carried no activation record — eligibility would fall back to guessing from content');
    assert.strictEqual(rec.status, 'activated', '🔴 the record did not transition — it would stay activatable after activation');
    const after = await getActivePointer(db, RID);
    assert.strictEqual(rec.activated_at_generation, after.generation,
      'and it records the generation it activated AT, so the pointer and the record cannot disagree about when');
    ok('a published candidate transitions pending → activated in the flip, stamped with the generation it activated at');
  }

  /* ── 5. 🔴 WHY THERE IS NO CELL HERE FOR THE PREDICATE'S REFUSALS ─────────────────────────────
     I wrote one and it could not be made honest, so it is gone rather than weakened.
     The intended cell was: something activates between a candidate's preparation and its flip, so the
     record's base_generation no longer matches. Two attempts failed for two different reasons, and
     the second is the real finding.
       1. Publishing something else mid-flight moves the VERSION too, so the pre-existing pointer CAS
          refuses it — the cell passed with the eligibility predicate DELETED. It measured the CAS.
       2. Publishing and rolling back leaves the version where the candidate expected it while the
          generation advances twice, which only the record can see. But it cannot happen: both
          publishVersion and rollbackVersion acquire the same per-restaurant LEASE, and the candidate
          holds it from before its baseline capture until after its flip. The detour dies with
          `publish_locked`, which is the system working correctly.
     So while the lease serializes activations and writeVersion always writes `pending`, the
     predicate's refusal branches are unreachable: nothing can move the generation under a held lease,
     and no candidate arrives non-pending. They are DEFENCE IN DEPTH — a lease is a time-based
     assertion, not a proof, and a future caller could flip without one — and they have NO MUTANT,
     because a mutant that cannot be killed by any reachable state would only look like coverage.
     What IS proven, by cell 4: the predicate runs on every activation and permits a valid candidate.
     Reported to the advisor rather than papered over with a seeded cell. */

  // ── 6. ROLLBACK IS EXEMPT, AND THE EXEMPTION IS NOT A LOOPHOLE ──────────────────────────────
  /* A rollback re-activates a version whose record already says `activated` — that is its history and
     precisely what a rollback is for. The exemption is passed explicitly by the caller rather than
     inferred from version ordering, so it cannot widen into "any flip onto an activated version". */
  {
    const current = await getActivePointer(db, RID);
    const history = await db.collection('restaurants').doc(RID).collection('versions').orderBy('__name__').get();
    const target = history.docs.map((d) => d.id).find((id) => id !== current.version);
    assert.ok(target, 'premise — there is an earlier version to roll back to');
    const targetRec = ((history.docs.find((d) => d.id === target).data()) || {}).identity_activation;
    assert.ok(!targetRec || targetRec.status === 'activated', 'premise — the rollback target is an already-activated version');

    await rollbackVersion(db, RID, target, { expected: { activeVersionId: current.version } });
    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, target, '🔴 a rollback onto an activated version was refused — the exemption is missing');
    assert.strictEqual(after.generation, current.generation + 1, 'and it still advances the generation');
    ok('rollback re-activates an already-activated version, which a publish may not — the exemption is explicit, not inferred');
  }

  // ── 🔴 A MALFORMED GENERATION REACHES NO FENCE AS 0 — ON THE REAL PATH ──────────────────────
  /* The unit suite proves the READER cannot return 0 for a stored-but-unusable generation. That is a
     property of a pure function, and it is only half the claim: it says nothing about whether the
     real publish path reads the pointer through that reader at all. A publish that built its own
     coercion somewhere else would satisfy every unit cell and still hand a fence a 0.
     So the pointer is corrupted in the emulator — generation stored as the STRING "0", which is the
     shape a bad migration or a hand-edit writes, and the one that would coerce to exactly the
     pre-cutover baseline — and a REAL publish is driven against it. It must refuse by name rather
     than proceed. The version is left valid so the refusal can only be about the generation. */
  {
    const live = await getActivePointer(db, RID);
    const ref = db.collection('restaurants').doc(RID).collection('meta').doc('active_version');
    const good = (await ref.get()).data();

    await ref.set({ ...good, generation: '0' });
    let threw = null;
    try { await publish(live.version, 'malformed-gen'); } catch (e) { threw = e; }
    assert.ok(threw && /active_pointer_malformed/.test(String(threw.message)),
      `🔴 a publish ran against a pointer whose generation is the STRING "0" — it coerced to the pre-cutover baseline instead of refusing: ${threw && threw.message}`);
    assert.match(String(threw.message), /generation/, '…and the refusal names the field, not just "malformed"');

    const after = (await ref.get()).data();
    assert.strictEqual(after.generation, '0', '🔴 the refused publish REPAIRED the pointer — corruption must be surfaced, not silently rewritten');
    assert.strictEqual(after.version, good.version, '…and it did not move the pointer');

    // Restore, and prove the same publish succeeds once the pointer is well-formed: the refusal was
    // about the corruption, not about anything else this cell happened to set up.
    await ref.set(good);
    const v = await publish(live.version, 'after-repair');
    const healed = await getActivePointer(db, RID);
    assert.strictEqual(healed.version, v, 'SENSITIVITY: the identical publish succeeds against a well-formed pointer');
    assert.strictEqual(healed.generation, live.generation + 1, '…and the fence advances normally again');
    ok('a stored generation of "0" REFUSES a real publish by name rather than coercing to the pre-cutover baseline; the same publish succeeds once repaired');
  }

  // ── 🔴 EACH READER ISOLATED — BECAUSE THE PUBLISH PATH GUARDS THIS TWICE ────────────────────
  /* The cell above is satisfied by EITHER reader refusing, which I found out by mutating one of them
     and watching it pass: `assertDraftPartition` reads the pointer through getActivePointer before the
     lease, and the flip reads it again through pointerStateOf inside its own transaction. That is real
     defence in depth and worth keeping — but it means no single-site mutant can be killed by a plain
     publish, and a survivor there reads as "the property is unguarded" when in fact it is guarded
     twice. So each reader is driven where it is the ONLY one that can see the corruption. */
  {
    const { acquireLease, flipPointer, releaseLease, snapshotRefOf } = require('../catalog/catalog-publish');
    const ref = db.collection('restaurants').doc(RID).collection('meta').doc('active_version');
    const good = (await ref.get()).data();

    // (a) getActivePointer ALONE — no transaction, no second read behind it.
    await ref.set({ ...good, generation: '0' });
    let direct = null;
    try { await getActivePointer(db, RID); } catch (e) { direct = e; }
    assert.ok(direct && /active_pointer_malformed/.test(String(direct.message)),
      `🔴 getActivePointer coerced a stored generation of "0" instead of refusing — every caller that reads the pair WITHOUT a transaction behind it (the editor's claim-base stamp, among others) would be handed the pre-cutover baseline: ${direct && direct.message}`);

    /* (b) THE IN-TX READER ALONE. flipPointer is exported and does not pre-flight, so a direct flip
       reaches the transaction's own pointerStateOf with nothing in front of it. The lease and snapshot
       are real; the flip must refuse on the corruption rather than on anything else, which is why the
       message is asserted rather than just the throw. */
    const snapshot = (await snapshotRefOf(db, RID).get()).data();
    const token = await acquireLease(db, RID);
    let inTx = null;
    try {
      await flipPointer(db, RID, token, snapshot.version, snapshot, { activeVersionId: good.version });
    } catch (e) { inTx = e; } finally { await releaseLease(db, RID, token); }
    assert.ok(inTx && /active_pointer_malformed/.test(String(inTx.message)),
      `🔴 the flip's own in-transaction read coerced a stored generation of "0" — the value it would then have written is priorGeneration + 1 on a baseline that was never real: ${inTx && inTx.message}`);

    await ref.set(good);
    assert.strictEqual((await getActivePointer(db, RID)).generation, good.generation, 'premise — the pointer is repaired for the cells that follow');
    ok('each reader refuses on its own: getActivePointer with no transaction behind it, and the flip\'s in-tx read with no pre-flight in front of it');
  }

  FINISHED = true;
  console.log(`d4p1-activation(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 ACTIVATION (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
