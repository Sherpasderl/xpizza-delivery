'use strict';
// PLAN-3a-capp-member-reads r4 §R2.1 (security, Codex r1 #2) — THE member predicate of the capp's member reads (getMyOrders,
// getMyFavorites, setFavorite, getMyLastTip): the same owner predicate the RTDB rules give a member's own nodes.
//   memberUidOf(db, idToken, verifyIdToken) → { uid } | { status: 401, reason: 'unauthenticated' } | { status: 403, reason: 'deleted' }
//   401: no / bad token; not a customer token; a HANDHELD token (the rules' auth.token.handheld !== true); no uid.
//   403: ANY of the three account tombstones — deleted_uids/{uid} (deletion), user_private/{uid}/deleted_at (deletion), and
//        user_profiles/{uid}/deleting_at (the inactivity sweep's claim, set before its deletion) — read in parallel.
// The two steps are exported too, so a caller that rate-limits by the VERIFIED uid between them (getMyOrders) keeps its order.
// The token arrives in a HEADER only (x-firebase-id-token); the caller passes it in, never from a URL or a body (rule 20).

const UNAUTH = Object.freeze({ status: 401, reason: 'unauthenticated' });
const DELETED = Object.freeze({ status: 403, reason: 'deleted' });

// step 1 — the verified customer uid (never a handheld), or null
async function verifiedMemberUid(idToken, verifyIdToken) {
  if (typeof idToken !== 'string' || !idToken) return null;
  let dec;
  try { dec = await verifyIdToken(idToken); } catch (_) { return null; }
  if (!dec || dec.customer !== true || dec.handheld === true || typeof dec.uid !== 'string' || !dec.uid) return null;
  return dec.uid;
}

// step 2 — any of the three account tombstones present
async function isMemberTombstoned(db, uid) {
  const [gone, priv, claim] = await Promise.all([
    db.ref(`deleted_uids/${uid}`).once('value'),
    db.ref(`user_private/${uid}/deleted_at`).once('value'),
    db.ref(`user_profiles/${uid}/deleting_at`).once('value'),
  ]);
  return gone.exists() || priv.exists() || claim.exists();
}

async function memberUidOf(db, idToken, verifyIdToken) {
  const uid = await verifiedMemberUid(idToken, verifyIdToken);
  if (!uid) return { ...UNAUTH };
  if (await isMemberTombstoned(db, uid)) return { ...DELETED };
  return { uid };
}

module.exports = { memberUidOf, verifiedMemberUid, isMemberTombstoned };
