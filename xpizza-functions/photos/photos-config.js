'use strict';
// PLAN-photos-public-bucket-config r5 §3 — the committed photos config (platform/photos.json, bundled byte-identical from
// <repo>/platform/photos.json by tools/sync-platform.js). LAZY and GUARDED: importing this module touches no file; the first
// loadPhotosConfig() reads the bundled copy through require() inside try/catch and memoizes the result per process. A missing or
// unparseable file, or an invalid shape, is { ok: false, reason } — never a throw (unlike platform-manifest.js, whose throwing
// import is deliberate for sites.json). There is NO injectable reader, setter or installer: production reads exactly CONFIG_PATH.
// validatePhotosConfig is the ONE validator, shared with the predeploy check (tools/platform-photos-check.js).
//   { "schema": 1,
//     "public_bucket":  { "<projectId>": "<bucket>" | "" },   "" = not configured (no public URL; a pid cannot publish)
//     "private_bucket": { "<projectId>": "<bucket>" } }      non-empty, always explicit (no default, no guess)
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'platform', 'photos.json');
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;          // a GCP project id
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;      // a GCS bucket name (lowercase; no gs://, no '/')
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// → { ok: true } | { ok: false, reason }
function validatePhotosConfig(c) {
  if (!isMap(c)) return { ok: false, reason: 'not_an_object' };
  if (c.schema !== 1) return { ok: false, reason: 'schema_not_1' };
  for (const k of Object.keys(c)) if (!['schema', 'public_bucket', 'private_bucket'].includes(k)) return { ok: false, reason: `unknown_key:${k}` };
  for (const m of ['public_bucket', 'private_bucket']) {
    if (!isMap(c[m])) return { ok: false, reason: `${m}_not_a_map` };
    for (const [project, name] of Object.entries(c[m])) {
      if (!PROJECT_RE.test(project)) return { ok: false, reason: `${m}_bad_project_id` };
      if (typeof name !== 'string') return { ok: false, reason: `${m}_value_not_a_string` };
      if (m === 'public_bucket' && name === '') continue;   // the explicit not-configured sentinel (codex r2 P2)
      if (!BUCKET_RE.test(name)) return { ok: false, reason: `${m}_invalid_bucket_name` };
    }
  }
  for (const [project, pub] of Object.entries(c.public_bucket)) {
    if (pub && Object.prototype.hasOwnProperty.call(c.private_bucket, project) && c.private_bucket[project] === pub) return { ok: false, reason: 'public_equals_private' };
  }
  return { ok: true };
}

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

// the guard around a read: → { ok: true, config } | { ok: false, reason } (exported for its own tests; production passes the require)
function parseLoaded(read) {
  let raw;
  try { raw = read(); } catch (e) { return { ok: false, reason: e && e.code === 'MODULE_NOT_FOUND' ? 'missing' : 'unparseable' }; }
  const v = validatePhotosConfig(raw);
  return v.ok ? { ok: true, config: deepFreeze(JSON.parse(JSON.stringify(raw))) } : v;
}

let memo = null;
function loadPhotosConfig() {
  if (!memo) memo = parseLoaded(() => require('../platform/photos.json'));
  return memo;
}

module.exports = { CONFIG_PATH, validatePhotosConfig, parseLoaded, loadPhotosConfig, BUCKET_RE, PROJECT_RE };
