'use strict';
// ---------------------------------------------------------------------------
// Merchant STATS — the per-restaurant CUSTOMER INDEX (PLAN-stats rev 4, §S1.2; codex r2 B, C).
//
// ONE derived artifact per restaurant: hmac → sorted list of that customer's Sale dates, split into a
// FIXED number of shards by hmac prefix. A customer's FIRST date is the head of their list, which is
// what makes new-vs-returning correct for ANY requested period:
//     new in [from, to]       ⇔ first date ∈ [from, to]
//     returning in [from, to] ⇔ first date < from (and they bought inside the period)
//
// IT IS RE-DERIVED, NEVER PATCHED. Each publication (1) removes every re-settled date from EVERY
// customer's list — so a customer who vanished from a rebuilt day (refund, cancellation, phone fixed) is
// removed, under old and new keys alike, by construction; (2) adds the rebuilt days' contributions;
// (3) drops empty lists. There is no incremental "+1" anywhere, so a re-run is idempotent and an early
// refund moves the first date forward instead of leaving a phantom.
//
// SHARDING: 16 shards by the first hex digit of the hmac. Changing SHARD_COUNT = a full rebuild
// (the count is recorded in stats_meta and checked on read).
// ---------------------------------------------------------------------------
const SHARD_COUNT = 16;
const SHARD_IDS = Array.from({ length: SHARD_COUNT }, (_, i) => i.toString(16));

function shardOf(hmac) {
  const c = String(hmac).slice(3, 4);       // 'h1:' + hex
  if (!/^[0-9a-f]$/.test(c)) throw new Error('stats_index_bad_key');
  return c;
}

// shards: { [shardId]: { [hmac]: [dates] } } → one flat Map. Defensive copies throughout.
function flatten(shards) {
  const m = new Map();
  for (const id of Object.keys(shards || {})) {
    const s = shards[id] || {};
    for (const [k, v] of Object.entries(s)) if (Array.isArray(v) && v.length) m.set(k, [...v]);
  }
  return m;
}

function toShards(flat) {
  const out = Object.fromEntries(SHARD_IDS.map((id) => [id, {}]));
  for (const [k, list] of flat) out[shardOf(k)][k] = list;
  return out;
}

/**
 * rederive(currentShards, resettled, contributionsByDate) → new shards.
 *   resettled:           Iterable<date> — EVERY date this publication rewrites (even if now empty)
 *   contributionsByDate: Map<date, Iterable<hmac>> — the customers with a Sale on each rewritten date
 * Throws if a contribution is for a date that is not being re-settled (that would double-count).
 */
function rederive(currentShards, resettled, contributionsByDate) {
  const R = new Set(resettled);
  const flat = flatten(currentShards);
  for (const [k, list] of flat) {
    const kept = list.filter((d) => !R.has(d));
    if (kept.length) flat.set(k, kept); else flat.delete(k);
  }
  for (const [date, keys] of contributionsByDate) {
    if (!R.has(date)) throw new Error(`stats_index_unsettled_contribution: ${date}`);
    for (const k of keys) {
      const list = flat.get(k) || [];
      if (!list.includes(date)) list.push(date);
      flat.set(k, list);
    }
  }
  for (const [k, list] of flat) flat.set(k, [...new Set(list)].sort());
  return toShards(flat);
}

// The IN-MEMORY live overlay: for every live date, the stored membership of that date is REPLACED by
// the live set (removed from every list, then the live customers added). Nothing is written.
// liveByDate: Map<date, Iterable<hmac>>. Returns Map hmac → firstDate (all a read needs).
function firstDatesWithOverlay(shards, liveByDate = new Map()) {
  const L = new Map([...liveByDate].map(([d, keys]) => [d, new Set(keys)]));
  const flat = flatten(shards);
  for (const [d, keys] of L) {
    for (const [k, list] of flat) {
      const kept = list.filter((x) => x !== d);
      if (kept.length) flat.set(k, kept); else flat.delete(k);
    }
    for (const k of keys) flat.set(k, [...(flat.get(k) || []), d]);
  }
  const firsts = new Map();
  for (const [k, list] of flat) if (list.length) firsts.set(k, list.reduce((a, b) => (b < a ? b : a)));
  return firsts;
}

/**
 * New vs returning for a period, from the period's merged per-customer contributions and the first
 * dates. A customer with contributions but no index entry would be an inconsistency between two
 * documents written in ONE transaction — it is counted as `unindexed`, never guessed into a bucket.
 */
function newVsReturning(customers, firsts, from) {
  const r = { distinct: 0, new: { customers: 0, orders: 0, cents: 0 }, returning: { customers: 0, orders: 0, cents: 0 }, unindexed: 0 };
  for (const [k, c] of Object.entries(customers || {})) {
    if (!c || !(c.orders > 0)) continue;
    r.distinct += 1;
    const first = firsts.get(k);
    if (!first) { r.unindexed += 1; continue; }
    const b = first >= from ? r.new : r.returning;
    b.customers += 1; b.orders += c.orders; b.cents += c.cents;
  }
  return r;
}

module.exports = { SHARD_COUNT, SHARD_IDS, shardOf, flatten, toShards, rederive, firstDatesWithOverlay, newVsReturning };
