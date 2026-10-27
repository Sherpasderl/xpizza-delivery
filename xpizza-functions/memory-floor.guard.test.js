'use strict';
// MEMORY FLOOR: no deployed function may declare less than 256 MiB.
// Every non-isolated instance loads ALL of index.js at cold start (firebase-admin + every module), and that already
// exceeds 128 MiB: formSignal shipped with memory '128MiB' (train next-after-bd777b6d, D5 2026-10-27) and its first
// revision died at boot with «Memory limit of 128 MiB exceeded with 156 MiB used». No emulator or local suite
// enforces a memory limit, so nothing caught it before the deploy. Two checks:
//   1. SOURCE: every `memory:` property in the deployed entry files (index.js, the isolated portal entries, and the
//      modules that build their own options) is a literal >= 256MiB, or a constant that resolves to one.
//   2. RUNTIME: the REAL loaded exports of index.js: every function's __endpoint.availableMemoryMb is >= 256 or unset
//      (the v2 default is 256 MiB).
// Run: node memory-floor.guard.test.js        (no emulator; loading index.js never reaches a database)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FLOOR_MB = 256;
const toMb = (s) => { const m = /^(\d+)(Mi|Gi)B$/.exec(s); return m ? Number(m[1]) * (m[2] === 'Gi' ? 1024 : 1) : NaN; };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1. SOURCE ──
const ENTRY_FILES = ['index.js', 'portal/functions.js', 'portal/ops-functions.js', 'portal/reset-draft.js', 'access/team-http.js', 'whatsapp/instance-health.js'];
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const constValue = (src, name) => { const m = new RegExp(`\\b${name.split('.').pop()}\\s*[:=]\\s*'([^']+)'`).exec(src); return m ? m[1] : null; };
let sites = 0; const low = [];
for (const f of ENTRY_FILES) {
  const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  for (const m of src.matchAll(/\bmemory:\s*('([^']*)'|[A-Za-z_][\w.]*)/g)) {
    sites++;
    let v = m[2];
    if (v === undefined) {   // a constant: resolve it in this file, else in the module it names (IIM.INTEGRITY_MEMORY)
      v = constValue(src, m[1]);
      if (v === null) for (const mod of fs.readdirSync(path.join(__dirname, 'catalog')).filter((x) => x.endsWith('.js'))) {
        v = constValue(fs.readFileSync(path.join(__dirname, 'catalog', mod), 'utf8'), m[1]); if (v !== null) break;
      }
    }
    const mb = toMb(v || '');
    if (!(mb >= FLOOR_MB)) low.push(`${f}: memory ${m[1]}${v && v !== m[2] ? ` = '${v}'` : ''}`);
  }
}
assert.ok(sites >= 50, `premise: the scan sees the option objects (${sites} memory: sites)`);
assert.deepStrictEqual(low, [], `🔴 memory below ${FLOOR_MB} MiB in a deployed entry (every instance loads all of index.js; 128 MiB OOMs at boot):\n  ${low.join('\n  ')}`);
assert.ok(!(toMb('128MiB') >= FLOOR_MB) && toMb('256MiB') >= FLOOR_MB && toMb('1GiB') >= FLOOR_MB, 'non-vacuity: the comparison rejects 128MiB and accepts 256MiB / 1GiB');
ok(`source: ${sites} memory: declarations across ${ENTRY_FILES.length} entry files, every one >= ${FLOOR_MB} MiB`);

// ── 2. RUNTIME (the real exports) ──
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'memory-floor-secret';
const app = require('./index.js');
const fns = Object.entries(app).filter(([, v]) => v && v.__endpoint);
assert.ok(fns.length >= 100, `premise: the real exports load (${fns.length} functions)`);
// unset memory reads as undefined or the SDK's ResetValue placeholder (= the 256 MiB v2 default); a number must clear the
// floor; anything else (an unresolved param expression) cannot be verified here and fails
const isUnset = (m) => m === undefined || (m !== null && typeof m === 'object' && m.constructor && m.constructor.name === 'ResetValue');
const lowRt = fns.filter(([, v]) => { const m = v.__endpoint.availableMemoryMb; return !isUnset(m) && !(typeof m === 'number' && m >= FLOOR_MB); })
  .map(([k, v]) => { const m = v.__endpoint.availableMemoryMb; return `${k}: ${typeof m === 'number' ? m + ' MiB' : 'unverifiable ' + (m && m.constructor ? m.constructor.name : typeof m)}`; });
const tally = fns.reduce((t, [, v]) => { const m = v.__endpoint.availableMemoryMb; const k = isUnset(m) ? 'default' : String(m); t[k] = (t[k] || 0) + 1; return t; }, {});
assert.deepStrictEqual(lowRt, [], `🔴 exported function(s) below ${FLOOR_MB} MiB:\n  ${lowRt.join('\n  ')}`);
ok(`runtime: ${fns.length} exported functions, none below ${FLOOR_MB} MiB (${Object.entries(tally).map(([k, c]) => `${k}: ${c}`).join(', ')}; default = the 256 MiB v2 default)`);

console.log(`\nmemory-floor.guard: OK (${n})`);
process.exit(0);
