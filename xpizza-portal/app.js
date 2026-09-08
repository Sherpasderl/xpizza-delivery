// Portal 2b-2a Task 5 — orchestration: sign-in → which restaurants → pick one.
//
// Rendering the menu is Task 6; this resolves WHICH restaurant is in view and keeps that choice.
// Nothing here decides what a merchant may see — every answer comes from the server, and the UI simply
// shows what came back.
import { apiFetch } from './api.js';
import { groupByCategory, renderRail, renderDetail } from './render.js';
import { token } from './auth.js';

const $ = (id) => document.getElementById(id);
const REMEMBERED = 'sherpa.portal.rid';

export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null };

export { pickRid, messageFor } from './portal-logic.js';

// DOM plumbing lives here, with the DOM. It was briefly in portal-logic.js — where it was neither
// exported nor reachable, so every call site was a ReferenceError the node tests could not see, because
// they import only the pure module. Built with createElement rather than an HTML string: the portal now
// has NO HTML sink at all, which is a rule a guard can check.
function showEmpty(title, detail) {
  const e = document.createElement('div');
  e.className = 'empty';
  const b = document.createElement('b'); b.textContent = title;
  const s2 = document.createElement('span'); s2.textContent = detail;
  e.append(b, s2);
  $('rail').replaceChildren();
  $('detail').replaceChildren(e);
}
import { pickRid, messageFor } from './portal-logic.js';

function renderSwitcher() {
  const cur = state.restaurants.find((r) => r.rid === state.currentRid);
  $('shopname').textContent = cur ? cur.name : '—';
  const multi = state.restaurants.length > 1;
  $('shopsub').textContent = multi ? `${state.restaurants.length} locales` : (cur ? cur.rid : '');
  // The chevron and the click only mean something when there is more than one restaurant to choose from.
  $('switcher').classList.toggle('multi', multi);
  if (!multi) $('switchmenu').classList.add('hidden');
}

// Built with createElement, never an HTML string — the portal keeps its no-HTML-sink rule even here,
// where the labels come from a server response.
function renderSwitchMenu() {
  const menu = $('switchmenu');
  menu.replaceChildren();
  for (const r of state.restaurants) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'switchmenu-item' + (r.rid === state.currentRid ? ' on' : '');
    const nm = document.createElement('span'); nm.textContent = r.name;
    item.append(nm);
    item.addEventListener('click', () => switchTo(r.rid));
    menu.append(item);
  }
}

function openSwitch(open) {
  const menu = $('switchmenu');
  if (state.restaurants.length <= 1) { menu.classList.add('hidden'); return; }
  const shouldOpen = open === undefined ? menu.classList.contains('hidden') : open;
  if (shouldOpen) { renderSwitchMenu(); menu.classList.remove('hidden'); }
  else menu.classList.add('hidden');
}

// Switching is client-side selection only — the server still re-checks ownership on the getEditableCatalog
// call, so a stale or forged rid loads nothing rather than someone else's menu.
function switchTo(rid) {
  openSwitch(false);
  if (!rid || rid === state.currentRid) return;
  if (!state.restaurants.some((r) => r.rid === rid)) return;   // never one you do not own
  state.currentRid = rid;
  try { localStorage.setItem(REMEMBERED, rid); } catch (_) { /* private mode: not worth failing over */ }
  renderSwitcher();
  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid } }));
}

export async function loadRestaurants() {
  let data;
  try {
    data = await apiFetch('getMyRestaurants', { token });
  } catch (e) {
    const [t, d] = messageFor(e);
    $('shopname').textContent = '—';
    $('shopsub').textContent = '';
    showEmpty(t, d);
    return;
  }
  state.restaurants = (data && data.restaurants) || [];
  if (state.restaurants.length === 0) {
    // Owning nothing is a real state, not an error — an owner whose grant has not been applied yet, or
    // internal staff who are not merchants. Say so plainly rather than showing a broken-looking shell.
    $('shopname').textContent = '—';
    $('shopsub').textContent = '';
    showEmpty('Tu cuenta no administra ningún local todavía', 'Si esperabas ver uno, escribinos y lo revisamos.');
    return;
  }
  state.currentRid = pickRid(state.restaurants, localStorage.getItem(REMEMBERED));
  try { localStorage.setItem(REMEMBERED, state.currentRid); } catch (_) { /* private mode: not worth failing over */ }
  renderSwitcher();
  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid: state.currentRid } }));
}

// ── loading and rendering one restaurant's menu ────────────────────────────────────────────────
// state.groups is what is on screen. It is replaced wholesale on every load — never merged — so a
// failed reload can never leave half of one restaurant's menu beside half of another's.
export async function loadMenu(rid) {
  if (!rid) return;
  $('detail').replaceChildren();
  showEmpty('Cargando tu menú…', 'Un momento.');
  let data;
  try {
    data = await apiFetch('getEditableCatalog', { rid, token });
  } catch (e) {
    // Degrade to a message, never to an empty menu that reads as "you have no products". The typed
    // kind decides the sentence: an outage says try again, a refusal says this account cannot see it.
    state.groups = [];
    $('rail').replaceChildren();
    const [t, d] = messageFor(e);
    showEmpty(t, d);
    return;
  }
  state.groups = groupByCategory(data && data.source);
  state.extras = ((data && data.source && data.source.extras) || []).reduce((m, e) => {
    if (e && typeof e.key === 'string') m[e.key] = e.price;
    return m;
  }, {});
  state.selectedCat = (state.groups[0] && state.groups[0].category.id) || null;
  paint();
}

function paint() {
  renderRail($('rail'), state.groups, state.selectedCat, (id) => { state.selectedCat = id; paint(); });
  renderDetail($('detail'), state.groups.find((g) => g.category.id === state.selectedCat), state.extras);
}

document.addEventListener('portal:signed-in', () => { loadRestaurants(); });
document.addEventListener('portal:restaurant', (e) => { loadMenu(e.detail && e.detail.rid); });
$('switcher').addEventListener('click', (e) => { e.stopPropagation(); openSwitch(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.switchwrap')) openSwitch(false); });
