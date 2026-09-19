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
const { sourceRefOf, encodeUpdateTime, canonicalize } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActivePointer } = require('../catalog/catalog-firestore');

const RID = 'x_pizza';
const claimOf = (ids, v, g) => ({ ids, base_version: v, base_generation: g });
const readClaim = async () => ((await sourceRefOf(db, RID).get()).data() || {}).deleted_ids;
const revision = async () => encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime);

async function seedSource() {
  await sourceRefOf(db, RID).set(canonicalize(buildSourceFromCode(RID)));
}
async function publishOnce({ withDraftCas = true, mutateBeforeFlip = null } = {}) {
  const live = await getActivePointer(db, RID);
  const { input } = buildPublishCandidate(RID, { activeVersionId: live.version }, { source_sha: `claim-${Date.now()}` });
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

  // ── 1. 🔴 C VALIDATES THE CLAIM AND LEAVES IT STANDING — CONSUMPTION BELONGS TO D ─────────
  /* A cleared claim must mean "carried out", never "dropped". C has no writer that retires the
     declared ids, so clearing here would discard a merchant's declared intent while reporting
     success — strictly worse than leaving it. It survives, and goes stale at the next baseline, which
     is correct: C alone is not a deploy target. Consumption arrives with D's activation writer, which
     is the thing that actually executes the deletion. */
  {
    const live = await getActivePointer(db, RID);
    const standing = claimOf(['DOOMED1'], live.version, live.generation);
    await sourceRefOf(db, RID).update({ deleted_ids: standing });

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
    const before = await getActivePointer(db, RID);
    const newer = claimOf(['SAVED-WHILE-IN-FLIGHT'], before.version, before.generation);

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

  // ── 4. 🔴 A STALE CLAIM IS REFUSED AT THE WRITE BOUNDARY, NOT MERELY BEFORE IT ────────────
  /* C-2: the check runs inside the flip, against the pointer pair that transaction CAS-verifies. A
     claim bound to a superseded baseline must not ride an activation through. */
  {
    await sourceRefOf(db, RID).update({ deleted_ids: claimOf(['STALE1'], 'v-long-gone', 0) });
    let threw = null;
    try { await publishOnce(); } catch (e) { threw = e; }
    assert.ok(threw && /deleted_ids_stale_baseline/.test(String(threw.message)),
      `🔴 a claim from a superseded baseline rode the activation through: ${threw && threw.message}`);
    assert.ok(await readClaim(), '…and it is left standing for the merchant to re-review');
    await sourceRefOf(db, RID).update({ deleted_ids: null });
    ok('a claim bound to a superseded baseline is refused INSIDE the flip, against the pair that transaction verified');
  }

  // ── 5. 🔴 A MALFORMED CLAIM IS REFUSED, NOT WAVED THROUGH ─────────────────────────────────
  /* Both publish-side checks used to gate on "a non-empty array of ids", so the shapes LEAST likely
     to be honest — a string, a bare list, an object — skipped validation entirely while a well-formed
     claim was scrutinised. Any present, non-null claim is now validated. Top-level null stays the
     cleared sentinel, and must keep publishing cleanly or the fix has broken the normal path. */
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
  ok('three malformed claim shapes refuse by name; the top-level null sentinel still publishes cleanly');

  FINISHED = true;
  console.log(`d4p1-claim(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 CLAIM (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
