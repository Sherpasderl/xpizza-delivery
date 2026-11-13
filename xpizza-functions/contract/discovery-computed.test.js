'use strict';
// contract/discovery.js — COMPUTED exports (2e asm7; r3-p0-scheduler D0: D4's eight SDK exports, written by
// `for (const k of SDK_PAY_FUNCTIONS.ENDPOINT_EXPORTS) exports[k] = SDK_PAY_FUNCTIONS[k];`, were SILENTLY invisible to source
// discovery). Only that loop shape over a top-level `const B = require('./m')` binding resolves (names read from ./m's list,
// each classified like any re-export); every other computed export is UNCLASSIFIED. Run: node contract/discovery-computed.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./discovery');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// endpoint-shaped values only (classifyRuntime reads __endpoint), so the fixture needs no firebase-functions install
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-computed-'));
const w = (f, src) => fs.writeFileSync(path.join(dir, f), src);
w('m.js', [
  "const ev = (t, ref) => ({ __endpoint: { eventTrigger: { eventType: `google.firebase.database.ref.v1.${t}`, eventFilterPathPatterns: { ref } } } });",
  "exports.aHttp = { __endpoint: { httpsTrigger: {} } };",
  "exports.aSched = { __endpoint: { scheduleTrigger: { schedule: 'every 5 minutes' } } };",
  "exports.aDb = ev('created', '/queue/{id}');",
  "exports.notFn = { plain: true };",
  "exports.LIST = Object.freeze(['aHttp', 'aSched', 'aDb', 'notFn']);",
  "exports.BAD = 'aHttp';",
].join('\n'));
w('index.js', [
  "const M = require('./m'); for (const k of M.LIST) exports[k] = M[k];",
  "const NOT_REQ = { LIST: ['x'] }; for (const k of NOT_REQ.LIST) exports[k] = NOT_REQ[k];",   // not a require binding → unclassified
  "for (const k of M.LIST) exports[k] = M.aHttp;",                                               // value is not B[k] → unclassified
  "exports['literalKey'] = M.aHttp;",                                                            // a bare computed export → unclassified
  "for (const k of M.BAD) exports[k] = M[k];",                                                   // the list is not an array → unclassified
].join('\n'));

const SRC = D.sourceInventory(path.join(dir, 'index.js'));
const by = (name) => SRC.entries.filter((e) => e.name === name);

// 1 — the loop shape: every listed name is found, classified by its OWN endpoint
assert.deepStrictEqual(by('aHttp').map((e) => [e.category, e.how, e.via]), [['http', 'reexport', 'LIST']], '🔴 DC-1 a listed http export is discovered');
assert.deepStrictEqual(by('aSched').map((e) => e.category), ['schedule'], '🔴 DC-1 a listed schedule export is discovered');
assert.deepStrictEqual(by('aDb').map((e) => [e.category, e.kind, e.ref]), [['db', 'created', 'queue/{id}']], '🔴 DC-1 a listed db trigger keeps its kind + ref');
assert.deepStrictEqual(by('notFn').map((e) => e.category), ['not-endpoint'], '🔴 DC-1 a listed non-endpoint is classified, not dropped');
ok('for (const k of B.LIST) exports[k] = B[k] → each listed name discovered and classified (http / schedule / db kind+ref / not-endpoint)');

// 2 — every other computed export fails CLOSED
const comp = SRC.unclassified.filter((u) => u.type === 'computed-export');
assert.strictEqual(comp.length, 4, `🔴 DC-2 the four non-loop-shape computed exports are UNCLASSIFIED (got ${JSON.stringify(SRC.unclassified)})`);
assert.ok(comp.some((u) => /not a non-empty array of strings/.test(u.why)), '🔴 DC-2 a non-array list is named');
assert.strictEqual(by('x').length, 0, '🔴 DC-2 a non-require loop resolves nothing');
ok('non-require binding / value not B[k] / bare exports[\'…\'] / a non-array list → UNCLASSIFIED with a reason, never dropped');

// 3 — the REAL index.js: D4's ENDPOINT_EXPORTS are all discovered from source, with the category of the loaded export
const SDK = require('../payments/sdk/functions');
const real = D.sourceInventory();
for (const k of SDK.ENDPOINT_EXPORTS) {
  const hits = real.entries.filter((e) => e.name === k);
  assert.strictEqual(hits.length, 1, `🔴 DC-3 ${k} is discovered once from index.js source`);
  assert.strictEqual(hits[0].category, D.classifyRuntime(SDK[k]).category, `🔴 DC-3 ${k} keeps its endpoint category`);
}
assert.deepStrictEqual(real.unclassified.filter((u) => u.type === 'computed-export'), [], '🔴 DC-3 index.js has no unresolved computed export');
ok(`index.js: all ${SDK.ENDPOINT_EXPORTS.length} ENDPOINT_EXPORTS discovered from source with their runtime category`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`discovery computed exports: OK (${n})`);
