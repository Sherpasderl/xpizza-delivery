// PLAN-S2 — at a terminal payment return, the pending-payment stash is removed ONLY when it is the returning order's (or
// unusable as anyone's record). Run: node s2-stash-cleanup.test.mjs
//
// Both REAL pages (form-harness). The stashes are written by the page ITSELF: a real card checkout (processPixelPay →
// a stubbed chargeOnlineOrder that answers with a hosted checkout) stashes the order exactly as production does. A return
// is then driven on a FRESH page (as after the redirect): the URL is arranged with history.replaceState and the storage
// is arranged BEFORE the real handlePaymentReturn() runs. The paymentStatus stub validates the (order_id, t) pair the way
// the server does (a token that is not that order's → 403), so no impossible response can pass.
//   1  complete returns × paid / scheduled_paid / closed_refunded / scheduled_review:
//      (a) B in storage → B byte-identical; A's screen as today; requests (A, tA) only; one terminal request
//      (b) A in storage → removed; paid / scheduled_paid rebuild the FULL confirmation (receipt DOM; the number line as
//          today: pending → number for paid, HIDDEN for scheduled)
//      (c) A at entry, B written by "another tab" between two polls → B survives
//   2  cancel returns (the REAL URL — no t): (a) A at entry, B written while the single check is pending → A's screen, B
//      kept, the pair (A, tA) — all four states; (b) B at entry → (A, tB) → 403 → the cancel screen, B unchanged, 1 request
//   3  B afterwards, INDEPENDENT continuations from the preserved stash: B's complete return → B's full confirmation (the
//      stash is consumed); B's failure → "Volver a intentar" restores B's form, resumes B's id and its serialization pin
//   4  the removal contract at a terminal site, every row (absent / null / unparseable / non-object / no or empty or
//      non-string order_id / matching / another order's / storage throwing)
//   5  missing id/token → today's screens, no removal      6  non-terminal states → no removal
//   7  DIFFERENTIAL: the same 1(a), 1(c) and 2(a) on the 8f1e017 pages DELETE B (the defect), so "B survives" is not vacuous
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { counter, settle, stageSettle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const { ok, count } = counter();
const WATCHDOG = setTimeout(() => { console.error('s2-stash-cleanup: FAILED — watchdog'); process.exit(1); }, 600000);
const KEY = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
const TERMINAL = ['paid', 'scheduled_paid', 'closed_refunded', 'scheduled_review'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_GAP = 2500;
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });

// the BASE pages (8f1e017), beside this suite, for the differential; removed on exit
const ROOT = fileURLToPath(new URL('./', import.meta.url));
const BASE_DIR = 'node_modules/.s2-base-client';
function materializeBase(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', '8f1e017', `${dir}/`], { encoding: 'utf8' }).split('\n').filter((f) => /\.(html|js)$/.test(f));
  mkdirSync(`${ROOT}${BASE_DIR}/${dir}`, { recursive: true });
  for (const f of files) writeFileSync(`${ROOT}${BASE_DIR}/${f}`, execFileSync('git', ['-C', ROOT, 'show', `8f1e017:${f}`]));
}
process.on('exit', () => { try { rmSync(`${ROOT}${BASE_DIR}`, { recursive: true, force: true }); } catch (_) {} try { rmdirSync(`${ROOT}node_modules`); } catch (_) {} });

// A REAL stash: the page's own card checkout. `pick` chooses the dishes (distinct carts → distinct orders).
async function realStash(dir, pick, token) {
  const B = BRAND[dir];
  const w = loadForm(dir);
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (url.includes('chargeOnlineOrder')) { const b = JSON.parse((init && init.body) || '{}'); return res({ ok: true, checkout_url: 'https://pay.test/checkout', order_id: b.order_id, poll_token: token }); }
    return new Promise(() => {});
  };
  await settle();
  const dishes = w.liveMenuGlobalGet('MENU').filter((d) => d.price > 0 && !d.variantOf && !(w.itemIsLauncher && w.itemIsLauncher(d)));
  for (const i of pick) { w.chg(dishes[i].id, 1); await settle(); }
  w.requestServerQuote(); await settle();
  w.selectPay('online');
  assert.ok(w.buildOrder(), `${dir}: premise — the cart composes`);
  const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
  for (let i = 0; i < 40 && !w.localStorage.getItem(KEY[dir]); i++) await wait(25);
  const raw = w.localStorage.getItem(KEY[dir]);
  assert.ok(raw, `${dir}: premise — the real checkout stashed the order`);
  const s = JSON.parse(raw);
  assert.ok(s.order_id && s.t === token && s.order && Array.isArray(s.order.items) && s.form, `${dir}: premise — a complete real stash`);
  return { raw, id: s.order_id, t: token, stash: s };
}

// A fresh page (as after the redirect) with the URL + storage arranged; `states(n, id)` answers the n-th VALID poll.
async function returnPage(dir, { url, stored, tokens, states, onRequest, base = false, transforms }) {
  const B = BRAND[dir];
  const w = loadForm(base ? `${BASE_DIR}/${dir}` : dir, transforms ? { transforms } : {});
  const reqs = [];
  let valid = 0;
  w.__respond = (u) => {
    if (u.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (u.includes('paymentStatus')) {
      const q = new URL(u).searchParams; const id = q.get('order_id'), t = q.get('t');
      reqs.push([id, t]);
      if (onRequest) onRequest(reqs.length, w);
      if (!id || !t || tokens[id] !== t) return json(403, { error: 'forbidden' });
      valid += 1;
      return Promise.resolve(states(valid, id)).then((b) => json(200, b));
    }
    if (u.includes('/order_tracking/')) return res(null);
    return new Promise(() => {});
  };
  await settle();
  w.history.replaceState({}, '', url);
  if (stored !== undefined) { if (stored === null) w.localStorage.removeItem(KEY[dir]); else w.localStorage.setItem(KEY[dir], stored); }
  return { w, reqs, run: async () => { const r = await w.handlePaymentReturn(); await stageSettle(); return r; } };   // showStage cross-dissolves (170 ms)
}
const SERVER_TOTAL_CENTS = 31750;   // an explicit, non-zero server-confirmed total (wins over the stashed client total, #6)
const body = (st, id) => (st === 'scheduled_paid' || st === 'scheduled_review'
  ? { ok: true, state: st, scheduled_for: '2026-10-20T19:00', tracking_token: null, order_id: id, total_cents: SERVER_TOTAL_CENTS }
  : { ok: true, state: st, tracking_token: st === 'paid' ? 'TrkTok12345678' : null, order_id: id, total_cents: SERVER_TOTAL_CENTS });
const receiptTotal = (w) => { const m = w.document.getElementById('s5').textContent.replace(/\s+/g, ' ').match(/Total\s*L\s*(\d+\.\d\d)/); return m ? m[1] : null; };
const overlay = (w) => { const o = w.document.getElementById('pay-return-overlay'); return o ? o.textContent : ''; };
const TITLE = { paid: '¡Pago confirmado!', scheduled_paid: '¡Pago confirmado!', closed_refunded: 'Te reembolsamos tu pago', scheduled_review: 'Pago recibido', cancel: 'Pago cancelado', failed: 'Pago no completado', pending_timeout: 'Pago en proceso' };
const fullConfirmation = (w, stash) => {
  const s5 = w.document.getElementById('s5');
  return !!s5 && s5.classList.contains('active') && !w.document.getElementById('pay-return-overlay') && stash.order.items.every((it) => s5.textContent.includes(it.name));
};

for (const dir of Object.keys(BRAND)) {
  materializeBase(dir);
  const A = await realStash(dir, [0], 'tokA_123456789');
  const Bs = await realStash(dir, [1, 2], 'tokB_987654321');
  assert.notStrictEqual(A.id, Bs.id, 'premise: two orders');
  const tokens = { [A.id]: A.t, [Bs.id]: Bs.t };
  const complete = `/?pay=complete&order=${encodeURIComponent(A.id)}&t=${encodeURIComponent(A.t)}`;
  const cancelUrl = `/?pay=cancel&order=${encodeURIComponent(A.id)}`;

  // ── 1. complete returns ──
  for (const st of TERMINAL) {
    { // (a) B in storage at entry
      const p = await returnPage(dir, { url: complete, stored: Bs.raw, tokens, states: () => body(st, A.id) });
      assert.strictEqual(await p.run(), true);
      assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), Bs.raw, `${dir}/1a/${st}: B is byte-identical`);
      assert.deepStrictEqual(p.reqs, [[A.id, A.t]], `${dir}/1a/${st}: one terminal request, (A, tA) only`);
      assert.ok(overlay(p.w).includes(TITLE[st]), `${dir}/1a/${st}: A's screen as today (${overlay(p.w).slice(0, 60)})`);
    }
    { // (b) A in storage → removed; the full confirmation for paid / scheduled_paid
      const p = await returnPage(dir, { url: complete, stored: A.raw, tokens, states: () => body(st, A.id) });
      assert.strictEqual(await p.run(), true);
      assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), null, `${dir}/1b/${st}: A's own stash is removed`);
      if (st === 'paid' || st === 'scheduled_paid') {
        assert.ok(fullConfirmation(p.w, A.stash), `${dir}/1b/${st}: the FULL confirmation (receipt items) is rebuilt`);
        assert.strictEqual(receiptTotal(p.w), (SERVER_TOTAL_CENTS / 100).toFixed(2), `${dir}/1b/${st}: the receipt TOTAL is exactly the server-confirmed L ${(SERVER_TOTAL_CENTS / 100).toFixed(2)} (codex S2 build r1 P2-1)`);
        await wait(300);
        const line = p.w.document.getElementById('order-id-display');
        if (st === 'scheduled_paid') assert.ok(!line || line.style.display === 'none', `${dir}/1b/${st}: the number line is HIDDEN for a scheduled confirmation (today)`);
        else assert.ok(line && line.style.display !== 'none', `${dir}/1b/${st}: the number line shows (pending → number, today)`);
      } else assert.ok(overlay(p.w).includes(TITLE[st]), `${dir}/1b/${st}: today's screen`);
    }
    { // (c) A at entry; B written by another tab BETWEEN two polls → B survives
      const p = await returnPage(dir, { url: complete, stored: A.raw, tokens, states: (n) => (n === 1 ? { ok: true, state: 'pending' } : body(st, A.id)),
        onRequest: (n, w) => { if (n === 1) setTimeout(() => w.localStorage.setItem(KEY[dir], Bs.raw), POLL_GAP / 2); } });
      assert.strictEqual(await p.run(), true);
      assert.strictEqual(p.reqs.length, 2, 'premise: two polls');
      assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), Bs.raw, `${dir}/1c/${st}: B (written mid-poll) survives`);
    }
  }
  ok(`${dir}: complete returns × 4 terminal states — (a) B at entry is byte-identical, one (A, tA) request, A's screen as today; (b) A's own stash removed, paid/scheduled_paid rebuild the full receipt (number line as today, hidden for scheduled); (c) B written between two polls survives`);

  // ── 2. cancel returns (the REAL URL: no t) ──
  for (const st of TERMINAL) {
    // (a) A at entry → the pair (A, tA) → B overwrites storage while the single check is pending → A's screen; B kept
    let release; const gate = new Promise((r) => { release = r; });
    const p = await returnPage(dir, { url: cancelUrl, stored: A.raw, tokens, states: () => gate.then(() => body(st, A.id)),
      onRequest: (n, w) => { w.localStorage.setItem(KEY[dir], Bs.raw); setTimeout(release, 50); } });
    assert.strictEqual(await p.run(), true);
    assert.deepStrictEqual(p.reqs, [[A.id, A.t]], `${dir}/2a/${st}: the request pair is (A, tA)`);
    assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), Bs.raw, `${dir}/2a/${st}: B (written during the check) is kept`);
    if (st === 'paid' || st === 'scheduled_paid') {
      assert.ok(fullConfirmation(p.w, A.stash), `${dir}/2a/${st}: A's full confirmation (captured at entry)`);
      assert.strictEqual(receiptTotal(p.w), (SERVER_TOTAL_CENTS / 100).toFixed(2), `${dir}/2a/${st}: the receipt TOTAL is exactly the server total`);
    }
    else assert.ok(overlay(p.w).includes(TITLE[st]), `${dir}/2a/${st}: A's screen`);
  }
  for (const st of TERMINAL) { // (a') OWN order (codex S2 build r1 P2-2): A at entry, NO overwrite → verified terminal → A's stash REMOVED
    const p = await returnPage(dir, { url: cancelUrl, stored: A.raw, tokens, states: () => body(st, A.id) });
    assert.strictEqual(await p.run(), true);
    assert.deepStrictEqual(p.reqs, [[A.id, A.t]], `${dir}/2a'/${st}: the pair (A, tA) from the stash`);
    assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), null, `${dir}/2a'/${st}: A's OWN stash is removed on the cancel return`);
    if (st === 'paid' || st === 'scheduled_paid') assert.ok(fullConfirmation(p.w, A.stash), `${dir}/2a'/${st}: A's full confirmation`);
    else assert.ok(overlay(p.w).includes(TITLE[st]), `${dir}/2a'/${st}: A's screen`);
  }
  { // (b) B at entry → (A, tB) → the server's token rejection → the cancel screen; B unchanged; one request
    const p = await returnPage(dir, { url: cancelUrl, stored: Bs.raw, tokens, states: () => body('paid', A.id) });
    assert.strictEqual(await p.run(), true);
    assert.deepStrictEqual(p.reqs, [[A.id, Bs.t]], `${dir}/2b: the request is (A, tB)`);
    assert.ok(overlay(p.w).includes(TITLE.cancel), `${dir}/2b: the cancel screen`);
    assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), Bs.raw, `${dir}/2b: B unchanged`);
  }
  ok(`${dir}: cancel returns (no t) — (a) A at entry, B written while the single check is pending → A's screen for every terminal state, B kept, the pair (A, tA); (b) B at entry → (A, tB) → token rejection → the cancel screen, B unchanged, one request`);

  // ── 3. B afterwards: independent continuations from the preserved stash ──
  {
    const okB = await returnPage(dir, { url: `/?pay=complete&order=${encodeURIComponent(Bs.id)}&t=${encodeURIComponent(Bs.t)}`, stored: Bs.raw, tokens, states: () => body('paid', Bs.id) });
    assert.strictEqual(await okB.run(), true);
    assert.ok(fullConfirmation(okB.w, Bs.stash), `${dir}/3: B's later return shows B's FULL confirmation`);
    assert.strictEqual(okB.w.localStorage.getItem(KEY[dir]), null, `${dir}/3: …and consumes B's stash`);
    const failB = await returnPage(dir, { url: `/?pay=complete&order=${encodeURIComponent(Bs.id)}&t=${encodeURIComponent(Bs.t)}`, stored: Bs.raw, tokens, states: () => ({ ok: true, state: 'failed' }) });
    assert.strictEqual(await failB.run(), true);
    assert.ok(overlay(failB.w).includes(TITLE.failed), 'premise: B failed');
    assert.strictEqual(failB.w.localStorage.getItem(KEY[dir]), Bs.raw, `${dir}/3: a failure keeps B's stash`);
    failB.w.restoreOrderForm(); await settle();
    assert.strictEqual(failB.w.__resumeOrderId, Bs.id, `${dir}/3: "Volver a intentar" resumes B's id`);
    const pin = failB.w.eval('SERIAL.current()');
    // the EXACT pin (codex S2 build r1 P2-3): B's saved items, in their saved order, mapped to the restored lines' keys
    const lines = failB.w.eval('resolvedCartLines()');
    const keyOf = (it) => { const l = lines.find((x) => (x.record && x.record.name) === it.name); return l ? String(l.key) : null; };
    const expectPin = Bs.stash.order.items.map(keyOf);
    assert.ok(expectPin.length >= 2 && expectPin.every(Boolean), `${dir}/3: premise — B has ≥2 lines, each restored (${JSON.stringify(expectPin)})`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(pin)), expectPin, `${dir}/3: B's resumed pin is EXACTLY B's saved order (identity + order)`);   // JSON: the page's realm
    assert.ok(failB.w.buildOrder(), `${dir}/3: the resumed cart composes`);
    const payload = failB.w.eval('currentOrder');
    assert.strictEqual(payload.order_id, Bs.id, `${dir}/3: the resumed payload carries B's id`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload.items.map((it) => [it.name, it.qty]))), Bs.stash.order.items.map((it) => [it.name, it.qty]), `${dir}/3: the resumed serialized payload is B's saved items, in order`);
  }
  ok(`${dir}: B afterwards (independent continuations) — B's complete return shows B's full confirmation and consumes the stash; B's failure → "Volver a intentar" resumes B's id and B's serialization pin`);

  // ── 4. the removal contract at a terminal site (applyPollState → closed_refunded), every row ──
  {
    const rows = [
      ['absent', null, null], ['stored null', 'null', null], ['unparseable', '{bad', null], ['a number', '5', null], ['a string', '"x"', null],
      ['an array', '[1,2]', null], ['no order_id', '{"t":"x"}', null], ['empty order_id', '{"order_id":""}', null], ['non-string order_id', '{"order_id":5}', null],
      ['matching', JSON.stringify({ order_id: A.id }), null], ['another order\'s', Bs.raw, Bs.raw],
    ];
    for (const [label, stored, after] of rows) {
      const p = await returnPage(dir, { url: '/', stored, tokens, states: () => ({}) });
      assert.strictEqual(p.w.applyPollState('closed_refunded', {}, A.id, null), true);
      assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), after, `${dir}/4 ${label}`);
    }
    for (const which of ['getItem', 'removeItem']) {
      const p = await returnPage(dir, { url: '/', stored: JSON.stringify({ order_id: A.id }), tokens, states: () => ({}) });
      const proto = p.w.Storage.prototype; const orig = proto[which];
      Object.defineProperty(proto, which, { value: function () { throw new Error('storage unavailable'); }, configurable: true, writable: true });
      let shown;
      try { shown = p.w.applyPollState('closed_refunded', {}, A.id, null); } finally { Object.defineProperty(proto, which, { value: orig, configurable: true, writable: true }); }
      assert.strictEqual(shown, true, `${dir}/4 ${which} throws → no exception escapes`);
      assert.ok(overlay(p.w).includes(TITLE.closed_refunded), `${dir}/4 ${which} throws → the screen is still shown`);
    }
  }
  ok(`${dir}: the removal contract — absent no-op; stored null / unparseable / non-object / no, empty or non-string order_id / matching → removed; another order's → kept; getItem or removeItem throwing → nothing escapes, the screen is shown`);

  // ── 5. missing id/token ──
  {
    const p1 = await returnPage(dir, { url: '/?pay=complete', stored: null, tokens, states: () => ({}) });
    assert.strictEqual(await p1.run(), true);
    assert.ok(overlay(p1.w).includes(TITLE.pending_timeout) && p1.reqs.length === 0, `${dir}/5: complete without id/token → pending_timeout, no request`);
    const noTok = JSON.stringify({ ...A.stash, t: undefined });
    const p2 = await returnPage(dir, { url: cancelUrl, stored: noTok, tokens, states: () => ({}) });
    assert.strictEqual(await p2.run(), true);
    assert.ok(overlay(p2.w).includes(TITLE.cancel) && p2.reqs.length === 0, `${dir}/5: cancel with no resolvable token → the cancel screen, no request`);
    assert.strictEqual(p2.w.localStorage.getItem(KEY[dir]), noTok, `${dir}/5: no removal`);
  }
  // ── 6. non-terminal states → no removal ──
  for (const st of ['failed', 'cancelled', 'verifying', 'pending']) {
    const p = await returnPage(dir, { url: '/', stored: A.raw, tokens, states: () => ({}) });
    p.w.applyPollState(st, { ok: true, state: st }, A.id, A.stash.order);
    assert.strictEqual(p.w.localStorage.getItem(KEY[dir]), A.raw, `${dir}/6 ${st}: no removal`);
  }
  ok(`${dir}: missing id/token → today's screens with no request and no removal; non-terminal states (failed / cancelled / verifying / pending) never remove`);

  // ── 7. DIFFERENTIAL on the 8f1e017 pages: the defect, so "B survives" above is not vacuous ──
  {
    const a = await returnPage(dir, { url: complete, stored: Bs.raw, tokens, states: () => body('paid', A.id), base: true });
    await a.run();
    assert.strictEqual(a.w.localStorage.getItem(KEY[dir]), null, `${dir}/7 base 1(a): B is DELETED`);
    const c = await returnPage(dir, { url: complete, stored: A.raw, tokens, states: (n) => (n === 1 ? { ok: true, state: 'pending' } : body('paid', A.id)),
      onRequest: (n, w) => { if (n === 1) setTimeout(() => w.localStorage.setItem(KEY[dir], Bs.raw), POLL_GAP / 2); }, base: true });
    await c.run();
    assert.strictEqual(c.w.localStorage.getItem(KEY[dir]), null, `${dir}/7 base 1(c): B is DELETED`);
    let release; const gate = new Promise((r) => { release = r; });
    const x = await returnPage(dir, { url: cancelUrl, stored: A.raw, tokens, states: () => gate.then(() => body('paid', A.id)),
      onRequest: (n, w) => { w.localStorage.setItem(KEY[dir], Bs.raw); setTimeout(release, 50); }, base: true });
    await x.run();
    assert.strictEqual(x.w.localStorage.getItem(KEY[dir]), null, `${dir}/7 base 2(a): B is DELETED`);
  }
  ok(`${dir}: DIFFERENTIAL — the same 1(a), 1(c) and 2(a) on the 8f1e017 page DELETE B (the defect reproduced)`);
}

clearTimeout(WATCHDOG);
closeAll();
console.log(`\ns2-stash-cleanup: OK (${count()})`);
