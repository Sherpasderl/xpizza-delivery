'use strict';
// Portal 1D · D4-a — the PURE context builder (catalog/catalog-context.js), over the two REAL catalogs
// and a synthetic third restaurant. Expected values come from the catalog snapshot and the EXISTING
// content-hash definition, never from the builder.
const assert = require('assert');
const { buildContext, identityPairs } = require('./catalog-context');
const { contentHash } = require('./content-hash');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));

// A version's RAW payload as Firestore would hold it: docs with ids, the structure, and a record whose
// content_hash is pinned over the served payload (what the publisher does), unless `pinOver` says otherwise.
function rawFor(rid, { certified = false, stamp = null, mutate = null, pinOver = null, src = null } = {}) {
  const snap = clone(src || catalogSnapshot(rid));
  if (stamp) {
    snap.items.forEach((it, i) => { const id = stamp('dish', it, i); if (id !== undefined) it.display.identity_id = id; });
    snap.extras.forEach((ex, i) => { const id = stamp('extra', ex, i); if (id !== undefined) ex.display.identity_id = id; });
  }
  const pinned = clone(pinOver ? pinOver(snap) : snap);
  if (mutate) mutate(snap);
  const order = (recs, ord) => ord.map((k) => recs.find((r) => r.key === k));
  const hash = contentHash({ rid, schema_version: 2, items: order(pinned.items, pinned.structure.item_order),
    extras: order(pinned.extras, pinned.structure.extra_order), structure: pinned.structure });
  const docs = (recs) => recs.map((r, i) => ({ id: `d${String(i).padStart(3, '0')}`, data: { key: r.key, price: r.price, display: r.display, ...(r.has_photo !== undefined ? { has_photo: r.has_photo } : {}) } }));
  return {
    rid, versionId: 'v-test',
    record: { version: 'v-test', seq: 7, schema_version: 2, content_hash: hash, ...(certified ? { identity_certified: true } : {}) },
    items: docs(snap.items), extras: docs(snap.extras), structure: snap.structure,
  };
}
const tablesOf = (rid) => {
  const s = catalogSnapshot(rid);
  return { menu: Object.fromEntries(s.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(s.extras.map((e) => [e.key, e.price])) };
};
const allStamped = (kind, rec, i) => `${kind === 'dish' ? 'D' : 'E'}${String(i).padStart(9, '0')}`;

try {
  // 1. Certified + fully stamped, both brands: intact, full coverage, complete, prices exactly the catalog's.
  for (const rid of ['x_pizza', 'la_musa']) {
    const ctx = buildContext(rawFor(rid, { certified: true, stamp: allStamped }));
    const snap = catalogSnapshot(rid);
    assert.strictEqual(ctx.built, true);
    assert.strictEqual(ctx.contentIntegrity.state, 'intact', `${rid}: an untouched payload is intact`);
    assert.deepStrictEqual(ctx.coverage.dish, { state: 'full', covered: snap.items.length, total: snap.items.length });
    assert.deepStrictEqual(ctx.coverage.extra, { state: 'full', covered: snap.extras.length, total: snap.extras.length });
    assert.strictEqual(ctx.complete, true);
    assert.deepStrictEqual(ctx.prices, tablesOf(rid), `${rid}: prices re-derived from objects equal the catalog's {key: price}`);
    assert.strictEqual(ctx.objects.length, snap.items.length + snap.extras.length);
    const first = ctx.objects[0];
    assert.deepStrictEqual(Object.keys(first).sort(), ['canonicalId', 'kind', 'label', 'legacyKey', 'policy', 'price']);
    assert.strictEqual(first.label, snap.items.find((i) => i.key === first.legacyKey).display.name, 'label = display.name of the SAME version');
    assert.strictEqual(identityPairs(ctx).length, ctx.objects.length);
  }
  ok('certified + fully stamped (x_pizza 24+14, la_musa 44+14): intact, coverage full, complete, prices = the catalog tables exactly');

  // 2. Uncertified: canonicalId null everywhere (owner Q2), coverage none — raw stamps reported separately.
  for (const rid of ['x_pizza', 'la_musa']) {
    const ctx = buildContext(rawFor(rid, { certified: false, stamp: allStamped }));
    assert.ok(ctx.objects.every((o) => o.canonicalId === null), `${rid}: no canonicalId on an uncertified version`);
    assert.strictEqual(ctx.coverage.dish.state, 'none'); assert.strictEqual(ctx.coverage.extra.state, 'none');
    assert.strictEqual(ctx.rawStampCoverage.dish.state, 'full', '…but the raw stamps are REPORTED, separately');
    assert.strictEqual(ctx.complete, false);
    assert.strictEqual(ctx.contentIntegrity.state, 'intact', 'certification is not content');
    assert.strictEqual(identityPairs(ctx).length, 0);
  }
  ok('uncertified: every canonicalId null, coverage none, raw stamp coverage reported separately, not complete');

  // 3. Coverage from OBJECTS, not the flag: certified with stamps on only some objects → partial (counts).
  const partial = buildContext(rawFor('x_pizza', { certified: true, stamp: (k, r, i) => (k === 'dish' && i < 5 ? allStamped(k, r, i) : undefined) }));
  assert.deepStrictEqual(partial.coverage.dish, { state: 'partial', covered: 5, total: 24 });
  assert.deepStrictEqual(partial.coverage.extra, { state: 'none', covered: 0, total: 14 });
  assert.strictEqual(partial.complete, false);
  ok('coverage is counted over objects: certified with 5/24 dish stamps → dish partial (5/24), extra none; not complete');

  // 4. Labels missing in the PUBLISHED payload → completeness, NOT integrity.
  const noName = (s) => { delete s.items[3].display.name; s.extras[1].display.name = ''; return s; };
  const lab = buildContext(rawFor('la_musa', { certified: true, stamp: allStamped, pinOver: noName, mutate: noName }));
  assert.strictEqual(lab.contentIntegrity.state, 'intact', 'the version was PUBLISHED without those names, so it is intact');
  assert.strictEqual(lab.labels.state, 'incomplete');
  assert.strictEqual(lab.labels.missing.length, 2);
  assert.strictEqual(lab.complete, false);
  ok('a missing/empty display.name → labels:incomplete (2 named) and complete=false, while integrity stays intact');

  // 5. SAME ids + SAME prices, DIFFERENT label → content mismatch.  6. … different POLICY → mismatch.
  const relabel = buildContext(rawFor('x_pizza', { certified: true, stamp: allStamped, mutate: (s) => { s.items[0].display.name += ' (edit)'; } }));
  assert.strictEqual(relabel.contentIntegrity.state, 'mismatch');
  assert.strictEqual(relabel.contentIntegrity.reason, 'catalog_content_mismatch');
  assert.ok(relabel.contentIntegrity.detail.includes('x_pizza/versions/v-test'), 'names the version');
  assert.deepStrictEqual(relabel.prices, tablesOf('x_pizza'), 'premise — prices unchanged');
  const repolicy = buildContext(rawFor('x_pizza', { certified: true, stamp: allStamped, mutate: (s) => { s.structure.weekend_only_cats = []; } }));
  assert.strictEqual(repolicy.contentIntegrity.state, 'mismatch');
  ok('same ids + same prices but a different label, or a different policy field → contentIntegrity mismatch, naming the version');

  // 7. A stamp SWAP keeps integrity intact BY DESIGN (stamps are excluded from content_hash); the pairs move.
  const base = buildContext(rawFor('x_pizza', { certified: true, stamp: allStamped }));
  const swapped = buildContext(rawFor('x_pizza', { certified: true, stamp: (k, r, i) => (k === 'dish' && i < 2 ? allStamped(k, r, 1 - i) : allStamped(k, r, i)) }));
  assert.strictEqual(swapped.contentIntegrity.state, 'intact', 'by design — the verifier, not the hash, binds stamps');
  assert.notDeepStrictEqual(identityPairs(swapped), identityPairs(base), 'the swap is visible in the pairs the verifier compares');
  ok('a stamp swap leaves integrity intact (by design) and changes the identity pairs the registry verifier judges');

  // 8. Ids: a duplicate within a kind, and a malformed id → reported, not complete.
  const dup = buildContext(rawFor('la_musa', { certified: true, stamp: (k, r, i) => (k === 'dish' && i === 1 ? allStamped(k, r, 0) : allStamped(k, r, i)) }));
  assert.strictEqual(dup.ids.unique, false); assert.strictEqual(dup.complete, false);
  const bad = buildContext(rawFor('la_musa', { certified: true, stamp: (k, r, i) => (k === 'extra' && i === 0 ? 'a/b' : allStamped(k, r, i)) }));
  assert.strictEqual(bad.ids.wellFormed, false); assert.strictEqual(bad.complete, false);
  const crossKind = buildContext(rawFor('la_musa', { certified: true, stamp: (k, r, i) => `SAME${i}` }));
  assert.strictEqual(crossKind.ids.unique, true, 'uniqueness is PER KIND: a dish and an extra may not collide with each other');
  ok('a duplicate id within a kind → ids.unique=false; a malformed id → ids.wellFormed=false; uniqueness is per kind');

  // 9. A mutated persisted RAW display name → mismatch.  10. An unbuildable payload → mismatch, never a throw.
  const raw = rawFor('x_pizza', { certified: true, stamp: allStamped });
  raw.items[2].data.display.name = 'tampered';
  assert.strictEqual(buildContext(raw).contentIntegrity.state, 'mismatch');
  const noStruct = rawFor('x_pizza', { certified: true }); noStruct.structure = null;
  const ns = buildContext(noStruct);
  assert.strictEqual(ns.built, false); assert.strictEqual(ns.contentIntegrity.state, 'mismatch'); assert.strictEqual(ns.contentIntegrity.reason, 'menu_structure_missing');
  for (const junk of [null, undefined, 5, {}, { record: null }]) assert.strictEqual(buildContext(junk).contentIntegrity.state, 'mismatch');
  const disagree = rawFor('x_pizza', { certified: true }); disagree.items[0].data.price += 1;   // charged ≠ shown
  assert.strictEqual(buildContext(disagree).built, false);
  ok('a tampered raw name → mismatch; missing structure, a price disagreement or junk input → unbuilt + mismatch with a reason, never a throw');

  // 11. No pinned hash → unknown (cannot be authenticated, but is not shown corrupt). Wrong version → mismatch.
  const nohash = rawFor('x_pizza', { certified: true }); delete nohash.record.content_hash;
  assert.strictEqual(buildContext(nohash).contentIntegrity.state, 'unknown');
  const wrongV = rawFor('x_pizza', { certified: true }); wrongV.record.version = 'v-other';
  assert.strictEqual(buildContext(wrongV).contentIntegrity.reason, 'version_identity_mismatch');
  ok('no pinned content_hash → integrity unknown; a record naming another version → mismatch');

  // 12. BRAND-FREE: a synthetic THIRD restaurant (la_musa's data under a new rid) behaves identically.
  const third = buildContext(rawFor('synthetic_3', { certified: true, stamp: allStamped, src: catalogSnapshot('la_musa') }));
  const lm = buildContext(rawFor('la_musa', { certified: true, stamp: allStamped }));
  const shape = (c) => ({ integrity: c.contentIntegrity.state, coverage: c.coverage, complete: c.complete, objects: c.objects, prices: c.prices, labels: c.labels, ids: c.ids, policyRules: c.policyRules });
  assert.deepStrictEqual(shape(third), shape(lm));
  assert.strictEqual(third.rid, 'synthetic_3');
  ok('a synthetic 3rd restaurant with the same data yields an identical context (only the rid differs)');

  console.log(`catalog-context: OK (${n})`);
} catch (e) {
  console.error('catalog-context FAILED:', e);
  process.exit(1);
}
