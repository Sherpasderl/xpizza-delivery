'use strict';
// ENVÍO STEP 2 (drawn no-delivery zones) — the wiring guard for tools/zones-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node zones-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyZonesModule } = require('./tools/zones-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['delivery/delivery-pricing.js', 'delivery/delivery-wire.js', 'index.js'], 'the owned files');
for (const f of FILES) {
  const src = require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8')));   // the NEWEST layer: the file on disk; train asm7 (2e): confirmOnlinePayment's retirement (1721f5d1, disjoint index.js hunks) merged beside this lane is peeled at the read
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyZonesModule(f, src), b, `🔴 ${f} minus the zones hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyZonesModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyZonesModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyZonesModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyZonesModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
// the portal fold of index.js carries every index.js hunk exactly once (the guards that read the fold peel this layer)
const fold = require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/portal-split').foldPortalSplit());
for (const h of HUNKS.filter((x) => x.file === 'index.js')) assert.strictEqual(fold.split(h.now).length - 1, 1, 'an index.js hunk survives the portal fold exactly once');
ok('the portal fold carries each index.js hunk exactly once');
// the frozen order forms (rule 40): no byte under either form directory differs from the base, and both pages hash as pinned
{
  const crypto = require('crypto');
  const REPO = path.join(__dirname, '..');
  execFileSync('git', ['diff', '--quiet', BASE, '--', 'la-musa-orders/', 'xpizza-orders/'], { cwd: REPO });   // throws on any difference
  const PIN = { 'la-musa-orders/index.html': 'deb044a541371af7335fd0d66fe959b2706ad572cc6a92f25c97ac773ad7c0f1', 'xpizza-orders/index.html': 'ebc5df6667b3c2953d6f8b01ed2b290278eed2e982da8e4ed34ea43a8b6e6226' };
  for (const [f, h] of Object.entries(PIN)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex'), h, `🔴 ${f} changed (rule 40: the forms are frozen)`);
  ok('the two frozen order forms are byte-identical to the base (git diff + sha256 pins)');
}
console.log(`\nzones-wiring.guard: OK (${n})`);
