'use strict';
// R3 P1-b — THE BRANCH-COVERAGE GUARD (static; npm test chain; PLAN-R3-P1 §3c). The committed list equals the generated
// one (every site a P1 required cell obligates is listed; planned = the designed scenario cells; exercised = a baseline
// hit in a NAMED planned (scenario, brand, LP) context); every reviewed GAP names a listed site with a reason; planned and
// exercised are never conflated. Run: node contract/branch-coverage.guard.test.js
const assert = require('assert');
const fs = require('fs');
const BC = require('./branch-coverage');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-BRANCH-COVERAGE ${m}`;
const committed = JSON.parse(fs.readFileSync(BC.OUT, 'utf8'));
const gen = BC.build();
assert.deepStrictEqual(committed.sites, gen.sites, FAIL('contract/p1-branch-coverage.json differs from the generated list — node contract/branch-coverage.js --write, then review'));
ok(`the list equals the generated one: ${gen.counts.sites} sites obligated by P1 cells — ${gen.counts.exercised} exercised (a hit in a named planned cell), ${gen.counts.plannedOnly} planned only (visible, no credit)`);
const hits = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'p1-hits.json'), 'utf8')).contexts;
const bad = [];
for (const [s, e] of Object.entries(gen.sites)) for (const x of e.exercised) { const [cell, ctx] = x.split(' @ '); const [S, b, lp] = cell.split('|'); if (!((hits[ctx] || []).includes(s)) || !((e.planned[S] || {})[b] || []).includes(lp)) bad.push(`${s}: ${x}`); }
assert.deepStrictEqual(bad, [], FAIL(`exercised entries without a baseline hit in their named planned cell:\n  ${bad.slice(0, 5).join('\n  ')}`));
ok('every "exercised" cites a baseline hit in a planned (scenario, brand, LP) — the boot context never counts');
const gaps = JSON.parse(fs.readFileSync(BC.GAPS, 'utf8')).gaps || {};
const gp = Object.entries(gaps).filter(([s, g]) => !gen.sites[s] || !(g.reason && g.reason.trim())).map(([s]) => s);
assert.deepStrictEqual(gp, [], FAIL(`stale / unjustified GAP entries: ${gp.join(', ')}`));
ok(`reviewed GAPs: ${Object.keys(gaps).length} (each names a listed site, with a reason)`);
// negatives (in memory)
const fakeHits = { contexts: { boot: Object.keys(gen.sites).slice(0, 5) } };
const g2 = BC.build({ hits: fakeHits });
assert.ok(Object.values(g2.sites).every((e) => e.exercised.length === 0), FAIL('a boot-context hit was credited as exercised'));
const anySite = Object.keys(gen.sites).find((s) => !gen.sites[s].exercised.length && !(gen.sites[s].planned.S2 || {}).x_pizza);
const g3 = BC.build({ hits: { contexts: { 'S2/x_pizza/ready': [anySite] } } });
assert.ok(g3.sites[anySite].exercised.length === 0, FAIL('a hit in a scenario that does not plan the site was credited'));
ok('negatives: a boot-context hit, or a hit in a scenario that does not plan the site, is never credited as exercised');
console.log(`\nr3-branch-coverage guard: OK (${n})`);
