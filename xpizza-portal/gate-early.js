// PLAN-portal-shell-no-shift R5 + Codex r1 P2 — the gate's FIRST state, before the module graph and before the first paint.
// A classic script in <head> (the CSP allows 'self' scripts, as sherpa-client.js; no inline script). It does two things only:
//   • a page that had a session (boot.js's hint) opens in the wait state (html.sw-wait): a reload never paints the login form;
//   • the boot deadline: if boot.js has not started BOOT_DEADLINE_MS after this ran (a module / CDN load failure), the card
//     shows the portal's outage box (html.sw-fail) with «Reintentar» — never an unwired form, never an endless wait.
// BOOT_DEADLINE_MS = 10 s. There is no field timing for the portal (no telemetry sink); the slowest lab boot is the P2 font
// harness's throttled cell (Slow 4G + 4× CPU): the portal's ~750 KB module graph incl. the Firebase SDK had run and the shell
// painted by ≈ 3.7 s. 10 s ≈ 2.7× that: a slow but working connection is never cut off; a dead one is told within seconds.
(function () {
  var html = document.documentElement;
  try { if (window.localStorage.getItem('sherpa.portal.session') === '1') html.classList.add('sw-wait'); } catch (e) { /* no storage: today's form */ }
  // Codex r2: «Reintentar» is DELEGATED (bound here, before the body exists) — the deadline can fire before the button is parsed
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (html.classList.contains('sw-fail') && t && t.closest && t.closest('#gatefailbtn')) (window.__portalReload || function () { window.location.reload(); })();
  });
  var BOOT_DEADLINE_MS = 10000;
  window.setTimeout(function () {
    if (window.__portalBooted) return;
    // sw-wait is KEPT (a deadline is not a signed-out answer): the fail card wins in CSS, and a late boot.js takes over from
    // the state the page really was in — the wait card for a page with a session, else the form
    html.classList.add('sw-fail');
    var focus = function () { var b = document.getElementById('gatefailbtn'); if (b && html.classList.contains('sw-fail')) b.focus(); };
    if (document.getElementById('gatefailbtn')) focus(); else document.addEventListener('DOMContentLoaded', focus);   // the body may not be parsed yet
  }, BOOT_DEADLINE_MS);
})();
