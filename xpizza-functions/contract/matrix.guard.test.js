'use strict';
// R3 §2 / §3a — THE MATRIX GUARD (static; in the npm test chain). Regenerates matrix.json from matrix-spec.json +
// census.json and requires: no problems, no open fact delta, UNIQUE cell identities and UNIQUE per-output assertion ids,
// every census site obligation carrying its own designated assertion, and the committed matrix equal to the generated
// one AS A WHOLE DOCUMENT (codex r1 P2: cells, metadata, obligations, outputs and the GAP report — not just a key set).
// The DYNAMIC half — every required cell and every designated output assertion EXECUTED in the run — is P1's.
const assert = require('assert');
const fs = require('fs');
const { build, OUT } = require('./matrix-build');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (msg) => `🔴 R3-MATRIX ${msg}`;
const { problems, openDeltas, doc } = build();
assert.deepStrictEqual(problems, [], FAIL(`problems:\n  ${problems.slice(0, 20).join('\n  ')}`));
assert.deepStrictEqual(openDeltas, [], FAIL(`${openDeltas.length} census read(s) whose facts the reviewed list does not cover: ${JSON.stringify(openDeltas.slice(0, 5))}`));
const dupCells = doc.cells.map((c) => c.cell).filter((c, i, a) => a.indexOf(c) !== i);
assert.deepStrictEqual(dupCells.slice(0, 5), [], FAIL(`duplicate cell identities: ${dupCells.slice(0, 5).join(', ')}`));
const asr = doc.outputs.flatMap((o) => o.assertions); const dupA = asr.filter((a, i, x) => x.indexOf(a) !== i);
assert.deepStrictEqual(dupA.slice(0, 5), [], FAIL(`duplicate output assertion ids: ${dupA.slice(0, 5).join(', ')}`));
assert.ok(doc.siteObligations.every((o) => o.assertion === `R3:${o.R}:${o.fact}:@${o.output}`), FAIL('a site obligation without its own designated (R, fact, output) assertion'));
ok(`${doc.counts.siteObligations} per-site obligations → ${doc.counts.outputAssertions} designated assertions over ${doc.counts.outputs} outputs (each independently implemented read has its own); cells unique; no open delta`);
const norm = (d) => JSON.stringify(d);
const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
assert.ok(norm(committed) === norm(doc), FAIL('matrix.json differs from the generated document (cells, metadata, obligations, outputs or GAP report) — review, then node contract/matrix-build.js --write'));
assert.ok(doc.counts.byStatus.required > 5000 && doc.counts.byStatus.gap > 0, FAIL(`premise — matrix size (${JSON.stringify(doc.counts.byStatus)})`));
ok(`matrix.json equals the generated document in full: ${doc.counts.cells} cells (${doc.counts.byStatus.required} required, ${doc.counts.byStatus.gap} GAP with reasons, ${doc.counts.byKind.absence} absence)`);
console.log(`\nr3-matrix guard: OK (${n})`);
