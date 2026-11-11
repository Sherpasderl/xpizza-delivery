'use strict';
// S2-core (PLAN-structure-S2core-r3 §3.1, §3.4) — the EXTRA allocator: the server owns every new extra's key and UI id, exactly as
// allocateAdditions owns a new product's. Pure; never mutates its inputs.
//   A new extra arrives as { ref: 'tmp:…', price, display: { name, cat, price? } } and leaves as { key, price, display: { id, name, cat,
//   price } } — the two key mappings (form-menu-source extrasKeyOf, source-store :274):
//     name mode (x_pizza): key = the tidy name; display.id = 'e' + (the highest existing e-number + 1)
//     id mode   (la_musa): key = display.id = a slug of the name, unique among extras
//   Refusals: extras_catalog_not_supported_yet (any new extra while the switch is off) · client_supplied_key (a key or id the server
//   did not allocate) · addition_malformed (no tmp ref / no name / no group) · extra_name_unsafe (a , | + [ ] in the name — the capp
//   could never sell it; EXTRA_LABEL_UNSAFE is the capp's own rule, pinned byte for byte by extras-allocate.test.js) · name_taken (an
//   ACTIVE extra's or dish's name) · name_needs_new_id (a key an EXTRA once had — reserved kind 'extra' — until S2b gives extras
//   fresh ids; a retired DISH key does not block).
const { AddProductError, TMP_RE, normalizeName, tidyName, slugify } = require('./add-product');

const EXTRA_LABEL_UNSAFE = /[,|+[\]]/;   // the capp's reader / grammar delimiters (customer-app capp-serialize.js UNSAFE_LABEL)
const refuse = (code, detail, opts) => { throw new AddProductError(code, detail, opts); };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function allocateExtras({ incoming, stored = null, activeExtras = [], activeItems = [], keyMode, reserved = new Map(), switchOn = false }) {
  const source = JSON.parse(JSON.stringify(incoming));
  const extras = Array.isArray(source.extras) ? source.extras : [];
  const activeKeys = new Set(activeExtras.map((e) => e.key));
  const storedByKey = new Map(((stored && stored.extras) || []).filter((e) => isObj(e) && typeof e.key === 'string').map((e) => [e.key, e]));
  const fresh = [], allocatedNow = [];
  for (const e of extras) {
    if (!isObj(e)) continue;
    if (typeof e.key === 'string' && activeKeys.has(e.key)) continue;   // an existing extra
    if (typeof e.key === 'string') {   // an addition already allocated in the SAVED draft keeps it; anything else is the client's invention
      const was = storedByKey.get(e.key);
      if (!was || !isObj(e.display) || !isObj(was.display) || String(e.display.id) !== String(was.display.id) || 'identity_id' in e.display) {
        refuse('client_supplied_key', `a new extra cannot carry a key or id the server did not allocate (${JSON.stringify(e.key)})`, { key: e.key });
      }
      continue;
    }
    fresh.push(e);
  }
  if (!fresh.length) return { source, allocated: [] };
  if (!switchOn) refuse('extras_catalog_not_supported_yet', 'adding extras is not available yet', { field: 'extras' });

  const activeExtraNames = new Set(activeExtras.map((e) => normalizeName(e.display && e.display.name)));
  const activeDishNames = new Set(activeItems.map((i) => normalizeName(i.display && i.display.name)));
  const takenKeys = new Set(extras.filter((e) => typeof e.key === 'string').map((e) => e.key));
  const takenIds = new Set(extras.filter((e) => isObj(e.display) && e.display.id != null).map((e) => String(e.display.id)));
  const refs = new Set();
  let nextE = Math.max(0, ...[...takenIds].map((id) => (/^e(\d+)$/.exec(id) ? Number(/^e(\d+)$/.exec(id)[1]) : 0))) + 1;
  for (const e of fresh) {
    if (typeof e.ref !== 'string' || !TMP_RE.test(e.ref) || refs.has(e.ref)) refuse('addition_malformed', 'a new extra needs a unique temporary reference tmp:<id>', { field: 'ref' });
    refs.add(e.ref);
    const d = isObj(e.display) ? e.display : {};
    const name = typeof d.name === 'string' ? tidyName(d.name) : '';
    if (!name || typeof d.cat !== 'string' || !d.cat) refuse('addition_malformed', 'a new extra needs a name and a group', { ref: e.ref, field: name ? 'cat' : 'name' });
    if (EXTRA_LABEL_UNSAFE.test(name)) {
      refuse('extra_name_unsafe', `«${name}» carries ${[...new Set(name.match(/[,|+[\]]/g))].join(' ')}`, { ref: e.ref, field: 'name' });
    }
    const n = normalizeName(name);
    if (activeExtraNames.has(n) || activeDishNames.has(n)) refuse('name_taken', `«${name}» is already on your menu`, { ref: e.ref, field: 'name' });
    let key, id;
    if (keyMode === 'id') {
      key = slugify(name);
      if (!key) refuse('addition_malformed', `«${name}» has no usable characters for an id`, { ref: e.ref, field: 'name' });
      id = key;
    } else {
      key = name; id = `e${nextE}`;
    }
    const kinds = reserved.get(key) || [];
    if (kinds.includes('extra')) refuse('name_needs_new_id', `«${name}» was an extra on your menu before`, { ref: e.ref, field: 'name' });
    if (takenKeys.has(key) || takenIds.has(id)) refuse('name_taken', `«${name}» is already on your menu`, { ref: e.ref, field: 'name' });
    const price = typeof e.price === 'number' ? e.price : d.price;
    const out = { key, price, display: { ...d, id, name, price } };
    Object.keys(e).forEach((k) => delete e[k]);
    Object.assign(e, out);
    takenKeys.add(key); takenIds.add(id); activeExtraNames.add(n);
    if (keyMode !== 'id') nextE += 1;
    allocatedNow.push(key);
  }
  return { source, allocated: allocatedNow };
}

module.exports = { allocateExtras, EXTRA_LABEL_UNSAFE };
