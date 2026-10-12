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
// STILL NOT IMPLEMENTED HERE: renaming or removing an EXISTING item, adding or removing an option, category edits.
// There is no setter for them in this file — not a disabled one, not a guarded one. A capability that does not exist
// cannot be reached by accident.
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
  // Sealed, not frozen, and the difference is the point: no property may be ADDED or REMOVED, so the
  // draft's shape is fixed — but `orig` and `state` stay writable, because discard() and commit()
  // assign them and the document has to remain editable through the guarded setters.
  return Object.seal(draft);
}

// One predicate, asked by every mutator below. Exported so callers can render an affordance from the
// same answer the guard uses, rather than keeping a second opinion.
export const canEditDraft = (draft) => !!(draft && draft.canEdit());

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
const isTmp = (row) => !!(row && typeof row.ref === 'string' && row.ref.startsWith('tmp:') && !('key' in row));

const rowsOf = (src, surface) => (surface === 'item'
  ? (Array.isArray(src.items) ? src.items : [])
  : (Array.isArray(src.extras) ? src.extras : []));

function setPrice(draft, surface, key, raw) {
  // THE BOUNDARY. A mutation arriving while the draft is not owned for editing — from a detached
  // listener, a retained reference, a stray dispatch — is refused here, whatever the DOM looks like.
  if (!canEditDraft(draft)) return draft;
  const row = rowsOf(draft.state, surface).find((r) => r && r.key === key);
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
export const setExtraPrice = (draft, key, raw) => setPrice(draft, 'extra', key, raw);

// ── 1D add-product A — ADDING A PLAIN PRODUCT ──────────────────────────────────────────────────────────────────
// A new row: the temporary reference the caller minted, the section it goes in, and nothing the server owns (no
// key, no id, no identity stamp). Appended at the END of item_order — the server refuses anything else. The price
// starts empty (the merchant types it) and is held unvalidated like any other price field.
export function addProduct(draft, { ref, cat, subcat = null } = {}) {
  if (!canEditDraft(draft)) return draft;
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
  if (!canEditDraft(draft)) return draft;
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
  if (!canEditDraft(draft)) return draft;
  const items = rowsOf(draft.state, 'item');
  const saved = savedAdditions instanceof Set ? savedAdditions : new Set();
  const i = items.findIndex((r) => r && rowId(r) === id && (isTmp(r) || (typeof r.key === 'string' && saved.has(r.key))));
  if (i === -1) return draft;
  if (isOptionRow(items[i])) return draft;
  const g = groupOfRow(draft.state, items[i]);
  const row = items[i];
  if (g) dropGroup(draft.state, g);
  items.splice(items.indexOf(row), 1);
  dropFromOrder(draft.state, id);
  return draft;
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
export function pendingChanges(draft) {
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
  return out;
}

export const pendingCount = (draft) => pendingChanges(draft).length;

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
export function setRequiredChoice(draft, id, on, optionRefs = []) {
  if (!canEditDraft(draft)) return draft;
  const l = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === id && isTmp(r) && !isOptionRow(r));
  if (!l) return draft;
  const st = draft.state;
  const g = groupOfRow(st, l);
  if (!on) { if (g) dropGroup(st, g); return draft; }
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
  if (!canEditDraft(draft)) return draft;
  const l = editableLauncher(draft, id);
  const g = l && isTmp(l) ? groupOfRow(draft.state, l) : null;
  if (g) g.spec.label = typeof raw === 'string' ? raw : '';
  return draft;
}
export function setGroupExtrasNone(draft, id, on) {
  if (!canEditDraft(draft)) return draft;
  const l = editableLauncher(draft, id);
  if (!l || !isTmp(l) || !groupOfRow(draft.state, l)) return draft;
  if (on) l.display.extras_policy = 'none'; else delete l.display.extras_policy;
  return draft;
}
// "Agregar opción": a new unnamed option, at the price given (the caller's shared price) or else the product's.
export function addChoice(draft, id, ref, raw) {
  if (!canEditDraft(draft)) return draft;
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
  if (!canEditDraft(draft)) return draft;
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
  if (!canEditDraft(draft)) return draft;
  const x = editableOption(draft, id);
  if (x && isTmp(x.o)) x.o.display.choice = typeof raw === 'string' ? raw : '';
  return draft;
}
// RECOMENDADA, per option (the contract's choice badge; the caller shows it only where the brand's picker draws it).
export function setChoiceRecommended(draft, id, on) {
  if (!canEditDraft(draft)) return draft;
  const x = editableOption(draft, id);
  if (!x || !isTmp(x.o)) return draft;
  if (on) x.o.display.tags = ['recommended']; else delete x.o.display.tags;
  return draft;
}
// ONE option's price (turning "Mismo precio" off is the caller's); the product's derived price follows.
export function setChoicePrice(draft, id, raw, savedAdditions = new Set()) {
  if (!canEditDraft(draft)) return draft;
  const x = editableOption(draft, id, savedAdditions);
  if (!x) return draft;
  setRowPrice(x.o, parsePrice(raw));
  recomputeLauncher(x.g);
  return draft;
}
// THE group price mutator ("Mismo precio para todas"): the product AND every option, from one parse, together.
export function setGroupPrice(draft, id, raw, savedAdditions = new Set()) {
  if (!canEditDraft(draft)) return draft;
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
