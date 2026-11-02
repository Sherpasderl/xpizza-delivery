'use strict';
// fix/hosted-recover-exclusive — the wiring guard for tools/hostedrace-module-inverse.js: the inverse returns
// each owned file (webhook, alert-prune, manual-resolve, index) to 8a31e2a3 byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk
// are each caught; an unowned file passes through.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyHostedRaceModule } = require('./tools/hostedrace-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['alert-prune.js', 'index.js', 'manual-resolve.js', 'pixelpay-hosted-webhook.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyHostedRaceModule(f, src), b, `🔴 ${f} minus the hosted-race hunks is not ${BASE}:${f}`);
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
