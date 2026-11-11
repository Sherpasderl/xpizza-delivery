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
// S1a: a live item renamed under a recorded frozen key (frozenKeys = the draft's server-owned map) agrees with the mode by
// that entry — exactly (display.id, key), as validation reads it.
function resolveKeyMode(profileMode, activeItems, frozenKeys = null) {
  const frozenOk = (it) => isObj(frozenKeys) && it.display.id != null && own(frozenKeys, String(it.display.id)) && frozenKeys[String(it.display.id)] === it.key;
  if (!KEY_MODES.has(profileMode)) {
    refuse('key_mode_unknown', `the restaurant profile has no usable pricing_key_mode (${JSON.stringify(profileMode)}); products cannot be added until it is set`, { status: 409 });
  }
  for (const it of activeItems || []) {
    if (!it || !isObj(it.display) || (it.key !== keyOfDisplay(profileMode, it.display) && !frozenOk(it))) {
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
function allocateAdditions({ incoming, stored, activeItems, keyMode, hwm, registryHasKey, fieldProblem = () => null, authoring = false, mint = null }) {
  const source = JSON.parse(JSON.stringify(incoming));
  // S1a: every frozen key — active or inert — stays TAKEN, and every frozen display id stays USED, so a renamed product's key is
  // never minted for another product and its id is never handed to a new one (D1 ruling condition 1).
  const frozen = [incoming, stored].filter((s) => isObj(s) && isObj(s.frozen_keys)).flatMap((s) => Object.entries(s.frozen_keys));
  const frozenKeys = new Set(frozen.map(([, k]) => k));
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
  for (const [id] of frozen) if (/^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))) numericIds.push(Number(id));
  let next = Math.max(Number.isInteger(hwm) && hwm >= 0 ? hwm : 0, ...numericIds, 0);
  const allocatedNow = [];
  const refToKey = new Map();
  // After allocation a FRESH addition is known by its key — but the portal still holds it by its tmp reference (the
  // refused save stored nothing). Every refusal from here on names BOTH, so the portal opens the row it actually
  // has, and never an existing product that happens to share the key.
  const at = (key) => { for (const [r, k] of refToKey) if (k === key) return { key, ref: r }; return { key }; };
  const refToId = new Map();   // 1D add-product B: tmp ref → DISPLAY id (the namespace variantOf / variant_items use)
  const mintedNow = new Set();
  const mintExtraKeys = new Set(((incoming && incoming.extras) || []).map((e) => (isObj(e) ? e.key : null)).filter((k) => typeof k === 'string'));
  for (const { item } of fresh) {
    const name = tidyName(item.display.name);
    let key; let id;
    if (keyMode === 'name') { next += 1; id = next; key = name; } else {
      key = slugify(name);
      if (!key) refuse('name_unusable', `"${name}" has no letters or digits to build an identifier from`, { ref: item.ref, field: 'name' });
      id = key;
    }
    // S1c: with minting on, the pricing key is a fresh opaque token (the id is still today's) and the server records it as a
    // frozen key, so nothing downstream needs a new rule. It never equals an active, saved, same-batch, extra, frozen or
    // reserved key: ONE draw, and a collision refuses (retryable) rather than reuse one (codex S1c r1 P2-5).
    if (mint) {
      const used = (k) => activeKeys.has(k) || frozenKeys.has(k) || storedByKey.has(k) || mintedNow.has(k) || mintExtraKeys.has(k) || (mint.reserved && mint.reserved.has(k));
      const k = mint.newKey(); const drawn = used(k) ? null : k;
      if (drawn === null) refuse('mint_unavailable', 'could not allocate a new product identifier — try again', { status: 503, ref: item.ref, field: 'name' });
      key = drawn; mintedNow.add(key);
      source.frozen_keys = { ...(isObj(source.frozen_keys) ? source.frozen_keys : {}), [String(id)]: key };
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
    if (registryHasKey(key) || frozenKeys.has(key)) refuse('name_previously_used', 'Ese nombre ya existió en tu menú — usá otro nombre.', { ...at(key), field: nameField(addedByKey.get(key)) });
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
const TEXT_FIELDS = Object.freeze(['name', 'desc', 'cat', 'subcat']);
const ALWAYS_COMPARED = ['categories', 'variant_items', 'pickup_only_cats', 'weekend_only_cats', 'extra_order'];
const COMPARED_WHEN_AUTHORED = ['extra_categories', 'badges', 'exposure', 'extras_by_category', 'extras_by_item',
  'redeem_eligible_cats', 'redeem_eligible_items', 'redeem_eligible_extras'];

function compareToActive({ draftBuilt, activeBuilt, draftAuthored, renderedCategories, deletedIds = null, authoring = false, extrasAuthoring = false, textEdit = false, extrasCatalog = false }) {
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
    // S1a: with the item_text_edit switch ON an existing product's text joins them — name, description, category, subcategory
    // (its pricing key is kept by a recorded frozen key); OFF, they are compared exactly as before
    const free = [...(extrasAuthoring ? ['price', 'identity_id', 'extras_policy'] : ['price', 'identity_id']), ...(textEdit ? TEXT_FIELDS : [])];
    if (textEdit && d.display && a.display && d.display.cat !== a.display.cat && !(renderedCategories || []).includes(d.display.cat)) {
      refuse('category_not_renderable', `the section ${JSON.stringify(d.display.cat)} is not shown on your order page`, { key, field: 'cat' });
    }
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
  if (!extrasCatalog && (ae.size !== de.size || [...ae.keys()].some((k) => !de.has(k)))) refuse('extras_changed', 'options (extras) cannot be added or removed here');
  for (const [k, a] of ae) {
    if (!de.has(k)) {   // S2-core: a removal (switch on only, above) — a certified extra leaves only through the reviewed deletion claim
      const stamp = a.display && a.display.identity_id;
      if (typeof stamp === 'string' && stamp && !declared.has(stamp)) refuse('existing_extra_removed', `the option ${JSON.stringify(k)} can only leave through the reviewed removal`, { key: k });
      continue;
    }
    if (!sameJson(without(de.get(k).display, ['price']), without(a.display, ['price']))) refuse('extras_changed', `the option ${JSON.stringify(k)} can only have its price changed here`, { key: k });
  }
  if (extrasCatalog) extrasCatalogClaims({ draftBuilt, activeBuilt, ae, de });

  // Structure: item_order is the active order with the new keys appended; everything else is frozen.
  const removed = new Set(removals);
  const ao = (activeBuilt.structure.item_order || []).filter((k) => !removed.has(k));
  const dorder = draftBuilt.structure.item_order || [];
  const addKeys = new Set(additions.map((it) => it.key));
  if (dorder.length !== ao.length + addKeys.size || !ao.every((k, i) => dorder[i] === k) || !dorder.slice(ao.length).every((k) => addKeys.has(k))) {
    refuse('item_order_changed', 'existing products cannot be reordered here; new products go at the end', { field: 'item_order' });
  }
  const authored = draftAuthored instanceof Set ? draftAuthored : new Set(draftAuthored || []);
  const S2_CLAIMED = extrasCatalog ? new Set(['extra_order', 'extra_categories', 'extras_by_category', 'extras_by_item', 'redeem_eligible_extras']) : new Set();   // judged by extrasCatalogClaims
  for (const f of [...ALWAYS_COMPARED.filter((x) => x !== 'variant_items' && x !== 'categories'), ...COMPARED_WHEN_AUTHORED.filter((x) => authored.has(x) && x !== 'exposure')].filter((x) => !S2_CLAIMED.has(x))) {   // variant_items, categories, exposure: their own rules
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
    const shape = (x) => (extrasCatalog && isObj(x) ? without(x, ['category_allow', 'item_overrides']) : exposureWithoutDenyExtras(x));   // S2-core: attach / detach are claimed; nothing else in the exposure
    if (!sameJson(shape(de), shape(ae))) refuse('structure_changed', "the menu's exposure cannot change here", { field: 'exposure' });
    if (!sameJson(denyExtrasOf(de), denyExtrasOf(ae)) && !extrasAuthoring) refuse('extras_not_supported_yet', 'choosing which extras a product takes is not available yet', { field: 'deny_extras' });
  }
  accountResidual({ draftBuilt, activeBuilt, authored });
  return { additions: additions.map((it) => it.key), removals };
}

/* S2-core (PLAN-structure-S2core-r3 §1.2; Codex #4, ruling R1) — EXHAUSTIVE ACCOUNTING, the final gate. The rules above explain a
   change only through the fields they compare; anything else that differs and is not code-derived is a RESIDUAL and refuses
   `structure_unexplained` naming its path: a structure field the draft AUTHORS that no rule handles (badge_priority, schema_version,
   an unknown field), an unknown field on an existing item or extra row, an unknown top-level field, or a key-mode change. An
   UNAUTHORED structure field stays skipped (it is derived from code; a code change must not refuse every save). */
const HANDLED_STRUCTURE = new Set([...ALWAYS_COMPARED, ...COMPARED_WHEN_AUTHORED, 'item_order']);
const HANDLED_TOP = new Set(['items', 'extras', 'structure', 'key_mode', 'frozen_keys', 'photos']);   // frozen_keys / photos: their own rules
function accountResidual({ draftBuilt, activeBuilt, authored }) {
  const residual = (path) => refuse('structure_unexplained', `this change is not one the menu editor can make (${path})`, { field: path });
  const ds = draftBuilt.structure || {}; const as = activeBuilt.structure || {};
  for (const f of new Set([...Object.keys(ds), ...Object.keys(as)])) {
    if (HANDLED_STRUCTURE.has(f) || !authored.has(f)) continue;
    if (!sameJson(ds[f], as[f])) residual(`structure.${f}`);
  }
  for (const f of new Set([...Object.keys(draftBuilt), ...Object.keys(activeBuilt)])) {
    if (!HANDLED_TOP.has(f) && !sameJson(draftBuilt[f], activeBuilt[f])) residual(f);
  }
  if (draftBuilt.key_mode !== activeBuilt.key_mode) residual('key_mode');
  const rows = (kind, list, other, known) => {
    const byKey = new Map((other || []).map((r) => [r.key, r]));
    for (const r of list || []) {
      const prev = byKey.get(r.key); if (!prev) continue;
      for (const f of new Set([...Object.keys(r), ...Object.keys(prev)])) if (!known.includes(f) && !sameJson(r[f], prev[f])) residual(`${kind}.${r.key}.${f}`);
    }
  };
  rows('items', draftBuilt.items, activeBuilt.items, ['key', 'price', 'display', 'has_photo']);
  rows('extras', draftBuilt.extras, activeBuilt.extras, ['key', 'price', 'display']);
}

/* S2-core (PLAN-structure-S2core-r3 §1.3, §3.3) — the Extras-page claims, behind the extrasCatalog switch. The removed extras' identity
   claims are judged above; here: no group emptied (extras_group_empty); extra_order is exactly today's order minus the removals plus the
   additions, group-major in the draft's group order (no in-group reorder); redeem_eligible_extras may only lose removed keys; the
   exposure maps are the build's projection of the draft (derived, never edited); extra_categories may be reordered or extended. */
function extrasCatalogClaims({ draftBuilt, activeBuilt, ae, de }) {
  const ds = draftBuilt.structure || {}, as = activeBuilt.structure || {};
  const draftGroups = new Set([...de.values()].map((e) => e && e.display && e.display.cat));
  for (const g of (Array.isArray(as.extra_categories) ? as.extra_categories : [])) {
    if (!draftGroups.has(g)) refuse('extras_group_empty', `the group ${JSON.stringify(g)} would be left with no options`, { field: 'extras' });
  }
  const added = (draftBuilt.extras || []).map((e) => e.key).filter((k) => !ae.has(k));
  const kept = (Array.isArray(as.extra_order) ? as.extra_order : []).filter((k) => de.has(k));
  // the order the build derives (group-major in the draft's group order — extras-projection groupMajorOrder) must hold exactly the kept
  // and added extras, each group contiguous and in the group order, its kept extras in today's relative order, its new ones after them
  const seq = Array.isArray(ds.extra_order) ? ds.extra_order : [];
  const catOf = new Map((draftBuilt.extras || []).map((e) => [e.key, e && e.display && e.display.cat]));
  const groups = Array.isArray(ds.extra_categories) ? ds.extra_categories : [];
  const rank = (k) => { const i = groups.indexOf(catOf.get(k)); return i < 0 ? groups.length : i; };
  const bad = () => refuse('structure_changed', "the options' order can only change by adding, removing or reordering groups", { field: 'extra_order' });
  if (seq.length !== kept.length + added.length || !sameJson([...seq].sort(), [...kept, ...added].sort())) bad();
  for (let i = 1; i < seq.length; i++) if (rank(seq[i]) < rank(seq[i - 1])) bad();
  for (const g of new Set(seq.map((k) => catOf.get(k)))) {
    if (!sameJson(seq.filter((k) => catOf.get(k) === g), [...kept, ...added].filter((k) => catOf.get(k) === g))) bad();
  }
  if (Array.isArray(as.redeem_eligible_extras) || Array.isArray(ds.redeem_eligible_extras)) {
    const keep = (as.redeem_eligible_extras || []).filter((k) => de.has(k));
    if (!sameJson(ds.redeem_eligible_extras || [], keep)) refuse('structure_changed', "the menu's redeem_eligible_extras can only lose removed options", { field: 'redeem_eligible_extras' });
  }
}

// Two category lists that differ at most in `name`: same length, and at each index every field but `name` equal — the id
// among them, so the same ids in the same order (a field present on one side only is a change).
function sameCategoriesExceptName(d, a) {
  if (!Array.isArray(d) || !Array.isArray(a)) return sameJson(d, a);
  if (d.length !== a.length) return false;
  return d.every((c, i) => isObj(c) && isObj(a[i]) && sameJson(without(c, ['name']), without(a[i], ['name'])));
}
// Nothing but the categories differs: no product added or removed, every product and extra record (price included) equal,
// and every OTHER structure field equal (an allowed structure edit — deny_extras under extras authoring — is a change too).
function changesNothingElse(draftBuilt, activeBuilt, additions, removals) {
  if (additions.length || removals.length) return false;
  if (!sameJson(without(draftBuilt.structure, ['categories']), without(activeBuilt.structure, ['categories']))) return false;
  const da = new Map(draftBuilt.items.map((it) => [it.key, it]));
  if (!activeBuilt.items.every((a) => { const d = da.get(a.key); return d && d.price === a.price && sameJson(d.display, a.display) && !!d.has_photo === !!a.has_photo; })) return false;
  const de = new Map((draftBuilt.extras || []).map((e) => [e.key, e]));
  if (!(activeBuilt.extras || []).every((a) => { const d = de.get(a.key); return d && d.price === a.price && sameJson(d.display, a.display); })) return false;
  // DISH PHOTOS A2 (§2.1, Codex P1-2): the photo states must be equal too (absent on both = equal ⇒ unchanged for callers without photos)
  return samePhotoStates(draftBuilt.photos, activeBuilt.photos);
}

// DISH PHOTOS A2 — photo-state equality, INLINE because this module requires nothing (add-product.test pins that). Per item key the
// state is legacy (no entry) | pid:<pid> | removed; URLs on version entries are ignored. Parity with photos/photo-state.js sameStates
// is pinned by photos/photo-state.test.js over a matrix.
function samePhotoStates(a, b) {
  const kind = (e) => (!e || typeof e !== 'object' ? 'legacy' : e.state === 'pid' ? `pid:${e.pid}` : e.state === 'removed' ? 'removed' : 'legacy');
  const x = isObj(a) ? a : {}, y = isObj(b) ? b : {};
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (kind(x[k]) !== kind(y[k])) return false;
  return true;
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

/* ── S1a TEXT RULES (PLAN-portal-item-edit r6 §4.4 + the r6 group-rename addendum) ───────────────────────────────────────────
   Caps on NEWLY AUTHORED values only — a value equal to the live record's is grandfathered, however long: a product name ≤ 60
   with no < or > (the section-name rule), a description ≤ 200, and every DERIVED option name ≤ 60 (a group's options are named
   "{launcher} - {choice}", so a long launcher name is refused through them). A product with no live counterpart is newly
   authored throughout. A newly authored name may not be another product's name or key, or an option's (extra's) name — on a
   name-keyed menu that name IS a pricing key (name_taken) — nor a RESERVED key: any key the draft's frozen_keys map names, active
   or retired, other than the product's own (name_previously_used; codex S1a r1 P1). Returns [{ key, field, code }] (key = the tmp reference for an unallocated product); [] = none. */
const NAME_MAX = 60;
const DESC_MAX = 200;
const chars = (s) => [...String(s)].length;
function textCapProblems({ draft, live, mint = false }) {
  const liveByKey = new Map(((live && live.items) || []).filter((it) => isObj(it) && typeof it.key === 'string').map((it) => [it.key, it]));
  const out = [];
  const items = ((draft && draft.items) || []).filter((it) => isObj(it) && isObj(it.display));
  const extraNames = ((draft && draft.extras) || []).map((e) => (isObj(e) && isObj(e.display) && typeof e.display.name === 'string' ? normalizeName(e.display.name) : null)).filter(Boolean);
  const reserved = new Set((isObj(draft && draft.frozen_keys) ? Object.values(draft.frozen_keys) : []).filter((k) => typeof k === 'string').map(normalizeName));
  const taken = (self, name) => {
    const n = normalizeName(name);
    return extraNames.includes(n) || items.some((o) => o !== self && ((typeof o.display.name === 'string' && normalizeName(o.display.name) === n) || (typeof o.key === 'string' && normalizeName(o.key) === n)));
  };
  for (const it of items) {
    const l = typeof it.key === 'string' && !own(it, 'ref') ? liveByKey.get(it.key) : null;
    const was = l && isObj(l.display) ? l.display : null;
    const id = own(it, 'ref') ? it.ref : it.key;
    const d = it.display;
    if (typeof d.name === 'string' && (!was || was.name !== d.name)) {
      if (isGroupVariant(it)) { if (chars(d.name) > NAME_MAX) out.push({ key: id, field: 'name', code: 'option_name_too_long' }); } else {
        if (chars(d.name) > NAME_MAX) out.push({ key: id, field: 'name', code: 'name_too_long' });
        if (/[<>]/.test(d.name)) out.push({ key: id, field: 'name', code: 'text_unsafe' });
      }
      if (taken(it, d.name)) out.push({ key: id, field: isGroupVariant(it) ? 'choice' : 'name', code: 'name_taken' });
      else if (!(mint && !l) && reserved.has(normalizeName(d.name)) && !(l && normalizeName(it.key) === normalizeName(d.name))) out.push({ key: id, field: isGroupVariant(it) ? 'choice' : 'name', code: 'name_previously_used' });
    }
    if (typeof d.desc === 'string' && (!was || was.desc !== d.desc) && chars(d.desc) > DESC_MAX) out.push({ key: id, field: 'desc', code: 'desc_too_long' });
  }
  return out;
}

/* The group rename: every option of an EXISTING group takes its name from the submitted launcher — "{launcher} - {choice}",
   exactly the validator's rule — and the launcher's category and subcategory. Keys, display ids, choices, prices and the group
   refs are untouched (an option's key, once its name moves, is held by a recorded frozen key). A group being created in this
   save (a launcher or option still on a tmp reference) is left to the allocation, which derives it. Never mutates its input. */
function rederiveOptionNames(source) {
  const out = JSON.parse(JSON.stringify(source));
  const items = Array.isArray(out.items) ? out.items : [];
  const byId = new Map(items.filter((it) => isObj(it) && isObj(it.display) && it.display.id != null).map((it) => [String(it.display.id), it]));
  for (const m of items) {
    if (!isObj(m) || !isObj(m.display) || m.display.variantOf == null || own(m, 'ref')) continue;
    const launcher = byId.get(String(m.display.variantOf));
    if (!launcher || own(launcher, 'ref') || !isObj(launcher.display) || typeof launcher.display.name !== 'string' || typeof m.display.choice !== 'string') continue;
    m.display.name = `${launcher.display.name} - ${m.display.choice}`;
    m.display.cat = launcher.display.cat;
    if (launcher.display.subcat == null) delete m.display.subcat; else m.display.subcat = launcher.display.subcat;
  }
  return out;
}

module.exports = {
  textCapProblems, rederiveOptionNames, TEXT_FIELDS,   // S1a
  MAX_ADDITIONS, TMP_RE, AddProductError, normalizeName, tidyName, slugify, sameJson,
  resolveKeyMode, classifyItems, allocateAdditions, compareToActive, assertSameAuthoredFields, isGroupVariant, optionName, prospectiveAdditionNames,
  samePhotoStates,      // DISH PHOTOS A2: parity-tested against photos/photo-state.js
  changesNothingElse,   // PLAN-public-menu-display T1 (portal r1 #3): the SAME «anything but a category name» rule, read by draft-assess
  ALWAYS_COMPARED, COMPARED_WHEN_AUTHORED,
};
