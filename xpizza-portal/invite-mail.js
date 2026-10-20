// PLAN-portal-team-invites T-b — the ONE place the portal asks Firebase to email an invite link. Thin by design: team.js decides
// WHEN (only for a live invite in the current generation); this only builds the continue URL and sends. The link opens the
// invitee page (aceptar.html) with ?invite=<id>; the id travels in the URL by design (it is the invite's own 128-bit key), the
// owner's ID token never does. Kept out of auth.js so the view's tests can stub this one module.
import { sendSignInLinkToEmail } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { auth } from './firebase.js';

export function inviteUrl(inviteId, base) {
  const u = new URL('./aceptar.html', base);
  u.searchParams.set('invite', String(inviteId));
  return u.href;
}

export function sendInviteLink(email, inviteId) {
  auth.languageCode = 'es';
  return sendSignInLinkToEmail(auth, email, { url: inviteUrl(inviteId, window.location.href), handleCodeInApp: true });
}
