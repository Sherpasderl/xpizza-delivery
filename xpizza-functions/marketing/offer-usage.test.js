'use strict';
// PLAN-5f-marketing-price r0 step 2 — the offer USAGE: counted at placement (a cap never over-runs), released on cancel, exactly once.
//   marketing_usage/{offerId} = { redemptions, spend_cents, week: { key, redemptions, spend_cents }, orders, sales_cents, new_customers }
//   (3a §2.2). The offer ctx is the REAL offerFor output over 3a's REAL writers; the RTDB has production's transaction semantics.
// Run: node marketing/offer-usage.test.js
const assert = require('assert');
const { world, NOW } = require('../test/_marketing-price-seed');
const OP = require('./offer-price');
const CFG = require('./config');
const OU = require('./offer-usage');
const { weekOf } = require('../driver-ledger/ledger-core');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ offer-usage: exited without completing\n'); process.exitCode = 1; } });

const RID = 'tb_centro'; const MENU = { i_aaaaaaaaaaaa: 200 };
const TABLES = { restaurantId: RID, menu: MENU, extras: {} };
const items = [{ name: 'i_aaaaaaaaaaaa', qty: 2, extras: [] }];   // L 400
const T = NOW + 3600000; const WEEK = 7 * 86400000;
async function offered(caps) {
  const w = await world({ rid: RID, menu: MENU });
  const id = await w.publish({ type: 'lps', params: { off_cents: 5000, min_cents: 20000 }, caps: { redemptions: null, spend_cents: null, weekly: false, ...caps } });
  const offer = OP.offerFor({ cfg: await CFG.readMarketingConfig(w.db), live: w.fake.get(`marketing_live/${RID}`), nowMs: T, items, rid: RID, tables: TABLES, baseTotalL: 400 });
  assert.ok(offer && offer.offer_id === id, 'premise: the REAL offer ctx');
  return { w, id, offer };
}
const usage = (w, id) => w.fake.get(`marketing_usage/${id}`);
const SALES = 35000;   // the paid food of the order (L 400 − L 50)

(async () => {
  await cell('OU-HOLD: a hold counts one redemption, the spend (the discount), one order and its paid food — in the HN week bucket', async (L) => {
    const { w, id, offer } = await offered({});
    const h = await OU.holdCounters(w.db, offer, { salesCents: SALES, nowMs: T });
    assert.deepStrictEqual(h, { ok: true, week: weekOf(T) }, L);
    assert.deepStrictEqual(usage(w, id), { redemptions: 1, spend_cents: 5000, week: { key: weekOf(T), redemptions: 1, spend_cents: 5000 }, orders: 1, sales_cents: SALES, new_customers: 0 }, L);
    await OU.holdCounters(w.db, offer, { salesCents: SALES, nowMs: T + WEEK });
    assert.deepStrictEqual(usage(w, id).week, { key: weekOf(T + WEEK), redemptions: 1, spend_cents: 5000 }, `${L}: a new week starts its own bucket`);
    assert.strictEqual(usage(w, id).redemptions, 2, `${L}: the total keeps counting`);
  });
  await cell('OU-CAP: the redemptions cap and the spend cap are never exceeded (≥ refuses, nothing written); weekly caps read the current week only', async (L) => {
    const a = await offered({ redemptions: 2 });
    assert.ok((await OU.holdCounters(a.w.db, a.offer, { salesCents: SALES, nowMs: T })).ok, L);
    assert.ok((await OU.holdCounters(a.w.db, a.offer, { salesCents: SALES, nowMs: T })).ok, `${L}: the 2nd = the cap`);
    const before = JSON.stringify(usage(a.w, a.id));
    assert.deepStrictEqual(await OU.holdCounters(a.w.db, a.offer, { salesCents: SALES, nowMs: T }), { ok: false, reason: 'cap' }, `${L}: the 3rd refused`);
    assert.strictEqual(JSON.stringify(usage(a.w, a.id)), before, `${L}: nothing written`);
    const s = await offered({ spend_cents: 10000 });
    assert.ok((await OU.holdCounters(s.w.db, s.offer, { salesCents: SALES, nowMs: T })).ok && (await OU.holdCounters(s.w.db, s.offer, { salesCents: SALES, nowMs: T })).ok, `${L}: spend L 100 = 2 × L 50`);
    assert.strictEqual((await OU.holdCounters(s.w.db, s.offer, { salesCents: SALES, nowMs: T })).ok, false, `${L}: the spend cap`);
    const k = await offered({ redemptions: 1, weekly: true });
    assert.ok((await OU.holdCounters(k.w.db, k.offer, { salesCents: SALES, nowMs: T })).ok, L);
    assert.strictEqual((await OU.holdCounters(k.w.db, k.offer, { salesCents: SALES, nowMs: T })).ok, false, `${L}: weekly cap this week`);
    assert.ok((await OU.holdCounters(k.w.db, k.offer, { salesCents: SALES, nowMs: T + WEEK })).ok, `${L}: next week resets`);
  });
  await cell('OU-RACE: cap 1 and two holds in flight ⇒ exactly one wins', async (L) => {
    const { w, id, offer } = await offered({ redemptions: 1 });
    const r = await Promise.all([OU.holdCounters(w.db, offer, { salesCents: SALES, nowMs: T }), OU.holdCounters(w.db, offer, { salesCents: SALES, nowMs: T })]);
    assert.deepStrictEqual(r.map((x) => x.ok).sort(), [false, true], L);
    assert.strictEqual(usage(w, id).redemptions, 1, L);
  });
  await cell('OU-ORDER: holdForOrder (the card path, the pending order exists) counts ONCE per order — a retried gate does not count again; a released order is refused', async (L) => {
    const { w, id, offer } = await offered({});
    w.fake.put('orders/o1/offer', OP.frozenOf(offer));
    assert.deepStrictEqual(await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T }), { ok: true }, L);
    assert.deepStrictEqual(await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T }), { ok: true }, `${L}: the retry`);
    assert.strictEqual(usage(w, id).redemptions, 1, `${L}: counted once`);
    assert.deepStrictEqual([w.fake.get('orders/o1/offer/usage'), w.fake.get('orders/o1/offer/usage_week'), w.fake.get('orders/o1/offer/usage_sales_cents')], ['held', weekOf(T), SALES], `${L}: the order flag`);
    await OU.releaseForOrder(w.db, 'o1');
    assert.strictEqual((await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T })).ok, false, `${L}: a released (cancelled) order is never counted again`);
  });
  await cell('OU-RELEASE: a cancel releases exactly once — the totals, and the week bucket only while it is still that week; never-held / double release ⇒ no-op', async (L) => {
    const { w, id, offer } = await offered({});
    for (const o of ['o1', 'o2']) { w.fake.put(`orders/${o}/offer`, OP.frozenOf(offer)); await OU.holdForOrder(w.db, o, offer, { salesCents: SALES, nowMs: T }); }
    assert.strictEqual(usage(w, id).redemptions, 2, 'premise');
    assert.strictEqual(await OU.releaseForOrder(w.db, 'o1'), true, L);
    assert.strictEqual(await OU.releaseForOrder(w.db, 'o1'), false, `${L}: the 2nd release`);
    assert.deepStrictEqual(usage(w, id), { redemptions: 1, spend_cents: 5000, week: { key: weekOf(T), redemptions: 1, spend_cents: 5000 }, orders: 1, sales_cents: SALES, new_customers: 0 }, L);
    w.fake.put('marketing_usage/' + id + '/week', { key: weekOf(T + WEEK), redemptions: 3, spend_cents: 15000 });   // a later week is current
    await OU.releaseForOrder(w.db, 'o2');
    assert.deepStrictEqual([usage(w, id).redemptions, usage(w, id).week], [0, { key: weekOf(T + WEEK), redemptions: 3, spend_cents: 15000 }], `${L}: a past week's order leaves the current bucket alone`);
    w.fake.put('orders/o3/offer', OP.frozenOf(offer));
    assert.strictEqual(await OU.releaseForOrder(w.db, 'o3'), false, `${L}: never held`);
    assert.strictEqual(await OU.releaseForOrder(w.db, 'nope'), false, `${L}: no order`);
  });
  await cell('OU-UNHOLD: the cash write failed after the hold ⇒ the counters are given back (no order exists to flag)', async (L) => {
    const { w, id, offer } = await offered({});
    const h = await OU.holdCounters(w.db, offer, { salesCents: SALES, nowMs: T });
    await OU.unholdCounters(w.db, offer, { salesCents: SALES, week: h.week });
    assert.deepStrictEqual(usage(w, id), { redemptions: 0, spend_cents: 0, week: { key: weekOf(T), redemptions: 0, spend_cents: 0 }, orders: 0, sales_cents: 0, new_customers: 0 }, L);
  });
  await cell('OU-GATE: afterGate passes a refusal / no offer through untouched; a cap after an accepted gate ⇒ 409 offer_changed and the reward hold released', async (L) => {
    const { w, offer } = await offered({ redemptions: 1 });
    w.fake.put('orders/o1/offer', OP.frozenOf(offer)); w.fake.put('orders/o2/offer', OP.frozenOf(offer));
    const refused = { refuse: { status: 409, body: { error: 'quote_invalid' } }, provenance: null, result: {} };
    assert.strictEqual(await OU.afterGate({ db: w.db, orderId: 'o1', offer, salesCents: SALES, releaseHold: async () => { throw new Error('no'); } }, refused), refused, `${L}: a refusal`);
    const accepted = { refuse: null, provenance: { quote_id: 'q' }, result: {} };
    assert.strictEqual(await OU.afterGate({ db: w.db, orderId: 'o1', offer: null, salesCents: SALES, releaseHold: async () => {} }, accepted), accepted, `${L}: no offer`);
    assert.strictEqual(await OU.afterGate({ db: w.db, orderId: 'o1', offer, salesCents: SALES, nowMs: T, releaseHold: async () => {} }, accepted), accepted, `${L}: held`);
    let released = 0;
    const capped = await OU.afterGate({ db: w.db, orderId: 'o2', offer, salesCents: SALES, nowMs: T, releaseHold: async () => { released += 1; } }, accepted);
    assert.deepStrictEqual([capped.refuse, released], [{ status: 409, body: { error: 'offer_changed', order_id: 'o2' } }, 1], L);
  });

  await cell('OU-FAILED: a definitive decline releases as «released_failed» (counters back); a retry of that order RE-HOLDS exactly once; a cancel («released») stays terminal', async (L) => {
    const { w, id, offer } = await offered({});
    w.fake.put('orders/o1/offer', OP.frozenOf(offer));
    await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T });
    assert.strictEqual(await OU.releaseForOrder(w.db, 'o1', { to: 'released_failed' }), true, L);
    assert.deepStrictEqual([w.fake.get('orders/o1/offer/usage'), usage(w, id).redemptions, usage(w, id).spend_cents], ['released_failed', 0, 0], `${L}: released, counters back`);
    assert.strictEqual(await OU.releaseForOrder(w.db, 'o1', { to: 'released_failed' }), false, `${L}: a second decline releases nothing`);
    assert.deepStrictEqual(await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T }), { ok: true }, `${L}: the retry re-holds`);
    assert.deepStrictEqual(await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T }), { ok: true }, `${L}: its retried gate`);
    assert.deepStrictEqual([w.fake.get('orders/o1/offer/usage'), usage(w, id).redemptions], ['held', 1], `${L}: counted exactly once again`);
    assert.strictEqual(await OU.releaseForOrder(w.db, 'o1'), true, `${L}: then cancelled`);
    assert.strictEqual((await OU.holdForOrder(w.db, 'o1', offer, { salesCents: SALES, nowMs: T })).ok, false, `${L}: a cancelled order never re-holds`);
    const c = await offered({ redemptions: 1 });
    c.w.fake.put('orders/o2/offer', OP.frozenOf(c.offer)); c.w.fake.put('orders/o3/offer', OP.frozenOf(c.offer));
    await OU.holdForOrder(c.w.db, 'o2', c.offer, { salesCents: SALES, nowMs: T });
    await OU.releaseForOrder(c.w.db, 'o2', { to: 'released_failed' });
    await OU.holdForOrder(c.w.db, 'o3', c.offer, { salesCents: SALES, nowMs: T });   // another order took the one use meanwhile
    assert.strictEqual((await OU.holdForOrder(c.w.db, 'o2', c.offer, { salesCents: SALES, nowMs: T })).ok, false, `${L}: the retry meets the cap ⇒ refused (offer_changed upstream)`);
  });

  FINISHED = true;
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`offer-usage: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
