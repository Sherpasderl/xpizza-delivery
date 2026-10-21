// PLAN-portal-team-invites T-c — the /aceptar page's REAL wiring: the Firebase SDK (the portal's one app, ./firebase.js) and the
// three team endpoints. All decisions live in aceptar.js (tested with these exact seams stubbed). The bearer token goes in a
// header, never the URL; the invite id travels in the POST body.
import { isSignInWithEmailLink, signInWithEmailLink, signOut, updatePassword, sendPasswordResetEmail, getIdToken, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { auth } from './firebase.js';
import { startAceptar } from './aceptar.js';

const BASE = 'https://us-central1-xpizza-delivery.cloudfunctions.net';
// every platform-function call goes through the self-update client when it is loaded (pselfupdate-wrapper-lint), as api.js does
function sherpaFetch(u, o) { const S = (typeof window !== 'undefined') ? window.SherpaClient : null; return (S && typeof S.fetch === 'function') ? S.fetch(u, o) : fetch(u, o); }
auth.languageCode = 'es';

async function call(fn, body, withToken) {   // withToken: false | true (the current user) | a captured user object
  const headers = { 'Content-Type': 'application/json' };
  if (withToken) {
    const who = withToken === true ? auth.currentUser : withToken;
    const t = who ? await getIdToken(who) : null;
    if (!t) { const e = new Error('not_signed_in'); e.status = 401; throw e; }
    headers.Authorization = `Bearer ${t}`;
  }
  let res;
  try { res = await sherpaFetch(`${BASE}/${fn}`, { method: 'POST', headers, body: JSON.stringify(body || {}) }); }
  catch (_) { const e = new Error('network'); e.status = 0; throw e; }
  let json = null; try { json = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, json };
}

startAceptar({
  doc: document,
  href: window.location.href,
  history: window.history,
  goPortal: () => window.location.assign('./'),
  auth: {
    ready: () => new Promise((resolve) => { const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); }); }),
    isLink: (href) => isSignInWithEmailLink(auth, href),
    signInWithLink: (email, href) => signInWithEmailLink(auth, email, href),
    signOut: () => signOut(auth),
    // only ever the ACCEPTING user object captured at acceptance, and only while it is still the signed-in one
    updatePassword: (pw, user) => { const u = auth.currentUser; if (!user || !u || u.uid !== user.uid) { const e = new Error('account_changed'); e.code = 'account_changed'; return Promise.reject(e); } return updatePassword(user, pw); },
    sendReset: (email) => sendPasswordResetEmail(auth, email, { url: new URL('./', window.location.href).href }),   // the reset continues to the portal
    email: () => (auth.currentUser && auth.currentUser.email) || '',
    uid: () => (auth.currentUser && auth.currentUser.uid) || null,
    user: () => auth.currentUser || null,
    onChange: (cb) => onAuthStateChanged(auth, cb),
  },
  api: {
    async preview(inviteId) {
      const r = await call('memberInvitePreview', { inviteId }, false);
      if (r.status === 200 && r.json) return r.json;
      const e = new Error('preview'); e.status = r.status; throw e;
    },
    async accept(inviteId) {
      const r = await call('memberAcceptInvite', { inviteId, want_display: true }, true);
      if (r.status === 200 && r.json) return r.json;
      return { ok: false, code: (r.json && r.json.error) || 'unavailable' };
    },
    async passwordSet(user) {   // the token is the CAPTURED accepting user's, never "whoever is current"
      const r = await call('memberPasswordSet', {}, user);
      if (r.status !== 200) { const e = new Error('password_set'); e.status = r.status; throw e; }
    },
  },
});
