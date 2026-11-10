'use strict';
// S0 — the restaurant's key mode on the DRAFT write paths (PLAN-portal-item-edit r6 S0; ruling R2).
// The mode is server-owned: it is set when a source is seeded or created, and a draft write may only echo what is stored.
// A different mode in a draft (a change, or one added where none is stored) is refused; an absent or null one keeps the
// stored value, so a client that never saw the field cannot drop it.
function serverOwnedKeyMode(draft, stored) {
  const want = stored && stored.key_mode != null ? stored.key_mode : undefined;
  const got = draft && draft.key_mode != null ? draft.key_mode : undefined;
  if (got !== undefined && got !== want) return { ok: false, error: 'key_mode_server_owned' };
  return { ok: true, key_mode: want };
}
// The draft with exactly the server-owned mode: set when there is one, removed when there is none.
function withServerKeyMode(source, keyMode) {
  const { key_mode: _ignored, ...rest } = source;   // eslint-disable-line no-unused-vars
  return keyMode === undefined ? rest : { ...rest, key_mode: keyMode };
}
module.exports = { serverOwnedKeyMode, withServerKeyMode };
