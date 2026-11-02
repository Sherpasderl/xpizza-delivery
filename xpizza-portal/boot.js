// Portal 2b-2a — the shell's boot script.
// Extracted from an inline <script> so the Content-Security-Policy can forbid inline script
// outright. A page that handles credentials should not be asking for 'unsafe-inline'.
// Task 4 is the gate only: sign in, show the shell, sign out. Loading and rendering the menu is
  // Tasks 5-6. Nothing here decides what a merchant may see — the server does, on every request.
  import { login, logout, watchAuth, authErrorMessage } from './auth.js';
  import './app.js';   // listens for portal:signed-in and resolves the restaurant list
  import './ventas.js';   // Stats S2: the owner-only Ventas page (listens for portal:auth / portal:restaurant)
  import './shell.js';    // PORTAL-UI 1a: discovery + the brand/branch switcher + the branch screens (after ventas.js: its nav handlers run first)
  import './team.js';     // PLAN-portal-team-invites T-b: «Equipo de trabajo», registered on the shell (after shell.js, before the first nav render)
  import './pubreq.js';   // PLAN-portal-team-invites T-d: the owner's publish-request banner + Productos badge, and the manager's «Enviado» toast

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), app = $('app'), err = $('loginerr'), btn = $('loginbtn');

  // PLAN-portal-shell-no-shift R1 + R5 — owner-approved MOCKUP-portal-shell-wait.html, option A: while the session opens, the
  // sign-in card holds with one quiet line instead of the form; the portal is revealed ONCE, on shell.js's `portal:ready`
  // (dispatched when the chrome is rendered, or discovery ended in its empty / error state), already in its final shape.
  // R5: a page that had a session (the hint, set on sign-in and cleared on sign-out) opens in that wait state, so a reload —
  // e.g. a brand switch — never paints the login form before auth answers. A stale hint falls back to the form on sign-out.
  const SESSION_HINT = 'sherpa.portal.session';
  const hint = {
    get() { try { return localStorage.getItem(SESSION_HINT) === '1'; } catch (_) { return false; } },
    set(on) { try { if (on) localStorage.setItem(SESSION_HINT, '1'); else localStorage.removeItem(SESSION_HINT); } catch (_) { /* private mode: no hint, today's form */ } },
  };
  const lede = gate.querySelector('.gatecard .lede');
  const LEDE = lede.textContent;
  const cardWait = (on) => {
    $('loginform').classList.toggle('hidden', on);
    lede.textContent = on ? 'Abriendo tu portal…' : LEDE;
    lede.classList.toggle('wait', on);
    if (on) lede.setAttribute('role', 'status'); else lede.removeAttribute('role');
  };
  let signedIn = false, revealed = false;
  if (hint.get()) cardWait(true);
  document.addEventListener('portal:ready', () => {
    if (!signedIn || revealed) return;
    revealed = true;
    gate.classList.add('hidden');                // one task: the card goes and the finished portal shows
    app.classList.remove('hidden');
  });
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
    signedIn = inn;
    hint.set(inn);
    if (!inn) revealed = false;
    if (!revealed) { gate.classList.remove('hidden'); app.classList.add('hidden'); cardWait(inn); }
    if (inn) {
      showError('');
      $('pass').value = '';                   // do not leave a password sitting in the DOM
      $('whoami').textContent = user.email || user.uid;
      $('avatar').textContent = (user.email || '?').slice(0, 1).toUpperCase();
      document.dispatchEvent(new CustomEvent('portal:signed-in'));   // Task 5 listens for this
    }
  });
