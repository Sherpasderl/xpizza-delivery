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
const { AddProductError, TMP_RE, tidyName, slugify, normalizeName } = require('./add-product');
// the judgment of every new extra (label, names, reserved keys, stamps, the allocation's own shape) is the ONE validator's — the same
// one the publish and the manager request run (Codex build r1 P1-1 / P1-2); EXTRA_LABEL_UNSAFE is the capp serializer's own object
const { validateNewExtras, EXTRA_LABEL_UNSAFE } = require('./extras-validate');
const refuse = (code, detail, opts) => { throw new AddProductError(code, detail, opts); };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function allocateExtras({ incoming, stored = null, activeExtras = [], activeItems = [], keyMode, reserved = new Map(), switchOn = false, mintExtras = false, mint = null }) {
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
  const judge = (refOfKey) => {
    try { validateNewExtras({ extras: source.extras, activeExtras, activeItems, keyMode, reserved, frozenExtraKeys: source.frozen_extra_keys, mintExtras }); } catch (e) {
      if (e instanceof AddProductError && e.key && refOfKey.has(e.key)) { e.ref = refOfKey.get(e.key); e.key = null; }
      throw e;
    }
  };
  if (!fresh.length) { if (source.extras && source.extras.some((e) => isObj(e) && typeof e.key === 'string' && !activeKeys.has(e.key))) judge(new Map()); return { source, allocated: [] }; }
  if (!switchOn) refuse('extras_catalog_not_supported_yet', 'adding extras is not available yet', { field: 'extras' });

  // a fresh row supplies NOTHING the server allocates — no key, no UI id, no stamp — judged BEFORE the next id is counted, so a
  // client-chosen id can never shift the allocation (Codex build r2 #1)
  for (const e of fresh) {
    const d = isObj(e.display) ? e.display : {};
    if ('id' in d || 'identity_id' in d) refuse('client_supplied_key', 'a new extra cannot carry an id or a stamp the server did not allocate', { ref: typeof e.ref === 'string' ? e.ref : null, field: 'id' in d ? 'id' : 'identity_id' });
  }
  const takenKeys = new Set(extras.filter((e) => typeof e.key === 'string').map((e) => e.key));
  const takenIds = new Set(extras.filter((e) => isObj(e.display) && e.display.id != null).map((e) => String(e.display.id)));
  const refs = new Set(); const refOf = new Map();
  let nextE = Math.max(0, ...[...takenIds].map((id) => (/^e(\d+)$/.exec(id) ? Number(/^e(\d+)$/.exec(id)[1]) : 0))) + 1;
  // S2b (PLAN-structure-S2b-r3 §1): the shared collision set of a minted extra key — every item, extra, frozen and reserved key
  const used = new Set([...takenKeys, ...(activeItems || []).map((i) => i && i.key), ...((source.items || []).map((i) => i && i.key)),
    ...Object.values(isObj(source.frozen_keys) ? source.frozen_keys : {}), ...Object.keys(isObj(source.frozen_extra_keys) ? source.frozen_extra_keys : {}), ...reserved.keys()]);
  const draw = () => { const k = (mint && mint.newKey ? mint.newKey : require('./mint-opaque').mintKey)(); if (used.has(k)) refuse('mint_unavailable', 'could not allocate a new option identifier — try again', { status: 503, field: 'name' }); used.add(k); return k; };
  const names = new Set(extras.filter((e) => typeof e.key === 'string' && isObj(e.display)).map((e) => normalizeName(e.display.name)));
  for (const e of fresh) {
    if (typeof e.ref !== 'string' || !TMP_RE.test(e.ref) || refs.has(e.ref)) refuse('addition_malformed', 'a new extra needs a unique temporary reference tmp:<id>', { field: 'ref' });
    refs.add(e.ref);
    const d = isObj(e.display) ? e.display : {};
    const name = typeof d.name === 'string' ? tidyName(d.name) : '';
    if (!name || typeof d.cat !== 'string' || !d.cat) refuse('addition_malformed', 'a new extra needs a name and a group', { ref: e.ref, field: name ? 'cat' : 'name' });
    let key, id;
    if (keyMode === 'id') {
      key = slugify(name);
      if (!key) refuse('addition_malformed', `«${name}» has no usable characters for an id`, { ref: e.ref, field: 'name' });
      id = key;
    } else {
      key = name; id = `e${nextE}`;
    }
    if (mintExtras && names.has(normalizeName(name))) refuse('name_taken', `«${name}» is already on your menu`, { ref: e.ref, field: 'name' });   // S2b §1.3(a): candidate-wide
    names.add(normalizeName(name));
    if (mintExtras && (reserved.get(key) || []).includes('extra')) {   // S2b §1.3(c): a RETIRED extra name reused — a fresh key, the reuse recorded
      const reuses = key; key = draw(); if (keyMode === 'id') id = key;
      source.frozen_extra_keys = { ...(isObj(source.frozen_extra_keys) ? source.frozen_extra_keys : {}), [key]: { display_id: String(id), minted: true, reuses } };
    }
    if (takenKeys.has(key) || takenIds.has(id)) refuse('name_taken', `«${name}» is already on your menu`, { ref: e.ref, field: 'name' });
    const price = typeof e.price === 'number' ? e.price : d.price;
    const tmpRef = e.ref;   // the row is rewritten in place below
    const out = { key, price, display: { ...d, id, name, price } };
    Object.keys(e).forEach((k) => delete e[k]);
    Object.assign(e, out);
    takenKeys.add(key); takenIds.add(id); refOf.set(key, tmpRef);
    if (keyMode !== 'id') nextE += 1;
    allocatedNow.push(key);
  }
  judge(refOf);
  return { source, allocated: allocatedNow, refs: Object.fromEntries([...refOf].map(([key, ref]) => [ref, key])) };   // { tmp ref: key } — the save answers it (extraRefs)
}

// The save's step (edit-catalog-handler): nothing to do when no new extra arrives (today's drafts, byte for byte); otherwise the key mode
// and the reserved keys are read through the save's own add-product I/O, and the allocation's refusal is returned for the handler's map.
async function forSave({ candidate, stored, live, extrasLive, addProduct, rid, switchOn }) {
  // every extra the live version does not have is judged — a fresh tmp ref AND a keyed row (only a re-saved allocation of this draft's
  // own may carry a key; a client-invented key, id or stamp never saves: Codex build r1 P1-1)
  const liveKeys = new Set((extrasLive || []).map((e) => e && e.key));
  const fresh = (Array.isArray(candidate && candidate.extras) ? candidate.extras : []).some((e) => isObj(e) && !(typeof e.key === 'string' && liveKeys.has(e.key)));
  if (!fresh) return { source: candidate };
  const anyTmp = candidate.extras.some((e) => isObj(e) && typeof e.key !== 'string');
  if (!switchOn) return anyTmp ? { error: new AddProductError('extras_catalog_not_supported_yet', 'adding extras is not available yet', { field: 'extras' }) } : { source: candidate };   // switch OFF: a keyed row is today's compareToActive's (extras_changed)
  if (!addProduct) return { error: new AddProductError('add_product_unavailable', 'the add-product I/O is not wired', { status: 503 }) };
  let keyMode, reserved;
  try {
    keyMode = require('./add-product').resolveKeyMode(await addProduct.readKeyMode(rid), live.items, candidate.frozen_keys);
    reserved = await addProduct.readReservedKeys(rid);
  } catch (_) { return { unavailable: true }; }
  try {
    const a = allocateExtras({ incoming: candidate, stored, activeExtras: extrasLive || [], activeItems: live.items || [], keyMode, reserved, switchOn, mintExtras: require('./extra-identity').extraIdentityCapabilities().mintExtras });   // S2b: the dark switch
    return { source: a.source, refs: a.refs || {} };
  } catch (e) { if (e instanceof AddProductError) return { error: e }; throw e; }
}

module.exports = { allocateExtras, forSave, EXTRA_LABEL_UNSAFE };
