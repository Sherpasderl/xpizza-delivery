// S3 (D4c-grill/item-s1/S3-DESIGN.md) — the REAL published menu a client is served, and the REAL tables the server resolves its
// lines against, from ONE published version. Shared by the S3 suites (forms + customer app); not a test itself.
//
//   published(rid, { rename, mint }) → { env, body, tables, source }
//     the seed source (tools/seed-source-store) → [a rename / a minted addition, each by the server's OWN writer] → the build
//     (buildSourceCandidate) → publishVersion (catalog-publish, on the strict Firestore fake) → buildPublicMenu (the ENDPOINT path:
//     identity overlay ON, so the body carries S1d's top-level `item_keys`) → env; and the same db through the production catalog
//     reader + pricing resolver → tables (key mode + labels attached, exactly what the four endpoints hand resolveLines).
//   rename: { key, to }  — the editor's own pure steps (edit-catalog-handler.js:113): canonicalize → rederiveOptionNames →
//                          recordRenames (frozen-keys.js:66) → withFrozenKeys. The emulator cell through editCatalogCore is owed in
//                          the slot (S3-DESIGN ruling: the editor-path rename).
//   mint:   { name, key } — add-product.js allocateAdditions with an injected `mint` (S1c's real allocator; MINT_OPAQUE stays false).
import { createRequire } from 'node:module';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion } = require('./catalog/catalog-publish');
const { buildSourceCandidate } = require('./catalog/candidate-validate');
const { buildPublicMenu } = require('./catalog/public-menu');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { canonicalize } = require('./catalog/source-store');
const FK = require('./catalog/frozen-keys');
const AP = require('./catalog/add-product');
const { createCatalogReader } = require('./catalog/catalog');
const { createPricingResolver } = require('./catalog/pricing-tables');
const CF = require('./catalog/catalog-firestore');

const clone = (v) => JSON.parse(JSON.stringify(v));
const KNOWN = new Set(['x_pizza', 'la_musa']);
const MODE = { x_pizza: 'name', la_musa: 'id' };

function renamed(live, { key, to }) {
  const draft = clone(live);
  const it = draft.items.find((i) => i.key === key);
  if (!it) throw new Error(`item-s3-fixtures: no item keyed ${key}`);
  it.display.name = to;
  let candidate = canonicalize(AP.rederiveOptionNames(canonicalize(draft)));
  const rec = FK.recordRenames({ draft: candidate, live, stored: live, textEdit: true });
  if (!rec.ok) throw new Error(`item-s3-fixtures: recordRenames refused (${rec.error})`);
  candidate = canonicalize(FK.withFrozenKeys(candidate, rec.frozen_keys));
  return candidate;
}

function minted(live, rid, { name, key }) {
  const incoming = clone(live);
  const cat = incoming.items[0].display.cat;
  incoming.items.push({ ref: 'tmp:s3mint01', price: 150, display: { name, cat, desc: '', price: 150 } });
  incoming.structure.item_order.push('tmp:s3mint01');
  const r = AP.allocateAdditions({ incoming, stored: live, activeItems: live.items, keyMode: MODE[rid], hwm: null, registryHasKey: () => false,
    mint: { newKey: () => key, reserved: new Set() } });
  return canonicalize(r.source);
}

export async function published(rid, { rename = null, mint = null } = {}) {
  let source = canonicalize(buildSourceFromCode(rid));
  if (rename) source = renamed(source, rename);
  if (mint) source = minted(source, rid, mint);
  const db = makeDb();
  const { inputs, built } = buildSourceCandidate(rid, source);
  const log = console.log; console.log = () => {};   // the publish's own diagnostics (mirror skip, post-flip pass) are not this suite's
  try {
    await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's3',
      ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, { expected: { activeVersionId: null } });
  } finally { console.log = log; }
  const m = await buildPublicMenu(db, rid, { known: KNOWN, isActive: async () => true });
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  const tables = await createPricingResolver({ reader, alarm: () => {} }).getPricingTables(rid);
  const body = clone(m.body);
  return { env: { rid: m.rid, representation_version: m.representation_version, menu: body }, body, tables, source };
}
