'use strict';
// R3 §3a — THE CENSUS GUARD (static; in the npm test chain). Recomputes the census from source and compares it with the
// committed, reviewed contract/census.json: a NEW site (a reader added without a census decision), a STALE one (a mapping
// that no longer exists), a changed mapping, an unmapped / unclassified entry, a write-sentinel hit, a projection
// premise miss or an application sleep outside the scheduler's reviewed set is RED.
// Regenerate after a REVIEWED change: node contract/census-build.js --write
const assert = require('assert');
const fs = require('fs');
const { build, OUT } = require('./census-build');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (msg) => `🔴 R3-CENSUS ${msg}`;

const { problems, doc } = build();
assert.deepStrictEqual(problems, [], FAIL(`the census has open problems:\n  ${problems.slice(0, 30).join('\n  ')}`));
ok(`census: ${doc.counts.units} source units, ${doc.counts.sites} read sites — every site mapped to an R-site or exempted with a reason; ${doc.counts.opaque} opaque reads mapped; write sentinel clean; timers reviewed; clocks classified`);

assert.ok(doc.counts.units >= 250 && doc.counts.sites >= 2000, FAIL(`premise — an empty / truncated walk (${doc.counts.units} units, ${doc.counts.sites} sites)`));
for (const r of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R15', 'R16', 'R17', 'R18']) {
  assert.ok((doc.counts.byR[r] || 0) > 0, FAIL(`premise — R-site ${r} has no census site (a rule stopped matching its reader)`));
}
ok(`premise: the walk is not truncated, and every R-site with persisted-order reads has census sites (${Object.entries(doc.counts.byR).map(([k, v]) => `${k} ${v}`).join(', ')})`);

const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const byId = (arr) => new Map(arr.map((s) => [s.id, s]));
const now = byId(doc.sites); const was = byId(committed.sites);
const added = [...now.keys()].filter((k) => !was.has(k));
const stale = [...was.keys()].filter((k) => !now.has(k));
const remapped = [...now.keys()].filter((k) => was.has(k) && (now.get(k).rule !== was.get(k).rule || now.get(k).r !== was.get(k).r));
assert.deepStrictEqual({ added: added.slice(0, 20), stale: stale.slice(0, 20), remapped: remapped.slice(0, 20) }, { added: [], stale: [], remapped: [] },
  FAIL(`the code's read sites differ from the reviewed census (${added.length} new, ${stale.length} stale, ${remapped.length} remapped) — review, then node contract/census-build.js --write`));
ok(`the reviewed census.json matches the code exactly (${now.size} site ids; 0 new, 0 stale, 0 remapped)`);

const keyset = (arr, f) => JSON.stringify(arr.map(f).sort());
for (const [name, f] of [['opaque', (o) => `${o.file}#${o.fn}#${o.how}#${o.rule}`], ['projections', (p) => `${p.scope}#${p.alias}#${p.field}`], ['sentinel', (s) => `${s.file}#${s.key}#${s.exempt}`], ['timers', (t) => `${t.key}#${t.class}`], ['clocks', (k) => `${k.key}#${k.class}`]]) {
  assert.strictEqual(keyset(doc[name], f), keyset(committed[name], f), FAIL(`the ${name} inventory differs from the reviewed census — review, then regenerate`));
}
ok(`opaque reads, projection links (incl. the KDS pedido / estado / maps premise), write sentinel, ${doc.timers.length} timers and ${doc.clocks.length} clock sites all equal the reviewed census`);

console.log(`\nr3-census guard: OK (${n})`);
