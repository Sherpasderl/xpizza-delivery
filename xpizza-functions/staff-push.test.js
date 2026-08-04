/**
 * Unit tests for the pure staff-push decision/format helpers (Phase 2b).
 * Run: `node --test staff-push.test.js`. Mirrors driver-push.test.js (pure, no firebase).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coalesceDecision, formatNewOrder, formatGrouped, pushWithCleanup } = require('./staff-push.js');

const isTerminal = (e) => !!(e && (e.statusCode === 404 || e.statusCode === 410));
const terminalErr = () => { const e = new Error('gone'); e.statusCode = 410; return e; };

const WIN = 2 * 60 * 1000;

// ---- coalesceDecision ----
test('quiet period (never sent, lastSentAt null) → immediate', () =>
  assert.equal(coalesceDecision({ lastSentAt: null, now: 1000, windowMs: WIN }), 'immediate'));
test('never sent (lastSentAt 0) → immediate', () =>
  assert.equal(coalesceDecision({ lastSentAt: 0, now: 1000, windowMs: WIN }), 'immediate'));
test('outside window → immediate', () =>
  assert.equal(coalesceDecision({ lastSentAt: 1, now: 1 + WIN + 1, windowMs: WIN }), 'immediate'));
test('within window → buffer', () =>
  assert.equal(coalesceDecision({ lastSentAt: 1000, now: 1000 + WIN - 1, windowMs: WIN }), 'buffer'));
test('exactly at the window boundary → immediate (inclusive far edge)', () =>
  assert.equal(coalesceDecision({ lastSentAt: 1000, now: 1000 + WIN, windowMs: WIN }), 'immediate'));

// ---- formatGrouped ----
test('grouped body breaks down by brand, plural noun', () => {
  const g = formatGrouped({ x_pizza: 2, la_musa: 1, ids: ['a', 'b', 'c'] });
  assert.match(g.title, /3 pedidos nuevos/);
  assert.match(g.body, /2 X\. Pizza/);
  assert.match(g.body, /1 La Musa/);
});
test('grouped single → singular noun, only the present brand', () => {
  const g = formatGrouped({ x_pizza: 0, la_musa: 1, ids: ['a'] });
  assert.match(g.title, /\b1 pedido nuevo\b/);
  assert.equal(/X\. Pizza/.test(g.body), false);
  assert.match(g.body, /1 La Musa/);
});

// ---- formatNewOrder ----
test('formatNewOrder: brand + #n + customer', () => {
  const f = formatNewOrder({ restaurant_id: 'x_pizza', display_number: 47, customer_name: 'Juan' });
  assert.match(f.title, /Nuevo pedido/);
  assert.match(f.body, /X\. Pizza/);
  assert.match(f.body, /#47/);
  assert.match(f.body, /Juan/);
});
test('formatNewOrder: la_musa, missing #n and customer degrade gracefully', () => {
  const f = formatNewOrder({ restaurant_id: 'la_musa' });
  assert.match(f.body, /La Musa/);
  assert.equal(/#/.test(f.body), false);
});
test('formatNewOrder: unknown restaurant_id falls back to X. Pizza label', () => {
  const f = formatNewOrder({ restaurant_id: undefined, display_number: 3 });
  assert.match(f.body, /X\. Pizza/);
  assert.match(f.body, /#3/);
});

// ---- pushWithCleanup (codex 2b REVISE: the send path must never reject) ----
test('pushWithCleanup: success → {sent:true}, no cleanup', async () => {
  let removed = false;
  const r = await pushWithCleanup(
    { send: async () => {}, removeSub: async () => { removed = true; }, isTerminal },
    { endpoint: 'x' }, { title: 't' });
  assert.deepEqual(r, { sent: true });
  assert.equal(removed, false);
});
test('pushWithCleanup: missing/empty sub → {sent:false, no_sub}, never sends', async () => {
  let sent = false;
  const r = await pushWithCleanup(
    { send: async () => { sent = true; }, removeSub: async () => {}, isTerminal },
    null, {});
  assert.equal(r.sent, false); assert.equal(r.reason, 'no_sub'); assert.equal(sent, false);
});
test('pushWithCleanup: terminal (410) error → removes the dead sub, {sent:false}', async () => {
  let removed = false;
  const r = await pushWithCleanup(
    { send: async () => { throw terminalErr(); }, removeSub: async () => { removed = true; }, isTerminal },
    { endpoint: 'x' }, {});
  assert.equal(r.sent, false); assert.equal(r.reason, 'failed'); assert.equal(removed, true);
});
test('pushWithCleanup: RESOLVES (never rejects) when cleanup removeSub throws — THE codex REVISE fix', async () => {
  // send fails terminally AND the cleanup remove() rejects (RTDB hiccup): must still resolve, not throw.
  const r = await pushWithCleanup(
    { send: async () => { throw terminalErr(); }, removeSub: async () => { throw new Error('rtdb down'); }, isTerminal },
    { endpoint: 'x' }, {});
  assert.equal(r.sent, false); assert.equal(r.reason, 'failed');   // resolved — did NOT reject
});
test('pushWithCleanup: non-terminal (500) error → does NOT remove the sub', async () => {
  let removed = false;
  const r = await pushWithCleanup(
    { send: async () => { const e = new Error('boom'); e.statusCode = 500; throw e; }, removeSub: async () => { removed = true; }, isTerminal },
    { endpoint: 'x' }, {});
  assert.equal(r.sent, false); assert.equal(removed, false);
});
