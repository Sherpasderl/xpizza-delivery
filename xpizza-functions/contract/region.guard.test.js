'use strict';
// R3 P1 §4b — THE REGION GUARD (static; npm test chain; codex P1 plan r3 P1-1). Every consumer call site of an output is a
// region; the reviewed registry must cover EXACTLY the generated inventory, and every entry must be well-formed.
// Run: node contract/region.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { build, OUT, REGISTRY } = require('./regions-build');
const { gateA } = require('./gate-a');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-REGION ${m}`;

// the checks, over (generated inventory, registry) — reused by the negatives
function check(doc, reg) {
  const p = [];
  const ids = new Set(doc.regions.map((r) => r.region));
  for (const id of ids) if (!reg.regions[id]) p.push(`region ${id} has NO registry entry (a new consumer call site — review it: terminal / via / pending)`);
  for (const id of Object.keys(reg.regions)) if (!ids.has(id)) p.push(`registry entry ${id} is stale (no such region)`);
  for (const [id, e] of Object.entries(reg.regions)) {
    if (!['pending', 'terminal', 'via'].includes(e.status)) p.push(`${id}: unknown status ${e.status}`);
    if (e.status === 'terminal' && !(e.observable && e.action)) p.push(`${id}: terminal needs observable + action`);
    if (e.status === 'via' && !(e.target && reg.regions[e.target])) p.push(`${id}: via target ${e.target} is not a region`);
    if (e.status === 'via' && !(e.reason && String(e.reason).trim())) p.push(`${id}: via needs a reason`);
    if (e.status === 'via' && reg.regions[e.target] && reg.regions[e.target].status === 'via') p.push(`${id}: via → via (${e.target}) — point at the terminal region`);
  }
  return p;
}

const { problems, doc } = build();
assert.deepStrictEqual(problems, [], FAIL(`inventory problems:\n  ${problems.slice(0, 10).join('\n  ')}`));
const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
assert.ok(JSON.stringify(committed.regions) === JSON.stringify(doc.regions), FAIL('regions.json differs from the generated inventory — node contract/regions-build.js --write, then review the registry'));
ok(`the committed region inventory equals the generated one: ${doc.counts.regions} regions over ${doc.counts.outputs} outputs (${doc.counts.multiConsumerOutputs} shared helpers with several consumers)`);

const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
const p = check(doc, reg);
assert.deepStrictEqual(p, [], FAIL(`registry problems:\n  ${p.slice(0, 10).join('\n  ')}`));
const st = Object.values(reg.regions).reduce((m, e) => ((m[e.status] = (m[e.status] || 0) + 1), m), {});
ok(`the registry covers exactly the inventory, every entry well-formed (${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(', ')})`);

// codex's example: every CALL SITE of paymentRowHtml is its own region — the driver active card AND the queue detail sheet,
// in the baseline renderers (kept in the file, now unreachable) and in the slice-2 stacked-view builders
const PR_CONSUMERS = ['xpizza-driver/index.html<script@0>#renderActiveCard', 'xpizza-driver/index.html<script@0>#renderQueueDetail', 'xpizza-driver/stacked-view.js#activeCardHtml', 'xpizza-driver/stacked-view.js#queueDetailHtml'];
const pr = doc.regions.filter((r) => r.output === 'xpizza-driver/cash-helpers.js#paymentRowHtml').map((r) => r.consumer);
assert.deepStrictEqual(pr.sort(), PR_CONSUMERS, FAIL(`paymentRowHtml regions: ${JSON.stringify(pr)}`));
const ga = gateA({ scenarios: ['S1'], brands: ['x_pizza'], lps: ['assigned'] });
const prCells = ga.cells.filter((c) => c.output === 'xpizza-driver/cash-helpers.js#paymentRowHtml');
assert.deepStrictEqual([...new Set(prCells.map((c) => c.region))].sort(), PR_CONSUMERS.map((c) => `xpizza-driver/cash-helpers.js#paymentRowHtml@${c}`), FAIL('gate A does not hold one cell per paymentRowHtml region'));
ok(`codex's example: paymentRowHtml → 4 regions (renderActiveCard, renderQueueDetail, stacked-view activeCardHtml, queueDetailHtml), each its own gate A cell (${prCells.length} at S1 / x_pizza / assigned)`);

// codex P1-a r1 P1-8: every CALL SITE is a region — getSalesStatsCore calls shapePeriod for the current AND the comparison
// period: two regions, never folded by caller
const sp = doc.regions.filter((r) => r.output === 'xpizza-functions/stats/stats-api.js#shapePeriod' && r.consumer === 'xpizza-functions/stats/stats-api.js#getSalesStatsCore');
assert.ok(sp.length === 2 && sp[0].line !== sp[1].line && sp.every((r) => r.callSites === 2), FAIL(`shapePeriod call sites: ${JSON.stringify(sp)}`));
const multi = doc.regions.filter((r) => r.callSites > 1).length;
ok(`every call site is its own region (codex's shapePeriod × 2 in getSalesStatsCore → 2 regions, lines ${sp.map((r) => r.line).join(' / ')}); ${multi} regions come from callers with several call sites`);

// negatives (in memory)
const clone = () => JSON.parse(JSON.stringify(reg));
const negs = [
  ['a new consumer call site without an entry', (r) => { delete r.regions[doc.regions[0].region]; }, /has NO registry entry/],
  ['a stale entry', (r) => { r.regions['nope#x@y#z'] = { status: 'pending' }; }, /is stale/],
  ['a terminal without observable', (r) => { r.regions[doc.regions[0].region] = { status: 'terminal', action: 'a' }; }, /terminal needs observable \+ action/],
  ['a via to a non-region', (r) => { r.regions[doc.regions[0].region] = { status: 'via', target: 'nope', reason: 'r' }; }, /is not a region/],
  ['a via without a reason', (r) => { r.regions[doc.regions[0].region] = { status: 'via', target: doc.regions[1].region }; }, /via needs a reason/],
];
for (const [label, mut, re] of negs) { const r = clone(); mut(r); assert.ok(check(doc, r).some((x) => re.test(x)), FAIL(`negative "${label}" was not refused`)); }
ok(`negatives refused: ${negs.map((x) => x[0]).join('; ')}`);

console.log(`\nr3-region guard: OK (${n})`);
