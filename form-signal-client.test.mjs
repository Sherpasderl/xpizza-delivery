// PLAN 3 — formSignal, the FORM half, on BOTH forms through the REAL refusal paths (real page in jsdom, form-harness).
// Run: node form-signal-client.test.mjs
//   send     the final gate (refuseConflictedSend) refusing a repriced line → exactly ONE beacon {rid,'send',['repriced']};
//            its empty-cart branch → ['empty']
//   build / submit / restore   each refusal point emits ITS event, once
//   LARGE CART (r3 NEW P2)     9 repriced lines + 1 sold out → ONE beacon, reasons exactly ['repriced','unavailable'],
//            < 512 B. The captured body is the committed fixture xpizza-functions/test/fixtures/form-signal-large-cart.json,
//            which form-signal.emulator.test.js posts through the REAL HTTP wrapper — the two halves composed.
//   FAILURE INJECTION          sendBeacon absent / throwing / returning false → the refusal result, the message, the cart,
//            orderSubmitting / __paySubmitting and the stash are identical to a working beacon
//   CLEAN PATHS                a clean cash send and a clean card send go out and emit NO beacon
//   Regenerate the fixture (only after an intended change): FORM_SIGNAL_WRITE_FIXTURE=1 node form-signal-client.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { counter, settle, envelope, loadForm, res, serve, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { ok, count } = counter();
const WATCHDOG = setTimeout(() => { console.error('form-signal-client: FAILED — watchdog'); process.exit(1); }, 300000);
const plain = (x) => JSON.parse(JSON.stringify(x));
const FIXTURE = new URL('./xpizza-functions/test/fixtures/form-signal-large-cart.json', import.meta.url);
const URL_RE = /^https:\/\/us-central1-xpizza-delivery\.cloudfunctions\.net\/formSignal$/;
const CHARGE_RE = /createOrder|chargeOnlineOrder/;

const CASES = {
  'xpizza-orders': { X: 2, Y: 19, dishKey: (d) => d.name, extraKey: (e) => e.name },
  'la-musa-orders': { X: 'dimsum_02', Y: 'dimsum_05', dishKey: (d) => String(d.id), extraKey: (e) => String(e.id) },
};
const STASH = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
// group-restore.test.mjs's fixtures: one dish that is ORDINARY on the first page and a LAUNCHER on the second
const GROUP_FIX = {
  'xpizza-orders': {
    launcher: 30,
    noGroup: (w) => { const m = BRAND['xpizza-orders'].menu(w); m.dishes = m.dishes.filter((d) => !d.variantOf && d.id !== 30); m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 }); m.variant_items = {}; return m; },
    group: (w) => {
      const m = BRAND['xpizza-orders'].menu(w); m.dishes = m.dishes.filter((d) => d.id !== 30 && !d.variantOf);
      m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 });
      [['Salsa Roja', 31, 624], ['Salsa Vodka', 32, 644], ['Combinada', 33, 654]].forEach(([c, id, p]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${c}`, price: p, variantOf: 30, choice: c }));
      m.variant_items = { 30: { label: 'Salsa', basePrice: 624, variantIds: [31, 32, 33] } };
      return m;
    },
  },
  'la-musa-orders': {
    launcher: 'noodle_01',
    noGroup: (w) => { const m = BRAND['la-musa-orders'].menu(w); m.dishes = m.dishes.filter((d) => !d.variantOf); m.variant_items = {}; return m; },
    group: null,   // the bundled Pad Thai group
  },
};
const tablesOf = (rid, menu, c) => ({ restaurantId: rid, menu: Object.fromEntries(menu.dishes.map((d) => [c.dishKey(d), d.price])), extras: Object.fromEntries((menu.extras || []).map((e) => [c.extraKey(e), e.price])) });

// the beacon: a recording stub (or a broken one) installed on the page's navigator
function installBeacon(w, mode = 'ok') {
  const sent = [];
  const impl = { ok: (url, body) => { sent.push({ url, body }); return true; }, false: (url, body) => { sent.push({ url, body }); return false; }, throw: () => { throw new Error('beacon down'); } }[mode];
  if (mode === 'absent') { try { delete w.navigator.sendBeacon; } catch (_) {} Object.defineProperty(w.navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true }); }
  else Object.defineProperty(w.navigator, 'sendBeacon', { value: impl, configurable: true, writable: true });
  return sent;
}
async function boot(dir, beacon = 'ok') {
  const B = BRAND[dir], c = CASES[dir];
  const w = loadForm(dir); await settle();
  let menu = B.menu(w);
  await serve(w, envelope(B.rid, menu));
  const charges = [];
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(B.rid, menu));
    const body = JSON.parse((init && init.body) || '{}');
    if (url.includes('quoteOrder')) { const t = computeServerTotal(body.items, B.rid, tablesOf(B.rid, menu, c)); return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) }); }
    if (CHARGE_RE.test(url)) { charges.push({ url, body }); return res(url.includes('chargeOnlineOrder') ? { ok: true, checkout_url: 'https://pay.test/checkout', order_id: body.order_id, poll_token: 'poll_tok_123' } : { ok: true }); }
    return new Promise(() => {});
  };
  const reprice = (changes) => {
    const next = JSON.parse(JSON.stringify(menu));
    for (const [id, value] of changes) next.dishes.find((r) => String(r.id) === String(id)).price = value;
    menu = next;
    return w.__liveMenu.applier.apply(plain(next));
  };
  const beacons = installBeacon(w, beacon);
  return { w, B, c, beacons, charges, reprice };
}
const priceOf = (w, id) => w.eval('MENU').find((d) => String(d.id) === String(id)).price;
const parsed = (beacons) => beacons.map((b) => { assert.match(b.url, URL_RE, 'the beacon goes to the formSignal endpoint'); assert.strictEqual(typeof b.body, 'string', 'a STRING body (sendBeacon sends it as text/plain)'); return JSON.parse(b.body); });
const errText = (w) => { const e = w.document.getElementById('err3') || w.document.getElementById('err1'); return e ? e.textContent : ''; };
const ordinary = (w) => plain(w.eval('MENU.filter(p => !p.variantOf && p.price > 0 && !itemIsLauncher(p) && !isSoldOut(p)).map(p => p.id)'));

const fixture = {};
for (const dir of Object.keys(CASES)) {
  const rid = BRAND[dir].rid;
  // ── 1. send: a repriced line refused at the final gate → ONE beacon; empty cart → ['empty'] ──
  {
    const { w, c, beacons, reprice } = await boot(dir);
    w.chg(c.X, 1); await settle();
    assert.strictEqual(reprice([[c.X, priceOf(w, c.X) + 11]]), 'applied');
    assert.strictEqual(beacons.length, 0, `${dir}: a live apply alone emits nothing`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), true, `${dir}: premise — the send gate refuses`);
    assert.deepStrictEqual(parsed(beacons), [{ rid, event: 'send', reasons: ['repriced'] }], `${dir}: exactly one beacon {rid, send, [repriced]}`);
    const { w: w2, beacons: b2 } = await boot(dir);
    assert.strictEqual(w2.refuseConflictedSend('createOrder'), true, `${dir}: premise — an empty cart is refused`);
    assert.deepStrictEqual(parsed(b2), [{ rid, event: 'send', reasons: ['empty'] }], `${dir}: the empty-cart branch sends ['empty']`);
    ok(`${dir}: send — a repriced line → one {${rid}, send, [repriced]} beacon (string body, formSignal URL); an empty cart → [empty]`);
  }
  // ── 2. build and submit: each refusal point emits its own event, once ──
  {
    const { w, c, beacons, reprice } = await boot(dir);
    w.chg(c.X, 1); await settle();
    reprice([[c.X, priceOf(w, c.X) + 12]]);
    assert.strictEqual(w.buildOrder(), false, `${dir}: premise — buildOrder refuses`);
    assert.deepStrictEqual(parsed(beacons), [{ rid, event: 'build', reasons: ['repriced'] }], `${dir}: build → one beacon`);
    beacons.length = 0;
    await w.submitOrder('confirmed'); await settle();
    assert.deepStrictEqual(parsed(beacons), [{ rid, event: 'submit', reasons: ['repriced'] }], `${dir}: submit → one beacon (its own gate refuses before the send gate: no double count)`);
    ok(`${dir}: build and submit each emit ONE beacon with their own event`);
  }
  // ── 3. restore: a cart saved BEFORE its dish became a launcher, restored where it is one (group-restore.test.mjs's
  //       real-writer fixture) → ONE 'restore' beacon with ['choice'] ──
  {
    const F = GROUP_FIX[dir];
    const a = loadForm(dir); await settle();
    await serve(a, envelope(rid, F.noGroup(a)));
    const O = plain(a.eval('MENU.find(p => !p.variantOf && p.price > 0 && !itemIsLauncher(p)).id'));
    a.chg(F.launcher, 1); a.chg(O, 1);
    const snap = plain(a.snapshotForm());
    const w = loadForm(dir); await settle();
    if (F.group) await serve(w, envelope(rid, F.group(w)));
    const beacons = installBeacon(w);
    w.localStorage.setItem(STASH[dir], JSON.stringify({ order_id: 'o_restore', ts: Date.now(), form: snap }));
    w.restoreOrderForm(); await settle();
    assert.deepStrictEqual(plain(w.eval('cartConflicts().map(l => l.unresolved)')), ['choice'], `${dir}: premise — the restored launcher line is blocked 'choice'`);
    assert.deepStrictEqual(parsed(beacons), [{ rid, event: 'restore', reasons: ['choice'] }], `${dir}: restore → one beacon`);
    ok(`${dir}: restore — a bare launcher restored from the payment stash → ONE {restore, [choice]} beacon`);
  }
  // ── 4. LARGE CART: 9 repriced + 1 sold out → ONE beacon, deduped, < 512 B ──
  {
    const { w, beacons, reprice } = await boot(dir);
    const ids = ordinary(w).slice(0, 10);
    assert.strictEqual(ids.length, 10, `${dir}: premise — 10 ordinary dishes`);
    for (const id of ids) w.chg(id, 1);
    await settle();
    assert.strictEqual(reprice(ids.slice(0, 9).map((id) => [id, priceOf(w, id) + 5])), 'applied');
    const gone = ids[9]; const realSoldOut = w.isSoldOut;
    w.isSoldOut = (rec) => (!!rec && String(rec.id) === String(gone)) || realSoldOut(rec);
    assert.strictEqual(plain(w.eval('cartConflicts().length')), 10, `${dir}: premise — 10 blocked lines`);
    assert.strictEqual(w.refuseConflictedSend('createOrder'), true);
    assert.strictEqual(beacons.length, 1, `${dir}: 🔴 ONE beacon for one refusal over 10 blocked lines`);
    const [body] = parsed(beacons);
    assert.deepStrictEqual(body, { rid, event: 'send', reasons: ['repriced', 'unavailable'] }, `${dir}: reasons deduped BEFORE serializing`);
    assert.ok(Buffer.byteLength(beacons[0].body) < 512, `${dir}: the body is ${Buffer.byteLength(beacons[0].body)} B`);
    fixture[rid] = beacons[0].body;
    ok(`${dir}: LARGE CART — 9 repriced + 1 sold out → ONE beacon, reasons exactly [repriced, unavailable], ${Buffer.byteLength(beacons[0].body)} B`);
  }
  // ── 5. FAILURE INJECTION: a broken beacon changes nothing about the refusal ──
  {
    const outcome = async (mode) => {
      const { w, c, reprice } = await boot(dir, mode);
      w.chg(c.X, 1); w.chg(c.Y, 1); await settle();
      reprice([[c.X, priceOf(w, c.X) + 13]]);
      w.localStorage.setItem(STASH[dir], JSON.stringify({ order_id: 'o_keep', ts: 1, form: { qty: {} } }));
      const sendRefused = w.refuseConflictedSend('createOrder');
      const built = w.buildOrder();
      let threw = null; try { await w.submitOrder('confirmed'); } catch (e) { threw = String(e); }
      await settle();
      return plain({ sendRefused, built, threw, msg: errText(w), cart: w.eval('cartLines().map(l => [String(l.key), l.qty, l.unresolved || null])'),
        orderSubmitting: w.eval('typeof orderSubmitting === "undefined" ? null : orderSubmitting'), paySubmitting: w.eval('window.__paySubmitting === undefined ? null : window.__paySubmitting'),
        stash: w.localStorage.getItem(STASH[dir]) });
    };
    const base = await outcome('ok');
    assert.strictEqual(base.sendRefused, true); assert.strictEqual(base.built, false);
    for (const mode of ['absent', 'throw', 'false']) assert.deepStrictEqual(await outcome(mode), base, `🔴 ${dir}: sendBeacon ${mode} changed the refusal`);
    ok(`${dir}: sendBeacon absent / throwing / returning false → refusal, message, cart, orderSubmitting/__paySubmitting and stash identical`);
  }
  // ── 6. CLEAN cash and card sends go out and emit NO beacon ──
  for (const path of ['cash', 'card']) {
    const { w, c, beacons, charges } = await boot(dir);
    w.chg(c.X, 1); await settle();
    w.selectPay(path === 'cash' ? 'cash' : 'online');
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder(), `${dir} ${path}: premise — the clean cart composes an order`);
    if (path === 'cash') { try { await w.submitOrder('confirmed'); } catch (_) {} } else { const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
    await settle(); await settle();
    assert.strictEqual(charges.length, 1, `${dir} ${path}: premise — the request left the page`);
    assert.strictEqual(beacons.length, 0, `🔴 ${dir} ${path}: a clean send emits NO beacon`);
  }
  ok(`${dir}: clean cash and clean card sends go out with ZERO beacons`);
}

// the composition fixture: the exact bodies the forms sent, posted by form-signal.emulator.test.js
const body = JSON.stringify(fixture, null, 1) + '\n';
if (process.env.FORM_SIGNAL_WRITE_FIXTURE === '1') { fs.writeFileSync(FIXTURE, body); console.log(`  wrote ${FIXTURE.pathname}`); }
assert.strictEqual(fs.readFileSync(FIXTURE, 'utf8'), body, '🔴 the large-cart fixture the emulator test posts is not what the forms send now');
ok('the committed large-cart fixture == the bodies both forms sent (the emulator test posts exactly these)');
clearTimeout(WATCHDOG);
closeAll();
console.log(`\nform-signal-client: OK (${count()})`);
process.exit(0);
