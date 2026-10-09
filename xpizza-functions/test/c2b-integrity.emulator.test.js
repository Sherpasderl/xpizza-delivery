'use strict';
/* 1D D4-c2b — THE IDENTITY INTEGRITY MONITOR on the Firestore + RTDB EMULATORS, over evidence written by the REAL c2a writers
   (publishVersion / rollbackVersion / bootstrapIdentityStamps). Run: npm run test:c2b-integrity
   Expected values come from the plan (PLAN-D4c2b rev 14) and from Firestore, never from the code under test. */
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'c2b-integrity-secret-'.padEnd(48, 'x');   // the portal save signs its edit token
const assert = require('assert');
const app = require('../index.js');
const admin = require('firebase-admin');
const { fixture } = require('./_c2b-fixture');
const { getActivePointer } = require('../catalog/catalog-firestore');
const E = require('../catalog/identity-evidence');

const db = admin.firestore(); const rtdb = admin.database();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('c2b-integrity: FAILED — exited without completing'); process.exitCode = 1; } });

// the quiet-period precheck skips a restaurant edited/activated < 10 min ago: the monitor's clock is moved past it explicitly
let clock = Date.now();
// the monitor's pacing sleeps advance the same clock (a frozen clock with a no-op sleep would never refill the read bucket)
const F = fixture({ db, rtdb, now: () => clock, sleep: async (ms) => { clock += ms; } });
const later = (min) => { clock += min * 60 * 1000; };
const evidence = async (rid) => (await db.collection('restaurants').doc(rid).collection(E.EVIDENCE_COL).get()).docs.map((d) => d.id).sort();

(async () => {
  assert.strictEqual(typeof app.verifyIdentityIntegrity, 'function', 'the scheduled export exists');
  const RID = 'x_pizza';
  await F.seed(RID);

  // ── 1. an UNCERTIFIED publish: onboarded boundary G0 = 1 (generation 1's evidence validates), state uncertified, no finding ──
  {
    await F.publish(RID, 'c2b-seed');
    const p = await getActivePointer(db, RID);
    assert.strictEqual(p.generation, 1, 'premise: the first activation is generation 1');
    later(11);
    const r = await F.runFor([RID]);
    const node = await F.nodeOf(RID);
    assert.deepStrictEqual(r.results.map((x) => x.outcome), ['checked'], JSON.stringify(r.results));
    assert.deepStrictEqual(node.boundary, { G0: 1, source: 'onboarded', recorded_obs_t: node.boundary.recorded_obs_t });
    assert.strictEqual(node.active.state, 'uncertified');
    assert.strictEqual(node.audited_through, 1);
    assert.deepStrictEqual(F.openFindings(node), []);
    assert.deepStrictEqual(r.lines.map((l) => [l.rid, l.open_violations, l.open_gaps, l.open_degraded, l.stale]), [[RID, 0, 0, 0, 0]]);
    assert.ok(r.logged.some((x) => x.k === 'identity_integrity_heartbeat'), 'heartbeat: enumeration completed, nothing stale');
    ok(`an UNCERTIFIED publish (evidence ${JSON.stringify(await evidence(RID))}): boundary onboarded G0=1, state uncertified, audited through 1, no finding, summary 0/0/0/0, heartbeat emitted`);
  }

  // ── 2. bootstrap certifies the live version: the effective record is the CERTIFICATION; binding verified → ok ──────────
  {
    const rep = await F.bootstrap(RID);
    assert.strictEqual(rep.stamped, true, 'premise: bootstrap stamped');
    later(11);
    const r = await F.runFor([RID]);
    const node = await F.nodeOf(RID);
    assert.strictEqual(node.active.state, 'ok', JSON.stringify(node.active));
    assert.deepStrictEqual(F.openFindings(node), []);
    ok(`bootstrap → certification evidence (${JSON.stringify(await evidence(RID))}); the monitor binds the active version through it: state ok, coverage + final_digest + registry agree, no finding`);
  }

  // ── 3. a certified publish WITH A MINT: activation evidence certified → ok; the audit covers generation 2 ─────────────
  {
    await F.addDish(RID, 'Zz C2b Mint');
    later(1); await F.publish(RID, 'c2b-mint');
    later(11);
    const r = await F.runFor([RID]);
    const node = await F.nodeOf(RID);
    assert.strictEqual(node.active.state, 'ok', JSON.stringify(node.active));
    assert.strictEqual(node.active.generation, 2);
    assert.strictEqual(node.audited_through, 2);
    assert.deepStrictEqual(F.openFindings(node), []);
    assert.ok(r.reads > 0 && r.reads < 1700, `reads ${r.reads} within the per-restaurant estimate`);
    ok(`a certified publish with a mint (g2): state ok, audited through 2, ${r.reads} reads`);
  }

  // helpers over the REAL state
  const { encodeKey, keysColOf, idsColOf } = require('../catalog/identity-registry');
  const S = require('../catalog/identity-integrity-state');
  const ACK = require('../tools/ack-identity-finding');
  const open = async (rid) => F.openFindings(await F.nodeOf(rid)).map(([, f]) => f.kind + (f.detail && f.detail.reason ? `{${f.detail.reason}}` : '')).sort();
  const items = async (rid, v) => (await F.versionsColOf(rid).doc(v).collection('menu_items').get()).docs;
  const run1 = async (rid, opts) => { later(16); return F.runFor([rid], opts); };
  const ackAll = async (rid, note) => { for (const [id] of F.openFindings(await F.nodeOf(rid))) assert.ok((await ACK.acknowledge({ rtdb, rid, finding: id, note, by: 'c2b-test', apply: true })).ok); };

  // ── 4. a PLANTED SWAP in the live version → stamps_changed + registry_disagrees; repaired → cleared but OPEN; acknowledged → 0 ──
  {
    const R = 'synth_swap';
    await F.merchant(R); const v2 = await F.publish(R, 'swap-v2');
    await run1(R);
    assert.deepStrictEqual(await open(R), [], 'premise: a clean certified merchant');
    const [a1, b1] = (await items(R, v2)).filter((d) => d.data().display && d.data().display.identity_id);
    const ia = a1.data().display.identity_id; const ib = b1.data().display.identity_id;
    await a1.ref.update({ 'display.identity_id': ib }); await b1.ref.update({ 'display.identity_id': ia });
    let r = await run1(R);
    assert.deepStrictEqual(await open(R), ['registry_disagrees', 'stamps_changed']);
    assert.deepStrictEqual(r.lines[0].open_violations, 2);
    await a1.ref.update({ 'display.identity_id': ia }); await b1.ref.update({ 'display.identity_id': ib });   // repaired
    r = await run1(R);
    const node = await F.nodeOf(R);
    assert.deepStrictEqual(F.openFindings(node).map(([, f]) => f.condition), ['cleared', 'cleared'], 'repaired → condition cleared …');
    assert.strictEqual(r.lines[0].open_violations, 2, '… but still OPEN and alerted until acknowledged');
    await ackAll(R, 'swap was a planted test; repaired');
    r = await run1(R);
    assert.deepStrictEqual([r.lines[0].open_violations, (await F.nodeOf(R)).active.state], [0, 'ok']);
    ok('a PLANTED id swap in the live version → stamps_changed + registry_disagrees (2 open violations); repaired → condition cleared but STILL open and alerted; acknowledged with the tool → 0, state ok');
  }

  // ── 5. registry key-row swap → registry_disagrees; a MISSING key row → degraded timer; > 2 h → sticky degraded; repaired → cleared ──
  {
    const R = 'synth_reg';
    const v1 = await F.merchant(R);
    const docs = (await items(R, v1)).map((d) => d.data()).filter((d) => d.display && d.display.identity_id);
    const [A1, B1] = docs;
    const kref = keysColOf(db, R, 'dish').doc(encodeKey(A1.key));
    const krow = (await kref.get()).data();
    await kref.update({ canonical_id: B1.display.identity_id });
    await run1(R);
    assert.deepStrictEqual(await open(R), ['registry_disagrees']);
    await kref.set(krow); await ackAll(R, 'planted');
    await kref.delete();
    await run1(R);
    let node = await F.nodeOf(R);
    assert.deepStrictEqual([await open(R), Object.keys(node.timers || {}).length], [[], 1], 'a missing key row opens a degraded TIMER, no finding yet');
    // 2 h elapse: the timer's start is moved back (the only state a test can age); the next observation crosses the bound
    const [pair, since] = Object.entries(node.timers)[0];
    await rtdb.ref(`catalog_integrity/${R}/timers/${pair}`).set(S.fromMs(S.obsMs(since) - 3 * 60 * 60 * 1000));
    let r = await run1(R);
    assert.deepStrictEqual([await open(R), r.lines[0].open_degraded], [['degraded'], 1], '> 2 h → a sticky degraded finding (alerted)');
    await kref.set(krow);
    r = await run1(R); node = await F.nodeOf(R);
    assert.deepStrictEqual([node.timers || {}, F.openFindings(node)[0][1].condition, r.lines[0].open_degraded], [{}, 'cleared', 1], 'repaired → timer closed, finding cleared but open');
    await kref.delete(); await run1(R); node = await F.nodeOf(R);
    assert.strictEqual(Object.keys(node.timers || {}).length, 1, 'reappears → a NEW timer');
    await kref.set(krow);
    ok('a registry key-row swap → registry_disagrees; a missing key row → a degraded timer only; past 2 h → a sticky degraded finding; repaired → timer closed + condition cleared (still open); reappears → a new timer');
  }

  // ── 6. certify → decertify → re-activate: a version certified before and now uncertified → decertified ──────────────
  {
    const R = 'synth_decert';
    const V = await F.merchant(R);                 // V: published uncertified, certified by bootstrap
    await F.publish(R, 'decert-W');                // W certified
    await F.versionsColOf(R).doc(V).update({ identity_certified: false });   // planted decertification
    await F.rollback(R, V);
    await run1(R);
    assert.deepStrictEqual(await open(R), ['decertified']);
    ok('certify (bootstrap) → publish W → V\'s record DECERTIFIED (planted) → rollback re-activates V uncertified: its binding origin (the certification) exists → decertified');
  }

  // ── 7. overflow: 9 certifications at the live generation → unavailable{too_many_certifications}, backoff, never a violation ──
  {
    const R = 'synth_overflow';
    await F.merchant(R);
    const p = await getActivePointer(db, R);
    const real = (await F.evidenceCol(R).doc(E.certificationDocId(p.generation, 1)).get()).data();
    for (let i = 2; i <= 9; i += 1) await F.evidenceCol(R).doc(E.certificationDocId(p.generation, i)).set({ ...real, rev_c: i });
    const r = await run1(R);
    const node = await F.nodeOf(R);
    assert.deepStrictEqual([r.results[0].outcome, r.results[0].reason, node.coverage.failures, await open(R)], ['unavailable', 'too_many_certifications', 1, []]);
    assert.ok(node.coverage.retry_after > clock, 'backed off');
    ok('nine certifications at the live generation → unavailable{too_many_certifications}: no violation, no coverage, failures 1 + retry_after (backoff)');
  }

  // ── 8. malformed evidence (active), a generation GAP (old-CLI activation), malformed history ────────────────────────
  {
    const R = 'synth_bad';
    await F.merchant(R); await F.publish(R, 'bad-2'); await F.publish(R, 'bad-3');
    const p = await getActivePointer(db, R);
    assert.strictEqual(p.generation, 3);
    await F.evidenceCol(R).doc(E.activationDocId(2)).delete();                          // g2: an activation by a pre-merged CLI
    await F.evidenceCol(R).doc(E.activationDocId(3)).update({ v: 2 });                  // g3 (live): malformed
    await run1(R);
    assert.deepStrictEqual(await open(R), ['evidence_malformed', 'unattested{generation_gap}'].sort(), 'live g3 malformed (once: active + audit share the condition) + the g2 gap');
    const node = await F.nodeOf(R);
    assert.strictEqual(node.boundary.G0, 1, 'onboarded from g1');
    ok('a missing intermediate generation (an old-CLI activation) → unattested{generation_gap}; malformed live evidence → evidence_malformed; audited through the current generation');
  }

  // ── 9. boundary_unknown → later a recorded boundary relabels < G0 as pre_boundary; a delayed first run audits only ≥ G0 ──
  {
    const R = 'synth_unknown';
    await F.merchant(R); await F.publish(R, 'u-2');
    await F.evidenceCol(R).doc(E.activationDocId(1)).delete();                          // no valid generation-1 evidence → unknown
    await run1(R);
    let node = await F.nodeOf(R);
    assert.strictEqual(node.boundary, undefined);
    assert.deepStrictEqual(await open(R), ['unattested{boundary_unknown}']);
    await rtdb.ref(`catalog_integrity/${R}`).transaction((cur) => S.withSize(S.setBoundary(cur, { G0: 2, source: 'rollout_record' }).node));
    node = await F.nodeOf(R);
    assert.deepStrictEqual(await open(R), ['unattested{pre_boundary}'], 'relabelled, kept (never deleted or downgraded)');
    const R2 = 'synth_delayed';
    await F.merchant(R2); for (let i = 2; i <= 5; i += 1) await F.publish(R2, `d-${i}`);
    await F.evidenceCol(R2).doc(E.activationDocId(1)).delete(); await F.evidenceCol(R2).doc(E.activationDocId(2)).delete();   // "pre-c2a"
    await rtdb.ref(`catalog_integrity/${R2}`).transaction((cur) => S.withSize(S.setBoundary(cur, { G0: 3, source: 'rollout_record' }).node));
    await run1(R2);
    node = await F.nodeOf(R2);
    assert.deepStrictEqual([node.audited_through, await open(R2)], [5, []], 'delayed monitor: audits G0 … current only; the missing pre-boundary generations are not gaps');
    ok('boundary_unknown: every unattested generation recorded informationally; a boundary written later relabels them pre_boundary (kept); a delayed first run (boundary 3, current 5) audits 3…5 only');
  }

  // ── 10. rollbacks: target unaltered (certification origin), history_unknown (origin predates c2a), target ALTERED (incl. superseded) ──
  {
    const R = 'synth_rb';
    const V = await F.merchant(R);                 // V: uncertified publish (g1) → bootstrap (certification origin)
    await F.publish(R, 'rb-W'); await F.rollback(R, V);
    await run1(R);
    assert.deepStrictEqual(await open(R), [], 'uncertified publish → certified by bootstrap → rolled back to: the CERTIFICATION is its origin; unaltered');
    const R2 = 'synth_rbh';
    await F.merchant(R2); const W = await F.publish(R2, 'h-W'); await F.publish(R2, 'h-X');
    const pw = (await F.evidenceCol(R2).where('vid', '==', require('../catalog/evidence-encoding').H(W)).get()).docs;
    for (const d of pw) await d.ref.delete();     // W's evidence "predates c2a"
    await F.rollback(R2, W); await F.publish(R2, 'h-Y');   // superseded before the run
    await run1(R2);
    assert.deepStrictEqual(await open(R2), ['history_unknown', 'unattested{generation_gap}'], 'a rollback to a version with no binding origin → history_unknown (gap); its deleted publish generation is a gap');
    const R3 = 'synth_rba';
    await F.merchant(R3); const W3 = await F.publish(R3, 'a-W'); await F.publish(R3, 'a-X'); await F.rollback(R3, W3); await F.publish(R3, 'a-Y');
    const origin = (await F.evidenceCol(R3).where('vid', '==', require('../catalog/evidence-encoding').H(W3)).orderBy(require('firebase-admin/firestore').FieldPath.documentId()).limit(1).get()).docs[0];
    const altered = require('../catalog/evidence-encoding').H('altered');
    await origin.ref.update({ final_digest: altered });   // the target's binding as certified ≠ what the rollback activated
    await run1(R3);
    assert.ok((await open(R3)).includes('rollback_target_altered'), JSON.stringify(await open(R3)));
    ok('rollbacks: to a bootstrap-certified version → certification origin, unaltered, no finding; to a version whose origin predates c2a → history_unknown (+ the gap), also when superseded before the run; to a target whose binding differs from what it re-activated → rollback_target_altered, detected after it was superseded');
  }

  // ── 11. legitimate operations through the MERCHANT'S REAL PATH (editCatalogCore → publishEditedCore) → NO violation:
  //        a rename (P1a: the old id declared deleted + the new name minted), a delete, a recreate, a name reuse, an unchanged
  //        republish, a rollback with the registry moved; La Musa uncertified ───────────────────────────────────────────
  {
    const R = 'synth_legit';
    const v1 = await F.merchant(R);
    await F.publish(R, 'legit-certified');          // a certified version to edit from
    const idOf = (src, key) => { const it = src.items.find((x) => x.key === key); return it && it.display && it.display.identity_id; };
    const reorder = (src) => { src.structure.item_order = src.items.map((x) => x.key); return src; };
    let victim;
    await F.portalSaveAndPublish(R, (src, loaded) => {       // rename = delete the old identity + mint the new name
      const it = src.items[1]; victim = it.key; const oldId = idOf(src, it.key); src.deleted_ids_loaded_base = loaded;
      src.items[1] = { ...it, key: `${it.key} Renamed`, name: `${it.key} Renamed`, display: { ...it.display, name: `${it.key} Renamed` } }; delete src.items[1].display.identity_id;
      src.deleted_ids = [...(src.deleted_ids || []), oldId].filter(Boolean); return reorder(src);
    }, 'legit-rename');
    let gone;
    await F.portalSaveAndPublish(R, (src, loaded) => { gone = src.items.splice(2, 1)[0]; src.deleted_ids = [...(src.deleted_ids || []), gone.display.identity_id].filter(Boolean); src.deleted_ids_loaded_base = loaded; return reorder(src); }, 'legit-delete');
    await F.portalSaveAndPublish(R, (src) => { const back = { ...gone, display: { ...gone.display } }; delete back.display.identity_id; src.items.push(back); return reorder(src); }, 'legit-recreate');
    await F.portalSaveAndPublish(R, (src) => { const reuse = { ...src.items[0], key: victim, name: victim, display: { ...src.items[0].display, id: 9999, name: victim } }; delete reuse.display.identity_id; src.items.push(reuse); return reorder(src); }, 'legit-reuse');
    await F.portalSaveAndPublish(R, (src) => src, 'legit-unchanged');
    await F.rollback(R, v1);                         // the registry moved since v1 (rename, delete, recreate, reuse)
    await run1(R);
    const node = await F.nodeOf(R);
    assert.deepStrictEqual([node.summary.open_violations, (await open(R)).filter((k) => !k.startsWith('unattested') && k !== 'history_unknown')], [0, []], `no violation: ${JSON.stringify(await open(R))}`);
    await F.seed('la_musa'); await F.publish('la_musa', 'lm');
    await run1('la_musa');
    assert.deepStrictEqual([(await F.nodeOf('la_musa')).active.state, await open('la_musa')], ['uncertified', []]);
    ok('legitimate operations through the merchant\'s REAL path (editCatalogCore → publishEditedCore) → NO violation: a rename (old identity declared deleted + new name minted, P1a), a delete, a recreate, a name reuse, an unchanged republish, then a rollback across all of them with the registry moved; La Musa uncertified → state uncertified, no finding');
  }

  // ── 12. reducer on the real path: a crash before LOGGING re-logs the same counts; a crash before COMMIT loses nothing ──
  {
    const R = 'synth_crash';
    const v = await F.merchant(R); const [d0] = (await items(R, v)).filter((d) => d.data().display && d.data().display.identity_id);
    await d0.ref.update({ 'display.identity_id': 'PLANTED_ID' });
    later(16);
    const m = F.monitor({ log: (k) => { if (k === 'identity_integrity_state') throw new Error('crash before logging'); } });
    await assert.rejects(() => m.run({ listIds: async () => [R], quietMs: 0 }), /crash before logging/);
    let r = await run1(R);
    assert.ok(r.lines[0].open_violations >= 1, 'the next run emits the same counts from the committed (sticky) state');
    const before = JSON.stringify((await F.nodeOf(R)).findings);
    const failing = { ...rtdb, ref: (p) => { const ref = rtdb.ref(p); return p === `catalog_integrity/${R}` ? Object.assign(Object.create(ref), { transaction: async () => { throw new Error('crash before commit'); } }) : ref; } };
    later(16);
    const { createIdentityIntegrityMonitor } = require('../catalog/identity-integrity-monitor');
    await createIdentityIntegrityMonitor({ db, rtdb: failing, now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {} }).run({ listIds: async () => [R], quietMs: 0 });
    assert.strictEqual(JSON.stringify((await F.nodeOf(R)).findings), before, 'a failed commit changes nothing');
    r = await run1(R);
    assert.ok(r.lines[0].open_violations >= 1);
    ok('crash AFTER commit / before logging → the next run emits the same counts (sticky state); crash BEFORE commit → nothing changed, the next run re-derives the findings');
  }

  // ── 13. scheduling: > 400 objects → unavailable{oversized} BEFORE any object read; a budget deferral; oldest first;
  //        a stale deferred restaurant still emits and suppresses the heartbeat; acknowledgement while backed off ───────
  {
    const R = 'synth_big';
    await F.merchant(R, { dishes: 401, certify: false });
    let r = await run1(R);
    assert.deepStrictEqual([r.results[0].outcome, r.results[0].reason], ['unavailable', 'oversized']);
    assert.ok(r.reads < 60, `count-first: no object page read (${r.reads} reads)`);
    const A1 = 'synth_sch_a'; const B1 = 'synth_sch_b';
    await F.merchant(A1); await F.merchant(B1);
    const rA = await run1(A1); later(1); await run1(B1);                        // A checked before B → A is older
    // the cap fits the two node views of each restaurant + ONE full check of A (its measured cost), not B's first stage
    const cap = 4 + (rA.reads - 2) + 2;
    r = await (async () => { later(16); return F.runFor([A1, B1], { readCap: cap }); })();
    assert.deepStrictEqual(r.results.map((x) => `${x.rid}:${x.outcome}`), [`${A1}:checked`, `${B1}:deferred_budget`], 'oldest first; the next one deferred at a stage boundary');
    const nb = await F.nodeOf(B1);
    assert.ok(nb.coverage.failures === 1 && nb.coverage.retry_after > clock);
    // anti-starvation: once B's backoff expires its coverage is the OLDEST, so it goes FIRST and A is the one deferred
    later(31);
    r = await F.runFor([A1, B1], { readCap: cap });
    assert.deepStrictEqual(r.results.map((x) => `${x.rid}:${x.outcome}`), [`${B1}:checked`, `${A1}:deferred_budget`], 'oldest coverage first: one slow/expensive restaurant cannot starve another');
    // a FAILING restaurant (a malformed pointer: every check fails) is backed off, yet still emits its line every run; once its
    // first enumeration is > 45 min old with no coverage it is STALE and the heartbeat is suppressed
    const X = 'synth_failing';
    await F.merchant(X); await F.pointerRef(X).update({ generation: 'bad' });
    later(16); r = await F.runFor([A1, B1, X]);
    assert.strictEqual(r.results.find((x) => x.rid === X).outcome, 'failed');
    assert.ok((await F.nodeOf(X)).coverage.retry_after > clock, 'backed off');
    later(20); r = await F.runFor([A1, B1, X]);
    assert.ok(!r.results.some((x) => x.rid === X), 'skipped while backed off');
    const lx = r.lines.find((l) => l.rid === X);
    assert.ok(lx, 'a backed-off restaurant still emits its summary line');
    later(30); r = await F.runFor([A1, B1, X]);
    const lx2 = r.lines.find((l) => l.rid === X);
    assert.deepStrictEqual([lx2.stale, r.logged.some((x) => x.k === 'identity_integrity_heartbeat')], [1, false], 'stale (no coverage 45 min after first enumeration) → no heartbeat');
    // an acknowledgement while it is backed off: its next summary line excludes it
    await rtdb.ref(`catalog_integrity/${X}`).transaction((cur) => (cur === null ? null : S.withSize(S.applyAuditPage({ ...cur, audited_through: Number.isSafeInteger(cur.audited_through) ? cur.audited_through : 0 },
      { start: (Number.isSafeInteger(cur.audited_through) ? cur.audited_through : 0) + 1, end: Number.isSafeInteger(cur.audited_through) ? cur.audited_through : 0,
        findings: [require('../catalog/identity-integrity').finding('stamps_changed', 'planted', { generation: 0 })], obs_t: S.fromMs(clock), current: 0 }).node)));
    later(1); r = await F.runFor([A1, B1, X]);
    assert.strictEqual(r.lines.find((l) => l.rid === X).open_violations, 1, 'premise: the planted finding is counted');
    const fid = F.openFindings(await F.nodeOf(X))[0][0];
    assert.ok((await ACK.acknowledge({ rtdb, rid: X, finding: fid, note: 'planted', by: 'c2b-test', apply: true })).ok);
    later(1); r = await F.runFor([A1, B1, X]);
    assert.ok(!r.results.some((x) => x.rid === X) || r.results.find((x) => x.rid === X).outcome !== 'checked', 'still not covered');
    assert.strictEqual(r.lines.find((l) => l.rid === X).open_violations, 0, 'acknowledged while backed off → its next line excludes it');
    await F.pointerRef(X).update({ generation: 3 });
    ok('> 400 combined objects → unavailable{oversized} counted FIRST (no object page read); a budget deferral at a stage boundary, oldest coverage first, and the deferred one goes first next time (no starvation); a FAILING restaurant is backed off and skipped yet still emits its line every run, goes stale after 45 min and suppresses the heartbeat; an acknowledgement while backed off is excluded from its next line');
  }

  FINISHED = true;
  console.log(`c2b-integrity: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('c2b-integrity FAILED:', e); process.exit(1); });
