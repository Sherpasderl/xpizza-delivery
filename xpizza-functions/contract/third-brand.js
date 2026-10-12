'use strict';
/* R3 §5c — THE THIRD SYNTHETIC BRAND: test-owned, valid source data published through the REAL publish path.
 *
 * A brand-new merchant's FIRST catalog is not a portal edit (publishEdited edits an existing active catalog) and the CLI
 * refuses unknown brands (seed-source-store). The real first-publish path is the one c2a-evidence drives: the SOURCE
 * document in the store → the shared builder (sourceToBuildInputs → buildCatalogV2(rid, { formData, priceTable })) →
 * publishVersion, the same function the CLI and the portal call (verify-before-flip, CAS on the pointer).
 *
 * The source is derived from x_pizza's, with EVERY dish key and name renamed (an exact-string bijection over the whole
 * document, so the structure stays consistent) and zero extras (bootstrap refuses `bootstrap_unpriced_extra` for a
 * synthetic rid with extras — a pre-existing brand coupling c2a disclosed). A renamed catalog means code that looks a
 * dish up in x_pizza's tables BY NAME fails visibly instead of being accidentally right (the two-brands-mask-literals
 * lesson). No production rid, host or literal is rewritten.
 */
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { publishVersion } = require('../catalog/catalog-publish');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { sourceRefOf, canonicalize, sourceToBuildInputs, encodeUpdateTime } = require('../catalog/source-store');

const THIRD = 'r3_synth';

function renameAll(obj, map) {
  if (typeof obj === 'string') return Object.prototype.hasOwnProperty.call(map, obj) ? map[obj] : obj;
  if (Array.isArray(obj)) return obj.map((x) => renameAll(x, map));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k] = renameAll(v, map);
    return out;
  }
  return obj;
}

function thirdBrandSource() {
  const t = JSON.parse(JSON.stringify(buildSourceFromCode('x_pizza')));
  const map = {};
  for (const it of t.items) { if (typeof it.key === 'string') map[it.key] = `R3 ${it.key}`; if (it.display && typeof it.display.name === 'string' && !map[it.display.name]) map[it.display.name] = `R3 ${it.display.name}`; }
  const src = renameAll(t, map);
  src.extras = [];
  src.structure = { ...src.structure, extra_categories: [], extras_by_category: Object.fromEntries(Object.keys(src.structure.extras_by_category || {}).map((k) => [k, []])),
    exposure: { ...(src.structure.exposure || {}), category_allow: Object.fromEntries(Object.keys((src.structure.exposure || {}).category_allow || {}).map((k) => [k, []])), item_overrides: {} } };
  for (const it of src.items) { if (it.display) delete it.display.identity_id; }
  return { source: src, renamed: map };
}

function candidateFromSource(rid, src) {
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
}

// publish the third brand's V1 through the real path; returns { versionId, source, renamed }
async function publishThirdBrand(fs, { rid = THIRD, mirror } = {}) {
  const { source, renamed } = thirdBrandSource();
  await sourceRefOf(fs, rid).set(canonicalize(source));
  const snap = await sourceRefOf(fs, rid).get();
  const prev = await getActivePointer(fs, rid);
  const cur = prev && prev.version ? prev.version : null;
  await publishVersion(fs, rid, { ...candidateFromSource(rid, snap.data()), source_sha: `r3-${rid}` },
    { expected: { activeVersionId: cur, draftRevision: encodeUpdateTime(snap.updateTime) }, ...(mirror ? { mirror } : {}) });
  return { versionId: (await getActivePointer(fs, rid)).version, source: snap.data(), renamed };
}

module.exports = { THIRD, thirdBrandSource, publishThirdBrand, candidateFromSource };
