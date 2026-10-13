'use strict';
// PER-PRODUCT EXTRAS, stage 2 (catalog half) — on the emulator, through the REAL publisher and the REAL public-menu builder:
//   • every publish writes the version's eligibility document (versions/{vid}/meta/extras_eligibility), DENSE, from the
//     same docs the version carries — x_pizza: Nutella denied every extra (legacy '*'), every other item []; la_musa:
//     rice_03 has the proteins, rice_02 does not;
//   • getPublicMenu's body carries `extras_eligibility` = { version, deny } for that version, exactly the document;
//   • a version WITHOUT the document (pre-feature) serves NO field — never an empty, "unrestricted" one;
//   • deleteVersion removes the document with its version.
// Run: npm run test:extras-eligibility-publish
require('./_emulator-required')('firestore');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();
const { publishVersion, deleteVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { buildPublicMenu } = require('../catalog/public-menu');
const { eligibilityRefOf, readEligibility, _cache } = require('../catalog/extras-eligibility-store');
const { projectEligibility, publicDeny } = require('../catalog/extras-eligibility');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('extras-eligibility-publish: FAILED — exited without completing'); process.exitCode = 1; } });

async function wipe() {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
}
const deps = { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true };

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'eep-seed' });
    await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
    const vid = await getActiveVersionId(db, rid);
    const snap = await eligibilityRefOf(db, rid, vid).get();
    assert.ok(snap.exists, `${rid}: the publish wrote the version's eligibility document`);
    const doc = snap.data();
    // independently: the evaluator over the brand's code-seeded source (the seed publishes exactly that)
    const want = publicDeny(projectEligibility(buildSourceFromCode(rid)));
    assert.deepStrictEqual(doc.public_deny, want, `${rid}: public_deny equals the evaluator over the published source`);
    assert.ok(Object.values(doc.public_deny).every(Array.isArray), `${rid}: DENSE — every item has a list`);
    if (rid === 'x_pizza') {
      assert.strictEqual(doc.public_deny.Nutella.length, 14, 'x_pizza: Nutella denied every extra');
      assert.deepStrictEqual(doc.public_deny.Margherita, [], 'x_pizza: an ordinary pizza is unrestricted ([])');
    } else {
      assert.ok(!doc.public_deny.rice_03.some((k) => /^protein_/.test(k)), 'la_musa: rice_03 takes the proteins');
      assert.ok(['protein_chicken', 'protein_beef', 'protein_shrimp'].every((k) => doc.public_deny.rice_02.includes(k)), 'la_musa: rice_02 does not');
    }
    // the public body carries exactly that document
    const pub = await buildPublicMenu(db, rid, deps);
    assert.deepStrictEqual(pub.body.extras_eligibility, { version: 1, deny: doc.public_deny }, `${rid}: getPublicMenu serves { version, deny } for the served version`);
    ok(`${rid}: the publish wrote a DENSE eligibility document equal to the evaluator, and getPublicMenu serves it`);

    // a PRE-FEATURE version: no document → no field (never an empty "unrestricted" one)
    await eligibilityRefOf(db, rid, vid).delete();
    _cache.clear();
    assert.strictEqual(await readEligibility(db, rid, vid), null, `${rid}: an absent document reads as null`);
    const pub2 = await buildPublicMenu(db, rid, deps);
    assert.ok(!Object.prototype.hasOwnProperty.call(pub2.body, 'extras_eligibility'), `🔴 ${rid}: a version without the document serves NO extras_eligibility`);
    ok(`${rid}: a version without the document serves no extras_eligibility field (never an empty, unrestricted one)`);
  }
  // deleteVersion removes the document with its version
  {
    const rid = 'x_pizza';
    const { input } = buildPublishCandidate(rid, { activeVersionId: await getActiveVersionId(db, rid) }, { source_sha: 'eep-second' });
    const before = await getActiveVersionId(db, rid);
    await publishVersion(db, rid, input, { expected: { activeVersionId: before } });
    const second = await getActiveVersionId(db, rid);
    assert.notStrictEqual(second, before, 'premise — a second version is active');
    // the FIRST (now inactive) version gets a document back, then is deleted
    await eligibilityRefOf(db, rid, before).set({ version: 1, projection: {}, public_deny: {} });
    await deleteVersion(db, rid, before);
    assert.ok(!(await eligibilityRefOf(db, rid, before).get()).exists, 'deleteVersion removed the eligibility document');
    ok('deleteVersion removes the eligibility document with its version');
  }
  FINISHED = true;
  console.log(`\nextras-eligibility-publish(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('extras-eligibility-publish FAILED:', e); process.exit(1); });
