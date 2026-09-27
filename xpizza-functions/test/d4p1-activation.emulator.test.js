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
    /* 🔴 THE TARGET MUST CARRY AN `activated` RECORD, asserted rather than assumed. Since the D-2 fix a
       rollback requires its target to be activated, so a broken status transition makes this rollback
       throw — and without this premise it throws UNCAUGHT, killing the suite with a stack trace
       instead of a sentence. A kill scored on an uncaught error is a kill scored on the absence of a
       try/catch; this says what actually broke. */
    const targetRec = await db.collection('restaurants').doc(RID).collection('versions').doc(target).get();
    assert.strictEqual(((targetRec.data() || {}).identity_activation || {}).status, 'activated',
      '🔴 premise — the rollback target does not carry an `activated` record, so the status transition never ran; a version the pointer reached must say it was activated, or nothing can ever be rolled back to it');

    await rollbackVersion(db, RID, target, { expected: { activeVersionId: current.version } });
    const afterRollback = await getActivePointer(db, RID);
    assert.strictEqual(afterRollback.version, target, 'premise — the rollback moved the pointer back');
    assert.strictEqual(afterRollback.generation, current.generation + 1,
      '🔴 a rollback did not advance the generation — a fence that only counts forward publishes cannot see a rollback at all');
    ok('a rollback advances the generation like any other activation, even though it moves the pointer backwards');
  }

  // ── 4. THE RECORD TRANSITIONS pending → activated IN THE FLIP'S OWN TRANSACTION ─────────────
  /* WHAT THIS CELL PROVES, STATED NARROWLY: the record MOVES from pending to activated inside the same
     transaction as the pointer, stamped with the generation it activated at — so "activated" cannot be
     true of a version the pointer never reached, and the two cannot disagree about when.
     🔴 WHAT IT DOES NOT PROVE, AND USED TO IMPLY. The comment here said "the record is what makes
     eligibility a fact about THIS attempt", which a reader takes as "this cell proves eligibility is
     ENFORCED". It does not: delete the flip's `activationVerdict` check and EVERY ASSERTION BELOW STILL
     PASSES, because the transition happens either way. An independent gate measured exactly that, and
     separately I measured that deleting the check DOES fail this suite and d4p1-claim — both true, and not
     a disagreement: THE PROPERTY IS COVERED, AND THIS CELL IS NOT WHAT COVERS IT. Same shape as the unit
     cell that claimed credit for a contract d4p1-activation actually held.
     WHERE THE ENFORCEMENT IS COVERED: the rollback refusal cell below drives the REAL rollbackVersion
     against a genuinely `pending` version and asserts the pointer does not move, and the predicate's own
     branches are exercised in catalog/activation-eligibility.test.js. Note 5 immediately below explains
     why the remaining refusal branches cannot be reached from HERE at all — under a held lease nothing can
     move the generation beneath a candidate — which is the honest account of the gap rather than a cell
     that pretends to close it.
     Reservation ownership is still the reason the record exists: it cannot reject an abandoned
     rename-only or price-only candidate, which mints nothing, owns no reservations, and would otherwise
     look activatable for ever. */
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
     So while the lease serializes activations and writeVersion always writes `pending`, THE
     GENERATION-STALENESS branches are unreachable: nothing can move the generation under a held lease,
     and no candidate arrives non-pending. Those are DEFENCE IN DEPTH — a lease is a time-based
     assertion, not a proof, and a future caller could flip without one — and they have no mutant,
     because a mutant no reachable state can kill would only look like coverage.

     🔴 THIS NOTE SAID "THE PREDICATE'S REFUSAL BRANCHES" AND THAT WAS TOO BROAD — IT DENIED COVERAGE
     THAT EXISTS TWENTY LINES BELOW. The ROLLBACK refusal
     (`flip_activation_rollback_not_activated`) and the RECORDLESS refusal
     (`flip_activation_no_record`) are both reachable and both covered: a cell further down drives the
     REAL rollbackVersion against a genuinely `pending` staged version and asserts neither the pointer
     nor the generation moves, and the sweep carries mutants for both — d4p1sf-01, d4p1sf-02 and
     d4p1sf-03, all KILLED (measured, not assumed: slice d4p1sf 4/4). Only the generation-staleness
     branches are unreachable from here.

     🔴 AND "WHAT IS PROVEN, BY CELL 4: THE PREDICATE RUNS ON EVERY ACTIVATION" WAS THE SAME CLAIM CELL 4
     WAS CORRECTED FOR MAKING. It does not prove that: delete the eligibility call and cell 4's assertions
     all still pass, because the record transitions either way. What cell 4 proves is the TRANSITION.
     That the predicate RUNS is shown by the rollback cell below and by activation-eligibility.test.js.
     Third instance today of a claim fixed in ONE place and left standing in another — grep the claim, not
     the line you were shown. Reported rather than papered over with a seeded cell. */

  // ── 6. ROLLBACK HAS ITS OWN REQUIREMENT — IT IS NOT EXEMPT FROM HAVING ONE ───────────────────
  /* 🔴 THIS HEADING SAID "ROLLBACK IS EXEMPT", WHICH IS THE SENTENCE THAT COST A GATE FINDING when a
     reader took it as "rollback skips eligibility". It does not: a rollback REQUIRES its target's record
     to say `activated`, and refuses `pending`, `abandoned`, an unmodelled status and no record at all.
     What it is exempt from is the PENDING requirement — history is not a candidate — and the intent is
     passed explicitly by the caller rather than inferred from version ordering, so it cannot widen into
     "any flip onto an activated version".
     THE PREMISE BELOW WAS ALSO STALE: it accepted `!targetRec` — a RECORDLESS target — which now refuses
     as `flip_activation_no_record`. A premise that permits a state the code refuses is a cell one edit
     away from passing for the wrong reason. */
  {
    const current = await getActivePointer(db, RID);
    const history = await db.collection('restaurants').doc(RID).collection('versions').orderBy('__name__').get();
    const target = history.docs.map((d) => d.id).find((id) => id !== current.version);
    assert.ok(target, 'premise — there is an earlier version to roll back to');
    const targetRec = ((history.docs.find((d) => d.id === target).data()) || {}).identity_activation;
    assert.strictEqual(targetRec && targetRec.status, 'activated',
      '🔴 premise — the rollback target must be an ALREADY-ACTIVATED version; a recordless one now refuses as flip_activation_no_record, so accepting it here would let this cell pass against a state the code rejects');

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

  // ── 🔴 THE CUTOVER BREAKER THE GATE FOUND: ROLLBACK TO A NEVER-ACTIVATED CANDIDATE ─────────
  /* Reproduced through the REAL functions exactly as codex did, then fixed. The rollback branch used
     to be a blanket exemption — any rollback intent skipped every eligibility check — so: publish A,
     let a publish of B FAIL so B is left `pending`, roll back to B. It SUCCEEDED. The pointer moved to
     a version that had never been live, B's record stayed `pending` because the transition excludes
     rollback too, and bootstrap then REFUSES that live version for carrying no `activated` record.
     A cutover breaker, and it disproved the claim that every live P1 version has transitioned.
     A rollback targets a version's OWN history; `activated` is what history looks like. */
  {
    const live = await getActivePointer(db, RID);

    /* Stage a REAL never-activated candidate: writeVersion creates the version, and the flip never
       happens. That is precisely what a failed publish leaves behind, which is why retention cannot be
       read as proof of activation. */
    const { writeVersion, serverNow } = require('../catalog/catalog-publish');
    const { input } = buildPublishCandidate(RID, { activeVersionId: live.version }, { source_sha: 'never-live' });
    const staged = await writeVersion(db, RID, { ...input, baseline: live }, await serverNow(db, RID));
    const stagedId = staged.versionId || staged.version || staged;

    const rec = await db.collection('restaurants').doc(RID).collection('versions').doc(stagedId).get();
    assert.strictEqual(((rec.data() || {}).identity_activation || {}).status, 'pending',
      'premise — the staged candidate really is pending: written, never flipped');

    let threw = null;
    try { await rollbackVersion(db, RID, stagedId, { expected: { activeVersionId: live.version } }); } catch (e) { threw = e; }
    assert.ok(threw && /flip_activation_rollback_not_activated/.test(String(threw.message)),
      `🔴 A ROLLBACK ACTIVATED A VERSION THAT WAS NEVER LIVE — prices no customer ever saw would be serving, and bootstrap would then refuse the version it finds under the pointer: ${threw && threw.message}`);

    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, live.version, '…and the pointer did not move');
    assert.strictEqual(after.generation, live.generation, '…and the fence did not advance');

    /* SENSITIVITY — a rollback to a genuinely ACTIVATED version still works. Without this the refusal
       above is satisfied by a rollback path that refuses everything, which would be a worse bug than
       the one being fixed: rollback is the emergency lever. */
    /* 🔴 THE TARGET MUST HAVE BEEN ACTIVATED BY THIS RUN, AND THE CELL PROVES IT. Taking whatever was
       live at cell start makes the outcome depend on emulator state a previous run left behind — and
       that is not hypothetical: the mutant that removes the status transition PASSED this cell on a
       warm database (the target was already `activated` from an earlier run) and died under the sweep
       on a cold one. A cell whose verdict depends on what ran before it measures the database, not the
       code. */
    const target = live.version;
    const targetRec = await db.collection('restaurants').doc(RID).collection('versions').doc(target).get();
    assert.strictEqual(((targetRec.data() || {}).identity_activation || {}).status, 'activated',
      '🔴 premise — the rollback target must carry an `activated` record written by THIS run; if it does not, the transition is broken and the sensitivity below would pass on stale state');

    const v = await publish(target, 'so-we-can-roll-back');
    const moved = await getActivePointer(db, RID);
    assert.strictEqual(moved.version, v, 'premise — something newer is live, so there is something to roll back FROM');
    await rollbackVersion(db, RID, target, { expected: { activeVersionId: v } });
    const landed = await getActivePointer(db, RID);
    assert.strictEqual(landed.version, target,
      '🔴 SENSITIVITY: a rollback to a genuinely ACTIVATED version was refused — the emergency lever is broken, which is worse than the defect being fixed');
    assert.strictEqual(landed.generation, moved.generation + 1, '…and it still advances the fence');
    ok('a rollback to a never-activated PENDING candidate is refused by name; a rollback to a genuinely activated version still works');
  }

  // ── 🔴 THE FOURTH READER: A MALFORMED POINTER MUST NOT BE OVERWRITTEN AT THE FLIP ───────────
  /* E-1 unified the two public readers and routed the three CLI tools through them, and the D-chain
     gate found a FOURTH — inside the flip transaction, the one that matters most. It coerced the
     version with `|| null`, so a document that EXISTS and names no version read as "nothing published
     yet", which is the expectation a FIRST publish and a null-expecting ROLLBACK both carry. The bytes
     both public readers refuse were still accepted at the activation boundary.
     🔴 AND MY CENSUS COULD NOT HAVE CAUGHT IT. pointer-state's census scans production files for a
     "read the active_version document" spelling; this is a parse of an ARGUMENT — the snapshot was
     fetched above it. That is exactly the alternate-spelling case the census's own comment says a lint
     walks past, which is why it is a lint and this is a cell.
     Reproduced as the gate reproduced it, through the real functions. */
  {
    const ptr = db.collection('restaurants').doc(RID).collection('meta').doc('active_version');
    const good = (await ptr.get()).data();
    const { rollbackVersion: rb } = require('../catalog/catalog-publish');

    /* (a) ROLLBACK EXPECTING `null` MUST NOT OVERWRITE A MALFORMED POINTER. Both shapes the gate used. */
    for (const [label, doc] of [['an empty document', {}], ['an explicit null version', { version: null }]]) {
      await ptr.set(doc);
      let threw = null;
      try { await rb(db, RID, good.version, { expected: { activeVersionId: null } }); } catch (e) { threw = e; }
      assert.ok(threw && /active_version_malformed/.test(String(threw.message)),
        `🔴 a rollback expecting "nothing published" OVERWROTE ${label} — a partial write read as a fresh restaurant, and the rollback took the pointer: ${threw && threw.message}`);
      const after = (await ptr.get()).data() || {};
      assert.strictEqual(after.version, doc.version, `…and ${label} is untouched — the refusal happened before any write`);
    }

    /* (b) A FIRST PUBLISH MUST NOT OVERWRITE ONE EITHER — the gate's second case, where the malformed
       document appears AFTER baseline capture and before the flip's transaction.
       🔴 MY FIRST VERSION SET UP THE WRONG STATE, and the gate caught it: it restored the good pointer
       before capturing the baseline, so the publish captured a REAL version and merely passed
       `activeVersionId: null` — simulating a null expectation rather than a genuinely ABSENT baseline.
       That is the same class as the fixture that repaired its own defect: the cell stages a state
       ADJACENT to the one it claims. A genuine first publish begins with NO pointer document at all,
       so the document is DELETED before capture here, and both malformed shapes are driven. */
    for (const [label, malformed] of [['an empty document', {}], ['an explicit null version', { version: null }]]) {
      await ptr.delete();                       // a genuine first publish: no pointer document at all
      assert.strictEqual((await ptr.get()).exists, false, `premise — ${label}: the baseline is genuinely ABSENT, not a real version with a null expectation`);

      const orig = db.runTransaction.bind(db);
      let calls = 0, fired = false;
      let racingTx;
    const racing = new Proxy(db, {
        get(t, prop) {
          if (prop === 'runTransaction') {
            return async (fn, o) => {
              calls += 1;
              if (calls === 2 && !fired) { fired = true; await ptr.set(malformed); }   // appears mid-publish
              return orig(fn, o);
            };
          }
          const v = t[prop];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      let pubThrew = null;
      try {
        const { input } = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: `fourth-${Date.now()}` });
        await publishVersion(racing, RID, input, { expected: { activeVersionId: null } });
      } catch (e) { pubThrew = e; }
      assert.ok(fired, `premise — ${label} really appeared between baseline capture and the flip`);
      assert.ok(pubThrew && /active_version_malformed/.test(String(pubThrew.message)),
        `🔴 a first publish OVERWROTE ${label} that appeared mid-flight — the flip read it as "nothing published" and took it: ${pubThrew && pubThrew.message}`);
      assert.deepStrictEqual((await ptr.get()).data(), malformed, `…and ${label} is untouched`);
    }

    /* SENSITIVITY — with a well-formed pointer the identical flip still works. Without this the two
       refusals are satisfied by an activation path that refuses everything, which would be a worse
       bug than the one being fixed. */
    await ptr.set(good);
    const live = await getActivePointer(db, RID);
    const v = await publish(live.version, 'after-fourth-reader');
    const healed = await getActivePointer(db, RID);
    assert.strictEqual(healed.version, v, '🔴 SENSITIVITY: an ordinary publish against a well-formed pointer was refused too');
    assert.strictEqual(healed.generation, live.generation + 1, '…and the fence advanced exactly once');
    ok('a malformed pointer is refused AT THE FLIP — a null-expecting rollback cannot overwrite it, nor can a first publish that meets it mid-flight; an ordinary publish still works');
  }

  // ── 🔴 BOOTSTRAP CERTIFIES BETWEEN THE PARTITION CHECK AND THE LEASE ──────────────────────────
  {
    /* THE RACE, AND IT IS LIVE EXACTLY DURING THE CUTOVER. `assertDraftPartition` runs at
       catalog-publish.js:1375 and `acquireLease` at :1377 — VALIDATION FIRST, LEASE SECOND. So a publish
       can validate its draft against an EMPTY active certified set, bootstrap can certify that same
       version while the publish is still in flight, and the publish then flips a version carrying ids
       that are neither CARRIED nor DECLARED DELETED — identities dropped silently by absence, which is
       the one outcome the partition law exists to prevent.
       🔴 THE FLIP'S CAS CANNOT SEE IT: certification changes neither the version id nor the generation,
       so the pointer the flip compares against is unchanged. And the operator CLI's code-derived path
       supplies no draft revision, so that guard is absent too.
       🔴 BOOTSTRAP ONLY RUNS DURING THE CUTOVER, so this is reachable precisely while the owner is
       running it — which is why the deploy note's "nothing may publish between a rehearsal and its apply"
       is insufficient: nothing may publish DURING THE CUTOVER AT ALL, including during an apply.
       Certification is staged DIRECTLY here (stamps on the active version's objects + identity_certified)
       rather than by calling bootstrap: what the partition law reads is the active certified version's
       stamps, and writing them is the state, not a claim about how bootstrap produces it.
       Interception point: `acquireLease` is the first runTransaction after the partition check. */
    const priorPtr = await getActivePointer(db, RID);
    const base = await publish(priorPtr.version, 'race-base');
    const vrefOfId = (id) => db.collection('restaurants').doc(RID).collection('versions').doc(id);

    const beforeCertified = (await vrefOfId(base).get()).data() || {};
    assert.notStrictEqual(beforeCertified.identity_certified, true,
      'premise — the active version is UNCERTIFIED when the publish validates, so A is empty and any draft passes the partition');

    const orig = db.runTransaction.bind(db);
    let certifiedMidFlight = false;
    /* 🔴 A PROXY, NOT A HAND-LISTED FACADE. My first wrapper forwarded only `collection` and
       `runTransaction` — copying cell 6's shape, which is enough for bootstrapIdentityStamps — and
       publishVersion died on `db.batch is not a function`. The cell then "refused", and a refusal caused
       by my own incomplete stub would have read as the guard working. Forward everything; intercept one. */
    const racing = new Proxy(db, {
      get: (t, prop, recv) => (prop === 'runTransaction' ? racingTx : Reflect.get(t, prop, recv)),
    });
    racingTx = async (fn, o) => {
      if (!certifiedMidFlight) {
        certifiedMidFlight = true;
        // stamp every object of the ACTIVE version, then certify it — the cutover, mid-publish
        for (const col of ['menu_items', 'extras']) {
          const docs = (await vrefOfId(base).collection(col).get()).docs;
          for (const [i, d] of docs.entries()) {
            await d.ref.update({ 'display.identity_id': `RACE-ID-${col}-${i}` });
          }
        }
        await vrefOfId(base).update({ identity_certified: true });
      }
      return orig(fn, o);
    };

    const { input: raceInput } = buildPublishCandidate(RID, { activeVersionId: base }, { source_sha: 'race-publish' });
    let outcome = null;
    try {
      await publishVersion(racing, RID, raceInput, { expected: { activeVersionId: base } });
      outcome = 'FLIPPED';
    } catch (e) { outcome = (e && e.message) || String(e); }
    assert.ok(certifiedMidFlight, 'premise — certification really landed between the partition check and the flip');

    assert.notStrictEqual(outcome, 'FLIPPED',
      '🔴 A PUBLISH THAT VALIDATED AGAINST AN EMPTY CERTIFIED SET FLIPPED AFTER THAT SET BECAME NON-EMPTY. Every id the newly-certified version carries is now neither carried nor declared deleted by the live version — identities dropped silently by absence, during the cutover, with the flip\'s CAS blind to it because certification moves neither the version id nor the generation.');
    assert.match(String(outcome), /identity_partition_unaccounted|carried_unknown|publish_lease|identity_partition/,
      `🔴 it refused, but not for the partition reason — the refusal must name what went wrong: ${outcome}`);
    /* 🔴 UNDO THE DOCTORED STATE, or every cell below inherits a CERTIFIED active version carrying
       RACE-ID stamps and refuses as unaccounted — which is what happened when I first wrote this, and it
       failed the NEXT cell rather than this one. A cell that stages a corrupt state owns putting it back. */
    for (const col of ['menu_items', 'extras']) {
      const docs = (await vrefOfId(base).collection(col).get()).docs;
      for (const d of docs) await d.ref.update({ 'display.identity_id': admin.firestore.FieldValue.delete() });
    }
    await vrefOfId(base).update({ identity_certified: admin.firestore.FieldValue.delete() });
    const cleaned = (await vrefOfId(base).get()).data() || {};
    assert.strictEqual(cleaned.identity_certified, undefined, '🔴 the cleanup left the version certified — the cells below would all refuse as unaccounted');
    ok(`a certification landing between the partition check and the flip is REFUSED (${String(outcome).split(':')[0]}) — the cutover window cannot drop identities by absence`);
  }

  // ── 🔴 THE DRAFT MOVES BETWEEN THE PRE-FLIGHT CAS AND THE FLIP'S ──────────────────────────────
  {
    /* WHY THIS CELL EXISTS, AND IT IS THE SAME REMEDY AS THE ACTIVATION PAIR. Two mutation survivors —
       task7-04 ("the flip stops comparing the draft revision") and task7-06 ("the draft CAS is keyed by
       VALUE, so an absent revision skips it") — survive because the draft CAS is enforced TWICE: a
       PRE-FLIGHT check before the lease, with its own independent `hasOwnProperty` gate, and the flip's
       own check inside the transaction. Mutating the flip's half leaves the pre-flight refusing, so the
       cells in publish-paths.test.js still pass and the mutants live.
       🔴 THE PRE-FLIGHT IS MINE, from the staleness-before-membership round, and it shadowed a guard that
       was armed before I added it. That is the third time an EARLIER check of mine has made a LATER one
       unkillable, and the pattern is now the thing to watch rather than any single instance.
       THE FLIP'S HALF IS NOT REDUNDANT: the pre-flight reads the source OUTSIDE any transaction, so a
       draft that moves AFTER it and BEFORE the flip is caught only in the transaction. That is the window
       this cell stages — and it is a real one, because a merchant saving while a publish is in flight is
       the ordinary case, not a contrivance. */
    const priorPtr2 = await getActivePointer(db, RID);
    const baseV = await publish(priorPtr2.version, 'draft-cas-base');
    const { encodeUpdateTime } = require('../catalog/source-store');
    const revAtReview = encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime);

    let movedDraft = false;
    let racingTx2;
    const racing2 = new Proxy(db, {
      get: (t, prop, recv) => (prop === 'runTransaction' ? racingTx2 : Reflect.get(t, prop, recv)),
    });
    racingTx2 = async (fn, o) => {
      if (!movedDraft) {
        movedDraft = true;
        // the merchant saves — AFTER the pre-flight CAS has already compared and passed
        const cur = (await sourceRefOf(db, RID).get()).data() || {};
        await sourceRefOf(db, RID).set({ ...cur, moved_between_preflight_and_flip: Date.now() });
      }
      return orig2(fn, o);
    };
    const orig2 = db.runTransaction.bind(db);

    const { input: dcInput } = buildPublishCandidate(RID, { activeVersionId: baseV }, { source_sha: 'draft-cas-race' });
    let dcOutcome = null;
    try {
      await publishVersion(racing2, RID, dcInput, { expected: { activeVersionId: baseV, draftRevision: revAtReview } });
      dcOutcome = 'FLIPPED';
    } catch (e) { dcOutcome = (e && e.message) || String(e); }
    assert.ok(movedDraft, 'premise — the draft really moved between the pre-flight comparison and the flip');

    assert.notStrictEqual(dcOutcome, 'FLIPPED',
      '🔴 A DRAFT THAT MOVED AFTER THE PRE-FLIGHT CAS WAS PUBLISHED ANYWAY. The pre-flight reads outside any transaction, so only the flip\'s own comparison can see a save that lands after it — without that comparison a merchant\'s edit is silently overwritten by a publish that never looked at it.');
    assert.match(String(dcOutcome), /flip_cas_draft_stale/,
      `🔴 it refused, but not as a stale draft — the refusal has to name what the merchant needs to hear: ${dcOutcome}`);
    const stillBase = await getActivePointer(db, RID);
    assert.strictEqual(stillBase.version, baseV, '🔴 …and the pointer moved anyway');
    /* 🔴 AND THE OTHER HALF, WHICH THE CASE ABOVE CANNOT REACH: `draftRevision` PRESENT AND NULL. The
       flip's gate is keyed on the KEY's PRESENCE (`hasOwnProperty`), not on the value's truthiness — so
       "there was no draft when I built this" is a CLAIM that must be falsified by a draft that exists.
       A truthy revision (the case above) leaves a value-keyed gate switched ON, so it cannot tell the two
       spellings apart; this one can. Staged as: NO source at the pre-flight (so the null claim is true
       and the pre-flight passes), and a draft APPEARING before the flip. */
    await sourceRefOf(db, RID).delete();
    let createdDraft = false;
    let racingTx3;
    const racing3 = new Proxy(db, {
      get: (t, prop, recv) => (prop === 'runTransaction' ? racingTx3 : Reflect.get(t, prop, recv)),
    });
    const orig3 = db.runTransaction.bind(db);
    racingTx3 = async (fn, o) => {
      if (!createdDraft) {
        createdDraft = true;
        await sourceRefOf(db, RID).set(buildSourceFromCode(RID));   // a draft appears after the pre-flight
      }
      return orig3(fn, o);
    };
    const nowPtr = await getActivePointer(db, RID);
    const { input: nullInput } = buildPublishCandidate(RID, { activeVersionId: nowPtr.version }, { source_sha: 'null-claim-race' });
    let nullOutcome = null;
    try {
      await publishVersion(racing3, RID, nullInput, { expected: { activeVersionId: nowPtr.version, draftRevision: null } });
      nullOutcome = 'FLIPPED';
    } catch (e) { nullOutcome = (e && e.message) || String(e); }
    assert.ok(createdDraft, 'premise — a draft really appeared between the pre-flight and the flip');
    assert.notStrictEqual(nullOutcome, 'FLIPPED',
      '🔴 A PUBLISH CLAIMING "THERE WAS NO DRAFT" LANDED ON A RESTAURANT THAT HAD ONE BY THE TIME IT FLIPPED. A value-keyed gate reads null as "no opinion" and skips the comparison — the presence-by-value trap, in the one place where skipping it means publishing over a draft nobody looked at.');
    assert.match(String(nullOutcome), /flip_cas_draft_stale/, `🔴 it refused, but not as a stale draft: ${nullOutcome}`);
    await sourceRefOf(db, RID).set(buildSourceFromCode(RID));   // leave a draft for any cell below
    ok('a draft that moves between the pre-flight CAS and the flip is refused IN THE TRANSACTION, for a truthy revision AND for a present-and-null claim — the guard the pre-flight cannot stand in for, and the gate keyed by presence rather than value');
  }

  FINISHED = true;
  console.log(`d4p1-activation(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 ACTIVATION (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
