'use strict';
// PLAN-guest-checkout-server (r4) — the pure core: discriminator, send budget, order-id-bound ticket, stateless grant, and the
// server phone allowlist (incl. a drift guard against the forms' PHONE_COUNTRIES). Pure; no emulator.
// Run: node checkout-guest-lib.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('./checkout-guest-lib');
const PC = require('./phone-countries');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const H = (c) => c.repeat(64);

// ── 1. the S2 discriminator: ONLY the stamped capp deployment with an unresolved identity ──
assert.strictEqual(L.isCappGuest({ deployment: 'orders-app' }, null), true);
for (const [hdr, uid, why] of [[{ deployment: 'orders-app' }, 'u_abc', 'a member'], [{ deployment: 'orders-xpizza' }, null, 'the x_pizza form'],
  [{ deployment: 'orders-lamusa' }, null, 'the la_musa form'], [{ deployment: null }, null, 'an absent/malformed header (readClientHeaders → null)'],
  [{ deployment: 'orders-app2' }, null, 'an unknown id'], [null, null, 'no header object'], [{ deployment: 'orders-app' }, undefined, 'uid undefined (not the resolved-null shape)'],
  [{ deployment: 'ORDERS-APP' }, null, 'a case variant']]) assert.strictEqual(L.isCappGuest(hdr, uid), false, `🔴 ${why} must take today's path`);
ok('isCappGuest: true ONLY for deployment === "orders-app" && uid === null — members, both forms, absent / unknown / malformed headers ⇒ false');

// ── 2. the durable checkout send budget (txn updater) ──
{
  const t0 = 1e12;
  let r = L.budgetReserve(null, t0); assert.ok(r.ok); assert.deepStrictEqual(r.next, { sends: [t0], last: t0 });
  r = L.budgetReserve(r.next, t0 + 10e3); assert.ok(!r.ok && r.next === undefined && r.retryInMs === 20e3, 'the 30 s gap');
  let cur = { sends: [t0, t0 + 31e3] };
  r = L.budgetReserve(cur, t0 + 62e3); assert.ok(r.ok); cur = r.next; assert.strictEqual(cur.sends.length, 3);
  r = L.budgetReserve(cur, t0 + 93e3); assert.ok(!r.ok, '3 per 10 min'); assert.strictEqual(r.retryInMs, t0 + 10 * 60e3 - (t0 + 93e3));
  r = L.budgetReserve(cur, t0 + 10 * 60e3 + 1); assert.ok(r.ok, 'the window slides'); assert.ok(!r.next.sends.includes(t0), 'expired sends are pruned');
  // the union with signup's (non-durable) sends counts toward the window, but only OWN sends persist
  r = L.budgetReserve(null, t0, [t0 - 40e3, t0 - 80e3, t0 - 120e3]); assert.ok(!r.ok, 'signup sends count (3 in the window)');
  r = L.budgetReserve({ sends: [t0 - 200e3] }, t0, [t0 - 40e3]); assert.ok(r.ok); assert.deepStrictEqual(r.next, { sends: [t0 - 200e3, t0], last: t0 }, 'signup sends are never copied into the budget');
  // the ADVISOR-ACCEPTED policy: after a signup verify deletes otp/{h}, the checkout budget = its own durable sends
  r = L.budgetReserve({ sends: [t0 - 100e3] }, t0, []); assert.ok(r.ok);
  r = L.budgetReserve(null, t0, 'garbage'); assert.ok(r.ok, 'a malformed signup record is ignored, never a crash');
}
ok('budgetReserve: 30 s gap, 3 per sliding 10 min, the signup union counted but never persisted, expired sends pruned, garbage-safe');

// ── 3. the order-id-bound ticket: record + READ-ONLY validity ──
{
  const now = 1e12;
  const rec = L.ticketRecord({ phone: '50499990000', phoneHash: H('a'), rid: 'x_pizza', cartFp: H('c'), orderId: 'XPZ-1', now });
  assert.deepStrictEqual(Object.keys(rec).sort(), ['cart_fp', 'exp', 'order_id', 'phone', 'phone_hash', 'rid'], 'NO state field (r3)');
  assert.strictEqual(rec.exp, now + 15 * 60e3);
  const ctx = { now: now + 60e3, rid: 'x_pizza', orderId: 'XPZ-1', cartFp: H('c'), phoneHash: H('a') };
  assert.strictEqual(L.ticketValid(rec, ctx), true);
  for (const [k, v, why] of [['rid', 'la_musa', 'another restaurant'], ['orderId', 'XPZ-2', 'a DIFFERENT order id — a ticket places only its own order'],
    ['cartFp', H('d'), 'a changed cart (strict binding)'], ['phoneHash', H('b'), 'another phone'], ['now', now + 15 * 60e3, 'expired (exactly at exp)'],
    ['cartFp', undefined, 'no recompute'], ['phoneHash', null, 'no phone']]) assert.strictEqual(L.ticketValid(rec, { ...ctx, [k]: v }), false, `🔴 ${why}`);
  assert.strictEqual(L.ticketValid(null, ctx), false); assert.strictEqual(L.ticketValid({ ...rec, exp: 'x' }, ctx), false);
  assert.strictEqual(L.ticketValid(rec, ctx), true, 'validity is READ-ONLY: checking twice changes nothing (a refused attempt consumes nothing)');
  for (const bad of [{ cartFp: 'nothex' }, { orderId: 'has space' }, { orderId: 'x'.repeat(65) }, { phoneHash: 'short' }, { rid: '' }])
    assert.throws(() => L.ticketRecord({ phone: '50499990000', phoneHash: H('a'), rid: 'x_pizza', cartFp: H('c'), orderId: 'XPZ-1', now, ...bad }));
  assert.match(L.newTicketId(), /^ct_[0-9a-f]{32}$/); assert.notStrictEqual(L.newTicketId(), L.newTicketId());
  assert.match(L.ticketKey('ct_x'), /^[0-9a-f]{64}$/);
}
ok('ticket: {phone, phone_hash, rid, cart_fp, order_id, exp} with no state; valid ONLY for its own rid / order id / cart / phone before exp; read-only; malformed inputs refused');

// ── 4. the stateless signup grant ──
{
  const S = 's'.repeat(40), created = 1e12;
  const p = L.grantPayload('XPZ-1', H('a'), created);
  assert.deepStrictEqual(p, { order_id: 'XPZ-1', phone_hash: H('a'), exp: created + 15 * 60e3 });
  const t = L.signGrant(p, S);
  assert.match(t, /^sg\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.strictEqual(L.signGrant(L.grantPayload('XPZ-1', H('a'), created), S), t, 'a replay recomputes the SAME bytes (no publication record, no TTL reset)');
  const v = L.verifyGrant(t, S, created + 60e3); assert.ok(v.ok); assert.deepStrictEqual(v.payload, p);
  assert.strictEqual(L.verifyGrant(t, S, created + 15 * 60e3).reason, 'expired');
  assert.strictEqual(L.verifyGrant(t, 'x'.repeat(40), created).reason, 'bad_signature', 'another secret');
  // tamper: a far-future exp with the original signature must read as a FORGERY (signature checked first), never as valid
  const [, body, sig] = t.split('.');
  const forged = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); forged.exp = created + 1e9;
  const fb = Buffer.from(JSON.stringify(forged)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(L.verifyGrant(`sg.${fb}.${sig}`, S, created).reason, 'bad_signature', '🔴 a tampered payload is a forgery');
  for (const g of [null, '', 'sg.', 'sg.a', 'sg.a.b.c', 'xx.a.b', 'sg.!!.!!', 42, {}]) assert.strictEqual(L.verifyGrant(g, S, created).ok, false, `garbage ${JSON.stringify(g)}`);
  assert.doesNotThrow(() => L.verifyGrant('sg.' + 'A'.repeat(5000) + '.B', S, created), 'never throws');
  assert.throws(() => L.signGrant(p, 'short'), /fail-closed/); assert.strictEqual(L.verifyGrant(t, 'short', created).ok, false);
}
ok('grant: HMAC over the exact payload bytes; deterministic per order (replay = same token); expiry; signature checked BEFORE the payload is believed; never throws; fail-closed secret');

// ── 6. the guest gate's BODY refusals (payment, scheduling, email — in that order) ──
{
  const good = { payment_method: 'online', customer_email: 'ana@example.com' };
  assert.strictEqual(L.guestBodyRefusal(good), null);
  for (const pm of ['cash', 'card_delivery', '', undefined, 'ONLINE']) assert.strictEqual(L.guestBodyRefusal({ ...good, payment_method: pm }), 'guest_cash_not_allowed', `payment ${pm}`);
  for (const sf of [1.8e12, '2026-10-28T12:00:00Z', 0, 'garbage', {}, false]) assert.strictEqual(L.guestBodyRefusal({ ...good, scheduled_for: sf }), 'guest_schedule_requires_account', `🔴 a guest body carrying scheduled_for=${JSON.stringify(sf)} must be refused`);
  for (const sf of [undefined, null, '']) assert.strictEqual(L.guestBodyRefusal({ ...good, scheduled_for: sf }), null, `no scheduling: ${JSON.stringify(sf)}`);
  for (const em of [undefined, '', 'ana', 'ana@', '@x.com', 'a b@x.com', 'ana@x', 42]) assert.strictEqual(L.guestBodyRefusal({ ...good, customer_email: em }), 'guest_email_required', `email ${JSON.stringify(em)}`);
  assert.strictEqual(L.guestBodyRefusal({ payment_method: 'cash', scheduled_for: 1, customer_email: '' }), 'guest_cash_not_allowed', 'order: payment first');
  assert.strictEqual(L.guestBodyRefusal({ payment_method: 'online', scheduled_for: 1, customer_email: '' }), 'guest_schedule_requires_account', 'order: scheduling before email');
  assert.strictEqual(L.guestBodyRefusal(null), 'guest_cash_not_allowed');
}
ok('guestBodyRefusal: non-online ⇒ guest_cash_not_allowed; ANY scheduled_for carried ⇒ guest_schedule_requires_account (owner rule: scheduling requires an account); bad email ⇒ guest_email_required; in that order');

// ── 5. the server phone allowlist = the forms' PHONE_COUNTRIES (drift guard: one list) ──
for (const form of ['xpizza-orders', 'la-musa-orders']) {
  const html = fs.readFileSync(path.join(__dirname, '..', form, 'index.html'), 'utf8');
  const block = html.slice(html.indexOf('const PHONE_COUNTRIES'), html.indexOf('];', html.indexOf('const PHONE_COUNTRIES')));
  const client = [...block.matchAll(/code:'(\d+)'[^}]*len:(\d+)/g)].map((m) => ({ cc: m[1], len: Number(m[2]) }));
  assert.deepStrictEqual(client, PC.COUNTRIES.map((c) => ({ cc: c.cc, len: c.len })), `🔴 ${form}: the server allowlist drifted from PHONE_COUNTRIES`);
}
assert.deepStrictEqual(PC.parseE164('+50499990000'), { e164: '+50499990000', cc: '504', national: '99990000' });
assert.deepStrictEqual(PC.parseE164('+12125550123'), { e164: '+12125550123', cc: '1', national: '2125550123' });
assert.strictEqual(PC.parseE164('+34612345678').cc, '34');
for (const bad of ['50499990000', '+5049999000', '+504999900001', '+4412345678', '+50499990000 x', '', null, 42, '+1212555012'])
  assert.strictEqual(PC.parseE164(bad), null, `refused: ${JSON.stringify(bad)}`);
ok('phone allowlist: exactly the forms\' PHONE_COUNTRIES (both forms, drift-guarded); qualified E.164 with the exact national length; everything else ⇒ null');

console.log(`\ncheckout-guest-lib: OK (${n})`);
