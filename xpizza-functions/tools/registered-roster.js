'use strict';
// The operator tools' roster (PLAN-brand-agnostic-convergence §3-E; Codex ba-r3 #11): the REGISTERED restaurants — every
// document id of the `restaurants` collection, active or dark — read through the platform's one registry reader, never a list
// in code. A restaurant is certified BEFORE it is activated (La Musa starts dark), so activeness is not a roster criterion.
// Fail closed: no rid, an unreadable (or slow) registry, or a rid not on the roster refuses.
const { makeFirestoreRegistryReader, sanitize } = require('../catalog/restaurant-registry');

const ROSTER_DEADLINE_MS = 20000;

async function registeredRestaurants(db, { listIds = makeFirestoreRegistryReader(db), deadlineMs = ROSTER_DEADLINE_MS } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('registry_timeout')), deadlineMs); });
  try { return sanitize(await Promise.race([listIds(), timeout])).sort(); } finally { clearTimeout(timer); }
}

async function checkRegistered(db, rid, opts) {
  if (typeof rid !== 'string' || !rid) return { ok: false, reason: 'no_rid' };
  let roster;
  try { roster = await registeredRestaurants(db, opts); } catch (_) { return { ok: false, reason: 'registry_unreadable' }; }
  return roster.includes(rid) ? { ok: true, roster } : { ok: false, reason: 'not_registered', roster };
}

module.exports = { registeredRestaurants, checkRegistered, ROSTER_DEADLINE_MS };
