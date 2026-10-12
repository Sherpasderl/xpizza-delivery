'use strict';
// R3 §1a — the GATE witness attributes each result by IDENTITY to the gate's own cache entry (codex r1 P1-6, r2 P1-2).
// Against the REAL gate reader (catalog/menu-gates.js); static, no emulator, no index.js.
const assert = require('assert');
const W = require('./version-witness').install();
const { ALS } = require('./scheduler');
const { createGateReader } = require('../catalog/menu-gates');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const F = (m) => `🔴 R3-WITNESS ${m}`;
// a built menu per version; weekend_only_cats AUTHORED so each version's cache entry has its OWN objects
const builtFor = (v) => ({ items: [{ key: `${v}-dish`, display: { cat: 'individual' } }], structure: { weekend_only_cats: [], menu_categories: ['individual'] } });
const run = (store, fn) => ALS.run(store, fn);

(async () => {
  // r1: A selects V1 and waits on its menu; the pointer expires; B selects + completes V2; A completes last
  {
    let pointer = 'V1'; let T = 0; let releaseA;
    const holdA = new Promise((r) => { releaseA = r; });
    const reader = createGateReader({ getVersionId: async () => pointer, getMenu: async (rid, v) => { if (v === 'V1') await holdA; return builtFor(v); }, nowMs: () => T, pointerTtlMs: 45000 });
    const A = { served: [] }; const B = { served: [] };
    const pa = run(A, () => reader.intakeGatesFor('x_pizza'));
    await new Promise((r) => setImmediate(r));
    pointer = 'V2'; T = 100000;
    await run(B, () => reader.intakeGatesFor('x_pizza'));
    releaseA(); await pa;
    assert.strictEqual(B.gates[0].versionId, 'V2', F(`B ${JSON.stringify(B.gates[0])}`));
    assert.strictEqual(A.gates[0].versionId, 'V1', F(`A (selected V1, completed after B) ${JSON.stringify(A.gates[0])}`));
    ok(`interleaving (r1): A=${A.gates[0].versionId}, B=${B.gates[0].versionId} — each by identity with its own cache entry`);
  }
  // r2: A's V1 POINTER read outlasts the gate's deadline (A falls back); B fetches V2 and caches it; A's late V1
  // completion lands; C serves the cached V2 gates → C must be V2 (a rejected pointer completion cannot poison it)
  {
    let T = 0; const deadlineMs = 40;
    let first = true;
    const reader = createGateReader({
      getVersionId: async () => { if (first) { first = false; await new Promise((r) => setTimeout(r, 200)); return 'V1'; } return 'V2'; },
      getMenu: async (rid, v) => builtFor(v), nowMs: () => T, pointerTtlMs: 45000, deadlineMs,
    });
    const A = { served: [] }; const B = { served: [] }; const C = { served: [] };
    await run(A, () => reader.intakeGatesFor('la_musa'));                   // times out → fallback
    await run(B, () => reader.intakeGatesFor('la_musa'));                   // fetches V2, caches V2
    await new Promise((r) => setTimeout(r, 300));                          // A's late V1 completion has landed
    await run(C, () => reader.intakeGatesFor('la_musa'));                   // pointer + gates cached → V2
    assert.ok(A.gates[0].fallback && A.gates[0].versionId === null, F(`A must be a fallback with no version ${JSON.stringify(A.gates[0])}`));
    assert.strictEqual(B.gates[0].versionId, 'V2', F(`B ${JSON.stringify(B.gates[0])}`));
    assert.strictEqual(C.gates[0].versionId, 'V2', F(`C served the cached V2 gates but was attributed ${JSON.stringify(C.gates[0])} (a late, REJECTED pointer completion poisoned the witness)`));
    assert.ok(W.pointerReads().some((x) => x.rid === 'la_musa' && x.versionId === 'V1'), 'premise — the late V1 pointer completion did happen');
    ok(`late rejected pointer (r2): A fallback (no version), B=V2, C (cached)=${C.gates[0].versionId} via ${C.gates[0].via} — the late V1 completion did not poison it`);
  }
  assert.strictEqual(W.unattributed().length, 0, 'every call was attributed to its own writer context');
  console.log(`\nr3-version-witness: OK (${n})`);
})().catch((e) => { console.error('r3-version-witness FAILED:', e && e.stack || e); process.exit(1); });
