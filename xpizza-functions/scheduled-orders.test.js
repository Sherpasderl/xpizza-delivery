'use strict';

// Golden tests for the pure Scheduled-Orders core (scheduled-orders.js). Run: node scheduled-orders.test.js
// Server-authoritative hours/slot/validation (UTC−6) + the release-sweep decision + SLA/overdue + the
// slot-bound fingerprint input. A wrong slot validation accepts an order for a CLOSED kitchen; a wrong
// release decision double-releases or strands paid money. See SCHEDULED_ORDERS_PLAN.md rev-3.
const assert = require('assert');
const S = require('./scheduled-orders');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MIN = 60000, HOUR = 3600000;
// local (UTC−6) wall-clock → UTC ms
const L = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h + 6, mi);
// La-Musa-shaped hours: Mon closed; Tue–Thu 17:00–20:45; Fri/Sat 17:00–21:45; Sun 12:00–20:45
const HOURS = {
  sun: { open: true, start: '12:00', end: '20:45' }, mon: { open: false, start: '00:00', end: '00:00' },
  tue: { open: true, start: '17:00', end: '20:45' }, wed: { open: true, start: '17:00', end: '20:45' },
  thu: { open: true, start: '17:00', end: '20:45' }, fri: { open: true, start: '17:00', end: '21:45' },
  sat: { open: true, start: '17:00', end: '21:45' },
};
const NOW = L(2026, 0, 6, 17, 0); // Tue Jan 6 2026, 17:00 local (open)
const CFG = S.resolveCfg();

// ── isOpenAt (UTC−6) ──
assert.strictEqual(S.isOpenAt(HOURS, L(2026, 0, 6, 17, 0)), true); ok('isOpenAt: Tue 17:00 → open');
assert.strictEqual(S.isOpenAt(HOURS, L(2026, 0, 6, 16, 59)), false); ok('isOpenAt: Tue 16:59 → closed (before open)');
assert.strictEqual(S.isOpenAt(HOURS, L(2026, 0, 6, 20, 45)), false); ok('isOpenAt: Tue 20:45 → closed (end exclusive)');
assert.strictEqual(S.isOpenAt(HOURS, L(2026, 0, 5, 19, 0)), false); ok('isOpenAt: Mon → closed (open:false)');
assert.strictEqual(S.isOpenAt(HOURS, L(2026, 0, 4, 15, 0)), true); ok('isOpenAt: Sun 15:00 → open (Sun window)');

// ── validateScheduledFor ──
const vf = (ms, ot = 'pickup') => S.validateScheduledFor(HOURS, ms, NOW, ot, CFG);
assert.deepStrictEqual(vf(L(2026, 0, 6, 18, 30)), { valid: true, reason: null }); ok('validate: Tue 18:30 (90m ahead, open, aligned) → valid');
assert.strictEqual(vf(L(2026, 0, 6, 16, 0)).reason, 'in_past'); ok('validate: past slot → in_past');
assert.strictEqual(vf(L(2026, 0, 6, 18, 7)).reason, 'not_granular'); ok('validate: :07 → not_granular');
assert.strictEqual(vf(L(2026, 0, 6, 17, 30)).reason, 'below_min_lead'); ok('validate: 30m ahead (<60 lead) → below_min_lead');
assert.strictEqual(vf(L(2026, 0, 14, 18, 0)).reason, 'above_max_horizon'); ok('validate: 8 days ahead → above_max_horizon');
assert.strictEqual(vf(L(2026, 0, 6, 21, 0)).reason, 'closed_at_slot'); ok('validate: 21:00 (past close) → closed_at_slot');
assert.strictEqual(vf(L(2026, 0, 12, 19, 0)).reason, 'closed_at_slot'); ok('validate: next Mon 19:00 → closed_at_slot (closed day)');
assert.strictEqual(vf('x').reason, 'not_a_time'); ok('validate: non-numeric → not_a_time');

// ── generateSlots — only future, in-lead, aligned, within open windows ──
{
  const slots = S.generateSlots(HOURS, NOW, 'pickup', CFG);
  assert.ok(slots.length > 0 && slots.length <= CFG.maxSlots); ok('slots: bounded, non-empty');
  assert.strictEqual(slots[0], L(2026, 0, 6, 18, 0)); ok('slots: first = Tue 18:00 (now 17:00 + 60m lead, aligned up)');
  for (const s of slots) { assert.ok(s >= NOW + CFG.minLeadMin * MIN); assert.strictEqual(s % (CFG.slotMin * MIN), 0); assert.ok(S.isOpenAt(HOURS, s)); }
  ok('slots: every slot ≥ now+lead, granular, and within an open window');
  assert.ok(!slots.includes(L(2026, 0, 12, 19, 0))); ok('slots: skips closed Monday');
}

// ── releaseAtFor ──
assert.strictEqual(S.releaseAtFor(L(2026, 0, 6, 18, 30), 'pickup', CFG), L(2026, 0, 6, 18, 30) - CFG.releaseLeadPickupMin * MIN); ok('releaseAtFor(pickup): scheduled_for − pickup lead (30m)');
assert.strictEqual(S.releaseAtFor(L(2026, 0, 6, 18, 30), 'delivery', CFG), L(2026, 0, 6, 18, 30) - CFG.releaseLeadDeliveryMin * MIN); ok('releaseAtFor(delivery): scheduled_for − delivery lead (60m, prep+drive)');

// ── releaseDecision — the sweep's per-order action ──
const rd = (o) => S.releaseDecision(o, NOW, CFG);
assert.strictEqual(rd({ status: 'scheduled', release_at: NOW - 1 }).action, 'claim'); ok('release: scheduled + due → claim');
assert.strictEqual(rd({ status: 'scheduled', release_at: NOW + HOUR }).action, 'skip'); ok('release: scheduled + not due → skip');
assert.strictEqual(rd({ status: 'scheduled', release_at: NOW - 1, scheduled_blocked: true }).reason, 'blocked'); ok('release: blocked → skip:blocked (no re-alert loop, R2-#1)');
assert.strictEqual(rd({ status: 'scheduled', release_at: NOW - 1, resolving_action: 'cancel' }).reason, 'cancel_in_progress'); ok('release: cancel in progress → skip');
assert.strictEqual(rd({ status: 'releasing', releasing_since: NOW - 10 * MIN }).action, 'recover_stale'); ok('release: stale releasing (>5m) → recover_stale');
assert.strictEqual(rd({ status: 'releasing', releasing_since: NOW - 30000 }).action, 'skip'); ok('release: fresh releasing → skip (in-flight)');
assert.strictEqual(rd({ status: 'new' }).reason, 'not_scheduled'); ok('release: live order → skip:not_scheduled');

// ── releaseTimeValid — the §D closed-at-release re-validation (no lead/horizon; slot open + not missed) ──
const rtv = (o) => S.releaseTimeValid(HOURS, o, NOW, CFG);
assert.strictEqual(rtv({ scheduled_for: L(2026, 0, 6, 18, 0) }).valid, true); ok('releaseTimeValid: open, imminent slot → valid (lead NOT re-checked at release)');
assert.strictEqual(rtv({ scheduled_for: L(2026, 0, 6, 21, 0) }).reason, 'closed_at_slot'); ok('releaseTimeValid: slot outside open hours → closed_at_slot (block)');
assert.strictEqual(rtv({ scheduled_for: L(2026, 0, 12, 19, 0) }).reason, 'closed_at_slot'); ok('releaseTimeValid: future slot on a closed day (Mon) → closed_at_slot');
assert.strictEqual(rtv({ scheduled_for: NOW - 2 * HOUR }).reason, 'missed_window'); ok('releaseTimeValid: slot far in past → missed_window');
assert.strictEqual(rtv({}).reason, 'no_slot'); ok('releaseTimeValid: no scheduled_for → no_slot');

// ── scheduledOverdue — reconcile SLA (paid-scheduled valid till release_at, then alert) ──
const ov = (o) => S.scheduledOverdue(o, NOW, CFG);
assert.strictEqual(ov({ status: 'scheduled', release_at: NOW + HOUR, scheduled_for: NOW + 2 * HOUR }).overdue, false); ok('overdue: scheduled valid before release_at → not overdue');
assert.strictEqual(ov({ status: 'scheduled', release_at: NOW - 2 * HOUR, scheduled_for: NOW + HOUR }).kind, 'scheduled_release_overdue'); ok('overdue: past release_at+SLA still scheduled → scheduled_release_overdue');
assert.strictEqual(ov({ status: 'scheduled', scheduled_for: NOW - 3 * HOUR, release_at: NOW - 4 * HOUR }).kind, 'scheduled_service_overdue'); ok('overdue: past scheduled_for+grace, never served → scheduled_service_overdue (capture-now liability)');

// ── fingerprintExtra — binds slot + fulfillment so a reused cart can't rebind a different slot (R2-#3) ──
assert.notStrictEqual(S.fingerprintExtra({ scheduled_for: 111, order_type: 'pickup' }), S.fingerprintExtra({ scheduled_for: 222, order_type: 'pickup' })); ok('fingerprintExtra: different scheduled_for → different');
assert.notStrictEqual(S.fingerprintExtra({ scheduled_for: 111, order_type: 'pickup' }), S.fingerprintExtra({ scheduled_for: 111, order_type: 'delivery' })); ok('fingerprintExtra: different order_type → different');
assert.strictEqual(S.fingerprintExtra({ order_type: 'pickup' }), S.fingerprintExtra({ order_type: 'pickup' })); ok('fingerprintExtra: no scheduled_for (ASAP) → stable/empty-consistent');

// ── constants + non-live augmentation ──
assert.ok(S.SCHEDULED === 'scheduled' && S.RELEASING === 'releasing'); ok('constants: SCHEDULED / RELEASING');
assert.ok(S.isNonLive('scheduled') && S.isNonLive('releasing') && S.isNonLive('pending_payment') && !S.isNonLive('new')); ok('isNonLive: scheduled/releasing/pending_payment non-live; new is live');

// ── asapWhileClosed: server fail-close guard for ASAP-while-closed (Checkout-scheduling move) ──
// An ASAP order (no scheduled_for) placed while the kitchen is closed must be rejected server-side; a
// scheduled order (slot present, validated separately) is accepted (held) even while closed.
{
  const closed = L(2026, 0, 5, 19, 0);   // Monday → closed
  const openT  = L(2026, 0, 6, 17, 0);   // Tue 17:00 → open
  const slot   = L(2026, 0, 6, 18, 0);   // a scheduled slot (its presence is what the guard keys on)
  assert.strictEqual(S.asapWhileClosed(HOURS, undefined, closed), true);  ok('asapWhileClosed: ASAP (no slot) while CLOSED → reject');
  assert.strictEqual(S.asapWhileClosed(HOURS, undefined, openT), false);  ok('asapWhileClosed: ASAP while OPEN → accept');
  assert.strictEqual(S.asapWhileClosed(HOURS, slot, closed), false);      ok('asapWhileClosed: scheduled (slot present) while closed → accept (held)');
  assert.strictEqual(S.asapWhileClosed(HOURS, NaN, openT), false);        ok('asapWhileClosed: NaN slot while open → accept (ASAP ok)');
}

console.log(`\n${n} passed`);
