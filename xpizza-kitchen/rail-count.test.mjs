// Golden test for the all-day make-count rail parser (rail-count.js). Like order-filter.test.mjs, it
// loads the REAL module source as an ESM data: URL (dependency-free) so we test the shipped code, not a
// copy. Run: node rail-count.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./rail-count.js', import.meta.url), 'utf8');
const { railSplit, railCount, enumerateItems } = await import('data:text/javascript,' + encodeURIComponent(src));

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── railSplit: bracket-aware ' | ' split (the whole point vs a naive split) ──
assert.deepEqual(railSplit('1x Margherita | 2x Hawaiana'), ['1x Margherita', '2x Hawaiana']);
ok('splits real top-level " | " between pizzas');

// The bracket bug: a naive itemsText.split(' | ') would wrongly break this ONE pizza into pieces.
assert.deepEqual(
  railSplit('2x Pepperoni [Pizza 1: extra queso | Pizza 2: sin cebolla]'),
  ['2x Pepperoni [Pizza 1: extra queso | Pizza 2: sin cebolla]'],
);
assert.equal('2x Pepperoni [Pizza 1: extra queso | Pizza 2: sin cebolla]'.split(' | ').length, 2,
  'sanity: a naive split WOULD miscount this into 2 entries');
ok('does NOT split on " | " inside an extras bracket (parseItems bug avoided)');

assert.deepEqual(railSplit(''), []);
assert.deepEqual(railSplit('—'), []);
ok('empty / "—" → []');

// ── railCount: make-count roll-up ──
{
  // bracketed extras containing " | " → counted as ONE 2× Pepperoni, not two
  const r = railCount(['2x Pepperoni [Pizza 1: extra queso | Pizza 2: sin cebolla]']);
  assert.deepEqual(r, [{ name: 'Pepperoni', qty: 2 }]);
  ok('bracketed " | " extras → 2× Pepperoni counted once (correct qty)');
}
{
  // per-instance "Pizza N:" + "(todas)"-style shared bracket → still just the pizza qty
  const r = railCount(['3x Margherita [Pizza 1: albahaca | Pizza 2: albahaca | Pizza 3: albahaca]']);
  assert.deepEqual(r, [{ name: 'Margherita', qty: 3 }]);
  ok('per-instance "Pizza N:" / (todas) bracket → 3× Margherita (extras ignored for count)');
}
{
  // price segment stripped, extras stripped
  const r = railCount(['2x Pepperoni (L250.00) [extra queso]']);
  assert.deepEqual(r, [{ name: 'Pepperoni', qty: 2 }]);
  ok('price "(L…)" + extras stripped from the counted name');
}
{
  // aggregation across multiple orders + real multi-pizza order; sorted qty desc then name
  const r = railCount([
    '2x Pepperoni | 1x Margherita',
    '3x Pepperoni [Pizza 1: x | Pizza 2: x | Pizza 3: x]',
    '2x Hawaiana | 1x Margherita',
  ]);
  assert.deepEqual(r, [
    { name: 'Pepperoni', qty: 5 },
    { name: 'Hawaiana', qty: 2 },
    { name: 'Margherita', qty: 2 },
  ]);
  ok('aggregates by name across orders, most-made first (qty desc, name asc tiebreak)');
}
{
  // empties / unparseable lines ignored, never throw
  const r = railCount(['', '—', 'garbage line', '1x Cheese']);
  assert.deepEqual(r, [{ name: 'Cheese', qty: 1 }]);
  ok('empty / "—" / unparseable entries ignored; no throw');
}
assert.deepEqual(railCount([]), []);
assert.deepEqual(railCount(null), []);
ok('no orders → [] (null-safe)');

// ── enumerateItems: per-item checkbox boundaries (Phase 2a) — bracket-aware, never a naive split ──
{
  // two real pizzas → two entries with stable indices
  const e = enumerateItems('1x Margherita | 2x Hawaiana');
  assert.deepEqual(e, [
    { idx: 0, qty: 1, name: 'Margherita', raw: '1x Margherita' },
    { idx: 1, qty: 2, name: 'Hawaiana', raw: '2x Hawaiana' },
  ]);
  ok('enumerateItems: two pizzas → 2 indexed entries with qty/name');
}
{
  // a bracketed " | " must NOT create a phantom checkbox — one pizza, one entry
  const e = enumerateItems('2x Pepperoni [Pizza 1: extra | Pizza 2: sin cebolla]');
  assert.equal(e.length, 1, 'one checkbox for one pizza line (bracket " | " ignored)');
  assert.equal(e[0].qty, 2);
  assert.equal(e[0].name, 'Pepperoni');
  ok('enumerateItems: bracketed " | " extras → single checkbox (no phantom boundary)');
}
assert.deepEqual(enumerateItems(''), []);
assert.deepEqual(enumerateItems('—'), []);
ok('enumerateItems: empty / "—" → [] (no checkboxes)');

console.log(`rail-count: OK (${n} cases)`);
