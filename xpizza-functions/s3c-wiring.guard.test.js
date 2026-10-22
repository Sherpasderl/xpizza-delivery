'use strict';
// S3c envío activation prerequisites — hot-file wiring guard (index.js inverse-fold invariant). The slice's index.js hunks are
// all SAME-LINE: the DELIVERY order-received calls carry the CHARGED total and the «Envío» argument (createOrder, and the
// online order-received trigger); a pickup never carries envío, so both pickup calls are untouched. It ships tools/s3c-inverse.js and composes unapplyS3cIndex INNERMOST into every
// index.js fold guard. This guard proves (i) unapplyS3cIndex(index.js) === 50ab2b56:index.js BYTE-FOR-BYTE with sensitivity,
// and (ii) NON-VACUITY — every hunk present and every order-received call site carries the envío argument.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS3cIndex } = require('./tools/s3c-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '50ab2b56';   // the HELD S3b tip this slice branches from
const live = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');   // this slice is the NEWEST: nothing composes on top
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(unapplyS3cIndex(live), baseIdx, `🔴 index.js minus the S3c hunks is not ${BASE}:index.js — something beyond the stated seams changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunks insert NO line (R3 region binds pin index.js lines)');
for (const [now] of HUNKS) assert.ok(live.indexOf(now) > -1 && live.indexOf(now, live.indexOf(now) + 1) === -1, `each hunk present exactly once: ${now.slice(0, 60)}`);
const calls = (re) => (live.match(re) || []).length;
assert.strictEqual(calls(/total: DW\.totalLempiras\(dq, effectiveTotal\), \.\.\.DW\.waEnvio\(priceBreakdown\),/g), 1, 'createOrder: the DELIVERY order-received message carries the charged total + envío');
assert.strictEqual(calls(/total: order\.total, \.\.\.DW\.waEnvio\(order\),/g), 1, 'the online order-received trigger carries envío on the DELIVERY template');
assert.ok(calls(/tplPickupReceived\(\{[^}]*\}/g) === 2 && calls(/tplPickupReceived\(\{[^}]*waEnvio/g) === 0, 'a PICKUP never carries envío (codex S3c r1): both pickup calls are byte-identical to the base');
assert.strictEqual(calls(/whatsapp\.tpl(OrderReceived|PickupReceived)\(/g), 4, 'premise: there are exactly four order-received call sites');
ok(`unapplyS3cIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} same-line hunks); the two DELIVERY order-received calls carry envío; pickup untouched`);

const [first] = HUNKS[0];
assert.throws(() => unapplyS3cIndex(live.replace(first, first.replace('waEnvio', 'waEnviX'))), /exactly once/, 'a byte INSIDE a hunk');
assert.throws(() => unapplyS3cIndex(live + HUNKS[HUNKS.length - 1][0]), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS3cIndex(live.replace(HUNKS[HUNKS.length - 1][0], '')), /exactly once/, 'a MISSING hunk');
ok('sensitivity: a byte inside a hunk, a duplicated hunk and a missing hunk are each detected');

console.log(`\ns3c-wiring.guard: OK (${n})`);
