'use strict';
// CONVERGENCE §1 — the PORTAL SOURCE STORE for platform config: Firestore restaurants/{rid}/meta/platform_source
//   { schema_version, version, fields, updated_at, updated_by }   (server-only: firestore.rules meta/* is default-deny)
// writePlatformSource is the ONE shared source writer — whichever authoring surface owner Q1 picks (a Sherpa-admin portal area or an
// owner-run tool) calls it. A compare-and-set on `version` (create ⇔ expectedVersion null), every field validated BEFORE the write,
// version + 1 per accepted write (the projection's monotonic source_version). readPlatformSource validates on the way out too.
const S = require('./schema');
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // platform-manifest RID_RE
const sourceRef = (fs, rid) => {
  if (typeof rid !== 'string' || !RID_RE.test(rid)) throw new Error('platform_source: bad restaurant id');
  return fs.collection('restaurants').doc(rid).collection('meta').doc('platform_source');
};

async function writePlatformSource(fs, rid, fields, { expectedVersion, by, now = Date.now() } = {}) {
  const clean = S.validateFields(fields);                       // throws platform_config_invalid — nothing written
  if (typeof by !== 'string' || !by) throw new Error('platform_source: author required');
  const ref = sourceRef(fs, rid);
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    const curV = cur && Number.isSafeInteger(cur.version) ? cur.version : null;
    if ((expectedVersion ?? null) !== curV) { const e = new Error(`platform_source_conflict: expected ${expectedVersion ?? null}, found ${curV}`); e.code = 'platform_source_conflict'; throw e; }
    const next = { schema_version: S.SCHEMA_VERSION, version: (curV || 0) + 1, fields: clean, updated_at: now, updated_by: by };
    tx.set(ref, next);
    return { version: next.version };
  });
}

// → { rid, version, fields } | null (absent). A present-but-invalid source THROWS (fail-closed).
async function readPlatformSource(fs, rid) {
  const snap = await sourceRef(fs, rid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  if (!d || d.schema_version !== S.SCHEMA_VERSION || !Number.isSafeInteger(d.version) || d.version < 1) { const e = new Error('platform_source_invalid'); e.code = 'platform_config_invalid'; throw e; }
  return { rid, version: d.version, fields: S.validateFields(d.fields) };
}

module.exports = { writePlatformSource, readPlatformSource, sourceRef, RID_RE };
