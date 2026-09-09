// Portal 2b-2a Task 5 — orchestration: sign-in → which restaurants → pick one.
//
// Rendering the menu is Task 6; this resolves WHICH restaurant is in view and keeps that choice.
// Nothing here decides what a merchant may see — every answer comes from the server, and the UI simply
// shows what came back.
import { apiFetch } from './api.js';
import { createDraft, setItemPrice, setExtraPrice, pendingChanges, pendingCount, isPublishable, discard, draftSource } from './editor.js';
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
  // THE DRAFT IS THE DOCUMENT. Everything on screen from here is rendered from the draft, not from the
  // response — so an edit shows up because the underlying source changed, not because a view model was
  // nudged to agree. The response is kept only for what the draft is not: the CAS baseline and the
  // fiscal capability.
  state.draft = createDraft((data && data.source) || { items: [], extras: [], structure: {} });
  state.sourceUpdateTime = (data && data.sourceUpdateTime) || null;
  state.usesPlatformFactura = (data && data.usesPlatformFactura) === true;
  state.selectedCat = null;
  repaintFromDraft();
}

// Re-derive EVERYTHING on screen from the draft. Rebuilding rather than patching in place is what
// keeps the count, the marks and the values from drifting apart: there is one source of truth and one
// pass that reads it.
function repaintFromDraft() {
  const src = draftSource(state.draft);
  state.groups = groupByCategory(src);
  state.extras = (src.extras || []).reduce((m, e) => {
    if (e && typeof e.key === 'string') m[e.key] = e.price;
    return m;
  }, {});
  if (!state.groups.some((g) => g.category.id === state.selectedCat)) {
    state.selectedCat = (state.groups[0] && state.groups[0].category.id) || null;
  }
  paint();
  refreshBar();
}

// The review bar states the count in the merchant's own terms and gates the way forward. It is the
// only place "you have unpublished work" is said, so it must never say it when the draft matches what
// is published — and never stay silent when it does not.
function refreshBar() {
  const n = pendingCount(state.draft);
  $('rbar').classList.toggle('show', n > 0);
  $('rbtxt').textContent = n === 1 ? '1 cambio sin publicar' : `${n} cambios sin publicar`;
  // A price we cannot vouch for blocks the way forward HERE, where the merchant can still see which
  // row it is — rather than at the server, after the review and the attestation.
  const ok = isPublishable(state.draft);
  $('review').disabled = !ok;
  $('review').title = ok ? '' : 'Hay un precio sin valor válido';
}

function onPrice(surface, key, value) {
  if (surface === 'extra') setExtraPrice(state.draft, key, value);
  else setItemPrice(state.draft, key, value);
  // The bar updates on every keystroke; the rows are NOT rebuilt, or the field being typed into would
  // be replaced mid-keystroke and lose the caret.
  refreshBar();
  markChanged(surface, key);
}

// Mark just the cell that changed, in place. Cheap, and it avoids the re-render that would steal focus.
function markChanged(surface, key) {
  const changed = new Set(pendingChanges(state.draft).map((c) => `${c.surface}::${c.key}`));
  for (const cell of document.querySelectorAll('.price')) {
    const k = cell.dataset && cell.dataset.k;
    if (k) cell.classList.toggle('chg', changed.has(k));
  }
  void surface; void key;
}

function paint() {
  renderRail($('rail'), state.groups, state.selectedCat, (id) => { state.selectedCat = id; paint(); });
  const changed = new Set(pendingChanges(state.draft).map((c) => `${c.surface}::${c.key}`));
  renderDetail($('detail'), state.groups.find((g) => g.category.id === state.selectedCat), state.extras, {
    editable: true,
    changed: (surface, key) => changed.has(`${surface}::${key}`),
    onPrice,
    onOpen: openDrawer,
  });
}

// ── the item drawer (Task 3: PRICE ONLY) ───────────────────────────────────────────────────────
// One editable field, deliberately. The drawer is where a name, a category or a delete button would
// naturally go, and all three write the pricing KEY — 2b-2c, after the key strategy lands. Nothing
// here renders them, so there is no control to accidentally enable.
export function openDrawer(key) {
  const src = draftSource(state.draft);
  const it = (src.items || []).find((i) => i && i.key === key);
  const d = $('drawer');
  d.replaceChildren();
  if (!it) { d.classList.add('hidden'); return; }
  // The mock's own drawer vocabulary — .dwh head, .dwt title, .dwx close, .dwb body — rather than new
  // class names, so the ported stylesheet already dresses it.
  const head = document.createElement('div');
  head.className = 'dwh';
  const title = document.createElement('div');
  title.className = 'dwt';
  title.textContent = (it.display && it.display.name) || it.key;   // textContent: a dish name is data
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'dwx'; close.textContent = 'Cerrar';
  close.addEventListener('click', () => d.classList.add('hidden'));
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'dwb';
  const fld = document.createElement('div');
  fld.className = 'fld pr';
  const label = document.createElement('label');
  label.textContent = 'Precio';
  const cur = document.createElement('span');
  cur.className = 'cur2'; cur.textContent = 'L';
  const input = document.createElement('input');
  input.type = 'text'; input.inputMode = 'numeric'; input.setAttribute('aria-label', 'Precio');
  input.value = (Number.isInteger(it.price) && it.price > 0) ? String(it.price) : '';
  input.placeholder = 'Sin precio';
  input.addEventListener('input', () => {
    setItemPrice(state.draft, key, input.value);
    refreshBar();
    // The ROW behind the drawer must follow, or the merchant closes it onto a stale number.
    syncRow('item', key, input.value);
  });
  fld.append(label, cur, input);
  body.append(fld);
  d.append(head, body);
  d.classList.remove('hidden');
}

// Keep the row's own field in step with the drawer without a full repaint (which would close it).
function syncRow(surface, key, value) {
  const cell = document.querySelector(`.price[data-k="${CSS.escape(`${surface}::${key}`)}"]`);
  const input = cell && cell.querySelector('input');
  if (input && input.value !== value) input.value = value;
  markChanged(surface, key);
}

document.addEventListener('portal:signed-in', () => { loadRestaurants(); });
document.addEventListener('portal:restaurant', (e) => { loadMenu(e.detail && e.detail.rid); });
$('switcher').addEventListener('click', (e) => { e.stopPropagation(); openSwitch(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.switchwrap')) openSwitch(false); });

// The review bar's own controls. Wired here, not inline: the CSP has no 'unsafe-inline', so an
// onclick attribute would be inert and the button would look enabled while doing nothing.
$('discard').addEventListener('click', () => {
  discard(state.draft);
  $('drawer').classList.add('hidden');
  repaintFromDraft();
});
