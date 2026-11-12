'use strict';
// SDK payments — the wiring guard for tools/sdkpay-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file
// passes through. Run: node sdkpay-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplySdkPayModule } = require('./tools/sdkpay-module-inverse');
const { unapplyTipprefIndex } = require('./tools/tippref-inverse');   // PLAN-capp-tip-step §1: the last-tip hunks, composed INNERMOST (as every index chain)
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['alert-prune.js', 'cancel-order-core.js', 'index.js', 'merchant/merchant-transitions.js', 'pixelpay-charge.js', 'pixelpay-confirm.js', 'pixelpay-hosted-charge.js', 'pixelpay-hosted-webhook.js', 'resolve-manual.js', 'rewards-reserve.js', 'scheduled-release-core.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  const raw = require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8')));
  const src = f === 'index.js' ? unapplyTipprefIndex(raw) : raw;
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, src))))))), b, `🔴 ${f} minus the SDK-payments hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))))))))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, src + h.now))))))), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, '\n' + src))))))), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplySdkPayModule('tb-unowned.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('tb-unowned.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('tb-unowned.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('tb-unowned.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('tb-unowned.js', require('./tools/s1d-module-inverse').unapplyS1dModule('tb-unowned.js', require('./tools/s2-module-inverse').unapplyS2Module('tb-unowned.js', 'x\n'))))))), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\nsdkpay-wiring.guard: OK (${n})`);
