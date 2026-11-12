'use strict';
// PLAN-photos-public-bucket-config r5 §3 — the committed photos config: the ONE validator (shared with the predeploy check), the lazy
// guarded loader, and BOTH committed copies (byte-equal; the verified private entry for the deploying project).
// Run: node photos/photos-config.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('./photos-config');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const PROD = 'xpizza-delivery';
const good = () => ({ schema: 1, public_bucket: { [PROD]: '' }, private_bucket: { [PROD]: `${PROD}.firebasestorage.app` } });
const bad = (mut) => { const c = good(); mut(c); return C.validatePhotosConfig(c); };

// 1. the validator
assert.deepStrictEqual(C.validatePhotosConfig(good()), { ok: true }, 'PCFG-VALID');
assert.strictEqual(bad((c) => { c.schema = 2; }).ok, false, 'PCFG-SCHEMA');
assert.strictEqual(bad((c) => { c.extra = 1; }).ok, false, 'PCFG-UNKNOWN-KEY');
assert.strictEqual(bad((c) => { delete c.private_bucket; }).ok, false, 'PCFG-MISSING-MAP');
assert.strictEqual(bad((c) => { c.public_bucket = []; }).ok, false, 'PCFG-MAP-NOT-OBJECT');
assert.strictEqual(bad((c) => { c.private_bucket = { 'Bad_Project': 'tb-priv' }; }).ok, false, 'PCFG-PROJECT-ID');
assert.strictEqual(bad((c) => { c.private_bucket[PROD] = 7; }).ok, false, 'PCFG-NON-STRING');
for (const name of ['gs://tb-priv', 'TB-PRIV', 'tb/priv', 'ab', '-tb-priv', 'tb-priv-']) {
  assert.strictEqual(bad((c) => { c.private_bucket[PROD] = name; }).ok, false, `PCFG-BUCKET-NAME private ${name}`);
  assert.strictEqual(bad((c) => { c.public_bucket[PROD] = name; }).ok, false, `PCFG-BUCKET-NAME public ${name}`);
}
// codex r2 P2: "" is the public NOT-CONFIGURED sentinel (valid), and is INVALID in the private map
assert.strictEqual(C.validatePhotosConfig(good()).ok, true, 'PCFG-PUBLIC-EMPTY-VALID');
assert.strictEqual(bad((c) => { c.private_bucket[PROD] = ''; }).ok, false, 'PCFG-PRIVATE-EMPTY-INVALID');
assert.strictEqual(bad((c) => { c.public_bucket[PROD] = c.private_bucket[PROD]; }).ok, false, 'PCFG-EQUAL-BUCKETS');
ok('validator: schema 1, exactly the two maps, GCP project-id keys, string values, bucket-name shape; public "" valid, private "" invalid; one project\'s public == private refused');

// 2. the loader's guard (missing / unparseable → ok:false, never a throw)
const missing = C.parseLoaded(() => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); });
assert.deepStrictEqual([missing.ok, missing.reason], [false, 'missing'], 'PCFG-LOADER-MISSING');
const garbage = C.parseLoaded(() => { throw new SyntaxError('Unexpected token'); });
assert.deepStrictEqual([garbage.ok, garbage.reason], [false, 'unparseable'], 'PCFG-LOADER-UNPARSEABLE');
assert.strictEqual(C.parseLoaded(() => ({ schema: 9 })).ok, false, 'PCFG-LOADER-INVALID');
const loaded = C.parseLoaded(() => good());
assert.ok(loaded.ok && Object.isFrozen(loaded.config) && Object.isFrozen(loaded.config.private_bucket), 'PCFG-LOADER-FROZEN');
ok('loader guard: a missing file → missing, bad JSON → unparseable, an invalid shape → its reason; a valid config is deep-frozen; nothing throws');

// 3. BOTH committed copies: byte-equal, valid, and the verified private entry for the deploying project (ATOMIC, owner read 2026-11-01)
const canon = fs.readFileSync(path.join(__dirname, '..', '..', 'platform', 'photos.json'));
const bundled = fs.readFileSync(path.join(__dirname, '..', 'platform', 'photos.json'));
assert.ok(canon.equals(bundled), '🔴 PCFG-COPIES-EQUAL platform/photos.json drifted from <repo>/platform/photos.json — run `npm run sync:platform`');
const committed = JSON.parse(bundled.toString('utf8'));
assert.deepStrictEqual(C.validatePhotosConfig(committed), { ok: true }, 'PCFG-COMMITTED-VALID');
assert.strictEqual(committed.private_bucket[PROD], 'xpizza-delivery.firebasestorage.app', '🔴 PCFG-PRIVATE-VERIFIED the committed private bucket is the owner-read storageBucket (decide row 3, 2026-11-01)');
assert.strictEqual(committed.public_bucket[PROD], 'sherpa-delivery-photos', 'PCFG-PUBLIC-NAMED (owner 2026-11-11, PLAN-photos-public-bucket-config §8a step 3: gs://sherpa-delivery-photos exists, GET public / LIST denied)');
const real = C.loadPhotosConfig();
assert.ok(real.ok && real.config.private_bucket[PROD] === committed.private_bucket[PROD], 'PCFG-LOADER-READS-THE-COMMITTED-FILE');
assert.strictEqual(C.loadPhotosConfig(), real, 'PCFG-LOADER-MEMOIZED');
assert.strictEqual(C.CONFIG_PATH, path.join(__dirname, '..', 'platform', 'photos.json'), 'PCFG-PATH (the bundled copy, the file the functions deploy)');
assert.ok(!/process\.env|argv|setConfig|_install|_use[A-Z]/.test(fs.readFileSync(path.join(__dirname, 'photos-config.js'), 'utf8')), '🔴 PCFG-NO-ENV-SEAM the loader reads no env var, argv, setter or installer (codex r5 P2: production is fixed to the committed file)');
ok('committed: both copies byte-equal and valid; private xpizza-delivery = the owner-verified storageBucket; public "" until launch; the loader reads exactly the bundled file, memoized');

console.log(`photos-config: OK (${n})`);
