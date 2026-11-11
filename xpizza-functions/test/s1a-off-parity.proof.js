'use strict';
// S1a — with item_text_edit OFF (as shipped), the REAL save / publish / reset / assessment handlers of this tip answer and write
// exactly what the base's do, draft for draft. The base is another checkout's functions dir (S1A_BASE_FN, the S0 tip); both
// module sets are loaded side by side (distinct absolute paths ⇒ distinct module instances) and driven through identical stubs.
// Pre-flip, publish-through-Firestore and rollback are proven by the S0 no-op capture (test/keymode-noop.capture.js) re-run at
// this tip. Run: S1A_BASE_FN=<base>/xpizza-functions node test/s1a-off-parity.proof.js
const assert = require('assert');
const path = require('path');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const BASE = process.env.S1A_BASE_FN;
assert.ok(BASE && path.isAbsolute(BASE) && require('fs').existsSync(path.join(BASE, 'catalog/edit-catalog-handler.js')), '🔴 S1A_BASE_FN must name the base functions dir');
const TIP = path.join(__dirname, '..');
assert.notStrictEqual(path.resolve(BASE), path.resolve(TIP), 'premise: two different checkouts');
// the switch ships ON since 2026-11-11 (owner: name editing); this proof is about the OFF state — the ROLLBACK — so the tip side is
// pinned OFF here, before any tip module loads (the base side predates the switch)
{ const p = require.resolve(path.join(TIP, 'catalog/item-text-edit')); require.cache[p] = { id: p, filename: p, loaded: true, exports: { textEditCapabilities: () => ({ enabled: false }) } }; }
assert.strictEqual(require(path.join(TIP, 'catalog/item-text-edit')).textEditCapabilities().enabled, false, 'premise: the tip is judged with the switch OFF (rollback)');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (o) => JSON.parse(JSON.stringify(o)); const label = (b) => JSON.stringify(b).slice(0, 160);
const T0 = '2026-11-09T10:00:00.000000Z'; const T1 = '2026-11-09T11:00:00.000000Z';
const allow = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
// codex S1a r2: nothing is stripped — the save's token and updateTime are compared tip vs base, under one frozen clock
const FIXED_NOW = Date.parse('2026-11-09T10:30:00.000Z'); Date.now = () => FIXED_NOW;

function sideOf(dir) {
  const r = (m) => require(path.join(dir, m));
  return { dir, editCatalogCore: r('catalog/edit-catalog-handler').editCatalogCore, publishEditedCore: r('catalog/publish-edited-handler').publishEditedCore,
    resetDraftToLiveCore: r('catalog/reset-draft').resetDraftToLiveCore, assessDraft: r('catalog/draft-assess').assessDraft,
    buildSourceFromCode: r('tools/seed-source-store').buildSourceFromCode, sourceToBuildInputs: r('catalog/source-store').sourceToBuildInputs,
    buildCatalogV2: r('catalog/form-menu-source').buildCatalogV2, buildSourceCandidate: r('catalog/candidate-validate').buildSourceCandidate,
    edit: r('catalog/catalog-edit') };
}
const SIDES = [sideOf(BASE), sideOf(TIP)];

// the draft store, live version and add-product I/O, identical for both sides
function world(S, rid, draft) {
  const state = { source: { data: clone(draft), updateTime: T0 }, writes: [], hwm: [] };
  const live = S.buildSourceFromCode(rid);
  const doc = (p) => ({
    get: async () => (p === `restaurants/${rid}/meta/source` ? { exists: true, data: () => clone(state.source.data), updateTime: state.source.updateTime } : { exists: false, data: () => ({}) }),
    update: async (data, pre) => { state.writes.push({ p, data: clone(data) }); if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
  });
  const activeRes = () => { const i = S.sourceToBuildInputs(live); const b = S.buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode }); return { built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }; };
  const db = { collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }) }) }), batch: () => { const ops = []; return { update: (ref, data) => ops.push(['u', data]), create: (ref, data) => ops.push(['c', data]), commit: async () => { for (const [k, d] of ops) { if (k === 'c') state.hwm.push(clone(d)); else if (d && d.value !== undefined && !d.items) state.hwm.push(clone(d)); else { state.writes.push({ p: 'batch', data: clone(d) }); state.source = { data: d, updateTime: T1 }; } } return [{ writeTime: T1 }]; } }; } };
  const addProduct = { readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }),
    registryKeysTaken: async (_r, keys, mode) => { if (mode !== 'name' && mode !== 'id') throw new Error('unknown key mode'); return new Set(); },
    syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }) };
  return { state, live, db, activeRes, addProduct };
}

async function run(S, rid, draft) {
  const out = {};
  const w = world(S, rid, draft);
  const save = await S.editCatalogCore({ db: w.db, authorize: allow, readActiveBuilt: async () => w.activeRes(), addProduct: w.addProduct }, { restaurantId: rid, source: draft, baseSourceUpdateTime: T0 }, {});
  out.save = { status: save.status, body: save.body, writes: w.state.writes, hwm: w.state.hwm };
  const stored = w.state.source.data;
  out.assess = S.assessDraft(rid, clone(stored), w.activeRes());
  if (save.status === 200) {
    const publishes = [];
    const builtOf = (src) => { const i = S.sourceToBuildInputs(src); return { ...S.buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode }), extras: i.extras }; };
    const diff = S.edit.catalogDiff(builtOf(w.live), builtOf(stored));
    const token = save.body.token;   // the token the save RETURNED, against the revision it returned (codex S1a r2)
    assert.ok(typeof token === 'string' && token, `premise: the save returned a token (${label(save.body)})`);   // a wrong token or revision fails the publish ⇒ the tip/base comparison
    const pub = await S.publishEditedCore({ db: {}, authorize: allow, addProduct: w.addProduct, readActiveBuilt: async () => w.activeRes(), readDraft: async () => ({ source: clone(stored), updateTime: save.body.updateTime }),
      publishVersion: async (_db, r, input) => { publishes.push(clone(input)); return { versionId: 'v-new', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } },
    { restaurantId: rid, token, acknowledgedChanges: diff.largeChangeSet.map((l) => ({ key: l.key, surface: l.surface })), fiscalAck: true }, {});
    out.publish = { status: pub.status, body: pub.body, inputs: publishes };
  }
  // reset back to the live version
  const vb = S.buildSourceCandidate(rid, w.live).built;
  const rs = await S.resetDraftToLiveCore({ db: w.db, authorize: allow, readActiveVersionId: async () => 'v-live',
    previewVersion: async () => ({ items: vb.items, extras: vb.extras, structure: vb.structure, record: { key_mode: rid === 'la_musa' ? 'id' : 'name' } }) },
  { restaurantId: rid, expectedRevision: w.state.source.updateTime }, {});
  out.reset = { status: rs.status, body: rs.body, stored: w.state.source.data };
  return out;
}

const CASES = [
  ['x_pizza price edit', 'x_pizza', (s) => { const it = s.items.find((i) => i.key === 'Carnivora'); it.price += 5; it.display.price = it.price; }],
  ['la_musa price edit', 'la_musa', (s) => { const it = s.items.find((i) => i.key === 'noodle_01_pollo'); it.price += 5; it.display.price = it.price; }],
  ['x_pizza rename (refused OFF)', 'x_pizza', (s) => { s.items.find((i) => i.key === 'Carnivora').display.name = 'Carnívora Suprema'; }],
  ['x_pizza desc edit (refused OFF)', 'x_pizza', (s) => { s.items.find((i) => i.key === 'Carnivora').display.desc = 'Nueva'; }],
  ['la_musa parent-only rename (refused OFF)', 'la_musa', (s) => { s.items.find((i) => i.key === 'noodle_01').display.name = 'Pad Thai Especial'; }],
  ['la_musa name edit (refused OFF)', 'la_musa', (s) => { s.items.find((i) => i.key === 'noodle_01_pollo').display.name = 'Otro'; }],
  ['x_pizza addition', 'x_pizza', (s) => { s.items.push({ ref: 'tmp:paritynew01', price: 150, display: { name: 'Pizza Nueva', cat: 'ny', price: 150, desc: '' } }); s.structure.item_order.push('tmp:paritynew01'); }],
  ['x_pizza addition with a 61-char name (uncapped OFF)', 'x_pizza', (s) => { s.items.push({ ref: 'tmp:paritynew02', price: 150, display: { name: 'N'.repeat(61), cat: 'ny', price: 150, desc: '' } }); s.structure.item_order.push('tmp:paritynew02'); }],
  ['la_musa addition', 'la_musa', (s) => { const c = s.items.find((i) => i.key === 'noodle_01').display.cat; s.items.push({ ref: 'tmp:paritynew03', price: 150, display: { name: 'Plato Nuevo', cat: c, price: 150, desc: '' } }); s.structure.item_order.push('tmp:paritynew03'); }],
  ['x_pizza unchanged echo', 'x_pizza', () => {}],
];

(async () => {
  for (const [label, rid, mutate] of CASES) {
    const results = [];
    for (const S of SIDES) { const d = clone(S.buildSourceFromCode(rid)); mutate(d); results.push(await run(S, rid, d)); }
    assert.deepStrictEqual(results[1], results[0], `🔴 OFF-PARITY ${label}: the tip differs from the base`);
    ok(`${label}: save ${results[1].save.status}${results[1].publish ? ` · publish ${results[1].publish.status}` : ''} · reset ${results[1].reset.status} — tip == base (responses, writes, publish input, assessment)`);
  }
  console.log(`\ns1a-off-parity: OK (${n})`);
})().catch((e) => { console.error('s1a-off-parity FAILED:', e); process.exit(1); });
