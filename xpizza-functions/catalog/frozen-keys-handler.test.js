'use strict';
// S1a — the REAL editCatalog handler with the item_text_edit switch OFF (today, byte-for-byte) and ON (a rename is recorded under
// its kept key; the map is server-owned; newly authored text is capped; a group renames as one unit). The switch is a platform
// constant, so this file swaps the module's export BEFORE the handler loads it (the handler reads the switch on every save).
// Run: node catalog/frozen-keys-handler.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const SWITCH = { enabled: false };
require.cache[require.resolve('./item-text-edit')] = { id: require.resolve('./item-text-edit'), filename: require.resolve('./item-text-edit'), loaded: true,
  exports: { textEditCapabilities: () => ({ enabled: SWITCH.enabled }) } };
const { editCatalogCore } = require('./edit-catalog-handler');
const { validateSource } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('frozen-keys-handler: FAILED — exited without completing'); process.exitCode = 1; } });

const T0 = '2026-11-08T10:00:00.000000Z';
const T1 = '2026-11-08T11:00:00.000000Z';
const clone = (o) => JSON.parse(JSON.stringify(o));

// A per-document Firestore stub as strict as production (codex S1a r3): every document has its own data and revision; a write
// batch checks EVERY precondition first — update needs the document (NOT_FOUND 5) and, when given, its revision
// (FAILED_PRECONDITION 9); create needs it absent (ALREADY_EXISTS 6) — and then applies all of it or none. Updates merge fields;
// creates persist their data (the id high-water mark included). The draft lives at restaurants/{rid}/meta/source (a draft
// write must be conditional); the live version is built by the production builder from the seeded source. `race` runs once,
// right after a read of the named path — a concurrent writer landing between the handler's read and its commit.
function stub(rid, sourceDoc, liveSource = null, { docs: extra = {}, race = {} } = {}) {
  const SRC = `restaurants/${rid}/meta/source`;
  const docs = new Map([[SRC, { data: clone(sourceDoc), updateTime: T0 }], [`restaurants/${rid}/meta/active_version`, { data: { version: 'v-live' }, updateTime: T0 }]]);
  for (const [p, d] of Object.entries(extra)) docs.set(p, { data: clone(d), updateTime: T0 });
  const state = { docs, writes: [], get source() { return docs.get(SRC); } };
  const live = liveSource || buildSourceFromCode(rid);   // the published version (a renamed one where a cell says so)
  const fail = (code, m) => { const e = new Error(m); e.code = code; return e; };
  const commit = async (ops) => {
    for (const op of ops) {
      const cur = docs.get(op.path);
      if (op.kind === 'create') { if (cur) throw fail(6, `ALREADY_EXISTS ${op.path}`); continue; }
      if (!cur) throw fail(5, `NOT_FOUND ${op.path}`);
      if (op.path === SRC && !(op.pre && op.pre.lastUpdateTime !== undefined)) throw fail(9, 'FAILED_PRECONDITION: an unconditional draft write');
      if (op.pre && op.pre.lastUpdateTime !== undefined && op.pre.lastUpdateTime !== cur.updateTime) throw fail(9, `FAILED_PRECONDITION ${op.path}`);
    }
    for (const op of ops) {
      const cur = docs.get(op.path);
      docs.set(op.path, { data: op.kind === 'create' ? clone(op.data) : { ...cur.data, ...clone(op.data) }, updateTime: T1 });
      state.writes.push(op.path);
    }
    return ops.map(() => ({ writeTime: T1 }));
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
      const inputs = require('./source-store').sourceToBuildInputs(live);
      const built = require('./form-menu-source').buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable, keyMode: inputs.keyMode });
      return { built: { ...built, extras: inputs.extras }, versionId: 'v-live', extraRecords: built.extras };
    },
    doc,
    collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }) }) }),
    batch: () => { const ops = []; return { update: (ref, data, pre) => { ops.push({ kind: 'update', path: ref.path, data, pre }); }, create: (ref, data) => { ops.push({ kind: 'create', path: ref.path, data }); }, commit: () => commit(ops) }; },
  };
}
const allow = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
// the add-product I/O (catalog/add-product-io.js shape): the profile's mode, the id high-water mark, and the identity registry's
// key rows — RETIRED holds the names used before; an unknown key mode throws exactly as production does
const RETIRED = new Set();
const addProductOf = (db, mode) => ({
  readKeyMode: async () => mode,
  hwmRef: (rid) => (db ? db.doc(`restaurants/${rid}/meta/display_id_hwm`) : { path: null, get: async () => ({ exists: false, data: () => undefined }) }),   // the production path (add-product-io hwmRefOf)
  registryKeysTaken: async (_rid, keys, keyMode) => {
    if (keyMode !== 'name' && keyMode !== 'id') throw new Error(`registryKeysTaken: unknown key mode ${JSON.stringify(keyMode)}`);
    return new Set([...new Set(keys)].filter((k) => RETIRED.has(k)));
  },
  syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }),   // production's shape when another publish won
});
const save = (db, rid, source, mode = rid === 'la_musa' ? 'id' : 'name') => editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt, addProduct: addProductOf(db, mode) }, { restaurantId: rid, source, baseSourceUpdateTime: db.state.source.updateTime }, {});
const itemOf = (s, key) => s.items.find((i) => i.key === key);

(async () => {
  const RID = 'x_pizza'; const KEY = 'Carnivora';
  const seed = buildSourceFromCode(RID);
  const renamed = (src, name) => { const s = clone(src); itemOf(s, KEY).display.name = name; return s; };
  const ID = String(itemOf(seed, KEY).display.id);

  // ── OFF: exactly today ──
  {
    SWITCH.enabled = false;
    const db = stub(RID, seed);
    const r = await save(db, RID, renamed(seed, 'Carnívora Suprema'));
    assert.strictEqual(r.status, 400, `HX-OFF a rename is refused as today (${JSON.stringify(r.body).slice(0, 160)})`);
    assert.strictEqual(r.body.error, 'invalid_source');
    assert.match(r.body.detail, /key does not match its display record/);
    assert.strictEqual(db.state.writes.length, 0, 'nothing written');
    const long = clone(seed); itemOf(long, KEY).display.desc = 'd'.repeat(201);
    const r2 = await save(db, RID, long);
    assert.strictEqual(r2.status === 400 && r2.body.error === 'desc_too_long', false, 'HX-OFF caps are not judged with the switch off');
    ok('switch OFF: a rename is refused exactly as today; caps are not judged');
  }

  // ── ON: the rename is recorded under its kept key ──
  let saved;
  {
    SWITCH.enabled = true;
    const db = stub(RID, seed);
    const r = await save(db, RID, renamed(seed, 'Carnívora Suprema'));
    assert.strictEqual(r.status, 200, `HX-ON the rename saves (${JSON.stringify(r.body).slice(0, 200)})`);
    saved = db.state.source.data;
    assert.deepStrictEqual(saved.frozen_keys, { [ID]: KEY }, 'HX-RECORD the stored draft records (display.id → kept key)');
    assert.strictEqual(itemOf(saved, KEY).display.name, 'Carnívora Suprema', 'the key is kept; the name is the new one');
    assert.deepStrictEqual(r.body.source.frozen_keys, { [ID]: KEY }, 'the canonical saved source comes back with the map');
    assert.doesNotThrow(() => validateSource(saved, RID));
    ok('switch ON: a rename saves under its kept key, recorded in the server-owned map');
  }

  // ── the map is server-owned ──
  {
    SWITCH.enabled = true;
    const add = stub(RID, seed);
    const r = await save(add, RID, { ...renamed(seed, 'Carnívora Suprema'), frozen_keys: { [ID]: KEY } });
    assert.deepStrictEqual([r.status, r.body.error], [409, 'frozen_keys_server_owned'], 'HX-OWNED a client cannot add an entry');
    assert.strictEqual(add.state.writes.length, 0);
    const chg = stub(RID, saved);
    const r2 = await save(chg, RID, { ...clone(saved), frozen_keys: { [ID]: 'Pepperoni' } });
    assert.deepStrictEqual([r2.status, r2.body.error], [409, 'frozen_keys_server_owned'], 'HX-OWNED a client cannot change an entry');
    const drop = stub(RID, saved);
    const r3 = await save(drop, RID, { ...clone(saved), frozen_keys: {} });
    assert.deepStrictEqual([r3.status, r3.body.error], [409, 'frozen_keys_server_owned'], 'HX-OWNED a client cannot drop the map');
    ok('the map is server-owned: a client add / change / drop is refused 409 before anything is written');
  }

  // ── the switch OFF later never strands the renamed menu (the rename is PUBLISHED: live = the renamed draft) ──
  {
    SWITCH.enabled = false;
    const db = stub(RID, saved, saved);
    const priced = clone(saved); const other = priced.items.find((i) => i.key !== KEY); other.price += 1; other.display.price = other.price;
    const r = await save(db, RID, priced);
    assert.strictEqual(r.status, 200, `HX-PERMANENT an ordinary edit after the switch goes off still saves (${JSON.stringify(r.body).slice(0, 200)})`);
    assert.deepStrictEqual(db.state.source.data.frozen_keys, { [ID]: KEY }, 'the echoed map is kept');
    const db2 = stub(RID, saved, saved);
    const { frozen_keys: _drop, ...noMap } = clone(saved);   // eslint-disable-line no-unused-vars
    const r2 = await save(db2, RID, noMap);
    assert.strictEqual(r2.status, 200, `HX-KEEP an absent map keeps the stored one (${JSON.stringify(r2.body).slice(0, 160)})`);
    assert.deepStrictEqual(db2.state.source.data.frozen_keys, { [ID]: KEY }, 'HX-KEEP a client that never saw the field cannot drop it');
    ok('switch OFF after a rename: ordinary saves still pass, and the stored map is kept whether echoed or absent');
  }

  // ── ON: caps and duplicate names, judged on newly authored values ──
  {
    SWITCH.enabled = true;
    const db = stub(RID, seed);
    const r = await save(db, RID, renamed(seed, 'N'.repeat(61)));
    assert.deepStrictEqual([r.status, r.body.error, r.body.field, r.body.key], [400, 'name_too_long', 'name', KEY], 'HX-CAP a new name over 60 is refused, field-mapped');
    const other = seed.items.find((i) => i.key !== KEY && i.display.variantOf == null);
    const r2 = await save(db, RID, renamed(seed, other.display.name));
    assert.deepStrictEqual([r2.status, r2.body.error, r2.body.key], [400, 'name_taken', KEY], 'HX-TAKEN a rename onto another product\'s name is refused');
    assert.strictEqual(db.state.writes.length, 0);
    ok('switch ON: a new name over 60 and a rename onto another product are refused before writing');
  }

  // ── ON (codex S1a r1 P1): a renamed label may not take a RESERVED key — a retired frozen entry or a registry key row ──
  {
    SWITCH.enabled = true;
    const withRetired = { ...clone(seed), frozen_keys: { 999: 'Pizza Retirada' } };   // an inert entry: its product was deleted
    const db = stub(RID, withRetired);
    const r = await save(db, RID, renamed(withRetired, 'Pizza Retirada'));
    assert.deepStrictEqual([r.status, r.body.error, r.body.key], [400, 'name_previously_used', KEY], 'HX-RESERVED-FROZEN a rename onto a retired frozen key is refused');
    RETIRED.add('Pizza Vieja');
    const db2 = stub(RID, seed);
    const r2 = await save(db2, RID, renamed(seed, 'Pizza Vieja'));
    assert.deepStrictEqual([r2.status, r2.body.error, r2.body.key], [400, 'name_previously_used', KEY], 'HX-RESERVED-REGISTRY a rename onto a name the registry holds is refused');
    RETIRED.delete('Pizza Vieja');
    assert.strictEqual(db.state.writes.length + db2.state.writes.length, 0, 'nothing written');
    ok('switch ON: a rename onto a retired frozen key or a registry-reserved name is refused before writing');
  }

  // ── ON (codex S1a r2 P1): an ID-keyed rename records no map entry, and is checked against the registry all the same ──
  {
    SWITCH.enabled = true;
    const LM = 'la_musa';
    const lm = buildSourceFromCode(LM);
    RETIRED.add('retired_key');
    const db = stub(LM, lm);
    const d = clone(lm); itemOf(d, 'dimsum_01').display.name = 'retired_key';
    const r = await save(db, LM, d);
    RETIRED.delete('retired_key');
    assert.deepStrictEqual([r.status, r.body.error, r.body.key], [400, 'name_previously_used', 'dimsum_01'], `HX-RESERVED-IDKEY an id-keyed rename onto a registry-reserved key is refused (${JSON.stringify(r.body).slice(0, 160)})`);
    assert.strictEqual(db.state.writes.length, 0, 'nothing written');
    ok('switch ON: an id-keyed rename (no map entry) onto a registry-reserved key is refused before writing');
  }

  // ── ON (codex S1a r2 P2): a NEW product whose freshly allocated key equals its name has no identity to own — the reserved
  //    check applies to it, normalized ──
  {
    SWITCH.enabled = true;
    const withRetired = { ...clone(seed), frozen_keys: { 999: 'Pizza Retirada' } };   // an inert entry: its product was deleted
    const db = stub(RID, withRetired);
    const d = clone(withRetired); const T = 'tmp:newretired01';
    d.items.push({ ref: T, price: 150, display: { name: 'pizza retirada', cat: 'ny', price: 150, desc: '' } }); d.structure.item_order.push(T);
    const r = await save(db, RID, d);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'name_previously_used'], `HX-NEW-RESERVED a new product named as a retired key (normalized) is refused (${JSON.stringify(r.body).slice(0, 160)})`);
    assert.strictEqual(db.state.writes.length, 0, 'nothing written');
    ok('switch ON: a new product whose allocated key would be a retired key is refused (no own-key exemption)');
  }

  // ── an addition commits the draft and the id high-water mark TOGETHER (codex S1a r3): a mark created or moved by another save
  //    between the read and the commit refuses the whole batch — the draft is left exactly as it was ──
  {
    SWITCH.enabled = false;
    const HWM = `restaurants/${RID}/meta/display_id_hwm`;
    const withAddition = () => { const d = clone(seed); const T = 'tmp:hwmrace0001'; d.items.push({ ref: T, price: 150, display: { name: 'Pizza Nueva', cat: 'ny', price: 150, desc: '' } }); d.structure.item_order.push(T); return d; };
    // (a) create conflict: absent at read, created by another save before the commit
    const a = stub(RID, seed, null, { race: { [HWM]: (docs) => docs.set(HWM, { data: { value: 777 }, updateTime: 'racer' }) } });
    const ra = await save(a, RID, withAddition());
    assert.deepStrictEqual([ra.status, ra.body.error], [409, 'stale_edit'], `HX-HWM-CREATE-CONFLICT a mark created concurrently refuses the save (${JSON.stringify(ra.body).slice(0, 160)})`);
    assert.deepStrictEqual([a.state.source.data, a.state.source.updateTime, a.state.docs.get(HWM).data.value, a.state.writes.length], [seed, T0, 777, 0], 'HX-HWM-CREATE-CONFLICT the draft untouched, the racer\'s mark kept');
    // (b) atomic: the mark exists, another save moves it — the batch's SECOND write fails, so its first (the draft) never applies
    const b = stub(RID, seed, null, { docs: { [HWM]: { value: 50 } }, race: { [HWM]: (docs) => docs.set(HWM, { data: { value: 60 }, updateTime: 'racer' }) } });
    const rb = await save(b, RID, withAddition());
    assert.deepStrictEqual([rb.status, rb.body.error], [409, 'stale_edit'], `HX-HWM-ATOMIC a mark moved concurrently refuses the save (${JSON.stringify(rb.body).slice(0, 160)})`);
    assert.deepStrictEqual([b.state.source.data, b.state.source.updateTime, b.state.docs.get(HWM).data.value, b.state.writes.length], [seed, T0, 60, 0], 'HX-HWM-ATOMIC the draft untouched — nothing of the batch applied');
    // the control, after the race cells (so each race mutant meets its own cell first): with no race the addition saves
    const ctl = stub(RID, seed);
    const c = await save(ctl, RID, withAddition());
    assert.strictEqual(c.status, 200, `HX-HWM-PERSIST the addition saves (${JSON.stringify(c.body).slice(0, 160)})`);
    assert.ok(Number.isInteger(ctl.state.docs.get(HWM).data.value), 'HX-HWM-PERSIST the high-water mark is created with the draft');
    ok('an addition\'s draft + high-water mark commit atomically: a concurrent create or move refuses the save and leaves the draft untouched');
  }

  // ── ON (codex S1a r1 P2): a NEW group is capped on its fully derived option names, atomically ──
  {
    SWITCH.enabled = true;
    const LM = 'x_pizza';   // the add-product groups test's portal-shaped group (catalog/add-product-groups.test.js withGroup)
    const lm = buildSourceFromCode(LM);
    const d = clone(lm);
    const L = 'tmp:llllllll-0001'; const V = ['tmp:vvvvvvvv-0001', 'tmp:vvvvvvvv-0002'];
    d.items.push({ ref: L, price: 1, display: { cat: 'ny', name: 'L'.repeat(55), price: 1, desc: 'La clásica' } });
    d.structure.item_order.push(L);
    ['Salsa Roja', 'Salsa Vodka'].forEach((ch, i) => { d.items.push({ ref: V[i], price: 624, display: { choice: ch, variantOf: L, price: 624 } }); d.structure.item_order.push(V[i]); });
    d.structure.variant_items = { ...(d.structure.variant_items || {}), [L]: { label: 'Salsa', variantIds: V } };
    const db = stub(LM, lm);
    const r = await save(db, LM, d);
    assert.strictEqual(r.status, 400, `HX-GROUP-CAP a new group whose derived option names exceed 60 is refused at save (${JSON.stringify(r.body).slice(0, 200)})`);
    assert.strictEqual(r.body.error, 'option_name_too_long');
    assert.strictEqual(db.state.writes.length, 0, 'the whole group is refused; nothing written');
    ok('switch ON: a new group is capped on its derived option names before saving (atomic)');
  }

  // ── ON: a required-choice group renames as one unit (la_musa's Pad Thai) ──
  {
    SWITCH.enabled = true;
    const LM = 'la_musa';
    const lm = buildSourceFromCode(LM);
    const db = stub(LM, lm);
    const d = clone(lm); itemOf(d, 'noodle_01').display.name = 'Pad Thai Especial';
    const r = await save(db, LM, d);
    assert.strictEqual(r.status, 200, `HX-GROUP a launcher rename saves with its options re-derived (${JSON.stringify(r.body).slice(0, 200)})`);
    const st = db.state.source.data;
    for (const k of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) {
      const o = itemOf(st, k);
      assert.strictEqual(o.display.name, `Pad Thai Especial - ${o.display.choice}`, `${k} re-derived`);
    }
    assert.strictEqual(st.frozen_keys, undefined, 'an id-keyed menu records nothing (its keys never derived from names)');
    SWITCH.enabled = false;
    const db2 = stub(LM, lm);
    const r2 = await save(db2, LM, d);
    assert.strictEqual(r2.status, 400, 'HX-GROUP-OFF switch off: a parent-only rename still fails the variant rule');
    assert.match(r2.body.detail, /a variant's name must be/);
    ok('switch ON: a group renames as one unit; OFF: a parent-only rename fails as today');
  }

  // ── PUBLISH (the real publishEditedCore, harness as publish-edited.test.js): a rename publishes carrying its map; a rename
  //    onto a retired frozen key or a registry-reserved name is refused before the publisher is reached (codex S1a r1 P1) ──
  {
    SWITCH.enabled = true;
    const { publishEditedCore } = require('./publish-edited-handler');
    const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
    const { sourceToBuildInputs } = require('./source-store');
    const { buildCatalogV2 } = require('./form-menu-source');
    const builtOf = (src, rid = RID) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode, frozenKeys: i.frozenKeys }), extras: i.extras }; };
    const T = '2026-11-08T12:00:00.000000Z';
    const publish = async (draft, rid = RID) => {
      const live = buildSourceFromCode(rid);
      const publishes = [];
      const deps = { db: {}, authorize: allow, addProduct: addProductOf(null, rid === 'la_musa' ? 'id' : 'name'),
        readActiveBuilt: async () => { const i = sourceToBuildInputs(live); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode }); return { built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }; },
        readDraft: async () => ({ source: draft, updateTime: T }),
        publishVersion: async (_db, r, input) => { publishes.push(input); return { versionId: 'v-new', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } };
      const diff = catalogDiff(builtOf(live, rid), builtOf(draft, rid));
      const token = issueEditToken({ rid, baseActiveVersionId: 'v-live', sourceUpdateTime: T, sourceHash: sha256(draft), diff });
      const r = await publishEditedCore(deps, { restaurantId: rid, token, acknowledgedChanges: diff.largeChangeSet.map((l) => ({ key: l.key, surface: l.surface })), fiscalAck: true }, {});
      return { r, publishes };
    };
    const ok1 = await publish({ ...renamed(seed, 'Carnívora Suprema'), frozen_keys: { [ID]: KEY } });
    assert.strictEqual(ok1.r.status, 200, `HX-PUB a recorded rename publishes (${JSON.stringify(ok1.r.body).slice(0, 200)})`);
    assert.deepStrictEqual(ok1.publishes[0].frozen_keys, { [ID]: KEY }, 'HX-PUB-CARRY the publish input carries the map');
    const p1 = await publish({ ...renamed(seed, 'Pizza Retirada'), frozen_keys: { [ID]: KEY, 999: 'Pizza Retirada' } });
    assert.deepStrictEqual([p1.r.status, p1.r.body.error, p1.publishes.length], [400, 'name_previously_used', 0], 'HX-PUB-RESERVED-FROZEN a rename onto a retired frozen key never reaches the publisher');
    RETIRED.add('Pizza Vieja');
    const p2 = await publish({ ...renamed(seed, 'Pizza Vieja'), frozen_keys: { [ID]: KEY } });
    RETIRED.delete('Pizza Vieja');
    assert.deepStrictEqual([p2.r.status, p2.r.body.error, p2.publishes.length], [400, 'name_previously_used', 0], 'HX-PUB-RESERVED-REGISTRY a rename onto a registry-reserved name never reaches the publisher');
    // codex S1a r2 P1: an id-keyed rename (no map entry) is checked against the registry on publish too
    const lmd = buildSourceFromCode('la_musa'); itemOf(lmd, 'dimsum_01').display.name = 'retired_key';
    RETIRED.add('retired_key');
    const p3 = await publish(lmd, 'la_musa');
    RETIRED.delete('retired_key');
    assert.deepStrictEqual([p3.r.status, p3.r.body.error, p3.r.body.key, p3.publishes.length], [400, 'name_previously_used', 'dimsum_01', 0], `HX-PUB-RESERVED-IDKEY an id-keyed rename onto a registry-reserved key never reaches the publisher (${JSON.stringify(p3.r.body).slice(0, 160)})`);
    ok('publish: a recorded rename publishes with its map; renames onto reserved keys are refused before the publisher');
  }

  // ── reset to the published menu: recorded renames are never dropped (stored ∪ version), and the projection validates by the
  //    version's own map ──
  {
    const { resetDraftToLiveCore } = require('./reset-draft');
    const { buildSourceCandidate } = require('./candidate-validate');
    const published = { ...renamed(seed, 'Carnívora Suprema'), frozen_keys: { [ID]: KEY } };
    const vb = buildSourceCandidate(RID, published).built;
    const preview = (record) => async () => ({ items: vb.items, extras: vb.extras, structure: vb.structure, record });
    const reset = (db, record) => resetDraftToLiveCore({ db, authorize: allow, readActiveVersionId: async () => 'v-live', previewVersion: preview(record) },
      { restaurantId: RID, expectedRevision: db.state.source.updateTime }, {});
    const db = stub(RID, { ...clone(published), frozen_keys: { [ID]: KEY, 999: 'Pizza Retirada' } });
    const r = await reset(db, { key_mode: 'name', frozen_keys: { [ID]: KEY } });
    assert.strictEqual(r.status, 200, `HX-RESET a renamed version resets (${JSON.stringify(r.body).slice(0, 200)})`);
    assert.deepStrictEqual(db.state.source.data.frozen_keys, { [ID]: KEY, 999: 'Pizza Retirada' }, 'HX-RESET-UNION the stored entries survive the reset');
    const db2 = stub(RID, { ...clone(seed), frozen_keys: { 999: 'Pizza Retirada' } });
    const plainBuilt = buildSourceCandidate(RID, seed).built;
    const r2 = await resetDraftToLiveCore({ db: db2, authorize: allow, readActiveVersionId: async () => 'v-live',
      previewVersion: async () => ({ items: plainBuilt.items, extras: plainBuilt.extras, structure: plainBuilt.structure, record: { key_mode: 'name' } }) },
    { restaurantId: RID, expectedRevision: db2.state.source.updateTime }, {});
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(db2.state.source.data.frozen_keys, { 999: 'Pizza Retirada' }, 'HX-RESET-KEEP a version with no map leaves the stored one in place');
    const db3 = stub(RID, clone(seed));
    const r3 = await reset(db3, { key_mode: 'name' });
    assert.strictEqual(r3.status, 500, 'HX-RESET-SELF a renamed version WITHOUT its map does not validate (the projection is judged by the version\'s own map)');
    ok('reset: the projection validates by the version\'s map; stored entries are never dropped');
  }

  FINISHED = true;
  console.log(`\nfrozen-keys-handler: OK (${n})`);
})().catch((e) => { console.error('frozen-keys-handler FAILED:', e); process.exit(1); });
