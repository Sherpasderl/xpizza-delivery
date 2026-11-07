'use strict';
// DISH PHOTOS (codex r1 P1-1) — the ONE source of both bucket names. lib/admin.js initializes the Admin app with databaseURL only, so an
// argument-less bucket call (getStorage().bucket with no name) THROWS in production (storage/invalid-argument); every photo path names its bucket from here
// (photos/buckets.test.js forbids an argument-less bucket call in every photo module and photo tool).
//   private: no override ('') → FIREBASE_CONFIG.storageBucket (set in deployed functions) → else '<projectId>.firebasestorage.app'
//            (the plan's default bucket gs://xpizza-delivery.firebasestorage.app). No project → throws.
//   public:  '' = not configured (no public URL is emitted, a new pid cannot publish).
// TRAIN BLOCKER (advisor ruling 2026-11-01): these WERE non-secret defineString params (default ''). A valueless param makes the
// functions emulator and the deploy PROMPT on stdin, and firebase-tools then writes .env.<project>, which deploy-dotenv-guard blocks.
// They are removed, BEHAVIOUR-IDENTICAL: the constants below are exactly what the params yielded with no value set (''). The
// committed photos config (PLAN-photos-public-bucket-config) replaces them later. deploy-params.guard.test.js keeps params out.
const PRIVATE_BUCKET_OVERRIDE = '';
const PUBLIC_BUCKET = '';

function privateBucketName({ param = () => PRIVATE_BUCKET_OVERRIDE, env = process.env } = {}) {
  const v = String(param() || '').trim();
  if (v) return v;
  let cfg = null;
  if (env.FIREBASE_CONFIG) { try { cfg = JSON.parse(env.FIREBASE_CONFIG); } catch (_) { cfg = null; } }
  if (cfg && typeof cfg.storageBucket === 'string' && cfg.storageBucket.trim()) return cfg.storageBucket.trim();
  const project = (cfg && cfg.projectId) || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (typeof project === 'string' && project.trim()) return `${project.trim()}.firebasestorage.app`;
  throw Object.assign(new Error('photos_private_bucket_unknown: no private bucket override, storageBucket or project id'), { code: 'photos_private_bucket_unknown' });
}

function publicBucketName({ param = () => PUBLIC_BUCKET } = {}) {
  const v = String(param() || '').trim();
  return v || null;
}

module.exports = { privateBucketName, publicBucketName };
