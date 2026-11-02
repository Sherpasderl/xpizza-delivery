'use strict';
// CONVERGENCE §1 — the GENERATOR: portal source store → the RTDB projection. It is the projection's ONLY writer.
//   restaurants/{rid}/platform_config = { schema_version, source_version, generated_at, fields }
// ONE RTDB transaction, MONOTONIC (plan §0 sync/version rule): a projection never moves to an OLDER source_version; the same
// version with the same fields is a no-op; the same version with DIFFERENT fields is a conflict (refused — something wrote outside
// the generator); a newer version replaces it whole. The updater never returns undefined (the Admin SDK first-run-on-null rule):
// "no change" returns the raw current value.
const S = require('./schema');
const { readPlatformSource } = require('./source');
const { projectionRef, canonical } = require('./projection');
const { decodeFields } = require('./rtdb-encoding');   // Codex run 5 P1: RTDB drops null / [] — the stored node is DECODED before any compare

function projectionUpdater(next, out) {
  return (raw) => {
    if (raw == null) { out.outcome = 'written'; return next; }
    const v = raw && Number.isSafeInteger(raw.source_version) ? raw.source_version : -1;
    if (v > next.source_version) { out.outcome = 'stale_refused'; return raw; }
    if (v === next.source_version) {
      out.outcome = canonical(decodeFields(raw.fields)) === canonical(next.fields) && raw.schema_version === next.schema_version ? 'unchanged' : 'conflict';
      return raw;
    }
    out.outcome = 'written'; return next;
  };
}

// → { rid, outcome: 'written' | 'unchanged' | 'stale_refused' | 'conflict' | 'no_source', source_version? }
async function generatePlatformConfig({ fs, db, now = Date.now() }, rid) {
  const src = await readPlatformSource(fs, rid);              // a malformed source THROWS — nothing is projected
  if (!src) return { rid, outcome: 'no_source' };
  const next = { schema_version: S.SCHEMA_VERSION, source_version: src.version, generated_at: now, fields: src.fields };   // RTDB itself omits the empty values (rtdb-encoding documents the wire form)
  const out = {};
  await projectionRef(db, rid).transaction(projectionUpdater(next, out));
  return { rid, outcome: out.outcome, source_version: src.version };
}

module.exports = { generatePlatformConfig, projectionUpdater };
