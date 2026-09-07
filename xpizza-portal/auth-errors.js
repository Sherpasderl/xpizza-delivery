// Portal 2b-2a — the login error map, in its own module so it can actually be TESTED.
//
// auth.js imports the Firebase SDK from a CDN URL, which node cannot load; anything worth asserting
// therefore has to live where a test can reach it. This is the only logic on the login screen, and it
// is the one place a login form can leak something it should not.
// ── THE ONE THING WORTH TESTING HERE ────────────────────────────────────────────────────────────
// A login form must not tell an anonymous visitor whether an email address has an account. Firebase
// already merges "no such user" and "wrong password" into auth/invalid-credential — but it still emits
// auth/user-not-found on older SDK paths, and mapping that to its own message would hand back an
// account-enumeration oracle: type an address, learn whether it is a merchant.
//
// So every credential-shaped failure returns the SAME sentence. Only conditions that say nothing about
// whether an account exists — rate limiting, a network failure — get their own message, because those
// change what the person should DO next.
const SAME_FOR_ALL_CREDENTIAL_FAILURES = 'Correo o contraseña incorrectos.';
const MESSAGES = {
  'auth/invalid-credential': SAME_FOR_ALL_CREDENTIAL_FAILURES,
  'auth/user-not-found': SAME_FOR_ALL_CREDENTIAL_FAILURES,
  'auth/wrong-password': SAME_FOR_ALL_CREDENTIAL_FAILURES,
  'auth/invalid-email': SAME_FOR_ALL_CREDENTIAL_FAILURES,
  'auth/user-disabled': 'Esta cuenta está deshabilitada. Escribinos para reactivarla.',
  'auth/too-many-requests': 'Demasiados intentos. Esperá un momento y probá de nuevo.',
  'auth/network-request-failed': 'Sin conexión. Revisá tu internet y probá de nuevo.',
};
export function authErrorMessage(code) {
  return MESSAGES[code] || 'No pudimos iniciar sesión. Probá de nuevo.';
}
