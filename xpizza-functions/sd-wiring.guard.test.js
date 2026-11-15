'use strict';
// S-D (PLAN §S-D) — the reorder price snapshot WIRING (tools/sd-inverse.js, composed INNERMOST in every index.js chain and in the
// pinned-module chains of create-order-build.js / materialize.js / claim-order.js / reorder-normalize.js):
//   1. the inverse is EXACT: index.js and each module minus the S-D hunks === BASE's bytes (BASE = this slice's parent);
//   2. every hunk is pure INSERTED whole lines — no base line edited — and the index.js hunk sits right after the online pending
//      record (reorder_items is its last field), before the serial3 card-content-keys block;
//   3. sensitivity: a missing / duplicated / shared-line index marker, a byte INSIDE a module hunk and a duplicated module hunk throw;
//      a byte OUTSIDE every hunk fails the base pin.
// Run: node sd-wiring.guard.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { unapplySdIndex, unapplySdModule, unapplySdModuleIfAny, HUNKS, MODULE_HUNKS, FILES } = require('./tools/sd-inverse');

const BASE = 'a61adad5';   // DRYRUN (2e, TRAIN-NEXT2 A4): the pre-3a ASSEMBLY commit (was c5093152, S-D's parent on feat/security-lifecycle)
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => require('./tools/sdkpay-module-inverse').unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, require('./tools/dpao-module-inverse').unapplyDpaoModule(f, require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule(f, require('./tools/zones-module-inverse').unapplyZonesModule(f, require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, require('./tools/s2bext-module-inverse').unapplyS2bextModule(f, require('./tools/d3live-module-inverse').unapplyD3liveModule(f, require('./tools/d4-intake-inverse').unapplyD4Module(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))))))))))))))))));
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// 1. exact
const live = read('index.js');
assert.notStrictEqual(unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live))), live, 'non-vacuity: index.js carries the hunk');
// the checkout endpoints block (my newer S-A(d) / getMyRating / S-B exports live INSIDE it) is folded out on BOTH sides: S-D's
// guarantee is the code outside it — that block is pinned whole by checkout-wiring.guard
const { unapplyCheckoutIndex } = require('./tools/checkout-inverse');
assert.strictEqual(unapplyCheckoutIndex(unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live)))), unapplyCheckoutIndex(baseOf('index.js')), `🔴 index.js minus the S-D hunk (outside the checkout endpoints block) is not ${BASE}:index.js`);
assert.deepStrictEqual(FILES, ['create-order-build.js', 'materialize.js', 'claim-order.js', 'reorder-normalize.js'], 'the slice\'s pinned modules');
for (const f of FILES) {
  const src = read(f);
  assert.notStrictEqual(unapplySdModule(f, src), src, `non-vacuity: ${f} carries its hunk`);
  assert.strictEqual(unapplySdModule(f, src), baseOf(f), `🔴 ${f} minus the S-D hunk is not ${BASE}:${f}`);
}
assert.strictEqual(unapplySdModuleIfAny('index.js', 'x'), 'x', 'the chain form passes an untouched file through');
ok(`exact: index.js and ${FILES.join(' / ')} minus the S-D hunks === ${BASE} byte-for-byte`);

// 2. pure insertions + placement
for (const h of MODULE_HUNKS) {
  assert.ok(h.now.startsWith(h.was) && h.now.length > h.was.length, `${h.file}: the hunk is the anchor line + inserted lines`);
  assert.ok(h.was.endsWith('\n') && h.was.indexOf('\n') === h.was.length - 1, `${h.file}: the anchor is ONE whole unchanged line`);
}
const B = HUNKS[0].begin;
const before = live.slice(0, live.indexOf(B));
assert.ok(/reorder_items: normalizeReorderItems\(body\.items, restaurantId, pricingTables\) \} : \{\}\)[^\n]*\n {2}\};\n {2}$/.test(before), '🔴 the hunk sits right after the pending record whose last field is reorder_items');
assert.ok(live.indexOf(HUNKS[0].end) < live.indexOf('/* serial3:begin card-content-keys */'), 'and before the serial3 card-content-keys block');
const block = live.slice(live.indexOf(B), live.indexOf(HUNKS[0].end));
assert.ok(/if \(customer_uid\) \{/.test(block) && /reorderPriceSnapshot\(body\.items, restaurantId, pricingTables\)/.test(block) && /pendingOrderRecord\.reorder_price_snapshot = /.test(block), 'members only; the SAME inputs as reorder_items; written onto the pending record');
ok('every hunk is whole lines INSERTED after one unchanged anchor; the index.js hunk follows the pending record (members only, the same body.items / restaurantId / pricingTables as reorder_items)');

// 3. sensitivity
const H = HUNKS[0];
assert.throws(() => unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live.replace(H.begin, '/* sd:BEGIN reorder-price-snapshot */')))), /missing/, 'a missing begin');
assert.throws(() => unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live + `${H.begin}\n${H.end}\n`))), /more than once/, 'a duplicated hunk');
assert.throws(() => unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live.replace(`  ${H.begin}`, `  x; ${H.begin}`)))), /own lines/, 'a marker sharing a base line');
for (const h of MODULE_HUNKS) {
  const src = read(h.file);
  const k = h.was.length + 5;
  assert.throws(() => unapplySdModule(h.file, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${h.file}: a byte INSIDE the hunk`);
  assert.throws(() => unapplySdModule(h.file, src + h.now), /occurs 2 times/, `${h.file}: a duplicated hunk`);
  assert.notStrictEqual(unapplySdModule(h.file, '\n' + src), baseOf(h.file), `${h.file}: a byte OUTSIDE the hunk fails the base pin`);
}
assert.notStrictEqual(unapplyCheckoutIndex(unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(`\n${live}`)))), unapplyCheckoutIndex(baseOf('index.js')), 'index.js: a byte OUTSIDE the hunk fails the base pin');
ok('sensitivity: missing / duplicated / shared-line markers, a byte inside or a duplicated module hunk throw; a byte outside every hunk fails the pin');

console.log(`sd-wiring.guard: OK (${n})`);
