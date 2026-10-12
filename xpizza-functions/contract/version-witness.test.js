'use strict';
// R3 §1a — the GATE witness binds provenance PER CALL (codex r1 P1-6). Reproduces codex's interleaving against the REAL
// gate reader (catalog/menu-gates.js): call A selects V1 and waits on its menu; the pointer expires; call B selects and
// completes V2; then A completes. A must be attributed V1, B V2. Static (no emulator, no index.js).
const assert = require('assert');
const W = require('./version-witness').install();
const { ALS } = require('./scheduler');
const { createGateReader } = require('../catalog/menu-gates');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  let pointer = 'V1'; let T = 0; let releaseA;
  const holdA = new Promise((r) => { releaseA = r; });
  const built = { items: [], structure: { weekend_only_cats: [], menu_categories: [] } };
  const reader = createGateReader({
    getVersionId: async () => pointer,
    getMenu: async (rid, v) => { if (v === 'V1') await holdA; return built; },
    nowMs: () => T, pointerTtlMs: 45000,
  });
  const A = { served: [] }; const B = { served: [] };
  const pa = ALS.run(A, () => reader.intakeGatesFor('x_pizza'));         // selects V1, waits on V1's menu
  await new Promise((r) => setImmediate(r));
  pointer = 'V2'; T = 100000;                                            // the pointer cache expires; the active version is V2
  await ALS.run(B, () => reader.intakeGatesFor('x_pizza'));              // selects V2, completes
  releaseA(); await pa;                                                  // A completes LAST
  const a = (A.gates || [])[0]; const b = (B.gates || [])[0];
  assert.ok(a && b, 'premise — both calls recorded a witness');
  assert.strictEqual(b.versionId, 'V2', `🔴 R3-WITNESS call B attributed ${JSON.stringify(b)}`);
  assert.strictEqual(a.versionId, 'V1', `🔴 R3-WITNESS call A (selected V1, completed after B selected V2) attributed ${JSON.stringify(a)}`);
  ok(`interleaved gate calls: A selected V1, B selected + completed V2, A completed last → A=${a.versionId} (${a.via}), B=${b.versionId} (${b.via})`);
  // a cached-pointer call: no pointer fetch, no menu read (both cached) → attributed the cached pointer it started with
  const C = { served: [] };
  await ALS.run(C, () => reader.intakeGatesFor('x_pizza'));
  assert.strictEqual(C.gates[0].versionId, 'V2', `🔴 R3-WITNESS cached call attributed ${JSON.stringify(C.gates[0])}`);
  ok(`a fully cached call is attributed the version its menu read / pointer cache served (${C.gates[0].versionId}, ${C.gates[0].via})`);
  assert.strictEqual(W.unattributed().length, 0, 'every call was attributed to its own writer context');
  console.log(`\nr3-version-witness: OK (${n})`);
})().catch((e) => { console.error('r3-version-witness FAILED:', e && e.stack || e); process.exit(1); });
