'use strict';
// WAHEALTH (WhatsApp gateway health, OWNER-approved 2026-10-22) — the slice's index.js footprint is ONE delimited block at the END of
// index.js, nothing else. Run: node wahealth-wiring.guard.test.js
//   1. unapplyWaHealthIndex(index.js) === e2266b24:index.js byte-for-byte (the parent of the commit that introduced the block, found
//      with git log -S, or HEAD's index.js while the block is still uncommitted); the block is last; non-vacuity.
//   2. Sensitivity: a missing delimiter, a second block and a byte outside are each caught.
//   3. The block holds only comments and ONE export line: exports.whatsappInstanceHealth = instance-health's makeHealthFunction.
//   4. The deployed shape: a v2 scheduled function, every 30 minutes, us-central1, bounded (60 s, 1 instance, no retry).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyWaHealthIndex, BEGIN, END } = require('./tools/wahealth-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const introducing = git(['log', '--format=%H', '-S', BEGIN, '--', 'index.js']).trim().split('\n').filter(Boolean).pop();
const base = introducing ? git(['show', `${introducing}^:xpizza-functions/index.js`]) : git(['show', 'HEAD:xpizza-functions/index.js']);

assert.strictEqual(unapplyWaHealthIndex(real), base, '🔴 index.js minus the wahealth block is not its base index.js — something outside the block changed');
assert.notStrictEqual(unapplyWaHealthIndex(real), real, 'non-vacuity: the block is present');
assert.ok(real.trimEnd().endsWith(END), 'the wahealth block is the LAST thing in index.js');
assert.strictEqual(real.split(BEGIN).length - 1, 1); assert.strictEqual(real.split(END).length - 1, 1);
ok(`unapplyWaHealthIndex(index.js) === its base index.js byte-for-byte (base ${introducing ? `${introducing.slice(0, 8)}^` : 'HEAD'}); the block is last`);

const block = real.slice(real.indexOf(BEGIN), real.indexOf(END) + END.length);
assert.throws(() => unapplyWaHealthIndex(real.replace(BEGIN, '/* wahealth:begn */')), /occurs 0×/);
assert.throws(() => unapplyWaHealthIndex(real.replace(END, '/* wahealth:ed */')), /occurs 0×/);
assert.throws(() => unapplyWaHealthIndex(real + `\n${block}\n`), /occurs 2×/);
const insideBlock = block.replace('registry: restaurantRegistry', 'registry: restaurantRegistrx');
assert.notStrictEqual(insideBlock, block, 'the inside probe edits the block');
assert.throws(() => unapplyWaHealthIndex(real.replace(block, () => insideBlock)), /occurs 0×/, 'a byte INSIDE the block');
const outside = real.replace('exports.merchantPushOnAnswered = merchantPushFunctions.merchantPushOnAnswered;', 'exports.merchantPushOnAnswered = merchantPushFunctions.merchantPushOnAnswered; ');
assert.notStrictEqual(outside, real);
assert.notStrictEqual(unapplyWaHealthIndex(outside), base, 'a byte OUTSIDE the block survives the inverse and fails the base pin');
ok('sensitivity: missing begin, missing end, a second block, a byte inside and a byte outside are each caught');

const lines = block.split('\n').slice(1, -1).filter((l) => !l.startsWith('//'));
assert.deepStrictEqual(lines, ["exports.whatsappInstanceHealth = require('./whatsapp/instance-health').makeHealthFunction({ registry: restaurantRegistry, getDb: getDatabase });"]);
ok('the block is comments + ONE export: whatsappInstanceHealth from whatsapp/instance-health.js, restaurant ids from the registry');

(async () => {
  const fn = require('./whatsapp/instance-health').makeHealthFunction({ registry: () => ({ ready: async () => {}, known: () => new Set() }), getDb: () => null });
  const ep = fn.__endpoint;
  assert.strictEqual(ep.platform, 'gcfv2');
  assert.deepStrictEqual(ep.region, ['us-central1']);
  assert.strictEqual(ep.scheduleTrigger.schedule, 'every 30 minutes'); assert.strictEqual(ep.scheduleTrigger.retryConfig.retryCount, 0);
  assert.strictEqual(ep.timeoutSeconds, 60); assert.strictEqual(ep.maxInstances, 1); assert.strictEqual(ep.availableMemoryMb, 256);
  await fn.run({});   // no restaurants → no HTTP; a null db → the config read fails soft (config_error); must not throw
  const seen = [];
  await require('./whatsapp/instance-health').makeHealthFunction({ registry: () => ({ ready: async () => { seen.push('ready'); }, known: () => { seen.push('known'); return new Set(); } }), getDb: () => null, configTimeoutMs: 20 }).run({});
  assert.deepStrictEqual(seen, ['ready', 'known'], 'the registry is WARMED (ready) before its ids are read — a cold instance still sees a newly-registered merchant');
  ok('deployed shape: v2 scheduled, every 30 minutes, us-central1, 60 s / 1 instance / 256 MiB / no retry; a run with no ids completes; the registry is warmed before known()');
  console.log(`wahealth-wiring.guard: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
