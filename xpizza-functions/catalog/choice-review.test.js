'use strict';
// S3 (PLAN-structure-S3-r3 §4) — THE canonical review diff with the required-choice switch. Codex r1 P1-5: catalogDiff paired an
// equal-price removal + addition as a «rename» and dropped its new-item sanity row, so a same-price option REPLACEMENT vanished from
// the fiscal review. With choiceEdit ON and an S3 edit present: no item pairing; the fiscal seal lists the new options; explicit
// `choices` rows show each group's label / membership / «Recomendada» change and a dish gaining or losing its group (D3's reprice is in
// fiscal.repriced). Without an S3 edit — and always with the switch OFF — the diff is today's, byte for byte (a price-only option
// edit included). Real sources, real writer, real build. Run: node catalog/choice-review.test.js
const assert = require('assert');
const STRUCT = { choiceEdit: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: false }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { reviewDiff } = require('./review-diff');
const CT = require('./choice-transitions');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const built = (rid, src) => buildSourceCandidate(rid, src).built;
const diffOf = (rid, live, draft) => { const L = built(rid, live); const D = built(rid, draft); return reviewDiff({ live: L, liveExtraRecords: L.extras, draftBuilt: D, draftExtraRecords: D.extras }); };
const ON = (fn) => { STRUCT.choiceEdit = true; try { return fn(); } finally { STRUCT.choiceEdit = false; } };
const apply = (src, op) => CT.apply(src, op).source;
// a settled option row (the allocator's outcome) — id mode: its id is its key
const withOption = (src, lkey, key, choice, price) => {
  const s = clone(src); const l = s.items.find((i) => i.key === lkey);
  s.items.push({ key, price, display: { id: key, variantOf: l.display.id, choice, name: `${l.display.name} - ${choice}`, price, cat: l.display.cat, ...(l.display.subcat != null ? { subcat: l.display.subcat } : {}) } });
  s.structure.variant_items[String(l.display.id)].variantIds.push(key);
  const o = s.structure.item_order; o.splice(o.indexOf(s.structure.variant_items[String(l.display.id)].variantIds.slice(-2)[0]) + 1, 0, key);
  return s;
};

const LM = buildSourceFromCode('la_musa');
const PAD = 'noodle_01';
const opts = LM.structure.variant_items[PAD].variantIds.map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
const mark = (s, k) => apply(s, { op: 'choice.recommended', launcher: PAD, option: k });
// a same-price REPLACEMENT: option 3 out, a new option at its price in
const p3 = LM.items.find((i) => i.key === opts[2]).price;
const replaced = mark(withOption(apply(LM, { op: 'option.remove', key: opts[2] }), PAD, 'noodle_01_tofu', 'Tofu', p3), opts[0]);

cell('CR-OFF: with the switch OFF the same-price replacement is today\'s diff — paired as a rename (the defect the switch closes; today\'s token bytes)', () => {
  const d = diffOf('la_musa', LM, replaced);
  assert.deepStrictEqual(d.renamed.map((r) => [r.from, r.to]), [[opts[2], 'noodle_01_tofu']]);
  assert.ok(!('choices' in d) && !('fiscal' in d));
});
cell('CR-PAIRING (P1-5): ON, the same-price replacement shows as removed + added, in the fiscal seal and the sanity rows — never a rename', () => ON(() => {
  const d = diffOf('la_musa', LM, replaced);
  assert.deepStrictEqual(d.renamed, []);
  assert.deepStrictEqual(d.removed.map((r) => r.key), [opts[2]]);
  assert.deepStrictEqual(d.added.map((r) => r.key), ['noodle_01_tofu']);
  assert.deepStrictEqual(d.fiscal.added.map((r) => [r.key, r.price]), [['noodle_01_tofu', p3]]);
  assert.ok(d.largeChangeSet.some((r) => r.key === 'noodle_01_tofu'), 'the new option keeps its sanity row');
}));
cell('CR-CHOICES: ON, the group row names its label, membership and «Recomendada» changes', () => ON(() => {
  const d = diffOf('la_musa', LM, apply(replaced, { op: 'choice.label', launcher: PAD, label: 'Elegí la proteína' }));
  assert.deepStrictEqual(d.choices, [{ launcher: PAD, name: LM.items.find((i) => i.key === PAD).display.name,
    label: { old: LM.structure.variant_items[PAD].label, new: 'Elegí la proteína' },
    members: { added: ['noodle_01_tofu'], removed: [opts[2]] },
    recommended: { old: [], new: [opts[0]] } }]);
}));
cell('CR-D3: ON, a dish losing its group is a `plain` row; its reprice to the option price is in fiscal.repriced', () => ON(() => {
  const d = diffOf('la_musa', LM, apply(LM, { op: 'choice.remove', launcher: PAD, price_from: opts[1] }));
  const row = d.choices.find((r) => r.launcher === PAD);
  assert.strictEqual(row.became, 'plain');
  assert.deepStrictEqual(row.members.removed.sort(), [...opts].sort());
  const lp = LM.items.find((i) => i.key === PAD).price; const np = LM.items.find((i) => i.key === opts[1]).price;
  assert.deepStrictEqual(d.fiscal.repriced.filter((r) => r.key === PAD).map((r) => [r.old, r.new]), [[lp, np]]);
}));
cell('CR-PRICE-ONLY (P2-4): ON, an option price edit alone is today\'s diff, byte for byte (La Musa Pollo 342 → 350)', () => {
  const d = clone(LM); const o = d.items.find((i) => i.key === opts[1]); o.price = 350; o.display.price = 350;
  const off = JSON.stringify(diffOf('la_musa', LM, d));
  assert.strictEqual(ON(() => JSON.stringify(diffOf('la_musa', LM, d))), off);
});
cell('CR-NO-S3: ON, a draft with no S3 edit (a dish description) is today\'s diff, byte for byte', () => {
  const d = clone(LM); d.items.find((i) => i.key === 'noodle_02').display.desc = 'Otra';
  assert.strictEqual(ON(() => JSON.stringify(diffOf('la_musa', LM, d))), JSON.stringify(diffOf('la_musa', LM, d)));
});

if (fails.length) { console.error(`choice-review FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`choice-review: OK (${n})`);
