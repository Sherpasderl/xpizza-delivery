'use strict';
// CLI — MIGRATE the live catalog to versioned-publish: publishVersion v1 for both brands from the
// current menu-pricing tables (+ the schema-v2 display records / structure), then FLIP the
// active_version pointer. ADDITIVE + atomic (the flip is the only cutover; the flat layout stays until
// contracted). This writes a NEW version and moves the pointer — run it CONTROLLED (owner, post-gate).
//
// Run (owner, post functions-deploy):  node tools/publish-version.js
// Then ALWAYS verify via the pointer:  node tools/verify-catalog.js
//
// 🔒 Value-identity: version 1 == the flat catalog == code (the emulator money-proof gates this). The
// reader serves version 1 via the pointer; the 1b guard still serves CODE + alarms on any divergence.
const { execSync } = require('child_process');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { publishVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror, RTDB_URL } = require('../catalog/mirror-rtdb');   // 1b: the RTDB disaster-fallback writer
const { readSource, sourceToBuildInputs } = require('../catalog/source-store');   // portal 2a
const { assertStoreCodeParity } = require('../catalog/publish-parity');                    // portal 2a: the pre-flip gate

const gitSha = () => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return 'unknown'; } };

// ── THE BASELINE, then THE CANDIDATE — read in that order, and paired for life ───────────────────
//
// 🔴 THE ORDER IS THE CORRECTNESS. The pointer is read FIRST, before the source: anything that
// publishes after this moment must lose the compare-and-set. Reading it afterwards — which is what
// this file did — captured whatever a competing publish had just installed as the CLI's own
// expectation, so the CAS compared a fresh value against itself and waved through a candidate built
// from a draft that was already superseded. A dish reverted 230 → 223 with every guard green.
//
// The revision comes back FROM readSource, not from a second read, for the same reason: "the draft I
// built this from" and "the draft I am claiming to be current" must be the same sentence.
async function readPublishBaseline(db, rid, { fromStore }) {
  const pointer = await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get();
  const activeVersionId = pointer.exists ? ((pointer.data() || {}).version || null) : null;
  if (!fromStore) return { activeVersionId, source: null, revision: null };
  const { source, revision } = await readSource(db, rid);   // fail-closed: missing/malformed throws
  return { activeVersionId, source, revision };
}

// THE CANDIDATE AND ITS EXPECTATION, PRODUCED TOGETHER. Returning them as one value is deliberate:
// the bug this closes was a caller pairing a candidate with a baseline read at a different moment,
// and a function that hands back both leaves nothing to pair up by hand.
//
// Exported so a test drives the REAL thing. The previous shape of this file was untestable — the
// input was assembled inline between an admin.initializeApp() and a live Firestore write — so what
// the cutover would actually publish could only be checked by running the cutover. The one bug that
// matters here is exactly the one an in-test reconstruction cannot find: a field the CLI does not
// pass, or a baseline it binds at the wrong moment. Both have now happened in this slice.
function buildPublishCandidate(rid, baseline, { source_sha = 'unknown' } = {}) {
  const { activeVersionId, source, revision } = baseline || {};
  const expected = { activeVersionId: activeVersionId === undefined ? null : activeVersionId };
  if (source) {
    // Build from the STORE, then prove it equals what the CODE builds — the no-op gate.
    const inputs = sourceToBuildInputs(source);
    const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
    const codeBuilt = { ...buildCatalogV2(rid), extras: EXTRAS_BY_RESTAURANT[rid] || {} };
    assertStoreCodeParity(rid, { items: built.items, structure: built.structure, extras: inputs.extras }, codeBuilt);   // THROWS → nothing written, no flip
    // The draft expectation is the revision the candidate was BUILT FROM. Present by KEY, so
    // "no draft" and "a draft I did not look at" can never be the same statement.
    expected.draftRevision = revision === undefined ? null : revision;
    return { input: { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha }, expected };
  }
  const built = buildCatalogV2(rid);   // schema-v2 items + EXTRAS display records + structure
  return { input: { items: built.items, structure: built.structure, extras: EXTRAS_BY_RESTAURANT[rid] || {}, extraRecords: built.extras, source_sha }, expected };
}

module.exports = { readPublishBaseline, buildPublishCandidate };

if (require.main !== module) return;   // imported for its pure parts — no credentials, no writes

try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; publish needs only ADC */ }
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: RTDB_URL,   // 1b REVISE: ADC + GOOGLE_CLOUD_PROJECT alone do NOT resolve RTDB — without
                           // this, admin.database() throws and the tool dies before writing anything.
});
const db = admin.firestore();
const mirror = makeRtdbMirror(admin.database());   // 1b: injected so the publish acks the mirror under its lease

// Portal 2a: --from-store builds each version from the SOURCE STORE instead of the code tables, and
// refuses to flip unless that build is canonically identical to what the code would have built. The
// gate runs BEFORE publishVersion, so a mismatch aborts with nothing written and no pointer moved.
const FROM_STORE = process.argv.includes('--from-store');

(async () => {
  const source_sha = gitSha();
  for (const rid of ['x_pizza', 'la_musa']) {
    const baseline = await readPublishBaseline(db, rid, { fromStore: FROM_STORE });   // pointer FIRST, then the source + its revision
    const { input, expected } = buildPublishCandidate(rid, baseline, { source_sha });  // parity gate runs inside, BEFORE anything is written
    if (FROM_STORE) console.log(`${rid}: parity gate PASSED — build-from-store is byte-identical to build-from-code`);
    const res = await publishVersion(db, rid, input, { mirror, expected });
    const codeItems = Object.keys(MENU_BY_RESTAURANT[rid]).length;
    const codeExtras = Object.keys(EXTRAS_BY_RESTAURANT[rid] || {}).length;
    if (res.item_count !== codeItems || res.extra_count !== codeExtras) {
      throw new Error(`publish count drift ${rid}: version=${res.item_count}/${res.extra_count} code=${codeItems}/${codeExtras}`);
    }
    console.log(`  ${rid}: published ${res.versionId} — ${res.item_count} items + ${res.extra_count} extras` +
      `  [menu ${res.menu_hash.slice(0, 12)} / extras ${res.extras_hash.slice(0, 12)}] → active_version flipped`);
  }
  console.log(`catalog versioned-publish complete — source ${source_sha} @ ${new Date().toISOString()}`);
  console.log('NEXT (required): node tools/verify-catalog.js — proves the pointer serves version 1 byte-identical to code');
  process.exit(0);
})().catch((e) => { console.error('publish-version failed:', e && e.stack || e); process.exit(1); });
