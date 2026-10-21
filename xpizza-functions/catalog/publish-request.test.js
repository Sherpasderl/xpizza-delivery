'use strict';
// PLAN-portal-team-invites r1 §2 G3 — «Enviar al dueño para publicar»: who may send (the facts, codex plan r1 P1-1), the ONE
// Firestore transaction that binds the slot to the draft + pointer it was verified against (P1-2), the DERIVED freshness
// (fresh / draft_changed / published, incl. the pointer flip-back ABA through the monotonic generation), and the owner-only
// read in getEditableCatalog. The publish / reset paths are not touched (no delete), so they are not exercised here.
const test = require('node:test');
const assert = require('node:assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'p'.repeat(32);
const { createFakeDb } = require('../merchant/_fake-db');
const { makeDb } = require('./firestore-fake');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, sourceRefOf } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { buildSourceCandidate } = require('./candidate-validate');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
const { getActiveVersionId } = require('./catalog-firestore');
const { getEditableCatalogCore } = require('./portal-reads');
const PR = require('./publish-request');

const FISCAL = 'x_pizza';   // the platform-factura location (data: factura/eligibility FACTURA_PLATFORM_RESTAURANTS)
const PLAIN = 'la_musa';
const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const rtdb = () => createFakeDb({
  brands: { [FISCAL]: legacy(FISCAL), [PLAIN]: legacy(PLAIN) },
  restaurants: { [FISCAL]: { identity: { name: 'Fiscal' }, kitchen_staff: { staff01: true } }, [PLAIN]: { identity: { name: 'Plain' } } },
  brand_members: {
    [FISCAL]: { owners: { ownerA: { granted_at: 1 } },
      managers: { [FISCAL]: { mgrOn01: { granted_at: 1 }, mgrOff01: { granted_at: 1 }, mgrDsp01: { granted_at: 1 } } },
      manager_perms: { mgrOn01: { can_edit_menu: true }, mgrOff01: { can_edit_menu: false }, mgrDsp01: { can_edit_menu: true } },
      profiles: { mgrOn01: { name: 'Dania Reyes', email: 'dania@m.hn' } } },
    [PLAIN]: { owners: { ownerB: { granted_at: 1 } }, managers: { [PLAIN]: { mgrPl01: { granted_at: 1 } } }, manager_perms: { mgrPl01: { can_edit_menu: true } } },
  },
  dispatchers: { disp01: true, mgrDsp01: true },
});
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const meta = (fs, rid, id) => fs.collection('restaurants').doc(rid).collection('meta').doc(id);
const setSource = (fs, rid, d) => meta(fs, rid, 'source').set(d);
const setPtr = (fs, rid, p) => meta(fs, rid, 'active_version').set(p);

// a store with a live version v1 (generation 3) and a draft with one modest price change; a token for exactly that draft
function store(rid = FISCAL) {
  const fs = makeDb();
  const live = buildSourceFromCode(rid);
  const draft = JSON.parse(JSON.stringify(live)); draft.items[0].price += 1; draft.items[0].display.price = draft.items[0].price;
  setSource(fs, rid, draft);
  setPtr(fs, rid, { version: 'v1', generation: 3 });
  const liveBuilt = builtOf(live, rid);
  const deps = (db) => ({ fs, db, now: () => 5000,
    readActiveBuilt: async () => ({ built: liveBuilt, versionId: await getActiveVersionId(fs, rid) }),
    readDraft: (r) => PR.readDraftFrom(fs, r) });
  const tokenFor = async () => {
    const { source, updateTime } = await PR.readDraftFrom(fs, rid);
    const { inputs, built } = buildSourceCandidate(rid, source);
    const diff = catalogDiff(liveBuilt, { ...built, extras: inputs.extras });
    return issueEditToken({ rid, baseActiveVersionId: await getActiveVersionId(fs, rid), sourceUpdateTime: updateTime, sourceHash: sha256(source), diff });
  };
  return { fs, deps, tokenFor, live, draft };
}
const as = (uid, token = {}) => ({ uid, token: { name: 'TOKEN NAME (never used)', ...token } });
const slotOf = async (fs, rid = FISCAL) => { const s = await PR.requestRefOf(fs, rid).get(); return s.exists ? s.data() : null; };

test('WHO (codex P1-1): only a manager grant + menu permission on a factura brand; owner / non-factura → 409; everyone else → 403', async () => {
  const db = rtdb();
  const S = store();
  const token = await S.tokenFor();
  const call = (uid, rid = FISCAL, extra) => PR.requestPublishCore(S.deps(db), as(uid, extra), { restaurantId: rid, token });
  assert.deepStrictEqual((await call('ownerA')).status, 409, 'the owner publishes directly');
  assert.strictEqual((await call('ownerA')).body.error, 'not_applicable');
  assert.deepStrictEqual(await call('mgrPl01', PLAIN), { status: 409, body: { error: 'not_applicable', detail: 'this brand publishes without the owner' } }, 'a non-factura brand: the manager publishes directly');
  for (const uid of ['mgrOff01', 'disp01', 'staff01', 'nobody01']) assert.deepStrictEqual(await call(uid), { status: 403, body: { error: 'forbidden' } }, `${uid} (catalog.publish alone is never enough)`);
  assert.deepStrictEqual(await call('mgrOn01', FISCAL, { customer: true }), { status: 403, body: { error: 'forbidden' } }, 'a customer token');
  assert.deepStrictEqual(await call('mgrOn01', FISCAL, { handheld: true }), { status: 403, body: { error: 'forbidden' } }, 'a handheld token');
  assert.strictEqual(await slotOf(S.fs), null, 'no refusal wrote anything');
  const ok = await call('mgrDsp01');
  assert.strictEqual(ok.status, 200, 'a permitted manager who is ALSO a dispatcher still sends');
  const r = await call('mgrOn01');
  assert.deepStrictEqual(r, { status: 200, body: { ok: true, counts: { changed: 1, added: 0, removed: 0, large: 0 } } });
  const slot = await slotOf(S.fs);
  assert.strictEqual(slot.by, 'mgrOn01'); assert.strictEqual(slot.name, 'Dania Reyes', 'the name comes from the SERVER profile, never the token'); assert.strictEqual(slot.base_active_version, 'v1');
  assert.strictEqual(slot.base_generation, 3, 'the pointer generation read INSIDE the transaction');
  assert.strictEqual(slot.source_hash, sha256((await PR.readDraftFrom(S.fs, FISCAL)).source));
});

test('FRESHNESS (codex P1-2): a stale token is refused; a draft that moves between the verify and the transaction is refused (raced); nothing written', async () => {
  const db = rtdb();
  const S = store();
  const old = await S.tokenFor();
  const d2 = JSON.parse(JSON.stringify(S.draft)); d2.items[0].price += 1; d2.items[0].display.price = d2.items[0].price;
  setSource(S.fs, FISCAL, d2);
  assert.deepStrictEqual(await PR.requestPublishCore(S.deps(db), as('mgrOn01'), { restaurantId: FISCAL, token: old }), { status: 409, body: { error: 'edit_superseded', reason: 'token_mismatch' } });
  const fresh = await S.tokenFor();
  // the race: the draft is rewritten AFTER the core read it (the verify passes) and BEFORE its transaction re-reads it
  const raced = S.deps(db);
  const readDraft = raced.readDraft;
  raced.readDraft = async (r) => { const out = await readDraft(r); setSource(S.fs, FISCAL, d2); return out; };
  assert.deepStrictEqual(await PR.requestPublishCore(raced, as('mgrOn01'), { restaurantId: FISCAL, token: fresh }), { status: 409, body: { error: 'edit_superseded', reason: 'raced' } });
  // …and a pointer flip in the same window
  const flipped = S.deps(db);
  const tok3 = await S.tokenFor();
  const rd = flipped.readDraft;
  flipped.readDraft = async (r) => { const out = await rd(r); setPtr(S.fs, FISCAL, { version: 'v2', generation: 4 }); return out; };
  assert.deepStrictEqual(await PR.requestPublishCore(flipped, as('mgrOn01'), { restaurantId: FISCAL, token: tok3 }), { status: 409, body: { error: 'edit_superseded', reason: 'raced' } });
  assert.strictEqual(await slotOf(S.fs), null);
  assert.deepStrictEqual((await PR.requestPublishCore(S.deps(db), as('mgrOn01'), { restaurantId: FISCAL, token: 'x' })).status, 409);
  assert.deepStrictEqual(await PR.requestPublishCore(S.deps(db), as('mgrOn01'), { restaurantId: FISCAL }), { status: 400, body: { error: 'bad_request', detail: 'token is required' } });
});

test('requestState (pure): fresh / draft_changed / published (version OR generation moved — the flip-back ABA) / too old → null', () => {
  const slot = { at: 1000, base_active_version: 'v1', base_generation: 3, source_update_time: 't1', source_hash: 'h1' };
  const cur = { sourceUpdateTime: 't1', sourceHash: 'h1', activeVersionId: 'v1', generation: 3, now: 2000 };
  assert.strictEqual(PR.requestState(slot, cur), 'fresh');
  assert.strictEqual(PR.requestState(slot, { ...cur, sourceUpdateTime: 't2' }), 'draft_changed');
  assert.strictEqual(PR.requestState(slot, { ...cur, sourceHash: 'h2' }), 'draft_changed');
  assert.strictEqual(PR.requestState(slot, { ...cur, activeVersionId: 'v2', generation: 4 }), 'published');
  assert.strictEqual(PR.requestState(slot, { ...cur, generation: 5 }), 'published', '🔴 ABA: published v2 then rolled back to v1 — same version id, newer generation → never fresh again');
  assert.strictEqual(PR.requestState(slot, { ...cur, sourceUpdateTime: 't9', generation: 4, activeVersionId: 'v2' }), 'published', 'a flip wins over a later draft edit: the request was handled');
  assert.strictEqual(PR.requestState(slot, { ...cur, now: 1000 + PR.MAX_AGE_MS + 1 }), null);
  for (const bad of [null, {}, { ...slot, at: 'x' }]) assert.strictEqual(PR.requestState(bad, cur), null);
});

test('getEditableCatalog: ONLY the owner of a factura brand receives publish_request (fresh / draft_changed); a flip hides it; a read failure omits it', async () => {
  const db = rtdb();
  const S = store();
  await PR.requestPublishCore(S.deps(db), as('mgrOn01'), { restaurantId: FISCAL, token: await S.tokenFor() });
  const { authorizeCatalogEdit } = require('./catalog-edit-auth');
  const read = (uid, extra = {}) => getEditableCatalogCore({ db, fsdb: S.fs, readActiveVersionId: getActiveVersionId, now: () => 6000,
    authorize: (rid) => authorizeCatalogEdit({ db, verifyIdToken: async () => ({ uid }) }, { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer t' : undefined) }, rid), ...extra },
  { method: 'GET', query: { restaurantId: FISCAL } });
  const own = await read('ownerA');
  assert.strictEqual(own.status, 200);
  assert.deepStrictEqual(own.body.publish_request, { state: 'fresh', by_name: 'Dania Reyes', at: 5000, counts: { changed: 1, added: 0, removed: 0, large: 0 } });
  const mgr = await read('mgrOn01');
  assert.strictEqual(mgr.status, 200);
  assert.ok(!('publish_request' in mgr.body), 'the manager never receives it');
  // the draft moves on → draft_changed
  const d2 = JSON.parse(JSON.stringify(S.draft)); d2.items[1].price += 1; d2.items[1].display.price = d2.items[1].price;
  setSource(S.fs, FISCAL, d2);
  assert.strictEqual((await read('ownerA')).body.publish_request.state, 'draft_changed');
  // back to the requested content, but a flip happened (published, then rolled back to v1 at a newer generation) → hidden
  setSource(S.fs, FISCAL, S.draft);
  setPtr(S.fs, FISCAL, { version: 'v1', generation: 5 });
  const after = await read('ownerA');
  assert.ok(!('publish_request' in after.body), 'a request from before any flip never reads as pending again (ABA)');
  // a failed read of the slot omits the field; the editor still loads
  const failing = await read('ownerA', { _readPublishRequest: async () => { throw new Error('down'); } });
  assert.strictEqual(failing.status, 200); assert.ok(!('publish_request' in failing.body));
});

test('NOTHING TO PUBLISH + ABA (codex plan r2 P1-1): draft == active → refused; publish → rollback-to-A, and a reset after a publish, never revive a request', async () => {
  const db = rtdb();
  const S = store();
  setSource(S.fs, FISCAL, S.live);   // the draft equals what is serving
  assert.deepStrictEqual(await PR.requestPublishCore(S.deps(db), as('mgrOn01'), { restaurantId: FISCAL, token: await S.tokenFor() }), { status: 409, body: { error: 'nothing_to_publish' } });
  assert.strictEqual(await slotOf(S.fs), null);
  setSource(S.fs, FISCAL, S.draft);
  assert.strictEqual((await PR.requestPublishCore(S.deps(db), as('mgrOn01'), { restaurantId: FISCAL, token: await S.tokenFor() })).status, 200);
  const { authorizeCatalogEdit } = require('./catalog-edit-auth');
  const ownerView = async () => (await getEditableCatalogCore({ db, fsdb: S.fs, readActiveVersionId: getActiveVersionId, now: () => 6000,
    authorize: (rid) => authorizeCatalogEdit({ db, verifyIdToken: async () => ({ uid: 'ownerA' }) }, { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer t' : undefined) }, rid) },
  { method: 'GET', query: { restaurantId: FISCAL } })).body.publish_request;
  assert.strictEqual((await ownerView()).state, 'fresh');
  // publish (A → B, generation 4) then roll back to A (generation 5); the source is not rewritten (identities match)
  setPtr(S.fs, FISCAL, { version: 'v2', generation: 4 });
  assert.strictEqual(await ownerView(), undefined, 'published → hidden');
  setPtr(S.fs, FISCAL, { version: 'v1', generation: 5 });
  assert.strictEqual(await ownerView(), undefined, '🔴 rolled back to A: same version id, newer generation → still hidden (never fresh again)');
  // a no-op reset after the publish: the draft document is untouched (same updateTime) → still hidden
  assert.strictEqual(await ownerView(), undefined);
});
