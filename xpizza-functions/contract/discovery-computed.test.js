'use strict';
// contract/discovery.js — the export surface is a STRICT ALLOWLIST (2e asm7; r3-p0-scheduler D0: D4's eight SDK exports,
// written by `for (const k of SDK_PAY_FUNCTIONS.ENDPOINT_EXPORTS) exports[k] = SDK_PAY_FUNCTIONS[k];`, were SILENTLY invisible
// to source discovery; Codex r1 2×P2 + r2 5×P2 → advisor ruling 11-12: allowlist, not shape-chasing). Accepted: (a) top-level
// `exports.X = …` / `module.exports.X = …`; (b) the one loop over a `const B = require('./m')` that B never leaves, with ./m's
// surface top-level `exports.Y = …` only and one frozen string LIST; (c) the FUNCTION_TARGET isolated-entry branch. Everything
// else touching exports / module / a module-level this is UNCLASSIFIED. Each case below runs in its OWN directory (no shared
// require cache, one variable per case). Run: node contract/discovery-computed.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./discovery');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const dirs = [];

// endpoint-shaped values only (classifyRuntime reads __endpoint), so the fixture needs no firebase-functions install
const M_SRC = [
  "const ev = (t, ref) => ({ __endpoint: { eventTrigger: { eventType: `google.firebase.database.ref.v1.${t}`, eventFilterPathPatterns: { ref } } } });",
  "exports.aHttp = { __endpoint: { httpsTrigger: {} } };",
  "exports.aSched = { __endpoint: { scheduleTrigger: { schedule: 'every 5 minutes' } } };",
  "exports.aDb = ev('created', '/queue/{id}');",
  "exports.notFn = { plain: true };",
  "exports.LIST = Object.freeze(['aHttp', 'aSched', 'aDb', 'notFn']);",
].join('\n');
const REQ = "const M = require('./m');"; const LOOP = 'for (const k of M.LIST) exports[k] = M[k];';
function inv(index, m = M_SRC) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-surface-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'm.js'), m); fs.writeFileSync(path.join(dir, 'x.js'), 'exports.iso = 1;\n'); fs.writeFileSync(path.join(dir, 'index.js'), index);
  return D.sourceInventory(path.join(dir, 'index.js'));
}

// 1 — (b) the loop: every listed name is found, classified by its OWN endpoint
{
  const r = inv(`${REQ} ${LOOP}`);
  const by = (name) => r.entries.filter((e) => e.name === name);
  assert.deepStrictEqual(r.unclassified, [], `🔴 DC-1 the canonical loop leaves nothing unclassified (got ${JSON.stringify(r.unclassified)})`);
  assert.deepStrictEqual(by('aHttp').map((e) => [e.category, e.how, e.via]), [['http', 'reexport', 'LIST']], '🔴 DC-1 a listed http export is discovered');
  assert.deepStrictEqual(by('aSched').map((e) => e.category), ['schedule'], '🔴 DC-1 a listed schedule export is discovered');
  assert.deepStrictEqual(by('aDb').map((e) => [e.category, e.kind, e.ref]), [['db', 'created', 'queue/{id}']], '🔴 DC-1 a listed db trigger keeps its kind + ref');
  assert.deepStrictEqual(by('notFn').map((e) => e.category), ['not-endpoint'], '🔴 DC-1 a listed non-endpoint is classified, not dropped');
  ok('for (const k of B.LIST) exports[k] = B[k] → each listed name discovered and classified (http / schedule / db kind+ref / not-endpoint)');
}

// 2 — the allowlist's other two forms + the live-code allowances, together: clean
{
  const r = inv([REQ, LOOP, 'exports.plain = M.aHttp;', 'function helper() {} module.exports.testOnly = helper;',
    "const S1 = Object.freeze(new Set(['f1'])); if (S1.has(process.env.FUNCTION_TARGET)) { console.log('iso'); module.exports = require('./x'); return; }",
    "const S2 = new Set(['f2']); if (S2.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); return; }",
    'function q() { return this; }'].join('\n'));
  assert.deepStrictEqual(r.unclassified, [], `🔴 DC-2 control: the allowlisted forms are clean (got ${JSON.stringify(r.unclassified)})`);
  assert.deepStrictEqual(r.isolated.map((x) => [x.set, x.module, x.names]), [['S1', './x', ['f1']], ['S2', './x', ['f2']]], '🔴 DC-2 control: both isolated branches listed');
  assert.deepStrictEqual(['plain', 'testOnly'].map((nm) => r.entries.filter((e) => e.name === nm).length), [1, 1], '🔴 DC-2 control: exports.X = B.Y and module.exports.X = … are inventoried');
  ok('control: exports.X = B.Y, module.exports.X = …, both isolated-set spellings and a function-scoped this are clean');
}

// 3 — the REAL index.js
{
  const SDK = require('../payments/sdk/functions');
  const real = D.sourceInventory();
  for (const k of SDK.ENDPOINT_EXPORTS) {
    const hits = real.entries.filter((e) => e.name === k);
    assert.strictEqual(hits.length, 1, `🔴 DC-3 ${k} is discovered once from index.js source`);
    assert.strictEqual(hits[0].category, D.classifyRuntime(SDK[k]).category, `🔴 DC-3 ${k} keeps its endpoint category`);
  }
  assert.deepStrictEqual(real.unclassified, [], `🔴 DC-3 index.js leaves nothing unclassified (got ${JSON.stringify(real.unclassified)})`);
  assert.deepStrictEqual(real.isolated.map((x) => x.set).sort(), ['PHOTOS_TARGETS', 'PORTAL_ISOLATED_TARGETS', 'PORTAL_OPS_TARGETS'], '🔴 DC-3 index.js: the three FUNCTION_TARGET branches are the isolated entries');
  ok(`index.js: all ${SDK.ENDPOINT_EXPORTS.length} ENDPOINT_EXPORTS discovered with their runtime category; 0 unclassified; 3 isolated entries`);
}

// 4 — everything else is UNCLASSIFIED, ONE variable per case, the reason asserted (each guard is killed on its own case)
const CASES = {
  // (b) the loop binding
  'L1 nested loop': [`${REQ} { ${LOOP} }`, /`exports` is used other than/],
  'L2 let loop variable': [`${REQ} for (let k of M.LIST) exports[k] = M[k];`, /`exports` is used other than/],
  'L3 k shadows B': [`${REQ} for (const M of M.LIST) exports[M] = M[M];`, /M is declared 2×/],
  'L4 B shadowed in a function': [`${REQ} function f() { const M = 1; return M; } ${LOOP}`, /M is declared 2×/],
  'L5 B declared with let': [`let M = require('./m'); ${LOOP}`, /is not `const M = require/],
  'L6 B is a require member chain': [`const M = require('./m').self; ${LOOP}`, /is not `const M = require/],
  'L7 Codex r2 #1: an alias of B rewrites the list': [`${REQ} const alias = M; alias.LIST = Object.freeze(['aSched']); ${LOOP}`, /M is referenced outside the allowlisted forms/],
  'L8 B written directly': [`${REQ} M.LIST = Object.freeze(['aSched']); ${LOOP}`, /M is referenced outside the allowlisted forms/],
  'L9 B read computed outside the loop': [`${REQ} ${LOOP} exports.z = M['aHttp'];`, /M is referenced outside the allowlisted forms/],
  // (b) ./m's surface
  'M1 Codex r2 #2: Object.assign(exports, { LIST }) in ./m': [`${REQ} ${LOOP}`, /m L\d+: `exports` is used other than/, `${M_SRC}\nObject.assign(exports, { LIST: Object.freeze(['aSched']) });`],
  'M2 ./m list not frozen': [`${REQ} ${LOOP}`, /is not Object\.freeze/, M_SRC.replace("Object.freeze(['aHttp', 'aSched', 'aDb', 'notFn'])", "['aHttp', 'aSched', 'aDb', 'notFn']")],
  'M3 ./m assigns the list twice': [`${REQ} ${LOOP}`, /assigns exports\.LIST 2×/, `${M_SRC}\nexports.LIST = Object.freeze(['aHttp']);`],
  'M4 ./m list holds a non-literal': [`${REQ} ${LOOP}`, /is not Object\.freeze\(\[<non-empty string literals>\]\)/, M_SRC.replace("['aHttp', 'aSched', 'aDb', 'notFn']", "['aHttp', ev.name]")],
  'M5 ./m list repeats a name': [`${REQ} ${LOOP}`, /repeats a name/, M_SRC.replace("['aHttp', 'aSched', 'aDb', 'notFn']", "['aHttp', 'aHttp']")],
  'M6 ./m uses module': [`${REQ} ${LOOP}`, /`module` is used/, `${M_SRC}\nmodule.exports.extra = 1;`],
  'M7 ./m has a module-level this': [`${REQ} ${LOOP}`, /module-level `this`/, `${M_SRC}\nthis.extra = 1;`],
  'M8 ./m lists a name it does not export': [`${REQ} ${LOOP}`, /names ghost, not exported/, M_SRC.replace("'notFn']", "'notFn', 'ghost']")],
  'M9 ./m redeclares exports': [`${REQ} ${LOOP}`, /redeclares `exports`/, `${M_SRC}\nfunction h(exports) { return exports; }`],
  // (c) the isolated-entry branch
  'I1 Codex r2 #3: new Set([undefined])': ["const S = new Set([undefined]); if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); return; }", /is not `const S = new Set/],
  'I2 the set declared with let': ["let S = new Set(['f']); if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); return; }", /is not `const S = new Set/],
  'I3 the set referenced elsewhere': ["const S = new Set(['f']); S.add(undefined); if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); return; }", /S is referenced outside its FUNCTION_TARGET test/],
  'I4 the set shadowed': ["const S = new Set(['f']); function g(S) { return S; } if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); return; }", /S is declared 2×/],
  'I5 a branch on another variable': ["const S = new Set(['f']); if (S.has(process.env.OTHER)) { module.exports = require('./x'); return; }", /`module` is used other than/],
  'I6 the branch falls through': ["const S = new Set(['f']); if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); console.log('after'); }", /`module` is used other than/],
  'I7 process redeclared': ["const process = { env: { FUNCTION_TARGET: 'f' } }; const S = new Set(['f']); if (S.has(process.env.FUNCTION_TARGET)) { module.exports = require('./x'); return; }", /`process` is redeclared/],
  // (a) and the rest of the surface
  'S1 Object.assign(exports, …)': [`${REQ} Object.assign(exports, M);`, /`exports` is used other than/],
  'S2 module.exports = { ...B }': [`${REQ} module.exports = { ...M };`, /`module` is used other than/],
  'S3 a nested exports.X = …': [`${REQ} if (true) { exports.x = M.aHttp; }`, /`exports` is used other than/],
  'S4 a nested module.exports.X = …': [`${REQ} if (true) { module.exports.x = M.aHttp; }`, /`module` is used other than/],
  'S5 an alias of module': [`${REQ} const mod = module; mod.exports.x = M.aHttp;`, /`module` is used other than/],
  'S6 a module-level this': [`${REQ} this.x = M.aHttp;`, /module-level `this`/],
  'S7 a compound export assignment': [`${REQ} exports.x = M.aHttp; exports.x += '';`, /`exports` is used other than/],
  'S8 exports redeclared': [`${REQ} function h(exports) { return exports; }`, /`exports` is redeclared/],
  'S9 an export name assigned twice': [`${REQ} exports.x = M.aHttp; exports.x = M.aSched;`, /x is exported more than once/],
};
for (const [label, [src, why, m]] of Object.entries(CASES)) {
  const r = inv(src, m);
  assert.ok(r.unclassified.some((u) => why.test(u.why)), `🔴 DC-4 ${label}: UNCLASSIFIED with the named reason (got ${JSON.stringify(r.unclassified)})`);
  assert.strictEqual(r.entries.filter((e) => e.via).length, 0, `🔴 DC-4 ${label}: no name is resolved from a list`);
}
ok(`${Object.keys(CASES).length} non-allowlisted shapes (9 loop binding, 9 ./m surface, 7 isolated branch, 9 export surface; incl. Codex r2 #1–#3) → UNCLASSIFIED, each with its own reason`);

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`discovery computed exports: OK (${n})`);
