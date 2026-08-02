// Node test for the pure KDS order-filter module. order-filter.js is browser ESM (.js, no
// package.json), so we load its REAL source as an ESM data: URL (it's dependency-free) — testing the
// actual module, not a copy. Run: node order-filter.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./order-filter.js', import.meta.url), 'utf8');
const { filterLiveOrders, kdsRestaurantFromHost, filterScheduledOrders, SCHEDULED_ORDER_STATUSES } =
  await import('data:text/javascript,' + encodeURIComponent(src));

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── kdsRestaurantFromHost (#6) ──
assert.equal(kdsRestaurantFromHost('lamusakitchendisplay.netlify.app'), 'la_musa'); ok('exact La Musa host → la_musa');
assert.equal(kdsRestaurantFromHost('deploy-preview-7--lamusakitchendisplay.netlify.app'), 'la_musa'); ok('Netlify preview host → la_musa');
assert.equal(kdsRestaurantFromHost('xpizzakitchen.netlify.app'), 'x_pizza'); ok('X. Pizza host → x_pizza');
assert.equal(kdsRestaurantFromHost('xlamusakitchendisplay.netlify.app'), 'x_pizza'); ok('same-suffix decoy → x_pizza (no false-positive)');
assert.equal(kdsRestaurantFromHost(''), 'x_pizza'); ok('empty host → x_pizza (fail-safe)');

// ── filterLiveOrders — mixed snapshot under both pins ──
const snapshot = {
  a: { status: 'new', restaurant_id: 'x_pizza' },
  b: { status: 'preparing' },                  // absent restaurant_id (legacy)
  c: { status: 'ready', restaurant_id: '' },   // empty-string legacy
  d: { status: 'new', restaurant_id: 'la_musa' },
  e: { status: 'pending_payment', restaurant_id: 'x_pizza' },
};
assert.deepEqual(Object.keys(filterLiveOrders(snapshot, 'x_pizza')).sort(), ['a', 'b', 'c']); ok('x_pizza keeps x_pizza/absent/empty-string, drops la_musa + pending');
assert.deepEqual(Object.keys(filterLiveOrders(snapshot, 'la_musa')).sort(), ['d']);            ok('la_musa keeps only la_musa');
assert.deepEqual(Object.keys(filterLiveOrders(snapshot, 'bogus')).sort(), ['a', 'b', 'c']);    ok('unknown selector → x_pizza (fail-safe)');

// ── GOLDEN no-op (#4): a no-la_musa snapshot under x_pizza == snapshot minus pending, same keys/order/refs ──
{
  const today = {
    o1: { status: 'new', restaurant_id: 'x_pizza' },
    o2: { status: 'preparing' },
    o3: { status: 'pending_payment', restaurant_id: 'x_pizza' }, // dropped (non-live)
    o4: { status: 'ready', restaurant_id: '' },
  };
  const out = filterLiveOrders(today, 'x_pizza');
  const expectedKeys = Object.keys(today).filter((k) => today[k].status !== 'pending_payment'); // today's live set, in order
  assert.deepEqual(Object.keys(out), expectedKeys);                       // same keys, same order
  for (const k of expectedKeys) assert.strictEqual(out[k], today[k]);     // same value REFERENCES (no clone)
  ok("GOLDEN no-op: x_pizza returns exactly today's live set (keys, order, refs)");
}

// ── null passthrough preserved (callback contract unchanged) ──
{
  const out = filterLiveOrders({ x: null, y: { status: 'new', restaurant_id: 'x_pizza' } }, 'x_pizza');
  assert.deepEqual(Object.keys(out).sort(), ['x', 'y']);
  assert.strictEqual(out.x, null);
  ok('null order value passes through (contract preserved)');
}

// ── SDK re-export (#7): the SDK can't be node-loaded (CDN firebase imports) — statically assert it
//    import-then-exports the single source, so XPD.filterLiveOrders is this same function. ──
{
  const sdk = readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
  assert.ok(/import\s*\{[^}]*\bfilterLiveOrders\b[^}]*\}\s*from\s*['"]\.\/order-filter\.js['"]/.test(sdk), 'SDK must import filterLiveOrders from order-filter.js');
  assert.ok(/export\s*\{[^}]*\bfilterLiveOrders\b[^}]*\}/.test(sdk), 'SDK must re-export filterLiveOrders');
  ok('SDK import-then-exports the single source (static check)');
}

// ── Scheduled Orders: scheduled + releasing are NON-LIVE → filtered from every /orders reader ──
{
  const snap = {
    live1: { status: 'new', restaurant_id: 'x_pizza' },
    sched: { status: 'scheduled', restaurant_id: 'x_pizza' },
    rel: { status: 'releasing', restaurant_id: 'x_pizza' },
    pend: { status: 'pending_payment', restaurant_id: 'x_pizza' },
  };
  assert.deepEqual(Object.keys(filterLiveOrders(snap, 'x_pizza')).sort(), ['live1']);
  ok('scheduled + releasing (+ pending_payment) filtered out; only live orders remain');
}

// ── filterScheduledOrders: held/scheduled orders only, per restaurant (Programados view) ──
{
  const orders = {
    a: { status: 'scheduled',       restaurant_id: 'x_pizza' },
    b: { status: 'releasing',       restaurant_id: 'x_pizza' },
    c: { status: 'new',             restaurant_id: 'x_pizza' },   // live → excluded
    d: { status: 'pending_payment', restaurant_id: 'x_pizza' },   // unpaid → excluded
    e: { status: 'scheduled',       restaurant_id: 'la_musa' },   // wrong restaurant for x_pizza
  };
  assert.deepEqual(Object.keys(filterScheduledOrders(orders, 'x_pizza')).sort(), ['a', 'b']);
  ok('filterScheduledOrders: x_pizza → scheduled+releasing only, excludes live/unpaid/la_musa');

  assert.deepEqual(Object.keys(filterScheduledOrders(orders, 'la_musa')), ['e']);
  ok('filterScheduledOrders: la_musa → strict own-restaurant scheduled only');

  // unpaid is NEVER prep-worthy even for the right restaurant
  assert.deepEqual(filterScheduledOrders({ x: { status: 'pending_payment', restaurant_id: 'x_pizza' } }, 'x_pizza'), {});
  ok('filterScheduledOrders: pending_payment excluded (unpaid never shown)');

  assert.deepEqual(filterScheduledOrders({}, 'x_pizza'), {});
  assert.deepEqual(filterScheduledOrders(null, 'x_pizza'), {});
  ok('filterScheduledOrders: empty/null → {} (safe)');

  // SCHEDULED_ORDER_STATUSES is the two held statuses; NEVER pending_payment
  assert.ok(SCHEDULED_ORDER_STATUSES.has('scheduled') && SCHEDULED_ORDER_STATUSES.has('releasing'));
  assert.ok(!SCHEDULED_ORDER_STATUSES.has('pending_payment'));
  ok('SCHEDULED_ORDER_STATUSES = {scheduled, releasing} (excl. pending_payment)');
}

console.log(`order-filter: OK (${n} cases)`);
