// Portal 2b-2a — the shell's boot script.
// Extracted from an inline <script> so the Content-Security-Policy can forbid inline script
// outright. A page that handles credentials should not be asking for 'unsafe-inline'.
// Task 4 is the gate only: sign in, show the shell, sign out. Loading and rendering the menu is
  // Tasks 5-6. Nothing here decides what a merchant may see — the server does, on every request.
  import { login, logout, watchAuth, authErrorMessage } from './auth.js';
  import './app.js';   // listens for portal:signed-in and resolves the restaurant list

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), app = $('app'), err = $('loginerr'), btn = $('loginbtn');
  const showError = (msg) => { err.textContent = msg; err.classList.toggle('on', !!msg); };

  $('loginform').addEventListener('submit', async (e) => {
    e.preventDefault();                       // never let the password reach the URL
    showError('');
    btn.disabled = true;                      // a second submit while the first is in flight just
    btn.textContent = 'Ingresando…';          // burns an attempt against the rate limiter
    try {
      await login($('email').value.trim(), $('pass').value);
    } catch (e2) {
      // The SDK error is mapped to one of a fixed set of sentences. The raw code never reaches the
      // screen: it is noise to a merchant, and for credential failures it is also an enumeration hint.
      // It IS logged, because an unmapped code is a gap in the map and the only way to see one is to
      // have it recorded somewhere a developer looks.
      console.warn('portal_login_failed', e2 && e2.code);
      showError(authErrorMessage(e2 && e2.code));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Ingresar';
    }
  });

  $('logout').addEventListener('click', () => logout());

  watchAuth((user) => {
    const inn = !!user;
    // EVERY auth transition, sign-in and sign-out alike, carrying who (if anyone) is now signed in.
    // app.js invalidates any in-flight review on this: an acknowledgement is a person's signature and
    // must not survive the person changing.
    document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: user ? user.uid : null } }));
    gate.classList.toggle('hidden', inn);
    app.classList.toggle('hidden', !inn);
    if (inn) {
      showError('');
      $('pass').value = '';                   // do not leave a password sitting in the DOM
      $('whoami').textContent = user.email || user.uid;
      $('avatar').textContent = (user.email || '?').slice(0, 1).toUpperCase();
      document.dispatchEvent(new CustomEvent('portal:signed-in'));   // Task 5 listens for this
    }
  });
