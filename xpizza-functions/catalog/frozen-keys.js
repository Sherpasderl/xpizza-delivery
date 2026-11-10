'use strict';
// ---------------------------------------------------------------------------
// S1a (PLAN-portal-item-edit r6; design D4c-grill/item-s1/S1a-DESIGN.md D1 + the two ruling conditions) — FROZEN KEYS.
// A product's pricing key never changes when its name does. Where the key derives from the name (name-keyed restaurants),
// a rename is recorded as `frozen_keys: { "<display.id>": "<key>" }`, server-owned like key_mode: a draft may echo the stored
// map, never add, change or drop an entry. An entry is ACTIVE only while the item with that display.id carries exactly that
// key; otherwise (the item was deleted, or its id now belongs to another product) it is kept inertly and judged by nothing.
// ACCEPTING a recorded rename is permanent (validation, the build, publish, pre-flip, rollback and reset all read the map);
// only MAKING one is switched (catalog/item-text-edit.js), so switching it off never strands a menu that was renamed.
// Pure: reads nothing, writes nothing.
// ---------------------------------------------------------------------------
const { pricingKeyOf } = require('./form-menu-source');

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The shape the map must have when present: a plain object of non-empty string → non-empty string. null is not "absent" —
// a stored null would read as a dropped map. Returns a reason, or null when the value is well formed.
function frozenKeysProblem(value) {
  if (!isPlain(value)) return `frozen_keys must be an object of display id → key (${JSON.stringify(value)})`.slice(0, 160);
  for (const [id, key] of Object.entries(value)) {
    if (!id) return 'frozen_keys has an empty display id';
    if (typeof key !== 'string' || !key) return `frozen_keys[${JSON.stringify(id)}] must be a non-empty key (${JSON.stringify(key)})`.slice(0, 160);
  }
  return null;
}

// The ACTIVE entries of a source: display.id → key, only where an item with that display.id carries exactly that key.
function activeFrozenKeys(source) {
  const out = new Map();
  const map = source && source.frozen_keys;
  if (!isPlain(map)) return out;
  for (const it of (source && Array.isArray(source.items) ? source.items : [])) {
    if (!isPlain(it) || !isPlain(it.display) || it.display.id === undefined || it.display.id === null) continue;
    const id = String(it.display.id);
    if (own(map, id) && map[id] === it.key && typeof it.key === 'string') out.set(id, it.key);
  }
  return out;
}

const sameMap = (a, b) => {
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

// The map is server-owned: a draft may echo exactly the stored one; an absent or null one keeps it; anything else is refused.
function serverOwnedFrozenKeys(draft, stored) {
  const want = stored && stored.frozen_keys != null ? stored.frozen_keys : undefined;
  const got = draft && draft.frozen_keys != null ? draft.frozen_keys : undefined;
  if (got !== undefined && (want === undefined || !isPlain(got) || !isPlain(want) || !sameMap(got, want))) {
    return { ok: false, error: 'frozen_keys_server_owned' };
  }
  return { ok: true, frozen_keys: want };
}

// The draft with exactly the given map: set when there is one, removed when there is none.
function withFrozenKeys(source, map) {
  const { frozen_keys: _ignored, ...rest } = source;   // eslint-disable-line no-unused-vars
  return map === undefined ? rest : { ...rest, frozen_keys: map };
}

// The renames a save makes, recorded. Only with the switch on (off ⇒ nothing is recorded and the stored map stands). An
// EXISTING product — the same key and the same display.id as live — whose key no longer derives from its display gets an entry
// for (display.id, key); every stored entry is kept. An entry already held by that display.id for a different key (an id reused
// after its renamed product was deleted) is a conflict the server refuses rather than overwrite.
function recordRenames({ draft, live, stored, textEdit }) {
  if (!textEdit) return { ok: true, frozen_keys: undefined };
  const kept = stored && isPlain(stored.frozen_keys) ? stored.frozen_keys : null;
  const out = { ...(kept || {}) };
  const rid = draft && draft.restaurant_id;
  const keyMode = draft && draft.key_mode;
  const liveByKey = new Map(((live && live.items) || []).filter((it) => isPlain(it) && isPlain(it.display)).map((it) => [it.key, it]));
  for (const d of ((draft && draft.items) || [])) {
    if (!isPlain(d) || !isPlain(d.display) || typeof d.key !== 'string' || own(d, 'ref')) continue;
    const l = liveByKey.get(d.key);
    if (!l || String(l.display.id) !== String(d.display.id)) continue;
    if (pricingKeyOf(rid, d.display, keyMode) === d.key) continue;
    const id = String(d.display.id);
    if (own(out, id) && out[id] !== d.key) return { ok: false, error: 'rename_id_conflict', key: d.key };
    out[id] = d.key;
  }
  return { ok: true, frozen_keys: Object.keys(out).length || kept ? out : undefined };
}

// The labels a draft newly gives its RENAMED products: an existing product (same key and display.id as live) whose name differs from
// live — every group member included, whether or not a map entry holds it (an id-keyed rename records none; codex S1a r2 P1). A label
// equal to the product's own key (a rename back) is not new. The writers check these against the identity registry's retired keys
// (codex S1a r1 P1): a name used before stays reserved.
function renamedLabels({ draft, live }) {
  const liveByKey = new Map(((live && live.items) || []).filter((it) => isPlain(it) && isPlain(it.display)).map((it) => [it.key, it]));
  const out = [];
  for (const d of ((draft && draft.items) || [])) {
    if (!isPlain(d) || !isPlain(d.display) || typeof d.key !== 'string' || own(d, 'ref') || typeof d.display.name !== 'string') continue;
    const id = d.display.id == null ? null : String(d.display.id);
    const l = liveByKey.get(d.key);
    if (id === null || !l || String(l.display.id) !== id || l.display.name === d.display.name || require('./add-product').normalizeName(d.display.name) === require('./add-product').normalizeName(d.key)) continue;   // S2-9 (G4): the record's OWN key is exempt, normalized as every other judge compares
    out.push({ key: d.key, name: d.display.name, field: d.display.variantOf != null ? 'choice' : 'name' });
  }
  return out;
}

module.exports = { frozenKeysProblem, activeFrozenKeys, serverOwnedFrozenKeys, withFrozenKeys, recordRenames, renamedLabels };
