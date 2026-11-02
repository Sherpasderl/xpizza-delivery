'use strict';
// fix/hosted-recover-exclusive — the wiring guard for tools/hostedrace-module-inverse.js: the inverse returns
// each owned file (webhook, alert-prune, manual-resolve, index) to 8a31e2a3 byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk
// are each caught; an unowned file passes through.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyHostedRaceModule } = require('./tools/hostedrace-module-inverse');
// DRYRUN (2e, next-train assembly): the module guard compares against the REAL pre-layer assembly commit, not the lane's base
// {'}}8a31e2a3{{'} (which lacks the whole last train). Re-point again at the real assembly (TRAIN-NEXT2 obligation A4).
const ASM_BASE = '51dc55ab';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['alert-prune.js', 'index.js', 'manual-resolve.js', 'pixelpay-hosted-webhook.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  // DRYRUN R-WIRE (2e): P5a (newer) innermost
  const src = require('./tools/_asm-next2-layers').stripNewer(f, fs.readFileSync(path.join(__dirname, f), 'utf8'), 'hostedrace');   // DRYRUN: every newer layer first
  const b = execFileSync('git', ['show', `${ASM_BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  // DRYRUN: index.js compared OUTSIDE the checkout endpoints block (3a's new endpoints live inside it, stripped whole — as 3a's guards do)
  const fold = (X) => (f === 'index.js' ? require('./tools/checkout-inverse').unapplyCheckoutIndex(X) : X);
  assert.strictEqual(fold(unapplyHostedRaceModule(f, src)), fold(b), `🔴 ${f} minus the hosted-race hunks is not ${ASM_BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyHostedRaceModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyHostedRaceModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyHostedRaceModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyHostedRaceModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.join(', ')} → ${BASE} byte-for-byte; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\nhostedrace-wiring.guard: OK (${n})`);
