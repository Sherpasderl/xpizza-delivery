// D4-c4 "Pausar pedidos" — the order forms on the pause refusals (PLAN-D4c4 rev 13 §5). Run: node order-control-client.test.mjs
//
// Boots BOTH brands' real pages and sends through the real submit paths — cash (submitOrder → createOrder) and card
// (processPixelPay → chargeOnlineOrder). The charge request is answered with the body the SERVER builds
// (order-control-state.js REFUSALS — the module the handlers answer with), then every retry timer is allowed to run out.
//   423 ordering_paused → exactly ONE request, no new order id, the Spanish detail on screen; the cart, the order id
//                         (a second tap resends the SAME id) and a pending reward are kept.
//   503 (state unavailable) → card: one request + "Tuvimos un problema momentáneo, probá de nuevo."; cash: today's retry
//                         loop under the SAME id, then that copy.
//   OLD pages (e1aeb3f): the 423's Spanish `detail` reaches the card path; the cash path shows generic Spanish; neither
//                         mints or resends.
//   The unknown-outcome latch (sherpa-client): a 423 is a definitive answer for THAT request; a 503 stays latched; an
//                         earlier 202 in_progress stays latched when a later request gets the 423.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const S = require('./order-control-state');
const SC = require('../platform/client/sherpa-client.js');

const { ok, count } = counter();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const BACKOFF_MS = 1500 + 3000 + 600;
const PAUSED = S.REFUSALS.paused; const UNAV = S.REFUSALS.unavailable;
const UNAV_COPY = 'Tuvimos un problema momentáneo, probá de nuevo.';
const answer = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' && status === 503 ? '2' : null) }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), clone() { return this; } });

// the e1aeb3f pages, from git, beside their (unchanged) local scripts — loaded by the same harness
const OLD = {};
for (const dir of Object.keys(BRAND)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `oc-old-${dir}-`));
  for (const f of fs.readdirSync(path.join(ROOT, dir))) { const p = path.join(ROOT, dir, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(tmp, f)); }
  fs.writeFileSync(path.join(tmp, 'index.html'), execFileSync('git', ['show', `e1aeb3f:${dir}/index.html`], { cwd: ROOT, maxBuffer: 1 << 27 }));
  OLD[dir] = { rel: path.relative(ROOT, tmp), tmp };
}

// Boot a page, compose a cart, send ONCE through the real path. `plan` answers the charge requests in order (last repeats).
async function start(dir, method, plan, { reward = false, old = false } = {}) {
  const B = BRAND[dir];
  const w = loadForm(old ? OLD[dir].rel : dir);
  const sends = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (CHARGE_RE.test(url)) {
      const body = JSON.parse((init && init.body) || '{}');
      sends.push({ url, order_id: body.order_id, redeem: body.redeem });
      const [st, b] = plan[Math.min(sends.length - 1, plan.length - 1)];
      return answer(st, b);
    }
    return idle;
  };
  await settle();
  const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dish.id, 1);
  w.requestServerQuote();
  await settle();
  if (reward) {
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
  assert.ok(sends.length >= 1 && sends[0].url.includes(method === 'card' ? 'chargeOnlineOrder' : 'createOrder'), `${dir}/${method}: premise — the send reached the handler`);
  return { w, sends, dish, label: `${old ? 'OLD ' : ''}${dir}/${method}${reward ? '/reward' : ''}` };
}
// read-only: the cart is still there (buildOrder() would re-derive the pending order id, so it is NOT used after the send)
const cartKept = (s) => { const sig = JSON.parse(s.w.eval('cartSig()')); return Array.isArray(sig[0]) && sig[0].length > 0; };
const shown = (s, method) => {
  const el = s.w.document.getElementById(method === 'card' ? 'err3' : 'sending-msg');
  return el ? el.textContent : '';
};

// ── the unknown-outcome latch ────────────────────────────────────────────────────────────────────────────────────────
{
  const ID = { 'sherpa-app': 'orders', 'sherpa-deployment': 'orders-xpizza', 'sherpa-context': 'x_pizza', 'app-build': 'aaaa1111', 'app-compat': '1', 'sherpa-env': 'production' };
  const doc = { visibilityState: 'visible', body: { appendChild() {} }, querySelector(sel) { const m = sel.match(/^meta\[name="([^"]+)"\]$/); return m && ID[m[1]] !== undefined ? { getAttribute: () => ID[m[1]] } : null; }, createElement() { return { style: {}, setAttribute() {} }; }, addEventListener() {} };
  const mk = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, clone() { return mk(status, body); } });
  const rig = (plan) => {
    let i = 0;
    return SC.create({ window: { document: doc, sessionStorage: null, console: { warn() {} }, addEventListener() {} }, fetch: async () => plan[Math.min(i++, plan.length - 1)](), reload() {}, now: () => 1e12, random: () => 0.5, setTimeout: () => 0, setInterval: () => 0, autoStart: false });
  };
  const tick = () => new Promise((r) => setImmediate(r));
  const base = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';
  for (const ep of ['createOrder', 'chargeOnlineOrder']) {
    const c = rig([() => mk(PAUSED.status, { ...PAUSED.body })]);
    await c.fetch(base + ep, {}); for (let k = 0; k < 4; k++) await tick();
    assert.strictEqual(c.latch.size(), 0, `${ep}: 423 ordering_paused is DEFINITIVE for that request`);
    const u = rig([() => mk(UNAV.status, { ...UNAV.body })]);
    await u.fetch(base + ep, {}); for (let k = 0; k < 4; k++) await tick();
    assert.strictEqual(u.latch.size(), 1, `${ep}: the 503 stays latched (outcome unknown)`);
  }
  const l = rig([() => mk(202, { status: 'in_progress' }), () => mk(PAUSED.status, { ...PAUSED.body })]);
  await l.fetch(base + 'chargeOnlineOrder', {}); await l.fetch(base + 'chargeOnlineOrder', {}); for (let k = 0; k < 4; k++) await tick();
  assert.strictEqual(l.latch.size(), 1, '🔴 202 → 423: the earlier in-progress attempt STAYS latched — the later 423 clears only its own');
  ok('latch (sherpa-client): 423 ordering_paused is definitive for THAT request (cash + card); the 503 stays latched; 202 in_progress → 423 leaves the 202 attempt latched');
}

// ── the pages ─────────────────────────────────────────────────────────────────────────────────────────────────────
const runs = [];
for (const dir of Object.keys(BRAND)) {
  for (const method of ['cash', 'card']) {
    runs.push({ kind: 'paused', method, p: start(dir, method, [[PAUSED.status, { ...PAUSED.body }]]) });
    runs.push({ kind: 'paused-reward', method, p: start(dir, method, [[PAUSED.status, { ...PAUSED.body }]], { reward: true }) });
    runs.push({ kind: 'unavailable', method, p: start(dir, method, [[UNAV.status, { ...UNAV.body }]]) });
    runs.push({ kind: 'old-paused', method, p: start(dir, method, [[PAUSED.status, { ...PAUSED.body }]], { old: true }) });
  }
  runs.push({ kind: '202-then-423', method: 'card', p: start(dir, 'card', [[202, { status: 'in_progress' }], [PAUSED.status, { ...PAUSED.body }]]) });
}
const started = await Promise.all(runs.map((r) => r.p));
await new Promise((r) => setTimeout(r, BACKOFF_MS));   // every retry timer a page could arm has now run out
await settle();

const tally = {};
for (let i = 0; i < runs.length; i++) {
  const r = runs[i]; const s = started[i];
  const ids = s.sends.map((x) => x.order_id);
  const txt = shown(s, r.method);
  tally[r.kind] = (tally[r.kind] || 0) + 1;
  if (r.kind === 'paused' || r.kind === 'paused-reward') {
    assert.strictEqual(ids.length, 1, `🔴 ${s.label}: a 423 must NOT trigger any resend (saw ${ids.length}: ${ids})`);
    assert.ok(txt.includes(PAUSED.body.detail), `${s.label}: the Spanish detail is shown (${txt})`);
    assert.ok(cartKept(s), `${s.label}: the cart is kept`);
    if (r.kind === 'paused-reward') assert.ok(s.w.__ACCOUNT.getRedeemPayload(), `${s.label}: the pending reward is kept`);
    // a second tap: the SAME order id goes again (no mint), and the page is still usable
    const before = s.sends.length;
    const p = r.method === 'card' ? s.w.processPixelPay() : s.w.submitOrder('confirmed');
    if (p && p.catch) p.catch(() => {});
    await settle(); await settle();
    assert.strictEqual(s.sends.length, before + 1, `${s.label}: a second tap sends once more`);
    assert.strictEqual(s.sends[before].order_id, ids[0], `${s.label}: …under the SAME order id (kept, not re-minted)`);
  } else if (r.kind === 'unavailable') {
    if (r.method === 'card') {
      assert.strictEqual(ids.length, 1, `${s.label}: card 503 → one request`);
      assert.ok(txt.includes(UNAV_COPY), `${s.label}: "${UNAV_COPY}" (${txt})`);
    } else {
      assert.strictEqual(ids.length, 3, `${s.label}: cash 503 → today's retry loop (3 attempts)`);
      assert.strictEqual(new Set(ids).size, 1, `${s.label}: …all under the SAME order id`);
      assert.ok(txt.includes(UNAV_COPY), `${s.label}: then "${UNAV_COPY}" (${txt})`);
    }
    assert.ok(cartKept(s), `${s.label}: the cart is kept`);
  } else if (r.kind === 'old-paused') {
    assert.strictEqual(ids.length, 1, `🔴 ${s.label}: an OLD page must not resend on the 423 either (saw ${ids.length})`);
    if (r.method === 'card') assert.ok(txt.includes(PAUSED.body.detail), `${s.label}: the old card path shows the server's Spanish detail (${txt})`);
    else assert.ok(/No pudimos enviar el pedido/.test(txt), `${s.label}: the old cash path shows its generic Spanish copy (${txt})`);
  } else if (r.kind === '202-then-423') {
    assert.strictEqual(ids.length, 2, `${s.label}: the 202 wait-and-retry, then the 423 — no further resend`);
    assert.strictEqual(ids[0], ids[1], `${s.label}: the same order id`);
    assert.ok(txt.includes(PAUSED.body.detail), `${s.label}: the Spanish detail after the 202 → 423`);
  }
}
ok(`423 ordering_paused × cash + card × both brands (+ a pending reward): exactly ONE request after every retry timer, the Spanish detail on screen, the cart and the reward kept, and a second tap resends the SAME order id (${tally.paused + tally['paused-reward']} runs)`);
ok(`503 (pause state unavailable): card → one request + "${UNAV_COPY}"; cash → today's 3-attempt retry under the same id, then that copy (${tally.unavailable} runs)`);
ok(`OLD pages (e1aeb3f), both brands: no resend on the 423; the card path shows the server's Spanish detail, the cash path its generic Spanish copy (${tally['old-paused']} runs)`);
ok(`202 in_progress → 423 on the card path, both brands: one wait-and-retry under the same id, then the paused detail, nothing more (${tally['202-then-423']} runs)`);

closeAll();
for (const o of Object.values(OLD)) fs.rmSync(o.tmp, { recursive: true, force: true });
console.log(`\norder-control-client: OK (${count()})`);
