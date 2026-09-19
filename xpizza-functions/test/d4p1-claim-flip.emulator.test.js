'use strict';
// Portal 1D · D4-P1 Slice C — THE DELETION CLAIM AT THE WRITE BOUNDARY, ON THE REAL FLIP.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4p1-claim
//
// 🔴 WHY THIS CANNOT BE A UNIT TEST. Every property here is about what happens INSIDE the flip
// transaction: that the claim is re-verified against the pointer pair that same transaction
// CAS-verifies, that consuming it and activating the version stand or fall together, and that a draft
// which moved underneath aborts the whole thing rather than clobbering a newer claim. A fake can be
// made to agree with any of that; only the real transaction engine decides it.
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

  // ── 1. 🔴 C VALIDATES THE CLAIM AND LEAVES IT STANDING — CONSUMPTION BELONGS TO D ─────────
  /* A cleared claim must mean "carried out", never "dropped". C has no writer that retires the
     declared ids, so clearing here would discard a merchant's declared intent while reporting
     success — strictly worse than leaving it. It survives, and goes stale at the next baseline, which
     is correct: C alone is not a deploy target. Consumption arrives with D's activation writer, which
     is the thing that actually executes the deletion. */
  {
    await declareDeletion(REAL_ID);
    const standing = (await sourceRefOf(db, RID).get()).data().deleted_ids;

    await publishOnce();
    assert.deepStrictEqual(await readClaim(), standing,
      '🔴 the claim was CONSUMED by an activation that retires nothing — a declared deletion silently discarded while the publish reports success');
    ok('a valid claim is validated and left STANDING — C never clears what it cannot carry out');
  }

  // ── 2. 🔴 A DRAFT THAT MOVED UNDER THE PUBLISH ABORTS EVERYTHING ──────────────────────────
  /* The N+1 race. The merchant saves a NEWER revision while this publish is in flight: the flip must
     abort, and the evidence is that the POINTER does not move — nothing activated. (The claim being
     intact is not evidence here, since C writes the source at all.) */
  {
    /* 🔴 CLEAR THE STANDING CLAIM FIRST. C validates but does not consume, so cell 1's claim is still
       there and is now stale against the baseline its own publish advanced — the pre-flip check would
       refuse this publish for that reason and the cell would "pass" its abort assertion for entirely
       the wrong cause. */
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
  /* 🔴 ALSO A PRE-FLIGHT CELL. The flip carries the same malformed check, but nothing can reach it:
     an already-malformed claim is refused here, and making one malformed later means writing the
     source, which moves its revision and trips the draft CAS first. That branch is documented in the
     source as defence in depth with no mutant, rather than covered by a cell that appears to exercise
     it and does not. */
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

    const orig = db.runTransaction.bind(db);
    let bumped = false;
    const racing = new Proxy(db, {
      get(t, prop) {
        if (prop === 'runTransaction') {
          return async (fn, o) => {
            // Same version, newer generation — invisible to the CAS, fatal to a claim bound at g.
            if (!bumped) { bumped = true; await activePointerRefOf().set({ version: cur.version, at: new Date(), generation: cur.generation + 1 }); }
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
    assert.ok(threw && /deleted_ids_stale_baseline/.test(String(threw.message)),
      `🔴 a claim that went stale BETWEEN the pre-flight check and the flip rode the activation through: ${threw && threw.message}`);
    assert.deepStrictEqual(await snapshotClaim(), before, '…and the claim is untouched');
    await activePointerRefOf().set({ version: cur.version, at: new Date(), generation: cur.generation });
    ok('a claim that goes stale between the pre-flight check and the flip is caught INSIDE the transaction');
  }

  FINISHED = true;
  console.log(`d4p1-claim(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 CLAIM (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
