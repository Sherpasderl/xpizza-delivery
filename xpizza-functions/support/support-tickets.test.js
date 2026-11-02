'use strict';
// S-F (PLAN §S-F; NOTE-S-F-support-tickets-build) — createSupportTicket: a ticket for an OWNED order only. Member proof = the ONE customer
// predicate (rate-order.customerUidOf) + orders/{id}.customer_uid; guest proof = the order's tracking_token (the claimOrder capability),
// compared in constant time. Any failure is ONE generic 403 with NOTHING written. The ticket carries no identity; ≤ 5 per order.
// Orders from the REAL intake writers. Run: node support/support-tickets.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'support-tickets-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const ST = require('./support-tickets');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 support-tickets: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {};
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  const ref = (p = '') => ({
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, prune(v)); },
    transaction: async (fn) => {
      const actual = clone(get(p)) ?? null;
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
      if (actual !== null) { next = fn(actual); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; }
      set(p, prune(next)); return { committed: true, snapshot: snap(get(p)) };
    },
  });
  return { tree, get, set, ref };
}
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true }, 'tok-hh': { uid: A, customer: true, handheld: true }, 'tok-staff': { uid: 's1' } };
const verifyIdToken = async (t) => { if (!TOK[t]) throw new Error('bad'); return TOK[t]; };
async function place(db, uid, id) {
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: 1, trackingToken: `trk_${id}_${'z'.repeat(20)}`, total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: 'x_pizza', priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: 1, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: 'x_pizza', items: [{ name: 'Margherita', qty: 1 }] });
  await db.ref().update(u);
  return db.get(`orders/${id}/tracking_token`);
}
const rl = [];
// as strict as production: index.js checkRateLimit reads cfg.windowMs / cfg.max inside its transaction — a missing policy THROWS there and
// fails OPEN, so the stub refuses it (Codex S-F r1 #1: the old stub accepted three arguments)
const policyOk = (cfg) => !!cfg && Number.isSafeInteger(cfg.windowMs) && cfg.windowMs > 0 && Number.isSafeInteger(cfg.max) && cfg.max > 0;
const h = (db, { limited = false, now = () => 5000, newId } = {}) => ST.makeSupportTickets({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }), now, newId: newId || (() => { let i = 0; return () => `t${++i}`; })(),
  checkRateLimit: async (_d, bucket, key, cfg) => { assert.ok(policyOk(cfg), `🔴 checkRateLimit(${bucket}) without a valid policy — production fails OPEN there`); rl.push({ bucket, key, cfg, reads: _d.reads ? _d.reads.length : null }); return limited ? { allowed: false, retryAfterSec: 3 } : { allowed: true, retryAfterSec: 0 }; } }).createSupportTicket;
async function call(fn, { token, body, method = 'POST' } = {}) {
  const headers = token ? { 'x-firebase-id-token': token } : {};
  const req = { method, body, headers, get: (k) => headers[String(k).toLowerCase()] };
  const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
  await fn(req, res); return res;
}
const GENERIC = { ok: false, error: 'not_allowed' };
const tickets = (db) => Object.values(db.get('support_tickets') || {});

(async () => {
  // ── 1. ownership: member (the ONE predicate) or guest (tracking_token); anything else ⇒ ONE generic 403, nothing written ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-m'); const gTok = await place(db, null, 'XPZ-g');
    const fn = h(db);
    let r = await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.deepStrictEqual(r.body, { ok: true, status: 'received' });
    r = await call(fn, { body: { order_id: 'XPZ-g', tracking_token: gTok, reason: 'missing', channel: 'whatsapp' } });
    assert.strictEqual(r.code, 200, '🔴 a guest with the order\'s tracking token files a ticket');
    assert.strictEqual(tickets(db).length, 2);
    for (const [why, o] of [['another member', { token: `tok-${B}`, body: { order_id: 'XPZ-m' } }], ['a member on a GUEST order', { token: `tok-${A}`, body: { order_id: 'XPZ-g' } }],
      ['a wrong tracking token', { body: { order_id: 'XPZ-g', tracking_token: gTok.slice(0, -1) + 'y' } }], ['a token PREFIX', { body: { order_id: 'XPZ-g', tracking_token: gTok.slice(0, 10) } }],
      ['another order\'s token', { body: { order_id: 'XPZ-m', tracking_token: gTok } }], ['no proof at all', { body: { order_id: 'XPZ-g' } }],
      ['a handheld token', { token: 'tok-hh', body: { order_id: 'XPZ-m' } }], ['a staff token', { token: 'tok-staff', body: { order_id: 'XPZ-m' } }],
      ['an unknown order', { token: `tok-${A}`, body: { order_id: 'XPZ-none' } }], ['an unknown order by token', { body: { order_id: 'XPZ-none', tracking_token: gTok } }]]) {
      const res = await call(fn, { ...o, body: { reason: 'late', channel: 'inapp', ...o.body } });
      assert.strictEqual(res.code, 403, `🔴 ${why} ⇒ ${res.code}`); assert.deepStrictEqual(res.body, GENERIC, `${why}: the ONE generic refusal`);
    }
    db.set(`deleted_uids/${A}`, 5);
    assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 403, '🔴 a tombstoned member');
    assert.strictEqual(tickets(db).length, 2, '🔴 no refusal wrote anything');
    assert.strictEqual(Object.keys(db.get('dispatcher_alerts') || {}).length, 2, '🔴 one alert per accepted ticket, none for a refusal');
  }
  ok('ownership: the member (customerUidOf + customer_uid) and the guest (the order\'s tracking_token) file; another member, a member on a guest order, a wrong / prefix / foreign token, no proof, a handheld, staff, an unknown order and a tombstoned member ⇒ ONE generic 403, nothing written');

  // ── 2. the ticket: no identity; exactly the contract fields ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-m');
    await call(h(db), { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'other', text: '  Faltó la salsa  ', channel: 'inapp' } });
    const [t] = tickets(db);
    assert.deepStrictEqual(t, { order_id: 'XPZ-m', restaurant_id: 'x_pizza', reason: 'other', text: 'Faltó la salsa', channel: 'inapp', created_at: 5000, status: 'received', via: 'member' });
    assert.ok(!/u_a|5049|Ana|trk_/.test(JSON.stringify(db.get('support_tickets'))), '🔴 no uid / phone / name / token in the ticket');
    // ruling F3: raised to the Central at once through the existing dispatcher_alerts channel — order_id + reason only
    const alerts = db.get('dispatcher_alerts') || {};
    assert.deepStrictEqual(Object.values(alerts), [{ type: 'support_ticket_received', order_id: 'XPZ-m', reason: 'other', created_at: 5000 }], '🔴 the Central alert: order_id + reason only');
    assert.deepStrictEqual(Object.keys(alerts), [`support_ticket_${Object.keys(db.get('support_tickets'))[0]}`], 'keyed by the ticket');
  }
  ok('the ticket: { order_id, restaurant_id, reason, text, channel, created_at, status:received, via } — no uid, phone, name or token');

  // ── 3. strict body ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-m'); const fn = h(db);
    for (const b of [{ order_id: 'XPZ-m', reason: 'bad', channel: 'inapp' }, { order_id: 'XPZ-m', reason: 'late', channel: 'sms' }, { order_id: 'XPZ-m', reason: 'other', channel: 'inapp' },
      { order_id: 'XPZ-m', reason: 'other', text: '   ', channel: 'inapp' }, { order_id: 'XPZ-m', reason: 'late', text: 'x'.repeat(501), channel: 'inapp' },
      { order_id: 'XPZ-m', reason: 'late', text: '<script>', channel: 'inapp' }, { order_id: 'XPZ-m', reason: 'late', text: 'a\u0000b', channel: 'inapp' },
      { order_id: 'XPZ-m', reason: 'late', channel: 'inapp', uid: B }, { order_id: '../x', reason: 'late', channel: 'inapp' }, null, []])
      assert.strictEqual((await call(fn, { token: `tok-${A}`, body: b })).code, 400, `🔴 ${JSON.stringify(b)} ⇒ 400`);
    assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' }, method: 'GET' })).code, 405);
    assert.strictEqual(tickets(db).length, 0);
  }
  ok('strict body: reason ∈ {missing, wrong, late, other}, channel ∈ {inapp, whatsapp}, text required for other, ≤ 500, no markup / control chars, no extra key ⇒ else 400; POST only');

  // ── 4. bounds: ≤ 5 per order (transaction-counted), the rate limit ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-m'); const fn = h(db);
    for (let i = 0; i < 5; i++) assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 200);
    const r = await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } });
    assert.strictEqual(r.code, 429, '🔴 the 6th ticket for an order is refused'); assert.strictEqual(tickets(db).length, 5);
    const db2 = fakeDb(); await place(db2, A, 'XPZ-m');
    assert.strictEqual((await call(h(db2, { limited: true }), { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 429);
    assert.ok(rl.some((x) => x.bucket === 'support_ticket' && x.key === `u:${A}`), '🔴 a member is rate-limited per CALLER (uid), not per order');
    assert.strictEqual(tickets(db2).length, 0);
  }
  ok('bounds: at most 5 tickets per order and a per-caller rate limit ⇒ 429, nothing written');

  // ── 5. Codex S-F r1: the throttle runs BEFORE anything ownership-dependent; equal work on a missing order; a recoverable reservation ──
  {
    const db = fakeDb(); const gTok = await place(db, null, 'XPZ-g');
    const reads = []; const real = db.ref; db.ref = (p) => { const r = real(p); return { ...r, once: async () => { reads.push(p); return r.once(); } }; };
    rl.length = 0;
    await call(h(db), { body: { order_id: 'XPZ-none', tracking_token: gTok, reason: 'late', channel: 'inapp' } });
    assert.deepStrictEqual(rl.map((x) => x.key), ['g:XPZ-none'], '🔴 an UNKNOWN order is throttled too (per the guest\'s order key) — before any ownership answer');
    rl.length = 0; reads.length = 0;
    const lim = await call(h(db, { limited: true }), { body: { order_id: 'XPZ-g', tracking_token: 'wrong', reason: 'late', channel: 'inapp' } });
    assert.strictEqual(lim.code, 429); assert.deepStrictEqual(reads, [], '🔴 a throttled caller never reaches the order read');
    db.ref = real;
    // equal comparison work: a probe on a MISSING order compares against a dummy exactly as a wrong token on a present one
    const crypto = require('crypto'); const orig = crypto.timingSafeEqual; let calls = 0;
    crypto.timingSafeEqual = (a, b) => { calls += 1; return orig(a, b); };
    try {
      calls = 0; await call(h(db), { body: { order_id: 'XPZ-g', tracking_token: 'wrong-token', reason: 'late', channel: 'inapp' } }); const present = calls;
      calls = 0; await call(h(db), { body: { order_id: 'XPZ-zzz', tracking_token: 'wrong-token', reason: 'late', channel: 'inapp' } }); const missing = calls;
      assert.ok(present === 1 && missing === 1, `🔴 equal comparison work on a missing vs a present order (${present} vs ${missing})`);
    } finally { crypto.timingSafeEqual = orig; }
    // a FAILED ticket write never burns capacity: its hold expires and the slot comes back
    const db2 = fakeDb(); await place(db2, A, 'XPZ-m');
    let t = 10_000; const ids = (() => { let i = 0; return () => `r${++i}`; })();
    const fn = h(db2, { now: () => t, newId: ids });
    const realUpdate = db2.ref; let failNext = 4;
    db2.ref = (p) => { const r = realUpdate(p); if (p === '' || p === undefined) return { ...r, update: async (m) => { if (failNext > 0) { failNext -= 1; throw new Error('write failed'); } return r.update(m); } }; return r; };
    for (let i = 0; i < 4; i++) assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 503, 'premise: the write fails');
    assert.strictEqual(tickets(db2).length, 0, 'nothing written');
    assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 200, 'one live slot remains while 4 holds are live');
    assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 429, '🔴 4 live holds + 1 committed = the cap (strict while holds live)');
    t += ST.HOLD_MS + 1;
    for (let i = 0; i < 4; i++) assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 200, '🔴 expired holds RETURN their capacity');
    assert.strictEqual((await call(fn, { token: `tok-${A}`, body: { order_id: 'XPZ-m', reason: 'late', channel: 'inapp' } })).code, 429, 'and the cap is 5 committed');
    assert.strictEqual(tickets(db2).length, 5); assert.strictEqual(Object.keys(db2.get('support_ticket_counts/XPZ-m/committed')).length, 5);
    assert.ok(!db2.get('support_ticket_counts/XPZ-m/held') || Object.values(db2.get('support_ticket_counts/XPZ-m/held')).every((at) => t - at >= ST.HOLD_MS), 'every committed ticket released its hold atomically');
    db2.ref = realUpdate;
  }
  ok('Codex S-F r1: the throttle (an explicit policy; per caller — a member uid, a guest\'s order) runs BEFORE the order read; a missing order costs the same comparison work; the per-order cap is a RECOVERABLE reservation committed atomically with the ticket — a failed write never burns capacity');

  FINISHED = true;
  console.log(`support-tickets: OK (${n})`);
})().catch((e) => { process.stderr.write(`support-tickets: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
