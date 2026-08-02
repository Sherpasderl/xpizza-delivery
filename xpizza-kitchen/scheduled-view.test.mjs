// Golden for scheduled-view.js. Loads the REAL module source as an ESM data: URL (with rail-count.js
// resolvable via a relative import baked into a small shim) so we test shipped code. Run: node scheduled-view.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// import the module directly from disk (relative import of ./rail-count.js resolves on the filesystem)
const mod = await import(pathToFileURL(new URL('./scheduled-view.js', import.meta.url).pathname).href);
const { groupScheduledByDay } = mod;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Tegucigalpa is UTC-6. Build timestamps as UTC = local + 6h.
const L = (y, m, d, hh, mm) => Date.UTC(y, m, d, hh + 6, mm);   // local Tegucigalpa → epoch ms
const now = L(2026, 7, 1, 6, 0);   // Aug 1 2026, 6:00 AM local

{
  const orders = {
    o1: { scheduled_for: L(2026, 7, 1, 19, 0), items_text: '2x Pepperoni', restaurant_id: 'x_pizza' },   // Hoy 7pm
    o2: { scheduled_for: L(2026, 7, 1, 18, 30), items_text: '1x Margherita | 1x Hongos', restaurant_id: 'x_pizza' }, // Hoy 6:30pm
    o3: { scheduled_for: L(2026, 7, 2, 12, 30), items_text: '1x Hawaiana', restaurant_id: 'x_pizza' },   // Mañana
  };
  const g = groupScheduledByDay(orders, now);
  assert.equal(g.length, 2, 'two day groups');
  assert.equal(g[0].label, 'Hoy'); assert.equal(g[1].label, 'Mañana');
  // Hoy sorted soonest-first → o2 (6:30) before o1 (7:00)
  assert.deepEqual(g[0].orders.map(o => o.id), ['o2', 'o1']);
  assert.equal(g[0].count, 2); assert.equal(g[0].pizzas, 4);   // 1+1 (o2) + 2 (o1)
  assert.deepEqual(g[0].makeCount, [
    { name: 'Pepperoni', qty: 2 }, { name: 'Hongos', qty: 1 }, { name: 'Margherita', qty: 1 },
  ]);
  ok('groups by day, Hoy/Mañana labels, soonest-first, per-day make-count via railCount');
}
{
  // midnight boundary: 11:30 PM local = Hoy; 12:30 AM local next day = Mañana
  const orders = {
    late:  { scheduled_for: L(2026, 7, 1, 23, 30), items_text: '1x Diávola', restaurant_id: 'x_pizza' },
    early: { scheduled_for: L(2026, 7, 2, 0, 30),  items_text: '1x Margherita', restaurant_id: 'x_pizza' },
  };
  const g = groupScheduledByDay(orders, now);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].orders.map(o => o.id), ['late']);   // Hoy
  assert.deepEqual(g[1].orders.map(o => o.id), ['early']);  // Mañana
  ok('midnight boundary buckets into the correct local day (Tegucigalpa)');
}
{
  // invalid/missing scheduled_for → sorts last, own bucket, stable id tie-break
  const orders = {
    b: { scheduled_for: NaN, items_text: '1x Margherita', restaurant_id: 'x_pizza' },
    a: { scheduled_for: undefined, items_text: '1x Pepperoni', restaurant_id: 'x_pizza' },
    ok1: { scheduled_for: L(2026, 7, 3, 13, 0), items_text: '1x Hawaiana', restaurant_id: 'x_pizza' },
  };
  const g = groupScheduledByDay(orders, now);
  assert.equal(g[g.length - 1].label, 'Sin fecha');
  assert.deepEqual(g[g.length - 1].orders.map(o => o.id), ['a', 'b']);   // tie-break by id
  ok('invalid scheduled_for → "Sin fecha" bucket last, id tie-break');
}
assert.deepEqual(groupScheduledByDay({}, now), []);
assert.deepEqual(groupScheduledByDay(null, now), []);
ok('empty/null → []');

console.log(`scheduled-view: OK (${n} cases)`);
