// PLAN-menu-ordering §3 — the shared serialization-order model, as a unit. Run: node --test xpizza-orders/form-serial-order.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSerialOrder, serialItemMatches } = require('./form-serial-order.js');

const line = (key, name, extra = {}) => ({ key: String(key), record: { name, ...extra }, added: { name } });
const keys = (ls) => ls.map((l) => l.key);

test('no pin → the lines exactly as given (insertion order); the input is never mutated', () => {
  const s = createSerialOrder();
  const ls = [line('b', 'B'), line('a', 'A')];
  assert.deepStrictEqual(keys(s.order(ls)), ['b', 'a']);
  assert.notStrictEqual(s.order(ls), ls, 'a copy');
  assert.strictEqual(s.current(), null);
});

test('mint pins what it serializes; pinned keys keep their place, others follow in insertion order', () => {
  const s = createSerialOrder();
  s.mint([line('a', 'A'), line('b', 'B')]);
  assert.deepStrictEqual(s.current(), ['a', 'b']);
  assert.deepStrictEqual(keys(s.order([line('b', 'B'), line('a', 'A')])), ['a', 'b'], 'remove + re-add keeps [a, b]');
  assert.deepStrictEqual(keys(s.order([line('c', 'C'), line('b', 'B'), line('d', 'D'), line('a', 'A')])), ['a', 'b', 'c', 'd'], 'unpinned c, d after, in insertion order');
  assert.deepStrictEqual(keys(s.order([line('b', 'B')])), ['b'], 'a removed pinned line is simply absent');
});

test('mint through an existing pin is a fixed point (quote and submit cannot disagree)', () => {
  const s = createSerialOrder();
  s.mint([line('a', 'A'), line('b', 'B')]);
  const now = [line('c', 'C'), line('b', 'B'), line('a', 'A')];
  const before = keys(s.order(now));
  s.mint(now);
  assert.deepStrictEqual(keys(s.order(now)), before);
  assert.deepStrictEqual(s.current(), ['a', 'b', 'c']);
});

test('resume pins the stashed payload order, matched on the fields it carries; clear releases it', () => {
  const s = createSerialOrder();
  const ls = [line('19', 'Margherita NY', { dish_id: 'd19' }), line('2', 'Carnivora', { dish_id: 'd2' })];
  assert.ok(s.resume(ls, [{ name: 'Carnivora', dish_id: 'd2' }, { name: 'Margherita NY' }]));
  assert.deepStrictEqual(keys(s.order(ls)), ['2', '19']);
  s.clear();
  assert.strictEqual(s.current(), null);
  assert.deepStrictEqual(keys(s.order(ls)), ['19', '2']);
  assert.strictEqual(s.resume(ls, null), false, 'no payload → no pin');
  assert.strictEqual(s.current(), null);
});

test('matching: name (live or as added) AND every identity field present; la_musa ids match the key', () => {
  const l = { key: 'dimsum_01', record: { id: 'dimsum_01', name: 'Wonton', dish_id: 'D1' }, added: { name: 'Wonton viejo' } };
  assert.ok(serialItemMatches(l, { id: 'dimsum_01', name: 'Wonton', dish_id: 'D1' }));
  assert.ok(serialItemMatches(l, { name: 'Wonton viejo' }), 'the name it was added as');
  assert.ok(!serialItemMatches(l, { id: 'dimsum_02', name: 'Wonton' }), 'a different id');
  assert.ok(!serialItemMatches(l, { name: 'Wonton', dish_id: 'D9' }), 'a different dish_id');
  assert.ok(!serialItemMatches(l, { name: 'Otro' }), 'a different name');
  assert.ok(!serialItemMatches(l, { id: 'dimsum_01' }), 'no name → no match');
  assert.ok(!serialItemMatches(l, null) && !serialItemMatches(null, { name: 'Wonton' }));
});

test('resume: an unmatched stashed item is skipped; each line is used once', () => {
  const s = createSerialOrder();
  const ls = [line('a', 'A'), line('b', 'B')];
  s.resume(ls, [{ name: 'Gone' }, { name: 'B' }, { name: 'B' }, { name: 'A' }]);
  assert.deepStrictEqual(s.current(), ['b', 'a']);
});
