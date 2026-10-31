'use strict';
// PAY RATE — the ONE pure reader of platform_rates/driver_per_delivery (PROPOSAL-driver-pay-rate-reader r2).
//   1. byte parity: xpizza-functions/pay-rate.js and xpizza-driver/pay-rate.js == <repo>/platform/client/pay-rate.js
//   2. semantics: the greatest effective_from ≤ t, else null; positive integer cents only; deterministic tie; no retro-apply
//   3. shiftEarningsCents: each delivery at its OWN in-effect rate; null when unknown / any delivery uncovered
//   4. the driver copy, loaded as a browser classic script, answers exactly like the Node module
// Run: node pay-rate.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('./pay-rate');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');

// ── 1. one source ──
const canon = fs.readFileSync(path.join(ROOT, 'platform', 'client', 'pay-rate.js'), 'utf8');
for (const rel of ['xpizza-functions/pay-rate.js', 'xpizza-driver/pay-rate.js']) {
  assert.strictEqual(fs.readFileSync(path.join(ROOT, rel), 'utf8'), canon, `🔴 ${rel} drifted from platform/client/pay-rate.js — run \`npm run sync:client\``);
}
ok('xpizza-functions/pay-rate.js and xpizza-driver/pay-rate.js are byte-identical to platform/client/pay-rate.js');

// ── 2. rateCentsInEffect ──
const { rateCentsInEffect: R, shiftEarningsCents: S } = P;
const E = { '-Na': { cents: 7000, effective_from: 0 }, '-Nb': { cents: 8000, effective_from: 1000 } };
assert.strictEqual(R(E, 500), 7000, 'before the 2nd entry → the 1st rate');
assert.strictEqual(R(E, 1000), 8000, 'AT the 2nd effective_from → the new rate (≤ is inclusive)');
assert.strictEqual(R(E, 999), 7000, 'one ms before → still the old rate');
assert.strictEqual(R(E, 9e12), 8000, 'long after → the latest');
assert.strictEqual(R({ a: { cents: 7000, effective_from: 2000 } }, 1999), null, '🔴 a time BEFORE the earliest entry must be null (never retro-apply a later rate)');
for (const bad of [null, undefined, {}, [], 'x', 5]) assert.strictEqual(R(bad, 1000), null, `entries ${JSON.stringify(bad)} → null`);
for (const t of [NaN, Infinity, -Infinity, '1000', null, undefined]) assert.strictEqual(R(E, t), null, `t ${String(t)} → null`);
// only positive integer cents and a finite effective_from count; a malformed entry is skipped, never chosen
const MAL = { a: { cents: 7000, effective_from: 0 }, b: { cents: 70.5, effective_from: 10 }, c: { cents: 0, effective_from: 20 }, d: { cents: -5, effective_from: 30 },
  e: { cents: '9000', effective_from: 40 }, f: { cents: 9000, effective_from: '50' }, g: { cents: 9000, effective_from: NaN }, h: null, i: { cents: 9000 } };
assert.strictEqual(R(MAL, 1000), 7000, '🔴 a malformed entry (fractional / zero / negative / string cents, non-finite or missing effective_from) was chosen');
assert.strictEqual(P.validEntry({ cents: 7000, effective_from: 0 }), true);
// a tie on effective_from: the later pushId wins (push keys sort chronologically), regardless of object insertion order
const TIE = {}; TIE['-Nz'] = { cents: 9500, effective_from: 1000 }; TIE['-Na'] = { cents: 9000, effective_from: 1000 };
assert.strictEqual(R(TIE, 1000), 9500, 'tie → the later key (-Nz)');
assert.strictEqual(R([{ cents: 7000, effective_from: 0 }, { cents: 8000, effective_from: 1000 }], 1500), 8000, 'an array of entries works too');
ok('rateCentsInEffect: greatest effective_from ≤ t (inclusive), null before the first entry / for no entries / a non-finite t; malformed entries skipped; a tie goes to the later push key');

// ── 3. shiftEarningsCents ──
assert.strictEqual(S([{ delivered_at: 500 }, { delivered_at: 1500 }], E), 15000, '🔴 each delivery at its OWN rate (7000 + 8000): a mid-shift change is counted, never retro-applied');
assert.strictEqual(S([], E), 0, 'no deliveries + entries → 0');
assert.strictEqual(S(null, E), 0, 'null deliveries + entries → 0');
assert.strictEqual(S([], null), null, 'no entries → null (rate unknown: render nothing)');
assert.strictEqual(S([{ delivered_at: 500 }, { delivered_at: -1 }], E), null, '🔴 any uncovered delivery → null (never a partial total)');
assert.strictEqual(S([{ delivered_at: 500 }, {}], E), null, 'a delivery without delivered_at → null');
assert.strictEqual(S([{ delivered_at: 500 }], { a: { cents: 70.5, effective_from: 0 } }), null, 'only a malformed entry → null');
ok('shiftEarningsCents: the sum of per-delivery in-effect rates; 0 for none; null when the rate is unknown or any delivery is uncovered');

// ── 4. the driver copy as a browser classic script ──
{
  const win = {};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xpizza-driver', 'pay-rate.js'), 'utf8'), vm.createContext({ self: win }), { filename: 'pay-rate.js' });
  const B = win.PayRate;
  assert.ok(B && typeof B.rateCentsInEffect === 'function' && typeof B.shiftEarningsCents === 'function', 'window.PayRate exposes both helpers');
  for (const t of [-1, 0, 500, 999, 1000, 9e12]) assert.strictEqual(B.rateCentsInEffect(E, t), R(E, t), `browser == node at t=${t}`);
  assert.strictEqual(B.shiftEarningsCents([{ delivered_at: 500 }, { delivered_at: 1500 }], E), 15000);
  assert.strictEqual(B.rateCentsInEffect(MAL, 1000), 7000);
}
ok('the driver copy loads as a classic script (window.PayRate) and answers exactly like the Node module');

console.log(`\npay-rate: OK (${n})`);
