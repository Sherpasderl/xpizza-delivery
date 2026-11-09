'use strict';
// S1b — the base's and the tip's captures must be identical (status + body + nothing written / charged), and each base answer
// is pinned to today's refusal (D4c-grill/item-s1/S1b-DESIGN.md, the Q3 correction and the option-A ruling):
//   reward (Q3): an UNKNOWN reward key → 503 menu_updating (group-intake: unclassifiable); a non-string reward id → 409
//     redemption_invalid
//   malformed legacy key (option A): an array name / id → 400 item_malformed at all four endpoints; a null one → today's 400
//     (whichever check answers first at the base) — never the stage's menu_changed / invalid_line
// Run: node test/s1b-reward-parity.compare.js <base.json> <tip.json>
const assert = require('assert');
const [base, tip] = process.argv.slice(2).map((f) => JSON.parse(require('fs').readFileSync(f, 'utf8')));
assert.ok(base && tip && Object.keys(base).length === 24, 'premise: twenty-four captured responses (8 reward, 16 malformed)');
assert.deepStrictEqual(Object.keys(tip).sort(), Object.keys(base).sort(), 'the same cases');
const today = (k) => {
  if (k.startsWith('mf_')) return k.split('/')[0].endsWith('_array') ? [400, 'item_malformed'] : [400, null];
  return k.split('/')[0].endsWith('_unknown') ? [503, 'menu_updating'] : [409, 'redemption_invalid'];
};
for (const k of Object.keys(base)) {
  const [status, error] = today(k); const b = base[k]; const j = JSON.parse(b.body);
  assert.ok(b.status === status && (error ? j.error === error : !['menu_changed', 'invalid_line'].includes(j.error)) && b.written === false && !b.charged,
    `premise: the base refuses ${k} with today's ${status} ${error || '(not the stage\'s code)'}, nothing written or charged (${b.status} ${b.body.slice(0, 120)})`);
  assert.deepStrictEqual(tip[k], b, `🔴 RWP ${k}: the tip answers differently from the base`);
}
console.log(`s1b-reward-parity: OK (${Object.keys(base).length} responses byte-identical, base vs tip; each the base's pinned refusal)`);
