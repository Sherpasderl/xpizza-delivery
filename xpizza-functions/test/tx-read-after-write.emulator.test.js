'use strict';
/**
 * Does Firestore actually refuse a READ AFTER A WRITE inside a transaction?
 * Run: npm run test:tx-read-after-write
 *
 * 🔴 WHY THIS EXISTS AT ALL. Something like a dozen comments in this tree rest on that sentence —
 * "EVERY READ FIRST — a Firestore transaction refuses a read after a write" (identity-registry.js),
 * "Gather ALL destination, claimant, fence, reservation, source and activation reads BEFORE any
 * write (Firestore refuses a read after a write)" (§4), and the ordering half of rule 17 everywhere
 * else. Neither the advisor nor I had ever WATCHED it happen. It was a belief the whole ordering
 * discipline was resting on, held because it is written down.
 *
 * The identity fake does NOT model it — recorded in catalog/firestore-fake.js — which is exactly why
 * no fake-based cell can carry this and why it has to be here.
 *
 * 🔴 AND IT IS THE ONLY MECHANICAL ENFORCEMENT AVAILABLE FOR ORDERING. A pure predicate cannot see
 * when its caller read. Cells asserting "the read comes first" by inspecting source are documentation
 * wearing a test's clothes. If the DATABASE refuses it, the ordering is enforced by the thing that
 * actually runs, and a writer that reorders its reads fails in the emulator rather than in review.
 *
 * If this suite ever reports that the emulator PERMITS a read after a write, stop: the blast radius
 * is every "reads first" claim in the tree, not one slice.
 */
require('./_emulator-required')('firestore');

const assert = require('assert');
const admin = require('firebase-admin');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('tx-read-after-write: FAILED — exited without completing'); process.exitCode = 1; } });

if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza' });
const db = admin.firestore();

const RID = `txraw-${Date.now()}`;
const col = () => db.collection('tx_read_after_write').doc(RID).collection('docs');

(async () => {
  await col().doc('a').set({ v: 1 });
  await col().doc('b').set({ v: 2 });

  // ── 1. READ-THEN-WRITE IS THE ORDINARY CASE AND MUST COMMIT ────────────────────────────────
  {
    /* The non-vacuity floor for everything below: if transactions were broken in this emulator, cell
       2 would "pass" by failing for an unrelated reason. */
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(col().doc('a'));
      assert.strictEqual((snap.data() || {}).v, 1, 'premise: the read sees what was written');
      tx.set(col().doc('a'), { v: 10 });
    });
    assert.strictEqual((await col().doc('a').get()).data().v, 10, 'premise: an ordinary read-then-write transaction commits');
    ok('read-then-write commits normally — transactions work in this emulator, so cell 2 is not passing by accident');
  }

  // ── 2. 🔴 THE CLAIM ITSELF: A READ AFTER A WRITE, IN THE SAME TRANSACTION ──────────────────
  {
    let threw = null;
    let readResolved = false;
    try {
      await db.runTransaction(async (tx) => {
        tx.set(col().doc('a'), { v: 99 });          // WRITE first
        const snap = await tx.get(col().doc('b'));  // then READ — the thing the tree says is refused
        readResolved = true;
        tx.set(col().doc('b'), { v: (snap.data() || {}).v + 1 });
      });
    } catch (e) { threw = (e && e.message) || String(e); }

    assert.ok(threw,
      `🔴🔴 THE EMULATOR PERMITTED A READ AFTER A WRITE INSIDE A TRANSACTION. Every "reads first" comment in this tree rests on it being refused — identity-registry.js, identity-restore.js, the flip, §4, and rule 17's ordering half. STOP AND REPORT THIS: the blast radius is the whole ordering discipline, not one slice. (read resolved: ${readResolved})`);
    /* 🔴 THE EXACT WORDING, RECORDED THE FIRST TIME IT WAS ACTUALLY OBSERVED (2026-09-25, Firestore
       emulator): "Firestore transactions require all reads to be executed before all writes."
       Pinned rather than matched loosely, because "it threw" is not the claim — the claim is that it
       threw FOR THIS REASON. A transaction can also fail on contention, on a missing document, or on
       a client bug, and every one of those would satisfy a bare `assert.ok(threw)` while telling us
       nothing about ordering. If this assertion ever fails because the wording changed, widen it
       deliberately; if it fails because the error is now something else entirely, that is the finding. */
    assert.ok(/all reads to be executed before all writes/i.test(threw),
      `🔴 it refused, but NOT for the reason claimed — the ordering may be enforced by something else, or this cell may be measuring an unrelated failure: ${threw}`);

    /* 🔴 AND THE WRITE DID NOT LAND. A refusal that still committed the first write would be worse
       than no refusal: the ordering error would be reported AND half-applied. */
    assert.strictEqual((await col().doc('a').get()).data().v, 10,
      '🔴 the refused transaction committed its first write anyway — the abort is not atomic');
    ok('a read after a write in the SAME transaction is REFUSED by the database, by name, and the transaction commits nothing');
  }

  // ── 3. THE BOUNDARY: A WRITE TO ONE DOC DOES NOT LICENSE A LATER READ OF ANOTHER ───────────
  {
    /* Checked separately because the natural misreading is "you cannot re-read what you wrote". It is
       stronger than that: ANY read after ANY write is refused, which is why the discipline is "gather
       every read first" rather than "do not read back your own writes". Cell 2 already reads a
       DIFFERENT document; this pins the same-document case so both are on record. */
    let threw = null;
    try {
      await db.runTransaction(async (tx) => {
        tx.set(col().doc('a'), { v: 100 });
        await tx.get(col().doc('a'));
      });
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw, '🔴 re-reading a document this transaction already wrote was permitted');
    ok('the rule is ANY read after ANY write, not merely re-reading what you wrote — which is why the discipline is "gather every read first"');
  }

  // cleanup: the suite owns a unique RID, so this cannot touch another run's data
  for (const d of (await col().get()).docs) await d.ref.delete();

  FINISHED = true;
  console.log(`tx-read-after-write: OK (${n})`);
})().catch((e) => { console.error('tx-read-after-write FAILED:', (e && e.message) || e); process.exit(1); });
