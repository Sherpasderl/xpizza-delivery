'use strict';
// S2-core (Codex build r1 P1-1 / P1-2) — THE ONE validator of new extras, run by the save (after the allocator) AND by the owner publish
// and the manager request (catalog/structure-gate.js), against the CURRENT live version. A new extra = an extra row whose key the live
// version does not have. Each one must be exactly what the server's allocator writes (extras-allocate.js):
//   · no identity stamp (a new extra is unidentified until its first activation) ............................ client_supplied_key
//   · its key and UI id ARE the allocation of its name: name mode key = the tidy name, id = 'e<n>';
//     id mode key = id = the slug of the name ............................................................. client_supplied_key
//   · a label the capp can serialize — the capp serializer's OWN predicate, compiled from its byte copy (catalog/capp-serialize.js) . extra_name_unsafe
//   · not an active extra's or dish's name, nor another new extra's key / id ......................................... name_taken
//   · not a key an extra once had (reserved kind 'extra'; a retired DISH key does not block) ..................... name_needs_new_id
// Pure; throws AddProductError (the handlers map it). Records or source rows alike ({ key, display: { id, name, identity_id? } }).
const { AddProductError, normalizeName, tidyName, slugify } = require('./add-product');
const { OPAQUE_SYNTAX } = require('./mint-opaque');
// the capp serializer's OWN rule, compiled from its byte copy (catalog/capp-serialize.js, written by tools/sync-client.js and drift-guarded by
// catalog/capp-serialize-sync.guard.test.js) — the capp lane's file stays untouched; there is ONE source text for the predicate
const EXTRA_LABEL_UNSAFE = (() => {
  const m = require('fs').readFileSync(require('path').join(__dirname, 'capp-serialize.js'), 'utf8').match(/\n {2}const UNSAFE_LABEL = \/(.+?)\/;/);
  if (!m) throw new Error('extras-validate: the capp serializer no longer declares UNSAFE_LABEL');
  return new RegExp(m[1]);
})();

const refuse = (code, detail, opts) => { throw new AddProductError(code, detail, opts); };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function validateNewExtras({ extras, activeExtras = [], activeItems = [], keyMode, reserved = new Map(), frozenExtraKeys = null, mintExtras = false }) {
  const activeKeys = new Set(activeExtras.map((e) => e && e.key));
  const rows = (Array.isArray(extras) ? extras : []).filter((e) => isObj(e) && typeof e.key === 'string' && !activeKeys.has(e.key));
  if (!rows.length) return [];
  const activeExtraNames = new Set(activeExtras.map((e) => normalizeName(e && e.display && e.display.name)));
  const activeDishNames = new Set(activeItems.map((i) => normalizeName(i && i.display && i.display.name)));
  const allKeys = new Map(); const allIds = new Map();
  for (const e of extras) {
    if (!isObj(e) || typeof e.key !== 'string') continue;
    allKeys.set(e.key, (allKeys.get(e.key) || 0) + 1);
    if (isObj(e.display) && e.display.id != null) allIds.set(String(e.display.id), (allIds.get(String(e.display.id)) || 0) + 1);
  }
  const nameCount = new Map();   // S2b §1.3(a): names unique across the WHOLE candidate (two rows reusing one retired name never both pass)
  for (const e of extras) if (isObj(e) && typeof e.key === 'string' && isObj(e.display)) { const k = normalizeName(e.display.name); nameCount.set(k, (nameCount.get(k) || 0) + 1); }
  for (const e of rows) {
    const d = isObj(e.display) ? e.display : {};
    if ('identity_id' in d) refuse('client_supplied_key', `a new extra cannot carry an identity stamp (${JSON.stringify(e.key)})`, { key: e.key, field: 'identity_id' });
    const name = typeof d.name === 'string' ? d.name : '';
    const derived = keyMode === 'id' ? slugify(name) : tidyName(name);
    // S2b §1.3(c): a minted row is the server's allocation ONLY with its recorded reuse — the switch on, the opaque shape, its own display id,
    // the retired key it reuses = its name's derivation, and that key reserved as an EXTRA's
    const entry = isObj(frozenExtraKeys) && isObj(frozenExtraKeys[e.key]) && frozenExtraKeys[e.key].minted === true ? frozenExtraKeys[e.key] : null;
    const minted = !!entry && mintExtras === true && OPAQUE_SYNTAX.test(e.key) && entry.display_id === String(d.id)
      && (keyMode === 'id' ? String(d.id) === e.key : /^e\d+$/.test(String(d.id))) && entry.reuses === derived && (reserved.get(derived) || []).includes('extra');
    const allocated = minted || (keyMode === 'id'
      ? (e.key === String(d.id) && e.key === slugify(name) && !!e.key)
      : (e.key === tidyName(name) && /^e\d+$/.test(String(d.id))));
    if (!allocated) refuse('client_supplied_key', `a new extra's key and id must be the server's allocation of its name (${JSON.stringify(e.key)})`, { key: e.key });
    if (EXTRA_LABEL_UNSAFE.test(name)) refuse('extra_name_unsafe', `«${name}» carries ${[...new Set(name.match(/[,|+[\]]/g))].join(' ')}`, { key: e.key, field: 'name' });
    const n = normalizeName(name);
    if (activeExtraNames.has(n) || activeDishNames.has(n)) refuse('name_taken', `«${name}» is already on your menu`, { key: e.key, field: 'name' });
    if (allKeys.get(e.key) > 1 || allIds.get(String(d.id)) > 1 || (mintExtras && nameCount.get(n) > 1)) refuse('name_taken', `«${name}» is already on your menu`, { key: e.key, field: 'name' });
    const kinds = reserved.get(e.key) || [];
    if (!minted && kinds.includes('extra')) refuse('name_needs_new_id', `«${name}» was an extra on your menu before`, { key: e.key, field: 'name' });
  }
  return rows.map((e) => e.key);
}

module.exports = { validateNewExtras, EXTRA_LABEL_UNSAFE };
