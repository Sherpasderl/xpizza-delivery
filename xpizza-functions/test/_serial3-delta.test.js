'use strict';
// test/_serial3-delta.js — the declared §3 delta must be EXACT: what it admits, and what stays RED. Run: node test/_serial3-delta.test.js
// codex serialization r2 P2: the mode is DECLARED per case (never inferred from the trace); every sensitivity below goes
// THROUGH compareShape, the function the suites call.
const assert = require('assert');
const SD = require('./_serial3-delta');
const { orderContentKey, orderContentKeyVerbatim } = require('../order-dedup');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const content = { phone: '+50499331001', itemsText: '1x Margherita (L250) | 1x Carnivora (Recompensa)', orderType: 'pickup', scheduledFor: null };
const C = orderContentKey(content), V = orderContentKeyVerbatim(content);
assert.notStrictEqual(C, V, 'premise: a multi-line text keys differently before and after §3');
const leaf = (k) => `recent_order_content/<phoneKey>/${k}`;
const op = (o, p, extra = {}) => ({ db: 'rtdb', op: o, path: p, ...extra });
const F = 'f'.repeat(32), E = 'e'.repeat(32);
// the golden (a pre-§3 client: the legacy key) and the candidate, as the CHARGE route records them
const golden = [op('get', 'config/token_enforce'), op('once', leaf(V)), op('set', leaf(V), { keys: ['at', 'order_id', 'payment_method'] }), op('once', 'recent_order_content/<phoneKey>')];
const actual = [op('get', 'config/token_enforce'), op('once', leaf(C)), op('set', leaf(C), { keys: ['at', 'order_id', 'payment_method'] }), op('once', 'recent_order_content/<phoneKey>')];
const swap = (ops, from, to) => ops.map((e) => (e.path ? { ...e, path: e.path.split(from).join(to) } : e));
const red = (fn, why) => { let threw = false, eq = false; try { const r = fn(); eq = JSON.stringify(r.actual) === JSON.stringify(r.expected); } catch (_) { threw = true; } assert.ok(threw || !eq, `🔴 must be RED: ${why}`); };

// ── declared mode is required ──
{
  assert.throws(() => SD.compareShape(actual, golden, { content }), /DECLARE its mode/, 'no mode → refused');
  assert.throws(() => SD.compareShape(actual, golden, { mode: 'auto', content }), /DECLARE its mode/, 'an inferred mode is not a mode');
  ok('the mode must be declared per case (bound | unbound): nothing is inferred from the trace');
}
// ── BOUND ──
{
  const r = SD.compareShape(actual, golden, { mode: 'bound', content, route: 'chargeOnlineOrder' });
  assert.deepStrictEqual(r.actual, r.expected, 'bound: canonical → the legacy key the golden recorded');
  assert.notDeepStrictEqual(actual, golden, 'without the delta: RED');
  red(() => SD.compareShape(swap(actual, C, F), golden, { mode: 'bound', content, route: 'chargeOnlineOrder' }), 'bound: EVERY stamp key replaced with ffff… (codex r2 reproduction)');
  red(() => SD.compareShape(actual, golden, { mode: 'bound', content: { ...content, itemsText: content.itemsText + ' | 1x Otra (L1)' }, route: 'chargeOnlineOrder' }), 'bound to a DIFFERENT content');
  assert.throws(() => SD.compareShape(actual, golden, { mode: 'bound', content: null }), /no content was declared/, 'a bound case that stamps with no declared content → refused');
  const quiet = [op('get', 'config/token_enforce')];
  assert.deepStrictEqual(SD.compareShape(quiet, quiet, { mode: 'bound', content: null }).actual, quiet, 'a bound case that stamps nothing needs no content');
  ok('bound: maps only THIS content\'s canonical key to its legacy key; ffff… keys, other content, or no content → RED');
}
// ── the createOrder legacy read ──
{
  const created = [op('once', leaf(C)), op('once', leaf(V)), op('set', leaf(C), { keys: ['at'] })];
  const base = [op('once', leaf(V)), op('set', leaf(V), { keys: ['at'] })];
  const r = SD.compareShape(created, base, { mode: 'bound', content, route: 'createOrder' });
  assert.deepStrictEqual(r.actual, r.expected, 'createOrder: the declared legacy-key read collapses');
  red(() => SD.compareShape([op('once', leaf(C)), op('once', leaf(E)), op('set', leaf(C), { keys: ['at'] })], base, { mode: 'bound', content, route: 'createOrder' }), 'createOrder: an extra eeee… read in place of the legacy read (codex r2)');
  red(() => SD.compareShape([op('once', leaf(C)), op('once', leaf(V)), op('once', leaf(E)), op('set', leaf(C), { keys: ['at'] })], base, { mode: 'bound', content, route: 'createOrder' }), 'createOrder: one MORE read than declared');
  red(() => SD.compareShape(created, base, { mode: 'bound', content, route: 'chargeOnlineOrder' }), 'the legacy read on any OTHER route');
  red(() => SD.compareShape(created, SD.goldenUnbound(base), { mode: 'unbound', route: 'createOrder' }), 'an UNBOUND case never collapses a twin');
  // the legacy key is the MENU-ORDER text of the cart (r2): with menu names, a permuted cart's legacy key is the menu-ordered one
  const perm = { ...content, itemsText: '1x Pepperoni (L307) | 2x Carnivora (L340)' };
  const menuNames = ['Carnivora', 'Pepperoni'];
  const L = orderContentKeyVerbatim({ ...perm, itemsText: '2x Carnivora (L340) | 1x Pepperoni (L307)' }), Cp = orderContentKey(perm);
  const r2 = SD.compareShape([op('once', leaf(Cp)), op('once', leaf(L)), op('set', leaf(Cp))], [op('once', leaf(L)), op('set', leaf(L))], { mode: 'bound', content: perm, route: 'createOrder', menuNames });
  assert.deepStrictEqual(r2.actual, r2.expected, 'the twin must be the MENU-ORDER legacy key');
  red(() => SD.compareShape([op('once', leaf(Cp)), op('once', leaf(orderContentKeyVerbatim(perm))), op('set', leaf(Cp))], [op('once', leaf(L)), op('set', leaf(L))], { mode: 'bound', content: perm, route: 'createOrder', menuNames }), 'a twin of the incoming (non-menu) order is not the legacy key');
  ok('createOrder: the twin must equal the expected LEGACY key (menu order); eeee… / extra reads / other routes / unbound twins → RED');
}
// ── UNBOUND ──
{
  const u = SD.compareShape(actual, golden, { mode: 'unbound', route: 'chargeOnlineOrder' });
  assert.deepStrictEqual(u.actual, u.expected, 'unbound: the leaf normalised on BOTH sides');
  red(() => SD.compareShape([op('once', leaf(C)), op('set', leaf(F), { keys: ['at'] })], golden, { mode: 'unbound' }), 'unbound: a read of one key and a write of another');
  assert.throws(() => SD.goldenUnbound([op('once', leaf(V)), op('set', leaf(C))]), /content keys/, 'the golden side is held to one key too');
  ok('unbound: one key per request on both sides; a reader / writer split is RED');
}
// ── changed paths + contentOfOrder ──
{
  const ch = SD.changedShape([`recent_order_content/<k>/${C}/at`], [`recent_order_content/<k>/${V}/at`], { content, bound: true });
  assert.deepStrictEqual(ch.actual, ch.expected, 'changed paths follow the same binding');
  assert.notDeepStrictEqual(SD.changedShape([`recent_order_content/<k>/${F}/at`], [`recent_order_content/<k>/${V}/at`], { content, bound: true }).actual, [`recent_order_content/<k>/${V}/at`], 'a wrong key in a bound changed path stays RED');
  assert.deepStrictEqual(SD.contentOfOrder({ customer_phone: '+504 9933-1001', items_text: 'x', order_type: 'delivery', scheduled_for: null }), { phone: '+504 9933-1001', itemsText: 'x', orderType: 'delivery', scheduledFor: null });
  assert.strictEqual(SD.contentOfOrder({}), null);
  // a reward append happens AFTER the stamp: the persisted text is not the stamped one; the request body is
  const sent = { customer_phone: '+50499331001', items_text: '1x Carnivora', order_type: 'pickup', payment_method: 'cash' };
  const persisted = { customer_phone: '+50499331001', items_text: '1x Carnivora | 1x Margherita (Recompensa)', order_type: 'pickup' };
  assert.deepStrictEqual(SD.contentOfRequest(sent), { phone: '+50499331001', itemsText: '1x Carnivora', orderType: 'pickup', scheduledFor: null });
  assert.notStrictEqual(orderContentKey(SD.contentOfRequest(sent)), orderContentKey(SD.contentOfOrder(persisted)), 'premise: the append changes the key');
  assert.strictEqual(SD.contentOfRequest({}), null);
  // per route: createOrder stamps the POSTED text; chargeOnlineOrder the final text (posted + server reward lines)
  assert.strictEqual(SD.stampContent({ route: 'createOrder', sent, post: persisted }).itemsText, '1x Carnivora');
  assert.strictEqual(SD.stampContent({ route: 'chargeOnlineOrder', sent, post: persisted }).itemsText, persisted.items_text);
  assert.strictEqual(SD.stampContent({ route: 'chargeOnlineOrder', sent: { ...sent, items_text: '2x Carnivora' }, post: persisted }).itemsText, '2x Carnivora', 'an order this request did not write (other cart) → the posted text');
  assert.strictEqual(SD.stampContent({ route: 'chargeOnlineOrder', sent, post: { ...persisted, items_text: '1x Carnivora | 1x Otra (L9)' } }).itemsText, '1x Carnivora', 'a non-server extra line is not this request\'s content');
  // r3: the pending order's persisted content keys — declared on a BOUND chargeOnlineOrder request only
  const base = [`recent_order_content/<k>/${V}/at`, 'orders/<oid>/status'];
  const withKeys = (...f) => [`recent_order_content/<k>/${C}/at`, 'orders/<oid>/status', ...f.map((x) => `orders/<oid>/${x}`)];
  { const r = SD.changedShape(withKeys('content_key', 'content_key_legacy'), base, { content, bound: true, route: 'chargeOnlineOrder' });
    assert.deepStrictEqual(r.actual, [...r.expected].sort(), 'charge + content_key + content_key_legacy → admitted'); }
  { const r = SD.changedShape(withKeys('content_key', 'content_key_legacy_reason'), base, { content, bound: true, route: 'chargeOnlineOrder' });
    assert.deepStrictEqual(r.actual, [...r.expected].sort(), 'charge + content_key + content_key_legacy_reason → admitted'); }
  assert.throws(() => SD.changedShape(withKeys('content_key', 'content_key_legacy'), base, { content, bound: true, route: 'createOrder' }), /undeclared route|written on createOrder/, 'on createOrder → RED');
  assert.throws(() => SD.changedShape(withKeys('content_key_legacy'), base, { content, bound: true, route: 'chargeOnlineOrder' }), /content_key \+ exactly one/, 'no content_key → RED');
  assert.throws(() => SD.changedShape(withKeys('content_key', 'content_key_legacy', 'content_key_legacy_reason'), base, { content, bound: true, route: 'chargeOnlineOrder' }), /exactly one/, 'both legacy and reason → RED');
  assert.notDeepStrictEqual(SD.changedShape(withKeys('content_key', 'content_key_legacy'), base, { content, bound: false, route: 'chargeOnlineOrder' }).actual, SD.changedShape(withKeys('content_key', 'content_key_legacy'), base, { content, bound: false }).expected, 'an UNBOUND request writing them stays RED');
  ok('changed paths follow the declared binding (a wrong key stays RED); contentOfOrder / contentOfRequest read the order and the POSTED body (a post-stamp reward append is not the stamped content)');
}
console.log(`\n_serial3-delta: OK (${n})`);
