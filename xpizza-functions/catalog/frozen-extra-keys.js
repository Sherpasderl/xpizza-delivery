'use strict';
// ---------------------------------------------------------------------------
// S2b (PLAN-structure-S2b-r3 §1.2, §3) — FROZEN EXTRA KEYS, the extras' counterpart of frozen-keys.js. An extra whose pricing key no longer
// derives from its display — a RETIRED extra name reused under a fresh server-minted key, or a RENAMED extra (its key kept) — is recorded in
// the server-owned `frozen_extra_keys: { "<key>": { display_id, minted?: true, reuses?: "<retired key>", field?: "name" } }`, in BOTH key
// modes. An entry is ACTIVE only while an extra with that display id carries exactly that key; otherwise it is kept inertly and judged by
// nothing. Accepting a recorded entry is permanent (validation, the build, publish, pre-flip, rollback and reset all read it); only MAKING one
// is switched (catalog/extra-identity.js), so switching it off never strands a menu. Written by the server only: the extras allocator (a
// minted reuse) and recordExtraRenames (a rename). Pure: reads nothing, writes nothing.
// ---------------------------------------------------------------------------
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ENTRY_FIELDS = new Set(['display_id', 'minted', 'reuses', 'field']);

function frozenExtraKeysProblem(value) {
  if (!isPlain(value)) return `frozen_extra_keys must be an object of key → entry (${JSON.stringify(value)})`.slice(0, 160);
  for (const [key, e] of Object.entries(value)) {
    if (!key) return 'frozen_extra_keys has an empty key';
    if (!isPlain(e)) return `frozen_extra_keys[${JSON.stringify(key)}] must be an entry object`.slice(0, 160);
    for (const f of Object.keys(e)) if (!ENTRY_FIELDS.has(f)) return `frozen_extra_keys[${JSON.stringify(key)}] has an unknown field ${f}`.slice(0, 160);
    if (typeof e.display_id !== 'string' || !e.display_id) return `frozen_extra_keys[${JSON.stringify(key)}].display_id must be a non-empty string`.slice(0, 160);
    if (own(e, 'minted') && e.minted !== true) return `frozen_extra_keys[${JSON.stringify(key)}].minted must be true when present`.slice(0, 160);
    if (own(e, 'reuses') && (typeof e.reuses !== 'string' || !e.reuses)) return `frozen_extra_keys[${JSON.stringify(key)}].reuses must be a non-empty key`.slice(0, 160);
    if (own(e, 'field') && e.field !== 'name') return `frozen_extra_keys[${JSON.stringify(key)}].field must be "name"`.slice(0, 160);
  }
  return null;
}

// The ACTIVE entries of a source: display id → key, only where an extra with that display id carries exactly that key.
function activeFrozenExtraKeys(source) {
  const out = new Map();
  const map = source && source.frozen_extra_keys;
  if (!isPlain(map)) return out;
  for (const e of (source && Array.isArray(source.extras) ? source.extras : [])) {
    if (!isPlain(e) || typeof e.key !== 'string' || !isPlain(e.display) || e.display.id === undefined || e.display.id === null) continue;
    const entry = own(map, e.key) ? map[e.key] : null;
    if (isPlain(entry) && entry.display_id === String(e.display.id)) out.set(String(e.display.id), e.key);
  }
  return out;
}

const sameEntries = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

// Server-owned: a draft may echo exactly the stored map; an absent or null one keeps it; anything else is refused.
function serverOwnedFrozenExtraKeys(draft, stored) {
  const want = stored && stored.frozen_extra_keys != null ? stored.frozen_extra_keys : undefined;
  const got = draft && draft.frozen_extra_keys != null ? draft.frozen_extra_keys : undefined;
  if (got !== undefined && (want === undefined || !isPlain(got) || !isPlain(want) || !sameEntries(got, want))) {
    return { ok: false, error: 'frozen_extra_keys_server_owned' };
  }
  return { ok: true, frozen_extra_keys: want };
}

// The draft with exactly the given map: set when there is one, removed when there is none (absent ⇒ today's bytes).
function withFrozenExtraKeys(source, map) {
  const { frozen_extra_keys: _ignored, ...rest } = source;   // eslint-disable-line no-unused-vars
  return map === undefined || (isPlain(map) && !Object.keys(map).length) ? rest : { ...rest, frozen_extra_keys: map };
}

// The extra renames a save makes, recorded (called only with the dark switch ON): an EXISTING extra — the same key and display id as
// live — whose display name changed gets { display_id, field: 'name' }; every stored entry is kept; an entry already held by that key
// for a different display id is refused (never overwritten).
function recordExtraRenames({ draft, live, stored }) {
  const kept = stored && isPlain(stored.frozen_extra_keys) ? stored.frozen_extra_keys : null;
  const out = { ...(kept || {}) };
  const liveByKey = new Map(((live && live.extras) || []).filter((e) => isPlain(e) && isPlain(e.display)).map((e) => [e.key, e]));
  for (const d of ((draft && draft.extras) || [])) {
    if (!isPlain(d) || typeof d.key !== 'string' || !isPlain(d.display) || own(d, 'ref')) continue;
    const l = liveByKey.get(d.key);
    if (!l || String(l.display.id) !== String(d.display.id) || l.display.name === d.display.name) continue;
    const id = String(d.display.id);
    if (own(out, d.key) && out[d.key].display_id !== id) return { ok: false, error: 'extra_rename_conflict', key: d.key };
    if (!own(out, d.key)) out[d.key] = { display_id: id, field: 'name' };
  }
  return { ok: true, frozen_extra_keys: Object.keys(out).length || kept ? out : undefined };
}

module.exports = { frozenExtraKeysProblem, activeFrozenExtraKeys, serverOwnedFrozenExtraKeys, withFrozenExtraKeys, recordExtraRenames };
