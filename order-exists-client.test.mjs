// D4-c5 phase 1 — the order forms do NOT auto-resubmit on the typed refusal (PLAN-D4c5 rev 6 §3/§5). Run: node order-exists-client.test.mjs
//
// Boots BOTH brands' real pages (unchanged in phase 1), composes a real cart, and sends through the real submit paths —
// cash (submitOrder → createOrder) and card (processPixelPay → chargeOnlineOrder). The first charge request is answered
// with a 409 whose body is built by the SERVER's own builder (order-exists.js — the module the handlers answer with),
// every later one with a 200. Then every timer the page could retry on is allowed to run out (the cash backoff is
// 1.5 s + 3 s), and the requests are counted.
//
//   CONTROL (reproduce the defect): today's literals — cash `order_conflict`, card `Order conflict` / `Order closed` —
//   make the page MINT a fresh order id and resend: 2 requests, 2 distinct ids. Without this every "1 request" below
//   would be vacuous.
//   CANDIDATE: `order_exists`, for EVERY reason in the closed enum, on both paths → exactly 1 request, no new id; the card
//   page shows the Spanish detail.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const OE = require('./order-exists');

const { ok, count } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const BACKOFF_MS = 1500 + 3000 + 300;   // the cash loop's two backoffs (attempt*1500), plus margin
const rej = (status, body) => Promise.resolve({ ok: false, status, headers: { get: () => null }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });

// Boot a page, compose a cart, send ONCE through the real path; resolve after the send has settled.
async function start(dir, method, first, { reward = false } = {}) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const sends = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (CHARGE_RE.test(url)) {
      const body = JSON.parse((init && init.body) || '{}');
      sends.push({ url, order_id: body.order_id, redeem: body.redeem });
      if (sends.length === 1) return rej(409, { ...first, ...(first.order_id === '<echo>' ? { order_id: body.order_id } : {}) });
      return res(/chargeOnlineOrder/.test(url) ? { ok: true, checkout_url: 'https://pay.test/ok', order_id: body.order_id } : { ok: true, order_id: body.order_id, tracking_token: 't' });
    }
    return idle;
  };
  await settle();
  const live = w.liveMenuGlobalGet('MENU');
  const dish = live.find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 1);
  w.requestServerQuote();
  await settle();
  if (reward) {
    // a pending reward installed through the page's OWN account module (the local customer marker + restoreRedeem +
    // requoteRedeem), so the confirmed-quote recovery sees a real reward-bearing send (its reward branch is the one that mints)
    try { w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_acct' : 'lamusa_acct', JSON.stringify({ uid: 'u-test', name: 'Cliente Prueba' })); } catch (_) {}
    w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { customerIdToken: () => Promise.resolve('test-id-token') });
    w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] }, null, null);
    await w.__ACCOUNT.requoteRedeem(w.redeemCartItems());
    await settle();
    assert.ok(w.__ACCOUNT.getRedeemPayload(), `${dir}/${method}: premise — a reward is active`);
  }
  assert.ok(w.buildOrder(), `${dir}/${method}: premise — a clean cart composes an order`);
  const p = method === 'card' ? (w.selectPay('online'), w.processPixelPay()) : w.submitOrder('confirmed');
  if (p && p.catch) p.catch(() => {});
  await settle(); await settle();
  if (reward) assert.ok(sends[0] && sends[0].redeem, `${dir}/${method}: premise — the send carries the redemption`);
  assert.ok(sends.length >= 1, `${dir}/${method}: premise — the send reached ${method === 'card' ? 'chargeOnlineOrder' : 'createOrder'}`);
  assert.ok(sends[0].url.includes(method === 'card' ? 'chargeOnlineOrder' : 'createOrder'), `${dir}/${method}: the right endpoint (${sends[0].url})`);
  return { w, sends, label: `${dir}/${method}/${first.error}/${first.reason || '-'}${reward ? '/reward' : ''}` };
}

const runs = [];
for (const dir of Object.keys(BRAND)) {
  // CONTROLS — today's literals (the bodies the f17466e handlers return)
  runs.push({ expect: 'mint', p: start(dir, 'cash', { error: 'order_conflict', reason: 'cart', order_id: '<echo>' }) });
  runs.push({ expect: 'mint', p: start(dir, 'card', { error: 'Order conflict', detail: 'order_id already used for a different cart/total', order_id: '<echo>' }) });
  runs.push({ expect: 'mint', p: start(dir, 'card', { error: 'Order closed', detail: 'order is cancelled; please start a new order', order_id: '<echo>' }) });
  // CANDIDATE — every reason of the closed enum, both paths, through the server's own body builder
  for (const reason of OE.ORDER_EXISTS_REASONS) {
    for (const method of ['cash', 'card']) runs.push({ expect: 'once', p: start(dir, method, { ...OE.orderExistsBody(reason, 'x'), order_id: '<echo>' }) });
  }
  // …and with a reward pending (the confirmed-quote recovery must not mint on it either)
  for (const method of ['cash', 'card']) runs.push({ expect: 'once', p: start(dir, method, { ...OE.orderExistsBody('cart', 'x'), order_id: '<echo>' }, { reward: true }) });
}
const started = await Promise.all(runs.map((r) => r.p));
await new Promise((r) => setTimeout(r, BACKOFF_MS));   // every retry timer the pages could have armed has now run out
await settle();

let mints = 0; let onces = 0;
started.forEach((s, i) => {
  const ids = s.sends.map((x) => x.order_id);
  if (runs[i].expect === 'mint') {
    assert.strictEqual(s.sends.length, 2, `${s.label}: CONTROL — today's literal makes the page resend (${ids})`);
    assert.notStrictEqual(ids[0], ids[1], `${s.label}: CONTROL — …under a FRESH order id (the defect)`);
    mints += 1;
  } else {
    assert.strictEqual(s.sends.length, 1, `🔴 ${s.label}: order_exists must NOT trigger any resubmission (saw ${s.sends.length}: ${ids})`);
    if (s.label.includes('/card/')) {
      const err = s.w.document.getElementById('err3');
      assert.ok(err && err.textContent.includes(OE.ORDER_EXISTS_DETAIL), `${s.label}: the card page shows the Spanish detail (${err && err.textContent})`);
    }
    onces += 1;
  }
});
ok(`CONTROL: today's literals (cash order_conflict; card Order conflict / Order closed) make BOTH brands' pages mint a fresh id and resend — ${mints} runs, 2 requests / 2 distinct ids each`);
ok(`order_exists × every reason of the closed enum × cash and card × both brands (+ a pending reward): exactly ONE request after every retry timer ran out — no mint, no resend (${onces} runs); the card page shows the Spanish detail`);

closeAll();
console.log(`\norder-exists-client: OK (${count()})`);
