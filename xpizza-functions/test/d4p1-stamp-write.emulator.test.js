'use strict';
// Portal 1D · D4-P1 Slice A — writeVersion STAMPS FROM A SERVER-SUPPLIED PLAN, AND ONLY FROM ONE.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4p1-stamp
//
// 🔴 THE TWO HALVES OF SLICE A MEET HERE. The exclusion tests prove the stamp is not hashed, using the
// hash function directly. This proves the same thing END TO END through the REAL writer: a version
// written WITH stamps and the same version written WITHOUT them carry the SAME content_hash, which is
// the property that lets the bootstrap pass stamp a live version without it reading as a menu change.
// Proving it on the projection alone would leave the writer free to hash something else.
require('./_emulator-required')('firestore');   // refuse if the emulator host vars are unset (would hit real infrastructure, or a foreign emulator)

const assert = require('assert');
const admin = require('firebase-admin');
const { buildPublishCandidate } = require('../tools/publish-version');

admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-stamp-write(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const { writeVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { lookupByLegacyKeys } = require('../catalog/identity-registry');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
/* 🔴 EVERY VERSION STATES THE BASELINE IT WAS BUILT AGAINST (D-2 gate fix). writeVersion no longer
   accepts an absent baseline: a version with no activation record cannot be proven to have been live,
   and retention is not proof. These fixtures read the live pair rather than inventing one, because a
   baseline chosen to satisfy the check is a fixture asserting against a world that does not exist. */
const baselineOf = (d, r) => require('../catalog/catalog-firestore').getActivePointer(d, r);

const readVersion = async (rid, versionId) => {
  const vref = db.collection('restaurants').doc(rid).collection('versions').doc(versionId);
  const [rec, items, extras] = await Promise.all([vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get()]);
  return { rec: rec.data() || {}, items: items.docs.map((d) => d.data()), extras: extras.docs.map((d) => d.data()) };
};

(async () => {
  const rid = 'x_pizza';
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'd4p1-stamp' });

  // ── 1. NO PLAN → PRE-P1 BEHAVIOUR, EXACTLY ──────────────────────────────────────────────────
  const plain = await writeVersion(db, rid, { ...input, baseline: await baselineOf(db, rid) }, admin.firestore.Timestamp.now());
  const A = await readVersion(rid, plain.versionId || plain.version || plain);
  assert.ok(A.items.length > 0 && A.extras.length > 0, 'premise — a real version was written');
  assert.ok(A.items.every((i) => !i.display || i.display.identity_id === undefined),
    '🔴 an unplanned publish stamped anyway — the stamp must come from the server plan or not exist');
  assert.strictEqual(A.rec.identity_certified, undefined,
    '🔴 an unplanned version claims certification — the discriminator would stop separating certified from pre-P1');
  ok(`no plan → ${A.items.length} items + ${A.extras.length} extras written unstamped and UNcertified, as pre-P1`);

  // ── 1b. 🔴 A CLIENT-CARRIED STAMP IS NOT CERTIFICATION ──────────────────────────────────────
  /* The display round-trips losslessly through the merchant's editor, so an `identity_id` CAN arrive
     in the input — stale, copied, or forged. Cell 1 cannot see the difference between "server plan or
     nothing" and "fall back to whatever the display carries", because its input carries no stamp at
     all. This does: the input arrives pre-stamped with a value the server never planned, and the
     written version must still be unstamped and uncertified. Inv #1 — never trusted from the client. */
  const forged = JSON.parse(JSON.stringify(input));
  let forgedCount = 0;
  for (const it of (Array.isArray(forged.items) ? forged.items : [])) {
    if (it && it.display) { it.display.identity_id = 'CLIENTFORGED'; forgedCount += 1; }
  }
  assert.ok(forgedCount > 0, 'premise — the input really does carry a client-supplied stamp');
  const fv = await writeVersion(db, rid, { ...forged, baseline: await baselineOf(db, rid) }, admin.firestore.Timestamp.now());
  const F = await readVersion(rid, fv.versionId || fv.version || fv);
  assert.ok(F.items.every((i) => !i.display || i.display.identity_id === undefined),
    '🔴 A CLIENT-SUPPLIED identity_id WAS WRITTEN AS THE STAMP — a field the merchant controls became certification');
  assert.strictEqual(F.rec.identity_certified, undefined,
    '🔴 …and the version claimed certification on the strength of it');
  ok(`a client-carried identity_id on ${forgedCount} input objects is DISCARDED — stamps come from the server plan or not at all`);

  // ── 2. A PLAN → EVERY NAMED OBJECT CARRIES ITS CERTIFIED ID, AND THE VERSION SAYS SO ────────
  /* 🔴 THE PLAN'S IDS COME FROM THE REGISTRY NOW, AND THAT IS THE CELL GETTING STRONGER RATHER THAN
     WEAKER. This used to invent them — PLANDISH00, PLANEXTRA00 — which proved the writer copies a map
     into the documents and nothing more. Slice D made writeVersion RE-VERIFY the map against the
     registry object by object, so an invented map is now refused, correctly: a map the registry does
     not confirm is exactly what must never become certification. Resolving the real ids keeps the
     original property (every named object carries the id the plan supplied, extras included) and adds
     the one the invented map could never show — that the written stamp is the id the registry holds
     for that NAME. */
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  const [dishIds, extraIds] = await Promise.all([
    lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: A.items.map((i) => i.key) }),
    lookupByLegacyKeys(db, { rid, kind: 'extra', legacyKeys: A.extras.map((e) => e.key) }),
  ]);
  const stamps = { dish: {}, extra: {} };
  A.items.forEach((i) => { if (dishIds.get(i.key)) stamps.dish[i.key] = dishIds.get(i.key); });
  A.extras.forEach((e) => { if (extraIds.get(e.key)) stamps.extra[e.key] = extraIds.get(e.key); });
  assert.ok(Object.keys(stamps.dish).length === A.items.length && Object.keys(stamps.extra).length === A.extras.length,
    'premise — the registry holds an id for every object, so the plan below is complete');

  /* The fence pair, which a stamped version must record: the map's membership decisions were made
     against THIS baseline, and writeVersion refuses to freeze a map it cannot bind to one. */
  const live = await getActivePointer(db, rid);
  const stamped = await writeVersion(db, rid, { ...input, stamps, baseline: live }, admin.firestore.Timestamp.now());
  const B = await readVersion(rid, stamped.versionId || stamped.version || stamped);
  assert.strictEqual(B.rec.identity_certified, true, '🔴 a planned version is not marked certified');
  for (const i of B.items) {
    assert.strictEqual(i.display && i.display.identity_id, stamps.dish[i.key],
      `🔴 ${i.key}: the written stamp is not the one the plan supplied`);
  }
  for (const e of B.extras) {
    assert.strictEqual(e.display && e.display.identity_id, stamps.extra[e.key],
      `🔴 ${e.key}: EXTRAS must be stamped too — hardening dishes and leaving the sibling is the recurring half-fix here`);
  }
  ok(`a plan → all ${B.items.length} dishes and ${B.extras.length} extras carry their planned id, version marked certified`);

  // ── 3. 🔴 AND THE STAMP DOES NOT MOVE THE CONTENT FINGERPRINT, THROUGH THE REAL WRITER ──────
  assert.strictEqual(B.rec.content_hash, A.rec.content_hash,
    '🔴 stamping changed content_hash — the bootstrap pass would read as a menu change to every cache and every merchant diff');
  assert.strictEqual(B.rec.menu_hash, A.rec.menu_hash, '…and menu_hash is unmoved');
  assert.strictEqual(B.rec.extras_hash, A.rec.extras_hash, '…and extras_hash is unmoved');
  assert.deepStrictEqual(
    B.items.map((i) => ({ key: i.key, price: i.price })).sort((a, b) => (a.key < b.key ? -1 : 1)),
    A.items.map((i) => ({ key: i.key, price: i.price })).sort((a, b) => (a.key < b.key ? -1 : 1)),
    'no key or price moved');

  // SENSITIVITY: content_hash is a real hash of real content — a price change still moves it.
  const bumped = JSON.parse(JSON.stringify(input));
  const firstKey = Object.keys(bumped.items)[0] !== undefined && Array.isArray(bumped.items) ? null : null;
  if (Array.isArray(bumped.items) && bumped.items.length) bumped.items[0].price += 1;
  const moved = await writeVersion(db, rid, { ...bumped, baseline: await baselineOf(db, rid) }, admin.firestore.Timestamp.now());
  const C = await readVersion(rid, moved.versionId || moved.version || moved);
  assert.notStrictEqual(C.rec.content_hash, A.rec.content_hash,
    '🔴 SENSITIVITY: content_hash does not respond to a price change — it is not hashing content, so cell 3 proves nothing');
  ok(`content_hash/menu_hash/extras_hash are identical stamped vs unstamped — and a price change still moves content_hash`);

  // ── 4. 🔴 THE MAP IS RE-VERIFIED AGAINST THE REGISTRY — THE CHECK THE PARTITION LAW CANNOT MAKE ──
  /* 🔴 THE HEADLINE CASE IS THE SWAP, and it is the reason this check exists at all. The partition law
     proves every carried id is in the active certified SET. It cannot prove that THIS id belongs to
     THIS object, because moving one live dish's id onto another live dish leaves C ⊆ A perfectly
     satisfied — same set, different owners. The ids reach the server through `display`, which
     round-trips losslessly through the merchant's editor, so without this a field the merchant
     controls becomes server certification FOR THE WRONG OBJECT, frozen into a create-only version
     where it can never be edited out.
     Driven through the real writer with a map that is wrong in exactly that way. */
  {
    const keys = A.items.map((i) => i.key);
    assert.ok(keys.length >= 2, 'premise — two objects to swap between');
    const swapped = { dish: { ...stamps.dish }, extra: { ...stamps.extra } };
    swapped.dish[keys[0]] = stamps.dish[keys[1]];
    swapped.dish[keys[1]] = stamps.dish[keys[0]];
    assert.notStrictEqual(swapped.dish[keys[0]], stamps.dish[keys[0]], 'premise — the two ids really differ');

    await assert.rejects(
      () => writeVersion(db, rid, { ...input, stamps: swapped, baseline: live }, admin.firestore.Timestamp.now()),
      /stamp_registry_disagrees/,
      '🔴 TWO OBJECTS SWAPPED IDS AND THE WRITER CERTIFIED IT — every id is still in the active certified set, so the partition law sees nothing wrong; only asking the registry per NAME can catch it');

    // An id the registry has never issued for this name — the forged-map case.
    const invented = { dish: { ...stamps.dish }, extra: { ...stamps.extra } };
    invented.dish[keys[0]] = 'NEVERISSUED';
    await assert.rejects(
      () => writeVersion(db, rid, { ...input, stamps: invented, baseline: live }, admin.firestore.Timestamp.now()),
      /stamp_registry_disagrees/,
      '🔴 an id the registry never issued was written as certification');

    // A map naming an object this candidate does not contain — resolved against a different draft.
    const foreign = { dish: { ...stamps.dish, 'No Such Dish': stamps.dish[keys[0]] }, extra: { ...stamps.extra } };
    await assert.rejects(
      () => writeVersion(db, rid, { ...input, stamps: foreign, baseline: live }, admin.firestore.Timestamp.now()),
      /stamp_not_in_candidate/,
      '🔴 a map naming an object this version does not contain was accepted — it was resolved against a different draft');

    /* SENSITIVITY — the same map, unswapped, still writes. Without this the three rejections above are
       satisfied by a writer that refuses everything. */
    const good = await writeVersion(db, rid, { ...input, stamps, baseline: live }, admin.firestore.Timestamp.now());
    const G = await readVersion(rid, good.versionId || good.version || good);
    assert.strictEqual(G.rec.identity_certified, true, '🔴 SENSITIVITY: the correct map no longer writes either — the refusals above prove nothing');
    ok('a swapped, a forged and a foreign stamp map are each REFUSED by name at the writer; the correct map still certifies');
  }

  // ── 5. 🔴 THE FENCE: A MAP RESOLVED AGAINST A BASELINE THAT MOVED IS NOT WRITTEN ────────────
  /* A version is create-only. If the pointer moves after the map was resolved, every membership
     decision behind it was made against a menu that is no longer live — and the flip's CAS would
     refuse the activation later anyway. Refusing HERE is the difference between a refused publish and
     a permanent retained version nobody can ever activate. */
  {
    const moved = { version: live.version, generation: (live.generation || 0) + 1 };
    await assert.rejects(
      () => writeVersion(db, rid, { ...input, stamps, baseline: moved }, admin.firestore.Timestamp.now()),
      /stamp_fence_moved/,
      '🔴 a stamp map bound to a baseline that is not live was frozen into an immutable version');

    /* 🔴 THE REFUSAL MOVED EARLIER, AND THAT IS THE D-2 FIX. This asserted `stamp_fence_unbound` —
       the stamp map refusing to be frozen without a baseline. writeVersion now refuses a missing
       baseline for EVERY version, stamped or not, because a version with no activation record cannot
       be proven to have been live and retention is not proof. So the same input is still refused, by
       a check that fires before the stamp machinery is reached. Asserted under the new code rather
       than loosened to match both: which guard refuses is the thing worth knowing. */
    await assert.rejects(
      () => writeVersion(db, rid, { ...input, stamps }, admin.firestore.Timestamp.now()),
      /write_version_no_baseline/,
      '🔴 a version was written with no record of the baseline it was built against');

    /* 🔴 AND AN EMPTY MAP IS NOT A CERTIFICATION — the second lock, at the write point. deriveStampMap
       returns null for an unstamped draft, so production never sends one; but writeVersion is
       EXPORTED and the parameter is reachable from any caller, and `!!stamps` alone is true for
       `{dish:{},extra:{}}`. A version marked certified with zero stamps has an EMPTY active certified
       set — which is precisely the A = ∅ state the publish lockout is made of, so getting this wrong
       would move the bug rather than fix it. */
    const hollow = await writeVersion(db, rid, { ...input, stamps: { dish: {}, extra: {} }, baseline: live }, admin.firestore.Timestamp.now());
    const H = await readVersion(rid, hollow.versionId || hollow.version || hollow);
    assert.strictEqual(H.rec.identity_certified, undefined,
      '🔴 an EMPTY stamp map certified the version — its active certified set is empty, so the next publish refuses as carried_unknown and the merchant is locked out');
    assert.ok(H.items.every((i) => !i.display || i.display.identity_id === undefined), '…and nothing was stamped, which is the point');
    ok('a stamp map bound to a moved baseline, or to none at all, is refused before the version exists; an EMPTY map certifies nothing');
  }

  FINISHED = true;
  console.log(`d4p1-stamp-write(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 STAMP WRITE (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
