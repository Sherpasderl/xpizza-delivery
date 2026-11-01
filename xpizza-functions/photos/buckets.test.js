'use strict';
// DISH PHOTOS codex r1 P1-1 — photos/buckets.js, the ONE source of both bucket names. lib/admin initializes with databaseURL only, so an
// argument-less getStorage().bucket() THROWS (storage/invalid-argument): every photo path names its bucket from here.
//   privateBucketName()  PHOTOS_PRIVATE_BUCKET param → FIREBASE_CONFIG.storageBucket → '<projectId>.firebasestorage.app'; no project → throws
//   publicBucketName()   PHOTOS_PUBLIC_BUCKET param ('' = not configured → null)
// Run: node photos/buckets.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('./buckets');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

assert.strictEqual(B.privateBucketName({ param: () => 'tb-priv', env: {} }), 'tb-priv', 'BUCKETS-PRIVATE-PARAM-WINS');
assert.strictEqual(B.privateBucketName({ param: () => '', env: { FIREBASE_CONFIG: JSON.stringify({ projectId: 'tb-proj', storageBucket: 'tb-proj.appspot.com' }) } }), 'tb-proj.appspot.com', 'BUCKETS-PRIVATE-FIREBASE-CONFIG');
assert.strictEqual(B.privateBucketName({ param: () => ' ', env: { GCLOUD_PROJECT: 'tb-proj' } }), 'tb-proj.firebasestorage.app', 'BUCKETS-PRIVATE-PROJECT-DEFAULT');
assert.throws(() => B.privateBucketName({ param: () => '', env: {} }), /photos_private_bucket_unknown/, 'BUCKETS-PRIVATE-UNKNOWN-THROWS');
assert.throws(() => B.privateBucketName({ param: () => '', env: { FIREBASE_CONFIG: '{not json' } }), /photos_private_bucket_unknown/, 'BUCKETS-PRIVATE-BAD-CONFIG-THROWS');
assert.strictEqual(B.publicBucketName({ param: () => '' }), null, 'BUCKETS-PUBLIC-UNSET-NULL');
assert.strictEqual(B.publicBucketName({ param: () => ' tb-pub ' }), 'tb-pub', 'BUCKETS-PUBLIC-TRIMMED');
ok('private: param → FIREBASE_CONFIG.storageBucket → <project>.firebasestorage.app (else throws); public: param, \'\' = not configured');

// the static rule: no photo module (and no photo tool) ever calls .bucket() without a name
const dirs = [['photos', (f) => f.endsWith('.js') && !f.endsWith('.test.js')], ['tools', (f) => /^photos-.*\.js$/.test(f) && !f.endsWith('.test.js')]];
const offenders = [];
for (const [d, keep] of dirs) for (const f of fs.readdirSync(path.join(__dirname, '..', d)).filter(keep)) {
  if (/\.bucket\(\s*\)/.test(fs.readFileSync(path.join(__dirname, '..', d, f), 'utf8'))) offenders.push(`${d}/${f}`);
}
assert.deepStrictEqual(offenders, [], `🔴 BUCKETS-NO-ARGLESS-BUCKET: ${offenders.join(', ')}`);
ok('no photo module / photo tool calls .bucket() without naming it (an argument-less bucket throws in production)');
console.log(`buckets: OK (${n})`);
