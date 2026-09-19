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
const readVersion = async (rid, versionId) => {
  const vref = db.collection('restaurants').doc(rid).collection('versions').doc(versionId);
  const [rec, items, extras] = await Promise.all([vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get()]);
  return { rec: rec.data() || {}, items: items.docs.map((d) => d.data()), extras: extras.docs.map((d) => d.data()) };
};

(async () => {
  const rid = 'x_pizza';
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'd4p1-stamp' });

  // ── 1. NO PLAN → PRE-P1 BEHAVIOUR, EXACTLY ──────────────────────────────────────────────────
  const plain = await writeVersion(db, rid, input, admin.firestore.Timestamp.now());
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
  const fv = await writeVersion(db, rid, forged, admin.firestore.Timestamp.now());
  const F = await readVersion(rid, fv.versionId || fv.version || fv);
  assert.ok(F.items.every((i) => !i.display || i.display.identity_id === undefined),
    '🔴 A CLIENT-SUPPLIED identity_id WAS WRITTEN AS THE STAMP — a field the merchant controls became certification');
  assert.strictEqual(F.rec.identity_certified, undefined,
    '🔴 …and the version claimed certification on the strength of it');
  ok(`a client-carried identity_id on ${forgedCount} input objects is DISCARDED — stamps come from the server plan or not at all`);

  // ── 2. A PLAN → EVERY NAMED OBJECT CARRIES ITS CERTIFIED ID, AND THE VERSION SAYS SO ────────
  const stamps = { dish: {}, extra: {} };
  A.items.forEach((i, k) => { stamps.dish[i.key] = `PLANDISH${String(k).padStart(2, '0')}`; });
  A.extras.forEach((e, k) => { stamps.extra[e.key] = `PLANEXTRA${String(k).padStart(2, '0')}`; });

  const stamped = await writeVersion(db, rid, { ...input, stamps }, admin.firestore.Timestamp.now());
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
  const moved = await writeVersion(db, rid, bumped, admin.firestore.Timestamp.now());
  const C = await readVersion(rid, moved.versionId || moved.version || moved);
  assert.notStrictEqual(C.rec.content_hash, A.rec.content_hash,
    '🔴 SENSITIVITY: content_hash does not respond to a price change — it is not hashing content, so cell 3 proves nothing');
  ok(`content_hash/menu_hash/extras_hash are identical stamped vs unstamped — and a price change still moves content_hash`);

  FINISHED = true;
  console.log(`d4p1-stamp-write(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 STAMP WRITE (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
