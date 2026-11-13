'use strict';
// S3 (PLAN-structure-S3-r3 §0, §1, §2) — the structural judgment with the required-choice switch: choice-compare.compareToActive
// wraps add-product.compareToActive at every site that judges a draft (save, publish, the manager request's structure gate, the
// portal's draft assessment). OFF: today's judgment, byte for byte (the same call, the same answer). ON: the S3 delta — group labels,
// option text and marks, options added under / removed from an EXISTING dish, a plain dish gaining (D2) or losing (D3) its group —
// is judged here, today's compare judges everything else, and the activation classifier (choice-activation) runs on the pair.
// Real sources (buildSourceFromCode), real writer (choice-transitions), real build (buildSourceCandidate); new rows SETTLED as the
// save's allocator would. Run: node catalog/choice-compare.test.js
const assert = require('assert');
const STRUCT = { choiceEdit: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: false }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { rendererContract } = require('./source-store');
const AP = require('./add-product');
const CT = require('./choice-transitions');
const CC = require('./choice-compare');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const built = (rid, src) => { const b = buildSourceCandidate(rid, src).built; return { items: b.items, extras: b.extras, structure: b.structure }; };
const refusedWith = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return e; } assert.fail(`not refused (${code})`); };
const args = (rid, active, draft, deletedIds = []) => ({ draftBuilt: built(rid, draft), activeBuilt: built(rid, active), draftAuthored: Object.keys(draft.structure || {}), renderedCategories: rendererContract(rid).renderedCategories, deletedIds, authoring: true, extrasAuthoring: false, textEdit: false, extrasCatalog: false });
const judge = (rid, active, draft, deletedIds) => CC.compareToActive(rid, args(rid, active, draft, deletedIds));
const today = (rid, active, draft, deletedIds) => AP.compareToActive(args(rid, active, draft, deletedIds));
const outcome = (fn) => { try { return { ok: fn() }; } catch (e) { return { code: e.code, detail: e.detail, key: e.key, field: e.field }; } };
const apply = (src, op) => CT.apply(src, op).source;
const ON = (fn) => { STRUCT.choiceEdit = true; try { return fn(); } finally { STRUCT.choiceEdit = false; } };

// the allocator's outcome (tmp refs → keys / display ids), as in choice-activation.test.js
function settle(src) {
  const s = clone(src);
  const idMode = s.key_mode === 'id';
  let next = Math.max(0, ...s.items.map((i) => Number(i.display && i.display.id)).filter(Number.isFinite)) + 1;
  const idOfRef = new Map(); const keyOfRef = new Map();
  for (const it of s.items) {
    if (!it.ref) continue;
    const id = idMode ? `s3c_${it.ref.slice(4).replace(/[^a-z0-9]/g, '_')}` : next++;
    idOfRef.set(it.ref, id); keyOfRef.set(it.ref, idMode ? id : it.display.name);
  }
  const parentRow = (v) => s.items.find((x) => String(x.ref || x.display.id) === String(v));
  for (const it of s.items) {
    if (!it.ref) continue;
    const p = it.display.variantOf != null ? parentRow(it.display.variantOf) : null;
    it.key = keyOfRef.get(it.ref);
    it.display = { ...it.display, id: idOfRef.get(it.ref), ...(p ? { cat: p.display.cat, ...(p.display.subcat != null ? { subcat: p.display.subcat } : {}), name: `${p.display.name} - ${it.display.choice}` } : {}) };
  }
  for (const it of s.items) if (it.display.variantOf != null && idOfRef.has(it.display.variantOf)) it.display.variantOf = idOfRef.get(it.display.variantOf);
  const vi = s.structure.variant_items || {};
  for (const [k, spec] of Object.entries(vi)) {
    const nk = idOfRef.has(k) ? String(idOfRef.get(k)) : k;
    spec.variantIds = spec.variantIds.map((v) => (idOfRef.has(v) ? idOfRef.get(v) : v));
    if (nk !== k) { delete vi[k]; vi[nk] = spec; }
  }
  s.structure.item_order = s.structure.item_order.map((k) => (keyOfRef.has(k) ? keyOfRef.get(k) : k));
  for (const it of s.items) delete it.ref;
  return s;
}

// certified rows (identity stamps), so a removal can be declared
const stamped = (src) => { const s = clone(src); for (const it of s.items) it.display.identity_id = `id_${String(it.key).replace(/[^A-Za-z0-9]/g, '_')}`; return s; };
const XP = stamped(buildSourceFromCode('x_pizza'));
const LM = stamped(buildSourceFromCode('la_musa'));
const PAD = 'noodle_01';
const padOpts = (src) => src.structure.variant_items[PAD].variantIds.map((id) => src.items.find((i) => String(i.display.id) === String(id)).key);
const stampOf = (src, k) => src.items.find((i) => i.key === k).display.identity_id;
const NONREWARD = XP.structure.categories.map((c) => c.id).find((c) => !(XP.structure.redeem_eligible_cats || []).includes(c) && XP.items.some((i) => i.display.cat === c));
const XP_PLAIN = XP.items.find((i) => i.display.cat === NONREWARD && i.display.variantOf == null).key;
const D2 = (key) => ({ op: 'choice.add', key, label: 'Tamaño', options: [{ ref: 'tmp:cc-a-xxxxxxx', choice: 'Personal' }, { ref: 'tmp:cc-b-xxxxxxx', choice: 'Grande', price: 999 }] });
const marked = (src) => apply(src, { op: 'choice.recommended', launcher: PAD, option: padOpts(src)[0] });

cell('CC-OFF: the switch OFF is today\'s judgment — the same answer for a price edit, a D2 draft and a label edit (byte-identical outcomes)', () => {
  const price = clone(LM); price.items.find((i) => i.key === PAD).price = 420; price.items.find((i) => i.key === PAD).display.price = 420;
  for (const [rid, a, d] of [['la_musa', LM, price], ['x_pizza', XP, settle(apply(XP, D2(XP_PLAIN)))], ['la_musa', LM, apply(LM, { op: 'choice.label', launcher: PAD, label: 'Otra' })]]) {
    assert.deepStrictEqual(outcome(() => judge(rid, a, d)), outcome(() => today(rid, a, d)), rid);
  }
  assert.strictEqual(outcome(() => judge('x_pizza', XP, settle(apply(XP, D2(XP_PLAIN))))).code, 'choices_not_supported_yet', 'premise: today refuses D2');
});
cell('CC-ON-LABEL-MARK: a group label change with its one mark passes; the label alone is choice_recommended_required', () => ON(() => {
  const d = apply(marked(LM), { op: 'choice.label', launcher: PAD, label: 'Elegí la proteína' });
  assert.ok(judge('la_musa', LM, d));
  refusedWith(() => judge('la_musa', LM, apply(LM, { op: 'choice.label', launcher: PAD, label: 'Elegí la proteína' })), 'choice_recommended_required');
}));
cell('CC-ON-RENAME: an option rename (key kept, composed name) passes; a name that is not «{dish} - {choice}» is choice_name_not_derived', () => ON(() => {
  const d = marked(apply(LM, { op: 'option.rename', key: padOpts(LM)[1], choice: 'Pollo al Wok' }));
  assert.ok(judge('la_musa', LM, d));
  const bad = clone(d); bad.items.find((i) => i.key === padOpts(LM)[1]).display.name = 'Otro Nombre';
  refusedWith(() => judge('la_musa', LM, bad), 'choice_name_not_derived');
}));
cell('CC-ON-RENAME-CAPS: a composed name over 60 is option_name_too_long; two options with the same choice (case-folded) is choice_duplicate', () => ON(() => {
  refusedWith(() => judge('la_musa', LM, marked(apply(LM, { op: 'option.rename', key: padOpts(LM)[1], choice: 'x'.repeat(60) }))), 'option_name_too_long');
  const first = LM.items.find((i) => i.key === padOpts(LM)[0]).display.choice;
  refusedWith(() => judge('la_musa', LM, marked(apply(LM, { op: 'option.rename', key: padOpts(LM)[1], choice: first.toUpperCase() }))), 'choice_duplicate');
}));
cell('CC-ON-ADD: an option added under an EXISTING dish passes (marked) and is returned as an addition', () => ON(() => {
  const d = marked(settle(apply(LM, { op: 'option.add', launcher: PAD, ref: 'tmp:cc-tofu-xxxxx', choice: 'Tofu', price: 330 })));
  const r = judge('la_musa', LM, d);
  assert.ok(r.additions.includes('s3c_cc_tofu_xxxxx'), JSON.stringify(r));
}));
cell('CC-ON-REMOVE: a DECLARED option removal passes (a removal); undeclared → existing_item_removed (today\'s claim rule)', () => ON(() => {
  const k = padOpts(LM)[2];
  const d = marked(apply(LM, { op: 'option.remove', key: k }));
  assert.deepStrictEqual(judge('la_musa', LM, d, [stampOf(LM, k)]).removals, [k]);
  refusedWith(() => judge('la_musa', LM, d, []), 'existing_item_removed');
}));
cell('CC-ON-D2: a plain non-reward dish gains a group (its options are additions); a reward dish → choice_on_reward_dish', () => ON(() => {
  const r = judge('x_pizza', XP, settle(apply(XP, D2(XP_PLAIN))));
  assert.strictEqual(r.additions.length, 2);
  const reward = XP.items.find((i) => i.display.cat === 'individual' && i.display.variantOf == null).key;
  refusedWith(() => judge('x_pizza', XP, settle(apply(XP, D2(reward)))), 'choice_on_reward_dish');
}));
cell('CC-ON-D3: the group leaves (declared option removals), the dish is plain at price_from\'s price', () => ON(() => {
  const opts = padOpts(LM);
  const d = apply(LM, { op: 'choice.remove', launcher: PAD, price_from: opts[1] });
  assert.deepStrictEqual(judge('la_musa', LM, d, opts.map((k) => stampOf(LM, k))).removals.sort(), [...opts].sort());
  refusedWith(() => judge('la_musa', LM, d, []), 'existing_item_removed');
}));
cell('CC-ON-STILL-TODAY: anything that is not an S3 edit is judged as today — a dish description, an option moved to another dish, a plain dish made an option', () => ON(() => {
  const desc = clone(LM); desc.items.find((i) => i.key === PAD).display.desc = 'Otra descripción';
  refusedWith(() => judge('la_musa', LM, desc), 'existing_item_changed');
  const plain = clone(LM); const other = plain.items.find((i) => i.key === 'noodle_02'); other.display.variantOf = PAD; other.display.choice = 'Robada';
  plain.structure.variant_items[PAD].variantIds.push(other.display.id);
  assert.ok(outcome(() => judge('la_musa', LM, marked(plain))).code, 'a plain dish cannot become an option');
}));
cell('CC-ON-PRICE-ONLY: an option price edit is today\'s judgment (no mark needed) — the same answer as OFF', () => {
  const d = clone(LM); const o = d.items.find((i) => i.key === padOpts(LM)[1]); o.price = 350; o.display.price = 350;
  const off = outcome(() => judge('la_musa', LM, d));
  assert.deepStrictEqual(ON(() => outcome(() => judge('la_musa', LM, d))), off);
});

cell('CC-PREPARE: new options under an EXISTING dish (option.add, D2) get their derived fields — «{dish} - {choice}», the dish\'s section and extras setting — and are returned by ref; a blank choice / an unsafe one / a blank D2 label refuse', () => {
  const src = apply(apply(XP, D2(XP_PLAIN)), { op: 'option.rename', key: 'tmp:cc-a-xxxxxxx', choice: '  Personal  ' });
  const dish = src.items.find((i) => i.key === XP_PLAIN);
  const refs = CC.prepareExistingGroups(src, { fieldProblem: () => null });
  assert.deepStrictEqual([...refs].sort(), ['tmp:cc-a-xxxxxxx', 'tmp:cc-b-xxxxxxx']);
  const a = src.items.find((i) => i.ref === 'tmp:cc-a-xxxxxxx');
  assert.deepStrictEqual([a.display.choice, a.display.name, a.display.cat], ['Personal', `${dish.display.name} - Personal`, dish.display.cat]);
  const blank = apply(XP, { ...D2(XP_PLAIN), options: [{ ref: 'tmp:bl-a-xxxxxxx', choice: '' }, { ref: 'tmp:bl-b-xxxxxxx', choice: 'B' }] });
  refusedWith(() => CC.prepareExistingGroups(blank, { fieldProblem: () => null }), 'choice_label_required');
  refusedWith(() => CC.prepareExistingGroups(apply(XP, D2(XP_PLAIN)), { fieldProblem: (f) => (f === 'choice' ? 'has unsafe characters' : null) }), 'text_unsafe');
  refusedWith(() => CC.prepareExistingGroups(apply(XP, { ...D2(XP_PLAIN), label: ' ' }), { fieldProblem: () => null }), 'label_required');
  assert.strictEqual(CC.prepareExistingGroups(clone(LM), { fieldProblem: () => null }).size, 0, 'no new option → nothing');
});

if (fails.length) { console.error(`choice-compare FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`choice-compare: OK (${n})`);
