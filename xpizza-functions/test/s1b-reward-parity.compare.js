'use strict';
// S1b — base vs tip, captured by test/s1b-reward-parity.capture.js: every response must be byte-identical (status + body + written
// + charged + the written order's money projection), AND every base response must equal its PINNED answer exactly
// (test/s1b-reward-parity.pins.json — one record per endpoint, setting and case; codex S1b r3 P2-2: a pin, never a predicate).
// Fixed rules on top of the pins (D4c-grill/item-s1/S1b-DESIGN.md: the Q3 correction, option A, codex r3):
//   - a malformed-key case never carries the stage's codes (menu_changed / invalid_line), at base or tip;
//   - under extras_eligibility 'enforce' an ARRAY key is today's 400 item_malformed with its customer copy at all four endpoints.
// Run: node test/s1b-reward-parity.compare.js <base.json> <tip.json> [pins.json]
//      node test/s1b-reward-parity.compare.js --print-pins <base.json>   (writes the pin table from a reviewed base capture)
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
if (process.argv[2] === '--print-pins') { process.stdout.write(`${JSON.stringify(sorted(read(process.argv[3])), null, 1)}\n`); process.exit(0); }
const [base, tip] = process.argv.slice(2, 4).map(read);
const pins = read(process.argv[4] || path.join(__dirname, 's1b-reward-parity.pins.json'));
const COPY = 'Tu pedido tiene un producto o un extra que no reconocemos. Volvé a armarlo, por favor.';
const keys = Object.keys(pins).sort();
assert.strictEqual(keys.length, 40, 'premise: forty pinned cases (8 reward, 32 malformed: 2 settings × 2 brands × 2 kinds × 4 endpoints)');
assert.deepStrictEqual(Object.keys(base).sort(), keys, 'premise: the base capture has exactly the pinned cases');
assert.deepStrictEqual(Object.keys(tip).sort(), keys, 'premise: the tip capture has exactly the pinned cases');
const errOf = (r) => { try { return JSON.parse(r.body).error; } catch (_) { return undefined; } };
for (const k of keys) {
  if (k.startsWith('mf_')) {
    for (const [who, r] of [['base', base[k]], ['tip', tip[k]]]) assert.ok(!['menu_changed', 'invalid_line'].includes(errOf(r)), `🔴 RWP-STAGE ${k}: the ${who} answers with the stage's code (${r.body.slice(0, 120)})`);
    if (k.startsWith('mf_enforce_') && k.split('/')[0].endsWith('_array')) assert.ok(pins[k].status === 400 && JSON.parse(pins[k].body).error === 'item_malformed' && JSON.parse(pins[k].body).detail === COPY, `premise: the pin for ${k} is today's 400 item_malformed with its copy`);
  }
  assert.deepStrictEqual(base[k], pins[k], `premise: the base answers ${k} exactly as pinned (${JSON.stringify(base[k]).slice(0, 160)})`);
  assert.deepStrictEqual(tip[k], base[k], `🔴 RWP ${k}: the tip answers differently from the base`);
}
console.log(`s1b-reward-parity: OK (${keys.length} responses: each the base's pinned answer, byte-identical at the tip)`);
