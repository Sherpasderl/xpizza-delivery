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
  await cell('PS-STRUCTURE-ONLY: a change the review draws ONLY as an «Estructura» row (the extras groups reordered: no added / removed / changed line) ⇒ true', async (L) => {
    const w = H.world('la_musa');
    const r = await quiet(() => w.save((d) => { const ec = d.structure.extra_categories; assert.ok(Array.isArray(ec) && ec.length >= 2, `${L}: premise — two extras groups`); d.structure.extra_categories = [...ec].reverse(); }));
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const raw = ['added', 'removed', 'renamed', 'changed', 'attachments', 'extras', 'choices'].reduce((n, k) => n + (Array.isArray(r.body.diff[k]) ? r.body.diff[k].length : 0), 0);
    assert.strictEqual(raw, 0, `${L}: premise — no line array carries it (${Object.keys(r.body.diff).join(',')})`);
    assert.ok(r.body.diff.structure, `${L}: premise — the structure facet`);
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa'), true, L);
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
  // S3 r2 (Codex #393): the summary is OPTIONAL — its computation, its write and its read never change, delay past a short bound, or
  // fail the response the handler gave before S3 (P1-1 a throwing computation at publish, P1-2 a stalled / rejected write, P2-3 a stalled read)
  const BOUND = PS.SUMMARY_WAIT_MS;
  const NEVER = () => new Promise(() => {});
  // patch THIS world's fake in place (the handlers hold the same object): the pending_summary doc's set / delete behave as `how` says
  const summaryWrites = (fs, how) => {
    const col0 = fs.collection.bind(fs);
    const wrap = (o) => new Proxy(o, { get(t, k) {
      const v = t[k];
      if (k === 'collection' || k === 'doc') return (...a) => { const r = v.apply(t, a); if (k === 'doc' && a[0] === 'pending_summary') return new Proxy(r, { get(t2, k2) { if (k2 === 'set' || k2 === 'delete') return () => how(); const v2 = t2[k2]; return typeof v2 === 'function' ? v2.bind(t2) : v2; } }); return wrap(r); };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    fs.collection = (...a) => wrap(col0(...a));
  };
  const steady = (body) => { const o = { ...body }; for (const k of ['token', 'updateTime', 'sourceUpdateTime']) delete o[k]; return o; };
  // a watchdog keeps the loop alive and fails AT the cell: a stalled await leaves no pending handle, so node would otherwise exit 0 mid-file
  const WATCH = BOUND + 3000;
  const watched = (p) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`still waiting after ${WATCH} ms`)), WATCH); })]).finally(() => clearTimeout(t)); };
  // console is silenced and RESTORED around the watched race (quiet() restores only when fn settles, which a stall never does)
  const timed = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; const t0 = Date.now(); try { const r = await watched(fn()); return { r, ms: Date.now() - t0 }; } finally { console.log = l; console.warn = w; } };
  const publishVia = async (w, { kds } = {}) => {
    await quiet(() => w.save((d) => reprice(d, 2)));
    const { token } = await w.tokenFor(); const { source, updateTime } = await w.draft();
    return require('./publish-edited-handler').publishEditedCore({
      db: w.fs, authorize: async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' }),
      readActiveBuilt: async () => ({ built: { ...w.L.built, extras: w.L.inputs.extras }, versionId: 'v1', extraRecords: w.L.built.extras }),
      readDraft: async () => ({ source, updateTime }),
      publishVersion: async () => { await meta(w.fs, 'la_musa', 'active_version').set({ version: 'v2', generation: 4 }); return { versionId: 'v2', item_count: 0, extra_count: 0 }; },
      addProduct: { syncKds: async () => { if (kds) kds.n += 1; return { pending: false }; } },
    }, { restaurantId: 'la_musa', token, fiscalAck: true, acknowledgedChanges: [] }, {});
  };
  await cell('PS-PUBLISH-COMPUTE-THROWS: the summary\'s own review diff throwing AFTER the publish ⇒ the original 200 (same body) and the KDS sync still runs', async (L) => {
    const RD = require('./review-diff'); const orig = RD.reviewDiff;
    let calls = 0; RD.reviewDiff = (...a) => { calls += 1; return orig(...a); };
    const k0 = { n: 0 }; let base;
    try { base = await quiet(() => publishVia(H.world('la_musa'), { kds: k0 })); } finally { RD.reviewDiff = orig; }
    const perPublish = calls; calls = 0;
    assert.strictEqual(base.status, 200, `${L}: premise, baseline 200`); assert.strictEqual(k0.n, 1, `${L}: premise, KDS runs`);
    const w = H.world('la_musa'); const k1 = { n: 0 }; let r;
    RD.reviewDiff = (...a) => { calls += 1; if (calls === perPublish) throw new Error('summary diff boom'); return orig(...a); };   // the LAST diff call of the publish = the summary's (the save before it has its own)
    try { r = await quiet(() => publishVia(w, { kds: k1 })); } finally { RD.reviewDiff = orig; }
    assert.strictEqual(calls, perPublish, `${L}: premise, the injected (last) call was reached`);
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.deepStrictEqual(steady(r.body), steady(base.body), `${L}: the original body`);
    assert.strictEqual(k1.n, 1, `${L}: the KDS sync still runs`);
    assert.strictEqual(await PS.readHasPending(w.fs, 'la_musa', { warn() {} }), null, `${L}: no summary ⇒ null`);
  });
  for (const [what, how] of [['stalls', NEVER], ['rejects', () => Promise.reject(Object.assign(new Error('DEADLINE restaurants/la_musa'), { code: 4 }))]]) {
    await cell(`PS-SAVE-WRITE-${what.toUpperCase()}: the summary write ${what} ⇒ the save answers its original response within the bound`, async (L) => {
      const base = await quiet(() => H.world('la_musa').save((d) => reprice(d, 3)));
      const w = H.world('la_musa'); summaryWrites(w.fs, how);
      const { r, ms } = await timed(() => w.save((d) => reprice(d, 3)));
      assert.strictEqual(r.status, base.status, `${L}: status`);
      assert.deepStrictEqual(steady(r.body), steady(base.body), `${L}: the original body`);
      assert.ok(ms < BOUND + 1000, `${L}: answered in ${ms} ms (bound ${BOUND})`);
    });
    await cell(`PS-PUBLISH-WRITE-${what.toUpperCase()}: the summary write ${what} after the publish ⇒ the original 200 within the bound, KDS runs`, async (L) => {
      const base = await quiet(() => publishVia(H.world('la_musa')));
      const w = H.world('la_musa'); const k = { n: 0 };
      await quiet(() => w.save((d) => reprice(d, 2)));   // seed then stall: the save before the publish records normally
      summaryWrites(w.fs, how);
      const { r, ms } = await timed(async () => {
        const { token } = await w.tokenFor(); const { source, updateTime } = await w.draft();
        return require('./publish-edited-handler').publishEditedCore({
          db: w.fs, authorize: async () => ({ ok: true, uid: 'ownerA', role: 'owner', actor: 'o@x.hn' }),
          readActiveBuilt: async () => ({ built: { ...w.L.built, extras: w.L.inputs.extras }, versionId: 'v1', extraRecords: w.L.built.extras }),
          readDraft: async () => ({ source, updateTime }),
          publishVersion: async () => { await meta(w.fs, 'la_musa', 'active_version').set({ version: 'v2', generation: 4 }); return { versionId: 'v2', item_count: 0, extra_count: 0 }; },
          addProduct: { syncKds: async () => { k.n += 1; return { pending: false }; } },
        }, { restaurantId: 'la_musa', token, fiscalAck: true, acknowledgedChanges: [] }, {});
      });
      assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.deepStrictEqual(steady(r.body), steady(base.body), `${L}: the original body`);
      assert.strictEqual(k.n, 1, `${L}: KDS runs`);
      assert.ok(ms < BOUND + 1000, `${L}: answered in ${ms} ms (bound ${BOUND})`);
    });
  }
  await cell('PS-RECORD-LATE: a write that settles AFTER the bound — late success or late rejection — logs one timeout line {rid, code:"timeout"}, never an unhandled rejection', async (L) => {
    const unhandled = []; const on = (e) => unhandled.push(e); process.on('unhandledRejection', on);
    try {
      for (const late of [() => new Promise((res) => setTimeout(res, BOUND + 200)), () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('late +50499998888'), { code: 4 })), BOUND + 200))]) {
        const fs = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: late, delete: late }) }) }) }) };
        const got = await capture(() => watched(PS.recordAfter(fs, 'la_musa', () => ({ pending: true, sourceUpdateTime: '1.000000000', baseActiveVersion: 'v1' }))));
        assert.deepStrictEqual(got, [['warn', 'pending_summary_record_failed', JSON.stringify({ rid: 'la_musa', code: 'timeout' })]], `${L}: one line at the bound`);
        await new Promise((res) => setTimeout(res, 400));
      }
      assert.deepStrictEqual(unhandled, [], `${L}: no unhandled rejection after settling`);
    } finally { process.off('unhandledRejection', on); }
  });
  await cell('PS-BRANCHES-STALLED-READ: a summary read that never answers ⇒ getMyBranches answers within the bound, every other field unchanged, has_pending null, one timeout line', async (L) => {
    const { call } = await branchesWorld();
    const good = await seededCatalog('tb', true);
    const ok = await call('ownerT1', good);
    const t0 = Date.now(); let out;
    const got = await capture(async () => { out = await watched(call('ownerT1', { ...good, collection: (...a) => good.collection(...a), getAll: NEVER })); });
    const ms = Date.now() - t0;
    assert.strictEqual(out.status, 200, L);
    assert.deepStrictEqual(out.body, { ...ok.body, branches: ok.body.branches.map((b) => ({ ...b, has_pending: null })) }, `${L}: the list intact, has_pending null`);
    assert.ok(ms < BOUND + 1000, `${L}: answered in ${ms} ms (bound ${BOUND})`);
    assert.deepStrictEqual(got, [['warn', 'getMyBranches: pending_summary read failed', JSON.stringify({ rid: 'tb', code: 'timeout' })]], `${L}: one line per catalog`);
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
