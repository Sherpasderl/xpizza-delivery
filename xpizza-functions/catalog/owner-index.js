'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2b-2a Task 1 — the owner→restaurants REVERSE INDEX.
//
// `restaurants/{rid}/owners/{uid}` answers "is this person the owner of THAT restaurant?", which is all
// the 2b-1 fiscal gate ever needed. The portal asks the opposite question — "which restaurants does
// this person own?" — and RTDB cannot answer that without scanning every restaurant. So a grant writes
// BOTH directions and the reverse index becomes load-bearing: it decides which catalogs a merchant can
// see at all.
//
// BOTH PATHS OR NEITHER. ownerGrantPaths returns a multi-path update object for a single
// `ref().update()`, which RTDB applies atomically. Two separate writes could half-apply, and the
// dangerous half is the reverse index naming a restaurant the forward index does not — a merchant
// listed as owning something they do not own is a tenant-isolation hole, not a cosmetic bug.
//
// THE IDS BUILD PATHS. Both are validated as identifiers before interpolation: a `/` (or any of RTDB's
// forbidden `.`, `#`, `$`, `[`, `]`) would relocate the write, and a write that relocates itself in a
// grant function grants something nobody asked for.
//
// Brand-agnostic by construction — nothing here knows which restaurants exist.
// ---------------------------------------------------------------------------

// Same shape the 2a restaurant registry accepts, so a merchant the platform can onboard is a merchant
// this can grant. Lower-case only: RTDB keys are case-sensitive, and two ids differing only by case
// would be two restaurants that look like one.
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// Firebase Auth uids are alphanumeric; kept deliberately strict because this value is interpolated into
// a path and the only writer is an admin tool, so a rejected exotic uid is a loud failure at grant time
// rather than a silent path anywhere else.
const UID_RE = /^[A-Za-z0-9]{6,128}$/;

const isRid = (v) => typeof v === 'string' && RID_RE.test(v);
const isUid = (v) => typeof v === 'string' && UID_RE.test(v);

// The two paths a grant writes, as ONE update object.
function ownerGrantPaths(rid, uid) {
  if (!isRid(rid)) throw new Error(`bad_rid: ${JSON.stringify(rid)} is not a valid restaurant id`);
  if (!isUid(uid)) throw new Error(`bad_uid: ${JSON.stringify(uid)} is not a valid uid`);
  return {
    [`restaurants/${rid}/owners/${uid}`]: true,   // the authorization tier (2b-1 reads this)
    [`owner_restaurants/${uid}/${rid}`]: true,    // the portal's lookup
  };
}

// Which restaurants this uid owns. ONE read.
//
// A failure PROPAGATES rather than returning []. An empty list is a confident answer — it would show a
// merchant a portal with no restaurants, as though theirs had been taken away — and "the lookup is
// down" is a different thing that the caller must be able to turn into a 503.
async function readOwnerRestaurants(db, uid) {
  if (!isUid(uid)) return [];                       // never build a path from an unvalidated uid
  const snap = await db.ref(`owner_restaurants/${uid}`).get();
  const val = (snap && snap.val()) || {};
  // Exactly `true`, and a structurally valid rid. Anything else — a revoked `false`, a stray number, a
  // malformed key from a hand-edit — is a value nobody deliberately granted and confers nothing.
  return Object.keys(val).filter((rid) => val[rid] === true && isRid(rid));
}

module.exports = { ownerGrantPaths, readOwnerRestaurants, RID_RE, UID_RE };
