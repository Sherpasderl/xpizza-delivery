// PLAN-menu-ordering §3 — an order's serialization never depends on MENU order. Run: node cart-serial-order.test.mjs
// Both forms, the REAL booted page, the SERVER's own fingerprints over the bodies the form actually sent:
//   1  a fresh order serializes in CART INSERTION order — the same cart under a reversed menu sends identical items /
//      items_text, so identical orderFingerprint and charge_inputs_fp (cash and card); what the customer SEES still
//      follows the menu
//   2  a same-page retry keeps the pending order's FIRST serialization: remove a line and re-add it identically → the
//      same order_id and the same [A, B] (never [B, A]); the quote serializes exactly what the submit sends
//   3  a genuine cart change mints a new order; a REAL completed (cash) order releases the pin
//   4  DEPLOY-SPANNING: a stash written by the PRE-§3 page (git 03bc399, menu order) resumes on this page byte-identically —
//      the same order_id, items, items_text and both fingerprints, on card and cash, with extras, with and without a
//      reward (the resumed reward quote serializes the same items); a genuine change still differs (→ the server's 409)
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { counter, settle, envelope, loadForm, res, serve, BRAND, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { orderFingerprint } = require('./pixelpay-charge');
const { chargeInputsFingerprint } = require('./catalog/charge-inputs');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('cart-serial-order: FAILED — watchdog'); process.exit(1); }, 300000);
const CHARGE_RE = /createOrder|chargeOnlineOrder/;
const plain = (x) => JSON.parse(JSON.stringify(x));
const STASH = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };

// the PRE-§3 page, from git, beside this suite (loadForm resolves dirs relative to the harness); removed on exit
const OLD_SHA = '03bc399';
const ROOT = fileURLToPath(new URL('./', import.meta.url));
const OLD_DIR = 'node_modules/.serial-old-client';   // git-ignored and outside every census, even if a killed run leaves it
function materializeOld(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', OLD_SHA, `${dir}/`], { encoding: 'utf8' }).split('\n').filter((f) => /\.(html|js)$/.test(f));
  assert.ok(files.includes(`${dir}/index.html`), `premise: ${OLD_SHA} has ${dir}/index.html`);
  mkdirSync(`${ROOT}${OLD_DIR}/${dir}`, { recursive: true });
  for (const f of files) writeFileSync(`${ROOT}${OLD_DIR}/${f}`, execFileSync('git', ['-C', ROOT, 'show', `${OLD_SHA}:${f}`]));
}
process.on('exit', () => { try { rmSync(`${ROOT}${OLD_DIR}`, { recursive: true, force: true }); } catch (_) {} try { rmdirSync(`${ROOT}node_modules`); } catch (_) {} });   // the parent only if it is left empty

// per brand: two plain dishes, X before Y on the MENU, and an extra the form toggles on X by its own control
const CASES = {
  'xpizza-orders': { X: 2, Y: 19, extra: (w) => w.toggleDetailExtra('e4', 2, 0) },
  'la-musa-orders': { X: 'dimsum_01', Y: 'dimsum_03', extra: (w) => w.chgDetailExtra('rice_white', 'dimsum_01', 1) },
};

function respondWith(w, rid, menu, sent) {
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return res(envelope(rid, menu));
    const body = JSON.parse((init && init.body) || '{}');
    if (url.includes('quoteOrder')) { const t = computeServerTotal(body.items, rid); return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) }); }
    if (url.includes('quoteRedemption')) {   // the reward quote: priced over the items it was ASKED about (recorded)
      (w.__redq = w.__redq || []).push(body.items);
      const t = computeServerTotal(body.items, rid); const cents = Math.round(t.total * 100);
      return res(t.error ? { ok: false } : { ok: true, total_cents: cents, net_total_cents: cents, discount_cents: 0, subtotal_cents: cents, tax_cents: 0, free_items: [], free_item: { name: null }, total_cost: 0, remaining: 0, savings_cents: 0 });
    }
    if (CHARGE_RE.test(url)) {
      sent.push({ url, body });
      // the card path answers like the server: a hosted checkout to redirect to — which is when the page stashes the order
      return res(url.includes('chargeOnlineOrder') ? { ok: true, checkout_url: 'https://pay.test/checkout', order_id: body.order_id, poll_token: 'poll_tok_123' } : { ok: true });
    }
    return new Promise(() => {});
  };
}
const MARKER = { 'xpizza-orders': 'xpizza_acct', 'la-musa-orders': 'lamusa_acct' };
function fakeFirebase() {
  const snap = (v) => ({ exists: () => v != null, val: () => v });
  const user = { uid: 'u_serial', getIdToken: async () => 'tok', phoneNumber: '+50499990000' };
  return { app: {}, db: {}, auth: { currentUser: user, authStateReady: async () => {} },
    authMod: { onAuthStateChanged: (a, cb) => { cb(user); return () => {}; }, signOut: async () => {} },
    // the customer's own rewards node: a balance, and redemption live for them (canary) — without it account.js's
    // renderRedeem drops a pending reward once the state is definitive, which is the product's rule, not this test's case
    dbMod: { ref: (db, path) => ({ path }), get: async () => snap(null),
      onValue: (r, cb) => { cb(snap(r && /^user_rewards\//.test(r.path) ? { balance: 100000, reserved: 0, canary: true } : null)); return () => {}; }, off: () => {} } };
}
const signedIn = (dir) => ({ 'account.js': (code) => {
  const seam = 'async function ensureFirebase() {';
  assert.strictEqual(code.split(seam).length, 2, 'premise: account.js has exactly one ensureFirebase');
  return `try { localStorage.setItem(${JSON.stringify(MARKER[dir])}, ${JSON.stringify(JSON.stringify({ uid: 'u_serial', name: 'Ana Pérez', phone: '+50499990000' }))}); } catch (_) {}\n`
    + code.replace(seam, `${seam} if (window.__FB_FAKE) return window.__FB_FAKE;`);
} });
async function boot(dir, { reverse = false, old = false, account = false } = {}) {
  const B = BRAND[dir];
  const w = loadForm(old ? `${OLD_DIR}/${dir}` : dir, account ? { transforms: signedIn(dir) } : {});
  if (account) w.__FB_FAKE = fakeFirebase();
  await settle();
  const menu = B.menu(w);
  if (reverse) menu.dishes.reverse();
  await serve(w, envelope(B.rid, menu));
  const sent = [];
  respondWith(w, B.rid, menu, sent);
  return { w, sent, rid: B.rid, menu };
}
const menuPos = (w, id) => w.eval('MENU').findIndex((d) => String(d.id) === String(id));
async function fill(w, c) { w.chg(c.Y, 1); await settle(); w.chg(c.X, 1); await settle(); c.extra(w); await settle(); }   // Y first, then X (+ its extra)
const keysOf = (items, rid) => items.map((i) => (rid === 'la_musa' ? String(i.id) : i.name));
const nameOf = (w, id) => w.eval('MENU').find((d) => String(d.id) === String(id)).name;
const keyOfDish = (w, id, rid) => (rid === 'la_musa' ? String(id) : nameOf(w, id));
// the server's two fingerprints over a body, with the order id normalized (two pages mint two ids)
const fps = (b, id = 'O') => ({ legacy: orderFingerprint(id, Math.round(Number(b.total) * 100), b.items_text), charge: chargeInputsFingerprint({ ...b, order_id: id }) });
async function send(w, sent, path) {
  const before = sent.length;
  w.selectPay(path === 'cash' ? 'cash' : 'online');   // chosen BEFORE the build, as the customer does
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `premise — the cart composes an order (${path})`);
  if (path === 'cash') { try { await w.submitOrder('confirmed'); } catch (_) {} }
  else { const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
  await settle(); await settle();
  assert.strictEqual(sent.length, before + 1, `premise — one ${path} request left the page`);
  return sent[sent.length - 1].body;
}

for (const dir of Object.keys(CASES)) {
  const c = CASES[dir];
  const RID = BRAND[dir].rid;
  // ── 1. insertion order; a reversed menu sends identical bodies ──
  {
    const a = await boot(dir);
    const r = await boot(dir, { reverse: true });
    assert.ok(menuPos(a.w, c.X) < menuPos(a.w, c.Y) && menuPos(r.w, c.X) > menuPos(r.w, c.Y), `${dir}: premise — X precedes Y on the menu, and the reversed menu flips them`);
    await fill(a.w, c); await fill(r.w, c);
    const want = [keyOfDish(a.w, c.Y, a.rid), keyOfDish(a.w, c.X, a.rid)];
    assert.deepStrictEqual(plain(a.w.eval('cartLines().map(l => String(l.key))')), [String(c.X), String(c.Y)], `${dir}: what the customer SEES follows the menu`);
    assert.deepStrictEqual(plain(r.w.eval('cartLines().map(l => String(l.key))')), [String(c.Y), String(c.X)], `${dir}: …the reversed menu too (non-vacuity: the menu really moved)`);
    for (const path of ['cash', 'card']) {
      const ba = await send(a.w, a.sent, path), br = await send(r.w, r.sent, path);
      assert.deepStrictEqual(keysOf(ba.items, a.rid), want, `🔴 ${dir} ${path}: items serialize in INSERTION order (Y then X)`);
      assert.ok(ba.items_text.indexOf(nameOf(a.w, c.Y)) < ba.items_text.indexOf(nameOf(a.w, c.X)), `🔴 ${dir} ${path}: items_text in the same order`);
      assert.deepStrictEqual(br.items, ba.items, `🔴 ${dir} ${path}: a reversed menu sends identical items`);
      assert.strictEqual(br.items_text, ba.items_text, `🔴 ${dir} ${path}: …and identical items_text`);
      assert.ok(fps(ba).charge, `${dir} ${path}: premise — the body is fingerprintable (every field classified)`);
      assert.deepStrictEqual(fps(br), fps(ba), `🔴 ${dir} ${path}: identical orderFingerprint and charge_inputs_fp under a reversed menu`);
    }
  }
  ok(`${dir}: a fresh order serializes in cart insertion order; the same cart under a reversed menu sends identical items, items_text and both server fingerprints (cash + card); the display still follows the menu`);

  // ── 2. a same-page retry keeps the first serialization; quote == submit ──
  {
    const { w, sent } = await boot(dir);
    const quoted = [];
    const real = w.__respond;
    w.__respond = (url, init) => { if (url.includes('quoteOrder')) quoted.push(JSON.parse(init.body).items); return real(url, init); };
    w.selectPay('online');
    w.chg(c.X, 1); await settle(); w.chg(c.Y, 1); await settle();
    w.requestServerQuote(); await settle();
    assert.ok(quoted.length >= 1, `${dir}: premise — the cart was quoted`);
    assert.ok(w.buildOrder());
    const first = plain(w.eval('currentOrder'));
    assert.deepStrictEqual(quoted[quoted.length - 1], first.items, `🔴 ${dir}: the quote serializes exactly what the order sends`);
    // back to the cart: X out and back in, identically → insertion order is now [Y, X]
    w.chg(c.X, -1); await settle(); w.chg(c.X, 1); await settle();
    assert.deepStrictEqual(plain(w.eval('resolvedCartLines().map(l => String(l.key))')), [String(c.Y), String(c.X)], `${dir}: non-vacuity — insertion order really became [Y, X]`);
    w.requestServerQuote(); await settle();
    assert.ok(w.buildOrder());
    const again = plain(w.eval('currentOrder'));
    assert.strictEqual(again.order_id, first.order_id, `${dir}: the same cart → the same order_id (cartSig)`);
    assert.deepStrictEqual(again.items, first.items, `🔴 ${dir}: the pending order keeps its FIRST serialization [X, Y]`);
    assert.strictEqual(again.items_text, first.items_text, `🔴 ${dir}: …items_text too`);
    assert.deepStrictEqual(quoted[quoted.length - 1], again.items, `🔴 ${dir}: and the retry's quote serializes the pinned order as well`);
    const body = await send(w, sent, 'card');
    assert.deepStrictEqual(fps(body, first.order_id), fps(first, first.order_id), `🔴 ${dir}: the retry's charge fingerprints equal the first build's`);
    // ── 3. a genuine change mints a new order (pinned order + the new line); completion releases the pin ──
    w.chg(c.Y, 1); await settle();
    assert.ok(w.buildOrder());
    const changed = plain(w.eval('currentOrder'));
    assert.notStrictEqual(changed.order_id, first.order_id, `${dir}: a genuine change is a new order`);
    assert.deepStrictEqual(keysOf(changed.items, RID), keysOf(first.items, RID), `${dir}: …serialized through the pin (no reshuffle)`);
  }
  ok(`${dir}: a same-page retry (remove + re-add) keeps the same order_id and its FIRST serialization; quote == submit; a genuine change is a new order; completion releases the pin`);
  // ── 3b. the REAL completion: a cash order that succeeds releases the pin with its order_id ──
  {
    const { w, sent } = await boot(dir);
    w.chg(c.X, 1); await settle(); w.chg(c.Y, 1); await settle();
    await send(w, sent, 'cash');
    assert.strictEqual(w.eval('SERIAL.current()'), null, `🔴 ${dir}: a completed order releases the pin`);
    assert.strictEqual(w.eval('window.__pendingOrder'), null, `${dir}: …with its order_id`);
    for (const k of plain(w.eval('resolvedCartLines().map(l => String(l.key))'))) w.eval(`chg(${JSON.stringify(/^\d+$/.test(k) ? Number(k) : k)}, -100)`);
    await settle();
    w.chg(c.Y, 1); await settle(); w.chg(c.X, 1); await settle();
    assert.ok(w.buildOrder());
    assert.deepStrictEqual(keysOf(plain(w.eval('currentOrder')).items, RID), [keyOfDish(w, c.Y, RID), keyOfDish(w, c.X, RID)], `🔴 ${dir}: the next order serializes in insertion order again (the old pin said [X, Y])`);
  }

  // ── 4. DEPLOY-SPANNING: the pre-§3 page's stash resumes here byte-identically ──
  {
    materializeOld(dir);
    const old = await boot(dir, { old: true });
    await fill(old.w, c);                                   // insertion [Y, X]; the OLD page serializes in MENU order [X, Y]
    const oldBody = await send(old.w, old.sent, 'card');
    const rid = old.rid;
    assert.deepStrictEqual(keysOf(oldBody.items, rid), [keyOfDish(old.w, c.X, rid), keyOfDish(old.w, c.Y, rid)], `${dir}: premise — the OLD page serialized in menu order`);
    const stash = old.w.localStorage.getItem(STASH[dir]);
    assert.ok(stash && JSON.parse(stash).order_id === oldBody.order_id, `${dir}: premise — the old page stashed its pending payment`);
    assert.strictEqual(oldBody.payment_method, 'online', `${dir}: premise — the old page's body is a real card body`);
    for (const path of ['card', 'cash']) {
      const { w, sent } = await boot(dir);
      w.localStorage.setItem(STASH[dir], stash);
      w.restoreOrderForm(); await settle();
      assert.deepStrictEqual(plain(w.eval('resolvedCartLines().map(l => String(l.key))')), [String(c.Y), String(c.X)], `${dir}: non-vacuity — the restored cart's insertion order is [Y, X], not the stash's`);
      const body = await send(w, sent, path);
      assert.strictEqual(body.order_id, oldBody.order_id, `🔴 ${dir} ${path}: the resumed order keeps its order_id (no new id minted)`);
      assert.deepStrictEqual(body.items, oldBody.items, `🔴 ${dir} ${path}: items byte-identical to the old page's payload`);
      assert.strictEqual(body.items_text, oldBody.items_text, `🔴 ${dir} ${path}: items_text byte-identical`);
      assert.strictEqual(fps(body, body.order_id).legacy, fps(oldBody, oldBody.order_id).legacy, `🔴 ${dir} ${path}: the same orderFingerprint`);
      if (path === 'card') assert.strictEqual(chargeInputsFingerprint(body), chargeInputsFingerprint(oldBody), `🔴 ${dir} card: the same charge_inputs_fp`);
    }
    // a genuine change on resume still differs → the server's fingerprint check refuses it (409)
    {
      const { w, sent } = await boot(dir);
      w.localStorage.setItem(STASH[dir], stash);
      w.restoreOrderForm(); await settle();
      w.chg(c.Y, 1); await settle();
      const body = await send(w, sent, 'card');
      assert.notStrictEqual(chargeInputsFingerprint(body), chargeInputsFingerprint(oldBody), `🔴 ${dir}: a genuine change on resume still changes the fingerprint (the server 409s it)`);
    }
  }
  // ── 4b. …with a REWARD pending: the resumed reward quote and the body serialize exactly the old page's payload ──
  {
    const REWARD = { 'xpizza-orders': { type: 'free_pizza_choice', item_id: 'Carnivora', name: 'Carnivora' },
                     'la-musa-orders': { type: 'points_ala_carte', items: [{ id: 'dimsum_03', qty: 1, name: 'Wonton' }] } }[dir];
    const old = await boot(dir, { old: true, account: true });
    await fill(old.w, c);
    old.w.__ACCOUNT.restoreRedeem(REWARD, null, null);
    await old.w.__ACCOUNT.requoteRedeem(old.w.redeemCartItems()); await settle();
    assert.ok(old.w.__ACCOUNT.getRedeemPayload(), `${dir}: premise — the old page holds the reward`);
    const oldBody = await send(old.w, old.sent, 'card');
    assert.ok(oldBody.redeem, `${dir}: premise — the old page's card body carries the reward`);
    const stash = old.w.localStorage.getItem(STASH[dir]);
    for (const path of ['card', 'cash']) {
      const { w, sent } = await boot(dir, { account: true });
      w.localStorage.setItem(STASH[dir], stash);
      w.restoreOrderForm(); await settle(); await settle();
      const body = await send(w, sent, path);
      assert.deepStrictEqual(body.redeem, oldBody.redeem, `${dir} ${path}: the resumed order re-attaches the same reward`);
      assert.strictEqual(body.order_id, oldBody.order_id, `🔴 ${dir} ${path} + reward: the same order_id`);
      assert.deepStrictEqual(body.items, oldBody.items, `🔴 ${dir} ${path} + reward: items byte-identical`);
      assert.strictEqual(body.items_text, oldBody.items_text, `🔴 ${dir} ${path} + reward: items_text byte-identical`);
      assert.deepStrictEqual(plain(w.__redq[w.__redq.length - 1]), body.items, `🔴 ${dir} ${path} + reward: the resumed reward quote serializes the same items`);
      if (path === 'card') assert.strictEqual(chargeInputsFingerprint(body), chargeInputsFingerprint(oldBody), `🔴 ${dir} card + reward: the same charge_inputs_fp`);
    }
  }
  ok(`${dir}: a stash written by the pre-§3 page (${OLD_SHA}, menu order) resumes here byte-identically — order_id, items, items_text, orderFingerprint, charge_inputs_fp — on card and cash, with an extra, with and without a reward; a genuine change still differs`);
}

closeAll();
clearTimeout(WATCHDOG);
console.log('\ncart-serial-order: OK');
process.exit(0);
