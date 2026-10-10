'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE A (PLAN-addproduct.md rev 5 §1–§2, §0.5) — ADD-ONLY: a merchant may append PLAIN products
// to existing, rendered categories. Nothing else about the menu may change in the same edit except prices.
//
// Two pure halves, both run by editCatalog at SAVE (before the CAS write) and repeated by publishEdited:
//
//   allocateAdditions — a new product arrives with a TEMPORARY reference (`ref: 'tmp:<uuid>'`) and NO key, id or
//     identity stamp. The SERVER assigns its pricing key (by the brand's key mode, read from data) and, for
//     numeric-id brands, the next display id above a persistent high-water mark. An addition that already
//     carries an allocation must match the one the CAS-protected saved draft holds — allocation happens ONCE.
//     A client that invents a key, id or stamp is REFUSED, never silently corrected.
//
//   compareToActive — a STRUCTURAL comparison against the ACTIVE published catalog, at the BUILT level (both
//     sides through the same builder, so formatting is not a difference). Existing items keep everything but
//     their price; extras keep their membership and everything but price; every structure field is frozen
//     except item_order, which must be the active order with the new keys APPENDED. This is not catalogDiff:
//     that diff is about prices and is blind to a renamed display name, a relabelled category, a changed
//     variant map or a renamed extra — all of which this refuses.
//
// Brand-agnostic: no restaurant id and no item name appears below. The key mode is DATA (the restaurant
// profile's pricing_key_mode), and the drawable categories are the generated renderer contract.
// ---------------------------------------------------------------------------
const MAX_ADDITIONS = 20;
const TMP_RE = /^tmp:[A-Za-z0-9-]{8,64}$/;
const KEY_MODES = new Set(['name', 'id']);

class AddProductError extends Error {
  constructor(code, detail, { status = 400, field = null, ref = null, key = null } = {}) {
    super(`${code}: ${detail}`);
    this.code = code; this.detail = detail; this.status = status; this.field = field; this.ref = ref; this.key = key;
  }
}
const refuse = (code, detail, opts) => { throw new AddProductError(code, detail, opts); };

const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Case-, accent- and whitespace-folded: "Pizza  Única" and "pizza unica" are the same name to a customer.
function normalizeName(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
// The display name as stored: trimmed, inner whitespace collapsed. A trailing space is not a different product.
const tidyName = (s) => String(s).replace(/\s+/g, ' ').trim();
// A slug for id-keyed brands: ascii, lowercase, underscores. Empty when the name has no usable characters.
function slugify(name) {
  return normalizeName(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

// Deep equality over JSON-shaped data, key order irrelevant.
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined).sort();
  const kb = Object.keys(b).filter((k) => b[k] !== undefined).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(a[k], b[k]));
}
const without = (o, keys) => { const out = { ...(o || {}) }; for (const k of keys) delete out[k]; return out; };

// The key the brand prices this display record by, from its DATA key mode.
const keyOfDisplay = (mode, display) => (mode === 'name' ? display.name : String(display.id));

// ── KEY MODE, FROM DATA, CROSS-CHECKED ─────────────────────────────────────────────────────────────────────
// The profile's pricing_key_mode decides how a new product is keyed. It is believed only when it is valid AND
// every live item already agrees with it — a profile that says 'name' over a menu keyed by id would allocate
// keys the pricing path can never find. Either failure refuses ADDITIONS (fail-closed); price edits are
// untouched by it.
function resolveKeyMode(profileMode, activeItems) {
  if (!KEY_MODES.has(profileMode)) {
    refuse('key_mode_unknown', `the restaurant profile has no usable pricing_key_mode (${JSON.stringify(profileMode)}); products cannot be added until it is set`, { status: 409 });
  }
  for (const it of activeItems || []) {
    if (!it || !isObj(it.display) || it.key !== keyOfDisplay(profileMode, it.display)) {
      refuse('key_mode_inconsistent', `pricing_key_mode '${profileMode}' does not match the live item ${JSON.stringify(it && it.key)}; products cannot be added`, { status: 409 });
    }
  }
  return profileMode;
}

// Which incoming items are ADDITIONS (absent from the active catalog), and in which state.
function classifyItems(incoming, activeKeys) {
  const out = { existing: [], fresh: [], allocated: [] };
  (incoming.items || []).forEach((it, index) => {
    if (isObj(it) && typeof it.key === 'string' && activeKeys.has(it.key) && !own(it, 'ref')) { out.existing.push({ index, item: it }); return; }
    if (isObj(it) && own(it, 'ref')) out.fresh.push({ index, item: it });
    else out.allocated.push({ index, item: it });
  });
  return out;
}

/* ── ALLOCATION AT SAVE ────────────────────────────────────────────────────────────────────────────────────
   incoming        the source the portal sent (canonicalized)
   stored          the CAS-protected saved draft (null-safe)
   activeItems     the active catalog's items [{key, display}]
   extras          the incoming extras (names are part of the collision space)
   keyMode         'name' | 'id', already resolved
   hwm             the stored display-id high-water mark (an integer ≥ 0, or null when never written)
   registryHasKey  (key) → boolean: does the identity registry hold a key row for this key (a name used before)?
   Returns { source, hwm, additions:[{key, name, ref|null}], allocatedNow:[keys] }. Never mutates its inputs. */
// fieldProblem(field, value) → a reason string | null: the caller injects the VALIDATOR's own per-field safety check
// (display-safety checkValue for that field's sink), so a new product's unusable name / description is refused HERE,
// field-mapped to its row, instead of surfacing as an unattributed invalid_source. Default: no opinion (the
// validator that runs after allocation still refuses — this only names the field).
function allocateAdditions({ incoming, stored, activeItems, keyMode, hwm, registryHasKey, fieldProblem = () => null }) {
  const source = JSON.parse(JSON.stringify(incoming));
  const activeKeys = new Set((activeItems || []).map((it) => it.key));
  const storedByKey = new Map(((stored && stored.items) || []).filter((it) => isObj(it) && typeof it.key === 'string').map((it) => [it.key, it]));
  const { existing, fresh, allocated } = classifyItems(source, activeKeys);

  if (fresh.length + allocated.length > MAX_ADDITIONS) {
    refuse('too_many_additions', `at most ${MAX_ADDITIONS} new products per publish (this edit has ${fresh.length + allocated.length})`);
  }

  // An addition already allocated in the SAVED draft keeps that allocation; anything else carrying a key is
  // the client inventing one.
  for (const { item } of allocated) {
    const was = isObj(item) && typeof item.key === 'string' ? storedByKey.get(item.key) : null;
    if (!was || activeKeys.has(item.key) || !isObj(item.display) || !isObj(was.display)
        || String(item.display.id) !== String(was.display.id) || own(item.display, 'identity_id')) {
      refuse('client_supplied_key', `a new product cannot carry a key, id or identity stamp the server did not allocate (${JSON.stringify(item && item.key)})`,
        { key: isObj(item) ? item.key : null });
    }
  }

  // Fresh additions: a tmp reference and nothing the server owns.
  const refs = new Set();
  for (const { item } of fresh) {
    if (typeof item.ref !== 'string' || !TMP_RE.test(item.ref)) refuse('addition_malformed', 'a new product needs a temporary reference tmp:<id>', { field: 'ref' });
    if (refs.has(item.ref)) refuse('addition_malformed', `duplicate temporary reference ${item.ref}`, { ref: item.ref });
    refs.add(item.ref);
    if (own(item, 'key')) refuse('client_supplied_key', 'a new product must not carry a key — the server allocates it', { ref: item.ref, field: 'key' });
    if (!isObj(item.display)) refuse('addition_malformed', 'a new product needs its display fields', { ref: item.ref, field: 'display' });
    if (own(item.display, 'id')) refuse('client_supplied_key', 'a new product must not carry an id — the server allocates it', { ref: item.ref, field: 'id' });
    if (own(item.display, 'identity_id')) refuse('client_supplied_key', 'a new product must not carry an identity stamp', { ref: item.ref, field: 'identity_id' });
    if (typeof item.display.name !== 'string' || !tidyName(item.display.name)) refuse('name_required', 'a new product needs a name', { ref: item.ref, field: 'name' });
    for (const f of ['name', 'desc']) {
      const v = item.display[f];
      if (typeof v !== 'string') continue;
      const why = fieldProblem(f, f === 'name' ? tidyName(v) : v);
      if (why) refuse('text_unsafe', `the ${f} ${why}`, { ref: item.ref, field: f });
    }
    // The validator's subcategory coverage, for THIS row: a section that groups by subsections needs one of its own;
    // one that declares none takes none. (An undeclared section is category_not_renderable's business, later.)
    const cats = isObj(source.structure) && Array.isArray(source.structure.categories) ? source.structure.categories : [];
    const cat = cats.find((c) => isObj(c) && c.id === item.display.cat);
    if (cat) {
      const declared = Array.isArray(cat.subcats) ? cat.subcats : [];
      const sub = item.display.subcat;
      if (declared.length ? !declared.includes(sub) : sub != null) {
        refuse('subcat_invalid', declared.length ? `choose one of this section's subsections (${declared.join(', ')})` : 'this section has no subsections',
          { ref: item.ref, field: 'subcat' });
      }
    }
  }

  // Allocate.
  const numericIds = [];
  for (const it of [...(activeItems || []), ...((stored && stored.items) || []), ...source.items]) {
    const id = isObj(it) && isObj(it.display) ? it.display.id : undefined;
    if (Number.isInteger(id) && id > 0) numericIds.push(id);
  }
  let next = Math.max(Number.isInteger(hwm) && hwm >= 0 ? hwm : 0, ...numericIds, 0);
  const allocatedNow = [];
  const refToKey = new Map();
  // After allocation a FRESH addition is known by its key — but the portal still holds it by its tmp reference (the
  // refused save stored nothing). Every refusal from here on names BOTH, so the portal opens the row it actually
  // has, and never an existing product that happens to share the key.
  const at = (key) => { for (const [r, k] of refToKey) if (k === key) return { key, ref: r }; return { key }; };
  for (const { item } of fresh) {
    const name = tidyName(item.display.name);
    let key; let id;
    if (keyMode === 'name') { next += 1; id = next; key = name; } else {
      key = slugify(name);
      if (!key) refuse('name_unusable', `"${name}" has no letters or digits to build an identifier from`, { ref: item.ref, field: 'name' });
      id = key;
    }
    refToKey.set(item.ref, key);
    delete item.ref;
    item.key = key;
    item.display = { ...item.display, name, id };
    allocatedNow.push(key);
  }

  // item_order: every temporary reference appears exactly once and becomes its key.
  const order = (source.structure && Array.isArray(source.structure.item_order)) ? source.structure.item_order : null;
  if (fresh.length) {
    if (!order) refuse('addition_malformed', 'item_order is missing', { field: 'item_order' });
    const seen = new Set();
    source.structure.item_order = order.map((k) => {
      if (typeof k === 'string' && k.startsWith('tmp:')) {
        if (!refToKey.has(k) || seen.has(k)) refuse('item_order_ref_mismatch', `item_order names ${k}, which is not exactly one new product`, { ref: k, field: 'item_order' });
        seen.add(k);
        return refToKey.get(k);
      }
      return k;
    });
    for (const r of refToKey.keys()) if (!seen.has(r)) refuse('item_order_ref_mismatch', `the new product ${r} is missing from item_order`, { ref: r, field: 'item_order' });
  }

  // Collisions — ADDITION-scoped: each addition against everything else; pre-existing duplicates are not ours.
  const additions = [...fresh, ...allocated].map(({ item }) => item);
  const others = (self) => [
    ...source.items.filter((it) => it !== self),
    ...(activeItems || []).filter((it) => !(isObj(self) && it.key === self.key)),
  ];
  const extraNames = (source.extras || []).map((e) => (isObj(e) && isObj(e.display) ? e.display.name : null)).filter((n) => typeof n === 'string');
  for (const add of additions) {
    const n = normalizeName(add.display.name);
    for (const o of others(add)) {
      if (isObj(o) && isObj(o.display) && typeof o.display.name === 'string' && normalizeName(o.display.name) === n) {
        refuse('name_taken', `"${add.display.name}" is already on your menu`, { ...at(add.key), field: 'name' });
      }
      if (isObj(o) && o.key === add.key) refuse('key_taken', `the identifier for "${add.display.name}" is already used`, { ...at(add.key), field: 'name' });
      if (isObj(o) && isObj(o.display) && o.display.id !== undefined && String(o.display.id) === String(add.display.id)) {
        refuse('id_taken', `the id ${add.display.id} is already used`, { ...at(add.key), field: 'id' });
      }
    }
    if (extraNames.some((x) => normalizeName(x) === n)) refuse('name_taken', `"${add.display.name}" is already an option (extra) on your menu`, { ...at(add.key), field: 'name' });
  }
  // A name (key) used before — a registry key row exists — is refused: today it would silently inherit that
  // identity, and the merchant would be publishing a "new" product that carries an old one's history.
  for (const key of allocatedNow) {
    if (registryHasKey(key)) refuse('name_previously_used', 'Ese nombre ya existió en tu menú — usá otro nombre.', { ...at(key), field: 'name' });
  }

  return { source, hwm: keyMode === 'name' ? next : (Number.isInteger(hwm) ? hwm : null), additions: additions.map((a) => ({ key: a.key, name: a.display.name })), allocatedNow,
    refs: Object.fromEntries([...refToKey].map(([r, k]) => [k, r])) };
}

/* ── THE STRUCTURAL COMPARISON ─────────────────────────────────────────────────────────────────────────────
   draftBuilt / activeBuilt  { items:[{key, price, display, has_photo?}], extras:[{key, price, display}] (records),
                               structure }  — both from the SAME builder
   draftAuthored             the set of structure fields the draft SOURCE authors (fields it does not author
                             are derived from code by the builder, and a later code change must not make every
                             save refuse — so they are not compared)
   renderedCategories        the brand's drawable categories (renderer contract)
   deletedIds                identity ids named in the SERVER-VALIDATED D4-P1 deletion claim (advisor ruling 2026-10-09,
                             "ADD-ONLY for portal-authored changes; the pre-existing D4-P1 server-owned deletion claim is
                             preserved"): a live item whose identity stamp is in this set may be ABSENT from the draft.
                             Nothing else may be removed. A draft that both removes declared items and adds products is
                             accepted only when each half passes its own checks (removals here, additions below).
   Returns { additions:[keys], removals:[keys] }; throws AddProductError on the first violation. */
const ALWAYS_COMPARED = ['categories', 'variant_items', 'pickup_only_cats', 'weekend_only_cats', 'extra_order'];
const COMPARED_WHEN_AUTHORED = ['extra_categories', 'badges', 'exposure', 'extras_by_category', 'extras_by_item',
  'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras'];

function compareToActive({ draftBuilt, activeBuilt, draftAuthored, renderedCategories, deletedIds = null }) {
  const active = new Map(activeBuilt.items.map((it) => [it.key, it]));
  const draft = new Map(draftBuilt.items.map((it) => [it.key, it]));
  const declared = deletedIds instanceof Set ? deletedIds : new Set(Array.isArray(deletedIds) ? deletedIds : []);
  const removals = [];

  for (const [key, a] of active) {
    const d = draft.get(key);
    if (!d) {
      const stamp = a.display && a.display.identity_id;
      if (typeof stamp === 'string' && stamp && declared.has(stamp)) { removals.push(key); continue; }
      refuse('existing_item_removed', `"${a.display && a.display.name}" cannot be removed here — adding is the only menu change allowed`, { key });
    }
    // Everything but the price. The identity stamp: if the draft carries one it must be the live one.
    if (own(d.display, 'identity_id') && (!own(a.display, 'identity_id') || d.display.identity_id !== a.display.identity_id)) {
      refuse('existing_item_changed', `"${a.display && a.display.name}" carries a different identity stamp`, { key, field: 'identity_id' });
    }
    if (!sameJson(without(d.display, ['price', 'identity_id']), without(a.display, ['price', 'identity_id'])) || !!d.has_photo !== !!a.has_photo) {
      refuse('existing_item_changed', `"${a.display && a.display.name}" can only have its price changed here`, { key });
    }
  }

  const additions = draftBuilt.items.filter((it) => !active.has(it.key));
  if (additions.length > MAX_ADDITIONS) refuse('too_many_additions', `at most ${MAX_ADDITIONS} new products per publish (this edit has ${additions.length})`);
  const variantClaims = new Set();
  const vmap = isObj(draftBuilt.structure.variant_items) ? draftBuilt.structure.variant_items : {};
  for (const [launcher, spec] of Object.entries(vmap)) {
    variantClaims.add(String(launcher));
    for (const v of (isObj(spec) && Array.isArray(spec.variantIds) ? spec.variantIds : [])) variantClaims.add(String(v));
  }
  const drawn = new Set(renderedCategories || []);
  for (const it of additions) {
    const d = it.display || {};
    if (own(d, 'variantOf') || own(d, 'choice') || variantClaims.has(String(d.id)) || variantClaims.has(it.key)) {
      refuse('choices_not_supported_yet', 'products with a required choice are not available yet', { key: it.key, field: 'choices' });
    }
    if (own(d, 'identity_id')) refuse('client_supplied_key', 'a new product must not carry an identity stamp', { key: it.key, field: 'identity_id' });
    if (!drawn.has(d.cat)) refuse('category_not_renderable', `the section ${JSON.stringify(d.cat)} is not shown on your order page`, { key: it.key, field: 'cat' });
  }

  // Extras: same membership, everything but price.
  const ae = new Map((activeBuilt.extras || []).map((e) => [e.key, e]));
  const de = new Map((draftBuilt.extras || []).map((e) => [e.key, e]));
  if (ae.size !== de.size || [...ae.keys()].some((k) => !de.has(k))) refuse('extras_changed', 'options (extras) cannot be added or removed here');
  for (const [k, a] of ae) {
    if (!sameJson(without(de.get(k).display, ['price']), without(a.display, ['price']))) refuse('extras_changed', `the option ${JSON.stringify(k)} can only have its price changed here`, { key: k });
  }

  // Structure: item_order is the active order with the new keys appended; everything else is frozen.
  const removed = new Set(removals);
  const ao = (activeBuilt.structure.item_order || []).filter((k) => !removed.has(k));
  const dorder = draftBuilt.structure.item_order || [];
  const addKeys = new Set(additions.map((it) => it.key));
  if (dorder.length !== ao.length + addKeys.size || !ao.every((k, i) => dorder[i] === k) || !dorder.slice(ao.length).every((k) => addKeys.has(k))) {
    refuse('item_order_changed', 'existing products cannot be reordered here; new products go at the end', { field: 'item_order' });
  }
  const authored = draftAuthored instanceof Set ? draftAuthored : new Set(draftAuthored || []);
  for (const f of [...ALWAYS_COMPARED, ...COMPARED_WHEN_AUTHORED.filter((x) => authored.has(x))]) {
    if (!sameJson(draftBuilt.structure[f], activeBuilt.structure[f])) refuse('structure_changed', `the menu's ${f} cannot change here`, { field: f });
  }
  return { additions: additions.map((it) => it.key), removals };
}

// The authored structure fields of a source must be the same set as the stored draft's: dropping one would
// silently hand it back to code-derived defaults, which the comparison above deliberately does not police.
function assertSameAuthoredFields(incomingStructure, storedStructure) {
  const a = Object.keys(incomingStructure || {}).sort();
  const b = Object.keys(storedStructure || {}).sort();
  if (!sameJson(a, b)) refuse('structure_changed', `the menu's structure fields cannot be added or removed here (${a.join(',')} vs ${b.join(',')})`, { field: 'structure' });
}

module.exports = {
  MAX_ADDITIONS, TMP_RE, AddProductError, normalizeName, tidyName, slugify, sameJson,
  resolveKeyMode, classifyItems, allocateAdditions, compareToActive, assertSameAuthoredFields,
  ALWAYS_COMPARED, COMPARED_WHEN_AUTHORED,
};
