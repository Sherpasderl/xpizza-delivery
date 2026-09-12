// Portal 1B Task 6 — THE LIVE APPLY, in a real DOM. Run: node live-apply.test.mjs
//
// 🔴 WHY THIS ONE NEEDS A DOM WHEN THE OTHERS DID NOT. cart-decoupling.test.mjs lifts functions out of
// the form and runs them in a controlled scope, which is right for logic and has found real money bugs.
// Task 6 is not logic: it is what the customer's SCREEN does while the menu is replaced underneath
// them. "The render rolled back", "focus survived", "the page did not jump", "a dish the upgrade
// introduced does not render as undefined" are claims about a document, and a harness with no document
// cannot make them — it can only assert that some function was called, which is the shape of check this
// programme keeps finding was never evidence.
//
// So the whole form is loaded and executed in jsdom, and every test drives the REAL chain:
// fetch → coordinator → adapter → applier → commit. Local modules are inlined so they execute; every
// remote script is REMOVED and fetch is stubbed before a single form script runs, so nothing here can
// reach the network.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { JSDOM, VirtualConsole } = require('jsdom');

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// jsdom keeps the event loop alive under pretendToBeVisual, so every window is closed at the end or
// the process hangs after the last assertion — a green run that never exits is not a green run.
const OPEN = [];
// setTimeout-based, not setImmediate: the deferred-apply flush is scheduled with setTimeout(…, 0) from
// the modal/stage close handlers, and only a real timer turn advances jsdom's timer queue.
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
// showStage cross-dissolves: it waits for transitionend, with a 170ms fallback. jsdom fires no
// transitions, so the fallback is what moves the stage — and the test has to outlast it.
const stageSettle = async () => { await new Promise((r) => setTimeout(r, 240)); await settle(); };

// The endpoint's real envelope, exactly as index.js sends it.
const envelope = (rid, menu) => ({ rid, representation_version: '1b.1', menu });

function loadForm(dir) {
  let html = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  html = html.replace(/<script src="(?!https?:)([^"]+)"><\/script>/g, (m, src) => {
    try { return `<script>\n${readFileSync(new URL(`./${dir}/${src}`, import.meta.url), 'utf8')}\n</script>`; }
    catch { return ''; }
  });
  html = html.replace(/<script[^>]*src="https?:[^"]*"[^>]*><\/script>/g, '');
  // Installed at the top of <head>: loadAvailability() and the live-menu boot both run during parse,
  // so the stub has to exist before any of it.
  const preamble = `<script>
    window.__calls = [];
    window.__respond = function(){ return Promise.reject(new Error('no responder')); };
    window.fetch = function(url, init){ window.__calls.push(String(url)); return window.__respond(String(url), init); };
    // jsdom has no IntersectionObserver and the la_musa page uses one for its category nav. A stub is
    // the honest thing here: this suite is about the apply, and a missing browser API would otherwise
    // kill the page for a reason that has nothing to do with what is being tested.
    window.IntersectionObserver = function(){ return { observe(){}, unobserve(){}, disconnect(){}, takeRecords(){ return []; } }; };
    window.__scrollY = 0;
    window.scrollTo = function(x, y){ window.__scrollY = y; };
    Object.defineProperty(window, 'scrollY', { get(){ return window.__scrollY; }, configurable: true });
  </script>`;
  html = html.replace(/<head([^>]*)>/i, `<head$1>${preamble}`);

  const vc = new VirtualConsole();          // swallow the page's own console noise
  const jsdomErrors = [];
  vc.on('jsdomError', (e) => jsdomErrors.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://orders.test/', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  /* The default responder NEVER SETTLES, rather than rejecting. A rejected background fetch is not
     inert: the server-quote refresh clears its own cache when its request fails, so a rejection landing
     during a later `await` mutated state the test was about to assert on — which is how a mutation
     deleting the apply's quote invalidation survived a test written to catch exactly that. Requests
     that never settle leave the page's state where the code under test left it. */
  w.__respond = () => new Promise(() => {});
  w.__jsdomErrors = jsdomErrors;
  w.__dom = dom;
  OPEN.push(dom);
  return w;
}

const res = (body) => Promise.resolve({
  ok: true, status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'etag' ? '"t1"' : null) },
  json: () => Promise.resolve(body),
});

// Serve one snapshot to the live-menu endpoint and let the whole chain run.
async function serve(w, body, opts = {}) {
  /* Non-catalog requests HANG rather than fail, and that is deliberate. The server-quote refresh
     clears its own cache whenever its fetch fails — so with a rejecting stub the cached quote ended up
     null whether or not the apply invalidated it, and a mutation deleting the invalidation survived.
     A request that never settles leaves the cache exactly as the apply left it, which is the only way
     to see what the apply actually did. */
  const idle = new Promise(() => {});
  w.__respond = (url) => (url.includes('/menu/') ? res(body) : (opts.rejectOthers ? Promise.reject(new Error('offline')) : idle));
  await w.__liveMenu.feed.refresh();
  await settle();
}

const BRAND = {
  'xpizza-orders': {
    rid: 'x_pizza',
    containers: ['menu-individual', 'menu-ny'],
    menu: (w) => {
      const live = w.liveMenuGlobalGet('MENU');
      return {
        dishes: live.map((d) => ({ ...d })),
        extras: w.liveMenuGlobalGet('EXTRAS').map((e) => ({ ...e })),
      };
    },
  },
  'la-musa-orders': {
    rid: 'la_musa',
    containers: null,                        // derived from CATEGORIES at run time
    menu: (w) => ({
      dishes: w.liveMenuGlobalGet('MENU').map((d) => ({ ...d })),
      extras: w.liveMenuGlobalGet('EXTRAS').map((e) => ({ ...e })),
      categories: w.liveMenuGlobalGet('CATEGORIES').map((c) => ({ ...c })),
    }),
  },
};

for (const dir of Object.keys(BRAND)) {
  console.log(`\n══ ${dir} ══`);
  const B = BRAND[dir];
  const containersOf = (w) => B.containers || w.liveMenuContainers();
  const painted = (w) => containersOf(w).map((id) => { const el = w.document.getElementById(id); return el ? el.innerHTML : ''; }).join('');

  // ── 1. BUNDLE FIRST ──
  {
    const w = loadForm(dir);
    assert.ok(painted(w).length > 200, `${dir}: the spliced bundle painted synchronously, before any fetch`);
    assert.ok(w.__liveMenu && w.__liveMenu.feed, `${dir}: and the live feed booted`);
    ok(`${dir}: the bundle paints synchronously and the live feed boots after it`);
  }

  // ── 2. THE FEED ASKS FOR ITS OWN BRAND, BY PATH ──
  {
    const w = loadForm(dir);
    await serve(w, envelope(B.rid, B.menu(w)));
    const menuCalls = w.__calls.filter((u) => u.includes('getPublicMenu'));
    // Two by now: the page's own boot refresh (which found the responder offline) and this one.
    assert.ok(menuCalls.length >= 1, `${dir}: the catalog was requested`);
    assert.deepStrictEqual([...new Set(menuCalls)], [w.PUBLICMENU_URL_FOR_TEST || menuCalls[0]],
      `${dir}: every catalog request goes to the same URL`);
    menuCalls.forEach((u) => assert.ok(u.endsWith('/menu/' + B.rid),
      `${dir}: the rid is in the PATH (cache isolation by path, never a Vary header): ${u}`));
    assert.ok(!/[?&]rid=/.test(menuCalls[0]), `${dir}: …and not in a query string`);
    ok(`${dir}: the feed requests /menu/<rid> — rid in the path`);
  }

  // ── 3. A VALID SNAPSHOT REACHES THE SCREEN ──
  {
    const w = loadForm(dir);
    const before = painted(w);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Renombrada Live', price: m.dishes[0].price + 11 };
    await serve(w, envelope(B.rid, m));
    assert.notStrictEqual(painted(w), before, `${dir}: the DOM changed`);
    assert.ok(painted(w).includes('Renombrada Live'), `${dir}: the new name is on screen`);
    assert.strictEqual(w.liveMenuGlobalGet('MENU')[0].name, 'Renombrada Live', `${dir}: and the global followed`);
    ok(`${dir}: a valid snapshot applies — DOM and globals both move`);
  }

  // ── 4. 🔴 ATOMIC — A REJECTED SNAPSHOT CHANGES NOTHING ──
  {
    const w = loadForm(dir);
    const before = painted(w), menuBefore = w.liveMenuGlobalGet('MENU');
    const m = B.menu(w);
    m.dishes[1] = { ...m.dishes[1], price: 0 };            // a price no validation may let through
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(painted(w), before, `${dir}: not one tile changed`);
    assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `${dir}: and MENU is the very same array`);
    ok(`${dir}: a snapshot that fails preparation leaves the bundle exactly as it was`);
  }

  // ── 5. 🔴 ATOMIC — A THROW MID-RENDER ROLLS THE WHOLE APPLY BACK ──
  // The carry-forward: the coordinator commits `applied` BEFORE onApply so a throwing render cannot
  // wedge it, which puts the half-a-menu risk on the SCREEN. renderMenu is made to throw after the
  // globals have already been swapped — the exact moment that would otherwise leave new dishes priced
  // by an old table.
  {
    const w = loadForm(dir);
    const before = painted(w), menuBefore = w.liveMenuGlobalGet('MENU');
    const realRender = w.renderMenu;
    let swappedDuringRender = null;
    w.renderMenu = function () {
      swappedDuringRender = w.liveMenuGlobalGet('MENU')[0].name;   // prove the globals HAD moved
      // 🔴 WRITE FIRST, THEN THROW. A render that throws before touching the DOM leaves nothing to roll
      // back, so asserting "the DOM is unchanged" would hold even with the rollback deleted. A real
      // partial render damages the page, and that is what this has to reproduce.
      const first = w.document.getElementById(containersOf(w)[0]);
      if (first) first.innerHTML = '<div id="half-rendered">HALF</div>';
      throw new Error('render exploded');
    };
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Half Rendered' };
    await serve(w, envelope(B.rid, m));
    w.renderMenu = realRender;
    assert.strictEqual(swappedDuringRender, 'Half Rendered', `${dir}: non-vacuity — the commit really was mid-flight`);
    assert.ok(!painted(w).includes('half-rendered'), `${dir}: 🔴 the half-written container was put back`);
    assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `${dir}: 🔴 MENU is back to the identical prior array`);
    assert.strictEqual(painted(w), before, `${dir}: 🔴 and the screen is the prior render, not half of each`);
    assert.strictEqual(w.__liveMenu.applier.state().lastError.message, 'render exploded', `${dir}: the failure is recorded, not swallowed`);
    ok(`${dir}: a throw MID-RENDER rolls back globals and DOM — never new dishes at old prices`);
  }

  // ── 6. THE FEED IS NOT WEDGED BY THAT FAILURE ──
  {
    const w = loadForm(dir);
    const realRender = w.renderMenu;
    w.renderMenu = () => { throw new Error('boom'); };
    await serve(w, envelope(B.rid, B.menu(w)));
    w.renderMenu = realRender;
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Second Try' };
    await serve(w, envelope(B.rid, m));
    assert.ok(painted(w).includes('Second Try'), `${dir}: the next snapshot applies normally`);
    ok(`${dir}: a failed apply does not wedge the feed — the next one still lands`);
  }

  // ── 7. DEFERRED WHILE A DISH MODAL IS OPEN, APPLIED WHEN IT CLOSES ──
  // Swapping the menu under a customer who is reading one dish moves the thing they are deciding about.
  {
    const w = loadForm(dir);
    const before = painted(w);
    w.openDetailModal(w.liveMenuGlobalGet('MENU')[0].id);
    assert.ok(w.liveMenuBusy(), `${dir}: non-vacuity — the form really is busy with the modal open`);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Deferred Dish' };
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(painted(w), before, `${dir}: nothing moved while the modal was open`);
    assert.ok(w.__liveMenu.applier.hasPending(), `${dir}: …but the snapshot is held`);
    w.closeDetailModal();
    await settle();
    assert.ok(painted(w).includes('Deferred Dish'), `${dir}: 🔴 and lands when the modal closes`);
    assert.ok(!w.__liveMenu.applier.hasPending(), `${dir}: nothing left pending`);
    ok(`${dir}: an apply is DEFERRED while a dish modal is open and flushed when it closes`);
  }

  // ── 8. DEFERRED WHILE CHECKOUT IS OPEN ──
  {
    const w = loadForm(dir);
    const before = painted(w);
    w.showStage('s2', 50);
    await stageSettle();
    assert.strictEqual(w.activeStageId(), 's2', `${dir}: non-vacuity — checkout really is open`);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Checkout Deferred' };
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(painted(w), before, `${dir}: the menu behind checkout is left alone`);
    w.showStage('s1', 0);
    await stageSettle();
    assert.ok(painted(w).includes('Checkout Deferred'), `${dir}: and applies on returning to the menu`);
    ok(`${dir}: an apply is DEFERRED while checkout is open and flushed on the way back`);
  }

  // ── 9. 🔴 IGNORED ONCE THE ORDER IS COMPLETE, AND PERMANENTLY ──
  // s5 is the receipt. Redrawing prices under a completed order would be actively wrong, and this state
  // never re-opens — so a held snapshot is DROPPED rather than waiting for an idle that will not come.
  {
    const w = loadForm(dir);
    const before = painted(w);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'After The Receipt' };
    // 🔴 DEFER IT FIRST, so there is genuinely something held when the order completes. Sending it
    // while already on the receipt leaves nothing pending, and a flush then returns 'idle' without ever
    // consulting the terminal state — which let a mutant deleting that check survive.
    w.openDetailModal(w.liveMenuGlobalGet('MENU')[0].id);
    await serve(w, envelope(B.rid, m));
    assert.ok(w.__liveMenu.applier.hasPending(), `${dir}: non-vacuity — a snapshot really is held`);
    // The modal is deliberately NOT closed: closing it schedules a flush that would land before the
    // stage transition finishes, and the point here is the terminal state, not a race with it.
    w.showStage('s5', 100);                      // …and the order completes before it can land
    await stageSettle();
    assert.ok(!painted(w).includes('After The Receipt'), `${dir}: the receipt is untouched`);
    w.liveMenuFlush();
    await settle();
    assert.ok(!painted(w).includes('After The Receipt'), `${dir}: 🔴 a flush cannot resurrect it either`);
    assert.ok(!w.__liveMenu.applier.hasPending(), `${dir}: and the held snapshot is dropped, not kept forever`);
    ok(`${dir}: once the order is complete the apply is IGNORED, and stays ignored`);
  }

  // ── 9b. …AND IGNORED AT APPLY TIME TOO, NOT ONLY AT FLUSH TIME ──
  // Two distinct checks: one when the snapshot ARRIVES on a completed order, one when a snapshot that
  // was held earlier is flushed into one. Covering only the second let a mutation of the first survive.
  {
    const w = loadForm(dir);
    w.showStage('s5', 100);
    await stageSettle();
    const before = painted(w);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Arrived After Receipt' };
    await serve(w, envelope(B.rid, m));
    assert.ok(!painted(w).includes('Arrived After Receipt'), `${dir}: a snapshot ARRIVING on the receipt is ignored`);
    assert.strictEqual(painted(w), before, `${dir}: nothing moved`);
    assert.ok(!w.__liveMenu.applier.hasPending(), `${dir}: and it is dropped, not held`);
    ok(`${dir}: a snapshot arriving after the order completes is ignored at apply time`);
  }

  // ── 10. DEFERRED WHILE A SUBMIT IS IN FLIGHT ──
  {
    const w = loadForm(dir);
    const before = painted(w);
    // window.__paySubmitting is the real in-flight flag processPayment sets (orderSubmitting is a
    // lexical `let` and deliberately not reachable from outside the script).
    w.__paySubmitting = true;
    assert.ok(w.liveMenuBusy(), `${dir}: non-vacuity — a submit is in flight`);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Mid Submit' };
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(painted(w), before, `${dir}: nothing races the submission`);
    w.__paySubmitting = false;
    w.liveMenuFlush();
    await settle();
    assert.ok(painted(w).includes('Mid Submit'), `${dir}: and lands once it finishes`);
    ok(`${dir}: an apply never races a submit in flight`);
  }

  // ── 11. 🔴 FOCUS SURVIVES A RE-RENDER OF THE CONTAINER IT WAS IN ──
  // Not a trivial assertion: the focused control is INSIDE a menu container, so the re-render destroys
  // the very node that had focus. Restoring it means finding its replacement by id.
  {
    const w = loadForm(dir);
    const firstId = w.liveMenuGlobalGet('MENU')[0].id;
    const btn = w.document.getElementById('qty-add-' + firstId);
    assert.ok(btn, `${dir}: the control exists to focus`);
    btn.focus();
    assert.strictEqual(w.document.activeElement.id, 'qty-add-' + firstId, `${dir}: non-vacuity — it really has focus`);
    await serve(w, envelope(B.rid, B.menu(w)));
    assert.ok(w.document.getElementById('qty-add-' + firstId) !== btn, `${dir}: non-vacuity — the node really was replaced`);
    assert.strictEqual(w.document.activeElement.id, 'qty-add-' + firstId, `${dir}: 🔴 focus is back on its replacement`);
    ok(`${dir}: focus survives a re-render that destroys the focused node`);
  }

  // ── 12. THE PAGE DOES NOT JUMP ──
  // Made non-vacuous by having the render itself reset the scroll — which is what a stage swap or a
  // shrinking document does in a real browser. The assertion is that the apply puts it back.
  {
    const w = loadForm(dir);
    w.scrollTo(0, 640);
    const realRender = w.renderMenu;
    w.renderMenu = function () { w.scrollTo(0, 0); return realRender.apply(this, arguments); };
    await serve(w, envelope(B.rid, B.menu(w)));
    w.renderMenu = realRender;
    assert.strictEqual(w.scrollY, 640, `${dir}: 🔴 the customer is left where they were reading`);
    ok(`${dir}: scroll position is restored across an apply that resets it`);
  }

  // ── 13. A DISH THE UPGRADE INTRODUCED RENDERS AS 0, NOT undefined ──
  {
    const w = loadForm(dir);
    const m = B.menu(w);
    const fresh = { ...m.dishes[0], id: (dir === 'xpizza-orders' ? 990001 : 'lm-brand-new'), name: 'Plato Nuevo' };
    m.dishes = m.dishes.concat([fresh]);
    await serve(w, envelope(B.rid, m));
    const html = painted(w);
    assert.ok(html.includes('Plato Nuevo'), `${dir}: the new dish is on screen`);
    const card = w.document.getElementById('qty-' + fresh.id);
    assert.ok(card, `${dir}: with its quantity control`);
    assert.strictEqual(card.textContent, '0', `${dir}: 🔴 showing 0 — never "undefined"`);
    w.chg(fresh.id, 1);
    assert.ok(Number.isFinite(w.calcTotal()), `${dir}: and adding it keeps the total finite (no NaN)`);
    ok(`${dir}: a dish introduced by the upgrade starts at 0 and adds cleanly`);
  }

  // ── 14. 🔴 THE CART IS RECONCILED, NOT REWRITTEN ──
  // The Task 4 guarantee, observed through the real apply: a dish the upgrade removes leaves the MENU
  // and stays in the CART, blocking, rather than vanishing from the order.
  {
    const w = loadForm(dir);
    const doomed = w.liveMenuGlobalGet('MENU')[1];
    w.chg(doomed.id, 2);
    assert.strictEqual(w.cartItemCount(), 2, `${dir}: in the cart to begin with`);
    const m = B.menu(w);
    m.dishes = m.dishes.filter((d) => String(d.id) !== String(doomed.id));
    await serve(w, envelope(B.rid, m));
    assert.ok(!painted(w).includes('id="card-' + doomed.id + '"'), `${dir}: the tile is gone from the menu`);
    assert.strictEqual(w.cartItemCount(), 2, `${dir}: 🔴 but the line is still in the cart`);
    const conflicts = w.cartConflicts();
    assert.strictEqual(conflicts.length, 1, `${dir}: and it is unresolved`);
    assert.strictEqual(conflicts[0].unresolved, 'removed', `${dir}: pinned reason`);
    assert.strictEqual(w.buildOrder(), false, `${dir}: so no order can be built from it`);
    ok(`${dir}: a dish the upgrade removes leaves the menu but stays in the cart, blocking`);
  }

  // ── 15. THE CACHED QUOTE IS DROPPED ──
  {
    const w = loadForm(dir);
    // A NON-EMPTY cart, because the quote refresh clears the key by itself when the cart is empty —
    // which made the original version of this assertion true for a reason that had nothing to do with
    // the apply, and let a mutant deleting the invalidation survive.
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.__serverQuote.key = 'stale-key';
    w.__serverQuote.cents = 999900;
    await serve(w, envelope(B.rid, B.menu(w)));
    assert.strictEqual(w.__serverQuote.key, null, `${dir}: the stale quote key is cleared`);
    assert.strictEqual(w.__serverQuote.cents, null, `${dir}: 🔴 and its amount, so no stale estimate survives a menu change`);
    ok(`${dir}: the cached server quote is invalidated by an apply`);
  }

  // ── 16. NO PAGE ERRORS ESCAPED ──
  // A jsdomError means an uncaught exception took out a script — the failure mode that hid a
  // temporal-dead-zone bug in this very wiring until the page was actually loaded.
  {
    const w = loadForm(dir);
    await serve(w, envelope(B.rid, B.menu(w)));
    assert.deepStrictEqual(w.__jsdomErrors, [], `${dir}: the page raised no uncaught errors: ${w.__jsdomErrors.join(' | ')}`);
    ok(`${dir}: loading and upgrading the page raises no uncaught errors`);
  }

  // ── 17. TWO DISHES SHARING AN ID IS A MALFORMED SNAPSHOT ──
  // Every record well-formed, the collection not — the set-level rule hydrate() and the send gate both
  // had to learn. One of the two silently wins every lookup (cart reconciliation, pricing, availability)
  // and which one is an accident of iteration order.
  {
    const w = loadForm(dir);
    const before = painted(w);
    const m = B.menu(w);
    m.dishes = m.dishes.concat([{ ...m.dishes[0], name: 'Impostor', price: m.dishes[0].price + 300 }]);
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(painted(w), before, `${dir}: 🔴 refused whole — never "whichever one came last"`);
    ok(`${dir}: a snapshot with two dishes sharing an id is refused whole`);
  }

  // ── 18. AN IN-CART ITEM'S STEPPER SURVIVES THE RE-RENDER ──
  // renderMenu draws every card from the template, which shows the collapsed "+"; the stepper state of
  // an item already in the cart is applied by chg() at runtime and is erased by a re-render. Without the
  // re-sync, a customer with two in their cart watches the control reset to "+" under them.
  {
    const w = loadForm(dir);
    const first = w.liveMenuGlobalGet('MENU')[0];
    w.chg(first.id, 2);
    const shownBefore = w.document.getElementById('qty-' + first.id).textContent;
    assert.strictEqual(shownBefore, '2', `${dir}: non-vacuity — the card shows 2 before the upgrade`);
    await serve(w, envelope(B.rid, B.menu(w)));
    assert.strictEqual(w.document.getElementById('qty-' + first.id).textContent, '2',
      `${dir}: 🔴 the quantity is still on the card after the re-render`);
    const controls = w.document.getElementById('qty-controls-' + first.id);
    if (controls) assert.ok(controls.className.includes('visible'), `${dir}: and the stepper is still open, not collapsed to "+"`);
    ok(`${dir}: an in-cart item's card state survives the re-render`);
  }

  // ── 19. A SNAPSHOT FOR THE OTHER BRAND IS NOT A DEGRADED MENU ──
  {
    const w = loadForm(dir);
    const before = painted(w), menuBefore = w.liveMenuGlobalGet('MENU');
    const m = B.menu(w);
    // 🔴 VISIBLY DIFFERENT, deliberately. The first version of this sent the CURRENT menu under the
    // wrong rid — so applying it would have produced identical markup and the assertion passed whether
    // the rid was checked or not. A mutation that deleted the rid check survived it.
    m.dishes[0] = { ...m.dishes[0], name: 'Otra Marca', price: m.dishes[0].price + 77 };
    await serve(w, envelope(B.rid === 'x_pizza' ? 'la_musa' : 'x_pizza', m));
    assert.ok(!painted(w).includes('Otra Marca'), `${dir}: someone else's prices never reach the screen`);
    assert.strictEqual(painted(w), before, `${dir}: nothing moved at all`);
    assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `${dir}: and MENU is the identical prior array`);
    ok(`${dir}: a snapshot carrying another restaurant's rid is refused — never defaulted`);
  }

  // ── 20. la_musa ONLY — A DISH IN NO EXISTING CATEGORY IS REFUSED ──
  // la_musa renders one container per category, so a dish whose cat is not among them renders nowhere:
  // it would be in MENU, priced and sellable, and invisible on the page.
  if (dir === 'la-musa-orders') {
    const w = loadForm(dir);
    const before = painted(w);
    const m = B.menu(w);
    const menuBefore = w.liveMenuGlobalGet('MENU');
    m.dishes = m.dishes.concat([{ ...m.dishes[0], id: 'lm-orphan', name: 'Huerfano', cat: 'no-such-category' }]);
    await serve(w, envelope(B.rid, m));
    // Asserted on MENU, not on the markup: an orphan renders into a container that does not exist, so
    // the PAGE looks unchanged whether the snapshot was refused or silently accepted. The difference
    // that matters is whether the dish entered MENU — priced, sellable, and invisible.
    assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `${dir}: 🔴 refused — MENU is the identical prior array`);
    assert.strictEqual(painted(w), before, `${dir}: and nothing rendered`);
    ok(`${dir}: a dish referencing a category that does not exist is refused whole`);
  }
}

OPEN.forEach((d) => { try { d.window.close(); } catch (_) {} });
console.log(`\n${n} checks passed across both forms.`);
