'use strict';
// S3 r1 (PLAN-5f-inicio-s3-pending-rebase-r0 + owner 11-23 «Tenés cambios sin publicar», NO number + the 11-24 per-catalog carry) —
// has_pending per branch: true exactly when «Revisar y publicar» would draw lines for the SAVED draft (the shared review line model,
// catalog/review-lines.js = the portal's bytes), recorded by the REAL save (editCatalogCore) and the REAL owner publish
// (publishEditedCore) beside the draft, served on getMyBranches per CATALOG id (= the branch's brand_id; founders: brand == rid) only
// while FRESH; anything unknown ⇒ null. Real handlers on one Firestore fake (test/_s2core-harness.js). Run: node catalog/pending-summary.test.js
const assert = require('assert');
const H = require('../test/_s2core-harness');
const PS = { ...require('./pending-summary'), ...require('./pending-answer') };
const RL = require('./review-lines');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const meta = (fs, rid, id) => fs.collection('restaurants').doc(rid).collection('meta').doc(id);
const dishes = (d) => d.items.filter((i) => i.display && i.display.variantOf == null);
const reprice = (d, n0 = 3, by = 7) => { for (const it of dishes(d).slice(0, n0)) { it.price += by; it.display.price = it.price; } };
const capture = async (fn) => { const got = []; const w = console.warn, e = console.error, l = console.log; console.warn = (...a) => got.push(['warn', ...a]); console.error = (...a) => got.push(['error', ...a]); console.log = (...a) => got.push(['log', ...a]); try { await fn(); } finally { console.warn = w; console.error = e; console.log = l; } return got; };

// getMyBranches over a third brand with TWO branches (an `on` brand: its catalog lives at the brand id — the 11-24 carry)
async function branchesWorld() {
  const { createFakeDb } = require('../merchant/_fake-db'); const R = require('../access/roster');
  const fake = createFakeDb({ brands: { tb: { name: 'Tercera', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: { tb_centro: { identity: { brand_id: 'tb', name: 'Centro', active: true, prep_default_min: 20, version: 1 } }, tb_sur: { identity: { brand_id: 'tb', name: 'Sur', active: true, prep_default_min: 25, version: 1 } } } });
  const op = (o) => R.mutateRoster({ db: fake, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, o);
  await op({ type: 'bootstrap_owner', uid: 'ownerT1', profile: { name: 'Dueña', email: 'd@tb.hn' } });
  await op({ type: 'grant_manager', uid: 'mgrNoMenu', rids: ['tb_centro'], can_edit_menu: false });
  const adminOf = (f) => ({ ref: (p) => { const r = f.ref(p); return { ...r, get: () => r.once() }; } });
  const call = (uid, fs) => require('../portal/ops-core').getMyBranchesCore({ db: adminOf(fake), ...(fs === undefined ? {} : { fs }), verifyIdToken: async () => ({ uid }), now: () => Date.UTC(2026, 9, 20, 15), log: { warn() {}, log() {}, error() {} } },
    { method: 'GET', get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });
  return { call };
}
async function seededCatalog(catalogId, pending) {
  const fs = require('./firestore-fake').makeDb();
  const src = meta(fs, catalogId, 'source');
  await src.set({ v: 1 }); await meta(fs, catalogId, 'active_version').set({ version: 'v5', generation: 5 });
  await PS.record(fs, catalogId, { pending, sourceUpdateTime: PS.encodeUpdateTime((await src.get()).updateTime), baseActiveVersion: 'v5' });
  return fs;
}
const rowsOf = (out) => Object.fromEntries(out.body.branches.map((b) => [b.rid, Object.prototype.hasOwnProperty.call(b, 'has_pending') ? b.has_pending : 'absent']));

(async () => {
  H.SW.extrasCatalog = true;
  await cell('PS-PARITY: the self-contained paths and updateTime encoding are the store\'s own (source-store / catalog-firestore)', (L) => {
    const { makeDb } = require('./firestore-fake'); const { Timestamp } = require('firebase-admin/firestore');
    const SS = require('./source-store'); const CF = require('./catalog-firestore'); const fs = makeDb();
    assert.strictEqual(PS.sourceRefOf(fs, 'tb').path, SS.sourceRefOf(fs, 'tb').path, `${L}: source`);
    assert.strictEqual(PS.activePointerRef(fs, 'tb').path, CF.activePointerRef(fs, 'tb').path, `${L}: pointer`);
    for (const t of [new Timestamp(1757000000, 0), new Timestamp(1757000001, 5), new Timestamp(1, 999999999), null, 'x']) assert.strictEqual(PS.encodeUpdateTime(t), SS.encodeUpdateTime(t), `${L}: ${String(t)}`);
  });
  await cell('PS-CLASSIFY: every field of the REAL save diffs is known; an unknown top-level field ⇒ null (never a guess); a non-object ⇒ null', async (L) => {
    const w = H.world('la_musa');
    const r = await quiet(() => w.save((d) => { reprice(d, 2); dishes(d)[3].display.desc = 'Otra descripción'; }));
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    for (const k of Object.keys(r.body.diff)) assert.ok(PS.KNOWN_FIELDS.includes(k), `${L}: the real diff's «${k}» is classified`);
    assert.strictEqual(PS.pendingOf(r.body.diff, {}), true, `${L}: premise — lines ⇒ true`);
    assert.strictEqual(PS.pendingOf({ ...r.body.diff, brand_new_facet: [1] }, {}), null, `${L}: an unknown facet ⇒ null`);
    assert.strictEqual(PS.pendingOf({ ...r.body.diff, brand_new_facet: [1] }, {}), null, L);
    for (const bad of [null, [], 'x', 3]) assert.strictEqual(PS.pendingOf(bad, {}), null, `${L}: ${JSON.stringify(bad)}`);
  });
  await cell('PS-SAVE: the REAL save records has_pending of the diff it returns (the review model\'s, not a raw array sum); served while fresh', async (L) => {
    const w = H.world('la_musa');
    const r = await quiet(() => w.save((d) => reprice(d, 3)));
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(RL.hasPending(r.body.diff, {}), true, `${L}: premise`);
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), true, L);
  });
  await cell('PS-NET-ZERO: an edit undone by the next save (a price changed then restored) ⇒ has_pending false, exactly as the review draws nothing', async (L) => {
    const w = H.world('la_musa');
    await quiet(() => w.save((d) => reprice(d, 2, 7)));
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), true, `${L}: premise`);
    const r = await quiet(() => w.save((d) => reprice(d, 2, -7)));
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(RL.hasPending(r.body.diff, {}), false, `${L}: premise — the review draws nothing`);
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), false, L);
  });
  await cell('PS-STALE-SOURCE: the draft written by anything else after the save ⇒ null', async (L) => {
    const w = H.world('la_musa');
    await quiet(() => w.save((d) => reprice(d, 2)));
    const { source } = await w.draft(); await w.store(source);   // same body, a NEW updateTime
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), null, L);
  });
  await cell('PS-STALE-POINTER: a new live version (the pointer moved) after the save ⇒ null', async (L) => {
    const w = H.world('la_musa');
    await quiet(() => w.save((d) => reprice(d, 2)));
    await meta(w.fs, 'la_musa', 'active_version').set({ version: 'v9', generation: 9 });
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), null, L);
  });
  await cell('PS-PUBLISH: the REAL owner publish records the published draft vs what it published ⇒ false, fresh against the new pointer', async (L) => {
    const w = H.world('la_musa');
    await quiet(() => w.save((d) => reprice(d, 2)));
    const { token } = await w.tokenFor();
    const { source, updateTime } = await w.draft();
    const r = await quiet(() => require('./publish-edited-handler').publishEditedCore({
      db: w.fs, authorize: async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' }),
      readActiveBuilt: async () => ({ built: { ...w.L.built, extras: w.L.inputs.extras }, versionId: 'v1', extraRecords: w.L.built.extras }),
      readDraft: async () => ({ source, updateTime }),
      publishVersion: async () => { await meta(w.fs, 'la_musa', 'active_version').set({ version: 'v2', generation: 4 }); return { versionId: 'v2', item_count: 0, extra_count: 0 }; },
      addProduct: { syncKds: async () => ({ pending: false }) },
    }, { restaurantId: 'la_musa', token, fiscalAck: true, acknowledgedChanges: [] }, {}));
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), false, L);
  });
  await cell('PS-NO-SUMMARY: a draft never saved through the recorder (seeded) ⇒ null', async (L) => {
    const w = H.world('x_pizza'); await w.draft();
    assert.strictEqual(await PS.readHasPending(w.fs, 'x_pizza'), null, L);
  });
  await cell('PS-NO-BODY: the read takes the draft with an EMPTY field mask (its updateTime only), never its body', async (L) => {
    const w = H.world('la_musa'); await quiet(() => w.save((d) => reprice(d, 1)));
    const calls = []; const spy = { ...w.fs, collection: w.fs.collection, getAll: (...a) => { calls.push(a); return w.fs.getAll(...a); } };
    assert.strictEqual(await PS.readHasPending(spy, 'la_musa'), true, `${L}: premise`);
    const src = calls.find((a) => a.some((r) => r && r.path && r.path.endsWith('/meta/source')));
    assert.ok(src && src.length === 2 && JSON.stringify(src[1]) === JSON.stringify({ fieldMask: [] }), `${L}: ${JSON.stringify(calls.map((a) => a.map((x) => x.path || x)))}`);
  });
  await cell('PS-RECORD-UNKNOWN: an unknown pending at the save ⇒ no summary left behind (an older one is deleted) ⇒ null', async (L) => {
    const w = H.world('la_musa'); await quiet(() => w.save((d) => reprice(d, 2)));
    const { updateTime } = await w.draft();
    await PS.record(w.fs, 'la_musa', { pending: null, sourceUpdateTime: updateTime, baseActiveVersion: 'v1' }, { warn: () => {} });
    assert.strictEqual((await PS.summaryRefOf(w.fs, 'la_musa').get()).exists, false, L);
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), null, L);
  });
  await cell('PS-RECORD-LOG: a failed record logs {rid, code} only — never the error message (paths, doc data, a phone)', async (L) => {
    const err = Object.assign(new Error('PERMISSION: restaurants/la_musa/meta/pending_summary {"has_pending":true} +50499998888'), { code: 7 });
    const down = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: () => Promise.reject(err), delete: () => Promise.reject(err) }) }) }) }) };
    const got = await capture(() => PS.record(down, 'la_musa', { pending: true, sourceUpdateTime: '1.000000000', baseActiveVersion: 'v1' }));
    assert.deepStrictEqual(got, [['warn', 'pending_summary_record_failed', JSON.stringify({ rid: 'la_musa', code: '7' })]], L);
    const noCode = await capture(() => PS.record({ collection: () => { throw new Error('boom +50499998888'); } }, 'la_musa', { pending: false, sourceUpdateTime: '1.000000000', baseActiveVersion: 'v1' }));
    assert.deepStrictEqual(noCode, [['warn', 'pending_summary_record_failed', JSON.stringify({ rid: 'la_musa', code: 'unknown' })]], `${L}: no code ⇒ 'unknown'`);
  });

  // getMyBranches — has_pending per branch for a role that can open the menu editor (catalog.read_editor), read at the branch's CATALOG
  // id (its brand_id): two branches of one brand serve the SAME value from the one brand draft; none to a role without the permission
  await cell('PS-BRANCHES: per catalog id — both branches of brand tb serve the brand draft\'s has_pending; a manager without the menu permission gets none; no Firestore handle ⇒ null', async (L) => {
    const { call } = await branchesWorld();
    for (const v of [true, false]) {
      const fs = await seededCatalog('tb', v);
      assert.deepStrictEqual(rowsOf(await call('ownerT1', fs)), { tb_centro: v, tb_sur: v }, `${L}: the owner, ${v}`);
      assert.deepStrictEqual(rowsOf(await call('mgrNoMenu', fs)), { tb_centro: 'absent' }, `${L}: a manager without the menu permission`);
    }
    const atBranch = await seededCatalog('tb_centro', true);   // a summary at a BRANCH rid is not the brand's catalog
    assert.deepStrictEqual(rowsOf(await call('ownerT1', atBranch)), { tb_centro: null, tb_sur: null }, `${L}: read at the brand id, never the branch rid`);
    assert.deepStrictEqual(rowsOf(await call('ownerT1')), { tb_centro: null, tb_sur: null }, `${L}: no Firestore handle`);
    const out = await call('ownerT1', await seededCatalog('tb', true));
    assert.ok(out.body.branches.every((b) => !Object.prototype.hasOwnProperty.call(b, 'pending_count')), `${L}: no pending_count is served (owner 11-23)`);
  });
  await cell('PS-BRANCHES-ISOLATED: a Firestore read that fails at runtime ⇒ getMyBranches still 200, every other field unchanged, has_pending null', async (L) => {
    const { call } = await branchesWorld();
    const good = await seededCatalog('tb', true);
    const ok = await call('ownerT1', good);
    assert.strictEqual(ok.status, 200, L);
    assert.deepStrictEqual(rowsOf(ok), { tb_centro: true, tb_sur: true }, `${L}: non-vacuity`);
    const nulled = (body) => ({ ...body, branches: body.branches.map((b) => ({ ...b, has_pending: null })) });
    const boom = () => { throw new Error('firestore down'); };
    const failing = {
      'getAll rejects': { ...good, collection: (...a) => good.collection(...a), getAll: () => Promise.reject(new Error('UNAVAILABLE')) },
      'getAll throws synchronously': { ...good, collection: (...a) => good.collection(...a), getAll: boom },
      'collection() throws': { collection: boom, getAll: boom },
    };
    for (const [k, fs] of Object.entries(failing)) {
      const out = await call('ownerT1', fs);
      assert.strictEqual(out.status, 200, `${L}: ${k} — status`);
      assert.deepStrictEqual(out.body, nulled(ok.body), `${L}: ${k} — the branch list intact, has_pending null`);
    }
  });
  await cell('PS-READ-LOG: a failed read logs «getMyBranches: pending_summary read failed» with {rid: catalog id, code} only — ONE line per catalog; a working read is silent', async (L) => {
    const { call } = await branchesWorld();
    const good = await seededCatalog('tb', true);
    assert.deepStrictEqual(await capture(() => call('ownerT1', good)), [], `${L}: a working read logs nothing`);
    const err = Object.assign(new Error('UNAVAILABLE: restaurants/tb/meta/pending_summary {"has_pending":true}'), { code: 14 });
    const got = await capture(() => call('ownerT1', { ...good, collection: (...a) => good.collection(...a), getAll: () => Promise.reject(err) }));
    assert.deepStrictEqual(got, [['warn', 'getMyBranches: pending_summary read failed', JSON.stringify({ rid: 'tb', code: '14' })]], `${L}: one line for the one catalog, code + id only`);
  });
  await cell('PS-NO-COUNT-READ: nothing in the functions tree reads (code, not comments) pending_count / a summary count outside this module and its tests', (L) => {
    const path = require('path'); const fs = require('fs'); const root = path.join(__dirname, '..', '..');
    const hits = []; const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');   // a comment that NAMES the field is not a reader
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name) && !/pending-summary(\.test)?\.js$|pending-review-parity\.test\.mjs$/.test(e.name) && /\.pending_count\b|\[['"`]pending_count['"`]\]|\bpending_count\s*:|source_summary/.test(codeOnly(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(root, p)); } };
    for (const d of ['xpizza-functions']) walk(path.join(root, d));
    assert.deepStrictEqual(hits, [], L);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`pending-summary: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
