'use strict';
// The membership write freeze (PLAN-portal-membership §7.5): team / invite WRITES run only while
// platform_config/membership_writes_enabled is the strict boolean true. Missing, any other value, or a read error → false
// (fail closed). Tiny and dependency-free on purpose: the portal's E1 reads it for nav visibility without pulling team-core.
async function writesEnabled(db) {
  try { return (await db.ref('platform_config/membership_writes_enabled').once('value')).val() === true; } catch (_) { return false; }
}

module.exports = { writesEnabled };
