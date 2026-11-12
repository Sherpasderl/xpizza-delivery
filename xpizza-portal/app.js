// Portal 2b-2a Task 5 — orchestration: sign-in → which restaurants → pick one.
//
// Rendering the menu is Task 6; this resolves WHICH restaurant is in view and keeps that choice.
// Nothing here decides what a merchant may see — every answer comes from the server, and the UI simply
// shows what came back.
import { apiFetch, editCatalog, publishEdited, resetDraftToLive, requestPublish } from './api.js';
import { setExtraName, createDraft, setItemPrice, setExtraPrice, pendingChanges, pendingCount, isPublishable, discard, commit, draftSource, optionGroups, groupUsage, addProduct, setAddition, removeAddition, adopt, rowId } from './editor.js';
// 1D add-product B — the required choice on a NEW product ("Elección requerida — el cliente elige 1")
import { parsePrice } from './editor.js';
import { pendingTexts, loadedName } from './editor.js';   // S4 — the session's unpublished text edits (row tags, the bar); a product's loaded name
// PLAN-public-menu-display T1 — a section's display NAME (owner-approved mockup «Cambiar nombre de sección», 2026-10-25)
import { setCategoryNames, pendingRenames, categoriesUnnamed, categoryNameProblem } from './editor.js';
import { setRequiredChoice, setGroupLabel, setGroupExtrasNone, addChoice, removeChoice, setChoiceName, setChoiceRecommended, setChoicePrice, setGroupPrice, choiceGroup, optionPricesEqual, isNewGroupOption, optionParentId } from './editor.js';
import { groupByCategory, renderRail, renderDetail } from './render.js';
import { movedGroups, reviewModel, ackSetFrom, renderReview, attestationModel, renderAttestation, canPublish, createPublisher, outcomeFor, renderOutcome, receiptFor, renderReceipt, PUBLISH_ACTIONS } from './review.js';
import { token } from './auth.js';
// DISH PHOTOS B (PLAN-dish-photos r2 §3) — the photo state, field, crop step and upload controller
import * as PL from './photo-logic.js';
import * as IE from './item-edit-logic.js';   // S4 «Editar producto»: the drawer's working copy
import { createUploader, photoField, cropStep, rowThumb, rowTag, decodeFile, openPicker } from './photo.js';
import { setPhoto, draftPhotos, origPhotos, pendingPhotos, canEditDraft } from './editor.js';

const $ = (id) => document.getElementById(id);
const REMEMBERED = 'sherpa.portal.rid';

export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null, renderedCategories: [], additionKeys: new Set(), settle: null, savedRenames: [], savedOther: false };

// ── DISH PHOTOS B — per-load photo facts (getEditableCatalog E-P3) and the upload controller ─────────────────────────────
//   enabled   photosEnabled === true (the server's PHOTOS_UPLOADS): the uploader is drawn only then (no control without effect)
//   previews  photoPreviews {[pid]: {card, hero, expiresAt?}} — every pid the draft OR the active version references
//   legacy    legacyPreviews {[itemKey]: {card}} — the image the public menu serves today for a dish with no entry
// A photo upload belongs to a TENANT WORLD (photoWorld), not to an operation generation: opening the review bumps the
// generation, and must not kill an upload; a tenant switch / reload / sign-out ends it.
// Module-private, NOT on the exported `state`: nothing outside this module reads or writes them (portal-wiring's census).
const emptyPhotoFacts = () => ({ enabled: false, previews: {}, legacy: {}, broken: new Set(), retried: new Set(), stale: new Set(), renewTimer: null });
let photo = emptyPhotoFacts();
let photoWorld = 0;
const uploader = createUploader({
  rid: () => state.draftRid,
  token,
  gen: () => photoWorld,
  alive: (w) => w === photoWorld,
  // the ONE write of an uploaded pid, through the guarded editor; refused (→ held, applied on the next repaint) while owned
  apply: (key, pid, preview) => {
    // S4: the edit drawer of this product owns the upload — it lands in the COPY (or nowhere: a replaced binding), never the draft
    if (editSess && !editSess.closed && editSess.key === key) {
      if (preview && typeof preview === 'object') photo.previews[pid] = preview;
      if (editUpload) editUpload.apply(pid);
      return true;
    }
    if (!state.draft || !canEditDraft(state.draft) || renamesPending()) return false;   // ruling A: held, never dropped, beside a name
    if (preview && typeof preview === 'object') photo.previews[pid] = preview;
    setPhoto(state.draft, key, { 'state': 'pid', pid });   // a quoted key: the census reads a bare `state:` as the state object
    scheduleRenew();
    return true;
  },
  changed: (key, what) => photoChanged(key, what),
  decode: decodeFile,
  newOpId: () => `op:${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`,
});

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
// a drawer's top-right close: the approved 32×32 X icon box (aria-label «Cerrar», no text) — ONE builder (ops-dom), shared with photo.js; availability.js's .adwx is the same button + icon('close')
import { closeIcon } from './ops-dom.js';
// STRUCTURE S2: the «Extras» page — its model (a pure reader of the draft) and its DOM
import { extrasPageModel, createGroupForm, createGroupView, setCreateField, settleForm, createGroupOp, extraRowCheck, addExtraRow, addExtraOp, moveGroupOrder, groupOrderTo, groupOrders, extrasOutcomeCtx, deletionRows, rekeyId } from './extras-logic.js';
import { renderExtrasPage, openRemoveConfirm, openDiscardConfirm, renderCreateGroup, renderAttachSheet, openDeletionsReview, enProductos, closeXConfirm } from './extras-view.js';
import { applyExposureOps, mergeDeletionClaim } from './editor.js';

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
// PLAN-portal-shell-no-shift (Codex r3): the catalog READ's own generation — shell.js's recovery (portal:abandon) cancels an
// abandoned load and nothing else; a save / publish in flight always settles, reconciles and runs its authoritative reload.
let readGeneration = 0;

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
  // STRUCTURE S2 (SBS-class defect, P-6 cell): after a locked write the Extras page kept its disabled controls — repaint it when the edit
  // state it was painted under has changed (a no-op otherwise: typing never pays for it)
  if (prodTab === 'xpage' && state.draft && xPaintedCanEdit !== null && xPaintedCanEdit !== canEditDraft(state.draft)) paintProductTabs();
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
    rev.disabled = owned || state.menuLoading === true || !state.draft || !valid || uploader.busy() || state.platformPending === true || copyDirty();
    rev.title = state.platformPending === true ? PLATFORM_COPY.bar : (copyDirty() ? UNSAVED_HINT : ((state.draft && !valid) ? 'Hay un precio sin valor válido' : ''));
  }
  // unsaved edits (frame 1): the WHOLE bar waits while the open product has unsaved edits — «Descartar» too — with one hint
  const dirty = copyDirty();
  const dis = $('discard');
  if (dis) { dis.disabled = dirty; if (dirty) dis.title = UNSAVED_HINT; else dis.removeAttribute('title'); }
  const sp = $('rbar') && $('rbar').querySelector('.rb-sp');
  let hint = sp && sp.querySelector('.mk-rbhint');
  if (sp && !hint && dirty) { hint = document.createElement('span'); hint.className = 'mk-rbhint'; hint.textContent = UNSAVED_HINT; sp.prepend(hint); }
  if (hint) hint.hidden = !dirty;
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
  applyPublishRequestFacts(null);             // T-d — per-load server facts, fail closed (today's path) until they arrive
  state.samePrice = new Map();                // "Mismo precio para todas", per product; DERIVED again on every load
  state.rawPrice = new Map();                 // typed price text that is not (yet) a price, per field (codex PB-3 P2-2)
  invalidateReview();                        // clears tenant-bound state AND bumps the generation
  const gen = opGeneration, rgen = readGeneration;
  state.renameEdit = null;                    // PLAN-public-menu-display T1 — the section title being edited, if any
  state.platformPending = false;              // F-2 — per-load server fact (platform_changes_pending): today's path until it arrives;
  paintPlatformLock();                        //   the shared header lock line goes back NOW, at the transition (a failed load never paints)
  closeNameAll();
  endPhotoWorld();                            // DISH PHOTOS B — uploads and previews belong to the tenant world that is ending
  $('detail').replaceChildren();
  showEmpty('Cargando tu menú…', 'Un momento.');
  let data;
  try {
    data = await apiFetch('getEditableCatalog', { rid, token });
  } catch (e) {
      // THE CHECK COMES FIRST, before ANY mutation. It sat BELOW the two lines that follow, so a slow
      // failure from the tenant the merchant had already left blanked the menu of the tenant they were
      // on — the current rail erased by an error about a different restaurant.
    if (gen !== opGeneration || rgen !== readGeneration) return;
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
  if (gen !== opGeneration || rgen !== readGeneration) return;        // a newer switch won; this response is for a tenant the merchant left
  // The draft carries the boundary: it may be edited only while nobody owns it for a review or a
  // publish. Every mutator asks this, so a retained or detached listener is refused at the state
  // rather than at the DOM.
  state.draft = createDraft(withPhotos((data && data.source) || { items: [], extras: [], structure: {} }, data),
    { canEdit: () => editLockHolder === null && state.platformPending !== true, held: savedHold });
  state.sourceUpdateTime = (data && data.sourceUpdateTime) || null;
  state.usesPlatformFactura = (data && data.usesPlatformFactura) === true;
  applyPhotoFacts(data);                    // DISH PHOTOS B — behind the same generation check
  applyAddProductFacts(data);
  applyPublishRequestFacts(data);           // T-d — behind the same generation check
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
  uploader.flush();                           // DISH PHOTOS B — an upload that finished while the draft was owned lands now
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
  // F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1) — Sherpa wrote fields into this draft that live does not carry yet: the menu is
  // READ-ONLY with the calm notice, and «Volver al menú publicado» is never offered (resetDraftToLive refuses it anyway; the server decides)
  state.platformPending = !!(data && data.platform_changes_pending && typeof data.platform_changes_pending === 'object');
  // 1D add-product B — whether the drawer may OFFER a required choice (the platform authoring switch the save is judged by) and
  // which badges this brand's picker draws on an option. Strictly from the server; absent = off / none.
  state.groupAuthoring = !!(data && data.groupAuthoring === true);
  state.choiceBadges = Array.isArray(data && data.choiceBadges) ? data.choiceBadges.filter((b) => typeof b === 'string') : [];
  // PLAN-public-menu-display T1 (Codex r1 #3) — what the SAVED draft already has pending against the PUBLISHED menu (server
  // truth), so «a rename publishes alone» survives a reload, a branch switch and «Enviar al dueño». Absent = nothing.
  state.savedRenames = Array.isArray(data && data.pendingRenames) ? data.pendingRenames.filter((r) => r && typeof r.id === 'string') : [];
  state.savedOther = !!(data && data.pendingOther === true);
  // S4 (S2-DESIGN §1.1) — the text-edit switch (absent / not true = today's drawer), the names a rename may not take (already
  // normalized by the server; absent = the C5 check waits for «Guardar»), and the SAVED draft's unpublished text edits
  state.textEditEnabled = !!(data && data.textEditEnabled === true);
  // STRUCTURE S1 (R5): the server's per-product extras switch; absent ⇒ OFF — the checklist and «Sin extras» stay dark
  state.extrasAuthoring = !!(data && data.extrasAuthoring === true);
  // advisor Q8 (11-11): whether the server serves the Extras page (getEditableCatalog extrasCatalog); absent ⇒ OFF — S1's «Opciones» line
  state.extrasCatalog = !!(data && data.extrasCatalog === true);
  // STRUCTURE S2 (§3.4, P-1): the deletion baseline the save checks a removal claim against — served verbatim, null when unreadable
  const db0 = data && data.deletionBase;
  state.deletionBase = db0 && typeof db0 === 'object' && typeof db0.version === 'string' && Number.isInteger(db0.generation) ? { version: db0.version, generation: db0.generation } : null;
  state.reservedNames = state.textEditEnabled && data && Array.isArray(data.reservedNames) ? data.reservedNames.filter((n) => typeof n === 'string') : null;
  state.savedTexts = Array.isArray(data && data.pendingTexts) ? data.pendingTexts.filter((t) => t && typeof t.key === 'string' && Array.isArray(t.fields)) : [];
}
// PLAN-portal-team-invites T-d — the two per-load facts of «Enviar al dueño para publicar», strictly from the server:
//   publish_via_request  this caller SENDS the draft to the owner instead of publishing (getEditableCatalog decides it with the
//                        predicate catalogRequestPublish enforces); absent = today's path. Only the review-bar CTA reads it.
//   publish_request      the owner's pending request (fresh / draft_changed), handed to pubreq.js for the banner + the badge.
function applyPublishRequestFacts(data) {
  state.publishViaRequest = !!(data && data.publish_via_request === true);
  $('review').textContent = state.publishViaRequest ? 'Enviar al dueño para publicar' : 'Revisar y publicar';
  const request = data && data.publish_request && typeof data.publish_request === 'object' ? data.publish_request : null;
  document.dispatchEvent(new CustomEvent('portal:publish-request', { detail: { request } }));
}
// ── DISH PHOTOS B (PLAN-dish-photos r2 §2.2 E-P3 + amendments 2026-10-27) — the photo facts and their surfaces ─────────
const objOrEmpty = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// The draft map arrives as E-P3 `photos` and lives IN the document as `source.photos`, so every save sends it back whole
// (an unchanged stored map always passes with uploads off). Empty or absent: the source is left exactly as it came.
function withPhotos(source, data) {
  const map = objOrEmpty(data && data.photos);
  if (Object.keys(map).length && source && typeof source === 'object') source.photos = JSON.parse(JSON.stringify(map));
  return source;
}
function applyPhotoFacts(data) {
  if (photo.renewTimer) clearTimeout(photo.renewTimer);
  photo = emptyPhotoFacts();
  photo.enabled = !!(data && data.photosEnabled === true);
  photo.previews = { ...objOrEmpty(data && data.photoPreviews) };
  photo.legacy = { ...objOrEmpty(data && data.legacyPreviews) };
  scheduleRenew();
}
// A tenant world ends (switch, reload, sign-out): its uploads are aborted and its previews forgotten.
function endPhotoWorld() {
  photoWorld += 1;
  uploader.abortAll();
  if (photo.renewTimer) clearTimeout(photo.renewTimer);
  photo = emptyPhotoFacts();
}
// The row's photo as the screen shows it; an image that failed to load (after its one renewal) is a missing preview —
// visible as such, never a broken image.
function photoViewOf(key, photos = null) {
  // legacy images are shown (row / drawer) only with uploads ON: E-P3 sends legacyPreviews whatever the flag, and the dark
  // portal must look exactly as today; the review still reads them (a stored map's lines need the true «nueva / cambiada»)
  const v = PL.photoView(key, { photos: photos || draftPhotos(state.draft), orig: origPhotos(state.draft), previews: photo.previews, legacy: photo.enabled ? photo.legacy : {} });
  // a picture that cannot be shown: a legacy image, or an upload whose renewal had nothing newer (codex r1 #2: an unsaved pid
  // is not in E-P3), keeps the NEUTRAL frame — still a photo; a pid the server no longer serves is MISSING (P5, a new upload)
  if (v.url && (photo.broken.has(v.url) || (v.pid && photo.stale.has(v.pid) && previewExpired(v.pid)))) {
    if (v.kind !== 'photo') return { ...v, url: null };
    return v.legacy || (v.pid && photo.stale.has(v.pid)) ? { ...v, url: null, neutral: true, missing: false } : { ...v, url: null, missing: true };
  }
  return v;
}
const previewExpired = (pid) => { const e = PL.expiryMs(photo.previews[pid] && photo.previews[pid].expiresAt); return e !== null && Date.now() >= e; };
// A photo's STABLE identity for its picture URL(s) — the pid, or the legacy dish key — so "one retry" is per photo, not per
// signed URL (each renewal mints a new one; codex r1 #3)
function photoIdOfUrl(url) {
  for (const [pid, p] of Object.entries(photo.previews)) if (p && (p.card === url || p.hero === url)) return `pid:${pid}`;
  for (const [k, l] of Object.entries(photo.legacy)) if (l && l.card === url) return `legacy:${k}`;
  return `url:${url}`;
}
function urlOfPhotoId(id) {
  if (id.startsWith('pid:')) { const pid = id.slice(4); const p = photo.previews[pid]; const u = p && typeof p.card === 'string' ? p.card : null; return u && !photo.broken.has(u) && !(photo.stale.has(pid) && previewExpired(pid)) ? u : null; }
  if (id.startsWith('legacy:')) { const l = photo.legacy[id.slice(7)]; const u = l && typeof l.card === 'string' ? l.card : null; return u && !photo.broken.has(u) ? u : null; }
  return null;
}
const photoNameOf = (key) => {
  const it = ((draftSource(state.draft) || {}).items || []).find((i) => i && rowId(i) === key);
  const n = it && it.display && typeof it.display.name === 'string' && it.display.name.trim() ? it.display.name : null;
  return n || (typeof key === 'string' && key.startsWith('tmp:') ? 'Nuevo producto' : String(key));
};
// render.js asks per row: today's placeholder (null) unless uploads are on or the dish has a photo to show
function rowPhoto(it, { name, open, upload }) {
  const v = photoViewOf(rowId(it));
  const enabled = photo.enabled && state.platformPending !== true;   // F-2: a photo is content like a price — read-only while Sherpa updates
  if (!enabled && !(v.kind === 'photo' && (v.url || v.neutral))) return null;
  return { thumb: rowThumb({ view: v, name, enabled, onOpen: open, onUpload: upload, onImgError: onPhotoImgError }), tag: rowTag(v) };
}
// P2 — choosing a photo for one product. `capture` null = the zone / the row camera: on a phone that EXPANDS the zone in place
// into «Tomar foto» / «Elegir de la galería» (the mockup's P1 cajón → P2 at 390); elsewhere it opens the system picker.
// true / false = those two buttons. Synchronous from the click, so the browser treats the picker as the user's gesture.
let photoExpandedKey = null;
const isPhone = () => !!(typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 560px)').matches);
function pickPhoto(key, capture) {
  if (!photo.enabled || !state.draft || !canEditDraft(state.draft) || renamesPending()) return;   // ruling A: a rename publishes alone
  if (capture === null && isPhone() && photoExpandedKey !== key) { photoExpandedKey = key; renderDrawer(); return; }
  openPicker((file) => { photoExpandedKey = null; uploader.take(key, file); }, { capture: capture === true });
}
// The controller's "something changed for this product": the bar in place for progress (no rebuild under the pointer),
// otherwise the open drawer, the rows and the bar from the draft.
function photoChanged(key, what) {
  if (what === 'progress') {
    const job = uploader.jobOf(key);
    const bar = state.drawerKey === key ? $('drawer').querySelector('.phbar') : null;
    if (job && bar) { const pct = Math.round((job.progress || 0) * 100); bar.setAttribute('aria-valuenow', String(pct)); const i = bar.querySelector('i'); if (i) i.style.width = `${pct}%`; }
    return;
  }
  if (editSess && editSess.key === key && editUpload) { const j = uploader.jobOf(key); if (j && j.phase === 'failed') editUpload.failed(); }
  if (state.drawerKey === key && $('drawer').classList.contains('show')) renderDrawer();
  if (state.draft) { paint(); refreshBar(); }
}
// The drawer's «Foto» field for a product, or null (uploads off and no photo: the drawer exactly as today).
// `sess`: an S4 edit drawer's working copy — «Quitar» / «Deshacer» / a retried upload then change the COPY, never the draft.
function photoFieldFor(it, sess = null) {
  const key = rowId(it);
  const name = photoNameOf(key);
  const job = uploader.jobOf(key);
  const setEntry = (entry) => { if (sess) { IE.set(sess, 'photo', entry); photoChanged(key); } else { setPhoto(state.draft, key, entry); photoChanged(key); } };
  return photoField({
    name, view: photoViewOf(key, sess ? editPhotos(sess) : null), job, enabled: photo.enabled, expanded: photoExpandedKey === key && isPhone(), held: renamesPending(),
    onPick: bound((capture) => pickPhoto(key, capture)),
    onRemove: bound(() => {
      uploader.clear(key);
      setEntry(PL.removedEntry(key, { orig: origPhotos(state.draft), legacy: photo.legacy }));
    }),
    onUndo: bound(() => setEntry(PL.undoEntry(key, { orig: origPhotos(state.draft) }))),
    // P5: the same upload again; a preview the server could not give (a pid it cannot show) needs a new file
    onRetry: bound(() => {
      if (renamesPending()) return;
      const j = uploader.jobOf(key);
      if (j && j.phase === 'failed') { if (sess && !sess.closed) { editUpload = IE.uploadBinding(sess); editUpload.started(); } uploader.retry(key); } else pickPhoto(key, null);
    }),
    // S4: in an edit drawer the stop also frees the copy («Guardar» no longer waits for an upload that will never land)
    onCancel: bound(() => { if (sess) { IE.stopUpload(sess); editUpload = null; } uploader.cancel(key); }),
    onImgError: onPhotoImgError,
    ...(sess ? { stopLabel: IE.COPY.photoStop } : {}),   // S4 (owner 11-10): «Detener subida» beside the drawer's own «Cancelar»
  });
}
// P3 — «Ajustar foto», the drawer's own step: Cancelar / Cerrar discard the file and upload nothing; Listo uploads.
function renderCropDrawer(d, it, job) {
  const key = rowId(it);
  const disp = it.display || {};
  const { head, body, foot } = cropStep({
    job, name: photoNameOf(key), desc: typeof disp.desc === 'string' ? disp.desc : '',
    priceText: Number.isInteger(it.price) && it.price > 0 ? `L ${it.price}` : '',
    onFrame: bound((id) => uploader.setFrame(key, id)),
    onView: (id, v) => uploader.setView(key, id, v),
    onCancel: bound(() => uploader.cancel(key)),
    onDone: bound(() => {
      if (renamesPending()) return;
      // S4: an upload started inside an edit drawer belongs to its working copy (session-bound: a cancelled or replaced drawer never takes it)
      if (editSess && !editSess.closed && editSess.key === key) { editUpload = IE.uploadBinding(editSess); editUpload.started(); }
      uploader.upload(key);
    }),
    onClose: bound(() => requestClose(() => { state.drawerKey = null; endEditSession(); uploader.cancel(key); d.classList.remove('show'); d.replaceChildren(); })),
  });
  d.replaceChildren(head, body, foot);
  d.classList.add('show');
}
// What the review (P8) and the seal need to show a photo line: the dish's name, the card URL of a state, and which dishes
// have a legacy image (that decides «Foto nueva» vs «Foto cambiada»).
function photoReviewOpts() {
  return {
    nameOf: photoNameOf,
    legacy: photo.legacy,
    urlOf: (st, key) => urlOfPhotoId(st && st.kind === 'pid' ? `pid:${st.pid}` : `legacy:${key}`),
    onImgError: onPhotoImgError,
  };
}
// ── preview renewal (§2.2 E-P3): a background re-read, never on the paint path. It merges PREVIEWS only — the draft on screen
// is the merchant's and is never replaced by a renewal.
function scheduleRenew() {
  if (photo.renewTimer) { clearTimeout(photo.renewTimer); photo.renewTimer = null; }
  if (!state.draft) return;
  // a pid a renewal could not extend is never scheduled again (codex r1 #2: no zero-delay loop); it falls back to the frame
  const pids = Object.values(draftPhotos(state.draft)).filter((e) => e && e.state === 'pid' && !photo.stale.has(e.pid)).map((e) => e.pid);
  const ms = PL.renewIn(photo.previews, pids, Date.now());
  if (ms === null) return;
  const w = photoWorld;
  const t = setTimeout(() => { if (w === photoWorld) refreshPreviews(); }, Math.min(ms, 2147483647));
  if (t && typeof t.unref === 'function') t.unref();
  photo.renewTimer = t;
}
async function refreshPreviews() {
  const rid = state.draftRid;
  const w = photoWorld;
  if (!rid) return;
  let fresh = null;
  try { fresh = await apiFetch('getEditableCatalog', { rid, token }); } catch (_) { fresh = null; }
  if (w !== photoWorld || rid !== state.draftRid || !fresh) return;
  const got = objOrEmpty(fresh.photoPreviews);
  // E-P3's `photos` is the SAVED draft map: it says which pids the server knows (codex r2 #3)
  const saved = new Set(Object.values(objOrEmpty(fresh.photos)).filter((e) => e && e.state === 'pid').map((e) => e.pid));
  const now = Date.now();
  for (const e of Object.values(draftPhotos(state.draft))) {
    if (!e || e.state !== 'pid') continue;
    const g = got[e.pid];
    const exp = g ? PL.expiryMs(g.expiresAt) : null;
    if (!g && saved.has(e.pid)) {
      // a SAVED pid the server no longer serves (§2.2 E-P3: deleting / deleted): MISSING — P5 and its re-upload, never the frame
      delete photo.previews[e.pid];
      photo.stale.delete(e.pid);
    } else if (!g || (exp !== null && exp - PL.RENEW_EARLY_MS <= now)) {
      // an UNSAVED upload (E-P3 knows only the saved draft), or a preview the read did not extend: STALE — no more renewals,
      // the neutral frame once its picture fails or expires (codex r1 #2)
      photo.stale.add(e.pid);
    } else photo.stale.delete(e.pid);
  }
  Object.assign(photo.previews, got);
  photo.legacy = { ...photo.legacy, ...objOrEmpty(fresh.legacyPreviews) };
  photo.broken.clear();
  scheduleRenew();
  if (state.draft) paint();
  if (state.drawerKey && $('drawer').classList.contains('show')) renderDrawer();
  renewReviewThumbs();
}
// codex r1 #4 — the OPEN review (P8) keeps its nodes, its record and the fiscal acknowledgement: only each thumbnail's picture
// is replaced in place (matched by its photo identity, data-ph), with a fresh one-shot error listener; no URL → the frame.
function renewReviewThumbs() {
  for (const img of $('mbody').querySelectorAll('img[data-ph]')) {
    const u = urlOfPhotoId(img.dataset.ph);
    if (!u) { img.remove(); continue; }
    if (img.getAttribute('src') !== u) img.setAttribute('src', u);   // its one identity-bound handler (review.js) stays
  }
}
// An image that fails to load: ONE renewal read PER PHOTO (its pid / legacy key — codex r1 #3); a second failure of the same
// photo, whatever its URL, re-reads nothing and leaves it shown as missing / the frame.
function onPhotoImgError(url, identity) {
  if (!url || photo.broken.has(url)) return;
  const id = identity || photoIdOfUrl(url);
  photo.broken.add(url);
  if (photo.retried.has(id)) { if (state.draft) paint(); if (state.drawerKey && $('drawer').classList.contains('show')) renderDrawer(); renewReviewThumbs(); return; }
  photo.retried.add(id);
  refreshPreviews();
}
// A NEW product: still unsaved (a temporary reference), or saved but not yet published (the server said so).
const isTmpRow = (it) => !!(it && typeof it.ref === 'string' && it.ref.startsWith('tmp:') && !('key' in it));
function isAddition(it) {
  return isTmpRow(it) || !!(it && typeof it.key === 'string' && state.additionKeys && state.additionKeys.has(it.key));
}
const canAddTo = (catId) => state.renderedCategories.includes(catId);   // always an array: declared [] and set from data
const categoriesOf = () => { const st = (draftSource(state.draft) || {}).structure || {}; return Array.isArray(st.categories) ? st.categories : []; };
// ── PLAN-public-menu-display T1 — A SECTION'S NAME ──────────────────────────────────────────────────────────────────────
// A RENAME PUBLISHES ALONE (server: rename_not_alone). The two sides are kept apart HERE, where the merchant can still see
// why: with prices / new products pending the rename control is off (mockup R3); with a name change pending prices and
// «Agregar producto» are off (R3b). The client sees only this session's draft — a saved draft that already mixes them is
// refused by the server with its own designed panel (R4).
// LOCAL (this session's draft) OR SAVED (the server's pendingRenames / pendingOther / pendingAdditions — Codex r1 #3): the
// exclusion holds against the PUBLISHED menu, not against whatever baseline this screen loaded or last sent.
const renamesPending = () => !!state.draft && (pendingRenames(state.draft).length > 0 || state.savedRenames.length > 0);
const othersPending = () => !!state.draft && (pendingCount(state.draft, state.additionKeys) > 0 || state.savedOther === true || (state.additionKeys && state.additionKeys.size > 0) || uploader.active());   // ruling A: an open upload is a pending photo
// the same SAVED half, handed to the draft so its state boundary refuses the other side (editor.js canEditContent)
function savedHold() {
  if (state.savedRenames.length) return 'names';
  if (state.savedOther === true || (state.additionKeys && state.additionKeys.size > 0)) return 'prices';
  return null;
}
const RENAME_NOTICE = {
  // owner-approved MOCKUP-portal-photos-held-state.html (2026-11-01): photos count too — H3 is not only prices, H1 locks photos
  others: 'Hay cambios sin publicar. Un cambio de nombre se publica solo: publicá o descartá esos cambios primero.',
  renames: 'Hay un cambio de nombre esperando publicarse. Publicalo o descartalo para seguir editando precios, fotos o agregando productos.',
};
const isDeclaredCategory = (id) => categoriesOf().some((c) => c && String(c.id) === String(id));
const declaredName = (id) => { const c = categoriesOf().find((x) => x && String(x.id) === String(id)); return (c && typeof c.name === 'string') ? c.name : ''; };
function renameStart(catId) {
  if (state.platformPending === true) return;   // F-2: refused at admission while Sherpa updates (the control is not drawn)
  if (!state.draft || othersPending() || categoriesUnnamed(state.draft) || !isDeclaredCategory(catId)) return;
  state.renameEdit = { catId: String(catId) };
  paint();
}
function renameSave(catId, value) {
  if (state.platformPending === true) return;   // F-2: refused at admission while Sherpa updates
  if (!state.draft || othersPending() || categoryNameProblem(value) !== null) return;
  setCategoryNames(state.draft, [[catId, value]]);
  state.renameEdit = null;
  repaintFromDraft();
  if (state.drawerKey) { renderDrawer(); holdDrawerForRename(); }   // a drawer open BEFORE the rename locks too (Codex r1 #2)
}
function renameCancel() {
  state.renameEdit = null;
  paint();
}
// The R1c callout: shown only while NO section has a name — then they are named together (R2b), never one at a time.
function paintNameCall() {
  const host = $('seccall');
  if (!host) return;
  const show = !!state.draft && categoriesUnnamed(state.draft);
  host.classList.toggle('hidden', !show);
  host.replaceChildren();
  if (!show) return;
  const ic = document.createElement('div');
  ic.className = 'seccallic';
  ic.append(pencilIcon());
  const tx = document.createElement('div');
  tx.className = 'seccalltx';
  const b = document.createElement('b');
  b.textContent = 'Tus secciones todavía no tienen nombre';
  const sp = document.createElement('span');
  sp.textContent = 'En el portal se muestran por su código. Se nombran todas juntas, de una vez.';
  tx.append(b, sp);
  const callBtn = document.createElement('button');
  callBtn.type = 'button'; callBtn.className = 'btn';
  callBtn.append(pencilIcon(), document.createTextNode('Ponerles nombre'));
  if (othersPending()) callBtn.disabled = true;
  else callBtn.addEventListener('click', bound(openNameAll));
  host.append(ic, tx, callBtn);
}
function pencilIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z']) { const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', d); svg.append(pth); }
  return svg;
}
// R2b — every section in its order, its id as a hint, one field each; «Guardar nombres» only when every field is a name.
function openNameAll() {
  if (!state.draft || othersPending() || !categoriesUnnamed(state.draft)) return;
  const modal = $('namemodal');
  if (!modal) return;
  modal.replaceChildren();
  const mh = document.createElement('div'); mh.className = 'mh';
  const mt = document.createElement('div'); mt.className = 'mt'; mt.id = 'nameTitle'; mt.textContent = 'Ponerles nombre a tus secciones';
  const ms = document.createElement('div'); ms.className = 'ms'; ms.textContent = 'Se nombran todas juntas: el menú lleva nombre en todas sus secciones o en ninguna.';
  mh.append(mt, ms);
  const mb = document.createElement('div'); mb.className = 'mb mscroll';
  const inputs = [];
  categoriesOf().forEach((c, i) => {
    if (!c) return;
    const f = document.createElement('div'); f.className = 'fld secnm';
    const hint = document.createElement('div'); hint.className = 'secnmid';
    const k = document.createElement('span'); k.className = 'secnmk'; k.textContent = String(i + 1);
    hint.append(k, document.createTextNode(String(c.id)));
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.maxLength = 40; nameIn.placeholder = 'Nombre de la sección'; nameIn.autocomplete = 'off';
    nameIn.setAttribute('aria-label', `Nombre de la sección ${c.id}`);
    nameIn.addEventListener('input', () => sync());
    f.append(hint, nameIn);
    mb.append(f);
    inputs.push([String(c.id), nameIn]);
  });
  const mf = document.createElement('div'); mf.className = 'mf';
  const note = document.createElement('span'); note.className = 'secmfnote';
  const nameCancel = document.createElement('button'); nameCancel.type = 'button'; nameCancel.className = 'btn ghost'; nameCancel.textContent = 'Cancelar';
  const nameSave = document.createElement('button'); nameSave.type = 'button'; nameSave.className = 'btn accent'; nameSave.textContent = 'Guardar nombres';
  mf.append(note, nameCancel, nameSave);
  function sync() {
    const missing = inputs.filter(([, inp]) => categoryNameProblem(inp.value) !== null).length;
    note.textContent = missing === 0 ? '' : (missing === 1 ? 'Falta 1 nombre' : `Faltan ${missing} nombres`);
    nameSave.disabled = missing > 0;
  }
  nameCancel.addEventListener('click', () => closeNameAll());
  nameSave.addEventListener('click', bound(() => {
    if (othersPending() || inputs.some(([, inp]) => categoryNameProblem(inp.value) !== null)) return;
    setCategoryNames(state.draft, inputs.map(([id, inp]) => [id, inp.value]));
    closeNameAll();
    repaintFromDraft();
    if (state.drawerKey) { renderDrawer(); holdDrawerForRename(); }
  }));
  modal.append(mh, mb, mf);
  sync();
  $('namescrim').classList.add('show');
  if (inputs.length) inputs[0][1].focus();
}
function closeNameAll() {
  const scrim = $('namescrim');
  if (scrim) scrim.classList.remove('show');
  const modal = $('namemodal');
  if (modal) modal.replaceChildren();
}
// R3 — prices are edited WITHOUT a repaint (the caret must stay), so the rename side follows in place: «Cambiar nombre» and
// «Ponerles nombre» go off, and the slim reason appears under the section header, the moment a price becomes pending (and
// come back when it is undone). A pending NAME repaints anyway (Guardar), so it is painted, not synced.
function syncRenameHold() {
  if (!state.draft || renamesPending()) return;
  const hold = othersPending();
  for (const b of document.querySelectorAll('#detail .secren, #seccall .btn')) b.disabled = hold;
  const head = document.querySelector('#detail > .dhead');
  const note = document.querySelector('#detail > .secnote');
  const wants = hold && !!head && (!!document.querySelector('#detail .secren') || categoriesUnnamed(state.draft));
  if (wants && !note) head.after(renameNote(RENAME_NOTICE.others));
  if (!wants && note) note.remove();
}
function renameNote(text) {
  const n = document.createElement('div');
  n.className = 'secnote';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const pth = document.createElementNS(NS, 'path');
  pth.setAttribute('d', 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4');
  svg.append(pth);
  const t = document.createElement('span');
  t.textContent = text;
  n.append(svg, t);
  return n;
}
// R3b — the drawer follows the list: while a name change waits, its fields are off too (Cerrar stays).
function holdDrawerForRename() {
  // the held-state mockup: the hold's locked controls are DIMMED like the list's prices (styles.css #drawer.namehold …:disabled);
  // the class itself is synced in ONE place, paint() (Codex r1)
  if (!renamesPending() && state.platformPending !== true) return;   // F-2: the same hold while Sherpa updates the menu
  for (const c of $('drawer').querySelectorAll('input, textarea, select')) lockControl(c, true);
  // ruling A — the «Foto» field's controls too (zone, Cambiar / Quitar, Reintentar, Deshacer); a photo is content like a price
  // …except a held upload's «Cancelar» (data-held): its way out (Codex r1 #1)
  for (const c of $('drawer').querySelectorAll('button.uploader, .phph2b button, .phacts button, .pherr button, .phrm button')) if (!c.closest('[data-held]')) lockControl(c, true);
}
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
  if (!state.draft || !canAddTo(catId) || renamesPending()) return;   // R3b: a name change travels alone
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
  // F-2 (mockup N2) — the server refused because Sherpa is updating this menu: the designed panel, and the screen behind it
  // becomes the read-only notice (a stale page that still showed the reset offer)
  if (failed && failed.code === 'platform_changes_pending') {
    state.platformPending = true;
    paint(); refreshBar();
    showOutcome(outcomeFor(failed, 'edit'));
    $('scrim').classList.add('show');
    syncUi();
    return;
  }
  if (failed) {
    const [t, d] = messageFor(failed);
    showEmpty(t, d);
    syncUi();
    return;
  }
  await loadMenu(rid);
}
// F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1, N1 / P1) — the portal's own quiet callout, no button: nothing for the merchant to do
export const PLATFORM_COPY = Object.freeze({
  title: 'Sherpa está actualizando tu menú',
  body: 'Estamos actualizando cómo se ve tu menú. Mientras tanto podés verlo, pero no guardar ni publicar cambios. Si necesitás cambiar un precio ya, escribinos.',
  bar: 'Publicar se habilita cuando Sherpa termine.',
  lock: 'Solo lectura mientras Sherpa actualiza',
});
function offerPlatformNotice(host) {
  const c = document.createElement('div');
  c.className = 'callout calloutquiet1b';
  c.setAttribute('role', 'status');
  const ns = 'http://www.w3.org/2000/svg';
  const v = document.createElementNS(ns, 'svg'); v.setAttribute('viewBox', '0 0 24 24'); v.setAttribute('aria-hidden', 'true');
  const ci = document.createElementNS(ns, 'circle'); ci.setAttribute('cx', '12'); ci.setAttribute('cy', '12'); ci.setAttribute('r', '9');
  const pa = document.createElementNS(ns, 'path'); pa.setAttribute('d', 'M12 11v5M12 8h.01');
  v.append(ci, pa);
  const t = document.createElement('div');
  const b = document.createElement('b'); b.textContent = `${PLATFORM_COPY.title}.`;
  t.append(b, document.createTextNode(` ${PLATFORM_COPY.body}`));
  c.append(v, t);
  host.prepend(c);
}
// the header lock the read-only menu already uses (#menulock), with this state's own line; restored when the state ends
let menulockText = null;
function paintPlatformLock() {
  const lock = $('menulock');
  const label = lock && lock.querySelector('.lock');
  if (!label) return;
  const text = Array.from(label.childNodes).find((n) => n.nodeType === 3);
  if (state.platformPending) {
    if (menulockText === null) menulockText = text ? text.nodeValue : '';
    if (text) text.nodeValue = PLATFORM_COPY.lock; else label.append(document.createTextNode(PLATFORM_COPY.lock));
    lock.classList.remove('hidden');
  } else if (menulockText !== null) {
    if (text) text.nodeValue = menulockText;
    menulockText = null;
    lock.classList.add('hidden');
  }
}

function offerResetToLive(host, rid, rev) {
  const box = document.createElement('div');
  box.className = 'unpub';
  const p = document.createElement('p');
  p.textContent = 'Tu borrador guardado no se puede publicar tal como está. Podés volver al menú publicado y aplicar tus cambios de nuevo.';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button'; resetBtn.className = 'btn accent'; resetBtn.textContent = 'Volver al menú publicado';
  resetBtn.addEventListener('click', bound(() => requestClose(() => resetToLive(rid, rev))));   // unsaved edits: ask first
  box.append(p, resetBtn);
  host.prepend(box);
}

// The review bar states the count in the merchant's own terms and gates the way forward. It is the
// only place "you have unpublished work" is said, so it must never say it when the draft matches what
// is published — and never stay silent when it does not.
function refreshBar() {
  const renames = pendingRenames(state.draft).length;   // PLAN-public-menu-display T1 — a section name is a change too
  const n = pendingCount(state.draft, state.additionKeys) + renames;
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
    : (n === 1 ? '1 cambio sin publicar' : `${n} cambios sin publicar`) + (renames && renames === n ? (n === 1 ? ' · nombre de sección' : ' · nombres de sección') : '');
  // DISH PHOTOS B (P7) — «1 cambio sin publicar · 1 foto»: the photo share of the count, said where the count is
  const nPhotos = state.draft ? pendingPhotos(state.draft).length : 0;
  if (nPhotos) { const sfx = document.createElement('span'); sfx.textContent = PL.COPY.barSuffix(nPhotos); $('rbtxt').append(sfx); }
  // X4 (MOCKUP x4) — «1 cambio sin publicar · 1 grupo»: the groups that moved, by the review's own «Orden» rule
  const go = n > 0 && state.draft ? groupOrders(state.draft) : null;
  const nGroups = go ? movedGroups(go.was, go.now).length : 0;
  if (nGroups) { const sfx = document.createElement('span'); sfx.textContent = ` · ${nGroups} ${nGroups === 1 ? 'grupo' : 'grupos'}`; $('rbtxt').append(sfx); }
  // S4 (mockup B) — «1 cambio sin publicar · 1 producto»: the products with unpublished text, said where the count is
  const nTexts = n > 0 ? textEditedKeys().size : 0;
  if (nTexts) { const sfx = document.createElement('span'); sfx.textContent = ` · ${nTexts} ${nTexts === 1 ? 'producto' : 'productos'}`; $('rbtxt').append(sfx); }
  // T-d (mockup v8 D2): who publishes, said where the merchant decides — text only
  if (state.publishViaRequest) { const note = document.createElement('span'); note.textContent = ' · el dueño confirma y publica con la autorización fiscal'; $('rbtxt').append(note); }
  // Nothing typed, nothing to throw away. The review is the way forward here; discard would be a
  // control that looks live and does nothing.
  $('discard').classList.toggle('hidden', n === 0);
  if (state.platformPending === true) { $('rbtxt').textContent = PLATFORM_COPY.bar; $('discard').classList.add('hidden'); }   // F-2: the reason, said where the action is
  syncRenameHold();                          // PLAN-public-menu-display T1 — a typed price turns the rename control off, in place
  // A price we cannot vouch for blocks the way forward — HERE, where the merchant can still see which
  // row it is, rather than at the server after the review and the attestation. The RULE lives here; the
  // BUTTON is painted by syncUi, which also knows whether an operation currently owns the draft. Two
  // opinions about one control is what made the entry die after a single use.
  syncUi();
}

function onPrice(surface, key, value) {
  if (renamesPending()) return;                // R3b: a name change travels alone (the field is disabled; this is the state half)
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

// ── STRUCTURE S2 — «Menú» / «Extras» (PLAN-portal-structure-S2-ui r3 §2 items 1–3; MOCKUP frame X) ─────────────────────────────
// Which tab and which group are VIEW state (never the draft). The tabs exist only with the server's extrasCatalog switch; without it
// Productos is today's page exactly.
let prodTab = 'menu';
// a source that carries a removal claim must save with the served baseline (LEDGER R-A clause 3; the claim is read only by
// editor.js mergeDeletionClaim)
const baseFor = (src) => (mergeDeletionClaim(src, null) && state.deletionBase ? { version: state.deletionBase.version, generation: state.deletionBase.generation } : null);
let extrasGroup = null;
// STRUCTURE S2 §5.2 REVIEW-DELETIONS — «Confirmar y seguir» arms ONE acknowledged resend; the next save consumes it
let reviewAck = false;
const takeReviewAck = () => { const r = reviewAck; reviewAck = false; return r; };
// STRUCTURE S2 §5.2 — the server's line FIX-EXTRA brought to an extra's row ({ id, text }); editing that row clears it
let extrasRowError = null;
// a detail field's restore key held across a LOCKED write (inputs disabled, repainted): restored on a later paint while nothing else holds
// focus; re-keyed by P-6 adoption; dropped the moment the merchant focuses anything else (focus is never stolen)
let xFocusK = null;
// the edit state the Extras page was last painted under: its controls bake `disabled` in, so syncUi repaints it when that state changes
let xPaintedCanEdit = null;
// ── X3 «Crear grupo» (plan §2 items 5 / 5b, §3.5): the form is LOCAL state until «Crear grupo» sends ONE group.create op ───────
let createForm = null;
let createError = null;
const X3_CODES = { group_name_taken: 'Ya hay un grupo con ese nombre.', extras_group_empty: 'Agregá al menos un extra.' };
const x3Dirty = (f) => !!f && (f.name.trim() !== '' || f.rows.some((r) => r.name.trim() || r.raw.trim()) || f.mode !== 'none' || f.marked.length > 0);
function x3Focusables() { return [...$('xcreate').querySelectorAll('input, select, button')].filter((x) => !x.disabled); }
function x3Key(e) {
  if (!createForm || $('xscrim').classList.contains('show')) return;   // the discard confirm, if open, owns the keys
  if (e.key === 'Escape') { e.preventDefault(); x3Dismiss(); return; }
  if (e.key !== 'Tab') return;
  const f = x3Focusables(); const i = f.indexOf(document.activeElement);
  if (i === -1 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
}
// the backdrop (Codex S2 UI r1 P2-12): the same dismissal as Escape — clean closes, dirty asks the discard confirm
function x3Scrim(e) { if (e.target === $('xcreate') && !$('xscrim').classList.contains('show')) x3Dismiss(); }
function openCreateGroup() {
  createForm = createGroupForm(); createError = null;
  $('xcreate').classList.add('show');
  document.addEventListener('keydown', x3Key, true); $('xcreate').addEventListener('click', x3Scrim);
  paintCreateGroup(true);
}
function closeCreateGroup(refocus) {
  createForm = null; createError = null;
  $('xcreate').classList.remove('show'); $('xcreate').querySelector('.modal').replaceChildren();
  document.removeEventListener('keydown', x3Key, true); $('xcreate').removeEventListener('click', x3Scrim);
  if (refocus) { const a = $('xrail') && $('xrail').querySelector('.railadd'); if (a) a.focus(); }
}
function x3Dismiss() {
  if (!createForm) return;
  if (!x3Dirty(createForm)) { closeCreateGroup(true); return; }
  const back = document.activeElement;
  openDiscardConfirm({ onDiscard: () => closeCreateGroup(true), onKeep: () => { if (back && back.isConnected) back.focus(); } });
}
function x3Set(field, v) { createForm = setCreateField(createForm, field, v); createError = null; paintCreateGroup(false); }
function x3Create() {
  const op = createGroupOp(state.draft, createForm);
  const r = applyExposureOps(state.draft, [op], { extrasCatalog: state.extrasCatalog === true });
  if (!r.ok) { createError = X3_CODES[r.code] || 'No pudimos aplicar el cambio. Recargá la página.'; paintCreateGroup(false); return; }
  extrasGroup = op.group;
  closeCreateGroup(false);
  paint(); refreshBar();
  const on = $('xrail').querySelector('.railitem.on'); if (on) on.focus();
}
function paintCreateGroup(first) {
  if (!createForm) return;
  const modal = $('xcreate').querySelector('.modal');
  const ae = document.activeElement; const k = ae && ae.dataset ? ae.dataset.k : null;
  const at = ae && typeof ae.selectionStart === 'number' ? ae.selectionStart : null;
  createForm = settleForm(draftSource(state.draft), createForm);
  const v = { ...createGroupView(state.draft, createForm), formError: createError };
  const r = renderCreateGroup(modal, v, {
    name: bound((x) => x3Set('name', x)), row: bound((i, patch) => x3Set('row', { i, ...patch })), addRow: bound(() => x3Set('addRow')),
    removeRow: bound((i) => x3Set('removeRow', i)), mode: bound((m) => x3Set('mode', m)), cat: bound((c) => x3Set('cat', c)),
    mark: bound((key, on) => x3Set('mark', { key, on })), markAll: bound((cat) => x3Set('markAll', { cat })), markNone: bound((cat) => x3Set('markNone', { cat })),
    cancel: x3Dismiss, create: bound(x3Create),
  });
  if (first) { r.first.focus(); return; }
  const back = k ? [...modal.querySelectorAll('[data-k]')].find((x) => x.dataset.k === k) : null;
  if (back) { back.focus(); if (at !== null) { try { back.setSelectionRange(at, at); } catch (_) { /* not a text field */ } } }
}

// ── «Agregar extra» (plan §2 item 3, §3.5 row 2): the inline row is LOCAL state until it commits ONE extra.add ─────────────────
let extraAdd = null;
let extraAddK = null;
let extraAddError = null;
const addDirty = () => !!extraAdd && (extraAdd.name.trim() !== '' || extraAdd.raw.trim() !== '');
// §3.5: ONE predicate ORs every local editor's «dirty while»; every leave path consults it first
function localDirty() { return x3Dirty(createForm) || addDirty(); }
const focusDetail = (k) => { const x = [...$('xdetail').querySelectorAll('[data-k]')].find((n) => n.dataset.k === k); if (x) x.focus(); };
const focusAddBtn = () => { const b = $('xdetail').querySelector('.dhead .dright .btn'); if (b) b.focus(); };
function addOpen() {
  if (!extraAdd || extraAdd.group !== extrasGroup) { extraAdd = addExtraRow(extrasGroup); extraAddError = null; }
  paint();
  focusDetail('xadd:n');
}
function addInput(field, v) {
  extraAdd = { ...extraAdd, [field]: v }; extraAddK = field === 'name' ? 'xadd:n' : 'xadd:p'; extraAddError = null;
  return extraRowCheck(extraAdd);
}
function addCommit(refocus) {
  const op = addExtraOp(extraAdd);
  if (!op) return;
  const r = applyExposureOps(state.draft, [op], { extrasCatalog: state.extrasCatalog === true });
  if (!r.ok) { extraAddError = 'No pudimos aplicar el cambio. Recargá la página.'; paint(); focusDetail(extraAddK || 'xadd:n'); return; }
  extraAdd = null; extraAddK = null;
  paint(); refreshBar();
  if (refocus) focusAddBtn();
}
function addCancel() { extraAdd = null; extraAddK = null; extraAddError = null; paint(); focusAddBtn(); }
// focus leaving the row commits it when complete; an incomplete row stays (§3.5)
function addLeave() { if (extraAdd && addExtraOp(extraAdd)) addCommit(false); }
// a leave path on the Extras page: a complete row commits first (focus left it); a dirty one asks the portal's discard confirm
function leaveExtras(go) {
  addLeave();
  if (!localDirty()) { extraAdd = null; return go(); }   // the continuation's own result (the review flow's promise): callers may await it
  openDiscardConfirm({ onDiscard: () => { extraAdd = null; extraAddK = null; extraAddError = null; go(); }, onKeep: () => focusDetail(extraAddK || 'xadd:n') });
}

// ── X4 / X4b — the ONE group order (plan §2 item 8): every move is ONE group.order naming every group, rebuilt from the draft ────
let railOpen = null;
let railError = null;
const focusGrip = (g) => { const x = [...$('xrail').querySelectorAll('button.rgrip')].find((n) => n.dataset.grip === g); if (x) x.focus(); };
function x4Write(next, g, from) {
  const r = applyExposureOps(state.draft, [{ op: 'group.order', order: next }], { extrasCatalog: state.extrasCatalog === true });
  if (!r.ok) { railError = { group: g, text: 'No pudimos aplicar el cambio. Recargá la página.' }; railOpen = null; paint(); focusGrip(g); return; }
  railError = null;
  paint(); refreshBar();
  $('xlive').textContent = `${g} · ${next.indexOf(g) + 1}.\u00ba lugar`;
  // focus STAYS on the pressed control of the moved group's row (an end it just reached is aria-disabled, still focusable)
  if (from === 'up' || from === 'down') {
    const k = (d) => `x4:${d}:${g}`;
    const mine = from === 'up' ? 'up' : 'dn';
    const at = [...$('xrail').querySelectorAll('[data-k]')];
    const pick = at.find((n) => n.dataset.k === k(mine));
    if (pick) pick.focus();
  } else focusGrip(g);
}
const railOrder = () => groupOrders(state.draft).now;
function x4Move(g, delta, from) { const next = moveGroupOrder(railOrder(), g, delta); if (next) x4Write(next, g, from); }
function x4Drop(g, index) { const next = groupOrderTo(railOrder(), g, index); if (next) x4Write(next, g, 'drop'); else focusGrip(g); }
function x4Toggle(g) { railOpen = railOpen === g ? null : g; railError = null; paint(); focusGrip(g); }
function x4Close(g) { railOpen = null; paint(); focusGrip(g); }

// ── B «Agregar grupo de extras» (plan §2 item 6, §3.5): the checked set is LOCAL until «Agregar N grupos» records the attaches in
// the drawer COPY (setGroupAttached — never the draft; «Guardar» composes them). Cancelar / Escape / the backdrop: an explicit cancel.
let attachPick = null;
function bFocusables() { return [...$('xattach').querySelectorAll('input, button')].filter((x) => !x.disabled); }
function bKey(e) {
  if (!attachPick) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bClose(true); return; }
  if (e.key !== 'Tab') return;
  const f = bFocusables(); const i = f.indexOf(document.activeElement);
  if (i === -1 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
}
function bScrim(e) { if (e.target === $('xattach')) bClose(true); }
function bOpen(s, action, after) {
  attachPick = { s, action, after, checked: new Set() };
  $('xattach').classList.add('show');
  document.addEventListener('keydown', bKey, true); $('xattach').addEventListener('click', bScrim);
  bPaint(true);
}
function bClose(refocus) {
  const p = attachPick; attachPick = null;
  $('xattach').classList.remove('show'); $('xattach').querySelector('.modal').replaceChildren();
  document.removeEventListener('keydown', bKey, true); $('xattach').removeEventListener('click', bScrim);
  if (refocus && p && p.action && p.action.isConnected) p.action.focus();
}
function bPaint(first) {
  if (!attachPick) return;
  const ae = document.activeElement; const k = ae && ae.dataset ? ae.dataset.k : null;
  const sheet = IE.attachSheet(state.draft, attachPick.s);
  const v = { dish: attachPick.s.base.name || attachPick.s.key, rows: sheet.rows.map((r) => ({ ...r, checked: attachPick.checked.has(r.group) })) };
  const r = renderAttachSheet($('xattach').querySelector('.modal'), v, {
    toggle: bound((g, on) => { if (on) attachPick.checked.add(g); else attachPick.checked.delete(g); bPaint(false); }),
    cancel: () => bClose(true),
    add: bound(() => {
      const p = attachPick; const order = sheet.rows.map((x) => x.group).filter((g) => p.checked.has(g));
      for (const g of order) IE.setGroupAttached(p.s, g, true);
      bClose(false); p.after();
    }),
    create: bound(() => { bClose(false); requestClose(() => { closeDrawer(); setProdTab('xpage'); openCreateGroup(); }); }),
  });
  if (first) { r.first.focus(); return; }
  const back = k ? [...$('xattach').querySelectorAll('[data-k]')].find((x) => x.dataset.k === k) : null;
  if (back) back.focus();
}

// rule 16b (SBS 11-12): a card's subtitle wraps BETWEEN its « · » parts, never inside one — «en 4 pro…» hid the count once «Editar en
// Extras» shared the header line at 390 px, and a free wrap would orphan a word («en 4 / productos»)
function setSegs(host, text) {
  const parts = String(text).split(' \u00b7 ');
  host.replaceChildren();
  // the « ·» stays at the END of its part (a line never starts with «·»); the space after it is the only break
  parts.forEach((p, i) => { if (i) host.append(document.createTextNode(' ')); const sp = document.createElement('span'); sp.className = 'mk-seg'; sp.textContent = i < parts.length - 1 ? `${p} \u00b7` : p; host.append(sp); });
}

function svgPlusIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M12 5v14M5 12h14'); s.append(p);
  return s;
}

function setProdTab(t) {
  const next = t === 'xpage' ? 'xpage' : 'menu';
  if (prodTab === 'xpage' && next !== 'xpage') { leaveExtras(() => { prodTab = next; paint(); }); return; }
  prodTab = next; paint();
}
function paintProductTabs() {
  if (!$('prodtabs') || !$('xsplit')) return;   // a page without the S2 markup (and today's tests' trimmed shells): Productos as today
  const on = state.extrasCatalog === true && !!state.draft;
  if (!on) prodTab = 'menu';
  $('prodtabs').classList.toggle('hidden', !on);
  for (const [id, t] of [['tabmenu', 'menu'], ['tabextras', 'xpage']]) {
    const b = $(id); const sel = prodTab === t; b.classList.toggle('on', sel); b.setAttribute('aria-selected', sel ? 'true' : 'false');
  }
  const menuSplit = $('rail').parentElement;
  const onXpage = prodTab === 'xpage';
  menuSplit.classList.toggle('hidden', onXpage);
  $('xsplit').classList.toggle('hidden', !onXpage);
  if (!onXpage) return;
  const model = extrasPageModel(state.draft, { group: extrasGroup });
  extrasGroup = model.selected;
  if (extraAdd && extraAdd.group !== extrasGroup) extraAdd = null;
  model.open = railOpen && model.rail.some((r) => r.group === railOpen) ? railOpen : null;
  model.railError = railError;
  model.rowError = extrasRowError;
  model.adding = extraAdd ? { name: extraAdd.name, raw: extraAdd.raw, check: { ...extraRowCheck(extraAdd), error: extraAddError } } : null;
  // a repaint keeps the focused field (a typed price, the inline row) or the focused rail group
  const ae = document.activeElement;
  const keepK = ae && ae.dataset && $('xdetail').contains(ae) ? ae.dataset.k : null;
  const keepG = ae && ae.dataset && $('xrail').contains(ae) ? ae.dataset.group : null;
  const keepGrip = ae && ae.dataset && $('xrail').contains(ae) ? ae.dataset.grip : null;
  const keepRailK = ae && ae.dataset && $('xrail').contains(ae) ? ae.dataset.k : null;
  renderExtrasPage($('xrail'), $('xdetail'), model, {
    select: bound((g) => leaveExtras(() => { extrasGroup = g; paint(); })),
    create: bound(() => openCreateGroup()),
    move: bound(x4Move), drop: bound(x4Drop), gripToggle: bound(x4Toggle), gripClose: bound(x4Close),
    addOpen: bound(addOpen), addInput, addCommit: bound(() => addCommit(true)), addCancel: bound(addCancel), addLeave: bound(addLeave),
    // a price on the Extras page: today's guarded setter (a new, keyless extra by its ref); repainted, the caret kept in its field
    // a «Nuevo» (keyless) row's name (advisor 11-12): the guarded keyless-only setter; repainted, the caret kept in its field
    name: bound((id, raw, input) => {
      const at = input.selectionStart; const k = input.dataset.k;
      setExtraName(state.draft, id, raw);
      if (extrasRowError && JSON.stringify(extrasRowError.id) === JSON.stringify(id)) extrasRowError = null;
      paint(); refreshBar();
      const back = [...$('xdetail').querySelectorAll('input[aria-label="Nombre del extra"]')].find((x) => x.dataset.k === k);
      if (back) { back.focus(); try { back.setSelectionRange(at, at); } catch (_) { /* not a text field */ } }
    }),
    price: bound((id, raw, input) => {
      const at = input.selectionStart; const k = input.dataset.k;
      if (extrasRowError && JSON.stringify(extrasRowError.id) === JSON.stringify(id)) extrasRowError = null;
      setExtraPrice(state.draft, id, raw);
      paint(); refreshBar();
      const back = [...$('xdetail').querySelectorAll('.price input')].find((x) => x.dataset.k === k);
      if (back) { back.focus(); try { back.setSelectionRange(at, at); } catch (_) { /* not a text field */ } }
    }),
    // X2: «¿Quitar {extra} de {grupo}?» — «Quitar» removes it through the ONE mutator (a published extra's identity joins the claim)
    remove: bound((row, trash) => {
      const g = model.detail.group, n = model.detail.reach;
      openRemoveConfirm({ title: `¿Quitar ${row.name} de ${g}?`, sub: `Extras \u00b7 ${enProductos(n || 0)}`,
        body: n === 1 ? 'Desaparece del menú en el producto que usa este grupo. Tus pedidos pasados no cambian.'
          : `Desaparece del menú en los ${n || 0} productos que usan este grupo. Tus pedidos pasados no cambian.`,
        returnTo: trash,
        onConfirm: bound(() => {
          const r = applyExposureOps(state.draft, [{ op: 'extra.remove', ...row.id }], { extrasCatalog: state.extrasCatalog === true });
          paint(); refreshBar();
          const back = $('xrail').querySelector('.railitem.on'); if (back) back.focus();
          return r.ok === true;
        }),
      });
    }),
  }, { canEdit: canEditDraft(state.draft) });
  xPaintedCanEdit = canEditDraft(state.draft);
  // `ae` is the focus BEFORE this repaint: a held key is used only when nothing held focus then
  const held = !keepK && xFocusK && (!ae || ae === document.body) ? xFocusK : null;
  if (!keepK && !held) xFocusK = null;   // the merchant is elsewhere now
  const want = keepK || held;
  if (want) {
    focusDetail(want);
    const landed = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.k === want;
    xFocusK = landed ? null : want;   // a disabled target (a write in flight): hold it for the next paint
  } else if (keepRailK) { const x = [...$('xrail').querySelectorAll('[data-k]')].find((n) => n.dataset.k === keepRailK); if (x) x.focus(); }
  else if (keepGrip) focusGrip(keepGrip);
  else if (keepG !== null && keepG !== undefined) { const g = [...$('xrail').querySelectorAll('.railitem')].find((n) => n.dataset.group === keepG); if (g) g.focus(); }
}

function paint() {
  paintProductTabs();
  // the held-state mockup (Codex r1): the drawer's hold follows the pending name on EVERY paint — publish, discard and undo all
  // repaint — not only on a drawer render, so it can never outlive the name change it marks
  $('drawer').classList.toggle('namehold', renamesPending());
  renderRail($('rail'), state.groups, state.selectedCat, (id) => { state.selectedCat = id; if (state.renameEdit && state.renameEdit.catId !== id) state.renameEdit = null; paint(); });
  const changed = new Set(pendingChanges(state.draft, state.additionKeys).map((c) => `${c.surface}::${c.key}`));
  paintNameCall();
  // PLAN-public-menu-display T1 — the section-name control for the section on screen (mockup R1–R3b), or none: no draft, no
  // section of its own (the uncategorized bucket), or no section named yet (then the R1c callout is the one way in).
  const catId = state.selectedCat;
  const nameHold = renamesPending();
  const otherHold = !nameHold && othersPending();
  const editing = !!(state.renameEdit && state.renameEdit.catId === catId);
  const rename = (state.platformPending !== true && state.draft && catId !== null && isDeclaredCategory(catId) && !categoriesUnnamed(state.draft)) ? {   // F-2: no «Cambiar nombre» while Sherpa updates (mockup N1/P1)
    mode: editing ? 'edit' : (otherHold ? 'blocked' : 'idle'),
    value: declaredName(catId),
    focus: editing,
    problemOf: categoryNameProblem,
    onStart: bound(() => renameStart(catId)),
    onSave: bound((v) => renameSave(catId, v)),
    onCancel: bound(renameCancel),
  } : null;
  renderDetail($('detail'), state.groups.find((g) => g.category.id === state.selectedCat), state.extras, {
    rename,
    locked: nameHold || state.platformPending === true,   // F-2: Sherpa is updating the menu — prices and «Agregar producto» read-only
    notice: nameHold ? RENAME_NOTICE.renames : (otherHold && (rename || categoriesUnnamed(state.draft)) ? RENAME_NOTICE.others : null),
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
    photoOf: rowPhoto,             // DISH PHOTOS B — null with uploads off and no photo: today's placeholder
    textTagOf: rowTextTag,         // S4 (B) — «Nombre sin publicar» / «Cambios sin publicar», only with the text-edit switch on
    onPhoto: bound((id) => { photoExpandedKey = null; openDrawer(id); pickPhoto(id, null); }),   // the camera: the drawer with the picker open
  });
  // F-2 — a Sherpa-written draft gets the calm notice INSTEAD of the reset offer; a merchant's own unpublishable draft keeps today's
  if (state.platformPending) offerPlatformNotice($('detail'));
  else if (state.draftUnpublishable && state.draftRid) offerResetToLive($('detail'), state.draftRid, state.sourceUpdateTime);
  paintPlatformLock();
}

// ── the item drawer (Task 3: PRICE ONLY) ───────────────────────────────────────────────────────
// One editable field, deliberately. The drawer is where a name, a category or a delete button would
// naturally go, and all three write the pricing KEY — 2b-2c, after the key strategy lands. Nothing
// here renders them, so there is no control to accidentally enable.
// Closing is its own operation because two different things need it: the Cerrar button, and the
// review opening (the drawer would otherwise overlay the attestation).
function closeDrawer() {
  state.drawerKey = null;
  endEditSession();                               // S4: closing the drawer is «Cancelar» for its working copy
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
  // S4: un-inerting enabled every button — «Guardar» must say what the working copy says (nothing to save / a hold) again
  if (!on) syncEdit();
}

export function openDrawer(key) {
  if (editSess && editSess.key !== key && copyDirty()) { requestClose(() => openDrawer(key)); return; }   // unsaved edits: ask first
  if (editSess && editSess.key !== key) endEditSession();   // S4: another product's drawer drops the open copy
  state.drawerKey = key;
  state.openGroups = state.openGroups || new Set();
  renderDrawer(); holdDrawerForRename();
}

// Re-rendered on every group toggle, so it PRESERVES the body's scroll position. Without that, opening
// a group three down the list snaps the drawer back to the top and the merchant loses the row they
// were reading — on a menu with a dozen option groups that makes the panel unusable.
function renderDrawer() {
  // ruling A (Codex r1 #2) — EVERY drawer render carries the rename lock (renewal, image-error and picker redraws included),
  // whichever return it leaves by
  try {
  const d = $('drawer');
  dismissConfirm();   // a redraw (e.g. an upload landing) while the confirm is open = «Seguir editando»: the copy stays, the page is live
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
  const pjob = uploader.jobOf(rowId(it));
  if (pjob && pjob.phase === 'crop') { renderCropDrawer(d, it, pjob); return; }   // DISH PHOTOS B — P3, a step of the drawer
  if (isAddition(it)) { renderAddDrawer(d, it, keepScroll); return; }   // 1D add-product A
  // S4 — the text-edit switch on (getEditableCatalog textEditEnabled): an existing product's drawer is the working copy; off: today's
  if (state.textEditEnabled === true && renderEditDrawer(d, it, keepScroll)) return;

  const head = document.createElement('div');
  head.className = 'dwh';
  const title = document.createElement('div');
  title.className = 'dwt';
  title.textContent = (it.display && it.display.name) || it.key;   // textContent: a dish name is data
  const close = closeIcon(() => { state.drawerKey = null; d.classList.remove('show'); });
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'dwb';

  // A PUBLISHED product with a required choice: its price IS its choices' prices (the launcher's own is legacy and never
  // charged), so the drawer shows the choice block in price-only mode instead of a "Precio" field (advisor ruling on
  // portal A — the list shows the choices read-only, so this is where a published choice's price is changed).
  const pf = photoFieldFor(it);            // DISH PHOTOS B — «Foto» first (P1), or nothing (uploads off, no photo: today)
  if (pf) body.append(pf);
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
  } finally { holdDrawerForRename(); }
}

// ── S4 «Editar producto» — the drawer of an EXISTING product while the text-edit switch is on (MOCKUP-portal-item-edit.html
// frames A–F, the approved target; S2-DESIGN §1 r2). The drawer edits a WORKING COPY (item-edit-logic.js): nothing it shows
// writes the draft on its own — photo, name, description, section, subsection, price, the options' prices and the extras-group
// prices (advisor Q1 / Q2) — and «Guardar» commits the whole edit ONCE; «Cancelar» / «Cerrar» drop it. Built ONCE per open;
// typing updates the built nodes in place (a rebuild under the caret would break an accent typed with a dead key).
// Module-private, never on the exported `state` (portal-wiring's census).
let editSess = null;      // the open drawer's working copy (IE session)
// the open unsaved-edits confirm, if any: its ONE cleanup (card, inert background, key trap) is owned here, not by its closure, so
// every path that replaces the drawer or ends the world tears it down (Codex drawer r2 #3)
let activeConfirm = null;
function dismissConfirm() { const c = activeConfirm; activeConfirm = null; if (c) c(); }
// read-only seam for the tests: the open copy itself (identity of the session, its work / base / upload binding)
export const _openCopy = () => editSess;
let editUpload = null;    // the upload bound to it (IE.uploadBinding), if one was started in this drawer
let editRefs = null;      // the built nodes `syncEdit` updates in place
// UNSAVED EDITS (MOCKUP-portal-item-edit-unsaved.html, owner-approved 2026-11-11): the open copy's unsaved work is never thrown
// away without asking. One predicate; the bar, the reload guard and every exit that would drop the copy read it.
const UNSAVED_HINT = 'Guardá o cancelá los cambios del producto abierto';
const copyDirty = () => !!editSess && !editSess.closed && IE.isDirty(editSess);
// Frame 2 — an in-page confirm anchored to the drawer (its scrim covers the drawer only; the page gets no backdrop). «Seguir
// editando» is the primary and holds focus; Enter, or Esc ANYWHERE, keeps the work and returns the caret (and its selection) to the
// last edited field. Tab / Shift+Tab stay inside the card, and everything behind it is inert while it is open. «Descartar» drops the
// copy, then runs `next` (close, reload, reset, or open the other product). Clean → `next` at once: nothing asks twice.
function requestClose(next) {
  if (!copyDirty()) return next();   // clean: the exit itself (its promise, for an async one)
  const d = $('drawer');
  if (d.querySelector('.mk-cfscrim')) return;
  // the last edited field (it keeps its own selection while the close button has focus; focusing it again restores the caret)
  const lastEl = editRefs && editRefs.lastEdit && editRefs.lastEdit.el.isConnected ? editRefs.lastEdit.el : document.activeElement;
  const mkEl = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const scrim = mkEl('div', 'mk-cfscrim');
  const cfCard = mkEl('div', 'mk-cf');
  cfCard.setAttribute('role', 'dialog'); cfCard.setAttribute('aria-modal', 'true');
  cfCard.setAttribute('aria-labelledby', 'mk-cf-t'); cfCard.setAttribute('aria-describedby', 'mk-cf-d');
  const h = mkEl('h3', null, '¿Descartar los cambios?'); h.id = 'mk-cf-t';
  const p = mkEl('p', null, 'Tenés cambios sin guardar en este producto.'); p.id = 'mk-cf-d';
  const acts = mkEl('div', 'mk-cfa');
  const cfDrop = document.createElement('button'); cfDrop.className = 'btn ghost mk-quiet-danger'; cfDrop.type = 'button'; cfDrop.textContent = 'Descartar';
  const cfKeep = document.createElement('button'); cfKeep.className = 'btn accent'; cfKeep.type = 'button'; cfKeep.textContent = 'Seguir editando';
  // the background, inert while the card is open (restored exactly: an element already inert stays inert)
  const inerted = [];
  for (const el of [...d.children, ...document.body.children]) {
    if (el === d || el.hasAttribute('inert')) continue;
    el.setAttribute('inert', ''); inerted.push(el);
  }
  const close = () => {
    if (activeConfirm === close) activeConfirm = null;
    scrim.remove();
    for (const el of inerted) el.removeAttribute('inert');
    document.removeEventListener('keydown', onDocKey, true);
  };
  const dismiss = () => {
    close();
    if (lastEl && lastEl.isConnected && typeof lastEl.focus === 'function') lastEl.focus();
  };
  const onDocKey = bound((e) => {
    if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
    if (e.key === 'Tab') {   // contained: the card's two buttons, in order
      e.preventDefault();
      const ring = [cfDrop, cfKeep];
      const at = ring.indexOf(document.activeElement);
      const to = e.shiftKey ? (at <= 0 ? ring.length - 1 : at - 1) : (at === ring.length - 1 ? 0 : at + 1);
      ring[to].focus();
    }
  });
  cfKeep.addEventListener('click', bound(() => dismiss()));
  cfDrop.addEventListener('click', bound(() => { close(); endEditSession(); next(); syncUi(); }));   // the bar is live again (frame 3)
  acts.append(cfDrop, cfKeep);
  cfCard.append(h, p, acts);
  scrim.append(cfCard);
  d.append(scrim);
  document.addEventListener('keydown', onDocKey, true);
  activeConfirm = close;
  cfKeep.focus();
}
function endEditSession() {
  dismissConfirm();   // the copy's confirm goes with it — every world-ending path (closeDrawer, resetEditFacts / invalidateReview, auth) passes here
  const s = editSess;
  editSess = null; editUpload = null; editRefs = null;
  if (!s || s.closed) return;
  IE.cancel(s);
  // an upload started in this drawer dies with it: cancelled, it can never land later (S4 addendum: late uploads never touch the draft)
  if (uploader.jobOf(s.key)) uploader.cancel(s.key);
}
// a new load: the S2 §1.1 facts fail closed — today's drawer, no served names, no saved text edits — and any open copy goes
// The products with unpublished text: this session's (the draft vs what was loaded) ∪ the SAVED draft's (pendingTexts, S2 §1.1)
// — key → the fields; empty without the switch (today's list).
function textEditedKeys() {
  const out = new Map();
  if (state.textEditEnabled !== true || !state.draft) return out;
  // copied as PRIMITIVES (a state object never leaves its scope)
  const mark = (key, field) => { const f = out.get(key) || new Set(); f.add(field === 'subcat' ? 'cat' : field); out.set(key, f); };
  for (const t of state.savedTexts) for (const x of t.fields) mark(`${t.key}`, `${x}`);
  for (const t of pendingTexts(state.draft)) for (const x of t.fields) mark(`${t.key}`, `${x}`);
  return out;
}
function rowTextTag(it) {
  const f = textEditedKeys().get(rowId(it));
  if (!f) return null;
  return f.size === 1 && f.has('name') ? 'Nombre sin publicar' : 'Cambios sin publicar';
}
// S4 «Productos» (frame E) — what the review needs from the draft to ARRANGE the server's lines (never to derive them): an
// option's product, by pricing key (the diff's keys), and the product's own choice order.
function productReviewCtx() {
  const items = ((draftSource(state.draft) || {}).items || []).filter((r) => r && r.display && typeof r.key === 'string');
  const keyOfId = new Map(items.map((r) => [String(r.display.id), r.key]));
  const parent = new Map();
  const index = new Map();
  for (const r of items) {
    if (r.display.variantOf == null) continue;
    const pk = keyOfId.get(String(r.display.variantOf));
    if (pk) { parent.set(r.key, pk); index.set(r.key, index.size); }
  }
  // STRUCTURE S1 (advisor 11-12): the server's checklist lines name extras by key — their display names, from the draft
  const extraNames = new Map((draftSource(state.draft).extras || []).filter((x) => x && typeof x.key === 'string' && x.display).map((x) => [x.key, x.display.name]));
  // STRUCTURE S2: the «Estructura» rows' names (the server diff names dishes by key and sections by id) — the draft's, ungated: the
  // server sends S2 fields only for an S2 op
  const structure = { nameOf: (k) => { const r = items.find((x) => x.key === k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },
    categoryName, sectionOf: (k) => { const r = items.find((x) => x.key === k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; } };
  // Codex S2 UI r1 P1-4: each extra's group, so a checklist key its group's detach drops folds into that «Estructura» row
  const extraGroups = new Map((draftSource(state.draft).extras || []).filter((x) => x && typeof x.key === 'string' && x.display && x.display.cat != null).map((x) => [x.key, `${x.display.cat}`]));
  return { optionParent: (k) => parent.get(k) || null, optionIndex: (k) => (index.has(k) ? index.get(k) : 0), extraName: (k) => extraNames.get(k) || null,
    extraGroup: (k) => extraGroups.get(k) || null, structure };
}
function productReviewOpts() {
  if (state.textEditEnabled !== true) return null;   // switch off: today's review rows exactly
  const items = ((draftSource(state.draft) || {}).items || []).filter((r) => r && r.display && typeof r.key === 'string');
  const section = (k) => { const r = items.find((x) => x.key === k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; };
  return { nameOf: (k) => { const r = items.find((x) => x.key === k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },
    categoryName, sectionOf: section };
}
// Codex S2 r1 P1-2 — the auth boundary ends the Extras page's LOCAL world too: every local editor (the inline row, X3, B, the rail
// pair), every open sheet / confirm on #xscrim with its document listeners, the armed acknowledged resend and the view state. Nothing
// person A typed, opened or acknowledged survives for person B; no continuation runs (the confirms close without onGo / onCancel).
function resetExtrasLocal() {
  closeXConfirm();
  // a page without the S2 markup (today's trimmed shells) has no sheets to close
  if ($('xcreate') && (createForm || $('xcreate').classList.contains('show'))) closeCreateGroup(false);
  if ($('xattach') && (attachPick || $('xattach').classList.contains('show'))) bClose(false);
  createForm = null; createError = null; attachPick = null;
  extraAdd = null; extraAddK = null; extraAddError = null;
  railOpen = null; railError = null; extrasRowError = null;
  reviewAck = false; xFocusK = null; xPaintedCanEdit = null;
  extrasGroup = null; prodTab = 'menu';
  // A's painted page goes too (a hidden #xsplit still holds A's rows and their handlers until a repaint)
  if ($('xrail')) $('xrail').replaceChildren();
  if ($('xdetail')) $('xdetail').replaceChildren();
}
function resetEditFacts() {
  state.textEditEnabled = false;
  state.extrasAuthoring = false;
  state.extrasCatalog = false;
  state.deletionBase = null;
  state.reservedNames = null;
  state.savedTexts = [];
  resetExtrasLocal();
  endEditSession();
}
// The product's photo as this drawer shows it: the draft's map with the copy's entry in place of the stored one.
function editPhotos(s) {
  const photos = { ...draftPhotos(state.draft) };
  if (s.photoTouched) { if (s.work.photo == null) delete photos[s.key]; else photos[s.key] = s.work.photo; }
  return photos;
}
function warnTri() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3l9 16H3z', 'M12 10v4', 'M12 17.5v.01']) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
// STRUCTURE S1 — the «Opciones» copy (MOCKUP-portal-structure-edit v2, table H) and the cards' fold state (view-only, per drawer
// session: never part of the copy, never dirty)
const OPC_COPY = Object.freeze({
  noneOff: 'Apagalo si este producto no lleva extras', noneOn: 'Este producto no ofrece ningún extra',
  req: 'Elección requerida · el cliente elige 1', ext: 'Extras · opcionales',
  allOn: 'Todos activos en este producto', markAll: 'Marcar todos', none: 'Ninguno', appOnly: 'Solo en la app Sherpa',
  gap: 'No pudimos cargar los extras.',
});
// table H (Codex build r1 #9): «En el menú cada opción se llama «{producto} - {opción}», «… - {opción}»: el nombre se arma solo.» — the
// recommended option first (the mockup's «Mediana»), else the first; then the one after it
function opcNameLine(options, g) {
  const opts = Array.isArray(options) ? options : [];
  if (!opts.length) return '';
  const rec = (k) => { const row = g && g.options.find((x) => x.key === k); return !!(row && row.display && Array.isArray(row.display.tags) && row.display.tags.includes('recommended')); };
  const i = Math.max(0, opts.findIndex((o) => rec(o.key)));
  const a = opts[i], b = opts.length > 1 ? opts[(i + 1) % opts.length] : null;
  return `En el menú cada opción se llama «${a.fullName}»${b ? `, «… - ${b.choice}»` : ''}: el nombre se arma solo.`;
}
const opcFolded = new Set();
const opcN = (n) => `${n} ${n === 1 ? 'opción' : 'opciones'}`;
const opcProducts = (n) => `en ${n} ${n === 1 ? 'producto' : 'productos'}`;
// an extras card's header line: open → the group's reach; folded (A3) → also how many are active here, or how many there are
function opcExtSub(c, open) {
  if (open) return `${OPC_COPY.ext} · ${opcProducts(c.usedBy)}`;
  return `${OPC_COPY.ext} · ${c.active < c.size ? `${c.active} de ${c.size} activos` : opcN(c.size)} · ${opcProducts(c.usedBy)}`;
}
function renderEditDrawer(d, it, keepScroll) {
  const key = rowId(it);
  if (!editSess || editSess.closed || editSess.key !== key || editSess.draft !== state.draft) {
    endEditSession();
    // the copy carries BOTH server switches: extrasCatalog turns on its group ops (B's attach, «Quitar de este producto») — without it
    // setGroupAttached stays dark by design, so an app that forgot to pass it would record nothing
    editSess = IE.open(state.draft, key, state.reservedNames, { extrasAuthoring: state.extrasAuthoring === true, extrasCatalog: state.extrasCatalog === true });
  }
  const s = editSess;
  if (!s) return false;                       // not a product this drawer edits (an option, an unsaved addition): today's drawer
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const v0 = IE.view(state.draft, s);
  const R = { flds: {}, cnts: {}, errs: {}, ctl: {} };   // ctl: the control(s) each field's line describes (AA)
  const relayout = () => { renderDrawer(); holdDrawerForRename(); };   // only on a structural change (a section), never per keystroke
  const errSlot = (f, field) => { R.flds[field] = f; R.errs[field] = null; };

  const head = mk('div', 'dwh');
  head.append(mk('span', 'dwt', s.base.name || key), closeIcon(bound(() => requestClose(() => closeDrawer()))));   // the published name until the draft is saved (B)
  const body = mk('div', 'dwb ie-edit');   // .ie-edit scopes the mockup rules that would otherwise reach the add drawer

  // «Foto» — the approved dish-photo field (P7), its entry from the copy
  const pf = photoFieldFor(it, s);
  if (pf) body.append(pf);

  // «Nombre» — no maxlength (C2: the owner types past 60 to see what to trim; advisor Q3)
  const fName = mk('div', 'fld');
  const lr1 = mk('div', 'mk-lrow');
  const nmId = `ie-nm-${s.id}`;
  const lab1 = mk('label', null, 'Nombre'); lab1.htmlFor = nmId;
  R.cnts.name = mk('span', 'mk-cnt');   // no aria-live (AA ruling 11-10): the error line announces over-60
  lr1.append(lab1, R.cnts.name);
  const ieName = document.createElement('input');
  ieName.type = 'text'; ieName.id = nmId; ieName.value = v0.fields.name; ieName.placeholder = 'Nombre del producto';
  ieName.addEventListener('input', bound(() => { IE.set(s, 'name', ieName.value); syncEdit(); }));
  focusKey(ieName, 'ie-name');
  fName.append(lr1, ieName); errSlot(fName, 'name'); R.ctl.name = [ieName];
  body.append(fName);

  // «Descripción · opcional» — maxlength 200 as drawn
  const fDesc = mk('div', 'fld');
  const lr2 = mk('div', 'mk-lrow');
  const dsId = `ie-ds-${s.id}`;
  const lab2 = mk('label', null, 'Descripción'); lab2.htmlFor = dsId; lab2.append(mk('span', 'mk-opt', ' · opcional'));
  R.cnts.desc = mk('span', 'mk-cnt');
  lr2.append(lab2, R.cnts.desc);
  const ieDesc = document.createElement('textarea');
  ieDesc.id = dsId; ieDesc.rows = 2; ieDesc.maxLength = 200; ieDesc.placeholder = 'Qué lleva, cómo viene'; ieDesc.value = v0.fields.desc;
  ieDesc.addEventListener('input', bound(() => { IE.set(s, 'desc', ieDesc.value); syncEdit(); }));
  focusKey(ieDesc, 'ie-desc');
  fDesc.append(lr2, ieDesc); errSlot(fDesc, 'desc'); R.ctl.desc = [ieDesc];
  body.append(fDesc);

  // «Categoría» — the sections the order page shows (the product's own section always listed)
  const fCat = mk('div', 'fld');
  fCat.append(mk('label', null, 'Categoría'));
  const ieCat = document.createElement('select');
  ieCat.className = 'mk-sel'; ieCat.setAttribute('aria-label', 'Categoría');
  for (const c of categoriesOf()) {
    const catId = String(c && c.id);
    if (!canAddTo(catId) && catId !== s.base.cat) continue;
    const o = mk('option', null, categoryName(catId)); o.value = catId; o.selected = catId === v0.fields.cat;
    ieCat.append(o);
  }
  ieCat.addEventListener('change', bound(() => { IE.set(s, 'cat', ieCat.value); relayout(); refocus(['ie-cat']); }));
  focusKey(ieCat, 'ie-cat');
  fCat.append(ieCat); errSlot(fCat, 'cat'); R.ctl.cat = [ieCat];
  R.note = mk('div', 'mk-note'); R.note.setAttribute('role', 'status');
  fCat.append(R.note);
  body.append(fCat);

  // «Subcategoría» — only when the chosen section has subsections; moving INTO one asks for a choice (no preselect)
  if (v0.subcats) {
    const fSub = mk('div', 'fld');
    fSub.append(mk('label', null, 'Subcategoría'));
    const ieSub = document.createElement('select');
    ieSub.className = 'mk-sel'; ieSub.setAttribute('aria-label', 'Subcategoría');
    if (v0.fields.subcat == null) { const ph = mk('option', null, IE.COPY.save.pickSubcat); ph.value = ''; ph.disabled = true; ph.selected = true; ieSub.append(ph); }
    for (const sc of v0.subcats) { const o = mk('option', null, sc); o.value = sc; o.selected = sc === v0.fields.subcat; ieSub.append(o); }
    ieSub.addEventListener('change', bound(() => { IE.set(s, 'subcat', ieSub.value); relayout(); refocus(['ie-subcat']); }));
    focusKey(ieSub, 'ie-subcat');
    fSub.append(ieSub); errSlot(fSub, 'subcat'); R.ctl.subcat = [ieSub];
    body.append(fSub);
  }

  // a plain product: its price, as today (a product with a required choice prices its options, in «Opciones» below)
  if (!v0.options) {
    const fPr = mk('div', 'fld pr');
    fPr.append(mk('label', null, 'Precio'), mk('span', 'cur2', 'L'));
    const iePrice = document.createElement('input');
    iePrice.type = 'text'; iePrice.inputMode = 'numeric'; iePrice.setAttribute('aria-label', 'Precio'); iePrice.placeholder = 'Sin precio'; iePrice.value = v0.fields.price;
    iePrice.addEventListener('input', bound(() => { IE.set(s, 'price', iePrice.value); syncEdit(); }));
    focusKey(iePrice, 'ie-price');
    fPr.append(iePrice); errSlot(fPr, 'price'); R.ctl.price = [iePrice];
    body.append(fPr);
  }

  // STRUCTURE S1 — «Opciones» (MOCKUP-portal-structure-edit v2 frame A / A2 / A3): «Sin extras», the required choice (R1: today's
  // option-price inputs kept inside its card until S3), one card per extras group the dish offers, with the per-dish checklist
  // (R4: today's editable prices until S2). Each card folds on its own (view-only). No grip (R2); no pencil, «Editar en Extras»,
  // «Quitar de este producto» or dish actions until S2 / S3 — no dead control.
  const ex = v0.extras;
  if (v0.options || ex.show) {
    const fOpc = mk('div', 'fld');
    const lrO = mk('div', 'mk-lrow');
    lrO.append(mk('label', null, 'Opciones'), mk('span', 'mk-cnt', state.extrasCatalog === true ? 'El orden de los grupos se define en Extras' : 'en el orden que las ve el cliente'));   // mockup v3 (owner 11-11): the order is set on the Extras page — once that page exists
    const box = mk('div', `mk-opc${ex.none ? ' mk-off' : ''}`);
    const folded = (id) => opcFolded.has(`${s.id}|${id}`);
    const fold = (id) => { const k = `${s.id}|${id}`; if (opcFolded.has(k)) opcFolded.delete(k); else opcFolded.add(k); relayout(); refocus([`ie-fold::${id}`]); };
    const header = (id, name, sub, subCls, open, lead = null) => {
      const gh = mk('div', 'mk-gh');
      const ieFoldName = document.createElement('button'); ieFoldName.type = 'button'; ieFoldName.className = 'mk-gt';
      ieFoldName.setAttribute('aria-expanded', String(open));
      const st = mk('span', subCls); setSegs(st, sub);
      ieFoldName.append(mk('b', 'mk-gtn', name), st);
      ieFoldName.addEventListener('click', bound(() => fold(id)));
      focusKey(ieFoldName, `ie-fold::${id}`);
      const act = mk('div', 'mk-gact');
      const ieFoldChev = document.createElement('button'); ieFoldChev.type = 'button'; ieFoldChev.className = 'mk-ib mk-chev';
      ieFoldChev.setAttribute('aria-label', `${open ? 'Ocultar' : 'Mostrar'} ${name}`); ieFoldChev.setAttribute('aria-expanded', String(open));
      ieFoldChev.append(svgChevron());
      ieFoldChev.addEventListener('click', bound(() => fold(id)));
      if (lead) act.append(lead);   // S2 frame A: «Editar en Extras» before the chevron
      act.append(ieFoldChev);
      gh.append(ieFoldName, act);
      return { gh, st };
    };
    R.opc = { cards: [] };
    if (ex.gap) box.append(mk('p', 'mk-opcgap', OPC_COPY.gap));   // Codex build r1 #8: said, never a silent absence
    else if (ex.show) {
      const sw = mk('div', 'mk-opcsw');
      const lbl = mk('div', 'mk-opcl');
      lbl.append(mk('b', 'mk-opcb', 'Sin extras'), mk('span', 'mk-opcs', ex.none ? OPC_COPY.noneOn : OPC_COPY.noneOff));
      const ieNoExtras = document.createElement('button'); ieNoExtras.type = 'button'; ieNoExtras.className = 'tog';
      if (!ex.none) ieNoExtras.classList.add('off');
      ieNoExtras.setAttribute('role', 'switch'); ieNoExtras.setAttribute('aria-checked', String(ex.none)); ieNoExtras.setAttribute('aria-label', 'Sin extras');
      ieNoExtras.append(document.createElement('i'));
      lockControl(ieNoExtras, !ex.authoring);   // R5: shown, inert, until the server's switch is on (locked: setDrawerInert keeps it off)
      ieNoExtras.addEventListener('click', bound(() => { IE.set(s, 'extrasNone', !s.work.extrasNone); relayout(); refocus(['ie-sinextras']); }));
      focusKey(ieNoExtras, 'ie-sinextras');
      sw.append(lbl, ieNoExtras);
      box.append(sw);
    }
    if (v0.options) {
      const g = choiceGroup(state.draft, key);
      const label = (g && typeof g.label === 'string' && g.label.trim()) ? g.label : 'Elección';
      const open = !folded('req');
      const card = mk('div', `mk-grp mk-req${open ? ' mk-open' : ''}`);
      const h = header('req', label, `${OPC_COPY.req}${open ? '' : ` · ${opcN(v0.options.length)}`}`, 'mk-gts mk-greq', open);
      card.append(h.gh);
      R.opts = [];
      R.optCnt = mk('span', 'mk-cnt');   // the F2 line's counter class (kept for syncEdit's red), not drawn
      if (open) {
        const block = mk('div', 'mk-gb');
        for (const o of v0.options) {
          const row = mk('div', 'mk-dopt');
          // advisor 11-12 (S1 SBS, mockup v3): the row names the CHOICE; the full name lives in the helper line (and the counter)
          const dn = mk('span', 'mk-dn', o.choice);
          const opRow = g && g.options.find((x) => x.key === o.key);
          if (opRow && opRow.display && Array.isArray(opRow.display.tags) && opRow.display.tags.includes('recommended')) dn.append(mk('span', 'mk-rec', 'Recomendada'));
          const cnt = mk('span', 'mk-cnt');
          const dp = mk('span', 'dp');
          const pr = mk('span', 'mopr');
          const ieOptPrice = document.createElement('input');
          ieOptPrice.type = 'text'; ieOptPrice.inputMode = 'numeric'; ieOptPrice.placeholder = 'Sin precio'; ieOptPrice.value = o.price;
          ieOptPrice.setAttribute('aria-label', `Precio de ${o.choice}`);
          ieOptPrice.addEventListener('input', bound(() => { IE.set(s, 'optionPrice', { key: o.key, raw: ieOptPrice.value }); syncEdit(); }));
          focusKey(ieOptPrice, `ie-opt::${o.key}`);
          pr.append(mk('span', 'mc', 'L'), ieOptPrice);
          dp.append(pr);
          row.append(dn, cnt, dp);
          block.append(row);
          R.opts.push({ key: o.key, row, cnt, pi: ieOptPrice });
        }
        const lab = mk('label', 'mgflag mgflag-same mk-gsame');
        const ieSame = document.createElement('input'); ieSame.type = 'checkbox';
        ieSame.addEventListener('change', bound(() => { IE.set(s, 'samePrice', ieSame.checked); syncEdit(); }));
        focusKey(ieSame, 'ie-same');
        lab.append(ieSame, document.createTextNode('Mismo precio para todas'));
        R.same = ieSame;
        R.gsub = mk('div', 'mk-gsub', opcNameLine(v0.options, g));
        block.append(lab, R.gsub);
        card.append(block);
        R.ctl.options = R.opts.map((x) => x.pi);
      }
      R.optBlock = card;
      errSlot(card, 'options');
      box.append(card);
    }
    for (const c of ex.cards) {
      const id = `x::${c.cat}`;
      const open = !folded(id);
      const card = mk('div', `mk-grp mk-ext${open ? ' mk-open' : ''}`);
      // STRUCTURE S2 (plan §2 item 7, MOCKUP frame A) — ONLY with the server's Extras page: «Editar en Extras» in the header, «Quitar de
      // este producto» at the foot, the prices read-only (R4 ends: an extra is repriced on the Extras page); without it, S1 exactly
      const s2 = state.extrasCatalog === true;
      let ieEditInExtras = null;
      if (s2) {
        ieEditInExtras = document.createElement('button'); ieEditInExtras.type = 'button'; ieEditInExtras.className = 'mk-lnk mk-gol';
        ieEditInExtras.textContent = 'Editar en Extras'; ieEditInExtras.setAttribute('aria-label', `Editar ${c.cat} en Extras`);
        ieEditInExtras.addEventListener('click', bound(() => requestClose(() => { closeDrawer(); extrasGroup = c.cat; setProdTab('xpage'); const r = [...$('xrail').querySelectorAll('.railitem')].find((n) => n.dataset.group === c.cat); if (r) r.focus(); })));
        focusKey(ieEditInExtras, `ie-gol::${c.cat}`);
      }
      const h = header(id, c.cat, opcExtSub(c, open), 'mk-gts', open, ieEditInExtras);
      card.append(h.gh);
      const ref = { cat: c.cat, open, st: h.st, rows: [] };
      if (open) {
        const gb = mk('div', 'mk-gb');
        const sum = mk('div', 'mk-gsum');
        ref.sum = mk('span', 'mk-gsumt');
        ref.app = mk('span', 'mk-apponly');
        ref.app.append(mk('span', 'mk-apdot'), document.createTextNode(OPC_COPY.appOnly));
        ref.sum.append(document.createTextNode(''), ref.app);
        const ieAllExtras = document.createElement('button'); ieAllExtras.type = 'button'; ieAllExtras.className = 'mk-lnk';
        ref.lnk = ieAllExtras;
        lockControl(ieAllExtras, c.disabled);   // dark (R5) or under «Sin extras» (A2) — locked, so an un-inert never re-enables it
        ieAllExtras.addEventListener('click', bound(() => {
          const cur = IE.view(state.draft, s).extras.cards.find((x) => x.cat === c.cat);
          IE.set(s, 'extraGroupOn', { cat: c.cat, on: !cur || cur.active !== cur.size }); syncEdit();
        }));
        focusKey(ieAllExtras, `ie-all::${c.cat}`);
        sum.append(ref.sum, ieAllExtras);
        gb.append(sum);
        for (const r of c.rows) {
          const row = mk('div', 'mopt mk-xopt');
          const lab = mk('label', 'mk-xchk');
          const ieExtraOn = document.createElement('input'); ieExtraOn.type = 'checkbox'; ieExtraOn.checked = r.on; lockControl(ieExtraOn, c.disabled);
          ieExtraOn.addEventListener('change', bound(() => { IE.set(s, 'extraOn', { key: r.key, on: ieExtraOn.checked }); syncEdit(); }));
          focusKey(ieExtraOn, `ie-x::${r.key}`);
          lab.append(ieExtraOn, mk('span', 'mk-xnm', r.name));
          if (s2) {   // S2: the group's price, read-only here (repriced on the Extras page)
            row.append(lab, mk('span', 'mk-mp', r.price ? `L ${r.price}` : ''));
            gb.append(row);
            ref.rows.push({ key: r.key, row, cb: ieExtraOn, pi: null });
            continue;
          }
          // R4: the group's price, editable as today (it is the group's, not the dish's — shown for an unchecked extra too)
          const pr = mk('span', 'mopr');
          const ieExtraPrice = document.createElement('input');
          ieExtraPrice.type = 'text'; ieExtraPrice.inputMode = 'numeric'; ieExtraPrice.placeholder = 'Sin precio'; ieExtraPrice.value = r.price || '';
          ieExtraPrice.setAttribute('aria-label', `Precio de ${r.name}`);
          ieExtraPrice.addEventListener('input', bound(() => { IE.set(s, 'extraPrice', { key: r.key, raw: ieExtraPrice.value }); syncEdit(); }));
          focusKey(ieExtraPrice, `ie-xp::${r.key}`);
          pr.append(mk('span', 'mc', 'L'), ieExtraPrice);
          row.append(lab, pr);
          gb.append(row);
          ref.rows.push({ key: r.key, row, cb: ieExtraOn, pi: ieExtraPrice });
        }
        if (s2) {   // «Quitar de este producto»: detach.item into the COPY; off with the writer's line when the copy refuses it
          const foot = mk('div', 'mk-gfoot');
          const refused = IE.detachRefusal(state.draft, s, c.cat);
          const ieDetach = document.createElement('button'); ieDetach.type = 'button'; ieDetach.className = 'mk-lnk danger'; ieDetach.textContent = 'Quitar de este producto';
          lockControl(ieDetach, !s.extrasAuthoring || !!refused);
          ieDetach.addEventListener('click', bound(() => { IE.setGroupAttached(s, c.cat, false); relayout(); refocus(['ie-badd']); }));
          focusKey(ieDetach, `ie-detach::${c.cat}`);
          foot.append(ieDetach);
          if (refused) foot.append(mk('div', 'ferr mk-ferr', refused));
          gb.append(foot);
        }
        card.append(gb);
      }
      R.opc.cards.push(ref);
      box.append(card);
    }
    // STRUCTURE S2 — B: the dish action under the cards (MOCKUP frame B: .mk-adds > .railadd), ONLY with the server's Extras page;
    // off with the writer's line when the COPY refuses an attach (the X3b predicate)
    if (state.extrasCatalog === true && ex.show) {
      const adds = mk('div', 'mk-adds');
      const sheet = IE.attachSheet(state.draft, s);
      const ieAddGroup = document.createElement('button'); ieAddGroup.type = 'button'; ieAddGroup.className = 'railadd';
      ieAddGroup.append(svgPlusIcon(), document.createTextNode('Agregar grupo de extras'));
      lockControl(ieAddGroup, !ex.authoring || !sheet.canAdd);
      ieAddGroup.addEventListener('click', bound(() => bOpen(s, ieAddGroup, () => { relayout(); refocus(['ie-badd']); })));
      focusKey(ieAddGroup, 'ie-badd');
      adds.append(ieAddGroup);
      if (!sheet.canAdd && sheet.reason) adds.append(mk('div', 'ferr mk-ferr', sheet.reason));
      box.append(adds);
    }
    fOpc.append(lrO, box);
    body.append(fOpc);
  }

  const foot = mk('div', 'dwf');
  const ieCancel = document.createElement('button'); ieCancel.className = 'btn ghost'; ieCancel.type = 'button'; ieCancel.textContent = 'Cancelar';
  ieCancel.addEventListener('click', bound(() => { closeDrawer(); syncUi(); }));   // the bar is live again once the copy is gone
  const ieSave = document.createElement('button'); ieSave.className = 'btn accent'; ieSave.type = 'button'; ieSave.textContent = 'Guardar';
  ieSave.addEventListener('click', bound(() => saveEdit()));
  R.save = ieSave;
  R.dirty = mk('span', 'mk-dirty', 'Cambios sin guardar');   // frame 1: the quiet mark beside «Guardar»
  R.dirty.hidden = true;
  foot.append(ieCancel, mk('span', 'mk-sp'), R.dirty, ieSave);

  R.body = body;
  editRefs = R;
  d.setAttribute('aria-label', 'Editar producto');
  d.append(head, body, foot);
  d.classList.add('show');
  syncEdit();
  body.scrollTop = keepScroll;
  return true;
}
// The copy → the built drawer, in place: counters, change marks, the lines under the fields, the note, the option rows, «Guardar».
function syncEdit() {
  const s = editSess, R = editRefs;
  if (!s || !R || s.closed) return;
  const v = IE.view(state.draft, s);
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const chg = { name: v.changed.includes('name'), desc: v.changed.includes('desc'), cat: v.changed.includes('cat'), subcat: v.changed.includes('subcat'), price: v.changed.includes('price') };
  for (const [field, f] of Object.entries(R.flds)) {
    const msg = typeof v.errors[field] === 'string' ? v.errors[field] : null;
    f.classList.toggle('chg', !!chg[field] && !v.errors[field]);
    f.classList.toggle('invalid', !!v.errors[field]);
    if (R.errs[field]) { R.errs[field].remove(); R.errs[field] = null; }
    let lineId = null;
    if (msg) {
      const line = mk('div', 'ferr mk-ferr'); line.setAttribute('role', 'alert');
      lineId = `ie-err-${field}-${s.id}`; line.id = lineId;
      line.append(warnTri(), mk('span', null, msg));
      R.errs[field] = line;
      f.append(line);
    }
    // AA: the control is invalid while its field has a problem, and described by the line that says which (cleared with it)
    for (const c of R.ctl[field] || []) {
      if (v.errors[field]) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
      if (lineId) c.setAttribute('aria-describedby', lineId); else c.removeAttribute('aria-describedby');
    }
  }
  const over = (txt) => { const [a, b] = txt.split('/').map(Number); return a > b; };
  R.cnts.name.textContent = v.counters.name; R.cnts.name.classList.toggle('over', over(v.counters.name));
  R.cnts.desc.textContent = v.counters.desc; R.cnts.desc.classList.toggle('over', over(v.counters.desc));
  // the mockup's `.fld.invalid .mk-cnt` red, as the counter's own class (AA grammar)
  R.cnts.name.classList.toggle('mk-cnterr', !!v.errors.name);
  R.cnts.desc.classList.toggle('mk-cnterr', !!v.errors.desc);
  // the consequence note (D): only the lines that apply; none ⇒ no note
  R.note.replaceChildren();
  R.note.hidden = !v.consequences;
  if (v.consequences) {
    const ul = mk('ul', 'mk-cons');
    for (const l of v.consequences.lines) { const li = mk('li'); li.append(mk('span', 'mk-cdot'), mk('span', null, l)); ul.append(li); }
    R.note.append(mk('b', null, v.consequences.title), ul);
  }
  if (R.opts && v.options) {
    const bad = !!v.errors.options;
    R.optBlock.classList.toggle('mk-inv', bad);
    R.optCnt.classList.toggle('mk-cnterr', bad);   // the mockup's `.fld.invalid .mk-cnt` red (F2)
    // STRUCTURE S1 (Codex build r1 #2): a FOLDED required-choice card draws no option rows — only the ones drawn are synced
    v.options.forEach((o) => {
      const r = R.opts.find((x) => x.key === o.key);
      if (!r) return;
      r.cnt.textContent = o.counter;
      r.cnt.hidden = !(o.nearLimit || o.tooLong);   // an inline warning only near / past the limit
      r.cnt.classList.toggle('over', o.tooLong);
      r.row.classList.toggle('over', o.tooLong);
      if (r.pi.value !== o.price && document.activeElement !== r.pi) r.pi.value = o.price;
    });
    if (R.same) R.same.checked = v.same === true;
    if (R.gsub) R.gsub.textContent = opcNameLine(v.options, choiceGroup(state.draft, s.key));
  }
  // STRUCTURE S1 — the extras cards follow the copy in place (counts, the summary, the link, each row's check and price)
  if (R.opc) {
    for (const ref of R.opc.cards) {
      const c = v.extras.cards.find((x) => x.cat === ref.cat);
      if (!c) continue;
      setSegs(ref.st, opcExtSub(c, ref.open));
      if (!ref.open) continue;
      const custom = c.active < c.size;
      ref.sum.firstChild.textContent = custom ? `${c.active} de ${c.size} activos en este producto` : OPC_COPY.allOn;
      ref.app.hidden = !custom;
      ref.lnk.textContent = custom ? OPC_COPY.markAll : OPC_COPY.none;
      for (const r of ref.rows) {
        const row = c.rows.find((x) => x.key === r.key);
        if (!row) continue;
        r.cb.checked = row.on;
        r.row.classList.toggle('mk-xoff', !row.on);
        if (r.pi && r.pi.value !== (row.price || '') && document.activeElement !== r.pi) r.pi.value = row.price || '';   // S2: read-only text (no input) with extrasCatalog
      }
    }
  }
  R.save.disabled = !v.save.enabled;
  if (v.save.title) R.save.title = v.save.title; else R.save.removeAttribute('title');
  const dirty = IE.isDirty(s);
  R.dirty.hidden = !dirty;
  // the field the merchant is editing, with its selection — where «Seguir editando» returns the caret
  const ae = document.activeElement;
  if (R.body && ae && R.body.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) R.lastEdit = { el: ae };
  // the bar waits while the copy is dirty — repainted by syncUi (the one derivation) only when that changes: syncUi → setDrawerInert →
  // syncEdit would otherwise loop
  if (R.lastDirty !== dirty) { R.lastDirty = dirty; syncUi(); }
}
// «Guardar»: the whole edit into the shared draft, once; the drawer closes onto the list (the row shows its tag, the bar counts it).
function saveEdit() {
  const s = editSess;
  if (!s || s.closed) return;
  const r = IE.save(state.draft, s);
  if (!r.ok) { syncEdit(); return; }
  editSess = null; editUpload = null; editRefs = null;
  closeDrawer();
  // STRUCTURE S2 (§3.2): «Guardar» swaps in the composed document (the writer returns a new one), so the list is re-derived from
  // the draft — never painted from row objects the swap replaced
  repaintFromDraft();
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
    if (m) { f.classList.add('invalid'); f.append(mk('div', 'ferr', m)); }
    return f;
  };
  const after = () => { refreshBar(); paint(); };

  const head = mk('div', 'dwh');
  const title = mk('div', 'dwt', 'Nuevo producto');
  title.append(mk('span', 'newtag', 'Nuevo'));
  const close = closeIcon(() => { state.drawerKey = null; d.classList.remove('show'); });
  head.append(title, close);

  const body = mk('div', 'dwb');
  // DISH PHOTOS B — the approved «Agregar producto» hole becomes the zone (P1 inset); uploads off: today's note, exactly
  body.append(photoFieldFor(it) || field('Foto', mk('div', 'fotosoon', 'Foto: próximamente — por ahora se muestra el emoji de la sección.')));

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
  sec.addEventListener('change', bound(() => { setAddition(state.draft, id, 'cat', sec.value); state.selectedCat = sec.value; after(); renderDrawer(); holdDrawerForRename(); }));
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
  if (errFor('price')) { prf.classList.add('invalid'); prf.append(mk('div', 'ferr', errFor('price'))); }
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
    uploader.cancel(id);                      // DISH PHOTOS B — an upload for a product being removed has nowhere to land
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
  const restructure = (keys) => { after(); renderDrawer(); holdDrawerForRename(); refocus(keys); };
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
    fold.addEventListener('click', bound(() => { if (state.openGroups.has(foldKey)) state.openGroups.delete(foldKey); else state.openGroups.add(foldKey); renderDrawer(); holdDrawerForRename(); refocus(['fold']); }));
    h.append(fold);
  }
  grp.append(h);
  const labelErr = errOn && (errField === 'label' || errField === 'choices' || errField === 'prompt') ? errMsg : null;
  if (labelErr) { grp.classList.add('invalid'); grp.append(mk('div', 'ferr', labelErr)); }

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
      if (oErr) { row.classList.add('invalid'); gb.append(mk('div', 'ferr', oErr)); }
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
// `sess` (S4, advisor Q2): an edit drawer's working copy — the prices read from and write to the COPY; «Guardar» commits them.
function groupBlock(g, sess = null) {
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
    renderDrawer(); holdDrawerForRename();
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
    pi.value = sess ? sess.work.extraPrices[o.key] || '' : ((Number.isInteger(o.price) && o.price > 0) ? String(o.price) : '');
    pi.placeholder = 'Sin precio';
    // This one always hit the right ROW — o.key was captured — but in whatever draft happened to be
    // loaded. After a different person signed in, it priced THEIR menu.
    pi.addEventListener('input', bound(() => {
      if (sess) { IE.set(sess, 'extraPrice', { key: o.key, raw: pi.value }); syncEdit(); return; }
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

// shell-wait r7 (R2): the load this event started, so openEditor can hand it to the shell's bounded reveal (it settles, never throws)
let lastMenuLoad = null;
document.addEventListener('portal:restaurant', (e) => { lastMenuLoad = loadMenu(e.detail && e.detail.rid); });

// The review bar's own controls. Wired here, not inline: the CSP has no 'unsafe-inline', so an
// onclick attribute would be inert and the button would look enabled while doing nothing.
$('discard').addEventListener('click', () => {
  if (copyDirty()) return;   // unsaved edits: the whole bar waits (frame 1)
  if (canEditDraft(state.draft)) uploader.abortAll();   // DISH PHOTOS B — an upload in flight belongs to the edits thrown away
  discard(state.draft);
  endEditSession();                                     // S4: the drawer's working copy goes with the thrown-away edits
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
// S2 §5.2: `reviewed` — the merchant re-confirmed the full deletion list (REVIEW-DELETIONS); takeReviewAck consumes it, ONE resend
async function openReviewFlow() {
  if (copyDirty()) return;   // unsaved edits: never review around an open, dirty copy (the bar is inert; this is the admission)
  if (state.publishViaRequest) return sendToOwnerFlow();   // T-d: this caller sends; the owner's path below is untouched
  if (state.platformPending === true) return;   // F-2 r2 (Codex r1 P2-2): Sherpa is updating the menu — no save, no review, at ADMISSION (each flow owns its own)
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
      loadedBase: baseFor(submitted),   // S2 §3.4
      reviewed: takeReviewAck(),
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
      adoptExtraRefs(res.extraRefs);
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
    const att = attestationModel(diff, { usesPlatformFactura: state.usesPlatformFactura, legacy: photo.legacy, optionParent: productReviewCtx().optionParent,
      extraName: productReviewCtx().extraName });   // S4: a group's options fold under its «Nombre en factura»
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
    renderReview($('mbody'), reviewModel(state.review.diff, productReviewCtx()), { describe: describeAddition, photos: photoReviewOpts(), products: productReviewOpts() });
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
    }), { describe: describeAddition, photos: photoReviewOpts(), products: productReviewOpts() });   // S4 (frame E): current names on the seal
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
      showOutcome(outcomeFor(e, 'edit', extrasOutcomeCtx(state.draft)));
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
$('review').addEventListener('click', () => leaveExtras(openReviewFlow));   // S2 §3.5: the Extras page's local editors first (a complete row commits; a dirty one asks)

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
    showOutcome(outcomeFor(e, 'publish', extrasOutcomeCtx(state.draft)));
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
  renderReceipt($('mbody'), receiptFor(out.res, captured, { nameOf: photoNameOf }));
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
  state.draft = createDraft(withPhotos(fresh.source, fresh), { canEdit: () => editLockHolder === null && state.platformPending !== true, held: savedHold });
  state.sourceUpdateTime = fresh.sourceUpdateTime || null;
  state.usesPlatformFactura = fresh.usesPlatformFactura === true;
  applyPhotoFacts(fresh);                   // DISH PHOTOS B — the published photos' previews (public URLs) replace the draft ones
  applyAddProductFacts(fresh);
  applyPublishRequestFacts(fresh);          // T-d — a publish retires the owner's banner / badge (the request is no longer fresh)
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
// ── PLAN-portal-team-invites T-d — «Enviar al dueño para publicar» ─────────────────────────────────────────────────────
// A manager with the menu permission on a platform-factura brand (the SERVER's publish_via_request) never publishes. The SAME
// admission, lock and generation discipline as openReviewFlow; editCatalog saves the draft exactly as today, then
// catalogRequestPublish records the request with the edit token that save returned. No review, no attestation, no publishEdited.
// Every failure lands on the designed panels (outcomeFor), like the review's own save.
async function sendToOwnerFlow() {
  if (state.platformPending === true) return;   // F-2 r2 (Codex r1 P2-2): the same admission refusal for «Enviar al dueño»
  if (state.menuLoading) return;
  if (!state.draft || !state.draftRid) return;
  if (state.currentRid && state.currentRid !== state.draftRid) return;
  const lock = takeEditLock();
  if (lock === null) return;
  clearReview();
  bumpGeneration();
  const gen = opGeneration;
  syncUi();
  let writeId = null;
  try {
    const submitted = JSON.parse(JSON.stringify(draftSource(state.draft)));
    writeId = beginWrite(lock);
    const rid = state.draftRid;
    const res = await editCatalog({ rid, source: submitted, baseSourceUpdateTime: state.sourceUpdateTime, token, loadedBase: baseFor(submitted), reviewed: takeReviewAck() });   // S2 §3.4 · §5.2
    if (gen !== opGeneration) return;
    if (res && res.source) {
      adopt(state.draft, res.source);
      adoptExtraRefs(res.extraRefs);
      // the saved additions are now known by key — still unpublished, still removable (the review flow's bookkeeping)
      for (const a of ((res.diff && res.diff.added) || [])) if (a && a.surface === 'item' && typeof a.key === 'string') state.additionKeys.add(a.key);
    }
    if (res && res.updateTime) state.sourceUpdateTime = res.updateTime;
    await requestPublish({ rid, editToken: res && res.token, token });
    if (gen !== opGeneration) return;
    // PLAN-public-menu-display T1 (Codex r1 #3): what was just SENT is saved and still unpublished — keep it as the saved
    // half of the exclusion, from the server's own diff, before the local baseline moves forward
    { const sent = (res && res.diff) || {};
      const ch = Array.isArray(sent.changed) ? sent.changed : [];
      const names = ch.filter((c) => c && c.surface === 'category' && c.field === 'name');
      state.savedRenames = names.map((c) => ({ id: String(c.key), from: c.old, to: c.new }));
      state.savedOther = ch.length > names.length || ['added', 'removed', 'renamed'].some((k) => Array.isArray(sent[k]) && sent[k].length > 0); }
    commit(state.draft);                       // saved and sent: nothing of this snapshot is pending on THIS screen any more
    repaintFromDraft();
    document.dispatchEvent(new CustomEvent('portal:publish-request-sent'));   // pubreq.js: «Enviado al dueño para publicar»
  } catch (e) {
      if (gen !== opGeneration) return;      // a stale failure must not paint over the current world
      showOutcome(outcomeFor(e, 'edit', extrasOutcomeCtx(state.draft)));
      $('scrim').classList.add('show');
  } finally {
    endWrite(writeId, lock, gen);
    releaseEditLock(lock);                   // nothing stays live: no review holds the draft on this path
    if (gen === opGeneration) syncUi();
  }
}
// S4 (advisor ruling 11-10) — a field-tagged refusal of an EXISTING product's edit, with the text-edit switch on: the drawer's
// approved line as the title, «Es en «{producto}». Tus otros cambios siguen en el borrador.», and «Corregir», which reopens that
// product's drawer with the line under the field. Additions, and everything without the switch, keep today's panels exactly.
function productRefusal(outcome) {
  if (state.textEditEnabled !== true || !outcome || typeof outcome.target !== 'string' || !state.draft) return outcome;
  const it = ((draftSource(state.draft) || {}).items || []).find((r) => r && r.key === outcome.target);
  if (!it || isAddition(it) || (it.display && it.display.variantOf != null)) return outcome;
  const line = IE.refusalLine({ error: outcome.code, key: outcome.target, field: outcome.field, option_key: outcome.optionKey });
  if (!line) return outcome;
  const name = loadedName(state.draft, outcome.target) || photoNameOf(outcome.target);
  return { ...outcome, title: line.message, detail: `Es en «${name}». Tus otros cambios siguen en el borrador.`,
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir' }, productLine: line };
}
// C-1: the sections the order page shows, read again — ONLY renderedCategories is taken; the merchant's draft is never replaced
// STRUCTURE S2 §5.2 REVIEW-DELETIONS (frame X2b): the published menu moved under a removal claim. (1) re-read getEditableCatalog's
// deletionBase / deletionClaim ONLY (generation + rid checked; the draft kept); (2) show the FULL list from that read; (3) «Confirmar y seguir»
// resends the SAME request (the owner's save, or the manager's send) acknowledged, with the fresh base; (4) the review from the server's
// fresh diff. «Cancelar» keeps the draft. A second refusal lands here again — never a loop of silent resends.
async function reviewDeletions(outcome) {
  releaseEditLock(state.reviewLock);
  state.reviewLock = null;
  $('scrim').classList.remove('show');
  clearReview();
  reviewAck = false;
  const rid = state.draftRid, gen = opGeneration;
  let fresh = null;
  try { fresh = await apiFetch('getEditableCatalog', { rid, token }); } catch (_) { fresh = null; }
  if (gen !== opGeneration || rid !== state.draftRid) return;   // another world now
  const base = fresh && fresh.deletionBase;
  const read = !!(base && typeof base.version === 'string' && base.version && Number.isInteger(base.generation));
  // Codex r1 P1-1: the fresh baseline is the SHEET's until «Confirmar y seguir» — «Cancelar» keeps the previous one (an unreviewed save never
  // carries a base the merchant did not confirm the deletion list against)
  const freshBase = read ? { version: base.version, generation: base.generation } : null;
  const served = read && fresh.deletionClaim && Array.isArray(fresh.deletionClaim.ids) ? fresh.deletionClaim.ids : [];
  const ids = [...served, ...(Array.isArray(outcome.existingIds) ? outcome.existingIds : []), ...mergeDeletionClaim(draftSource(state.draft), 'ids')];
  openDeletionsReview({
    rows: deletionRows(state.draft, ids),
    line: read ? null : 'No pudimos leer el menú publicado. Recargá la página.',
    onCancel: () => { reviewAck = false; },
    onGo: bound(() => { if (freshBase) state.deletionBase = freshBase; reviewAck = true; if (state.publishViaRequest) sendToOwnerFlow(); else openReviewFlow(); }),
  });
}
// P-6 (plan r3 §3.3, Codex r2 #5): after a save is adopted, the view state keyed by a NEW extra's ref follows it to its allocated key —
// ONLY through the save answer's extraRefs (rekeyId); a ref the map does not name is DROPPED (its price is already in the adopted source).
// Covers the FIX-EXTRA row line and the focused detail field's restore key (data-k), so the repaint keeps focus on the SAME row.
function rekeyK(k, extraRefs) {   // a detail field's restore key ('{"ref":…}' or 'xnm:{"ref":…}') → its keyed price field, or null (dropped)
  if (typeof k !== 'string') return k;
  const pre = k.startsWith('xnm:') ? 'xnm:' : '';
  let id = null;
  try { id = JSON.parse(k.slice(pre.length)); } catch (_) { return k; }   // not an extra row's field
  if (!id || typeof id !== 'object' || typeof id.ref !== 'string') return k;
  const next = rekeyId(id, extraRefs);
  return next ? JSON.stringify(next) : null;   // a keyed row has no name field: its price
}
function adoptExtraRefs(extraRefs) {
  if (extrasRowError) { const id = rekeyId(extrasRowError.id, extraRefs); extrasRowError = id ? { id, text: extrasRowError.text } : null; }
  if (xFocusK) xFocusK = rekeyK(xFocusK, extraRefs);
  const ae = document.activeElement;
  if (!ae || !ae.dataset || typeof ae.dataset.k !== 'string' || !$('xdetail') || !$('xdetail').contains(ae)) return;
  const k = rekeyK(ae.dataset.k, extraRefs);
  if (k) ae.dataset.k = k; else delete ae.dataset.k;
}
async function rereadSections() {
  const rid = state.draftRid, gen = opGeneration;
  let fresh = null;
  try { fresh = await apiFetch('getEditableCatalog', { rid, token }); } catch (_) { fresh = null; }
  if (gen !== opGeneration || rid !== state.draftRid || !fresh || !Array.isArray(fresh.renderedCategories)) return;
  state.renderedCategories = fresh.renderedCategories.filter((c) => typeof c === 'string');
}
function showOutcome(outcome) {
  outcome = productRefusal(outcome);
  if (outcome && outcome.action && outcome.action.id === PUBLISH_ACTIONS.REVIEW_DELETIONS) { reviewDeletions(outcome); return; }
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
      // the DRAFT moved under us: refetch it and start over — after asking, if an open product holds unsaved edits
      await requestClose(async () => { $('scrim').classList.remove('show'); await loadMenu(state.currentRid); });
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
    if (id === PUBLISH_ACTIONS.FIX_EXTRA) {
      // STRUCTURE S2 §5.2 — an EXTRA needs a correction: the «Extras» tab, that extra's group, its row with the server's line under it
      // (focus: a new row's name, a published row's price); extras_group_empty → the group the server named, its «Agregar extra» row open
      $('scrim').classList.remove('show');
      clearReview();
      const ctx = extrasOutcomeCtx(state.draft);
      const named = outcome.target && ctx.isExtra(outcome.target) ? outcome.target : null;
      const g = outcome.group || (named ? ctx.groupOf(named) : null);
      if (g) extrasGroup = g;
      extraAdd = null; extraAddK = null;
      extrasRowError = named ? { id: outcome.targetIs === 'ref' ? { ref: named } : { key: named }, text: outcome.detail } : null;
      prodTab = 'xpage';
      paint(); syncUi();
      if (outcome.code === 'extras_group_empty' && outcome.group) { addOpen(); return; }
      if (extrasRowError) {
        const k = JSON.stringify(extrasRowError.id);
        const all = [...$('xdetail').querySelectorAll('[data-k]')];
        const ctl = all.find((x) => x.dataset.k === `xnm:${k}`) || all.find((x) => x.dataset.k === k);
        if (ctl) ctl.focus();
      }
      return;
    }
    if (id === PUBLISH_ACTIONS.FIX && outcome.productLine) {
      // S4 — back to editing, with the existing product's drawer open and the server's line under the field it named
      const line = outcome.productLine;
      $('scrim').classList.remove('show');
      clearReview();
      const host = (draftSource(state.draft).items || []).find((i) => i && i.key === line.key);
      if (host && host.display && host.display.cat) state.selectedCat = host.display.cat;
      paint(); syncUi();
      if (line.reread) await rereadSections();
      openDrawer(line.key);
      if (editSess && editSess.key === line.key) {
        IE.setServerError(editSess, line); syncEdit();
        // AA ruling 11-10: focus the field the line names (a derived option name is fixed in Nombre)
        const ctl = editRefs && (editRefs.ctl[line.field === 'options' ? 'name' : line.field] || [])[0];
        if (ctl && typeof ctl.focus === 'function') ctl.focus();
      }
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
      await requestClose(async () => { $('scrim').classList.remove('show'); clearReview(); await resetToLive(state.draftRid, state.sourceUpdateTime); });   // unsaved edits: ask first
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
  resetEditFacts();                        // S4 — the world's per-load facts (S2 §1.1) fail closed until the next load sets them
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
  if (state.draft === null) endPhotoWorld();   // DISH PHOTOS B — a different person: their uploads are not this one's
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
  return { pendingWrite: !!pendingWrite || uploader.busy(), publishing: !!publisher.busy || !!state.settle, review: !!state.review, reviewLock: !!state.reviewLock,
    pendingCount: (state.draft ? pendingCount(state.draft, state.additionKeys) + pendingRenames(state.draft).length : 0) + (copyDirty() ? 1 : 0) + (localDirty() ? 1 : 0), focusedTag: a ? a.tagName : null };   // + an unsaved open copy (addendum note) · S2 §3.5: the Extras page's local editors
}
try {
  const S = window.SherpaClient;
  if (S && !S.inert) S.registerAdapter({ canReload: () => portalCanReload(portalReloadFacts()), blockedNotice: 'Nueva versión: guardá tus cambios para actualizar' });
} catch (_) { /* the module never breaks the portal */ }

// ── PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §5.2) — shell.js owns discovery, the brand/branch switcher and the ONE
// selection per page load. These are the only two additions to this module; everything above is unchanged.
// openEditor: the selected branch holds catalog.read_editor → the editor opens on it, ONCE per page. It mirrors
// loadRestaurants' tail (state.currentRid, then the restaurant event) without the switcher render or the localStorage write.
// `sales` rides on the event for ventas.js (§11 A3: Ventas is owner-only in 1a); a detail without it behaves as today.
export function openEditor(rid, { name = rid, sales } = {}) {
  state.restaurants = [{ rid, name }];
  state.currentRid = rid;
  lastMenuLoad = null;
  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid, sales } }));
  return lastMenuLoad;   // shell-wait r7: the catalog's first load — the shell's reveal waits for it (bounded)
}
// The self-update guard, reused verbatim to block a branch switch while the merchant has unsaved work or an operation open.
export const editorCanLeave = () => portalCanReload(portalReloadFacts());
// STRUCTURE S2 §3.5 — the reload / close (beforeunload): the browser's own prompt while unsaved work exists (a pending change, an open
// copy, the Extras page's local editors) or a write is in flight. Not on focus alone (that rule is the self-update's, not a close).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('beforeunload', (e) => {   // a host without it (a test shell): no prompt, never a crash
  const f = portalReloadFacts();
  if (!(f.pendingWrite || f.publishing || f.pendingCount > 0)) return;
  e.preventDefault();
  e.returnValue = '';
});

// PLAN-portal-shell-no-shift (Codex r2 P1): shell.js presents its recovery box after a boot failure / the discovery deadline;
// the editor's held catalog LOAD belongs to an abandoned world and must not repaint over it — reads only (Codex r3).
document.addEventListener('portal:abandon', () => { readGeneration += 1; });
// STRUCTURE S2: the «Menú» / «Extras» tabs — VIEW state only (which page shows), never a write, so not world-bound; ← / → move between
// them (the tablist pattern)
const tabKey = (t) => (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const next = t === 'menu' ? 'xpage' : 'menu';
  setProdTab(next);
  const nb = $(next === 'menu' ? 'tabmenu' : 'tabextras'); if (nb) nb.focus();
};
if ($('tabmenu') && $('tabextras')) {
  $('tabmenu').addEventListener('click', () => setProdTab('menu'));
  $('tabextras').addEventListener('click', () => setProdTab('xpage'));
  $('tabmenu').addEventListener('keydown', tabKey('menu'));
  $('tabextras').addEventListener('keydown', tabKey('xpage'));
}
