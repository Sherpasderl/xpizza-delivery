'use strict';
// PLAN-photos-public-bucket-config r5 §4 — the census core: decide() (ONE decision table, one cell per row), the read-only census over a
// fake Firestore (counts + DISTINCT public hosts from stored URLs only — registry paths never give an identity), and decide's plan fed
// through BOTH CLIs' target resolution (codex r3 P2). Run: node tools/photos-config-census-core.test.js
const assert = require('assert');
const { decide, census, parseDeployed, hostOf } = require('./photos-config-census-core');
const { resolveTargets, checkTarget } = require('./photo-create-only-check-core');
const C = require('../photos/photos-config');
const B = require('../photos/buckets');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const S = 'tb-proj.firebasestorage.app';
const none = { counts: { pids: 0, legacy: 0, metaPhotos: 0 }, publicHosts: [] };
const dep = (o = {}) => ({ storageBucket: S, legacyPrivate: false, legacyPublic: false, ...o });

(async () => {
  // the step-1 tokens, parsed exactly as printed
  assert.deepStrictEqual(parseDeployed({ storageBucket: S, legacyPrivate: '<unset>', legacyPublic: '<unset>' }), dep(), 'CENSUS-PARSE-STEP1');
  assert.deepStrictEqual(parseDeployed({ storageBucket: '<absent>', legacyPrivate: '<present:>', legacyPublic: '<present:tb-x>' }), { storageBucket: null, legacyPrivate: true, legacyPublic: true }, 'CENSUS-PARSE-PRESENT-EVEN-EMPTY');
  assert.throws(() => parseDeployed({ storageBucket: S, legacyPrivate: 'maybe', legacyPublic: '<unset>' }), /step-1 token/, 'CENSUS-PARSE-REFUSES-UNKNOWN-TOKEN');
  ok('step-1 tokens: <unset> / <present:…> (empty or not) / <absent> / a bucket name; anything else refused');

  // decide — one cell per table row
  assert.deepStrictEqual(decide({ deployed: dep({ legacyPrivate: true }), census: none }), { stop: true, row: 1, reason: 'legacy_env_present' }, 'CENSUS-ROW1 legacy private present (empty) → STOP');
  assert.deepStrictEqual(decide({ deployed: dep({ legacyPublic: true }), census: none }).row, 1, 'CENSUS-ROW1 legacy public present → STOP');
  assert.deepStrictEqual(decide({ deployed: dep({ storageBucket: null }), census: none }), { stop: true, row: 2, reason: 'storage_bucket_absent' }, 'CENSUS-ROW2 no storageBucket → STOP');
  assert.deepStrictEqual(decide({ deployed: dep(), census: none }), { stop: false, plan: { private_bucket: S, public_bucket: '' }, rows: [3, 4] }, 'CENSUS-ROW3+4 explicit private, public ""');
  assert.deepStrictEqual(decide({ deployed: dep(), census: { ...none, publicHosts: ['tb-pub'] }, committedPublic: 'tb-pub' }), { stop: false, plan: { private_bucket: S, public_bucket: 'tb-pub' }, rows: [3, 5] }, 'CENSUS-ROW5 host = committed public → kept');
  assert.deepStrictEqual(decide({ deployed: dep(), census: { ...none, publicHosts: ['tb-pub'] }, committedPublic: '' }), { stop: true, row: 6, reason: 'public_host_mismatch' }, 'CENSUS-ROW6 a host with public "" → STOP');
  assert.deepStrictEqual(decide({ deployed: dep(), census: { ...none, publicHosts: ['tb-pub'] }, committedPublic: 'tb-other' }).row, 6, 'CENSUS-ROW6 host ≠ committed → STOP');
  assert.deepStrictEqual(decide({ deployed: dep(), census: { ...none, publicHosts: ['tb-pub', 'tb-pub-2'] }, committedPublic: 'tb-pub' }).row, 6, 'CENSUS-ROW6 two hosts → STOP');
  ok('decide: (1) any legacy name present → STOP; (2) no storageBucket → STOP; (3) explicit private = storageBucket; (4) no host → public ""; (5) hosts = committed → kept; (6) a mismatch or two hosts → STOP');

  // census over a fake Firestore: counts, and public hosts ONLY from stored URLs
  const docs = {
    'photo_registry/tb_r1/pids/p1': { state: 'published', paths: ['drafts/tb_r1/p1-card.webp'], generations: { pub_card: '1' } },
    'photo_registry/tb_r1/legacy/h1': { card_url: 'https://storage.googleapis.com/tb-pub/photos/tb_r1/legacy/h1-card.webp' },
    'restaurants/tb_r1/versions/v1/meta/photos': { entries: { k1: { state: 'pid', pid: 'p1', card: 'https://storage.googleapis.com/tb-pub/photos/tb_r1/p1-card.webp', hero: 'https://storage.googleapis.com/tb-pub/photos/tb_r1/p1-hero.webp' }, k2: { state: 'removed' } } },
    'restaurants/tb_r1/meta/source': { not: 'photos' },
  };
  const fakeFs = {
    collection: (c) => ({ listDocuments: async () => [...new Set(Object.keys(docs).filter((k) => k.startsWith(`${c}/`)).map((k) => k.split('/')[1]))].map((id) => ({ id,
      collection: (sub) => ({ get: async () => ({ docs: Object.keys(docs).filter((k) => k.startsWith(`${c}/${id}/${sub}/`) && k.split('/').length === 4).map((k) => ({ id: k.split('/')[3], data: () => docs[k] })) }) }) })) }),
    collectionGroup: (g) => ({ get: async () => ({ docs: Object.keys(docs).filter((k) => k.split('/').slice(-2, -1)[0] === g).map((k) => ({ id: k.split('/').pop(), ref: { path: k }, data: () => docs[k] })) }) }),
  };
  const c = await census(fakeFs);
  assert.deepStrictEqual(c, { counts: { pids: 1, legacy: 1, metaPhotos: 1 }, publicHosts: ['tb-pub'] }, `CENSUS-COUNTS-AND-HOSTS ${JSON.stringify(c)}`);
  assert.strictEqual(hostOf('drafts/tb_r1/p1-card.webp'), null, 'CENSUS-REGISTRY-PATH-NO-IDENTITY (bucket-relative)');
  assert.strictEqual(hostOf('https://example.com/img.png'), null, 'CENSUS-NON-GCS-URL-IGNORED');
  ok('census: pids / legacy / meta-photos counts; DISTINCT public hosts from stored URLs only (registry paths and non-GCS URLs give none; only versions/*/meta/photos counted)');

  // decide's plan → BOTH CLIs' target resolution (the create-only CLI core + the backfill's photoBuckets call)
  const plan = decide({ deployed: dep(), census: none }).plan;
  const loaded = C.parseLoaded(() => ({ schema: 1, public_bucket: { 'tb-proj': plan.public_bucket }, private_bucket: { 'tb-proj': plan.private_bucket } }));
  const t = resolveTargets({ projectId: 'tb-proj', env: {}, loaded });
  assert.deepStrictEqual(t, { privateBucket: S, publicBucket: null, reason: null }, 'CENSUS-PLAN-THROUGH-CREATE-ONLY-CLI');
  assert.ok(/not configured/.test(checkTarget({ bucket: S, ...t }) || ''), 'CENSUS-PLAN-CREATE-ONLY-REFUSES-UNTIL-LAUNCH (documented)');
  assert.deepStrictEqual({ ...B.resolveBuckets(loaded, { explicit: 'tb-proj', env: {} }) }, { project: 'tb-proj', private: S, public: null }, 'CENSUS-PLAN-THROUGH-BACKFILL-RESOLUTION');
  const launched = C.parseLoaded(() => ({ schema: 1, public_bucket: { 'tb-proj': 'tb-pub' }, private_bucket: { 'tb-proj': plan.private_bucket } }));
  const t2 = resolveTargets({ projectId: 'tb-proj', env: {}, loaded: launched });
  assert.strictEqual(checkTarget({ bucket: S, ...t2 }), null, 'CENSUS-PLAN-WITH-PUBLIC-RESOLVES-BOTH');
  ok('decide\'s plan through BOTH CLIs: private resolves (no exit 2); public not configured → the create-only CLI refuses until launch (documented); with a public name both resolve');

  console.log(`photos-config-census-core: OK (${n})`);
})().catch((e) => { console.error('photos-config-census-core: FAILED —', e && e.stack || e); process.exit(1); });
