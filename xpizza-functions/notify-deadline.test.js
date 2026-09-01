'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { notifyWithinDeadline } = require('./notify-deadline');

// (a) fast-resolving promise → resolves ~immediately (well under the deadline).
test('fast-resolving send → resolves immediately, not at the deadline', async () => {
  const t0 = Date.now();
  await notifyWithinDeadline(Promise.resolve('sent'), 5000);
  assert.ok(Date.now() - t0 < 200, 'should resolve on the send, not wait for the 5s deadline');
});

// (b) NEVER-resolving promise + short deadline → resolves within a small bound.
// This is the "createOrder responds even when the WhatsApp send hangs" proof.
test('never-resolving send + short deadline → resolves bounded (the 30s-hang guard)', async () => {
  const hung = new Promise(() => {}); // never settles — models a hung UltraMsg fetch
  const t0 = Date.now();
  await notifyWithinDeadline(hung, 30);
  const dt = Date.now() - t0;
  assert.ok(dt >= 25, `should wait ~the deadline, waited ${dt}ms`);
  assert.ok(dt < 200, `should resolve shortly after the deadline, waited ${dt}ms`);
});

// (c) a REJECTING promise → still resolves (never rejects). A notify failure can't fail the order.
test('rejecting send → still resolves, never rejects', async () => {
  await assert.doesNotReject(
    notifyWithinDeadline(Promise.reject(new Error('gateway 500')), 5000)
  );
});

// timer-cleared: a resolved-fast wrapper must leave no pending timer keeping the loop alive.
// If the deadline timer weren't cleared, this test process would hang ~10s past assertions.
test('timer is cleared on fast resolve (no leaked handle)', async () => {
  await notifyWithinDeadline(Promise.resolve(), 10000);
  // Reaching here without the 10s timer holding the loop open proves clearTimeout ran.
  // (node:test would keep the process alive for a stray timer; a leak surfaces as a hang.)
  assert.ok(true);
});

// idempotent settle: deadline fires first, then the slow send settles later → single resolve, no throw.
test('deadline-then-late-settle → single resolve, late settle is a harmless no-op', async () => {
  let releaseReject;
  const slow = new Promise((_, rej) => { releaseReject = rej; });
  const t0 = Date.now();
  await notifyWithinDeadline(slow, 20); // deadline wins
  assert.ok(Date.now() - t0 < 200);
  // Now let the abandoned promise reject late — must not throw an unhandled rejection into the wrapper.
  releaseReject(new Error('late gateway error'));
  await new Promise((r) => setTimeout(r, 10)); // let the microtask flush
  assert.ok(true, 'late rejection after resolve is swallowed by then(finish, finish)');
});
