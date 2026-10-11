'use strict';
// 1D add-product B (rev 6, UNIFORM) — the group rules and the ungated builder, proven on BOTH brands with the SAME
// fixtures (§0d.6). Run: node catalog/group-rules.test.js
//   la_musa: today's Pad Thai (unequal prices) — must keep validating, and each defect planted in it is refused.
//   x_pizza: a NEW group (equal prices, numeric display ids, name-keyed) — validates, reaches the bundle and the public
//            menu body, and the SAME defects are refused with the SAME rule.
const assert = require('assert');
const { canonicalize, validateSource, sourceToBuildInputs } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2, rebuildFormMenu } = require('./form-menu-source');
const { assertWholeBody } = require('./public-menu');
const { generateFormBundle } = require('./generate-form-bundle');
const { groupIndexFrom } = require('./group-index');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));

// an x_pizza group: launcher "NY Plain Slice" + three sauces, all L 624, in `ny`
function withXpGroup(src, { prices = [624, 624, 624], extra = {} } = {}) {
  const s = clone(src);
  const maxId = Math.max(...s.items.map((i) => i.display.id));
  const L = { id: maxId + 1, name: 'NY Plain Slice', cat: 'ny' };
  const sauces = ['Salsa Roja', 'Salsa Vodka', 'Combinada'];
  s.items.push({ key: L.name, price: Math.min(...prices), display: { id: L.id, cat: L.cat, name: L.name, price: Math.min(...prices), desc: '6 slices', ...extra } });
  s.structure.item_order.push(L.name);
  const vids = [];
  sauces.forEach((ch, i) => {
    const id = maxId + 2 + i; const name = `${L.name} - ${ch}`;
    s.items.push({ key: name, price: prices[i], display: { id, cat: L.cat, name, price: prices[i], variantOf: L.id, choice: ch, ...extra } });
    s.structure.item_order.push(name);
    vids.push(id);
  });
  s.structure.variant_items = { [String(L.id)]: { label: 'Salsa', variantIds: vids } };
  return { src: s, launcherId: String(L.id), launcherKey: L.name, vids };
}
const lmSrc = () => canonicalize(buildSourceFromCode('la_musa'));
const xpSrc = () => canonicalize(buildSourceFromCode('x_pizza'));
const GROUPS = {
  la_musa: () => ({ src: lmSrc(), launcherId: 'noodle_01', launcherKey: 'noodle_01', vids: ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'] }),
  x_pizza: () => withXpGroup(xpSrc()),
};
const refuses = (rid, src, re, why) => assert.throws(() => validateSource(src, rid), re, `${rid}: ${why}`);
const itemById = (src, id) => src.items.find((i) => String(i.display.id) === String(id));
// rename a record CONSISTENTLY: where the pricing key mirrors the display name (name-keyed data), the key and its
// item_order entry follow — decided from the data itself, not from the brand
const rename = (src, id, name) => {
  const it = itemById(src, id);
  if (it.key === it.display.name) { src.structure.item_order = src.structure.item_order.map((k) => (k === it.key ? name : k)); it.key = name; }
  it.display.name = name;
};

{
  for (const rid of ['la_musa', 'x_pizza']) {
    const g = GROUPS[rid]();
    assert.doesNotThrow(() => validateSource(g.src, rid), `${rid}: the group validates`);
    // the SAME defects, planted the same way, refused by the SAME rule on both brands
    let s;
    s = clone(g.src); itemById(s, g.vids[1]).display.choice = itemById(s, g.vids[0]).display.choice.toUpperCase();
    rename(s, g.vids[1], `${itemById(s, g.launcherId).display.name} - ${itemById(s, g.vids[1]).display.choice}`);
    refuses(rid, s, /appears twice/, 'a duplicate choice (case-folded)');
    s = clone(g.src); rename(s, g.vids[0], 'Otro nombre');
    refuses(rid, s, /name must be/, 'a variant name that is not "{launcher} - {choice}"');
    s = clone(g.src); itemById(s, g.vids[0]).display.cat = rid === 'la_musa' ? 'rice' : 'individual';
    refuses(rid, s, /share its launcher's category/, 'a variant that escapes its launcher’s category');
    s = clone(g.src); itemById(s, g.launcherId).display.extras_policy = 'none';
    refuses(rid, s, /extras_policy must be the same/, 'extras_policy on the launcher but not the variants');
    s = clone(g.src); for (const id of [g.launcherId, ...g.vids]) itemById(s, id).display.extras_policy = 'all';
    refuses(rid, s, /extras_policy must be one of none/, 'an extras_policy other than "none"');
    s = clone(g.src); for (const id of [g.launcherId, ...g.vids]) itemById(s, id).display.extras_policy = 'none';
    assert.doesNotThrow(() => validateSource(s, rid), `${rid}: extras_policy "none" on the whole group validates`);
    s = clone(g.src); s.structure.variant_items[g.launcherId].prompt = '   ';
    refuses(rid, s, /prompt must not be blank/, 'a blank authored prompt');
    s = clone(g.src); s.structure.variant_items[g.launcherId].prompt = 'Elegí <b>';
    refuses(rid, s, /display_unsafe/, 'an unsafe authored prompt (body sink)');
    s = clone(g.src); s.structure.variant_items[g.launcherId].prompt = 'Elegí tu salsa';
    assert.doesNotThrow(() => validateSource(s, rid), `${rid}: a safe authored prompt validates`);
    // fewer than 2 choices: drop all but one variant (items, order and list)
    s = clone(g.src); const drop = g.vids.slice(1).map(String);
    s.items = s.items.filter((i) => !drop.includes(String(i.display.id)));
    s.structure.item_order = s.structure.item_order.filter((k) => s.items.some((i) => i.key === k));
    s.structure.variant_items[g.launcherId].variantIds = [g.vids[0]];
    refuses(rid, s, /at least 2/, 'a single-choice group');
  }
  ok('the group rules are the SAME on both brands: la_musa’s Pad Thai and an x_pizza group both validate, and each planted defect (duplicate choice, wrong name, category escape, extras_policy split / bad value, blank or unsafe prompt, < 2 choices) is refused by the same rule');
}

{
  // the ungated builder: an x_pizza group travels store → build → bundle → public body exactly like la_musa's
  const g = GROUPS.x_pizza();
  const i = sourceToBuildInputs(g.src);
  const built = buildCatalogV2('x_pizza', { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
  assert.deepStrictEqual(built.structure.variant_items, g.src.structure.variant_items, 'the build carries the authored map (x_pizza is no longer gated out)');
  const idx = groupIndexFrom(built);
  assert.deepStrictEqual([idx.ok, [...idx.launchers]], [true, ['NY Plain Slice']], 'the group index names the launcher by its PRICING key (the name, on x_pizza)');
  const bundle = rebuildFormMenu('x_pizza', built.items, built.structure, built.extras);
  assert.deepStrictEqual(Object.keys(bundle), ['dishes', 'extras', 'categories', 'variant_items', 'pickup_only_cats', 'weekend_only_cats'], 'x_pizza body order: categories → variant_items → its own gates');
  assert.deepStrictEqual(bundle.variant_items[g.launcherId], { label: 'Salsa', basePrice: 624, variantIds: g.vids }, '"desde" derived from the variants (equal prices → 624)');
  const menu = { items: built.items, structure: built.structure, extras: built.extras };   // the live reader's shape (extras = display records)
  // buildPublicMenu = generateFormBundle + the structure fields it carries (public-menu.js CARRIED_FROM_STRUCTURE), then
  // assertWholeBody. Its reader is not injectable, so the carry is mirrored here; the real endpoint is exercised by the
  // emulator cells (public menu) in the PB-1 hand-back.
  const body = generateFormBundle('x_pizza', menu);
  for (const f of ['extras_by_category', 'extras_by_item', 'badges']) if (menu.structure[f] !== undefined) body[f] = menu.structure[f];
  assert.doesNotThrow(() => assertWholeBody('x_pizza', body, menu), 'the public body is whole (variant_items reaches it)');
  const dropped = { ...body }; delete dropped.variant_items;
  assert.throws(() => assertWholeBody('x_pizza', dropped, menu), /variant_items is missing although the catalog carries it/, 'sensitivity: a body that dropped the groups is refused');
  // and la_musa’s order is exactly today’s
  const lb = buildCatalogV2('la_musa');
  assert.deepStrictEqual(Object.keys(rebuildFormMenu('la_musa', lb.items, lb.structure, lb.extras)), ['dishes', 'extras', 'categories', 'variant_items', 'has_photo'], 'la_musa body order unchanged');
  // unequal prices are allowed for every brand; the derived "desde" is the cheapest choice
  const u = withXpGroup(xpSrc(), { prices: [600, 650, 700] });
  assert.doesNotThrow(() => validateSource(u.src, 'x_pizza'), 'unequal per-choice prices validate on x_pizza too');
  const ui = sourceToBuildInputs(u.src); const ub = buildCatalogV2('x_pizza', { formData: ui.formData, priceTable: ui.priceTable, extrasTable: ui.extras });
  assert.strictEqual(rebuildFormMenu('x_pizza', ub.items, ub.structure, ub.extras).variant_items[u.launcherId].basePrice, 600, '"desde" = the cheapest choice');
  // no groups → the key stays ABSENT (never {}), so today’s x_pizza bytes are unchanged
  const plain = buildCatalogV2('x_pizza', (() => { const p = sourceToBuildInputs(xpSrc()); return { formData: p.formData, priceTable: p.priceTable, extrasTable: p.extras }; })());
  assert.ok(!('variant_items' in plain.structure), 'no groups → no variant_items key');
  ok('the ungated builder: an x_pizza group is carried by the build, indexed by pricing key, emitted in the bundle (derived "desde"), and served whole; unequal prices allowed; no groups → the key stays absent; la_musa’s order is unchanged');
}

{
  // §0c.6 — the KDS manifest (the ONE generator all three writers share: publish, rollback, publish-menus) lists a group as a
  // WHOLE-DISH row (the launcher: 86 = hide every choice) plus one row per choice, for every brand
  const { generateKdsManifest } = require('./generate-form-bundle');
  const g = GROUPS.x_pizza();
  const i = sourceToBuildInputs(g.src);
  const built = buildCatalogV2('x_pizza', { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
  const rows = generateKdsManifest('x_pizza', built).slice(-4);
  assert.deepStrictEqual(rows, [
    { key: 'NY Plain Slice', label: 'NY Plain Slice', category: 'ny' },
    { key: 'NY Plain Slice - Salsa Roja', label: 'NY Plain Slice - Salsa Roja', category: 'ny' },
    { key: 'NY Plain Slice - Salsa Vodka', label: 'NY Plain Slice - Salsa Vodka', category: 'ny' },
    { key: 'NY Plain Slice - Combinada', label: 'NY Plain Slice - Combinada', category: 'ny' },
  ], 'the whole-dish row, then one row per choice');
  const lm = generateKdsManifest('la_musa', buildCatalogV2('la_musa')).filter((r) => r.key.startsWith('noodle_01'));
  assert.deepStrictEqual(lm.map((r) => r.key), ['noodle_01', 'noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'], 'la_musa’s Pad Thai: the same shape it has today');
  ok('KDS: a group is a whole-dish row (the launcher) plus one row per choice — the same shape on both brands (Pad Thai unchanged)');
}

console.log(`\ngroup-rules: OK (${n})`);
