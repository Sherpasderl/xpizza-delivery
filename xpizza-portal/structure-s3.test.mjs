// STRUCTURE S3 (UI) — the NON-DRAWING half (PLAN-portal-structure-S3-ui-r0, approved 2026-11-13): the portal's byte copy of 5f's choice
// writer (catalog/choice-transitions.js, tools/sync-client), the one mutator applyChoiceOps, the OFF cells, and the reward-dish refusal
// judged by the REAL save. The backend is 5f's REAL chain over one store (remove-product's harness): the seed stored → the real
// publishVersion → the real identity bootstrap → getEditableCatalogCore / editCatalogCore, the caller through the real
// authorizeCatalogEdit. The request bodies are the portal's own (api.js editCatalog), travelling verbatim. The ONE stub is the switch:
// choiceEdit, injected into platform-structure the way 5f's catalog/choice-compare.test.js:11 does (until getEditableCatalog states it).
// Run: node --test structure-s3.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { readFileSync } from 'node:fs';

process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const freq = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
const CE = { on: false };
{
  const p = freq.resolve('./catalog/platform-structure');
  const real = freq('./catalog/platform-structure');
  freq.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), choiceEdit: CE.on }) } };
}
// the page's classic scripts, in index.html order
for (const f of ['extras-eligibility.js', 'exposure-transitions.js', 'choice-transitions.js']) runInThisContext(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const { createDraft, draftSource, setItemPrice, addProduct, setAddition, setRequiredChoice, setGroupLabel, setChoiceName, setChoicePrice,
  setChoiceRecommended, applyChoiceOps, choiceRefusalLine } = await import('./editor.js');
const { editCatalog, ApiError } = await import('./api.js');
const SERVER_CT = freq('./catalog/choice-transitions');
const { buildSourceFromCode } = freq('./tools/seed-source-store');
const { canonicalize } = freq('./catalog/source-store');

const clone = (v) => JSON.parse(JSON.stringify(v));
const OWNER_LINE = 'Este producto se canjea con recompensas. Para mantener el premio, no se le pueden agregar opciones.';
const ON = { choiceEdit: true };
const ref = (c) => `tmp:${c.repeat(8)}`;

// ── the real backend, one store per rid ──
async function backend(rid) {
  const { makeDb } = freq('./catalog/firestore-fake');
  const { createFakeDb } = freq('./merchant/_fake-db');
  const { Timestamp } = freq('firebase-admin/firestore');
  const { sourceRefOf } = freq('./catalog/source-store');
  const { publishVersion } = freq('./catalog/catalog-publish');
  const { readPublishBaseline, buildPublishCandidate } = freq('./tools/publish-version');
  const { bootstrapIdentityStamps } = freq('./catalog/identity-bootstrap');
  const { getActiveVersionId } = freq('./catalog/catalog-firestore');
  const { authorizeCatalogEdit } = freq('./catalog/catalog-edit-auth');
  const { editCatalogCore } = freq('./catalog/edit-catalog-handler');
  const { getEditableCatalogCore } = freq('./catalog/portal-reads');
  const PR = freq('./catalog/publish-request');
  const U = 'uOwnerS3';
  const fsdb = makeDb();
  const rtdb = createFakeDb({ brands: { [rid]: { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } } },
    restaurants: { [rid]: { identity: { name: rid } } }, brand_members: { [rid]: { owners: { [U]: { granted_at: 1 } } } } });
  const seed = clone(buildSourceFromCode(rid));
  await fsdb.collection('restaurants').doc(rid).set({ pricing_key_mode: seed.key_mode });
  await sourceRefOf(fsdb, rid).set(seed);
  { const b = await readPublishBaseline(fsdb, rid, { fromStore: true }); const { input, expected } = buildPublishCandidate(rid, b, { source_sha: 's3ui' }); await publishVersion(fsdb, rid, input, { expected }); }
  assert.equal((await bootstrapIdentityStamps(fsdb, rid)).stamped, true, `premise: the real bootstrap stamped ${rid}`);
  const readActiveBuilt = async () => PR.readActiveBuiltFrom(fsdb, rid);
  const authorize = (r, q) => authorizeCatalogEdit({ db: rtdb, verifyIdToken: async () => ({ uid: U }) }, q, r);
  const rq = (m, auth) => ({ method: m, query: { restaurantId: rid }, get: (h) => (String(h).toLowerCase() === 'authorization' ? auth : undefined) });
  const toPrecondition = (v) => { if (typeof v !== 'string') return v; const [a, b] = v.split('.'); return /^\d+$/.test(a || '') && /^\d+$/.test(b || '') ? new Timestamp(Number(a), Number(b)) : v; };
  const addProductIo = freq('./catalog/add-product-io').addProductIo({ fs: fsdb, rtdb });
  const read = await getEditableCatalogCore({ db: rtdb, fsdb, readActiveVersionId: getActiveVersionId, readActiveBuilt, authorize, now: () => 6000 }, rq('GET', 'Bearer t'));
  assert.equal(read.status, 200, `premise: the editable read (${JSON.stringify(read.body).slice(0, 200)})`);
  const calls = [];
  // the portal's fetch → the real save core (the URL, method, headers and JSON body as api.js sent them)
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/editCatalog', `only the save is expected here, got ${u.pathname}`);
    const body = JSON.parse(opts.body);
    calls.push(body);
    const r = await editCatalogCore({ db: fsdb, authorize, readActiveBuilt, toPrecondition, addProduct: addProductIo }, body, rq('POST', opts.headers && opts.headers.Authorization));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => clone(r.body) };
  };
  return { read: read.body, fetch, calls };
}
const save = (B, rid, draft) => { globalThis.fetch = B.fetch; return editCatalog({ rid, source: draftSource(draft), baseSourceUpdateTime: B.read.sourceUpdateTime, token: async () => 't' }); };
const groupMembers = (src, launcherKey) => {
  const l = src.items.find((i) => i.key === launcherKey);
  return src.structure.variant_items[String(l.display.id)].variantIds.map((id) => src.items.find((i) => String(i.display.id) === String(id) || i.ref === id));
};
const marked = (src, launcherKey) => groupMembers(src, launcherKey).filter((m) => Array.isArray(m.display.tags) && m.display.tags.includes('recommended')).map((m) => m.key || m.ref);

const LM = await backend('la_musa');
const PAD = 'noodle_01';

test('the byte copy: xpizza-portal/choice-transitions.js IS the server\'s writer, loaded by index.html right after exposure-transitions.js', () => {
  const copy = readFileSync(new URL('./choice-transitions.js', import.meta.url));
  const src = readFileSync(new URL('../xpizza-functions/catalog/choice-transitions.js', import.meta.url));
  assert.ok(copy.equals(src), 'byte-identical (tools/sync-client)');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const x = html.indexOf('<script src="exposure-transitions.js"></script>'), c = html.indexOf('<script src="choice-transitions.js"></script>');
  assert.ok(x !== -1 && c > x, 'the choice writer loads after the Extras writer (the S2 order)');
  assert.equal(typeof globalThis.ChoiceTransitions.apply, 'function');
});

test('the switch the portal reads: the REAL getEditableCatalog always states choiceEdit as a boolean — false today, true only with the server\'s switch on', async () => {
  assert.equal(LM.read.choiceEdit, false, 'stated, and OFF (the platform switch ships OFF)');
  CE.on = true;
  try { assert.equal((await backend('la_musa')).read.choiceEdit, true, '🔴 the read follows the server\'s switch'); } finally { CE.on = false; }
  assert.equal((await backend('x_pizza')).read.choiceEdit, false, 'every brand, the same platform switch');
});

test('OFF: applyChoiceOps refuses without the server\'s switch (absent, false, a truthy non-boolean) and on a draft not owned for editing — the draft untouched', () => {
  const d = createDraft(clone(LM.read.source)); const before = JSON.stringify(draftSource(d));
  const op = { op: 'choice.label', launcher: PAD, label: 'Proteína' };
  for (const opts of [undefined, {}, { choiceEdit: false }, { choiceEdit: 'true' }, { choiceEdit: 1 }]) {
    assert.deepEqual(applyChoiceOps(d, [op], opts), { ok: false, code: 'choice_edit_off' }, `OFF for ${JSON.stringify(opts)}`);
    assert.equal(JSON.stringify(draftSource(d)), before, 'nothing written');
  }
  const ro = createDraft(clone(LM.read.source), { canEdit: () => false });
  assert.equal(applyChoiceOps(ro, [op], ON).code, 'not_editable');
  assert.equal(applyChoiceOps(d, [], ON).code, 'unknown_op');
  assert.equal(JSON.stringify(draftSource(d)), before);
});

test('OFF at the save: today\'s edit still saves (200) through the real judgment, and a refused choice op sends NOTHING', async () => {
  CE.on = false;
  const B = await backend('la_musa');
  const d = createDraft(clone(B.read.source));
  assert.equal(applyChoiceOps(d, [{ op: 'choice.label', launcher: PAD, label: 'Proteína' }]).ok, false);
  assert.equal(B.calls.length, 0, 'no request');
  setItemPrice(d, 'dimsum_01', '255');
  const r = await save(B, 'la_musa', d);
  assert.ok(r && r.ok !== false, 'today\'s price edit saves');
  assert.equal(B.calls.length, 1);
});

test('ON: every op through applyChoiceOps writes exactly what the SERVER\'s writer writes; removals carry their identity stamps in deleted_ids', () => {
  const src = clone(LM.read.source);
  const ops = [
    { op: 'choice.label', launcher: PAD, label: 'Proteína' },
    { op: 'choice.recommended', launcher: PAD, option: groupMembers(src, PAD)[0].key },
    { op: 'option.rename', key: groupMembers(src, PAD)[1].key, choice: 'Pollo al wok' },
    { op: 'option.add', launcher: PAD, ref: ref('n'), choice: 'Tofu', price: 330 },
    { op: 'option.remove', key: groupMembers(src, PAD)[2].key },
    { op: 'choice.add', key: 'dimsum_02', label: 'Porción', options: [{ ref: ref('p'), choice: 'Media' }, { ref: ref('q'), choice: 'Entera', price: 400 }] },
    { op: 'choice.remove', launcher: PAD, price_from: groupMembers(src, PAD)[0].key },
  ];
  let expect = src; const ids = [];
  const d = createDraft(clone(src));
  for (const op of ops) {
    const r = SERVER_CT.apply(expect, op); expect = r.source; ids.push(...r.deletedIds);
    assert.deepEqual(applyChoiceOps(d, [op], ON), { ok: true }, op.op);
    const got = clone(draftSource(d)); const claim = got.deleted_ids; delete got.deleted_ids;
    const want = clone(expect); delete want.deleted_ids;
    assert.deepEqual(got, want, `🔴 ${op.op}: the draft is the server writer's output`);
    if (ids.length) assert.deepEqual(claim, [...new Set(ids)].sort(), `${op.op}: the claim = the writer's deletedIds`);
  }
  assert.ok(ids.length >= 2, 'premise: the stamped options left with their stamps');
});

test('a list is ATOMIC: one refused op leaves the draft untouched, with the writer\'s own code', () => {
  const d = createDraft(clone(LM.read.source)); const before = JSON.stringify(draftSource(d));
  const m = groupMembers(draftSource(d), PAD);
  assert.equal(m.length, 3, 'premise: the live group has three options');
  const r = applyChoiceOps(d, [{ op: 'choice.label', launcher: PAD, label: 'Proteína' }, { op: 'option.remove', key: m[0].key }, { op: 'option.remove', key: m[1].key }], ON);
  assert.equal(r.ok, false); assert.equal(r.code, 'choices_too_few');
  assert.equal(JSON.stringify(draftSource(d)), before);
});

test('«Recomendada» is ONE op: a live group starts with no mark; exactly one marked after each choice, the siblings cleared', () => {
  const d = createDraft(clone(LM.read.source));
  const [a, b] = groupMembers(draftSource(d), PAD).map((x) => x.key);
  assert.deepEqual(marked(draftSource(d), PAD), [], 'premise: live groups carry no mark (S3 §2)');
  applyChoiceOps(d, [{ op: 'choice.recommended', launcher: PAD, option: a }], ON);
  assert.deepEqual(marked(draftSource(d), PAD), [a]);
  applyChoiceOps(d, [{ op: 'choice.recommended', launcher: PAD, option: b }], ON);
  assert.deepEqual(marked(draftSource(d), PAD), [b], '🔴 exactly one mark, the siblings cleared');
});

test('the real save judges the marks: one op → 200; two marks written per option (the old toggle\'s way) → choice_recommended_many', async () => {
  CE.on = true;
  try {
    const B = await backend('la_musa');
    const d = createDraft(clone(B.read.source));
    const [a, b] = groupMembers(draftSource(d), PAD).map((x) => x.key);
    applyChoiceOps(d, [{ op: 'choice.label', launcher: PAD, label: 'Proteína' }, { op: 'choice.recommended', launcher: PAD, option: a }], ON);
    assert.ok(await save(B, 'la_musa', d), 'one mark: saved');
    const B2 = await backend('la_musa');
    const s = clone(B2.read.source);
    for (const m of groupMembers(s, PAD)) m.display.tags = ['recommended'];
    s.structure.variant_items[String(s.items.find((i) => i.key === PAD).display.id)].label = 'Proteína';
    await assert.rejects(save(B2, 'la_musa', createDraft(s)), (e) => e instanceof ApiError && e.code === 'choice_recommended_many');
    assert.ok(a && b);
  } finally { CE.on = false; }
});

test('the reward dish: «Agregar elección» on a LIVE redeemable dish → the REAL save refuses choice_on_reward_dish → the owner\'s line, verbatim', async () => {
  CE.on = true;
  try {
    const B = await backend('la_musa');
    const d = createDraft(clone(B.read.source));
    const r = applyChoiceOps(d, [{ op: 'choice.add', key: 'dimsum_01', label: 'Porción', options: [{ ref: ref('a'), choice: 'Media' }, { ref: ref('b'), choice: 'Entera', price: 400 }] }], ON);
    assert.equal(r.ok, true, 'the writer itself allows it (the rule is the server\'s, on the resulting draft)');
    let err = null;
    try { await save(B, 'la_musa', d); } catch (e) { err = e; }
    assert.ok(err instanceof ApiError, 'refused'); assert.equal(err.status, 409); assert.equal(err.code, 'choice_on_reward_dish');
    assert.equal(choiceRefusalLine(err.code), OWNER_LINE, '🔴 the owner\'s line, verbatim');
  } finally { CE.on = false; }
});

// the «Agregar producto» drawer (1D add-product B): a new sized dish in a reward category; `mark` = its «Recomendada» pill tapped
function newSizedDish(B, mark) {
  const d = createDraft(clone(B.read.source));
  const id = ref('z');
  addProduct(d, { ref: id, cat: 'dim_sum' });
  setAddition(d, id, 'name', 'Wonton especial'); setAddition(d, id, 'price', '300');
  const [o1, o2] = [ref('x'), ref('y')];
  setRequiredChoice(d, id, true, [o1, o2]);
  setGroupLabel(d, id, 'Porción');
  setChoiceName(d, o1, 'Media'); setChoiceName(d, o2, 'Entera');
  setChoicePrice(d, o1, '300'); setChoicePrice(d, o2, '450');
  if (mark) setChoiceRecommended(d, o1, true);
  return d;
}
// FLIP-TIME FINDING (S3 UI build, for the advisor): with choiceEdit ON the server requires exactly one «Recomendada» on EVERY new group (S3
// §2: a new group is TOUCHED), and the new-product drawer offers the pill but never requires it — an unmarked new sized dish saves with
// the switch OFF and is refused with it ON. The drawing half must close this before the flip; this cell pins both sides.
test('FLIP-TIME: an unmarked new sized dish saves with choiceEdit OFF (today) and is refused choice_recommended_required with it ON', async () => {
  const off = await backend('la_musa');
  assert.ok(await save(off, 'la_musa', newSizedDish(off, false)), 'OFF: today, saved');
  CE.on = true;
  try {
    const on = await backend('la_musa');
    await assert.rejects(save(on, 'la_musa', newSizedDish(on, false)), (e) => e instanceof ApiError && e.code === 'choice_recommended_required');
  } finally { CE.on = false; }
});
test('a BRAND-NEW sized dish (marked) in the same reward category is accepted by the real save (only existing dishes are protected)', async () => {
  CE.on = true;
  try {
    const B = await backend('la_musa');
    const d = newSizedDish(B, true);
    const res = await save(B, 'la_musa', d).catch((e) => assert.fail(`refused: ${e.status} ${JSON.stringify(e.body)}`));
    assert.ok(res, 'saved');
    assert.equal(B.calls.length, 1);
  } finally { CE.on = false; }
});

test('choiceRefusalLine: the owner-approved line for choice_on_reward_dish ONLY; every other code has no approved copy yet (null)', () => {
  assert.equal(choiceRefusalLine('choice_on_reward_dish'), OWNER_LINE);
  for (const c of ['choices_too_few', 'option_name_too_long', 'choice_duplicate', 'choice_label_required', 'choice_recommended_required', 'choice_recommended_many',
    'choice_price_from_invalid', 'choice_index_invalid', 'name_needs_new_id', 'choice_groups_would_vanish', undefined, null, '']) assert.equal(choiceRefusalLine(c), null, String(c));
});

test('x_pizza (name keys): «Agregar elección» on a plain dish and its first option takes the dish\'s price and the mark — through the portal\'s copy', () => {
  const src = canonicalize(buildSourceFromCode('x_pizza'));
  const vi = (src.structure && src.structure.variant_items) || {};
  const dish = src.items.find((i) => i.display && i.display.variantOf == null && !vi[String(i.display.id)] && Number.isInteger(i.price));
  const d = createDraft(clone(src));
  assert.equal(applyChoiceOps(d, [{ op: 'choice.add', key: dish.key, label: 'Tamaño', options: [{ ref: ref('m'), choice: 'Mediana' }, { ref: ref('g'), choice: 'Grande', price: dish.price + 100 }] }], ON).ok, true);
  const out = draftSource(d);
  const first = out.items.find((i) => i.ref === ref('m'));
  assert.equal(first.price, dish.price); assert.deepEqual(first.display.tags, ['recommended']);
  assert.deepEqual(out, SERVER_CT.apply(src, { op: 'choice.add', key: dish.key, label: 'Tamaño', options: [{ ref: ref('m'), choice: 'Mediana' }, { ref: ref('g'), choice: 'Grande', price: dish.price + 100 }] }).source);
});
