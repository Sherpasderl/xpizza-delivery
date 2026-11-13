'use strict';
// S3 (PLAN-structure-S3-r3 §0, §2) — THE writer for the required choice on an EXISTING dish, over the REAL sources
// (buildSourceFromCode), read back through the REAL build (buildSourceCandidate — validateSource refuses a malformed group).
// Ops that add rows carry tmp refs the save's allocator resolves, so those cells check the written shape; every other op builds.
// Run: node catalog/choice-transitions.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { groupIndexFrom } = require('./group-index');
const CT = require('./choice-transitions');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const refused = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return; } assert.fail(`not refused (${code})`); };
const builds = (rid, src) => buildSourceCandidate(rid, src).built;
const row = (src, key) => src.items.find((i) => i.key === key);
const members = (src, lkey) => { const l = row(src, lkey); return src.structure.variant_items[String(l.display.id)].variantIds; };
const tagged = (src, lkey) => members(src, lkey).filter((v) => { const r = src.items.find((i) => String(i.display.id) === String(v) || i.ref === v); return (r.display.tags || []).includes('recommended'); });

// La Musa ships a real group (Pad Thai, 3 options); X Pizza has none, so its group comes from choice.add on a real dish.
const LM = buildSourceFromCode('la_musa');
const PAD = 'noodle_01';
const PAD_OPTS = members(LM, PAD).map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
const XP = buildSourceFromCode('x_pizza');
const CARN = 'Carnivora';
const xpGroup = () => CT.apply(XP, { op: 'choice.add', key: CARN, label: 'Tamaño', options: [{ ref: 'tmp:carn-12-xxxx', choice: '12 pulgadas' }, { ref: 'tmp:carn-18-xxxx', choice: '18 pulgadas', price: 520 }] }).source;

cell('CT-PURE: no op mutates its input', () => {
  const before = JSON.stringify(LM);
  CT.apply(LM, { op: 'choice.label', launcher: PAD, label: 'Elegí la proteína' });
  CT.apply(LM, { op: 'choice.remove', launcher: PAD, price_from: PAD_OPTS[0] });
  assert.strictEqual(JSON.stringify(LM), before);
});
cell('CT-LABEL la_musa: the group\'s name changes and nothing else; it builds', () => {
  const s = CT.apply(LM, { op: 'choice.label', launcher: PAD, label: 'Elegí la proteína' }).source;
  assert.strictEqual(s.structure.variant_items[PAD].label, 'Elegí la proteína');
  const back = clone(s); back.structure.variant_items[PAD].label = LM.structure.variant_items[PAD].label;
  assert.deepStrictEqual(back, LM, 'only the label differs');
  builds('la_musa', s);
});
cell('CT-RENAME la_musa: the option keeps its key; its choice and composed name «{dish} - {choice}» follow; it builds', () => {
  const k = PAD_OPTS[1];
  const s = CT.apply(LM, { op: 'option.rename', key: k, choice: 'Pollo al Wok' }).source;
  assert.ok(row(s, k), 'the key is kept');
  assert.strictEqual(row(s, k).display.choice, 'Pollo al Wok');
  assert.strictEqual(row(s, k).display.name, `${row(LM, PAD).display.name} - Pollo al Wok`);
  builds('la_musa', s);
});
cell('CT-ADD la_musa: a new option row on a tmp ref, listed by the group and ordered after its last member', () => {
  const s = CT.apply(LM, { op: 'option.add', launcher: PAD, ref: 'tmp:pad-tofu-xxxx', choice: 'Tofu', price: 330 }).source;
  const r = s.items.find((i) => i.ref === 'tmp:pad-tofu-xxxx');
  assert.deepStrictEqual(r, { ref: 'tmp:pad-tofu-xxxx', price: 330, display: { variantOf: PAD, choice: 'Tofu', name: `${row(LM, PAD).display.name} - Tofu`, price: 330 } });
  assert.deepStrictEqual(members(s, PAD), [...members(LM, PAD), 'tmp:pad-tofu-xxxx']);
  const o = s.structure.item_order;
  assert.strictEqual(o.indexOf('tmp:pad-tofu-xxxx'), o.indexOf(PAD_OPTS[PAD_OPTS.length - 1]) + 1);
  refused(() => CT.apply(s, { op: 'option.add', launcher: PAD, ref: 'tmp:pad-tofu-xxxx', choice: 'Otra', price: 300 }), 'addition_malformed');
});
cell('CT-REMOVE la_musa: an option leaves (row, group list, order); ≥ 2 stay — the next removal is choices_too_few; it builds', () => {
  const s = CT.apply(LM, { op: 'option.remove', key: PAD_OPTS[2] }).source;
  assert.ok(!row(s, PAD_OPTS[2]) && !s.structure.item_order.includes(PAD_OPTS[2]));
  assert.deepStrictEqual(members(s, PAD), members(LM, PAD).slice(0, 2));
  builds('la_musa', s);
  refused(() => CT.apply(s, { op: 'option.remove', key: PAD_OPTS[1] }), 'choices_too_few');
});
cell('CT-REMOVE-CLAIM: a removed certified option returns its identity stamp for the reviewed deletion claim', () => {
  const src = clone(LM); row(src, PAD_OPTS[2]).display.identity_id = 'id_test_opt_3';
  assert.deepStrictEqual(CT.apply(src, { op: 'option.remove', key: PAD_OPTS[2] }).deletedIds, ['id_test_opt_3']);
});
cell('CT-RECOMMENDED la_musa: ATOMIC — exactly the chosen option carries it, siblings lose it, other tags stay; it builds', () => {
  let s = CT.apply(LM, { op: 'choice.recommended', launcher: PAD, option: PAD_OPTS[0] }).source;
  assert.deepStrictEqual(tagged(s, PAD), [members(LM, PAD)[0]]);
  s = CT.apply(s, { op: 'choice.recommended', launcher: PAD, option: PAD_OPTS[2] }).source;
  assert.deepStrictEqual(tagged(s, PAD), [members(LM, PAD)[2]], 'the earlier mark is cleared');
  assert.ok(!('tags' in row(s, PAD_OPTS[0]).display), 'an emptied tag list goes (today\'s shape)');
  builds('la_musa', s);
  refused(() => CT.apply(LM, { op: 'choice.recommended', launcher: PAD, option: 'noodle_02' }), 'choice_option_missing');
});
cell('CT-CHOICE-ADD x_pizza: a plain dish gains a group under its display id; the first option takes its price and is «Recomendada»; ordered after the dish', () => {
  const s = xpGroup();
  const id = String(row(XP, CARN).display.id);
  assert.deepStrictEqual(s.structure.variant_items[id], { label: 'Tamaño', variantIds: ['tmp:carn-12-xxxx', 'tmp:carn-18-xxxx'] });
  const [a, b] = ['tmp:carn-12-xxxx', 'tmp:carn-18-xxxx'].map((r) => s.items.find((i) => i.ref === r));
  assert.strictEqual(a.price, row(XP, CARN).price, 'the first option takes the dish\'s price');
  assert.strictEqual(b.price, 520);
  assert.deepStrictEqual([a.display.tags, b.display.tags], [['recommended'], undefined]);
  assert.strictEqual(a.display.name, 'Carnivora - 12 pulgadas');
  const o = s.structure.item_order;
  assert.deepStrictEqual(o.slice(o.indexOf(CARN), o.indexOf(CARN) + 3), [CARN, 'tmp:carn-12-xxxx', 'tmp:carn-18-xxxx']);
  assert.ok(row(s, CARN), 'the dish keeps its key');
  refused(() => CT.apply(XP, { op: 'choice.add', key: CARN, label: 'Tamaño', options: [{ ref: 'tmp:carn-one-xxxx', choice: 'Única' }] }), 'choices_too_few');
  refused(() => CT.apply(s, { op: 'choice.add', key: CARN, label: 'Otra', options: [{ ref: 'tmp:c1-xxxxxxx', choice: 'a' }, { ref: 'tmp:c2-xxxxxxx', choice: 'b' }] }), 'choice_group_exists');
});
cell('CT-CHOICE-REMOVE la_musa: every option leaves; the dish is plain at price_from\'s price; an emptied map stays {} (the authored field is kept); it builds', () => {
  const from = PAD_OPTS[1];
  const r = CT.apply(LM, { op: 'choice.remove', launcher: PAD, price_from: from });
  const s = r.source;
  for (const k of PAD_OPTS) assert.ok(!row(s, k) && !s.structure.item_order.includes(k), `${k} left`);
  assert.strictEqual(row(s, PAD).price, row(LM, from).price);
  assert.strictEqual(row(s, PAD).display.price, row(LM, from).price);
  const others = Object.keys(LM.structure.variant_items).filter((k) => k !== PAD);
  assert.deepStrictEqual(Object.keys(s.structure.variant_items), others, 'the other groups stay; an emptied map is {} — the field stays authored (assertSameAuthoredFields keeps a brand\'s structure fields)');
  const b = builds('la_musa', s);
  assert.ok(groupIndexFrom(b).ok && !groupIndexFrom(b).launchers.has(PAD), 'the built index no longer has the group');
  refused(() => CT.apply(LM, { op: 'choice.remove', launcher: PAD, price_from: 'noodle_02' }), 'choice_option_missing');
  refused(() => CT.apply(LM, { op: 'choice.remove', launcher: 'noodle_02', price_from: PAD_OPTS[0] }), 'choice_group_missing');
});
cell('CT-UNKNOWN: an unknown op is refused', () => refused(() => CT.apply(LM, { op: 'choice.explode' }), 'unknown_op'));

if (fails.length) { console.error(`choice-transitions FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`choice-transitions: OK (${n})`);
