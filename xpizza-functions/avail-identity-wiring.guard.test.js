'use strict';
// PLAN-avail-identity r1 — the slice's wiring guard: tools/avail-identity-inverse.js reproduces BASE (8a31e2a3) byte-for-byte for every
// file it touches, so nothing outside its exact same-line hunks changed; and the inverse is SENSITIVE (an edit inside a hunk, a byte
// outside one, a missing or duplicated hunk each fail). Every hunk is one whole line, so no line moved (the line-pinned guards hold).
// Run: node avail-identity-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyAvailIdentity } = require('./tools/avail-identity-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))));   // S0 key mode (newest) reversed first
const GBASE = '69b045de';   // DRYRUN R-WIRE (2e): the assembly state just before the avail-identity layer (the train's older layers sit under it); re-point at the real assembly
const baseOf = (f) => execFileSync('git', ['show', `${GBASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES].sort(), ['catalog/public-menu.js', 'menu-pricing.js'], 'AVAIL-ID-WIRING-FILES');
for (const f of FILES) {
  const real = require('./tools/photos-module-inverse').unapplyPhotosModule(f, read(f));   // DRYRUN R-WIRE (2e): photos A2 (newest) innermost
  assert.notStrictEqual(unapplyAvailIdentity(f, real), real, `AVAIL-ID-WIRING non-vacuity ${f}`);
  assert.strictEqual(unapplyAvailIdentity(f, real), baseOf(f), `🔴 AVAIL-ID-WIRING ${f} minus the avail-identity hunks is not ${GBASE}:${f}`);
  assert.strictEqual(real.split('\n').length, baseOf(f).split('\n').length, `AVAIL-ID-WIRING-NO-LINE-SHIFT ${f}`);
}
for (const h of HUNKS) {
  assert.ok(h.now.endsWith('\n') && h.was.endsWith('\n') && h.now.indexOf('\n') === h.now.length - 1 && h.was.indexOf('\n') === h.was.length - 1, `AVAIL-ID-WIRING-SAME-LINE ${JSON.stringify(h.now.slice(0, 60))}`);
}
ok(`${FILES.join(' + ')} minus the ${HUNKS.length} same-line hunks == ${GBASE} (inverse BASE ${BASE}), byte-for-byte; no line moved`);

const f = 'menu-pricing.js'; const real = read(f);
assert.throws(() => unapplyAvailIdentity(f, real.replace("item[availIdentityField(restaurantId)]", "item[availIdentityField(restaurantId) ]")), /occurs 0 times/, 'AVAIL-ID-WIRING an edit INSIDE a hunk');
assert.notStrictEqual(unapplyAvailIdentity(f, real.replace('function extraPricingKey', 'function  extraPricingKey')), baseOf(f), 'AVAIL-ID-WIRING a byte OUTSIDE the hunks');
const dup = HUNKS.find((h) => h.file === f).now;
assert.throws(() => unapplyAvailIdentity(f, real + dup), /occurs 2 times/, 'AVAIL-ID-WIRING a duplicated hunk');
assert.throws(() => unapplyAvailIdentity(f, real.replace(dup, '')), /occurs 0 times/, 'AVAIL-ID-WIRING a missing hunk');
ok('sensitive: an edit inside a hunk, a byte outside, a duplicated and a missing hunk are each caught');

console.log(`avail-identity-wiring: OK (${n})`);
