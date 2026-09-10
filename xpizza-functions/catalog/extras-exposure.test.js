// Task 1 — THE EXPOSURE CONTRACT, pinned against today's shipped renderers.
//
// Exposure is display/eligibility only: which option set a customer is offered for an item. It is NOT
// pricing, and 1A must not turn a display rule into a charging restriction.
//
// The oracle here is a TRANSCRIPTION OF THE TWO SHIPPED FORMS, read from the real files rather than
// hand-copied, because the contract's only real claim is "every item's option set is what it is today".
// A fixture I authored would prove that my resolver agrees with my idea of the forms.
const { test } = require('node:test');
const assert = require('node:assert');
const { formSource, readLiteral } = require('./form-menu-source');
const { resolveExposure, deriveLegacyMaps, ALL } = require('./extras-exposure');

// ── the real artifacts ───────────────────────────────────────────────────────────────────────────
const real = (rid) => {
  const src = formSource(rid);
  const dishes = readLiteral(src, 'MENU');
  const extras = readLiteral(src, 'EXTRAS');
  const byCategory = rid === 'la_musa' ? readLiteral(src, 'EXTRAS_BY_CATEGORY', '{', '}') : null;
  const byItem = rid === 'la_musa' ? readLiteral(src, 'EXTRAS_BY_ITEM', '{', '}') : null;
  return { dishes, extras, byCategory, byItem };
};
// Extra-category order = first appearance in EXTRAS, which is what BOTH forms use today
// (x_pizza: `[...new Set(EXTRAS.map(e => e.cat))]`; la_musa: the EXTRAS array itself).
const extraCatsOf = (extras) => [...new Set(extras.map((e) => e.cat))];

// ── THE ORACLE: what each shipped form renders today, transcribed line-for-line ───────────────────
// x_pizza — xpizza-orders/index.html:3615 (`isNutella`) and :3646-3670 (grouped by category).
const oracleXPizza = (dish, extras) => {
  if (dish.name === 'Nutella') return [];                       // :3615 — the ONE exclusion, keyed by NAME
  const cats = [...new Set(extras.map((e) => e.cat))];          // :3648
  const out = [];
  for (const cat of cats) for (const e of extras.filter((x) => x.cat === cat)) out.push(e.id);  // :3653-3656
  return out;
};
// la_musa — :1950 (extrasCatsForItem) and :1980 (extrasForItem).
const oracleLaMusa = (dish, extras, byCategory, byItem) => {
  const fromCat = byCategory[dish.cat] || [];                   // :1951
  const fromItem = byItem[dish.id] || [];                       // :1952
  const seen = new Set(fromCat);
  const cats = [...fromCat, ...fromItem.filter((c) => !seen.has(c))];   // :1954
  return extras.filter((e) => cats.includes(e.cat)).map((e) => e.id);   // :1982 — FLAT EXTRAS order
};

// ── the authored exposure for today's data, in the new committed shape ───────────────────────────
// This is what the migration (Task 8) will produce. Task 1 owns the RESOLVER; this is its input.
const authoredFor = (rid, { dishes, extras, byCategory, byItem }) => {
  const extraCategories = extraCatsOf(extras);
  if (rid === 'la_musa') {
    return {
      extras, extraCategories,
      categoryAllow: byCategory,
      itemOverrides: Object.fromEntries(Object.entries(byItem).map(([k, v]) => [k, { add: v }])),
      itemsByKey: Object.fromEntries(dishes.map((d) => [d.id, d])),
    };
  }
  // x_pizza exposes EVERY extra category to EVERY dish category and excludes exactly one item.
  // The exclusion is a NAME literal in the form (`pizza.name === 'Nutella'`), so the authored form of
  // it is a per-item deny — which is precisely why exposure has to become data.
  const cats = [...new Set(dishes.map((d) => d.cat))];
  return {
    extras, extraCategories,
    categoryAllow: Object.fromEntries(cats.map((c) => [c, extraCategories.slice()])),
    itemOverrides: Object.fromEntries(dishes.filter((d) => d.name === 'Nutella').map((d) => [String(d.id), { deny: ALL }])),
    itemsByKey: Object.fromEntries(dishes.map((d) => [String(d.id), d])),
  };
};

// ── THE MONEY ASSERTION: every real item, both brands ─────────────────────────────────────────────
for (const rid of ['x_pizza', 'la_musa']) {
  test(`🔴 ${rid}: resolveExposure reproduces TODAY'S option set for EVERY real item, in order`, () => {
    const data = real(rid);
    const ctx = authoredFor(rid, data);
    const oracle = (d) => (rid === 'x_pizza'
      ? oracleXPizza(d, data.extras)
      : oracleLaMusa(d, data.extras, data.byCategory, data.byItem));
    assert.ok(data.dishes.length > 10, `premise: the real menu loaded (${data.dishes.length} dishes)`);
    for (const d of data.dishes) {
      const item = { key: String(d.id), cat: d.cat, variantOf: d.variantOf || null };
      assert.deepStrictEqual(resolveExposure(item, ctx), oracle(d),
        `🔴 ${rid}/${d.id} (${d.name}) — exposed option set must be EXACTLY what ships today`);
    }
  });
}

test('🔴 Nutella is offered NOTHING — the one X.Pizza exclusion, as data rather than a name literal', () => {
  const data = real('x_pizza');
  const ctx = authoredFor('x_pizza', data);
  const nutella = data.dishes.find((d) => d.name === 'Nutella');
  assert.ok(nutella, 'premise: Nutella is on the real menu');
  assert.deepStrictEqual(resolveExposure({ key: String(nutella.id), cat: nutella.cat }, ctx), [],
    '🔴 deny=ALL yields the EMPTY set');
  // ...and it is the only one, so the deny cannot be quietly over-applied.
  const empties = data.dishes.filter((d) => resolveExposure({ key: String(d.id), cat: d.cat }, ctx).length === 0);
  assert.deepStrictEqual(empties.map((d) => d.name), ['Nutella'], 'and NOTHING else lost its extras');
});

test('🔴 rice_03 gets its category extras PLUS the proteins, in canonical order', () => {
  const data = real('la_musa');
  const ctx = authoredFor('la_musa', data);
  const got = resolveExposure({ key: 'rice_03', cat: 'rice' }, ctx);
  const acc = data.extras.filter((e) => e.cat === 'Acompañamientos').map((e) => e.id);
  const sal = data.extras.filter((e) => e.cat === 'Salsas').map((e) => e.id);
  const pro = data.extras.filter((e) => e.cat === 'Proteínas').map((e) => e.id);
  assert.deepStrictEqual(got, [...acc, ...sal, ...pro],
    '🔴 category allow-list first, then the item ADD, each in extras order');
  // a sibling in the same category must NOT inherit the per-item add
  const sibling = resolveExposure({ key: 'rice_01', cat: 'rice' }, ctx);
  assert.deepStrictEqual(sibling, [...acc, ...sal], '🔴 rice_01 gets no proteins — the add is per ITEM');
  assert.ok(pro.length > 0 && !sibling.includes(pro[0]), 'non-vacuous: proteins exist and are absent here');
});

test('🔴 a variant inherits its launcher’s exposure unless it overrides', () => {
  const data = real('la_musa');
  const ctx = authoredFor('la_musa', data);
  // Give the LAUNCHER a per-item add; today no launcher has one, so this is the rule stated forward.
  ctx.itemOverrides = { ...ctx.itemOverrides, noodle_01: { add: ['Proteínas'] } };
  const launcher = resolveExposure({ key: 'noodle_01', cat: 'noodles' }, ctx);
  const variant = resolveExposure({ key: 'noodle_01_pollo', cat: 'noodles', variantOf: 'noodle_01' }, ctx);
  assert.deepStrictEqual(variant, launcher, '🔴 the variant is offered exactly what the launcher is');
  // ...and an override on the variant wins over the inheritance
  ctx.itemOverrides.noodle_01_pollo = { deny: ALL };
  assert.deepStrictEqual(resolveExposure({ key: 'noodle_01_pollo', cat: 'noodles', variantOf: 'noodle_01' }, ctx), [],
    '🔴 a variant that overrides is not overruled by its launcher');
});

test('🔴 the legacy maps are DERIVED output, never a second source', () => {
  // Round-trip: deriving from the resolver's own inputs must reproduce today's authored maps exactly.
  // If these ever diverge, something is authoring exposure twice — which is the failure this prevents.
  const data = real('la_musa');
  const ctx = authoredFor('la_musa', data);
  const items = data.dishes.map((d) => ({ key: String(d.id), cat: d.cat, variantOf: d.variantOf || null }));
  const legacy = deriveLegacyMaps(items, ctx);
  assert.deepStrictEqual(legacy.byCategory, data.byCategory, '🔴 EXTRAS_BY_CATEGORY round-trips');
  assert.deepStrictEqual(legacy.byItem, data.byItem, '🔴 EXTRAS_BY_ITEM round-trips');
});

test('🔴 the resolver names no brand — exposure is keyed by data, not by restaurant', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'extras-exposure.js'), 'utf8');
  const code = src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
  for (const brand of ['x_pizza', 'la_musa', 'Nutella', 'rice_03', 'Proteínas']) {
    assert.ok(!code.includes(brand), `🔴 extras-exposure.js must not mention ${brand} — it resolves data`);
  }
});

test('🔴 a PARTIAL deny removes exactly what it names, and beats an add of the same thing', () => {
  // Only deny=ALL (Nutella) exists in today's data, so nothing pinned the general case — mutation
  // testing found that removing the deny step entirely still passed. The contract is
  // `(allow) − (deny) + (add)`, so the partial forms have to be stated even though no merchant uses
  // one yet: they are what the next exposure edit will reach for.
  const data = real('la_musa');
  const ctx = authoredFor('la_musa', data);
  const acc = data.extras.filter((e) => e.cat === 'Acompañamientos').map((e) => e.id);
  const sal = data.extras.filter((e) => e.cat === 'Salsas').map((e) => e.id);

  // deny a whole extra-category the item's dish-category allows
  ctx.itemOverrides = { ...ctx.itemOverrides, rice_01: { deny: ['Salsas'] } };
  assert.deepStrictEqual(resolveExposure({ key: 'rice_01', cat: 'rice' }, ctx), acc,
    '🔴 denying a category removes that category and leaves the rest');

  // deny a SINGLE extra by key, leaving its siblings
  ctx.itemOverrides.rice_02 = { deny: [sal[0]] };
  assert.deepStrictEqual(resolveExposure({ key: 'rice_02', cat: 'rice' }, ctx), [...acc, ...sal.slice(1)],
    '🔴 denying one option removes only that option');

  // add and deny the SAME thing → not offered. Fail-closed is the only safe reading of a
  // contradictory override, and it must not depend on which loop happens to run last.
  ctx.itemOverrides.rice_04 = { add: ['Proteínas'], deny: ['Proteínas'] };
  assert.deepStrictEqual(resolveExposure({ key: 'rice_04', cat: 'rice' }, ctx), [...acc, ...sal],
    '🔴 a contradictory override resolves to NOT offered');
});

test('🔴 a denied CATEGORY suppresses even an individually-added extra inside it', () => {
  // The hole in the first cut: `add` could name a single extra key while `deny` named its category,
  // and the two never met — deny was applied by exact match before emission, so it deleted the
  // category from the allow-set (where it already wasn't) and left the individually-added KEY intact.
  // The extra was offered by an item whose exposure explicitly denies its whole category.
  //
  // The formula is (allow ∪ add) − deny with deny applied LAST, at emission, against BOTH the key and
  // its category. Today's data exercises neither half of this — nothing uses a key-level add, and the
  // only deny is deny=ALL — so it took stating the contract to find it.
  const data = real('la_musa');
  const ctx = authoredFor('la_musa', data);
  const acc = data.extras.filter((e) => e.cat === 'Acompañamientos').map((e) => e.id);
  const sal = data.extras.filter((e) => e.cat === 'Salsas').map((e) => e.id);
  const chicken = data.extras.find((e) => e.id === 'protein_chicken');
  assert.ok(chicken && chicken.cat === 'Proteínas', 'premise: protein_chicken is a real Proteínas extra');

  ctx.itemOverrides = { ...ctx.itemOverrides, rice_01: { add: ['protein_chicken'], deny: ['Proteínas'] } };
  const got = resolveExposure({ key: 'rice_01', cat: 'rice' }, ctx);
  assert.ok(!got.includes('protein_chicken'),
    '🔴 the denied category wins over the individual add — deny is applied last, to key AND category');
  assert.deepStrictEqual(got, [...acc, ...sal], 'and the rest of the exposure is untouched');

  // ...and the same add WITHOUT the category deny does offer it, or the assertion above would pass
  // for the wrong reason — an add that never worked at all.
  ctx.itemOverrides.rice_01 = { add: ['protein_chicken'] };
  assert.deepStrictEqual(resolveExposure({ key: 'rice_01', cat: 'rice' }, ctx), [...acc, ...sal, 'protein_chicken'],
    'non-vacuous: a key-level add on its own IS offered, in canonical order');
});
