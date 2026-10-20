'use strict';
// PLAN-portal-team-invites r2 (codex plan r2 P1-2) — whether a portal account has CREATED its password. Firebase reports the
// provider id 'password' for email-link accounts too, so the client can never infer it: the server records it.
//   portal_accounts/{uid} = { password_set: true, at }   (Admin-only: the database default-denies unlisted nodes)
// Written by the /aceptar A2 stage (memberPasswordSet, the caller's OWN flag only) and by the cutover backfill for the census
// owners (they sign in with a password today). Read back in the acceptance response so A2 is skipped only when it is true.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function passwordSet(db, uid) {
  const v = (await db.ref(`portal_accounts/${uid}`).once('value')).val();
  return isObj(v) && v.password_set === true;
}
async function markPasswordSet(db, uid, at) {
  await db.ref(`portal_accounts/${uid}`).transaction((cur) => (isObj(cur) && cur.password_set === true ? undefined : { password_set: true, at }));
}

module.exports = { passwordSet, markPasswordSet };
