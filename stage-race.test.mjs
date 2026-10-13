// showStage — THE LAST CALL WINS (a live lost-sale path, diagnosed 2026-10-12). showStage(X) cross-dissolves: it defers
// the swap ~170 ms, but swaps AT ONCE when X is already the active stage — and nothing used to cancel a swap still pending.
// So a fast A → B → A ended on B: tap Pagar (s2 → s4, deferred), the charge fails instantly (offline: "Failed to fetch")
// → paymentFallback → showStage('s2') swaps at once → the pending s4 swap lands after it → the customer is stuck on
// "Iniciando pago seguro…" with the error written on the hidden s2. Run: node stage-race.test.mjs
// BOTH brands' REAL pages, the real pay/submit paths, fetch captured.
import assert from 'node:assert';
import { settle, envelope, loadForm, res, BRAND, closeAll, counter } from './form-harness.mjs';

const { ok } = counter();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const active = (w) => (w.document.querySelector('.stage.active') || {}).id;

async function boot(dir, charge, create) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (url.includes('chargeOnlineOrder') && charge) return charge();
    if (url.includes('createOrder') && create) return create(JSON.parse(init.body));
    return new Promise(() => {});
  };
  await settle();
  const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !w.itemIsLauncher(d));
  w.chg(dish.id, 1); w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `${dir}: premise — a cart composes an order`);
  w.showStage('s2', 50); await wait(300);
  assert.strictEqual(active(w), 's2', `${dir}: premise — on the pay step`);
  return w;
}
const netErr = () => Promise.reject(new TypeError('Failed to fetch'));

for (const dir of Object.keys(BRAND)) {
  { // an INSTANT charge failure (offline) → back on s2 with the error VISIBLE — never stuck on "Iniciando pago seguro…"
    const w = await boot(dir, netErr);
    w.selectPay('online');
    const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
    await wait(600);
    assert.strictEqual(active(w), 's2', `${dir}: an instant charge failure lands on the pay step (was stuck on s4)`);
    const err = w.document.getElementById('err3');
    assert.ok(err && err.style.display === 'block' && /Error de conexión/.test(err.textContent), `${dir}: …with the error visible on it`);
    assert.strictEqual(w.eval('orderSubmitting'), false, `${dir}: …and the customer can tap Pagar again`);
    ok(`${dir}: an instant charge failure → s2 with "Error de conexión…" visible, retry possible`);
  }
  { // the same failure after 400 ms (the swap already happened) — unchanged
    const w = await boot(dir, () => new Promise((_, rej) => setTimeout(() => rej(new TypeError('Failed to fetch')), 400)));
    w.selectPay('online');
    const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
    await wait(250);
    assert.strictEqual(active(w), 's4', `${dir}: premise — "Iniciando pago seguro…" shows while the charge is in flight`);
    await wait(600);
    assert.strictEqual(active(w), 's2', `${dir}: the slow failure lands on s2`);
    assert.ok(/Error de conexión/.test(w.document.getElementById('err3').textContent), `${dir}: …with the error`);
    ok(`${dir}: a failure after 400 ms → s4 while in flight, then s2 with the error (unchanged)`);
  }
  { // A → B → A: the immediate swap back must not be overtaken by B's pending swap
    const w = await boot(dir);
    w.showStage('s4', 90); w.showStage('s2', 50);
    await wait(400);
    assert.strictEqual(active(w), 's2', `${dir}: s2 → s4 → s2 ends on s2`);
    assert.ok(!w.document.getElementById('s2').classList.contains('stage-out'), `${dir}: …and s2 is not left mid-fade`);
    ok(`${dir}: A → B → A ends on A (the pending B swap is cancelled)`);
  }
  { // A → B → C (both deferred): ends on C, as before
    const w = await boot(dir);
    w.showStage('s4', 90); w.showStage('s5', 100);
    await wait(400);
    assert.strictEqual(active(w), 's5', `${dir}: s2 → s4 → s5 ends on s5`);
    ok(`${dir}: A → B → C ends on C`);
  }
  { // the CASH path's exposure, proven: an instant createOrder failure retries with a 1.5 s / 3 s backoff and shows its
    // error ON s4 (the sending stage is where cash errors are shown) — no stage swap back, so no race; the page is on s4
    // with the error text, and the customer can submit again
    let n = 0;
    const w = await boot(dir, null, () => { n += 1; return netErr(); });
    const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
    await wait(5200);
    assert.strictEqual(n, 3, `${dir}: premise — three createOrder attempts`);
    assert.strictEqual(active(w), 's4', `${dir}: cash shows its failure on the sending stage`);
    assert.ok(/conexi|intent/i.test(w.document.getElementById('sending-msg').textContent), `${dir}: …with an error message (${w.document.getElementById('sending-msg').textContent.trim().slice(0, 60)})`);
    assert.strictEqual(w.eval('orderSubmitting'), false, `${dir}: …and can be submitted again`);
    ok(`${dir}: cash — an instant failure retries ×3, then shows its error on s4 (by design; no swap back, so no race)`);
  }
}
closeAll();
console.log('\nstage-race: OK');
