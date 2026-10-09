'use strict';
/* 1D D4-c2b — OPERATIONS on the Firestore + RTDB EMULATORS (PLAN-D4c2b rev 14 §1, §4 quiet period, §10; advisor ruling N2):
   the quiet-period precheck against REAL server times, a publish overlapping a check, the boundary import's branches (unchanged /
   evidenced / gap / inconsistent, write-once), the acknowledgement tool, the §10 first-run expectation, and the DEPLOYED function
   object. Run: npm run test:c2b-ops */
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'c2b-ops-secret-'.padEnd(48, 'x');
const assert = require('assert');
const app = require('../index.js');
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');
const { fixture } = require('./_c2b-fixture');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { sourceRefOf } = require('../catalog/source-store');
const E = require('../catalog/identity-evidence');
const BND = require('../tools/record-evidence-boundary');
const ACK = require('../tools/ack-identity-finding');
const S = require('../catalog/identity-integrity-state');
const C = require('../catalog/identity-integrity');

const db = admin.firestore(); const rtdb = admin.database();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('c2b-ops: FAILED — exited without completing'); process.exitCode = 1; } });
let clock = Date.now();
const F = fixture({ db, rtdb, now: () => clock, sleep: async (ms) => { clock += ms; } });
const QUIET = 10 * 60 * 1000;

(async () => {
  // ── 1. quiet period against REAL server times: a live lease / a draft edited < 10 min / a pointer moved < 10 min → deferred,
  //       no backoff, no coverage; the streak counts once per run id; once idle (lease released) → checked ────────────────
  {
    const R = 'synth_quiet';
    await F.merchant(R);
    let r = await F.runFor([R], { quietMs: QUIET, runId: () => 'run-1' });
    assert.deepStrictEqual(r.results.map((x) => x.outcome), ['deferred_merchant_active'], 'the pointer moved (bootstrap / publish) < 10 min ago');
    let node = await F.nodeOf(R);
    assert.deepStrictEqual([node.coverage.active_streak, node.coverage.failures, node.coverage.retry_after, node.coverage.active_ok_obs_t], [1, undefined, undefined, undefined]);
    await F.runFor([R], { quietMs: QUIET, runId: () => 'run-1' });
    assert.strictEqual((await F.nodeOf(R)).coverage.active_streak, 1, 'a duplicate/overlapping run (same run id) does not double count');
    await F.runFor([R], { quietMs: QUIET, runId: () => 'run-2' });
    assert.strictEqual((await F.nodeOf(R)).coverage.active_streak, 2);
    // the window is relative to the SNAPSHOT's server time: with the window at 0 ms the pointer is "old" → checked
    r = await F.runFor([R], { quietMs: 0 });
    node = await F.nodeOf(R);
    assert.deepStrictEqual([r.results[0].outcome, node.coverage.active_streak, node.coverage.first_active_deferral_obs_t], ['checked', 0, undefined], 'a completed check resets the streak');
    // a LIVE LEASE defers regardless of the window; released → checked
    const lock = db.collection('restaurants').doc(R).collection('meta').doc('publish_lock');
    await lock.set({ owner_token: 'someone', acquired_at: Timestamp.now(), expires_at: Timestamp.fromMillis(Date.now() + 120000) });   // the real lease shape (catalog-publish.js:245)
    r = await F.runFor([R], { quietMs: 0 });
    assert.deepStrictEqual(r.results.map((x) => x.outcome), ['deferred_merchant_active'], 'a live lease');
    await lock.set({ owner_token: 'someone', acquired_at: Timestamp.now(), expires_at: Timestamp.fromMillis(Date.now() - 1000) });   // expired = free
    r = await F.runFor([R], { quietMs: 0 });
    assert.deepStrictEqual(r.results.map((x) => x.outcome), ['checked'], 'lease released/expired → checked next run');
    // a DRAFT edited < 10 min ago (a real save) defers; an UNCHANGED save does not advance updateTime (honest scope, §4)
    await F.portalSaveAndPublish(R, (src) => { src.items[0].price += 1; if (src.items[0].display) src.items[0].display.price = src.items[0].price; return src; }, 'quiet-edit');
    r = await F.runFor([R], { quietMs: QUIET });
    assert.strictEqual(r.results[0].outcome, 'deferred_merchant_active', 'a draft edited / a publish < 10 min ago');
    const before = (await sourceRefOf(db, R).get()).updateTime;
    await sourceRefOf(db, R).set((await sourceRefOf(db, R).get()).data());
    assert.ok((await sourceRefOf(db, R).get()).updateTime.isEqual(before), 'premise (honest scope): an unchanged save keeps the previous updateTime — the precheck cannot see it');
    ok('quiet period on REAL server times: pointer moved / draft edited < 10 min and a live lease → deferred_merchant_active (no failure, no backoff, no coverage); the streak counts once per run id; idle / lease expired → checked and the streak resets; an unchanged save keeps updateTime (stated scope)');
  }

  // ── 2. a publish that STARTS DURING a check completes unaffected (the real publish path, concurrently) ──────────────
  {
    const R = 'synth_overlap';
    await F.merchant(R); await F.publish(R, 'ov-1');
    const before = await getActivePointer(db, R);
    const [mon, pub] = await Promise.all([F.runFor([R], { quietMs: 0 }), (async () => { await new Promise((res) => setTimeout(res, 5)); return F.publish(R, 'ov-2'); })()]);
    const after = await getActivePointer(db, R);
    assert.strictEqual(after.generation, before.generation + 1, 'the publish activated');
    assert.strictEqual(after.version, pub);
    assert.ok((await F.evidenceIds(R)).includes(E.activationDocId(after.generation)), 'and wrote its evidence');
    assert.ok(['checked', 'deferred_merchant_active'].includes(mon.results[0].outcome), `the monitor run completed (${mon.results[0].outcome})`);
    const r = await F.runFor([R], { quietMs: 0 });
    assert.deepStrictEqual([r.results[0].outcome, (await F.nodeOf(R)).active.generation, F.openFindings(await F.nodeOf(R))], ['checked', after.generation, []]);
    ok('a publish starting DURING a monitor check (real publish path, concurrent) activates and writes its evidence unaffected; the check completes (read-only, lock-free); the next run binds the new generation with no finding');
  }

  // ── 3. the boundary import (ruling N2): G0 from the RECORDED observation; unchanged / evidenced → G0 = Gpre + 1; gap /
  //       inconsistency → REFUSED; WRITE-ONCE; never derived from the pointer at import ─────────────────────────────────
  {
    // a "pre-c2a" restaurant: its live pointer carries NO generation (as both brands' did when recorded) and no evidence
    const pre = async (R) => {
      await F.merchant(R);
      const p = await getActivePointer(db, R);
      await F.pointerRef(R).set({ version: p.version, at: new Date() });                   // the pre-P1 pointer shape
      for (const id of await F.evidenceIds(R)) await F.evidenceCol(R).doc(id).delete();     // no evidence before c2a
      const snap = await F.pointerRef(R).get();
      const ut = snap.updateTime; const iso = `${new Date(ut.toMillis() - (ut.toMillis() % 1000)).toISOString().slice(0, 19)}.${String(ut.nanoseconds).padStart(9, '0')}Z`;
      return { version: p.version, updateTime: iso, pointer: { version: p.version } };
    };
    const record = (restaurants) => ({ decision: 'test', after_ready: '2026-10-09T18:03:03Z', recorded_at: '2026-10-09T18:07:48Z', restaurants });
    const RU = 'synth_bnd_unchanged'; const RE = 'synth_bnd_evidenced'; const RG = 'synth_bnd_gap'; const RI = 'synth_bnd_inconsistent';
    const rec = record({ [RU]: await pre(RU), [RE]: await pre(RE), [RG]: await pre(RG), [RI]: await pre(RI) });
    // after the record: RE activates (its evidence written by the real writer), RG activates with its evidence lost (old CLI),
    // RI's pointer is rewritten with no new generation
    await F.publish(RE, 'bnd-e'); await F.publish(RG, 'bnd-g');
    for (const id of await F.evidenceIds(RG)) await F.evidenceCol(RG).doc(id).delete();
    await F.pointerRef(RI).set({ version: rec.restaurants[RI].version, at: new Date(), touched: true });
    const dry = await BND.run({ db, rtdb, record: rec, apply: false, log: () => {} });
    const by = Object.fromEntries(dry.results.map((x) => [x.rid, x]));
    assert.deepStrictEqual([by[RU].ok, by[RU].branch, by[RU].Gpre, by[RU].G0], [true, 'pointer_unchanged', 0, 1], 'Gpre = 0 as c2a\'s reader reads an absent generation (catalog-firestore.js:112) → G0 = 1');
    assert.deepStrictEqual([by[RE].ok, by[RE].branch, by[RE].G0], [true, 'evidenced', 1]);
    assert.deepStrictEqual([by[RG].ok, by[RG].reason, by[RG].missing], [false, 'evidence_gap', [1]]);
    assert.deepStrictEqual([by[RI].ok, by[RI].reason], [false, 'pointer_changed_without_a_new_generation']);
    assert.strictEqual(await F.nodeOf(RU), null, 'a dry run writes nothing');
    const ap = await BND.run({ db, rtdb, record: rec, apply: true, log: () => {} });
    assert.deepStrictEqual(ap.results.map((x) => [x.rid, !!x.written]).sort(), [[RE, true], [RG, false], [RI, false], [RU, true]].sort());
    const nu = await F.nodeOf(RU);
    assert.deepStrictEqual([nu.boundary.G0, nu.boundary.source, nu.boundary.branch, nu.boundary.recorded_version, nu.audited_through], [1, 'rollout_record', 'pointer_unchanged', rec.restaurants[RU].version, 0]);
    // WRITE-ONCE: a second apply (even with a different record) never overwrites
    const again = await BND.run({ db, rtdb, record: rec, rid: RU, apply: true, log: () => {} });
    assert.deepStrictEqual([again.results[0].written, again.results[0].existing.G0], [false, 1]);
    assert.ok((await BND.run({ db, rtdb, record: { ...rec, recorded_at: '2026-10-09T18:00:00Z' }, apply: false, log: () => {} })).refused, 'a record read BEFORE the deploy went ready is refused');
    // §10 expectation: the pre-c2a restaurant reads pre_boundary until its next organic publish, then ok
    let r = await F.runFor([RU], { quietMs: 0 });
    assert.deepStrictEqual([(await F.nodeOf(RU)).active.state, F.openFindings(await F.nodeOf(RU))], ['pre_boundary', []], 'x_pizza-like: pre_boundary, ZERO findings');
    await F.publish(RU, 'bnd-next');
    r = await F.runFor([RU], { quietMs: 0 });
    assert.deepStrictEqual([(await F.nodeOf(RU)).active.state, r.lines[0].open_violations, r.lines[0].open_gaps], ['ok', 0, 0], 'after its next organic publish: ok');
    ok('boundary import (N2): G0 from the RECORDED pointer (Gpre = 0 through c2a\'s reader) — unchanged → G0 1, evidenced since → G0 1, a lost-evidence activation → REFUSED evidence_gap [1], a rewritten pointer without a new generation → REFUSED; dry run writes nothing; WRITE-ONCE; a record read before the deploy went ready is refused; then pre_boundary with zero findings until the next publish, then ok');
  }

  // ── 4. the acknowledgement tool: list, dry run, apply, twice, unknown, missing note; the summary drops in the same commit ─
  {
    const R = 'synth_ack';
    await F.merchant(R); await F.runFor([R], { quietMs: 0 });
    await rtdb.ref(`catalog_integrity/${R}`).transaction((cur) => (cur === null ? null : S.withSize(S.applyActive(cur, { state: 'violation', findings: [C.finding('stamps_changed', 'planted', { generation: 1 })], degradedPairs: [], coverage: true },
      { obs_t: S.fromMs(Date.now() + 3600000), generation: 1 }).node)));
    const l = await ACK.list({ rtdb, rid: R });
    const fid = l.findings.find((f) => f.status === 'open').id;
    assert.strictEqual(l.summary.open_violations, 1);
    assert.ok((await ACK.acknowledge({ rtdb, rid: R, finding: fid, note: '', by: 'x', apply: true })).refused, 'a note is required');
    const dry = await ACK.acknowledge({ rtdb, rid: R, finding: fid, note: 'checked', by: 'owner', apply: false });
    assert.ok(dry.dryRun && (await F.nodeOf(R)).findings[fid].status === 'open', 'dry run writes nothing');
    const ap = await ACK.acknowledge({ rtdb, rid: R, finding: fid, note: 'checked the version docs', by: 'owner', apply: true });
    assert.deepStrictEqual([ap.ok, ap.summaryBefore.open_violations, ap.summaryAfter.open_violations], [true, 1, 0], 'status + summary in ONE commit');
    assert.deepStrictEqual((await F.nodeOf(R)).findings[fid].ack.note, 'checked the version docs');
    assert.ok((await ACK.acknowledge({ rtdb, rid: R, finding: fid, note: 'x', by: 'y', apply: true })).refused, 'twice refused');
    assert.ok((await ACK.acknowledge({ rtdb, rid: R, finding: 'nope', note: 'x', by: 'y', apply: true })).refused);
    assert.ok((await ACK.list({ rtdb, rid: 'synth_none' })).refused);
    ok('acknowledgement tool: list; note/by required; dry run writes nothing; apply sets acknowledged + {at, by, note} and recomputes the summary in the same transaction (1 → 0); twice / unknown / no state refused');
  }

  // ── 5. the DEPLOYED function object: the scheduled export runs end to end over the registry enumeration ───────────────
  {
    const logs = []; const real = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try { await app.verifyIdentityIntegrity.run({}); } finally { console.log = real; }
    const runLine = logs.map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).find((x) => x && x.event === 'identity_integrity_run');
    assert.ok(runLine && runLine.ok === true && runLine.enumerated >= 5, `the scheduled function enumerated the registry: ${JSON.stringify(runLine)}`);
    const states = logs.filter((x) => x.includes('"identity_integrity_state"')).length;
    assert.strictEqual(states, runLine.enumerated, 'one summary line per enumerated restaurant');
    ok(`the DEPLOYED scheduled function (verifyIdentityIntegrity.run): ${runLine.enumerated} restaurants enumerated by makeFirestoreRegistryReader, one summary line each, run ok (${runLine.reads} reads)`);
  }

  FINISHED = true;
  console.log(`c2b-ops: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('c2b-ops FAILED:', e); process.exit(1); });
