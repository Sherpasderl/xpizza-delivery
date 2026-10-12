'use strict';
/* 1D D4-c2b — CAPACITY, TIME, MEMORY and PACING on the Firestore + RTDB EMULATORS (PLAN-D4c2b rev 14 §5), on the REAL clock and
   the REAL pacer (no virtual time): ten 400-object merchants — one SLOW (injected read latency), one FAILING (a malformed pointer)
   — must each be covered within 3 runs, with the 30 s summary reserve intact; the measured envelope is REPORTED. Peak RSS is
   sampled IN THE MONITOR'S OWN fresh process (test/_c2b-monitor-child.js — the deployed function's footprint) during the
   400-object runs and the long-value (1,125-char keys) and escape-heavy (control-character keys) runs. Asserted per the advisor's
   ruling R2 (clarifying §5's "< 256 MiB", which conflated the codebase baseline with the monitor's cost): the monitor's own
   increment (peak − the process baseline after index.js loads) ≤ 130 MiB AND the total < 512 MiB; all three reported; the real pacing log is asserted ≤ 100 reads in every 1 s window. Run: npm run test:c2b-capacity */
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const assert = require('assert');
require('../index.js');
const admin = require('firebase-admin');
const { fixture } = require('./_c2b-fixture');
const { SUMMARY_RESERVE_MS, INTEGRITY_TIMEOUT_S, RUN_READ_CAP } = require('../catalog/identity-integrity-monitor');
const { encodeKey } = require('../catalog/identity-registry');

const db = admin.firestore(); const rtdb = admin.database();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('c2b-capacity: FAILED — exited without completing'); process.exitCode = 1; } });
const F = fixture({ db, rtdb });   // the REAL clock and sleep
const MiB = 1024 * 1024;

const { execFileSync } = require('child_process');
const path = require('path');
// ONE monitor run in a FRESH child process (the deployed function's own footprint, sampled there)
function monitorRun(input) {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.FORCE_COLOR;
  const out = execFileSync('node', [path.join(__dirname, '_c2b-monitor-child.js'), JSON.stringify(input)], { encoding: 'utf8', env, maxBuffer: 1 << 27, timeout: 600000 });
  const r = JSON.parse(out.trim().split('\n').pop()); if (r.error) throw new Error(r.error); return r;
}

(async () => {
  // ── 1. TEN 400-object merchants (one slow, one failing): every healthy one covered within 3 runs, the summary reserve kept ──
  const RIDS = Array.from({ length: 10 }, (_, i) => `synth_cap_${String(i).padStart(2, '0')}`);
  const SLOW = RIDS[3]; const FAILING = RIDS[7];
  const t0 = Date.now();
  for (const R of RIDS) await F.merchant(R, { dishes: 400 });
  await F.pointerRef(FAILING).update({ generation: 'bad' });
  console.log(`     setup: ten 400-object merchants published + certified in ${Math.round((Date.now() - t0) / 1000)} s`);
  const covered = new Set(); const runs = [];
  const lineStamps = [];
  for (let k = 1; k <= 3 && covered.size < RIDS.length - 1; k += 1) {
    const r = monitorRun({ rids: RIDS, slow: { rid: SLOW, ms: 15 }, nowOffsetMs: (k - 1) * 15 * 60 * 1000 });   // the schedule: runs 15 min apart
    for (const x of r.results) if (x.outcome === 'checked') covered.add(x.rid);
    runs.push({ run: k, ms: r.ms, summaryAt: r.summaryAt, reads: r.reads, checked: r.results.filter((x) => x.outcome === 'checked').map((x) => x.rid), outcomes: r.results.map((x) => `${x.rid.slice(-2)}:${x.outcome}`), peakMiB: Math.round(r.peakRss / MiB), baseMiB: Math.round(r.baseRss / MiB), heapAtPeakMiB: r.atPeak ? Math.round(r.atPeak.heapUsed / MiB) : null });
    const firstSummary = r.summaryAt !== null;
    console.log(`     run ${k}: ${Math.round(runs[k - 1].ms / 1000)} s, summaries at ${Math.round(runs[k - 1].summaryAt / 1000)} s, ${r.reads} reads, checked ${runs[k - 1].checked.length}, RSS baseline ${runs[k - 1].baseMiB} + increment ${runs[k - 1].peakMiB - runs[k - 1].baseMiB} = total ${runs[k - 1].peakMiB} MiB (heap at peak ${runs[k - 1].heapAtPeakMiB}) — ${runs[k - 1].outcomes.join(' ')}`);
    lineStamps.push(r.lines.length);
    assert.strictEqual(r.lines.length, RIDS.length, `run ${k}: one summary line for EVERY enumerated restaurant (incl. the failing one)`);
    assert.ok(firstSummary && r.summaryAt <= (INTEGRITY_TIMEOUT_S * 1000) - SUMMARY_RESERVE_MS, `run ${k}: summaries began with ≥ ${SUMMARY_RESERVE_MS / 1000} s of the ${INTEGRITY_TIMEOUT_S} s left (at ${Math.round(r.summaryAt / 1000)} s)`);
    // §5 as clarified by the advisor (ruling R2): the MONITOR'S OWN increment (peak − the process baseline after index.js loads)
    // ≤ the plan's 130 MiB worst-case arithmetic, AND the total < the deployed 512 MiB container; all three reported
    assert.ok(r.peakRss - r.baseRss <= 130 * MiB, `run ${k}: the monitor's own increment ${Math.round((r.peakRss - r.baseRss) / MiB)} MiB ≤ 130 MiB`);
    assert.ok(r.peakRss < 512 * MiB, `run ${k}: total peak ${Math.round(r.peakRss / MiB)} MiB < 512 MiB`);
    assert.ok(r.reads <= RUN_READ_CAP, `run ${k}: ${r.reads} reads ≤ the ${RUN_READ_CAP} cap`);
    // pacing: ≤ 100 reads in EVERY 1 s window (real time)
    for (const [ts] of r.pacing) { const w = r.pacing.filter(([t]) => t >= ts && t < ts + 1000).reduce((s, [, c]) => s + c, 0); assert.ok(w <= 100, `run ${k}: ${w} reads in the 1 s window from ${ts}`); }
  }
  const healthy = RIDS.filter((x) => x !== FAILING);
  assert.deepStrictEqual(healthy.filter((x) => !covered.has(x)), [], `every healthy merchant (incl. the slow one) covered within ${runs.length} run(s)`);
  assert.ok(covered.has(SLOW));
  assert.ok(!covered.has(FAILING) && (await F.nodeOf(FAILING)).coverage.failures >= 1, 'the failing one is backed off, never covered, still emitting');
  ok(`TIMED capacity (real clock, real pacing): ten 400-object merchants incl. one SLOW (+15 ms per read) and one FAILING — all ${healthy.length} healthy covered within ${runs.length} run(s) (per run: ${runs.map((x) => `${x.checked.length} checked / ${x.reads} reads / ${Math.round(x.ms / 1000)} s`).join('; ')}); summaries always began with the 30 s reserve intact; a summary line for all 10 every run; ≤ 100 reads in every 1 s window; monitor RSS increment ≤ ${Math.max(...runs.map((x) => x.peakMiB - x.baseMiB))} MiB (≤ 130), total ≤ ${Math.max(...runs.map((x) => x.peakMiB))} MiB (< 512)`);

  // ── 2. LONG-VALUE and ESCAPE-HEAVY keys on a 400-object version: the monitor completes, peak RSS < 256 MiB ─────────────
  {
    const peaks = {};
    for (const [label, keyOf] of [['long-value (1,125-char keys)', (i) => `${'k'.repeat(1121)}${String(i).padStart(4, '0')}`],
      ['escape-heavy (control-character keys, 6× encoded)', (i) => `${'\u0001'.repeat(1100)}${String(i).padStart(4, '0')}`]]) {
      const R = label.startsWith('long') ? 'synth_cap_long' : 'synth_cap_esc';
      await F.merchant(R, { dishes: 400 });
      const p = await require('../catalog/catalog-firestore').getActivePointer(db, R);
      const docs = (await F.versionsColOf(R).doc(p.version).collection('menu_items').get()).docs;
      const w = db.bulkWriter();
      docs.forEach((d, i) => { w.update(d.ref, { key: keyOf(i) }); w.set(db.doc(`restaurants/${R}/identity/dish/keys/${encodeKey(keyOf(i))}`), { canonical_id: d.data().display.identity_id, kind: 'dish' }); });
      await w.close();
      const r = monitorRun({ rids: [R] }); const pk = r.peakRss; const inc = r.peakRss - r.baseRss;
      assert.strictEqual(r.results[0].outcome, 'checked', `${label}: the check completed (${JSON.stringify(r.results[0])})`);
      peaks[label] = `baseline ${Math.round(r.baseRss / MiB)} + increment ${Math.round(inc / MiB)} = total ${Math.round(pk / MiB)} MiB`;
      assert.ok(inc <= 130 * MiB, `${label}: the monitor's own increment ${Math.round(inc / MiB)} MiB ≤ 130 MiB`);
      assert.ok(pk < 512 * MiB, `${label}: total ${Math.round(pk / MiB)} MiB < 512 MiB`);
    }
    ok(`monitor-process RSS during the long-value and escape-heavy 400-object checks: ${Object.entries(peaks).map(([k, v]) => `${k}: ${v}`).join('; ')} — increment ≤ 130 MiB (the plan's arithmetic), total < 512 MiB (advisor ruling R2)`);
  }

  // ── 3. WORST CASE for retention (codex build r1 P1-1): 400 objects whose values sit AT and FAR PAST the §5 pair budget ──────
  //    (a) at the edge: 400 × ~10,000-byte keys ≈ 4.0 MB raw (just under 4 MiB) — every pair retained, the digest built, the
  //        registry judged batch by batch (keys > 1,125 bytes have no valid key-row id → judged without a read);
  //    (b) far past it: 400 × ~40,000-byte keys ≈ 16 MB raw — reading STOPS at the first pair past the budget →
  //        unavailable{oversized_values}, nothing more retained, the registry never read.
  //    Both in the monitor's own fresh process: increment ≤ 130 MiB, total < 512 MiB (R2).
  {
    const out = {};
    for (const [label, R, bytes] of [['at the budget (400 × ~10 KB keys)', 'synth_cap_edge', 10000], ['far past it (400 × ~40 KB keys)', 'synth_cap_over', 40000]]) {
      await F.merchant(R, { dishes: 400 });
      const p = await require('../catalog/catalog-firestore').getActivePointer(db, R);
      const docs = (await F.versionsColOf(R).doc(p.version).collection('menu_items').get()).docs;
      const w = db.bulkWriter();
      docs.forEach((d, i) => { w.update(d.ref, { key: `${String(i).padStart(4, '0')}${'v'.repeat(bytes)}` }); });
      await w.close();
      const r = monitorRun({ rids: [R] }); const inc = r.peakRss - r.baseRss;
      const chk = r.checks.find((c) => c.rid === R) || {};
      const node = await F.nodeOf(R);
      out[label] = { outcome: r.results[0].outcome, state: chk.state, reason: node.active && node.active.reason, coverage: !!(node.coverage && node.coverage.active_ok_obs_t), mib: `baseline ${Math.round(r.baseRss / MiB)} + increment ${Math.round(inc / MiB)} = total ${Math.round(r.peakRss / MiB)} MiB`, reads: r.reads };
      assert.ok(inc <= 130 * MiB, `${label}: the monitor's own increment ${Math.round(inc / MiB)} MiB ≤ 130 MiB`);
      assert.ok(r.peakRss < 512 * MiB, `${label}: total ${Math.round(r.peakRss / MiB)} MiB < 512 MiB`);
    }
    const edge = out['at the budget (400 × ~10 KB keys)']; const over = out['far past it (400 × ~40 KB keys)'];
    assert.deepStrictEqual([edge.outcome, edge.state], ['checked', 'violation'], `at the budget: judged (the edited keys break the binding) ${JSON.stringify(edge)}`);
    // past the budget: the check ran and recorded unavailable{oversized_values} — NOT coverage, never a violation (classifier §2.4/§5)
    assert.deepStrictEqual([over.state, over.reason, over.coverage], ['unavailable', 'oversized_values', false], `past the budget: unavailable{oversized_values}, not coverage ${JSON.stringify(over)}`);
    assert.ok(over.reads < edge.reads, `past the budget the read STOPS early (${over.reads} vs ${edge.reads} reads)`);
    ok(`WORST-CASE retention: ${Object.entries(out).map(([k, v]) => `${k}: ${v.outcome}${v.state ? `/${v.state}` : ''}${v.reason ? `{${v.reason}}` : ''}, ${v.reads} reads, ${v.mib}`).join('; ')} — increment ≤ 130 MiB, total < 512 MiB (R2)`);
  }

  console.log(`     envelope: ${JSON.stringify(runs.map(({ run, ms, summaryAt, reads, checked, peakMiB }) => ({ run, s: Math.round(ms / 1000), summary_s: Math.round(summaryAt / 1000), reads, checked: checked.length, peakMiB })))}`);
  FINISHED = true;
  console.log(`c2b-capacity: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('c2b-capacity FAILED:', e); process.exit(1); });
