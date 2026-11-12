'use strict';
// S2 switch-OFF proof (S2-DESIGN §1.0; Codex S2 code r1 P2-6) — with item_text_edit OFF, the save, the publish and the editor read
// answer EXACTLY as the base (S1d) did: every body byte-compared against a golden CAPTURED by running these same scenarios on the
// S1d handlers (`node catalog/s2-off-golden.test.js --capture <S1d xpizza-functions dir>`), the volatile token aside; the editor
// read differs by the ONE declared additive field, textEditEnabled:false. One scenario turns the per-product EXTRAS authoring
// switch on and toggles a product's extras policy, so the consequences gate at either diff site is exercised OFF.
// Run: node catalog/s2-off-golden.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const capIdx = process.argv.indexOf('--capture');
const FN = capIdx > 0 ? path.resolve(process.argv[capIdx + 1]) : path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 's2-off.golden.json');
const R = (rel) => path.join(FN, rel);
const EXTRAS = { authoring: false };
const swap = (rel, exportsOf) => { const p = require.resolve(R(rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsOf(require(p)) }; };
swap('catalog/item-text-edit', () => ({ textEditCapabilities: () => ({ enabled: false }) }));
{ const p = require.resolve(R('catalog/platform-extras')); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, extrasCapabilities: () => ({ ...real.extrasCapabilities(), authoring: EXTRAS.authoring }) } }; }
const { editCatalogCore } = require(R('catalog/edit-catalog-handler'));
const { publishEditedCore } = require(R('catalog/publish-edited-handler'));
const { getEditableCatalogCore } = require(R('catalog/portal-reads'));
const { NO_STAMP } = require('../test/_no-stamp');   // asm5 (codex P2): F-1's fail-closed stamp read — fsdb: {} no longer means "no stamp"
const { buildSourceFromCode } = require(R('tools/seed-source-store'));
const T0 = '2026-11-08T10:00:00.000000Z';
const T1 = '2026-11-08T11:00:00.000000Z';
const clone = (o) => JSON.parse(JSON.stringify(o));
function stub(rid, sourceDoc, liveSource = null, { docs: extra = {}, race = {} } = {}) {
  const SRC = `restaurants/${rid}/meta/source`;
  const docs = new Map([[SRC, { data: clone(sourceDoc), updateTime: T0 }], [`restaurants/${rid}/meta/active_version`, { data: { version: 'v-live' }, updateTime: T0 }]]);
  for (const [p, d] of Object.entries(extra)) docs.set(p, { data: clone(d), updateTime: T0 });
  const state = { docs, writes: [], get source() { return docs.get(SRC); } };
  const live = liveSource || buildSourceFromCode(rid);   // the published version (a renamed one where a cell says so)
  const fail = (code, m) => { const e = new Error(m); e.code = code; return e; };
  let seq = 0;
  const commit = async (ops) => {
    for (const op of ops) {
      const cur = docs.get(op.path);
      if (op.kind === 'create') { if (cur) throw fail(6, `ALREADY_EXISTS ${op.path}`); continue; }
      if (!cur) throw fail(5, `NOT_FOUND ${op.path}`);
      if (op.path === SRC && !(op.pre && op.pre.lastUpdateTime !== undefined)) throw fail(9, 'FAILED_PRECONDITION: an unconditional draft write');
      if (op.pre && op.pre.lastUpdateTime !== undefined && op.pre.lastUpdateTime !== cur.updateTime) throw fail(9, `FAILED_PRECONDITION ${op.path}`);
    }
    const rev = T1.replace(/0{6}Z$/, `${String(seq++).padStart(6, '0')}Z`);   // a FRESH revision per commit, shared by its writes (first = T1)
    for (const op of ops) {
      const cur = docs.get(op.path);
      docs.set(op.path, { data: op.kind === 'create' ? clone(op.data) : { ...cur.data, ...clone(op.data) }, updateTime: rev });
      state.writes.push(op.path);
    }
    return ops.map(() => ({ writeTime: rev }));
  };
  const doc = (path) => ({
    path,
    get: async () => {
      const d = docs.get(path);
      const snap = d ? { exists: true, data: () => clone(d.data), updateTime: d.updateTime } : { exists: false, data: () => undefined, updateTime: undefined };
      if (race[path]) { const r = race[path]; delete race[path]; r(docs); }
      return snap;
    },
    update: async (data, pre) => (await commit([{ kind: 'update', path, data, pre }]))[0],
    create: async (data) => (await commit([{ kind: 'create', path, data }]))[0],
  });
  return {
    state,
    readActiveBuilt: async () => {
      const inputs = require(R('catalog/source-store')).sourceToBuildInputs(live);
      const built = require(R('catalog/form-menu-source')).buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable, keyMode: inputs.keyMode });
      return { built: { ...built, extras: inputs.extras }, versionId: 'v-live', extraRecords: built.extras };
    },
    doc,
    collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }) }) }),
    batch: () => { const ops = []; return { update: (ref, data, pre) => { ops.push({ kind: 'update', path: ref.path, data, pre }); }, create: (ref, data) => { ops.push({ kind: 'create', path: ref.path, data }); }, commit: () => commit(ops) }; },
  };
}
const allow = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const io = (mode) => ({ readKeyMode: async () => mode, hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }),
  registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => new Map() });
const save = (db, rid, source) => editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt, addProduct: io(rid === 'la_musa' ? 'id' : 'name') }, { restaurantId: rid, source, baseSourceUpdateTime: T0 }, {});
const publish = (db, rid, saved) => publishEditedCore({ db: {}, authorize: allow, addProduct: io(rid === 'la_musa' ? 'id' : 'name'), readActiveBuilt: db.readActiveBuilt,
  readDraft: async () => ({ source: db.state.source.data, updateTime: saved.body.updateTime }), publishVersion: async () => ({ versionId: 'v-new', item_count: 0, extra_count: 0 }) },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: ((saved.body.diff || {}).largeChangeSet || []).map((l) => ({ key: l.key, surface: l.surface })), fiscalAck: true }, {});
const strip = (r) => { const b = clone(r.body); delete b.token; return { status: r.status, body: b }; };
const itemOf = (s, key) => s.items.find((i) => i.key === key);

(async () => {
  const XP = buildSourceFromCode('x_pizza'); const LM = buildSourceFromCode('la_musa');
  const out = {};
  const run = async (name, rid, seed, mutate, { pub = false } = {}) => {
    const db = stub(rid, seed); const d = clone(seed); mutate(d);
    const s = await save(db, rid, d); out[`${name}:save`] = strip(s);
    if (pub && s.status === 200) out[`${name}:publish`] = strip(await publish(db, rid, s));
  };
  await run('price-only', 'x_pizza', XP, (d) => { itemOf(d, 'Carnivora').price += 5; itemOf(d, 'Carnivora').display.price += 5; }, { pub: true });
  await run('rename', 'x_pizza', XP, (d) => { itemOf(d, 'Carnivora').display.name = 'Carnívora Suprema'; });
  await run('quote-name', 'x_pizza', XP, (d) => { itemOf(d, 'Carnivora').display.name = "Carnivora's"; });
  await run('desc', 'x_pizza', XP, (d) => { itemOf(d, 'Carnivora').display.desc = 'Nueva descripción'; });
  await run('move', 'la_musa', LM, (d) => { const b = itemOf(d, 'beer_01'); b.display.cat = 'dim_sum'; delete b.display.subcat; });
  await run('group-rename', 'la_musa', LM, (d) => { itemOf(d, 'noodle_01').display.name = 'Pad Thai Nuevo'; });
  EXTRAS.authoring = true;   // the per-product extras switch ON: an extras-policy toggle saves and publishes (eligibility changes)
  await run('extras-policy', 'x_pizza', XP, (d) => { itemOf(d, 'Carnivora').display.extras_policy = 'none'; }, { pub: true });
  EXTRAS.authoring = false;
  const ed = await getEditableCatalogCore({ db: {}, fsdb: NO_STAMP, authorize: allow, readActiveVersionId: async () => 'v-live',
    _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => clone(XP), updateTime: { seconds: 1788754374, nanoseconds: 634000000 } }) }),
    readActiveBuilt: stub('x_pizza', XP).readActiveBuilt }, { method: 'GET', query: { restaurantId: 'x_pizza' }, get: () => 'Bearer tok' });
  out['editor-read'] = { status: ed.status, body: ed.body };

  if (capIdx > 0) { fs.writeFileSync(GOLDEN, `${JSON.stringify({ _captured_from: FN, scenarios: out }, null, 1)}\n`); console.log(`captured ${Object.keys(out).length} scenarios from ${FN}`); return; }
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).scenarios;
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(g).sort(), 'S2OFF premise: the same scenarios');
  for (const k of Object.keys(g)) {
    if (k === 'editor-read') {
      assert.strictEqual(out[k].body.textEditEnabled, false, 'S2OFF-READ textEditEnabled:false is present');
      assert.strictEqual(out[k].body.extrasAuthoring, false, 'S2OFF-READ S1 extrasAuthoring:false is present (switch off)');
      assert.strictEqual(out[k].body.extrasCatalog, false, 'S2OFF-READ extrasCatalog:false is present (S2-core: the Extras-page switch, fail-closed)');
      const { textEditEnabled: _t, extrasAuthoring: _a, extrasCatalog: _x, deletionBase: _b, deletionClaim: _c, ...rest } = out[k].body;   // eslint-disable-line no-unused-vars
      assert.deepStrictEqual(_c, { ids: [] }, 'S2OFF-READ deletionClaim is the normalized empty claim');
      assert.deepStrictEqual({ status: out[k].status, body: rest }, g[k], 'S2OFF-READ the editor read is the base\'s, plus ONLY textEditEnabled:false, S1 extrasAuthoring:false, extrasCatalog:false and the S2 deletion fields');
    } else if (k === 'extras-policy:save' || k === 'extras-policy:publish') {
      // S2-core §1.6 (PLAN-structure-S2core-r3): the ONE canonical review diff folds the extras consequences UNGATED — item_text_edit OFF
      // too (prod runs it ON, where this was already the answer) — so this save's (and its publish's) diff gains them: the ONE declared delta, and it is
      // exactly the REAL evaluator's answer over the live and the draft records
      const { consequences, ...diffRest } = out[k].body.diff;
      const { buildSourceCandidate } = require(R('catalog/candidate-validate'));
      const d = clone(XP); itemOf(d, 'Carnivora').display.extras_policy = 'none';
      const want = require(R('catalog/extras-consequences')).extrasConsequences({ live: buildSourceCandidate('x_pizza', XP).built, draft: buildSourceCandidate('x_pizza', d).built });
      assert.ok(want.length && consequences, `S2OFF-${k} premise: the toggle has a consequence`);
      assert.deepStrictEqual(consequences, want, `S2OFF-${k} the declared delta is the real consequences`);
      assert.deepStrictEqual({ ...out[k], body: { ...out[k].body, diff: diffRest } }, g[k], `S2OFF-${k} otherwise byte-identical to the base`);
    } else {
      assert.deepStrictEqual(out[k], g[k], `S2OFF-${k} switch OFF answers byte-identically to the base`);
    }
  }
  console.log(`  ✓ 1 switch OFF: ${Object.keys(g).length} save / publish / read scenarios byte-identical to the base (S1d), textEditEnabled the one additive field`);
  console.log('\ns2-off-golden: OK (1)');
})().catch((e) => { console.error(e); process.exit(1); });
