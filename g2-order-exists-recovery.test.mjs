// PLAN-G2 — the typed `409 order_exists` refusal → a recovery screen (both forms). Run: node g2-order-exists-recovery.test.mjs
//
// Every cell boots the REAL page (form-harness), composes a real cart, selects the payment method BEFORE buildOrder()
// (payment is part of cartSig, as in the real checkout) and sends through the real path — cash (submitOrder → createOrder)
// and card (processPixelPay → chargeOnlineOrder). Refusal bodies are built by the SERVER's own orderExistsBody.
//   1  every reason × cash/card × reward/no reward: ONE request; the recovery screen (spinner + #sending-msg hidden);
//      #oe-ref = the last 4 of the SENT id; the contact href = the page's own WhatsApp number + a prefill of the full id
//      only; body.detail nowhere in the DOM; err3 unused
//   2  Back → s2 (spinner restored, controls unlocked) → rebuild/send: (a) a second order_exists → the same screen, the
//      SAME id (ordinary path, golden); (b) success (card: the stash is written; cash: s5), no recovery visible; (c) another
//      error → its own message; (d) GOLDEN, pre-existing: reward → price_increased accepted → refused → Back → a FRESH id
//   3  predicate negatives: other 409s / a non-409 order_exists / malformed bodies never show the screen
//   4  controls: Already paid → success; the legacy literals still heal (order-exists-client.test.mjs CONTROL)
//   5  serialization: a multi-line cart with an extra and a reward → refused → Back → resend: identical items + pin
//   6  a third brand with no contact line → the screen renders, the contact button is hidden (computed display:none)
//   7  the module, pure: isOrderExists / orderRef / storeContactHref
//   8  the two copies are byte-identical
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { counter, settle, stageSettle, envelope, loadForm, res, serve, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const OE = require('./order-exists');
const OEX = require('../xpizza-orders/form-order-exists.js');
const { ok, count } = counter();
const WATCHDOG = setTimeout(() => { console.error('g2-order-exists-recovery: FAILED — watchdog'); process.exit(1); }, 300000);
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const BACKOFF_MS = 1500 + 3000 + 300;
const STASH = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
const WA = { 'xpizza-orders': 'https://wa.me/50497952893', 'la-musa-orders': 'https://wa.me/50493736607' };
const rej = (status, body) => Promise.resolve({ ok: false, status, headers: { get: () => null }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
const okFor = (url, body) => res(/chargeOnlineOrder/.test(url) ? { ok: true, checkout_url: 'https://pay.test/ok', order_id: body.order_id, poll_token: 'poll_tok_123' } : { ok: true, order_id: body.order_id, tracking_token: 'trk_tok_12345678' });

// Boot a page; `reply(n, url, body)` answers the n-th charge request (1-based).
async function boot(dir, reply, { reward = false } = {}) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  const sent = [];
  const idle = new Promise(() => {});
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (CHARGE_RE.test(url)) {
      const body = JSON.parse((init && init.body) || '{}');
      sent.push({ url, body });
      return reply(sent.length, url, body);
    }
    return idle;
  };
  await settle();
  const live = w.liveMenuGlobalGet('MENU');
  const dishes = live.filter((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  w.chg(dishes[0].id, 1);
  w.requestServerQuote();
  await settle();
  if (reward) {
    try { w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_acct' : 'lamusa_acct', JSON.stringify({ uid: 'u-test', name: 'Cliente Prueba' })); } catch (_) {}
    w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { customerIdToken: () => Promise.resolve('test-id-token') });
    w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] }, null, null);
    await w.__ACCOUNT.requoteRedeem(w.redeemCartItems());
    await settle();
    assert.ok(w.__ACCOUNT.getRedeemPayload(), `${dir}: premise — a reward is active`);
  }
  return { w, sent, dishes };
}
async function send(w, method) {
  w.selectPay(method === 'card' ? 'online' : 'cash');
  assert.ok(w.buildOrder(), 'premise — the cart composes an order');
  const p = method === 'card' ? w.processPixelPay() : w.submitOrder('confirmed');
  if (p && p.catch) p.catch(() => {});
  await settle(); await settle(); await stageSettle();   // showStage cross-dissolves (170 ms fallback)
}
const view = (w) => {
  const d = w.document;
  const st = d.querySelector('.stage.active');
  return {
    stage: st && st.id,
    block: !d.getElementById('order-exists-recovery').hidden,
    spinner: !d.querySelector('#s4 .spinner').hidden && !d.getElementById('sending-msg').hidden && !d.getElementById('sending-msg').parentElement.hidden,
    ref: d.getElementById('oe-ref').textContent,
    href: d.getElementById('oe-contact').getAttribute('href'),
    contactHidden: d.getElementById('oe-contact').hidden,
    err3: d.getElementById('err3').style.display === 'block' ? d.getElementById('err3').textContent : null,
    text: d.body.textContent,
  };
};
const back = async (w) => { w.document.getElementById('oe-back').click(); await stageSettle(); };
const prefill = (dir, id) => `${WA[dir]}?text=${encodeURIComponent(`Hola, tengo un problema con mi pedido ${id}.`)}`;

// ── 7. the module, pure ──
{
  const T = OEX.isOrderExists;
  assert.strictEqual(T(409, { error: 'order_exists' }), true);
  assert.strictEqual(T(409, { error: 'order_exists', reason: 'something_new' }), true, 'no reason check');
  for (const [s, b] of [[400, { error: 'order_exists' }], [200, { error: 'order_exists' }], [409, { error: 'order_conflict' }], [409, { error: 'Order conflict' }], [409, null], [409, 'order_exists'], [409, []], [409, undefined], [409, {}]]) assert.strictEqual(T(s, b), false, `${s} ${JSON.stringify(b)}`);
  assert.strictEqual(OEX.orderRef('PZX-251014-120000-abcd7kqm'), '#7KQM');
  assert.strictEqual(OEX.orderRef('ab'), '#AB');
  for (const v of ['', null, undefined, 42, {}]) assert.strictEqual(OEX.orderRef(v), '');
  const docWith = (href) => ({ querySelector: () => (href == null ? null : { getAttribute: () => href }) });
  assert.strictEqual(OEX.storeContactHref(docWith('https://wa.me/50412345678'), 'ID-1'), 'https://wa.me/50412345678?text=' + encodeURIComponent('Hola, tengo un problema con mi pedido ID-1.'));
  assert.strictEqual(OEX.storeContactHref(docWith('https://wa.me/50412345678?text=old'), 'ID-1').split('?text=')[0], 'https://wa.me/50412345678', 'an existing query is replaced');
  assert.strictEqual(OEX.storeContactHref(docWith(null), 'ID-1'), null, 'no link → null');
  assert.strictEqual(OEX.storeContactHref(docWith('https://wa.me/evil.example'), 'ID-1'), null, 'only a numeric wa.me link');
  ok('module: isOrderExists is exactly (409, error order_exists); orderRef = # + last 4 uppercased ("" otherwise); the contact href is ONLY the page\'s numeric wa.me link + the fixed prefill with the full id');
}
// ── 8. same bytes ──
assert.strictEqual(readFileSync(new URL('./xpizza-orders/form-order-exists.js', import.meta.url), 'utf8'), readFileSync(new URL('./la-musa-orders/form-order-exists.js', import.meta.url), 'utf8'), 'the two copies are byte-identical');
ok('form-order-exists.js: the X. Pizza and La Musa copies are byte-identical');

for (const dir of Object.keys(BRAND)) {
  // ── 1. every reason × cash/card × reward/no reward ──
  {
    const runs = [];
    for (const reason of OE.ORDER_EXISTS_REASONS) for (const method of ['cash', 'card']) for (const reward of [false, true]) {
      runs.push((async () => {
        const b = await boot(dir, (n, url, body) => rej(409, OE.orderExistsBody(reason, body.order_id)), { reward });
        assert.ok(b.w.OrderExists && typeof b.w.OrderExists.renderOrderExists === 'function', `${dir}: the module is loaded`);
        await send(b.w, method);
        return { ...b, label: `${dir}/${method}/${reason}${reward ? '/reward' : ''}`, method };
      })());
    }
    const done = await Promise.all(runs);
    await new Promise((r) => setTimeout(r, BACKOFF_MS)); await settle();
    for (const s of done) {
      assert.strictEqual(s.sent.length, 1, `${s.label}: exactly one request`);
      const id = s.sent[0].body.order_id;
      const v = view(s.w);
      assert.strictEqual(v.stage, 's4', `${s.label}: stage s4`);
      assert.ok(v.block && !v.spinner, `${s.label}: the recovery screen, the spinner/message hidden`);
      assert.strictEqual(v.ref, OEX.orderRef(id), `${s.label}: the reference is the sent id's last 4`);
      assert.strictEqual(v.href, prefill(dir, id), `${s.label}: the page's own number + the full id`);
      assert.ok(!v.text.includes(OE.ORDER_EXISTS_DETAIL), `${s.label}: body.detail is never displayed`);
      assert.strictEqual(v.err3, null, `${s.label}: err3 is not used`);
      assert.strictEqual(s.w.eval('orderSubmitting'), false, `${s.label}: the send is unlocked`);
    }
    ok(`${dir}: order_exists × every reason × cash/card × reward/none (${done.length} runs): one request; the recovery screen with #ABCD of the sent id, the store's own WhatsApp + the full id; no server detail; err3 unused`);
  }
  // ── 2. Back → s2 → rebuild/send ──
  for (const method of ['cash', 'card']) {
    // (a) a second refusal → the same screen, the SAME id
    {
      const { w, sent } = await boot(dir, (n, url, body) => rej(409, OE.orderExistsBody('cart', body.order_id)));
      await send(w, method);
      await back(w);
      let v = view(w);
      assert.ok(v.stage === 's2' && !v.block && v.spinner, `${dir}/${method}: Back → s2, the block hidden, the spinner restored`);
      assert.strictEqual(w.document.getElementById('progress').style.width, '50%', `${dir}/${method}: Back → the progress bar at s2's 50%`);
      assert.strictEqual(w.eval('orderSubmitting'), false);
      assert.strictEqual(w.document.getElementById('btn-pay').disabled, false, 'the pay button is enabled');
      await send(w, method);
      v = view(w);
      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[1].body.order_id, sent[0].body.order_id, `${dir}/${method}: GOLDEN — the ordinary path resends the SAME id`);
      assert.ok(v.block && v.stage === 's4', `${dir}/${method}: the same screen again`);
    }
    // (b) Back → success
    {
      const { w, sent } = await boot(dir, (n, url, body) => (n === 1 ? rej(409, OE.orderExistsBody('cart', body.order_id)) : okFor(url, body)));
      await send(w, method);
      await back(w);
      await send(w, method);
      await stageSettle();
      const v = view(w);
      assert.strictEqual(sent.length, 2);
      assert.ok(!v.block, `${dir}/${method}: no recovery block after success`);
      if (method === 'card') {
        const st = JSON.parse(w.localStorage.getItem(STASH[dir]) || 'null');
        assert.ok(st && st.order_id === sent[1].body.order_id && st.t === 'poll_tok_123', `${dir}/card: the success path stashes the order (redirect)`);
      } else assert.strictEqual(v.stage, 's5', `${dir}/cash: success → s5`);
    }
    // (c) Back → another error → its own message
    {
      const { w } = await boot(dir, (n, url, body) => (n === 1 ? rej(409, OE.orderExistsBody('cart', body.order_id)) : rej(400, { error: 'item_unavailable', blocked: ['Pizza Rara'] })));
      await send(w, method);
      await back(w);
      await send(w, method);
      await new Promise((r) => setTimeout(r, BACKOFF_MS)); await stageSettle();
      const v = view(w);
      assert.ok(!v.block, `${dir}/${method}: no recovery block for item_unavailable`);
      assert.ok(/Pizza Rara/.test(v.text), `${dir}/${method}: item_unavailable shows its own message`);
    }
  }
  ok(`${dir}: Back → s2 (block hidden, spinner + controls restored) → (a) a second refusal: the same screen and the SAME id (golden); (b) success: card stash / cash s5, no block; (c) item_unavailable: its own message — cash and card`);

  // (e) a NEW send started while the recovery screen is up (no Back — e.g. a retry path) never shows a stale screen: in
  // flight, the spinner and the sending message are back and the block is hidden
  for (const method of ['cash', 'card']) {
    const { w, sent } = await boot(dir, (n, url, body) => (n === 1 ? rej(409, OE.orderExistsBody('cart', body.order_id)) : new Promise(() => {})));
    await send(w, method);
    assert.ok(view(w).block, 'premise: the recovery screen is up');
    await send(w, method);
    assert.strictEqual(sent.length, 2, 'premise: the second send is in flight');
    const v = view(w);
    assert.ok(!v.block && v.spinner && v.stage === 's4', `${dir}/${method}: in flight → the sending view, never the stale recovery screen`);
  }
  ok(`${dir}: a new send started from the recovery screen (no Back) shows the sending view in flight, never the stale screen — cash and card`);

  // (d) GOLDEN, pre-existing: reward → price_increased accepted → order_exists → Back → rebuild → a FRESH id
  for (const method of ['cash', 'card']) {
    const { w, sent } = await boot(dir, (n, url, body) => (n === 1 ? rej(409, { error: 'price_increased', net_total_cents: 31900 }) : rej(409, OE.orderExistsBody('cart', body.order_id))), { reward: true });
    w.__ACCOUNT.getRedeemQuoteTotalCents = () => 29900;
    w.__ACCOUNT.redeemQuoteMatches = () => true;
    await send(w, method);
    const sheet = w.document.querySelector('.cq-sheet');
    assert.ok(sheet && sent[0].body.redeem, `${dir}/${method}: premise — the increase sheet for a reward order`);
    const bs = [...sheet.querySelectorAll('button')]; bs[bs.length - 1].click();
    await settle(); await settle();
    assert.strictEqual(sent.length, 2, `${dir}/${method}: premise — the accepted increase resent`);
    assert.notStrictEqual(sent[1].body.order_id, sent[0].body.order_id, 'premise: the quote recovery minted (pre-existing)');
    assert.ok(view(w).block, `${dir}/${method}: the resend refused → the recovery screen`);
    await back(w);
    await send(w, method);
    assert.strictEqual(sent.length, 3);
    assert.notStrictEqual(sent[2].body.order_id, sent[1].body.order_id, `${dir}/${method}: GOLDEN (pre-existing, not fixed by G2) — the rebuild after a quote-recovery mint mints again`);
  }
  ok(`${dir}: GOLDEN (pre-existing) — reward → price_increased accepted (mint) → order_exists → Back → rebuild mints a FRESH id, cash and card`);

  // ── 3. predicate negatives ──
  {
    const cases = [
      ['card', 409, { error: 'Already paid' }], ['cash', 409, { error: 'order_conflict', reason: 'cart' }], ['card', 409, { error: 'Order conflict' }],
      ['card', 409, { error: 'choice_required' }], ['card', 409, { error: 'redemption_reserve_failed', reason: 'cart_unverifiable' }],
      ['cash', 409, { error: 'redemption_reserve_failed', reason: 'cart_unverifiable' }],
      ['cash', 400, OE.orderExistsBody('cart', 'x')], ['card', 400, OE.orderExistsBody('cart', 'x')],
      ['cash', 409, null], ['card', 409, null], ['card', 409, ['order_exists']], ['cash', 409, 'order_exists'],
    ];
    const runs = await Promise.all(cases.map(async ([method, status, body]) => {
      const b = await boot(dir, (n, url, rb) => (n === 1 ? rej(status, body) : okFor(url, rb)));
      await send(b.w, method);
      return { ...b, label: `${dir}/${method}/${status}/${JSON.stringify(body)}` };
    }));
    await new Promise((r) => setTimeout(r, BACKOFF_MS)); await stageSettle();
    for (const r of runs) assert.ok(!view(r.w).block, `${r.label}: NOT the recovery screen`);
    const paid = runs[0];
    assert.strictEqual(view(paid.w).stage, 's5', `${paid.label}: Already paid → success (unchanged control)`);
    ok(`${dir}: predicate negatives (Already paid / order_conflict / Order conflict / choice_required / redemption_reserve_failed·cart_unverifiable / a 400 order_exists / null, array, string bodies) never show the screen; Already paid still → success`);
  }

  // ── 5. serialization: multi-line + extra + reward → refused → Back → resend: identical items and pin ──
  for (const method of ['cash', 'card']) {
    const B = BRAND[dir];
    const w = loadForm(dir);
    const sent = [];
    await settle();
    const menu = B.menu(w);
    await serve(w, envelope(B.rid, menu));
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, menu));
      if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
      if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
      if (CHARGE_RE.test(url)) { const body = JSON.parse((init && init.body) || '{}'); sent.push({ url, body }); return rej(409, OE.orderExistsBody('cart', body.order_id)); }
      return new Promise(() => {});
    };
    const C = dir === 'xpizza-orders' ? { X: 2, Y: 19, extra: (x) => x.toggleDetailExtra('e4', 2, 0) } : { X: 'dimsum_01', Y: 'dimsum_03', extra: (x) => x.chgDetailExtra('rice_white', 'dimsum_01', 1) };
    w.chg(C.Y, 1); await settle(); w.chg(C.X, 1); await settle(); C.extra(w); await settle();
    try { w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_acct' : 'lamusa_acct', JSON.stringify({ uid: 'u-test', name: 'Cliente Prueba' })); } catch (_) {}
    w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { customerIdToken: () => Promise.resolve('test-id-token') });
    w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] }, null, null);
    await w.__ACCOUNT.requoteRedeem(w.redeemCartItems()); await settle();
    w.requestServerQuote(); await settle();
    await send(w, method);
    const pin1 = JSON.stringify(w.eval('typeof SERIAL !== "undefined" && SERIAL.current ? SERIAL.current() : null'));
    await back(w);
    await send(w, method);
    assert.strictEqual(sent.length, 2, `${dir}/${method}: premise — two sends`);
    assert.ok(sent[0].body.items.length >= 2 && sent[0].body.redeem, `${dir}/${method}: premise — multi-line + reward`);
    assert.ok(sent[0].body.items.some((it) => (Array.isArray(it.extras) && it.extras.length) || (Array.isArray(it.options) && it.options.length)), `${dir}/${method}: premise — an extra is on the wire ${JSON.stringify(sent[0].body.items)}`);
    assert.deepStrictEqual(sent[1].body.items, sent[0].body.items, `${dir}/${method}: the outgoing items (order included) are identical after Back`);
    assert.strictEqual(sent[1].body.items_text, sent[0].body.items_text);
    assert.strictEqual(JSON.stringify(w.eval('typeof SERIAL !== "undefined" && SERIAL.current ? SERIAL.current() : null')), pin1, `${dir}/${method}: the serialization pin is unchanged`);
  }
  ok(`${dir}: a multi-line cart with an extra and a reward → refused → Back → resend: identical items (order included), items_text and serialization pin — cash and card`);

  // ── 6. a third brand: no contact line → the screen renders, the contact button is hidden despite display:flex ──
  {
    const { w, sent } = await boot(dir, (n, url, body) => rej(409, OE.orderExistsBody('cart', body.order_id)));
    w.document.querySelectorAll('.contact-line').forEach((e) => e.remove());
    await send(w, 'cash');
    const c = w.document.getElementById('oe-contact');
    assert.ok(view(w).block, 'the screen renders');
    assert.strictEqual(c.hidden, true);
    assert.strictEqual(w.getComputedStyle(c).display, 'none', 'computed display:none despite the a.oe-contact display:flex rule');
    assert.strictEqual(c.getAttribute('href'), null);
    assert.strictEqual(view(w).ref, OEX.orderRef(sent[0].body.order_id));
    ok(`${dir}: a page with no contact line (a third brand) → the screen renders and the contact button is hidden (computed display:none)`);
  }
}

// ── 9. (codex build r1 P2-1) a RESUMED order: the stash restored through SERIAL.resume with a saved order DIFFERENT from the
// restored insertion order, an extra and a reward → refused → Back → resend: the saved order and the pin are kept ──
// The PRE-§3 page (git 03bc399) serialized in MENU order, so its stash's saved order DIFFERS from the cart's insertion
// order — the realistic resumed-order case (cart-serial-order.test.mjs §4 uses the same page). Removed on exit.
const OLD_SHA = '03bc399';
const ROOT = fileURLToPath(new URL('./', import.meta.url));
const OLD_DIR = 'node_modules/.g2-old-client';
function materializeOld(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', OLD_SHA, `${dir}/`], { encoding: 'utf8' }).split('\n').filter((f) => /\.(html|js)$/.test(f));
  assert.ok(files.includes(`${dir}/index.html`), `premise: ${OLD_SHA} has ${dir}/index.html`);
  mkdirSync(`${ROOT}${OLD_DIR}/${dir}`, { recursive: true });
  for (const f of files) writeFileSync(`${ROOT}${OLD_DIR}/${f}`, execFileSync('git', ['-C', ROOT, 'show', `${OLD_SHA}:${f}`]));
}
process.on('exit', () => { try { rmSync(`${ROOT}${OLD_DIR}`, { recursive: true, force: true }); } catch (_) {} try { rmdirSync(`${ROOT}node_modules`); } catch (_) {} });
const SER = { 'xpizza-orders': { X: 2, Y: 19, extra: (w) => w.toggleDetailExtra('e4', 2, 0) }, 'la-musa-orders': { X: 'dimsum_01', Y: 'dimsum_03', extra: (w) => w.chgDetailExtra('rice_white', 'dimsum_01', 1) } };
const STASHKEY = STASH;
async function realCheckoutStash(dir) {
  const B = BRAND[dir]; const C = SER[dir];
  materializeOld(dir);
  const w = loadForm(`${OLD_DIR}/${dir}`); await settle();   // the stash is written by the PRE-§3 page itself
  const menu = B.menu(w); await serve(w, envelope(B.rid, menu));
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, menu));
    if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (url.includes('chargeOnlineOrder')) { const b = JSON.parse((init && init.body) || '{}'); return res({ ok: true, checkout_url: 'https://pay.test/c', order_id: b.order_id, poll_token: 'tokRES_123456' }); }
    return new Promise(() => {});
  };
  w.chg(C.Y, 1); await settle(); w.chg(C.X, 1); await settle(); C.extra(w); await settle();   // insertion order: Y, then X (+ its extra)
  try { w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_acct' : 'lamusa_acct', JSON.stringify({ uid: 'u-test', name: 'Cliente Prueba' })); } catch (_) {}
  w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { customerIdToken: () => Promise.resolve('test-id-token') });
  w.__ACCOUNT.restoreRedeem({ type: 'points_ala_carte', items: [{ id: 'rw1', qty: 1, name: 'Premio' }] }, null, null);
  await w.__ACCOUNT.requoteRedeem(w.redeemCartItems()); await settle();
  w.requestServerQuote(); await settle();
  w.selectPay('online'); assert.ok(w.buildOrder());
  const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
  for (let i = 0; i < 40 && !w.localStorage.getItem(STASHKEY[dir]); i++) await new Promise((r) => setTimeout(r, 25));
  const raw = w.localStorage.getItem(STASHKEY[dir]); assert.ok(raw, `${dir}: premise — the real checkout stashed`);
  return { raw, stash: JSON.parse(raw), menu };
}
for (const dir of Object.keys(BRAND)) {
  const B = BRAND[dir];
  const { raw, stash, menu } = await realCheckoutStash(dir);
  const savedNames = stash.order.items.map((it) => it.name);
  assert.ok(stash.order.redeem, `${dir}: premise — the stashed order carries the reward`);
  assert.ok(stash.order.items.some((it) => (Array.isArray(it.extras) && it.extras.length) || (Array.isArray(it.options) && it.options.length)), `${dir}: premise — the stashed order carries the extra`);
  for (const method of ['cash', 'card']) {
    const w = loadForm(dir); await settle();
    await serve(w, envelope(B.rid, menu));
    const sent = [];
    w.__respond = (url, init) => {
      if (url.includes('/menu/')) return res(envelope(B.rid, menu));
      if (url.includes('paymentStatus')) return res({ ok: true, state: 'pending' });   // a genuine cancel → "Pago cancelado"
      if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
      if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
      if (CHARGE_RE.test(url)) { const b = JSON.parse((init && init.body) || '{}'); sent.push({ url, body: b }); return rej(409, OE.orderExistsBody('cart', b.order_id)); }
      return new Promise(() => {});
    };
    w.localStorage.setItem(STASHKEY[dir], raw);
    try { w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_acct' : 'lamusa_acct', JSON.stringify({ uid: 'u-test', name: 'Cliente Prueba' })); } catch (_) {}   // the same signed-in customer returns
    w.history.replaceState({}, '', `/?pay=cancel&order=${encodeURIComponent(stash.order_id)}`);
    await w.handlePaymentReturn(); await stageSettle();
    w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { customerIdToken: () => Promise.resolve('test-id-token'), getRedeemQuoteTotalCents: () => 1, redeemQuoteMatches: () => true });
    w.restoreOrderForm(); await settle(); await stageSettle();   // "Volver a intentar" → the cart restored + SERIAL.resume on the saved items
    const pin0 = JSON.stringify(w.eval('SERIAL.current()'));
    const resumedId = w.__resumeOrderId;
    assert.strictEqual(resumedId, stash.order_id, `${dir}/${method}: premise — the stash's id is resumed`);
    const insertionKeys = w.eval('resolvedCartLines()').map((l) => String(l.key));
    const pinKeys = JSON.parse(pin0);
    assert.ok(Array.isArray(pinKeys) && pinKeys.length === insertionKeys.length, `${dir}/${method}: premise — the resume pinned every line (${pin0})`);
    assert.notDeepStrictEqual(pinKeys, insertionKeys, `${dir}/${method}: premise — the RESUMED pin (${pinKeys}) DIFFERS from the restored insertion order (${insertionKeys}), so a re-mint would change the wire`);
    await send(w, method);
    assert.ok(view(w).block, `${dir}/${method}: premise — refused`);
    await back(w);
    await send(w, method);
    assert.strictEqual(sent.length, 2, `${dir}/${method}: two sends`);
    assert.deepStrictEqual(sent[0].body.items.map((it) => it.name), savedNames, `${dir}/${method}: the first send serializes the SAVED order (SERIAL.resume)`);
    assert.deepStrictEqual(sent[1].body.items, sent[0].body.items, `${dir}/${method}: after Back the resend keeps the saved order (no re-mint of the pin)`);
    assert.strictEqual(sent[1].body.order_id, resumedId, `${dir}/${method}: the resumed id is kept`);
    assert.ok(sent[1].body.redeem, `${dir}/${method}: the reward is still on the wire`);
    assert.strictEqual(JSON.stringify(w.eval('SERIAL.current()')), pin0, `${dir}/${method}: the serialization pin is unchanged`);
  }
  ok(`${dir}: a RESUMED order (a real checkout stash written by the PRE-§3 page 03bc399, menu-ordered → cancel return → "Volver a intentar" → SERIAL.resume; saved order ≠ restored insertion order; an extra + a reward) → refused → Back → resend keeps the saved order, the id, the reward and the pin — cash and card`);
}

// ── 10. (codex build r1 P2-2) the REAL processPayment() wrapper: locked while pending, unlocked after the refusal, and a
// later success NAVIGATES (card: window.location.href = checkout_url; cash: s5) ──
for (const dir of Object.keys(BRAND)) for (const method of ['cash', 'card']) {
  const B = BRAND[dir]; const w = loadForm(dir);
  let release; const gateP = new Promise((r) => { release = r; });
  const sent = [];
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (CHARGE_RE.test(url)) {
      const b = JSON.parse((init && init.body) || '{}'); sent.push(b);
      if (sent.length === 1) return gateP.then(() => rej(409, OE.orderExistsBody('cart', b.order_id)));
      return okFor(url, b);
    }
    return new Promise(() => {});
  };
  await settle();
  const d = w.liveMenuGlobalGet('MENU').find((x) => x.price > 0 && !x.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(x)));
  w.chg(d.id, 1); w.requestServerQuote(); await settle();
  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'c@t.hn']]) if (g(id)) g(id).value = v;
  if (typeof w.setOrderType === 'function') w.setOrderType('pickup');
  w.selectPay(method === 'card' ? 'online' : 'cash');
  const p1 = w.processPayment(); if (p1 && p1.catch) p1.catch(() => {});
  await settle(); await settle();
  assert.strictEqual(sent.length, 1, `${dir}/${method}: premise — the send is in flight`);
  assert.ok(w.__paySubmitting === true && g('btn-pay').disabled === true, `${dir}/${method}: LOCKED while pending (__paySubmitting + the pay button disabled)`);
  const again = w.processPayment(); if (again && again.catch) again.catch(() => {});
  await settle();
  assert.strictEqual(sent.length, 1, `${dir}/${method}: a re-tap while pending sends nothing`);
  release(); await p1; await stageSettle();
  assert.ok(view(w).block, `${dir}/${method}: the refusal shows the recovery screen`);
  assert.ok(w.__paySubmitting === false && g('btn-pay').disabled === false && w.eval('orderSubmitting') === false, `${dir}/${method}: UNLOCKED after the refusal`);
  await back(w);
  const navBefore = w.__jsdomErrors.filter((m) => /navigation/i.test(m)).length;
  const p2 = w.processPayment(); if (p2 && p2.catch) p2.catch(() => {});
  await p2; await settle(); await stageSettle();
  assert.strictEqual(sent.length, 2, `${dir}/${method}: the later send went out`);
  if (method === 'card') {
    const nav = w.__jsdomErrors.filter((m) => /navigation/i.test(m)).length;
    assert.strictEqual(nav, navBefore + 1, `${dir}/card: the success NAVIGATES (window.location.href = checkout_url; jsdom reports the navigation)`);
    assert.ok(JSON.parse(w.localStorage.getItem(STASH[dir]) || 'null'), `${dir}/card: …after stashing the order`);
  } else assert.strictEqual(view(w).stage, 's5', `${dir}/cash: the success shows the confirmation (s5)`);
  assert.ok(!view(w).block, `${dir}/${method}: no recovery screen after the success`);
}
ok('the REAL processPayment() wrapper (codex build r1 P2-2), both brands × cash/card: LOCKED while pending (and a re-tap sends nothing), UNLOCKED after the order_exists refusal, and a later success NAVIGATES (card: location.href → the checkout, after the stash; cash: s5)');

clearTimeout(WATCHDOG);
closeAll();
console.log(`\ng2-order-exists-recovery: OK (${count()})`);
