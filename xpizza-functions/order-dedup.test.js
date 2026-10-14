'use strict';

// order-dedup — pure content-key + re-tap decision (Layer 2 content-aware phone rate limit).
// Run: node order-dedup.test.js
const assert = require('assert');
const { orderContentKey, orderContentKeyVerbatim, canonicalItemsText, legacyItemsText, isContentRetap } = require('./order-dedup');

const base = { phone: '+504 3367-2490', itemsText: '1x Pad Thai - Camarones (L414)', orderType: 'delivery', scheduledFor: null };
const k = orderContentKey(base);
assert.equal(k, orderContentKey({ ...base, phone: '33672490' }), 'phone normalized (digits only) → same key');
assert.equal(k, orderContentKey({ ...base, phone: '504-3367-2490' }), 'phone punctuation ignored → same key');
assert.notEqual(k, orderContentKey({ ...base, itemsText: '2x Pad Thai - Camarones (L828)' }), 'different cart → different key');
assert.notEqual(k, orderContentKey({ ...base, orderType: 'pickup' }), 'different type → different key');
assert.notEqual(k, orderContentKey({ ...base, scheduledFor: 1787000000000 }), 'scheduled vs ASAP → different key');
assert.equal(orderContentKey({ ...base, scheduledFor: null }), orderContentKey({ ...base, scheduledFor: undefined }), 'null/undefined slot both = ASAP');
assert.equal(typeof k, 'string');
assert.ok(/^[0-9a-f]+$/.test(k), 'rtdb-safe hex key (no . $ # [ ] /)');
assert.equal(orderContentKey({}), orderContentKey({ phone: '', itemsText: '', orderType: '', scheduledFor: null }), 'empty inputs stable');

// PLAN-menu-ordering §3 — the key is ORDER-INDEPENDENT (forms now serialize in cart insertion order)
{
  const A = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]', B = '1x Margherita (L250)', C = '1x Pad Thai - Pollo (L342) [+ 2x Arroz blanco]';
  const at = (t) => orderContentKey({ ...base, itemsText: t });
  assert.equal(at(`${A} | ${B}`), at(`${B} | ${A}`), 'the same cart in either line order → the same key');
  assert.equal(at(`${A} | ${B} | ${C}`), at(`${C} | ${A} | ${B}`), 'three lines, any order → the same key');
  assert.notEqual(at(`${A} | ${B}`), at(A), 'a different cart (a line fewer) → a different key');
  // a line keeps its OWN extras: the separator inside "[…]" is not a line break. A naive split of these two DIFFERENT
  // carts (pizza 2's extra moved between dishes) yields the same multiset of pieces — the keys must still differ
  const X = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni] | 2x Margherita (L250) [Pizza 1: Albahaca | Pizza 2: Chorizo]';
  const Y = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Chorizo] | 2x Margherita (L250) [Pizza 1: Albahaca | Pizza 2: Pepperoni]';
  assert.deepStrictEqual(X.split(' | ').sort(), Y.split(' | ').sort(), 'premise: a naive " | " split cannot tell these carts apart');
  assert.notEqual(at(X), at(Y), 'two DIFFERENT carts whose naive split collides keep DIFFERENT keys');
  // compatibility: a one-line cart keys EXACTLY as before §3 (most live stamps are unchanged)
  for (const t of [A, B, C, '  1x Margherita (L250)  ']) assert.equal(at(t), orderContentKeyVerbatim({ ...base, itemsText: t }), `one line → the pre-§3 key (${t})`);
  // unbalanced brackets → verbatim (never a looser key)
  for (const t of ['1x A (L1) ] | 1x B (L2)', '1x A (L1) [x | 1x B (L2)']) assert.equal(canonicalItemsText(t), t, `unbalanced → verbatim: ${t}`);
  assert.equal(canonicalItemsText(`${B} | ${A}`), canonicalItemsText(`${A} | ${B}`), 'either order → the same canonical text');
  assert.equal(canonicalItemsText(null), '', 'null → empty');
  console.log('  ✓ §3: order-independent content key (lines at top level only; single-line keys unchanged; unbalanced → verbatim)');
}

// §3 r2 — the PRE-§3 text of a cart, rebuilt from any line order (old clients serialized in MENU order; the server
// appends reward lines last)
{
  const menu = ['Carnivora', 'Crispy Bacon', 'Margherita', 'Pepperoni'];
  const A = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]', B = '1x Pepperoni (L307)', C = '1x Margherita (L299)', F = '1x Margherita (Recompensa)';
  assert.equal(legacyItemsText(`${B} | ${A}`, menu), `${A} | ${B}`, 'client lines re-ordered into menu order');
  assert.equal(legacyItemsText(`${B} | ${C} | ${A}`, menu), `${A} | ${C} | ${B}`, 'three lines, any order → menu order');
  assert.equal(legacyItemsText(`${A} | ${B}`, menu), `${A} | ${B}`, 'already menu-ordered → unchanged');
  assert.equal(legacyItemsText(`${B} | ${A} | ${F}`, menu), `${A} | ${B} | ${F}`, 'server-appended reward lines stay LAST, as appended');
  assert.equal(legacyItemsText(A, menu), A, 'one line → itself (= the verbatim key, as before)');
  assert.equal(legacyItemsText(`1x Unknown (L10) | ${A}`, menu), null, 'a dish the snapshot does not name → null (no guessing)');
  assert.equal(legacyItemsText(`${F} | ${A}`, menu), null, 'a client line after a server line is not a real shape → null');
  assert.equal(legacyItemsText(`${A} | ${B}`, null), null, 'no snapshot → null');
  assert.equal(legacyItemsText('1x A (L1) [x | 1x B (L2)', menu), null, 'unbalanced brackets → null');
  console.log('  ✓ §3 r2: legacy text = the cart re-ordered into menu order, reward lines last; anything not rebuildable → null');
}

// re-tap decision
assert.equal(isContentRetap(null, 1000, 120000), false, 'no record → count');
assert.equal(isContentRetap(undefined, 1000, 120000), false, 'undefined record → count');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 119000, 120000), true, 'within window → re-tap (skip)');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 120000, 120000), false, 'at window edge → count (exclusive)');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 121000, 120000), false, 'after window → count');
assert.equal(isContentRetap({ at: 'x' }, 2000, 120000), false, 'non-finite at → count');
assert.equal(isContentRetap({}, 2000, 120000), false, 'missing at → count');

console.log('order-dedup: OK');
