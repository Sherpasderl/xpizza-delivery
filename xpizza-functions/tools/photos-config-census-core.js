'use strict';
// PLAN-photos-public-bucket-config r5 §4 — the photos-config census CORE (pure / over an injected Firestore; the owner CLI is
// tools/photos-config-census.js). READ-ONLY: it counts photo data and lists the DISTINCT public bucket hosts in STORED URLs; registry
// paths are bucket-RELATIVE (photos/process.js, photos/sweep-core.js), so they never give an identity. decide() is the ONE decision table:
//   1 any legacy PHOTOS_* env name present on a deployed photos function (empty or not) → STOP (the code ignores them since bfe87a9e)
//   2 storageBucket absent → STOP (no verified private identity; never guess)
//   3 otherwise → private_bucket = storageBucket, ALWAYS explicit — only if it passes the SHARED bucket validator (codex r1 #3), else STOP
//   4 no public host → public_bucket = '' (until the owner names it at launch)
//   5 every host equals the committed public value → kept
//   6 a host ≠ the committed public value (incl. ''), or more than one host → STOP
const { BUCKET_RE } = require('../photos/photos-config');   // the ONE bucket-name rule (loader + predeploy + this census)
const GCS_URL = /^https:\/\/storage\.googleapis\.com\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\//;
const hostOf = (u) => { const m = typeof u === 'string' ? GCS_URL.exec(u) : null; return m ? m[1] : null; };

// the step-1 tokens exactly as the owner's read prints them
function parseDeployed({ storageBucket, legacyPrivate, legacyPublic }) {
  const legacy = (t, name) => {
    if (t === '<unset>') return false;
    if (typeof t === 'string' && t.startsWith('<present:') && t.endsWith('>')) return true;
    throw new Error(`${name}: not a step-1 token (<unset> | <present:…>)`);
  };
  if (typeof storageBucket !== 'string' || !(storageBucket === '<absent>' || BUCKET_RE.test(storageBucket))) throw new Error('storageBucket: not a step-1 token (exactly <absent> | a valid bucket name)');
  return { storageBucket: storageBucket === '<absent>' ? null : storageBucket, legacyPrivate: legacy(legacyPrivate, 'legacyPrivate'), legacyPublic: legacy(legacyPublic, 'legacyPublic') };
}

function decide({ deployed, census: c, committedPublic = '' }) {
  if (deployed.legacyPrivate || deployed.legacyPublic) return { stop: true, row: 1, reason: 'legacy_env_present' };
  if (!deployed.storageBucket) return { stop: true, row: 2, reason: 'storage_bucket_absent' };
  if (!BUCKET_RE.test(deployed.storageBucket)) return { stop: true, row: 3, reason: 'private_identity_invalid' };
  if (committedPublic !== '' && !BUCKET_RE.test(String(committedPublic))) return { stop: true, row: 5, reason: 'committed_public_invalid' };
  const hosts = c.publicHosts || [];
  if (hosts.some((h) => !BUCKET_RE.test(String(h)))) return { stop: true, row: 6, reason: 'public_host_invalid' };
  if (!hosts.length) return { stop: false, plan: { private_bucket: deployed.storageBucket, public_bucket: committedPublic || '' }, rows: [3, 4] };
  if (hosts.length > 1 || hosts[0] !== committedPublic) return { stop: true, row: 6, reason: 'public_host_mismatch' };
  return { stop: false, plan: { private_bucket: deployed.storageBucket, public_bucket: committedPublic }, rows: [3, 5] };
}

// → { counts: { pids, legacy, metaPhotos }, publicHosts: [sorted distinct] } — reads only
async function census(fs) {
  const counts = { pids: 0, legacy: 0, metaPhotos: 0 };
  const hosts = new Set();
  for (const r of await fs.collection('photo_registry').listDocuments()) {
    counts.pids += (await r.collection('pids').get()).docs.length;
    for (const d of (await r.collection('legacy').get()).docs) { counts.legacy += 1; const h = hostOf((d.data() || {}).card_url); if (h) hosts.add(h); }
  }
  for (const d of (await fs.collectionGroup('meta').get()).docs) {
    if (d.id !== 'photos' || !/^restaurants\/[^/]+\/versions\/[^/]+\/meta\/photos$/.test(d.ref.path)) continue;
    counts.metaPhotos += 1;
    const data = d.data() || {}; const entries = data.entries && typeof data.entries === 'object' ? data.entries : data;
    for (const e of Object.values(entries)) if (e && typeof e === 'object') for (const u of [e.card, e.hero]) { const h = hostOf(u); if (h) hosts.add(h); }
  }
  return { counts, publicHosts: [...hosts].sort() };
}

module.exports = { decide, census, parseDeployed, hostOf };
