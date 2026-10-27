// Customer app — PLAN-capp-signin-required r5.4 §4c (Codex r6): the RETURNING-DEVICE marker. Pure, UMD, brand-agnostic. DARK.
//
//   What it is: a LOCAL note that THIS device had a signed-in account — the full phone in E.164 + an account hint. NEVER a token.
//   It is device-local and never sent anywhere beyond a normal sign-in (where it PRE-FILLS the full number); the UI DISPLAYS only the
//   last 4 digits («Entrá de nuevo · ···· 3344», frame 1c).
//   Lifetime: set at sign-in; KEPT across an ordinary sign-out and a lost session (recognition is the point); cleared ONLY by the
//   explicit «Cerrar sesión y olvidar este teléfono», by account deletion, or by the device's site data being cleared.
//   Every storage access is wrapped: unavailable storage ⇒ no marker ⇒ the plain «Entrá o creá tu cuenta» row.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappDeviceAccount = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'capp:device_account';
  const E164 = /^\+[1-9]\d{6,14}$/;

  function read(storage) {
    let v = null;
    try { const s = storage && storage.getItem(KEY); v = s ? JSON.parse(s) : null; } catch (_) { v = null; }
    if (!v || typeof v !== 'object' || v.v !== 1 || v.account !== true || typeof v.e164 !== 'string' || !E164.test(v.e164)) return null;
    return { e164: v.e164, last4: v.e164.slice(-4) };
  }
  // at sign-in (the G6 sign-in flow calls it with the verified number); a malformed number is never stored
  function remember(storage, e164) {
    if (typeof e164 !== 'string' || !E164.test(e164)) return false;
    try { const s = JSON.stringify({ v: 1, account: true, e164 }); storage.setItem(KEY, s); return storage.getItem(KEY) === s; } catch (_) { return false; }
  }
  // ONLY «Cerrar sesión y olvidar este teléfono» / account deletion — an ordinary sign-out never calls this
  function forget(storage) { try { storage.removeItem(KEY); return storage.getItem(KEY) === null; } catch (_) { return false; } }

  // ── the MEMBER PROFILE cache (advisor 2026-10-27): the signed-in member's own name / phone / email, so a session the Auth SDK
  // RESTORES (it carries only a uid) autofills at once — cached-first; getMyProfile revalidates at checkout entry once it exists.
  // Bound to the uid (another member's is never used); written at sign-in / completion; cleared by an ORDINARY sign-out too (unlike
  // the marker above: it holds personal data, and a signed-out device shows none of it).
  const PROFILE_KEY = 'capp:member_profile';
  function readProfile(storage, uid) {
    let v = null;
    try { const s = storage && storage.getItem(PROFILE_KEY); v = s ? JSON.parse(s) : null; } catch (_) { v = null; }
    if (!v || typeof v !== 'object' || v.v !== 1 || typeof v.uid !== 'string' || !v.uid || v.uid !== uid) return null;
    const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
    return { uid: v.uid, name: str(v.name, 80), phone: typeof v.phone === 'string' && E164.test(v.phone) ? v.phone : '', email: str(v.email, 254) };
  }
  function rememberProfile(storage, p) {
    if (!p || typeof p.uid !== 'string' || !p.uid) return false;
    try { storage.setItem(PROFILE_KEY, JSON.stringify({ v: 1, uid: p.uid, name: p.name || '', phone: E164.test(p.phone || '') ? p.phone : '', email: p.email || '' })); return true; } catch (_) { return false; }
  }
  function forgetProfile(storage) { try { storage.removeItem(PROFILE_KEY); return storage.getItem(PROFILE_KEY) === null; } catch (_) { return false; } }

  return { read, remember, forget, KEY, readProfile, rememberProfile, forgetProfile, PROFILE_KEY };
});
