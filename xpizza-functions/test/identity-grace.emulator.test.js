'use strict';
// Portal 1D · D4-grace — THE SELF-HEAL AND THE FORWARD RESOLVER, AGAINST THE REAL FIRESTORE ENGINE.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:identity-grace
//
// 🔴 WHY THIS EXISTS ALONGSIDE catalog/identity-grace.test.js. The node suite proves D4's logic against
// memFirestore and runs on every `npm test`; that is where the money-no-op, the forgery refusal, the
// trichotomy and the freshness race live, because those are decided by OUR code and a model store is
// the right instrument for them. This file covers the properties whose truth is decided by FIRESTORE,
// not by us — and which a model store therefore cannot evidence:
//
//   · ADOPTION UNDER CONTENTION. The writer guard's whole claim is that a QUERY read and a key-row
//     read inside ONE transaction serialize, so two racing ensureIdentity calls on an orphan converge
//     on adopting the same id instead of one adopting and one minting a duplicate. memFirestore models
//     re-run on a contended DOCUMENT; whether the real engine serializes a transaction whose read was
//     a QUERY over the ids collection is a different question, and it is the exact question the
//     duplicate-id fix rests on. This build has caught a fake diverging from production seven times.
//   · QUERY SEMANTICS. `where('status','==','live')` is what keeps a RETIRED id from being revived
//     into a new object's identity. That filter is the entire reservation guarantee at this seam.
//   · THE SWEEP'S RE-READ GUARD racing a live adoption, on the engine that actually arbitrates them.
//
// If any of these is false in production, D4's self-heal does not heal — it mints the duplicate it was
// written to prevent, at the exact moment a registry is being repaired. Under grace that is invisible;
// at enforce it is historical data nobody can reconstruct.
const assert = require('assert');
const admin = require('firebase-admin');
const {
  ensureIdentity, retireIdentity, resolveLegacyByIds, _resetResolveCache,
  encodeKey, STATUS_LIVE, STATUS_RETIRED, RESOLVE_MAX_LOOKUPS,
} = require('../catalog/identity-registry');
const { sweepIdentityIntegrity } = require('../catalog/identity-sweep');

admin.initializeApp({ projectId: 'demo-xpizza' });   // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-grace(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const dishDoc = (rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind);
const idsCol = (rid, kind) => dishDoc(rid, kind).collection('ids');
const keysCol = (rid, kind) => dishDoc(rid, kind).collection('keys');
const keyRowOf = (rid, kind, legacyKey) => keysCol(rid, kind).doc(encodeKey(legacyKey));
const liveIdsFor = async (rid, kind, legacyKey) =>
  (await idsCol(rid, kind).get()).docs.filter((d) => {
    const x = d.data() || {};
    return x.legacy_key === legacyKey && x.status === STATUS_LIVE;
  });

/* Stage the exact corruption D4 exists for: a LIVE id row whose reverse row is gone. Minted by the
   real ensureIdentity — not hand-written — so the orphan has production's own field shape. */
async function stageOrphan(rid, kind, legacyKey) {
  const { canonical_id } = await ensureIdentity(db, { rid, kind, legacyKey });
  await keyRowOf(rid, kind, legacyKey).delete();
  assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).exists, false,
    `premise — ${rid}/${kind}/${legacyKey} really is orphaned`);
  return canonical_id;
}

/* The real db, wrapped ONLY to count transaction attempts. attempts > calls is direct evidence the
   engine made a contender re-run — without it a green result cannot distinguish "Firestore serialized
   them" from "the calls never actually overlapped", and only the first is the guarantee. */
function countingDb() {
  let attempts = 0;
  return {
    attempts: () => attempts,
    db: {
      collection: (c) => db.collection(c),
      runTransaction: (fn, opts) => db.runTransaction(async (tx) => { attempts += 1; return fn(tx); }, opts),
    },
  };
}

/* Counts DOCUMENT reads, so "deduped", "budgeted" and "an invalid id costs no read" are measured
   rather than asserted about. The resolver reaches Firestore only as idsColOf(fs,…).doc(id).get(). */
function countingFs() {
  let reads = 0;
  const wrapDoc = (d) => ({
    id: d.id,
    get: async () => { reads += 1; return d.get(); },
    collection: (c) => wrapCol(d.collection(c)),
  });
  const wrapCol = (c) => ({
    doc: (id) => wrapDoc(c.doc(id)),
    where: (...a) => c.where(...a),
    get: () => c.get(),
  });
  return { reads: () => reads, fs: { collection: (c) => wrapCol(db.collection(c)) } };
}

(async () => {
  // ── 1. RACING ADOPTION CONVERGES ON ONE ID — NO DUPLICATE MINTED ──────────────────────────────
  /* §7: "Concurrency: two racing ensureIdentity on the orphan converge to one id." This is the cell
     the node suite cannot stand in for. Both brands, because the mint path differs (x_pizza mints a
     random token; la_musa is grandfathered and mints its slug) while the ADOPTION path is shared —
     and a shared guard that only ever runs on one brand is a guard with half its coverage. */
  for (const [rid, kind, legacyKey, contenders] of [
    ['x_pizza', 'dish', 'Carnivora', 6],
    ['la_musa', 'dish', 'dimsum_01', 5],
  ]) {
    const orphanId = await stageOrphan(rid, kind, legacyKey);
    const { db: counting, attempts } = countingDb();

    // Started synchronously into the array, THEN awaited — genuinely in flight together.
    const calls = [];
    for (let i = 0; i < contenders; i += 1) calls.push(ensureIdentity(counting, { rid, kind, legacyKey }));
    const out = await Promise.all(calls);

    const ids = new Set(out.map((r) => r.canonical_id));
    assert.strictEqual(ids.size, 1,
      `🔴 ${contenders} racing adoptions of one orphan produced ${ids.size} ids — the split identity D4 exists to prevent`);
    assert.strictEqual([...ids][0], orphanId,
      '🔴 …and the surviving id must be the ORPHAN\'s — a fresh mint here IS the duplicate, even when all contenders agree on it');
    assert.ok(out.every((r) => r.created !== true),
      '🔴 a contender reported created:true — it minted rather than adopted');
    assert.ok(out.some((r) => r.adopted === true), 'at least one call took the adoption path');

    const live = await liveIdsFor(rid, kind, legacyKey);
    assert.strictEqual(live.length, 1,
      `🔴 ${live.length} live id rows claim ${legacyKey} — a duplicate was minted beside the orphan`);
    assert.strictEqual(live[0].id, orphanId, 'the one live row is the original');
    const healed = await keyRowOf(rid, kind, legacyKey).get();
    assert.strictEqual((healed.data() || {}).canonical_id, orphanId, '🔴 the reverse row was not repaired to the adopted id');
    assert.ok(attempts() > out.length,
      `🔴 ${attempts()} attempts for ${out.length} calls — nothing re-ran, so this run never actually contended and proves nothing about serialization`);
    ok(`${rid}: ${contenders} racing adoptions converge on the orphan's own id (${attempts()} attempts, 1 live row, reverse row healed)`);
  }

  // ── 2. A RETIRED ID IS NEVER REVIVED — THE SENSITIVITY PARTNER TO CELL 1 ──────────────────────
  /* Identical staging to cell 1 in every respect but ONE: the surviving id row is retired rather than
     live. If `where('status','==','live')` did not bite, this cell would adopt exactly as cell 1 does
     — which is what makes the pair falsifiable instead of two runs of the same assertion. Retirement
     deletes the reverse row itself, so this is not a contrived state: it is the precise shape a
     re-created object arrives in. */
  {
    const rid = 'x_pizza', kind = 'dish', legacyKey = 'Retirada';
    const { canonical_id: retiredId } = await ensureIdentity(db, { rid, kind, legacyKey });
    const r = await retireIdentity(db, { rid, kind, canonicalId: retiredId });
    assert.strictEqual(r.retired, true, 'premise — it really was retired');
    assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).exists, false,
      'premise — retirement removed the reverse row, leaving exactly cell 1\'s shape but retired');

    const again = await ensureIdentity(db, { rid, kind, legacyKey });
    assert.notStrictEqual(again.canonical_id, retiredId,
      '🔴 THE RETIRED ID WAS HANDED BACK OUT — every historical record naming it now resolves to a different object');
    assert.strictEqual(again.created, true, 'the re-created object gets a genuine fresh mint, not an adoption');
    const retiredRow = await idsCol(rid, kind).doc(retiredId).get();
    assert.strictEqual((retiredRow.data() || {}).status, STATUS_RETIRED, 'the retired row stays retired');
    ok(`${rid}: a retired id is NOT adopted — the re-created object mints fresh and the reservation holds`);
  }

  // ── 3. TWO LIVE IDS FOR ONE KEY IS REFUSED AND REPORTED, NEVER ARBITRATED ─────────────────────
  /* The corruption the guard must not "fix". Picking a winner would make the loser's historical orders
     unresolvable AND hide that it ever happened. Hand-written rows, because ensureIdentity by
     construction cannot produce this state — that is the point. */
  {
    const rid = 'x_pizza', kind = 'dish', legacyKey = 'Doble';
    await idsCol(rid, kind).doc('AAAAAAAAAA').set({ legacy_key: legacyKey, status: STATUS_LIVE, kind, created_at: 'x' });
    await idsCol(rid, kind).doc('BBBBBBBBBB').set({ legacy_key: legacyKey, status: STATUS_LIVE, kind, created_at: 'x' });

    await assert.rejects(
      () => ensureIdentity(db, { rid, kind, legacyKey }),
      (e) => /identity_conflicting_live_ids/.test(String(e && e.message)) && String(e.message).includes(legacyKey),
      '🔴 a two-live-id conflict did not refuse by name — it either picked a winner or minted a third',
    );
    assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).exists, false,
      '🔴 a reverse row was written for a conflicted key — that IS picking a winner');
    assert.strictEqual((await liveIdsFor(rid, kind, legacyKey)).length, 2,
      '🔴 the id row count moved — the refusal was not clean');
    ok(`${rid}: two live ids for one key → refused by name, no winner picked, no third id`);
  }

  // ── 4. THE SWEEP REPAIRS AN ORPHAN, IDEMPOTENTLY, AND TOUCHES NOTHING ELSE ────────────────────
  {
    const rid = 'la_musa', kind = 'extra', legacyKey = 'salsa_ponzu';
    // Healthy neighbours, so "does not touch healthy rows" is measured against real rows, not an empty set.
    for (const k of ['salsa_soja', 'salsa_picante']) await ensureIdentity(db, { rid, kind, legacyKey: k });
    const orphanId = await stageOrphan(rid, kind, legacyKey);
    const before = new Map((await keysCol(rid, kind).get()).docs.map((d) => [d.id, JSON.stringify(d.data())]));

    const r1 = await sweepIdentityIntegrity(db, rid, kind);
    assert.strictEqual(r1.repaired, 1, `🔴 the sweep repaired ${r1.repaired} rows, expected exactly the one orphan`);
    assert.strictEqual(r1.conflicts, 0, 'no conflict here');
    assert.strictEqual(r1.errors, 0, 'no errors');
    const healed = await keyRowOf(rid, kind, legacyKey).get();
    assert.strictEqual((healed.data() || {}).canonical_id, orphanId, '🔴 repaired to the wrong id');
    const firstRepairedAt = (healed.data() || {}).repaired_at;
    assert.ok(firstRepairedAt, 'the repair is stamped, so an operator can see it happened');

    // Healthy rows byte-unchanged.
    for (const [id, json] of before) {
      const now = await keysCol(rid, kind).doc(id).get();
      assert.strictEqual(JSON.stringify(now.data()), json, `🔴 the sweep rewrote a HEALTHY reverse row (${id})`);
    }

    // Idempotent: a second run must no-op via the in-transaction re-read, not rewrite with a fresh stamp.
    const r2 = await sweepIdentityIntegrity(db, rid, kind);
    assert.strictEqual(r2.repaired, 0, `🔴 the re-run repaired ${r2.repaired} again — the re-read guard did not fire`);
    assert.strictEqual(r2.orphans, 0, 'and it sees no orphan the second time');
    assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).data().repaired_at, firstRepairedAt,
      '🔴 the stamp moved on a no-op run — the row was rewritten, so "idempotent" is a count, not a fact');
    ok(`${rid}: the sweep repairs the one orphan, re-runs as a true no-op, and leaves ${before.size} healthy rows byte-identical`);
  }

  // ── 5. THE SWEEP NEVER REVIVES A RETIRED ID EITHER ───────────────────────────────────────────
  /* Cell 2's property for the OTHER healer. A retired id row with no reverse row looks exactly like an
     orphan to anything that does not filter on status — and the sweep WRITES reverse rows, so if its
     query drifted it would hand a reserved id back out on a schedule, unattended. */
  {
    const rid = 'x_pizza', kind = 'extra', legacyKey = 'Extra Retirado';
    const { canonical_id: retiredId } = await ensureIdentity(db, { rid, kind, legacyKey });
    await retireIdentity(db, { rid, kind, canonicalId: retiredId });
    const r = await sweepIdentityIntegrity(db, rid, kind);
    assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).exists, false,
      '🔴 THE SWEEP RESURRECTED A RETIRED ID into a live reverse row');
    assert.ok(r.repaired === 0 || !(await keyRowOf(rid, kind, legacyKey).get()).exists,
      'nothing was repaired toward the retired id');
    ok(`${rid}: a retired id with no reverse row is left alone by the sweep — reservation holds on the unattended path too`);
  }

  // ── 6. THE SWEEP'S RE-READ LOSES TO A LIVE ADOPTION RATHER THAN OVERWRITING IT ────────────────
  /* Both healers can reach one orphan at once. The sweep's scan is a snapshot; by commit time an
     ordinary order may already have adopted. Repairing on the scan's word would overwrite a fresher
     row with a stale one. They must converge on ONE id, whichever wins. */
  {
    const rid = 'x_pizza', kind = 'dish', legacyKey = 'Concurrente';
    const orphanId = await stageOrphan(rid, kind, legacyKey);
    const [, adopted] = await Promise.all([
      sweepIdentityIntegrity(db, rid, kind),
      ensureIdentity(db, { rid, kind, legacyKey }),
    ]);
    assert.strictEqual(adopted.canonical_id, orphanId, 'the order path adopted the orphan');
    const live = await liveIdsFor(rid, kind, legacyKey);
    assert.strictEqual(live.length, 1, `🔴 sweep and writer racing produced ${live.length} live ids`);
    assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).data().canonical_id, orphanId,
      '🔴 the two healers disagreed about the reverse row');
    ok(`${rid}: sweep and writer racing one orphan converge on a single id and one reverse row`);
  }

  // ── 7. THE FORWARD RESOLVER ON THE REAL ENGINE — TRICHOTOMY AND THE ROUND TRIP ────────────────
  /* forward ∘ reverse == identity, measured rather than assumed: the key ensureIdentity minted FOR is
     the key the resolver hands back. Plus the three outcomes, kept distinct where the store is real. */
  {
    _resetResolveCache();
    const rid = 'x_pizza', kind = 'dish';
    const keys = ['Hawaiana', 'Pepperoni', 'Margarita'];
    const minted = [];
    for (const k of keys) minted.push((await ensureIdentity(db, { rid, kind, legacyKey: k })).canonical_id);

    const retiredKey = 'Temporal';
    const { canonical_id: retiredId } = await ensureIdentity(db, { rid, kind, legacyKey: retiredKey });
    await retireIdentity(db, { rid, kind, canonicalId: retiredId });

    const absentId = 'ZZZZZZZZZZ';
    const { fs, reads } = countingFs();
    const { byId, incomplete } = await resolveLegacyByIds(fs, rid, kind, [
      ...minted, ...minted,          // the duplicates must cost nothing
      retiredId, absentId, '', 'bad/id',
    ]);

    minted.forEach((id, i) => {
      assert.deepStrictEqual(
        { outcome: byId.get(id).outcome, legacyKey: byId.get(id).legacyKey },
        { outcome: 'resolved', legacyKey: keys[i] },
        `🔴 the forward direction disagrees with what was minted for ${keys[i]} — the round trip is broken`,
      );
    });
    assert.deepStrictEqual(
      { r: byId.get(retiredId).outcome, a: byId.get(absentId).outcome },
      { r: 'unresolved', a: 'unresolved' },
      'retired and absent are both ANSWERS — definitively not a live object',
    );
    assert.strictEqual(byId.get(retiredId).reason, 'retired', 'and they stay distinguishable by reason');
    assert.strictEqual(byId.get(absentId).reason, 'absent', 'absent is not retired');
    assert.strictEqual(byId.get('bad/id').reason, 'invalid_id', 'a malformed id is refused without a read');
    assert.strictEqual(incomplete, false, 'nothing here is a read_error — the registry answered everything');
    assert.strictEqual(reads(), minted.length + 2,
      `🔴 ${reads()} reads for ${minted.length + 2} distinct readable ids — duplicates or invalid shapes reached Firestore`);
    ok(`${rid}: forward ∘ reverse == identity on the real engine; retired/absent/invalid stay distinct in ${reads()} deduped reads`);
  }

  // ── 8. THE FAN-OUT BUDGET BOUNDS REAL READS — OVERFLOW IS read_error, NOT A REFUSAL ───────────
  /* §7's budget cell against the store that would actually feel it. The count is what matters: a
     resolver that "handles" overflow after issuing every read has not bounded anything. */
  {
    _resetResolveCache();
    const rid = 'x_pizza', kind = 'extra';
    const over = RESOLVE_MAX_LOOKUPS + 7;
    const ids = [];
    for (let i = 0; i < over; i += 1) {
      ids.push((await ensureIdentity(db, { rid, kind, legacyKey: `Budget ${i}` })).canonical_id);
    }
    const { fs, reads } = countingFs();
    const { byId, incomplete } = await resolveLegacyByIds(fs, rid, kind, ids);

    assert.strictEqual(reads(), RESOLVE_MAX_LOOKUPS,
      `🔴 the budget is ${RESOLVE_MAX_LOOKUPS} but ${reads()} reads were issued — nothing is bounded on the charge path`);
    const resolved = ids.filter((id) => byId.get(id).outcome === 'resolved').length;
    const overflow = ids.filter((id) => byId.get(id).outcome === 'read_error' && byId.get(id).reason === 'budget_exceeded').length;
    assert.strictEqual(resolved, RESOLVE_MAX_LOOKUPS, `🔴 ${resolved} resolved, expected the budget's worth`);
    assert.strictEqual(overflow, over - RESOLVE_MAX_LOOKUPS,
      '🔴 the overflow is not read_error/budget_exceeded — under enforce it would refuse a paid cart instead of degrading');
    assert.strictEqual(incomplete, true,
      '🔴 a budget-starved order was reported COMPLETE — it would count as clean evidence for the enforce-go');
    ok(`${rid}: ${over} ids issue exactly ${reads()} reads; the ${overflow} overflow are read_error and the coverage is INCOMPLETE`);
  }

  // ── 10. 🔴 THE SWEEP'S CURSOR ACTUALLY ADVANCES ON THE REAL ENGINE ───────────────────────────
  /* The sweep now walks every page with orderBy('__name__') + startAfter(snapshot). Whether that
     cursor advances is a FIRESTORE question, not one about our code, and it fails in two directions
     that a model store would not show: a cursor that never advances turns the `for(;;)` into an
     infinite loop on a scheduled function, and one that over-skips silently drops the orphans it was
     added to reach. Both are worse than the single-page bug this replaced, so the traversal is proven
     against the engine that will actually run it — with a page size far smaller than the data, so the
     pagination is genuinely exercised rather than completing in one page by accident. */
  {
    const rid = 'la_musa', kind = 'extra';
    const keys = Array.from({ length: 7 }, (_, i) => `page_probe_${i}`);
    const minted = [];
    for (const k of keys) minted.push((await ensureIdentity(db, { rid, kind, legacyKey: k })).canonical_id);

    // Orphan every other one, so repairs are spread across several pages rather than sitting in the first.
    const orphaned = keys.filter((_, i) => i % 2 === 0);
    for (const k of orphaned) await keyRowOf(rid, kind, k).delete();

    const r = await sweepIdentityIntegrity(db, rid, kind, { pageSize: 2 });
    assert.ok(r.scanned >= keys.length,
      `🔴 the cursor did not traverse the collection — scanned ${r.scanned} of at least ${keys.length} live rows`);
    assert.strictEqual(r.repaired, orphaned.length,
      `🔴 ${r.repaired} of ${orphaned.length} orphans repaired across ${Math.ceil(r.scanned / 2)} pages — a cursor that over-skips drops exactly this`);
    for (const k of orphaned) {
      const row = await keyRowOf(rid, kind, k).get();
      assert.ok(row.exists, `🔴 ${k} was never visited — it sits past the first page`);
      assert.strictEqual(row.data().canonical_id, minted[keys.indexOf(k)], `${k} repaired to its own id`);
    }
    const again = await sweepIdentityIntegrity(db, rid, kind, { pageSize: 2 });
    assert.strictEqual(again.repaired, 0, 'and the paginated re-run is still a no-op');
    ok(`${rid}: the cursor walks all ${r.scanned} live rows in pages of 2 and repairs every one of the ${orphaned.length} orphans`);
  }

  // ── 11. 🔴 A CONFLICT THAT APPEARS UNDER THE SWEEP IS REFUSED, NOT ARBITRATED ───────────────
  /* The scan groups claimants from a snapshot; the repair transaction runs later. A SECOND live id for
     the same key appearing in that window is invisible to the grouping, so the sweep would write a
     reverse row toward whichever id the older snapshot happened to pick and report a clean repair —
     arbitrating a conflict, which is precisely what this file refuses to do everywhere else, and
     which permanently strands the loser's historical orders. Re-reading the claimant SET inside the
     transaction is what re-establishes the refusal, and whether a transactional QUERY re-read actually
     observes a concurrent insert is a Firestore question, so it is asked of Firestore. */
  {
    const rid = 'x_pizza', kind = 'dish', legacyKey = 'Aparecida';
    /* 🔴 MEASURED AS A DELTA. Cell 3 deliberately leaves a permanent two-live-id conflict in this
       collection, so an absolute `conflicts === 1` here would be asserting the state of an earlier
       cell rather than the behaviour of this one — and would break the moment any cell above changed.
       The baseline is taken first and the claim is that THIS staging adds exactly one. */
    const baseline = await sweepIdentityIntegrity(db, rid, kind);
    const orphanId = await stageOrphan(rid, kind, legacyKey);
    const intruder = 'INTRUDER01';
    let raced = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, opts) => {
        // The scan has happened and the repair has not — the exact window the grouping cannot see.
        if (!raced) {
          raced = true;
          await idsCol(rid, kind).doc(intruder).set({ legacy_key: legacyKey, status: STATUS_LIVE, kind, created_at: 'x' });
        }
        return db.runTransaction(fn, opts);
      },
    };

    const r = await sweepIdentityIntegrity(racing, rid, kind);
    assert.ok(raced, 'premise — the second claimant really did land between the scan and the repair');
    assert.strictEqual(r.repaired, 0,
      '🔴 THE SWEEP ARBITRATED — it picked a winner for a key that had two live claimants by the time it wrote');
    assert.strictEqual(r.conflicts, baseline.conflicts + 1,
      `🔴 …and it must REPORT the conflict rather than pass over it silently (${baseline.conflicts} before, ${r.conflicts} after)`);
    assert.strictEqual((await keyRowOf(rid, kind, legacyKey).get()).exists, false,
      '🔴 a reverse row was written for a conflicted key — that IS picking a winner');
    const live = await liveIdsFor(rid, kind, legacyKey);
    assert.strictEqual(live.length, 2, 'both claimants are left exactly as they were, for a human to resolve');
    assert.deepStrictEqual(live.map((d) => d.id).sort(), [intruder, orphanId].sort(), 'and neither was touched');
    ok(`${rid}: a second live claimant appearing mid-sweep is REFUSED and reported, never arbitrated`);
  }

  FINISHED = true;
  console.log(`identity-grace(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('IDENTITY GRACE (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
