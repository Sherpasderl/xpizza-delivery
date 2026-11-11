'use strict';
// PLAN-manager-request-consequences r0 (APPROVED 2026-11-11): with item_text_edit ON, the save (edit-catalog-handler) and the owner's
// publishEdited fold the extras CONSEQUENCES into the token-bound diff; a manager's catalogRequestPublish must recompute the SAME diff,
// or its token never re-matches (409 edit_superseded) on a draft whose category move changes which extras a product takes.
// Real writers end to end on one Firestore fake: the REAL save mints the token; the REAL request and the REAL owner publish verify it.
// The switch is driven through a mutable stub (as test/item-s3-rename.emulator.test.js does). Run: node catalog/publish-request-consequences.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'p'.repeat(32);
const SWITCH = { enabled: true };
{ const p = require.resolve('./item-text-edit'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { textEditCapabilities: () => ({ enabled: SWITCH.enabled }) } }; }
const { createFakeDb } = require('../merchant/_fake-db');
const { makeDb } = require('./firestore-fake');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
const { editCatalogCore } = require('./edit-catalog-handler');
const { publishEditedCore } = require('./publish-edited-handler');
const PR = require('./publish-request');
// the PRODUCTION precondition decoder, evaluated from its own source (portal/functions.js decodeUpdateTimeForEdit; not exported, and
// requiring the deployed entry would initialize the Admin app) — the save gets exactly what production passes, and the fake accepts
// only a real Timestamp, so this harness is never laxer than production
const PROD_DECODE = (() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../portal/functions.js'), 'utf8');
  const m = src.match(/function decodeUpdateTimeForEdit\(v\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'premise: portal/functions.js still defines decodeUpdateTimeForEdit');
  return new Function('FirestoreTimestamp', `${m[0]}; return decodeUpdateTimeForEdit;`)(require('firebase-admin/firestore').Timestamp);
})();

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const FISCAL = 'x_pizza';   // the platform-factura location (data: factura/eligibility) — the only brand a manager REQUESTS on
const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const rtdb = () => createFakeDb({
  brands: { [FISCAL]: legacy(FISCAL) },
  restaurants: { [FISCAL]: { identity: { name: 'Fiscal' } } },
  brand_members: { [FISCAL]: { owners: { ownerA: { granted_at: 1 } }, managers: { [FISCAL]: { mgrOn01: { granted_at: 1 } } },
    manager_perms: { mgrOn01: { can_edit_menu: true } }, profiles: { mgrOn01: { name: 'Dania Reyes', email: 'dania@m.hn' } } } },
});
const as = (uid) => ({ uid, token: {} });
const owner = async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' });

// a live store whose 'ny' category takes FEWER extra groups than 'individual' (data, both sides), so moving a pizza there LOSES groups
function world() {
  const fs = makeDb();
  const live = buildSourceFromCode(FISCAL);
  live.structure.exposure.category_allow.ny = ['Salsas & Queso'];
  const meta = (id) => fs.collection('restaurants').doc(FISCAL).collection('meta').doc(id);
  const L = buildSourceCandidate(FISCAL, live);
  // the production reader's shape (publish-request.js readActiveBuiltFrom): the built catalog + the extra RECORDS
  const readActiveBuilt = async () => ({ built: { ...L.built, extras: L.inputs.extras }, versionId: 'v1', extraRecords: L.built.extras });
  const ready = Promise.all([meta('source').set(live), meta('active_version').set({ version: 'v1', generation: 3 })]);
  const save = async (mutate) => {
    await ready;
    const { source, updateTime } = await PR.readDraftFrom(fs, FISCAL);
    const draft = JSON.parse(JSON.stringify(source)); mutate(draft);
    const r = await editCatalogCore({ db: fs, authorize: owner, readActiveBuilt, toPrecondition: PROD_DECODE }, { restaurantId: FISCAL, source: draft, baseSourceUpdateTime: updateTime }, {});
    assert.strictEqual(r.status, 200, `premise: the REAL save accepts the draft (${JSON.stringify(r.body).slice(0, 200)})`);
    return r.body;
  };
  const request = (token) => PR.requestPublishCore({ fs, db: rtdb(), now: () => 5000, readActiveBuilt, readDraft: (rid) => PR.readDraftFrom(fs, rid) }, as('mgrOn01'), { restaurantId: FISCAL, token });
  const ownerPublish = async (token) => {
    const { source, updateTime } = await PR.readDraftFrom(fs, FISCAL);
    return publishEditedCore({ db: {}, authorize: owner, readActiveBuilt, readDraft: async () => ({ source, updateTime }),
      publishVersion: async (_db, _r, input) => ({ versionId: 'v2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }) },
    { restaurantId: FISCAL, token, fiscalAck: true }, {});
  };
  const slot = async () => { const s = await PR.requestRefOf(fs, FISCAL).get(); return s.exists ? s.data() : null; };
  return { fs, live, save, request, ownerPublish, slot, ready, meta };
}
const moveToNy = (...keys) => (d) => { for (const k of keys) d.items.find((i) => i.key === k).display.cat = 'ny'; };

(async () => {
  await cell('MRC-CONSEQUENCE-REQUEST', async (L) => {
    SWITCH.enabled = true;
    const w = world();
    const saved = await w.save(moveToNy('Carnivora'));
    assert.ok(Array.isArray(saved.diff.consequences) && saved.diff.consequences.length > 0, `${L}: premise — the save's reviewed diff carries extras consequences (${JSON.stringify(saved.diff.consequences)})`);
    const r = await w.request(saved.token);
    assert.deepStrictEqual([r.status, r.body.ok], [200, true], `${L}: a manager's request with the save's token is accepted (got ${JSON.stringify(r)})`);
    const s = await w.slot();
    assert.ok(s && s.by === 'mgrOn01' && s.counts.changed === saved.diff.changed.length, `${L}: the request is recorded with the reviewed counts (${JSON.stringify(s && s.counts)})`);
  });

  await cell('MRC-OFF-UNCHANGED', async (L) => {
    // switch OFF: the save cannot make a text edit, so the consequence-bearing draft is written as a draft and its token minted the
    // pre-switch way (catalogDiff only, no fold) — the request must verify it exactly as before the fix
    SWITCH.enabled = false;
    const w = world(); await w.ready;
    const { source } = await PR.readDraftFrom(w.fs, FISCAL);
    const draft = JSON.parse(JSON.stringify(source)); moveToNy('Carnivora')(draft);
    await w.meta('source').set(draft);
    const { source: stored, updateTime } = await PR.readDraftFrom(w.fs, FISCAL);
    const live = buildSourceCandidate(FISCAL, w.live); const d = buildSourceCandidate(FISCAL, stored);
    const diff = catalogDiff({ ...live.built, extras: live.inputs.extras }, { ...d.built, extras: d.inputs.extras });
    const token = issueEditToken({ rid: FISCAL, baseActiveVersionId: 'v1', sourceUpdateTime: updateTime, sourceHash: sha256(stored), diff });
    const r = await w.request(token);
    assert.deepStrictEqual([r.status, r.body.ok], [200, true], `${L}: with the switch OFF the request folds nothing and verifies the plain diff (got ${JSON.stringify(r)})`);
    SWITCH.enabled = true;
  });

  await cell('MRC-PARITY', async (L) => {
    SWITCH.enabled = true;
    for (const [label, mutate, want] of [
      ['no consequence (a price change)', (dd) => { dd.items[0].price += 10; dd.items[0].display.price = dd.items[0].price; }, 0],
      ['one consequence', moveToNy('Carnivora'), 1],
      ['several consequences', moveToNy('Carnivora', 'Margherita', 'Pepperoni'), 3],
    ]) {
      const w = world();
      const saved = await w.save(mutate);
      assert.strictEqual((saved.diff.consequences || []).length, want, `${L}: ${label} — premise: ${want} consequence(s) in the save's diff (${JSON.stringify(saved.diff.consequences)})`);
      const r = await w.request(saved.token);
      assert.strictEqual(r.status, 200, `${L}: ${label} — the manager's recompute equals the save's (got ${JSON.stringify(r)})`);
      const p = await w.ownerPublish(saved.token);
      assert.strictEqual(p.status, 200, `${L}: ${label} — the owner publish's recompute equals the save's (got ${JSON.stringify(p.body).slice(0, 200)})`);
    }
  });

  await cell('MRC-HELPER-PURE', (L) => {
    const { withConsequences } = require('./extras-consequences');
    const live = buildSourceFromCode(FISCAL); live.structure.exposure.category_allow.ny = ['Salsas & Queso'];
    const draft = JSON.parse(JSON.stringify(live)); moveToNy('Carnivora')(draft);
    const Lv = buildSourceCandidate(FISCAL, live); const Dr = buildSourceCandidate(FISCAL, draft);
    const input = { added: [], removed: [], renamed: [], changed: [] }; const frozen = JSON.stringify(input);
    const out = withConsequences(input, { live: Lv.built, liveExtraRecords: Lv.built.extras, draftBuilt: { ...Dr.built, extras: Dr.inputs.extras }, draftExtraRecords: Dr.built.extras });
    assert.strictEqual(JSON.stringify(input), frozen, `${L}: the input diff is not mutated`);
    assert.ok(out !== input && Array.isArray(out.consequences) && out.consequences.length === 1, `${L}: a NEW diff carries the consequences (${JSON.stringify(out.consequences)})`);
  });

  if (fails.length) { console.log(`FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`OK (${n})`);
})();
