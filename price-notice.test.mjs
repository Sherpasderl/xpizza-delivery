// PLAN 5 — the cart price-change notice (owner-approved mockup v2, DECISIONS 2026-10-26), on BOTH forms, through the REAL
// paths: a live apply through the form's own applier, the real cart sheet / pay-step renderers, the real send gates.
// Run: node price-notice.test.mjs
//   eligible (repriced dish only) → no block, notice + struck old subtotal, adopted at the visible moment only;
//   persistence across re-renders; removal clears; never adopted without a moment;
//   ineligible (mixed / unavailable / option / resume / reward) → today's block, nothing adopted;
//   a mixed cart re-evaluates after the blocking line is removed;
//   failure injection (renderer throws, notice not shown) → rolled back, both send endpoints still refuse;
//   the ORACLE: an adopted cart sends exactly what the same cart freshly added at the new price sends (cash + card,
//   items / items_text / total / orderFingerprint / chargeInputsFingerprint / the server total from the served menu).
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, serve, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { orderFingerprint } = require('./pixelpay-charge');
const { chargeInputsFingerprint } = require('./catalog/charge-inputs');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('price-notice: FAILED — watchdog'); process.exit(1); }, 300000);
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// showStage cross-fades: the swap (and the pay-step moment inside it) runs on transitionend or a 170 ms fallback
const toStage = async (w, id, pct) => { w.showStage(id, pct); await sleep(260); await settle(); };

// per brand: X (repriced) and Y (a second plain dish), the option toggle on X, and the pricing-key rules
const CASES = {
  'xpizza-orders': { X: 2, Y: 19, extra: (w) => w.toggleDetailExtra('e4', 2, 0), extraId: 'e4', dishKey: (d) => d.name, extraKey: (e) => e.name },
  'la-musa-orders': { X: 'dimsum_02', Y: 'dimsum_05', extra: (w) => w.chgDetailExtra('rice_white', 'dimsum_02', 1), extraId: 'rice_white', dishKey: (d) => String(d.id), extraKey: (e) => String(e.id) },
};
const tablesOf = (rid, menu, c) => ({ restaurantId: rid, menu: Object.fromEntries(menu.dishes.map((d) => [c.dishKey(d), d.price])), extras: Object.fromEntries((menu.extras || []).map((e) => [c.extraKey(e), e.price])) });

function respondWith(w, rid, getMenu, c, sent) {
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(rid, getMenu()));
    const body = JSON.parse((init && init.body) || '{}');
    if (url.includes('quoteOrder')) { const t = computeServerTotal(body.items, rid, tablesOf(rid, getMenu(), c)); return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) }); }
    if (CHARGE_RE.test(url)) { sent.push({ url, body }); return res(url.includes('chargeOnlineOrder') ? { ok: true, checkout_url: 'https://pay.test/checkout', order_id: body.order_id, poll_token: 'poll_tok_123' } : { ok: true }); }
    return new Promise(() => {});
  };
}
async function boot(dir) {
  const B = BRAND[dir], c = CASES[dir];
  const w = loadForm(dir);
  await settle();
  let menu = B.menu(w);
  await serve(w, envelope(B.rid, menu));
  const sent = [];
  respondWith(w, B.rid, () => menu, c, sent);
  const reprice = (changes) => {        // a publish: the live menu moves, through the form's own applier
    const next = JSON.parse(JSON.stringify(menu));
    for (const [id, field, value] of changes) {
      const coll = field === 'extra' ? next.extras : next.dishes;
      coll.find((r) => String(r.id) === String(id)).price = value;
    }
    menu = next;
    return w.__liveMenu.applier.apply(plain(next));
  };
  return { w, B, c, sent, reprice, menuNow: () => menu };
}
const priceOf = (w, id) => w.eval('MENU').find((d) => String(d.id) === String(id)).price;
const err = (w) => { const e = w.document.getElementById('err3') || w.document.getElementById('err1'); return e ? e.textContent : ''; };
const noticeIn = (w, sel) => { const n = w.document.querySelector(`${sel} .price-change-notice`); return n ? n.textContent : null; };
const expected = (name, from, to) => `Cambió el precio de ${name}: antes L ${from}, ahora L ${to}.`;
async function send(w, sent, path) {
  const before = sent.length;
  w.selectPay(path === 'cash' ? 'cash' : 'online');
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `premise — the cart composes an order (${path})`);
  if (path === 'cash') { try { await w.submitOrder('confirmed'); } catch (_) {} } else { const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
  await settle(); await settle();
  assert.strictEqual(sent.length, before + 1, `premise — one ${path} request left the page`);
  return sent[sent.length - 1].body;
}

for (const dir of Object.keys(CASES)) {
  // ── 1. ELIGIBLE: one repriced dish → disclosed at the cart sheet, adopted, no block ──
  {
    const { w, c, reprice } = await boot(dir);
    w.chg(c.X, 1); await settle();
    const from = priceOf(w, c.X), name = w.eval('MENU').find((d) => String(d.id) === String(c.X)).name;
    assert.strictEqual(reprice([[c.X, 'dish', from + 26]]), 'applied', 'premise: the publish applied');
    assert.deepStrictEqual(plain(w.eval('CART.disclosed()')), [], `${dir}: 🔴 NOTHING is adopted until a visible moment (the apply alone adopts nothing)`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), true, `${dir}: …and until then the send is refused exactly as today`);
    w.renderStage2Summary(); w.chg(c.Y, 1); w.chg(c.Y, -1); await settle();   // a HIDDEN summary refresh + a quantity change elsewhere
    assert.deepStrictEqual(plain(w.eval('CART.disclosed()')), [], `${dir}: 🔴 a hidden summary refresh or another line's quantity change NEVER adopts`);
    w.document.getElementById('err1') && (w.document.getElementById('err1').style.display = 'none');
    w.openCartReview(); await settle();
    assert.strictEqual(noticeIn(w, '#cart-review-body'), expected(name, from, from + 26), `${dir}: the notice, exact copy, in the cart sheet`);
    const was = w.document.querySelector('#cart-review-body s.price-change-was');
    assert.ok(was && was.textContent === `L ${from}` && was.classList.contains('price-change-was--stacked'), `${dir}: the struck OLD subtotal, stacked`);
    assert.strictEqual(w.document.getElementById('cart-review-total').textContent, `L ${from + 26}`, `${dir}: the total is the new price`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), false, `${dir}: 🔴 NO checkout block once disclosed`);
    // persistence: a later re-render, a quantity change on another line, the pay-step render
    w.chg(c.Y, 1); await settle(); w.updateCartReviewBody();
    assert.strictEqual(noticeIn(w, '#cart-review-body'), expected(name, from, from + 26), `${dir}: the notice SURVIVES a later re-render and another line's quantity change`);
    w.closeCartReview(); await toStage(w, 's2', 66);
    assert.strictEqual(w.document.getElementById('s2-price-notice').hidden, false, `${dir}: the pay step shows the notice slot`);
    assert.strictEqual(noticeIn(w, '#s2-price-notice'), expected(name, from, from + 26), `${dir}: …with the same notice`);
    assert.ok(w.document.querySelector('#s2-summary s.price-change-was:not(.price-change-was--stacked)'), `${dir}: the summary strikes the old subtotal INLINE`);
    w.renderStage2Summary();
    assert.strictEqual(noticeIn(w, '#s2-price-notice'), expected(name, from, from + 26), `${dir}: a summary re-render keeps it`);
    // removal clears
    await toStage(w, 's1', 33);
    w.openCartReview(); await settle();
    w.chgFromCart(c.X, -1); await settle();
    assert.deepStrictEqual(plain(w.eval('CART.disclosed()')), [], `${dir}: removing the dish removes its disclosure`);
    assert.strictEqual(noticeIn(w, '#cart-review-body'), null, `${dir}: …and its notice line`);
    ok(`${dir}: a repriced dish is adopted ONLY at the visible moment, with the exact notice + struck old subtotal; no block; survives re-renders; removal clears`);
  }

  // ── 2. qty 2: the struck value is the OLD SUBTOTAL at the same quantity (advisor ruling (a)) ──
  {
    const { w, c, reprice } = await boot(dir);
    w.chg(c.X, 1); w.chg(c.X, 1); await settle();
    const from = priceOf(w, c.X);
    reprice([[c.X, 'dish', from + 10]]);
    w.openCartReview(); await settle();
    assert.strictEqual(w.document.querySelector('#cart-review-body s.price-change-was').textContent, `L ${2 * from}`, `${dir}: qty 2 → the struck value is the old SUBTOTAL (2 × old unit)`);
    assert.ok(noticeIn(w, '#cart-review-body').includes(`antes L ${from}, ahora L ${from + 10}`), `${dir}: …while the notice keeps UNIT prices`);
    ok(`${dir}: qty 2 — struck = the old subtotal; the notice keeps unit prices`);
  }

  // ── 3. INELIGIBLE → today's block, byte-identical message, nothing adopted ──
  const todayCase = async (label, setup) => {
    const { w, c, reprice } = await boot(dir);
    w.chg(c.X, 1); await settle();
    const from = priceOf(w, c.X);
    const extraChanges = await setup(w, c);
    reprice([[c.X, 'dish', from + 7], ...(extraChanges || [])]);
    w.openCartReview(); await settle();
    w.closeCartReview(); await toStage(w, 's2', 66);
    assert.deepStrictEqual(plain(w.eval('CART.disclosed()')), [], `${dir} ${label}: 🔴 nothing adopted`);
    assert.strictEqual(w.document.getElementById('s2-price-notice').hidden, true, `${dir} ${label}: no notice`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), true, `${dir} ${label}: the send is refused`);
    assert.ok(/^Algunos productos de tu carrito cambiaron: |^Agotado: |^Estamos actualizando tu premio\./.test(err(w)), `${dir} ${label}: one of today's block messages (${err(w)})`);
    return w;
  };
  await todayCase('repriced + UNAVAILABLE', async (w, c) => { w.isSoldOut = (rec) => !!rec && String(rec.id) === String(c.X); });
  await todayCase('repriced dish + repriced OPTION', async (w, c) => { c.extra(w); await settle(); const ex = w.eval('EXTRAS').find((e) => String(e.id) === c.extraId); return [[c.extraId, 'extra', ex.price + 5]]; });
  await todayCase('payment RESUME pending', async (w) => { w.__resumeOrderId = 'ORD-resume-1'; });
  await todayCase('a REWARD attached', async (w) => { w.__ACCOUNT = Object.assign({}, w.__ACCOUNT, { getRedeemPayload: () => ({ type: 'points_ala_carte', items: [] }) }); });
  ok(`${dir}: repriced+unavailable, +option reprice, a pending resume, an attached reward → today's block, nothing adopted`);

  // ── 4. MIXED: a repriced dish + a dish gone from the menu → today's block; removing the gone one discloses the rest ──
  {
    const { w, B, c, reprice, menuNow } = await boot(dir);
    w.chg(c.X, 1); w.chg(c.Y, 1); await settle();
    const from = priceOf(w, c.X);
    const next = JSON.parse(JSON.stringify(menuNow()));
    next.dishes.find((d) => String(d.id) === String(c.X)).price = from + 9;
    next.dishes = next.dishes.filter((d) => String(d.id) !== String(c.Y));
    assert.strictEqual(w.__liveMenu.applier.apply(next), 'applied', 'premise: the publish (reprice X, remove Y) applied');
    w.openCartReview(); await settle();
    assert.deepStrictEqual(plain(w.eval('CART.disclosed()')), [], `${dir} mixed: nothing adopted while another line blocks`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), true, `${dir} mixed: today's block`);
    w.chgFromCart(c.Y, -1); await settle();                     // the cart's EXISTING remove control path
    assert.strictEqual(plain(w.eval('CART.disclosed()')).length, 1, `${dir} mixed: once the gone dish is removed, the repriced one is disclosed`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), false, `${dir} mixed: …and the send proceeds`);
    void B;
    ok(`${dir}: a mixed cart keeps today's block and re-evaluates after the blocking line is removed`);
  }

  // ── 5. FAILURE INJECTION: the final render fails → rolled back; BOTH send endpoints still refuse ──
  for (const [label, inject] of [
    ['the renderer throws', (w) => { const real = w.updateCartReviewBody; let n = 0; w.updateCartReviewBody = function () { if (n++ === 1) throw new Error('boom');   /* call 0 = openCartReview's own pre-open render; call 1 = the FINAL render inside the moment */ return real.apply(this, arguments); }; }],
    ['the notice does not render', (w) => { w.priceNoticeHtml = () => ''; }],
  ]) {
    const { w, c, reprice, sent } = await boot(dir);
    w.chg(c.X, 1); await settle();
    reprice([[c.X, 'dish', priceOf(w, c.X) + 3]]);
    inject(w);
    w.openCartReview(); await settle();
    assert.deepStrictEqual(plain(w.eval('CART.disclosed()')), [], `${dir} (${label}): 🔴 rolled back — nothing disclosed`);
    for (const path of ['cash', 'card']) {
      w.selectPay(path === 'cash' ? 'cash' : 'online');
      assert.strictEqual(w.buildOrder(), false, `${dir} (${label}) ${path}: the line is still repriced → the order cannot compose`);
      if (path === 'cash') { try { await w.submitOrder('confirmed'); } catch (_) {} } else { const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
      await settle();
    }
    assert.strictEqual(sent.length, 0, `${dir} (${label}): no request left the page on either endpoint`);
  }
  ok(`${dir}: a failed final render (throw / notice missing) rolls back; cash and card both still refuse`);

  // ── 6. THE ORACLE: adopted cart ≡ the same cart freshly added at the new price (cash + card) ──
  for (const path of ['cash', 'card']) {
    const a = await boot(dir);
    a.w.chg(a.c.X, 1); await settle(); a.c.extra(a.w); await settle();
    const from = priceOf(a.w, a.c.X);
    a.reprice([[a.c.X, 'dish', from + 21]]);
    await toStage(a.w, 's2', 66);      // disclosed at the pay step
    assert.strictEqual(plain(a.w.eval('CART.disclosed()')).length, 1, `premise — adopted at the pay step (${path})`);
    const adopted = await send(a.w, a.sent, path);

    const f = await boot(dir);
    f.reprice([[f.c.X, 'dish', from + 21]]);                       // the new price is on the menu BEFORE the customer adds
    f.w.chg(f.c.X, 1); await settle(); f.c.extra(f.w); await settle();
    await toStage(f.w, 's2', 66);
    const fresh = await send(f.w, f.sent, path);

    for (const k of ['items', 'items_text', 'total', 'payment_method', 'expected_net_cents']) assert.deepStrictEqual(adopted[k], fresh[k], `${dir} ${path}: 🔴 ${k} differs between the adopted and the fresh cart`);
    assert.strictEqual(orderFingerprint('O', Math.round(Number(adopted.total) * 100), adopted.items_text), orderFingerprint('O', Math.round(Number(fresh.total) * 100), fresh.items_text), `${dir} ${path}: orderFingerprint`);
    assert.strictEqual(chargeInputsFingerprint({ ...adopted, order_id: 'O' }), chargeInputsFingerprint({ ...fresh, order_id: 'O' }), `${dir} ${path}: chargeInputsFingerprint`);
    const st = computeServerTotal(adopted.items, BRAND[dir].rid, tablesOf(BRAND[dir].rid, a.menuNow(), a.c));
    assert.ok(!st.error && st.total === Number(adopted.total), `${dir} ${path}: the server total from the served menu equals the displayed/sent total (${st.total} vs ${adopted.total})`);
  }
  ok(`${dir}: ORACLE — an adopted cart sends exactly what the fresh cart at the new price sends (items, items_text, total, net, both fingerprints, server total), cash and card`);
}

closeAll();
clearTimeout(WATCHDOG);
console.log('\nprice-notice: OK');
process.exit(0);
