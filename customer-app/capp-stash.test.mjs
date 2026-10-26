// Customer app S2a (PLAN-capp-S2-r4 §5.2 Stash, §7 Stash) — the pay stash in the minimal LEGACY shape { order_id, t, order, form, ts }
// under the config's storage_keys.pending_pay, BOTH directions with the REAL live form pages (the form harness boots each page's
// own index.html in jsdom):
//   app → form   a stash the app wrote is resumed by the page's OWN handlePaymentReturn: the order id and poll token come from it
//                (the return URL carries neither), the page polls with them, shows the paid outcome and removes the stash
//   form → app   a stash built by the page's OWN writer expression (currentOrder + snapshotForm(), as its card path stashes) is
//                resumed by the app's handleReturn, polled with its token, and cleared
// Unresolved creds survive a cart discard and a reload (the app never touches the stash outside the clearing outcomes). Light.
// Run: node --test customer-app/capp-stash.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = require('./capp-api.js');
const C = require('./capp-checkout.js');
const { loadForm, settle, res, BRAND, closeAll } = await import(join(ROOT, 'form-harness.mjs'));
after(() => closeAll());

const E = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus' };
const memStorage = (from) => { const m = from || new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };

for (const dir of Object.keys(BRAND)) {
  const B = BRAND[dir];
  const KEY = B.config.storage_keys.pending_pay;

  test(`${dir}: app → form — the page's own handlePaymentReturn resumes a stash the APP wrote`, async () => {
    // the app writes its stash through its REAL card path (a scripted checkout response)
    const storage = memStorage();
    const api = A.createApi({ config: { restaurantId: B.rid, orderIdPrefix: B.config.order_id_prefix, pendingPayKey: KEY, endpoints: E, hours: null },
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ checkout_url: 'https://pay.test/x', poll_token: 'pt_app', attempt_id: 'a1' }) }), storage, sleep: async () => {},
      setInterval: () => 0, clearInterval: () => {} });
    const f = C.freshFlow(null); C.setPin(f, 15.5, -88, true); Object.assign(f, { details: 'Portón', name: 'Ana', phone: '99990000', pay: 'online' });
    const out = await api.place({ flow: f, ctx: { restaurantId: B.rid, items: [{ id: 'x', name: 'X', qty: 1, price: 100, subtotal: 100, extras: [], extrasTotal: 0 }], itemsText: '1x X (L100)', member: null }, sig: 's', expectedNetCents: 10000 });
    assert.equal(out.kind, 'redirect');
    const stash = storage.getItem(KEY);
    assert.ok(stash, 'premise: the app stashed under the config key');
    // the REAL old page, with that stash, returning WITHOUT order / t in the URL
    const w = loadForm(dir);
    const polls = [];
    w.__respond = (url) => { if (url.includes('paymentStatus')) { polls.push(url); return res({ ok: true, state: 'paid', tracking_token: null, total_cents: 10000 }); } return new Promise(() => {}); };
    w.localStorage.setItem(KEY, stash);
    await settle();
    w.history.replaceState(null, '', '/?pay=complete');
    const handled = await w.handlePaymentReturn();
    assert.equal(handled, true, 'the page handled the return');
    assert.equal(polls.length, 1, 'it polled once');
    const q = new URL(polls[0]).searchParams;
    assert.deepEqual([q.get('order_id'), q.get('t')], [out.order_id, 'pt_app'], '🔴 the page took the order id AND the poll token from the APP\'s stash');
    assert.equal(w.localStorage.getItem(KEY), null, 'paid ⇒ the page removed this order\'s stash');
  });

  test(`${dir}: form → app — the app's handleReturn resumes a stash built by the page's OWN writer expression`, async () => {
    const w = loadForm(dir);
    await settle();
    // the page's card path stashes { order_id, t, order: currentOrder, form: snapshotForm(), ts } (its own expression, its own functions)
    const pageStash = w.eval(`JSON.stringify({ order_id: 'XP-PAGE-0001', t: 'pt_page', order: (typeof currentOrder !== 'undefined' ? currentOrder : null), form: snapshotForm(), ts: Date.now() })`);
    const storage = memStorage(); storage.setItem(KEY, pageStash);
    const polls = [];
    const api = A.createApi({ config: { restaurantId: B.rid, orderIdPrefix: B.config.order_id_prefix, pendingPayKey: KEY, endpoints: E, hours: null },
      fetch: async (url) => { polls.push(url); return { status: 200, ok: true, json: async () => ({ ok: true, state: 'paid', tracking_token: 'tk' }) }; }, storage, sleep: async () => {},
      setInterval: () => 0, clearInterval: () => {} });
    assert.equal(api.credsFor('XP-PAGE-0001'), 'pt_page', 'the app reads the page\'s creds');
    const outcome = await api.handleReturn('?pay=complete');
    assert.deepEqual([outcome.kind, outcome.order_id], ['placed', 'XP-PAGE-0001']);
    const q = new URL(polls[0]).searchParams;
    assert.deepEqual([q.get('order_id'), q.get('t')], ['XP-PAGE-0001', 'pt_page'], '🔴 the app polled with the PAGE\'s order id and token');
    assert.equal(storage.getItem(KEY), null, 'placed ⇒ cleared');
  });
}

test('unresolved creds survive a cart discard and a reload (only a clearing outcome removes them)', async () => {
  const storage = memStorage();
  const mk = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'k_pending_pay', endpoints: E, hours: null },
    fetch: async (url) => (url.includes('charge') ? { status: 200, ok: true, json: async () => ({ checkout_url: 'u', poll_token: 'pt' }) } : { status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) }),
    storage, sleep: async () => {}, setInterval: () => 0, clearInterval: () => {} });
  const f = C.freshFlow(null); C.setPin(f, 15.5, -88, true); Object.assign(f, { details: 'Portón', name: 'Ana', phone: '99990000', pay: 'online' });
  const out = await mk().place({ flow: f, ctx: { restaurantId: 'rid_a', items: [], itemsText: 'x', member: null }, sig: 's', expectedNetCents: 1 });
  // a cart discard is the host's; the app keeps nothing of the cart — a reload is a new instance over the same storage
  const reloaded = mk();
  assert.deepEqual([reloaded.credsFor(out.order_id), !!reloaded.readPlace()], ['pt', true], 'creds + placement survive the reload');
  const pend = await reloaded.handleReturn(`?pay=cancel&order=${out.order_id}&t=pt`);
  assert.equal(pend.kind, 'payment_failed');
  assert.equal(reloaded.credsFor(out.order_id), 'pt', 'a cancel return (state pending) never discards the creds');
});
