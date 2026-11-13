'use strict';
// fix/hosted-recover-exclusive — the wiring guard for tools/hostedrace-module-inverse.js: the inverse returns
// each owned file (webhook, alert-prune, manual-resolve, index, and the claim fix's hosted-charge) to 8a31e2a3 byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk
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
assert.deepStrictEqual([...FILES].sort(), ['alert-prune.js', 'index.js', 'manual-resolve.js', 'pixelpay-hosted-charge.js', 'pixelpay-hosted-webhook.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  // DRYRUN R-WIRE (2e): P5a (newer) innermost
  // asm2 (5f): index.js also carries the newer S-B / S-D layers (stripped first, as in h0-wiring), and capp + 3a additions made
  // INSIDE checkout's endpoints block with no inverse of their own — stripped by their EXACT generated text
  // (tools/asm2-approved-additions.js) from the actual side only; every other byte, checkout code included, must be base.
  const raw = f === 'index.js' ? require('./tools/asm2-approved-additions').stripApprovedAdditions(require('./tools/sdkpay-module-inverse').unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, require('./tools/dpao-module-inverse').unapplyDpaoModule(f, require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule(f, require('./tools/zones-module-inverse').unapplyZonesModule(f, require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, require('./tools/d3live-module-inverse').unapplyD3liveModule(f, require('./tools/d4-intake-inverse').unapplyD4Module(f, fs.readFileSync(path.join(__dirname, f), 'utf8')))))))))))))))))) : require('./tools/sdkpay-module-inverse').unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, require('./tools/dpao-module-inverse').unapplyDpaoModule(f, require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule(f, require('./tools/zones-module-inverse').unapplyZonesModule(f, require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, require('./tools/d3live-module-inverse').unapplyD3liveModule(f, require('./tools/d4-intake-inverse').unapplyD4Module(f, fs.readFileSync(path.join(__dirname, f), 'utf8')))))))))))))))));
  const CO = (x) => x;
  const src = require('./tools/p5a-inverse').unapplyP5aModule(f, f === 'index.js' ? require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(raw))) : raw);
  const b = CO(execFileSync('git', ['show', `${ASM_BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 }));
  assert.notStrictEqual(CO(src), b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(CO(unapplyHostedRaceModule(f, src)), b, `🔴 ${f} minus the hosted-race hunks is not ${ASM_BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyHostedRaceModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyHostedRaceModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(CO(unapplyHostedRaceModule(f, '\n' + src)), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyHostedRaceModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
// asm2 (5f): index.js's fold to the assembly base — the ONE definition the loop and the sensitivity cell share
const foldIndexToBase = (raw) => unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aModule('index.js', require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/asm2-approved-additions').stripApprovedAdditions(raw))))));
const indexBase = () => execFileSync('git', ['show', `${ASM_BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// ASM2-CHECKOUT-SENSITIVITY (Codex asm2 r1 P2): a change to EXISTING checkout logic must fail the index.js base pin — the
// fold may remove only the approved additions, never the surrounding checkout bytes.
{
  const raw = require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))))))))));
  const CALC = "const cappGuestRefusal = require('./checkout-guest-gate').createOrderRefusal(clientHdr, customer_uid, body);";
  assert.strictEqual(raw.split(CALC).length - 1, 1, 'ASM2-CHECKOUT-SENSITIVITY: PREMISE — the calculation is present exactly once');
  const mutated = raw.replace(CALC, () => 'const cappGuestRefusal = null;');
  assert.strictEqual(foldIndexToBase(raw), indexBase(), 'ASM2-CHECKOUT-SENSITIVITY: PREMISE — the unmutated file folds to base');
  assert.notStrictEqual(foldIndexToBase(mutated), indexBase(), 'ASM2-CHECKOUT-SENSITIVITY: replacing cappGuestRefusal\'s calculation with null fails the hostedrace-wiring index.js base pin');
  ok('ASM2-CHECKOUT-SENSITIVITY: an edit to existing checkout logic is caught');
}

ok(`${FILES.join(', ')} → ${BASE} byte-for-byte; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\nhostedrace-wiring.guard: OK (${n})`);
