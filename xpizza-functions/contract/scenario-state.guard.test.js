'use strict';
// R3 P1-b — THE SCENARIO STATE VECTOR GUARD (static; npm test chain). Every (scenario, brand, LP) a P1 cell names has a
// derived vector; each vector is well-formed (exactly the declared fields, each in its domain); every scenario's marked
// LPs equal the matrix spec's LPs for it; the CHECKS cover only declared fields. Run: node contract/scenario-state.guard.test.js
const assert = require('assert');
const SS = require('./scenario-state');
const { gateA } = require('./gate-a');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-SCENARIO-STATE ${m}`;
const P1 = ['S1', 'S1t-a', 'S1t-b', 'S1t-c', 'S1a-on', 'S1a-off', 'S2', 'S3', 'S4', 'S13', 'S14-omitted', 'S14-empty', 'S14-efectivo', 'S14-bitcoin', 'S17d', 'S17p'];
const spec = require('./matrix-spec.json');
const doc = SS.load();

// 1. the paths cover exactly the P1 scenarios, and each scenario's marked LPs equal the spec's
assert.deepStrictEqual(Object.keys(doc.scenarios).sort(), [...P1].sort(), FAIL('the scenario paths are not exactly the P1 scenarios'));
for (const S of P1) {
  for (const b of doc.scenarios[S].brands || doc.defaultBrands) {
    const lps = Object.keys(SS.vectorsOf(S, b, doc));
    assert.deepStrictEqual([...lps].sort(), [...spec.scenarios[S].lps].sort(), FAIL(`${S}/${b}: path LPs ${JSON.stringify(lps)} ≠ spec LPs ${JSON.stringify(spec.scenarios[S].lps)}`));
    assert.ok(!spec.scenarios[S].fulfil || SS.vectorsOf(S, b, doc)[lps[0]].fulfil === spec.scenarios[S].fulfil, FAIL(`${S}: fulfilment differs from the spec`));
  }
}
ok(`${P1.length} scenario paths, each scenario's marked LPs = the matrix spec's LPs (per brand), fulfilment = the spec's`);

// 2. every P1 gate A cell's (S, brand, LP) has a well-formed vector
const cells = gateA({ scenarios: P1 }).cells;
const keys = [...new Set(cells.map((c) => `${c.S}|${c.brand}|${c.lp}`))];
const bad = [];
for (const k of keys) { const [S, b, lp] = k.split('|'); try { const p = SS.vectorProblems(SS.vectorOf(S, b, lp, doc)); if (p.length) bad.push(`${k}: ${p.join('; ')}`); } catch (e) { bad.push(`${k}: ${e.message}`); } }
assert.deepStrictEqual(bad, [], FAIL(`cells without a well-formed vector:\n  ${bad.slice(0, 10).join('\n  ')}`));
ok(`all ${cells.length} P1 gate A cells name a (scenario, brand, LP) with a well-formed vector (${keys.length} distinct)`);

// 3. CHECKS only over declared fields; the S1 / new vector is what P1-a's journey evidences
assert.ok(Object.keys(SS.CHECKS).every((k) => k in SS.FIELDS), FAIL('a CHECK names an undeclared field'));
const v = SS.vectorOf('S1', 'x_pizza', 'new', doc);
assert.deepStrictEqual({ fulfil: v.fulfil, pay: v.pay, kitchen: v.kitchen, driver: v.driver, terminal: v.terminal, scheduled: v.scheduled, redemption: v.redemption }, { fulfil: 'delivery', pay: 'cash', kitchen: 'none', driver: 'none', terminal: 'none', scheduled: false, redemption: false }, FAIL('the S1 / new vector'));
ok('CHECKS cover only declared fields; S1 / x_pizza / new = delivery, cash, kitchen none, no driver, not terminal, ASAP, no redemption');

// negatives (in memory)
const clone = () => JSON.parse(JSON.stringify(doc));
{ const d = clone(); d.scenarios.S2.path.push(['noop', 'extra_lp']); assert.throws(() => { for (const b of d.defaultBrands) { const lps = Object.keys(SS.vectorsOf('S2', b, d)); assert.deepStrictEqual(lps.sort(), [...spec.scenarios.S2.lps].sort()); } }, FAIL('an LP not in the spec passed')); }
{ const d = clone(); d.scenarios.S3.constants.pay = 'paypal'; assert.ok(SS.vectorProblems(SS.vectorOf('S3', 'x_pizza', 'new', d)).some((p) => /outside its domain/.test(p)), FAIL('a value outside its domain passed')); }
{ const d = clone(); d.scenarios.S1.path.splice(1, 0, 'teleport'); assert.throws(() => SS.vectorsOf('S1', 'x_pizza', d), /unknown effect/, FAIL('an unknown effect passed')); }
ok('negatives: an LP not in the spec, a value outside its domain, an unknown effect → RED');
console.log(`\nr3-scenario-state guard: OK (${n})`);
