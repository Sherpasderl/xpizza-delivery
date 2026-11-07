'use strict';
// ORCHESTRATION O1a — the slice's INVERSE: its exact hunks in modules older slices PIN byte-for-byte
// (d12-wiring: scheduled-release-core.js vs ebc8564, through the brand-server / H0 / D12b / D12 inverses). The newest inverse is
// applied INNERMOST (first), so any byte outside these hunks still fails those pins. A file this slice did not touch passes
// through unchanged. Generated from the O1a diff; scheduled-inactive-hold.test.js compiles the result as the BASE module.
const HUNKS = Object.freeze([
 {
  "file": "scheduled-release-core.js",
  "now": "// ORCHESTRATION O1a §5 — the claim rollback the pause hold and the inactive hold SHARE (releasing → scheduled, ownership cleared)\nconst rollbackClaim = (db, orderId, extra) => db.ref(`orders/${orderId}`).update({ status: S.SCHEDULED, release_claim_id: null, releasing_since: null, ...extra });\n\n",
  "was": ""
 },
 {
  "file": "scheduled-release-core.js",
  "now": "      await rollbackClaim(db, orderId, keep ? {} : { control_held: { at: now, cause: hold.cause } });\n      return { released: false, blocked: false, held: true, cause: hold.cause };\n    }\n  }\n  // ORCHESTRATION O1a §5 — INACTIVE hold, after the pause return and before the hours check; ONLY on identity.active === false\n  // (absent / malformed / unreadable → today's path). One create-only dispatcher alert; the next sweep retries.\n  let active;\n  try { active = (await db.ref(`restaurants/${rid}/identity/active`).once('value')).val(); } catch (_) { active = undefined; }\n  if (active === false) {\n    await rollbackClaim(db, orderId, {});\n    try {\n      await db.ref(`dispatcher_alerts/scheduled_inactive_${orderId}`).transaction((cur) => (cur == null ? { type: 'scheduled_inactive', order_id: orderId, restaurant_id: rid, created_at: now } : undefined));\n    } catch (e) { console.error(`scheduled_inactive alert failed for ${orderId}`, e && e.message); }   // the hold stands; the next sweep re-alerts\n    return { released: false, blocked: false, held: true, cause: 'inactive' };\n",
  "was": "      await db.ref(`orders/${orderId}`).update({\n        status: S.SCHEDULED, release_claim_id: null, releasing_since: null,\n        ...(keep ? {} : { control_held: { at: now, cause: hold.cause } }),\n      });\n      return { released: false, blocked: false, held: true, cause: hold.cause };\n    }\n"
 }
]);
function unapplyOrchO1aModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`orch-o1a-inverse: ${file}: an O1a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyOrchO1aModule };
