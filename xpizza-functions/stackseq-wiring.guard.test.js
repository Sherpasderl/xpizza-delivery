'use strict';
// STACKED-DELIVERY SEQUENCING (BUILD-stacked-seq-server r5) — the index.js footprint is EXACTLY the stated hunks:
//   (i)  unapplyStackseqIndex(index.js) === acf32fc8:index.js BYTE-FOR-BYTE; a byte changed inside a hunk, outside every hunk,
//        a duplicated or a missing hunk is each detected;
//   (ii) D12 — monitorAssignmentTimeout is byte-identical to the base (no hunk touches it: no planning, no filter, no copies), and
//        its pickEligibleDriver call passes no stack option;
//   (iii) the secret is bound to autoAssignOnOrderCreate and sweepPendingOrders ONLY.
// Run: node stackseq-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyStackseqIndex, INDEX_HUNKS } = require('./tools/stackseq-inverse');
const BASE = '93573fb5';   // R-WIRE train re-point: M7^1, the train state just before stackseq merged (the slice's own base was acf32fc8)

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))));   // R-WIRE train re-point: the newer train slices reversed first (formsignal innermost → wahealth → drvc → drvf)
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// (i)
assert.notStrictEqual(real, base, 'non-vacuity: the slice is present');
assert.strictEqual(unapplyStackseqIndex(real), base, `🔴 index.js minus the stackseq hunks is not ${BASE}:index.js`);
for (const [now] of INDEX_HUNKS) {
  assert.ok(real.includes(now), 'non-vacuity: each hunk is present');
  const k = Math.floor(now.length / 2);
  const inside = real.replace(now, now.slice(0, k) + (now[k] === '#' ? '%' : '#') + now.slice(k + 1));
  let detected; try { detected = unapplyStackseqIndex(inside) !== base; } catch (_) { detected = true; }
  assert.ok(detected, `a byte changed INSIDE a hunk is detected: ${JSON.stringify(now.slice(0, 60))}`);
  assert.throws(() => unapplyStackseqIndex(real + now), /occurs 2×/, 'a duplicated hunk');
  assert.throws(() => unapplyStackseqIndex(real.replace(now, '')), /occurs 0×/, 'a missing hunk');
}
const outside = real.replace('exports.quoteOrder = onRequest(', 'exports.quoteOrder  = onRequest(');
assert.notStrictEqual(outside, real, 'premise');
assert.notStrictEqual(unapplyStackseqIndex(outside), base, 'a byte changed OUTSIDE every hunk is detected');
ok(`PROOF: unapplyStackseqIndex(index.js) === ${BASE}:index.js byte-for-byte (${INDEX_HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

// (ii) D12: the timeout writer is byte-identical
const region = (src) => { const a = src.indexOf('exports.monitorAssignmentTimeout = onValueWritten('); const b = src.indexOf('\nexports.', a + 10); assert.ok(a > 0 && b > a, 'premise: the timeout writer is found'); return src.slice(a, b); };
assert.strictEqual(region(real), region(base), '🔴 D12: monitorAssignmentTimeout changed');
assert.ok(!/stackFilter|SEQ\.|stackCopies|ROUTES_API_KEY/.test(region(real)), 'the timeout writer references no sequencing');
assert.ok(/pickEligibleDriver\(db, \[[^\]]*\], [^,()]+, [^,()]+\)/.test(region(real)), 'the timeout calls pickEligibleDriver with its four base arguments');
ok('D12: monitorAssignmentTimeout is byte-identical to the base, references no sequencing, and passes no stack option');

// (iii) the secret is bound to exactly the two sequencing writers
const bound = [...real.matchAll(/secrets: \[ROUTES_API_KEY\]/g)].length;
assert.strictEqual(bound, 2, `ROUTES_API_KEY bound ${bound}× (expected autoAssign + sweep)`);
for (const w of ['exports.autoAssignOnOrderCreate', 'exports.sweepPendingOrders']) {
  const a = real.indexOf(w); const head = real.slice(a, a + 400);
  assert.ok(head.includes('secrets: [ROUTES_API_KEY]'), `${w} binds the Routes secret`);
}
ok('ROUTES_API_KEY is bound to autoAssignOnOrderCreate and sweepPendingOrders only');

// (iv) the pinned module cancel-order-core.js: base + exactly the flag-gated promotion entry (OFF = the base body verbatim)
{
  const { unapplyStackseqModule, HUNKS: MH } = require('./tools/stackseq-module-inverse');
  for (const f of ['cancel-order-core.js', 'retention-sweep.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.notStrictEqual(src, b, `non-vacuity: ${f}`);
    assert.strictEqual(unapplyStackseqModule(f, src), b, `🔴 ${f} minus the stackseq hunks is not ${BASE}:${f}`);
    for (const h of MH.filter((x) => x.file === f)) {
      const k = Math.floor(h.now.length / 2);
      assert.throws(() => unapplyStackseqModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
      assert.throws(() => unapplyStackseqModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
    }
    assert.notStrictEqual(unapplyStackseqModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk`);
  }
  assert.strictEqual(unapplyStackseqModule('other.js', 'x'), 'x', 'other files pass through');
  ok(`cancel-order-core.js + retention-sweep.js: base + exactly the stackseq hunks (${MH.length}); inside / outside / duplicated detected`);
}

console.log(`\nstackseq-wiring: OK (${n})`);
