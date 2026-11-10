'use strict';
// R3 census HEADROOM guard (advisor ruling 2026-11-08, PLAN-write-provenance-headroom.md (1)). census() — and with it the
// write-provenance pass — runs in a child under a fixed budget: a 1 GB old-space heap and a 60 s wall clock. At c20c92f4 it
// needs ~0.4 GB and ~3 s. A by-name fan-out (a member call on an unresolvable receiver whose same-named wrapper re-enters it,
// as `deps.now()` did before 'now' joined COMMON) grows past both, and is RED here in the PR that adds it — not as an
// out-of-memory at the next train's assembly.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const HEAP_MB = 1024;
const WALL_MS = 60000;
const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');   // a tree to measure (mutant runs); default: this one
const FAIL = (msg) => `🔴 R3-CENSUS-HEADROOM ${msg} — likely a by-name fan-out in contract/write-provenance.js (fnsFor's by-name fallback re-entered through a same-named wrapper; see COMMON and PLAN-write-provenance-headroom.md)`;

const CHILD = `const t0 = Date.now(); const r = require(${JSON.stringify(path.join(DIR, 'contract', 'census.js'))}).census();
if (!r || !Array.isArray(r.writes)) throw new Error('census() returned no write inventory');
const h = require('v8').getHeapStatistics();
console.log(JSON.stringify({ ms: Date.now() - t0, heapMB: Math.round(h.total_heap_size / 2 ** 20), writes: r.writes.length }));`;

// NODE_OPTIONS is dropped so an inherited --max-old-space-size cannot widen the budget
const env = { ...process.env }; delete env.NODE_OPTIONS;
const t0 = Date.now();
const res = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, '-r', path.join(DIR, 'tools', 'egress-guard.js'), '-e', CHILD],
  { cwd: DIR, env, encoding: 'utf8', timeout: WALL_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 2 ** 20 });
const wall = Date.now() - t0;
const tail = `${res.stderr || ''}`.trim().split('\n').slice(-3).join('\n  ');

assert.ok(!(res.error && res.error.code === 'ETIMEDOUT') && res.signal !== 'SIGKILL', FAIL(`census() exceeded the ${WALL_MS / 1000} s budget (killed after ${wall} ms)`));
assert.ok(!/heap out of memory|Allocation failed/.test(res.stderr || ''), FAIL(`census() exceeded the ${HEAP_MB} MB heap budget:\n  ${tail}`));
assert.strictEqual(res.status, 0, FAIL(`the census child failed (status ${res.status}, signal ${res.signal}):\n  ${tail}`));
const m = JSON.parse(`${res.stdout}`.trim().split('\n').pop());
assert.ok(m.writes > 0, FAIL('premise — census() produced an empty write inventory'));

console.log(`  ✓ 1 census() within budget: ${m.ms} ms (cap ${WALL_MS / 1000} s), heap ${m.heapMB} MB (cap ${HEAP_MB} MB), ${m.writes} write records`);
console.log('\nr3-census headroom guard: OK (1)');
