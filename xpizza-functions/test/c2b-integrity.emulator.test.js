'use strict';
/* 1D D4-c2b — THE IDENTITY INTEGRITY MONITOR on the Firestore + RTDB EMULATORS, over evidence written by the REAL c2a writers
   (publishVersion / rollbackVersion / bootstrapIdentityStamps). Run: npm run test:c2b-integrity
   Expected values come from the plan (PLAN-D4c2b rev 14) and from Firestore, never from the code under test. */
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
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

  FINISHED = true;
  console.log(`c2b-integrity: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('c2b-integrity FAILED:', e); process.exit(1); });
