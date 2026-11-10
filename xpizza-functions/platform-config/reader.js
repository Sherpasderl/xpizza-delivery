'use strict';
// CONVERGENCE §1 — the projection READER (no consumer is switched over yet; rows 2.1+ after step 0).
//   read(db, rid) → { ok:true, fields, source_version, fresh, age_ms } | { ok:false, reason: 'absent' | 'unavailable' }
// MONOTONIC: a fresh read whose source_version is LOWER than the one this instance last accepted is rejected (never a stale
// downgrade) and the last-known-good is used. OUTAGE (rulings B / D): a read error or a malformed projection ⇒ the LAST-KNOWN-GOOD
// within ttlMs of its last FRESH acceptance, then CLOSED ('unavailable'). 'absent' (no projection) is a confident answer — never LKG.
// Each consumer then applies its plan §3-A row: money / fiscal call requireFresh (no LKG); display / WhatsApp accept LKG.
const S = require('./schema');
const { projectionRef } = require('./projection');
const { decodeFields } = require('./rtdb-encoding');   // Codex run 5 P1: the projection is RTDB-encoded (null / [] omitted)

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createPlatformConfigReader({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const lkg = new Map();   // rid → { fields, source_version, at }
  const fromLkg = (rid) => {
    const m = lkg.get(rid);
    if (!m) return { ok: false, reason: 'unavailable' };
    const age = now() - m.at;
    return age <= ttlMs ? { ok: true, fields: m.fields, source_version: m.source_version, fresh: false, age_ms: age } : { ok: false, reason: 'unavailable' };
  };
  async function read(db, rid) {
    let raw;
    try { raw = (await projectionRef(db, rid).once('value')).val(); } catch (_) { return fromLkg(rid); }
    if (raw == null) return { ok: false, reason: 'absent' };
    let fields;
    try {
      if (raw.schema_version !== S.SCHEMA_VERSION || !Number.isSafeInteger(raw.source_version) || raw.source_version < 1) throw new Error('x');
      fields = S.validateFields(decodeFields(raw.fields));
    } catch (_) { return fromLkg(rid); }                                   // malformed ⇒ treated as an outage, never trusted
    const prev = lkg.get(rid);
    if (prev && raw.source_version < prev.source_version) return fromLkg(rid);   // older than accepted ⇒ rejected
    lkg.set(rid, { fields, source_version: raw.source_version, at: now() });
    return { ok: true, fields, source_version: raw.source_version, fresh: true, age_ms: 0 };
  }
  return { read, _lkg: lkg };
}
// the money / fiscal policy: a FRESH value or nothing
const requireFresh = (r) => (r && r.ok && r.fresh ? r : { ok: false, reason: r && r.ok ? 'not_fresh' : (r && r.reason) || 'unavailable' });

module.exports = { createPlatformConfigReader, requireFresh, DEFAULT_TTL_MS };
