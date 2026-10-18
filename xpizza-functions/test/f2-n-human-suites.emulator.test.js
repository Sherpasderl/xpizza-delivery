/**
 * PLATFORM F2 Q1 (PLAN-F2-query-rules §1.5, §1.8; codex Q1 r1 P2-7) — the EXISTING svc / eligibility proofs run to COMPLETION against
 * the candidate N-human rules (xpizza-reference/f2-narrow/N-human.rules.json), unmodified except:
 *   - the rules file they load (N-human instead of database.rules.json), and
 *   - an EXPLICIT, pinned per-cell list of expectation flips in driver-eligibility-rules: the cells whose subject is a WHOLE-
 *     COLLECTION read by a non-dispatcher, which N-human denies BY DESIGN (each flip must apply exactly once — none stale).
 * Every other cell — the svc claim / finalize / shift-open writes in tolerant AND CLOSED mode, the svc leaf-scoping denials, the
 * deactivated-driver denials, the real completion batch — runs as written. Fixture reads stay on the rules-disabled path.
 * driver-assignment-parity runs with no flips at all (every real svc writer, rules-enforced as svc-assigner, no fallback).
 *   npm run test:f2-n-human-suites
 */
require('./_emulator-required')('database');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const N_HUMAN = "path.join(__dirname, '..', '..', 'xpizza-reference', 'f2-narrow', 'N-human.rules.json')";
const BASE_RULES = "path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json')";
// whole-collection reads that N-human denies by design (consumers move to scoped queries in Q2; the suites' cells migrate at Q4)
const ELIGIBILITY_FLIPS = [
  "await ok('enabled driver reads /tasks',",
  "await ok('enabled driver reads /orders',",
  "await ok('enabled driver reads /order_timelines',",
  "await ok('enabled driver still reads /tasks',",
];
const SUITES = [
  { file: 'driver-eligibility-rules.emulator.test.js', flips: ELIGIBILITY_FLIPS, marker: /driver-eligibility-rules\(emulator\): OK \((\d+)\)/ },
  { file: 'driver-assignment-parity.emulator.test.js', flips: [], marker: /driver-assignment-parity\(emulator\): OK \((\d+)\)/ },
];

let n = 0; const pass = (l) => console.log(`  ✓ ${++n} ${l}`);
for (const s of SUITES) {
  let src = fs.readFileSync(path.join(__dirname, s.file), 'utf8');
  assert.strictEqual(src.split(BASE_RULES).length - 1, 1, `${s.file}: loads the base rules exactly once`);
  src = src.replace(BASE_RULES, N_HUMAN);
  for (const f of s.flips) {
    assert.strictEqual(src.split(f).length - 1, 1, `${s.file}: flip "${f}" must match exactly once (stale or ambiguous otherwise)`);
    src = src.replace(f, f.replace('await ok(', "await no('[N-human: whole-collection read DENIED by design] ' + "));
  }
  const tmp = path.join(__dirname, `.f2-n-human-${process.pid}-${s.file}`);
  fs.writeFileSync(tmp, src);
  try {
    const r = spawnSync(process.execPath, [tmp], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 600000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = s.marker.exec(out);
    assert.ok(r.status === 0 && m, `${s.file} under N-human did not complete green (exit ${r.status}):\n${out.slice(-2500)}`);
    const flipped = (out.match(/\[N-human: whole-collection read DENIED by design\]/g) || []).length;
    assert.strictEqual(flipped, s.flips.length, `${s.file}: every pinned flip ran (${flipped}/${s.flips.length})`);
    pass(`${s.file} under N-human: ran to COMPLETION — ${m[1]} cells green (${s.flips.length} explicit whole-collection-read denials, every other cell as written)`);
  } finally { fs.rmSync(tmp, { force: true }); }
}
console.log(`f2-n-human-suites.emulator: OK (${n})`);
