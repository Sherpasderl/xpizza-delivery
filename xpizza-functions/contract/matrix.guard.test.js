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
const allReq = doc.cells.filter((c) => c.status === 'required');
const bare = allReq.filter((c) => !(c.sites || []).length && !(c.outputs || []).length);
assert.deepStrictEqual(bare.slice(0, 5).map((c) => c.cell), [], FAIL(`required cells (any kind) with NO designated assertion: ${bare.length}`));
const used = new Array(doc.siteObligations.length).fill(0);
for (const c of doc.cells.filter((x) => x.kind === 'agreement')) for (const i of c.sites) {
  const o = doc.siteObligations[i];
  assert.ok(o && o.R === c.R && o.fact === c.fact && o.applies.scenarios.includes(c.S) && o.applies.brands.includes(c.brand) && o.applies.lps.includes(c.lp), FAIL(`cell ${c.cell} lists site ${i} outside its (R, fact) / applicability`));
  if (c.status === 'required') used[i] += 1;
}
doc.siteObligations.forEach((o, i) => assert.ok(used[i] >= 1 && used[i] === o.requiredCells, FAIL(`site ${o.assertion}: ${used[i]} required cell(s) list it, declared ${o.requiredCells}`)));
assert.strictEqual(req.reduce((a, c) => a + c.sites.length, 0), doc.counts.requiredCellSitePairs, FAIL('requiredCellSitePairs count drift'));
ok(`explicit applicability: ${doc.counts.requiredCellSitePairs} required (cell, site) obligations; every required cell OF ANY KIND has ≥ 1 designated assertion (${doc.counts.absenceRequiredCells} absence, ${doc.counts.notInSourceRequiredCells} not-in-source); every site obligation is listed by exactly its declared required cells (≥ 1); ${doc.counts.unsitedGroups} site-less groups (${doc.counts.unsitedParts} parts, ${doc.counts.unsitedRequiredCells} required cells) carry reviewed output assertions`);

// codex r4 P1-3: coverage() covers EVERY required cell. Every agreement pair executed, NO absence assertion executed → RED
// with exactly the required absence (and not-in-source) cells missing
const allAgree = new Set();
for (const c of doc.cells.filter((x) => x.status === 'required' && x.kind === 'agreement')) for (const a of (c.sites.length ? c.sites.map((i) => doc.siteObligations[i].assertion) : c.outputs)) allAgree.add(`${c.cell}|${a}`);
const missAbs = coverage(doc, allAgree);
const wantAbs = allReq.filter((c) => c.kind === 'absence').reduce((a, c) => a + c.outputs.length, 0);
assert.ok(missAbs.filter((m) => /:ABSENT:/.test(m)).length === wantAbs && wantAbs > 0, FAIL(`coverage() let required ABSENCE cells pass unexecuted (${missAbs.filter((m) => /:ABSENT:/.test(m)).length} of ${wantAbs} reported)`));
const nis = allReq.filter((c) => c.kind === 'not-in-source');
assert.ok(nis.every((c) => c.outputs.every((a) => missAbs.includes(`${c.cell}|${a}`))), FAIL('coverage() let required NOT-IN-SOURCE cells pass unexecuted'));
const everything = new Set([...allAgree, ...missAbs]);
assert.deepStrictEqual(coverage(doc, everything), [], FAIL('coverage() still reports missing pairs after every required assertion ran'));
ok(`coverage covers every required cell: all ${allAgree.size} agreement pairs executed, absences not → RED with all ${wantAbs} required absence assertions (${doc.counts.absenceRequiredCells} cells) + every not-in-source assertion missing; executing them too → 0`);

// codex r4 P1-4: R9:PLACE is split — pickup messages that state the restaurant are POSITIVE output assertions; only the
// outputs that state no location are not-in-source (reported apart, listed for PLAN reconciliation before P1)
const r9 = doc.cells.filter((c) => c.R === 'R9' && c.fact === 'PLACE' && c.status === 'required');
const r9ready = r9.find((c) => c.S === 'S2' && c.lp === 'ready');
assert.ok(r9ready && r9ready.kind === 'agreement' && r9ready.outputs.includes('R3:R9:PLACE:@xpizza-functions/whatsapp.js#renderPickupReady'), FAIL('R9:PLACE pickup-ready does not assert the displayed pickup location (renderPickupReady)'));
assert.ok(r9.filter((c) => c.kind === 'not-in-source').every((c) => c.S !== 'S2' || c.lp === 'completed'), FAIL('an R9:PLACE pickup cell stating the location was classified absent'));
assert.ok(doc.planReconciliation.length && doc.planReconciliation.every((u) => /^dropped 2026-10-12, advisor/.test(u.ruling || '')) && doc.planReconciliation.every((u) => doc.cells.some((c) => c.kind === 'not-in-source' && c.group === u.group)) && doc.counts.byKind['not-in-source'] === doc.cells.filter((c) => c.kind === 'not-in-source').length, FAIL('not-in-source cells are not reported apart from agreement'));
ok(`R9:PLACE split: pickup new / ready assert the displayed location (renderPickupReceived / renderPickupReady); delivery + pickup-completed are not-in-source; ${doc.counts.byKind['not-in-source']} not-in-source cells are their own kind, ${doc.planReconciliation.length} parts listed for PLAN reconciliation before P1`);

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
  ['an absence reader without reviewed absenceOutputs', (s) => { delete s.absenceOutputs.R1; }, /absence cell R3:R1:ABSENT:.* no reviewed absenceOutputs\.R1/],
  ['a not-in-source part without the reconciliation ruling', (s) => { delete s.unsitedFacts['R6:MONEY'].ruling; }, /R6:MONEY: not-in-source without a PLAN-reconciliation ruling/],
  ['a split whose parts overlap', (s) => { s.unsitedFacts['R9:PLACE'].split[3].when = {}; }, /R9:PLACE: cell .* matches 2 part/],
  ['a split that leaves cells unmatched', (s) => { s.unsitedFacts['R9:PLACE'].split.pop(); }, /R9:PLACE: cell .* matches 0 part/],
  ['a disposition for a group that HAS sites', (s) => { s.unsitedFacts['R2:MONEY'] = { kind: 'output', outputs: ['xpizza-functions/staff-push.js#formatNewOrder'], reason: 'r' }; }, /unsitedFacts\.R2:MONEY is stale/],
];
for (const [label, mut, re] of neg) { const s = base(); mut(s); const p = build(s).problems; assert.ok(p.some((x) => re.test(x)), FAIL(`negative "${label}" was not refused: ${JSON.stringify(p.slice(0, 3))}`)); }
const sn = base(); sn.siteApplicability.entries.push({ site: o2.site, fact: 'MONEY', brands: ['x_pizza'], reason: 'reviewed narrowing (test)' });
const nd = build(sn); const no2 = nd.doc.siteObligations.find((o) => o.assertion === o2.assertion);
assert.ok(!nd.problems.length && no2.applies.brands.join() === 'x_pizza' && no2.requiredCells < o2.requiredCells && nd.doc.cells.filter((c) => c.brand === 'la_musa' && c.group === 'R2:MONEY').every((c) => !c.sites.includes(nd.doc.siteObligations.indexOf(no2))), FAIL('a reviewed narrowing did not narrow exactly'));
ok(`schema negatives refused (${neg.length}): ${neg.map((x) => x[0]).join('; ')}; a REVIEWED narrowing narrows exactly (${o2.requiredCells} → ${no2.requiredCells} required cells)`);

// P1-a: brandSurfaces — a brand's own form site never joins another brand's cell (sites or unsited outputs)
{
  const bs = Object.entries(JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')).brandSurfaces || {}).filter(([k]) => k !== '_doc');
  const wrong = [];
  for (const c of doc.cells) {
    const refs = [...(c.sites || []).map((i) => doc.siteObligations[i].site), ...(c.outputs || []).map((x) => { const m = /:[@!]([^:]*)$/.exec(x); return m ? m[1] : ''; })];
    for (const r of refs) for (const [pre, brands] of bs) if (r.startsWith(pre) && !brands.includes(c.brand)) wrong.push(`${c.cell} ← ${r}`);
  }
  assert.deepStrictEqual(wrong.slice(0, 5), [], FAIL(`a brand's own surface joined another brand's cell (${wrong.length})`));
  const neg = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')); delete neg.brandSurfaces;
  const nd = build(neg).doc; const leaks = nd.cells.filter((c) => c.brand === 'x_pizza' && (c.sites || []).some((i) => nd.siteObligations[i].site.startsWith('la-musa-orders/'))).length;
  assert.ok(leaks > 0, FAIL('premise — without brandSurfaces La Musa form sites would join x_pizza cells'));
  ok(`brandSurfaces: no cell lists another brand's form site / output (without the rule ${leaks} x_pizza cells would join La Musa form sites)`);
}
const norm = (d) => JSON.stringify(d);
const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
assert.ok(norm(committed) === norm(doc), FAIL('matrix.json differs from the generated document (cells, metadata, obligations, outputs or GAP report) — review, then node contract/matrix-build.js --write'));
assert.ok(doc.counts.byStatus.required > 5000 && doc.counts.byStatus.gap > 0, FAIL(`premise — matrix size (${JSON.stringify(doc.counts.byStatus)})`));
ok(`matrix.json equals the generated document in full: ${doc.counts.cells} cells (${doc.counts.byStatus.required} required, ${doc.counts.byStatus.gap} GAP with reasons, ${doc.counts.byKind.absence} absence)`);
console.log(`\nr3-matrix guard: OK (${n})`);
