'use strict';
// S1 (per-dish extras; advisor ruling 11-11) — the per-dish checklist (`deny_extras`) and «Sin extras» (`extras_policy`) ride the ONE
// canonical, token-bound review diff: a change saved in an EARLIER session is shown on reload (the server diff is live vs draft) and
// the publish binds it (the token is bound to that diff). With no checklist change the diff is today's, byte for byte.
// The REAL editCatalogCore / publishEditedCore. Run: node catalog/s1-extras-review.test.js
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
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s1-extras-review: FAILED — exited without completing'); process.exitCode = 1; } });

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


const withDeny = (rid, key, extra) => { const s = base(rid); const ov = s.structure.exposure.item_overrides = s.structure.exposure.item_overrides || {};
  ov[key] = { ...(ov[key] || {}), deny_extras: [extra] }; return s; };
const plainKey = (rid) => { const s = base(rid); return s.items.find((i) => !i.display.variantOf && !(s.structure.variant_items || {})[i.display.id] && !(s.structure.exposure.item_overrides || {})[i.key] && i.display.extras_policy !== 'none').key; };

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const key = plainKey(rid); const extra = base(rid).extras[0].key;
    // (1) the diff line, old → new
    {
      const d = catalogDiff(builtOf(base(rid), rid), builtOf(withDeny(rid, key, extra), rid));
      assert.deepStrictEqual(d.changed.filter((c) => c.field === 'deny_extras'), [{ key, surface: 'item', field: 'deny_extras', old: [], new: [extra] }], `S1V-LINE ${rid}: the checklist change is a reviewed line`);
      const back = catalogDiff(builtOf(withDeny(rid, key, extra), rid), builtOf(base(rid), rid));
      assert.deepStrictEqual(back.changed.filter((c) => c.field === 'deny_extras'), [{ key, surface: 'item', field: 'deny_extras', old: [extra], new: [] }], `S1V-LINE ${rid}: re-checking it is a line too`);
    }
    // (2) no checklist change → no new line (today's diff, byte for byte)
    {
      const s = base(rid); s.items.find((i) => i.key === key).price += 1; s.items.find((i) => i.key === key).display.price += 1;
      const d = catalogDiff(builtOf(base(rid), rid), builtOf(s, rid));
      assert.deepStrictEqual(d.changed.map((c) => c.field), ['price'], `S1V-OLD-FORMAT ${rid}: a price-only draft has exactly today's lines`);
    }
    // (3) saved in session 1, shown on reload (session 2 re-saves the stored draft with no new edit), bound at publish
    {
      EXTRAS.authoring = true;
      const { r: s1, db } = await save(rid, withDeny(rid, key, extra));
      assert.strictEqual(s1.status, 200, `S1V-SAVE ${rid}: premise (${JSON.stringify(s1.body).slice(0, 200)})`);
      const stored = db.state.source.data;
      const { r: s2 } = await save(rid, clone(stored));
      assert.deepStrictEqual(s2.body.diff.changed.filter((c) => c.field === 'deny_extras'), [{ key, surface: 'item', field: 'deny_extras', old: [], new: [extra] }], `S1V-RELOAD ${rid}: session 2's review shows session 1's checklist change`);
      const p = publishDeps(rid, stored);
      const pub = await publishEditedCore(p.deps, { restaurantId: rid, token: s2.body.token, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
      assert.strictEqual(pub.status, 200, `S1V-PUBLISH ${rid}: the reviewed token publishes (${JSON.stringify(pub.body).slice(0, 200)})`);
      // a token issued over a diff WITHOUT the checklist line does not publish this draft
      const blind = issueEditToken({ rid, baseActiveVersionId: ACTIVE, sourceUpdateTime: T1, sourceHash: sha256(stored), diff: catalogDiff(builtOf(base(rid), rid), builtOf(base(rid), rid)) });
      const pb = publishDeps(rid, stored);
      const rb = await publishEditedCore(pb.deps, { restaurantId: rid, token: blind, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
      assert.strictEqual(rb.status, 409, `S1V-BINDS ${rid}: a review that did not show the checklist change cannot publish it (got ${rb.status})`);
      EXTRAS.authoring = false;
    }
    ok(`${rid}: the checklist change is a reviewed line, shown on reload, bound at publish; no change = today's diff`);
  }
  FINISHED = true;
  console.log(`s1-extras-review: OK (${n})`);
})().catch((e) => { console.error('s1-extras-review FAILED:', e && e.message); process.exit(1); });
