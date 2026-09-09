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
// DEFERRED, and deliberately NOT IMPLEMENTED HERE (2b-2c): adding, removing or renaming an item,
// adding or removing an option, category edits. All of those write the pricing KEY, which is the
// per-merchant key-strategy work. There is no setter for them in this file — not a disabled one, not
// a guarded one. A capability that does not exist cannot be reached by accident.

const clone = (v) => JSON.parse(JSON.stringify(v));

// The server's rule is isPositiveInt: Number.isInteger(p) && p > 0. This is the client half of it, and
// it must REFUSE rather than repair. parseInt('12.9') is 12 and parseInt('12abc') is 12 — both are a
// different price from the one the merchant typed, and a wrong price is worse than a rejected one:
// rejection is visible, truncation is not. Digits only, nothing clever.
export function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
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
export function createDraft(source) {
  return { orig: clone(source), state: clone(source) };
}

export function discard(draft) {
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

const rowsOf = (src, surface) => (surface === 'item'
  ? (Array.isArray(src.items) ? src.items : [])
  : (Array.isArray(src.extras) ? src.extras : []));

function setPrice(draft, surface, key, raw) {
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

// What actually differs from what was loaded — never a log of keystrokes. Typing a price back to its
// original value is not a change, and counting it as one would tell a merchant they have unpublished
// work when they have none, and put a no-op on the review screen.
export function pendingChanges(draft) {
  const out = [];
  for (const surface of ['item', 'extra']) {
    const origRows = rowsOf(draft.orig, surface);
    for (const row of rowsOf(draft.state, surface)) {
      const was = origRows.find((r) => r && r.key === row.key);
      if (!was || was.price === row.price) continue;
      out.push({ surface, key: row.key, from: was.price, to: row.price });
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
      if (!(Number.isInteger(row.price) && row.price > 0)) out.push({ surface, key: row.key });
    }
  }
  return out;
}

// Fail closed. The server would refuse a non-positive price anyway, but it would do so later and less
// clearly — after the review, after the attestation, as a 400 on a screen that had said everything
// was ready.
export const isPublishable = (draft) => invalidKeys(draft).length === 0;

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
