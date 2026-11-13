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
assert.deepStrictEqual(real.unclassified, [], '🔴 DC-3 index.js has no unresolved computed export and no other export-surface use');
assert.deepStrictEqual(real.isolated.map((x) => x.set).sort(), ['PHOTOS_TARGETS', 'PORTAL_ISOLATED_TARGETS', 'PORTAL_OPS_TARGETS'], '🔴 DC-3 index.js: the three FUNCTION_TARGET branches are the isolated entries');
ok(`index.js: all ${SDK.ENDPOINT_EXPORTS.length} ENDPOINT_EXPORTS discovered from source with their runtime category`);

// 4 — Codex r1 P2-1: the loop resolves ONLY when B is a once-declared, never-written, top-level const require binding, the loop
// is top-level, and the list is frozen + distinct. One fixture per shape, each over m2.js (m.js + OPEN + DUP; a fresh module, so the require cache holds no stale m.js); exactly ONE reason each.
w('m2.js', fs.readFileSync(path.join(dir, 'm.js'), 'utf8') + "\nexports.OPEN = ['aHttp'];\nexports.DUP = Object.freeze(['aHttp', 'aHttp']);\n");
const LOOP = 'for (const k of M.LIST) exports[k] = M[k];';
const REQ = "const M = require('./m2');";
const one = (src) => { w('index.js', src); return D.sourceInventory(path.join(dir, 'index.js')); };
const LOOP_CASES = {
  'L1 nested': [`${REQ} { ${LOOP} }`, /outside a top-level/],
  'L2 let loop var': [`${REQ} for (let k of M.LIST) exports[k] = M[k];`, /is not `for \(const k of …\)`/],
  'L3 k shadows B': [`${REQ} for (const M of M.LIST) exports[M] = M[M];`, /loop variable M shadows M/],
  'L4 B shadowed in a function': [`${REQ} function f() { const M = 1; return M; } ${LOOP}`, /M is declared 2× in the file/],
  'L5 B declared with let': [`let M = require('./m2'); ${LOOP}`, /M is declared with let, not const/],
  'L6 B written through a member': [`${REQ} M.LIST = ['aHttp']; ${LOOP}`, /M \(or a member of it\) is written/],
  'L7 require redeclared': [`${REQ} function g(require) { return require; } ${LOOP}`, /`require` is redeclared/],
  'L8 unfrozen list': [`${REQ} for (const k of M.OPEN) exports[k] = M[k];`, /OPEN is not frozen/],
  'L9 repeated name': [`${REQ} for (const k of M.DUP) exports[k] = M[k];`, /DUP repeats a name/],
};
for (const [label, [src, why]] of Object.entries(LOOP_CASES)) {
  const r = one(src);
  assert.deepStrictEqual(r.unclassified.map((u) => u.type), ['computed-export'], `🔴 DC-4 ${label}: exactly one computed-export UNCLASSIFIED (got ${JSON.stringify(r.unclassified)})`);
  assert.ok(why.test(r.unclassified[0].why), `🔴 DC-4 ${label}: the reason names the rule (got ${r.unclassified[0].why})`);
  assert.strictEqual(r.entries.filter((e) => e.via).length, 0, `🔴 DC-4 ${label}: no name is resolved from the list`);
}
assert.deepStrictEqual(one(`${REQ} ${LOOP}`).unclassified, [], '🔴 DC-4 control: the canonical shape over the same m.js is clean');
ok(`the loop fails CLOSED on each of ${Object.keys(LOOP_CASES).length} shapes (nested / let / k shadows B / B shadowed / let B / B written / require redeclared / unfrozen / repeated) — one reason each`);

// 5 — Codex r1 P2-2: every OTHER use of the export objects is UNCLASSIFIED (it was silently dropped)
const SURFACE_CASES = {
  'S1 Object.assign(exports, …)': [`${REQ} Object.assign(exports, M);`, /`exports` is used other than/],
  'S2 module.exports = { ...B }': [`${REQ} module.exports = { ...M };`, /`module\.exports` is used other than/],
  'S3 defineProperty(module.exports, …)': [`${REQ} Object.defineProperty(module.exports, 'x', { value: M.aHttp });`, /`module\.exports` is used other than/],
  'S4 exports = …': [`${REQ} exports = M;`, /`exports` is used other than/],
  'S5 an alias of module': [`${REQ} const mod = module; mod.exports.x = M.aHttp;`, /`module` is used other than as `module\.exports`/],
  'S6 module-level this': [`${REQ} this.x = M.aHttp;`, /module-level `this`/],
  'S7 compound export assignment': [`${REQ} exports.x = M.aHttp; exports.x += '';`, /`exports` is used other than/],
  'S8 exports redeclared': [`${REQ} function h(exports) { return exports; }`, /`exports` is redeclared/],
  'S9 the isolated branch falls through (no return)': [`${REQ} const S = new Set(); if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./m2'); console.log('after'); }`, /`module\.exports` is used other than/],
  'S10 an isolated-looking branch on another variable': [`${REQ} const S = new Set(); if (S.has(process.env.OTHER)) { module.exports = require('./m2'); return; }`, /`module\.exports` is used other than/],
};
for (const [label, [src, why]] of Object.entries(SURFACE_CASES)) {
  const r = one(src); const u = r.unclassified.filter((x) => x.type === 'export-surface');
  assert.ok(u.some((x) => why.test(x.why)),`🔴 DC-5 ${label}: UNCLASSIFIED for the export surface (got ${JSON.stringify(r.unclassified)})`);
}
const iso = one(`${REQ} const S = new Set(); if (S.has(process.env.FUNCTION_TARGET)) { console.log('e'); module.exports = require('./m2'); return; } function q() { return this; } exports.y = M.aHttp;`);
assert.deepStrictEqual([iso.unclassified, iso.isolated.map((x) => [x.set, x.module])], [[], [['S', './m2']]], '🔴 DC-5 control: the isolated-entry branch + a function-scoped this + exports.y = … are clean');
ok(`every other use of exports / module.exports / module / module-level this is UNCLASSIFIED (${Object.keys(SURFACE_CASES).length} shapes); the FUNCTION_TARGET branch is listed as isolated`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`discovery computed exports: OK (${n})`);
