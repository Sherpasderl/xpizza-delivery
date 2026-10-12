'use strict';
// R3 §2 / §3a — THE MATRIX GUARD (static; in the npm test chain). Regenerates matrix.json from matrix-spec.json +
// census.json and requires: no problems, no open fact delta, UNIQUE cell identities and UNIQUE per-output assertion ids,
// every census site obligation carrying its own designated assertion, and the committed matrix equal to the generated
// one AS A WHOLE DOCUMENT (codex r1 P2: cells, metadata, obligations, outputs and the GAP report — not just a key set).
// codex r3 P1-3: the join is EXPLICIT per (site, fact, scenario, brand, LP) — cells list every applicable site obligation;
// site-less groups carry reviewed output assertions; coverage() is the rule (codex's counter-example is RED under it).
// The DYNAMIC half — every required (cell, site) pair EXECUTED in the run — is P1's.
const assert = require('assert');
const fs = require('fs');
const { build, coverage, OUT, SPEC_FILE } = require('./matrix-build');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (msg) => `🔴 R3-MATRIX ${msg}`;
const { problems, openDeltas, doc } = build();
assert.deepStrictEqual(problems, [], FAIL(`problems:\n  ${problems.slice(0, 20).join('\n  ')}`));
assert.deepStrictEqual(openDeltas, [], FAIL(`${openDeltas.length} census read(s) whose facts the reviewed list does not cover: ${JSON.stringify(openDeltas.slice(0, 5))}`));
const dupCells = doc.cells.map((c) => c.cell).filter((c, i, a) => a.indexOf(c) !== i);
assert.deepStrictEqual(dupCells.slice(0, 5), [], FAIL(`duplicate cell identities: ${dupCells.slice(0, 5).join(', ')}`));
const asr = doc.outputs.flatMap((o) => o.assertions); const dupA = asr.filter((a, i, x) => x.indexOf(a) !== i);
assert.deepStrictEqual(dupA.slice(0, 5), [], FAIL(`duplicate output assertion ids: ${dupA.slice(0, 5).join(', ')}`));
assert.ok(doc.siteObligations.every((o) => o.assertion === `R3:${o.R}:${o.fact}:#${o.site}`), FAIL('a site obligation without its own per-SITE designated assertion'));
const dupSite = doc.siteObligations.map((o) => o.assertion).filter((a, i, x) => x.indexOf(a) !== i);
assert.deepStrictEqual(dupSite.slice(0, 5), [], FAIL(`two obligations share an assertion: ${dupSite.slice(0, 5).join(', ')}`));
const reqGroups = new Set(doc.cells.filter((c) => c.status === 'required' && c.group).map((c) => c.group));
const orphan = Object.keys(doc.groups).filter((g) => !reqGroups.has(g));
assert.deepStrictEqual(orphan, [], FAIL(`site-assertion groups with no required cell to execute in: ${orphan.join(', ')}`));
ok(`${doc.counts.siteObligations} per-SITE designated assertions (every independently implemented read / branch its own) across ${doc.counts.groups} (R, fact) groups, each group joined to required cells; cells unique; no open delta`);
// codex r3 P1-3 — the join is EXPLICIT per (site, fact, scenario, brand, LP)
const req = doc.cells.filter((c) => c.kind === 'agreement' && c.status === 'required');
const bare = req.filter((c) => !c.sites.length && !(c.outputs || []).length);
assert.deepStrictEqual(bare.slice(0, 5).map((c) => c.cell), [], FAIL(`required cells with NO applicable assertion: ${bare.length}`));
const used = new Array(doc.siteObligations.length).fill(0);
for (const c of doc.cells.filter((x) => x.kind === 'agreement')) for (const i of c.sites) {
  const o = doc.siteObligations[i];
  assert.ok(o && o.R === c.R && o.fact === c.fact && o.applies.scenarios.includes(c.S) && o.applies.brands.includes(c.brand) && o.applies.lps.includes(c.lp), FAIL(`cell ${c.cell} lists site ${i} outside its (R, fact) / applicability`));
  if (c.status === 'required') used[i] += 1;
}
doc.siteObligations.forEach((o, i) => assert.ok(used[i] >= 1 && used[i] === o.requiredCells, FAIL(`site ${o.assertion}: ${used[i]} required cell(s) list it, declared ${o.requiredCells}`)));
assert.strictEqual(req.reduce((a, c) => a + c.sites.length, 0), doc.counts.requiredCellSitePairs, FAIL('requiredCellSitePairs count drift'));
ok(`explicit applicability: ${doc.counts.requiredCellSitePairs} required (cell, site) obligations; every required cell lists ≥ 1 applicable assertion; every site obligation is listed by exactly its declared required cells (≥ 1); ${doc.counts.unsitedGroups} site-less groups (${doc.counts.unsitedRequiredCells} required cells) carry reviewed output assertions`);

// codex's counter-example: an execution mapping where every required R2:MONEY cell runs the group's FIRST site and the
// second site runs in ONE cell satisfies "each cell executes one, each site executes somewhere" — it must now be RED
const r2 = req.filter((c) => c.R === 'R2' && c.fact === 'MONEY');
const s1 = doc.siteObligations[r2[0].sites[0]].assertion; const s2 = doc.siteObligations[r2[0].sites[1]].assertion;
const weak = new Set(r2.map((c) => `${c.cell}|${s1}`)); weak.add(`${r2[0].cell}|${s2}`);
const missWeak = coverage(doc, weak).filter((m) => m.startsWith('R3:R2:MONEY:'));
assert.ok(missWeak.some((m) => m.endsWith(`|${s2}`)) && missWeak.filter((m) => m.endsWith(`|${s2}`)).length === r2.filter((c) => c.sites.includes(r2[0].sites[1])).length - 1, FAIL('the coverage rule accepted a site executed in only one of its applicable cells'));
const full = new Set(r2.flatMap((c) => c.sites.map((i) => `${c.cell}|${doc.siteObligations[i].assertion}`)));
assert.deepStrictEqual(coverage(doc, full).filter((m) => m.startsWith('R3:R2:MONEY:')), [], FAIL('full R2:MONEY execution still reported missing pairs'));
ok(`coverage rule: codex's R2:MONEY mapping (${r2.length} cells run site 1, site 2 runs once) → ${missWeak.length} missing (cell, site) pairs, incl. ${missWeak.filter((m) => m.endsWith(`|${s2}`)).length} for site 2; executing every pair → 0`);

// negatives: the applicability / disposition schema refuses unreviewed or inconsistent narrowing
const base = () => JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
const o2 = doc.siteObligations[r2[0].sites[1]];
const neg = [
  ['narrowing without a reason', (s) => s.siteApplicability.entries.push({ site: o2.site, fact: 'MONEY', brands: ['x_pizza'] }), /has no reason/],
  ['a stale narrowing (no such site)', (s) => s.siteApplicability.entries.push({ site: 'nope#x#total#0', fact: 'MONEY', brands: ['x_pizza'], reason: 'r' }), /matches no site obligation/],
  ['narrowing a site to no REQUIRED cell', (s) => s.siteApplicability.entries.push({ site: o2.site, fact: 'MONEY', scenarios: ['S10'], lps: ['escalated'], reason: 'r' }), /applies to no REQUIRED cell/],
  ['a site-less group without a disposition', (s) => { delete s.unsitedFacts['R6:MONEY']; }, /R6:MONEY: \d+ required cell\(s\) with NO census site/],
  ['a disposition naming a function that does not exist', (s) => { s.unsitedFacts['R6:MONEY'].outputs = ['xpizza-functions/staff-push.js#formatMoneyLine']; }, /does not exist in source/],
  ['a disposition for a group that HAS sites', (s) => { s.unsitedFacts['R2:MONEY'] = { kind: 'output', outputs: ['xpizza-functions/staff-push.js#formatNewOrder'], reason: 'r' }; }, /unsitedFacts\.R2:MONEY is stale/],
];
for (const [label, mut, re] of neg) { const s = base(); mut(s); const p = build(s).problems; assert.ok(p.some((x) => re.test(x)), FAIL(`negative "${label}" was not refused: ${JSON.stringify(p.slice(0, 3))}`)); }
const sn = base(); sn.siteApplicability.entries.push({ site: o2.site, fact: 'MONEY', brands: ['x_pizza'], reason: 'reviewed narrowing (test)' });
const nd = build(sn); const no2 = nd.doc.siteObligations.find((o) => o.assertion === o2.assertion);
assert.ok(!nd.problems.length && no2.applies.brands.join() === 'x_pizza' && no2.requiredCells < o2.requiredCells && nd.doc.cells.filter((c) => c.brand === 'la_musa' && c.group === 'R2:MONEY').every((c) => !c.sites.includes(nd.doc.siteObligations.indexOf(no2))), FAIL('a reviewed narrowing did not narrow exactly'));
ok(`schema negatives refused (${neg.length}): ${neg.map((x) => x[0]).join('; ')}; a REVIEWED narrowing narrows exactly (${o2.requiredCells} → ${no2.requiredCells} required cells)`);

const norm = (d) => JSON.stringify(d);
const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
assert.ok(norm(committed) === norm(doc), FAIL('matrix.json differs from the generated document (cells, metadata, obligations, outputs or GAP report) — review, then node contract/matrix-build.js --write'));
assert.ok(doc.counts.byStatus.required > 5000 && doc.counts.byStatus.gap > 0, FAIL(`premise — matrix size (${JSON.stringify(doc.counts.byStatus)})`));
ok(`matrix.json equals the generated document in full: ${doc.counts.cells} cells (${doc.counts.byStatus.required} required, ${doc.counts.byStatus.gap} GAP with reasons, ${doc.counts.byKind.absence} absence)`);
console.log(`\nr3-matrix guard: OK (${n})`);
