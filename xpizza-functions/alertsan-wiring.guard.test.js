'use strict';
// fix/payment-alert-sanitize — the wiring guard for tools/alertsan-module-inverse.js: the inverse returns pixelpay-cancel.js and pixelpay-confirm.js to
// 8a31e2a3 byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file
// passes through.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyAlertSanModule } = require('./tools/alertsan-module-inverse');
// DRYRUN (2e, next-train assembly; TRAIN-NEXT2 A4): compare with the REAL pre-sanitize assembly commit, not the lane base
const ASM_BASE = '2b132041';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['pixelpay-cancel.js', 'pixelpay-confirm.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  // DRYRUN R-WIRE (2e): the layers newer than alertsan (3a sb / sd, P5a) stripped first
  const src = require('./tools/_asm-next2-layers').stripNewer(f, fs.readFileSync(path.join(__dirname, f), 'utf8'), 'alertsan');
  const b = execFileSync('git', ['show', `${ASM_BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyAlertSanModule(f, src), b, `🔴 ${f} minus the alert-sanitize hunks is not ${ASM_BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyAlertSanModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyAlertSanModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyAlertSanModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyAlertSanModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.join(', ')} → ${BASE} byte-for-byte; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\nalertsan-wiring.guard: OK (${n})`);
