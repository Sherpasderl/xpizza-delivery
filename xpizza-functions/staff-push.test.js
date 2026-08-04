/**
 * Unit tests for the pure staff-push decision/format helpers (Phase 2b).
 * Run: `node --test staff-push.test.js`. Mirrors driver-push.test.js (pure, no firebase).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coalesceDecision, formatNewOrder, formatGrouped } = require('./staff-push.js');

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
