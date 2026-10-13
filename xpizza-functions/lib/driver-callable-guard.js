'use strict';
// S1a (PLAN-S1 §6) — the SHARED hard-stop for driver callables.
//
// Refuses the call when the caller is a DEACTIVATED driver. It checks BOTH:
//   (1) the RTDB marker  /driver_accounts/{uid}/deactivated === true   — catches the intermediate state where
//       phase-2 has written the marker but the Auth disable/revoke has not landed (or is awaiting journal recovery);
//   (2) the Auth session: the user is disabled, OR the token was minted before the account's tokensValidAfterTime
//       (the Admin-SDK equivalent of verifyIdToken(idToken, /*checkRevoked*/ true) — onCall hands us the DECODED
//       token, not the raw string, so revocation is checked against the user record instead of re-verifying).
// Either condition refuses. INERT until S1b first sets a marker / disables a user — in S1a-dark nothing triggers it.
//
// Pure logic with INJECTED deps (db, auth, HttpsError) so it is unit-testable and constructs no Admin app itself.
// S1b's submitDriverProfile wraps this same helper (the coverage guard asserts every driver callable calls it).
async function assertDriverCallerActive(uid, authToken, { db, auth, HttpsError }) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const [deactSnap, user] = await Promise.all([
    db.ref(`driver_accounts/${uid}/deactivated`).once('value'),
    auth.getUser(uid),
  ]);
  if (deactSnap.val() === true) throw new HttpsError('permission-denied', 'Tu cuenta está desactivada.');
  if (user && user.disabled) throw new HttpsError('permission-denied', 'Tu cuenta está desactivada.');
  const validAfterMs = user && user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
  const authTimeMs = authToken && authToken.auth_time ? authToken.auth_time * 1000 : 0;
  if (validAfterMs && authTimeMs && authTimeMs < validAfterMs) {
    throw new HttpsError('permission-denied', 'Sesión expirada, iniciá sesión de nuevo.');
  }
}

module.exports = { assertDriverCallerActive };
