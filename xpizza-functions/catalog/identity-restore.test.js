'use strict';
/**
 * restoreIdentity — the provenance chain, driven. Run: node catalog/identity-restore.test.js
 *
 * 🔴 THE PROPERTY THIS FILE EXISTS FOR: a supplied id is evidence of nothing. Every cell below is a
 * way of handing the primitive an id it is not entitled to write, and watching it refuse for the
 * right reason. The happy path is here too, because a primitive that refuses everything would satisfy
 * all of them.
 */
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { activePointerRef } = require('./catalog-firestore');
const { restoreIdentity, CLAIMANT_CAP } = require('./identity-restore');
const { idsColOf, keysColOf, encodeKey, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'x_pizza';
const KEY = 'Carnivora';
const ID = 'ABCDEFGHJK';
const V = 'v-1';
const PAIR = { version: V, generation: 3 };

const versionRef = (db) => db.collection('restaurants').doc(RID).collection('versions').doc(V);

/* A restaurant whose pointer names V@3 and whose version V is certified and stamps KEY with ID —
   the state a legitimate restore is entitled to act on. */
async function world({ certified = true, stamp = ID, key = KEY, objects = 1, pointer = PAIR } = {}) {
  const db = makeDb();
  await activePointerRef(db, RID).set({ version: pointer.version, generation: pointer.generation });
  await versionRef(db).set({ identity_certified: certified });
  for (let i = 0; i < objects; i += 1) {
    await versionRef(db).collection('menu_items').doc(`obj${i}`).set({ key, display: { identity_id: stamp } });
  }
  return db;
}
const restore = (db, over = {}) => restoreIdentity(db, { rid: RID, kind: 'dish', legacyKey: KEY, canonicalId: ID, ...PAIR, ...over });
const rowsOf = async (db, kind, leaf) => (await db.collection('restaurants').doc(RID).collection('identity').doc(kind).collection(leaf).get()).docs;

(async () => {

// ── 1. THE HAPPY PATH — a certified version that stamped this id on this object ───────────────
{
  const db = await world();
  const r = await restore(db);
  assert.strictEqual(r.restored, true, '🔴 a legitimate restore was refused — every refusal below would be vacuous');
  assert.strictEqual((await keysColOf(db, RID, 'dish').doc(encodeKey(KEY)).get()).data().canonical_id, ID, 'the reverse row points at the restored id');
  const idRow = (await idsColOf(db, RID, 'dish').doc(ID).get()).data();
  assert.strictEqual(idRow.legacy_key, KEY, 'and the id row claims the key');
  assert.strictEqual(idRow.status, STATUS_LIVE, 'live');
  ok('a certified version that stamped this id on this object restores both planes');
}

// ── 2. 🔴 THE POINTER MOVED — fenced, and the fence is what makes ONE version parameter sound ──
{
  const db = await world();
  await activePointerRef(db, RID).set({ version: 'v-2', generation: 4 });
  await assert.rejects(() => restore(db), /identity_restore_pointer_moved: x_pizza — judged against v-1@3, now "v-2"@4/,
    '🔴 a restore landed against an activation it was never judged under');
  assert.deepStrictEqual(await rowsOf(db, 'dish', 'keys'), [], 'and nothing was written');
  ok('a moved pointer refuses — and past the fence, `version` IS the active version');
}

// ── 3. 🔴 NO BASELINE AT ALL — required, not defaulted ────────────────────────────────────────
{
  const db = await world();
  await assert.rejects(() => restore(db, { version: undefined, generation: undefined }),
    /identity_restore_pointer_moved_no_baseline/,
    '🔴 a restore ran with no captured pair — the fence would pass every call and protect nothing');
  ok('a missing baseline refuses at the first call');
}

// ── 4. 🔴 AN UNCERTIFIED VERSION PROVES NOTHING, however current it is ────────────────────────
{
  const db = await world({ certified: false });
  await assert.rejects(() => restore(db), /identity_restore_version_uncertified/,
    '🔴 an uncertified version was accepted as the source of an id — its objects may never have been through the identity pass');
  assert.deepStrictEqual(await rowsOf(db, 'dish', 'keys'), [], 'nothing written');
  ok('an uncertified version refuses — certification is what makes a stamp evidence');
}

// ── 5. 🔴 THE STAMP MUST BE THE SUPPLIED ID — the whole provenance check ──────────────────────
{
  const db = await world({ stamp: 'ZZZZZZZZZZ' });
  await assert.rejects(() => restore(db), /identity_restore_stamp_mismatch.*stamped "ZZZZZZZZZZ" on that object, not "ABCDEFGHJK"/s,
    '🔴 the caller\'s id was written although the version stamped a DIFFERENT id on that object');
  ok('a stamp that disagrees with the supplied id refuses, naming both');
}

// ── 6. 🔴 MEMBERSHIP SOMEWHERE IN THE VERSION IS INSUFFICIENT ─────────────────────────────────
/* The id EXISTS in the version — on another object, under another key. Reaching the stamp THROUGH the
   key is what makes this refuse by construction rather than by an extra check. */
{
  const db = await world({ stamp: 'ZZZZZZZZZZ' });
  await versionRef(db).collection('menu_items').doc('elsewhere').set({ key: 'Hawaiana', display: { identity_id: ID } });
  await assert.rejects(() => restore(db), /identity_restore_stamp_mismatch/,
    '🔴 an id present ELSEWHERE in the version was accepted for this key — that is the fabricated-provenance case');
  ok('an id stamped on a DIFFERENT object does not authorise a restore onto this one');
}

// ── 7. 🔴 A FABRICATED STAMP PASSED AS AN ARGUMENT IS NEVER READ ──────────────────────────────
/* There is no argument through which a caller can supply the evidence; the object is loaded from the
   server's own version record. This asserts the shape of the API, which is the guarantee. */
{
  const db = await world({ stamp: 'ZZZZZZZZZZ' });
  await assert.rejects(
    () => restoreIdentity(db, { rid: RID, kind: 'dish', legacyKey: KEY, canonicalId: ID, ...PAIR,
      stamps: { [KEY]: ID }, display: { identity_id: ID }, object: { key: KEY, display: { identity_id: ID } } }),
    /identity_restore_stamp_mismatch/,
    '🔴 caller-supplied stamp-shaped arguments changed the outcome — provenance must come from the server record alone');
  ok('caller-supplied stamps, displays and objects are ignored entirely');
}

// ── 8. 🔴 NO OBJECT AT THAT KEY, AND AMBIGUITY, BOTH REFUSE ───────────────────────────────────
{
  const absent = await world({ key: 'SomethingElse' });
  await assert.rejects(() => restore(absent), /identity_restore_object_absent/,
    '🔴 a version that never contained this key was treated as having stamped it');

  const ambiguous = await world({ objects: 2 });
  await assert.rejects(() => restore(ambiguous), /identity_restore_object_ambiguous/,
    '🔴 two objects at one key were resolved by picking one — which is how an id lands on the wrong dish');
  ok('an absent object and an ambiguous one both refuse rather than guessing');
}

// ── 9. 🔴 THE DESTINATION-CLAIMANT GUARD IS CALLED — non-vacuity, and it is the point ──────────
/* D-4 left this guard UNWIRED precisely because a guard in front of nothing passes its own cells
   while protecting nothing. So this proves it is REACHED: a foreign live claimant on the destination
   key must refuse, and the refusal must carry the guard's own vocabulary rather than a generic one.
   🔴 THIS DOES NOT DISCHARGE THE D-4 DEFERRAL — §68 and §5 put that guard on the ATOMIC ACTIVATION
   WRITER, which is E-4. restoreIdentity already owned this protection; wiring it here satisfies
   nothing on the writer's behalf. */
{
  const db = await world();
  await idsColOf(db, RID, 'dish').doc('FOREIGNIDXX').set({ legacy_key: KEY, kind: 'dish', status: STATUS_LIVE, created_at: 'x' });
  await assert.rejects(() => restore(db), /identity_restore_destination_/,
    '🔴 a restore landed on a key a DIFFERENT live id already claims — it overwrote a live claimant instead of refusing');
  assert.deepStrictEqual(await rowsOf(db, 'dish', 'keys'), [], 'and no reverse row was written');

  // …and a RETIRED claimant is not a live one, so it does not block.
  const db2 = await world();
  await idsColOf(db2, RID, 'dish').doc('RETIREDIDXX').set({ legacy_key: KEY, kind: 'dish', status: STATUS_RETIRED, created_at: 'x' });
  const r2 = await restore(db2);
  assert.strictEqual(r2.restored, true, '🔴 a RETIRED claimant blocked a restore — retirement releases the name');
  ok('a foreign LIVE claimant refuses in the guard\'s own vocabulary; a retired one does not block');
}

// ── 10. OUR OWN ID RE-LANDING IS PERMITTED — a half-written restore is retryable ──────────────
{
  const db = await world();
  await restore(db);
  const again = await restore(db);
  assert.strictEqual(again.restored, true, '🔴 re-running a completed restore refused — a half-written one could never be finished');
  assert.strictEqual((await keysColOf(db, RID, 'dish').doc(encodeKey(KEY)).get()).data().canonical_id, ID, 'and the mapping is unchanged');
  ok('re-landing our own id is permitted, so an interrupted restore can be retried');
}

// ── 11. 🔴 AN UNUSABLE ID REFUSES BEFORE ANY READ — BUT "UNUSABLE" IS SHAPE, NOT ALPHABET ─────
/* 🔴 MY FIRST VERSION OF THIS CELL WOULD HAVE BROKEN la_musa. It asserted that 'short' and
   'lower-case-id' are refused, on the assumption that a canonical id must look like x_pizza's minted
   token. identity-registry.js:235 says otherwise, deliberately: la_musa GRANDFATHERS its slug, so
   `dimsum_01` is a perfectly valid canonical id, and alphabet-checking here would classify an entire
   brand as unresolved. validIdShape validates what FIRESTORE requires of a document id — which is the
   read about to be performed — and nothing more.
   So the property is: an id that cannot be a document path refuses before any read; a brand's own
   slug is accepted. Asserting the stricter thing would have argued for a change that breaks a brand. */
{
  const db = await world();
  for (const unusable of ['', 42, null, undefined, 'has/slash', '.', '..']) {
    await assert.rejects(() => restore(db, { canonicalId: unusable }), /identity_restore_bad_id/,
      `🔴 ${JSON.stringify(unusable)} was accepted as an id — it cannot even be a document path`);
  }
  /* …and a grandfathered slug reaches the provenance check rather than being rejected on its shape. */
  const slug = await world({ stamp: 'dimsum_01' });
  const r = await restoreIdentity(slug, { rid: RID, kind: 'dish', legacyKey: KEY, canonicalId: 'dimsum_01', ...PAIR });
  assert.strictEqual(r.restored, true, '🔴 a grandfathered slug was refused on its SHAPE — that classifies a whole brand as unresolved');
  ok('unusable ids refuse before any read; a brand-grandfathered slug is a valid id and restores');
}

// ── 12. 🔴 THE WRITE TARGET IS READ — a live id claiming ANOTHER name refuses ─────────────────
/* Found in review: idRef was written and never read. "Every read first" passed — that is the ORDER
   rule, and every read that happened WAS first — while COMPLETENESS went unchecked. The claimant
   query asks who claims the NAME; it is given nothing about what the landing ID claims, so it
   structurally cannot see this. A guard on a neighbouring document is not a read of this one.
   Writing here would MOVE the id and leave keys/{oldName} naming an id that no longer claims it —
   the `destination_key_row_disagrees` state the guard refuses elsewhere and the sweep declines to
   repair, manufactured from a path that believes it is repairing. It is also a move, which P1a
   disables. */
{
  const db = await world({ key: 'Pizza Napoli' });
  await idsColOf(db, RID, 'dish').doc(ID).set({ legacy_key: 'Pizza Margarita', kind: 'dish', status: STATUS_LIVE, created_at: '2026-01-01T00:00:00Z' });
  await keysColOf(db, RID, 'dish').doc(encodeKey('Pizza Margarita')).set({ canonical_id: ID, kind: 'dish' });

  await assert.rejects(
    () => restoreIdentity(db, { rid: RID, kind: 'dish', legacyKey: 'Pizza Napoli', canonicalId: ID, ...PAIR }),
    /identity_restore_id_claims_other_name.*is live claiming "Pizza Margarita"/s,
    '🔴 a restore MOVED a live id onto another name and left the old key row naming it');

  const idRow = (await idsColOf(db, RID, 'dish').doc(ID).get()).data();
  assert.strictEqual(idRow.legacy_key, 'Pizza Margarita', 'the id still claims what it claimed');
  assert.strictEqual(idRow.created_at, '2026-01-01T00:00:00Z', 'and its creation time is intact');
  assert.strictEqual((await keysColOf(db, RID, 'dish').doc(encodeKey('Pizza Napoli')).get()).exists, false, 'no new reverse row');
  ok('a landing id live-claiming ANOTHER name refuses — a move belongs to the atomic writer, in one tx');
}

// ── 13. 🔴 A RETIRED LANDING ID IS NOT SILENTLY RESURRECTED ───────────────────────────────────
/* Retirement writes a reservation deliberately, and the integrity sweep refuses to revive a retired
   id at all. Slice F does restore retired ids on rollback — but §68 keeps that inside the flip's own
   transaction, so refusing here blocks nothing F needs. */
{
  const db = await world();
  await idsColOf(db, RID, 'dish').doc(ID).set({ legacy_key: KEY, kind: 'dish', status: STATUS_RETIRED, created_at: '2026-01-01T00:00:00Z', retired_at: '2026-02-02T00:00:00Z' });
  await assert.rejects(() => restore(db), /identity_restore_id_retired/,
    '🔴 a RETIRED id was silently resurrected to live by a restore');
  const row = (await idsColOf(db, RID, 'dish').doc(ID).get()).data();
  assert.strictEqual(row.status, STATUS_RETIRED, 'it is still retired');
  assert.strictEqual(row.retired_at, '2026-02-02T00:00:00Z', 'and the record of when is intact');
  ok('a retired landing id refuses — resurrection must be explicit, and this is not the writer for it');
}

// ── 14. 🔴 AN EXISTING ROW IS PRESERVED, NOT REPLACED ─────────────────────────────────────────
/* tx.set is a full replace, so a bare object destroys created_at. This is the mechanism that once
   dropped the generation from the pointer write; retireIdentity spreads the existing document for
   the same reason. Past the two refusals above, an existing row can only be our own id already
   claiming this name — the idempotent retry. */
{
  const db = await world();
  await idsColOf(db, RID, 'dish').doc(ID).set({ legacy_key: KEY, kind: 'dish', status: STATUS_LIVE, created_at: '2026-01-01T00:00:00Z', minted_by: 'ensureIdentity' });
  const r = await restore(db);
  assert.strictEqual(r.restored, true, 'our own id re-landing on its own name proceeds');
  assert.strictEqual(r.existed, true, 'and it reports that a row was already there');
  const row = (await idsColOf(db, RID, 'dish').doc(ID).get()).data();
  assert.strictEqual(row.created_at, '2026-01-01T00:00:00Z', '🔴 created_at was destroyed by a full replace');
  assert.strictEqual(row.minted_by, 'ensureIdentity', '🔴 an unrelated field was destroyed — tx.set replaces, it does not merge');
  assert.ok(row.restored_at, 'and the restore is recorded');
  ok('an existing row keeps created_at and its other fields; only the restore fields are added');
}

// ── 15. 🔴 THE CLAIMANT CAP REFUSES RATHER THAN TRUNCATING ────────────────────────────────────
/* 🔴 THIS CELL SHOULD HAVE EXISTED WHEN THE CAP DID. I modelled limit() in the in-memory Firestore
   specifically so this bound would be testable — and then shipped without asserting it, which is my
   own sentence turned around: a fixture that cannot express a production constraint makes it
   untestable, and removing that excuse does not write the assertion.
   The property: the claimant set decides whether a name is free. Discovering it only PARTLY and
   treating the remainder as absent is how an orphan goes unseen, so overflow is an explicit refusal —
   the same reasoning the flip's stamp budget gives for aborting rather than verifying a subset. */
{
  const db = await world();
  for (let i = 0; i <= CLAIMANT_CAP; i += 1) {                       // CAP + 1 claimants
    await idsColOf(db, RID, 'dish').doc(`CLAIMANT${String(i).padStart(4, '0')}`)
      .set({ legacy_key: KEY, kind: 'dish', status: STATUS_LIVE, created_at: 'x' });
  }
  await assert.rejects(() => restore(db), /identity_restore_destination_claimants_truncated/,
    '🔴 the claimant query overflowed its cap and the restore proceeded on a PARTIAL set — a name judged free on claimants nobody read');
  assert.deepStrictEqual(await rowsOf(db, 'dish', 'keys'), [], 'and nothing was written');

  /* …and exactly AT the cap is not truncation. Without this, "refuses when there are many claimants"
     would be satisfied by a cap that fires one short, or by refusing for the wrong reason entirely. */
  const atCap = await world();
  for (let i = 0; i < CLAIMANT_CAP; i += 1) {
    await idsColOf(atCap, RID, 'dish').doc(`CLAIMANT${String(i).padStart(4, '0')}`)
      .set({ legacy_key: KEY, kind: 'dish', status: STATUS_LIVE, created_at: 'x' });
  }
  await assert.rejects(() => restore(atCap), (e) => {
    assert.ok(!/truncated/.test(e.message),
      `🔴 exactly ${CLAIMANT_CAP} claimants reported as TRUNCATED — the boundary is off by one and a readable set is being called unreadable`);
    assert.match(e.message, /identity_restore_destination_/, 'it still refuses, on the claimants it CAN see');
    return true;
  });
  ok(`${CLAIMANT_CAP} claimants refuse on what was read; ${CLAIMANT_CAP + 1} refuses as TRUNCATED rather than judging a partial set`);
}

// ── 16. 🔴 A STORED `id` FIELD MUST NOT SHADOW THE DOCUMENT ID — this one manufactured a FORK ──
/* Found at review, and it is the sharpest defect in this slice. The claimant set was built as
   `{ id: d.id, ...data }`, so a row carrying its OWN `id` field overrode the authoritative document
   id. identity-destination reads `c.id` and trusts it, as it should be able to. So a row
   `ids/FOREIGN = { id: OWN, legacy_key: K, status: live }` presented to the guard as claimant OWN,
   the guard saw only our own id re-landing — the permitted retry — and the write landed while
   FOREIGN was still live claiming K. TWO LIVE IDS FOR ONE NAME, produced by the guard whose entire
   job is preventing that.
   🔴 THE FILE'S HEADER SAYS A SUPPLIED ID IS A CLAIM AND NEVER EVIDENCE. That was enforced on the
   PARAMETER and dropped three lines away in the plumbing, where a supplied FIELD shadowed the
   document id. A principle held at the front door and dropped in the plumbing is not held. */
{
  const db = await world();
  await idsColOf(db, RID, 'dish').doc('FOREIGNIDXX')
    .set({ id: ID, legacy_key: KEY, kind: 'dish', status: STATUS_LIVE, created_at: 'x' });   // stored id shadows the doc id

  await assert.rejects(() => restore(db), /identity_restore_destination_/,
    '🔴 a stored `id` field made a FOREIGN claimant present as our own, and the restore wrote — two live ids now claim one name');

  /* The fork, asserted directly rather than inferred from the refusal: only one live id may claim
     this name, and it must be the one that was already there. */
  const live = [];
  for (const d of await rowsOf(db, 'dish', 'ids')) {
    const x = d.data();
    if (x.status === STATUS_LIVE && x.legacy_key === KEY) live.push(d.id);
  }
  assert.deepStrictEqual(live, ['FOREIGNIDXX'],
    `🔴 FORK: ${JSON.stringify(live)} are all live claiming ${KEY} — inv #2/#4 says no path may produce this`);
  ok('a stored `id` field cannot shadow the document id — the authoritative id wins and the fork is refused');
}

console.log(`\n${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
