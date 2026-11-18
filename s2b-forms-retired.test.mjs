// S2b (PLAN-structure-S2b-r3 §6; Codex S2b r1 P2-6) — the FROZEN order forms (rule 40: never edited) on the admission gate's refusal.
// Boots BOTH brands' real pages and sends through the real submit paths — cash (submitOrder → createOrder) and card (processPixelPay →
// chargeOnlineOrder) — answered with the server's exact refusal (catalog/client-retired.js: 410 { error: 'client_retired' }), then every
// retry timer is allowed to run out. Proves: exactly ONE request (no resend, no new order id) and NO success screen; the existing generic
// error path is what the customer sees. Run: node s2b-forms-retired.test.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const SW = { on: true };
{ const p = require.resolve('./catalog/extra-identity'); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, extraIdentityCapabilities: () => ({ mintExtras: SW.on }) } }; }
const { retiredClientRefusal } = require('./catalog/client-retired');
const RETIRED = retiredClientRefusal({ app: 'orders', deployment: 'orders-xpizza' });   // the server's OWN answer for a stamped form (switch ON)
assert.deepStrictEqual(RETIRED, { status: 410, body: { error: 'client_retired' } }, 'premise: the server refuses a stamped form');

const { ok } = counter();
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const BACKOFF_MS = 1500 + 3000 + 600;
const answer = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });

async function start(dir, method) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const sends = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (CHARGE_RE.test(url)) { const body = JSON.parse((init && init.body) || '{}'); sends.push({ url, order_id: body.order_id }); return answer(RETIRED.status, { ...RETIRED.body }); }
    return idle;
  };
  await settle();
  const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 1);
  w.requestServerQuote();
  await settle();
  assert.ok(w.buildOrder(), `${dir}/${method}: premise — a clean cart composes an order`);
  const p = method === 'card' ? (w.selectPay('online'), w.processPixelPay()) : w.submitOrder('confirmed');
  if (p && p.catch) p.catch(() => {});
  await settle(); await settle();
  assert.ok(sends.length >= 1 && sends[0].url.includes(method === 'card' ? 'chargeOnlineOrder' : 'createOrder'), `${dir}/${method}: premise — the send reached the handler`);
  return { w, sends, label: `${dir}/${method}` };
}

const runs = [];
for (const dir of Object.keys(BRAND)) for (const method of ['cash', 'card']) runs.push(start(dir, method));
const started = await Promise.all(runs);
await new Promise((r) => setTimeout(r, BACKOFF_MS));   // every retry timer a page could arm has now run out
await settle();
for (const s of started) {
  assert.strictEqual(s.sends.length, 1, `🔴 ${s.label}: a 410 client_retired must NOT trigger any resend (saw ${s.sends.length})`);
  const s5 = s.w.document.getElementById('s5');   // showSuccess() → showStage('s5') — the success stage
  assert.ok(s5, `${s.label}: premise — the page has the success stage`);
  assert.ok(!s5.classList.contains('active'), `🔴 ${s.label}: no success stage`);
}
ok(`410 client_retired × cash + card × both brands: exactly ONE request after every retry timer, no success — the forms' existing generic error path (${started.length} runs)`);
closeAll();
console.log('s2b-forms-retired: OK');
process.exit(0);
