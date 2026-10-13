// Portal 2b-2a Task 5 — orchestration: sign-in → which restaurants → pick one.
//
// Rendering the menu is Task 6; this resolves WHICH restaurant is in view and keeps that choice.
// Nothing here decides what a merchant may see — every answer comes from the server, and the UI simply
// shows what came back.
import { apiFetch, editCatalog, publishEdited, resetDraftToLive } from './api.js';
import { createDraft, setItemPrice, setExtraPrice, pendingChanges, pendingCount, isPublishable, discard, commit, draftSource, optionGroups, groupUsage, addProduct, setAddition, removeAddition, adopt, rowId } from './editor.js';
// 1D add-product B — the required choice on a NEW product ("Elección requerida — el cliente elige 1")
import { parsePrice } from './editor.js';
import { setRequiredChoice, setGroupLabel, setGroupExtrasNone, addChoice, removeChoice, setChoiceName, setChoiceRecommended, setChoicePrice, setGroupPrice, choiceGroup, optionPricesEqual, isNewGroupOption, optionParentId } from './editor.js';
import { groupByCategory, renderRail, renderDetail } from './render.js';
import { reviewModel, ackSetFrom, renderReview, attestationModel, renderAttestation, canPublish, createPublisher, outcomeFor, renderOutcome, receiptFor, renderReceipt, PUBLISH_ACTIONS } from './review.js';
import { token } from './auth.js';

const $ = (id) => document.getElementById(id);
const REMEMBERED = 'sherpa.portal.rid';

export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null, renderedCategories: [], additionKeys: new Set(), settle: null };

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
import { pickRid, messageFor, portalCanReload } from './portal-logic.js';

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
// ── THE ATTESTATION IS RUNTIME-CLOSED ────────────────────────────────────────────────────────────
// 🔴 THIS IS THE WRITE THAT STAMPS A TAX DOCUMENT. Every guard before this one proved that no code
// path in app.js forges it — a proof about the source, which has to be re-established every time the
// source changes and every time someone finds a syntax the analysis had not considered.
//
// This makes the object refuse instead. `acknowledged` is an accessor with a getter and NO setter,
// backed by a variable that exists only inside this closure. In a module (always strict) every way of
// writing it THROWS at runtime rather than silently succeeding:
//
//     review.acknowledged = true                 → TypeError, no setter
//     review['acknowledged'] = true              → TypeError, same property
//     Object.assign(review, {acknowledged:true}) → TypeError, [[Set]] on an accessor
//     ({acknowledged: review.acknowledged} = x)  → TypeError, same
//     const r = review; r.acknowledged = true    → TypeError, it is the same object
//     delete review.acknowledged                 → TypeError, non-configurable
//
// Retained, aliased, forwarded, destructured, deleted — none of it matters, because none of them is a
// spelling the analyzer has to recognise any more. There is exactly one way in, it re-verifies the
// world it belongs to at the moment of the write, and the analyzer no longer has to prove anything
// about this field at all.
//
// The rest of the record is frozen for the same reason: a review is EVIDENCE of what was shown to a
// person, so the token, the submitted snapshot and the acknowledged set must be exactly what they were
// when the merchant looked at them.
const mintedReviews = new WeakSet();
// 🔴 THE BRAND SAYS "WE MINTED THIS". IT DOES NOT SAY "THIS IS STILL THE OPEN REVIEW."
//
// A minted, acknowledged record stays branded and stays acknowledged forever — the closure variable
// does not reset when the review closes. So a retained reference, reinstalled as state.review after
// the review was closed, was a SIGNED INSTRUMENT THAT COULD BE REPLAYED: brand check passes,
// acknowledged reads true, publish proceeds. The merchant signed once and could be made to publish
// twice, or to publish a set they had already walked away from.
//
// Generation alone does not close it, because closing a review does NOT end the world — closeReview
// nulls state.review and bumps nothing, so a close-and-reinstall happens entirely inside one
// generation. Liveness is therefore tracked directly: there is at most one live minted review, and it
// is retired the moment it stops being open, whatever the reason.
let liveReview = null;
// The ONE place state.review is cleared. Retiring and clearing are the same event, and splitting them
// across four call sites is how one of them ends up doing only half of it.
function clearReview() {
  state.review = null;
  liveReview = null;
}

// 🔴 A REVIEW IS EVIDENCE OF WHAT A PERSON WAS SHOWN BEFORE THEY SIGNED. Making the record's own
// properties read-only stopped the record being re-pointed; it did nothing about the objects hanging
// off it. `review.submitted.items[0].price = 999` reached straight through a non-writable property
// into a live, shared object — and `submitted` is precisely what publish commits as the new baseline,
// so that one line changes what the merchant is recorded as having published.
//
// CLONE, THEN FREEZE, ALL THE WAY DOWN. Cloning makes the snapshot independent of anything that still
// holds a reference to the original; freezing makes it independent of anything that finds this one.
// In strict mode a write anywhere inside it throws.
function frozenCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  const copy = Array.isArray(value)
    ? value.map(frozenCopy)
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozenCopy(v)]));
  return Object.freeze(copy);
}

function mintReview(fields, gen) {
  let acknowledged = false;
  const review = {};
  for (const k of Object.keys(fields)) {
    // Frozen deeply, not just held non-writably: the diff, the reviewed set, the attestation and the
    // submitted snapshot are all the evidence, and evidence that can be edited afterwards is not.
    Object.defineProperty(review, k, { value: frozenCopy(fields[k]), enumerable: true, writable: false, configurable: false });
  }
  Object.defineProperty(review, 'acknowledged', { get: () => acknowledged, enumerable: true, configurable: false });
  Object.preventExtensions(review);
  mintedReviews.add(review);
  // The only way in. It re-checks provenance ITSELF rather than trusting its caller to be bound — so
  // even a caller that somehow reached this function outside the wrapper cannot sign for another world.
  const acknowledge = (v) => {
    if (gen !== opGeneration) return;        // a world that ended
    if (state.review !== review) return;     // a different review is open
    acknowledged = v === true;               // a literal true, never a truthy — this unlocks a signature
  };
  return { review, acknowledge };
}

function bound(fn) {
  const gen = opGeneration;
  const draft = state.draft;
  const token = state.review ? state.review.editToken : null;
  return (...args) => {
    if (gen !== opGeneration) return;                                   // a world that ended
    if (state.draft !== draft) return;                                  // a different draft
    // The review token. NOW BELT-AND-BRACES: the acknowledgement — the only review-scoped write there
    // is — re-verifies identity inside its own closure, so removing this clause breaks no test. It is
    // kept for the next review-scoped callback, which will not have a runtime lock of its own on the
    // day it is written. Reported as a mutation survivor rather than quietly carried.
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
  // "Listo" on the receipt is not pressable while the post-publish reload is owed (derived, like every other control)
  if (PUBBACK) PUBBACK.disabled = !!state.settle;
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
  // 1D add-product A — per-load facts from the server (never derived from a rid)
  state.additionKeys = new Set();
  state.renderedCategories = [];
  state.restaurantName = '';
  state.draftUnpublishable = null;
  state.drawerError = null;
  state.groupAuthoring = false;               // 1D add-product B — per-load server facts, fail closed until they arrive
  state.choiceBadges = [];
  state.samePrice = new Map();                // "Mismo precio para todas", per product; DERIVED again on every load
  state.rawPrice = new Map();                 // typed price text that is not (yet) a price, per field (codex PB-3 P2-2)
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
    // 1D add-product A §0.1 — a stored draft that cannot even be loaded says WHY and carries its revision: offer the
    // way back to the published menu instead of a dead end.
    const b = e && e.body;
    if (b && b.draft_unpublishable && typeof b.sourceUpdateTime === 'string') offerResetToLive($('detail'), rid, b.sourceUpdateTime);
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
  applyAddProductFacts(data);
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
  // 1D add-product B — a product's options belong under it (its drawer, its review row, its nested lines in the list —
  // portal mockup screen 2), not in the list as products of their own: they are folded out here, NEW and PUBLISHED groups
  // alike, so the section count counts products. An orphan bucket left empty by that (an unsaved option has no section of
  // its own — the server derives it) is not shown.
  state.groups = groupByCategory(src)
    .map((g) => ({ ...g, items: g.items.filter((it) => !isNewGroupOption(state.draft, it, state.additionKeys) && !listIsGroupOption(it)) }))
    .filter((g) => g.items.length || (categoriesOf().some((c) => c && String(c.id) === g.category.id)));
  // the extras ARRAY, not a {key: price} map — the rows need their display records to show a name
  state.extras = Array.isArray(src.extras) ? src.extras : [];
  if (!state.groups.some((g) => g.category.id === state.selectedCat)) {
    state.selectedCat = (state.groups[0] && state.groups[0].category.id) || null;
  }
  paint();
  refreshBar();
}

// ── 1D add-product A — the facts the add flow reads, all from the server's getEditableCatalog response ──────────
function applyAddProductFacts(data) {
  state.additionKeys = new Set(Array.isArray(data && data.pendingAdditions) ? data.pendingAdditions.filter((k) => typeof k === 'string') : []);
  state.renderedCategories = Array.isArray(data && data.renderedCategories) ? data.renderedCategories.filter((c) => typeof c === 'string') : [];
  state.restaurantName = (data && typeof data.restaurantName === 'string') ? data.restaurantName : '';
  state.draftUnpublishable = (data && data.draft_unpublishable && typeof data.draft_unpublishable === 'object') ? data.draft_unpublishable : null;
  // 1D add-product B — whether the drawer may OFFER a required choice (the platform authoring switch the save is judged by) and
  // which badges this brand's picker draws on an option. Strictly from the server; absent = off / none.
  state.groupAuthoring = !!(data && data.groupAuthoring === true);
  state.choiceBadges = Array.isArray(data && data.choiceBadges) ? data.choiceBadges.filter((b) => typeof b === 'string') : [];
}
// A NEW product: still unsaved (a temporary reference), or saved but not yet published (the server said so).
const isTmpRow = (it) => !!(it && typeof it.ref === 'string' && it.ref.startsWith('tmp:') && !('key' in it));
function isAddition(it) {
  return isTmpRow(it) || !!(it && typeof it.key === 'string' && state.additionKeys && state.additionKeys.has(it.key));
}
const canAddTo = (catId) => state.renderedCategories.includes(catId);   // always an array: declared [] and set from data
const categoriesOf = () => { const st = (draftSource(state.draft) || {}).structure || {}; return Array.isArray(st.categories) ? st.categories : []; };
const categoryName = (id) => { const c = categoriesOf().find((x) => x && String(x.id) === String(id)); return (c && typeof c.name === 'string' && c.name.trim()) ? c.name : String(id); };
// What a NEW product inherits from its section — said in the review so the owner knows before publishing.
function inheritedRules(catId) {
  const st = (draftSource(state.draft) || {}).structure || {};
  const has = (f) => Array.isArray(st[f]) && st[f].includes(catId);
  const out = [];
  if (has('pickup_only_cats')) out.push('Solo para recoger');
  if (has('weekend_only_cats')) out.push('Solo fines de semana');
  if (has('redeem_eligible_cats')) out.push('Canjeable con recompensas');
  return out;
}
function describeAddition(x) {
  const it = ((draftSource(state.draft) || {}).items || []).find((i) => i && rowId(i) === (x && x.key));
  if (!it || !it.display) return null;
  const d = it.display;
  // 1D add-product B — an OPTION of a new product names its product (the review nests it there) and its choice; its full
  // name ("{product} - {choice}", server-derived) is what the factura prints, so it is kept too.
  const parent = optionParentId(state.draft, rowId(it));
  if (parent) {
    return { option: true, parent, name: typeof d.choice === 'string' && d.choice.trim() ? d.choice : String(x.key),
      fullName: typeof d.name === 'string' && d.name.trim() ? d.name : String(x.key), recommended: Array.isArray(d.tags) && d.tags.includes('recommended') };
  }
  const g = choiceGroup(state.draft, rowId(it));
  return { name: typeof d.name === 'string' && d.name.trim() ? d.name : String(x.key),
    section: categoryName(d.cat) + (typeof d.subcat === 'string' && d.subcat ? ` / ${d.subcat}` : ''), rules: inheritedRules(d.cat),
    ...(g ? { choice: { label: g.label, extrasNone: g.extrasNone } } : {}) };
}
// The list row of ANY product with a required choice — new or published (portal mockup screen 2, approved): its group as a
// chip, its price ONCE as the order page shows it ("L {min}" / "desde L {min}"), and its choices nested beneath. Read-only:
// a choice's price is edited in the product's drawer. `changed` lights the row when any of its choices' prices moved.
function listGroupOf(it) {
  if (!it) return null;
  const g = choiceGroup(state.draft, rowId(it));
  if (!g) return null;
  const ps = g.options.map((o) => o.price).filter((p) => Number.isInteger(p) && p > 0);
  const changedSet = new Set(pendingChanges(state.draft, state.additionKeys).map((c) => `${c.surface}::${c.key}`));
  // "the same price for every choice" only when EVERY choice has a valid price and they are equal (codex portal-A P2-a): a
  // choice without a usable price never hides behind "mismo precio"
  const equal = g.options.length > 0 && ps.length === g.options.length && ps.every((p) => p === ps[0]);
  // …and the merchant's explicit "Mismo precio para todas" wins when they set it (codex portal-A r2): OFF at equal prices
  // shows each choice's own price; ON can only hold while the prices really are equal
  const id = rowId(it);
  const same = state.samePrice && state.samePrice.has(id) ? (state.samePrice.get(id) === true && equal) : equal;
  return { label: g.label, min: ps.length ? Math.min(...ps) : null, max: ps.length ? Math.max(...ps) : null, same,
    badges: state.choiceBadges.includes('recommended'),
    changed: cellChanged(changedSet, `item::${rowId(it)}`),
    options: g.options.map((o) => {
      const d = o.display || {};
      return { name: typeof d.choice === 'string' && d.choice.trim() ? d.choice : String(rowId(o)), price: o.price,
        recommended: Array.isArray(d.tags) && d.tags.includes('recommended') };
    }) };
}
// An option row drawn under its product (listGroupOf), never as a product of its own.
const listIsGroupOption = (it) => !!(it && optionParentId(state.draft, rowId(it)));
function onAddProduct(catId) {
  if (!state.draft || !canAddTo(catId)) return;
  const ref = `tmp:${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
  const cat = categoriesOf().find((c) => c && String(c.id) === String(catId));
  addProduct(state.draft, { ref, cat: catId, subcat: (cat && Array.isArray(cat.subcats) && cat.subcats.length === 1) ? cat.subcats[0] : null });
  if (!draftSource(state.draft).items.some((i) => i && i.ref === ref)) return;   // refused (the draft is owned)
  state.drawerError = null;
  repaintFromDraft();
  openDrawer(ref);
}
// "Volver al menú publicado" (§0.1): replace the saved draft with the published menu, conditional on the revision
// the owner saw, then load it again. Distinct from "Descartar", which only drops unsaved edits in this browser.
// 🔴 codex build r1 #2 — A WRITE LIKE ANY OTHER: it takes the edit lock (nothing can be typed into a draft that is about
// to be replaced), holds a write ticket while the request is outstanding (a tenant switch cannot hand the lock away),
// and its continuations check the captured generation AND tenant before painting an error or reloading — a reset of
// X. Pizza that lands after the merchant moved to La Musa does nothing to La Musa's screen.
async function resetToLive(rid, expectedRevision) {
  if (!rid || typeof expectedRevision !== 'string') return;
  const lock = takeEditLock();
  if (lock === null) return;                 // a save, publish or reset already owns the draft
  const gen = opGeneration;
  syncUi();
  const writeId = beginWrite(lock);
  let failed = null;
  try {
    await resetDraftToLive({ rid, expectedRevision, token });
  } catch (e) {
    failed = e;
  } finally {
    endWrite(writeId, lock, gen);             // settled; a world that ended gets its lock back here
  }
  if (gen !== opGeneration || (state.currentRid && state.currentRid !== rid)) return;   // the merchant is elsewhere now
  releaseEditLock(lock);
  if (failed) {
    const [t, d] = messageFor(failed);
    showEmpty(t, d);
    syncUi();
    return;
  }
  await loadMenu(rid);
}
function offerResetToLive(host, rid, rev) {
  const box = document.createElement('div');
  box.className = 'unpub';
  const p = document.createElement('p');
  p.textContent = 'Tu borrador guardado no se puede publicar tal como está. Podés volver al menú publicado y aplicar tus cambios de nuevo.';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button'; resetBtn.className = 'btn accent'; resetBtn.textContent = 'Volver al menú publicado';
  resetBtn.addEventListener('click', bound(() => resetToLive(rid, rev)));
  box.append(p, resetBtn);
  host.prepend(box);
}

// The review bar states the count in the merchant's own terms and gates the way forward. It is the
// only place "you have unpublished work" is said, so it must never say it when the draft matches what
// is published — and never stay silent when it does not.
function refreshBar() {
  const n = pendingCount(state.draft, state.additionKeys);
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
  else if (typeof key === 'string' && key.startsWith('tmp:')) setAddition(state.draft, key, 'price', value);   // an unsaved addition
  else setItemPrice(state.draft, key, value);
  // The bar updates on every keystroke; the rows are NOT rebuilt, or the field being typed into would
  // be replaced mid-keystroke and lose the caret.
  refreshBar();
  markChanged(surface, key);
}

// Mark just the cell that changed, in place. Cheap, and it avoids the re-render that would steal focus.
function markChanged(surface, key) {
  const changed = new Set(pendingChanges(state.draft, state.additionKeys).map((c) => `${c.surface}::${c.key}`));
  for (const cell of document.querySelectorAll('.price')) {
    const k = cell.dataset && cell.dataset.k;
    if (k) cell.classList.toggle('chg', cellChanged(changed, k));
  }
  void surface; void key;
}
// ONE rule for "is this price cell changed", shared by the incremental highlight above and the full renderer (listGroupOf):
// its own key moved — or, for a product with a required choice, any of its CHOICES' prices moved (codex portal-A P2-b: the
// group row's cell is keyed by the product, its edits land on the choices).
function cellChanged(changed, k) {
  if (changed.has(k)) return true;
  if (!k.startsWith('item::')) return false;
  const g = choiceGroup(state.draft, k.slice('item::'.length));
  return !!(g && g.options.some((o) => changed.has(`item::${rowId(o)}`)));
}

function paint() {
  renderRail($('rail'), state.groups, state.selectedCat, (id) => { state.selectedCat = id; paint(); });
  const changed = new Set(pendingChanges(state.draft, state.additionKeys).map((c) => `${c.surface}::${c.key}`));
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
    // 1D add-product A — NUEVO tags, and "Agregar producto" only on sections the order page draws
    isAddition,
    canAdd: canAddTo,
    onAdd: bound(onAddProduct),
    groupOf: listGroupOf,          // 1D add-product B (a group's option rows are folded out in repaintFromDraft)
  });
  if (state.draftUnpublishable && state.draftRid) offerResetToLive($('detail'), state.draftRid, state.sourceUpdateTime);
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
// 1D add-product B (codex PB-3 P2-1) — a control that is OFF for a reason of its own (a saved product's fixed structure) rather
// than because the drawer is busy: the busy/idle toggle below must never re-enable it.
const lockedControls = new WeakSet();
function lockControl(el, locked) { if (locked) { lockedControls.add(el); el.disabled = true; } return el; }
// (codex PB-3 P2-4) a rebuild replaces every control, so the one the merchant was on is found again by its key and focused
const focusables = new Map();
function focusKey(el, key) { focusables.set(key, el); return el; }
function refocus(keys) {
  for (const k of keys) { const el = focusables.get(k); if (el && !el.disabled && typeof el.focus === 'function') { el.focus(); return; } }
}
// (codex PB-3 P2-2) typed price text that is not (yet) a price, per field, so a rebuild shows what was typed instead of a
// blank — shown only while that field's draft price is still not a price (a stale entry is inert)
function priceText(rid, price) {
  if (Number.isInteger(price) && price > 0) return String(price);
  const k = `item::${rid}`;
  return state.rawPrice.has(k) ? state.rawPrice.get(k) : '';   // only ever set to a string (holdPriceText)
}
function holdPriceText(rid, text) {
  if (parsePrice(text) === null && String(text).trim() !== '') state.rawPrice.set(`item::${rid}`, String(text));
  else state.rawPrice.delete(`item::${rid}`);
}

function setDrawerInert(on) {
  const d = $('drawer');
  if (!d) return;
  if (on) d.setAttribute('inert', ''); else d.removeAttribute('inert');
  for (const el of d.querySelectorAll('input, button')) el.disabled = on === true || lockedControls.has(el);
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

  focusables.clear();
  const src = draftSource(state.draft);
  // 1D add-product B — a NEW product's option is edited in its product's drawer
  const parentId = optionParentId(state.draft, state.drawerKey);
  if (parentId && isNewGroupOption(state.draft, (src.items || []).find((i) => i && rowId(i) === state.drawerKey), state.additionKeys)) state.drawerKey = parentId;
  const it = (src.items || []).find((i) => i && rowId(i) === state.drawerKey);
  d.replaceChildren();
  if (!it) { d.classList.remove('show'); return; }
  if (isAddition(it)) { renderAddDrawer(d, it, keepScroll); return; }   // 1D add-product A

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

  // A PUBLISHED product with a required choice: its price IS its choices' prices (the launcher's own is legacy and never
  // charged), so the drawer shows the choice block in price-only mode instead of a "Precio" field (advisor ruling on
  // portal A — the list shows the choices read-only, so this is where a published choice's price is changed).
  const pg = choiceGroup(state.draft, rowId(it));
  if (pg && pg.options.length) {
    body.append(publishedChoiceBlock(rowId(it), pg));
    for (const g of optionGroups(state.draft)) body.append(groupBlock(g));
    d.append(head, body);
    d.classList.add('show');
    body.scrollTop = keepScroll;
    return;
  }

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

// ── A PUBLISHED group's choices, price-only (advisor ruling on portal A) ──────────────────────────────────────────────
// The approved mock's "Elección requerida" block, applied: the same components as the new-product block (modblock / modgrp /
// mopt / mopr / recpill / mgflag), with the group's structure READ-ONLY — its name, each choice's name, Recomendada — and
// each choice's PRICE editable through the very write the list's price boxes made before the choices were grouped
// (onPrice → setItemPrice on the choice's own key). "Mismo precio para todas" sets every choice to the cheapest current
// price; editing one choice's price turns it off, exactly like the new-product block.
function publishedChoiceBlock(id, g) {
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const block = mk('div', 'modblock');
  block.append(mk('div', 'modh', 'Elección requerida — el cliente elige 1'));
  const grp = mk('div', 'modgrp open');
  const h = mk('div', 'modgrp-h');
  const main = mk('div', 'mgmain');
  const n = g.options.length;
  main.append(mk('span', 'mgname', (typeof g.label === 'string' && g.label.trim()) ? g.label : 'Elección'), mk('span', 'mgsub', `${n} ${n === 1 ? 'opción' : 'opciones'} · define el precio`));
  h.append(main);
  grp.append(h);
  const gb = mk('div', 'mgbody');
  const canBadge = state.choiceBadges.includes('recommended');
  const sameOn = () => (state.samePrice.has(id) ? state.samePrice.get(id) : optionPricesEqual(state.draft, id));
  const inputs = [];
  let cb = null;   // "Mismo precio para todas", created below; a price edit turns it off
  for (const o of g.options) {
    const oid = rowId(o);
    const d = o.display || {};
    const name = typeof d.choice === 'string' && d.choice.trim() ? d.choice : String(oid);
    const row = mk('div', 'mopt');
    const pr = mk('span', 'mopr');
    const pi = document.createElement('input'); pi.type = 'text'; pi.inputMode = 'numeric';
    pi.setAttribute('aria-label', `Precio de ${name}`);
    pi.value = priceText(oid, o.price); pi.placeholder = 'Sin precio';
    focusKey(pi, `price::${oid}`);
    pi.addEventListener('input', bound(() => {
      onPrice('item', oid, pi.value);   // the list boxes' write, on the choice's own key
      holdPriceText(oid, pi.value);
      state.samePrice.set(id, false);
      if (cb) cb.checked = false;
      paint();
    }));
    inputs.push(pi);
    pr.append(mk('span', 'mc', 'L'), pi);
    row.append(mk('span', 'moname ro', name), pr);
    if (canBadge) {
      const on = Array.isArray(d.tags) && d.tags.includes('recommended');
      const pill = document.createElement('button'); pill.className = 'recpill'; if (on) pill.classList.add('recpill-on');
      pill.textContent = 'Recomendada'; pill.type = 'button'; pill.setAttribute('aria-pressed', String(on)); lockControl(pill, true);
      row.append(pill);
    }
    gb.append(row);
  }
  const lab = mk('label', 'mgflag mgflag-same');
  cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sameOn();
  focusKey(cb, 'mgflag-same');
  cb.addEventListener('change', bound(() => {
    state.samePrice.set(id, cb.checked);
    if (!cb.checked) { paint(); return; }   // OFF: the list shows each choice's own price (codex portal-A r2)
    if (cb.checked) {
      const ps = g.options.map((o) => o.price).filter((p) => Number.isInteger(p) && p > 0);
      if (ps.length) { const v = String(Math.min(...ps)); for (const o of g.options) { onPrice('item', rowId(o), v); holdPriceText(rowId(o), ''); } }
      inputs.forEach((pi, i) => { const p = g.options[i].price; pi.value = Number.isInteger(p) && p > 0 ? String(p) : ''; });
      paint();
    }
  }));
  lab.append(cb, document.createTextNode('Mismo precio para todas'));
  gb.append(lab);
  grp.append(gb);
  block.append(grp);
  return block;
}

// ── 1D add-product A — THE "NUEVO PRODUCTO" DRAWER (the approved mock's Phase A subset) ────────────────────────
// Foto (próximamente), Nombre, Descripción, Sección (+ Subsección when the section needs one), Precio, the fiscal
// note from DATA, and Quitar / Listo. NOT here (Phase B or never in A): "Elección requerida", rename / delete / 86 of
// existing products, the mock's scaffolding. Every write goes through the guarded editor (setAddition /
// setItemPrice / removeAddition); nothing below assigns a draft field.
// An unsaved addition is fully editable; a saved-but-unpublished one shows its name and section and keeps only its
// price and Quitar (its key is now the server's).
function renderAddDrawer(d, it, keepScroll) {
  const id = rowId(it);
  const unsaved = isTmpRow(it);
  const disp = it.display || {};
  // the field error after a refused save — copied as PRIMITIVES (a state object never leaves its scope)
  const errOn = !!(state.drawerError && state.drawerError.target === id);
  const errField = errOn && typeof state.drawerError.field === 'string' ? `${state.drawerError.field}` : '';
  const errMsg = errOn && typeof state.drawerError.message === 'string' ? `${state.drawerError.message}` : '';
  const errFor = (field) => (errOn && (errField === field || (!errField && field === 'name')) ? errMsg : null);
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const field = (label, control, errKey) => {
    const f = mk('div', 'fld');
    f.append(mk('label', null, label), control);
    const m = errKey ? errFor(errKey) : null;
    if (m) { f.classList.add('err'); f.append(mk('div', 'ferr', m)); }
    return f;
  };
  const after = () => { refreshBar(); paint(); };

  const head = mk('div', 'dwh');
  const title = mk('div', 'dwt', 'Nuevo producto');
  title.append(mk('span', 'newtag', 'Nuevo'));
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'dwx'; close.textContent = 'Cerrar';
  close.addEventListener('click', () => { state.drawerKey = null; d.classList.remove('show'); });
  head.append(title, close);

  const body = mk('div', 'dwb');
  body.append(field('Foto', mk('div', 'fotosoon', 'Foto: próximamente — por ahora se muestra el emoji de la sección.')));

  const name = document.createElement('input');
  name.type = 'text'; name.value = typeof disp.name === 'string' ? disp.name : ''; name.setAttribute('aria-label', 'Nombre');
  name.disabled = !unsaved;
  name.addEventListener('input', bound(() => { setAddition(state.draft, id, 'name', name.value); after(); }));
  body.append(field('Nombre', name, 'name'));

  const desc = document.createElement('textarea');
  desc.value = typeof disp.desc === 'string' ? disp.desc : ''; desc.setAttribute('aria-label', 'Descripción');
  desc.placeholder = 'Ingredientes, porción…'; desc.disabled = !unsaved;
  desc.addEventListener('input', bound(() => { setAddition(state.draft, id, 'desc', desc.value); after(); }));
  body.append(field('Descripción', desc, 'desc'));

  const row2 = mk('div', 'drow2');
  const sec = document.createElement('select');
  sec.setAttribute('aria-label', 'Sección'); sec.disabled = !unsaved;
  for (const c of categoriesOf()) {
    const catId = String(c && c.id);
    if (!canAddTo(catId)) continue;   // declared AND drawn by the order page
    const o = mk('option', null, categoryName(catId));
    o.value = catId; o.selected = catId === disp.cat;
    sec.append(o);
  }
  sec.addEventListener('change', bound(() => { setAddition(state.draft, id, 'cat', sec.value); state.selectedCat = sec.value; after(); renderDrawer(); }));
  row2.append(field('Sección', sec, 'cat'));
  const prf = mk('div', 'fld pr');
  prf.append(mk('label', null, 'Precio'), mk('span', 'cur2', 'L'));
  const price = document.createElement('input');
  price.type = 'text'; price.inputMode = 'numeric'; price.setAttribute('aria-label', 'Precio');
  price.value = priceText(id, it.price); price.placeholder = 'Sin precio';
  focusKey(price, 'price');
  // 1D add-product B (§0d.5) — with a required choice the product's price belongs to the GROUP: "Mismo precio para todas" on,
  // it sets the product and every option together (setGroupPrice, ONE mutator); off, it is DERIVED (the cheapest option)
  // and shown read-only. Without a group, exactly Phase A.
  const group = choiceGroup(state.draft, id);
  const sameOn = () => (state.samePrice.has(id) ? state.samePrice.get(id) : optionPricesEqual(state.draft, id));
  const optionPriceInputs = [];
  // readOnly, not disabled: syncUi re-enables every drawer input when the draft is handed back, and the handler below is
  // what actually refuses a derived price
  const derivedUi = () => { const d = !!choiceGroup(state.draft, id) && !sameOn(); price.readOnly = d; price.title = d ? 'Se calcula de la opción más barata' : ''; };
  derivedUi();
  price.addEventListener('input', bound(() => {
    if (choiceGroup(state.draft, id)) {
      if (!sameOn()) { const l = (draftSource(state.draft).items || []).find((r) => r && rowId(r) === id); price.value = l && Number.isInteger(l.price) && l.price > 0 ? String(l.price) : ''; return; }
      setGroupPrice(state.draft, id, price.value, state.additionKeys);
      holdPriceText(id, price.value);
      for (const [pi, oid] of optionPriceInputs) { pi.value = price.value; holdPriceText(oid, price.value); }   // in place: a repaint would steal the caret
      refreshBar(); paint();
      return;
    }
    holdPriceText(id, price.value);
    if (unsaved) setAddition(state.draft, id, 'price', price.value); else setItemPrice(state.draft, id, price.value);
    refreshBar(); syncRow('item', id, price.value);
  }));
  prf.append(price);
  if (errFor('price')) { prf.classList.add('err'); prf.append(mk('div', 'ferr', errFor('price'))); }
  row2.append(prf);
  body.append(row2);

  // Subsección — only when the chosen section declares subsections (the server requires one there)
  const cat = categoriesOf().find((c) => c && String(c.id) === String(disp.cat));
  if (cat && Array.isArray(cat.subcats) && cat.subcats.length) {
    const sub = document.createElement('select');
    sub.setAttribute('aria-label', 'Subsección'); sub.disabled = !unsaved;
    const ph = mk('option', null, 'Elegí una subsección'); ph.value = ''; ph.disabled = true; ph.selected = !disp.subcat;
    sub.append(ph);
    for (const sc of cat.subcats) { const o = mk('option', null, String(sc)); o.value = String(sc); o.selected = sc === disp.subcat; sub.append(o); }
    sub.addEventListener('change', bound(() => { setAddition(state.draft, id, 'subcat', sub.value); after(); }));
    body.append(field('Subsección', sub, 'subcat'));
  }

  if (state.usesPlatformFactura) {
    const note = mk('div', 'fiscnote');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
    for (const dd of ['M12 3l7 4v5c0 5-3 8-7 9-4-1-7-4-7-9V7z', 'M9 12l2 2 4-4']) { const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', dd); svg.append(pth); }
    note.append(svg, document.createTextNode('Este precio aparece en la factura fiscal' + ' (SAR) de ' + (state.restaurantName || 'tu restaurante') + ' — el cambio pedirá tu autorización al publicar.'));
    body.append(note);
  }

  // 1D add-product B — "Elección requerida — el cliente elige 1", exactly the approved mock's block. Offered only while the
  // server's platform authoring switch is on, and only on an UNSAVED product (a saved one shows its group, prices editable).
  if ((state.groupAuthoring && unsaved) || group) {
    body.append(choiceBlock({ id, unsaved, group, mk, errOn, errField, errMsg, after, price, sameOn, optionPriceInputs, derivedUi }));
  }

  const foot = mk('div', 'dwf');
  const quitar = document.createElement('button');
  quitar.type = 'button'; quitar.className = 'btn delx'; quitar.textContent = 'Quitar';
  quitar.addEventListener('click', bound(() => {
    removeAddition(state.draft, id, state.additionKeys);
    state.drawerError = null;
    closeDrawer(); repaintFromDraft();
  }));
  const listo = document.createElement('button');
  listo.type = 'button'; listo.className = 'btn accent'; listo.textContent = 'Listo';
  listo.addEventListener('click', bound(() => { state.drawerKey = null; d.classList.remove('show'); paint(); }));
  foot.append(quitar, listo);

  d.append(head, body, foot);
  d.classList.add('show');
  body.scrollTop = keepScroll;
}

// ── 1D add-product B — the "Elección requerida" block of the NEW-product drawer (the approved mock, its Phase B subset) ──
// Ninguna | the product's group. The group header carries its name (editable inline while unsaved) and "N opciones · define el
// precio · en 1 producto"; its body lists the options — name, price, RECOMENDADA (where this brand's picker draws it), × —
// then "Agregar opción", "Mismo precio para todas" and "Sin extras". Every write goes through the guarded editor; nothing
// below assigns a draft field. Structure edits re-render the drawer; typing never does (the caret stays put).
function choiceBlock({ id, unsaved, group, mk, errOn, errField, errMsg, after, price, sameOn, optionPriceInputs, derivedUi }) {
  const svgPath = (dd) => { const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', dd); svg.append(pth); return svg; };
  const newRef = () => `tmp:${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
  const restructure = (keys) => { after(); renderDrawer(); refocus(keys); };
  const errAt = (target, field) => (state.drawerError && state.drawerError.target === target && (!field || state.drawerError.field === field) && typeof state.drawerError.message === 'string' ? `${state.drawerError.message}` : null);
  const block = mk('div', 'modblock');
  block.append(mk('div', 'modh', 'Elección requerida — el cliente elige 1'));
  const radioName = `dwreq-${id}`;

  const none = mk('label', 'modopt');
  const noneIn = document.createElement('input'); noneIn.type = 'radio'; noneIn.name = radioName; noneIn.checked = !group;
  focusKey(noneIn, 'none');
  // Ninguna on ANY new product, saved ones included (§0b.8): the product stays, its group goes
  noneIn.addEventListener('change', bound(() => { if (noneIn.checked) { setRequiredChoice(state.draft, id, false, [], state.additionKeys); state.samePrice.delete(id); state.drawerError = null; restructure(['none', 'price']); } }));
  const noneNm = mk('span', 'mognm', 'Ninguna'); noneNm.append(mk('span', 'mogsub', ' · sin elección obligatoria'));
  none.append(noneIn, noneNm);
  block.append(none);

  // open by default; the chevron folds the options away (view state only)
  state.openGroups = state.openGroups || new Set();
  const foldKey = `choice::${id}`;
  const open = !!group && !state.openGroups.has(foldKey);
  const grp = mk('div', `modgrp${open ? ' open' : ''}`);
  const h = mk('div', 'modgrp-h');
  const attach = mk('label', 'mgattach');
  const onIn = document.createElement('input'); onIn.type = 'radio'; onIn.name = radioName; onIn.checked = !!group; lockControl(onIn, !unsaved);
  focusKey(onIn, 'on');
  onIn.setAttribute('aria-label', 'El cliente elige 1 opción');
  onIn.addEventListener('change', bound(() => { if (onIn.checked) { setRequiredChoice(state.draft, id, true, [newRef(), newRef()]); state.samePrice.delete(id); restructure(['label', 'on']); } }));
  attach.append(onIn);
  const n = group ? group.options.length : 0;
  const sub = group ? `${n} ${n === 1 ? 'opción' : 'opciones'} · define el precio · en 1 producto` : 'el cliente elige 1 opción · define el precio';
  const main = mk('div', 'mgmain');
  if (group && unsaved) {
    // the approved mock's field (portal mockup screen 1): a label above, then the same box as every portal input
    const lab = document.createElement('input');
    lab.type = 'text'; lab.className = 'mgname-in'; lab.value = group.label; lab.placeholder = 'ej. Salsa, Tamaño, Proteína';
    lab.id = `mgname-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    lab.setAttribute('aria-label', 'Nombre de la elección');
    focusKey(lab, 'label');
    lab.addEventListener('input', bound(() => { setGroupLabel(state.draft, id, lab.value); after(); }));
    const lbl = mk('label', 'mgname-lbl', 'Nombre de la elección'); lbl.htmlFor = lab.id;
    h.classList.add('with-in');
    main.append(lbl, lab);
  } else main.append(mk('span', 'mgname', group ? (group.label || 'Elección') : 'Agregar una elección'));
  main.append(mk('span', 'mgsub', sub));
  h.append(attach, main);
  if (group) {
    const fold = document.createElement('button'); fold.className = 'mgchev'; fold.type = 'button';
    fold.setAttribute('aria-label', 'Ver opciones'); fold.setAttribute('aria-expanded', String(open));
    fold.append(svgPath('M9 6l6 6-6 6'));
    focusKey(fold, 'fold');
    fold.addEventListener('click', bound(() => { if (state.openGroups.has(foldKey)) state.openGroups.delete(foldKey); else state.openGroups.add(foldKey); renderDrawer(); refocus(['fold']); }));
    h.append(fold);
  }
  grp.append(h);
  const labelErr = errOn && (errField === 'label' || errField === 'choices' || errField === 'prompt') ? errMsg : null;
  if (labelErr) { grp.classList.add('err'); grp.append(mk('div', 'ferr', labelErr)); }

  if (group && open) {
    const gb = mk('div', 'mgbody');
    const canBadge = state.choiceBadges.includes('recommended');
    for (const o of group.options) {
      const oid = rowId(o);
      const row = mk('div', 'mopt');
      let nm;
      if (unsaved) {
        nm = document.createElement('input'); nm.type = 'text'; nm.className = 'moname'; nm.value = typeof o.display.choice === 'string' ? o.display.choice : '';
        nm.placeholder = 'Nombre de la opción'; nm.setAttribute('aria-label', 'Nombre de la opción');
        focusKey(nm, `name::${oid}`);
        nm.addEventListener('input', bound(() => { setChoiceName(state.draft, oid, nm.value); after(); }));
      } else nm = mk('span', 'moname ro', typeof o.display.choice === 'string' ? o.display.choice : String(oid));
      const pr = mk('span', 'mopr');
      const pi = document.createElement('input'); pi.type = 'text'; pi.inputMode = 'numeric';
      pi.setAttribute('aria-label', `Precio de ${(typeof o.display.choice === 'string' && o.display.choice) || 'la opción'}`);
      pi.value = priceText(oid, o.price); pi.placeholder = 'Sin precio';
      focusKey(pi, `price::${oid}`);
      // ONE option's price: "Mismo precio" turns off (§0d.5) and the product's derived price follows, in place
      pi.addEventListener('input', bound(() => {
        setChoicePrice(state.draft, oid, pi.value, state.additionKeys);
        holdPriceText(oid, pi.value);
        state.samePrice.set(id, false);
        const l = (draftSource(state.draft).items || []).find((r) => r && rowId(r) === id);
        price.value = l && Number.isInteger(l.price) && l.price > 0 ? String(l.price) : ''; derivedUi();
        const same = gb.querySelector('.mgflag-same input'); if (same) same.checked = false;
        refreshBar(); paint();
      }));
      optionPriceInputs.push([pi, oid]);
      pr.append(mk('span', 'mc', 'L'), pi);
      row.append(nm, pr);
      if (canBadge) {
        const on = Array.isArray(o.display.tags) && o.display.tags.includes('recommended');
        const pill = document.createElement('button'); pill.className = 'recpill'; if (on) pill.classList.add('recpill-on');
        pill.textContent = 'Recomendada'; pill.type = 'button'; pill.setAttribute('aria-pressed', String(on)); lockControl(pill, !unsaved);
        focusKey(pill, `pill::${oid}`);
        pill.addEventListener('click', bound(() => { setChoiceRecommended(state.draft, oid, !on); restructure([`pill::${oid}`]); }));
        row.append(pill);
      }
      if (unsaved) {
        const x = document.createElement('button'); x.className = 'model'; x.type = 'button'; x.title = 'Quitar opción'; x.setAttribute('aria-label', 'Quitar opción');
        x.append(svgPath('M18 6L6 18M6 6l12 12'));
        focusKey(x, `x::${oid}`);
        // after a removal: the next option's name, else the previous one's, else "Agregar opción"
        const i = group.options.indexOf(o);
        const near = [group.options[i + 1], group.options[i - 1]].filter(Boolean).map((r) => `name::${rowId(r)}`);
        x.addEventListener('click', bound(() => { removeChoice(state.draft, id, oid); restructure([...near, 'add']); }));
        row.append(x);
      }
      gb.append(row);
      const oErr = errAt(oid);
      if (oErr) { row.classList.add('err'); gb.append(mk('div', 'ferr', oErr)); }
    }
    if (unsaved) {
      const add = document.createElement('button'); add.className = 'mgadd'; add.type = 'button';
      add.append(svgPath('M12 5v14M5 12h14'), document.createTextNode('Agregar opción'));
      focusKey(add, 'add');
      add.addEventListener('click', bound(() => {
        const l = (draftSource(state.draft).items || []).find((r) => r && rowId(r) === id);
        const ref = newRef();
        addChoice(state.draft, id, ref, sameOn() && l && Number.isInteger(l.price) ? String(l.price) : undefined);
        restructure([`name::${ref}`, 'add']);   // straight into the new option's name
      }));
      gb.append(add);
    }
    const flag = (cls, text, checked, disabled, onChange) => {
      const lab = mk('label', `mgflag ${cls}`);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked; lockControl(cb, disabled);
      focusKey(cb, cls);
      cb.addEventListener('change', bound(() => onChange(cb.checked)));
      lab.append(cb, document.createTextNode(text));
      return lab;
    };
    gb.append(flag('mgflag-same', 'Mismo precio para todas', sameOn(), false, (on) => {
      state.samePrice.set(id, on);
      // ON sets every option to the product's current price — the ONE mutator, so it counts once
      if (on) { const l = (draftSource(state.draft).items || []).find((r) => r && rowId(r) === id); setGroupPrice(state.draft, id, l && Number.isInteger(l.price) ? String(l.price) : '', state.additionKeys); for (const o of group.options) holdPriceText(rowId(o), ''); }
      restructure(['mgflag-same']);
    }));
    gb.append(flag('mgflag-extras', 'Sin extras — el cliente no puede agregar opcionales', group.extrasNone, !unsaved, (on) => { setGroupExtrasNone(state.draft, id, on); restructure(['mgflag-extras']); }));
    grp.append(gb);
  }
  block.append(grp);
  return block;
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
  clearReview();
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
    const diff = res && res.diff;
    // 1D add-product A §3 — ADOPT the canonical saved source (allocated keys / ids, canonical order) before the review
    // is built, so what the owner reviews — and every later save — is server truth. The saved additions are now known
    // by key.
    if (res && res.source) {
      adopt(state.draft, res.source);
      for (const a of ((diff && diff.added) || [])) if (a && a.surface === 'item' && typeof a.key === 'string') state.additionKeys.add(a.key);
      state.drawerError = null;
      repaintFromDraft();
    }
    // THE ATTESTATION, gated on the SERVER's capability flag — never on the rid. usesPlatformFactura
    // came back with getEditableCatalog (Task 2b) and is the only thing that decides whether this
    // merchant's edit touches a SAR factura.
    //
    // Computed BEFORE the record is minted, because the record is immutable once it exists — the whole
    // evidence set is fixed at the moment it is created, rather than assembled field by field
    // afterwards where anything could join in.
    const att = attestationModel(diff, { usesPlatformFactura: state.usesPlatformFactura });
    const minted = mintReview({
      diff,
      editToken: res && res.token,
      ackSet: ackSetFrom(diff),
      submitted,                              // what publish will commit as the new baseline
      gen,                                    // the world this review belongs to
      rid: state.draftRid,
      attestation: att,
    }, gen);
    state.review = minted.review;
    liveReview = minted.review;                 // this one, and only until it closes
    // the CAS baseline moves forward: the draft we just wrote is the new precondition
    if (res && res.updateTime) state.sourceUpdateTime = res.updateTime;
    $('revSub').textContent = 'Esto es exactamente lo que cambia en tu menú en vivo.';
    // 🔴 RENDERED FROM THE MINTED RECORD, not from the locals it was built out of. What the merchant
    // reads must be the same object the publish will send — rendering from the pre-freeze originals
    // would leave a second, mutable copy of the evidence alive for as long as this scope is.
    renderReview($('mbody'), reviewModel(state.review.diff), { describe: describeAddition });
    const attBox = document.createElement('div');
    $('mbody').append(attBox);
    // BOUND to this review and this world. Dispatching A's checkbox after B opened must acknowledge
    // nothing — an acknowledgement identifies a person signing one specific reviewed set.
    // Bound AS WELL as runtime-closed. The wrapper stops a stale callback from reaching the setter at
    // all; the closure stops anything that reaches it anyway from signing for the wrong world. Neither
    // depends on the other being correct.
    renderAttestation(attBox, state.review.attestation, bound((v) => {
      minted.acknowledge(v);
      syncUi();
    }), { describe: describeAddition });
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
  // 🔴 …AND NEITHER IS A PUBLISH WHOSE AUTHORITATIVE RELOAD IS STILL OWED (codex build r1 #1/#3). The receipt is up, but
  // the draft on screen is about to be REPLACED by the post-publish source; handing editing back now let an edit land
  // and then be silently overwritten by the reload. Ownership is released by the reload's adoption, never by "Listo".
  if (state.settle) return;
  $('scrim').classList.remove('show');
  clearReview();
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
  // 🔴 IT MUST BE A REVIEW WE MINTED — one check, and it is now the only one needed.
  //
  // A hand-built object with `acknowledged: true` on it is an ordinary data property that no runtime
  // check refuses, because the lock lives on the minted record rather than on the field name. Requiring
  // the brand means forging an attestation takes forging the whole record, and the record cannot be
  // forged: this WeakSet is module-private and nothing adds to it but mintReview.
  //
  // It replaces the two checks that used to stand here — "is there a review" and "does it have an
  // attestation". Both are now implied: has() is false for null, and a minted record always carries an
  // attestation because it is built in one call with one. Narrowing the runtime surface narrowed the
  // checks too, which is the point rather than a side effect.
  if (!mintedReviews.has(state.review)) return;
  // 🔴 ...AND IT MUST BELONG TO NOW. Three separate facts, because they fail in three different ways:
  //
  //   liveReview  — it is still the OPEN review. A closed one was reinstalled from a retained
  //                 reference; closing bumps no generation, so nothing else would have noticed.
  //   gen         — it belongs to THIS world. An auth change or a tenant switch ends the world while a
  //                 signed review is still reachable in a closure somewhere.
  //   rid         — it belongs to the tenant currently loaded, so a review minted for one restaurant
  //                 can never publish against another.
  //
  // An acknowledgement is a person's signature on one specific set at one specific moment. Replaying
  // it is forging a second signature they never gave.
  if (state.review !== liveReview) return;
  // These two are DEFENCE IN DEPTH, and mutation testing says so: removing either alone breaks no
  // test, because every path that ends a world or switches tenant goes through clearReview() and so
  // retires the live review first. They are kept as independent assertions of the two facts liveness
  // currently implies — a bump path added later that forgets to retire would be caught here rather
  // than silently re-opening the replay. Reported as survivors, not carried quietly.
  if (state.review.gen !== opGeneration) return;
  if (state.review.rid !== state.draftRid) return;
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
  clearReview();
  // 1D add-product A §3 — RELOAD the authoritative source and revision before editing resumes: a certified publish
  // writes identity stamps back to the source (so "publish doesn't change the revision" no longer holds), and the
  // published additions stop being additions.
  // 🔴 codex build r1 #1/#3 — THE PUBLISH OWNS THE DRAFT UNTIL THAT RELOAD IS ADOPTED. Not until the receipt is
  // dismissed (that let an edit land and be overwritten), and not on a failed read (that resumed editing on a stale
  // baseline — the reviewed snapshot predates the certified stamps and the canonical allocation). A failure leaves the
  // receipt up with "Publicado; recargá para seguir editando." and a retry of the same authoritative read.
  state.settle = { gen, rid: state.draftRid, lock: state.reviewLock };
  syncUi();
  await settlePublish();
}
// The authoritative post-publish read. Runs under the publish's lock; adopts or reports, nothing in between.
async function settlePublish() {
  const st = state.settle;
  if (!st || st.gen !== opGeneration) return;
  renderSettleFailure(false);
  let fresh = null;
  try { fresh = await apiFetch('getEditableCatalog', { rid: st.rid, token }); } catch (_) { fresh = null; }
  if (state.settle !== st || st.gen !== opGeneration || st.rid !== state.draftRid) return;   // a world that ended
  if (!fresh || !fresh.source) {
    renderSettleFailure(true);
    syncUi();
    return;
  }
  state.draft = createDraft(fresh.source, { canEdit: () => editLockHolder === null });
  state.sourceUpdateTime = fresh.sourceUpdateTime || null;
  state.usesPlatformFactura = fresh.usesPlatformFactura === true;
  applyAddProductFacts(fresh);
  state.settle = null;
  releaseEditLock(st.lock);               // the publish is done AND its result adopted; editing is handed back
  state.reviewLock = null;
  repaintFromDraft();
}
// The recovery state on the receipt: said plainly, with the one action that resolves it.
function renderSettleFailure(on) {
  const body = $('mbody');
  body.replaceChildren(...Array.from(body.children).filter((n) => !(n.dataset && n.dataset.settle === '1')));
  if (!on) { $('revFoot').replaceChildren(PUBBACK); return; }
  const p = document.createElement('p');
  p.className = 'kdswarn'; p.dataset.settle = '1';
  p.textContent = 'Publicado; recargá para seguir editando.';
  $('mbody').append(p);
  const again = document.createElement('button');
  again.type = 'button'; again.className = 'btn accent'; again.textContent = 'Recargar';
  again.addEventListener('click', bound(() => settlePublish()));
  $('revFoot').replaceChildren(PUBBACK, again);
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
    if (id === PUBLISH_ACTIONS.FIX) {
      // 1D add-product A — back to editing, with the new product's drawer open at the field the server named
      $('scrim').classList.remove('show');
      clearReview();
      // ONLY a new product's drawer: a target that names an existing product (or nothing on screen) opens nothing —
      // the field error must never land on a product the owner did not add
      const it = outcome.target ? (draftSource(state.draft).items || []).find((i) => i && rowId(i) === outcome.target) : null;
      if (it && isAddition(it)) {
        state.drawerError = { target: outcome.target, field: outcome.field || null, message: outcome.detail };
        // 1D add-product B — a refusal named on an OPTION opens its product's drawer, the message under that option
        const owner = optionParentId(state.draft, outcome.target);
        const host = owner ? (draftSource(state.draft).items || []).find((i) => i && rowId(i) === owner) : it;
        if (host && host.display && host.display.cat) state.selectedCat = host.display.cat;
        paint(); syncUi();
        openDrawer(owner || outcome.target);
      } else { paint(); syncUi(); }
      return;
    }
    if (id === PUBLISH_ACTIONS.RESET) {
      // 1D add-product A §0.1 — "Volver al menú publicado"
      $('scrim').classList.remove('show');
      clearReview();
      await resetToLive(state.draftRid, state.sourceUpdateTime);
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
  state.settle = null;                     // an owed post-publish reload belongs to the world that ended
  clearReview();
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

// ── P-SELFUPDATE CP2 §3 — the portal's self-update ADAPTER (read-only over this module's state) ───────────────────
// canReload is FALSE while the merchant has unsaved work or the platform holds an operation of theirs:
//   • a request is outstanding (pendingWrite), a publish is in flight, or a review / its lock is open;
//   • the draft differs from what was loaded (pendingCount — a held not-yet-valid price differs too);
//   • a field has focus.
// Otherwise the page reloads at the coordinator's next trigger and re-reads everything from the server. While blocked the
// merchant is told once, plainly: "Nueva versión: guardá tus cambios para actualizar".
function portalReloadFacts() {
  const a = document.activeElement;
  return { pendingWrite: !!pendingWrite, publishing: !!publisher.busy || !!state.settle, review: !!state.review, reviewLock: !!state.reviewLock,
    pendingCount: state.draft ? pendingCount(state.draft, state.additionKeys) : 0, focusedTag: a ? a.tagName : null };
}
try {
  const S = window.SherpaClient;
  if (S && !S.inert) S.registerAdapter({ canReload: () => portalCanReload(portalReloadFacts()), blockedNotice: 'Nueva versión: guardá tus cambios para actualizar' });
} catch (_) { /* the module never breaks the portal */ }
