// Portal 2b-2a Task 5 — orchestration: sign-in → which restaurants → pick one.
//
// Rendering the menu is Task 6; this resolves WHICH restaurant is in view and keeps that choice.
// Nothing here decides what a merchant may see — every answer comes from the server, and the UI simply
// shows what came back.
import { apiFetch, editCatalog } from './api.js';
import { createDraft, setItemPrice, setExtraPrice, pendingChanges, pendingCount, isPublishable, discard, draftSource, optionGroups, groupUsage } from './editor.js';
import { groupByCategory, renderRail, renderDetail } from './render.js';
import { reviewModel, ackSetFrom, renderReview } from './review.js';
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
  // the extras ARRAY, not a {key: price} map — the rows need their display records to show a name
  state.extras = Array.isArray(src.extras) ? src.extras : [];
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
  state.drawerKey = key;
  state.openGroups = state.openGroups || new Set();
  renderDrawer();
}

// Re-rendered on every group toggle, so it PRESERVES the body's scroll position. Without that, opening
// a group three down the list snaps the drawer back to the top and the merchant loses the row they
// were reading — on a menu with a dozen option groups that makes the panel unusable.
function renderDrawer() {
  const d = $('drawer');
  const scroller = d.querySelector('.dwb');
  const keepScroll = scroller ? scroller.scrollTop : 0;

  const src = draftSource(state.draft);
  const it = (src.items || []).find((i) => i && i.key === state.drawerKey);
  d.replaceChildren();
  if (!it) { d.classList.remove('show'); return; }

  const head = document.createElement('div');
  head.className = 'dwh';
  const title = document.createElement('div');
  title.className = 'dwt';
  title.textContent = (it.display && it.display.name) || it.key;   // textContent: a dish name is data
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'dwx'; close.textContent = 'Cerrar';
  close.addEventListener('click', () => { state.drawerKey = null; d.classList.remove('show'); });
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
    setItemPrice(state.draft, state.drawerKey, input.value);
    refreshBar();
    syncRow('item', state.drawerKey, input.value);   // the row behind must follow, or it closes onto a stale number
  });
  fld.append(label, cur, input);
  body.append(fld);

  for (const g of optionGroups(state.draft)) body.append(groupBlock(g));

  d.append(head, body);
  // `.show` is what REVEALS the drawer: `.drawer` parks at translateX(102%) and `.drawer.show` brings
  // it in. `.hidden` (display:none) is the APP SHELL's mechanism, not this panel's — toggling it here
  // left the drawer permanently off-canvas while every structural check still passed, because the
  // listeners were all correctly attached to a panel nobody could see.
  d.classList.add('show');
  body.scrollTop = keepScroll;
}

// One option group: a header that toggles, and — when open — its options with editable prices.
//
// DELIBERATELY ABSENT (the mock has all four): the option NAME input (.moname), add option (.mgadd),
// remove option (.model) and the 86 toggle (.motog). The first three write pricing keys and are
// 2b-2c; the last is 2b-2d. The option name renders as TEXT, not in .moname — that class is styled as
// an input box, and dressing unwritable text as a field is the same hazard that has bitten this slice
// five times already.
function groupBlock(g) {
  const wrap = document.createElement('div');
  const isOpen = state.openGroups.has(g.name);
  wrap.className = `modgrp${isOpen ? ' open' : ''}`;

  const h = document.createElement('div');
  h.className = 'modgrp-h';
  const main = document.createElement('button');
  main.type = 'button'; main.className = 'mgmain';
  const nm = document.createElement('span');
  nm.className = 'mgname';
  nm.textContent = g.name || 'Sin grupo';        // the unnamed group is still shown, never dropped
  const sub = document.createElement('span');
  sub.className = 'mgsub';
  const n = g.options.length;
  // groupUsage already encodes the whole null-vs-zero truth: null when the source declares no exposure
  // at all, a real count otherwise. Short-circuiting the unnamed group to null here second-guessed it
  // and reported "unknown" for an orphan group whose usage IS knowable — for a merchant who declares
  // exposure, an extra that no map names is a genuine, honest 0.
  const usage = groupUsage(state.draft, g.name);
  // "en N productos" ONLY when the source actually declares exposure. x_pizza declares none, and
  // "en 0 productos" about a group its customers order from every day would be a confident lie.
  sub.textContent = `${n} ${n === 1 ? 'opción' : 'opciones'}${usage === null ? '' : ` · en ${usage} ${usage === 1 ? 'producto' : 'productos'}`}`;
  main.append(nm, sub);
  const toggle = () => {
    if (state.openGroups.has(g.name)) state.openGroups.delete(g.name); else state.openGroups.add(g.name);
    renderDrawer();
  };
  main.addEventListener('click', toggle);
  const chev = document.createElement('button');
  chev.type = 'button'; chev.className = 'mgchev';
  chev.setAttribute('aria-label', 'Ver opciones');
  chev.setAttribute('aria-expanded', String(isOpen));
  chev.append(svgChevron());
  chev.addEventListener('click', toggle);
  h.append(main, chev);
  wrap.append(h);

  if (!isOpen) return wrap;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'mgbody';
  // The shared-group warning, only when it is TRUE: more than one product reaches this group, so a
  // price typed here changes what every one of them costs. Silent when the source cannot say.
  if (usage !== null && usage > 1) {
    const note = document.createElement('div');
    note.className = 'mgshared';
    note.textContent = `Es un grupo compartido — editar una opción cambia el precio en ${usage} productos.`;
    bodyEl.append(note);
  }
  for (const o of g.options) {
    const row = document.createElement('div');
    row.className = 'mopt';
    const name = document.createElement('span');
    name.className = 'moname ro';                 // .ro strips the input chrome: this text is not editable
    name.textContent = (o.display && o.display.name) || o.key;
    const pr = document.createElement('span');
    pr.className = 'mopr';
    const mc = document.createElement('span');
    mc.className = 'mc'; mc.textContent = 'L';
    const pi = document.createElement('input');
    pi.type = 'text'; pi.inputMode = 'numeric';
    pi.setAttribute('aria-label', `Precio de ${(o.display && o.display.name) || o.key}`);
    pi.value = (Number.isInteger(o.price) && o.price > 0) ? String(o.price) : '';
    pi.placeholder = 'Sin precio';
    pi.addEventListener('input', () => {
      setExtraPrice(state.draft, o.key, pi.value);
      refreshBar();
      syncRow('extra', o.key, pi.value);          // the option's row in the detail list follows too
    });
    pr.append(mc, pi);
    row.append(name, pr);
    bodyEl.append(row);
  }
  wrap.append(bodyEl);
  return wrap;
}

function svgChevron() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M9 6l6 6-6 6');
  svg.append(path);
  return svg;
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
  $('drawer').classList.remove('show');
  repaintFromDraft();
});

// ── THE REVIEW FLOW ────────────────────────────────────────────────────────────────────────────
// "Revisar y publicar" does NOT publish. It saves the draft through editCatalog and shows what the
// SERVER says will change — the diff, the token bound to it, and the acknowledgement set captured
// verbatim for replay at publish time.
//
// The screen never re-derives the diff from the local draft. A client-side diff would be a second
// opinion about money, and publishEdited re-checks the server's one anyway: the two disagreeing is
// how a merchant approves a change they were never shown.
$('review').addEventListener('click', async () => {
  const btn = $('review');
  btn.disabled = true;
  try {
    const res = await editCatalog({
      rid: state.currentRid,
      source: draftSource(state.draft),
      baseSourceUpdateTime: state.sourceUpdateTime,
      token,
    });
    // Everything the publish will need, kept exactly as the server sent it. The ack set is captured
    // here — at the moment the token was minted — so what is replayed is what the token is bound to.
    state.review = {
      diff: res && res.diff,
      editToken: res && res.token,
      ackSet: ackSetFrom(res && res.diff),
    };
    // the CAS baseline moves forward: the draft we just wrote is the new precondition
    if (res && res.updateTime) state.sourceUpdateTime = res.updateTime;
    $('revSub').textContent = 'Esto es exactamente lo que cambia en tu menú en vivo.';
    renderReview($('mbody'), reviewModel(state.review.diff));
    $('scrim').classList.add('show');
  } catch (e) {
    // Task 7 gives each server code its own designed panel. Until then this states the failure
    // honestly rather than pretending the review opened — a blank modal would read as "no changes".
    $('revSub').textContent = '';
    $('mbody').replaceChildren();
    const [t, dsc] = messageFor(e);
    const box = document.createElement('div');
    box.className = 'empty';
    box.append(Object.assign(document.createElement('b'), { textContent: t }));
    box.append(Object.assign(document.createElement('span'), { textContent: dsc }));
    $('mbody').append(box);
    $('scrim').classList.add('show');
  } finally {
    btn.disabled = !isPublishable(state.draft);
  }
});

$('pubback').addEventListener('click', () => { $('scrim').classList.remove('show'); });
