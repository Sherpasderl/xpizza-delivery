'use strict';
// CONVERGENCE §1 — the DRIFT check (read-only): does the projection equal a fresh generation from the current portal source?
//   → { rid, state: 'in_sync' | 'not_projected' | 'behind' | 'drift' | 'orphan_projection' | 'unconfigured' | 'source_invalid' }
// Names and states only — no field value is ever printed (the tool prints this object).
const { readPlatformSource } = require('./source');
const { projectionRef, canonical } = require('./projection');

async function checkDrift({ fs, db }, rid) {
  let src;
  try { src = await readPlatformSource(fs, rid); } catch (_) { return { rid, state: 'source_invalid' }; }
  const proj = (await projectionRef(db, rid).once('value')).val();
  if (!src) return { rid, state: proj == null ? 'unconfigured' : 'orphan_projection' };
  if (proj == null) return { rid, state: 'not_projected' };
  if (!Number.isSafeInteger(proj.source_version) || proj.source_version > src.version) return { rid, state: 'drift' };
  if (proj.source_version < src.version) return { rid, state: 'behind' };
  return { rid, state: canonical(proj.fields) === canonical(src.fields) ? 'in_sync' : 'drift' };
}

module.exports = { checkDrift };
