'use strict';
// DISH PHOTOS (codex r1 P1-1) — the ONE source of both bucket names. lib/admin.js initializes the Admin app with databaseURL only, so an
// argument-less bucket call (getStorage().bucket with no name) THROWS in production (storage/invalid-argument); every photo path names its bucket from here
// (photos/buckets.test.js forbids an argument-less bucket call in every photo module and photo tool).
// PLAN-photos-public-bucket-config r5 §2 — the names come from the COMMITTED photos config (photos/photos-config.js; no param, no dotenv,
// no env var — deploy-params.guard.test.js keeps params out):
//   project  every declaration (the CLIs' explicit project, FIREBASE_CONFIG.projectId, GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT) must agree;
//   private  private_bucket[project], REQUIRED — no FIREBASE_CONFIG fallback and no '<project>.firebasestorage.app' guess any more;
//            FIREBASE_CONFIG.storageBucket, when present, only CORROBORATES (different → photos_private_bucket_conflict);
//   public   public_bucket[project]; '' or absent = not configured → null; equal to the private → refused.
// Every refusal is a typed error thrown at CALL time (never at import or construction): consumers resolve LAZILY, inside photo I/O, so a
// photo-free publish never resolves a bucket (photos/publish-io.js). publicOrNull is the getter for "is a public bucket configured":
// a refusal there degrades to null, which every caller already treats as fail-closed (no public URL; a pid cannot publish).
const { loadPhotosConfig } = require('./photos-config');

const refuse = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code, photosConfig: true });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function firebaseConfig(env) {
  if (!env.FIREBASE_CONFIG) return null;
  try { const c = JSON.parse(env.FIREBASE_CONFIG); return c && typeof c === 'object' ? c : undefined; } catch (_) { return undefined; }
}

// → the project id every declaration agrees on (refusals name the SOURCES, never the values)
function projectOf({ explicit, env = process.env } = {}) {
  const fc = firebaseConfig(env);
  if (fc === undefined) throw refuse('photos_project_conflict', 'FIREBASE_CONFIG is not parseable');
  const found = [];
  if (typeof explicit === 'string' && explicit) found.push(['--project', explicit]);
  if (fc && typeof fc.projectId === 'string' && fc.projectId) found.push(['FIREBASE_CONFIG.projectId', fc.projectId]);
  for (const k of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) if (typeof env[k] === 'string' && env[k]) found.push([k, env[k]]);
  if (!found.length) throw refuse('photos_project_unknown', 'no project is declared');
  if (new Set(found.map(([, v]) => v)).size > 1) throw refuse('photos_project_conflict', `the project declarations disagree (${found.map(([s]) => s).join(', ')})`);
  return found[0][1];
}

// → frozen { project, private, public | null } over a loaded config ({ ok, config } from photos-config), else a typed refusal
function resolveBuckets(loaded, { explicit, env = process.env } = {}) {
  const project = projectOf({ explicit, env });
  if (!loaded || !loaded.ok) throw refuse('photos_config_invalid', `the photos config is not usable (${(loaded && loaded.reason) || 'unknown'})`);
  const c = loaded.config;
  if (!own(c.private_bucket, project)) throw refuse('photos_private_bucket_unknown', `no private bucket is committed for project ${project}`);
  const priv = c.private_bucket[project];
  const fc = firebaseConfig(env);
  if (fc && typeof fc.storageBucket === 'string' && fc.storageBucket && fc.storageBucket !== priv) {
    throw refuse('photos_private_bucket_conflict', 'FIREBASE_CONFIG.storageBucket differs from the committed private bucket');
  }
  const pub = own(c.public_bucket, project) && c.public_bucket[project] ? c.public_bucket[project] : null;
  if (pub && pub === priv) throw refuse('photos_buckets_equal', 'the public and private photo buckets are the same');
  return Object.freeze({ project, private: priv, public: pub });
}

const photoBuckets = (opts = {}) => resolveBuckets(loadPhotosConfig(), opts);

// the public bucket, or null when it is not configured OR the config refuses (logged once per reason) — fail-closed for every caller
const logged = new Set();
function publicOrNull(opts = {}, loaded = loadPhotosConfig()) {
  try { return resolveBuckets(loaded, opts).public; } catch (e) {
    if (e && e.photosConfig) { if (!logged.has(e.code)) { logged.add(e.code); console.error('photos_config_refused', e.code); } return null; }
    throw e;
  }
}

module.exports = { projectOf, resolveBuckets, photoBuckets, publicOrNull };
