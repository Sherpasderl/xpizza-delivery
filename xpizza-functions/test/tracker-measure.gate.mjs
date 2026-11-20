#!/usr/bin/env node
// TRACKER FIXES r2.10.1 §8.4 — `npm run test:tracker-measure`: measure OFF and ON on the current tree and compare against the
// FROZEN limits in test/fixtures/tracker-measure.limits.json (every scenario present, zero handler failures, the retention checks,
// zero residual LIVE claims, each limit). Outputs go to a temp dir.
//
// asm12 (owner «break the test into pieces», advisor 11-19): EACH SCENARIO RUNS AS ITS OWN PIECE — its own child process
// (`tracker-measure.mjs --flag <f> --only <scenario>`), starting from that scenario's own world reset (the db wiped), under a HARD
// CAP. A full single-process run hung at a scenario BOUNDARY inside the harness (shiftEnd → the next scenario; harness backlog,
// asm13); every scenario is still measured, OFF and ON, and the pieces are merged into the same off/on documents the unchanged
// --compare reads. The scenario list is DERIVED from tracker-measure.mjs's own table (its `want(...)` guards), never typed here,
// and the gate REFUSES if a scenario in that table is not run, or a piece returns anything but exactly its own scenario.
// The suite is green only if every piece and the compare are green.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEASURE = path.join(here, 'tracker-measure.mjs');
const PIECE_CAP_MS = 300000;   // one scenario alone takes ~1 min; a piece past 5 min is a hang → FAIL (never a pass)

// the scenario table, derived from the measure script's own source: named `want('x')` guards + templated
// `for (const N of [..]) if (want(`prefix${N}`))` families
export function deriveScenarios(src) {
  const named = [...src.matchAll(/\bif \(want\('(\w+)'\)\)/g)].map((m) => m[1]);
  const families = [...src.matchAll(/for \(const N of \[([\d,\s]+)\]\) if \(want\(`(\w+)\$\{N\}`\)\)/g)]
    .flatMap((m) => m[1].split(',').map((n) => `${m[2]}${n.trim()}`));
  const guards = (src.match(/\bif \(want\(/g) || []).length;
  const familyLoops = [...src.matchAll(/for \(const N of \[[\d,\s]+\]\) if \(want\(`/g)].length;
  const assigned = [...src.matchAll(/^if \(want\('(\w+)'\)\) scenarios\.(\w+) = await/gm)].map((m) => [m[1], m[2]]);
  const problems = [];
  if (named.length + familyLoops !== guards) problems.push(`${guards} want(...) guards, but ${named.length} named + ${familyLoops} templated families were derived`);
  // the GROUND TRUTH is what the script stores: every `scenarios.x =` and `scenarios[`p${N}`] =` must be a derived scenario /
  // family — a scenario stored under a guard this derivation cannot read (renamed helper, odd spacing) is refused, never dropped
  const storedNamed = [...src.matchAll(/\bscenarios\.(\w+)\s*=(?!=)/g)].map((m) => m[1]);
  const storedFamilies = [...src.matchAll(/\bscenarios\[`(\w+)\$\{N\}`\]\s*=(?!=)/g)].map((m) => m[1]);
  const familyPrefixes = [...src.matchAll(/for \(const N of \[[\d,\s]+\]\) if \(want\(`(\w+)\$\{N\}`\)\)/g)].map((m) => m[1]);
  for (const x of storedNamed) if (!named.includes(x)) problems.push(`scenarios.${x} is stored but no \`if (want('${x}'))\` guard was derived`);
  for (const p of storedFamilies) if (!familyPrefixes.includes(p)) problems.push(`scenarios[\`${p}\${N}\`] is stored but no \`for (const N of [...]) if (want(\`${p}\${N}\`))\` family was derived`);
  for (const [w, s] of assigned) if (w !== s) problems.push(`want('${w}') stores scenarios.${s}`);
  const all = [...named, ...families];
  if (new Set(all).size !== all.length) problems.push(`duplicate scenario names: ${all.join(', ')}`);
  return { scenarios: all, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = fs.readFileSync(MEASURE, 'utf8');
  const { scenarios: SCN, problems } = deriveScenarios(src);
  if (problems.length || SCN.length < 1) { console.error(`tracker-measure gate: FAIL — the scenario table could not be derived:\n  ${problems.join('\n  ') || 'no scenario'}`); process.exit(1); }
  console.log(`tracker-measure gate: ${SCN.length} scenarios derived from tracker-measure.mjs: ${SCN.join(', ')}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-measure-'));
  // Each step gets this process's preloads (execArgv): under the gate that is the egress guard, the NULL guard and the
  // cell counter, which emulator-run puts on argv only (not NODE_OPTIONS) — a step spawned without it prints marks nobody counts.
  const run = (args, label) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [...process.execArgv, ...args], { stdio: 'inherit', env: process.env, timeout: PIECE_CAP_MS, killSignal: 'SIGKILL' });
    const s = ((Date.now() - t0) / 1000).toFixed(0);
    const ok = r.status === 0 && !r.signal && !r.error;
    console.log(`tracker-measure piece ${label}: ${ok ? 'OK' : `FAIL (${r.error && r.error.code === 'ETIMEDOUT' ? `HUNG past the ${PIECE_CAP_MS / 1000} s cap` : r.signal ? `signal ${r.signal}` : `rc ${r.status}`})`} ${s}s`);
    return ok;
  };
  let rc = 0;
  try {
    const failed = [];
    for (const f of ['off', 'on']) {
      const merged = { flag: f, scenarios: {} };
      for (const sc of SCN) {
        const out = path.join(tmp, `${f}-${sc}.json`);
        if (!run([MEASURE, '--flag', f, '--only', sc, '--out', out], `${f}/${sc}`)) { failed.push(`${f}/${sc}`); continue; }
        const got = JSON.parse(fs.readFileSync(out, 'utf8')).scenarios || {};
        const keys = Object.keys(got);
        if (keys.length !== 1 || keys[0] !== sc) { failed.push(`${f}/${sc} returned [${keys.join(', ')}]`); continue; }
        merged.scenarios[sc] = got[sc];
      }
      fs.writeFileSync(path.join(tmp, `${f}.json`), JSON.stringify(merged, null, 1) + '\n');
    }
    if (failed.length) { console.error(`tracker-measure gate: FAIL — ${failed.length} piece(s): ${failed.join(', ')}`); rc = 1; }
    else if (!run([MEASURE, '--compare', path.join(tmp, 'off.json'), path.join(tmp, 'on.json')], 'compare')) rc = 1;
    else console.log(`tracker-measure gate: OK (${SCN.length} scenarios × OFF/ON, each its own piece)`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(rc);
}
