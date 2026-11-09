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

// A Firestore stub with a real precondition (as edit-catalog.test.js): the draft at restaurants/{rid}/meta/source, the live version
// built by the production builder from the seeded source.
function stub(rid, sourceDoc, liveSource = null) {
  const state = { source: { data: clone(sourceDoc), updateTime: T0 }, writes: [] };
  const live = liveSource || buildSourceFromCode(rid);   // the published version (a renamed one where a cell says so)
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: 'v-live' }) };
      return { exists: false, data: () => ({}) };
    },
    update: async (data, pre) => {
      state.writes.push(path);
      if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; }
      state.source = { data, updateTime: T1 };
      return { writeTime: T1 };
    },
  });
  return {
    state,
    readActiveBuilt: async () => {
      const inputs = require('./source-store').sourceToBuildInputs(live);
      const built = require('./form-menu-source').buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable, keyMode: inputs.keyMode });
      return { built: { ...built, extras: inputs.extras }, versionId: 'v-live', extraRecords: built.extras };
    },
    collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }) }) }),
  };
}
const allow = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const save = (db, rid, source) => editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt }, { restaurantId: rid, source, baseSourceUpdateTime: db.state.source.updateTime }, {});
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
