'use strict';
// Portal 1D · D4-P1 Slice C — THE DELETION CLAIM AT THE WRITE BOUNDARY, ON THE REAL FLIP.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4p1-claim
//
// 🔴 WHY THIS CANNOT BE A UNIT TEST. Every property here is about what happens INSIDE the flip
// transaction: that the claim is re-verified against the pointer pair that same transaction
// CAS-verifies, that consuming it and activating the version stand or fall together, and that a draft
// which moved underneath aborts the whole thing rather than clobbering a newer claim. A fake can be
// made to agree with any of that; only the real transaction engine decides it.
require('./_emulator-required')('firestore');   // refuse if the emulator host vars are unset (would hit real infrastructure, or a foreign emulator)

const assert = require('assert');
const admin = require('firebase-admin');
const { buildPublishCandidate } = require('../tools/publish-version');

admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-claim(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const { publishVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, encodeUpdateTime, canonicalize, sourceToBuildInputs } = require('../catalog/source-store');
const versionsColOf = (d, rid) => d.collection('restaurants').doc(rid).collection('versions');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { bootstrapIdentityStamps, readActiveVersion } = require('../catalog/identity-bootstrap');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActivePointer } = require('../catalog/catalog-firestore');

const RID = 'x_pizza';
const claimOf = (ids, v, g) => ({ ids, base_version: v, base_generation: g });

/* 🔴 DECLARING A DELETION MEANS THE OBJECT LEAVES THE DRAFT TOO. The partition law is C ∩ D = ∅: an
   id cannot be both carried and deleted. A fixture that only wrote the claim left the object in the
   source, so the draft carried the very id it declared deleted and the publish refused — the law
   catching an incoherent setup, which is exactly what it is for. */
/* 🔴 EVERY CELL STARTS FROM A CERTIFIED BASELINE, because a C-era publish does not produce one.
   The first publish after bootstrap yields an UNCERTIFIED version (C has no writer that stamps one),
   which empties A while the source still carries its stamps — so the NEXT publish refuses as
   carried_unknown. That limitation is pinned as its own cell in the bootstrap suite; here it just
   means a cell that publishes must re-establish the baseline first, or it fails for a reason that has
   nothing to do with what it is testing. */
async function ensureCertifiedBaseline() {
  const cur = await readActiveVersion(db, RID);
  if (cur.record.identity_certified === true) return cur;
  await sourceRefOf(db, RID).update({ deleted_ids: null });
  const rep = await bootstrapIdentityStamps(db, RID);
  assert.ok(rep.stamped || rep.already, `re-established a certified baseline: ${JSON.stringify(rep)}`);
  return readActiveVersion(db, RID);
}

async function declareDeletion(id) {
  const src = (await sourceRefOf(db, RID).get()).data();
  const gone = new Set();
  const keep = (rows) => (Array.isArray(rows) ? rows : []).filter((o) => {
    const hit = o && o.display && o.display.identity_id === id;
    if (hit) gone.add(o.key);
    return !hit;
  });
  const items = keep(src.items);
  const extras = keep(src.extras);
  /* …and out of the STRUCTURE, or item_order still names a key with no object behind it and the
     build dereferences undefined. Removing the row alone is not a deletion in this source model. */
  const structure = { ...src.structure, item_order: (src.structure.item_order || []).filter((k) => !gone.has(k)) };
  const live = await getActivePointer(db, RID);
  await sourceRefOf(db, RID).update({
    items, extras, structure,
    deleted_ids: claimOf([id], live.version, live.generation),
  });
}
const readClaim = async () => ((await sourceRefOf(db, RID).get()).data() || {}).deleted_ids;
const snapshotClaim = async () => JSON.parse(JSON.stringify((await readClaim()) || null));
const activePointerRefOf = () => db.collection('restaurants').doc(RID).collection('meta').doc('active_version');
const revision = async () => encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime);

async function seedSource() {
  await sourceRefOf(db, RID).set(canonicalize(buildSourceFromCode(RID)));
}
/* 🔴 BUILD FROM THE STORED SOURCE, as production does. Once bootstrap certifies a version, A is
   non-empty and the partition law requires the draft to carry exactly those ids — and only the SOURCE
   carries them. A code-derived candidate is short of every id and refuses as unaccounted, which is the
   law working, not the suite being unlucky. */
async function candidateFromSource() {
  const src = (await sourceRefOf(db, RID).get()).data();
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable });
  return { items: built.items, structure: built.structure, extras: inputs.extras,
    extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
}
async function publishOnce({ withDraftCas = true, mutateBeforeFlip = null } = {}) {
  const live = await getActivePointer(db, RID);
  const input = { ...(await candidateFromSource()), source_sha: `claim-${Date.now()}` };
  const expected = { activeVersionId: live.version };
  if (withDraftCas) expected.draftRevision = await revision();

  let handle = db;
  if (mutateBeforeFlip) {
    const orig = db.runTransaction.bind(db);
    let fired = false;
    /* Delegates EVERYTHING and overrides only runTransaction. A hand-listed wrapper missed db.batch
       and the publish died on the wrapper rather than on the property under test — a fixture failing
       for its own reasons looks exactly like the code failing. */
    handle = new Proxy(db, {
      get(t, prop) {
        if (prop === 'runTransaction') {
          return async (fn, o) => {
            if (!fired) { fired = true; await mutateBeforeFlip(); }
            return orig(fn, o);
          };
        }
        const v = t[prop];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }
  return publishVersion(handle, RID, input, { expected });
}

(async () => {
  await seedSource();
  await publishVersion(db, RID, buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'seed' }).input,
    { expected: { activeVersionId: null } });
  /* 🔴 BOOTSTRAP FIRST, AND USE A REAL CERTIFIED ID. A deletion claim names an id the server has
     CERTIFIED; an invented one refuses as deleted_unknown, and a suite that invented its ids would be
     testing the wrong refusal. Bootstrap also stamps the source, which is what makes the publishes
     below lawful against A. */
  await require('../catalog/identity-backfill').backfillIdentities(db, RID, require('../catalog/generate-form-bundle').catalogSnapshot(RID));
  const boot = await bootstrapIdentityStamps(db, RID);
  assert.ok(boot.stamped, `premise — the baseline is certified and the source stamped: ${JSON.stringify(boot)}`);
  const activeNow = await readActiveVersion(db, RID);
  const REAL_ID = activeNow.dishes[0].data.display.identity_id;
  assert.ok(REAL_ID, 'premise — a real certified id to name in the claim');

  // ── 1. 🔴 THE ACTIVATION THAT EXECUTES THE DELETION IS THE ONE THAT CONSUMES THE CLAIM ────
  /* This cell asserted the OPPOSITE under C, and the inversion is the point rather than a revision:
     C validated the claim and left it standing because it had no writer that retired the declared
     ids, so clearing would have discarded a merchant's intent while reporting success. D has that
     writer. The claim is now consumed by the flip that carries it out — the same transaction, so
     "cleared" means "carried out" by construction and cannot come to mean anything else.
     Three things are checked, because clearing the field is the easy third of it: the claim is gone,
     the VERSION records which ids it retired (the source is replaced on every save, so the only
     durable account of what a publish executed is the version that executed it), and the id really
     has left the certified set — a consumed claim whose id was still live would be the silent
     discard in a different costume. */
  {
    await declareDeletion(REAL_ID);
    const standing = (await sourceRefOf(db, RID).get()).data().deleted_ids;
    assert.deepStrictEqual(standing.ids, [REAL_ID], 'premise — a declared claim really is standing before the publish');

    await publishOnce();

    assert.strictEqual(await readClaim(), null,
      '🔴 the claim SURVIVED the activation that carried it out — it now goes stale against the next baseline and the merchant is sent back to re-review a deletion that already happened');
    const after = await readActiveVersion(db, RID);
    assert.deepStrictEqual((after.record.identity_activation || {}).consumed_deleted_ids, [REAL_ID],
      '🔴 the version does not record which deletion it executed — the claim is gone and nothing says where it went');
    const stillLive = after.dishes.some((d) => d.data.display.identity_id === REAL_ID);
    assert.strictEqual(stillLive, false,
      '🔴 the claim was consumed by a version that still carries the id — the declaration is gone and the object is not');
    ok('the activation that retires the ids CONSUMES the claim, records what it retired, and the ids are really gone');
  }

  // ── 2. 🔴 A DRAFT THAT MOVED UNDER THE PUBLISH ABORTS EVERYTHING ──────────────────────────
  /* The N+1 race. The merchant saves a NEWER revision while this publish is in flight: the flip must
     abort, and the evidence is that the POINTER does not move — nothing activated. (The claim being
     intact is not evidence here, since C writes the source at all.) */
  {
    /* Cell 1's claim is already consumed, so this is a no-op today — kept because the cell must not
       depend on WHO cleared it. A standing claim here would be stale against the baseline cell 1's
       own publish advanced, and the pre-flip check would refuse this publish for that reason, so the
       cell would "pass" its abort assertion for entirely the wrong cause. */
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    await ensureCertifiedBaseline();
    const before = await getActivePointer(db, RID);
    const newer = claimOf([REAL_ID], before.version, before.generation);

    let threw = null;
    try {
      await publishOnce({ mutateBeforeFlip: async () => { await sourceRefOf(db, RID).update({ deleted_ids: newer }); } });
    } catch (e) { threw = e; }

    assert.ok(threw && /flip_cas_draft_stale/.test(String(threw.message)),
      `🔴 a publish whose draft moved underneath did not abort: ${threw && threw.message}`);
    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, before.version,
      '🔴 THE POINTER MOVED despite the draft CAS failing — the activation was not atomic with the check');
    assert.deepStrictEqual(await readClaim(), newer, 'and the newer claim the merchant just saved is untouched');
    ok('a draft saved while the publish was in flight aborts the flip — nothing activated, and the newer claim stands');
  }

  // ── 3. A STALE CLAIM IS REFUSED BEFORE THE LEASE — A PRE-FLIGHT CELL, LABELLED AS ONE ────
  /* 🔴 THIS DOES NOT REACH THE FLIP, and the label used to claim it did. A claim that is ALREADY
     stale when the publish starts is refused by assertDraftPartition, before the lease and before any
     version is written — which is the right behaviour and worth a cell, but it is the PRE-FLIGHT pass
     doing it, not the in-transaction check. Cell 5 is the one that reaches the flip, by moving the
     baseline between the two. Naming which guard a cell exercises is the difference between evidence
     and a comfortable assumption. */
  {
    await ensureCertifiedBaseline();
    await sourceRefOf(db, RID).update({ deleted_ids: claimOf([REAL_ID], 'v-long-gone', 0) });
    let threw = null;
    try { await publishOnce(); } catch (e) { threw = e; }
    assert.ok(threw && /deleted_ids_stale_baseline/.test(String(threw.message)),
      `🔴 a claim from a superseded baseline rode the activation through: ${threw && threw.message}`);
    assert.ok(await readClaim(), '…and it is left standing for the merchant to re-review');
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    ok('a claim bound to a superseded baseline is refused at PRE-FLIGHT, before the lease and before any version is written');
  }

  // ── 4. A MALFORMED CLAIM IS REFUSED AT PRE-FLIGHT, NOT WAVED THROUGH ─────────────────────
  /* Both publish-side checks used to gate on "a non-empty array of ids", so the shapes LEAST likely
     to be honest — a string, a bare list, an object — skipped validation entirely while a well-formed
     claim was scrutinised. Any present, non-null claim is now validated. Top-level null stays the
     cleared sentinel, and must keep publishing cleanly or the fix has broken the normal path. */
  await ensureCertifiedBaseline();
  for (const [label, bad] of [
    ['a string where ids should be', { ids: 'X', base_version: 'v', base_generation: 0 }],
    ['a bare list instead of a claim', ['X']],
    ['an explicit null ids', { ids: null, base_version: 'v', base_generation: 0 }],
  ]) {
    await sourceRefOf(db, RID).update({ deleted_ids: bad });
    let threw = null;
    try { await publishOnce(); } catch (e) { threw = e; }
    assert.ok(threw && /deleted_ids_malformed/.test(String(threw.message)),
      `🔴 ${label} skipped validation instead of refusing: ${threw && threw.message}`);
  }

  // SENSITIVITY: the cleared sentinel is NOT malformed and must still publish.
  await sourceRefOf(db, RID).update({ deleted_ids: null });
  await publishOnce();
  assert.strictEqual((await readClaim()), null, 'a cleared claim publishes normally and stays cleared');
  /* 🔴 ALSO A PRE-FLIGHT CELL — and the reason it is only a pre-flight cell is narrower than I first
     wrote. Nothing can reach the flip's malformed check THROUGH publishVersion: this pass refuses an
     already-malformed claim, and making one malformed later means writing the source, which moves its
     revision and trips the draft CAS first. That is not the same as unreachable. flipPointer is
     exported and rollbackVersion forwards `expected` without pre-flighting, so a direct flip does
     reach it — live defence, not dead code, for every caller that is not publishVersion. */
  ok('three malformed claim shapes refuse by name AT PRE-FLIGHT; the top-level null sentinel still publishes cleanly');

  // ── 5. 🔴 THE TEAR C-2 EXISTS FOR: STALE ONLY AT THE WRITE BOUNDARY ───────────────────────
  /* The pre-flight pass in publishVersion validates the claim too, so a claim that is ALREADY stale
     never reaches the transaction — which means the in-tx check looks redundant and its mutant
     survives. This isolates it. The GENERATION is bumped between the pre-flight check and the flip,
     leaving the VERSION untouched: the flip's CAS compares versions and passes, the pre-flight check
     saw the old generation and passed, and the only thing that can notice is the in-tx check reading
     the pointer THIS transaction holds. That is precisely the tear C-2 was written to close — a claim
     validating against v1@g1 while the flip lands on v1@g2. */
  {
    const baseline = await ensureCertifiedBaseline();
    const cur = await getActivePointer(db, RID);
    /* 🔴 A CURRENT certified id, read here. REAL_ID names an object cell 1 deleted, so it is no longer
       in the active certified set and the pre-flight check refuses it as deleted_unknown — the cell
       would then never reach the transaction it exists to test. */
    const liveId = baseline.dishes[0].data.display.identity_id;
    assert.ok(liveId, 'premise — a currently certified id to declare');
    await declareDeletion(liveId);
    const before = await snapshotClaim();

    /* 🔴 THE BUMP MOVED, BECAUSE SLICE D ADDED A GUARD IN FRONT OF THIS ONE. It used to fire on the
       FIRST transaction, which is `acquireLease` — so the generation moved before the candidate was
       even built, and writeVersion's stamp-map fence now refuses there with
       `stamp_fence_resolved_elsewhere`. That refusal is correct and is its own cell; it is simply not
       THIS cell's property. The window the in-tx claim check alone owns is writeVersion → flip, so the
       bump fires on the SECOND transaction: publish has exactly three transaction sites — acquireLease
       (:164), flipPointer (:262) and releaseLease (:473) — and the second one IS the flip.
       🔴 AND THE COUNT IS CHECKED, NOT TRUSTED. A cell that depends on how many transactions a
       function happens to open is a cell that silently retargets when someone adds one. At fire time
       it asserts the candidate version document already exists, which is only true once writeVersion
       has committed — so if the ordering ever changes, this fails loudly instead of testing the guard
       it used to test. */
    const versionCount = async () => (await versionsColOf(db, RID).get()).size;
    const versionsBefore = await versionCount();
    const orig = db.runTransaction.bind(db);
    let calls = 0, bumped = false, bumpedAfterWrite = null;
    const racing = new Proxy(db, {
      get(t, prop) {
        if (prop === 'runTransaction') {
          return async (fn, o) => {
            calls += 1;
            // Same version, newer generation — invisible to the CAS, fatal to a claim bound at g.
            if (calls === 2 && !bumped) {
              bumped = true;
              bumpedAfterWrite = (await versionCount()) > versionsBefore;
              await activePointerRefOf().set({ version: cur.version, at: new Date(), generation: cur.generation + 1 });
            }
            return orig(fn, o);
          };
        }
        const v = t[prop];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });

    let threw = null;
    try {
      const input = { ...(await candidateFromSource()), source_sha: `tear-${Date.now()}` };
      await publishVersion(racing, RID, input, { expected: { activeVersionId: cur.version, draftRevision: await revision() } });
    } catch (e) { threw = e; }

    assert.ok(bumped, 'premise — the generation really moved between the pre-flight check and the flip');
    assert.strictEqual(bumpedAfterWrite, true,
      '🔴 the bump landed BEFORE the candidate was written, so this cell is exercising the stamp-map fence rather than the in-tx claim check — publish\'s transaction order changed under it');
    assert.ok(threw && /deleted_ids_stale_baseline/.test(String(threw.message)),
      `🔴 a claim that went stale BETWEEN the pre-flight check and the flip rode the activation through: ${threw && threw.message}`);
    assert.deepStrictEqual(await snapshotClaim(), before, '…and the claim is untouched');
    await activePointerRefOf().set({ version: cur.version, at: new Date(), generation: cur.generation });
    ok('a claim that goes stale between the pre-flight check and the flip is caught INSIDE the transaction');
  }

  // ── 6. 🔴 A STANDING CLAIM AND NO DRAFT CAS REFUSES — IT DOES NOT PUBLISH AND LEAVE IT ───
  /* Consuming means WRITING the source, and writing it without a revision to compare against would
     clobber whatever the merchant saved while the publish was in flight. So the publish that cannot
     consume is refused rather than allowed through: the alternative is an activation that carries out
     the deletion, reports success, and leaves the declaration standing to be replayed against the next
     baseline — the exact replay the binding exists to prevent.
     🔴 AND THE SOURCE IS READ EVEN WITHOUT THE CAS, which is what makes this reachable at all. While
     the claim was only read when a draftRevision was present, a publish that omitted one could not
     see the standing claim it was about to strand. */
  {
    await ensureCertifiedBaseline();
    const baseline = await readActiveVersion(db, RID);
    const liveId = baseline.dishes[0].data.display.identity_id;
    await declareDeletion(liveId);
    const standing = await snapshotClaim();
    const before = await getActivePointer(db, RID);

    let threw = null;
    try { await publishOnce({ withDraftCas: false }); } catch (e) { threw = e; }

    assert.ok(threw && /flip_claim_needs_draft_cas/.test(String(threw.message)),
      `🔴 a publish that cannot consume the standing claim activated anyway, stranding the deletion: ${threw && threw.message}`);
    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, before.version, '🔴 THE POINTER MOVED — the refusal came after the activation, not instead of it');
    assert.strictEqual(after.generation, before.generation, '…and the fence did not advance either');
    assert.deepStrictEqual(await snapshotClaim(), standing, '…and the claim is exactly as the merchant left it');
    ok('a standing claim with no draft CAS REFUSES the flip — nothing activated, nothing consumed, the declaration intact');
  }

  // ── 7. 🔴 ROLLBACK IGNORES THE CLAIM — IT NEITHER CONSUMES IT NOR IS BLOCKED BY IT ────────
  /* Two failures in opposite directions, and the explicit policy is what rules out both. A rollback
     re-activates a version from before the claim was ever declared, so it retires nothing and must not
     consume — a consumed claim here would delete the merchant's declaration and leave the object live.
     And it must not be BLOCKED either: rollback is the emergency path, and a pending deletion is not a
     reason to keep a bad menu in front of customers.
     This was true by ACCIDENT before, because rollbackVersion happens to omit draftRevision and the
     claim was only read when a CAS was present. The policy is now stated, so a rollback that did pass
     a draftRevision behaves the same way. */
  {
    /* 🔴 LAND CELL 6'S REFUSED PUBLISH FIRST, and not as tidying. Cell 6 refused AFTER declareDeletion
       had already taken the object out of the draft, so the source is short of an id the active
       certified set still has — and the only thing that accounts for it is the very claim cell 6 left
       standing. Clearing that claim and publishing would refuse as `unaccounted`, which is the
       partition law correctly reporting an incoherent fixture. So the claim is CARRIED OUT, which is
       both the honest repair and the prior version this cell needs to roll back from. */
    /* 🔴 CELL 6'S REFUSAL IS LOAD-BEARING SETUP FOR THIS CELL, so what it leaves behind is ASSERTED,
       not assumed. The failure mode of an ordered fixture is not a red cell — it is a green one: if
       cell 6's refusal ever moves, this cell quietly starts testing a different scenario and still
       passes. These four preconditions are the whole of the inherited state, stated so that a change
       upstream lands here as a named failure. */
    const inherited = await readClaim();
    assert.ok(inherited && Array.isArray(inherited.ids) && inherited.ids.length === 1,
      `precondition — cell 6 left exactly one declared id standing: ${JSON.stringify(inherited)}`);
    const orphan = inherited.ids[0];
    const draft = (await sourceRefOf(db, RID).get()).data();
    const inDraft = [...(draft.items || []), ...(draft.extras || [])]
      .some((o) => o && o.display && o.display.identity_id === orphan);
    assert.strictEqual(inDraft, false,
      'precondition — the declared object is OUT of the draft, which is why its claim is the only thing accounting for it');

    const cur = await getActivePointer(db, RID);
    assert.strictEqual(inherited.base_version, cur.version,
      'precondition — cell 6 REFUSED: its claim is still bound to the version that is live, so nothing activated underneath it');
    assert.strictEqual(inherited.base_generation, cur.generation,
      'precondition — …and to the live generation, so the publish below can consume it rather than refusing it as stale');

    /* A no-op while the baseline above is certified — and if it ever is not, it CLEARS the claim, so
       the state this cell depends on is re-checked on the far side of it rather than trusted. */
    await ensureCertifiedBaseline();
    assert.deepStrictEqual(await readClaim(), inherited,
      'precondition — re-establishing the baseline did not clear the claim out from under this cell');

    await publishOnce();
    const moved = await getActivePointer(db, RID);
    assert.notStrictEqual(moved.version, cur.version, 'premise — there is a real prior version to roll back to');
    assert.strictEqual(await readClaim(), null, 'premise — and that publish consumed it, so the claim below is the only one standing');

    const baseline = await ensureCertifiedBaseline();
    const liveId = baseline.dishes[0].data.display.identity_id;
    assert.ok(liveId, 'premise — a currently certified id to declare');

    // NOW declare a deletion, and roll back with it standing.
    await declareDeletion(liveId);
    const standing = await snapshotClaim();

    const { rollbackVersion } = require('../catalog/catalog-publish');
    /* CAUGHT, not awaited bare. The "not blocked" half of this cell is a property in its own right and
       needs its own assertion: a rollback refused by the consumption machinery would otherwise surface
       as an uncaught error attributed to whatever the suite was doing, and the one sentence that says
       WHY it matters — the emergency path is not the merchant's to gate — would never be printed. */
    let refused = null;
    try {
      await rollbackVersion(db, RID, cur.version, { expected: { activeVersionId: moved.version } });
    } catch (e) { refused = e; }
    assert.strictEqual(refused, null,
      `🔴 the rollback was REFUSED while a deletion claim was standing — a pending deletion is not the merchant's to gate the emergency path with: ${refused && refused.message}`);

    const landed = await getActivePointer(db, RID);
    assert.strictEqual(landed.version, cur.version, '🔴 the rollback did not land on its target version');
    assert.strictEqual(landed.generation, moved.generation + 1, '…and a rollback still advances the fence');
    assert.deepStrictEqual(await snapshotClaim(), standing,
      '🔴 the rollback CONSUMED a claim it never carried out — the declaration is gone and the object is still live');
    ok('a rollback with a claim standing neither consumes it nor is blocked by it — the ignore policy, stated rather than inherited from an omitted argument');
  }

  // ── 8. 🔴 CONSUMPTION REQUIRES EXECUTION — A VERSION THAT STILL CARRIES THE ID REFUSES ────
  /* The half of the partition law that consumption depends on (C ∩ D = ∅), re-checked at the write
     point against the PERSISTED candidate instead of assumed of the caller. publishVersion cannot
     reach this — its pre-flight pass refuses a draft that both carries and deletes an id — but
     flipPointer is EXPORTED, and a caller that holds a lease reaches the consumption path with no
     partition pass anywhere behind it. Without this guard that flip clears a declaration nothing
     executed: the id stays live, the merchant's deletion is gone, and the publish reports success.
     Driven through flipPointer directly, because that is the caller the guard exists for. */
  {
    await ensureCertifiedBaseline();
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    const live = await getActivePointer(db, RID);
    const baseline = await readActiveVersion(db, RID);
    const carriedId = baseline.dishes[0].data.display.identity_id;
    assert.ok(carriedId, 'premise — an id the LIVE version genuinely carries');

    /* Written straight onto the source WITHOUT removing the object, which is the incoherent state
       the pre-flight pass exists to refuse and a direct flip never sees. */
    await sourceRefOf(db, RID).update({ deleted_ids: claimOf([carriedId], live.version, live.generation) });
    const standing = await snapshotClaim();

    const { acquireLease, flipPointer, releaseLease } = require('../catalog/catalog-publish');
    const snapshot = (await require('../catalog/catalog-publish').snapshotRefOf(db, RID).get()).data();
    assert.strictEqual(snapshot.version, live.version, 'premise — the live snapshot describes the live version');

    const token = await acquireLease(db, RID);
    let threw = null;
    try {
      await flipPointer(db, RID, token, live.version, snapshot,
        { activeVersionId: live.version, draftRevision: await revision() });
    } catch (e) { threw = e; } finally { await releaseLease(db, RID, token); }

    assert.ok(threw && /flip_claim_not_executed/.test(String(threw.message)),
      `🔴 a flip consumed a deletion claim naming an id the version still carries: ${threw && threw.message}`);
    assert.ok(/carries/.test(String(threw.message)) && String(threw.message).includes(carriedId),
      '…and the refusal names the id that was not retired');
    assert.deepStrictEqual(await snapshotClaim(), standing, '…and the claim is untouched');
    assert.strictEqual((await getActivePointer(db, RID)).generation, live.generation,
      '…and nothing activated');
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    ok('a flip whose version still CARRIES a claimed id refuses rather than consuming a deletion nobody executed');
  }

  // ── 9. 🔴 AN INERT CLAIM IS NOT A DECLARATION — IT MUST NOT DRAG THE CAS REQUIREMENT IN ──
  /* A claim that is present but declares no ids retires nothing, so there is nothing to consume and
     nothing to strand. Refusing a publish over one would be friction bought for nothing, and friction
     on the safe path is exactly how a requirement gets weakened on the UNSAFE path — the CAS rule in
     cell 6 is worth keeping strict precisely because it never fires where it is pointless.
     Driven through flipPointer with no draftRevision, and asserted as the error it is NOT: the flip
     still refuses, because the live version is already `activated` and this is an activate intent,
     and that is the whole evidence — the inert claim did not change which refusal we got. */
  {
    const live = await getActivePointer(db, RID);
    await sourceRefOf(db, RID).update({ deleted_ids: { ids: [], base_version: live.version, base_generation: live.generation } });
    const { acquireLease, flipPointer, releaseLease, snapshotRefOf } = require('../catalog/catalog-publish');
    const snapshot = (await snapshotRefOf(db, RID).get()).data();
    const token = await acquireLease(db, RID);
    let threw = null;
    try {
      await flipPointer(db, RID, token, live.version, snapshot, { activeVersionId: live.version });
    } catch (e) { threw = e; } finally { await releaseLease(db, RID, token); }

    assert.ok(threw, 'premise — this flip refuses for its own reasons; the cell is about WHICH reason');
    assert.ok(!/flip_claim_needs_draft_cas/.test(String(threw.message)),
      `🔴 a claim declaring NO ids triggered the consumption CAS requirement — a publish refused over a deletion that would have been a no-op: ${threw.message}`);
    assert.ok(/flip_activation_not_pending/.test(String(threw.message)),
      `sensitivity — it refused on the activation record, the reason that has nothing to do with the claim: ${threw.message}`);
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    ok('a claim declaring no ids is inert — it neither consumes nor demands a draft CAS');
  }

  FINISHED = true;
  console.log(`d4p1-claim(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 CLAIM (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
