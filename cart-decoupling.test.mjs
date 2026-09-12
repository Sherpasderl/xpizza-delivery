// Portal 1B Task 4 — THE CART IS DECOUPLED FROM THE DISPLAYED MENU. Run: node cart-decoupling.test.mjs
//
// 🔴 WHAT THIS PROTECTS. Both order forms used to serialize the order as `MENU.filter(p => qty[p.id] > 0)`.
// 1B makes MENU replaceable while a customer is shopping, and at that moment the expression stops meaning
// "the cart" and starts meaning "the part of the cart the menu still agrees with". A dish the merchant
// removed leaves the SUBMISSION, silently, while qty[id] still says 2 — a customer is charged for an order
// they did not place, and nothing logs an error. The same one line down drops a vanished OPTION out of the
// order and out of the price.
//
// Every test below runs the REAL extracted functions — chg, calcTotal, redeemCartItems, cartSig, and the
// real guard clause lifted out of submitOrder — against a MENU that is swapped underneath them, exactly as
// Task 6's apply will swap it. Nothing is paraphrased.
//
// AND THE HALF THAT MATTERS JUST AS MUCH: with no live conflict, the serialization must be IDENTICAL to
// what shipped. Tests 1-2 assert that against a reference implementation of the old expression, because a
// refactor of two live money forms that quietly changes the normal path is a worse outcome than the bug.
//
// BOTH FORMS, every test — they key options differently (x_pizza per pizza instance, la_musa per item with
// a quantity) and are priced differently (by name / by id), so a rule proven on one is not proven.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let n = 0, failures = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// The real 202-in_progress retry re-enters processPixelPay through setTimeout (immediate here), so the
// continuation runs on a later turn than the call that scheduled it. Drain before asserting.
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const grab = (html, re, what) => { const m = html.match(re); assert.ok(m, `${what} not found in form — the harness would be unsound`); return m[0]; };

// Lift the real code out of the form and run it in a scope where MENU is swappable. Everything the
// extracted code needs is injected by name: anything under-injected throws a loud ReferenceError rather
// than passing quietly.
// ── Brand fixtures. Deliberately NOT derived from the forms' own bundles: a fixture that came from the
// code under test could agree with a broken derivation. Shapes match each brand's real records.
const BRANDS = {
  'xpizza-orders': {
    MENU: () => ([{ id: 1, name: 'Margherita', price: 250, cat: 'individual' },
                  { id: 2, name: 'Pepperoni',  price: 280, cat: 'individual' },
                  { id: 3, name: 'Carnivora',  price: 340, cat: 'individual' }]),
    EXTRAS: () => ([{ id: 'e-chorizo', name: 'Chorizo', price: 45 }, { id: 'e-queso', name: 'Queso extra', price: 30 }]),
    // Reference implementation of the OLD serialization, written from the shipped expression.
    oldSerialize: (MENU, EXTRAS, qty, pizzaExtras) => MENU.filter(p => qty[p.id] > 0).map(p => {
      const instances = pizzaExtras[p.id] || {}; const extrasArr = [];
      Object.entries(instances).forEach(([inst, extras]) => {
        if (typeof extras !== 'object') return;
        Object.entries(extras).filter(([, q]) => q > 0).forEach(([eid]) => {
          const ex = EXTRAS.find(e => e.id === eid);
          if (ex) extrasArr.push({ instance: parseInt(inst), name: ex.name, price: ex.price });
        });
      });
      const extrasTotal = extrasArr.reduce((s, e) => s + e.price, 0);
      return { name: p.name, qty: qty[p.id], price: p.price, subtotal: p.price * qty[p.id], extras: extrasArr, extrasTotal };
    }),
    oldTotal: (MENU, EXTRAS, qty, pizzaExtras) => {
      let total = MENU.reduce((s, p) => s + p.price * qty[p.id], 0);
      Object.entries(pizzaExtras).forEach(([pid, instances]) => {
        if (qty[pid] < 1) return;
        Object.entries(instances).forEach(([, extras]) => {
          if (typeof extras !== 'object') return;
          Object.entries(extras).forEach(([eid, q]) => { const ex = EXTRAS.find(e => e.id === eid); if (ex) total += ex.price * q; });
        });
      });
      return total;
    },
  },
  'la-musa-orders': {
    MENU: () => ([{ id: 'lm-pollo',   name: 'Pollo a la brasa', price: 180, cat: 'principales' },
                  { id: 'lm-lomo',    name: 'Lomo saltado',     price: 260, cat: 'principales' },
                  { id: 'lm-ceviche', name: 'Ceviche',          price: 220, cat: 'entradas' }]),
    EXTRAS: () => ([{ id: 'lm-arroz', name: 'Arroz', price: 40 }, { id: 'lm-salsa', name: 'Salsa huancaina', price: 25 }]),
    oldSerialize: (MENU, EXTRAS, qty, pizzaExtras) => MENU.filter(p => qty[p.id] > 0).map(p => {
      const itemExtras = pizzaExtras[p.id] || {};
      const extrasArr = Object.entries(itemExtras).filter(([, q]) => q > 0).map(([eid, q]) => {
        const ex = EXTRAS.find(e => e.id === eid);
        return ex ? { id: ex.id, name: ex.name, price: ex.price, qty: q } : null;
      }).filter(Boolean);
      const extrasTotal = extrasArr.reduce((s, e) => s + e.price * e.qty, 0);
      return { id: p.id, name: p.name, cat: p.cat, qty: qty[p.id], price: p.price,
               subtotal: p.price * qty[p.id] + extrasTotal, extras: extrasArr, extrasTotal };
    }),
    oldTotal: (MENU, EXTRAS, qty, pizzaExtras) => {
      let total = MENU.reduce((s, p) => s + p.price * qty[p.id], 0);
      Object.entries(pizzaExtras).forEach(([pid, extras]) => {
        if ((qty[pid] || 0) < 1) return;
        if (!extras || typeof extras !== 'object') return;
        Object.entries(extras).forEach(([eid, q]) => { const ex = EXTRAS.find(e => e.id === eid); if (ex && q > 0) total += ex.price * q; });
      });
      return total;
    },
  },
};

// Reach into the harness's own state objects so a test can arrange options the way the form's own
// stepper does, and read back the exact qty/pizzaExtras the extracted code sees.
function setup(dir) {
  const B = BRANDS[dir];
  const MENU = B.MENU(), EXTRAS = B.EXTRAS();
  const ctxQty = {}, ctxExtras = {};
  const html = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  const f = makeFormWith(dir, html, MENU, EXTRAS, ctxQty, ctxExtras);
  return { B, MENU, EXTRAS, qty: ctxQty, pizzaExtras: ctxExtras, f };
}

function makeFormWith(dir, html, MENU, EXTRAS, qty, pizzaExtras) {
  const { createCart } = require(`./${dir}/form-cart.js`);
  const cartBlock = grab(html, /const CART = window\.createCart\(\{[\s\S]*?__onCartConflict\(conflicts\)[\s\S]*?\n\}/, 'the cart block');
  const chgFn     = grab(html, /\nfunction chg\(id,d\)\{[\s\S]*?\n\}\n/, 'chg()');
  const calcFn    = grab(html, /\nfunction calcTotal\(\)\{[\s\S]*?\n\}\n/, 'calcTotal()');
  const redeemFn  = grab(html, /\nfunction redeemCartItems\(\)\{[\s\S]*?\n\}\n/, 'redeemCartItems()');
  const sigFn     = grab(html, /\nfunction cartSig\(\)\{[\s\S]*?\n\}\n/, 'cartSig()');
  // The guard itself, verbatim — and separately, proof of WHERE it sits. A gate that ran after
  // orderSubmitting was set, or after the payload was built, would pass a "it refused" assertion while
  // leaving the form wedged; the bounded match below is what pins it to the top of submitOrder.
  /* 🔴 EVERY SOURCE-LEVEL ASSERTION HAS MOVED to form-cart.copy.test.mjs, and this is the same
     correction as the Task 3 drift-mask. The mutation sweep runs THIS file; while a textual check
     for "the gate is present" lived here, a mutant that deleted a gate was killed by the TEXT and
     never had to reach a behavioural assertion — so a count of kills said nothing about whether
     any behaviour noticed. What remains below is extraction only: if an anchor stops matching the
     harness fails loudly as unsound, which is not a kill. The structural census still runs in
     npm test, where catching a hand-edit is exactly its job. */
  const buildFn   = grab(html, /\nfunction buildOrder\(\)\{[\s\S]*?\n\}\n/, 'buildOrder()');
  const submitFn  = grab(html, /\nasync function submitOrder\(paymentStatus\)\{[\s\S]*?\n\}\n/, 'submitOrder()');
  // The REAL dispatch. Everything above it is reachable directly; this is the function the button calls,
  // and it is the only way to prove the cash/online branch itself honours a refusal.
  const dispatchFn = grab(html, /\nasync function processPayment\(\)\{[\s\S]*?\n\}\n/, 'processPayment()');
  // 🔴 THE REAL paymentFallback, not a stub. It sets orderSubmitting=false, and the committed
  // online-retry test depended on that WITHOUT it being true: an inert stub left the lock held, so the
  // re-entry stopped at `if(orderSubmitting) return` and never reached the send gate. A rule above the
  // one under test, masking it — the same shape as the entry gate that hid the send gate.
  const fallbackFn = grab(html, /\nfunction paymentFallback\(msg\)\{[\s\S]*?\n\}\n/, 'paymentFallback()');
  const payFn     = grab(html, /\nasync function processPixelPay\(\)\{[\s\S]*?\n\}\n/, 'processPixelPay()');
  const snapFn    = grab(html, /\nfunction snapshotForm\(\)\{[\s\S]*?\n\}\n/, 'snapshotForm()');
  const restoreFn = grab(html, /\nfunction restoreOrderForm\(\)\{[\s\S]*?\n\}\n/, 'restoreOrderForm()');
  const optFn     = dir === 'xpizza-orders'
    ? grab(html, /\nfunction toggleDetailExtra\(extraId, pizzaId, instance\) \{[\s\S]*?\n\}\n/, 'toggleDetailExtra()')
    : grab(html, /\nfunction chgDetailExtra\(extraId, pizzaId, delta\) \{[\s\S]*?\n\}\n/, 'chgDetailExtra()');
  MENU.forEach(p => { qty[p.id] = 0; });
  // A persistent fake-element cache. The DOM is not what is under test — the cart is — but the real
  // buildOrder()/snapshotForm() read a dozen fields, and the notice assertions need the SAME object back.
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { value: '', textContent: '', checked: false, style: {}, classList: { add(){}, remove(){}, toggle(){} }, focus(){}, remove(){}, scrollIntoView(){} }); return els.get(id); };
  const errEl = el('err3');
  const win = { createCart, __ACCOUNT: null, __onCartConflict: null, __scheduledFor: null, __timeMode: 'standard', location: { href: '' } };
  const doc = { getElementById: el, querySelector: () => null, querySelectorAll: () => [] };
  const notices = [], fetchCalls = [], plan = [], stages = [];
  let stash = null;
  const ctlRef = {};
  const api = new Function('ctx', `
    let MENU = ctx.MENU, EXTRAS = ctx.EXTRAS;
    const pizzaExtras = ctx.pizzaExtras, qty = ctx.qty;
    const window = ctx.window, document = ctx.document;
    const console = { warn: (...a) => ctx.notices.push(a), log: () => {}, error: () => {} };
    const soldOutById = () => false, registerOutsideClick = () => {}, refreshCardExtrasIndicator = () => {};
    const updateDetailModal = () => {}, updateDetailCta = () => {}, updateTotal = () => {}, updateCart = () => {};
    const refreshPickupGate = () => {}, itemIsLauncher = () => false;
    // Collaborators the REAL buildOrder / processPixelPay / restoreOrderForm call. All inert: this suite
    // is about which paths the cart gate covers, not about rendering or networking.
    const orderIdForThisCart = () => 'ord_test_1', redeemAdjustedTotal = () => calcTotal();
    const rtnIsValid = () => true, phoneCC = '504', ICON_CHECK_CIRCLE = '';
    // Recorded, not inert: honouring buildOrder()'s refusal is now an EARLY-FEEDBACK rule rather than a
    // money rule (the send gate is the money rule), and the difference it makes is visible exactly here —
    // the customer is never shown the "sending your order" stage for an order that will be refused.
    const showStage = (st) => ctx.stages.push(st);
    const setSending = () => {}, renderMenu = () => {}, selectPay = () => {};
    const setOrderType = () => {}, initMap = () => {}, showPayReturn = () => {}, toggleRtn = () => {};
    const renderRedeemUI = () => {}, applyRedeemQuoteToTotals = () => {}, setCashTendered = () => {};
    const showSuccess = () => {}, setPayError = () => {};
    const ICON_X_CIRCLE = '', ORDER_SECRET = 'test-secret';
    // processPayment's own validation chain. Pickup orders skip the delivery checks (map, zone, address
    // detail), leaving the payment/RTN gates — satisfied so the dispatch reaches the cart gate, which is
    // what is under test. A validation that refused earlier would make every assertion below vacuous.
    const isOpen = () => true, weekendOnlyBlocked = () => false;
    let isWithinDeliveryZone = true;
    let __restorePos = null, currentOrder = {};
    const RESTAURANT_ID = ctx.rid, MIN_ORDER = 0, LA_MUSA_FALLBACK_EMAIL = 'pedidos@lamusa.test';
    const CREATEORDER_URL = 'http://test/createOrder', CHARGEORDER_URL = 'http://test/chargeOnlineOrder';
    const location = { href: '' };
    const localStorage = { getItem: () => (ctx.getStash() ? JSON.stringify(ctx.getStash()) : null), setItem: () => {}, removeItem: () => {} };
    /* 🔴 THE NETWORK IS RECORDED, NOT FORBIDDEN — and that is the difference between this suite and
       the one that let two bypasses through. A stub that throws on any call makes "no request was
       sent" indistinguishable from "the code crashed on the way there", so a deleted gate survives.
       Recording instead lets every negative assertion be paired with a POSITIVE CONTROL that proves
       the harness can reach the send at all. ctx.plan scripts the responses (a 500 drives the real
       retry loop); ctx.onFetch lets a test change the menu mid-flight, which is exactly how a
       merchant's publish lands between attempt 1 and attempt 2. */
    const fetch = async (url) => {
      ctx.fetchCalls.push(String(url));
      if (ctx.onFetch) ctx.onFetch(ctx.fetchCalls.length);
      const step = ctx.plan.shift();
      if (step === 'throw') throw new Error('network blip');
      const status = step && step.status ? step.status : 200;
      return { ok: status < 400, status, json: async () => (step && step.body) || {} };
    };
    // The real retry backs off 1.5s then 3s. The gate, not the wait, is under test.
    const setTimeout = (fn) => { fn(); return 0; };
    let currentDetailPizzaId = null, orderSubmitting = false;
    // The order-context fields cartSig hashes alongside the items. Held constant across a comparison so
    // that when two sigs differ, the CART is the only thing that could have made them differ.
    let orderType = 'delivery', pickupTimeType = 'standard', pickupScheduledTime = null;
    let selectedPayment = 'cash', tendered = '', rtnOn = false, lat = null, lng = null, __scheduledFor = null;
    const fullPhone = () => '+50499999999';
    ${cartBlock}
    ${chgFn}
    ${calcFn}
    ${redeemFn}
    ${sigFn}
    ${submitFn}
    ${dispatchFn}
    ${fallbackFn}
    /* 🔴 "BLOCKED" NOW MEANS "createOrder WAS NEVER CALLED", not "an extracted fragment returned
       early". The previous definition ran a lifted copy of submitOrder's guard — which is precisely
       why the cash RETRY bypass was invisible: the fragment had no retry loop in it. This runs the
       real function, all three attempts, and reports what reached the network. */
    async function submitGate(){
      const before = ctx.fetchCalls.length;
      await submitOrder('confirmed');
      const sent = ctx.fetchCalls.slice(before).filter((u) => u.includes('createOrder'));
      return sent.length ? 'PROCEEDED' : undefined;
    }
    ${buildFn}
    ${payFn}
    ${snapFn}
    ${restoreFn}
    ${optFn}
    return { chg, calcTotal, redeemCartItems, cartSig, submitGate, cartConflicts, cartLines, cartItems, cartCount, CART,
             noteExtra: (r) => CART.noteExtra(r), qtyOf: (id) => qty[id],
             buildOrder, processPixelPay, snapshotForm, restoreOrderForm, currentOrder: () => currentOrder,
             fetchCalls: ctx.fetchCalls, setStash: ctx.setStash, submitOrder, processPayment,
             asPickup: () => { orderType = 'pickup'; }, paySelect: (m) => { selectedPayment = m; },
             optionControl: ${dir === 'xpizza-orders' ? '(eid, pid) => toggleDetailExtra(eid, pid, 0)' : '(eid, pid, d) => chgDetailExtra(eid, pid, d === undefined ? 1 : d)'},
             liveMenu: () => MENU, setMenu: (m, e) => { MENU = m; if (e) EXTRAS = e; } };
  `)({ MENU, EXTRAS, pizzaExtras, qty, window: win, document: doc, notices, fetchCalls,
       rid: dir === 'xpizza-orders' ? 'x_pizza' : 'la_musa', plan, stages,
       get onFetch() { return ctlRef.onFetch; },
       getStash: () => stash, setStash: (v) => { stash = v; } });
  const ctl = { plan, setPlan: (p) => { plan.length = 0; plan.push(...p); }, onFetch: (fn) => { ctlRef.onFetch = fn; } };
  return { ...api, errEl, notices, win, fetchCalls, stages, ...ctl };
}

// Add an option the way each brand's stepper does, INCLUDING the capture the form performs.
const addOption = (dir, f, pizzaExtras, pid, ex) => {
  if (dir === 'xpizza-orders') { (pizzaExtras[pid] ||= {}); (pizzaExtras[pid][0] ||= {}); pizzaExtras[pid][0][ex.id] = 1; }
  else { (pizzaExtras[pid] ||= {}); pizzaExtras[pid][ex.id] = 1; }
  f.noteExtra(ex);
};

for (const dir of Object.keys(BRANDS)) {
  console.log(`\n══ ${dir} ══`);
  const B = BRANDS[dir];

  // ── 1. NO REGRESSION — the normal path serializes exactly as the shipped expression did ──
  {
    const { f, MENU, EXTRAS, qty, pizzaExtras } = setup(dir);
    f.chg(MENU[0].id, 2); f.chg(MENU[2].id, 1);
    addOption(dir, f, pizzaExtras, MENU[0].id, EXTRAS[0]);
    assert.deepStrictEqual(f.redeemCartItems(), B.oldSerialize(MENU, EXTRAS, qty, pizzaExtras),
      `${dir}: no-conflict serialization must equal the shipped MENU-derived expression`);
    assert.strictEqual(f.calcTotal(), B.oldTotal(MENU, EXTRAS, qty, pizzaExtras), `${dir}: no-conflict total must be unchanged`);
    assert.strictEqual(await f.submitGate(), 'PROCEEDED', `${dir}: a clean cart must submit`);
    ok(`${dir}: NO REGRESSION — clean cart serializes + totals byte-identically to the shipped expression`);
  }

  // ── 2. NO REGRESSION — line ORDER still follows MENU, not insertion ──
  {
    const { f, MENU, EXTRAS, qty, pizzaExtras } = setup(dir);
    f.chg(MENU[2].id, 1); f.chg(MENU[0].id, 1);        // added LAST-first
    assert.deepStrictEqual(f.redeemCartItems().map(l => l.name), [MENU[0].name, MENU[2].name],
      `${dir}: lines must serialize in MENU order regardless of the order they were added`);
    assert.deepStrictEqual(f.redeemCartItems(), B.oldSerialize(MENU, EXTRAS, qty, pizzaExtras), `${dir}: still identical to the old expression`);
    ok(`${dir}: NO REGRESSION — MENU ordering preserved (not cart-insertion order)`);
  }

  // ── 3. A REMOVED DISH IS NOT DROPPED FROM THE SUBMISSION ──
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[1].id, 2);
    f.setMenu(MENU.filter(p => p.id !== MENU[1].id));   // the live upgrade removes it
    const lines = f.redeemCartItems();
    assert.strictEqual(lines.length, 1, `${dir}: the line must survive the dish leaving MENU`);
    assert.strictEqual(lines[0].name, MENU[1].name, `${dir}: it must still be named`);
    assert.strictEqual(lines[0].qty, 2, `${dir}: it must keep its quantity`);
    assert.strictEqual(lines[0].price, MENU[1].price, `${dir}: it must keep the price it was added at`);
    ok(`${dir}: a dish removed by a live upgrade stays in the cart, named, with its qty and added price`);
  }

  // ── 4. …AND STAYS IN THE TOTAL ──
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[1].id, 2);
    const before = f.calcTotal();
    f.setMenu(MENU.filter(p => p.id !== MENU[1].id));
    assert.strictEqual(f.calcTotal(), before, `${dir}: the total must not shrink when the menu drops a dish`);
    assert.strictEqual(f.cartCount(), 2, `${dir}: the cart badge must not silently decrement`);
    ok(`${dir}: the displayed total and count do not quietly shrink when a dish leaves the menu`);
  }

  // ── 5. …AND BLOCKS SUBMIT, VISIBLY ──
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[1].id, 1);
    assert.strictEqual(await f.submitGate(), 'PROCEEDED', `${dir}: control — it submits before the change`);
    f.setMenu(MENU.filter(p => p.id !== MENU[1].id));
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: submit must be refused while a line is unresolved`);
    assert.strictEqual(f.cartConflicts()[0].unresolved, 'removed', `${dir}: and the reason must be 'removed', not merely "it refused"`);
    assert.match(f.errEl.textContent, new RegExp(MENU[1].name), `${dir}: the customer must be told which line changed`);
    assert.strictEqual(f.notices.length, 1, `${dir}: and it must be logged`);
    ok(`${dir}: an unresolved line BLOCKS submit, names the dish to the customer, and logs`);
  }

  // ── 6. A RE-PRICED DISH KEEPS THE PRICE THE CUSTOMER AGREED TO ──
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p)));
    assert.strictEqual(f.redeemCartItems()[0].price, MENU[0].price, `${dir}: the line must NOT adopt the new price silently`);
    assert.strictEqual(f.cartConflicts()[0].unresolved, 'repriced', `${dir}: pinned reason — repriced`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: and it must block submit`);
    ok(`${dir}: a re-priced dish keeps its agreed price and blocks submit (never silently re-priced)`);
  }

  // ── 7. AN OPTION THAT VANISHES DOES NOT VANISH FROM THE ORDER ──
  {
    const { f, MENU, EXTRAS, pizzaExtras } = setup(dir);
    f.chg(MENU[0].id, 1);
    addOption(dir, f, pizzaExtras, MENU[0].id, EXTRAS[0]);
    const before = f.calcTotal();
    f.setMenu(f.liveMenu(), EXTRAS.filter(e => e.id !== EXTRAS[0].id));   // option pulled from the live menu
    const line = f.redeemCartItems()[0];
    assert.strictEqual(line.extras.length, 1, `${dir}: the option must not be dropped from the order`);
    assert.strictEqual(line.extras[0].price, EXTRAS[0].price, `${dir}: it keeps its captured price`);
    assert.strictEqual(f.calcTotal(), before, `${dir}: and stays in the total`);
    // 🔴 THE DIRECTION I EXPECTED TO MISS: the DISH still resolves cleanly. Only the option is gone.
    assert.strictEqual(f.cartConflicts().length, 1, `${dir}: the line must be blocked BY ITS OPTION`);
    assert.strictEqual(f.cartConflicts()[0].unresolved, null, `${dir}: …and not because the dish is unresolved — it isn't`);
    assert.strictEqual(f.cartConflicts()[0].extras.find(x => x.unresolved).unresolved, 'removed', `${dir}: pinned reason on the option`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: a clean dish with a vanished option still blocks submit`);
    ok(`${dir}: a vanished OPTION is retained, counted, and blocks submit even though its dish is fine`);
  }

  // ── 8. A RE-PRICED OPTION IS NOT SILENTLY ADOPTED ──
  {
    const { f, MENU, EXTRAS, pizzaExtras } = setup(dir);
    f.chg(MENU[0].id, 1);
    addOption(dir, f, pizzaExtras, MENU[0].id, EXTRAS[0]);
    f.setMenu(f.liveMenu(), EXTRAS.map(e => (e.id === EXTRAS[0].id ? { ...e, price: e.price + 55 } : e)));
    assert.strictEqual(f.redeemCartItems()[0].extras[0].price, EXTRAS[0].price, `${dir}: the option keeps its agreed price`);
    assert.strictEqual(f.cartConflicts()[0].extras.find(x => x.unresolved).unresolved, 'repriced', `${dir}: pinned reason`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: and blocks submit`);
    ok(`${dir}: a re-priced OPTION keeps its agreed price and blocks submit`);
  }

  // ── 9. AN UNRESOLVED LINE IS STILL REMOVABLE, AND THAT UNBLOCKS THE CART ──
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1); f.chg(MENU[1].id, 1);
    f.setMenu(MENU.filter(p => p.id !== MENU[1].id));
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: blocked while the removed dish is in the cart`);
    f.chg(MENU[1].id, -1);                              // the customer takes it out — the real path
    assert.strictEqual(f.cartConflicts().length, 0, `${dir}: removing the line resolves the conflict`);
    assert.strictEqual(f.redeemCartItems().length, 1, `${dir}: and the rest of the cart is intact`);
    assert.strictEqual(await f.submitGate(), 'PROCEEDED', `${dir}: the cart submits again`);
    ok(`${dir}: an unresolved line can still be removed through the real chg() path, unblocking the cart`);
  }

  // ── 10. A DISH THAT ARRIVES WITH A LIVE UPGRADE STARTS AT 0, NOT NaN ──
  {
    const { f, MENU } = setup(dir);
    const fresh = dir === 'xpizza-orders' ? { id: 99, name: 'Nueva', price: 195, cat: 'individual' }
                                          : { id: 'lm-nueva', name: 'Nueva', price: 195, cat: 'principales' };
    f.setMenu(MENU.concat([fresh]));                    // qty has no entry for it — the NaN source
    f.chg(fresh.id, 1);
    assert.strictEqual(f.redeemCartItems()[0].qty, 1, `${dir}: a newly-arrived dish increments from 0`);
    assert.ok(Number.isFinite(f.calcTotal()), `${dir}: the total must stay finite`);
    assert.strictEqual(f.calcTotal(), 195, `${dir}: and be right`);
    ok(`${dir}: a dish introduced by a live upgrade adds at qty 1 with a finite total (no NaN)`);
  }

  // ── 11. A RENAMED DISH — AND WHAT "RENAMED" MEANS IS PER BRAND ──
  // Found by a surviving mutant: nothing here compared the pricing key at all.
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, name: p.name + ' Especial' } : p)));
    if (dir === 'xpizza-orders') {
      // x_pizza is priced BY NAME — a renamed dish is a different product to createOrder, so it must stop.
      assert.strictEqual(f.cartConflicts()[0].unresolved, 'renamed', 'x_pizza: a rename must be pinned as renamed');
      assert.strictEqual(f.redeemCartItems()[0].name, MENU[0].name, 'x_pizza: the line keeps the name it was added under');
      assert.strictEqual(await f.submitGate(), undefined, 'x_pizza: and it blocks submit');
      ok(`${dir}: a RENAMED dish is unresolved and blocks submit (priced by name)`);
    } else {
      // la_musa is priced BY ID, so a rename changes nothing about the charge. Pinned as a deliberate
      // decision rather than left as an untested silence — Task 5 owns whether display identity should
      // also stop a customer, and it will change THIS assertion if it decides so.
      assert.strictEqual(f.cartConflicts().length, 0, 'la_musa: a rename is not a money event — priced by id');
      assert.strictEqual(await f.submitGate(), 'PROCEEDED', 'la_musa: so it does not block');
      assert.strictEqual(f.redeemCartItems()[0].price, MENU[0].price, 'la_musa: and the price is untouched');
      ok(`${dir}: a RENAMED dish does NOT block (priced by id) — the deferral to Task 5, pinned`);
    }
  }

  // ── 12. TOUCHING A RE-PRICED LINE MUST NOT LAUNDER IT ──
  // Found by a surviving mutant: capturing the record on every quantity change meant one tap of "+"
  // adopted the merchant's new price silently — the customer's own gesture clearing the conflict.
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p)));
    f.chg(MENU[0].id, 1);                               // the customer adds another one
    assert.strictEqual(f.redeemCartItems()[0].qty, 2, `${dir}: the quantity change still applies`);
    assert.strictEqual(f.redeemCartItems()[0].price, MENU[0].price, `${dir}: but the agreed price is NOT refreshed`);
    assert.strictEqual(f.cartConflicts()[0].unresolved, 'repriced', `${dir}: the conflict survives being touched`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: and submit stays blocked`);
    ok(`${dir}: changing the quantity of a re-priced line does not launder it to the new price`);
  }

  // ── 13. A STALE CONTROL CANNOT ADD A DISH THAT IS NO LONGER ON THE MENU ──
  // Found by a surviving mutant, and it was a real defect rather than a missing test: chg() set
  // qty[id]=1 while the cart captured nothing, so the card read "1" for a line in no total and no
  // order. Reachable through a detail modal left open across a live upgrade.
  {
    const { f, MENU } = setup(dir);
    f.setMenu(MENU.filter(p => p.id !== MENU[0].id));   // removed while its control is still on screen
    f.chg(MENU[0].id, 1);                               // the customer taps "+"
    assert.strictEqual(f.cartCount(), 0, `${dir}: nothing was added`);
    assert.strictEqual(f.redeemCartItems().length, 0, `${dir}: and nothing serializes`);
    assert.strictEqual(f.calcTotal(), 0, `${dir}: and the total is 0`);
    assert.strictEqual(f.qtyOf(MENU[0].id), 0, `${dir}: 🔴 and qty must NOT dangle at 1 — the card would lie`);
    assert.strictEqual(f.cartConflicts().length, 0, `${dir}: an empty cart has no CONFLICTS…`);
    assert.strictEqual(await f.submitGate(), undefined,
      `${dir}: …but the send gate still refuses it — a request for money with no items is not an order`);
    ok(`${dir}: a stale control cannot add a dish the live menu dropped, and qty does not dangle`);
  }

  // ── 14. 🔴 THE TWO CHARGE SENDS ARE GATED — WITH POSITIVE CONTROLS ──
  // The guarantee lives immediately before the only two fetches that ask for money. Each "it was not
  // sent" assertion is paired with a control proving the harness CAN reach that send — without one,
  // a negative passes for any reason at all, which is how the first two bypasses survived a green suite.
  {
    // CONTROL A — the cash send is reachable.
    const c = setup(dir);
    c.f.chg(c.MENU[0].id, 1);
    assert.strictEqual(c.f.buildOrder(), true);
    await c.f.submitOrder('confirmed');
    assert.ok(c.f.fetchCalls.some((u) => u.includes('createOrder')),
      `${dir}: control — a clean cart DOES reach createOrder (otherwise every negative below is vacuous)`);

    // CONTROL B — the online send is reachable.
    const d = setup(dir);
    d.f.chg(d.MENU[0].id, 1);
    d.f.buildOrder();
    try { await d.f.processPixelPay(); } catch (_) {}
    assert.ok(d.f.fetchCalls.some((u) => u.includes('chargeOnlineOrder')),
      `${dir}: control — a clean cart DOES reach chargeOnlineOrder`);
    ok(`${dir}: CONTROL — both charge sends are reachable from this harness`);
  }

  {
    // …and neither is reachable with a conflicted cart.
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p)));
    assert.strictEqual(f.buildOrder(), false, `${dir}: buildOrder refuses (early feedback)`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: createOrder is never called`);
    try { await f.processPixelPay(); } catch (_) {}
    assert.deepStrictEqual(f.fetchCalls.filter((u) => u.includes('chargeOnlineOrder')), [],
      `${dir}: 🔴 chargeOnlineOrder is never called with an unresolved line`);
    ok(`${dir}: a conflicted cart reaches NEITHER charge send`);
  }

  // ── 15. 🔴 THE CASH RETRY LOOP RE-CHECKS BEFORE IT RE-SENDS ──
  // The bypass the caller-gates could not close: submitOrder gates at ENTRY, then retries createOrder
  // on a 500 without rebuilding anything. If the merchant publishes during the backoff, attempt 2 sends
  // the stale cart. The menu is repriced from inside the first request, which is exactly when it happens.
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    assert.strictEqual(f.buildOrder(), true, `${dir}: the cart was clean when it was sent`);
    f.setPlan([{ status: 500 }, { status: 200 }]);            // attempt 1 fails, attempt 2 would succeed
    f.onFetch((n) => { if (n === 1) f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p))); });
    await f.submitOrder('confirmed');
    const sends = f.fetchCalls.filter((u) => u.includes('createOrder'));
    assert.strictEqual(sends.length, 1,
      `${dir}: 🔴 the RETRY must not re-send a cart that was repriced during the backoff (sent ${sends.length}×)`);
    assert.ok(f.notices.some((n) => String(n[0]).includes('cart_conflict_blocked_send')),
      `${dir}: and the refusal is logged AT THE SEND, pinning where it stopped`);
    ok(`${dir}: the cash retry re-checks before re-sending — a mid-backoff reprice is never charged`);
  }

  // ── 16. 🔴 AN UNREADABLE STASH IS NEVER PARTIALLY RESTORED ──
  // "Rebuild from the live menu" silently omits a dish the menu no longer carries — a smaller cart than
  // the customer left, with no error: the silent drop wearing error-handling's clothes. Reproduced at
  // 3 units across 2 dishes, one since removed, restoring as 1 unit with zero conflicts.
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 2); a.f.chg(a.MENU[1].id, 1);
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));
    delete stash.form.cart.lines[0].added;                    // the stash can no longer be read whole

    const b = setup(dir);
    b.f.setMenu(b.MENU.filter(p => p.id !== b.MENU[1].id));   // …and one of the dishes is gone from the menu
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.cartCount(), 0,
      `${dir}: 🔴 restoration must be ALL or NOTHING — never the 2 units it could still describe`);
    assert.strictEqual(await b.f.submitGate(), undefined, `${dir}: and nothing is sent`);
    assert.ok(b.f.notices.some((n) => String(n[0]).includes('cart_restore_refused')),
      `${dir}: the refusal is explicit, not an empty cart nobody explained`);
    assert.match(b.f.errEl.textContent, /recuperar tu pedido/, `${dir}: and the customer is told`);
    ok(`${dir}: an unreadable stash whose menu also moved restores NOTHING, visibly — never partially`);
  }

  // ── 17. 🔴 THE REAL DISPATCH HONOURS THE REFUSAL — BOTH BRANCHES ──
  // Every other test calls buildOrder / submitOrder / processPixelPay directly. This drives the actual
  // function the pay button calls, so the cash-vs-online branch itself is under test rather than assumed.
  for (const method of ['cash', 'online']) {
    const c = setup(dir);                                     // CONTROL: the dispatch reaches the send
    c.f.asPickup(); c.f.paySelect(method);
    c.f.chg(c.MENU[0].id, 1);
    try { await c.f.processPayment(); } catch (_) {}
    const wanted = method === 'cash' ? 'createOrder' : 'chargeOnlineOrder';
    assert.ok(c.f.fetchCalls.some((u) => u.includes(wanted)),
      `${dir}/${method}: control — the real dispatch reaches ${wanted}`);
    assert.ok(c.f.stages.includes('s4'), `${dir}/${method}: control — a clean order DOES advance to the sending stage`);

    const { f, MENU } = setup(dir);
    f.asPickup(); f.paySelect(method);
    f.chg(MENU[0].id, 1);
    f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p)));
    try { await f.processPayment(); } catch (_) {}
    assert.deepStrictEqual(f.fetchCalls, [],
      `${dir}/${method}: 🔴 the real dispatch must send nothing with an unresolved line`);
    assert.ok(!f.stages.includes('s4'),
      `${dir}/${method}: and must stop AT the dispatch — never show "sending your order" for an order it will refuse`);
    ok(`${dir}: the REAL dispatch (${method}) refuses a conflicted cart and sends nothing`);
  }

  // ── 18. 🔴 THE ONLINE RETRY RE-CHECKS TOO — THROUGH THE REAL RETRY PATH ──
  // processPixelPay's actual retry is the 202 in_progress branch: it releases the submit lock and
  // re-enters itself via setTimeout. An earlier version of this test invoked the function twice by hand
  // with the lock still held, so the second call stopped at `if(orderSubmitting) return` — the LOCK was
  // proving the retry safe, not the send gate. Driven through the real 202 path now, with a positive
  // control proving the retry does go out again when the cart has not changed.
  {
    // CONTROL — the retry really does re-send when nothing changed.
    const c = setup(dir);
    c.f.chg(c.MENU[0].id, 1);
    c.f.buildOrder();
    c.f.setPlan([{ status: 202, body: { status: 'in_progress' } }, { status: 200, body: { checkout_url: 'http://pay/x' } }]);
    try { await c.f.processPixelPay(); } catch (_) {}
    await drain();
    assert.strictEqual(c.f.fetchCalls.filter((u) => u.includes('chargeOnlineOrder')).length, 2,
      `${dir}: control — an unchanged cart DOES retry (otherwise the negative below is vacuous)`);

    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    assert.strictEqual(f.buildOrder(), true, `${dir}: clean when first sent`);
    f.setPlan([{ status: 202, body: { status: 'in_progress' } }, { status: 200, body: { checkout_url: 'http://pay/x' } }]);
    f.onFetch((n) => { if (n === 1) f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p))); });
    try { await f.processPixelPay(); } catch (_) {}
    await drain();
    const sends = f.fetchCalls.filter((u) => u.includes('chargeOnlineOrder'));
    assert.strictEqual(sends.length, 1,
      `${dir}: 🔴 the online retry must not re-send a cart repriced mid-flight (sent ${sends.length}×)`);
    assert.ok(f.notices.some((n) => String(n[0]).includes('cart_conflict_blocked_send')),
      `${dir}: and it is the SEND gate that stopped it — logged at the send`);
    ok(`${dir}: the online retry re-checks at the send (real 202 path, lock released)`);
  }

  // ── 14. 🔴 THE ONLINE PAYMENT PATH IS GATED TOO ──
  // The gate lived only in submitOrder(), which is the CASH path. processPayment() → buildOrder() →
  // processPixelPay() → chargeOnlineOrder never touched it, so a repriced line could be charged without
  // consent. Driven through the REAL buildOrder and the REAL processPixelPay.
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1);
    assert.strictEqual(f.buildOrder(), true, `${dir}: control — a clean cart builds`);
    f.setMenu(MENU.map(p => (p.id === MENU[0].id ? { ...p, price: p.price + 90 } : p)));

    assert.strictEqual(f.buildOrder(), false, `${dir}: buildOrder must REFUSE a conflicted cart`);
    // 🔴 THE ASSERTION IS "IT RETURNED AT THE GATE", NOT "NOTHING WAS OBSERVED". An earlier version
    // swallowed whatever processPixelPay threw and then checked fetch had not been called — so a run
    // that crashed on the way to fetch was indistinguishable from one the gate stopped, and a mutant
    // deleting the gate outright survived. Absence of evidence rendered as evidence. It must now
    // complete cleanly (proving it RETURNED) and must not have reached the network.
    let threw = null;
    try { await f.processPixelPay(); } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `${dir}: processPixelPay must RETURN at its gate, not run on (${threw && threw.message})`);
    assert.deepStrictEqual(f.fetchCalls, [], `${dir}: 🔴 chargeOnlineOrder must NOT be reached with an unresolved line`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: and the cash path stays blocked too`);
    ok(`${dir}: the ONLINE charge path is gated — buildOrder refuses and chargeOnlineOrder is never called`);
  }

  // ── 15. 🔴 A STALE OPTION CONTROL CANNOT DROP AN OPTION SILENTLY ──
  // The dish-level dangling-qty defect, one level down: the real option handler writes a positive
  // quantity, the capture cannot happen (the option is not in the live list to capture from), and an
  // uncaptured option used to classify as resolved — no conflict, no record, no entry in the order.
  {
    const { f, MENU, EXTRAS } = setup(dir);
    f.chg(MENU[0].id, 1);
    f.setMenu(f.liveMenu(), EXTRAS.filter(e => e.id !== EXTRAS[0].id));   // pulled while its control is on screen
    f.optionControl(EXTRAS[0].id, MENU[0].id);                            // the customer taps it
    const conflicts = f.cartConflicts();
    assert.strictEqual(conflicts.length, 1, `${dir}: the line must be blocked, not silently clean`);
    assert.strictEqual(conflicts[0].extras.find(x => x.unresolved).unresolved, 'uncaptured',
      `${dir}: pinned reason — an option with a quantity and no capture is unresolved`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: the cash path is blocked`);
    assert.strictEqual(f.buildOrder(), false, `${dir}: and so is every path to a charge`);
    ok(`${dir}: a stale option control cannot drop an option silently — it blocks instead`);
  }

  // ── 16. 🔴 RETURNING FROM ONLINE PAYMENT KEEPS THE CART ──
  // restoreOrderForm() rehydrated qty and pizzaExtras but not CART, so a customer coming back from the
  // hosted checkout saw their cart and serialized []. Driven through the REAL snapshotForm → JSON
  // round-trip → restoreOrderForm, on a FRESH form instance, as the real return actually happens.
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 2); a.f.chg(a.MENU[2].id, 1);
    addOption(dir, a.f, a.pizzaExtras, a.MENU[0].id, a.EXTRAS[0]);
    const expected = a.f.redeemCartItems();
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));

    const b = setup(dir);                                    // the fresh page after the redirect back
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.cartCount(), 3, `${dir}: 🔴 the restored cart must not be empty`);
    assert.deepStrictEqual(b.f.redeemCartItems(), expected, `${dir}: and must serialize exactly as before the redirect`);
    assert.strictEqual(b.f.buildOrder(), true, `${dir}: and be chargeable again`);
    assert.strictEqual(b.f.qtyOf(a.MENU[0].id), 2, `${dir}: quantities restored`);
    ok(`${dir}: a payment-return restores the CART, not just the quantities — serialization survives`);
  }

  // ── 17. …AND A PRICE PUBLISHED DURING THE HOSTED CHECKOUT STILL BLOCKS ──
  // The reason the captured records travel in the stash: the merchant can publish while the customer is
  // on PixelPay's page. The restored line must keep the price they agreed to, and stop.
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 1);
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));

    const b = setup(dir);
    b.f.setMenu(b.MENU.map(p => (p.id === b.MENU[0].id ? { ...p, price: p.price + 90 } : p)));  // published mid-checkout
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.redeemCartItems()[0].price, a.MENU[0].price, `${dir}: the restored line keeps its agreed price`);
    assert.strictEqual(b.f.cartConflicts()[0].unresolved, 'repriced', `${dir}: pinned reason`);
    assert.strictEqual(b.f.buildOrder(), false, `${dir}: and it blocks every path to a charge`);
    ok(`${dir}: a price published DURING the hosted checkout blocks the restored cart (records travel in the stash)`);
  }

  // ── 18. 🔴 AN UNREADABLE STASH NEVER REBUILDS A REPRICED LINE AT TODAY'S PRICE ──
  // The last place the agreed price could be lost, and the subtlest. `added` IS the record of what the
  // customer agreed to pay. Rebuilding a line from the live menu captures TODAY's price AS the agreed
  // price, so a dish repriced during the hosted checkout came back with added == live, classify() saw
  // no disagreement, and the send gate was handed a cart it had no reason to stop.
  //
  // The earlier rule refused only when a line could not be DESCRIBED by the live menu — which catches a
  // removed dish and misses a repriced one, because a repriced dish is still perfectly describable. The
  // question is not "can I name it", it is "can I certify what was agreed", and an unreadable stash
  // answers no for everything in it.
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 1);
    const agreed = a.MENU[0].price;
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));
    delete stash.form.cart.lines[0].added;                    // the stash can no longer be read whole

    const b = setup(dir);
    // …and the dish is still perfectly describable — it was merely REPRICED while the customer was away.
    b.f.setMenu(b.MENU.map(p => (p.id === b.MENU[0].id ? { ...p, price: agreed + 90 } : p)));
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.cartCount(), 0,
      `${dir}: 🔴 nothing is rebuilt — a line rebuilt from live would carry ${agreed + 90} as "agreed"`);
    assert.strictEqual(await b.f.submitGate(), undefined, `${dir}: and nothing is sent`);
    assert.deepStrictEqual(b.f.fetchCalls, [], `${dir}: neither charge send is reached`);
    assert.ok(b.f.notices.some((n) => String(n[0]).includes('cart_restore_refused')),
      `${dir}: the refusal is explicit, not an empty cart nobody explained`);
    ok(`${dir}: an unreadable stash never silently re-agrees a repriced line at today's price`);
  }

  // ── 19. 🔴 A SNAPSHOT CARRYING THE SAME LINE TWICE IS MALFORMED ──
  // Every element well-formed is not the same as the SET being well-formed. These are keyed maps, so
  // two entries sharing a key is not a duplicate, it is a silent overwrite — and if the surviving entry
  // is the one at today's price, the agreed price is erased and the reprice disagrees with nothing.
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 1);
    const agreed = a.MENU[0].price;
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));
    // A second entry for the SAME line, at the price the merchant has since published. Each entry on its
    // own passes every element-wise check there is.
    const dup = JSON.parse(JSON.stringify(stash.form.cart.lines[0]));
    dup.added.price = agreed + 90; dup.added.record.price = agreed + 90;
    stash.form.cart.lines.push(dup);

    const b = setup(dir);
    b.f.setMenu(b.MENU.map(p => (p.id === b.MENU[0].id ? { ...p, price: agreed + 90 } : p)));
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.cartCount(), 0,
      `${dir}: 🔴 a duplicate-key snapshot is malformed — it must restore nothing, not the last entry`);
    assert.strictEqual(await b.f.submitGate(), undefined, `${dir}: createOrder is never reached`);
    assert.deepStrictEqual(b.f.fetchCalls, [], `${dir}: and neither is chargeOnlineOrder`);
    assert.ok(b.f.notices.some((n) => String(n[0]).includes('cart_restore_refused')),
      `${dir}: refused explicitly`);
    ok(`${dir}: a snapshot with the same line twice at conflicting agreed prices is refused whole`);
  }

  // ── 20. 🔴 …AND THE SAME FOR AN OPTION CARRIED TWICE ──
  // Closing the class in both directions. A duplicate OPTION key overwrites a captured option's agreed
  // price exactly as a duplicate line key overwrites a dish's — the uniqueness rule has to cover both
  // maps, and a test that only exercised lines let a mutant enforcing it on lines alone survive.
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 1);
    addOption(dir, a.f, a.pizzaExtras, a.MENU[0].id, a.EXTRAS[0]);
    const agreed = a.EXTRAS[0].price;
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));
    const dup = JSON.parse(JSON.stringify(stash.form.cart.extras[0]));
    dup.price = agreed + 55; dup.record.price = agreed + 55;
    stash.form.cart.extras.push(dup);

    const b = setup(dir);
    b.f.setMenu(b.MENU, b.EXTRAS.map(e => (e.id === b.EXTRAS[0].id ? { ...e, price: agreed + 55 } : e)));
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.cartCount(), 0,
      `${dir}: 🔴 a duplicate OPTION key is malformed too — restore nothing`);
    assert.strictEqual(await b.f.submitGate(), undefined, `${dir}: createOrder is never reached`);
    assert.deepStrictEqual(b.f.fetchCalls, [], `${dir}: and neither is chargeOnlineOrder`);
    ok(`${dir}: a snapshot with the same OPTION twice at conflicting agreed prices is refused whole`);
  }

  // ── 21. …AND A READABLE STASH STILL RESTORES (the rule above is not "always refuse") ──
  {
    const a = setup(dir);
    a.f.chg(a.MENU[0].id, 2); a.f.chg(a.MENU[1].id, 1);
    const expected = a.f.redeemCartItems();
    const stash = JSON.parse(JSON.stringify({ form: a.f.snapshotForm(), ts: Date.now(), order_id: 'o1' }));
    const b = setup(dir);
    b.f.setStash(stash);
    b.f.restoreOrderForm();
    assert.strictEqual(b.f.cartCount(), 3, `${dir}: control — a readable stash restores in full`);
    assert.deepStrictEqual(b.f.redeemCartItems(), expected, `${dir}: …identically`);
    assert.strictEqual(b.f.buildOrder(), true, `${dir}: …and is chargeable`);
    ok(`${dir}: CONTROL — a readable stash still restores fully (the refusal is not blanket)`);
  }

  // ── 19. THE CART SIGNATURE FOLLOWS THE CART, NOT THE MENU ──
  {
    const a = setup(dir), b = setup(dir);
    a.f.chg(a.MENU[0].id, 1); a.f.chg(a.MENU[1].id, 1);
    b.f.chg(b.MENU[0].id, 1);
    a.f.setMenu(a.MENU.filter(p => p.id !== a.MENU[1].id));   // a's second line is dropped from the MENU
    assert.notStrictEqual(a.f.cartSig(), b.f.cartSig(),
      `${dir}: a two-line cart missing one from the MENU must NOT hash equal to a genuine one-line cart`);
    ok(`${dir}: cartSig distinguishes "line dropped from the menu" from "line never added" (no idempotent-return reuse)`);
  }

  // ── 20. TOGGLING AN OPTION OFF AND ON DOES NOT RE-CAPTURE IT AT A NEW PRICE ──
  {
    const { f, MENU, EXTRAS, pizzaExtras } = setup(dir);
    f.chg(MENU[0].id, 1);
    addOption(dir, f, pizzaExtras, MENU[0].id, EXTRAS[0]);
    f.setMenu(f.liveMenu(), EXTRAS.map(e => (e.id === EXTRAS[0].id ? { ...e, price: 999 } : e)));
    addOption(dir, f, pizzaExtras, MENU[0].id, { ...EXTRAS[0], price: 999 });   // re-selected after the change
    assert.strictEqual(f.redeemCartItems()[0].extras[0].price, EXTRAS[0].price,
      `${dir}: re-selecting must not adopt the new price — capture is idempotent by key`);
    assert.strictEqual(await f.submitGate(), undefined, `${dir}: and it stays blocked`);
    ok(`${dir}: re-selecting an option does not silently re-capture it at a changed price`);
  }
}

// ── 21-22. NO REGRESSION AGAINST THE REAL SHIPPED BUNDLE ────────────────────────────────────────
// The fixtures above are deliberately synthetic, so an assertion cannot be satisfied by the same data
// the code derives from. But "no regression" is a claim about the MENU customers actually see, so it is
// also checked against each form's real spliced bundle — including la_musa's variant items, whose
// launcher path (stage options → chg(variantId, 1)) is the most intricate way a line enters the cart
// and is not represented by any fixture.
for (const dir of Object.keys(BRANDS)) {
  const B = BRANDS[dir];
  const html = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  const m = html.match(/window\.__FORM_MENU_BUNDLE__ = (\{[\s\S]*?\});<\/script>/);
  assert.ok(m, `${dir}: the shipped bundle was not found — this test would otherwise pass vacuously`);
  const bundle = JSON.parse(m[1]);
  const MENU = bundle.dishes, EXTRAS = bundle.extras;
  assert.ok(MENU.length > 10 && EXTRAS.length > 1, `${dir}: non-vacuity — the real bundle is substantial`);

  const qty = {}, pizzaExtras = {};
  const f = makeFormWith(dir, html, MENU, EXTRAS, qty, pizzaExtras);
  // A realistic cart: three dishes from different categories, one with an option. For la_musa the
  // middle line is deliberately a VARIANT (the launcher's product), which no fixture exercises.
  const variant = MENU.find(p => p.variantOf);
  const picks = [MENU[0], variant || MENU[Math.floor(MENU.length / 2)], MENU[MENU.length - 1]];
  f.chg(picks[0].id, 2); f.chg(picks[1].id, 1); f.chg(picks[2].id, 3);
  addOption(dir, f, pizzaExtras, picks[0].id, EXTRAS[0]);

  assert.deepStrictEqual(f.redeemCartItems(), B.oldSerialize(MENU, EXTRAS, qty, pizzaExtras),
    `${dir}: the REAL bundle must serialize byte-identically to the shipped expression`);
  assert.strictEqual(f.calcTotal(), B.oldTotal(MENU, EXTRAS, qty, pizzaExtras), `${dir}: …and total identically`);
  assert.strictEqual(f.cartCount(), 6, `${dir}: …and count identically`);
  assert.strictEqual(await f.submitGate(), 'PROCEEDED', `${dir}: …and submit`);
  if (dir === 'la-musa-orders') assert.ok(variant, 'la_musa: a variant item must exist in the real bundle for this to mean anything');
  ok(`${dir}: NO REGRESSION on the REAL shipped bundle${variant ? ' (including a variant line)' : ''}`);
}

console.log(`\n${n} checks passed across both forms.`);
