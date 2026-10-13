'use strict';
// PER-PRODUCT EXTRAS — the one evaluator (catalog/extras-eligibility.js). Run: node catalog/extras-eligibility.test.js
const assert = require('assert');
const { projectEligibility, eligibleExtras, publicDeny } = require('./extras-eligibility');
const { resolveExposure } = require('./extras-exposure');
const { buildSourceFromCode } = require('../tools/seed-source-store');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── 1. PARITY with today's display resolver, on both brands' code-seeded sources (translated to pricing keys) ──
for (const rid of ['x_pizza', 'la_musa']) {
  const src = buildSourceFromCode(rid);
  const proj = projectEligibility(src);
  const ex = src.structure.exposure;
  const keyByExtraId = new Map(src.extras.map((e) => [String(e.display.id), e.key]));
  const ctx = { categoryAllow: ex.category_allow, extraCategories: src.structure.extra_categories,
    extras: src.extras.map((e) => ({ key: e.key, id: e.display.id, cat: e.display.cat })), itemOverrides: ex.item_overrides || {},
    itemsByKey: Object.fromEntries(src.items.map((i) => [i.key, { variantOf: i.display.variantOf !== undefined ? src.items.find((l) => String(l.display.id) === String(i.display.variantOf)).key : undefined }])) };
  for (const it of src.items) {
    const today = resolveExposure({ key: it.key, cat: it.display.cat, variantOf: ctx.itemsByKey[it.key].variantOf }, ctx).map((id) => keyByExtraId.get(id) || id);
    assert.deepStrictEqual(eligibleExtras(proj, it.key), today, `${rid}/${it.key}: the evaluator equals today's resolver (in pricing keys)`);
  }
  ok(`${rid}: for all ${src.items.length} items the evaluator equals today's exposure resolver, translated to PRICING keys`);
}

// ── 2. today's facts, as data ──
{
  const xp = projectEligibility(buildSourceFromCode('x_pizza'));
  assert.deepStrictEqual(eligibleExtras(xp, 'Nutella'), [], 'x_pizza Nutella: nothing (legacy deny "*")');
  assert.strictEqual(eligibleExtras(xp, 'Margherita').length, 14, 'x_pizza: every other pizza takes all 14 extras');
  assert.ok(eligibleExtras(xp, 'Margherita').includes('Salsa Roja') && !eligibleExtras(xp, 'Margherita').includes('e1'), 'PRICING keys ("Salsa Roja"), never display ids ("e1")');
  const lm = projectEligibility(buildSourceFromCode('la_musa'));
  const proteins = buildSourceFromCode('la_musa').extras.filter((e) => e.display.cat === 'Proteínas').map((e) => e.key);
  assert.ok(proteins.length && proteins.every((k) => eligibleExtras(lm, 'rice_03').includes(k)), 'la_musa rice_03: the item ADD gives it the proteins');
  assert.ok(proteins.every((k) => !eligibleExtras(lm, 'rice_02').includes(k)), 'la_musa rice_02: no proteins (category allow only)');
  assert.deepStrictEqual(eligibleExtras(lm, 'noodle_01_pollo'), eligibleExtras(lm, 'noodle_01'), 'a variant has its launcher’s set');
  ok('today as data: Nutella none; x_pizza all 14 by pricing key; la_musa rice_03 proteins via add, rice_02 none; variants = launcher');
}

// ── 3. typed deny_extras: KEY ONLY — a key spelled like a category never expands (codex r3 P2-2) ──
{
  const src = buildSourceFromCode('x_pizza');
  src.structure.exposure.item_overrides.Margherita = { deny_extras: ['Salsa Roja', 'Salsa Blanca', 'Salsa Calabrian Chili'] };
  const p = projectEligibility(src);
  assert.deepStrictEqual(eligibleExtras(p, 'Margherita').filter((k) => /Salsa/.test(k)), [], 'the three sauces are excluded');
  assert.strictEqual(eligibleExtras(p, 'Margherita').length, 11, '…and only them (11 of 14)');
  assert.strictEqual(eligibleExtras(p, 'Pepperoni').length, 14, 'another product is untouched');
  // a NEW extra in the same (allowed) category is eligible on the product with the custom list
  src.extras.push({ key: 'Salsa Pesto Rosso', price: 45, display: { id: 'e99', cat: 'Salsas & Queso', name: 'Salsa Pesto Rosso', price: 45 } });
  assert.ok(eligibleExtras(projectEligibility(src), 'Margherita').includes('Salsa Pesto Rosso'), '🔴 a NEW extra starts CHECKED on a product with a custom list');
  // collision: an extra whose KEY equals a category name; deny_extras of it excludes ONLY that extra
  const c = buildSourceFromCode('x_pizza');
  c.extras.push({ key: 'Carnes', price: 10, display: { id: 'e98', cat: 'Salsas & Queso', name: 'Carnes', price: 10 } });
  c.structure.exposure.item_overrides.Margherita = { deny_extras: ['Carnes'] };
  const pc = projectEligibility(c);
  assert.ok(!eligibleExtras(pc, 'Margherita').includes('Carnes'), 'the colliding extra is excluded');
  assert.ok(['Pepperoni', 'Jamón', 'Prosciutto'].every((k) => eligibleExtras(pc, 'Margherita').includes(k)), '🔴 …but the "Carnes" CATEGORY is not');
  // unknown keys / '*' / a category in deny_extras resolve to nothing
  const u = buildSourceFromCode('x_pizza');
  u.structure.exposure.item_overrides.Margherita = { deny_extras: ['*', 'Vegetales & Hierbas', 'Nope'] };
  assert.strictEqual(eligibleExtras(projectEligibility(u), 'Margherita').length, 14, "deny_extras never means '*' or a category");
  ok('typed deny_extras: key-only exclusions; a new extra in an allowed category starts checked; a key spelled like a category never expands; "*"/categories/unknown keys ignored');
}

// ── 4. groups: launcher-canonical (§3) ──
{
  const src = buildSourceFromCode('la_musa');
  const ov = src.structure.exposure.item_overrides;
  ov.noodle_01 = { deny_extras: ['rice_white'] };
  ov.noodle_01_pollo = { add: ['Proteínas'], deny_extras: [] };   // a variant with its OWN add and an empty deny_extras
  const p = projectEligibility(src);
  for (const v of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) assert.ok(!eligibleExtras(p, v).includes('rice_white'), `🔴 ${v}: the launcher's exclusion applies, whatever the variant declares`);
  assert.ok(eligibleExtras(p, 'noodle_01_pollo').some((k) => p.extraCat[k] === 'Proteínas'), 'a variant’s legacy add still applies (today’s rule)');
  src.items.find((i) => i.key === 'noodle_01').display.extras_policy = 'none';
  const pn = projectEligibility(src);
  for (const v of ['noodle_01', 'noodle_01_sin', 'noodle_01_pollo']) assert.deepStrictEqual(eligibleExtras(pn, v), [], `${v}: the launcher's "Sin extras" empties the group`);
  src.items.find((i) => i.key === 'noodle_01_sin').display.extras_policy = 'none';
  src.items.find((i) => i.key === 'noodle_01').display.extras_policy = undefined;
  delete src.items.find((i) => i.key === 'noodle_01').display.extras_policy;
  assert.ok(eligibleExtras(projectEligibility(src), 'noodle_01_sin').length > 0, 'a VARIANT’s own policy is never read (the launcher’s is)');
  ok('groups: the launcher’s deny_extras and "Sin extras" govern every variant (even one with its own add); a variant’s own policy is never read');
}

// ── 5. the public map: DENSE complement (codex r3 P2-1) ──
{
  const src = buildSourceFromCode('x_pizza');
  src.structure.exposure.item_overrides.Margherita = { deny_extras: ['Salsa Roja'] };
  const p = projectEligibility(src);
  const pub = publicDeny(p);
  assert.deepStrictEqual(Object.keys(pub).sort(), src.items.map((i) => i.key).sort(), 'an entry for EVERY item');
  assert.deepStrictEqual(pub.Pepperoni, [], 'unrestricted → [] (never absent)');
  assert.deepStrictEqual(pub.Margherita, ['Salsa Roja']);
  assert.deepStrictEqual(pub.Nutella, p.extraKeys, '"nothing" → every extra key');
  for (const k of Object.keys(pub)) assert.deepStrictEqual(p.extraKeys.filter((e) => !pub[k].includes(e)), eligibleExtras(p, k), `${k}: public complement == evaluator`);
  ok('publicDeny is dense — every item, [] when unrestricted, all keys for "nothing" — and exactly the complement of the evaluator');
}

// ── 6. a variant naming no item is refused, never guessed ──
{
  const src = buildSourceFromCode('la_musa');
  src.items.find((i) => i.key === 'noodle_01_sin').display.variantOf = 'ghost';
  assert.throws(() => projectEligibility(src), /names launcher ghost/);
  ok('a variantOf naming no item is refused (no eligibility against a guess)');
}
console.log(`\nextras-eligibility: OK (${n})`);
