'use strict';
// S3 (PLAN-structure-S3-r3 §0, §1a, §2) — the required choice on an EXISTING dish through the REAL editCatalogCore, the choiceEdit
// switch stubbed (shipped OFF). Drafts are written by the REAL writer (choice-transitions) over the REAL sources; the save allocates
// the new options' keys itself. OFF: today's refusals. ON: D2 / option.add / an option rename / D3 save; a reward dish refuses.
// Run: node catalog/s3-flow.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const STRUCT = { choiceEdit: false };
const TEXT = { enabled: true };   // the S1 text switch (ON in production); the x_pizza rename cell turns it OFF: S3 records renames on its own
{ const p = require.resolve('./item-text-edit'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { textEditCapabilities: () => ({ enabled: TEXT.enabled }) } }; }
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: false }) } }; }
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const CT = require('./choice-transitions');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s3-flow: FAILED — exited without completing'); process.exitCode = 1; } });

const T0 = '2026-10-24T10:00:00.000000Z';
const T1 = '2026-10-24T11:00:00.000000Z';
const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const clone = (x) => JSON.parse(JSON.stringify(x));
// certified rows (identity stamps) in the live AND the stored draft, so a removal can be declared
const base = (rid) => { const s = clone(buildSourceFromCode(rid)); for (const it of s.items) it.display.identity_id = `id_${String(it.key).replace(/[^A-Za-z0-9]/g, '_')}`; return s; };
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = (rid, liveSrc = null) => async () => {
  const src = liveSrc ? clone(liveSrc) : base(rid); const i = sourceToBuildInputs(src);
  return { built: builtOf(src, rid), versionId: ACTIVE, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras };
};
function saveDb(rid, liveSrc = null) {
  const state = { source: { data: liveSrc ? clone(liveSrc) : base(rid), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE, generation: 0 }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => {
      if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; }
      state.source = { data, updateTime: T1 }; return { writeTime: T1 };
    },
  });
  // a new option moves the display-id high-water mark: the save commits the draft and the mark in ONE batch (each conditional)
  const batch = () => { const ops = []; return { update: (r, data, pre) => ops.push(() => r.update(data, pre)), create: (r, data) => ops.push(async () => { state.hwm = data; }), commit: async () => { const out = []; for (const op of ops) out.push(await op()); return out; } }; };
  return { state, batch, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const addProductOf = (rid) => ({ readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }), set: async () => {} }), registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => require('./reserved-keys').reservedKeySet(undefined) });
const save = (rid, source, deletedIds, liveSrc = null) => {
  const db = saveDb(rid, liveSrc);
  const src = deletedIds ? { ...source, deleted_ids: { ids: deletedIds } } : source;
  return editCatalogCore({ db, authorize: owner, readActiveBuilt: liveRead(rid, liveSrc), addProduct: addProductOf(rid) }, { restaurantId: rid, source: src, baseSourceUpdateTime: T0, ...(deletedIds ? { deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } } : {}) }, {}).then((r) => ({ r, db }));
};
const apply = (src, op) => CT.apply(src, op).source;
// the owner publish (s2core-flow.test.js's harness): the stored draft, today's live, a captured publishVersion
const publishDeps = (rid, draft) => {
  const state = { publishes: [] };
  return { state, deps: { db: {}, authorize: owner, readActiveBuilt: liveRead(rid), addProduct: addProductOf(rid),
    readDraft: async () => ({ source: draft, updateTime: T1 }),
    publishVersion: async (_db, r, input, opts) => { state.publishes.push({ r, input, opts }); return { versionId: 'v-new-2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } } };
};
const publishBody = (rid, r) => ({ restaurantId: rid, token: r.body.token, acknowledgedChanges: r.body.diff.largeChangeSet, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) });
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;

(async () => {
  const XP = base('x_pizza'); const LM = base('la_musa');
  const PAD = 'noodle_01';
  const padOpts = LM.structure.variant_items[PAD].variantIds.map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
  const nonReward = XP.structure.categories.map((c) => c.id).find((c) => !(XP.structure.redeem_eligible_cats || []).includes(c) && XP.items.some((i) => i.display.cat === c));
  const plain = XP.items.find((i) => i.display.cat === nonReward && i.display.variantOf == null).key;
  const reward = XP.items.find((i) => i.display.cat === 'individual' && i.display.variantOf == null).key;
  const D2 = (key) => ({ op: 'choice.add', key, label: 'Tamaño', options: [{ ref: 'tmp:s3f-a-xxxxxx', choice: 'Personal' }, { ref: 'tmp:s3f-b-xxxxxx', choice: 'Grande', price: 999 }] });

  // OFF: today
  {
    const { r } = await save('x_pizza', apply(XP, D2(plain)));
    assert.deepStrictEqual([r.status, r.body.error], [400, 'choices_not_supported_yet'], `S3F-OFF: ${show(r)}`);
    ok('OFF: a plain dish gaining a group is today\'s refusal');
  }
  STRUCT.choiceEdit = true;
  {
    const { r, db } = await save('x_pizza', apply(XP, D2(plain)));
    assert.strictEqual(r.status, 200, `S3F-D2: ${show(r)}`);
    const saved = db.state.source.data;
    const dish = saved.items.find((i) => i.key === plain);
    const ids = saved.structure.variant_items[String(dish.display.id)].variantIds;
    const opts = ids.map((id) => saved.items.find((i) => String(i.display.id) === String(id)));
    assert.deepStrictEqual(opts.map((o) => [o.key, o.display.name, o.display.cat]), [[`${dish.display.name} - Personal`, `${dish.display.name} - Personal`, dish.display.cat], [`${dish.display.name} - Grande`, `${dish.display.name} - Grande`, dish.display.cat]], 'S3F-D2: keys allocated (name mode), names derived');
    assert.ok(!opts.some((o) => o.ref), 'no tmp ref survives');
    ok('ON: a plain non-reward dish gains a group — the options get their keys and derived names on save');
  }
  {
    const { r } = await save('x_pizza', apply(XP, D2(reward)));
    assert.deepStrictEqual([r.status, r.body.error, r.body.key], [409, 'choice_on_reward_dish', reward], `S3F-REWARD: ${show(r)}`);
    ok('ON: a reward dish gaining a group is choice_on_reward_dish (409, its key)');
  }
  {
    const d = apply(apply(LM, { op: 'option.add', launcher: PAD, ref: 'tmp:s3f-tofu-xxxx', choice: 'Tofu', price: 330 }), { op: 'choice.recommended', launcher: PAD, option: padOpts[0] });
    const { r, db } = await save('la_musa', d);
    assert.strictEqual(r.status, 200, `S3F-ADD: ${show(r)}`);
    const tofu = db.state.source.data.items.find((i) => i.display.choice === 'Tofu');
    assert.ok(tofu && tofu.key && !tofu.ref && db.state.source.data.structure.variant_items[PAD].variantIds.includes(tofu.display.id), 'S3F-ADD: allocated and listed by the group');
    ok('ON: an option added under an existing dish saves with its allocated key, listed by its group');
  }
  {
    const d = apply(apply(LM, { op: 'option.rename', key: padOpts[1], choice: 'Pollo al Wok' }), { op: 'choice.recommended', launcher: PAD, option: padOpts[1] });
    const { r, db } = await save('la_musa', d);
    assert.strictEqual(r.status, 200, `S3F-RENAME: ${show(r)}`);
    const o = db.state.source.data.items.find((i) => i.key === padOpts[1]);
    assert.deepStrictEqual([o.display.choice, o.display.name], ['Pollo al Wok', `${LM.items.find((i) => i.key === PAD).display.name} - Pollo al Wok`]);
    ok('ON: an option rename saves under its kept key, its full name derived');
  }
  {
    const d = apply(LM, { op: 'choice.remove', launcher: PAD, price_from: padOpts[1] });
    const ids = padOpts.map((k) => LM.items.find((i) => i.key === k).display.identity_id);
    const { r, db } = await save('la_musa', d, ids);
    assert.strictEqual(r.status, 200, `S3F-D3: ${show(r)}`);
    assert.ok(!db.state.source.data.items.some((i) => padOpts.includes(i.key)), 'S3F-D3: the options left');
    ok('ON: a group removed with its declared options saves; the dish is plain at the chosen option\'s price');
  }
  {   // x_pizza (name mode): an option rename keeps its key — the composed old name — RECORDED as a frozen key by the save
    const { r: r1, db: d1 } = await save('x_pizza', apply(XP, D2(plain)));
    assert.strictEqual(r1.status, 200, `S3F-RENAME-XP premise: ${show(r1)}`);
    const live = d1.state.source.data;
    const dish = live.items.find((i) => i.key === plain);
    const optKey = live.structure.variant_items[String(dish.display.id)].variantIds.map((id) => live.items.find((i) => String(i.display.id) === String(id)).key)[0];
    const d = apply(apply(live, { op: 'option.rename', key: optKey, choice: 'Mediana' }), { op: 'choice.recommended', launcher: plain, option: optKey });
    TEXT.enabled = false;   // S3 alone (the S1 text switch off) still re-derives the name and records the kept key
    const { r, db } = await save('x_pizza', d, null, live);
    TEXT.enabled = true;
    assert.strictEqual(r.status, 200, `S3F-RENAME-XP: ${show(r)}`);
    const saved = db.state.source.data;
    const o = saved.items.find((i) => i.key === optKey);
    assert.ok(o && o.display.name === `${dish.display.name} - Mediana`, 'S3F-RENAME-XP: the option keeps its key under its new name');
    assert.ok(Object.values(saved.frozen_keys || {}).includes(optKey), `S3F-RENAME-XP: the kept key is recorded (${JSON.stringify(saved.frozen_keys)})`);
    ok('ON: an x_pizza option rename keeps its name-mode key, recorded as a frozen key by the save — with the S1 text switch OFF too');
  }
  {   // the owner PUBLISH re-judges: a D2 saved ON publishes ON (the version carries the group); saved ON, published OFF → refused
    const { r, db } = await save('x_pizza', apply(XP, D2(plain)));
    assert.strictEqual(r.status, 200, `S3F-PUBLISH premise: ${show(r)}`);
    const stored = db.state.source.data;
    const p = publishDeps('x_pizza', stored);
    const pub = await publishEditedCore(p.deps, publishBody('x_pizza', r), {});
    assert.strictEqual(pub.status, 200, `S3F-PUBLISH: ${show(pub)}`);
    const dish = p.state.publishes[0].input.items.find((i) => i.key === plain);
    assert.ok(p.state.publishes[0].input.structure.variant_items[String(dish.display.id)], 'S3F-PUBLISH: the published version carries the group');
    STRUCT.choiceEdit = false;
    const p2 = publishDeps('x_pizza', stored);
    const off = await publishEditedCore(p2.deps, publishBody('x_pizza', r), {});
    STRUCT.choiceEdit = true;
    assert.ok(off.status >= 400 && p2.state.publishes.length === 0, `S3F-PUBLISH-OFF: refused, nothing published (${show(off)})`);
    ok('ON: the owner publish re-judges the draft — published ON with its group; saved ON, published OFF is refused, nothing written');
  }
  {   // the owner PUBLISH refuses a reward-dish D2 on its own (Codex build r1 P2-4): a stored draft carrying it, a token over its canonical diff
    const AP = require('./add-product'); const CC = require('./choice-compare');
    const { buildSourceCandidate } = require('./candidate-validate');
    const { issueEditToken, sha256 } = require('./catalog-edit');
    const stored = AP.allocateAdditions({ incoming: apply(XP, D2(reward)), stored: XP, activeItems: XP.items, keyMode: 'name', hwm: null, registryHasKey: () => false, authoring: true, prepareExisting: CC.prepareExistingGroups }).source;
    const L = await liveRead('x_pizza')(); const { inputs: i, built: b } = buildSourceCandidate('x_pizza', stored);
    const diff = require('./review-diff').reviewDiff({ live: L.built, liveExtraRecords: L.extraRecords, draftBuilt: { ...b, extras: i.extras }, draftExtraRecords: b.extras, extrasCatalog: false });
    const token = issueEditToken({ rid: 'x_pizza', baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(stored), diff });
    const p = publishDeps('x_pizza', stored);
    const pub = await publishEditedCore(p.deps, { restaurantId: 'x_pizza', token, acknowledgedChanges: diff.largeChangeSet, fiscalAck: true }, {});
    assert.deepStrictEqual([pub.status, pub.body.error, pub.body.key, p.state.publishes.length], [409, 'choice_on_reward_dish', reward, 0], `S3F-PUBLISH-REWARD: refused, nothing published (${show(pub)})`);
    ok('ON: the owner publish refuses a reward-dish D2 on its own (409, its key), nothing published');
  }
  {   // the MANAGER REQUEST's judgment (structure-gate, compare on): the same classifier through the same wrapper
    const SG = require('./structure-gate');
    const { buildSourceCandidate } = require('./candidate-validate');
    const live = (await liveRead('x_pizza')()); const draftOf = (src) => { const { built } = buildSourceCandidate('x_pizza', src); return { items: built.items, extras: built.extras, structure: built.structure }; };
    const judge = (src) => SG.judge({ rid: 'x_pizza', draft: src, draftRecords: draftOf(src), live: live.built, liveExtraRecords: live.extraRecords, addProduct: addProductOf('x_pizza'), compare: true });
    const settled = async (src) => { const { r, db } = await save('x_pizza', src); assert.strictEqual(r.status === 200 || r.status === 409, true, show(r)); return r.status === 200 ? db.state.source.data : null; };
    const okDraft = await settled(apply(XP, D2(plain)));
    let g; try { g = await judge(okDraft); } catch (e) { assert.fail(`S3F-REQUEST: a non-reward D2 must pass the request judgment (${e.code}: ${String(e.message).slice(0, 100)})`); }
    assert.deepStrictEqual(g, { ok: true }, 'S3F-REQUEST: a non-reward D2 passes the request judgment');
    // a reward-dish D2, allocated the way the save would (the save itself refuses it): hand the request a draft that carries it
    const AP = require('./add-product'); const CC = require('./choice-compare');
    const rewardDraft = AP.allocateAdditions({ incoming: apply(XP, D2(reward)), stored: XP, activeItems: XP.items, keyMode: 'name', hwm: null, registryHasKey: () => false, authoring: true, prepareExisting: CC.prepareExistingGroups }).source;
    await assert.rejects(() => judge(rewardDraft), (e) => e && e.code === 'choice_on_reward_dish' && e.key === reward, 'S3F-REQUEST: the reward-dish D2 is refused by the request judgment');
    ok('ON: the manager request\'s judgment (structure-gate) passes a non-reward D2 and refuses a reward-dish D2 (choice_on_reward_dish)');
  }
  STRUCT.choiceEdit = false;
  FINISHED = true;
  console.log(`s3-flow: OK (${n})`);
})().catch((e) => { console.error('s3-flow FAILED:', e && e.message); process.exit(1); });
