'use strict';
// Pure helpers for account lifecycle — deleteAccount (H10) + inactivity-aging sweep (H9). No I/O, so the
// exact multi-location delete maps are unit-tested. The handlers in index.js only do auth + RTDB reads,
// then apply these maps in a single atomic `db.ref().update(...)`.

const INACTIVE_MS = 180 * 24 * 3600e3;   // ~6 months of dormancy before an account is aged out (H9)

// The atomic null-map that clears ONE account's three nodes. phoneHash may be absent (legacy profile) —
// then the phone_index entry is left (it will resolve to a re-created profile at the same uid on next login).
function accountDeleteUpdates(uid, phoneHash, tombstoneAt = null) {
  const updates = { [`user_profiles/${uid}`]: null, [`user_orders/${uid}`]: null };
  if (phoneHash) updates[`phone_index/${phoneHash}`] = null;
  // H10 durability: user-initiated deletion writes a server-only tombstone so the still-valid custom-token
  // session can't recreate the profile or re-accrue attribution. The inactivity sweep passes no tombstoneAt
  // (2-arg) — its accounts are 6-month-dormant with no live session, and tombstoning would grow unbounded.
  if (tombstoneAt != null) updates[`deleted_uids/${uid}`] = tombstoneAt;
  return updates;
}

// Given a { uid: profile } snapshot object + a cutoff timestamp, return the atomic null-map for every
// profile whose last activity is strictly older than the cutoff, plus how many were selected. A profile
// with no last_login falls back to created_at; one with neither (0) is never swept (fail-safe).
function pruneUpdates(profiles, cutoff) {
  const updates = {}; let count = 0;
  for (const uid of Object.keys(profiles || {})) {
    const p = profiles[uid] || {};
    const lastActivity = Number(p.last_login || p.created_at || 0);
    if (lastActivity && lastActivity < cutoff) {
      Object.assign(updates, accountDeleteUpdates(uid, p.phone_hash));
      count++;
    }
  }
  return { updates, count };
}

module.exports = { INACTIVE_MS, accountDeleteUpdates, pruneUpdates };
