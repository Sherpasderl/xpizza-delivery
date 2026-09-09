// Portal 2b-2a Task 5 — orchestration: sign-in → which restaurants → pick one.
//
// Rendering the menu is Task 6; this resolves WHICH restaurant is in view and keeps that choice.
// Nothing here decides what a merchant may see — every answer comes from the server, and the UI simply
// shows what came back.
import { apiFetch, editCatalog, publishEdited } from './api.js';
import { createDraft, setItemPrice, setExtraPrice, pendingChanges, pendingCount, isPublishable, discard, commit, commitTo, draftSource, optionGroups, groupUsage } from './editor.js';
import { groupByCategory, renderRail, renderDetail } from './render.js';
import { reviewModel, ackSetFrom, renderReview, attestationModel, renderAttestation, canPublish, createPublisher, outcomeFor, renderOutcome, receiptFor, renderReceipt, PUBLISH_ACTIONS } from './review.js';
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
// ── THE OPERATION GENERATION ───────────────────────────────────────────────────────────────────
// 🔴 ONE MECHANISM for a defect that wore six hats. Every async operation — loadMenu, editCatalog,
// publishEdited — captures this at LAUNCH and re-checks it before ANY state mutation or paint when it
// settles, on the success path AND the failure path. A continuation whose generation is stale belongs
// to a world the merchant has left, and is dropped silently.
//
// It is bumped whenever that world changes: an auth transition, a tenant switch, or re-entering the
// review. Without it: a slow save settles after sign-out and repopulates state for the next person; a
// slow failure from the tenant you left erases the rail of the tenant you are on; an older save
// overwrites a newer review's CAS baseline.
//
// The check must come before EVERY write, not once at the top — the point of interleaving is that the
// world can change while the continuation is running.
let opGeneration = 0;
const bumpGeneration = () => { opGeneration += 1; };

export async function loadMenu(rid) {
  if (!rid) return;
  // ORDER MATTERS. End the previous world FIRST, then take this operation's generation — otherwise
  // invalidateReview()'s own bump lands after the capture and instantly invalidates the load that
  // just started. (It did: every load returned before building a draft, and only an executable
  // interleaving test showed it.)
  invalidateReview();                        // clears tenant-bound state AND bumps the generation
  const gen = opGeneration;
  state.usesPlatformFactura = false;
  $('detail').replaceChildren();
  showEmpty('Cargando tu menú…', 'Un momento.');
  let data;
  try {
    data = await apiFetch('getEditableCatalog', { rid, token });
  } catch (e) {
      // THE CHECK COMES FIRST, before ANY mutation. It sat BELOW the two lines that follow, so a slow
      // failure from the tenant the merchant had already left blanked the menu of the tenant they were
      // on — the current rail erased by an error about a different restaurant.
      if (gen !== opGeneration) return;
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
  if (gen !== opGeneration) return;        // a newer switch won; this response is for a tenant the merchant left
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
// Closing is its own operation because two different things need it: the Cerrar button, and the
// review opening (the drawer would otherwise overlay the attestation).
function closeDrawer() {
  state.drawerKey = null;
  $('drawer').classList.remove('show');
  setDrawerInert(false);
}

// 🔴 OFF-SCREEN IS NOT INERT. A translated panel keeps its inputs in the tab order and fully
// editable, so a merchant could keep typing into the draft — by keyboard — while the review is open
// or while a save is on the wire. That is what lets an older save overwrite a newer review.
//
// `inert` removes the subtree from focus and interaction entirely; the attribute is set on the
// element AND its inputs are disabled, because inert is not supported everywhere and a fallback that
// silently does nothing is the same failure again.
function setDrawerInert(on) {
  const d = $('drawer');
  if (!d) return;
  if (on) d.setAttribute('inert', ''); else d.removeAttribute('inert');
  for (const el of d.querySelectorAll('input, button')) el.disabled = on === true;
  if (on && document.activeElement && d.contains(document.activeElement)) document.activeElement.blur();
}

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
async function openReviewFlow() {
  // 🔴 CLEAR THE PREVIOUS REVIEW FIRST. A review carries an acknowledgement and a token bound to ONE
  // diff. If a save fails while an older acknowledged review is still in state, an edit-retry could
  // publish a set the merchant has already moved past. Nothing acknowledged survives re-entry.
  state.review = null;
  publisher.reset();
  bumpGeneration();                          // re-entering the review ends the previous attempt
  const gen = opGeneration;
  syncPublishButton();
  const btn = $('review');
  btn.disabled = true;
  try {
    // The exact document being submitted — captured BEFORE the await, so what is reviewed, saved and
    // later committed as the baseline is one snapshot rather than whatever the draft holds by then.
    const submitted = JSON.parse(JSON.stringify(draftSource(state.draft)));
    const res = await editCatalog({
      rid: state.currentRid,
      source: submitted,
      baseSourceUpdateTime: state.sourceUpdateTime,
      token,
    });
    if (gen !== opGeneration) return;        // auth changed, tenant switched, or a newer review began
    // Everything the publish will need, kept exactly as the server sent it. The ack set is captured
    // here — at the moment the token was minted — so what is replayed is what the token is bound to.
    state.review = {
      diff: res && res.diff,
      editToken: res && res.token,
      ackSet: ackSetFrom(res && res.diff),
      submitted,                              // what publish will commit as the new baseline
      gen,                                    // the world this review belongs to
    };
    // the CAS baseline moves forward: the draft we just wrote is the new precondition
    if (res && res.updateTime) state.sourceUpdateTime = res.updateTime;
    $('revSub').textContent = 'Esto es exactamente lo que cambia en tu menú en vivo.';
    renderReview($('mbody'), reviewModel(state.review.diff));

    // THE ATTESTATION, gated on the SERVER's capability flag — never on the rid. usesPlatformFactura
    // came back with getEditableCatalog (Task 2b) and is the only thing that decides whether this
    // merchant's edit touches a SAR factura.
    const att = attestationModel(state.review.diff, { usesPlatformFactura: state.usesPlatformFactura });
    state.review.rid = state.currentRid;
    state.review.attestation = att;
    state.review.acknowledged = false;
    publisher.reset();   // a NEW reviewed set, with a new token — the previous latch does not apply
    const attBox = document.createElement('div');
    $('mbody').append(attBox);
    renderAttestation(attBox, att, (v) => {
      state.review.acknowledged = v === true;   // a literal true, never a truthy — this unlocks a signature
      syncPublishButton();
    });
    syncPublishButton();
    restorePublishFooter();
    // The drawer is z-index 26; the review scrim is 20. An open drawer therefore sits OVER the
    // attestation, and a merchant could edit the underlying draft while signing for a snapshot taken
    // before that edit. Close it before the review opens.
    closeDrawer();          // and inert with it: off-screen alone leaves its inputs keyboard-reachable
    $('scrim').classList.add('show');
  } catch (e) {
      // The SAME designed panels the publish uses. editCatalog and publishEdited share most of their
      // error surface — stale_edit is an editCatalog code with its own panel — so routing this through
      // outcomeFor means every server error on the write path lands somewhere the merchant can act on,
      // whichever call produced it. The generic durable panel catches anything unmapped.
      if (gen !== opGeneration) return;      // a stale failure must not paint over the current world
      showOutcome(outcomeFor(e, 'edit'));
      $('scrim').classList.add('show');
  } finally {
    if (gen === opGeneration) btn.disabled = !isPublishable(state.draft);
  }
}
$('review').addEventListener('click', openReviewFlow);

$('pubback').addEventListener('click', () => { $('scrim').classList.remove('show'); });

// The publish button's enabled state is derived, never toggled ad hoc: one function reads the model
// and the acknowledgement, so the button and the gate can never drift apart.
function syncPublishButton() {
  const r = state.review;
  const ok = !!(r && r.attestation) && canPublish(r.attestation, r.acknowledged);
  PUBBTN.disabled = !ok;
  PUBBTN.title = ok ? '' : (r && r.attestation && r.attestation.hasZero
    ? 'Hay un precio sin valor válido'
    : 'Confirmá los cambios antes de publicar');
}

// ── THE PUBLISH ────────────────────────────────────────────────────────────────────────────────
// 🔴🔴 The send the attestation exists to authorize. What leaves here is built by publishPayload —
// the verbatim ack set and a strict fiscalAck — so what is signed is decided in one tested place
// rather than assembled at the call site.
// The publisher owns the in-flight lock and builds the payload. `disabled` still drives the button's
// APPEARANCE, but it is not the guard: the lock is a closure value taken before the await, so a second
// dispatched click cannot re-enter however the DOM is manipulated.
// STABLE REFERENCES, captured once while both buttons are attached.
//
// 🔴 A detached node is still a valid Node and can be re-appended — but getElementById will not FIND
// it. Restoring the footer with `$('pubbtn')` after showOutcome detached it does not throw: null is
// stringified by replaceChildren into a TEXT NODE, so the footer renders "Volver a editarnull" and
// the publish button is gone permanently. Verified in a browser. Every re-attach uses these.
//
// DECLARED HERE, ABOVE EVERY EXECUTED USE. `const` sits in the temporal dead zone until its own line,
// so a top-level `PUBBTN.addEventListener(...)` written above this point throws
// "Cannot access 'PUBBTN' before initialization" at module-eval — killing the whole module, not just
// the publish path. It shipped that way once: every test passed, because node never EXECUTES app.js.
const PUBBTN = $('pubbtn');
const PUBBACK = $('pubback');

const publisher = createPublisher({ publish: (payload) => publishEdited({ ...payload, token }) });

// The publish attempt, as a NAMED function rather than a click handler body.
//
// 🔴 RETRY used to re-enter by calling $('pubbtn').click(). But showOutcome replaces #revFoot's
// children to render a panel, which DETACHES #pubbtn from the document — and getElementById does not
// find a detached node. So `$('pubbtn')` was null and RETRY threw a TypeError instead of resending.
// That fired on store_unavailable, the single most likely real failure: the merchant got the
// "Reintentar" button the state machine promised, pressed it, and nothing happened.
//
// The structural guard asserted the STRING `$('pubbtn').click()` was present, which proved it was
// written, not that it worked. Calling the function directly removes the DOM lookup entirely.
async function runPublish() {
  // The captured reference, not a lookup: it stays valid even while the button is detached by a
  // conflict panel, which is exactly when RETRY re-enters.
  const btn = PUBBTN;
  // In-flight is a VISIBLE state, not just a disabled button: publishing is the one action where a
  // merchant who sees nothing happen will press again.
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
  const captured = state.review;          // kept for the receipt; the baseline moves on success
  const gen = opGeneration;               // the world this attempt belongs to
  setDrawerInert(true);                   // no editing the draft while it is being published
  let out;
  try {
    out = await publisher.run(state.review);
  } catch (e) {
    if (gen !== opGeneration) return;     // stale: auth changed or a newer review began mid-flight
    showOutcome(outcomeFor(e, 'publish'));
    return;
  } finally {
    setDrawerInert(false);
    if (btn) delete btn.dataset.busy;
    if (gen === opGeneration) syncPublishButton();
  }
  if (gen !== opGeneration) return;       // the answer arrived into a world that has moved on
  // Refused before the network: already in flight, spent, or the gate said no. Nothing was sent.
  if (!out || !out.ok) return;

  // SUCCESS. The receipt reads from the CAPTURED review, because the next two lines throw the draft
  // away — the publish is the new baseline, and leaving edits pending would claim unpublished work
  // the merchant no longer has.
  $('revFoot').replaceChildren(PUBBACK);
  PUBBACK.textContent = 'Listo';
  renderReceipt($('mbody'), receiptFor(out.res, captured));
  state.review = null;
  // 🔴 COMMIT, not discard. The published prices ARE the new baseline: the stored source is exactly
  // what went live, so ORIG moves forward to it. discard() — which shipped here — reset the editor to
  // the PRE-EDIT prices, so it showed 299 after publishing 310 and the next unrelated edit carried 299
  // back into the diff, silently reverting the price that had just gone live.
  //
  // sourceUpdateTime needs no change: publishEdited does not write the source, so the CAS baseline
  // editCatalog established still describes the document that was published.
  // 🔴 The SUBMITTED snapshot, not the live draft. If the merchant kept editing after opening the
  // review, what went live is what was reviewed — and the later edit must stay pending rather than be
  // marked live.
  commitTo(state.draft, (captured && captured.submitted) || draftSource(state.draft));
  repaintFromDraft();
}
PUBBTN.addEventListener('click', runPublish);

// Put the publish footer back. Used when RETRY re-enters from a conflict panel, so the merchant is
// returned to the normal publish UI rather than left looking at the panel they just dismissed.
function restorePublishFooter() {
  $('revFoot').replaceChildren(PUBBACK, PUBBTN);
  PUBBACK.textContent = 'Volver a editar';
}

// Every publish failure lands on a designed panel, and the panel's action is carried out here. The
// mapping from code to panel lives in review.js; what an action MEANS lives here, because only this
// module can reload a menu or re-open a review.
function showOutcome(outcome) {
  $('revSub').textContent = '';
  $('revFoot').replaceChildren(PUBBACK);
  PUBBACK.textContent = 'Cerrar';
  renderOutcome($('mbody'), outcome, async (id) => {
    if (id === PUBLISH_ACTIONS.RELOAD) {
      // the DRAFT moved under us: refetch it and start over
      $('scrim').classList.remove('show');
      await loadMenu(state.currentRid);
      return;
    }
    if (id === PUBLISH_ACTIONS.REREVIEW) {
      // 🔴 the LIVE version moved. Re-call editCatalog for a FRESH diff and token — never retry
      // publishEdited with the stale one, which is bound to a diff that no longer describes reality.
      await openReviewFlow();
      return;
    }
    if (id === PUBLISH_ACTIONS.BACK) {
      // something on the review was not confirmed; go back and let them tick it
      await openReviewFlow();
      return;
    }
    if (id === PUBLISH_ACTIONS.RETRY) {
      // 🔴 REDO THE OPERATION THAT FAILED. A failed SAVE retried as a PUBLISH would push a
      // reviewed-and-acknowledged set the merchant has already moved past; a failed PUBLISH retried as
      // a save would silently do nothing they asked for. The outcome carries which one it was.
      if (outcome.op === 'edit') {
        await openReviewFlow();
        return;
      }
      // Nothing about the edit was wrong, so send the same reviewed payload again. Calls runPublish
      // DIRECTLY: rendering this panel detached #pubbtn, so any lookup of it here is null.
      restorePublishFooter();
      await runPublish();
      return;
    }
    // An action id nothing handles must do NOTHING rather than fall through into a publish. Every id
    // the state machine emits is handled above; this is the guard for one it does not emit yet.
  });
}
// 🔴 AN ACKNOWLEDGEMENT IS A PERSON'S SIGNATURE, so it cannot outlive the person. Owner A ticks
// Autorizo, signs out, owner B signs in on the same browser — without this, A's tick publishes under
// B's token and the server records B as the SAR acknowledger. Every auth transition drops the review,
// its acknowledgement, the open modal and the publisher latch.
function invalidateReview() {
  bumpGeneration();          // every continuation still in flight now belongs to a world that ended
  state.review = null;
  publisher.reset();
  closeDrawer();
  $('scrim').classList.remove('show');
  syncPublishButton();
}

document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  invalidateReview();
  // The draft belongs to the previous session too: a new person must not inherit unpublished edits
  // they never made.
  if (state.uid && state.uid !== uid) { state.draft = null; state.groups = []; state.currentRid = null; }
  state.uid = uid;
});
