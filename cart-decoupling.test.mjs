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
  const guard = grab(html, /const _conflicts = cartConflicts\(\);\n\s*if\(_conflicts\.length\)\{ announceCartConflicts\(_conflicts\); return; \}/, "submitOrder's cart gate");
  assert.ok(
    /async function submitOrder\(paymentStatus\)\{\n  if\(orderSubmitting\) return;\n(?:[^\n]*\n){0,6}?  const _conflicts = cartConflicts\(\);\n  if\(_conflicts\.length\)\{ announceCartConflicts\(_conflicts\); return; \}\n  orderSubmitting = true;/.test(html),
    'the cart gate must sit at the top of submitOrder, before orderSubmitting is set');
  MENU.forEach(p => { qty[p.id] = 0; });
  const errEl = { textContent: '', style: {} };
  const win = { createCart, __ACCOUNT: null, __onCartConflict: null };
  const doc = { getElementById: (id) => (id === 'err3' || id === 'err1' ? errEl : null) };
  const notices = [];
  const api = new Function('ctx', `
    let MENU = ctx.MENU, EXTRAS = ctx.EXTRAS;
    const pizzaExtras = ctx.pizzaExtras, qty = ctx.qty;
    const window = ctx.window, document = ctx.document;
    const console = { warn: (...a) => ctx.notices.push(a), log: () => {}, error: () => {} };
    const soldOutById = () => false, registerOutsideClick = () => {}, refreshCardExtrasIndicator = () => {};
    const updateDetailModal = () => {}, updateDetailCta = () => {}, updateTotal = () => {}, updateCart = () => {};
    const refreshPickupGate = () => {}, itemIsLauncher = () => false;
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
    function submitGate(){ ${guard} return 'PROCEEDED'; }
    return { chg, calcTotal, redeemCartItems, cartSig, submitGate, cartConflicts, cartLines, cartItems, cartCount, CART,
             noteExtra: (r) => CART.noteExtra(r), qtyOf: (id) => qty[id],
             liveMenu: () => MENU, setMenu: (m, e) => { MENU = m; if (e) EXTRAS = e; } };
  `)({ MENU, EXTRAS, pizzaExtras, qty, window: win, document: doc, notices });
  return { ...api, errEl, notices, win };
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
    assert.strictEqual(f.submitGate(), 'PROCEEDED', `${dir}: a clean cart must submit`);
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
    assert.strictEqual(f.submitGate(), 'PROCEEDED', `${dir}: control — it submits before the change`);
    f.setMenu(MENU.filter(p => p.id !== MENU[1].id));
    assert.strictEqual(f.submitGate(), undefined, `${dir}: submit must be refused while a line is unresolved`);
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
    assert.strictEqual(f.submitGate(), undefined, `${dir}: and it must block submit`);
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
    assert.strictEqual(f.submitGate(), undefined, `${dir}: a clean dish with a vanished option still blocks submit`);
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
    assert.strictEqual(f.submitGate(), undefined, `${dir}: and blocks submit`);
    ok(`${dir}: a re-priced OPTION keeps its agreed price and blocks submit`);
  }

  // ── 9. AN UNRESOLVED LINE IS STILL REMOVABLE, AND THAT UNBLOCKS THE CART ──
  {
    const { f, MENU } = setup(dir);
    f.chg(MENU[0].id, 1); f.chg(MENU[1].id, 1);
    f.setMenu(MENU.filter(p => p.id !== MENU[1].id));
    assert.strictEqual(f.submitGate(), undefined, `${dir}: blocked while the removed dish is in the cart`);
    f.chg(MENU[1].id, -1);                              // the customer takes it out — the real path
    assert.strictEqual(f.cartConflicts().length, 0, `${dir}: removing the line resolves the conflict`);
    assert.strictEqual(f.redeemCartItems().length, 1, `${dir}: and the rest of the cart is intact`);
    assert.strictEqual(f.submitGate(), 'PROCEEDED', `${dir}: the cart submits again`);
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
      assert.strictEqual(f.submitGate(), undefined, 'x_pizza: and it blocks submit');
      ok(`${dir}: a RENAMED dish is unresolved and blocks submit (priced by name)`);
    } else {
      // la_musa is priced BY ID, so a rename changes nothing about the charge. Pinned as a deliberate
      // decision rather than left as an untested silence — Task 5 owns whether display identity should
      // also stop a customer, and it will change THIS assertion if it decides so.
      assert.strictEqual(f.cartConflicts().length, 0, 'la_musa: a rename is not a money event — priced by id');
      assert.strictEqual(f.submitGate(), 'PROCEEDED', 'la_musa: so it does not block');
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
    assert.strictEqual(f.submitGate(), undefined, `${dir}: and submit stays blocked`);
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
    assert.strictEqual(f.submitGate(), 'PROCEEDED', `${dir}: an empty cart is not "in conflict"`);
    ok(`${dir}: a stale control cannot add a dish the live menu dropped, and qty does not dangle`);
  }

  // ── 14. THE CART SIGNATURE FOLLOWS THE CART, NOT THE MENU ──
  {
    const a = setup(dir), b = setup(dir);
    a.f.chg(a.MENU[0].id, 1); a.f.chg(a.MENU[1].id, 1);
    b.f.chg(b.MENU[0].id, 1);
    a.f.setMenu(a.MENU.filter(p => p.id !== a.MENU[1].id));   // a's second line is dropped from the MENU
    assert.notStrictEqual(a.f.cartSig(), b.f.cartSig(),
      `${dir}: a two-line cart missing one from the MENU must NOT hash equal to a genuine one-line cart`);
    ok(`${dir}: cartSig distinguishes "line dropped from the menu" from "line never added" (no idempotent-return reuse)`);
  }

  // ── 15. TOGGLING AN OPTION OFF AND ON DOES NOT RE-CAPTURE IT AT A NEW PRICE ──
  {
    const { f, MENU, EXTRAS, pizzaExtras } = setup(dir);
    f.chg(MENU[0].id, 1);
    addOption(dir, f, pizzaExtras, MENU[0].id, EXTRAS[0]);
    f.setMenu(f.liveMenu(), EXTRAS.map(e => (e.id === EXTRAS[0].id ? { ...e, price: 999 } : e)));
    addOption(dir, f, pizzaExtras, MENU[0].id, { ...EXTRAS[0], price: 999 });   // re-selected after the change
    assert.strictEqual(f.redeemCartItems()[0].extras[0].price, EXTRAS[0].price,
      `${dir}: re-selecting must not adopt the new price — capture is idempotent by key`);
    assert.strictEqual(f.submitGate(), undefined, `${dir}: and it stays blocked`);
    ok(`${dir}: re-selecting an option does not silently re-capture it at a changed price`);
  }
}

// ── 16-17. NO REGRESSION AGAINST THE REAL SHIPPED BUNDLE ────────────────────────────────────────
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
  assert.strictEqual(f.submitGate(), 'PROCEEDED', `${dir}: …and submit`);
  if (dir === 'la-musa-orders') assert.ok(variant, 'la_musa: a variant item must exist in the real bundle for this to mean anything');
  ok(`${dir}: NO REGRESSION on the REAL shipped bundle${variant ? ' (including a variant line)' : ''}`);
}

console.log(`\n${n} checks passed across both forms.`);
