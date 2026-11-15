// Stats S2 — the "Ventas" page's GATE: the nav, the owner proof, the view switch. Since «Ventas» V3b (PLAN-portal-ventas-draw-r0, the
// owner-approved MOCKUP-portal-rendimiento-ventas-delta under Nav B) the page itself is ventas-tab.js — the tab, «Personalizado» and
// «Más detalle» with «Descargar» — mounted here on #viewventas; everything this file used to draw moved there, with its safety rules
// (assertLive on every request, the CSV allowlist, a 403 refusing the exports) carried over and tested (ventas-tab.test.mjs).
//
// OWNER-ONLY, BY PROVENANCE. The page and its nav exist only after app.js announces a restaurant on
// `portal:restaurant` — and app.js announces only a rid from getMyRestaurants, which lists exactly the
// restaurants in the caller's OWNER index (staff and dispatchers get []). No announcement, no nav, and
// getSalesStats is never called. The server is the authority regardless: getSalesStats answers 403
// not_owner to anyone else, and that answer is a state the tab renders, not a crash.
//
// Kept OUT of app.js on purpose: app.js is the menu editor's state spine (guarded by the AST wiring
// tests); this page shares nothing with it but the two shell events.
import { token } from './auth.js';
import { mountVentasTab, unmountVentasTab } from './ventas-tab.js';

const $ = (id) => document.getElementById(id);

const S = {
  uid: undefined,     // the signed-in person; any change ends every Ventas world
  rid: null,          // set ONLY by portal:restaurant — the owner proof
  name: null,         // the announced restaurant's name (the shipped lede)
  view: 'menu',
};

// ── the gate: nav + view ────────────────────────────────────────────────────────────────────────
function setGate(owner) {
  $('navbiz').classList.toggle('hidden', !owner);
  $('navventas').classList.toggle('hidden', !owner);
  $('mnav').classList.toggle('show', owner);
  if (!owner) showView('menu');
}

function showView(view) {
  if (view === 'ventas' && !S.rid) return;                       // never without the owner proof
  S.view = view;
  const v = view === 'ventas';
  $('viewmenu').classList.toggle('hidden', v);
  $('viewventas').classList.toggle('hidden', !v);
  // the menu editor's review bar belongs to Productos (the mockup has none here); app.js's .show is untouched
  $('app').classList.toggle('vview', v);
  for (const [id, on] of [['navprod', !v], ['navventas', v], ['mnprod', !v], ['mnventas', v]]) {
    const n = $(id);
    n.classList.toggle('on', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  }
  if (v) mount(); else unmountVentasTab();
}
// the page: the tab, for the announced restaurant (the owner proof)
function mount() { mountVentasTab($('viewventas'), { uid: S.uid, rid: S.rid, name: S.name || (($('shopname') && $('shopname').textContent) || ''), token }); }

document.addEventListener('portal:auth', (e) => {
  // EVERY auth event closes the page. A signed-in owner is re-announced right after (portal:signed-in →
  // getMyRestaurants → portal:restaurant); anyone else never is.
  S.uid = e && e.detail ? e.detail.uid : null;
  S.rid = null; S.name = null;
  setGate(false);
  $('viewventas').replaceChildren();
});

document.addEventListener('portal:restaurant', (e) => {
  const rid = e && e.detail ? e.detail.rid : null;
  if (!rid) return;
  if (e.detail.sales === false) return;   // PORTAL-UI 1a §11 A3: Ventas is owner-only in 1a — shell.js says so per page
  S.rid = rid;
  S.name = typeof e.detail.name === 'string' && e.detail.name ? e.detail.name : null;
  setGate(true);
  if (S.view === 'ventas') mount();
});

const navprod = $('navprod');
const navventas = $('navventas');
const mnprod = $('mnprod');
const mnventas = $('mnventas');
navprod.addEventListener('click', () => showView('menu'));
navventas.addEventListener('click', () => showView('ventas'));
mnprod.addEventListener('click', () => showView('menu'));
mnventas.addEventListener('click', () => showView('ventas'));

