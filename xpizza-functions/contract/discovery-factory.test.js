'use strict';
// contract/discovery.js — FACTORY-CALL exports (2e 11-01; r3-p0-scheduler D0: whatsappInstanceHealth was invisible to source
// discovery). `exports.X = require('./m').f(…)` is classified by the constructor f RETURNS in ./m; any other shape is UNCLASSIFIED
// with a reason (the p0-scheduler D0 cell fails on a non-empty list). Run: node contract/discovery-factory.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./discovery');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-factory-'));
const w = (f, src) => fs.writeFileSync(path.join(dir, f), src);
w('m.js', [
  "const { onSchedule } = require('firebase-functions/v2/scheduler'); const { onRequest } = require('firebase-functions/v2/https');",
  "function makeSched(d) { return onSchedule({ schedule: 'every 5 minutes' }, async () => {}); }",
  "function makeHttp(d) { return onRequest({}, (q, s) => s.end()); }",                        // MUTANT target: must be http, not schedule
  "const makeArrow = (d) => onSchedule({ schedule: 'every day' }, async () => {});",
  "function makePlain() { return { not: 'an endpoint' }; }",
  "function makeMixed(x) { if (x) return onRequest({}, () => {}); return onSchedule({ schedule: 'x' }, async () => {}); }",
  "function makeNested() { const inner = () => onRequest({}, () => {}); return onSchedule({ schedule: 'y' }, async () => {}); }",   // a nested fn's return is NOT the factory's
  "function makeBothSched(x) { if (x) return onSchedule({ schedule: 'a' }, async () => {}); return onSchedule({ schedule: 'b' }, async () => {}); }",   // every path → onSchedule (OK)
  "function makeFall(x) { if (x) return onSchedule({ schedule: 'a' }, async () => {}); }",   // a path FALLS THROUGH (undefined)
  "function makeRefs(x) { if (x) return onRequest({ ref: '/a' }, () => {}); return onRequest({ ref: '/b' }, () => {}); }",   // same ctor, different refs
  "function realImpl() { return onSchedule({ schedule: 'z' }, async () => {}); }",
  "function notExported() { return onSchedule({ schedule: 'n' }, async () => {}); }",       // same-name trap: NOT exported under that name
  'module.exports = { makeSched, makeHttp, makeArrow, makePlain, makeMixed, makeNested, makeBothSched, makeFall, makeRefs, remapped: realImpl, broken: 42 };',
].join('\n'));
w('index.js', [
  "exports.sched = require('./m').makeSched({ a: 1 });",
  "exports.http = require('./m').makeHttp({});",
  "exports.arrow = require('./m').makeArrow({});",
  "exports.plain = require('./m').makePlain();",
  "exports.mixed = require('./m').makeMixed(true);",
  "exports.nested = require('./m').makeNested();",
  "exports.bothsched = require('./m').makeBothSched(1);",
  "exports.fall = require('./m').makeFall(1);",
  "exports.refs = require('./m').makeRefs(1);",
  "exports.remap = require('./m').remapped();",              // export key «remapped» → realImpl (followed through the binding)
  "exports.notexp = require('./m').notExported();",          // a top-level function by that name exists but is NOT exported
  "exports.broken = require('./m').broken();",               // exported, but not a function
  "exports.missing = require('./m').notThere();",
].join('\n'));

const inv = D.sourceInventory(path.join(dir, 'index.js'));
const by = (nm) => inv.entries.find((e) => e.name === nm);
const un = (nm) => inv.unclassified.find((e) => e.name === nm);

assert.strictEqual(by('sched') && by('sched').category, 'schedule', 'a factory returning onSchedule is a schedule');
assert.strictEqual(by('sched').how, 'factory');
assert.strictEqual(by('arrow') && by('arrow').category, 'schedule', 'an arrow factory is followed too');
assert.strictEqual(by('nested') && by('nested').category, 'schedule', "a nested function's return is not the factory's return");
assert.strictEqual(by('bothsched') && by('bothsched').category, 'schedule', 'every path returning the SAME constructor is classified');
assert.strictEqual(by('remap') && by('remap').category, 'schedule', 'a REMAPPED export (key → another function) is followed through the export binding');
ok('factory exports are classified by the RETURNED constructor, through the EXPORT BINDING (declaration, arrow, remapped key; nested returns ignored; all-paths-same ctor)');

assert.strictEqual(by('http') && by('http').category, 'http', '🔴 MUTANT: a factory returning onRequest must be http, NOT schedule');
assert.notStrictEqual(by('http').category, 'schedule');
ok('MUTANT killed: an onRequest factory is classified http (the category comes from the factory, not from a default)');

const NEG = { plain: /not a constructor call/, mixed: /different constructors/, fall: /fall through/, refs: /different refs/,
  notexp: /not exported/, broken: /does not name a top-level function/, missing: /not exported/ };
for (const [nm, re] of Object.entries(NEG)) {
  assert.ok(!by(nm), `${nm} must not be classified`);
  assert.ok(un(nm) && un(nm).type === 'factory-call' && re.test(un(nm).why), `${nm} is UNCLASSIFIED with the right reason (got ${un(nm) && un(nm).why})`);
}
ok(`FAIL CLOSED — unclassified with a reason: non-ctor, mixed ctors, fallthrough, different refs, unexported same-name function, non-function export, missing export (${Object.keys(NEG).length} negatives)`);

const real = D.sourceInventory();
const wah = real.entries.find((e) => e.name === 'whatsappInstanceHealth');
assert.ok(wah && wah.how === 'factory' && wah.category === 'schedule', 'the real index.js: whatsappInstanceHealth is a schedule (factory makeHealthFunction)');
assert.deepStrictEqual(real.unclassified, [], `the real index.js leaves no export unclassified: ${JSON.stringify(real.unclassified)}`);
ok('the real index.js: whatsappInstanceHealth → schedule via makeHealthFunction; 0 unclassified');

// codex r2 P2 counterexamples — overwritten / spread export surfaces fail closed (each module alone, so its shape is the only variable)
const CX = {
  overwritten: "const { onSchedule } = require('firebase-functions/v2/scheduler');\nfunction otherFactory() { return onSchedule({ schedule: 's' }, async () => {}); }\nmodule.exports = { f: otherFactory };\nmodule.exports = {}; // f no longer exported",
  spread: "const { onSchedule } = require('firebase-functions/v2/scheduler');\nfunction otherFactory() { return onSchedule({ schedule: 's' }, async () => {}); }\nmodule.exports = { f: otherFactory, ...{ f: 42 } };",
  dupkey: "const { onSchedule } = require('firebase-functions/v2/scheduler');\nfunction a() { return onSchedule({ schedule: 's' }, async () => {}); }\nmodule.exports = { f: a, f: 42 };",
  twiceExports: "const { onSchedule } = require('firebase-functions/v2/scheduler');\nfunction a() { return onSchedule({ schedule: 's' }, async () => {}); }\nexports.f = a;\nexports.f = 42;",
  mixedSurface: "const { onSchedule } = require('firebase-functions/v2/scheduler');\nfunction a() { return onSchedule({ schedule: 's' }, async () => {}); }\nexports.f = a;\nmodule.exports = {};",
};
const CXRE = { overwritten: /assigned 2×/, spread: /spread/, dupkey: /repeats a key/, twiceExports: /more than once/, mixedSurface: /reassigned while exports/ };
for (const [nm, src] of Object.entries(CX)) {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), `disc-cx-${nm}-`));
  fs.writeFileSync(path.join(d2, 'm.js'), src); fs.writeFileSync(path.join(d2, 'index.js'), "exports.x = require('./m').f();");
  const iv = D.sourceInventory(path.join(d2, 'index.js'));
  assert.ok(!iv.entries.find((e) => e.name === 'x'), `🔴 ${nm}: an overwritten / spread export must NOT be classified`);
  const u = iv.unclassified.find((e) => e.name === 'x');
  assert.ok(u && CXRE[nm].test(u.why), `${nm}: unclassified with the right reason (got ${u && u.why})`);
  fs.rmSync(d2, { recursive: true, force: true });
}
ok(`FAIL CLOSED on the export SURFACE: module.exports reassigned (codex r2 #1), a spread (codex r2 #2), a repeated key, exports.f twice, module.exports + exports.* mixed (${Object.keys(CX).length} counterexamples)`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\ndiscovery-factory: OK (${n})`);
