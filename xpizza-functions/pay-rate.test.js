'use strict';
// PAY RATE — the ONE pure reader of platform_rates/driver_per_delivery (PROPOSAL-driver-pay-rate-reader r2).
//   1. byte parity: xpizza-functions/pay-rate.js and xpizza-driver/pay-rate.js == <repo>/platform/client/pay-rate.js
//   2. semantics: the greatest effective_from ≤ t, else null; only entries inside the bounds contract; deterministic tie; no retro-apply
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

// ── 2. rateCentsInEffect ── (times are offsets from T0 = MIN_EFFECTIVE_FROM, the earliest valid effective_from)
const { rateCentsInEffect: R, shiftEarningsCents: S } = P;
const T0 = P.MIN_EFFECTIVE_FROM;
assert.strictEqual(T0, Date.parse('2026-01-01T00:00:00Z'), 'MIN_EFFECTIVE_FROM = 2026-01-01T00:00:00Z');
assert.deepStrictEqual([P.MIN_CENTS, P.MAX_CENTS, P.MAX_AHEAD_MS], [100, 100000, 366 * 86400000], 'the bounds: L 1 – L 1,000; 366 days ahead');
const E = { '-Na': { cents: 7000, effective_from: T0 }, '-Nb': { cents: 8000, effective_from: T0 + 1000 } };
assert.strictEqual(R(E, T0 + 500), 7000, 'before the 2nd entry → the 1st rate');
assert.strictEqual(R(E, T0 + 1000), 8000, 'AT the 2nd effective_from → the new rate (≤ is inclusive)');
assert.strictEqual(R(E, T0 + 999), 7000, 'one ms before → still the old rate');
assert.strictEqual(R(E, T0 + 9e12), 8000, 'long after → the latest');
assert.strictEqual(R({ a: { cents: 7000, effective_from: T0 + 2000 } }, T0 + 1999), null, '🔴 a time BEFORE the earliest entry must be null (never retro-apply a later rate)');
for (const bad of [null, undefined, {}, [], 'x', 5]) assert.strictEqual(R(bad, T0 + 1000), null, `entries ${JSON.stringify(bad)} → null`);
for (const t of [NaN, Infinity, -Infinity, '1000', null, undefined]) assert.strictEqual(R(E, t), null, `t ${String(t)} → null`);
// only VALID entries count (the bounds contract); a malformed / out-of-bounds entry is skipped, never chosen, never thrown on
const MAL = { a: { cents: 7000, effective_from: T0 }, b: { cents: 70.5, effective_from: T0 + 10 }, c: { cents: 0, effective_from: T0 + 20 }, d: { cents: -5, effective_from: T0 + 30 },
  e: { cents: '9000', effective_from: T0 + 40 }, f: { cents: 9000, effective_from: String(T0 + 50) }, g: { cents: 9000, effective_from: NaN }, h: null, i: { cents: 9000 },
  j: { cents: 99, effective_from: T0 + 60 }, k: { cents: 100001, effective_from: T0 + 70 }, l: { cents: Number.MAX_SAFE_INTEGER, effective_from: T0 + 80 }, m: { cents: 2 ** 53, effective_from: T0 + 90 },
  o: { cents: 9000, effective_from: T0 + 100.5 }, p: { cents: 9000, effective_from: Infinity }, q: { cents: Infinity, effective_from: T0 + 110 } };
assert.strictEqual(R(MAL, T0 + 1000), 7000, '🔴 a malformed entry (fractional / < 100 / > 100000 / unsafe / string cents; fractional, non-finite, string or missing effective_from) was chosen');
// a negative / pre-2026 effective_from is invalid: it can never become "the rate in effect" for any time
assert.strictEqual(R({ a: { cents: 9000, effective_from: -1 } }, T0 + 1000), null, '🔴 a negative effective_from was accepted');
assert.strictEqual(R({ a: { cents: 9000, effective_from: 0 } }, T0 + 1000), null, '🔴 effective_from 0 (1970) was accepted');
assert.strictEqual(R({ a: { cents: 9000, effective_from: T0 - 1 } }, T0 + 1000), null, '🔴 an effective_from 1 ms before 2026-01-01 was accepted');
assert.strictEqual(R({ x: { cents: 7000, effective_from: T0 }, a: { cents: 9000, effective_from: -1 } }, T0 + 1000), 7000, 'an invalid entry next to a valid one is skipped');
for (const [e, want] of [[{ cents: 100, effective_from: T0 }, true], [{ cents: 100000, effective_from: T0 }, true], [{ cents: 99, effective_from: T0 }, false], [{ cents: 100001, effective_from: T0 }, false],
  [{ cents: 7000, effective_from: T0 - 1 }, false], [{ cents: 7000, effective_from: T0 + 0.5 }, false], [{ cents: 7000, effective_from: 2 ** 53 }, false], [{ cents: 7000, effective_from: T0 + 9e12 }, true]]) {
  assert.strictEqual(P.validEntry(e), want, `validEntry(${JSON.stringify(e)}) must be ${want}`);
}
// the WRITE gate adds the clock bound: ≤ now + 366 days
const NOW = Date.parse('2026-11-01T00:00:00Z');
assert.strictEqual(P.writableEntry({ cents: 7000, effective_from: NOW + P.MAX_AHEAD_MS }, NOW), true, 'exactly 366 days ahead is writable');
assert.strictEqual(P.writableEntry({ cents: 7000, effective_from: NOW + P.MAX_AHEAD_MS + 1 }, NOW), false, '🔴 more than 366 days ahead was writable');
assert.strictEqual(P.writableEntry({ cents: 99, effective_from: NOW }, NOW), false, 'an invalid entry is never writable');
for (const now of [NaN, undefined, '1', Infinity]) assert.strictEqual(P.writableEntry({ cents: 7000, effective_from: NOW }, now), false, `writableEntry with now=${String(now)} → false`);
assert.strictEqual(R({ a: { cents: 7000, effective_from: T0 + 9e12 } }, T0 + 9e12), 7000, 'the reader has no clock bound (a stored far-future entry stays valid; validity never changes with time)');
// a tie on effective_from: the later pushId wins (push keys sort chronologically), regardless of object insertion order
const TIE = {}; TIE['-Nz'] = { cents: 9500, effective_from: T0 + 1000 }; TIE['-Na'] = { cents: 9000, effective_from: T0 + 1000 };
assert.strictEqual(R(TIE, T0 + 1000), 9500, 'tie → the later key (-Nz)');
assert.strictEqual(R([{ cents: 7000, effective_from: T0 }, { cents: 8000, effective_from: T0 + 1000 }], T0 + 1500), 8000, 'an array of entries works too');
ok('rateCentsInEffect: greatest effective_from ≤ t (inclusive), null before the first entry / for no entries / a non-finite t; entries outside the bounds contract (cents 100–100000 safe integer, effective_from integer ≥ 2026-01-01) skipped, never thrown; writableEntry adds ≤ now + 366 d; a tie goes to the later push key');

// ── 3. shiftEarningsCents ──
assert.strictEqual(S([{ delivered_at: T0 + 500 }, { delivered_at: T0 + 1500 }], E), 15000, '🔴 each delivery at its OWN rate (7000 + 8000): a mid-shift change is counted, never retro-applied');
assert.strictEqual(S([], E), 0, 'no deliveries + entries → 0');
assert.strictEqual(S(null, E), 0, 'null deliveries + entries → 0');
assert.strictEqual(S([], null), null, 'no entries → null (rate unknown: render nothing)');
assert.strictEqual(S([{ delivered_at: T0 + 500 }, { delivered_at: T0 - 1 }], E), null, '🔴 any uncovered delivery → null (never a partial total)');
assert.strictEqual(S([{ delivered_at: T0 + 500 }, {}], E), null, 'a delivery without delivered_at → null');
assert.strictEqual(S([{ delivered_at: T0 + 500 }], { a: { cents: 70.5, effective_from: T0 } }), null, 'only a malformed entry → null');
assert.strictEqual(S([{ delivered_at: T0 + 500 }], { a: { cents: Number.MAX_SAFE_INTEGER, effective_from: T0 } }), null, '🔴 only an out-of-bounds (unsafe-sized) entry → null, never a 9e15 total');
assert.strictEqual(S([{ delivered_at: 500 }], { a: { cents: 7000, effective_from: -1000 } }), null, '🔴 a negative effective_from never covers a delivery');
ok('shiftEarningsCents: the sum of per-delivery in-effect rates; 0 for none; null when the rate is unknown, any delivery is uncovered, or only out-of-bounds entries exist');

// ── 4. the driver copy as a browser classic script ──
{
  const win = {};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xpizza-driver', 'pay-rate.js'), 'utf8'), vm.createContext({ self: win }), { filename: 'pay-rate.js' });
  const B = win.PayRate;
  assert.ok(B && typeof B.rateCentsInEffect === 'function' && typeof B.shiftEarningsCents === 'function' && typeof B.writableEntry === 'function', 'window.PayRate exposes the helpers');
  for (const t of [T0 - 1, T0, T0 + 500, T0 + 999, T0 + 1000, T0 + 9e12]) assert.strictEqual(B.rateCentsInEffect(E, t), R(E, t), `browser == node at t=${t}`);
  assert.strictEqual(B.shiftEarningsCents([{ delivered_at: T0 + 500 }, { delivered_at: T0 + 1500 }], E), 15000);
  assert.strictEqual(B.rateCentsInEffect(MAL, T0 + 1000), 7000);
  assert.deepStrictEqual([B.MIN_CENTS, B.MAX_CENTS, B.MIN_EFFECTIVE_FROM, B.MAX_AHEAD_MS], [P.MIN_CENTS, P.MAX_CENTS, P.MIN_EFFECTIVE_FROM, P.MAX_AHEAD_MS]);
}
ok('the driver copy loads as a classic script (window.PayRate) and answers exactly like the Node module');

console.log(`\npay-rate: OK (${n})`);
