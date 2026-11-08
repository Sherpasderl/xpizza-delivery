'use strict';
// S0 — key_mode is a SOURCE field (ruling R2; relay Task 4): written at seed, validated against the stored keys, carried
// through the build into the publish input, and server-owned on every draft write.
// Run: node catalog/key-mode-source.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { validateSource, sourceToBuildInputs } = require('./source-store');
const { serverOwnedKeyMode } = require('./key-mode');
const { buildSourceCandidate, candidateSource } = require('./candidate-validate');
const { buildCatalogV2 } = require('./form-menu-source');
const MP = require('../menu-pricing');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const without = (src) => { const s = clone(src); delete s.key_mode; return s; };
const SEEDED_PROFILE_MODE = { x_pizza: 'name', la_musa: 'id' };   // tools/seed-catalog.js — the profile's pricing_key_mode

for (const rid of ['x_pizza', 'la_musa']) {
  const seeded = buildSourceFromCode(rid);
  assert.strictEqual(seeded.key_mode, MP.defaultKeyMode(rid), `${rid}: the seed writes the default mode`);
  assert.strictEqual(seeded.key_mode, SEEDED_PROFILE_MODE[rid], `${rid}: which is the profile's seeded pricing_key_mode`);

  // validate THROUGH the mode: the right one passes, the other one contradicts every stored key, a malformed one is refused
  assert.doesNotThrow(() => validateSource(seeded, rid));
  assert.doesNotThrow(() => validateSource(without(seeded), rid), 'a legacy source with no key_mode validates through the default');
  const other = seeded.key_mode === 'id' ? 'name' : 'id';
  assert.throws(() => validateSource({ ...clone(seeded), key_mode: other }, rid), /key does not match its display record/, `${rid}: a contradicting mode fails`);
  for (const bad of ['ID', '', 1, null, ['id']]) {
    assert.throws(() => validateSource({ ...clone(seeded), key_mode: bad }, rid), /source_malformed: .*key_mode/, `${rid}: key_mode ${JSON.stringify(bad)} is refused`);
  }

  // BUILD ↔ PUBLISH parity: writing the default changes nothing the build produces, and the build carries the mode
  const a = buildSourceCandidate(rid, seeded);
  const b = buildSourceCandidate(rid, without(seeded));
  assert.strictEqual(a.inputs.keyMode, seeded.key_mode);
  assert.strictEqual('keyMode' in b.inputs, false, 'no mode ⇒ the build inputs are today\'s shape');
  assert.strictEqual(a.built.key_mode, seeded.key_mode);
  assert.strictEqual('key_mode' in b.built, false, 'no mode ⇒ the built candidate is today\'s shape');
  const { key_mode: _km, ...aRest } = a.built;   // eslint-disable-line no-unused-vars
  assert.deepStrictEqual(aRest, b.built, `${rid}: items / extras / structure are byte-identical with and without the written default`);
  assert.deepStrictEqual(JSON.stringify(sourceToBuildInputs(without(seeded))), JSON.stringify(b.inputs));
  // the candidate a publish validates carries it too
  assert.strictEqual(candidateSource(rid, { items: a.built.items, extras: seeded.extras, structure: a.built.structure, key_mode: a.built.key_mode }).key_mode, seeded.key_mode);
  assert.strictEqual('key_mode' in candidateSource(rid, { items: b.built.items, extras: seeded.extras, structure: b.built.structure }), false);
  ok(`${rid}: seed writes the profile's mode; validation derives through it (contradicting / malformed refused); build ↔ publish byte-identical`);
}

// a config-only third restaurant keyed by id: validates and builds with NO code change, and its keys follow the mode
{
  const src = clone(buildSourceFromCode('la_musa'));
  src.restaurant_id = 'tb_merch_3';
  src.key_mode = 'id';
  // (la_musa's data relabelled: the per-restaurant RENDERER contract judges it later and is not S0's concern, so the
  // assertion is on the KEY check alone — with its mode every key passes; without it the first key is a mismatch)
  const reason = (s) => { try { validateSource(s, 'tb_merch_3'); return 'valid'; } catch (e) { return String(e.message); } };
  assert.ok(!/key does not match|key_mode/.test(reason(src)), `id-keyed third restaurant passes the key check by its own mode (${reason(src).slice(0, 120)})`);
  assert.match(reason(without(src)), /key does not match its display record/, 'without its mode it is judged by the default (name) and fails on the key');
  const built = buildCatalogV2('tb_merch_3', { ...(({ formData, priceTable, extras }) => ({ formData, priceTable, extrasTable: extras }))(sourceToBuildInputs(src)), keyMode: 'id' });
  assert.deepStrictEqual(built.items.map((i) => i.key).sort(), src.items.map((i) => i.key).sort());
  assert.strictEqual(built.key_mode, 'id');
  ok('a config-only id-keyed restaurant validates and builds by its mode alone');
}

// server-owned on every draft write: a client may echo the stored mode, never change, add or drop one
{
  assert.deepStrictEqual(serverOwnedKeyMode({ key_mode: 'name' }, { key_mode: 'name' }), { ok: true, key_mode: 'name' });
  assert.deepStrictEqual(serverOwnedKeyMode({}, { key_mode: 'id' }), { ok: true, key_mode: 'id' }, 'absent in the draft ⇒ the stored one is kept');
  assert.deepStrictEqual(serverOwnedKeyMode({}, {}), { ok: true, key_mode: undefined });
  assert.deepStrictEqual(serverOwnedKeyMode({ key_mode: null }, { key_mode: 'id' }), { ok: true, key_mode: 'id' }, 'a null in the draft is absent');
  assert.strictEqual(serverOwnedKeyMode({ key_mode: 'id' }, { key_mode: 'name' }).ok, false, 'a change is refused');
  assert.strictEqual(serverOwnedKeyMode({ key_mode: 'id' }, {}).ok, false, 'adding one through a draft is refused');
  ok('the draft write keeps the stored key_mode: echo allowed, change / add refused, absent ⇒ kept');
}

console.log(`\nkey-mode-source: OK (${n})`);
