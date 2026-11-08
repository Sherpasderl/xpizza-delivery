'use strict';
// F-1 (BRIEF-portal-stale-draft-clobber, ruled (a) 2026-11-07) — the platform-pending stamp, end to end on the fake Firestore with the
// REAL seed sources, the REAL reviewed migration data and the REAL writers: migrate-menu-structure --write (stamps), the REAL
// resetDraftToLiveCore (refuses / resets / clears) and the REAL getEditableCatalogCore (reports, read-only).
//   Cell A — the 11-02 sequence: the REAL --write output (draft ahead of live) ⇒ stamp; the reset REFUSES 409; the draft keeps them.
//   Cell B — case 2, a ROLLBACK: the draft differs from live with NO stamp ⇒ the reset still resets (no regression).
//   Cell C — a publish that makes live carry the fields CLEARS the stamp; a later rollback then resets normally.
//   + partial carry, a removed record, live-first (nothing stamped), malformed stamp (fails closed), outage (503, nothing written).
// The fake has no ref.update(); the reset uses update(data, { lastUpdateTime }) — added below with Firestore's semantics (a stale
// precondition REFUSES with code 9, a missing doc refuses, top-level fields replaced). Run: node catalog/platform-pending.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { sourceRefOf, readSource, encodeUpdateTime } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { migrateMenuStructure, publishMenuStructure } = require('../tools/migrate-menu-structure');
const CP = require('./catalog-publish');
const { buildSourceCandidate } = require('./candidate-validate');
const { getActiveVersionId } = require('./catalog-firestore');
const { resetDraftToLiveCore } = require('./reset-draft');
const { getEditableCatalogCore } = require('./portal-reads');
const PP = require('./platform-pending');
const { fakeRtdb } = require('../test/_fake-rtdb');
const CLI = require('../tools/platform-pending');
const DATA = require('../tools/migrations/2026-10-26-menu-structure.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('platform-pending: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const RIDS = ['la_musa', 'x_pizza'];

// the production store BEFORE the migration (same construction as tools/migrate-menu-structure.test.js)
function preMigration(rid, s) {
  const r = DATA.restaurants[rid] || {};
  for (const f of Object.keys(r.structure || {})) delete s.structure[f];
  for (const [coll, list] of [['items', s.items], ['extras', s.extras]]) {
    for (const [key, row] of Object.entries(r[coll] || {})) { const rec = list.find((x) => x.key === key); for (const f of Object.keys(row.display)) delete rec.display[f]; }
  }
  return s;
}
// ref.update with Firestore's semantics, on top of the fake (which models set / create / delete / transactions only)
function withUpdate(db) {
  const wrap = (node) => new Proxy(node, {
    get(t, k) {
      const v = t[k];
      if (k === 'collection' || k === 'doc') return (...a) => wrap(v.apply(t, a));
      if (k === 'update' && v === undefined && typeof t.path === 'string') {
        return async (data, opts) => {
          const cur = await t.get();
          if (!cur.exists) { const e = new Error('5 NOT_FOUND'); e.code = 5; throw e; }
          if (opts && opts.lastUpdateTime !== undefined && opts.lastUpdateTime !== encodeUpdateTime(cur.updateTime)) { const e = new Error('9 FAILED_PRECONDITION'); e.code = 9; throw e; }
          await t.set({ ...cur.data(), ...clone(data) });
          return { writeTime: (await t.get()).updateTime };
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return wrap(db);
}
const liveOf = (s) => ({ items: clone(s.items), extras: clone(s.extras), structure: clone(s.structure) });   // a source-shaped live
const owner = async () => ({ ok: true, uid: 'pp_owner', role: 'owner', actor: 'owner@x.hn', capabilities: undefined });
async function reset(db, rid, live, extra = {}) {
  const { revision } = await readSource(db, rid);
  return resetDraftToLiveCore({ db, authorize: owner, readActiveVersionId: async () => 'v-live', previewVersion: async () => clone(live), ...extra },
    { restaurantId: rid, expectedRevision: revision }, {});
}
async function editable(db, rid, live, extra = {}) {
  return getEditableCatalogCore({ db: {}, fsdb: db, authorize: owner, readActiveVersionId: async () => 'v-live',
    readActiveBuilt: async () => ({ built: { items: clone(live.items), structure: clone(live.structure), extras: [] }, versionId: 'v-live', extraRecords: clone(live.extras) }), ...extra },
    { method: 'GET', query: { restaurantId: rid } });
}
// a store where every rid's draft = the pre-migration seed, and LIVE (what the injected reader serves) = that same body
async function premigrated() {
  const db = withUpdate(makeDb());
  const live = {};
  for (const rid of RIDS) { const s = preMigration(rid, buildSourceFromCode(rid)); await sourceRefOf(db, rid).set(s); live[rid] = liveOf(s); }
  return { db, live };
}
const pendingDoc = async (db, rid) => { const s = await PP.pendingRefOf(db, rid).get(); return s.exists ? s.data() : null; };
// null-safe: a missing stamp fails the NAMED assertion, never a TypeError before it
const stampFields = async (db, rid, label = `${rid}: a stamp exists`) => { const d = await pendingDoc(db, rid); assert.ok(d && Array.isArray(d.fields), label); return d.fields; };

(async () => {
  // owner capabilities come from the ONE table; check the stub passes the real gates before relying on it
  {
    const { can } = require('../access/membership');
    const a = await owner();
    assert.ok(can(a, 'catalog.reset_draft') && can(a, 'catalog.read_editor'), 'premise: an owner auth passes the reset / read gates');
  }

  // ── Cell A: the 11-02 sequence through the REAL writers ──
  const { db, live } = await premigrated();
  const reports = await migrateMenuStructure(db, DATA, { write: true, readLive: async (_db, rid) => live[rid] });
  for (const r of reports) {
    assert.ok(r.written && r.added.length > 0, `premise: --write added fields to ${r.rid}`);
    assert.deepStrictEqual(r.stamped, r.added, `${r.rid}: live lacks every added field ⇒ every one is stamped`);
    const st = await pendingDoc(db, r.rid);
    assert.ok(st, `${r.rid}: the --write transaction wrote the platform-pending stamp`);
    assert.deepStrictEqual(st.fields, [...r.added].sort(), `${r.rid}: the stamp doc carries exactly the added paths`);
    assert.strictEqual(st.by, 'migrate-menu-structure');
  }
  for (const rid of RIDS) {
    const before = await readSource(db, rid);
    const res = await reset(db, rid, live[rid]);
    assert.deepStrictEqual([res.status, res.body.error], [409, 'platform_changes_pending'], `${rid}: the reset REFUSES while live lacks Sherpa's fields`);
    assert.deepStrictEqual(res.body.fields, (await stampFields(db, rid)), `${rid}: the refusal names the pending fields`);
    const after = await readSource(db, rid);
    assert.deepStrictEqual([after.revision, after.source], [before.revision, before.source], `${rid}: NOTHING written — the migrated draft is intact`);
    const ed = await editable(db, rid, live[rid]);
    assert.strictEqual(ed.status, 200);
    assert.deepStrictEqual(ed.body.platform_changes_pending, { fields: (await stampFields(db, rid)) }, `${rid}: getEditableCatalog reports it`);
    assert.ok(await pendingDoc(db, rid), `${rid}: getEditableCatalog is read-only — the stamp is still there`);
  }
  ok('A · the REAL --write output stamps every field live lacks (same transaction); the reset REFUSES 409 platform_changes_pending and writes nothing; getEditableCatalog reports it, read-only');

  // ── Cell C: a publish that makes live carry the fields clears the stamp; a LATER rollback then resets normally ──
  {
    const rid = 'x_pizza';
    const published = liveOf((await readSource(db, rid)).source);   // Sherpa publishes the migrated draft: live now carries them
    assert.ok(await pendingDoc(db, rid), 'premise: a STALE stamp — nobody resolved it yet');
    const ed = await editable(db, rid, published);
    assert.strictEqual(ed.body.platform_changes_pending, undefined, 'live carries them ⇒ not reported');
    assert.ok(await pendingDoc(db, rid), 'the lock is DERIVED (stamp ∧ gaps), not the stamp\u2019s mere presence: it is still there and locks nothing');
    const res = await reset(db, rid, published);
    assert.strictEqual(res.status, 200, `the reset proceeds once live carries them: ${JSON.stringify(res.body).slice(0, 160)}`);
    assert.strictEqual(await pendingDoc(db, rid), null, 'and the stamp is CLEARED (absent-only: every stamped field is carried)');
    const rolled = await reset(db, rid, live[rid]);   // live rolled back to the pre-migration body: an ordinary rollback recovery
    assert.strictEqual(rolled.status, 200, 'after the clear, a rollback resets like any other (no stale stamp dead-ends it)');
    assert.deepStrictEqual((await readSource(db, rid)).source.structure, live[rid].structure);
    // Sherpa's publish tools call the same resolver directly
    const { db: db2, live: live2 } = await premigrated();
    await migrateMenuStructure(db2, DATA, { write: true, readLive: async (_db, r) => live2[r] });
    const pub2 = liveOf((await readSource(db2, 'la_musa')).source);
    assert.deepStrictEqual(await PP.resolvePlatformPending(db2, 'la_musa', live2.la_musa), { pending: true, fields: (await stampFields(db2, 'la_musa')) });
    assert.deepStrictEqual(await PP.resolvePlatformPending(db2, 'la_musa', pub2), { pending: false, cleared: true });
    assert.strictEqual(await pendingDoc(db2, 'la_musa'), null);
  }
  ok('C · a publish that carries the fields clears the stamp (through the reset and through the resolver Sherpa\'s publish tools call); a later rollback resets normally');

  // ── Cell B: case 2, a ROLLBACK — the draft differs from live, no stamp ⇒ the reset still resets ──
  {
    const db3 = withUpdate(makeDb());
    const rid = 'la_musa';
    const newer = buildSourceFromCode(rid);                         // the draft carries the fields (it was published, then live rolled back)
    const older = liveOf(preMigration(rid, buildSourceFromCode(rid)));
    await sourceRefOf(db3, rid).set(newer);
    assert.strictEqual(await pendingDoc(db3, rid), null, 'premise: no stamp');
    assert.ok(PP.gapsIn(older, ['structure.badge_priority']).length === 1, 'premise: the draft differs from live exactly where the migration did');
    const res = await reset(db3, rid, older);
    assert.strictEqual(res.status, 200, 'RESETS — the difference alone never blocks the documented rollback recovery');
    assert.deepStrictEqual((await readSource(db3, rid)).source.structure, older.structure);
    const ed = await editable(db3, rid, older);
    assert.strictEqual(ed.body.platform_changes_pending, undefined);
  }
  ok('B · case 2: a draft ahead of a rolled-back live, with no stamp, still resets (no regression)');

  // ── partial carry · a removed record · live-first (nothing stamped) ──
  {
    const fields = ['structure.badge_priority', 'item[Nutella].display.extras_policy', 'item[Gone].display.reward_icon'];
    const lv = { structure: { badge_priority: [] }, items: [{ key: 'Nutella', display: {} }], extras: [] };
    assert.deepStrictEqual(PP.gapsIn(lv, fields), ['item[Nutella].display.extras_policy'], 'carried → no gap; absent → gap; record gone → no gap');
    assert.deepStrictEqual(PP.gapsIn({ ...lv, items: [{ key: 'Nutella', display: { extras_policy: 'all' } }] }, fields), [], 'ANY value carried counts (absent-only)');
    const { db: db4, live: live4 } = await premigrated();
    const r0 = await migrateMenuStructure(db4, DATA, { write: true, readLive: async (_db, rid) => liveOf(buildSourceFromCode(rid)) });   // live-first: live already carries all
    for (const r of r0) { assert.ok(r.written); assert.deepStrictEqual(r.stamped, []); assert.strictEqual(await pendingDoc(db4, r.rid), null, `${r.rid}: live-first ⇒ nothing stamped`); }
    void live4;
    // a second Sherpa write UNIONS with an unresolved stamp (nothing is forgotten)
    const db5 = withUpdate(makeDb());
    await db5.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db5, rid: 'x_pizza', by: 't1', fields: ['structure.a'] }); });
    await db5.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db5, rid: 'x_pizza', by: 't2', fields: ['structure.b'] }); });
    assert.deepStrictEqual((await stampFields(db5, 'x_pizza')), ['structure.a', 'structure.b']);
    await assert.rejects(db5.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db5, rid: 'x_pizza', by: 't', fields: ['items.0.price'] }); }), /platform_pending_bad_path/);
    await assert.rejects(db5.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db5, rid: 'x_pizza', fields: ['structure.c'] }); }), /platform_pending_by_required/);
  }
  ok('partial carry keeps only the remaining gaps; a record live removed is not a gap; live-first stamps nothing; stamps union; a bad path / no author refuses');

  // ── the clear never deletes a NEWER stamp (a Sherpa write landing between the evaluation and the clear) ──
  {
    const db7 = withUpdate(makeDb());
    await db7.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db7, rid: 'x_pizza', by: 't1', fields: ['structure.a'] }); });
    let injected = false;
    const racing = new Proxy(db7, { get(t, k) {
      if (k === 'runTransaction') return async (fn) => {
        if (!injected) { injected = true; await t.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: t, rid: 'x_pizza', by: 't2', fields: ['structure.z'] }); }); }
        return t.runTransaction(fn);
      };
      return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
    } });
    const r = await PP.resolvePlatformPending(racing, 'x_pizza', { structure: { a: 1 }, items: [], extras: [] });   // live carries the OLD stamp's field
    assert.ok(injected, 'non-vacuity: the newer stamp landed in between');
    assert.deepStrictEqual((await stampFields(db7, 'x_pizza')), ['structure.a', 'structure.z'], 'the newer stamp SURVIVES the clear');
    assert.deepStrictEqual(r, { pending: true, fields: ['structure.z'] }, 'and the answer is the NEWER stamp\'s: still pending');
    // Codex r1 P1-2: a replacement with the SAME paths is still a newer stamp (identified by its write time, not its fields)
    const db9 = withUpdate(makeDb());
    await db9.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db9, rid: 'x_pizza', by: 't1', fields: ['structure.a'] }); });
    let swapped = false;
    const samePath = new Proxy(db9, { get(t, k) {
      if (k === 'runTransaction') return async (fn) => {
        if (!swapped) { swapped = true; await PP.pendingRefOf(t, 'x_pizza').set({ v: 1, by: 't3', at: 9, fields: ['structure.a'] }); }
        return t.runTransaction(fn);
      };
      return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
    } });
    await PP.resolvePlatformPending(samePath, 'x_pizza', { structure: { a: 1 }, items: [], extras: [] });
    assert.ok(swapped, 'non-vacuity: the same-path replacement landed in between');
    const kept = await pendingDoc(db9, 'x_pizza');
    assert.ok(kept && kept.by === 't3', 'a same-path replacement stamp SURVIVES the clear (write time, not fields)');
  }
  ok('the clear deletes only the stamp it evaluated — a newer Sherpa stamp landing in between survives');

  // ── fail closed: a malformed stamp refuses; an unreadable stamp is a 503 with nothing written ──
  {
    const { db: db6, live: live6 } = await premigrated();
    await PP.pendingRefOf(db6, 'x_pizza').set({ v: 1, fields: 'nope' });
    const before = await readSource(db6, 'x_pizza');
    const rt = fakeRtdb();
    const alertMalformed = (rid) => PP.raiseMalformedAlert(rt, rid, 1111);
    const r = await reset(db6, 'x_pizza', live6.x_pizza, { alertMalformed });
    assert.deepStrictEqual([r.status, r.body.error], [409, 'platform_changes_pending'], 'a malformed stamp fails CLOSED');
    assert.strictEqual((await readSource(db6, 'x_pizza')).revision, before.revision);
    const alerts = () => Object.keys((rt.data && rt.data.dispatcher_alerts) || {});
    assert.deepStrictEqual(alerts(), ['platform_pending_malformed_x_pizza'], 'never silent: ONE owner alert, keyed by rid');
    // repeats (another refused reset, the portal's load) re-find it: still ONE, first-seen kept
    const rAgain = await reset(db6, 'x_pizza', live6.x_pizza, { alertMalformed: (rid) => PP.raiseMalformedAlert(rt, rid, 2222) });
    assert.strictEqual(rAgain.status, 409);
    const ed = await editable(db6, 'x_pizza', live6.x_pizza, { alertMalformed: (rid) => PP.raiseMalformedAlert(rt, rid, 3333) });
    assert.deepStrictEqual(ed.body.platform_changes_pending, { fields: [] }, 'the portal shows the lock (fail closed)');
    assert.deepStrictEqual(alerts(), ['platform_pending_malformed_x_pizza'], 'deduped: still ONE');
    // the realistic case: the merchant only LOADS the menu (no reset is offered while locked) — the load alone raises it
    const rtLoad = fakeRtdb();
    await editable(db6, 'x_pizza', live6.x_pizza, { alertMalformed: (rid) => PP.raiseMalformedAlert(rtLoad, rid, 5555) });
    assert.ok(rtLoad.data && rtLoad.data.dispatcher_alerts && rtLoad.data.dispatcher_alerts.platform_pending_malformed_x_pizza, 'a portal LOAD alone raises the owner alert');
    assert.strictEqual(rt.data.dispatcher_alerts.platform_pending_malformed_x_pizza.ts, 1111, 'first-seen kept');
    assert.strictEqual(rt.data.dispatcher_alerts.platform_pending_malformed_x_pizza.type, 'platform_pending_malformed', 'Central renders it by `type` (its unknown-type bucket names it)');
    // a speculative null run (RTDB may call the update with null first) still ends with ONE alert and created=false on a repeat
    assert.deepStrictEqual(await PP.raiseMalformedAlert(rt, 'x_pizza', 4444), { created: false });
    const boom = new Proxy(db6, { get(t, k) { if (k === 'collection') return (c) => { const col = t.collection(c); return new Proxy(col, { get(ct, ck) { if (ck !== 'doc') return typeof ct[ck] === 'function' ? ct[ck].bind(ct) : ct[ck]; return (id) => { const d = ct.doc(id); return new Proxy(d, { get(dt, dk) { if (dk !== 'collection') return typeof dt[dk] === 'function' ? dt[dk].bind(dt) : dt[dk]; return (sub) => { const sc = dt.collection(sub); return new Proxy(sc, { get(st2, sk) { if (sk !== 'doc') return typeof st2[sk] === 'function' ? st2[sk].bind(st2) : st2[sk]; return (did) => (did === 'platform_pending' ? { get: async () => { throw new Error('down'); } } : st2.doc(did)); } }); }; } }); }; } }); }; return typeof t[k] === 'function' ? t[k].bind(t) : t[k]; } });
    const r2 = await reset(boom, 'x_pizza', live6.x_pizza);
    assert.deepStrictEqual([r2.status, r2.body.error], [503, 'store_unavailable'], 'an unreadable stamp: 503, never a reset');
    assert.strictEqual((await readSource(db6, 'x_pizza')).revision, before.revision, 'nothing written');
  }
  ok('fails closed: a malformed stamp refuses (409), an unreadable one is a 503 — the draft untouched either way');

  // ── Codex r1 P1-1: the REAL --publish resolves the stamp; a LATER rollback then resets — no manual resolver call anywhere ──
  {
    const dbP = withUpdate(makeDb());
    const pre = {};
    for (const rid of RIDS) {
      const s = preMigration(rid, buildSourceFromCode(rid)); pre[rid] = s;
      const { inputs, built } = buildSourceCandidate(rid, clone(s));
      await CP.publishVersion(dbP, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'test' }, { expected: { activeVersionId: null } });
      await sourceRefOf(dbP, rid).set(clone(s));   // the draft = the pre-migration body
    }
    const wr = await migrateMenuStructure(dbP, DATA, { write: true });   // the DEFAULT live reader (the real active version)
    for (const r of wr) assert.ok(r.stamped.length > 0 && await pendingDoc(dbP, r.rid), `${r.rid}: premise — the --write stamped (live lacks the fields)`);
    const pub = await publishMenuStructure(dbP, DATA, { apply: true });
    for (const r of pub) {
      assert.strictEqual(r.outcome, 'published', `${r.rid}: premise — the REAL --publish published`);
      assert.strictEqual(r.stamp, 'cleared', `${r.rid}: the publish resolved the stamp (live now carries the fields)`);
      assert.strictEqual(await pendingDoc(dbP, r.rid), null, `${r.rid}: no stamp left`);
    }
    // a LATER rollback: live goes back to the pre-migration body (a new version whose body predates the migration)
    const rid = 'x_pizza';
    const { inputs, built } = buildSourceCandidate(rid, clone(pre[rid]));
    await CP.publishVersion(dbP, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'rollback' }, { expected: { activeVersionId: await getActiveVersionId(dbP, rid) } });
    const { revision } = await readSource(dbP, rid);
    const res = await resetDraftToLiveCore({ db: dbP, authorize: owner, readActiveVersionId: (fs, r) => getActiveVersionId(fs, r), previewVersion: CP.previewVersion },
      { restaurantId: rid, expectedRevision: revision }, {});
    assert.strictEqual(res.status, 200, `the rollback's reset is NOT relocked by a stale stamp: ${JSON.stringify(res.body).slice(0, 160)}`);
    // the re-run is the RETRY path: a stamp left behind (e.g. a failed cleanup) is resolved by an already_current run
    await dbP.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: dbP, rid: 'la_musa', by: 'migrate-menu-structure', fields: wr.find((r) => r.rid === 'la_musa').added }); });
    assert.ok(await pendingDoc(dbP, 'la_musa'), 'premise: a leftover stamp');
    const again = await publishMenuStructure(dbP, DATA, { apply: true });
    const by = Object.fromEntries(again.map((r) => [r.rid, r]));
    assert.deepStrictEqual([by.la_musa.outcome, by.la_musa.stamp], ['already_current', 'cleared'], 'the retry: already_current publishes nothing but resolves the leftover stamp');
    assert.strictEqual(await pendingDoc(dbP, 'la_musa'), null);
    assert.deepStrictEqual([by.x_pizza.outcome, by.x_pizza.stamp], ['published', 'none'], 'x_pizza re-published over the rollback; no stamp to clear');
  }
  ok('P1-1: the REAL --write stamps, the REAL --publish clears it, and a LATER rollback resets (200) — no manual resolver call');

  // ── Codex r1 P2-1: getEditableCatalog never UNLOCKS silently — a stamp unlocks only after a SUCCESSFUL gap evaluation ──
  {
    const { db: dbE, live: liveE } = await premigrated();
    await migrateMenuStructure(dbE, DATA, { write: true, readLive: async (_db, r) => liveE[r] });
    const liveFails = await getEditableCatalogCore({ db: {}, fsdb: dbE, authorize: owner, readActiveVersionId: async () => 'v-live',
      readActiveBuilt: async () => { throw new Error('live down'); } }, { method: 'GET', query: { restaurantId: 'x_pizza' } });
    assert.deepStrictEqual([liveFails.status, liveFails.body.error, liveFails.body.retryable], [503, 'live_version_unavailable', true], 'a stamp + live unreadable ⇒ retryable 503, never an unlocked editor');
    const stampFails = await getEditableCatalogCore({ db: {}, fsdb: new Proxy(dbE, { get(t, k) { if (k !== 'collection') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
      return (c) => { const col = t.collection(c); return new Proxy(col, { get(ct, ck) { if (ck !== 'doc') return typeof ct[ck] === 'function' ? ct[ck].bind(ct) : ct[ck]; return (id) => { const d = ct.doc(id); return new Proxy(d, { get(dt, dk) { if (dk !== 'collection') return typeof dt[dk] === 'function' ? dt[dk].bind(dt) : dt[dk]; return (sub) => { const sc = dt.collection(sub); return new Proxy(sc, { get(s2, sk) { if (sk !== 'doc') return typeof s2[sk] === 'function' ? s2[sk].bind(s2) : s2[sk]; return (did) => (did === 'platform_pending' ? { get: async () => { throw new Error('down'); } } : s2.doc(did)); } }); }; } }); }; } }); }; } }),
      authorize: owner, readActiveVersionId: async () => 'v-live',
      readActiveBuilt: async () => ({ built: { items: clone(liveE.x_pizza.items), structure: clone(liveE.x_pizza.structure), extras: [] }, versionId: 'v-live', extraRecords: clone(liveE.x_pizza.extras) }) },
      { method: 'GET', query: { restaurantId: 'x_pizza' } });
    assert.deepStrictEqual([stampFails.status, stampFails.body.error, stampFails.body.retryable], [503, 'source_unavailable', true], 'the stamp unreadable ⇒ retryable 503');
    const noLive = await getEditableCatalogCore({ db: {}, fsdb: dbE, authorize: owner, readActiveVersionId: async () => null }, { method: 'GET', query: { restaurantId: 'x_pizza' } });
    assert.strictEqual(noLive.status, 200);
    assert.deepStrictEqual(noLive.body.platform_changes_pending, { fields: await stampFields(dbE, 'x_pizza') }, 'nothing published ⇒ live carries none: locked on every stamped field');
    const { db: dbU } = await premigrated();   // CONFIRMED unstamped: a live read failure changes nothing about the lock (today's response)
    const unst = await getEditableCatalogCore({ db: {}, fsdb: dbU, authorize: owner, readActiveVersionId: async () => 'v-live',
      readActiveBuilt: async () => { throw new Error('live down'); } }, { method: 'GET', query: { restaurantId: 'x_pizza' } });
    assert.strictEqual(unst.status, 200, 'no stamp ⇒ the editor loads as today');
    assert.strictEqual(unst.body.platform_changes_pending, undefined);
  }
  ok('P2-1: a stamp + an unreadable live or stamp ⇒ retryable 503 (never a silent unlock); nothing published ⇒ locked; confirmed-unstamped ⇒ today');

  // ── the owner CLI (tools/platform-pending.js): strict argv; status = shape only; clear dry-run writes nothing; --apply clears ONLY that rid ──
  {
    const P = (s) => CLI.parseArgs(s.split(' '));
    for (const bad of ['status --rid=x_pizza --project p', 'status --project p', 'clear --rid x_pizza', 'status --rid x_pizza --project p --apply',
      'clear --rid x_pizza --project p --bogus', 'clear --rid x_pizza --rid la_musa --project p', 'clear --rid X_Pizza! --project p', 'purge --rid x_pizza --project p', 'status --rid --project p']) {
      assert.strictEqual(P(bad).ok, false, `refused: ${bad}`);
    }
    assert.deepStrictEqual(P('clear --project p --rid x_pizza --apply'), { ok: true, sub: 'clear', rid: 'x_pizza', apply: true });
    assert.deepStrictEqual(P('status --rid x_pizza --project p'), { ok: true, sub: 'status', rid: 'x_pizza', apply: false });
    const db8 = withUpdate(makeDb());
    const rt8 = fakeRtdb();
    await db8.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db8, rid: 'x_pizza', by: 'migrate-menu-structure', fields: ['structure.a', 'item[Nutella].display.extras_policy'], now: 7 }); });
    await db8.runTransaction(async (tx) => { await PP.stampPlatformPending(tx, { db: db8, rid: 'la_musa', by: 'migrate-menu-structure', fields: ['structure.b'], now: 8 }); });
    const st = await CLI.status(db8, 'x_pizza');
    assert.deepStrictEqual(st, { rid: 'x_pizza', exists: true, malformed: false, by: 'migrate-menu-structure', at: 7, fields: 2 });
    assert.ok(!JSON.stringify(st).includes('structure.') && !JSON.stringify(st).includes('Nutella'), 'shape only — never the field paths');
    assert.deepStrictEqual(await CLI.status(db8, 'nope'), { rid: 'nope', exists: false });
    await PP.raiseMalformedAlert(rt8, 'x_pizza', 9);
    const dry = await CLI.clear(db8, rt8, 'x_pizza', { apply: false });
    assert.strictEqual(dry.cleared, false);
    assert.ok(await pendingDoc(db8, 'x_pizza') && rt8.data.dispatcher_alerts.platform_pending_malformed_x_pizza, 'DRY RUN writes nothing');
    const done = await CLI.clear(db8, rt8, 'x_pizza', { apply: true });
    assert.strictEqual(done.cleared, true);
    assert.strictEqual(await pendingDoc(db8, 'x_pizza'), null, '--apply deletes that rid\u2019s stamp');
    assert.ok(!(rt8.data && rt8.data.dispatcher_alerts && rt8.data.dispatcher_alerts.platform_pending_malformed_x_pizza), 'and its alert');
    assert.deepStrictEqual(await stampFields(db8, 'la_musa'), ['structure.b'], 'another rid\u2019s stamp is untouched');
    await PP.pendingRefOf(db8, 'la_musa').set({ v: 1, fields: 'nope' });
    assert.deepStrictEqual(await CLI.status(db8, 'la_musa'), { rid: 'la_musa', exists: true, malformed: true });
    // Codex r2 P2: the stamp delete succeeds, the alert delete FAILS ⇒ the run rejects (main maps a rejection to exit 1) and says
    // the stamp is gone; the RETRY — no stamp left — still removes the alert and resolves (exit 0). Same real fake, one failing set.
    await PP.raiseMalformedAlert(rt8, 'la_musa', 10);
    let failAlert = true;
    const flaky = { ref: (p) => { const r = rt8.ref(p); return { once: r.once, transaction: r.transaction,
      set: async (v) => { if (failAlert && p === 'dispatcher_alerts/platform_pending_malformed_la_musa') { failAlert = false; throw new Error('rtdb down'); } return r.set(v); } }; } };
    await assert.rejects(CLI.clear(db8, flaky, 'la_musa', { apply: true }), /the stamp was deleted but the alert delete failed/, 'a failed alert delete is an error, never exit 0');
    assert.strictEqual(await pendingDoc(db8, 'la_musa'), null, 'premise: the stamp delete went through');
    assert.ok(rt8.data.dispatcher_alerts.platform_pending_malformed_la_musa, 'premise: the alert survived the failed run');
    const dry2 = await CLI.clear(db8, flaky, 'la_musa', { apply: false });
    assert.deepStrictEqual([dry2.existed, dry2.alert, dry2.cleared], [false, true, false], 'the dry run reports the leftover alert (no stamp)');
    const retry = await CLI.clear(db8, flaky, 'la_musa', { apply: true });
    assert.deepStrictEqual([retry.existed, retry.alert, retry.cleared, retry.stampDeleted, retry.alertDeleted], [false, true, true, false, true], 'the retry clears the alert alone');
    assert.ok(!rt8.data.dispatcher_alerts || !rt8.data.dispatcher_alerts.platform_pending_malformed_la_musa, 'the leftover alert is gone after the retry');
    assert.deepStrictEqual(await CLI.clear(db8, flaky, 'la_musa', { apply: true }), { rid: 'la_musa', existed: false, alert: false, cleared: false, apply: true }, 'and a third run is a clean no-op');
  }
  ok('owner CLI: strict argv (9 refusals); status prints the shape only; clear is a DRY RUN by default; --apply clears ONLY that rid\u2019s stamp + its alert; a failed alert delete rejects and its retry (stamp gone) still clears the alert (Codex r2 P2)');

  FINISHED = true;
  console.log(`platform-pending: OK (${n})`);
})().catch((e) => { console.error('platform-pending: FAILED —', e && e.stack || e); process.exit(1); });
