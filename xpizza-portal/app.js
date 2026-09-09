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
  // In the spine like every other async op: A's restaurant lookup settling after auth flipped to B
  // would otherwise replace B's selection AND dispatch a fresh loadMenu for A's restaurant, and an
  // old failure would erase B's rail.
  const gen = opGeneration;
  let data;
  try {
    data = await apiFetch('getMyRestaurants', { token });
  } catch (e) {
    // The check precedes ANY mutation, exactly as in loadMenu: a stale failure must not erase the
    // rail or the name of the restaurant the merchant is actually on.
    if (gen !== opGeneration) return;
    const [t, d] = messageFor(e);
    $('shopname').textContent = '—';
    $('shopsub').textContent = '';
    showEmpty(t, d);
    return;
  }
  if (gen !== opGeneration) return;   // a newer auth change or switch won; this answer is for a world that ended
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

// ── THE SHARED-STATE CALLBACK GUARD ────────────────────────────────────────────────────────────
// canEdit covers every writer of the DRAFT. This covers the other class: callbacks that write shared
// state which is not the draft — the acknowledgement above all.
//
// A callback captures the world it was created in — the generation, and the identity of the review it
// belongs to — and refuses to act if either has moved. A retained listener from review A dispatched
// after review B opened is therefore inert, and so is one dispatched across an auth transition.
//
// 🔴 The acknowledgement is why this exists. A's checkbox listener wrote through the GLOBAL
// state.review, so firing it later acknowledged B — a forged SAR attestation, which is the one thing
// the fiscal gate exists to prevent. Reachable only by a retained reference and a programmatic
// dispatch, but "unforgeable even programmatically" is the right bar for a legal document.
// OWNERSHIP AND PROVENANCE ARE DIFFERENT QUESTIONS, and canEdit only answers the first.
//
//   ownership  — is editing allowed at all right now? (a lock is held, or it is not)
//   provenance — does THIS callback belong to the draft, review and generation that are current?
//
// Every defect found in the last three rounds was provenance, not ownership: a listener retained from
// an earlier world firing at a moment when editing was perfectly legal, so canEdit waved it through.
// The acknowledgement forged for another review, an option field pricing a menu belonging to a
// different person, a recovery button re-entering a transition after its world had ended — all of them
// passed every ownership check there was.
//
// So: every listener that writes money or ownership state is created through this wrapper, which
// captures the world at CREATION and refuses on any drift. Three captures, each closing a real one:
//
//   generation   — the world ended (auth change, tenant switch, a newer review began)
//   draft object — the draft was replaced (a reload, a different tenant, a different person). Identity
//                  by REFERENCE: a new draft is a new object, so nothing needs to be numbered.
//   review token — a different review is open than the one this callback was rendered for
//
// The listener census in portal-wiring.test.mjs enforces that this is used everywhere it must be, so
// an unbound write-listener cannot be added without failing the build.
function bound(fn) {
  const gen = opGeneration;
  const draft = state.draft;
  const token = state.review ? state.review.editToken : null;
  return (...args) => {
    if (gen !== opGeneration) return;                                   // a world that ended
    if (state.draft !== draft) return;                                  // a different draft
    const now = state.review ? state.review.editToken : null;
    if (now !== token) return;                                          // a different review
    return fn(...args);
  };
}

// ── EDITING OWNERSHIP ──────────────────────────────────────────────────────────────────────────
// The drawer must be inert for as long as SOME operation owns the draft — a save, a review, or a
// publish — and must be released only by whoever took it.
//
// A ticket rather than a boolean, for the same reason `spent` became per-token: a second publish that
// is SKIPPED as in-flight still runs its own `finally`, and a boolean would let it unlock the drawer
// while the first request is still outstanding. Only the holder releases.
let editLockTicket = 0;
let editLockHolder = null;
// ── THE THIRD LEG: SERVER-WRITE ADMISSION ────────────────────────────────────────────────────────
// The generation spine stops a stale answer from PAINTING. bound() stops a stale listener from WRITING
// LOCALLY. Neither governs what is allowed to LEAVE THE BROWSER, and that is a separate question,
// because a world ending does not un-send a request that is already on the wire.
//
// The enders released the edit lock as though it did: switch tenants during a save and editLockHolder
// went to null while editCatalog was still outstanding, so the next review was admitted alongside it.
// Two writes against the same document, neither aware of the other, and the CAS baseline decided by
// whichever landed second.
//
// So a ticket that has a request in flight is NOT the enders' to reclaim. It belongs to the request
// until the request settles, whatever has happened to the UI in the meantime.
// 🔴 OWNERSHIP OF THE WIRE BELONGS TO A REQUEST, NOT TO A TICKET, and the two are deliberately
// different things. A ticket is REUSABLE: runPublish publishes under the review's existing ticket, so
// a second press carries the same number as the live request. Keying wire ownership on it meant a
// duplicate press — refused by the publisher as already in flight, having sent nothing — still called
// endWrite with that number and cleared the LIVE request's ownership. The lock then read as free to
// the next ender, and every guarantee built on it came undone.
//
// A request id is minted once, at the moment a request is genuinely admitted, and is never reused. A
// press that was refused never gets one, so it has nothing to give back — which is the correct answer
// rather than a special case, because it never owned the wire in the first place.
let writeSeq = 0;
let pendingWrite = null;                 // { id, ticket } while a request is genuinely outstanding
const beginWrite = (ticket) => { const id = ++writeSeq; pendingWrite = { id, ticket }; return id; };
// Settled: the ticket goes back. If the world that sent it has ended, nobody is coming back for it —
// this is its only chance to be released, so it releases itself here rather than leaking the lock.
function endWrite(id, ticket, gen) {
  if (id === null) return;               // never admitted: it owns nothing and must clear nothing
  // CLEAR ONLY YOUR OWN OWNERSHIP. Unreachable today — a second beginWrite needs the edit lock, and the
  // lock is exclusive and is not returned until this line has run — so no test can distinguish this
  // from an unconditional clear, and mutation testing reports it as a survivor. It is kept, and said
  // out loud here, because "clear it if it is mine" is the invariant; "clear it" is the bug this whole
  // section exists to fix, one level up. Anything that ever makes two writes concurrent must not also
  // silently reintroduce it.
  if (pendingWrite && pendingWrite.id === id) pendingWrite = null;
  if (gen !== opGeneration) {
    releaseEditLock(ticket);
    if (state.reviewLock === ticket) state.reviewLock = null;
    syncUi();
  }
}

function takeEditLock() {
  // EXCLUSIVE. If someone already holds it, the caller does NOT become the holder — it gets null and
  // its release is a no-op. Taking it unconditionally was the bug: a second publish, refused before
  // the network as in-flight, still became the holder and then released the drawer in its own
  // `finally` while the FIRST request was still outstanding, re-opening the draft mid-publish.
  if (editLockHolder !== null) return null;
  editLockHolder = ++editLockTicket;
  setDrawerInert(true);
  return editLockHolder;
}
function releaseEditLock(ticket) {
  if (ticket === null || editLockHolder !== ticket) return;   // a skipped or stale attempt never held it
  editLockHolder = null;
  syncUi();
}

// ── PRINCIPLE: UI IS DERIVED FROM OWNERSHIP, NEVER CLEARED IN A `finally` ───────────────────────
// Every bit below is a QUESTION ABOUT THE PRESENT — is a request on the wire, does anyone own the
// draft, can this review publish — so it is answered by reading current ownership rather than by
// whoever happens to finish last.
//
// That is what makes stale continuations harmless instead of dangerous: a finished operation calling
// syncUi() paints the CURRENT truth, not its own. A `finally` that clears a UI bit owns something
// that outlives its operation, and every symptom in this round came from one doing exactly that — a
// skipped publish clearing the live one's spinner, a stale publish stranding busy='1', a save's
// release un-inerting the drawer while a review was pending.
function syncUi() {
  const owned = editLockHolder !== null;
  // "Is a request on the wire" is not quite the question. After an auth change or a tenant switch the
  // request genuinely IS still in flight — but it belongs to a world the merchant has left, and this
  // one is not waiting on it. The honest derivation is whether THIS world is waiting.
  const waiting = publisher.busy && state.publishGen === opGeneration;
  if (PUBBTN) {
    if (waiting) PUBBTN.dataset.busy = '1'; else delete PUBBTN.dataset.busy;
    const r = state.review;
    PUBBTN.disabled = waiting || !(r && r.attestation && canPublish(r.attestation, r.acknowledged));
    PUBBTN.title = PUBBTN.disabled && r && r.attestation && r.attestation.hasZero
      ? 'Hay un precio sin valor válido'
      : (PUBBTN.disabled && r ? 'Confirmá los cambios antes de publicar' : '');
  }
  // 🔴 THE REVIEW ENTRY IS DERIVED TOO, from the same ownership. It used to be set imperatively in two
  // places — refreshBar enabled it on validity, openReviewFlow disabled it on entry — and NOTHING
  // re-enabled it, so open-then-close left it dead until the next keystroke. That is the failure mode
  // this file has now hit three times: UI that REMEMBERS what an operation did instead of reading what
  // is true. One derivation, from ownership and validity, and the close path needs no cleanup at all.
  $('rbar').classList.toggle('show', !!state.draft);
  const rev = $('review');
  if (rev) {
    const valid = !!state.draft && isPublishable(state.draft);
    rev.disabled = owned || state.menuLoading === true || !state.draft || !valid;
    rev.title = (state.draft && !valid) ? 'Hay un precio sin valor válido' : '';
  }
  setDrawerInert(owned);
}

export async function loadMenu(rid) {
  if (!rid) return;
  // ORDER MATTERS. End the previous world FIRST, then take this operation's generation — otherwise
  // invalidateReview()'s own bump lands after the capture and instantly invalidates the load that
  // just started. (It did: every load returned before building a draft, and only an executable
  // interleaving test showed it.)
  // 🔴 THE PREVIOUS TENANT'S DRAFT AND CAS BASELINE GO NOW, at the start of the transition rather
  // than on arrival. Leaving them in place is what made "B's rid with A's source" reachable: for the
  // whole duration of the fetch the screen held one tenant's document while another was current.
  //
  // Loading is represented EXPLICITLY rather than inferred from a null draft, because "no draft" and
  // "a draft is coming" want different answers from the review entry, and inferring one from the
  // other is how a transient state becomes a permanent-looking one.
  state.draft = null;
  state.draftRid = null;
  state.sourceUpdateTime = null;
  state.menuLoading = true;
  state.usesPlatformFactura = false;
  invalidateReview();                        // clears tenant-bound state AND bumps the generation
  const gen = opGeneration;
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
    state.menuLoading = false;               // it is not coming; the entry must stop saying "wait"
    state.groups = [];
    $('rail').replaceChildren();
    const [t, d] = messageFor(e);
    showEmpty(t, d);
    syncUi();
    return;
  }
  // THE DRAFT IS THE DOCUMENT. Everything on screen from here is rendered from the draft, not from the
  // response — so an edit shows up because the underlying source changed, not because a view model was
  // nudged to agree. The response is kept only for what the draft is not: the CAS baseline and the
  // fiscal capability.
  if (gen !== opGeneration) return;        // a newer switch won; this response is for a tenant the merchant left
  // The draft carries the boundary: it may be edited only while nobody owns it for a review or a
  // publish. Every mutator asks this, so a retained or detached listener is refused at the state
  // rather than at the DOM.
  state.draft = createDraft((data && data.source) || { items: [], extras: [], structure: {} },
    { canEdit: () => editLockHolder === null });
  state.sourceUpdateTime = (data && data.sourceUpdateTime) || null;
  state.usesPlatformFactura = (data && data.usesPlatformFactura) === true;
  // WHICH TENANT THIS DRAFT IS. Recorded with the draft, from the rid the request was made for — so
  // the write path names the restaurant it actually loaded rather than the one currently selected.
  state.draftRid = rid;
  state.menuLoading = false;
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
  // 🔴 #7-B — REACHABLE WHENEVER A DRAFT EXISTS, not only when this session typed something.
  //
  // editCatalog PERSISTS the draft and getEditableCatalog returns the SAVED draft, so after a reload
  // orig === state and the count is 0 while the merchant's unpublished work sits on the server. Keying
  // the bar to the count made that work unreachable — a dead end on the merchant's own saved edits,
  // with no way back to it short of re-typing a change.
  //
  // The client cannot answer "is there unpublished work?" — it is holding the draft, not the live
  // version. Only editCatalog's diff knows. So the bar OFFERS the question and never answers it.
  // Visibility is DERIVED by syncUi from the same `state.draft`, so every path that ends a world —
  // sign-out, tenant switch — takes the bar down without knowing the bar exists. Setting it here as
  // well would be the second opinion that just killed the review entry.
  // ...which is why the zero case is an INVITATION, not a claim. Saying "0 cambios sin publicar" would
  // be the client asserting something it cannot know, and it would be wrong in exactly the case this
  // whole change exists for.
  $('rbtxt').textContent = n === 0
    ? 'Revisá si hay algo sin publicar'
    : (n === 1 ? '1 cambio sin publicar' : `${n} cambios sin publicar`);
  // Nothing typed, nothing to throw away. The review is the way forward here; discard would be a
  // control that looks live and does nothing.
  $('discard').classList.toggle('hidden', n === 0);
  // A price we cannot vouch for blocks the way forward — HERE, where the merchant can still see which
  // row it is, rather than at the server after the review and the attestation. The RULE lives here; the
  // BUTTON is painted by syncUi, which also knows whether an operation currently owns the draft. Two
  // opinions about one control is what made the entry die after a single use.
  syncUi();
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
    // 🔴 BOUND AT THE CALL SITE, not declared bound. `onPrice` is one module-level function shared by
    // every cell ever rendered — it belongs to no world, so it can vouch for none. Binding it HERE
    // creates one wrapper per paint, which is exactly the lifetime the cells it feeds have.
    //
    // This is the largest editing surface on the screen. Binding the drawer fields and leaving these
    // unbound would have closed the two cases the review named and left the ordinary one open.
    onPrice: bound(onPrice),
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
  // EMPTIED, not just hidden. Its option-price handlers close over their own key, so leaving the
  // subtree in place keeps live listeners that would mutate the draft by that captured key — inertness
  // stops a person reaching them, but not a stray programmatic event. Nothing left to fire.
  $('drawer').replaceChildren();
  // Inertness is NOT touched here: it is derived from who owns the draft, and closing the drawer is
  // not the same event as the review handing editing back. Callers sync once their state has settled.
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
  // 🔴 THE KEY IS CAPTURED HERE. Reading state.drawerKey at dispatch time meant "whichever drawer is
  // open NOW", so a field retained from Pizza's drawer repriced Other once Other was opened — with both
  // dishes legitimately editable, which is why no ownership check ever saw it. A field edits the dish
  // it was built for or it edits nothing.
  const itemKey = it.key;
  input.addEventListener('input', bound(() => {
    setItemPrice(state.draft, itemKey, input.value);
    refreshBar();
    syncRow('item', itemKey, input.value);   // the row behind must follow, or it closes onto a stale number
  }));
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
    // This one always hit the right ROW — o.key was captured — but in whatever draft happened to be
    // loaded. After a different person signed in, it priced THEIR menu.
    pi.addEventListener('input', bound(() => {
      setExtraPrice(state.draft, o.key, pi.value);
      refreshBar();
      syncRow('extra', o.key, pi.value);          // the option's row in the detail list follows too
    }));
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
  // 🔴 ADMISSION CONTROL, FIRST — before the generation is bumped and before anything is sent.
  //
  // An operation that cannot acquire the edit lock is REFUSED, not admitted-then-collided. Letting a
  // re-entrant review proceed on a null ticket was the whole defect: it bumped the generation and sent
  // its own editCatalog while save A still held the lock, and A's release then un-inerted the drawer
  // with B still pending. Nothing to reconcile if the second one never starts.
  // 🔴 ADMISSION BEFORE ANYTHING, and the draft's readiness is part of it. During a tenant switch the
  // OLD draft is still in memory while the NEW rid is already current, so a review admitted here sends
  // one tenant's rid with the other tenant's source — a write that is internally consistent, passes
  // every client check, and prices the wrong restaurant.
  if (state.menuLoading) return;                                        // the draft on screen is being replaced
  if (!state.draft || !state.draftRid) return;                          // nothing loaded to write
  if (state.currentRid && state.currentRid !== state.draftRid) return;  // loaded, but not for this tenant
  const lock = takeEditLock();
  if (lock === null) return;                 // a save or publish is already in flight; this one waits

  // Only now does the previous world end. A review carries an acknowledgement and a token bound to ONE
  // diff, so nothing acknowledged survives re-entry.
  state.review = null;
  bumpGeneration();
  const gen = opGeneration;
  syncUi();       // the lock is held now, so this alone refuses re-entry — no imperative disable
  let writeId = null;                        // set only if a request actually goes out
  try {
    // The exact document being submitted — captured BEFORE the await, so what is reviewed, saved and
    // later committed as the baseline is one snapshot rather than whatever the draft holds by then.
    const submitted = JSON.parse(JSON.stringify(draftSource(state.draft)));
    writeId = beginWrite(lock);   // admitted by construction: the lock was taken exclusively
    const res = await editCatalog({
      // 🔴 THE RID THE SOURCE WAS LOADED FOR, never "the tenant currently selected". They differ for
      // exactly as long as a switch takes, and that is the window this write must not fall into.
      rid: state.draftRid,
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
    state.review.rid = state.draftRid;
    state.review.attestation = att;
    state.review.acknowledged = false;
    const attBox = document.createElement('div');
    $('mbody').append(attBox);
    // BOUND to this review and this world. Dispatching A's checkbox after B opened must acknowledge
    // nothing — an acknowledgement identifies a person signing one specific reviewed set.
    renderAttestation(attBox, att, bound((v) => {
      state.review.acknowledged = v === true;   // a literal true, never a truthy — this unlocks a signature
      syncUi();
    }));
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
    endWrite(writeId, lock, gen);   // settled; the ticket is the UI's again (or nobody's)
    // LIFECYCLE: the lock is held while the review is LIVE — the modal open, the merchant attesting —
    // and released the moment the operation settles into anything else.
    //
    // Admission control over-corrected the first time: a FAILED save kept the lock, so Reintentar,
    // Revisar-de-nuevo and Volver-a-la-revisión all hit a held lock and returned immediately. The
    // Task-7 recovery panels were dead. The distinction is SETTLED vs IN-FLIGHT, not first vs second:
    // a genuinely concurrent operation is still refused, but a recovery transition in the same session
    // must be able to re-enter.
    if (gen !== opGeneration || !state.review) releaseEditLock(lock);   // failed, or this world is gone
    else { state.reviewLock = lock; syncUi(); }                        // live review: keep the draft
    if (gen === opGeneration) syncUi();
  }
}

// The explicit return to editing. Everything that hands the draft back to the merchant goes through
// here, so there is one place that knows the review is over.
function closeReview() {
  // 🔴 A LIVE REVIEW IS CLOSEABLE; AN IN-FLIGHT PUBLISH IS NOT. Closing during a publish released its
  // lock, so the merchant could edit and start a SAVE while the publish was still pending — not a
  // double publish (the token latch holds) but a save/publish overlap that corrupts the baseline.
  //
  // Failure-panel recovery still releases, because by then the operation has settled.
  if (publisher.busy && state.publishGen === opGeneration) return;
  $('scrim').classList.remove('show');
  state.review = null;
  releaseEditLock(state.reviewLock);
  state.reviewLock = null;
  syncUi();
  // 🔴 REPAINT, because opening the review BUMPED THE GENERATION. Every control built before it is now
  // bound to a world that is over — correct while the review is open, and a dead page the moment it
  // closes. The drawer hid this in testing because openDrawer rebuilds its own fields; the inline price
  // cells are built by paint() and nothing else rebuilds them, so without this one line a single visit
  // to the review would leave every price on the page unresponsive.
  //
  // Same rule as the spinner and the review button before it: whoever ends a world repaints the one
  // that follows. Binding without repainting just moves a defect from "writes the wrong thing" to
  // "writes nothing at all", and the second is harder to notice.
  if (state.draft) repaintFromDraft();
}
$('review').addEventListener('click', openReviewFlow);

$('pubback').addEventListener('click', closeReview);

// The publish button's enabled state is derived, never toggled ad hoc: one function reads the model
// and the acknowledgement, so the button and the gate can never drift apart.
// Kept as a name callers already use; the derivation lives in syncUi.
const syncPublishButton = () => syncUi();
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
  syncUi();                               // publisher.busy is about to become true; render from it
  const captured = state.review;          // kept for the receipt; the baseline moves on success
  const gen = opGeneration;               // the world this attempt belongs to
  // ITS OWN ADMISSION, rather than riding the review's lock. If a save or another publish is in
  // flight, this one is refused before anything is sent — the same contract openReviewFlow honours.
  // 🔴 VALIDATE BEFORE ACQUIRING. Dispatching a retained publish button with no review used to
  // ACQUIRE the edit lock, get `not_ready` back from the publisher, and return without releasing —
  // leaving draft.canEdit() false forever and every future review refused at admission. The portal
  // became read-only until reload.
  if (!state.review || !state.review.attestation) return;   // nothing to publish; take nothing
  const held = state.reviewLock;
  const acquired = held !== null && held === editLockHolder ? null : takeEditLock();
  const lock = acquired !== null ? acquired : held;
  if (lock === null) return;              // something else genuinely owns the draft right now
  state.reviewLock = lock;
  let out;
  let writeId = null;                     // null unless the publisher admitted THIS call
  try {
    // START, then RENDER, then await. publisher.busy only becomes true once run() is executing, so
    // painting before the call would derive from a state that has not happened yet — the spinner
    // would never appear. This is the ordering cost of deriving UI instead of setting it, and it is
    // worth paying: everything after this point reads the truth rather than remembering it.
    // 🔴 ONLY ON GENUINE ADMISSION — and `busy` cannot tell us that. It is true whenever ANY request
    // is in flight, including the one that caused THIS press to be refused, so reading it would mark
    // the world as waiting on a request it never made: a spinner with nothing behind it, stuck until
    // someone else's finished. The admission COUNT answers the question this call is actually asking.
    const admittedBefore = publisher.admissions;
    const attempt = publisher.run(state.review);
    // 🔴 THE SAME ANSWER GOVERNS BOTH. Whether this call was admitted decides whether it owns a
    // spinner AND whether it owns the wire — a refused press owns neither, and minting its id before
    // asking was what let it hand back ownership it never had.
    if (publisher.admissions > admittedBefore) {
      writeId = beginWrite(lock);
      state.publishGen = gen;
    }
    syncUi();
    out = await attempt;
  } catch (e) {
    if (gen !== opGeneration) return;     // stale: auth changed or a newer review began mid-flight
    showOutcome(outcomeFor(e, 'publish'));
    return;
  } finally {
    endWrite(writeId, lock, gen);
    // NO UI IS CLEARED HERE. Every owned bit is derived by syncUi from CURRENT ownership, so calling
    // it is safe even from a stale continuation — it paints the present, not this operation's past.
    // A `finally` that cleared the spinner would be owning something that outlives its own operation,
    // which is how a skipped second publish wiped the live one's indicator.
    syncUi();
  }
  if (gen !== opGeneration) return;       // the answer arrived into a world that has moved on
  // Refused before the network: already in flight, spent, or the gate said no. Nothing was sent — so
  // hand back any ticket THIS call acquired, or the lock leaks and the portal goes read-only.
  if (!out || !out.ok) {
    if (acquired !== null) { releaseEditLock(acquired); state.reviewLock = null; syncUi(); }
    return;
  }

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
  // FAIL CLOSED. The fallback here used to be the LIVE draft, which would silently commit whatever
  // the merchant had typed since as though it had published. If the snapshot is missing we do not know
  // what went live, so the baseline is left alone and the changes stay pending — visible and
  // republishable, rather than quietly marked live.
  if (captured && captured.submitted) commitTo(state.draft, captured.submitted);
  releaseEditLock(state.reviewLock);      // the publish is done; editing is handed back
  state.reviewLock = null;
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
  // A panel is a SETTLED state: the operation is over and the merchant is deciding what to do next.
  // Editing is theirs again, and the recovery transitions must be able to acquire the lock.
  releaseEditLock(state.reviewLock);
  state.reviewLock = null;
  $('revSub').textContent = '';
  $('revFoot').replaceChildren(PUBBACK);
  PUBBACK.textContent = 'Cerrar';
  // 🔴 THESE ARE TRANSITIONS, NOT MESSAGES. RELOAD calls loadMenu, which invalidates unconditionally
  // and CLEARS THE LOCK HOLDER — so a retained RELOAD hands away a draft a live review is holding, and
  // a save can start against a baseline a pending publish is about to move. REREVIEW and RETRY happen
  // to be caught by admission control; RELOAD is not, and relying on that difference is how the next
  // one gets missed. Bound like every other write-listener.
  renderOutcome($('mbody'), outcome, bound(async (id) => {
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
  }));
}
// 🔴 AN ACKNOWLEDGEMENT IS A PERSON'S SIGNATURE, so it cannot outlive the person. Owner A ticks
// Autorizo, signs out, owner B signs in on the same browser — without this, A's tick publishes under
// B's token and the server records B as the SAR acknowledger. Every auth transition drops the review,
// its acknowledgement, the open modal and the publisher latch.
function invalidateReview() {
  bumpGeneration();          // every continuation still in flight now belongs to a world that ended
  // WHOEVER ENDS A WORLD CLEANS ITS UI. Stale continuations are forbidden from painting — that is the
  // whole point — so the busy indicator and the editing lock they would otherwise have cleared must be
  // cleared here instead, or a spinner from an abandoned publish sits on the button forever.
  // 🔴 NOT UNCONDITIONAL. A ticket whose request is on the wire keeps the lock: the UI world is over,
  // but the WRITE is not, and admission is about the write. Everything else here is UI and is cleared.
  editLockHolder = pendingWrite ? pendingWrite.ticket : null;   // held only by a request genuinely outstanding
  state.reviewLock = null;
  state.review = null;
  state.publishGen = null;                 // and it is not waiting on anything
  closeDrawer();
  $('scrim').classList.remove('show');
  // ONE derivation, last, after every piece of state has settled. There were three calls here (one
  // aliased, one nested inside closeDrawer), which is worse than untidy: any one of them could be
  // deleted and the other two masked it, so no test could tell whether this function cleaned up at all.
  syncUi();
}

document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  // The draft belongs to the previous session too: a new person must not inherit unpublished edits
  // they never made.
  //
  // 🔴 CLEARED BEFORE THE REPAINT, not after. invalidateReview() ends the world AND paints it, so
  // running it first meant the final paint of the old session still saw a draft that was about to be
  // deleted — leaving the review bar up and its entry live over nothing. Synchronous, so there is no
  // window between these two lines; the only thing that ever mattered was which came first.
  if (state.uid && state.uid !== uid) { state.draft = null; state.groups = []; state.currentRid = null; }
  state.uid = uid;
  invalidateReview();                       // bumps: whatever this event means, the old session is over
  // A re-authentication for the SAME person keeps the draft — but the generation moved, so the controls
  // rendered under the old session are inert. Rebuild them, or a token refresh silently freezes the
  // editor with everything still on screen and nothing responding.
  if (state.draft) repaintFromDraft();
});
