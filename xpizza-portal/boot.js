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
  // sign-in card holds with one quiet line instead of the form (html.sw-wait; gate-early.js sets it before the first paint on a
  // page that had a session); the portal is revealed ONCE per signed-in interval, on shell.js's `portal:ready`, in its final shape.
  // Codex r1: the card can NEVER be the end state —
  //   • AUTH_DEADLINE_MS (6 s): a stale hint whose auth never answers gives the form back. Auth restores from local storage (no
  //     network), well under a second in every lab run; 6 s ≫ that, and short enough that a signed-out visitor is not left waiting.
  //   • DISCOVERY_DEADLINE_MS (20 s): signed in, discovery never ends (a token / fetch / parse that never settles) → the shell's
  //     retry box via `portal:deadline`; if the shell does not answer, the portal is revealed as it stands. The slowest lab boot
  //     painted at ≈ 3.7 s (Slow 4G + 4× CPU); a cold Cloud Functions start adds seconds — 20 s covers both with margin. There is
  //     no field timing for the portal (no telemetry sink): re-derive both from the A0/A1 trace in the Chrome slot.
  // On reveal, focus moves to a deliberate target (the error box's «Reintentar», else the view heading); back to the form, to the email.
  window.__portalBooted = true;                  // gate-early.js's boot deadline: the module graph did start
  const html = document.documentElement;
  html.classList.remove('sw-fail');              // a late start takes over from the recovery card
  const SESSION_HINT = 'sherpa.portal.session';
  const AUTH_DEADLINE_MS = 6000, DISCOVERY_DEADLINE_MS = 20000;
  const hint = {
    set(on) { try { if (on) localStorage.setItem(SESSION_HINT, '1'); else localStorage.removeItem(SESSION_HINT); } catch (_) { /* private mode: no hint, today's form */ } },
  };
  let signedIn = false, revealed = false, authTimer = null, discoveryTimer = null;
  const stopDeadlines = () => { clearTimeout(authTimer); clearTimeout(discoveryTimer); authTimer = null; discoveryTimer = null; };
  const shownIn = (n) => { for (; n && n.nodeType === 1; n = n.parentElement) if (n.hidden || n.classList.contains('hidden')) return false; return true; };
  function focusPortal() {
    const pick = (sel) => [...app.querySelectorAll(sel)].find(shownIn);
    const t = pick('.errbox button') || pick('.errbox') || pick('h1');
    if (!t) return;
    if (!t.matches('button, a[href], input, select, textarea')) t.setAttribute('tabindex', '-1');
    t.focus();
  }
  function cardWait(on) {
    const was = html.classList.contains('sw-wait');
    html.classList.toggle('sw-wait', on);
    if (was && !on) $('email').focus();          // the form comes back: focus where the merchant types
  }
  function reveal() {
    if (!signedIn || revealed) return;
    revealed = true;
    stopDeadlines();
    gate.classList.add('hidden');                // one task: the card goes and the finished portal shows
    app.classList.remove('hidden');
    html.classList.remove('sw-wait');            // the card is gone: no wait state lingers behind the portal
    focusPortal();
  }
  document.addEventListener('portal:ready', reveal);
  if (html.classList.contains('sw-wait')) {
    authTimer = setTimeout(() => { authTimer = null; if (!signedIn && !revealed) cardWait(false); }, AUTH_DEADLINE_MS);
  }

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
    const wasRevealed = revealed;
    signedIn = inn;
    hint.set(inn);
    stopDeadlines();
    if (!inn) revealed = false;
    if (!revealed) {
      gate.classList.remove('hidden'); app.classList.add('hidden'); cardWait(inn);
      if (!inn && wasRevealed) $('email').focus();   // signed out of the portal: back to the form, focused
      if (inn) {
        discoveryTimer = setTimeout(() => {
          discoveryTimer = null;
          if (!signedIn || revealed) return;
          document.dispatchEvent(new CustomEvent('portal:deadline'));   // shell.js answers with its retry box + portal:ready
          reveal();                                                       // …and if nothing answered, the portal as it stands
        }, DISCOVERY_DEADLINE_MS);
      }
    }
    if (inn) {
      showError('');
      $('pass').value = '';                   // do not leave a password sitting in the DOM
      $('whoami').textContent = user.email || user.uid;
      $('avatar').textContent = (user.email || '?').slice(0, 1).toUpperCase();
      document.dispatchEvent(new CustomEvent('portal:signed-in'));   // Task 5 listens for this
    }
  });
