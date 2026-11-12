'use strict';
// SECURITY confirmOnlinePayment retirement — the wiring guard for tools/confirmretire-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node confirmretire-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyConfirmRetireModule } = require('./tools/confirmretire-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['index.js'], 'the owned files');
for (const f of FILES) {
  const src = require('./tools/zones-module-inverse').unapplyZonesModule(f, require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/d4-intake-inverse').unapplyD4Module(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))));   // train asm7 (2e): Envío (f13dc7de) landed after this lane — its two layers (envlim newest) are peeled first; D4 (5e63f584, newest) peeled first
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyConfirmRetireModule(f, src), b, `🔴 ${f} minus the confirmretire hunks is not ${BASE}:${f}`);
  // a RETIREMENT removes lines by design (the HTTP app + export); the hunks pin exactly what was removed
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyConfirmRetireModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyConfirmRetireModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyConfirmRetireModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyConfirmRetireModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
// the portal fold of index.js carries every index.js hunk exactly once (the guards that read the fold peel this layer)
const fold = require('./tools/portal-split').foldPortalSplit();
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
console.log(`\nconfirmretire-wiring.guard: OK (${n})`);
