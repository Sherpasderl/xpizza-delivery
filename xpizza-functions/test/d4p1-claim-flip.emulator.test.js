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

  // ── 1. A STANDING CLAIM IS CONSUMED BY THE ACTIVATION THAT USES IT ─────────────────────────
  {
    const live = await getActivePointer(db, RID);
    await sourceRefOf(db, RID).update({ deleted_ids: claimOf(['DOOMED1'], live.version, live.generation) });
    assert.ok(await readClaim(), 'premise — a claim is standing against the live baseline');

    await publishOnce();
    assert.strictEqual(await readClaim(), null,
      '🔴 the claim survived the activation that consumed it — the next edit would replay it against a new baseline');
    ok('a standing claim declared against the live baseline is cleared by the activation that consumes it');
  }

  // ── 2. 🔴 A DRAFT THAT MOVED UNDER THE PUBLISH ABORTS EVERYTHING ──────────────────────────
  /* The N+1 race. The merchant saves a NEWER revision, carrying a fresh deletion, while this publish
     is in flight. The flip must refuse rather than clear — and note WHY the newer claim survives: not
     because the clear is clever, but because the CAS aborts the whole transaction, so nothing is
     written at all. */
  {
    const live = await getActivePointer(db, RID);
    const before = await getActivePointer(db, RID);
    const newer = claimOf(['SAVED-WHILE-IN-FLIGHT'], live.version, live.generation);

    let threw = null;
    try {
      await publishOnce({ mutateBeforeFlip: async () => { await sourceRefOf(db, RID).update({ deleted_ids: newer }); } });
    } catch (e) { threw = e; }

    assert.ok(threw && /flip_cas_draft_stale/.test(String(threw.message)),
      `🔴 a publish whose draft moved underneath did not abort: ${threw && threw.message}`);
    assert.deepStrictEqual(await readClaim(), newer,
      '🔴 THE NEWER CLAIM WAS WIPED by a publish that never activated — the merchant lost a deletion they had just saved');
    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, before.version, '…and the pointer did not move either');
    ok('a draft saved while the publish was in flight aborts the flip — the newer claim is intact and nothing activated');
  }

  // ── 3. 🔴 A CLAIM CANNOT BE CONSUMED WITHOUT A DRAFT CAS TO PROTECT THE WRITE ─────────────
  /* Consuming a claim means writing the source. Without a revision to compare against, that write
     would clobber whatever the merchant saved in the meantime — so a standing claim plus no CAS
     REFUSES rather than publishing and leaving the deletion to be replayed. Protected by
     construction, not by the caller remembering to pass an argument. */
  {
    const live = await getActivePointer(db, RID);
    const standing = claimOf(['NEEDS-CAS'], live.version, live.generation);
    await sourceRefOf(db, RID).update({ deleted_ids: standing });

    let threw = null;
    try { await publishOnce({ withDraftCas: false }); } catch (e) { threw = e; }
    assert.ok(threw && /publish_claim_without_cas/.test(String(threw.message)),
      `🔴 a claim was consumable with no draft revision to protect the write: ${threw && threw.message}`);
    assert.deepStrictEqual(await readClaim(), standing, '…and the claim is untouched');

    // SENSITIVITY: the same publish WITH the CAS succeeds and consumes it, so the refusal is about
    // the missing CAS and not about the claim being unwelcome.
    await publishOnce({ withDraftCas: true });
    assert.strictEqual(await readClaim(), null, 'non-vacuity: with the CAS present the same claim is consumed');
    ok('a standing claim with no draft CAS refuses; the same claim with the CAS is consumed normally');
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

  FINISHED = true;
  console.log(`d4p1-claim(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 CLAIM (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
