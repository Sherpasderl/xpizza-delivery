'use strict';
// ---------------------------------------------------------------------------
// Portal 1A Task 8 — THE PROVENANCE MERGE. The migration that gives the live catalog its display
// dataset without changing one charged or served value.
//
// 🔴 PRICES COME FROM WHAT IS LIVE, NEVER FROM CODE. The whole reason this is a merge and not a
// re-seed: by the time it runs, a merchant may have published a price that no longer matches
// menu-pricing.js, and rebuilding from code would silently revert it. Every price in the candidate is
// the captured document's own. The code tables are never consulted here — not as a default, not as a
// fallback, not to fill a gap.
//
// WHAT COMES FROM WHERE, per field:
//   • price, display.price, item display records, item_order, categories, variants, gate cats,
//     redemption  → THE CAPTURED DOCUMENT (the live version, or the merchant's draft).
//   • extras display records, the extra-category namespace, badges, exposure
//     → THE DEPLOYED SERVING ARTIFACT, because the catalog has never carried them. An extra was
//       persisted as {key, price}; its name, its group and who is offered it live in the form.
//
// AMBIGUITY IS REFUSED, NEVER GUESSED. The join between "a priced key" and "a display record" is the
// only place this can go wrong quietly, so every way it can be non-1:1 is a rejection with a reason:
// two artifact records resolving to one pricing key, a record resolving to no priced key, a priced
// key no record describes. A migration that guesses is a migration that renames someone's dish.
//
// 🔴 PROVENANCE IS A REPORT, NOT A FIELD. The version content hash covers the structure document
// WHOLESALE, so a per-field provenance marker written into menu_structure would make two versions
// with an identical menu hash differently — and read as "the menu changed" to 1B and 1C. The
// provenance is returned alongside the candidate and never appears inside it.
//
// THE CANDIDATE IS A SOURCE DOCUMENT, built by the SAME builder every other publish path uses. Not a
// bespoke assembly: the key↔display bijection, the extras bijection and the complete validator are
// the rules that already govern a publish, and a migration that met different ones would be a
// migration whose output nothing else could accept.
// ---------------------------------------------------------------------------
const { SCHEMA_VERSION, validateSource, sourceToBuildInputs, sourceRefOf, encodeUpdateTime, canonicalize, extrasKeyOf } = require('../catalog/source-store');
const { buildCatalogV2, pricingKeyOf, formSource, readLiteral, readSetLiteral } = require('../catalog/form-menu-source');
const { attachExposure, assertExposureMatchesToday } = require('../catalog/exposure-source');
const { attachRedeemFields } = require('../catalog/redeem-source');

const refuse = (reason, detail) => { const e = new Error(`migration_refused_${reason}: ${detail}`); e.code = `migration_refused_${reason}`; throw e; };

// ── THE DEPLOYED SERVING ARTIFACT ────────────────────────────────────────────────────────────────
// The shipped form, read as data. This is the artifact customers are being served from right now,
// which is what makes it the right provenance for display fields the catalog never carried.
function deployedArtifact(restaurantId, formText = null) {
  const src = formText === null ? formSource(restaurantId) : formText;
  const lit = (name, o, c) => { try { return readLiteral(src, name, o, c); } catch (_) { return null; } };
  assertExposureMatchesToday(restaurantId, src);   // the authored exclusion set still matches the renderer
  return {
    dishes: lit('MENU') || [],
    extras: lit('EXTRAS') || [],
    categories: lit('CATEGORIES'),
    variant_items: lit('VARIANT_ITEMS', '{', '}'),
    badges: lit('TAG_BADGES', '{', '}'),
    extras_by_category: lit('EXTRAS_BY_CATEGORY', '{', '}'),
    extras_by_item: lit('EXTRAS_BY_ITEM', '{', '}'),
    has_photo: (() => { try { return readSetLiteral(src, 'HAS_PHOTO'); } catch (_) { return []; } })(),
  };
}

// A display collection from the artifact, indexed by the PRICING key — the only join that means
// anything, and the one place a silent mismatch would rename someone's dish.
function indexByPricingKey(restaurantId, records, keyOf, what) {
  const byKey = new Map();
  for (const rec of records) {
    const key = keyOf(restaurantId, rec);
    if (typeof key !== 'string' || !key) {
      refuse('unkeyable', `${restaurantId} — a ${what} record in the deployed artifact resolves to no pricing key: ${JSON.stringify(rec).slice(0, 120)}`);
    }
    if (byKey.has(key)) {
      refuse('ambiguous', `${restaurantId}/${key} — two ${what} records in the deployed artifact resolve to the SAME pricing key; the merge will not choose between them`);
    }
    byKey.set(key, rec);
  }
  return byKey;
}

// ── THE MERGE ────────────────────────────────────────────────────────────────────────────────────
// `captured` is a source-shaped document whose PRICES are authoritative: the live version, or the
// merchant's draft. Both are merged by the same function, because "what this document already says
// wins, and only the gaps come from the artifact" is one rule, not two.
function upgradeDocument(restaurantId, captured, artifact) {
  const provenance = {};
  const note = (path, from) => { provenance[path] = from; };

  const capturedItems = Array.isArray(captured.items) ? captured.items : [];
  const capturedExtras = Array.isArray(captured.extras) ? captured.extras : [];
  if (!capturedItems.length) refuse('empty', `${restaurantId} — the captured document has no items; there is nothing to migrate`);

  const dishByKey = indexByPricingKey(restaurantId, artifact.dishes, pricingKeyOf, 'dish');
  const extraByKey = indexByPricingKey(restaurantId, artifact.extras, extrasKeyOf, 'extra');
  const photo = new Set(artifact.has_photo || []);

  // ITEMS — price always the captured one; display kept if the capture has it, taken from the
  // artifact only to fill a gap.
  const items = capturedItems.map((it) => {
    if (typeof it.key !== 'string' || !it.key) refuse('malformed', `${restaurantId} — a captured item has no pricing key`);
    const out = { key: it.key, price: it.price };
    note(`items.${it.key}.price`, 'captured');
    if (it.display && typeof it.display === 'object') {
      out.display = it.display;
      note(`items.${it.key}.display`, 'captured');
    } else {
      const fromArtifact = dishByKey.get(it.key);
      if (!fromArtifact) {
        refuse('undescribed', `${restaurantId}/${it.key} — priced in the catalog and described nowhere: no display record in the capture and none in the deployed artifact`);
      }
      out.display = { ...fromArtifact };
      note(`items.${it.key}.display`, 'artifact');
    }
    // 🔴 THE SHOWN PRICE FOLLOWS THE CHARGED ONE. A display record taken from the artifact carries
    // the price the FORM was shipped with, which is exactly the value a live edit has moved on from.
    // Copying it over unchanged is how a migration reverts a price while every count still matches.
    if (out.display.price !== out.price) {
      out.display = { ...out.display, price: out.price };
      note(`items.${it.key}.display.price`, 'captured');
    }
    if (it.has_photo !== undefined) { out.has_photo = it.has_photo; note(`items.${it.key}.has_photo`, 'captured'); }
    else if (photo.size) { out.has_photo = photo.has(it.key); note(`items.${it.key}.has_photo`, 'artifact'); }
    return out;
  });

  // EXTRAS — the half the catalog never carried. Price captured, description from the artifact.
  //
  // 🔴 IN THE DEPLOYED ORDER, and this is not cosmetic. A capture comes back in Firestore's DOC-ID
  // order, and the ids are content hashes — so the captured sequence is effectively random
  // ("Salsa Blanca, Whipped Ricotta, Maíz, Pepperoni…" against a form that offers "Salsa Roja, Salsa
  // Blanca, Salsa Calabrian Chili…"). The builder derives extra_order from THIS array, so migrating
  // in capture order would serve every merchant's options shuffled, on the first read after cutover.
  // Anything the artifact does not order is appended rather than dropped.
  const artifactOrder = new Map([...extraByKey.keys()].map((k, i) => [k, i]));
  const orderedCaptured = capturedExtras.slice().sort((a, b) => {
    const ai = artifactOrder.has(a.key) ? artifactOrder.get(a.key) : Number.MAX_SAFE_INTEGER;
    const bi = artifactOrder.has(b.key) ? artifactOrder.get(b.key) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
  const extras = orderedCaptured.map((ex) => {
    if (typeof ex.key !== 'string' || !ex.key) refuse('malformed', `${restaurantId} — a captured extra has no pricing key`);
    const out = { key: ex.key, price: ex.price };
    note(`extras.${ex.key}.price`, 'captured');
    if (ex.display && typeof ex.display === 'object') {
      out.display = ex.display;
      note(`extras.${ex.key}.display`, 'captured');
    } else {
      const fromArtifact = extraByKey.get(ex.key);
      if (!fromArtifact) {
        refuse('undescribed', `${restaurantId}/${ex.key} — an option is charged for and described nowhere: no display record in the capture and none in the deployed artifact`);
      }
      out.display = { ...fromArtifact };
      note(`extras.${ex.key}.display`, 'artifact');
    }
    if (out.display.price !== out.price) {
      out.display = { ...out.display, price: out.price };
      note(`extras.${ex.key}.display.price`, 'captured');
    }
    return out;
  });

  // ...and the reverse direction. A record in the artifact that the catalog does not price is an
  // option a customer can be offered and never charged for — the one direction a per-item loop
  // cannot see, because it only ever walks what is priced.
  const pricedExtras = new Set(extras.map((e) => e.key));
  for (const [key] of extraByKey) {
    if (!pricedExtras.has(key)) {
      refuse('unpriced', `${restaurantId}/${key} — the deployed artifact offers an option the catalog does not price; migrating it would either invent a price or drop the option`);
    }
  }

  // STRUCTURE — the capture's, with the gaps filled and the authored "desde" stripped.
  const structure = JSON.parse(JSON.stringify(captured.structure || {}));
  structure.schema_version = SCHEMA_VERSION;
  for (const f of Object.keys(structure)) note(`structure.${f}`, 'captured');

  // 🔴 STRIP THE AUTHORED basePrice. Task 7's validator refuses one outright — "desde" is derived at
  // emission — so an un-stripped capture publishes nothing and an un-stripped DRAFT fails on the
  // merchant's next portal publish, with no clue that a migration put it there. The served bundle
  // re-derives the same number, so nothing a customer sees moves.
  if (structure.variant_items && typeof structure.variant_items === 'object') {
    for (const [launcher, spec] of Object.entries(structure.variant_items)) {
      if (spec && typeof spec === 'object' && Object.prototype.hasOwnProperty.call(spec, 'basePrice')) {
        const { basePrice, ...rest } = spec;      // eslint-disable-line no-unused-vars
        structure.variant_items[launcher] = rest;
        note(`structure.variant_items.${launcher}.basePrice`, 'stripped');
      }
    }
  }
  if (!Array.isArray(structure.item_order) || !structure.item_order.length) {
    structure.item_order = items.map((i) => i.key);
    note('structure.item_order', 'derived');
  }
  if (!structure.categories && artifact.categories) { structure.categories = artifact.categories; note('structure.categories', 'artifact'); }
  if (!structure.badges && artifact.badges && Object.keys(artifact.badges).length) { structure.badges = artifact.badges; note('structure.badges', 'artifact'); }

  // THE EXTRA-CATEGORY NAMESPACE, in the artifact's own order — the order options are offered in.
  if (structure.extra_categories === undefined) {
    const cats = [];
    for (const rec of artifact.extras) {
      const c = rec && rec.cat;
      if (typeof c === 'string' && c && !cats.includes(c)) cats.push(c);
    }
    if (cats.length) { structure.extra_categories = cats; note('structure.extra_categories', 'artifact'); }
  }
  // extra_order is NOT set here. The builder derives it from the extras array — which is now in the
  // deployed order — and a second copy computed here would be a second source for the same fact,
  // silently ignored by the one path that actually publishes. That is exactly how the ordering came
  // to be wrong in the first place.
  note('structure.extra_order', 'derived-from-extras-order');

  // EXPOSURE — extracted from the artifact's maps, or authored from its renderer. The legacy maps
  // are re-derived from it rather than carried, so there is one authority and one output.
  const hadExposure = Object.prototype.hasOwnProperty.call(structure, 'exposure');
  attachExposure(restaurantId, structure, items, { byCategory: artifact.extras_by_category, byItem: artifact.extras_by_item });
  if (!hadExposure && structure.exposure) note('structure.exposure', 'artifact');

  // Redemption eligibility, if the capture predates it carrying any.
  if (structure.redeem_eligible_cats === undefined) {
    const extraTable = {}; for (const e of extras) extraTable[e.key] = e.price;
    attachRedeemFields(restaurantId, structure, items, extraTable);
    note('structure.redeem_eligible_cats', 'derived');
  }

  const source = { restaurant_id: restaurantId, schema_version: SCHEMA_VERSION, items, extras, structure };
  // Fail closed at ASSEMBLY, not at publish time: a candidate that cannot validate must not reach a
  // CLI that would try to publish it, and a draft that cannot validate must not be written back over
  // one that could.
  validateSource(source, restaurantId);
  return { source, provenance };
}

// THE PUBLISH CANDIDATE. Built with the same builder every other publish path uses, and bound to the
// version it was captured from: a concurrent publish invalidates it at the flip rather than
// overwriting whatever landed.
function buildMigrationCandidate(restaurantId, captured, artifact, { source_sha = 'migration' } = {}) {
  const { source, provenance } = upgradeDocument(restaurantId, captured, artifact);
  const inputs = sourceToBuildInputs(source);
  const built = buildCatalogV2(restaurantId, { formData: inputs.formData, priceTable: inputs.priceTable, extrasTable: inputs.extras });
  return {
    source,
    provenance,
    input: { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha },
    expected: { activeVersionId: captured.versionId === undefined ? null : captured.versionId },
  };
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────────────────
// Capture the live version as a source-shaped document. The POINTER is read first and the version is
// read THROUGH it, so the id the candidate binds its CAS to is the id it actually captured.
async function captureActiveVersion(db, restaurantId) {
  const pointer = await db.collection('restaurants').doc(restaurantId).collection('meta').doc('active_version').get();
  if (!pointer.exists) refuse('no_active_version', `${restaurantId} — nothing is published; there is no live catalog to migrate`);
  const versionId = (pointer.data() || {}).version;
  if (typeof versionId !== 'string' || !versionId) refuse('no_active_version', `${restaurantId} — the active_version pointer is malformed`);
  const vref = db.collection('restaurants').doc(restaurantId).collection('versions').doc(versionId);
  const [rec, itemSnap, extraSnap, structSnap] = await Promise.all([
    vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get(), vref.collection('meta').doc('menu_structure').get(),
  ]);
  if (!rec.exists) refuse('version_missing', `${restaurantId}/${versionId}`);
  const docsOf = (snap) => snap.docs.map((d) => d.data() || {});
  return {
    versionId,
    record: rec.data() || {},
    items: docsOf(itemSnap),
    extras: docsOf(extraSnap),
    structure: structSnap.exists ? (structSnap.data() || {}) : {},
  };
}

// THE DRAFT UPGRADE — in place, and it must not publish the merchant's pending edits.
//
// The draft is upgraded by the SAME merge, so its prices (which ARE the pending edits) are carried
// exactly as the live version's are. What it gains is the display dataset the schema now requires;
// what it does not gain is a publish. Without this the merchant's next portal publish fails the
// Task-7 validator on a document they never touched — an authored basePrice, or no exposure.
async function upgradeDraftInPlace(db, restaurantId, artifact, { apply = false } = {}) {
  const snap = await sourceRefOf(db, restaurantId).get();
  if (!snap.exists) return { upgraded: false, reason: 'no_draft' };
  const draft = snap.data();
  const revision = encodeUpdateTime(snap.updateTime);
  const { source, provenance } = upgradeDocument(restaurantId, draft, artifact);
  const before = JSON.stringify(canonicalize(draft));
  const after = JSON.stringify(canonicalize(source));
  if (before === after) return { upgraded: false, reason: 'already_current', revision, provenance };
  if (apply) {
    // CONDITIONAL on the revision it was read at: a merchant saving an edit between the read and the
    // write must not have it overwritten by an upgrade of the version they replaced.
    await sourceRefOf(db, restaurantId).set(canonicalize(source), { lastUpdateTime: snap.updateTime });
  }
  return { upgraded: true, revision, source, provenance, applied: !!apply };
}

module.exports = {
  deployedArtifact, upgradeDocument, buildMigrationCandidate, captureActiveVersion, upgradeDraftInPlace, indexByPricingKey,
};

// ── THE CLI (owner-run, Task 9) ─────────────────────────────────────────────────────────────────
//
//   node tools/migrate-catalog-display.js              # DRY RUN — reports, writes nothing
//   node tools/migrate-catalog-display.js --apply      # publish the candidate + upgrade the drafts
//
// 🔴 THE CANDIDATE IS PUBLISHED HERE, NOT VIA `publish-version --from-store`. The plan's runbook
// sketch routed it that way, and it cannot go that way: --from-store publishes the DRAFT, and a draft
// may hold a merchant's pending, unpublished edits. Publishing it would ship an edit nobody reviewed —
// the one thing this task promises not to do. So the two outputs stay separate: the candidate (built
// from the ACTIVE VERSION) is published under the CAS that binds it to the version it captured, and
// the draft is upgraded in place and left unpublished. Flagged for Task 9's runbook.
if (require.main !== module) return;

try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency */ }
const admin = require('firebase-admin');
const { publishVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror, RTDB_URL } = require('../catalog/mirror-rtdb');

const APPLY = process.argv.includes('--apply');
const RIDS = ['x_pizza', 'la_musa'];

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: RTDB_URL });
const db = admin.firestore();

(async () => {
  console.log(APPLY ? 'MIGRATION — APPLYING (publishes a version + upgrades each draft)' : 'MIGRATION — DRY RUN (writes nothing)');
  for (const rid of RIDS) {
    const artifact = deployedArtifact(rid);
    const captured = await captureActiveVersion(db, rid);
    const cand = buildMigrationCandidate(rid, captured, artifact, { source_sha: `migrate-${captured.versionId}` });

    // A belt over the braces: by construction every price is the capture's own, so this can only
    // fire if that stopped being true — in which case nothing should be written on any account.
    const from = {}; for (const i of captured.items) from[i.key] = i.price;
    const to = {}; for (const i of cand.input.items) to[i.key] = i.price;
    const moved = Object.keys({ ...from, ...to }).filter((k) => from[k] !== to[k]);
    if (moved.length) throw new Error(`migration_refused_price_moved: ${rid} — ${moved.join(', ')}`);
    const bySource = {};
    for (const v of Object.values(cand.provenance)) bySource[v] = (bySource[v] || 0) + 1;
    console.log(`  ${rid}: captured ${captured.versionId} — ${cand.input.items.length} items + ${cand.input.extraRecords.length} options`);
    console.log(`    provenance: ${Object.entries(bySource).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    console.log(`    prices moved: ${moved.length} (must be 0)`);

    if (APPLY) {
      const res = await publishVersion(db, rid, cand.input, {
        expected: cand.expected,                       // aborts if anything published since the capture
        mirror: makeRtdbMirror(admin.database()),
      });
      console.log(`    published ${res.versionId} (from ${captured.versionId})`);
    }
    const draft = await upgradeDraftInPlace(db, rid, artifact, { apply: APPLY });
    console.log(`    draft: ${draft.upgraded ? (APPLY ? 'UPGRADED in place (its pending edits preserved, nothing published)' : 'would be upgraded') : `unchanged (${draft.reason})`}`);
  }
  console.log(APPLY ? 'NEXT (required): node tools/verify-catalog.js' : 'nothing written. re-run with --apply when the parity gate has passed.');
  process.exit(0);
})().catch((e) => { console.error('migration failed (nothing published unless stated above):', (e && e.stack) || e); process.exit(1); });
