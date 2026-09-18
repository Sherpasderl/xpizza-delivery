'use strict';
// Portal 1D · D1 — FIRST-ASSIGNMENT SERIALIZATION, AGAINST THE REAL FIRESTORE TRANSACTION ENGINE.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:identity-registry
//
// 🔴 WHY THIS EXISTS, AND WHY THE NODE TEST IS NOT ENOUGH. identity-registry.test.js proves "one
// object, one id under concurrent seeds" against memFirestore — a store that MODELS the one behaviour
// the guarantee rests on: a transaction that observed a document which then changed must re-run. That
// is the right shape for reasoning, and it runs on every `npm test` rather than only where Java is
// installed. But the claim it proves is conditional: one id follows IF Firestore serializes concurrent
// transactions on a contended document the way the model says it does.
//
// This build has now caught a fake diverging from production SIX times — a kind-blind registry, a
// .get()/.once() mismatch that made the 86 gate fail open, a rid-blind stub twice, a silent factura
// skip, and a transaction stub that permitted a read after a write. "The model is right about
// Firestore" is exactly the assumption our own track record says to distrust, and this particular
// assumption is the one the entire registry exists to provide. If it is wrong, "one object, one id" is
// false in production, two ids are minted for one object, and every record written between them points
// at a different identity. In D1 that is shadow and moves no money; at D4 it is authoritative, and by
// then the split is historical data nobody can repair.
//
// So: real engine, real contention, same assertions. A previous version of the node suite's header
// claimed "the emulator test covers the real driver" while no emulator test touched the registry at
// all — a comment asserting coverage that did not exist. This file is that comment made true.
const assert = require('assert');
const admin = require('firebase-admin');
const { ensureIdentity, lookupByLegacyKeys, encodeKey, ALPHABET, ID_LEN } = require('../catalog/identity-registry');
const { isGrandfathered } = require('../catalog/identity-registry');

admin.initializeApp({ projectId: 'demo-xpizza' });   // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-registry(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const idsCol = (rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('ids');
const keysCol = (rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('keys');

/* 🔴 THE REAL db, WRAPPED ONLY TO COUNT TRANSACTION ATTEMPTS. Every ref and every read below is
   Firestore's own; the wrapper adds nothing but a counter around the callback. The admin SDK invokes
   the transaction callback once per ATTEMPT, so attempts > calls is direct evidence that the engine
   actually made a contender re-run — which is the mechanism the guarantee depends on. Without it a
   green result could mean "Firestore serialized them" or "the calls never actually overlapped", and
   those are very different tests. */
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

const rowsFor = async (rid, kind, legacyKey) => ({
  ids: (await idsCol(rid, kind).get()).docs.filter((d) => (d.data() || {}).legacy_key === legacyKey),
  keys: (await keysCol(rid, kind).get()).docs.filter((d) => d.id === encodeKey(legacyKey)),
});

(async () => {
  // ── 1. CONCURRENT FIRST ASSIGNMENT → ONE ID, ON THE REAL ENGINE ───────────────────────────────
  for (const [rid, kind, legacyKey, contenders] of [
    ['x_pizza', 'dish', 'Carnivora', 6],
    ['x_pizza', 'extra', 'Salsa Roja', 5],
    ['la_musa', 'dish', 'dimsum_01', 6],
  ]) {
    const { db: counting, attempts } = countingDb();

    /* All contenders are STARTED before any is awaited — built synchronously into the array, then
       handed to Promise.all — so they are genuinely in flight together rather than a sequence wearing
       concurrency's clothes. This is the seed racing itself: two deploys, or a seed and a publish,
       reaching the same object at the same moment. */
    const inFlight = [];
    for (let i = 0; i < contenders; i += 1) inFlight.push(ensureIdentity(counting, { rid, kind, legacyKey }));
    const results = await Promise.all(inFlight);

    const ids = new Set(results.map((r) => r.canonical_id));
    assert.strictEqual(ids.size, 1,
      `🔴 ${rid}/${kind}: ${contenders} concurrent seeds minted ${ids.size} ids for ONE object — ${[...ids].join(', ')}`);
    const canonical = [...ids][0];

    const created = results.filter((r) => r.created);
    assert.strictEqual(created.length, 1,
      `🔴 ${rid}/${kind}: exactly one caller may MINT; ${created.length} did — the rest must read the winner's id`);
    assert.ok(results.filter((r) => !r.created).every((r) => r.canonical_id === canonical),
      `🔴 ${rid}/${kind}: a losing transaction returned something other than the winner's id`);

    // NO SECOND ROW. The ids collection is where a split would be visible even if the callers agreed.
    const rows = await rowsFor(rid, kind, legacyKey);
    assert.strictEqual(rows.ids.length, 1,
      `🔴 ${rid}/${kind}: ${rows.ids.length} id rows exist for one legacy key — a split identity in the store`);
    assert.strictEqual(rows.ids[0].id, canonical, `${rid}/${kind}: …and it is the id the callers were given`);
    assert.strictEqual(rows.keys.length, 1, `🔴 ${rid}/${kind}: ${rows.keys.length} key rows — the reverse index split`);
    assert.strictEqual((rows.keys[0].data() || {}).canonical_id, canonical, `${rid}/${kind}: …pointing at the same id`);

    // The brand rule still holds under contention — a race must not quietly change what an id IS.
    if (isGrandfathered(rid, kind)) {
      assert.strictEqual(canonical, legacyKey, `🔴 ${rid}/${kind}: the grandfathered slug must survive a race`);
    } else {
      assert.ok(new RegExp(`^[${ALPHABET}]{${ID_LEN}}$`).test(canonical), `${rid}/${kind}: an opaque token`);
      assert.ok(!canonical.includes(legacyKey), `🔴 ${rid}/${kind}: …not derived from the display name`);
    }

    /* 🔴 NON-VACUITY: THE ENGINE REALLY CONTENDED. The admin SDK runs the callback once per attempt,
       so more attempts than calls means Firestore made at least one contender re-run — the exact
       mechanism the guarantee rests on. Without this the assertions above would pass just as happily if
       the calls had quietly serialized themselves and never raced at all, which would make this an
       expensive way to re-run the sequential case. */
    assert.ok(attempts() > contenders,
      `🔴 ${rid}/${kind}: ${attempts()} attempts for ${contenders} calls — the real engine never forced a retry, so nothing was actually contended and this proves nothing`);

    ok(`${rid}/${kind}: ${contenders} concurrent seeds → ONE id (${canonical}), one id row, one key row, ${attempts() - contenders} genuine retries on the real engine`);
  }

  // ── 2. THE WINNER IS WHAT EVERY LATER READER SEES ─────────────────────────────────────────────
  /* One id in the callers' hands is not the whole claim: the reverse index has to agree, because the
     overlay and preserve-on-write both resolve through it rather than through a return value. */
  {
    const rid = 'x_pizza', kind = 'dish', legacyKey = 'Carnivora';
    const found = await lookupByLegacyKeys(db, { rid, kind, legacyKeys: [legacyKey] });
    const rows = await rowsFor(rid, kind, legacyKey);
    assert.strictEqual(found.get(legacyKey), rows.ids[0].id,
      '🔴 the overlay\'s own read resolves to the surviving id — the reverse index agrees with the forward one');

    // …and a re-run after the race still preserves rather than minting a seventh time.
    const again = await ensureIdentity(db, { rid, kind, legacyKey });
    assert.strictEqual(again.created, false, '🔴 a post-race re-run must preserve, not mint');
    assert.strictEqual(again.canonical_id, rows.ids[0].id, '…the same id');
    assert.strictEqual((await rowsFor(rid, kind, legacyKey)).ids.length, 1, 'and still exactly one row');
    ok('after the race the reverse index resolves to the surviving id, and a re-run preserves it');
  }

  // ── 3. CONCURRENT SEEDS OF DIFFERENT OBJECTS DO NOT SERIALIZE INTO ONE ────────────────────────
  /* The mirror image, and the reason the assertions above are not satisfied by a registry that simply
     returns the same id for everything. Distinct objects raced together must come out distinct. */
  {
    const rid = 'x_pizza', kind = 'dish';
    const keys = ['Hawaiana', 'Pepperoni', 'Margarita', 'Vegetariana'];
    const out = await Promise.all(keys.map((k) => ensureIdentity(db, { rid, kind, legacyKey: k })));
    const ids = new Set(out.map((r) => r.canonical_id));
    assert.strictEqual(ids.size, keys.length,
      `🔴 ${keys.length} distinct objects seeded concurrently produced ${ids.size} ids — identities collapsed`);
    assert.ok(out.every((r) => r.created), 'each is a genuine first assignment');
    const resolved = await lookupByLegacyKeys(db, { rid, kind, legacyKeys: keys });
    assert.strictEqual(new Set([...resolved.values()]).size, keys.length, '…and the reverse index keeps them distinct too');
    ok(`${keys.length} distinct objects raced together stay ${ids.size} distinct identities`);
  }

  FINISHED = true;
  console.log(`identity-registry(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('IDENTITY REGISTRY (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
