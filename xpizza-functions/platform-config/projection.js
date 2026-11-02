'use strict';
// CONVERGENCE §1 — the ONE module that names the RTDB projection path restaurants/{rid}/platform_config (the single-writer guard
// enforces it: platform-config-single-writer.guard). The generator WRITES through projectionRef; the reader READS through it.
const { RID_RE } = require('./source');
function projectionRef(db, rid) {
  if (typeof rid !== 'string' || !RID_RE.test(rid)) throw new Error('platform_config: bad restaurant id');
  return db.ref(`restaurants/${rid}/platform_config`);
}
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
module.exports = { projectionRef, canonical };
