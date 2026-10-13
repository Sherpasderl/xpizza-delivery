'use strict';
// test/_serial3-delta.js — the declared §3 r1 delta must be EXACT: what it admits, and what stays RED. Run: node test/_serial3-delta.test.js
const assert = require('assert');
const SD = require('./_serial3-delta');
const { orderContentKey, orderContentKeyVerbatim } = require('../order-dedup');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const content = { phone: '+50499331001', itemsText: '1x Margherita (L250) | 1x Carnivora (GRATIS)', orderType: 'pickup', scheduledFor: null };
const C = orderContentKey(content), V = orderContentKeyVerbatim(content);
assert.notStrictEqual(C, V, 'premise: a multi-line text keys differently before and after §3');
const leaf = (k) => `recent_order_content/<phoneKey>/${k}`;
const op = (o, p, extra = {}) => ({ db: 'rtdb', op: o, path: p, ...extra });
// the golden (pre-§3) and the candidate as the CHARGE route records them
const golden = [op('get', 'config/token_enforce'), op('once', leaf(V)), op('set', leaf(V), { keys: ['at', 'order_id', 'payment_method'] }), op('once', 'recent_order_content/<phoneKey>')];
const actual = [op('get', 'config/token_enforce'), op('once', leaf(C)), op('set', leaf(C), { keys: ['at', 'order_id', 'payment_method'] }), op('once', 'recent_order_content/<phoneKey>')];

// ── content-bound ──
{
  assert.notDeepStrictEqual(actual, golden, 'without the delta: RED');
  assert.deepStrictEqual(SD.contentKeyDelta(actual, { content, route: 'chargeOnlineOrder' }), golden, 'bound to the content the server hashed: the golden\'s REAL hash is compared');
  const wrong = { ...content, itemsText: `${content.itemsText} | 1x Otra (L1)` };
  assert.notDeepStrictEqual(SD.contentKeyDelta(actual, { content: wrong, route: 'chargeOnlineOrder' }), golden, 'a corrupted (different-content) binding: RED');
  const cs = SD.compareShape(actual, golden, { content, route: 'chargeOnlineOrder' });
  assert.ok(cs.bound); assert.deepStrictEqual(cs.actual, cs.expected);
  assert.ok(!SD.compareShape(actual, golden, { content: wrong, route: 'chargeOnlineOrder' }).bound, 'content whose key the request never touched does not bind');
  ok('content-bound: canonical → verbatim of the SAME content only; no delta / a wrong binding stays RED');
}
// ── the legacy twin read: ONLY on createOrder's route ──
{
  const created = [op('once', leaf(C)), op('once', leaf(V)), op('set', leaf(C), { keys: ['at'] })];
  const base = [op('once', leaf(V)), op('set', leaf(V), { keys: ['at'] })];
  assert.deepStrictEqual(SD.contentKeyDelta(created, { content, route: 'createOrder' }), base, 'createOrder: the declared extra read of the verbatim key collapses');
  assert.notDeepStrictEqual(SD.contentKeyDelta(created, { content, route: 'chargeOnlineOrder' }), base, 'any other route: the extra read stays in → RED');
  const extra = [op('once', leaf(C)), op('once', leaf(V)), op('once', leaf(V)), op('set', leaf(C), { keys: ['at'] })];
  assert.notDeepStrictEqual(SD.contentKeyDelta(extra, { content, route: 'createOrder' }), base, 'one MORE content-stamp read than declared → RED');
  const writtenTwin = [op('once', leaf(C)), op('once', leaf(V)), op('set', leaf(V), { keys: ['at'] })];
  assert.notDeepStrictEqual(SD.contentKeyDelta(writtenTwin, { content, route: 'createOrder' }), base, 'a "twin" that is later WRITTEN is not the declared read → RED');
  ok('the legacy-key read collapses only on createOrder, only once, only if never written');
}
// ── unbound (a refusal persisted nothing) ──
{
  const u = SD.compareShape(actual, golden, { content: null, route: 'chargeOnlineOrder' });
  assert.ok(!u.bound); assert.deepStrictEqual(u.actual, u.expected, 'unbound: the leaf normalised on BOTH sides');
  const split = [op('once', leaf(C)), op('set', leaf('f'.repeat(32)), { keys: ['at'] })];
  assert.throws(() => SD.contentKeyDelta(split, { content: null }), /different content keys/, 'unbound: a read of one key and a write of another → RED');
  assert.throws(() => SD.goldenUnbound([op('once', leaf(V)), op('set', leaf(C))]), /content keys/, 'the golden side is held to one key too');
  const ch = SD.changedShape([`recent_order_content/<k>/${C}/at`], [`recent_order_content/<k>/${V}/at`], { content, bound: true });
  assert.deepStrictEqual(ch.actual, ch.expected, 'changed paths follow the same binding');
  assert.notDeepStrictEqual(SD.changedShape([`recent_order_content/<k>/${C}/at`, 'orders/x/extra'], [`recent_order_content/<k>/${V}/at`], { content, bound: true }).actual, [`recent_order_content/<k>/${V}/at`], 'an extra changed path stays RED');
  ok('unbound: one key per request on both sides (a reader / writer split is RED); changed paths follow the binding');
}
// ── contentOfOrder reads exactly the stamp's inputs ──
{
  assert.deepStrictEqual(SD.contentOfOrder({ customer_phone: '+504 9933-1001', items_text: 'x', order_type: 'delivery', scheduled_for: null }), { phone: '+504 9933-1001', itemsText: 'x', orderType: 'delivery', scheduledFor: null });
  assert.strictEqual(SD.contentOfOrder({}), null); assert.strictEqual(SD.contentOfOrder(null), null);
  ok('contentOfOrder: the persisted order\'s phone / items_text / type / normalised slot; nothing persisted → null');
}
console.log(`\n_serial3-delta: OK (${n})`);
