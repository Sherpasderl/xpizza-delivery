'use strict';
// S1a (PLAN-portal-item-edit r6 §0.4, §4, r6 addendum S1 group rename; design D4c-grill/item-s1/S1a-DESIGN.md) — the text rules
// for NEWLY AUTHORED values, and the group rename. Run: node catalog/text-edit-rules.test.js
//   add-product.js: textCapProblems({ draft, live }) → [{ key, field, code }] — newly authored values only (an untouched record is
//     grandfathered): name ≤ 60 (attribute rule), desc ≤ 200 (body rule), every DERIVED option name ≤ 60;
//   rederiveOptionNames(source) → a copy where every option's name is `${launcher name} - ${choice}` and its cat / subcat are the
//     launcher's (the server derives them from the submitted parent; source-store.js:592 is unchanged).
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { validateSource, canonicalize } = require('./source-store');
const AP = require('./add-product');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const codes = (ps) => ps.map((p) => `${p.key}:${p.field}:${p.code}`).sort();

// ── caps on newly authored values ──
{
  const live = canonicalize(buildSourceFromCode('x_pizza'));
  const d = clone(live); const it = d.items.find((i) => i.key === 'Carnivora');
  assert.deepStrictEqual(AP.textCapProblems({ draft: d, live }), [], 'premise: an unedited draft has no problems');
  it.display.name = 'N'.repeat(61);
  assert.deepStrictEqual(codes(AP.textCapProblems({ draft: d, live })), ['Carnivora:name:name_too_long'], 'TC-NAME a new name over 60 is refused');
  it.display.name = 'N'.repeat(60);
  assert.deepStrictEqual(AP.textCapProblems({ draft: d, live }), [], 'TC-NAME 60 is allowed');
  it.display.name = 'Pizza <b>';
  assert.deepStrictEqual(codes(AP.textCapProblems({ draft: d, live })), ['Carnivora:name:text_unsafe'], 'TC-SAFE a name with < or > is refused (attribute rule)');
  it.display.name = live.items.find((i) => i.key === 'Carnivora').display.name;
  it.display.desc = 'd'.repeat(201);
  assert.deepStrictEqual(codes(AP.textCapProblems({ draft: d, live })), ['Carnivora:desc:desc_too_long'], 'TC-DESC a new description over 200 is refused');
  // grandfathered: an over-long value already LIVE is not a problem while untouched
  const liveLong = clone(live); liveLong.items.find((i) => i.key === 'Carnivora').display.desc = 'g'.repeat(250);
  assert.deepStrictEqual(AP.textCapProblems({ draft: clone(liveLong), live: liveLong }), [], 'TC-GRANDFATHER an untouched live value is not judged');
  // a NEW product is newly authored throughout
  const add = clone(live); add.items.push({ ref: 'tmp:newdish01', price: 100, display: { name: 'A'.repeat(61), cat: 'individual' } });
  assert.deepStrictEqual(codes(AP.textCapProblems({ draft: add, live })), ['tmp:newdish01:name:name_too_long'], 'TC-NEW a new product\'s name is capped');
  // a newly authored name may not be another product's name or key, or an option's — on a name-keyed menu it would price that one
  const other = live.items.find((i) => i.key !== 'Carnivora' && i.display.variantOf == null);
  const dup = clone(live); dup.items.find((i) => i.key === 'Carnivora').display.name = other.display.name.toUpperCase();
  assert.deepStrictEqual(codes(AP.textCapProblems({ draft: dup, live })), ['Carnivora:name:name_taken'], 'TC-TAKEN another product\'s name (any case) is refused');
  const exName = live.extras.find((e) => e.display && typeof e.display.name === 'string').display.name;
  const dupX = clone(live); dupX.items.find((i) => i.key === 'Carnivora').display.name = exName;
  assert.ok(codes(AP.textCapProblems({ draft: dupX, live })).includes('Carnivora:name:name_taken'), 'TC-TAKEN an option (extra) name is refused');
  // a RESERVED key — any key the draft's frozen_keys names, active or retired — is refused as a newly authored name, except the
  // product's own key (a rename back) (codex S1a r1 P1)
  const res = { ...clone(live), frozen_keys: { 999: 'Pizza Retirada', 1000: 'Carnivora' } };
  res.items.find((i) => i.key === 'Carnivora').display.name = 'pizza  retirada';
  assert.deepStrictEqual(codes(AP.textCapProblems({ draft: res, live })), ['Carnivora:name:name_previously_used'], 'TC-RESERVED a retired frozen key (any case / spacing) is refused');
  const back = { ...clone(live), frozen_keys: { 1000: 'Carnivora' } };
  back.items.find((i) => i.key === 'Carnivora').display.name = 'Carnivora ';
  assert.deepStrictEqual(AP.textCapProblems({ draft: back, live: { ...live, items: live.items.map((i) => (i.key === 'Carnivora' ? { ...i, display: { ...i.display, name: 'Otra' } } : i)) } }), [], 'TC-RESERVED-OWN a rename back to the product\'s own key is not refused');
  ok('caps: name ≤ 60 (attribute rule), desc ≤ 200, newly authored only; live values grandfathered; new products capped');
}

// ── the group rename (la_musa's Pad Thai: a launcher and its options) ──
{
  const live = canonicalize(buildSourceFromCode('la_musa'));
  const d = clone(live);
  d.items.find((i) => i.key === 'noodle_01').display.name = 'Pad Thai Especial';
  assert.throws(() => validateSource(d, 'la_musa'), /a variant's name must be/, 'premise: a parent-only rename fails the :592 rule (unchanged)');
  const r = AP.rederiveOptionNames(d);
  for (const k of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) {
    const o = r.items.find((i) => i.key === k);
    assert.strictEqual(o.display.name, `Pad Thai Especial - ${o.display.choice}`, `TG-DERIVE ${k} re-derived from the submitted parent`);
    assert.strictEqual(o.key, k, `TG-KEYS ${k} keeps its key`);
  }
  assert.doesNotThrow(() => validateSource(r, 'la_musa'), 'TG-VALID the whole group validates');
  assert.deepStrictEqual(clone(d.items.find((i) => i.key === 'noodle_01_pollo').display.choice), 'Pollo', 'premise: the choice label is untouched');
  // a category move propagates to every member
  const m = clone(live); m.items.find((i) => i.key === 'noodle_01').display.cat = 'rice';
  const rm = AP.rederiveOptionNames(m);
  assert.deepStrictEqual(rm.items.filter((i) => i.display.variantOf === 'noodle_01').map((i) => i.display.cat), ['rice', 'rice', 'rice'], 'TG-CAT the move reaches every option');
  // a derived option name over 60 is refused as a whole-group problem
  const long = clone(live); long.items.find((i) => i.key === 'noodle_01').display.name = 'P'.repeat(50);
  const lr = AP.rederiveOptionNames(long);
  assert.ok(codes(AP.textCapProblems({ draft: lr, live })).some((c) => /:name:option_name_too_long$/.test(c)), 'TG-CAP a derived option name over 60 is refused');
  // the input is never mutated
  assert.strictEqual(d.items.find((i) => i.key === 'noodle_01_sin').display.name, 'Pad Thai - Sin Proteína', 'rederiveOptionNames never mutates its input');
  ok('group rename: options re-derived from the parent (keys and choices kept), cat propagates, derived names capped');
}

console.log(`\ntext-edit-rules: OK (${n})`);
