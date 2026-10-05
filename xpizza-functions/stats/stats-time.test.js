'use strict';
// Merchant STATS — business time. Run: node stats/stats-time.test.js
const assert = require('assert');
const T = require('./stats-time');
const SCHED = require('../scheduled-orders');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// 1. Honduras fixed UTC−6, same offset as scheduled-orders.js.
assert.strictEqual(T.TZ_OFFSET_MS, 6 * 3600000);
assert.strictEqual(T.TZ_OFFSET_MS, SCHED.TZ_OFFSET_MS);
ok('pinned to UTC−6, shared with scheduled-orders.js');

// 2. Half-open business days [00:00, 24:00) local.
{
  const start = T.dayStartMs('2026-10-05');
  assert.strictEqual(new Date(start).toISOString(), '2026-10-05T06:00:00.000Z');
  assert.strictEqual(T.dateOf(start), '2026-10-05');
  assert.strictEqual(T.dateOf(start - 1), '2026-10-04', '23:59:59.999 belongs to the previous day');
  assert.strictEqual(T.dateOf(T.dayEndMs('2026-10-05')), '2026-10-06', 'the end is exclusive');
  assert.strictEqual(T.dateOf(T.dayEndMs('2026-10-05') - 1), '2026-10-05');
  assert.strictEqual(T.hourOf(start), 0); assert.strictEqual(T.hourOf(T.dayEndMs('2026-10-05') - 1), 23);
  ok('half-open day boundaries and local hours');
}

// 3. Service time = scheduled_for, else created_at.
{
  assert.strictEqual(T.serviceMs({ created_at: 5, scheduled_for: 9 }), 9);
  assert.strictEqual(T.serviceMs({ created_at: 5 }), 5);
  assert.strictEqual(T.serviceMs({ created_at: 5, scheduled_for: '' }), 5);
  assert.strictEqual(T.serviceMs({ created_at: 5, scheduled_for: null }), 5);
  assert.strictEqual(T.serviceMs({}), null);
  ok('one effective service timestamp');
}

// 4. 🔴 READ PADDING IS TIED TO THE SCHEDULING HORIZON (scheduled-orders.js:34).
{
  const horizonMs = SCHED.DEFAULT_CFG.maxHorizonHours * 3600000;
  assert(T.READ_PAD_MS >= horizonMs + T.DAY_MS, `pad ${T.READ_PAD_MS} must cover the ${SCHED.DEFAULT_CFG.maxHorizonHours} h horizon + a day boundary`);
  assert.strictEqual(T.READ_PAD_DAYS, 8, 'the plan\'s 8 days at today\'s 168 h horizon');
  // An order created at the very start of the read window can be served on the earliest target day.
  const target = '2026-10-10';
  const createdEarliest = T.dayStartMs(target) - horizonMs;   // placed 168 h before the first instant of the target day
  assert(createdEarliest >= T.dayStartMs(target) - T.READ_PAD_MS);
  ok('read padding covers the 168 h scheduling horizon (asserted, not assumed)');
}

// 5. Calendar helpers: Monday weeks, month keys, invalid dates rejected.
{
  assert.strictEqual(T.weekdayOf('2026-10-05'), 0, '2026-10-05 is a Monday');
  assert.strictEqual(T.weekdayOf('2026-10-11'), 6);
  assert.strictEqual(T.weekStartOf('2026-10-11'), '2026-10-05');
  assert.strictEqual(T.weekStartOf('2026-10-05'), '2026-10-05');
  assert.strictEqual(T.monthOf('2026-10-11'), '2026-10');
  assert.deepStrictEqual(T.datesBetween('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.strictEqual(T.daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.strictEqual(T.isDate('2026-02-31'), false);
  assert.strictEqual(T.isDate('2026-2-3'), false);
  assert.throws(() => T.dayStartMs('nope'));
  ok('Monday-start weeks, months, date validation');
}
console.log(`\nstats-time: ${n} cells passed`);
