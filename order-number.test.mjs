// Owner (2026-10-12) / R3 D19 — the confirmation shows the KITCHEN's short number (#47), never the long order id.
// Run: node order-number.test.mjs
//   PART A — the shared module (form-order-number.js), on a VIRTUAL clock: the real 45 s deadline and the real read
//            schedule, the request cap, a hung read, a stale poll, stop().
//   PART B — BOTH brands' REAL pages, through the real send paths (cash submitOrder → createOrder; the online return's
//            `paid` poll state), with fetch captured: pending → "Orden #47" after a delayed allocation; scheduled → no
//            line and no read; no token → hidden; the deadline → hidden; a stale poll never paints a newer order; the
//            long id never appears in the confirmation at any step.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { counter, settle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(import.meta.url);
const { ok } = counter();

// ── PART A — the module on a virtual clock ──────────────────────────────────────────────────────────────────────────
const ON = require('./xpizza-orders/form-order-number.js');
assert.strictEqual(readFileSync(new URL('./xpizza-orders/form-order-number.js', import.meta.url), 'utf8'),
  readFileSync(new URL('./la-musa-orders/form-order-number.js', import.meta.url), 'utf8'), 'both forms ship the SAME module bytes');

function clock() {
  let now = 0, seq = 0; const q = [];
  return {
    setTimeout: (f, ms) => { const id = ++seq; q.push({ id, at: now + ms, f }); return id; },
    clearTimeout: (id) => { const i = q.findIndex((t) => t.id === id); if (i >= 0) q.splice(i, 1); },
    async advance(ms) {   // run every timer due within the horizon, in time order, letting promises settle between
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!q.length || q[0].at > end) break;
        const t = q.shift(); now = t.at; t.f();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
    },
    get now() { return now; },
  };
}
function harness(answer) {
  const c = clock(), reads = [], states = [];
  const fetch = (url) => { reads.push({ url, at: c.now }); return answer(reads.length, url); };
  const on = ON.createOrderNumber({ base: 'https://db.test', read: fetch, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    paint: (s, n) => states.push(n === undefined ? s : `${s}:${n}`) });
  return { c, on, reads, states };
}
const json = (v) => Promise.resolve({ ok: true, json: () => Promise.resolve(v) });
const TOKEN = 'AbCdEfGh2345';

{ // delayed allocation: null, null, then 47 → pending → number; the poll stops there
  const h = harness((n) => json(n < 3 ? null : 47));
  h.on.start(TOKEN);
  assert.deepStrictEqual(h.states, ['pending'], 'pending at once, before any read');
  await h.c.advance(60000);
  assert.deepStrictEqual(h.states, ['pending', 'number:47']);
  assert.strictEqual(h.reads.length, 3, 'stops reading once the number lands');
  assert.strictEqual(h.reads[0].url, `https://db.test/order_tracking/${TOKEN}/display_number.json`, 'reads THIS order\'s public tracking node');
  ok('A: a delayed allocation → pending, then "number:47" on the 3rd read; no read after it');
}
{ // never allocated: the REAL deadline (45 s) hides the line; the reads are capped
  const h = harness(() => json(null));
  h.on.start(TOKEN);
  await h.c.advance(ON.ORDER_NUMBER_DEADLINE_MS - 1);
  assert.deepStrictEqual(h.states, ['pending'], 'still pending 1 ms before the deadline');
  await h.c.advance(1);
  assert.deepStrictEqual(h.states, ['pending', 'hidden'], 'hidden AT the deadline');
  await h.c.advance(10 * 60000);
  assert.ok(h.reads.length <= ON.ORDER_NUMBER_DELAYS_MS.length && h.reads.length === 10, `capped: ${h.reads.length} reads in total, none after`);
  assert.strictEqual(ON.ORDER_NUMBER_DEADLINE_MS, 45000);
  ok(`A: never allocated → hidden at exactly 45 s; ${h.reads.length} reads in all (capped), none after`);
}
{ // a HUNG read (never settles) cannot stall the deadline, and stacks no further reads
  const h = harness(() => new Promise(() => {}));
  h.on.start(TOKEN);
  await h.c.advance(60000);
  assert.deepStrictEqual(h.states, ['pending', 'hidden']);
  assert.strictEqual(h.reads.length, 1, 'one outstanding read at a time');
  ok('A: a hung read → still hidden at the deadline, and no read piles up behind it');
}
{ // failures (non-ok, throw, garbage) are "not yet", never a number
  const bad = [Promise.resolve({ ok: false, json: () => Promise.resolve(47) }), Promise.reject(new Error('net')), json('47'), json(0), json(-3), json(4.5), json({ n: 47 })];
  const h = harness((n) => bad[(n - 1) % bad.length]);
  h.on.start(TOKEN);
  await h.c.advance(60000);
  assert.deepStrictEqual(h.states, ['pending', 'hidden'], 'none of them is a number; the reads run out and the deadline hides');
  assert.strictEqual(h.reads.length, 10);
  ok('A: a non-ok response, a network error, "47", 0, -3, 4.5 and an object are each "not yet" — never painted');
}
{ // no token / an unusable token → hidden, zero reads
  for (const t of [null, undefined, '', 'short', 'has space12', 'x'.repeat(200), 42]) {
    const h = harness(() => json(47));
    h.on.start(t);
    await h.c.advance(60000);
    assert.deepStrictEqual(h.states, ['hidden'], `token ${JSON.stringify(t)} → hidden`);
    assert.strictEqual(h.reads.length, 0, `token ${JSON.stringify(t)} → no read`);
  }
  ok('A: no token, or an unusable one → hidden at once, no read');
}
{ // a STALE poll: order 1's number lands after order 2 started → only order 2 paints
  let release1;
  const h = harness((n, url) => (url.includes('ORDERone1234') ? new Promise((r) => { release1 = () => r({ ok: true, json: () => Promise.resolve(11) }); }) : json(22)));
  h.on.start('ORDERone1234');
  await h.c.advance(800);   // order 1's first read is in flight
  h.on.start('ORDERtwo5678');
  release1();
  await h.c.advance(60000);
  assert.deepStrictEqual(h.states, ['pending', 'pending', 'number:22'], 'order 1\'s late 11 is never painted');
  ok('A: a stale poll (order 1 answering after order 2 started) paints nothing');
}
{ // stop(): "Hacer otro pedido" / page unload → no more reads, no more paints
  const h = harness(() => json(null));
  h.on.start(TOKEN);
  await h.c.advance(3000);
  const n = h.reads.length;
  h.on.stop();
  await h.c.advance(60000);
  assert.strictEqual(h.reads.length, n, 'no read after stop');
  assert.deepStrictEqual(h.states, ['pending'], 'no paint after stop (not even the deadline)');
  ok('A: stop() ends the poll — no further read, no deadline paint');
}

// ── PART B — the real pages ─────────────────────────────────────────────────────────────────────────────────────────
// The page runs on real timers, so its module is loaded with a SHORT schedule (the schedule and the deadline are PART A's
// subject; here it is the wiring). transforms only rewrites those two constants.
const FAST = { 'form-order-number.js': (code) => code
  .replace(/const ORDER_NUMBER_DELAYS_MS = \[[^\]]*\];/, 'const ORDER_NUMBER_DELAYS_MS = [60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60];')
  .replace('const ORDER_NUMBER_DEADLINE_MS = 45000;', 'const ORDER_NUMBER_DEADLINE_MS = 1500;') };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const display = (w) => w.document.getElementById('order-id-display');
const visible = (el) => !!el && el.style.display !== 'none';
const line = (w) => display(w).textContent.replace(/\s+/g, ' ').trim();
const s5 = (w) => w.document.getElementById('s5').textContent;

// Boot, compose a cart, send through the REAL cash path. `create` answers createOrder; `number(readNo)` answers the
// tracking read. Returns the page, the order id it sent, and the captured tracking reads.
async function cash(dir, { create, number }) {
  const B = BRAND[dir];
  const w = loadForm(dir, { transforms: FAST });
  const reads = []; let sent = null;
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
    if (url.includes('quoteRedemption')) return res({ ok: true, total_cents: 1, net_total_cents: 1, savings_cents: 0, free_items: [], remaining: 0, total_cost: 0 });
    if (url.includes('quoteOrder')) return res({ ok: true, total_cents: 1, net_total_cents: 1 });
    if (url.includes('/order_tracking/')) { reads.push(url); return number(reads.length, url); }
    if (url.includes('createOrder')) { sent = JSON.parse(init.body).order_id; return res(create(sent)); }
    return new Promise(() => {});
  };
  await settle();
  const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !w.itemIsLauncher(d));
  w.chg(dish.id, 1); w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `${dir}: premise — a cart composes an order`);
  const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
  for (let i = 0; i < 40 && !(sent && w.document.querySelector('#s5.stage.active')); i++) await wait(25);
  assert.ok(sent && w.document.querySelector('#s5.stage.active'), `${dir}: premise — the send reached createOrder and the confirmation is showing`);
  return { w, reads, sent: () => sent };
}

for (const dir of Object.keys(BRAND)) {
  { // cash: the number is allocated AFTER the response → pending, then "Orden #47"; the long id never shows
    let allocated = false;
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(allocated ? 47 : null) });
    assert.ok(visible(display(r.w)) && /^Orden #/.test(line(r.w)) && /asignando/.test(line(r.w)), `${dir}: pending → "Orden #" + "asignando número…" (${line(r.w)})`);
    assert.ok(!s5(r.w).includes(r.sent()), `${dir}: the long id is NOT on the confirmation while pending`);
    allocated = true;   // the allocator stamps the number
    await wait(250);
    assert.strictEqual(line(r.w), 'Orden #47', `${dir}: the allocated number lands`);
    assert.ok(!s5(r.w).includes(r.sent()), `${dir}: …and the long id never appears`);
    const n = r.reads.length;
    await wait(400);
    assert.strictEqual(r.reads.length, n, `${dir}: no read once the number landed`);
    assert.ok(n >= 1 && r.reads.every((u) => u === `https://xpizza-delivery-default-rtdb.firebaseio.com/order_tracking/${TOKEN}/display_number.json`), `${dir}: every read is THIS order's public tracking node`);
    ok(`${dir}: cash → "Orden #" pending, then "Orden #47" once allocated; reads stop there; the PZX id is never shown`);
  }
  { // cash, never allocated → the deadline hides the line
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(null) });
    await wait(1900);
    assert.ok(!visible(display(r.w)), `${dir}: no number by the deadline → the line is hidden`);
    assert.ok(!s5(r.w).includes(r.sent()), `${dir}: …never the long id`);
    assert.ok(r.reads.length <= 12, `${dir}: capped reads (${r.reads.length})`);
    ok(`${dir}: cash, never allocated → the line is hidden at the deadline (${r.reads.length} capped reads), no long id`);
  }
  { // cash, no token in the response → hidden at once, zero reads
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id }), number: () => res(47) });
    await wait(300);
    assert.ok(!visible(display(r.w)) && r.reads.length === 0, `${dir}: no token → hidden, no read`);
    assert.ok(!s5(r.w).includes(r.sent()), `${dir}: …never the long id`);
    ok(`${dir}: cash with no tracking token → the line is hidden, no read, no long id`);
  }
  { // scheduled (cash {scheduled:true}) → no line, no read
    const r = await cash(dir, { create: (id) => ({ ok: true, scheduled: true, order_id: id, scheduled_for: '2026-10-13T19:00', release_at: 1 }), number: () => res(47) });
    await wait(300);
    assert.ok(!visible(display(r.w)) && r.reads.length === 0, `${dir}: scheduled → no number line and no read`);
    assert.ok(!s5(r.w).includes(r.sent()), `${dir}: …never the long id`);
    ok(`${dir}: a scheduled order → no number line, no read`);
  }
  { // STALE: order 1's number lands after "Hacer otro pedido" + order 2's confirmation → only order 2's number
    let release1;
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }),
      number: (n, url) => (url.includes(TOKEN) ? new Promise((ok1) => { release1 = () => ok1({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(11) }); }) : res(22)) });
    await wait(120);   // order 1's first read is in flight
    assert.ok(release1, `${dir}: premise — order 1's read is outstanding`);
    r.w.startAnotherOrder(); await settle();
    // order 2: same page, a fresh cart, a different token
    const T2 = 'SecondOrd987';
    const prev = r.w.__respond;
    r.w.__respond = (url, init) => (url.includes('createOrder') ? res({ ok: true, order_id: JSON.parse(init.body).order_id, tracking_token: T2 }) : prev(url, init));
    const dish = r.w.liveMenuGlobalGet('MENU').find((d) => d.price > 0 && !d.variantOf && !r.w.itemIsLauncher(d));
    r.w.chg(dish.id, 1); r.w.requestServerQuote(); await settle();
    assert.ok(r.w.buildOrder(), `${dir}: premise — order 2 composes`);
    const p2 = r.w.submitOrder('confirmed'); if (p2 && p2.catch) p2.catch(() => {});
    await settle(); await settle();
    await wait(300);
    assert.strictEqual(line(r.w), 'Orden #22', `${dir}: premise — order 2 shows ITS number`);
    release1(); await settle();   // order 1's read answers LAST — without the guard it would overwrite 22 with 11
    await wait(150);
    assert.strictEqual(line(r.w), 'Orden #22', `${dir}: order 1's late 11 is never painted over order 2`);
    ok(`${dir}: a stale poll (order 1 answering after "Hacer otro pedido" and order 2) never paints the newer confirmation`);
  }
  { // a later confirmation that carries NO token — the online return of a SCHEDULED order — after an earlier tokened one:
    // order 1's token is never reused (it is consumed at showSuccess, and a scheduled confirmation starts no poll)
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(11) });
    await wait(250);
    assert.strictEqual(line(r.w), 'Orden #11', `${dir}: premise — order 1 shows its number`);
    r.w.startAnotherOrder(); await settle();
    const n = r.reads.length;
    const stash = { order_id: 'PZX-SCHED-2', items: [{ name: 'X', qty: 1, subtotal: 1 }], total: 1, payment_method: 'online', order_type: 'pickup', notes: '—', customer_phone: '9999-9999' };
    assert.ok(r.w.applyPollState('scheduled_paid', { ok: true, state: 'scheduled_paid', scheduled_for: '2026-10-13T19:00', tracking_token: null }, 'PZX-SCHED-2', stash), `${dir}: premise — the scheduled return rendered`);
    await settle(); await wait(300);
    assert.ok(!visible(display(r.w)) && r.reads.length === n, `${dir}: order 2 hides the line and never re-reads order 1's node`);
    ok(`${dir}: a later token-less confirmation (scheduled online return) never reuses the earlier order's token`);
  }
  { // "Hacer otro pedido" stops the poll
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(null) });
    await wait(80);
    assert.ok(r.reads.length >= 1 && r.reads.length < 12, `${dir}: premise — the poll is still running (${r.reads.length} reads)`);
    r.w.startAnotherOrder(); await settle();
    const n = r.reads.length;
    await wait(900);
    assert.strictEqual(r.reads.length, n, `${dir}: no read after "Hacer otro pedido"`);
    ok(`${dir}: "Hacer otro pedido" stops the poll (no further read)`);
  }
  { // page unload (pagehide) stops the poll
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(null) });
    await wait(80);
    assert.ok(r.reads.length >= 1 && r.reads.length < 12, `${dir}: premise — the poll is still running (${r.reads.length} reads)`);
    r.w.dispatchEvent(new r.w.Event('pagehide'));
    const n = r.reads.length;
    await wait(900);
    assert.strictEqual(r.reads.length, n, `${dir}: no read after pagehide`);
    ok(`${dir}: leaving the page (pagehide) stops the poll`);
  }
  { // codex P2-2 — bfcache: leave while pending (persisted pagehide), come Back (persisted pageshow) → the pending line is
    // HIDDEN, never a stranded "asignando número…"; and nothing polls
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(null) });
    await wait(80);
    assert.ok(/asignando/.test(line(r.w)) && visible(display(r.w)), `${dir}: premise — pending`);
    const ev = (type) => { const e = new r.w.Event(type); Object.defineProperty(e, 'persisted', { value: true }); return e; };
    r.w.dispatchEvent(ev('pagehide'));
    const n = r.reads.length;
    r.w.dispatchEvent(ev('pageshow'));
    await wait(900);
    assert.ok(!visible(display(r.w)) && !/asignando/.test(s5(r.w)), `${dir}: after Back the pending line is hidden`);
    assert.ok(!s5(r.w).includes(r.sent()), `${dir}: …never the long id`);
    assert.strictEqual(r.reads.length, n, `${dir}: …and nothing polls`);
    ok(`${dir}: bfcache (persisted pagehide → pageshow) — a pending line is hidden, not stranded; no polling`);
  }
  { // …while a number already shown STAYS after the same round trip
    const r = await cash(dir, { create: (id) => ({ ok: true, order_id: id, tracking_token: TOKEN }), number: () => res(47) });
    await wait(300);
    assert.strictEqual(line(r.w), 'Orden #47', `${dir}: premise — the number landed`);
    const ev = (type) => { const e = new r.w.Event(type); Object.defineProperty(e, 'persisted', { value: true }); return e; };
    r.w.dispatchEvent(ev('pagehide')); r.w.dispatchEvent(ev('pageshow'));
    assert.strictEqual(line(r.w), 'Orden #47', `${dir}: a shown number survives Back`);
    ok(`${dir}: bfcache — a number already shown stays ("Orden #47")`);
  }
  { // the ONLINE return: the `paid` poll state carries the token → the same pending → number; scheduled_paid → no line
    for (const [state, expectLine] of [['paid', 'Orden #47'], ['scheduled_paid', null]]) {
      const B = BRAND[dir];
      const w = loadForm(dir, { transforms: FAST });
      const reads = [];
      w.__respond = (url) => {
        if (url.includes('/menu/')) return res(envelope(B.rid, { dishes: [], extras: [] }));
        if (url.includes('/order_tracking/')) { reads.push(url); return res(reads.length < 2 ? null : 47); }
        return new Promise(() => {});
      };
      await settle();
      const stash = { order_id: 'PZX-ONLINE-1', items: [{ name: 'X', qty: 1, subtotal: 1 }], total: 1, payment_method: 'online', order_type: 'pickup', notes: '—', customer_phone: '9999-9999' };
      const j = state === 'paid' ? { ok: true, state, tracking_token: TOKEN } : { ok: true, state, scheduled_for: '2026-10-13T19:00', tracking_token: null };
      assert.ok(w.applyPollState(state, j, 'PZX-ONLINE-1', stash), `${dir}/${state}: premise — the return rendered the confirmation`);
      await settle(); await wait(400);
      if (expectLine) assert.strictEqual(line(w), expectLine, `${dir}/${state}: the number lands`);
      else assert.ok(!visible(display(w)) && reads.length === 0, `${dir}/${state}: no line, no read`);
      assert.ok(!w.document.getElementById('s5').textContent.includes('PZX-ONLINE-1'), `${dir}/${state}: never the long id`);
    }
    ok(`${dir}: online return — "paid" → pending then "Orden #47"; "scheduled_paid" → no line; never the long id`);
  }
}

closeAll();
console.log('\norder-number: OK');
