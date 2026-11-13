// STRUCTURE S3 (UI) — the DRAWING half, step 1: the drawer's working copy for a LIVE dish's required choice (MOCKUP-portal-structure-edit
// panel D / D2 / D3 + the S3 addendum B2 / B2b / B7; advisor 11-13: build to the visually-checked addendum, copy pending). The copy keeps
// its S3 ops IN CLICK ORDER next to S2's; each is dry-run through 5f's writer (the portal's byte copy) before it is queued; «Guardar» is ONE
// composition (the choice ops first, then today's fields); a TOUCHED group with no «Recomendada» is HELD in the drawer (never sent to a
// sure 409). Real seeds (both brands); the page's classic scripts in index.html order. Run: node --test structure-s3-drawer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';

for (const f of ['extras-eligibility.js', 'exposure-transitions.js', 'choice-transitions.js', 'section-transitions.js']) runInThisContext(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const { createDraft, draftSource, addProduct, setAddition, setRequiredChoice, setGroupLabel, setChoiceName, setChoicePrice, removeChoice, rowId } = await import('./editor.js');
const IE = await import('./item-edit-logic.js');
const freq = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
const { buildSourceFromCode } = freq('./tools/seed-source-store');
const { canonicalize } = freq('./catalog/source-store');
const CT = freq('./catalog/choice-transitions');

const clone = (v) => JSON.parse(JSON.stringify(v));
const seed = (rid) => canonicalize(buildSourceFromCode(rid));
const ON = { extrasAuthoring: true, choiceEdit: true };
const PAD = 'noodle_01';
const membersOf = (src, key) => { const l = src.items.find((i) => i.key === key); return src.structure.variant_items[String(l.display.id)].variantIds.map((id) => src.items.find((i) => String(i.display.id) === String(id) || i.ref === id)); };
const ref = (c) => `tmp:${c.repeat(8)}`;

test('OFF: the copy carries no choice ops — choiceOp refuses choice_edit_off, choiceModel is null, save is today\'s', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, { extrasAuthoring: true });
  assert.deepEqual(IE.choiceOp(s, { op: 'choice.label', launcher: PAD, label: 'Proteína' }), { ok: false, code: 'choice_edit_off' });
  assert.equal(IE.choiceModel(d, s), null, 'no editor model with the switch off');
  assert.deepEqual(s.choiceOps, []);
});

test('the model of a LIVE group: its options in order with price and mark; zero marks today; untouched ⇒ no hold', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  const m = IE.choiceModel(d, s);
  const live = membersOf(draftSource(d), PAD);
  assert.deepEqual(m.options.map((o) => o.id), live.map((o) => o.key));
  assert.ok(m.options.every((o) => o.marked === false), 'premise: no live mark (S3-r4 :129)');
  assert.equal(m.touched, false); assert.equal(m.hold, null, 'an untouched group never shows the line (the legacy grace)');
});

test('B2: a TOUCHED group with no mark is HELD — «Guardar» sends nothing; one pill tap (ONE choice.recommended op) releases it', () => {
  const d = createDraft(clone(seed('la_musa')));
  const before = JSON.stringify(draftSource(d));
  const s = IE.open(d, PAD, null, ON);
  assert.equal(IE.choiceOp(s, { op: 'option.add', launcher: PAD, ref: ref('n'), choice: 'Tofu', price: 330 }).ok, true);
  let m = IE.choiceModel(d, s);
  assert.equal(m.touched, true); assert.deepEqual(m.hold, { reason: 'recommended_required' }, '🔴 the line appears');
  assert.deepEqual(IE.save(d, s), { ok: false, error: 'choice_hold', reason: 'recommended_required' }, '🔴 held in the drawer');
  assert.equal(JSON.stringify(draftSource(d)), before, 'nothing written');
  const pick = m.options[1].id;
  assert.equal(IE.choiceOp(s, { op: 'choice.recommended', launcher: PAD, option: pick }).ok, true);
  m = IE.choiceModel(d, s);
  assert.equal(m.hold, null); assert.deepEqual(m.options.filter((o) => o.marked).map((o) => o.id), [pick]);
  assert.deepEqual(IE.save(d, s), { ok: true });
  const out = membersOf(draftSource(d), PAD);
  assert.equal(out.length, 4, 'the new option landed'); assert.deepEqual(out.filter((o) => (o.display.tags || []).includes('recommended')).map((o) => o.key), [pick]);
});

test('a price-only edit is NOT an S3 edit: no line, «Guardar» saves as today (S3-r4 :127)', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  const k = membersOf(draftSource(d), PAD)[0].key;
  IE.set(s, 'optionPrice', { key: k, raw: '399' });
  assert.equal(IE.choiceModel(d, s).hold, null);
  assert.deepEqual(IE.save(d, s), { ok: true });
});

test('B2 (iii): removing the MARKED option ⇒ the other hold reason («Quitaste…»); the trash refuses at two options (choices_too_few)', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s0 = IE.open(d, PAD, null, ON);
  const [a, b, c] = membersOf(draftSource(d), PAD).map((o) => o.key);
  IE.choiceOp(s0, { op: 'choice.recommended', launcher: PAD, option: a }); IE.save(d, s0);   // a stored mark, as after a first save
  const s = IE.open(d, PAD, null, ON);
  s.draft.orig = clone(draftSource(d));                                                         // the baseline now carries the mark
  assert.equal(IE.choiceOp(s, { op: 'option.remove', key: a }).ok, true);
  assert.deepEqual(IE.choiceModel(d, s).hold, { reason: 'recommended_removed' }, '🔴 «Quitaste la opción recomendada…»');
  assert.equal(IE.choiceOp(s, { op: 'option.remove', key: b }).code, 'choices_too_few', 'two left: the trash refuses');
  assert.ok(c);
});

test('B2b / D3: «Quitar elección» defaults the price to the marked option; with NO mark the plan asks (priceFrom null) and the op needs a pick', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  const opts = membersOf(draftSource(d), PAD);
  assert.deepEqual(IE.choiceRemovePlan(d, s), { priceFrom: null, options: opts.map((o) => ({ id: o.key, choice: o.display.choice, price: o.price })) }, '🔴 zero marks: ask');
  IE.choiceOp(s, { op: 'choice.recommended', launcher: PAD, option: opts[1].key });
  assert.equal(IE.choiceRemovePlan(d, s).priceFrom, opts[1].key, 'a marked group: the default');
  assert.equal(IE.choiceOp(s, { op: 'choice.remove', launcher: PAD, price_from: opts[2].key }).ok, true);
  assert.equal(IE.choiceModel(d, s).removed, true, 'the dish goes back to one price');
  assert.deepEqual(IE.save(d, s), { ok: true });
  const dish = draftSource(d).items.find((i) => i.key === PAD);
  assert.equal(dish.price, opts[2].price, 'the picked price stays');
});

test('the copy\'s ops are the SERVER writer\'s: «Guardar» writes exactly what CT.apply writes, in click order', () => {
  const src = seed('la_musa');
  const d = createDraft(clone(src));
  const s = IE.open(d, PAD, null, ON);
  const ops = [{ op: 'choice.label', launcher: PAD, label: 'Proteína' }, { op: 'option.rename', key: membersOf(src, PAD)[1].key, choice: 'Pollo al wok' },
    { op: 'choice.recommended', launcher: PAD, option: membersOf(src, PAD)[0].key }];
  for (const op of ops) assert.equal(IE.choiceOp(s, op).ok, true);
  IE.save(d, s);
  let want = clone(src); for (const op of ops) want = CT.apply(want, op).source;
  assert.equal(JSON.stringify(membersOf(draftSource(d), PAD)), JSON.stringify(membersOf(want, PAD)), '🔴 the server writer\'s output');
});

test('B7 (the flip gate): with choiceEdit ON a NEW dish\'s group marks its FIRST option; deleting it moves the mark to the new first; OFF unchanged', () => {
  const d = createDraft(clone(seed('la_musa')));
  const id = ref('z'); addProduct(d, { ref: id, cat: 'dim_sum' });
  const [o1, o2, o3] = [ref('x'), ref('y'), ref('w')];
  setRequiredChoice(d, id, true, [o1, o2], new Set(), { choiceEdit: true });
  const tags = (r) => (draftSource(d).items.find((i) => i.ref === r).display.tags || []);
  assert.deepEqual(tags(o1), ['recommended'], '🔴 the first option pre-marked'); assert.deepEqual(tags(o2), []);
  removeChoice(d, id, o1, { choiceEdit: true });
  assert.deepEqual(tags(o2), ['recommended'], 'the mark follows the first row: never zero');
  const off = createDraft(clone(seed('la_musa')));
  addProduct(off, { ref: id, cat: 'dim_sum' }); setRequiredChoice(off, id, true, [o1, o3]);
  assert.equal(draftSource(off).items.find((i) => i.ref === o1).display.tags, undefined, 'OFF: today, unmarked');
});

test('typing coalesces: the label / a rename / the mark stay ONE op each (the last value); a NEW option\'s name and price edit its own add op', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  for (const l of ['P', 'Pr', 'Proteína']) assert.equal(IE.choiceSet(s, { op: 'choice.label', launcher: PAD, label: l }).ok, true);
  const k = membersOf(draftSource(d), PAD)[1].key;
  for (const c of ['Po', 'Pollo wok']) IE.choiceSet(s, { op: 'option.rename', key: k, choice: c });
  const [a, b] = membersOf(draftSource(d), PAD).map((o) => o.key);
  IE.choiceSet(s, { op: 'choice.recommended', launcher: PAD, option: a }); IE.choiceSet(s, { op: 'choice.recommended', launcher: PAD, option: b });
  IE.choiceOp(s, { op: 'option.add', launcher: PAD, ref: ref('q'), choice: '', price: null });
  assert.equal(IE.choiceUpdateNew(s, ref('q'), { choice: 'Tofu' }).ok, true);
  assert.equal(IE.choiceUpdateNew(s, ref('q'), { price: 330 }).ok, true);
  assert.deepEqual(s.choiceOps.map((o) => o.op), ['choice.label', 'option.rename', 'choice.recommended', 'option.add'], '🔴 one op per slot');
  assert.equal(s.choiceOps[0].label, 'Proteína'); assert.equal(s.choiceOps[1].choice, 'Pollo wok'); assert.equal(s.choiceOps[2].option, b);
  assert.deepEqual([s.choiceOps[3].choice, s.choiceOps[3].price], ['Tofu', 330]);
  const m = IE.choiceModel(d, s);
  assert.deepEqual(m.options.find((o) => o.id === ref('q')), { id: ref('q'), choice: 'Tofu', price: 330, marked: false, isNew: true });
});

test('a NEW option\'s trash drops its add op and every op that names it (its mark included); a live option\'s trash is option.remove', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  IE.choiceOp(s, { op: 'option.add', launcher: PAD, ref: ref('t'), choice: 'Tofu', price: 330 });
  IE.choiceSet(s, { op: 'choice.recommended', launcher: PAD, option: ref('t') });
  assert.equal(IE.choiceDropNew(s, ref('t')).ok, true);
  assert.deepEqual(s.choiceOps, [], '🔴 nothing left of the new option');
  assert.equal(IE.choiceModel(d, s).touched, false, 'the group is as loaded again: no line');
  assert.equal(IE.choiceDropNew(s, ref('t')).ok, false, 'an unknown ref is refused');
});

test('choiceModel is a PURE reader (the wiring guards rule it so): a deep-frozen draft source and copy ops, byte-identical after', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  IE.choiceOp(s, { op: 'option.add', launcher: PAD, ref: ref('f'), choice: 'Tofu', price: 330 });
  const freeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };
  const before = JSON.stringify([draftSource(d), d.orig, s.choiceOps]);
  freeze(draftSource(d)); freeze(d.orig); freeze(s.choiceOps);
  const m = IE.choiceModel(d, s);
  assert.equal(m.options.length, 4, 'premise: the model read the ops');
  assert.equal(JSON.stringify([draftSource(d), d.orig, s.choiceOps]), before);
});

test('D3: choiceRemove turns the copy into a plain dish — «Precio» shows the picked price, editable; «Guardar» writes the removal then the typed price', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  const opts = membersOf(draftSource(d), PAD);
  IE.set(s, 'optionPrice', { key: opts[0].key, raw: '999' });                 // an option price typed before: moot once the choice goes
  assert.equal(IE.choiceRemove(s, 'nope').ok, false, 'price_from must be one of the group\'s options');
  assert.equal(IE.choiceRemove(s, opts[1].key).ok, true);
  let v = IE.view(d, s);
  assert.equal(v.options, null, '🔴 no option rows: the dish has one price');
  assert.equal(v.fields.price, String(opts[1].price), 'the picked price, in the Precio field');
  IE.set(s, 'price', '360');
  v = IE.view(d, s);
  assert.equal(v.save.enabled, true);
  assert.deepEqual(IE.save(d, s), { ok: true });
  const dish = draftSource(d).items.find((i) => i.key === PAD);
  assert.equal(dish.price, 360, 'the typed price wins, after the removal');
  assert.equal(draftSource(d).structure.variant_items[String(dish.display.id)], undefined, "the group is gone");
});

test('choiceRemovePlan is a PURE reader (the wiring guards rule it so): a deep-frozen draft source and copy ops, byte-identical after', () => {
  const d = createDraft(clone(seed('la_musa')));
  const s = IE.open(d, PAD, null, ON);
  IE.choiceOp(s, { op: 'choice.recommended', launcher: PAD, option: membersOf(draftSource(d), PAD)[2].key });
  const freeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };
  const before = JSON.stringify([draftSource(d), d.orig, s.choiceOps]);
  freeze(draftSource(d)); freeze(d.orig); freeze(s.choiceOps);
  assert.equal(IE.choiceRemovePlan(d, s).priceFrom, membersOf(draftSource(d), PAD)[2].key, 'premise: the plan read the ops');
  assert.equal(JSON.stringify([draftSource(d), d.orig, s.choiceOps]), before);
});
