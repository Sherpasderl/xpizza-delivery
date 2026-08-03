import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotLabel, groupScheduledBySlot } from './slot-format.js';

// Tegucigalpa is UTC-6, no DST. 2026-08-03 17:00 local = 2026-08-03T23:00:00Z.
const TODAY_5PM = Date.parse('2026-08-03T23:00:00Z');
const TODAY_NOON = Date.parse('2026-08-03T18:00:00Z');
const TMRW_1230 = Date.parse('2026-08-04T18:30:00Z');
const NOW = Date.parse('2026-08-03T20:00:00Z'); // 2pm local same day

test('slotLabel prefixes Hoy / Mañana', () => {
  assert.match(slotLabel(TODAY_5PM, NOW), /^Hoy .*5:00/);
  assert.match(slotLabel(TMRW_1230, NOW), /^Mañana .*12:30/);
});

test('groupScheduledBySlot buckets by slot and sorts ascending', () => {
  const scheduled = {
    a: { scheduled_for: TMRW_1230, order_type:'delivery', restaurant_id:'x_pizza' },
    b: { scheduled_for: TODAY_5PM, order_type:'pickup', restaurant_id:'la_musa' },
    c: { scheduled_for: TODAY_5PM, order_type:'delivery', restaurant_id:'x_pizza' },
  };
  const groups = groupScheduledBySlot(scheduled, NOW);
  assert.equal(groups.length, 2);            // two distinct slots
  assert.equal(groups[0].orders.length, 2);  // the earlier slot (Hoy 5pm) has c+b
  assert.match(groups[0].label, /Hoy/);      // earliest first
  assert.match(groups[1].label, /Mañana/);
});
