'use strict';
// PLAN-public-menu-display r2 T1 — a category rename END TO END, through the real handlers:
//   SAVE (editCatalogCore) → the reviewed diff + token → PUBLISH (publishEditedCore) → the real publish pipeline →
//   the SERVED menu (buildPublicMenu) carries the names.
// And the refusals that must stay exactly as they are: a stale token, publish without catalog.publish, the x_pizza
// fiscal gate (a rename IS an x_pizza menu edit — no exemption), and a rename riding beside a price edit.
// Run: node catalog/category-rename-flow.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
// the platform extras-authoring switch, made settable (shipped OFF; cell 4 turns it ON) — before the handlers load it
const EXTRAS = { authoring: false };
{ const p = require.resolve('./platform-extras'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { extrasCapabilities: () => ({ ...EXTRAS }) } }; }
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublicMenu } = require('./public-menu');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('category-rename-flow: FAILED — exited without completing'); process.exitCode = 1; } });

const T0 = '2026-10-24T10:00:00.000000Z';
const T1 = '2026-10-24T11:00:00.000000Z';
const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const asRole = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@x.hn` });
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = (rid) => clone(buildSourceFromCode(rid));
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = (rid) => async () => {
  const src = base(rid); const i = sourceToBuildInputs(src);
  return { built: builtOf(src, rid), versionId: ACTIVE, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras };
};
const NAMES = { x_pizza: ['Pizzas de 12', 'NY de 18'], la_musa: ['Dim Sum de la Casa'] };
const renamed = (rid) => { const s = base(rid); NAMES[rid].forEach((nm, i) => { s.structure.categories[i].name = nm; }); return s; };

// The save side: a source doc with a faithful update-time precondition (the edit-catalog.test.js stub, cut to what a
// rename touches).
function saveDb(rid) {
  const state = { source: { data: base(rid), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => {
      if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; }
      state.source = { data, updateTime: T1 }; return { writeTime: T1 };
    },
  });
  return { state, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const save = (rid, source, { authorize = owner } = {}) => {
  const db = saveDb(rid);
  return editCatalogCore({ db, authorize, readActiveBuilt: liveRead(rid) }, { restaurantId: rid, source, baseSourceUpdateTime: T0 }, {}).then((r) => ({ r, db }));
};
// The publish side: the draft the save wrote, the live version, and every publish attempt recorded.
const publishDeps = (rid, draft, { authorize = owner, draftUpdateTime = T1 } = {}) => {
  const state = { publishes: [] };
  return {
    state,
    deps: {
      db: {}, authorize, readActiveBuilt: liveRead(rid),
      readDraft: async () => ({ source: draft, updateTime: draftUpdateTime }),
      publishVersion: async (_db, r, input, opts) => { state.publishes.push({ r, input, opts }); return { versionId: 'v-new-2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; },
    },
  };
};
// The served menu of what the publish handler ACTUALLY handed to publishVersion: that exact input (and its options),
// through the real publishVersion on a fresh store, read back by buildPublicMenu.
async function served(rid, captured) {
  const db = makeDb();
  // the INPUT is exactly the handler's; only the flip CAS is re-aimed — a fresh store has no active version and no draft
  // revision to compare against (the handler's own CAS is pinned by publish-edited.test.js)
  await publishVersion(db, rid, captured.input, { expected: { activeVersionId: null } });
  return (await buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true })).body;
}

(async () => {
  // ── (1) the whole flow, both brands ────────────────────────────────────────────────────────────────────
  for (const rid of ['x_pizza', 'la_musa']) {
    const { r, db } = await save(rid, renamed(rid));
    assert.strictEqual(r.status, 200, `${rid}: save → 200 (got ${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
    const lines = r.body.diff.changed.filter((c) => c.surface === 'category');
    assert.deepStrictEqual(lines.map((c) => c.new), NAMES[rid], `${rid}: the reviewed diff shows every rename`);
    assert.deepStrictEqual(r.body.diff.changed.filter((c) => c.surface !== 'category'), [], `${rid}: and nothing else`);
    const draft = db.state.source.data;
    const p = publishDeps(rid, draft);
    const body = { restaurantId: rid, token: r.body.token, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) };
    const pub = await publishEditedCore(p.deps, body, {});
    assert.strictEqual(pub.status, 200, `${rid}: publish → 200 (got ${pub.status} ${JSON.stringify(pub.body).slice(0, 200)})`);
    assert.strictEqual(p.state.publishes.length, 1, `${rid}: exactly one publish`);
    const menu = await served(rid, p.state.publishes[0]);
    assert.deepStrictEqual(menu.categories.slice(0, NAMES[rid].length).map((c) => c.name), NAMES[rid], `${rid}: the served categories carry the names`);
  }
  ok('save → reviewed diff (the renames and nothing else) → token → publish → the SERVED categories carry the names, on both brands');

  // ── (2) a stale token, no catalog.publish, the fiscal gate: refused exactly as today ──────────────────────
  {
    const rid = 'x_pizza';
    const { r, db } = await save(rid, renamed(rid));
    const draft = db.state.source.data;
    // the draft moved after the diff was shown
    const moved = publishDeps(rid, draft, { draftUpdateTime: '2026-10-24T12:00:00.000000Z' });
    const rs = await publishEditedCore(moved.deps, { restaurantId: rid, token: r.body.token, fiscalAck: true }, {});
    assert.strictEqual(rs.status, 409, `a stale token → 409 (got ${rs.status})`);
    assert.strictEqual(moved.state.publishes.length, 0, 'stale: nothing published');
    // a token for a DIFFERENT rename does not publish this one
    const other = renamed(rid); other.structure.categories[1].name = 'NY Grande';
    const forged = issueEditToken({ rid, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(other), diff: catalogDiff(builtOf(base(rid), rid), builtOf(other, rid)) });
    const pf = publishDeps(rid, draft);
    const rf = await publishEditedCore(pf.deps, { restaurantId: rid, token: forged, fiscalAck: true }, {});
    assert.strictEqual(rf.status, 409, `another rename's token → 409 (got ${rf.status})`);
    // no catalog.publish
    const pa = publishDeps(rid, draft, { authorize: asRole('viewer') });
    const ra = await publishEditedCore(pa.deps, { restaurantId: rid, token: r.body.token, fiscalAck: true }, {});
    assert.strictEqual(ra.status, 403, `no catalog.publish → 403 (got ${ra.status} ${JSON.stringify(ra.body)})`);
    assert.strictEqual(ra.body.error, 'not_authorized', 'not_authorized');
    // the fiscal gate: no ack → refused; a non-owner's ack → refused; the owner's ack lands
    const p0 = publishDeps(rid, draft);
    const r0 = await publishEditedCore(p0.deps, { restaurantId: rid, token: r.body.token }, {});
    assert.strictEqual(r0.status, 403, 'a rename with no fiscalAck → 403');
    assert.strictEqual(r0.body.error, 'fiscal_ack_required', 'fiscal_ack_required — a rename gets no exemption');
    const pd = publishDeps(rid, draft, { authorize: asRole('dispatcher') });
    const rd = await publishEditedCore(pd.deps, { restaurantId: rid, token: r.body.token, fiscalAck: true }, {});
    assert.strictEqual(rd.status, 403, 'a dispatcher sending fiscalAck → 403');
    assert.strictEqual(rd.body.error, 'not_owner', 'not_owner');
    assert.strictEqual(p0.state.publishes.length + pd.state.publishes.length + pa.state.publishes.length + pf.state.publishes.length, 0, 'none of the refusals published');
  }
  ok('a stale token, another rename’s token, no catalog.publish, no fiscalAck and a non-owner’s ack are all refused as today; nothing published');

  // ── (3) a rename riding beside a price edit is refused on SAVE and at PUBLISH; a price-only edit still lands ──
  {
    const rid = 'x_pizza';
    const both = renamed(rid); const it = both.items.find((i) => i.key === 'Margherita'); it.price += 10; it.display.price = it.price;
    const { r } = await save(rid, both);
    assert.strictEqual(r.status, 400, `save: rename + price → 400 (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
    assert.strictEqual(r.body.error, 'rename_not_alone', 'rename_not_alone');
    assert.strictEqual(r.body.field, 'categories', 'field: categories');
    // a draft that reached the store some other way is judged again at publish
    const tok = issueEditToken({ rid, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(both), diff: catalogDiff(builtOf(base(rid), rid), builtOf(both, rid)) });
    const pb = publishDeps(rid, both);
    const rb = await publishEditedCore(pb.deps, { restaurantId: rid, token: tok, fiscalAck: true }, {});
    assert.strictEqual(rb.status, 400, `publish: rename + price → 400 (got ${rb.status} ${JSON.stringify(rb.body).slice(0, 160)})`);
    assert.strictEqual(rb.body.error, 'rename_not_alone', 'rename_not_alone at publish');
    assert.strictEqual(pb.state.publishes.length, 0, 'nothing published');
    // and a structural change past save (an id swap) is refused at publish as well
    const swap = renamed(rid); [swap.structure.categories[0], swap.structure.categories[1]] = [swap.structure.categories[1], swap.structure.categories[0]];
    const tsw = issueEditToken({ rid, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(swap), diff: catalogDiff(builtOf(base(rid), rid), builtOf(swap, rid)) });
    const psw = publishDeps(rid, swap);
    const rsw = await publishEditedCore(psw.deps, { restaurantId: rid, token: tsw, fiscalAck: true }, {});
    assert.strictEqual(rsw.status, 400, `publish: reordered categories → 400 (got ${rsw.status})`);
    assert.strictEqual(rsw.body.error, 'structure_changed', 'structure_changed at publish');
    // the ordinary price edit, unchanged
    const price = base(rid); const m = price.items.find((i) => i.key === 'Margherita'); m.price += 10; m.display.price = m.price;
    const sp = await save(rid, price);
    assert.strictEqual(sp.r.status, 200, 'a price-only edit saves');
    const pp = publishDeps(rid, sp.db.state.source.data);
    const rp = await publishEditedCore(pp.deps, { restaurantId: rid, token: sp.r.body.token, fiscalAck: true }, {});
    assert.strictEqual(rp.status, 200, `a price-only edit publishes (got ${rp.status} ${JSON.stringify(rp.body).slice(0, 160)})`);
  }
  ok('rename + price → rename_not_alone on save AND at publish; reordered categories → structure_changed at publish; a price-only edit saves and publishes as today');

  // ── (4) codex build r1 P2: with extras authoring ON, a rename beside a deny_extras change is refused on SAVE and at
  //    PUBLISH on both brands (the reviewed diff would show only the rename); the deny_extras change alone still lands ──
  EXTRAS.authoring = true;
  try {
    const denied = (src) => { src.structure.exposure.item_overrides[src.items[0].key] = { deny_extras: [src.extras[0].key] }; return src; };
    for (const rid of ['x_pizza', 'la_musa']) {
      const fiscal = rid === 'x_pizza' ? { fiscalAck: true } : {};
      const both = denied(renamed(rid));
      const { r } = await save(rid, both);
      assert.strictEqual(r.status, 400, `${rid} save: rename + deny_extras → 400 (got ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      assert.strictEqual(r.body.error, 'rename_not_alone', `${rid}: rename_not_alone on save`);
      const tok = issueEditToken({ rid, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(both), diff: catalogDiff(builtOf(base(rid), rid), builtOf(both, rid)) });
      const pb = publishDeps(rid, both);
      const rb = await publishEditedCore(pb.deps, { restaurantId: rid, token: tok, ...fiscal }, {});
      assert.strictEqual(rb.status, 400, `${rid} publish: rename + deny_extras → 400 (got ${rb.status} ${JSON.stringify(rb.body).slice(0, 160)})`);
      assert.strictEqual(rb.body.error, 'rename_not_alone', `${rid}: rename_not_alone at publish`);
      assert.strictEqual(pb.state.publishes.length, 0, `${rid}: nothing published`);
      // premise: the deny_extras change on its own saves and publishes with authoring ON
      const alone = await save(rid, denied(base(rid)));
      assert.strictEqual(alone.r.status, 200, `${rid}: deny_extras alone saves (got ${alone.r.status} ${JSON.stringify(alone.r.body).slice(0, 160)})`);
      const pa = publishDeps(rid, alone.db.state.source.data);
      const ra = await publishEditedCore(pa.deps, { restaurantId: rid, token: alone.r.body.token, ...fiscal }, {});
      assert.strictEqual(ra.status, 200, `${rid}: deny_extras alone publishes (got ${ra.status} ${JSON.stringify(ra.body).slice(0, 160)})`);
    }
  } finally { EXTRAS.authoring = false; }
  ok('extras authoring ON: rename + deny_extras → rename_not_alone on save AND at publish, both brands, nothing published; deny_extras alone saves and publishes');

  FINISHED = true;
  console.log(`\ncategory-rename-flow: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
