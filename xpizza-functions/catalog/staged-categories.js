'use strict';
// S4 (PLAN-structure-S4-r4 §1.2, R2.7/R3.3, §1.3) — the STAGED categories' shape, checked by validateSource (one call, source-store.js):
// structure.staged_categories, when present, is a NON-EMPTY array (an empty list is stored absent — one representation) of exactly
// { id, name, after }:
//   id     /^[a-z][a-z0-9_]{0,31}$/ (the section-transitions slug syntax), unique across categories ∪ staged
//   name   trimmed, 1..40, unique case-folded across every named category ∪ staged
//   after  null (first) or a DECLARED category id — never a staged id, never itself (R3.3: no cycles can be expressed)
// `fail(message)` is validateSource's own (source_malformed).
const NAME_MAX = 40;
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const KEYS = ['after', 'id', 'name'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fold = (s) => require('./add-product').normalizeName(s);   // the ONE folding section-compare uses

function validateStaged(st, rid, fail) {
  if (!isObj(st) || st.staged_categories === undefined) return;
  const list = st.staged_categories;
  if (!Array.isArray(list) || list.length === 0) fail(`${rid} — structure.staged_categories must be a non-empty array when present`);
  const catIds = new Set((Array.isArray(st.categories) ? st.categories : []).filter(isObj).map((c) => c.id));
  const names = new Set((Array.isArray(st.categories) ? st.categories : []).filter((c) => isObj(c) && typeof c.name === 'string' && c.name).map((c) => fold(c.name)));
  const ids = new Set();
  for (const e of list) {
    if (!isObj(e) || JSON.stringify(Object.keys(e).sort()) !== JSON.stringify(KEYS)) fail(`${rid} — a staged category must be exactly { id, name, after }`);
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) fail(`${rid} — staged category id ${JSON.stringify(e.id)} is not valid`);
    if (catIds.has(e.id) || ids.has(e.id)) fail(`${rid} — staged category id ${e.id} is not unique`);
    ids.add(e.id);
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name || name !== e.name) fail(`${rid} — staged category ${e.id} needs a trimmed name`);
    if ([...name].length > NAME_MAX) fail(`${rid} — staged category ${e.id}'s name is over ${NAME_MAX} characters`);
    if (names.has(fold(name))) fail(`${rid} — staged category ${e.id}'s name is already taken`);
    names.add(fold(name));
  }
  for (const e of list) {
    if (e.after !== null && !(typeof e.after === 'string' && catIds.has(e.after))) fail(`${rid} — staged category ${e.id} must follow a declared category (or be first)`);
  }
}

module.exports = { validateStaged, ID_RE, NAME_MAX };
