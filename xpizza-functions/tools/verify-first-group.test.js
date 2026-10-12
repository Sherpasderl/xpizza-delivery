'use strict';
// 1D add-product B — the verify-first-group CLI: the spec files it ships validate (and the NY spec IS plan §4.4's pinned
// first-use data); the spec validator refuses malformed specs; the CLI refuses an inherited project variable and a
// missing/invalid spec BEFORE any client exists. The spawned CLI is pointed at a dead loopback RTDB port with void
// credentials, so even a regression past a guard could never reach a database.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateSpec, readOnly } = require('./verify-first-group-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const load = (f) => JSON.parse(require('fs').readFileSync(path.join(__dirname, 'group-specs', f), 'utf8'));

const NY = load('ny-plain-slice.json');
assert.deepStrictEqual(validateSpec(NY), []); assert.deepStrictEqual(validateSpec(load('la_musa.pad-thai.json')), []);
// plan §4.4 / §9 pinned first-use data
assert.deepStrictEqual(NY, {
  launcher: { name: 'NY Plain Slice', cat: 'ny', desc: 'La clásica NY Plain Slice - 6 slices, queso mozzarella, salsa de tu elección.', extras_policy: 'none' },
  label: 'Salsa',
  choices: [{ choice: 'Salsa Roja', price: 624 }, { choice: 'Salsa Vodka', price: 624 }, { choice: 'Combinada', price: 624, tags: ['recommended'] }],
});
// the owner's 12" decision (PORTAL-ENTRY-plain-slices.md): daily, cat individual, L 299, the same group; no desc pinned
// (the entry note marks the description "suggested; edit freely")
const P12 = load('plain-slice-12.json');
assert.deepStrictEqual(validateSpec(P12), []);
assert.deepStrictEqual(P12, {
  launcher: { name: 'Plain Slice', cat: 'individual', extras_policy: 'none' },
  label: 'Salsa',
  choices: [{ choice: 'Salsa Roja', price: 299 }, { choice: 'Salsa Vodka', price: 299 }, { choice: 'Combinada', price: 299, tags: ['recommended'] }],
});
ok('the shipped specs validate; the NY spec is exactly plan §4.4 / §9\'s pinned first-use data; the 12" spec is the owner\'s entry (daily, individual, L 299)');

const base = () => JSON.parse(JSON.stringify(NY));
const bads = [
  [null, /not an object/], [{ ...base(), label: '' }, /label/], [{ ...base(), label: ' Salsa' }, /label/],
  [{ ...base(), launcher: { name: 'X' } }, /launcher needs/], [{ ...base(), choices: [base().choices[0]] }, /≥ 2/],
  [{ ...base(), choices: [{ choice: 'A', price: 0 }, { choice: 'B', price: 1 }] }, /positive integer price/],
  [{ ...base(), choices: [{ choice: 'A', price: 1 }, { choice: 'A', price: 1 }] }, /repeat/],
  [{ ...base(), choices: [{ choice: 'A', price: 1, tags: 'x' }, { choice: 'B', price: 1 }] }, /tags/],
  [{ ...base(), launcher: { ...base().launcher, price: 1.5 } }, /launcher.price/],
];
for (const [s, re] of bads) assert.ok(validateSpec(s).some((e) => re.test(e)), `refuses ${JSON.stringify(s).slice(0, 80)} → ${re}`);
assert.throws(() => readOnly({ ref: () => ({ set() {} }) }).ref('x').set(1), /read-only/, 'readOnly: a nested write throws');
ok('validateSpec refuses each malformed spec with its reason; readOnly makes a nested write throw');

const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
const CLI = path.join(__dirname, 'verify-first-group.js');
const expected = require('./require-project').expectedProject();
const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
const specArg = ['--rid', 'x_pizza', '--spec', path.join(__dirname, 'group-specs', 'ny-plain-slice.json')];
for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
  const r = run(specArg, { [v]: expected });
  assert.notStrictEqual(r.status, 0, `${v} inherited, no flag → refused`); assert.match(r.stderr, /explicit flag/);
  assert.ok(!/verify-first-group — project|CHECKS/.test(r.stdout), 'nothing read');
}
// with the flag but a bad spec / rid: exit 2, before any client (the mixed-env guard would refuse the dead-port env first,
// so these run WITHOUT the emulator variable — and still never construct a client: usage() exits before initializeApp)
const noEmu = { ...env }; delete noEmu.FIREBASE_DATABASE_EMULATOR_HOST;
const run2 = (args) => spawnSync(process.execPath, [CLI, '--project', expected, ...args], { env: noEmu, encoding: 'utf8', timeout: 20000 });
const missing = run2(['--rid', 'x_pizza', '--spec', '/nonexistent/spec.json']);
assert.strictEqual(missing.status, 2, missing.stderr); assert.match(missing.stderr, /cannot read the spec/);
const badRid = run2(['--rid', '../x', '--spec', specArg[3]]);
assert.strictEqual(badRid.status, 2); assert.match(badRid.stderr, /valid --rid/);
const tmp = path.join(require('os').tmpdir(), `vfg-bad-${process.pid}.json`); require('fs').writeFileSync(tmp, JSON.stringify({ label: '' }));
const invalid = run2(['--rid', 'x_pizza', '--spec', tmp]); require('fs').unlinkSync(tmp);
assert.strictEqual(invalid.status, 2); assert.match(invalid.stderr, /invalid spec/);
ok('the CLI refuses an inherited project variable (explicit-flag), and a missing / invalid spec or a bad rid with exit 2 — before any client exists');

console.log(`\nverify-first-group: OK (${n})`);
