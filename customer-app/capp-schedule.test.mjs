// Customer app S4 (PLAN-capp-S4 r1 §3.1 / S-4; owner N3 / N4): the picker's generator agrees with the SERVER's validator, both
// ways, on the schedule the app is actually served (the 5f directory fixture — produced by the real handler) at frozen clocks.
// Light: the real xpizza-functions/scheduled-orders.js, no emulator.
// Run: node --test customer-app/capp-schedule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const K = require('./capp-schedule.js');
const SCHED = require(join(ROOT, 'xpizza-functions/scheduled-orders.js'));
const FX = JSON.parse(readFileSync(join(HERE, 'fixtures/s7a2/directory.json'), 'utf8'));
const SERVED = FX.scenarios.complete.body.restaurants.find((r) => r.schedule).schedule;   // what the app receives (P1)
const J = (x) => JSON.parse(JSON.stringify(x));
// an instant from a Honduras wall-clock (UTC−6, no DST)
const hn = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h + 6, mi);
const CLOCKS = [hn(2026, 10, 20, 9, 7), hn(2026, 10, 20, 11, 59), hn(2026, 10, 20, 13, 1), hn(2026, 10, 20, 19, 30), hn(2026, 10, 20, 20, 50),
  hn(2026, 10, 20, 23, 52), hn(2026, 10, 24, 18, 44), hn(2026, 10, 25, 0, 3), hn(2026, 12, 31, 22, 15)];

test('S4 premise: the served schedule is the server\'s own cfg (slot grain, horizon, the per-fulfilment lead floor)', () => {
  const c = SCHED.resolveCfg();
  assert.equal(SERVED.slot_min, c.slotMin); assert.equal(SERVED.horizon_h, c.maxHorizonHours); assert.equal(SERVED.tz_offset_min, -SCHED.TZ_OFFSET_MS / 60000);
  assert.deepEqual(SERVED.lead_min, { pickup: Math.max(c.minLeadMin, c.releaseLeadPickupMin), delivery: Math.max(c.minLeadMin, c.releaseLeadDeliveryMin) });
  assert.equal(K.valid(SERVED), true);
});
test('S-4 agreement, BOTH ways: every offered slot is accepted by validateScheduledFor, and every accepted aligned slot inside the 7 local dates is offered', () => {
  for (const now of CLOCKS) for (const mode of ['delivery', 'pickup']) {
    const got = K.slots(SERVED, now, mode);
    for (const ms of got) assert.deepEqual(SCHED.validateScheduledFor(SERVED.hours, ms, now, mode), { valid: true, reason: null }, `🔴 offered but refused: ${new Date(ms).toISOString()} @ ${new Date(now).toISOString()} ${mode}`);
    const keys = new Set(K.days(SERVED, now, mode).map((d) => d.key));
    const step = SERVED.slot_min * 60000; const want = [];
    for (let ms = Math.ceil(now / step) * step; ms <= now + SERVED.horizon_h * 3600000; ms += step) if (SCHED.validateScheduledFor(SERVED.hours, ms, now, mode).valid && keys.has(K.dayKey(SERVED, ms))) want.push(ms);
    assert.deepEqual(got, want, `🔴 the generator and the validator disagree @ ${new Date(now).toISOString()} ${mode}`);
  }
});
test('S-4 edges: one grid step below the first slot ⇒ below_min_lead; one step past 168 h ⇒ above_max_horizon; unaligned ⇒ not_granular; the closing time is exclusive', () => {
  const now = hn(2026, 10, 20, 13, 1), step = 15 * 60000;
  const first = K.slots(SERVED, now, 'delivery')[0];
  assert.equal(SCHED.validateScheduledFor(SERVED.hours, first - step, now, 'delivery').reason, 'below_min_lead');
  const far = Math.floor((now + 168 * 3600000) / step) * step + step;
  assert.equal(SCHED.validateScheduledFor(SERVED.hours, far, now, 'delivery').reason, 'above_max_horizon');
  assert.equal(SCHED.validateScheduledFor(SERVED.hours, first + 60000, now, 'delivery').reason, 'not_granular');
  // Tuesday closes 19:45 local: 19:30 is the last slot, 19:45 is never offered
  const tue = K.days(SERVED, now, 'delivery')[0];
  assert.equal(K.slotTime(SERVED, tue.slots[tue.slots.length - 1]), '7:30 p.m.'); assert.equal(tue.slots.includes(hn(2026, 10, 20, 19, 45)), false);
});
test('S4 N4 + N3 (owner): exactly 7 local dates (the partial 8th is never offered, though the server would accept it); every slot of a day (no 12-chip cap)', () => {
  const now = hn(2026, 10, 20, 9, 7);
  const ds = K.days(SERVED, now, 'pickup');
  assert.equal(ds.length, 7); assert.deepEqual(ds.map((d) => d.off), [0, 1, 2, 3, 4, 5, 6]); assert.equal(ds[6].key, '2026-10-26', 'the last chip = offset 6');
  // at 1:01 p.m. the rolling 168 h reach the NEXT Tuesday's 12:00…1:00 p.m. — the server accepts them; the app does not offer them
  const later = hn(2026, 10, 20, 13, 1), inEighth = [], step = 15 * 60000;
  for (let ms = hn(2026, 10, 27, 0, 0); ms <= later + 168 * 3600000; ms += step) if (SCHED.validateScheduledFor(SERVED.hours, ms, later, 'pickup').valid) inEighth.push(ms);
  assert.ok(inEighth.length > 0, 'premise: the server accepts slots on the 8th local date');
  assert.ok(inEighth.every((ms) => !K.slots(SERVED, later, 'pickup').includes(ms)), '🔴 the 8th local date is never offered');
  const wed = ds[1]; assert.ok(wed.slots.length > 12, 'premise: more than 12 slots that day'); assert.equal(wed.slots.length, 31, '🔴 all of them (12:00…7:30 p.m. every 15 min)');
});
test('S4 the zone is the SERVED one, never the device\'s: the same days and slots under TZ=UTC and TZ=Asia/Tokyo', () => {
  const run = (tz) => execFileSync(process.execPath, ['-e', `const K=require(${JSON.stringify(join(HERE, 'capp-schedule.js'))});const s=${JSON.stringify(SERVED)};process.stdout.write(JSON.stringify(K.days(s, ${hn(2026, 10, 24, 18, 44)}, 'delivery')))`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  const a = run('UTC'), b = run('Asia/Tokyo');
  assert.equal(a, b, '🔴 the device zone changes nothing'); assert.equal(JSON.parse(a)[0].key, '2026-10-24');
});
test('S4 labels (the prototype\'s): «Hoy» / «Mañana» / «Jue»; the sub «22 oct» or «Sin horarios» (today) / «Cerrado»; «Mañana · 12:00 p.m. – 12:30 p.m.»', () => {
  const now = hn(2026, 10, 20, 20, 50);   // Tuesday after close: today has no slots
  const ds = K.days(SERVED, now, 'delivery');
  assert.deepEqual(ds.slice(0, 3).map((d) => [K.chipDay(d), K.chipSub(d)]), [['Hoy', 'Sin horarios'], ['Mañana', '21 oct'], ['Jue', '22 oct']]);
  const closed = J(SERVED); closed.hours.thu = { open: false };
  assert.equal(K.chipSub(K.days(closed, now, 'delivery')[2]), 'Cerrado');
  assert.equal(K.slotWhen(SERVED, now, ds[1].slots[0]), 'Mañana · 12:00 p.m. – 12:30 p.m.');
  assert.equal(K.slotWhen(SERVED, now, ds[2].slots[0]), 'Jue 22 · 12:00 p.m. – 12:30 p.m.');
});
test('S4 a malformed served schedule offers nothing (the drawn «Sin horarios disponibles»), never a guess', () => {
  for (const bad of [null, {}, { ...SERVED, slot_min: 0 }, { ...SERVED, lead_min: null }, { ...SERVED, hours: null }]) assert.deepEqual(K.slots(bad, CLOCKS[0], 'delivery'), []);
  const inv = J(SERVED); inv.hours.wed = { open: true, start: '20:00', end: '12:00' };   // inverted ⇒ closed, as the server
  assert.equal(K.days(inv, hn(2026, 10, 20, 9, 7), 'pickup')[1].slots.length, 0);
});
test('no restaurant literal in the schedule module', () => {
  assert.equal(readFileSync(join(HERE, 'capp-schedule.js'), 'utf8').match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});
