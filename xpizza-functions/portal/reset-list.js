'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1 r5 §6 + §11 A5) — WHICH restaurants the 30-minute availability reset clears, computed
// exactly as the job computes it, so the portal can say truthfully whether a sold-out item clears by itself.
// Two real steps, composed (no extraction — index.js and availability-reset.js are untouched):
//   (a) parse: index.js's resetItemAvailability handler block (JSON only; a throw → undefined), copied with
//       `process.env` → `env` and WITHOUT its console.error (the job's log stays the job's);
//   (b) resolve: availability-reset.js's `Array.isArray(r) && r.length ? r : DEFAULT_RESTAURANTS`, with
//       DEFAULT_RESTAURANTS IMPORTED from its home.
// portal/ops-helpers.guard.test.js compares both pieces with the live source (the exact normalizations of §11 A5) and
// runs every env case through the real runAvailabilityReset.
const { DEFAULT_RESTAURANTS } = require('../availability-reset');

function parseResetEnv(env) {
    let restaurants;
    try {
      const raw = env.AVAILABILITY_RESET_RESTAURANTS;
      const parsed = raw ? JSON.parse(raw) : null;
      restaurants = Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : undefined;
    } catch (e) {
      restaurants = undefined;
    }
    return restaurants;
}

function resolveResetList(r) {
  return Array.isArray(r) && r.length ? r : DEFAULT_RESTAURANTS;
}

const effectiveResetList = (env) => resolveResetList(parseResetEnv(env || {}));

module.exports = { effectiveResetList, parseResetEnv, resolveResetList };
