'use strict';
// SECURITY null-fingerprint fix — the wiring guard for tools/secfp-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node secfp-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplySecFpModule } = require('./tools/secfp-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['createorder-classify.js'], 'the owned files');
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');   // the NEWEST layer: the file on disk
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplySecFpModule(f, src), b, `🔴 ${f} minus the secfp hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplySecFpModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplySecFpModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplySecFpModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplySecFpModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
// the frozen order forms (rule 40): no byte under either form directory differs from the base, and both pages hash as pinned
{
  const crypto = require('crypto');
  const REPO = path.join(__dirname, '..');
  execFileSync('git', ['diff', '--quiet', BASE, '--', 'la-musa-orders/', 'xpizza-orders/'], { cwd: REPO });   // throws on any difference
  const PIN = { 'la-musa-orders/index.html': 'deb044a541371af7335fd0d66fe959b2706ad572cc6a92f25c97ac773ad7c0f1', 'xpizza-orders/index.html': 'ebc5df6667b3c2953d6f8b01ed2b290278eed2e982da8e4ed34ea43a8b6e6226' };
  for (const [f, h] of Object.entries(PIN)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex'), h, `🔴 ${f} changed (rule 40: the forms are frozen)`);
  ok('the two frozen order forms are byte-identical to the base (git diff + sha256 pins)');
}
console.log(`\nsecfp-wiring.guard: OK (${n})`);
