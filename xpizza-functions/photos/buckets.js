'use strict';
// DISH PHOTOS (codex r1 P1-1) — the ONE source of both bucket names. lib/admin.js initializes the Admin app with databaseURL only, so an
// argument-less bucket call (getStorage().bucket with no name) THROWS in production (storage/invalid-argument); every photo path names its bucket from here
// (photos/buckets.test.js forbids an argument-less bucket call in every photo module and photo tool).
//   PHOTOS_PRIVATE_BUCKET  (non-secret defineString, default '') → else FIREBASE_CONFIG.storageBucket (set in deployed functions) → else
//                          '<projectId>.firebasestorage.app' (the plan's default bucket gs://xpizza-delivery.firebasestorage.app). No project → throws.
//   PHOTOS_PUBLIC_BUCKET   (non-secret defineString, default '' = not configured: no public URL is emitted, a new pid cannot publish)
const { defineString } = require('firebase-functions/params');

const PHOTOS_PRIVATE_BUCKET = defineString('PHOTOS_PRIVATE_BUCKET', { default: '', description: 'Private dish-photo bucket (uploads/drafts); empty = the project default bucket' });
const PHOTOS_PUBLIC_BUCKET = defineString('PHOTOS_PUBLIC_BUCKET', { default: '', description: 'Public dish-photo bucket (A0 runbook); empty = not configured' });

function privateBucketName({ param = () => PHOTOS_PRIVATE_BUCKET.value(), env = process.env } = {}) {
  const v = String(param() || '').trim();
  if (v) return v;
  let cfg = null;
  if (env.FIREBASE_CONFIG) { try { cfg = JSON.parse(env.FIREBASE_CONFIG); } catch (_) { cfg = null; } }
  if (cfg && typeof cfg.storageBucket === 'string' && cfg.storageBucket.trim()) return cfg.storageBucket.trim();
  const project = (cfg && cfg.projectId) || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (typeof project === 'string' && project.trim()) return `${project.trim()}.firebasestorage.app`;
  throw Object.assign(new Error('photos_private_bucket_unknown: no PHOTOS_PRIVATE_BUCKET, storageBucket or project id'), { code: 'photos_private_bucket_unknown' });
}

function publicBucketName({ param = () => PHOTOS_PUBLIC_BUCKET.value() } = {}) {
  const v = String(param() || '').trim();
  return v || null;
}

module.exports = { PHOTOS_PRIVATE_BUCKET, PHOTOS_PUBLIC_BUCKET, privateBucketName, publicBucketName };
