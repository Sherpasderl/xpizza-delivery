'use strict';
// PLAN-photos-public-bucket-config r5 §2 — photos/buckets.js, the ONE source of both bucket names, now over the committed photos config.
//   projectOf: every declaration (explicit CLI project, FIREBASE_CONFIG.projectId, GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT) must agree;
//   private: the committed private_bucket[project], REQUIRED (no FIREBASE_CONFIG fallback, no '<project>.firebasestorage.app' guess),
//            corroborated by FIREBASE_CONFIG.storageBucket when present (different → conflict);
//   public:  public_bucket[project], '' / absent = not configured → null; equal to the private → refused.
// lib/admin initializes with databaseURL only, so an argument-less getStorage().bucket() THROWS — every photo path names its bucket.
// Run: node photos/buckets.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('./buckets');
const C = require('./photos-config');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const P = 'tb-proj-a';
const cfg = (over = {}) => C.parseLoaded(() => ({ schema: 1, public_bucket: { [P]: '' }, private_bucket: { [P]: 'tb-priv' }, ...over }));
const FC = (o) => JSON.stringify(o);
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e && e.code; } };

// projectOf
assert.strictEqual(code(() => B.projectOf({ env: {} })), 'photos_project_unknown', 'BUCKETS-PROJECT-NONE');
assert.strictEqual(B.projectOf({ explicit: P, env: {} }), P, 'BUCKETS-PROJECT-EXPLICIT');
assert.strictEqual(B.projectOf({ env: { GCLOUD_PROJECT: P, FIREBASE_CONFIG: FC({ projectId: P }) } }), P, 'BUCKETS-PROJECT-AGREE');
assert.strictEqual(code(() => B.projectOf({ env: { GCLOUD_PROJECT: P, FIREBASE_CONFIG: FC({ projectId: 'tb-proj-b' }) } })), 'photos_project_conflict', 'BUCKETS-PROJECT-CONFLICT (FIREBASE_CONFIG vs GCLOUD_PROJECT)');
assert.strictEqual(code(() => B.projectOf({ explicit: P, env: { GOOGLE_CLOUD_PROJECT: 'tb-proj-b' } })), 'photos_project_conflict', 'BUCKETS-PROJECT-CONFLICT (explicit vs env)');
assert.strictEqual(code(() => B.projectOf({ env: { FIREBASE_CONFIG: '{not json' } })), 'photos_project_conflict', 'BUCKETS-PROJECT-UNPARSEABLE-FIREBASE-CONFIG');
assert.ok(/GCLOUD_PROJECT/.test((() => { try { B.projectOf({ explicit: P, env: { GCLOUD_PROJECT: 'tb-proj-b' } }); } catch (e) { return e.message; } })()), 'BUCKETS-PROJECT-CONFLICT-NAMES-SOURCES');
ok('projectOf: none → unknown; every declaration must agree (explicit / FIREBASE_CONFIG / GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT) else conflict, naming the sources; unparseable FIREBASE_CONFIG refused');

// private
assert.deepStrictEqual({ ...B.resolveBuckets(cfg(), { explicit: P, env: {} }) }, { project: P, private: 'tb-priv', public: null }, 'BUCKETS-PRIVATE-COMMITTED');
assert.strictEqual(code(() => B.resolveBuckets(cfg({ private_bucket: {} }), { explicit: P, env: {} })), 'photos_private_bucket_unknown', 'BUCKETS-PRIVATE-REQUIRED');
assert.strictEqual(code(() => B.resolveBuckets(cfg({ private_bucket: {} }), { env: { FIREBASE_CONFIG: FC({ projectId: P, storageBucket: 'tb-priv' }) } })), 'photos_private_bucket_unknown', 'BUCKETS-PRIVATE-NO-FIREBASE-CONFIG-FALLBACK');
assert.strictEqual(code(() => B.resolveBuckets(cfg({ private_bucket: {} }), { env: { GCLOUD_PROJECT: P } })), 'photos_private_bucket_unknown', 'BUCKETS-PRIVATE-NO-GUESS');
assert.strictEqual(B.resolveBuckets(cfg(), { env: { FIREBASE_CONFIG: FC({ projectId: P, storageBucket: 'tb-priv' }) } }).private, 'tb-priv', 'BUCKETS-PRIVATE-CORROBORATED');
assert.strictEqual(code(() => B.resolveBuckets(cfg(), { env: { FIREBASE_CONFIG: FC({ projectId: P, storageBucket: 'tb-other' }) } })), 'photos_private_bucket_conflict', 'BUCKETS-PRIVATE-CONFLICT');
assert.strictEqual(code(() => B.resolveBuckets(cfg({ private_bucket: { [P]: '' } }), { explicit: P, env: {} })), 'photos_config_invalid', 'BUCKETS-PRIVATE-EMPTY-INVALID');
assert.strictEqual(code(() => B.resolveBuckets(C.parseLoaded(() => { throw new SyntaxError('x'); }), { explicit: P, env: {} })), 'photos_config_invalid', 'BUCKETS-CONFIG-UNTRUSTWORTHY');
ok('private: the committed key, REQUIRED — absent refused even with FIREBASE_CONFIG.storageBucket or a project (no fallback, no guess); FIREBASE_CONFIG corroborates (different → conflict); "" / an untrustworthy config refused');

// public + separation + unconfigured project
assert.strictEqual(B.resolveBuckets(cfg({ public_bucket: { [P]: 'tb-pub' } }), { explicit: P, env: {} }).public, 'tb-pub', 'BUCKETS-PUBLIC-SET');
assert.strictEqual(B.resolveBuckets(cfg({ public_bucket: {} }), { explicit: P, env: {} }).public, null, 'BUCKETS-PUBLIC-ABSENT-NULL');
assert.strictEqual(B.resolveBuckets(cfg(), { explicit: P, env: {} }).public, null, 'BUCKETS-PUBLIC-EMPTY-NULL');
assert.strictEqual(code(() => B.resolveBuckets(cfg({ public_bucket: { [P]: 'tb-priv' } }), { explicit: P, env: {} })), 'photos_config_invalid', 'BUCKETS-EQUAL-IN-CONFIG');
const unconfigured = 'tb-proj-z';
assert.strictEqual(code(() => B.resolveBuckets(cfg(), { explicit: unconfigured, env: {} })), 'photos_private_bucket_unknown', 'BUCKETS-UNCONFIGURED-PROJECT-PRIVATE-REFUSED');
assert.strictEqual(B.publicOrNull({ explicit: unconfigured, env: {} }, cfg()), null, 'BUCKETS-UNCONFIGURED-PROJECT-PUBLIC-NULL');
ok('public: set → the name; absent / "" → null; public == private refused; an UNCONFIGURED project → private refused, public null');

// the static rule: no photo module (and no photo tool) ever calls .bucket() without a name
const dirs = [['photos', (f) => f.endsWith('.js') && !f.endsWith('.test.js')], ['tools', (f) => /^photos?-.*\.js$/.test(f) && !f.endsWith('.test.js')]];
const offenders = [];
for (const [d, keep] of dirs) for (const f of fs.readdirSync(path.join(__dirname, '..', d)).filter(keep)) {
  if (/\.bucket\(\s*\)/.test(fs.readFileSync(path.join(__dirname, '..', d, f), 'utf8'))) offenders.push(`${d}/${f}`);
}
assert.deepStrictEqual(offenders, [], `🔴 BUCKETS-NO-ARGLESS-BUCKET: ${offenders.join(', ')}`);
ok('no photo module / photo tool calls .bucket() without naming it (an argument-less bucket throws in production)');
console.log(`buckets: OK (${n})`);
