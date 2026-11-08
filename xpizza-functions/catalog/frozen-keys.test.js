'use strict';
// S1a (PLAN-portal-item-edit r6; design D4c-grill/item-s1/S1a-DESIGN.md, D1 + the two ruling conditions) — FROZEN KEYS.
// A name-keyed item keeps its pricing key when renamed: the server records `frozen_keys[display.id] = key` (server-owned), and
// validation / the build accept an item whose key is either derived from its display (today) or an ACTIVE entry — one whose
// display.id currently carries exactly that key. Inactive entries (item deleted, id reused) are kept inertly. Accepting is
// permanent; MAKING a rename needs item_text_edit. Run: node catalog/frozen-keys.test.js
//   new module catalog/frozen-keys.js: activeFrozenKeys(source) · recordRenames({ draft, live, stored, textEdit }) ·
//     serverOwnedFrozenKeys(draft, stored)
//   compareToActive({ ..., textEdit }) frees name / desc / cat / subcat of an existing item; allocateAdditions takes every entry key
//   (active or not) as taken.
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { validateSource, canonicalize } = require('./source-store');
const { buildSourceCandidate, candidateSource } = require('./candidate-validate');
const AP = require('./add-product');
const FK = require('./frozen-keys');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const RID = 'x_pizza';
const live = () => canonicalize(buildSourceFromCode(RID));
const KEY = 'Carnivora';
const itemOf = (src, key) => src.items.find((i) => i.key === key);
const renamed = (src, key, name) => { const s = clone(src); itemOf(s, key).display.name = name; return s; };
const idOf = (src, key) => itemOf(src, key).display.id;

// ── validation: derived OR an ACTIVE entry ──
{
  const base = live();
  const r = renamed(base, KEY, 'Carnívora Suprema');
  assert.throws(() => validateSource(r, RID), /key does not match its display record/, 'FK-VALIDATE without an entry a rename is refused (today)');
  const withEntry = { ...r, frozen_keys: { [String(idOf(base, KEY))]: KEY } };
  assert.doesNotThrow(() => validateSource(withEntry, RID), 'FK-VALIDATE an active entry accepts the renamed item');
  assert.deepStrictEqual([...FK.activeFrozenKeys(withEntry).entries()], [[String(idOf(base, KEY)), KEY]]);
  // condition 1: an entry whose item is gone is INERT — kept, never a failure
  const gone = clone(withEntry); gone.items = gone.items.filter((i) => i.key !== KEY); gone.structure.item_order = gone.structure.item_order.filter((k) => k !== KEY);
  assert.doesNotThrow(() => validateSource(gone, RID), 'FK-INERT an entry for a deleted item never fails validation');
  assert.strictEqual(FK.activeFrozenKeys(gone).size, 0);
  // condition 2: a REUSED display.id never inherits a frozen key — the entry applies only to (id, key) exactly
  const reused = clone(base);
  const other = reused.items.find((i) => i.key !== KEY && Number.isInteger(i.display.id));
  reused.frozen_keys = { [String(other.display.id)]: KEY };   // an old entry now pointing at an id another item carries
  assert.doesNotThrow(() => validateSource(reused, RID), 'FK-REUSE an entry whose id now carries another key is inert');
  const steal = clone(reused); itemOf(steal, other.key).key = KEY;   // that item claiming the frozen key with its own name
  assert.throws(() => validateSource(steal, RID), /key does not match|duplicate/, 'FK-REUSE a reused id cannot inherit the frozen key');
  // malformed map
  for (const bad of [null, [], 'x', { 2: 3 }, { 2: '' }]) assert.throws(() => validateSource({ ...withEntry, frozen_keys: bad }, RID), /frozen_keys/, `FK-MALFORMED ${JSON.stringify(bad)}`);
  ok('validation: derived OR an active (display.id, key) entry; deleted / reused-id entries are inert; malformed refused');
}

// ── the build keys by the entry and carries the map ──
{
  const base = live();
  const src = { ...renamed(base, KEY, 'Carnívora Suprema'), frozen_keys: { [String(idOf(base, KEY))]: KEY } };
  const { inputs, built } = buildSourceCandidate(RID, src);
  const b = built.items.find((i) => i.display && i.display.id === idOf(base, KEY));
  assert.strictEqual(b.key, KEY, 'FK-BUILD the renamed item keeps its pricing key');
  assert.strictEqual(b.display.name, 'Carnívora Suprema');
  assert.deepStrictEqual(inputs.frozenKeys, src.frozen_keys, 'FK-INPUTS carry the map');
  assert.deepStrictEqual(built.frozen_keys, src.frozen_keys, 'FK-BUILT carries the map');
  assert.deepStrictEqual(candidateSource(RID, { items: built.items, extras: src.extras, structure: built.structure, frozen_keys: built.frozen_keys }).frozen_keys, src.frozen_keys, 'FK-CANDIDATE carries the map');
  const plain = buildSourceCandidate(RID, base);
  assert.strictEqual('frozenKeys' in plain.inputs || 'frozen_keys' in plain.built, false, 'no map ⇒ today\'s shapes');
  ok('the build keys a renamed item by its entry; inputs, built and candidate carry the map; none ⇒ today');
}

// ── the server records a rename (switch ON), never accepts a client-made entry ──
{
  const base = live();
  const draft = renamed(base, KEY, 'Carnívora Suprema');
  const on = FK.recordRenames({ draft, live: base, stored: base, textEdit: true });
  assert.ok(on.ok, 'FK-RECORD switch ON records the rename');
  assert.deepStrictEqual(on.frozen_keys, { [String(idOf(base, KEY))]: KEY });
  const off = FK.recordRenames({ draft, live: base, stored: base, textEdit: false });
  assert.deepStrictEqual(off, { ok: true, frozen_keys: undefined }, 'FK-RECORD switch OFF records nothing (today)');
  // an entry is never removed, even when its item is gone from the draft
  const storedWith = { ...base, frozen_keys: { 99: 'Old Name' } };
  assert.deepStrictEqual(FK.recordRenames({ draft: base, live: base, stored: storedWith, textEdit: true }).frozen_keys, { 99: 'Old Name' }, 'FK-KEEP entries are never removed');
  // server-owned: echo allowed; add / change / drop refused
  const stored = { frozen_keys: { 2: KEY } };
  assert.strictEqual(FK.serverOwnedFrozenKeys({ frozen_keys: { 2: KEY } }, stored).ok, true);
  assert.strictEqual(FK.serverOwnedFrozenKeys({}, stored).ok, true, 'absent in the draft ⇒ the stored map is kept');
  assert.strictEqual(FK.serverOwnedFrozenKeys({ frozen_keys: { 2: KEY, 3: 'Pepperoni' } }, stored).ok, false, 'FK-OWNED adding an entry is refused');
  assert.strictEqual(FK.serverOwnedFrozenKeys({ frozen_keys: { 2: 'Pepperoni' } }, stored).ok, false, 'FK-OWNED changing an entry is refused');
  assert.strictEqual(FK.serverOwnedFrozenKeys({ frozen_keys: {} }, stored).ok, false, 'FK-OWNED dropping an entry is refused');
  ok('the server records a rename only with the switch on, never removes an entry, and owns the map');
}

// ── compareToActive: text fields free only with the switch on ──
{
  const base = live();
  const builtOf = (s) => buildSourceCandidate(RID, s).built;
  const edited = clone(base); const e = itemOf(edited, KEY).display;
  e.name = 'Carnívora Suprema'; e.desc = 'Nueva descripción'; edited.frozen_keys = { [String(e.id)]: KEY };
  const args = (textEdit) => ({ draftBuilt: builtOf(edited), activeBuilt: builtOf(base), draftAuthored: edited, renderedCategories: base.structure.categories.map((c) => c.id), textEdit });
  assert.doesNotThrow(() => AP.compareToActive(args(true)), 'FK-COMPARE switch ON: name / desc of an existing item may change');
  assert.throws(() => AP.compareToActive(args(false)), /can only have its price changed/, 'FK-COMPARE switch OFF: refused exactly as today');
  ok('compareToActive frees name / desc only with item_text_edit');
}

// ── allocation: every entry key is taken (a deleted renamed item's old key is never minted again) ──
{
  const base = live();
  const stored = { ...base, frozen_keys: { 999: 'Pizza Retirada' } };   // an inert entry: its item is gone
  const incoming = clone(stored);
  incoming.items.push({ ref: 'tmp_1', price: 150, display: { name: 'Pizza Retirada', cat: 'individual', desc: '' } });
  incoming.structure.item_order.push('tmp_1');
  assert.throws(() => AP.allocateAdditions({ incoming, stored, activeItems: base.items, keyMode: 'name', hwm: 24, registryHasKey: () => false }),
    /name_previously_used|previously|taken/i, 'FK-TAKEN a frozen key (even inert) is never minted for a new item');
  ok('allocation treats every frozen key as taken');
}

console.log(`\nfrozen-keys: OK (${n})`);
