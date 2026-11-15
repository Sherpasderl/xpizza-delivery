// Portal 2b-2b Task 3 — THE EDIT STATE.
//
// 🔴 MONEY. This module holds a merchant's uncommitted price changes and produces the source document
// that editCatalog validates and publishEdited publishes. Everything a customer is charged for a
// changed dish passes through here first.
//
// THE DRAFT IS A SOURCE DOCUMENT, not a view model. The approved mock keeps {sections, groups} — a
// shape invented for the demo. What editCatalog actually sends is `body.source`, and validateSource
// checks THAT. Keeping a separate edit model would mean translating back at publish time, and the
// translation is exactly where a price goes missing. So the draft IS the document, edited in place.
//
// Pure and DOM-free on purpose: node can import it, so every rule below is asserted directly rather
// than through a rendered page.
//
// STILL NOT IMPLEMENTED HERE: removing an EXISTING item, adding or removing an option, category edits other than a
// section's display NAME (PLAN-public-menu-display T1; see "A SECTION'S NAME" at the end).
// There is no setter for them in this file — not a disabled one, not a guarded one. A capability that does not exist
// cannot be reached by accident.
// S4 (PLAN-portal-item-edit) — an EXISTING product's name, description and section ARE here, through ONE whole-drawer
// mutator (editItem, at the end): the key and every identity stay; the server records the rename.
//
// 1D add-product A — ADDING a plain product IS here, and it writes NO key: a new row carries only a temporary
// reference (`ref: 'tmp:<uuid>'`) and its display fields; the SERVER allocates the pricing key and id on save
// (editCatalog), and the portal ADOPTS the canonical source it returns. Only an addition can be edited beyond its
// price (name / description / section — while it is still unsaved) or removed again ("Quitar").
//
// 1D add-product B — a NEW product may carry a required choice (its own options; see "A REQUIRED CHOICE" below). That is
// not the extras ("opcionales") the paragraph above means: an existing extra still cannot be added, removed or renamed.

const clone = (v) => JSON.parse(JSON.stringify(v));

// The server's rule is isPositiveInt: Number.isInteger(p) && p > 0. This is the client half of it, and
// it must REFUSE rather than repair. parseInt('12.9') is 12 and parseInt('12abc') is 12 — both are a
// different price from the one the merchant typed, and a wrong price is worse than a rejected one:
// rejection is visible, truncation is not. Digits only, nothing clever.
export function parsePrice(raw) {
  // isSafeInteger here too, matching the string branch: a value past 2^53 cannot round-trip, and a
  // price that cannot be represented is not a price whichever type it arrives as.
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^[0-9]+$/.test(s)) return null;      // ASCII digits only — no signs, decimals, exponents, hex or non-Latin numerals
  const n = Number(s);
  // isSafeInteger, not isInteger: past 2^53 a value cannot round-trip exactly, and a price that
  // cannot be represented is not a price.
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ORIG is the yardstick every change is measured against and what discard restores; STATE is what the
// merchant is editing. Both are deep clones, so nothing here can reach back into the object the
// caller loaded — if an edit did, a change would compare equal to itself, the review screen would list
// nothing, and the merchant would publish a price they were never shown.
// `canEdit` is THE STATE BOUNDARY. Every user-editing mutator asks it before touching anything.
//
// 🔴 DOM inertness is only an affordance. Removing a node does not remove its listeners, and neither
// `inert` nor `disabled` stops a programmatic dispatch — so a retained reference to a drawer input
// could still fire and change an extra's price by its closed-over key WHILE THE MERCHANT WAS SIGNING
// for a snapshot that did not include it. Reproduced: an extra moving 20→99 during attestation.
//
// Guarding at the DOM was always going to be a game of finding every node. Guarding here is one
// question asked in one place, and it covers every stale listener, every retained reference and every
// handler that has not been written yet.
//
// Defaults to permissive so the pure tests — which own no lock and have no UI — read naturally.
export function createDraft(source, opts = {}) {
  const draft = { orig: clone(source), state: clone(source) };
  // 🔴 THE BOUNDARY IS FIXED AT CONSTRUCTION. canEdit is what every mutator asks, so as a plain
  // property it was one assignment away from `() => true` — the entire boundary disabled at runtime,
  // with no change to any mutator and nothing at the call site for a reader or a checker to notice.
  // Non-writable and non-configurable: it cannot be replaced, redefined or deleted.
  Object.defineProperty(draft, 'canEdit', {
    value: typeof opts.canEdit === 'function' ? opts.canEdit : () => true,
    writable: false, configurable: false, enumerable: true,
  });
  // PLAN-public-menu-display T1 (Codex r1 P2-2/P2-3) — what the SERVER says is already pending against the published menu
  // ('names' | 'prices' | null), from the caller; fixed at construction like canEdit. See "A RENAME PUBLISHES ALONE" below.
  Object.defineProperty(draft, 'held', {
    value: typeof opts.held === 'function' ? opts.held : () => null,
    writable: false, configurable: false, enumerable: true,
  });
  // Sealed, not frozen, and the difference is the point: no property may be ADDED or REMOVED, so the
  // draft's shape is fixed — but `orig` and `state` stay writable, because discard() and commit()
  // assign them and the document has to remain editable through the guarded setters.
  return Object.seal(draft);
}

// One predicate, asked by every mutator below. Exported so callers can render an affordance from the
// same answer the guard uses, rather than keeping a second opinion.
export const canEditDraft = (draft) => !!(draft && draft.canEdit());
// 🔴 A RENAME PUBLISHES ALONE (server: rename_not_alone) — held HERE, at the state boundary every content mutator asks, not at
// the controls: a drawer opened before the rename keeps its live inputs (Codex r1 P2-2), and a control that is merely
// disabled can still be dispatched. A pending section NAME (local, or one the server says is saved and unpublished) refuses
// every price / product / choice write; a pending price or product refuses a name (setCategoryNames).
const canEditContent = (draft) => canEditDraft(draft) && pendingRenames(draft).length === 0 && draft.held() !== 'names';

export function discard(draft) {
  // A user action like any other: refused while an operation owns the draft. Throwing the merchant's
  // edits away mid-attestation would change the very document being signed for.
  if (!canEditDraft(draft)) return draft;
  draft.state = clone(draft.orig);
  return draft;
}

// 🔴 THE PUBLISHED STATE BECOMES THE BASELINE. The opposite of discard, and the two must never be
// confused: after a successful publish the live menu IS the draft, so ORIG moves forward to it.
//
// Calling discard() there — which shipped — reset the editor to the PRE-EDIT prices: it showed 299
// after publishing 310, and the next unrelated edit carried 299 into the diff and silently reverted
// the price that had just gone live. A merchant would have had to publish twice for one change to
// stick, and would never have been told why.
export function commit(draft) {
  draft.orig = clone(draft.state);
  return draft;
}

// 🔴 COMMIT THE SNAPSHOT THAT WAS PUBLISHED, not whatever the draft holds now.
//
// The two differ whenever the merchant kept editing after opening the review: edit to 310 → review →
// edit again to 320 → publish. What went live is the 310 that was REVIEWED and saved; commit(draft)
// would move the baseline to 320, marking a price that never published as live — invisible in the
// pending count and, with the saved-draft dead end, unpublishable.
//
// Committing the submitted snapshot instead leaves 320 correctly pending.
export function commitTo(draft, publishedSource) {
  draft.orig = clone(publishedSource);
  return draft;
}

// The document to send. Deliberately the live object rather than a copy: callers read it to hash,
// diff and POST, and a copy taken here would be one more thing that can fall out of step.
export function draftSource(draft) {
  return draft.state;
}

// A row's identity on the screen: its key once the server allocated one, its temporary reference until then.
export const rowId = (row) => (row && typeof row.key === 'string' ? row.key : (row && typeof row.ref === 'string' ? row.ref : undefined));
const rowMatches = (r, id) => (id && typeof id === 'object'
  ? (typeof id.key === 'string' ? r.key === id.key : (typeof id.ref === 'string' && typeof r.key !== 'string' && r.ref === id.ref))
  : r.key === id);
const isTmp = (row) => !!(row && typeof row.ref === 'string' && row.ref.startsWith('tmp:') && !('key' in row));

const rowsOf = (src, surface) => (surface === 'item'
  ? (Array.isArray(src.items) ? src.items : [])
  : (Array.isArray(src.extras) ? src.extras : []));

function setPrice(draft, surface, key, raw) {
  // THE BOUNDARY. A mutation arriving while the draft is not owned for editing — from a detached
  // listener, a retained reference, a stray dispatch — is refused here, whatever the DOM looks like.
  if (!canEditContent(draft)) return draft;
  const row = rowsOf(draft.state, surface).find((r) => r && rowMatches(r, key));
  // An unknown key is a NO-OP, never a new row. Creating one here would be an accidental back door to
  // "add item", which writes a pricing key and belongs to 2b-2c.
  if (!row) return draft;
  const next = parsePrice(raw);
  row.price = next;
  // price and display.price MOVE TOGETHER: validateSource fails a source whose display.price disagrees
  // with the authoritative one, so a one-sided edit is unpublishable — and it fails at the server,
  // after the merchant believed they were finished.
  //
  // Only when the row already HAS a display.price. The agreement check is conditional, so a row that
  // never carried one is valid without it; inventing the field would change the document's shape, and
  // the shape is what the CAS hash is taken over.
  if (row.display && typeof row.display === 'object' && 'price' in row.display) row.display.price = next;
  return draft;
}

export const setItemPrice = (draft, key, raw) => setPrice(draft, 'item', key, raw);
// STRUCTURE S2 (advisor 2026-11-12): a NEW extra's name — ONLY a keyless row, by its { ref } (it has no identity yet: renaming it is the
// inline row's own field, not the S2b rename). A key, a string id or a ref that names a keyed row is a NO-OP. Runs of spaces collapse
// (the caller trims on blur, so typing a space between words survives).
export function setExtraName(draft, id, raw) {
  if (!canEditContent(draft)) return draft;
  if (!id || typeof id !== 'object' || typeof id.ref !== 'string' || typeof id.key === 'string') return draft;
  const row = rowsOf(draft.state, 'extra').find((r) => r && typeof r.key !== 'string' && r.ref === id.ref);
  if (!row || !row.display || typeof row.display !== 'object') return draft;
  row.display.name = String(raw ?? '').replace(/\s+/g, ' ');
  return draft;
}
// STRUCTURE S2 (PLAN-portal-structure-S2-ui r3 §3.3): an extra by its key (a string, S1's callers, or { key }) OR — a new one the
// server has not allocated yet — by { ref }, which matches ONLY a keyless row (the writer's own predicate, exposure-transitions.js
// extra.remove); a new row never gets a key, id or stamp here
export const setExtraPrice = (draft, id, raw) => setPrice(draft, 'extra', id, raw);

// ── 1D add-product A — ADDING A PLAIN PRODUCT ──────────────────────────────────────────────────────────────────
// A new row: the temporary reference the caller minted, the section it goes in, and nothing the server owns (no
// key, no id, no identity stamp). Appended at the END of item_order — the server refuses anything else. The price
// starts empty (the merchant types it) and is held unvalidated like any other price field.
export function addProduct(draft, { ref, cat, subcat = null } = {}) {
  if (!canEditContent(draft)) return draft;
  if (typeof ref !== 'string' || !ref.startsWith('tmp:') || typeof cat !== 'string' || !cat) return draft;
  const st = draft.state;
  if (!Array.isArray(st.items)) st.items = [];
  if (st.items.some((r) => r && r.ref === ref)) return draft;
  const display = { cat, name: '', price: null };
  if (typeof subcat === 'string' && subcat) display.subcat = subcat;
  st.items.push({ ref, price: null, display });
  st.structure = st.structure || {};
  if (!Array.isArray(st.structure.item_order)) st.structure.item_order = [];
  st.structure.item_order.push(ref);
  return draft;
}

// Edit an UNSAVED addition's field. name / desc / cat / subcat only while it is still a temporary row: once the
// server allocated its key, the name IS the key for some brands, so it is no longer the merchant's to retype here
// (they can still change its price, or remove it). Price goes through parsePrice like every price.
// The branches below ARE the field whitelist: any other field (key, id, identity_id…) matches none and writes nothing.
export function setAddition(draft, ref, field, raw) {
  if (!canEditContent(draft)) return draft;
  const row = rowsOf(draft.state, 'item').find((r) => r && r.ref === ref && isTmp(r));
  if (!row || isOptionRow(row)) return draft;   // an option is edited through the group mutators below
  if (field === 'price') {
    // 1D add-product B (§0d.2/§0d.5): with a required choice the product's price is DERIVED from its options (or set with
    // them by setGroupPrice, the ONE mutator) — never written alone here
    if (groupOfRow(draft.state, row)) return draft;
    const next = parsePrice(raw);
    row.price = next;
    row.display.price = next;
    return draft;
  }
  const v = typeof raw === 'string' ? raw : '';
  if (field === 'name') row.display.name = v;
  else if (field === 'desc') { if (v.trim()) row.display.desc = v; else delete row.display.desc; }
  else if (field === 'cat') { if (v) { row.display.cat = v; delete row.display.subcat; } }
  else if (field === 'subcat') { if (v) row.display.subcat = v; else delete row.display.subcat; }
  return draft;
}

// "Quitar": remove an ADDITION — an unsaved row (its tmp reference) or a saved-but-unpublished one (its key, when the
// caller's set of saved additions holds its key). Never an existing published item: removing those is not an add-product capability.
// 1D add-product B — a product with a required choice goes WITH its options and its variant_items entry (one unit, as the
// server allocates and compares it); an option on its own is never removed here (removeChoice owns that, on an unsaved group).
export function removeAddition(draft, id, savedAdditions = new Set()) {
  if (!canEditContent(draft)) return draft;
  const items = rowsOf(draft.state, 'item');
  const saved = savedAdditions instanceof Set ? savedAdditions : new Set();
  const i = items.findIndex((r) => r && rowId(r) === id && (isTmp(r) || (typeof r.key === 'string' && saved.has(r.key))));
  if (i === -1) return draft;
  if (isOptionRow(items[i])) return draft;
  const g = groupOfRow(draft.state, items[i]);
  const row = items[i];
  if (g) dropGroup(draft.state, g);
  dropDishUnit(draft.state, row);
  return draft;
}
// ONE dish unit leaves the source: its row, its item_order entry and its photos entry — shared by removeAddition and removeProduct
// («Quitar del menú») so the two cannot drift (PLAN-portal-remove-product r3 §4.1 step 3).
function dropDishUnit(st, row) {
  const id = rowId(row);
  const items = rowsOf(st, 'item');
  items.splice(items.indexOf(row), 1);
  dropFromOrder(st, id);
  // DISH PHOTOS B (codex r1 #1) — its photo goes with it: a `source.photos` key with no matching item fails editCatalog's
  // validation (the amended tmp-ref rule), so an orphan here would make the next save unsavable
  const pm = st.photos && typeof st.photos === 'object' ? st.photos : null;
  if (pm && Object.prototype.hasOwnProperty.call(pm, id)) { delete pm[id]; if (!Object.keys(pm).length) delete st.photos; }
}

// ── «Quitar del menú» (PLAN-portal-remove-product r3, APPROVED 11-12; MOCKUP-portal-remove-product.html) ──────────────────────────
// The served live order (P-R9, 5f `liveOrder: { items, rewards }`), well-formed — without it nothing is removed or restored (Q-13:
// never a guessed order).
const validLiveOrder = (lo) => !!(lo && Array.isArray(lo.items) && lo.items.every((k) => typeof k === 'string') && Array.isArray(lo.rewards)
  && lo.rewards.every((k) => typeof k === 'string'));
// §2 — the ONE predicate (the drawer's action and both writers ask it). ctx: { on (the server's productRemoval), baseReadable
// (state.deletionBase), liveOrder (P-R9), savedAdditions (the server's unpublished additions) }. → { show, enabled, code }: rows 1–5
// HIDE the action (U3); row 6 (no readable base / no live order) shows it disabled with the U2 line. app.js passes the two served
// collections POSITIONALLY (`liveOrder`, `savedAdditions` — the portal-wiring rule: a state reference travels only as a ruled consumer's
// argument, never inside a literal); they default to ctx's.
export function canRemoveProduct(draft, key, ctx = {}, liveOrder = ctx && ctx.liveOrder, savedAdditions = ctx && ctx.savedAdditions) {
  const no = (code, show = false) => ({ show, enabled: false, code });
  if (!ctx || ctx.on !== true) return no('off');
  if (!draft || !canEditContent(draft)) return no('not_editable');
  const row = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === key);
  if (!row) return no('unknown_item');
  const saved = savedAdditions instanceof Set ? savedAdditions : new Set();
  if (isTmp(row) || typeof row.key !== 'string' || saved.has(row.key)) return no('new_item');   // a «Nuevo» dish keeps «Descartar»
  if (isOptionRow(row) || groupOfRow(draft.state, row)) return no('has_options');                // advisor ruling (b), until S3
  const sid = row.display && row.display.identity_id;
  if (typeof sid !== 'string' || !sid) return no('unstamped');                                   // the server would refuse a RESET
  if (ctx.baseReadable !== true || !validLiveOrder(liveOrder)) return no('base_unreadable', true);
  return { show: true, enabled: true, code: null };
}
// §4.2 / P-R9 — the ONE order rebuild: item_order = the live order filtered to what is present, THEN the draft's additions (keys the
// live order does not hold) in their relative order — the server's rule (add-product.js: new products go at the end); rewards = the
// live rewards filtered to what is present, then any other entry. Pure over the source; false (nothing written) without the live order.
export function rebuildOrders(st, liveOrder) {
  if (!st || typeof st !== 'object' || !validLiveOrder(liveOrder)) return false;
  const present = new Set(rowsOf(st, 'item').map(rowId).filter((k) => typeof k === 'string'));
  st.structure = st.structure || {};
  const liveItems = new Set(liveOrder.items);
  const cur = Array.isArray(st.structure.item_order) ? st.structure.item_order : (st.structure.item_order = []);
  const nextItems = [...liveOrder.items.filter((k) => present.has(k)), ...cur.filter((k) => !liveItems.has(k))];
  cur.splice(0, cur.length, ...nextItems);
  const rei = st.structure.redeem_eligible_items;
  if (Array.isArray(rei) || liveOrder.rewards.length) {
    const liveRewards = new Set(liveOrder.rewards);
    const next = [...liveOrder.rewards.filter((k) => present.has(k)), ...(Array.isArray(rei) ? rei : []).filter((k) => !liveRewards.has(k))];
    if (Array.isArray(rei)) rei.splice(0, rei.length, ...next); else st.structure.redeem_eligible_items = next;
  }
  return true;
}
// §4.1 — remove a PUBLISHED plain dish as one unit, all or nothing: its row, order entry and photo (dropDishUnit), its OWN entries
// (P-R4, 5f d1309843: item_overrides[key], extras_by_item[key] — the map itself stays, B-3 — and its rewards entry), and its identity
// stamp claimed (Ruling A). → { ok:true, snap } (P-R1's shape; the caller's stash, for «Deshacer») | { ok:false, code }.
export function removeProduct(draft, key, ctx = {}, liveOrder = ctx && ctx.liveOrder, savedAdditions = ctx && ctx.savedAdditions) {
  const p = canRemoveProduct(draft, key, ctx, liveOrder, savedAdditions);
  if (!p.enabled) return { ok: false, code: p.code };
  const st = draft.state;
  const row = rowsOf(st, 'item').find((r) => r && r.key === key);
  const s = st.structure || {};
  const ov = s.exposure && s.exposure.item_overrides && typeof s.exposure.item_overrides === 'object' ? s.exposure.item_overrides : null;
  const ebi = s.extras_by_item && typeof s.extras_by_item === 'object' ? s.extras_by_item : null;
  const rei = Array.isArray(s.redeem_eligible_items) ? s.redeem_eligible_items : null;
  const order = Array.isArray(s.item_order) ? s.item_order : [];
  const pm = st.photos && typeof st.photos === 'object' ? st.photos : null;
  const j = order.indexOf(key), ri = rei ? rei.indexOf(key) : -1;
  // `after` / `redeem_index` are kept in P-R1's shape but NEVER place anything: §4.2 rebuilds both orders from P-R9
  const snap = clone({ key, identity_id: row.display.identity_id, row, after: j > 0 ? order[j - 1] : null, photo: pm && own(pm, key) ? pm[key] : null,
    refs: { item_override: ov && own(ov, key) ? ov[key] : null, extras_by_item: ebi && own(ebi, key) ? ebi[key] : null, redeem_index: ri === -1 ? null : ri } });
  dropDishUnit(st, row);
  if (ov && own(ov, key)) delete ov[key];
  if (ebi && own(ebi, key)) delete ebi[key];
  if (ri !== -1) rei.splice(ri, 1);
  mergeDeletionClaim(st, { add: [row.display.identity_id] });
  rebuildOrders(st, liveOrder);
  return { ok: true, snap };
}
// §4.2 — «Deshacer»: put the dish back from `snap` (the in-session stash: the row as it was just before the removal, D-2; or P-R1's
// entry after a reload — row, photo, refs), withdraw its stamp, and rebuild both orders from the served live order (never from snap).
// Codex HIGH r1 P2 — the snapshot's OWN refs must still resolve in the draft as it is NOW (an extra or a group deleted between the removal
// and «Deshacer» would make the restored entry name what the source no longer has: the REAL save refuses the whole draft, invalid_source).
// The server validator's rules for these fields (source-store.js): item_overrides add / deny name declared extra GROUPS, deny_extras
// names existing extra KEYS; an extras_by_item value names either.
function staleRefs(st, refs) {
  const s = (st && st.structure) || {};
  const extras = rowsOf(st || {}, 'extra');
  const groups = new Set((Array.isArray(s.extra_categories) ? s.extra_categories : extras.map((e) => e && e.display && e.display.cat)).filter((g) => g != null).map(String));
  const keys = new Set(extras.map((e) => e && e.key).filter((k) => typeof k === 'string'));
  const ov = refs && refs.item_override;
  if (ov && typeof ov === 'object') {
    for (const g of [...(Array.isArray(ov.add) ? ov.add : []), ...(Array.isArray(ov.deny) ? ov.deny : [])]) if (!groups.has(String(g))) return true;
    for (const k of (Array.isArray(ov.deny_extras) ? ov.deny_extras : [])) if (!keys.has(String(k))) return true;
  }
  const ebi = refs && refs.extras_by_item;
  if (Array.isArray(ebi)) for (const v of ebi) if (!groups.has(String(v)) && !keys.has(String(v))) return true;
  return false;
}
export function undoRemoveProduct(draft, key, snap, liveOrder) {
  if (!draft || !canEditContent(draft)) return { ok: false, code: 'not_editable' };
  if (!validLiveOrder(liveOrder)) return { ok: false, code: 'base_unreadable' };
  if (!snap || !snap.row || snap.row.key !== key) return { ok: false, code: 'unknown_item' };
  if (staleRefs(draft.state, snap.refs)) return { ok: false, code: 'refs_stale' };   // nothing written
  const st = draft.state;
  if (!Array.isArray(st.items)) st.items = [];
  if (st.items.some((r) => r && r.key === key)) return { ok: false, code: 'present' };
  // the row goes where the live order puts it among the rows (canonical items follow item_order); additions stay after it
  const rank = (k) => { const i = liveOrder.items.indexOf(k); return i === -1 ? Infinity : i; };
  const at = rank(key);
  const pos = st.items.findIndex((r) => rank(rowId(r)) > at);
  st.items.splice(pos === -1 ? st.items.length : pos, 0, clone(snap.row));
  if (snap.photo) { if (!st.photos || typeof st.photos !== 'object') st.photos = {}; st.photos[key] = clone(snap.photo); }
  const refs = snap.refs || {};
  st.structure = st.structure || {};
  if (refs.item_override != null) {
    st.structure.exposure = st.structure.exposure || {};
    st.structure.exposure.item_overrides = st.structure.exposure.item_overrides || {};
    st.structure.exposure.item_overrides[key] = clone(refs.item_override);
  }
  if (refs.extras_by_item != null) { st.structure.extras_by_item = st.structure.extras_by_item || {}; st.structure.extras_by_item[key] = clone(refs.extras_by_item); }
  const sid = snap.row.display && snap.row.display.identity_id;
  if (typeof sid === 'string' && sid) mergeDeletionClaim(st, { withdraw: [sid] });
  rebuildOrders(st, liveOrder);
  return { ok: true };
}
// ── the READ side app.js paints from (§3.3 / §9) — pure readers; every row they hand back is a COPY, so nothing the caller keeps
// reaches the session's stash or the served list
// The dishes pending removal, key → the snapshot «Deshacer» restores: the session's stash first (the row as it was just before the
// removal, D-2), else the SAVED draft's P-R1 entry (`served`: the live row, its photo and refs). A key the draft holds again is not pending.
export function pendingRemovalsOf(draft, stash, served) {
  const out = new Map();
  if (!draft) return out;
  const present = new Set(rowsOf(draft.state, 'item').map(rowId).filter((k) => typeof k === 'string'));
  if (stash instanceof Map) for (const [k, snap] of stash) if (typeof k === 'string' && snap && snap.row && !present.has(k)) out.set(k, clone(snap));
  for (const r of (Array.isArray(served) ? served : [])) if (r && typeof r.key === 'string' && r.row && !present.has(r.key) && !out.has(r.key)) out.set(r.key, clone(r));
  return out;
}
// The list's DISPLAY projection, never sent: the source with each pending row back at its live place — the SAME rebuildOrders a restore
// runs over P-R9's live order, so the list and «Deshacer» agree. The draft is not touched (its arrays are copied before the rebuild).
export function removalListSource(draft, pending, liveOrder) {
  const src = draftSource(draft);
  if (!(pending instanceof Map) || !pending.size || !validLiveOrder(liveOrder)) return src;
  const st = src.structure || {};
  const out = { ...src, items: [...(src.items || []), ...[...pending.values()].map((p) => clone(p.row))],
    structure: { ...st, item_order: Array.isArray(st.item_order) ? [...st.item_order] : [], ...(Array.isArray(st.redeem_eligible_items) ? { redeem_eligible_items: [...st.redeem_eligible_items] } : {}) } };
  rebuildOrders(out, liveOrder);
  return out;
}
// A removed dish's row for the review's names and places: the pending snapshot's, else the LOADED draft's (orig) — a copy, or null
export function removedRowOf(draft, pending, key) {
  const p = pending instanceof Map ? pending.get(key) : null;
  if (p && p.row) return clone(p.row);
  const r = rowsOf((draft && draft.orig) || {}, 'item').find((x) => x && x.key === key);
  return r ? clone(r) : null;
}
// Every dish row a deletion list can name (U1 / U5): the loaded draft, the draft now and the pending snapshots — copies
export function removalDishRows(draft, pending) {
  const rows = [...rowsOf((draft && draft.orig) || {}, 'item'), ...rowsOf((draft && draft.state) || {}, 'item'), ...(pending instanceof Map ? [...pending.values()].map((p) => p.row) : [])];
  return rows.filter((r) => r && r.display).map(clone);
}

// ADOPT the server's canonical source after a save: allocated keys and ids replace the temporary references, in the
// server's canonical order — so the review, and every later save, shows and sends server truth. Not a user edit and
// not gated by canEdit: it runs while the review owns the draft, with the response that review is built from.
// ORIG is untouched — what was loaded stays the yardstick until a publish reloads it.
export function adopt(draft, canonical) {
  if (!canonical || typeof canonical !== 'object' || !Array.isArray(canonical.items)) return draft;
  draft.state = clone(canonical);
  return draft;
}

// What actually differs from what was loaded — never a log of keystrokes. Typing a price back to its
// original value is not a change, and counting it as one would tell a merchant they have unpublished
// work when they have none, and put a no-op on the review screen.
//
// 1D add-product A — and ADDED / REMOVED rows count. A row in the draft that the loaded document did not have is an
// unsaved addition (or an adopted one); a row the loaded document had and the draft no longer does is a removed
// addition. Not counting them was a dirty-guard hole: a product typed but not yet saved read as "nothing pending",
// so a deploy-triggered self-update reload could throw it away.
// 1D add-product B (§0d.5) — a NEW product with a required choice is ONE pending change, not 1 + N: its options are added (or
// removed) with it, so an option whose product is itself added (or removed) is folded into the product's entry. The review,
// built from the server's diff, still lists every option.
export function pendingChanges(draft, savedAdditions = new Set()) {
  const saved = savedAdditions instanceof Set ? savedAdditions : new Set();
  const out = [];
  for (const surface of ['item', 'extra']) {
    const origRows = rowsOf(draft.orig, surface);
    const stateRows = rowsOf(draft.state, surface);
    const inOrig = (row) => origRows.some((r) => r && rowId(r) === rowId(row));
    const inState = (row) => stateRows.some((r) => r && rowId(r) === rowId(row));
    for (const row of stateRows) {
      const id = rowId(row);
      const was = origRows.find((r) => r && rowId(r) === id);
      if (!was) {
        const parent = surface === 'item' ? parentOf(draft.state, row) : null;
        if (parent && !inOrig(parent)) continue;   // folded into its new product
        out.push({ surface, key: id, from: null, to: row.price, added: true }); continue;
      }
      if (was.price === row.price) continue;
      out.push({ surface, key: id, from: was.price, to: row.price });
    }
    for (const was of origRows) {
      const id = rowId(was);
      if (inState(was)) continue;
      const parent = surface === 'item' ? parentOf(draft.orig, was) : null;
      if (parent && !inState(parent)) continue;     // folded into its removed product
      out.push({ surface, key: id, from: was.price, to: null, removed: true });
    }
  }
  return foldNewGroups(draft, out, saved);
}
// 1D add-product B (§0d.5, codex PB-3 P2-3) — a NEW product's choice group is ONE pending change however many of its rows
// moved: a shared-price edit (the product + every option), one option's price (and the product's derived price with it),
// or "Ninguna" on a saved group (its options removed). The entries collapse into one on the PRODUCT. A published group
// (La Musa's Pad Thai) is not folded — its rows count exactly as before. The review and the fiscal seal are built from
// the SERVER's diff, so every option is still listed there.
function foldNewGroups(draft, entries, saved) {
  const isNew = (row) => !!row && !isOptionRow(row) && (isTmp(row) || (typeof row.key === 'string' && saved.has(row.key)));
  const launcherOf = (key) => {
    const st = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === key);
    const or = rowsOf(draft.orig, 'item').find((r) => r && rowId(r) === key);
    const row = st || or;
    if (!row || !isOptionRow(row)) return null;
    return (st && parentOf(draft.state, st)) || (or && parentOf(draft.orig, or)) || null;
  };
  const hasGroup = (key) => {
    const st = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === key);
    const or = rowsOf(draft.orig, 'item').find((r) => r && rowId(r) === key);
    return !!((st && groupOfRow(draft.state, st)) || (or && groupOfRow(draft.orig, or)));
  };
  const own = new Map();   // launcher key → its group's collapsed entry
  const out = [];
  for (const e of entries) {
    if (e.surface !== 'item') { out.push(e); continue; }
    const l = launcherOf(e.key);
    const lKey = l ? rowId(l) : (hasGroup(e.key) ? e.key : null);
    const launcher = l || (lKey !== null ? (rowsOf(draft.state, 'item').find((r) => r && rowId(r) === lKey) || rowsOf(draft.orig, 'item').find((r) => r && rowId(r) === lKey)) : null);
    // an OPTION's entry always folds into its new product; the product's OWN entry folds only when it is a price change
    // (an added / removed product already carries its options — the loops above skipped them)
    if (lKey === null || !isNew(launcher) || (!l && (e.added || e.removed))) { out.push(e); continue; }
    if (own.has(lKey)) continue;
    const was = rowsOf(draft.orig, 'item').find((r) => r && rowId(r) === lKey);
    const now = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === lKey);
    const entry = { surface: 'item', key: lKey, from: was ? was.price : null, to: now ? now.price : null, group: true };
    own.set(lKey, entry); out.push(entry);
  }
  return out;
}

// DISH PHOTOS B — a photo change is a change like any other (mockup P7: «1 cambio sin publicar · 1 foto"), counted here and
// nowhere in pendingChanges, whose entries light PRICE cells by key.
// S4 (item edit) — and so is an existing product's text or section: one per changed field (Nombre, Descripción, Categoría),
// MOCKUP-portal-item-edit B («4 cambios sin publicar · 1 producto»).
// STRUCTURE S1 — and so is a dish's extras checklist or «Sin extras» (Codex S1 plan r1 #1): a SAVED one is pending work after the
// drawer closed, so the reload / branch-switch / self-update guard (portalReloadFacts) still holds it.
export const pendingCount = (draft, savedAdditions) => pendingChanges(draft, savedAdditions).length + pendingPhotos(draft).length
  + pendingTexts(draft).reduce((n, t) => n + t.fields.length, 0) + pendingDishExtras(draft).reduce((n, t) => n + t.sentences, 0)
  + pendingStructure(draft).length;

// ── DISH PHOTOS B (PLAN-dish-photos §2.1 / §2.2) — THE DRAFT PHOTO MAP ────────────────────────────────────────────────
// `source.photos` = {[itemKey]: {state:'pid', pid} | {state:'removed'}}; an absent key is LEGACY. It is part of the document
// editCatalog saves (the whole map every save), and it is ABSENT when empty — a photo-less draft is byte-identical to
// today's. A key is a row's id: its pricing key, or its `tmp:` reference while unsaved (editCatalog re-keys that entry to
// the allocated key in the canonical source it returns — §2.2 amendment 2026-10-27). The entry is written ONLY from a pid
// E-P2 / E-P3 returned (the caller's), or the removed / restored states below.
const photoMap = (src) => (src && src.photos && typeof src.photos === 'object' && !Array.isArray(src.photos) ? src.photos : null);
export const draftPhotos = (draft) => photoMap(draft && draft.state) || {};
export const origPhotos = (draft) => photoMap(draft && draft.orig) || {};
// One mutator: `entry` null = back to absent (legacy). Refused while the draft is owned, while a section name waits (ruling A:
// a photo is content, and a rename publishes alone — canEditContent, like every price write), for a row that is not in the
// draft, and for any entry that is not one of the two states.
export function setPhoto(draft, id, entry) {
  if (!canEditContent(draft)) return draft;
  if (!rowsOf(draft.state, 'item').some((r) => r && rowId(r) === id)) return draft;
  const ok = entry === null || (entry && entry.state === 'removed' && Object.keys(entry).length === 1)
    || (entry && entry.state === 'pid' && typeof entry.pid === 'string' && entry.pid && Object.keys(entry).length === 2);
  if (!ok) return draft;
  const map = { ...draftPhotos(draft) };
  if (entry === null) delete map[id]; else map[id] = entry.state === 'pid' ? { state: 'pid', pid: entry.pid } : { state: 'removed' };
  if (Object.keys(map).length) draft.state.photos = map; else delete draft.state.photos;
  return draft;
}
// Keys whose photo differs from what was loaded (the bar's «· N fotos").
export function pendingPhotos(draft) {
  const a = draftPhotos(draft); const b = origPhotos(draft);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  // «Quitar del menú» (Codex HIGH r1 P3, MOCKUP R3 «1 cambio»): a PUBLISHED dish no longer in the draft took its photo entry with it —
  // that cleanup is the removal (pendingChanges counts it once), never also a photo change
  const present = new Set(rowsOf((draft && draft.state) || {}, 'item').map((r) => r && r.key));
  const gone = (k) => !present.has(k) && rowsOf((draft && draft.orig) || {}, 'item').some((r) => r && r.key === k);
  return [...keys].filter((k) => !gone(k) && JSON.stringify(a[k] || null) !== JSON.stringify(b[k] || null)).sort();
}

// Rows whose current value is not a price. The value is HELD rather than discarded — a field that
// snapped back mid-keystroke would fight the merchant — so the draft can legitimately be in this
// state, and the publish path is what must refuse it.
export function invalidKeys(draft) {
  const out = [];
  for (const surface of ['item', 'extra']) {
    for (const row of rowsOf(draft.state, surface)) {
      if (!(Number.isInteger(row.price) && row.price > 0)) out.push({ surface, key: rowId(row) });
    }
  }
  return out;
}

// Fail closed. The server would refuse a non-positive price anyway, but it would do so later and less
// clearly — after the review, after the attestation, as a 400 on a screen that had said everything
// was ready.
// 1D add-product A — an unsaved addition with no name cannot be saved (the server refuses name_required); say so
// here, on the row, rather than after the review.
// 1D add-product B — and an unsaved required choice needs its name, at least 2 options and a name on every option (the server
// refuses label_required / choices_too_few / choice_label_required); the reference returned is the row the field lives on.
export function incompleteAdditions(draft) {
  const out = rowsOf(draft.state, 'item').filter((r) => isTmp(r) && !isOptionRow(r) && !(r.display && typeof r.display.name === 'string' && r.display.name.trim())).map((r) => r.ref);
  for (const r of rowsOf(draft.state, 'item')) {
    if (!isTmp(r) || isOptionRow(r)) continue;
    const g = groupOfRow(draft.state, r);
    if (!g) continue;
    if (!(typeof g.spec.label === 'string' && g.spec.label.trim()) || g.options.length < 2) { if (!out.includes(r.ref)) out.push(r.ref); }
    for (const o of g.options) if (!(typeof o.display.choice === 'string' && o.display.choice.trim())) out.push(o.ref);
  }
  return out;
}
export const isPublishable = (draft) => invalidKeys(draft).length === 0 && incompleteAdditions(draft).length === 0;

// ── 1D add-product B (rev 6, UNIFORM) — A REQUIRED CHOICE ON A NEW PRODUCT ("Elección requerida — el cliente elige 1") ─────
// The SERVER's shape, nothing invented (catalog/add-product.js prepareGroups): the product row is the LAUNCHER; each option
// is its own priced row `{ref, price, display: {variantOf: <launcher ref>, choice, price, tags?}}`; and
// structure.variant_items[<launcher ref>] = {label, variantIds: [<option refs>]}. The server derives everything derivable —
// each option's full name "{product} - {choice}", its section, its "sin extras" — so none of it is written here.
// After a save the references are the server's: variantOf / the map key / variantIds become DISPLAY ids (a separate
// namespace from pricing keys, §0b.2), so a group is found by its launcher's display id once it has one.
//
// The group's STRUCTURE (name, options, Recomendada, sin extras) is the merchant's while the product is unsaved, like its
// name; once saved it is fixed and only PRICES stay editable (and "Quitar" removes the whole unit). A published group (La
// Musa's Pad Thai) is never touched by anything below: every mutator requires an UNSAVED launcher, or a saved one the
// server listed as an unpublished addition.
//
// PRICES (§0d.2, §0d.5): the product's own price is DERIVED — the cheapest option — and recomputed on every option change
// (legacy, never charged). "Mismo precio para todas" is the caller's convenience over ONE mutator, setGroupPrice, which sets
// the product and every option together; a single option's price goes through setChoicePrice. Held invalid input stays on
// the field it was typed in, exactly like every other price.
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isOptionRow = (row) => !!(row && row.display && typeof row.display === 'object' && (own(row.display, 'variantOf') || own(row.display, 'choice')));
// the id a group refers to a row by: its tmp reference while unsaved, its display id after the server allocated one
const groupRefOf = (row) => (isTmp(row) ? row.ref : (row && row.display && row.display.id != null ? String(row.display.id) : undefined));
const variantMap = (st) => (st && st.structure && st.structure.variant_items && typeof st.structure.variant_items === 'object' ? st.structure.variant_items : null);
function groupOfRow(st, launcher) {
  const vm = variantMap(st);
  const gk = groupRefOf(launcher);
  if (!vm || gk === undefined || !own(vm, gk) || !vm[gk] || !Array.isArray(vm[gk].variantIds)) return null;
  const items = rowsOf(st, 'item');
  const options = vm[gk].variantIds.map((v) => items.find((r) => r && groupRefOf(r) === String(v))).filter(Boolean);
  return { key: gk, spec: vm[gk], launcher, options };
}
function parentOf(st, row) {
  if (!isOptionRow(row) || row.display.variantOf == null) return null;
  return rowsOf(st, 'item').find((r) => r && !isOptionRow(r) && groupRefOf(r) === String(row.display.variantOf)) || null;
}
function dropFromOrder(st, id) {
  const order = st.structure && st.structure.item_order;
  if (Array.isArray(order)) { const j = order.indexOf(id); if (j !== -1) order.splice(j, 1); }
}
// Remove a group's options and its map entry. The map itself goes back to ABSENT when it empties — exactly today's shape
// for a brand with no groups (the server's §0b.2 exception); a brand that has one (La Musa) keeps the rest in order.
function dropGroup(st, g) {
  const items = rowsOf(st, 'item');
  for (const o of g.options) { const i = items.indexOf(o); if (i !== -1) items.splice(i, 1); dropFromOrder(st, rowId(o)); }
  const vm = variantMap(st);
  delete vm[g.key];
  if (!Object.keys(vm).length) delete st.structure.variant_items;
  if (g.launcher && g.launcher.display) delete g.launcher.display.extras_policy;
}
// A launcher the merchant may edit: unsaved, or saved and listed by the server as an unpublished addition.
function editableLauncher(draft, id, savedAdditions) {
  const saved = savedAdditions instanceof Set ? savedAdditions : new Set();
  const row = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === id);
  if (!row || isOptionRow(row) || !(isTmp(row) || (typeof row.key === 'string' && saved.has(row.key)))) return null;
  return row;
}
const setRowPrice = (row, next) => { row.price = next; if (row.display && typeof row.display === 'object') row.display.price = next; };
// The product's price follows its options: the cheapest usable one, or none while no option has a usable price.
function recomputeLauncher(g) {
  const ok = g.options.map((o) => o.price).filter((p) => Number.isInteger(p) && p > 0);
  setRowPrice(g.launcher, ok.length ? Math.min(...ok) : null);
}
// Insert after the group's last row in item_order (still among the appended additions, which is all the server allows).
function orderAfter(st, afterId, id) {
  st.structure = st.structure || {};
  if (!Array.isArray(st.structure.item_order)) st.structure.item_order = [];
  const order = st.structure.item_order;
  const j = order.indexOf(afterId);
  if (j === -1) order.push(id); else order.splice(j + 1, 0, id);
}

// The group on a product, for the drawer and the review: {label, extrasNone, options}, or null. Read-only.
export function choiceGroup(draft, id) {
  const row = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === id);
  if (!row || isOptionRow(row)) return null;
  const g = groupOfRow(draft.state, row);
  if (!g) return null;
  return { label: typeof g.spec.label === 'string' ? g.spec.label : '', extrasNone: !!(row.display && row.display.extras_policy === 'none'), options: g.options };
}
// Is this row an option of a group whose product is NEW (unsaved, or listed as an unpublished addition)? Those rows belong
// under their product in the drawer and the review, not as products of their own.
export function isNewGroupOption(draft, row, savedAdditions = new Set()) {
  const p = isOptionRow(row) ? parentOf(draft.state, row) : null;
  return !!(p && editableLauncher(draft, rowId(p), savedAdditions));
}
// The product an option belongs to (its row id), or null — so a refusal the server names on an OPTION opens its product.
export function optionParentId(draft, id) {
  const row = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === id);
  const p = row ? parentOf(draft.state, row) : null;
  return p ? rowId(p) : null;
}
// "Mismo precio para todas" is DERIVED on load: on iff every option has the same price (§0d.5).
export function optionPricesEqual(draft, id) {
  const g = choiceGroup(draft, id);
  return !!(g && g.options.length && g.options.every((o) => o.price === g.options[0].price));
}

// Ninguna ⇄ a group. ON creates the group with the given option references (2, from the caller), each at the product's
// current price; OFF ("Ninguna") removes the options, the map entry and "sin extras" — zero residue.
export function setRequiredChoice(draft, id, on, optionRefs = [], savedAdditions = new Set()) {
  if (!canEditContent(draft)) return draft;
  const st = draft.state;
  // OFF ("Ninguna") on any NEW product — unsaved, or saved and listed as an unpublished addition (§0b.8): the product stays,
  // its group goes. A published group is never reachable here (editableLauncher refuses it).
  if (!on) { const el = editableLauncher(draft, id, savedAdditions); const g = el ? groupOfRow(st, el) : null; if (g) dropGroup(st, g); return draft; }
  // ON only while the product is unsaved: a saved product's structure is fixed
  const l = rowsOf(st, 'item').find((r) => r && rowId(r) === id && isTmp(r) && !isOptionRow(r));
  if (!l) return draft;
  const g = groupOfRow(st, l);
  if (g) return draft;
  const refs = Array.isArray(optionRefs) ? optionRefs.filter((r) => typeof r === 'string' && r.startsWith('tmp:')) : [];
  if (refs.length !== optionRefs.length || new Set(refs).size !== refs.length || refs.some((r) => rowsOf(st, 'item').some((x) => x && x.ref === r))) return draft;
  st.structure = st.structure || {};
  if (!variantMap(st)) st.structure.variant_items = {};
  st.structure.variant_items[l.ref] = { label: '', variantIds: [] };
  for (const r of refs) addChoice(draft, id, r);
  return draft;
}
export function setGroupLabel(draft, id, raw) {
  if (!canEditContent(draft)) return draft;
  const l = editableLauncher(draft, id);
  const g = l && isTmp(l) ? groupOfRow(draft.state, l) : null;
  if (g) g.spec.label = typeof raw === 'string' ? raw : '';
  return draft;
}
export function setGroupExtrasNone(draft, id, on) {
  if (!canEditContent(draft)) return draft;
  const l = editableLauncher(draft, id);
  if (!l || !isTmp(l) || !groupOfRow(draft.state, l)) return draft;
  if (on) l.display.extras_policy = 'none'; else delete l.display.extras_policy;
  return draft;
}
// "Agregar opción": a new unnamed option, at the price given (the caller's shared price) or else the product's.
export function addChoice(draft, id, ref, raw) {
  if (!canEditContent(draft)) return draft;
  const l = editableLauncher(draft, id);
  const g = l && isTmp(l) ? groupOfRow(draft.state, l) : null;
  if (!g || typeof ref !== 'string' || !ref.startsWith('tmp:') || rowsOf(draft.state, 'item').some((x) => x && x.ref === ref)) return draft;
  const price = raw === undefined ? (Number.isInteger(l.price) && l.price > 0 ? l.price : null) : parsePrice(raw);
  draft.state.items.push({ ref, price, display: { variantOf: l.ref, choice: '', price } });
  orderAfter(draft.state, g.options.length ? rowId(g.options[g.options.length - 1]) : l.ref, ref);
  g.spec.variantIds.push(ref);
  recomputeLauncher({ ...g, options: [...g.options, draft.state.items[draft.state.items.length - 1]] });
  return draft;
}
// × on an unsaved option.
export function removeChoice(draft, id, ref) {
  if (!canEditContent(draft)) return draft;
  const l = editableLauncher(draft, id);
  const g = l && isTmp(l) ? groupOfRow(draft.state, l) : null;
  const o = g && g.options.find((x) => x.ref === ref);
  if (!o) return draft;
  const items = rowsOf(draft.state, 'item');
  items.splice(items.indexOf(o), 1);
  dropFromOrder(draft.state, ref);
  g.spec.variantIds.splice(g.spec.variantIds.indexOf(ref), 1);
  recomputeLauncher({ ...g, options: g.options.filter((x) => x !== o) });
  return draft;
}
function editableOption(draft, id, savedAdditions) {
  const o = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === id && isOptionRow(r));
  const p = o ? parentOf(draft.state, o) : null;
  const l = p ? editableLauncher(draft, rowId(p), savedAdditions) : null;
  return l ? { o, g: groupOfRow(draft.state, l) } : null;
}
export function setChoiceName(draft, id, raw) {
  if (!canEditContent(draft)) return draft;
  const x = editableOption(draft, id);
  if (x && isTmp(x.o)) x.o.display.choice = typeof raw === 'string' ? raw : '';
  return draft;
}
// RECOMENDADA, per option (the contract's choice badge; the caller shows it only where the brand's picker draws it).
export function setChoiceRecommended(draft, id, on) {
  if (!canEditContent(draft)) return draft;
  const x = editableOption(draft, id);
  if (!x || !isTmp(x.o)) return draft;
  if (on) x.o.display.tags = ['recommended']; else delete x.o.display.tags;
  return draft;
}
// ONE option's price (turning "Mismo precio" off is the caller's); the product's derived price follows.
export function setChoicePrice(draft, id, raw, savedAdditions = new Set()) {
  if (!canEditContent(draft)) return draft;
  const x = editableOption(draft, id, savedAdditions);
  if (!x) return draft;
  setRowPrice(x.o, parsePrice(raw));
  recomputeLauncher(x.g);
  return draft;
}
// THE group price mutator ("Mismo precio para todas"): the product AND every option, from one parse, together.
export function setGroupPrice(draft, id, raw, savedAdditions = new Set()) {
  if (!canEditContent(draft)) return draft;
  const l = editableLauncher(draft, id, savedAdditions);
  const g = l ? groupOfRow(draft.state, l) : null;
  if (!g) return draft;
  const next = parsePrice(raw);
  for (const o of g.options) setRowPrice(o, next);
  setRowPrice(l, next);
  return draft;
}

// ── Task 4 — OPTION GROUPS ───────────────────────────────────────────────────────────────────────
// The approved mock models options as first-class `groups` with an id and a required/optional `type`.
// THE REAL SCHEMA HAS NEITHER, verified against both live sources:
//
//   • `extras` is a FLAT priced list. A "group" is just the distinct `display.cat` values across it —
//     x_pizza has "Salsas & Queso" / "Carnes" / "Vegetales & Hierbas", la_musa has "Acompañamientos" /
//     "Salsas" / "Proteínas".
//   • there is no `type` field anywhere, so the mock's required-vs-optional distinction cannot be
//     rendered truthfully and is not invented here.
//   • `structure.extras_by_category` and `extras_by_item` say WHERE a group is exposed.
//
// Groups are DERIVED on read rather than stored, so there is no second model to keep in step with the
// document — the same reason the draft is the source itself.
export function optionGroups(draft) {
  const out = [];
  const byName = new Map();
  for (const ex of (draft.state.extras || [])) {
    if (!ex || typeof ex.key !== 'string') continue;
    // An extra with no cat is still a priced line a customer can buy. It goes in an unnamed group
    // rather than disappearing — the read-only render's rule (nothing silently vanishes) holds here.
    const name = (ex.display && typeof ex.display.cat === 'string' && ex.display.cat) || null;
    if (!byName.has(name)) { const g = { name, options: [] }; byName.set(name, g); out.push(g); }
    byName.get(name).options.push(ex);
  }
  return out;
}

// Which PRODUCTS reach this group — by category exposure and by direct item exposure, both of which
// count. Returns item keys so a caller can name them, not just count them.
export function productsUsingGroup(draft, groupName) {
  const st = draft.state.structure || {};
  const byCat = st.extras_by_category || {};
  const byItem = st.extras_by_item || {};
  const out = [];
  for (const it of (draft.state.items || [])) {
    if (!it || typeof it.key !== 'string') continue;
    const cat = it.display && it.display.cat;
    const viaCat = Array.isArray(byCat[cat]) && byCat[cat].includes(groupName);
    const viaItem = Array.isArray(byItem[it.key]) && byItem[it.key].includes(groupName);
    if (viaCat || viaItem) out.push(it.key);
  }
  return out;
}

// 🔴 A NUMBER, OR NULL — never a misleading zero.
//
// x_pizza declares NEITHER exposure map, while its extras are demonstrably sold. Reporting "en 0
// productos" for a group customers order from every day would be a confident false statement about a
// merchant's own menu, and the note exists to build trust in the editor. When the source says nothing
// about exposure, the honest answer is that it says nothing, and the note stays silent.
//
// A source that DOES declare exposure and simply never names this group is a real zero, and says so.
export function groupUsage(draft, groupName) {
  const st = draft.state.structure || {};
  const declares = st.extras_by_category !== undefined || st.extras_by_item !== undefined;
  if (!declares) return null;
  return productsUsingGroup(draft, groupName).length;
}

// ── PLAN-public-menu-display T1 — A SECTION'S NAME ────────────────────────────────────────────────────────────────
// The one field of a category the edit path may change (server: compareToActive, `sameCategoriesExceptName`). The id,
// the order, the count and every other field stay frozen, so nothing here touches anything but `name`.
//
// Two server rules shape it:
//   • A RENAME PUBLISHES ALONE (`rename_not_alone`): a draft that renames may change nothing else. The caller keeps the
//     two apart (app.js); this module only reports both sides — pendingRenames here, pendingChanges above.
//   • ALL-OR-NOTHING where names are optional: none named, or every one. setCategoryNames therefore applies a SET of names
//     at once and refuses the whole set if any one is not a name — a half-applied set is the state the server refuses.
// Where names are REQUIRED a name can never be removed: there is no way to clear one here at all.
const CATEGORY_NAME_MAX = 40;
const catsOf = (src) => (src && src.structure && Array.isArray(src.structure.categories) ? src.structure.categories : []);
const catNameOf = (cat) => (cat && typeof cat.name === 'string' && cat.name.trim() ? cat.name : null);
// The server's `body` sink (display-safety.js): no markup characters, no entity that decodes to one.
const MARKUP = /[<>]|&(?:lt|gt|#0*(?:60|62)|#x0*3[ce]);?/i;
// 'empty' | 'long' | 'markup' | null — the reason a typed value is not a name. Refuse, never repair: the name saved is
// the name typed (trimmed, inner runs of spaces collapsed — the one normalisation, applied the same everywhere).
const cleanCategoryName = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '');
export function categoryNameProblem(raw) {
  const v = cleanCategoryName(raw);
  if (!v) return 'empty';
  if (v.length > CATEGORY_NAME_MAX) return 'long';
  if (MARKUP.test(v)) return 'markup';
  return null;
}
// `names`: [[categoryId, typedValue], …]. Every id must be a declared section and every value a name, or NOTHING changes.
export function setCategoryNames(draft, names) {
  if (!canEditDraft(draft) || pendingCount(draft) > 0 || draft.held() === 'prices') return draft;
  const cats = catsOf(draft.state);
  const next = [];
  for (const [id, raw] of (Array.isArray(names) ? names : [])) {
    const cat = cats.find((c) => c && String(c.id) === String(id));
    if (!cat || categoryNameProblem(raw) !== null) return draft;
    next.push([cat, cleanCategoryName(raw)]);
  }
  for (const [cat, v] of next) cat.name = v;
  return draft;
}
// The sections whose name differs from the baseline, in section order: { id, from, to } (null = no name).
export function pendingRenames(draft) {
  const orig = catsOf(draft.orig);
  const out = [];
  for (const cat of catsOf(draft.state)) {
    const was = orig.find((c) => c && cat && String(c.id) === String(cat.id));
    const from = catNameOf(was), to = catNameOf(cat);
    if (from !== to) out.push({ id: String(cat.id), from, to });
  }
  return out;
}
// No section has a name yet: then they can only be named together (all-or-nothing), never one at a time.
export function categoriesUnnamed(draft) {
  const cats = catsOf(draft.state);
  return cats.length > 0 && cats.every((c) => catNameOf(c) === null);
}


// ── S4 (PLAN-portal-item-edit r6 + addendum S4) — AN EXISTING PRODUCT'S NAME, DESCRIPTION AND SECTION ─────────────────────
// The «Editar producto» drawer edits a working copy (item-edit-logic.js) and hands the WHOLE edit here once, on «Guardar».
// editItem applies it ALL OR NOTHING: every field is judged first, and one refusal writes nothing — an invalid name can never
// be half-saved next to a price. It is the explicit whitelist: name / desc / cat / subcat / price / option prices / photo.
// The key, display.id and every identity stamp are never written; the SERVER records the rename (S1a frozen_keys).
// A product with a required choice renames WITH its options: each option's name is derived, «{producto} - {opción}», exactly
// the server's rule (source-store.js:592; S1a re-derives it too), and the section moves with it. Choices, keys and prices stay.
export const ITEM_NAME_MAX = 60;
export const ITEM_DESC_MAX = 200;
const charCount = (s) => [...String(s)].length;
// The server's own folds: tidyName (stored form) and normalizeName (what counts as the same name) — catalog/add-product.js.
export const tidyItemName = (raw) => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '');
const foldName = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// A name reaches an attribute sink (display-safety.js `attribute`): markup, an entity that decodes to it, or a quote.
const QUOTE = /["'`]/;
// The opaque id syntax new products are keyed by (plan §2.2): a name may never look like one.
const OPAQUE = /^i_[a-z2-7]{12}$/i;
const existingRow = (st, key) => rowsOf(st, 'item').find((r) => r && typeof r.key === 'string' && r.key === key && !isTmp(r) && !isOptionRow(r)) || null;
const membersOf = (st, row) => { const g = groupOfRow(st, row); return g ? g.options : []; };
const derivedName = (name, opt) => `${name} - ${opt && opt.display && typeof opt.display.choice === 'string' ? opt.display.choice : ''}`;

// 'empty' | 'long' | 'quote' | 'unavailable' | 'taken' | 'option_long' | null. A value equal to the LOADED one is grandfathered
// (the server caps only newly authored values), however long. `reserved`: getEditableCatalog's reservedNames (already folded
// by the server's normalizeName) — a name may not take one, unless it is the OWN key of the record the name belongs to (the
// product's key for its name; each option's key for its derived name), so a rename back always passes (S2 §1.1, G4).
export function itemNameProblem(draft, key, raw, reserved = null) {
  const row = existingRow(draft.state, key);
  if (!row) return null;
  const v = tidyItemName(raw);
  const was = existingRow(draft.orig, key);
  if (was && was.display && was.display.name === v) return null;
  if (!v) return 'empty';
  if (charCount(v) > ITEM_NAME_MAX) return 'long';
  if (MARKUP.test(v) || QUOTE.test(v)) return 'quote';
  if (OPAQUE.test(v)) return 'unavailable';
  const mine = new Set([row, ...membersOf(draft.state, row)]);
  const others = rowsOf(draft.state, 'item').filter((r) => r && !mine.has(r));
  const names = (n) => others.some((o) => (o.display && typeof o.display.name === 'string' && foldName(o.display.name) === n) || (typeof o.key === 'string' && foldName(o.key) === n))
    || rowsOf(draft.state, 'extra').some((e) => e && e.display && typeof e.display.name === 'string' && foldName(e.display.name) === n);
  if (names(foldName(v))) return 'taken';
  const held = (n, rec) => !!reserved && typeof reserved.has === 'function' && reserved.has(foldName(n)) && foldName(n) !== foldName(rec.key);
  if (held(v, row)) return 'unavailable';
  const opts = membersOf(draft.state, row);
  if (opts.some((o) => charCount(derivedName(v, o)) > ITEM_NAME_MAX)) return 'option_long';
  if (opts.some((o) => names(foldName(derivedName(v, o))))) return 'taken';
  if (opts.some((o) => held(derivedName(v, o), o))) return 'unavailable';
  return null;
}
// 'long' | 'markup' | null (the `body` rule). Empty is fine: the description is optional.
export function itemDescProblem(draft, key, raw) {
  const v = typeof raw === 'string' ? raw : '';
  const was = existingRow(draft.orig, key);
  if (was && was.display && (was.display.desc || '') === v) return null;
  if (charCount(v) > ITEM_DESC_MAX) return 'long';
  if (MARKUP.test(v)) return 'markup';
  return null;
}
// 'unknown' | 'subcat_required' | 'section_empty' | 'subsection_empty' | null — the target must be a section the page shows,
// one of ITS subsections when it has any (chosen, never preselected), and the move may not leave a section or subsection empty.
export function itemCategoryProblem(draft, key, { cat, subcat = null } = {}) {
  const row = existingRow(draft.state, key);
  if (!row) return 'unknown';
  const target = catsOf(draft.state).find((c) => c && String(c.id) === String(cat));
  if (!target) return 'unknown';
  const subs = Array.isArray(target.subcats) ? target.subcats.map(String) : [];
  if (subs.length && !subs.includes(subcat == null ? '' : String(subcat))) return 'subcat_required';
  if (!subs.length && subcat != null && subcat !== '') return 'unknown';
  const d = row.display || {};
  const products = rowsOf(draft.state, 'item').filter((r) => r && r !== row && !isOptionRow(r) && r.display);
  if (String(d.cat) !== String(cat) && !products.some((r) => String(r.display.cat) === String(d.cat))) return 'section_empty';
  const nextSub = subs.length ? String(subcat) : null;
  if (typeof d.subcat === 'string' && (String(d.cat) !== String(cat) || d.subcat !== nextSub)
      && !products.some((r) => String(r.display.cat) === String(d.cat) && r.display.subcat === d.subcat)) return 'subsection_empty';
  return null;
}

// The whole drawer, once. `edit`: any of { name, desc, cat, subcat, price, optionPrices: {[optionKey]: raw}, photo,
// extraPrices: {[extraKey]: raw} }; an absent field is unchanged. `reserved`: the served reservedNames (itemNameProblem).
// Returns true when written, false when refused (and then NOTHING was written).
// The section an edit moves a product to (a section change without a subsection clears it), and the move itself: the product
// and every option move together. One rule for editItem and the drawer's composition (S2 §3.2).
function resolveMove(d, e) {
  const moving = own(e, 'cat') || own(e, 'subcat');
  const cat = own(e, 'cat') ? e.cat : d.cat;
  const subcat = own(e, 'subcat') ? (e.subcat == null || e.subcat === '' ? null : String(e.subcat)) : (own(e, 'cat') && String(e.cat) !== String(d.cat) ? null : (d.subcat == null ? null : d.subcat));
  return { moving, cat, subcat };
}
function writeMove(members, cat, subcat) {
  for (const r of members) { r.display.cat = cat; if (subcat == null) delete r.display.subcat; else r.display.subcat = subcat; }
}
export function editItem(draft, key, edit = {}, { reserved = null, extrasAuthoring = false } = {}) {
  if (!canEditContent(draft)) return false;
  const row = existingRow(draft.state, key);
  if (!row || !row.display) return false;
  const e = edit && typeof edit === 'object' ? edit : {};
  const d = row.display;
  const opts = membersOf(draft.state, row);
  const name = own(e, 'name') ? tidyItemName(e.name) : d.name;
  if (own(e, 'name') && itemNameProblem(draft, key, e.name, reserved) !== null) return false;
  const desc = own(e, 'desc') ? (typeof e.desc === 'string' ? e.desc : '') : undefined;
  if (desc !== undefined && itemDescProblem(draft, key, desc) !== null) return false;
  const { moving, cat, subcat } = resolveMove(d, e);
  if (moving && itemCategoryProblem(draft, key, { cat, subcat }) !== null) return false;
  const price = own(e, 'price') ? parsePrice(e.price) : undefined;
  if (price === null || (price !== undefined && opts.length)) return false;   // a group's price lives on its options
  const optPrices = [];
  for (const [k, raw] of Object.entries(e.optionPrices && typeof e.optionPrices === 'object' ? e.optionPrices : {})) {
    const o = opts.find((x) => x.key === k);
    const p = parsePrice(raw);
    if (!o || p === null) return false;
    optPrices.push([o, p]);
  }
  // the extras-group price blocks below the drawer's fields (advisor Q2, 11-10): one save behaviour per drawer, so their prices
  // ride the same all-or-nothing write — a usable price on an existing extra, or nothing is written
  const exPrices = [];
  for (const [k, raw] of Object.entries(e.extraPrices && typeof e.extraPrices === 'object' ? e.extraPrices : {})) {
    const x = rowsOf(draft.state, 'extra').find((r) => r && r.key === k);
    const p = parsePrice(raw);
    if (!x || p === null) return false;
    exPrices.push([k, raw]);
  }
  // STRUCTURE S1 (PLAN-per-product-extras §2 / §3 / §8): the dish's typed, key-only exclusions and «Sin extras». Only with the
  // server's authoring switch ON; never on an option (existingRow refuses one: the launcher's list governs the group); every
  // key an existing extra; a key the merchant ADDS must be in the dish's baseline AFTER this edit's move (a kept key outside
  // it is preserved untouched — it excludes nothing there).
  const denyEdit = own(e, 'denyExtras'), policyEdit = own(e, 'extrasPolicy');
  if ((denyEdit || policyEdit) && extrasAuthoring !== true) return false;
  if (policyEdit && !(e.extrasPolicy === 'none' || e.extrasPolicy === null)) return false;
  let denyList = null;
  if (denyEdit) {
    const list = e.denyExtras;
    if (!Array.isArray(list) || list.some((k) => typeof k !== 'string') || new Set(list).size !== list.length) return false;
    const order = rowsOf(draft.state, 'extra').map((x) => x && x.key);
    if (list.some((k) => !order.includes(k))) return false;
    const expo = draft.state.structure && draft.state.structure.exposure;
    if (!expo || typeof expo !== 'object') return false;
    const kept = new Set(denyExtrasOf(draft.state, key));
    const base = extrasBaseline(draft.state, key, moving ? { cat, subcat } : null);
    if (!base) return false;
    const inBase = new Set(base.groups.flatMap((g) => g.keys));
    if (list.some((k) => !kept.has(k) && !inBase.has(k))) return false;
    denyList = list.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  const photo = own(e, 'photo') ? e.photo : undefined;
  if (photo !== undefined && !(photo === null || (photo && photo.state === 'removed' && Object.keys(photo).length === 1)
      || (photo && photo.state === 'pid' && typeof photo.pid === 'string' && photo.pid && Object.keys(photo).length === 2))) return false;
  // every field judged: write
  if (own(e, 'name')) { d.name = name; for (const o of opts) o.display.name = derivedName(name, o); }
  if (desc !== undefined) { if (desc.trim()) d.desc = desc; else delete d.desc; }
  if (moving) writeMove([row, ...opts], cat, subcat);
  if (price !== undefined) setRowPrice(row, price);
  for (const [o, p] of optPrices) setRowPrice(o, p);
  if (photo !== undefined) setPhoto(draft, key, photo);
  for (const [k, raw] of exPrices) setPrice(draft, 'extra', k, raw);
  if (denyList) {
    const expo = draft.state.structure.exposure;
    if (!expo.item_overrides || typeof expo.item_overrides !== 'object') expo.item_overrides = {};
    const io = expo.item_overrides;
    // the validator refuses an empty list and an empty override (source-store.js:462-463, :473): [] DELETES them
    if (denyList.length) io[key] = { ...(io[key] || {}), deny_extras: denyList };
    else if (io[key]) { delete io[key].deny_extras; if (!Object.keys(io[key]).length) delete io[key]; }
  }
  // one extras_policy per group: the launcher AND every option (source-store.js:596-598)
  if (policyEdit) for (const r of [row, ...opts]) { if (e.extrasPolicy === 'none') r.display.extras_policy = 'none'; else delete r.display.extras_policy; }
  return true;
}

// ── STRUCTURE S1 — A DISH'S EXTRAS (PLAN-portal-structure-S1-ui r3; PLAN-per-product-extras rev 2.2 §2 / §3 / §12.3) ─────────
// The dish's typed exclusions: item_overrides[key].deny_extras (keys only), [] when absent.
function denyExtrasOf(src, key) {
  const io = src && src.structure && src.structure.exposure && src.structure.exposure.item_overrides;
  const o = io && typeof io === 'object' ? io[key] : null;
  return o && Array.isArray(o.deny_extras) ? o.deny_extras.slice() : [];
}
export const dishDenyExtras = (draft, key) => denyExtrasOf(draft && draft.state, key);
// The checklist's universe (§12.3): what the dish would offer WITHOUT its own exclusions and «Sin extras» — its section's
// extras ∪ its `add`, legacy rules still applied — grouped by extra-category in THE ONE rule's order (the page's
// ExtrasEligibility, the server's byte copy). `move` = the section this edit moves it to (the prospective dish). null when the
// evaluator is absent (nothing about extras is ever guessed).
export function extrasBaseline(src, key, move = null) {
  const E = globalThis.ExtrasEligibility;
  if (!E || typeof E.projectEligibility !== 'function' || typeof E.eligibleExtras !== 'function') return null;
  const s = clone(src);
  const r = rowsOf(s, 'item').find((x) => x && x.key === key);
  if (!r || !r.display || isOptionRow(r)) return { groups: [] };
  const g = groupOfRow(s, r);
  const members = [r, ...(g ? g.options : [])];
  for (const m of members) {
    if (move) { m.display.cat = move.cat; if (move.subcat == null) delete m.display.subcat; else m.display.subcat = move.subcat; }
    delete m.display.extras_policy;
  }
  const io = s.structure && s.structure.exposure && s.structure.exposure.item_overrides;
  if (io && io[key]) { delete io[key].deny_extras; if (!Object.keys(io[key]).length) delete io[key]; }
  let keys;
  try { const proj = E.projectEligibility(s); keys = E.eligibleExtras(proj, key).map((k) => [k, proj.extraCat[k]]); } catch (_) { return null; }
  const groups = [];
  for (const [k, c] of keys) { const last = groups[groups.length - 1]; if (last && last.cat === c) last.keys.push(k); else groups.push({ cat: c, keys: [k] }); }
  return { groups };
}
// Existing products whose checklist or «Sin extras» differs from what was loaded — [{ key, fields: ['denyExtras' | 'extrasPolicy'] }],
// in document order; the list compares as a SET (order-free, absent ≡ empty), the policy as 'none' vs absent.
export function pendingDishExtras(draft) {
  const out = [];
  for (const row of rowsOf(draft.state, 'item')) {
    if (!row || isTmp(row) || isOptionRow(row) || typeof row.key !== 'string') continue;
    const was = existingRow(draft.orig, row.key);
    if (!was || !was.display || !row.display) continue;
    const a = new Set(denyExtrasOf(draft.orig, row.key)), b = new Set(denyExtrasOf(draft.state, row.key));
    const fields = [];
    if (a.size !== b.size || [...a].some((k) => !b.has(k))) fields.push('denyExtras');
    if ((was.display.extras_policy === 'none') !== (row.display.extras_policy === 'none')) fields.push('extrasPolicy');
    // the bar counts what the review will SAY (Codex S1 follow-up r1 P2): an untick and a re-tick in one list are two sentences
    const sentences = (b.size > 0 && [...b].some((k) => !a.has(k)) ? 1 : 0) + (a.size > 0 && [...a].some((k) => !b.has(k)) ? 1 : 0) + (fields.includes('extrasPolicy') ? 1 : 0);
    if (fields.length) out.push({ key: row.key, fields, sentences });
  }
  return out;
}

// The name an EXISTING product had when the draft was loaded (the one the merchant recognises), or null. Pure.
export function loadedName(draft, key) {
  const was = existingRow(draft.orig, key);
  return was && was.display && typeof was.display.name === 'string' && was.display.name.trim() ? was.display.name : null;
}

// Existing products whose text or section differs from what was loaded: [{ key, fields: ['name' | 'desc' | 'cat'] }] in
// document order ('cat' covers the subsection). A group's options are derived from their product and are not counted again.
export function pendingTexts(draft) {
  const out = [];
  for (const row of rowsOf(draft.state, 'item')) {
    if (!row || isTmp(row) || isOptionRow(row) || typeof row.key !== 'string') continue;
    const was = existingRow(draft.orig, row.key);
    if (!was || !was.display || !row.display) continue;
    const a = was.display, b = row.display;
    const fields = [];
    if (a.name !== b.name) fields.push('name');
    if ((a.desc || '') !== (b.desc || '')) fields.push('desc');
    if (String(a.cat) !== String(b.cat) || (a.subcat || null) !== (b.subcat || null)) fields.push('cat');
    if (fields.length) out.push({ key: row.key, fields });
  }
  return out;
}

// ── STRUCTURE S2 — THE EXTRAS PAGE'S WRITES (PLAN-portal-structure-S2-ui r3, APPROVED 2026-11-11) ───────────────────────────
// ONE writer: 5f's catalog/exposure-transitions.js, byte-copied to xpizza-portal/exposure-transitions.js (tools/sync-client.js) and
// loaded as a classic script after extras-eligibility.js (the ExposureTransitions global). Nothing below edits exposure, the group
// order or the extras rows by hand.
const writer = () => globalThis.ExposureTransitions;
const refusedBy = (err) => ({ ok: false, code: (err && err.code) || 'unknown_op', ...((err && err.detail) || {}) });
// §3.1 — the one mutator: an ORDERED op list folded through the writer on ONE copy; any refusal leaves the draft untouched (no
// half-applied list); success replaces the draft's document. Only with the server's switch (getEditableCatalog extrasCatalog).
// The removal claim (§3.4, bound to the served baseline) lands with that step, after the advisor's ruling on portal-wiring
// RULING A; until then nothing here reads the writer's removal output.
export function applyExposureOps(draft, ops, { extrasCatalog = false } = {}) {
  if (extrasCatalog !== true) return { ok: false, code: 'extras_catalog_off' };
  if (!canEditContent(draft)) return { ok: false, code: 'not_editable' };
  if (!writer() || typeof writer().apply !== 'function') return { ok: false, code: 'writer_unavailable' };
  if (!Array.isArray(ops) || !ops.length) return { ok: false, code: 'unknown_op' };
  let cur = draft.state; const results = [];
  try { for (const op of ops) { const r = writer().apply(cur, op); results.push(r); cur = r.source; } }
  catch (err) { return refusedBy(err); }
  draft.state = mergeDeletionClaim(cur, results);
  return { ok: true };
}
// §3.2 — the drawer's ONE composition, for the preview (strict: false — what the copy WOULD save, a move not yet valid included)
// and the commit (strict: true — every field judged by the editor's rules). Never writes `draft`:
//   1. «Sin extras» OFF first (an attach needs a dish that offers extras);
//   2. the prospective MOVE (section / subsection) — before any exposure op (Codex S2 plan r2 #4);
//   3. the copy's attach / detach ops, in order, through the writer, on the moved copy;
//   4. the rest (text, price, photo, the checklist, «Sin extras» ON) through editItem, the checklist judged against THAT prospect.
// → { ok: true, source } | { ok: false, code, … }. (attach / detach never remove an extra.)
export function composeDish(draft, key, edit = {}, ops = [], { reserved = null, extrasAuthoring = false, extrasCatalog = false, strict = true } = {}) {
  if (strict && !canEditContent(draft)) return { ok: false, code: 'not_editable' };
  if (!Array.isArray(ops) || ops.some((o) => !o || (o.op !== 'attach.item' && o.op !== 'detach.item'))) return { ok: false, code: 'unknown_op' };
  if (ops.length && extrasCatalog !== true) return { ok: false, code: 'extras_catalog_off' };
  if (ops.length && (!writer() || typeof writer().apply !== 'function')) return { ok: false, code: 'writer_unavailable' };
  const row = existingRow(draft.state, key);
  if (!row || !row.display) return { ok: false, code: 'unknown_item' };
  const e = { ...(edit && typeof edit === 'object' ? edit : {}) };
  // a scratch draft: the commit judges names against what was loaded; the preview has no rename to hold
  const scratch = createDraft(clone(draft.state));
  scratch.orig = clone(strict ? draft.orig : draft.state);
  if (own(e, 'extrasPolicy') && e.extrasPolicy === null) {
    if (!editItem(scratch, key, { extrasPolicy: null }, { extrasAuthoring })) return { ok: false, code: 'invalid', field: 'extrasPolicy' };
    delete e.extrasPolicy;
  }
  const mv = resolveMove(row.display, e);
  if (mv.moving) {
    if (strict && itemCategoryProblem(draft, key, { cat: mv.cat, subcat: mv.subcat }) !== null) return { ok: false, code: 'invalid', field: 'cat' };
    const sr = existingRow(scratch.state, key);
    writeMove([sr, ...membersOf(scratch.state, sr)], mv.cat, mv.subcat);
    delete e.cat; delete e.subcat;
  }
  if (ops.length) {
    let cur = scratch.state;
    try { for (const op of ops) cur = writer().apply(cur, { op: op.op, item: key, group: op.group }).source; }
    catch (err) { return refusedBy(err); }
    scratch.state = cur;
  }
  if (Object.keys(e).length && !editItem(scratch, key, e, { reserved, extrasAuthoring })) return { ok: false, code: 'invalid' };
  return { ok: true, source: scratch.state };
}
// RULING A, narrowed at S2 (LEDGER R-A): the ONE portal function that names the removal claim. It reads the writer's removal output
// from the op results and writes `deleted_ids` as ONE sorted array — the claim already carried by the source (either stored shape)
// ∪ the newly removed identities (5f contract §4b). A never-published extra claims nothing.
// `results === null` asks only whether `src` carries a claim (no write) — the one place that reads it, so the save can send the baseline.
export function mergeDeletionClaim(src, results) {
  // 'ids' (S2 §5.2 REVIEW-DELETIONS): the claim's ids, both stored shapes, sorted — the ONE place the claim is read (Ruling A)
  if (results === 'ids') { const c = src && src.deleted_ids; return [...new Set((Array.isArray(c) ? c : (c && typeof c === 'object' && Array.isArray(c.ids) ? c.ids : [])).map(String))].sort(); }
  if (results === null) { const c = src && src.deleted_ids; return Array.isArray(c) ? c.length > 0 : !!(c && typeof c === 'object' && Array.isArray(c.ids) && c.ids.length); }
  // { add: [ids] } («Quitar del menú»: a dish's identity stamp — the dish writer has no op results) is the same union as the op results;
  // { withdraw: [ids] } («Deshacer»): drop exactly those ids, ONE sorted array; no claim ⇒ nothing written; [] stays []
  if (results && typeof results === 'object' && !Array.isArray(results) && Array.isArray(results.add)) return mergeDeletionClaim(src, [{ deletedIds: results.add }]);
  if (results && typeof results === 'object' && !Array.isArray(results)) {
    const cur = src && src.deleted_ids;
    if (cur === undefined || !Array.isArray(results.withdraw)) return src;
    const have = Array.isArray(cur) ? cur : (cur && typeof cur === 'object' && Array.isArray(cur.ids) ? cur.ids : []);
    const drop = new Set(results.withdraw.map(String));
    src.deleted_ids = [...new Set(have.map(String))].filter((x) => !drop.has(x)).sort();
    return src;
  }
  const add = [];
  for (const r of results) for (const id of (r && Array.isArray(r.deletedIds) ? r.deletedIds : [])) add.push(String(id));
  if (!add.length) return src;
  const cur = src.deleted_ids;
  const have = Array.isArray(cur) ? cur : (cur && typeof cur === 'object' && Array.isArray(cur.ids) ? cur.ids : []);
  src.deleted_ids = [...new Set([...have.map(String), ...add])].sort();
  return src;
}
// «Guardar» on the drawer: the strict composition, swapped in ONCE (all or nothing).
export function commitDish(draft, key, edit, ops, opts = {}) {
  const r = composeDish(draft, key, edit, ops, { ...opts, strict: true });
  if (!r.ok) return r;
  draft.state = r.source;
  return { ok: true };
}
// §3.6 — the exposure and order work this draft holds against what it loaded: the group ORDER (the same groups, another order;
// a new or removed group is its extras rows' pending work), each section's offered groups, each dish's own add / deny (its
// checklist and «Sin extras» are S1's lines, never counted twice). → [{ kind: 'order' } | { kind: 'category', cat } |
// { kind: 'dish', key }].
export function pendingStructure(draft) {
  const out = [];
  const st = (src) => (src && src.structure) || {};
  const a = st(draft.orig), b = st(draft.state);
  const ga = Array.isArray(a.extra_categories) ? a.extra_categories : [], gb = Array.isArray(b.extra_categories) ? b.extra_categories : [];
  if (ga.length === gb.length && ga.every((g) => gb.includes(g)) && ga.some((g, i) => g !== gb[i])) out.push({ kind: 'order' });
  const xa = a.exposure || {}, xb = b.exposure || {};
  const ca = xa.category_allow || {}, cb = xb.category_allow || {};
  for (const c of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()) if (JSON.stringify(ca[c] || []) !== JSON.stringify(cb[c] || [])) out.push({ kind: 'category', cat: c });
  const oa = xa.item_overrides || {}, ob = xb.item_overrides || {};
  const own2 = (ov) => { if (!ov || typeof ov !== 'object') return '{}'; const r = {}; for (const k of Object.keys(ov).sort()) if (k !== 'deny_extras') r[k] = ov[k]; return JSON.stringify(r); };
  const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
  const docOrder = rowsOf(draft.state, 'item').map((r) => r && r.key);
  // «Quitar del menú» (SBS 11-13, MOCKUP R3 «1 cambio»): a PUBLISHED dish no longer in the draft took its own entry with it — that is the
  // removal (pendingChanges counts it once), never also a «dish» structure change
  const gone = (k) => !docOrder.includes(k) && rowsOf(draft.orig || {}, 'item').some((r) => r && r.key === k);
  for (const k of [...keys].sort((x, y) => docOrder.indexOf(x) - docOrder.indexOf(y))) if (!gone(k) && own2(oa[k]) !== own2(ob[k])) out.push({ kind: 'dish', key: k });
  return out;
}
// §2 item 5b — may a NEW group be offered there? Decided by the WRITER itself: a dry run of group.create with that destination on
// a copy (attach.cat runs the option-override check on every launcher of the section; attach.item the «Sin extras» / deny-all
// check). → null (allowed) | { code } | { code, reason: 'none' | 'deny_all' | 'option_override' | 'unsaved' } for the row's line.
const PROBE_GROUP = '\u0000probe';
export function attachRefusal(src, attach) {
  if (!writer() || typeof writer().apply !== 'function') return { code: 'writer_unavailable' };
  try { writer().apply(src, { op: 'group.create', group: PROBE_GROUP, extras: [{ ref: 'tmp:probe', name: 'probe', price: 1 }], attach }); return null; }
  catch (err) {
    const code = (err && err.code) || 'unknown_op', d = (err && err.detail) || {};
    if (code === 'exposure_dish_no_extras') { const r = existingRow(src, d.item); return { code, reason: r && r.display && r.display.extras_policy === 'none' ? 'none' : 'deny_all' }; }
    if (code === 'exposure_option_override') return { code, reason: 'option_override' };
    if (code === 'unknown_item' && rowsOf(src, 'item').some((r) => r && isTmp(r) && r.ref === d.item)) return { code, reason: 'unsaved' };
    return { code };
  }
}
