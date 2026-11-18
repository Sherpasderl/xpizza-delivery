'use strict';
// S3 (PLAN-structure-S3-r3 §1a, §1c, §2) — THE activation classifier, judged on the RESULTING built snapshots (baseline → target),
// both from the REAL build (buildSourceCandidate) over the REAL sources, the target written by the REAL writer (choice-transitions).
// A target with new rows is SETTLED first — its tmp refs replaced by the keys / display ids the save's allocator gives (name mode:
// the composed name and the next numeric id; id mode: a slug id) — so the classifier sees what it sees in production.
// Run: node catalog/choice-activation.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const CT = require('./choice-transitions');
const CA = require('./choice-activation');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const built = (rid, src) => buildSourceCandidate(rid, src).built;
const refusedWith = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return e; } assert.fail(`not refused (${code})`); };
const judge = (rid, baseSrc, targetSrc, { choiceEdit = true } = {}) => CA.choiceActivation({ rid, baseline: built(rid, baseSrc), target: built(rid, targetSrc), choiceEdit });

// the allocator's outcome for a settled target: tmp refs → keys / display ids, in place
function settle(rid, src) {
  const s = clone(src);
  const idMode = s.key_mode === 'id';
  let next = Math.max(0, ...s.items.map((i) => Number(i.display && i.display.id)).filter(Number.isFinite)) + 1;
  const idOfRef = new Map(); const keyOfRef = new Map();
  for (const it of s.items) {
    if (!it.ref) continue;
    const id = idMode ? `s3t_${it.ref.slice(4).replace(/[^a-z0-9]/g, '_')}` : next++;
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
const apply = (src, op) => CT.apply(src, op).source;
const D2 = (key, refs) => ({ op: 'choice.add', key, label: 'Tamaño', options: [{ ref: refs[0], choice: 'Personal' }, { ref: refs[1], choice: 'Grande', price: 999 }] });

const XP = buildSourceFromCode('x_pizza');
const LM = buildSourceFromCode('la_musa');
const PAD = 'noodle_01';
const padOpts = (src) => src.structure.variant_items[PAD].variantIds.map((id) => src.items.find((i) => String(i.display.id) === String(id)).key);
const NON_REWARD_XP_CAT = XP.structure.categories.map((c) => c.id).find((c) => !(XP.structure.redeem_eligible_cats || []).includes(c) && XP.items.some((i) => i.display.cat === c));
const plainIn = (src, cat) => src.items.find((i) => i.display.cat === cat && i.display.variantOf == null && !(src.structure.variant_items || {})[String(i.display.id)]).key;
const XP_REWARD = plainIn(XP, 'individual');
const LM_REWARD = plainIn(LM, 'noodles');

cell('CA-OFF: with choiceEdit OFF nothing is judged (a reward dish gaining a group passes — today\'s rules apply elsewhere)', () => {
  assert.strictEqual(judge('x_pizza', XP, settle('x_pizza', apply(XP, D2(XP_REWARD, ['tmp:off-a-xxxxx', 'tmp:off-b-xxxxx']))), { choiceEdit: false }), null);
});
cell('CA-REWARD-D2 both brands: an EXISTING reward-redeemable dish that gains a group is choice_on_reward_dish (409, its key)', () => {
  for (const [rid, src, k] of [['x_pizza', XP, XP_REWARD], ['la_musa', LM, LM_REWARD]]) {
    const e = refusedWith(() => judge(rid, src, settle(rid, apply(src, D2(k, ['tmp:rw-a-xxxxxx', 'tmp:rw-b-xxxxxx'])))), 'choice_on_reward_dish');
    assert.deepStrictEqual([e.status, e.key], [409, k], rid);
  }
});
cell('CA-REWARD-LIVE-ONLY: redeemable only in the BASELINE (the draft moves it out of the reward category in the same publish) → refused', () => {
  const t = apply(XP, D2(XP_REWARD, ['tmp:lo-a-xxxxxx', 'tmp:lo-b-xxxxxx']));
  for (const it of t.items) if (it.key === XP_REWARD || (it.display.variantOf != null && String(it.display.variantOf) === String(XP.items.find((i) => i.key === XP_REWARD).display.id))) it.display.cat = NON_REWARD_XP_CAT;
  refusedWith(() => judge('x_pizza', XP, settle('x_pizza', t)), 'choice_on_reward_dish');
});
cell('CA-REWARD-DRAFT-ONLY: redeemable only in the TARGET (moved INTO a reward category with its group) → refused', () => {
  const base = clone(XP); const k = plainIn(XP, NON_REWARD_XP_CAT);
  const t = apply(base, D2(k, ['tmp:do-a-xxxxxx', 'tmp:do-b-xxxxxx']));
  const lid = String(base.items.find((i) => i.key === k).display.id);
  for (const it of t.items) if (it.key === k || String(it.display.variantOf) === lid || (it.ref && t.structure.variant_items[lid].variantIds.includes(it.ref))) it.display.cat = 'individual';
  refusedWith(() => judge('x_pizza', base, settle('x_pizza', t)), 'choice_on_reward_dish');
});
cell('CA-NONREWARD: a dish redeemable in neither snapshot gains a group → allowed (D2 marks its first option)', () => {
  const k = plainIn(XP, NON_REWARD_XP_CAT);
  assert.strictEqual(judge('x_pizza', XP, settle('x_pizza', apply(XP, D2(k, ['tmp:nr-a-xxxxxx', 'tmp:nr-b-xxxxxx'])))), null);
});
cell('CA-NO-MODEL: a restaurant with no redemption model → a reward-category conversion is allowed (data, not a brand branch)', () => {
  assert.strictEqual(CA.choiceActivation({ rid: 'no_rewards_rid', baseline: built('x_pizza', XP), target: built('x_pizza', settle('x_pizza', apply(XP, D2(XP_REWARD, ['tmp:nm-a-xxxxxx', 'tmp:nm-b-xxxxxx'])))), choiceEdit: true }), null);
});
cell('CA-NEW-DISH (Q3): a BRAND-NEW sized dish in X Pizza individual (absent from the baseline) is allowed; the same dish once live, converted again, is judged like any existing dish', () => {
  const add = clone(XP);
  add.items.push({ ref: 'tmp:newpie-xxxxxx', price: 300, display: { name: 'Pizza Nueva S3', cat: 'individual', price: 300 } });
  add.structure.item_order.push('tmp:newpie-xxxxxx');
  const withGroup = apply(add, D2('tmp:newpie-xxxxxx', ['tmp:np-a-xxxxxx', 'tmp:np-b-xxxxxx']));
  const live = settle('x_pizza', withGroup);
  assert.strictEqual(judge('x_pizza', XP, live), null, 'a new sized dish is accepted');
  // now live WITHOUT a group (a plain new pie published), then converted → refused
  const plainLive = settle('x_pizza', add);
  refusedWith(() => judge('x_pizza', plainLive, settle('x_pizza', apply(plainLive, D2('Pizza Nueva S3', ['tmp:np2-a-xxxxx', 'tmp:np2-b-xxxxx'])))), 'choice_on_reward_dish');
});
cell('CA-MINTED both brands: an existing MINTED dish (key i_…, display id ≠ key) gaining a group is judged by its KEY → refused', () => {
  for (const [rid, src, cat] of [['x_pizza', XP, 'individual'], ['la_musa', LM, 'noodles']]) {
    const m = clone(src); const id = rid === 'x_pizza' ? 7101 : 'mint_s3_dish';
    m.items.push({ key: 'i_aaaaaaaaaaac', price: 210, display: { id, name: 'Plato Minted', cat, price: 210, desc: '' } });
    m.structure.item_order.push('i_aaaaaaaaaaac'); m.frozen_keys = { ...(m.frozen_keys || {}), [id]: 'i_aaaaaaaaaaac' };
    const e = refusedWith(() => judge(rid, m, settle(rid, apply(m, D2('i_aaaaaaaaaaac', ['tmp:mn-a-xxxxxx', 'tmp:mn-b-xxxxxx'])))), 'choice_on_reward_dish');
    assert.strictEqual(e.key, 'i_aaaaaaaaaaac', `${rid}: named by its pricing key`);
  }
});
cell('CA-INDEX-INVALID: an unreadable group index on either side fails closed (choice_index_invalid), never "no groups"', () => {
  const b = built('la_musa', LM); const t = clone(b);
  t.structure.variant_items[PAD] = { ...t.structure.variant_items[PAD], variantIds: [...t.structure.variant_items[PAD].variantIds, 'nope_missing'] };
  refusedWith(() => CA.choiceActivation({ rid: 'la_musa', baseline: b, target: t, choiceEdit: true }), 'choice_index_invalid');
  refusedWith(() => CA.choiceActivation({ rid: 'la_musa', baseline: t, target: b, choiceEdit: true }), 'choice_index_invalid');
});
cell('CA-EXACTLY-ONE: a TOUCHED group needs exactly one «Recomendada» — 0 → choice_recommended_required, 2 → choice_recommended_many; untouched legacy groups pass with 0', () => {
  const [a, b] = padOpts(LM);
  assert.strictEqual(judge('la_musa', LM, LM), null, 'the untouched legacy group (0 marks) passes');
  refusedWith(() => judge('la_musa', LM, apply(LM, { op: 'choice.label', launcher: PAD, label: 'Proteína a elegir' })), 'choice_recommended_required');
  assert.strictEqual(judge('la_musa', LM, apply(apply(LM, { op: 'choice.label', launcher: PAD, label: 'Proteína a elegir' }), { op: 'choice.recommended', launcher: PAD, option: a })), null);
  const two = apply(LM, { op: 'choice.recommended', launcher: PAD, option: a }); two.items.find((i) => i.key === b).display.tags = ['recommended'];
  refusedWith(() => judge('la_musa', LM, two), 'choice_recommended_many');
});
cell('CA-REMOVE-RECOMMENDED: removing the marked option leaves 0 → refused until another is marked', () => {
  const [a, b, c] = padOpts(LM);
  const marked = apply(LM, { op: 'choice.recommended', launcher: PAD, option: c });
  refusedWith(() => judge('la_musa', marked, apply(marked, { op: 'option.remove', key: c })), 'choice_recommended_required');
  assert.strictEqual(judge('la_musa', marked, apply(apply(marked, { op: 'option.remove', key: c }), { op: 'choice.recommended', launcher: PAD, option: a })), null);
  void b;
});
cell('CA-PRICE-ONLY (P2-4): an option price change alone touches no group — no mark required (La Musa Pollo 342 → 350)', () => {
  const t = clone(LM); const pollo = t.items.find((i) => i.key === padOpts(LM)[1]);
  pollo.price = 350; pollo.display.price = 350;
  assert.strictEqual(judge('la_musa', LM, t), null);
});
cell('CA-D3-PRICE: removing a group requires the dish\'s new price to be one of its options\' prices (price_from) — else choice_price_from_invalid', () => {
  const from = padOpts(LM)[1];
  const ok = apply(LM, { op: 'choice.remove', launcher: PAD, price_from: from });
  assert.strictEqual(judge('la_musa', LM, ok), null);
  const bad = clone(ok); const l = bad.items.find((i) => i.key === PAD); l.price = 1; l.display.price = 1;
  refusedWith(() => judge('la_musa', LM, bad), 'choice_price_from_invalid');
});

if (fails.length) { console.error(`choice-activation FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`choice-activation: OK (${n})`);
