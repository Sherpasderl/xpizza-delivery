'use strict';
// R3 §2 / §3a — THE MATRIX GUARD (static; in the npm test chain). Regenerates matrix.json from matrix-spec.json +
// census.json and compares: every census obligation joins to a REQUIRED cell, no open fact delta, and the committed
// matrix equals the generated one (a spec / census change without a regenerated, reviewed matrix is RED).
// The DYNAMIC half — every required cell's designated assertion EXECUTED in the run — is enforced by the P1 suites.
const assert = require('assert');
const fs = require('fs');
const { build, OUT } = require('./matrix-build');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (msg) => `🔴 R3-MATRIX ${msg}`;
const { problems, openDeltas, doc } = build();
assert.deepStrictEqual(problems, [], FAIL(`problems:\n  ${problems.slice(0, 20).join('\n  ')}`));
assert.deepStrictEqual(openDeltas, [], FAIL(`${openDeltas.length} census read(s) whose facts the reviewed list does not cover: ${JSON.stringify(openDeltas.slice(0, 5))}`));
ok(`${doc.counts.obligations} (R-site, fact) obligations from ${doc.counts.obligationSites} census sites all join to a REQUIRED cell; no open fact delta (${doc.counts.deltas} accepted with reasons)`);
const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const key = (c) => `${c.cell}|${c.status}|${c.kind}`;
const a = new Set(doc.cells.map(key)); const b = new Set(committed.cells.map(key));
const add = [...a].filter((k) => !b.has(k)); const gone = [...b].filter((k) => !a.has(k));
assert.deepStrictEqual({ add: add.slice(0, 10), gone: gone.slice(0, 10) }, { add: [], gone: [] }, FAIL(`matrix.json is stale (${add.length} new, ${gone.length} removed cells) — review, then node contract/matrix-build.js --write`));
assert.ok(doc.counts.byStatus.required > 5000 && doc.counts.byStatus.gap > 0, FAIL(`premise — matrix size (${JSON.stringify(doc.counts.byStatus)})`));
ok(`matrix.json equals the generated matrix: ${doc.counts.cells} cells (${doc.counts.byStatus.required} required, ${doc.counts.byStatus.gap} GAP with reasons, ${doc.counts.byKind.absence} absence)`);
console.log(`\nr3-matrix guard: OK (${n})`);
