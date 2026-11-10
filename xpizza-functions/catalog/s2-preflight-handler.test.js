'use strict';
// S2-1/2/3 (D4c-grill/item-s1/S2-DESIGN.md §1.2 + §2 r1 E/F) — the REAL editCatalog handler with item_text_edit ON answers the
// contract's FIRST refusal, field-tagged ({ error, key, field, option_key? }): empty name, code-point caps (grandfathered when
// unchanged), the validator's own text-safety rule (attribute for names, body for descriptions), option attribution to the
// LAUNCHER, registry hits, subsection coverage, emptied sections / subsections (field per the drawer's visible control) — and
// OFF answers exactly as today. Run: node catalog/s2-preflight-handler.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const SWITCH = { enabled: false };
require.cache[require.resolve('./item-text-edit')] = { id: require.resolve('./item-text-edit'), filename: require.resolve('./item-text-edit'), loaded: true,
  exports: { textEditCapabilities: () => ({ enabled: SWITCH.enabled }) } };
const MINT = { enabled: false, next: null };   // S1c: the one-time minting switch, swapped like the text switch; `next` forces the token
require.cache[require.resolve('./mint-opaque')] = { id: require.resolve('./mint-opaque'), filename: require.resolve('./mint-opaque'), loaded: true,
  exports: { ...require('./mint-opaque'), mintCapabilities: () => ({ enabled: MINT.enabled }), mintKey: () => (MINT.next ? MINT.next() : require('crypto').randomBytes(6).toString('hex').replace(/[^a-z2-7]/g, 'a').padEnd(12, 'a').slice(0, 12).replace(/^/, 'i_')) } };
const { editCatalogCore } = require('./edit-catalog-handler');
const { validateSource } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2-preflight-handler: FAILED — exited without completing'); process.exitCode = 1; } });

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
const RESERVED_IO = { doc: undefined, fail: false, reads: 0 }; const PUBLISH_THROWS = { err: null };   // S1c (codex r1 P2-2): the activation's typed refusals   // S1c: the reserved-key set the io reads
const addProductOf = (db, mode) => ({
  readKeyMode: async () => mode,
  hwmRef: (rid) => (db ? db.doc(`restaurants/${rid}/meta/display_id_hwm`) : { path: null, get: async () => ({ exists: false, data: () => undefined }) }),   // the production path (add-product-io hwmRefOf)
  registryKeysTaken: async (_rid, keys, keyMode) => {
    if (keyMode !== 'name' && keyMode !== 'id') throw new Error(`registryKeysTaken: unknown key mode ${JSON.stringify(keyMode)}`);
    return new Set([...new Set(keys)].filter((k) => RETIRED.has(k)));
  },
  syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }),   // production's shape when another publish won
  readReservedKeys: async () => { RESERVED_IO.reads += 1; if (RESERVED_IO.fail) throw new Error('UNAVAILABLE'); return require('./reserved-keys').reservedKeySet(RESERVED_IO.doc); },   // S1c: production's shape (add-product-io)
});
const save = (db, rid, source, mode = rid === 'la_musa' ? 'id' : 'name') => editCatalogCore({ db, authorize: allow, readActiveBuilt: db.readActiveBuilt, addProduct: addProductOf(db, mode) }, { restaurantId: rid, source, baseSourceUpdateTime: db.state.source.updateTime }, {});
const itemOf = (s, key) => s.items.find((i) => i.key === key);


const LM = buildSourceFromCode('la_musa'); const XP = buildSourceFromCode('x_pizza');
const body = (r) => r.body;
const want = (r, status, b, label) => { assert.strictEqual(r.status, status, `${label} (${JSON.stringify(r.body).slice(0, 220)})`); for (const [k, v] of Object.entries(b)) assert.deepStrictEqual(r.body[k], v, `${label}: ${k}`); };

(async () => {
  SWITCH.enabled = true;
  // ── names: empty, unsafe (attribute rule: quotes and angle brackets, literal or encoded) ──
  {
    for (const [name, code, label] of [['   ', 'name_required', 'S2H-NAME-EMPTY'], ["Carnivora's", 'text_unsafe', 'S2H-NAME-QUOTE'], ['Carnivora "XL"', 'text_unsafe', 'S2H-NAME-DQUOTE'], ['Carnivora &lt;b&gt;', 'text_unsafe', 'S2H-NAME-ENCODED']]) {
      const s = clone(XP); itemOf(s, 'Carnivora').display.name = name;
      want(await save(stub('x_pizza', XP), 'x_pizza', s), 400, { error: code, key: 'Carnivora', field: 'name' }, `${label} ${JSON.stringify(name)}`);
    }
    ok('a name that is empty, or carries a quote or an angle bracket (literal or encoded), is refused under the name field');
  }
  // ── descriptions: the body rule (quotes allowed, angle brackets not) ──
  {
    const s1 = clone(XP); itemOf(s1, 'Carnivora').display.desc = 'La "clásica" de la casa';
    assert.strictEqual((await save(stub('x_pizza', XP), 'x_pizza', s1)).status, 200, 'S2H-DESC-QUOTE a description may carry quotes');
    const s2 = clone(XP); itemOf(s2, 'Carnivora').display.desc = 'Con <b>queso</b>';
    want(await save(stub('x_pizza', XP), 'x_pizza', s2), 400, { error: 'text_unsafe', key: 'Carnivora', field: 'desc' }, 'S2H-DESC-ANGLE');
    ok('a description may carry quotes; angle brackets are refused under the description field');
  }
  // ── caps count Unicode code points (an astral character is ONE), and an unchanged value is grandfathered ──
  {
    const ASTRAL = '\u{1D11E}';
    const n60 = 'á'.repeat(59) + ASTRAL; assert.strictEqual(n60.length, 61, 'premise: 60 code points, 61 UTF-16 units');
    const s1 = clone(XP); itemOf(s1, 'Carnivora').display.name = n60;
    assert.strictEqual((await save(stub('x_pizza', XP), 'x_pizza', s1)).status, 200, 'S2H-CAP-60 a 60-code-point name passes');
    const s2 = clone(XP); itemOf(s2, 'Carnivora').display.name = n60 + 'á';
    want(await save(stub('x_pizza', XP), 'x_pizza', s2), 400, { error: 'name_too_long', key: 'Carnivora', field: 'name' }, 'S2H-CAP-61');
    const d200 = 'é'.repeat(199) + ASTRAL;
    const s3 = clone(XP); itemOf(s3, 'Carnivora').display.desc = d200;
    assert.strictEqual((await save(stub('x_pizza', XP), 'x_pizza', s3)).status, 200, 'S2H-DCAP-200 a 200-code-point description passes');
    const s4 = clone(XP); itemOf(s4, 'Carnivora').display.desc = d200 + 'é';
    want(await save(stub('x_pizza', XP), 'x_pizza', s4), 400, { error: 'desc_too_long', key: 'Carnivora', field: 'desc' }, 'S2H-DCAP-201');
    const long = clone(XP); itemOf(long, 'Carnivora').display.desc = 'ñ'.repeat(230);   // a live over-limit value
    const priceOnly = clone(long); itemOf(priceOnly, 'Carnivora').price += 1; itemOf(priceOnly, 'Carnivora').display.price += 1;
    assert.strictEqual((await save(stub('x_pizza', long, long), 'x_pizza', priceOnly)).status, 200, 'S2H-GRANDFATHER an unchanged over-limit description never blocks a price-only save');
    ok('caps count code points; an unchanged over-limit value is grandfathered');
  }
  // ── a derived option name: refused under the LAUNCHER, naming the option ──
  {
    const s = clone(LM); itemOf(s, 'noodle_01').display.name = 'P'.repeat(48);
    const r = await save(stub('la_musa', LM), 'la_musa', s);
    want(r, 400, { error: 'option_name_too_long', key: 'noodle_01', field: 'name' }, 'S2H-OPT-CAP');
    assert.ok(['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron'].includes(r.body.option_key), `S2H-OPT-CAP option_key names the option (${r.body.option_key})`);
    RETIRED.add('Pad Thai Nuevo - Pollo');
    const s2 = clone(LM); itemOf(s2, 'noodle_01').display.name = 'Pad Thai Nuevo';
    want(await save(stub('la_musa', LM), 'la_musa', s2, 'name'), 400, { error: 'name_previously_used', key: 'noodle_01', field: 'name', option_key: 'noodle_01_pollo' }, 'S2H-OPT-REGISTRY a registry hit on a derived option name');
    RETIRED.clear();
    ok('a derived option name refusal is attributed to the launcher with option_key (caps and registry)');
  }
  // ── moves: subsection coverage; an emptied section; an emptied subsection (field = the visible control) ──
  {
    const s1 = clone(LM); const d = itemOf(s1, 'dimsum_01') || s1.items.find((i) => i.display.cat === 'dim_sum'); d.display.cat = 'bebidas'; delete d.display.subcat;
    want(await save(stub('la_musa', LM), 'la_musa', s1), 400, { error: 'subcat_invalid', key: d.key, field: 'subcat' }, 'S2H-SUBCAT a move into a subsectioned section needs a subsection');
    const s2 = clone(LM); const crudo = s2.items.filter((i) => i.display.cat === 'crudo'); for (const it of crudo) it.display.cat = 'rice';
    want(await save(stub('la_musa', LM), 'la_musa', s2), 400, { error: 'section_emptied', key: crudo[0].key, field: 'cat' }, 'S2H-SECTION-EMPTIED');
    const s3 = clone(LM); const sodas = s3.items.filter((i) => i.display.subcat === 'Sodas'); for (const it of sodas) it.display.subcat = 'Cervezas';
    want(await save(stub('la_musa', LM), 'la_musa', s3), 400, { error: 'subsection_emptied', key: sodas[0].key, field: 'subcat' }, 'S2H-SUB-EMPTIED-SAME within the section → the Subcategoría field');
    const s4 = clone(LM); const sodas4 = s4.items.filter((i) => i.display.subcat === 'Sodas'); for (const it of sodas4) { it.display.cat = 'rice'; delete it.display.subcat; }
    want(await save(stub('la_musa', LM), 'la_musa', s4), 400, { error: 'subsection_emptied', key: sodas4[0].key, field: 'cat' }, 'S2H-SUB-EMPTIED-CROSS across sections → the Categoría field');
    ok('moves: subsection coverage, an emptied section, an emptied subsection tagged to the visible control');
  }
  // ── precedence: the text rule answers before the move rule ──
  {
    const s = clone(LM); itemOf(s, 'noodle_01').display.name = 'x'.repeat(61); const d = s.items.find((i) => i.display.cat === 'dim_sum'); d.display.cat = 'bebidas'; delete d.display.subcat;
    want(await save(stub('la_musa', LM), 'la_musa', s), 400, { error: 'name_too_long', key: 'noodle_01' }, 'S2H-ORDER the first refusal is the text rule');
    ok('precedence: text before moves');
  }
  // ── PUBLISH: the same preflight, against CURRENT state, before the validator (the real publishEditedCore) ──
  {
    const { publishEditedCore } = require('./publish-edited-handler');
    const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
    const { sourceToBuildInputs } = require('./source-store');
    const { buildCatalogV2 } = require('./form-menu-source');
    const AP = require('./add-product');
    const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode, frozenKeys: i.frozenKeys }), extras: i.extras }; };
    const T = '2026-11-08T12:00:00.000000Z';
    const publish = async (draft, rid, throws = null) => {
      const live = buildSourceFromCode(rid);
      const deps = { db: {}, authorize: allow, addProduct: addProductOf(null, rid === 'la_musa' ? 'id' : 'name'),
        readActiveBuilt: async () => { const i = sourceToBuildInputs(live); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode }); return { built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }; },
        readDraft: async () => ({ source: draft, updateTime: T }),
        publishVersion: async () => { if (throws) throw throws; return { versionId: 'v-new', item_count: 0, extra_count: 0 }; } };
      let diff; try { diff = catalogDiff(builtOf(live, rid), builtOf(draft, rid)); } catch (_) { diff = { largeChangeSet: [] }; }
      const token = issueEditToken({ rid, baseActiveVersionId: 'v-live', sourceUpdateTime: T, sourceHash: sha256(draft), diff });
      return publishEditedCore(deps, { restaurantId: rid, token, acknowledgedChanges: (diff.largeChangeSet || []).map((l) => ({ key: l.key, surface: l.surface })), fiscalAck: true }, {});
    };
    // a registry row gained between the save and the publish, on a derived option name
    const renamedGroup = AP.rederiveOptionNames((() => { const s = clone(LM); itemOf(s, 'noodle_01').display.name = 'Pad Thai Nuevo'; return s; })());
    RETIRED.add('Pad Thai Nuevo - Pollo');
    want(await publish(renamedGroup, 'la_musa'), 400, { error: 'name_previously_used', key: 'noodle_01', field: 'name', option_key: 'noodle_01_pollo' }, 'S2H-PUB-REGISTRY refused at publish, attributed to the launcher');
    RETIRED.clear();
    // a draft stored by an older server with a quote in a name: the typed refusal, not the validator's untagged one
    const q = clone(XP); itemOf(q, 'Carnivora').display.name = "Carnivora's";
    want(await publish(q, 'x_pizza'), 400, { error: 'text_unsafe', key: 'Carnivora', field: 'name' }, 'S2H-PUB-TEXT the text rule at publish is field-tagged');
    // the SAME first refusal at save and at publish for a draft with several problems
    const multi = clone(LM); itemOf(multi, 'noodle_01').display.name = 'x'.repeat(61); const md = multi.items.find((i) => i.display.cat === 'dim_sum'); md.display.cat = 'bebidas'; delete md.display.subcat;
    const rs = await save(stub('la_musa', LM), 'la_musa', clone(multi)); const rp = await publish(AP.rederiveOptionNames(clone(multi)), 'la_musa');
    assert.deepStrictEqual([rp.status, rp.body], [rs.status, rs.body], 'S2H-PUB-SAME the publish answers the save\'s first refusal');
    // S2-7 (§1.3; Codex P2-8): the activation's reserved_key_conflict NAMES the product — key + display name (+ option_key)
    const okDraft = (() => { const s = clone(XP); s.frozen_keys = { [String(itemOf(s, 'Carnivora').display.id)]: 'Carnivora' }; itemOf(s, 'Carnivora').display.name = 'Carnívora Suprema'; return s; })();
    const conflict = Object.assign(new Error('reserved_key_conflict: x_pizza/v-new — a renamed item may not take a reserved key ("Carnivora")'), { status: 409, code: 'reserved_key_conflict', key: 'Carnivora', name: 'Carnívora Suprema', field: 'name' });
    want(await publish(okDraft, 'x_pizza', conflict), 409, { error: 'reserved_key_conflict', key: 'Carnivora', name: 'Carnívora Suprema', field: 'name' }, 'S2H-RKC the activation conflict names its product');
    const optConflict = Object.assign(new Error('reserved_key_conflict: la_musa/v-new — a renamed item may not take a reserved key ("noodle_01_pollo")'), { status: 409, code: 'reserved_key_conflict', key: 'noodle_01', option_key: 'noodle_01_pollo', name: 'Pad Thai Nuevo - Pollo', field: 'name' });
    want(await publish(renamedGroup, 'la_musa', optConflict), 409, { error: 'reserved_key_conflict', key: 'noodle_01', option_key: 'noodle_01_pollo', name: 'Pad Thai Nuevo - Pollo', field: 'name' }, 'S2H-RKC-OPT an option conflict: the launcher + option_key');
    ok('publish: the same preflight against current state — a later registry row, a stored unsafe name, the same first refusal');
  }
  // ── S2-6 (§1.3, Codex r1 P2-4): the extras consequences ride the reviewed diff at BOTH sites — a save → publish round trip
  //    with a non-empty consequence publishes with the save's own token (never edit_superseded) ──
  {
    const { publishEditedCore } = require('./publish-edited-handler');
    const s = clone(LM); const beer = itemOf(s, 'beer_01'); beer.display.cat = 'dim_sum'; delete beer.display.subcat;
    const db = stub('la_musa', LM);
    const saved = await save(db, 'la_musa', s);
    assert.strictEqual(saved.status, 200, `premise: the move saves (${JSON.stringify(saved.body).slice(0, 200)})`);
    assert.deepStrictEqual(saved.body.diff.consequences, [{ key: 'beer_01', kind: 'extras', gained: ['Acompañamientos', 'Salsas'], lost: [] }], 'S2H-XC-SAVE the reviewed diff carries the extras consequence');
    const deps = { db: {}, authorize: allow, addProduct: addProductOf(null, 'id'), readActiveBuilt: db.readActiveBuilt,
      readDraft: async () => ({ source: db.state.source.data, updateTime: saved.body.updateTime }),
      publishVersion: async () => ({ versionId: 'v-new', item_count: 0, extra_count: 0 }) };
    const pub = await publishEditedCore(deps, { restaurantId: 'la_musa', token: saved.body.token, acknowledgedChanges: (saved.body.diff.largeChangeSet || []).map((l) => ({ key: l.key, surface: l.surface })), fiscalAck: true }, {});
    assert.strictEqual(pub.status, 200, `S2H-XC-ROUNDTRIP the publish re-computes the same consequence and accepts the save's token (${JSON.stringify(pub.body).slice(0, 200)})`);
    const plain = clone(LM); itemOf(plain, 'beer_01').price += 1; itemOf(plain, 'beer_01').display.price += 1;
    const sp = await save(stub('la_musa', LM), 'la_musa', plain);
    assert.ok(sp.status === 200 && !('consequences' in sp.body.diff), 'S2H-XC-ABSENT no consequence ⇒ no key (today\'s diff, and its token hash, byte-identical)');
    ok('extras consequences: carried by the save\'s diff, re-computed identically at publish (round trip 200); absent when none');
  }
  // ── OFF: exactly today (none of the S2 codes) ──
  {
    SWITCH.enabled = false;
    const s = clone(XP); itemOf(s, 'Carnivora').display.name = "Carnivora's";
    const r = await save(stub('x_pizza', XP), 'x_pizza', s);
    assert.strictEqual(r.status, 400, 'S2H-OFF refused');
    assert.ok(!['text_unsafe', 'name_required', 'subcat_invalid', 'section_emptied', 'subsection_emptied'].includes(r.body.error), `S2H-OFF today's code, never an S2 one (${r.body.error})`);
    SWITCH.enabled = true;
    ok('switch OFF: today\'s answers, never an S2 code');
  }
  FINISHED = true;
  console.log(`\ns2-preflight-handler: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
