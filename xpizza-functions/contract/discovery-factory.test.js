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
  'module.exports = { makeSched, makeHttp, makeArrow, makePlain, makeMixed, makeNested };',
].join('\n'));
w('index.js', [
  "exports.sched = require('./m').makeSched({ a: 1 });",
  "exports.http = require('./m').makeHttp({});",
  "exports.arrow = require('./m').makeArrow({});",
  "exports.plain = require('./m').makePlain();",
  "exports.mixed = require('./m').makeMixed(true);",
  "exports.nested = require('./m').makeNested();",
  "exports.missing = require('./m').notThere();",
].join('\n'));

const inv = D.sourceInventory(path.join(dir, 'index.js'));
const by = (nm) => inv.entries.find((e) => e.name === nm);
const un = (nm) => inv.unclassified.find((e) => e.name === nm);

assert.strictEqual(by('sched') && by('sched').category, 'schedule', 'a factory returning onSchedule is a schedule');
assert.strictEqual(by('sched').how, 'factory');
assert.strictEqual(by('arrow') && by('arrow').category, 'schedule', 'an arrow factory is followed too');
assert.strictEqual(by('nested') && by('nested').category, 'schedule', "a nested function's return is not the factory's return");
ok('factory exports are classified by the RETURNED constructor (declaration, arrow; nested returns ignored)');

assert.strictEqual(by('http') && by('http').category, 'http', '🔴 MUTANT: a factory returning onRequest must be http, NOT schedule');
assert.notStrictEqual(by('http').category, 'schedule');
ok('MUTANT killed: an onRequest factory is classified http (the category comes from the factory, not from a default)');

for (const nm of ['plain', 'mixed', 'missing']) {
  assert.ok(!by(nm), `${nm} must not be classified`);
  assert.ok(un(nm) && un(nm).type === 'factory-call' && typeof un(nm).why === 'string' && un(nm).why.length, `${nm} is UNCLASSIFIED with a reason`);
}
ok(`non-constructor / mixed-category / missing factories are UNCLASSIFIED with a reason (${['plain', 'mixed', 'missing'].map((x) => un(x).why).join(' | ')})`);

const real = D.sourceInventory();
const wah = real.entries.find((e) => e.name === 'whatsappInstanceHealth');
assert.ok(wah && wah.how === 'factory' && wah.category === 'schedule', 'the real index.js: whatsappInstanceHealth is a schedule (factory makeHealthFunction)');
assert.deepStrictEqual(real.unclassified, [], `the real index.js leaves no export unclassified: ${JSON.stringify(real.unclassified)}`);
ok('the real index.js: whatsappInstanceHealth → schedule via makeHealthFunction; 0 unclassified');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\ndiscovery-factory: OK (${n})`);
