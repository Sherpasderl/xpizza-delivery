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
// authoring — the ONE platform authoring switch (catalog/platform-groups.js, §0c.7). Off ⇒ a new required-choice group is
// refused for EVERY brand (choices_not_supported_yet); on ⇒ a group arrives as ONE atomic unit (see allocateGroups).
function allocateAdditions({ incoming, stored, activeItems, keyMode, hwm, registryHasKey, fieldProblem = () => null, authoring = false }) {
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
    // 1D add-product B: a group VARIANT's name is DERIVED ("{launcher} - {choice}", allocateGroups); its own checks run there
    if (isGroupVariant(item)) continue;
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

  // 1D add-product B (rev 6): required-choice GROUPS — validated as one unit and their derived fields set, BEFORE allocation
  // (a variant's key derives from its full name). Refused for every brand while the authoring switch is off.
  const group = prepareGroups(source, fresh, { authoring, fieldProblem });

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
  const refToId = new Map();   // 1D add-product B: tmp ref → DISPLAY id (the namespace variantOf / variant_items use)
  for (const { item } of fresh) {
    const name = tidyName(item.display.name);
    let key; let id;
    if (keyMode === 'name') { next += 1; id = next; key = name; } else {
      key = slugify(name);
      if (!key) refuse('name_unusable', `"${name}" has no letters or digits to build an identifier from`, { ref: item.ref, field: 'name' });
      id = key;
    }
    refToKey.set(item.ref, key);
    refToId.set(item.ref, id);
    delete item.ref;
    item.key = key;
    item.display = { ...item.display, name, id };
    allocatedNow.push(key);
  }
  // 1D add-product B (§0b.2): the DISPLAY-id namespace, rewritten atomically and separately from the pricing keys below.
  if (group.units.length) rewriteGroupRefs(source, refToId);

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
  // per-product extras (§9): an exposure override OWNED by a new product names it by its temporary reference — rewritten to
  // the allocated key exactly like item_order; an unknown reference, or one that collides with an override the key already
  // has, is refused (never silently dropped or merged)
  const ovs = source.structure && source.structure.exposure && source.structure.exposure.item_overrides;
  if (ovs && typeof ovs === 'object' && !Array.isArray(ovs) && Object.keys(ovs).some((k) => k.startsWith('tmp:'))) {
    const rewritten = {};
    for (const [k, o] of Object.entries(ovs)) {
      if (!k.startsWith('tmp:')) { rewritten[k] = o; continue; }
      if (!refToKey.has(k)) refuse('exposure_ref_mismatch', `an extras setting names ${k}, which is not a new product`, { ref: k, field: 'deny_extras' });
      const key = refToKey.get(k);
      if (Object.prototype.hasOwnProperty.call(ovs, key) || Object.prototype.hasOwnProperty.call(rewritten, key)) refuse('exposure_ref_mismatch', `two extras settings would name ${JSON.stringify(key)}`, { ref: k, field: 'deny_extras' });
      rewritten[key] = o;
    }
    source.structure.exposure.item_overrides = rewritten;
  }

  // Collisions — ADDITION-scoped: each addition against everything else; pre-existing duplicates are not ours.
  const additions = [...fresh, ...allocated].map(({ item }) => item);
  const others = (self) => [
    ...source.items.filter((it) => it !== self),
    ...(activeItems || []).filter((it) => !(isObj(self) && it.key === self.key)),
  ];
  const extraNames = (source.extras || []).map((e) => (isObj(e) && isObj(e.display) ? e.display.name : null)).filter((n) => typeof n === 'string');
  // codex PB-1 r1 P2-4: an OPTION's name is derived from its choice, so a name refusal on it points at the choice input
  const nameField = (item) => (isGroupVariant(item) ? 'choice' : 'name');
  /* codex PB-1 r2 (defence in depth): a NEW dish may not take a KEY an existing extra already uses. The identity registry keeps
     dish and extra namespaces apart, so nothing else refuses it — yet the reward calculator resolves a key DISH-first, so the
     new dish would silently re-point every reward that names the extra (la_musa: "Rice White" → rice_white = "Arroz Blanco").
     Additions only; pre-existing overlaps (x_pizza's dish and extra both named "Pepperoni") are untouched. */
  const extraKeys = new Set((source.extras || []).map((e) => (isObj(e) ? e.key : null)).filter((k) => typeof k === 'string'));
  for (const add of additions) {
    const n = normalizeName(add.display.name);
    for (const o of others(add)) {
      if (isObj(o) && isObj(o.display) && typeof o.display.name === 'string' && normalizeName(o.display.name) === n) {
        refuse('name_taken', `"${add.display.name}" is already on your menu`, { ...at(add.key), field: nameField(add) });
      }
      if (isObj(o) && o.key === add.key) refuse('key_taken', `the identifier for "${add.display.name}" is already used`, { ...at(add.key), field: nameField(add) });
      if (isObj(o) && isObj(o.display) && o.display.id !== undefined && String(o.display.id) === String(add.display.id)) {
        refuse('id_taken', `the id ${add.display.id} is already used`, { ...at(add.key), field: 'id' });
      }
    }
    if (extraNames.some((x) => normalizeName(x) === n)) refuse('name_taken', `"${add.display.name}" is already an option (extra) on your menu`, { ...at(add.key), field: nameField(add) });
    if (extraKeys.has(add.key)) refuse('key_taken', `the identifier for "${add.display.name}" is already used by an option (extra) on your menu`, { ...at(add.key), field: nameField(add) });
  }
  // A name (key) used before — a registry key row exists — is refused: today it would silently inherit that
  // identity, and the merchant would be publishing a "new" product that carries an old one's history.
  const addedByKey = new Map(additions.map((a) => [a.key, a]));
  for (const key of allocatedNow) {
    if (registryHasKey(key)) refuse('name_previously_used', 'Ese nombre ya existió en tu menú — usá otro nombre.', { ...at(key), field: nameField(addedByKey.get(key)) });
  }

  return { source, hwm: keyMode === 'name' ? next : (Number.isInteger(hwm) ? hwm : null), additions: additions.map((a) => ({ key: a.key, name: a.display.name })), allocatedNow,
    refs: Object.fromEntries([...refToKey].map(([r, k]) => [k, r])) };
}

// ONE derivation of an option's full name — used by prepareGroups (which sets it) and by prospectiveAdditionNames (which the
// SAVE handler queries the registry with BEFORE allocation), so the two can never disagree.
const optionName = (launcherName, choice) => `${tidyName(String(launcherName))} - ${tidyName(String(choice))}`;

/* codex PB-1 r1 P2-4 — the names every FRESH addition WILL carry, options included (derived "{launcher} - {choice}" when the
   request omits them, which the supported shape does). Pure; tolerant of malformed input (allocation refuses it later). */
function prospectiveAdditionNames(source) {
  const items = isObj(source) && Array.isArray(source.items) ? source.items : [];
  const fresh = items.filter((it) => isObj(it) && own(it, 'ref') && isObj(it.display));
  const byRef = new Map(fresh.map((it) => [it.ref, it]));
  const out = [];
  for (const it of fresh) {
    const d = it.display;
    if (typeof d.name === 'string' && tidyName(d.name)) { out.push(tidyName(d.name)); continue; }
    const parent = typeof d.variantOf === 'string' ? byRef.get(d.variantOf) : null;
    if (parent && isObj(parent.display) && typeof parent.display.name === 'string' && typeof d.choice === 'string' && tidyName(d.choice)) {
      out.push(optionName(parent.display.name, d.choice));
    }
  }
  return out;
}

/* ── 1D add-product B (rev 6, UNIFORM) — REQUIRED-CHOICE GROUPS, AS ONE ATOMIC UNIT ─────────────────────────────
   A new group arrives as a LAUNCHER row and N VARIANT rows, all with tmp refs, and a `variant_items` entry keyed by the
   launcher's tmp ref listing the variants' tmp refs. The server owns everything derivable: each variant's name
   ("{launcher name} - {choice}"), its category/subcategory and extras_policy (the launcher's), and the launcher's stored
   price (min of the choices — legacy, NON-chargeable, §0d.2). A client value that CONTRADICTS a derived one is refused,
   never overwritten. Choices can never be added to an existing product, and every refusal names the tmp ref the portal
   holds and the field. Off the authoring switch, any group in an edit is refused for every brand. */
const isGroupVariant = (item) => isObj(item) && isObj(item.display) && (own(item.display, 'variantOf') || own(item.display, 'choice'));

function prepareGroups(source, fresh, { authoring, fieldProblem }) {
  const vi = isObj(source.structure) && isObj(source.structure.variant_items) ? source.structure.variant_items : null;
  const tmpLaunchers = vi ? Object.keys(vi).filter((k) => k.startsWith('tmp:')) : [];
  const freshVariants = fresh.map(({ item }) => item).filter(isGroupVariant);
  if (!tmpLaunchers.length && !freshVariants.length) return { units: [] };
  if (!authoring) {
    const ref = (freshVariants[0] && freshVariants[0].ref) || tmpLaunchers[0];
    refuse('choices_not_supported_yet', 'products with a required choice are not available yet', { ref, field: 'choices' });
  }
  const byRef = new Map(fresh.map(({ item }) => [item.ref, item]));
  const claimed = new Map();   // variant ref → launcher ref
  const units = [];
  for (const lRef of tmpLaunchers) {
    const launcher = byRef.get(lRef);
    const spec = vi[lRef];
    if (!launcher || isGroupVariant(launcher)) refuse('addition_malformed', `the choice group ${lRef} has no new product to belong to`, { ref: lRef, field: 'choices' });
    if (!isObj(spec) || !Array.isArray(spec.variantIds)) refuse('addition_malformed', 'a choice group needs its list of options', { ref: lRef, field: 'choices' });
    const label = typeof spec.label === 'string' ? tidyName(spec.label) : '';
    if (!label) refuse('label_required', 'a choice group needs a name (e.g. "Salsa")', { ref: lRef, field: 'label' });
    const lWhy = fieldProblem('label', label);
    if (lWhy) refuse('text_unsafe', `the group name ${lWhy}`, { ref: lRef, field: 'label' });
    spec.label = label;
    if (own(spec, 'prompt')) {
      const pWhy = typeof spec.prompt === 'string' && spec.prompt.trim() ? fieldProblem('prompt', spec.prompt) : 'must not be blank';
      if (pWhy) refuse('text_unsafe', `the prompt ${pWhy}`, { ref: lRef, field: 'prompt' });
    }
    if (spec.variantIds.length < 2) refuse('choices_too_few', 'a required choice needs at least 2 options', { ref: lRef, field: 'choices' });
    const lName = tidyName(launcher.display.name);
    const policy = own(launcher.display, 'extras_policy') ? launcher.display.extras_policy : undefined;
    if (policy !== undefined && policy !== 'none') refuse('addition_malformed', 'the only "extras" setting a group may carry is "none"', { ref: lRef, field: 'extras_policy' });
    const seen = new Set();
    const prices = [];
    for (const vRef of spec.variantIds) {
      const v = typeof vRef === 'string' ? byRef.get(vRef) : null;
      if (!v || !isGroupVariant(v) || String(v.display.variantOf) !== lRef) refuse('addition_malformed', `option ${JSON.stringify(vRef)} is not a new option of this group`, { ref: lRef, field: 'choices' });
      if (claimed.has(vRef)) refuse('addition_malformed', `option ${vRef} belongs to two groups`, { ref: vRef, field: 'choices' });
      claimed.set(vRef, lRef);
      const choice = typeof v.display.choice === 'string' ? tidyName(v.display.choice) : '';
      if (!choice) refuse('choice_label_required', 'every option needs a name', { ref: vRef, field: 'choice' });
      const cWhy = fieldProblem('choice', choice);
      if (cWhy) refuse('text_unsafe', `the option ${cWhy}`, { ref: vRef, field: 'choice' });
      const folded = normalizeName(choice);
      if (seen.has(folded)) refuse('choice_duplicate', `"${choice}" appears twice in this group`, { ref: vRef, field: 'choice' });
      seen.add(folded);
      const name = optionName(lName, choice);
      if (own(v.display, 'name') && tidyName(String(v.display.name)) !== name) refuse('addition_malformed', `an option's name is derived ("${name}")`, { ref: vRef, field: 'name' });
      const nWhy = fieldProblem('name', name);
      if (nWhy) refuse('text_unsafe', `the option's full name "${name}" ${nWhy}`, { ref: vRef, field: 'choice' });
      for (const f of ['cat', 'subcat']) {
        if (own(v.display, f) && v.display[f] !== launcher.display[f]) refuse('addition_malformed', `an option inherits its product's ${f}`, { ref: vRef, field: f });
      }
      if (own(v.display, 'extras_policy') && v.display.extras_policy !== policy) refuse('addition_malformed', 'an option inherits its group\'s extras setting', { ref: vRef, field: 'extras_policy' });
      // the derived fields, set by the server
      v.display = { ...without(v.display, ['name', 'cat', 'subcat', 'extras_policy']), name, cat: launcher.display.cat,
        ...(own(launcher.display, 'subcat') ? { subcat: launcher.display.subcat } : {}), ...(policy !== undefined ? { extras_policy: policy } : {}), choice };
      if (Number.isInteger(v.price) && v.price > 0) prices.push(v.price);
    }
    // the launcher's stored price: min of the choices — display / legacy only, never charged (§0d.2)
    if (prices.length === spec.variantIds.length) { launcher.price = Math.min(...prices); launcher.display = { ...launcher.display, price: launcher.price }; }
    units.push({ launcher: lRef, variants: spec.variantIds.slice() });
  }
  for (const v of freshVariants) {
    if (claimed.has(v.ref)) continue;
    const target = v.display.variantOf;
    // pointing at an EXISTING product: adding a choice to a product that already exists is not an add-only change
    refuse(typeof target === 'string' && target.startsWith('tmp:') ? 'addition_malformed' : 'choices_not_supported_yet',
      typeof target === 'string' && target.startsWith('tmp:') ? `option ${v.ref} names a group that is not in this edit` : 'options cannot be added to a product that already exists',
      { ref: v.ref, field: 'choices' });
  }
  return { units };
}

// tmp refs → DISPLAY ids in variantOf, the variant_items keys and variantIds (key order of the map preserved).
function rewriteGroupRefs(source, refToId) {
  const map = (r) => (typeof r === 'string' && refToId.has(r) ? refToId.get(r) : r);
  for (const it of source.items) {
    if (isObj(it) && isObj(it.display) && own(it.display, 'variantOf')) it.display = { ...it.display, variantOf: map(it.display.variantOf) };
  }
  const vi = source.structure.variant_items;
  const out = {};
  for (const [k, spec] of Object.entries(vi)) {
    out[String(map(k))] = isObj(spec) && Array.isArray(spec.variantIds) ? { ...spec, variantIds: spec.variantIds.map(map) } : spec;
  }
  source.structure.variant_items = out;
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

function compareToActive({ draftBuilt, activeBuilt, draftAuthored, renderedCategories, deletedIds = null, authoring = false, extrasAuthoring = false }) {
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
    // per-product extras (§8): with the extras authoring switch ON, the `extras_policy` toggle (absent ⇄ 'none', typed by the
    // validator) is the ONE other field an existing product may change; with it OFF, it is compared like any other field
    const free = extrasAuthoring ? ['price', 'identity_id', 'extras_policy'] : ['price', 'identity_id'];
    if (!sameJson(without(d.display, free), without(a.display, free)) || !!d.has_photo !== !!a.has_photo) {
      if (!extrasAuthoring && (d.display && d.display.extras_policy) !== (a.display && a.display.extras_policy)
        && sameJson(without(d.display, [...free, 'extras_policy']), without(a.display, [...free, 'extras_policy']))) {
        refuse('extras_not_supported_yet', `choosing which extras "${a.display && a.display.name}" takes is not available yet`, { key, field: 'extras_policy' });
      }
      refuse('existing_item_changed', `"${a.display && a.display.name}" can only have its price changed here`, { key });
    }
  }

  const additions = draftBuilt.items.filter((it) => !active.has(it.key));
  if (additions.length > MAX_ADDITIONS) refuse('too_many_additions', `at most ${MAX_ADDITIONS} new products per publish (this edit has ${additions.length})`);
  // 1D add-product B (rev 6): the variant map. Every ACTIVE entry (e.g. Pad Thai) is frozen; a NEW entry is a whole new
  // group — its launcher AND every option are additions — and only while the platform authoring switch is on. Choices
  // can never be added to (or claimed by) an existing product.
  const vmap = isObj(draftBuilt.structure.variant_items) ? draftBuilt.structure.variant_items : {};
  const amap = isObj(activeBuilt.structure.variant_items) ? activeBuilt.structure.variant_items : {};
  const additionIds = new Set(additions.map((it) => String(it.display && it.display.id)));
  const keyOfId = new Map(draftBuilt.items.map((it) => [String(it.display && it.display.id), it.key]));
  for (const [launcher, spec] of Object.entries(amap)) {
    if (!sameJson(vmap[launcher], spec)) refuse('structure_changed', `the existing choice group of ${JSON.stringify(keyOfId.get(String(launcher)) || launcher)} cannot change here`, { field: 'variant_items' });
  }
  const unitClaims = new Set();   // display ids that belong to a NEW, whole group
  for (const [launcher, spec] of Object.entries(vmap)) {
    if (own(amap, launcher)) continue;
    const ids = isObj(spec) && Array.isArray(spec.variantIds) ? spec.variantIds.map(String) : [];
    const lKey = keyOfId.get(String(launcher));
    if (!authoring) refuse('choices_not_supported_yet', 'products with a required choice are not available yet', { key: lKey || null, field: 'choices' });
    if (!additionIds.has(String(launcher)) || ids.some((v) => !additionIds.has(v))) {
      refuse('choices_not_supported_yet', 'options cannot be added to a product that already exists', { key: lKey || null, field: 'choices' });
    }
    unitClaims.add(String(launcher)); for (const v of ids) unitClaims.add(v);
  }
  const drawn = new Set(renderedCategories || []);
  for (const it of additions) {
    const d = it.display || {};
    if ((own(d, 'variantOf') || own(d, 'choice')) && !unitClaims.has(String(d.id))) {
      refuse('choices_not_supported_yet', 'products with a required choice are not available yet', { key: it.key, field: 'choices' });
    }
    if (own(d, 'identity_id')) refuse('client_supplied_key', 'a new product must not carry an identity stamp', { key: it.key, field: 'identity_id' });
    // a NEW plain product's "Sin extras" is per-product extras authoring (a new GROUP's is the group's own, as today)
    if (!extrasAuthoring && own(d, 'extras_policy') && !unitClaims.has(String(d.id))) refuse('extras_not_supported_yet', 'choosing which extras a product takes is not available yet', { key: it.key, field: 'extras_policy' });
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
  for (const f of [...ALWAYS_COMPARED.filter((x) => x !== 'variant_items' && x !== 'categories'), ...COMPARED_WHEN_AUTHORED.filter((x) => authored.has(x) && x !== 'exposure')]) {   // variant_items, categories, exposure: their own rules
    if (!sameJson(draftBuilt.structure[f], activeBuilt.structure[f])) refuse('structure_changed', `the menu's ${f} cannot change here`, { field: f });
  }
  // categories (PLAN-public-menu-display r2 T1): frozen except each category's display `name` — same count, the same id
  // at every index, every other field equal. A draft that renames must change NOTHING else (rename_not_alone), so the
  // reviewed diff shows the rename alone and never a rename riding beside a price edit.
  if (!sameCategoriesExceptName(draftBuilt.structure.categories, activeBuilt.structure.categories)) {
    refuse('structure_changed', "the menu's categories cannot change here", { field: 'categories' });
  }
  if (!sameJson(draftBuilt.structure.categories, activeBuilt.structure.categories) && !changesNothingElse(draftBuilt, activeBuilt, additions, removals)) {
    refuse('rename_not_alone', 'a category rename must be published on its own, with no other change', { field: 'categories' });
  }
  // exposure (§8): EVERYTHING is frozen except the typed, key-only deny_extras lists — compared after removing only those
  // and normalizing an override left empty by that removal (an existing `add` is never deleted by the normalization)
  if (authored.has('exposure')) {
    const de = draftBuilt.structure.exposure; const ae = activeBuilt.structure.exposure;
    if (!sameJson(exposureWithoutDenyExtras(de), exposureWithoutDenyExtras(ae))) refuse('structure_changed', "the menu's exposure cannot change here", { field: 'exposure' });
    if (!sameJson(denyExtrasOf(de), denyExtrasOf(ae)) && !extrasAuthoring) refuse('extras_not_supported_yet', 'choosing which extras a product takes is not available yet', { field: 'deny_extras' });
  }
  return { additions: additions.map((it) => it.key), removals };
}

// Two category lists that differ at most in `name`: same length, same id at each index, and every other field equal
// (a field present on one side only is a change).
function sameCategoriesExceptName(d, a) {
  if (!Array.isArray(d) || !Array.isArray(a)) return sameJson(d, a);
  if (d.length !== a.length) return false;
  return d.every((c, i) => isObj(c) && isObj(a[i]) && c.id === a[i].id && sameJson(without(c, ['name']), without(a[i], ['name'])));
}
// Nothing but the categories differs: no product added or removed, every product and extra record (price included) equal.
function changesNothingElse(draftBuilt, activeBuilt, additions, removals) {
  if (additions.length || removals.length) return false;
  const da = new Map(draftBuilt.items.map((it) => [it.key, it]));
  if (!activeBuilt.items.every((a) => { const d = da.get(a.key); return d && d.price === a.price && sameJson(d.display, a.display) && !!d.has_photo === !!a.has_photo; })) return false;
  const de = new Map((draftBuilt.extras || []).map((e) => [e.key, e]));
  return (activeBuilt.extras || []).every((a) => { const d = de.get(a.key); return d && d.price === a.price && sameJson(d.display, a.display); });
}

// exposure minus the typed deny_extras: each override without the field, and an override left EMPTY by that removal
// dropped (it said only deny_extras). `deny` / `add` / everything else stays — so any other difference is still caught.
function exposureWithoutDenyExtras(ex) {
  if (!isObj(ex)) return ex;
  const out = { ...ex };
  if (isObj(ex.item_overrides)) {
    const ov = {};
    for (const [k, o] of Object.entries(ex.item_overrides)) {
      if (!isObj(o)) { ov[k] = o; continue; }
      const rest = without(o, ['deny_extras']);
      if (Object.keys(rest).length) ov[k] = rest;
    }
    out.item_overrides = ov;
  }
  return out;
}
// { itemKey: [sorted deny_extras] } — only items that carry one
function denyExtrasOf(ex) {
  const out = {};
  if (isObj(ex) && isObj(ex.item_overrides)) for (const [k, o] of Object.entries(ex.item_overrides)) if (isObj(o) && Array.isArray(o.deny_extras)) out[k] = [...o.deny_extras].sort();
  return out;
}

// The authored structure fields of a source must be the same set as the stored draft's: dropping one would
// silently hand it back to code-derived defaults, which the comparison above deliberately does not police.
// 1D add-product B (§0b.2) — ONE narrow exception: `variant_items` may APPEAR (a first group) or DISAPPEAR (the last
// unpublished group removed, back to today's ABSENT shape) only while the ACTIVE catalog has no variant map at all — so
// every entry is an unpublished addition, which compareToActive validates as whole new groups. Any other authored field
// added or dropped is refused exactly as before.
function assertSameAuthoredFields(incomingStructure, storedStructure, { activeHasVariantItems = true } = {}) {
  const exempt = (k) => !activeHasVariantItems && k === 'variant_items';
  const a = Object.keys(incomingStructure || {}).filter((k) => !exempt(k)).sort();
  const b = Object.keys(storedStructure || {}).filter((k) => !exempt(k)).sort();
  if (!sameJson(a, b)) refuse('structure_changed', `the menu's structure fields cannot be added or removed here (${a.join(',')} vs ${b.join(',')})`, { field: 'structure' });
}

module.exports = {
  MAX_ADDITIONS, TMP_RE, AddProductError, normalizeName, tidyName, slugify, sameJson,
  resolveKeyMode, classifyItems, allocateAdditions, compareToActive, assertSameAuthoredFields, isGroupVariant, optionName, prospectiveAdditionNames,
  ALWAYS_COMPARED, COMPARED_WHEN_AUTHORED,
};
