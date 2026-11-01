'use strict';
// S4 C′ (PLAN-capp-S4-r4 §1.2) — loadSchedule: the ONE schedule-loading boundary for NEW hours consumers (schedule_only now;
// the quote metadata and the S7a directory later). Built ONLY on restaurant-config's getIdentity (fresh-first, warm-cache
// fallback within its TTL, otherwise a retryable 503 that this function lets propagate). The legacy readers L1-L12 do NOT
// use it yet (byte-identical, G1-pinned) — HOURS-ONE-SOURCE migrates them later.
//
// Returns { hours, valid, errors, cfg, source }:
//   valid  — hours7Errors(identity.hours) is empty (the ONE grammar, schedule/hours-grammar.js);
//   hours  — the identity's hours when valid, else null (a new consumer can never act on grammar-invalid hours);
//   cfg    — SCHED.resolveCfg() with NO per-restaurant override: exactly the cfg the intake gate enforces today
//            (both intake handlers call validateScheduledFor without a cfg), so what is served == what is enforced;
//   source — getIdentity's 'fresh' | 'cache'.
const SCHED = require('../scheduled-orders');
const { hours7Errors } = require('./hours-grammar');
const { getIdentity } = require('../restaurant-config');

async function loadSchedule(db, rid, opts = {}) {
  const read = typeof opts.getIdentity === 'function' ? opts.getIdentity : getIdentity;
  const identity = await read(db, rid, opts.now === undefined ? Date.now() : opts.now);   // throws {retryable, statusCode:503}
  const raw = identity && typeof identity === 'object' ? identity.hours : undefined;
  const errors = hours7Errors(raw);
  const valid = errors.length === 0;
  return { hours: valid ? raw : null, valid, errors, cfg: SCHED.resolveCfg(), source: (identity && identity._source) || null };
}

module.exports = { loadSchedule };
