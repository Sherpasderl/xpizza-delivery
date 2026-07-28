'use strict';
// deleteAccount (H10) + inactivity sweep (H9) pure-map helpers.
const assert = require('assert');
const A = require('./account-lib');
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const UID = 'u_' + 'a'.repeat(24);
const PH = 'deadbeef'.repeat(8);

// ── accountDeleteUpdates ──
{
  const u = A.accountDeleteUpdates(UID, PH);
  assert.deepStrictEqual(u, { [`user_profiles/${UID}`]: null, [`user_orders/${UID}`]: null, [`user_rewards/${UID}`]: null, [`phone_index/${PH}`]: null });
  ok('delete clears profile + user_orders + user_rewards + phone_index (all null, atomic)');
}
// ── Rewards Phase A: deletion purges user_rewards (balances/ledger) but RETAINS the reward_welcome
// tombstone (anti-farm: a delete+re-login must NOT re-earn the welcome). ──
{
  const u = A.accountDeleteUpdates(UID, PH, 1700000000000);
  assert.strictEqual(u[`user_rewards/${UID}`], null); ok('deletion nulls the user_rewards/{uid} subtree root');
  assert.ok(!Object.keys(u).some((k) => k.startsWith('reward_welcome')),
    'must NOT touch reward_welcome — the tombstone stays so welcome is un-farmable across delete');
  ok('deletion does NOT null reward_welcome (welcome tombstone survives → un-farmable)');
}
// ── P3 PII-safety (codex HIGH-3): the EXTENDED history entries (restaurant/status/items[]) are purged
// on deletion UNCHANGED — because the delete nulls the WHOLE user_orders/{uid} SUBTREE ROOT (not a
// field-level path), so every descendant is removed regardless of entry shape. No code change; this is
// the reason P3 kept the user_orders/{uid} path (did NOT re-nest under restaurant). ──
{
  const u = A.accountDeleteUpdates(UID, PH);
  assert.strictEqual(u[`user_orders/${UID}`], null); ok('P3: deletion nulls the user_orders/{uid} SUBTREE ROOT');
  assert.ok(!Object.keys(u).some((k) => k.startsWith(`user_orders/${UID}/`)),
    'must be a subtree-root null, never a field-level path (else a new field could orphan)');
  ok('P3: subtree-root null purges the new restaurant/status/items[] fields — no orphaned order-history PII');
}
{
  const u = A.accountDeleteUpdates(UID, null);
  assert.deepStrictEqual(u, { [`user_profiles/${UID}`]: null, [`user_orders/${UID}`]: null, [`user_rewards/${UID}`]: null });
  ok('delete without phone_hash → 3 nodes (no phone_index key)');
}
{
  // touches ONLY the given uid's namespaces — every key is scoped to UID/PH
  const u = A.accountDeleteUpdates(UID, PH);
  assert.ok(Object.keys(u).every((k) => k.includes(UID) || k.includes(PH)));
  ok('delete touches only the caller uid/phoneHash paths');
}

// ── tombstone (H10 durable deletion): the user-initiated delete stamps deleted_uids ──
{
  const TS = 1700000000000;
  const u = A.accountDeleteUpdates(UID, PH, TS);
  assert.equal(u[`deleted_uids/${UID}`], TS); ok('3-arg delete writes deleted_uids tombstone with the timestamp');
  assert.deepStrictEqual(u, { [`user_profiles/${UID}`]: null, [`user_orders/${UID}`]: null, [`user_rewards/${UID}`]: null, [`phone_index/${PH}`]: null, [`deleted_uids/${UID}`]: TS });
  ok('tombstone delete = 4 nulls + deleted_uids tombstone');
}
{
  // 2-arg (inactivity sweep) NEVER tombstones — avoids unbounded /deleted_uids growth (dormant, no live session)
  const u = A.accountDeleteUpdates(UID, PH);
  assert.ok(!(`deleted_uids/${UID}` in u)); ok('2-arg delete (sweep) writes NO tombstone');
}

// ── pruneUpdates ──
const NOW = 1_700_000_000_000;
const cutoff = NOW - A.INACTIVE_MS;
{
  const stale = { [UID]: { last_login: cutoff - 1, phone_hash: PH } };
  const { updates, count } = A.pruneUpdates(stale, cutoff);
  assert.equal(count, 1);
  assert.deepStrictEqual(updates, { [`user_profiles/${UID}`]: null, [`user_orders/${UID}`]: null, [`user_rewards/${UID}`]: null, [`phone_index/${PH}`]: null });
  assert.ok(!Object.keys(updates).some((k) => k.startsWith('deleted_uids/'))); // sweep never tombstones
  ok('stale profile (last_login < cutoff) pruned with all 4 nodes, no tombstone');
}
{
  const fresh = { [UID]: { last_login: cutoff + 1, phone_hash: PH } };
  const { count } = A.pruneUpdates(fresh, cutoff);
  assert.equal(count, 0); ok('fresh profile (last_login >= cutoff) kept');
}
{
  const boundary = { [UID]: { last_login: cutoff, phone_hash: PH } };
  assert.equal(A.pruneUpdates(boundary, cutoff).count, 0); ok('boundary (last_login == cutoff) NOT pruned (strict <)');
}
{
  // no last_login → falls back to created_at
  const byCreated = { [UID]: { created_at: cutoff - 1, phone_hash: PH } };
  assert.equal(A.pruneUpdates(byCreated, cutoff).count, 1); ok('missing last_login → created_at used');
}
{
  // neither timestamp → never swept (fail-safe against wiping malformed rows)
  const noTs = { [UID]: { phone_hash: PH } };
  assert.equal(A.pruneUpdates(noTs, cutoff).count, 0); ok('no timestamp → never swept (fail-safe)');
}
{
  // stale but no phone_hash → prune profile + user_orders, no phone_index key
  const noHash = { [UID]: { last_login: cutoff - 1 } };
  const { updates, count } = A.pruneUpdates(noHash, cutoff);
  assert.equal(count, 1);
  assert.ok(!Object.keys(updates).some((k) => k.startsWith('phone_index/')));
  ok('stale without phone_hash → no phone_index null');
}
{
  // mixed batch: only the stale ones counted
  const batch = {
    u_stale1: { last_login: cutoff - 100, phone_hash: 'h1' },
    u_fresh1: { last_login: cutoff + 100, phone_hash: 'h2' },
    u_stale2: { created_at: cutoff - 100 },
  };
  const { count } = A.pruneUpdates(batch, cutoff);
  assert.equal(count, 2); ok('mixed batch → only stale profiles selected');
}

console.log(`account-lifecycle: OK (${n})`);
