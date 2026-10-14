'use strict';

// order-dedup — pure content-key + re-tap decision (Layer 2 content-aware phone rate limit).
// Run: node order-dedup.test.js
const assert = require('assert');
const { orderContentKey, orderContentKeyVerbatim, canonicalItemsText, legacyItemsText, legacyOrderOf, legacyKeyByOrder, clientTextOf, contentKeysRecord, isContentRetap } = require('./order-dedup');

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
  assert.equal(legacyItemsText(`${B} | ${A} | ${F}`, menu, ` | ${F}`), `${A} | ${B} | ${F}`, 'the server-appended reward text (PROVENANCE, r5) stays LAST, exactly as appended');
  assert.equal(legacyItemsText(A, menu), A, 'one line → itself (= the verbatim key, as before)');
  assert.equal(legacyItemsText(`1x Unknown (L10) | ${A}`, menu), null, 'a dish the snapshot does not name → null (no guessing)');
  assert.equal(legacyItemsText(`${F} | ${A}`, menu, ` | ${F}`), null, 'a suffix the text does not END with is not a real shape → null');
  assert.equal(legacyItemsText(`${B} | ${A} | ${F}`, menu), null, 'r5: without provenance a reward line is an unknown dish → null (never stripped by pattern)');
  assert.equal(legacyItemsText(`${A} | ${B}`, null), null, 'no snapshot → null');
  assert.equal(legacyItemsText('1x A (L1) [x | 1x B (L2)', menu), null, 'unbalanced brackets → null');
  console.log('  ✓ §3 r2/r5: legacy text = the cart re-ordered into menu order, the server-appended text (provenance) last; anything not rebuildable → null');
}

// re-tap decision
assert.equal(isContentRetap(null, 1000, 120000), false, 'no record → count');
assert.equal(isContentRetap(undefined, 1000, 120000), false, 'undefined record → count');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 119000, 120000), true, 'within window → re-tap (skip)');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 120000, 120000), false, 'at window edge → count (exclusive)');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 121000, 120000), false, 'after window → count');
assert.equal(isContentRetap({ at: 'x' }, 2000, 120000), false, 'non-finite at → count');
assert.equal(isContentRetap({}, 2000, 120000), false, 'missing at → count');

// §3 r4/r5 — the persisted legacy context is the menu-order PERMUTATION of the order's own CLIENT lines; the server's
// appended reward text is known by PROVENANCE (`suffix`), never by a "(Recompensa)" pattern
{
  const M = ['Carnivora', 'Crispy Bacon', 'Margherita', 'Pepperoni'];
  const A = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]', B = '1x Pepperoni (L307)', C = '1x Margherita (L250)';
  const R = ' | 1x Margherita (Recompensa)';
  const a = (t) => ({ phone: '+50499112233', itemsText: t, orderType: 'pickup', scheduledFor: null });
  assert.deepStrictEqual(legacyOrderOf(`${B} | ${C} | ${A}`, M), [2, 1, 0], 'the permutation that writes the order\'s own lines in menu order');
  assert.deepStrictEqual(legacyOrderOf(`${B} | ${A}${R}`, M, R), [1, 0], 'the server suffix (provenance) is cut off exactly and not permuted');
  assert.strictEqual(legacyKeyByOrder(a(`${B} | ${A}${R}`), [1, 0], R), orderContentKeyVerbatim(a(`${A} | ${B}${R}`)), 'rebuilt: client lines in menu order, then exactly the appended text');
  assert.strictEqual(legacyOrderOf(`${B} | ${A}${R}`, M), null, 'WITHOUT provenance a reward line is just an unknown dish → no rebuild (never guessed)');
  assert.strictEqual(legacyOrderOf(`${B} | ${A}`, M, R), null, 'a suffix the text does not end with → no rebuild');
  assert.deepStrictEqual(legacyOrderOf(`${B} | ${A} | 1x Margherita (L250) (Recompensa)`.replace('1x Margherita (L250) (Recompensa)', C + ' (Recompensa)'), M), [1, 2, 0], 'a PAID line that merely ends "(Recompensa)" is a client line (permuted by its dish), not stripped');
  assert.strictEqual(legacyKeyByOrder(a(`${B} | ${A}`), legacyOrderOf(`${B} | ${A}`, M)), orderContentKeyVerbatim(a(legacyItemsText(`${B} | ${A}`, M))), 'the rebuild equals the warm legacy text\'s key');
  for (const bad of [[0], [0, 0], [0, 2], [-1, 0], [0.5, 1], ['1', '0'], null, 'ab', {}, { 0: 1 }, { 0: 1, 2: 0 }]) assert.strictEqual(legacyKeyByOrder(a(`${B} | ${A}`), bad), null, `not a permutation of the order's lines: ${JSON.stringify(bad)}`);
  assert.strictEqual(legacyKeyByOrder(a(`${B} | ${A}`), { 0: 1, 1: 0 }), orderContentKeyVerbatim(a(`${A} | ${B}`)), 'RTDB\'s dense index object is accepted');
  assert.strictEqual(legacyKeyByOrder(a(`${B} [ | ${A}`), [1, 0]), null, 'unbalanced text → no rebuild');
  assert.deepStrictEqual(contentKeysRecord(a(`${B} | ${A}`), { menuNames: M }), { content_key: orderContentKey(a(`${B} | ${A}`)), content_legacy_order: [1, 0] }, 'the persisted record');
  assert.strictEqual(clientTextOf(`${A}${R}`, R), A, 'clientTextOf: exactly the appended text is cut');
  assert.strictEqual(clientTextOf(`${A} | 1x X (L9) (Recompensa)`, null), `${A} | 1x X (L9) (Recompensa)`, 'no provenance → nothing is cut (a paid line ending the marker stays)');
  assert.strictEqual(clientTextOf(A, R), null, 'provenance the text does not end with → null');
  assert.strictEqual(clientTextOf(R, R), null, 'a text that is ONLY the appended part is not a shape the server writes');
}

console.log('order-dedup: OK');
