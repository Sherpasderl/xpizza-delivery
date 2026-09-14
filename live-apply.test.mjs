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

/* Availability is installed by running the form's OWN loadAvailability against a stubbed poll — not by
   assigning itemAvail, which is module-lexical and unreachable from here anyway. Driving the real poll
   also means these tests exercise the same path the KDS feed does, including its fail-open handling. */
const loadAvail = async (w, map) => {
  const prev = w.__respond;
  w.__respond = (url) => (/item_availability/.test(url) ? res(map) : prev(url));
  await w.loadAvailability();
  await settle();
};

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

  /* (The old "a throw mid-render rolls back globals and DOM" case lived here. It asserted a DOM-undo
     contract the design no longer has — and should not have: undoing the markup of the regions that
     hold the menu would also undo the markup of the customer's input fields inside them. What replaced
     it is checks 19-21 below: a mid-commit throw REDRAWS the last good menu, typed input survives, and
     a renderer that cannot draw the old menu either is reported fatal rather than papered over.) */

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

  // ── 19. 🔴 A MID-COMMIT THROW REDRAWS THE LAST GOOD MENU ──
  // The commit does not try to undo itself. prepare has already refused anything unusable, so a throw
  // here means a renderer bug — and the recovery is a clean redraw of the menu that was standing, which
  // is coherent whatever the half-finished one left behind. The throw is placed at a step AFTER the
  // menu has rendered, which is exactly the case where a half-applied screen would otherwise persist.
  {
    const w = loadForm(dir);
    const before = painted(w);
    /* 🔴 THE FAILURE IS DATA-DEPENDENT, and it has to be for this to mean anything. The recovery
       redraws by running the SAME paint over the old menu, so a renderer that throws unconditionally
       throws again during recovery — that case is check 21, and it ends fatal. What the redraw is FOR
       is the realistic failure: a snapshot that is valid but trips a renderer, where the menu that was
       standing does not. This stub throws only while the new data is installed. */
    const realTender = w.onCashTenderedInput;
    /* 🔴 THE REAL BODY RUNS FIRST, THEN IT THROWS — and that ordering is the whole test. The previous
       version threw INSTEAD of running, which meant onCashTenderedInput never re-derived cashExactMode
       from the cleared-quote total, so the mode never flipped and the bug this is here to catch never
       occurred. It passed because nothing went wrong. Running the real body reproduces the flip and
       then fails the commit, which is the actual sequence. */
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      if (w.liveMenuGlobalGet('MENU')[0].name === 'Should Not Survive') throw new Error('tender hint exploded');
      return out;
    };
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Should Not Survive', price: m.dishes[0].price + 40 };
    await serve(w, envelope(B.rid, m));
    w.onCashTenderedInput = realTender;

    assert.strictEqual(w.__liveMenu.applier.state().lastError.message, 'tender hint exploded',
      `${dir}: non-vacuity — the commit really failed after the menu had been drawn`);
    assert.ok(!painted(w).includes('Should Not Survive'),
      `${dir}: 🔴 the half-applied menu is gone`);
    assert.strictEqual(painted(w), before, `${dir}: and what stands is the prior menu, drawn whole`);
    assert.strictEqual(w.liveMenuGlobalGet('MENU')[0].name, B.menu(w).dishes[0].name,
      `${dir}: the globals agree with what is on screen`);
    assert.ok(w.__jsdomErrors.length === 0, `${dir}: and the page raised nothing uncaught`);
    ok(`${dir}: a mid-commit throw redraws the last good menu — no half-applied screen`);
  }

  // ── 20. 🔴 …AND THE CUSTOMER'S TYPED INPUT SURVIVES IT ──
  // The reason the recovery is a redraw rather than a DOM undo. Restoring the markup of the regions
  // that hold the menu would also restore the markup of the fields inside them — wiping a name, a
  // phone number, a cash-tendered amount, to fix a cosmetic glitch. A redraw cannot: it writes the
  // menu containers and the totals, and never touches an input the customer has filled in.
  {
    const w = loadForm(dir);
    const name = w.document.getElementById('cname');
    const tendered = w.document.getElementById('cash-tendered');
    assert.ok(name && tendered, `${dir}: the typed fields exist`);
    const phone = w.document.getElementById('cphone');
    assert.ok(phone, `${dir}: the phone field exists`);
    name.value = 'Ana Martínez';
    phone.value = '9876 5432';
    tendered.value = '500';
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);

    const realTender = w.onCashTenderedInput;
    /* 🔴 THE REAL BODY RUNS FIRST, THEN IT THROWS — and that ordering is the whole test. The previous
       version threw INSTEAD of running, which meant onCashTenderedInput never re-derived cashExactMode
       from the cleared-quote total, so the mode never flipped and the bug this is here to catch never
       occurred. It passed because nothing went wrong. Running the real body reproduces the flip and
       then fails the commit, which is the actual sequence. */
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      if (w.liveMenuGlobalGet('MENU')[0].name === 'Should Not Survive') throw new Error('tender hint exploded');
      return out;
    };
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Should Not Survive' };
    await serve(w, envelope(B.rid, m));
    w.onCashTenderedInput = realTender;

    assert.strictEqual(w.document.getElementById('cname').value, 'Ana Martínez',
      `${dir}: 🔴 the name the customer typed is untouched by the recovery`);
    assert.strictEqual(w.document.getElementById('cash-tendered').value, '500',
      `${dir}: 🔴 …and so is the amount they were paying with`);
    assert.strictEqual(w.document.getElementById('cphone').value, '9876 5432',
      `${dir}: …and the phone number — omitted from the first version of this check, which is what hid the tender bug`);
    assert.strictEqual(w.cartItemCount(), 1, `${dir}: and their cart is intact`);
    ok(`${dir}: recovery never clears the customer's typed input`);
  }

  // ── 21. 🔴 THE INVARIANT: A FAILED APPLY LEAVES THE TENDER AND THE MODE EXACTLY AS THEY WERE ──
  //
  // Stated as an invariant over BOTH modes rather than as cases, and that is the point. Two earlier
  // rounds of this were a list — first the menu, then the quote — and each time the next item on the
  // list was the one that leaked. The exact-mode case was fixed by restoring the quote; the CUSTOM case
  // then fell through it, because onCashTenderedInput re-derives cashExactMode from whatever total is
  // current, so a commit that clears the quote can flip a custom tender to "exact" and nothing flips it
  // back. The recovery then rewrites the tender down to the restored quote's total.
  //
  // So: for every starting mode, the tender VALUE and the MODE must come out of a failed apply
  // byte-identical. The mode is not readable from out here (it is a lexical `let`), so it is asserted
  // behaviourally — a later updateTotal must not move the tender either, which it would if the mode
  // were stuck on exact.
  for (const mode of ['exact', 'custom']) {
    const w = loadForm(dir);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');

    // A server quote BELOW the local total: the gap is what the bug spends.
    const localTotal = w.calcTotal();
    w.__serverQuote.key = w.serverQuoteCartKey();
    w.__serverQuote.cents = Math.round((localTotal - 10) * 100);
    const quotedTotal = w.redeemAdjustedTotal();
    assert.ok(quotedTotal < localTotal, `${dir}/${mode}: non-vacuity — the quote really is lower than the local total`);

    // EXACT: the tender equals the quoted total. CUSTOM: it equals the LOCAL total — a number the
    // customer chose, which the temporary total during a failed commit happens to match. That
    // coincidence is what flips the mode.
    if (mode === 'exact') w.setCashTendered(quotedTotal);
    else { box().value = String(localTotal); w.onCashTenderedInput(); }
    const tenderBefore = box().value;
    const quoteKeyBefore = w.__serverQuote.key, quoteInflightBefore = w.__serverQuote.inflight;

    // DEMONSTRATE THE HAZARD, so the assertions below cannot pass vacuously: with the quote gone the
    // total jumps to the local one, and a custom tender equal to it is re-derived as exact — after
    // which restoring the quote drags the tender down.
    if (mode === 'custom') {
      const q = { key: w.__serverQuote.key, cents: w.__serverQuote.cents };
      w.__serverQuote.key = null; w.__serverQuote.cents = null;
      w.updateTotal();                                   // the flip
      w.__serverQuote.key = q.key; w.__serverQuote.cents = q.cents;
      w.updateTotal();                                   // …and the fall
      assert.notStrictEqual(box().value, tenderBefore,
        `${dir}/custom: non-vacuity — this sequence really does lower the tender (${tenderBefore} → ${box().value})`);
      box().value = tenderBefore; w.onCashTenderedInput();   // put the customer back before the real test
      assert.strictEqual(box().value, tenderBefore);
    }

    const realTender = w.onCashTenderedInput;
    /* 🔴 THE REAL BODY RUNS FIRST, THEN IT THROWS — and that ordering is the whole test. The previous
       version threw INSTEAD of running, which meant onCashTenderedInput never re-derived cashExactMode
       from the cleared-quote total, so the mode never flipped and the bug this is here to catch never
       occurred. It passed because nothing went wrong. Running the real body reproduces the flip and
       then fails the commit, which is the actual sequence. */
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      if (w.liveMenuGlobalGet('MENU')[0].name === 'Should Not Survive') throw new Error('tender hint exploded');
      return out;
    };
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Should Not Survive' };
    await serve(w, envelope(B.rid, m));
    w.onCashTenderedInput = realTender;

    assert.strictEqual(w.__liveMenu.applier.state().lastError.message, 'tender hint exploded',
      `${dir}/${mode}: non-vacuity — the apply really did fail`);
    assert.strictEqual(box().value, tenderBefore,
      `${dir}/${mode}: 🔴 the customer is still paying the amount they chose`);
    assert.strictEqual(w.__serverQuote.cents, Math.round((localTotal - 10) * 100),
      `${dir}/${mode}: and the quote a failed apply cleared is restored — amount…`);
    assert.strictEqual(w.__serverQuote.key, quoteKeyBefore, `${dir}/${mode}: …and key`);
    /* The in-flight marker is deliberately NOT restored verbatim: the recovery advances it to a fresh
       epoch so that every request outstanding across the failed apply is orphaned. Restoring the old
       token would re-arm the original request, which is no longer something to listen to. */
    assert.notStrictEqual(w.__serverQuote.inflight, quoteInflightBefore,
      `${dir}/${mode}: the in-flight token is advanced, not restored — outstanding requests are orphaned`);
    assert.strictEqual(w.__serverQuote.inflightKey, null,
      `${dir}/${mode}: …and the per-cart dedupe is cleared so a genuinely new request can still be made`);

    /* 🔴 THE MODE, DISTINGUISHED BY MOVING THE TOTAL. The previous version called updateTotal() at the
       UNCHANGED total and asserted the tender had not moved — which is true in BOTH modes, because an
       exact tender at an unchanged total is rewritten to the same number it already held. It proved
       nothing, and replacing the restore with `cashExactMode = false` passed it. The two modes are only
       distinguishable when the total MOVES: an exact tender follows it, a custom one does not. */
    const movedCents = Math.round((quotedTotal - 5) * 100);
    w.__serverQuote.cents = movedCents;
    w.updateTotal();
    if (mode === 'exact') {
      assert.strictEqual(Number(box().value), movedCents / 100,
        `${dir}/exact: 🔴 an exact tender must still FOLLOW a changed total — the mode came through`);
    } else {
      assert.strictEqual(box().value, tenderBefore,
        `${dir}/custom: 🔴 a custom tender must still NOT follow the total — the mode came through`);
    }
    ok(`${dir}: a failed apply leaves the tender and the mode byte-identical (${mode} mode)`);
  }

  // ── 21b. …INCLUDING WITH A REDEMPTION ACTIVE ──
  // The total can also come from a redemption quote held by __ACCOUNT, which the snapshot does not
  // cover. It does not need to: the tender and the mode are restored by VALUE, so it makes no
  // difference where the total the redraw computed came from. Asserted rather than assumed.
  {
    const w = loadForm(dir);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');
    let redeemCents = Math.round((w.calcTotal() - 25) * 100);
    w.__ACCOUNT = {
      getRedeemPayload: () => ({ reward_id: 'r1' }),
      getRedeemQuote: () => ({ total_cents: redeemCents }),
      getRedeemQuoteTotalCents: () => redeemCents,
      customerIdToken: async () => null,
      classifyRedeemError: () => null,
      restoreRedeem: () => {}, setRestoring: () => {},
    };
    box().value = String(w.calcTotal());              // a custom tender, chosen against the undiscounted total
    w.onCashTenderedInput();
    const tenderBefore = box().value;

    const realTender = w.onCashTenderedInput;
    /* The real body runs before the throw, as in the checks above. NOTE what is different here, and it
       is stated at the assertion below too: this setup does NOT reproduce the custom→exact flip — with a
       redemption active the total does not move when the apply clears the server quote, because
       redeemAdjustedTotal prefers the redemption quote. The comment this replaced was copied from the
       flip tests and claimed otherwise; a test that overstates what it exercises is worth less than one
       that says plainly what it does not. */
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      if (w.liveMenuGlobalGet('MENU')[0].name === 'Should Not Survive') throw new Error('tender hint exploded');
      return out;
    };
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Should Not Survive' };
    await serve(w, envelope(B.rid, m));
    w.onCashTenderedInput = realTender;

    assert.strictEqual(w.__liveMenu.applier.state().lastError.message, 'tender hint exploded',
      `${dir}: non-vacuity — the apply failed with a redemption active`);
    assert.strictEqual(box().value, tenderBefore,
      `${dir}: 🔴 a redemption-active custom tender survives a failed apply too`);
    /* And the MODE, by the same moving-total test. Worth stating what is NOT being claimed here: with a
       redemption active the custom→exact flip is not reachable at all, because redeemAdjustedTotal
       takes the redemption quote in preference to the server one and the apply never clears the
       redemption quote — so the total does not move during the commit. This checks the invariant holds
       on that path, not that the flip was reproduced on it. */
    redeemCents -= 500;                       // move the total the redemption dictates
    w.updateTotal();
    assert.strictEqual(box().value, tenderBefore,
      `${dir}: 🔴 …and it is still a CUSTOM tender — it does not follow the redemption total`);
    ok(`${dir}: the invariant holds with a redemption active (flip unreachable there — precedence, not luck)`);
  }

  // ── 23. 🔴 THE DOUBLE FAULT — THE COMMIT THROWS AND THE RECOVERY THROWS TOO ──
  // The invariant said "whatever they were" but was written on the happy path: the customer-restore was
  // a statement AFTER the redraw, so when the redraw itself threw it never ran — while that redraw had
  // already flipped the mode and lowered the tender. A try/finally makes it unconditional, and the
  // throw still propagates so the page is still reported unrecoverable. Both properties, not a choice
  // between them.
  {
    const w = loadForm(dir);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');
    const localTotal = w.calcTotal();
    w.__serverQuote.key = w.serverQuoteCartKey();
    w.__serverQuote.cents = Math.round((localTotal - 10) * 100);
    const quotedTotal = w.redeemAdjustedTotal();
    box().value = String(localTotal);                 // a CUSTOM tender equal to the local total
    w.onCashTenderedInput();
    const tenderBefore = box().value;

    // Throws on EVERY paint — the commit's and the recovery's — after letting the real body run, so the
    // mode really does flip before each failure.
    const realTender = w.onCashTenderedInput;
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      throw new Error('tender hint exploded');
    };
    await serve(w, envelope(B.rid, B.menu(w)));
    w.onCashTenderedInput = realTender;

    const st = w.__liveMenu.applier.state();
    assert.ok(st.fatal, `${dir}: non-vacuity — this really is a double fault; the recovery failed too`);
    assert.strictEqual(box().value, tenderBefore,
      `${dir}: 🔴 the customer's tender survives a failed recovery, not just a failed commit`);
    w.__serverQuote.cents = Math.round((quotedTotal - 5) * 100);
    w.updateTotal();
    assert.strictEqual(box().value, tenderBefore,
      `${dir}: 🔴 …and it is still CUSTOM — the flipped mode did not survive either`);
    ok(`${dir}: a double fault still leaves the tender and mode exactly as the customer had them`);
  }

  // ── 25. 🔴 THE ORPHANED-QUOTE MATRIX: mode × fault × settlement direction ──
  //
  // THE ROOT, and why the two previous rounds each closed only a site. `inflight` held the CART KEY, so
  // two requests for the SAME cart were indistinguishable — and a failed apply creates exactly that
  // pair: the commit's invalidation clears the in-flight marker (which is also the per-cart dedupe), so
  // the paint starts a duplicate while the original is still outstanding. Whichever settled first
  // matched the restored marker, was treated as current, and overwrote the quote the recovery had put
  // back; the next exact-mode updateTotal then spent it and lowered the tender.
  //
  // Guarding the rejection path (round 4) fixed one settlement direction of one of the two requests.
  // Identity is now per-REQUEST, and the recovery ADVANCES the token, so both outstanding requests are
  // orphaned whichever way each settles. This matrix is the class, not another instance:
  //   {exact, custom} × {single fault, double fault} × {orphan resolves, orphan rejects}
  for (const mode of ['exact', 'custom']) {
  for (const fault of ['single', 'double']) {
  for (const settleAs of ['resolve', 'reject']) {
  for (const order of ['duplicate-first', 'original-first']) {
  for (const pairing of ['agree', 'mixed']) {
    const w = loadForm(dir);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');

    const localTotal = w.calcTotal();
    const quotedCents = Math.round((localTotal - 10) * 100);

    // THE ORIGINAL request: genuinely outstanding across the apply, holding the current token.
    let settleOriginal = null;
    const original = new Promise((resolve, reject) => { settleOriginal = { resolve, reject }; });
    original.catch(() => {});
    let quoteHandler = () => original;
    w.__respond = (url) => (url.includes('/menu/') ? res(menuBody) : /quote/i.test(url) ? quoteHandler() : new Promise(() => {}));
    const menuBody = envelope(B.rid, (() => { const m = B.menu(w); m.dishes[0] = { ...m.dishes[0], name: 'Should Not Survive' }; return m; })());
    w.__serverQuote.inflight = null; w.__serverQuote.inflightKey = null;
    w.updateTotal();                                   // issues the original request
    assert.ok(w.__serverQuote.inflightKey, `${dir}/${mode}/${fault}/${settleAs}/${order}/${pairing}: non-vacuity — an original request is outstanding`);

    // The customer's state, set AFTER the original went out.
    w.__serverQuote.key = w.serverQuoteCartKey();
    w.__serverQuote.cents = quotedCents;
    if (mode === 'exact') w.setCashTendered(w.redeemAdjustedTotal());
    else { box().value = String(localTotal); w.onCashTenderedInput(); }
    const tenderBefore = box().value;
    const quoteCallsBefore = w.__calls.filter((u) => /quote/i.test(u)).length;

    // THE DUPLICATE the failed apply's paint will start, once the invalidation clears the dedupe.
    let settleDuplicate = null;
    const duplicate = new Promise((resolve, reject) => { settleDuplicate = { resolve, reject }; });
    duplicate.catch(() => {});
    quoteHandler = () => duplicate;

    let thrown = 0;
    const realTender = w.onCashTenderedInput;
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      const started = w.__calls.filter((u) => /quote/i.test(u)).length > quoteCallsBefore;
      if (started && (fault === 'double' || thrown === 0)) { thrown += 1; throw new Error('tender hint exploded'); }
      return out;
    };
    await w.__liveMenu.feed.refresh();
    await settle();
    w.onCashTenderedInput = realTender;

    const st = w.__liveMenu.applier.state();
    assert.ok(st.lastError || st.fatal, `${dir}/${mode}/${fault}/${settleAs}/${order}/${pairing}: non-vacuity — the apply failed`);
    if (fault === 'double') assert.ok(st.fatal, `${dir}/${mode}/${fault}: non-vacuity — the recovery failed too`);
    assert.ok(w.__calls.filter((u) => /quote/i.test(u)).length > quoteCallsBefore,
      `${dir}/${mode}/${fault}/${settleAs}/${order}/${pairing}: non-vacuity — a DUPLICATE same-cart request really was started`);

    // Both outstanding requests settle, the orphan-under-test first.
    const good = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, total_cents: quotedCents - 5000 }) };
    const fire = (d, how) => (how === 'resolve' ? d.resolve(good) : d.reject(new Error('quote failed')));
    /* Both ORDERS and both PAIRINGS. The first committed matrix always settled the duplicate first with
       the replies agreeing; widening it to mixed outcomes REPLACED those cases rather than adding to
       them, which narrowed coverage while the count went up. `pairing` keeps both: 'agree' is the
       original combination, 'mixed' the one that exercises a guard seeing a success and a failure for
       the same cart. `settleAs` names what the FIRST reply does. */
    const [firstD, secondD] = (order === 'duplicate-first') ? [settleDuplicate, settleOriginal] : [settleOriginal, settleDuplicate];
    fire(firstD, settleAs);
    await settle();
    fire(secondD, pairing === 'agree' ? settleAs : (settleAs === 'resolve' ? 'reject' : 'resolve'));
    await settle();

    assert.strictEqual(w.__serverQuote.cents, quotedCents,
      `${dir}/${mode}/${fault}/${settleAs}/${order}/${pairing}: 🔴 no orphaned request may overwrite the restored quote`);
    w.updateTotal();
    assert.strictEqual(box().value, tenderBefore,
      `${dir}/${mode}/${fault}/${settleAs}/${order}/${pairing}: 🔴 …so the customer still pays what they chose`);
    // …and the MODE came through: move the total and see which way the tender goes.
    w.__serverQuote.cents = quotedCents - 500;
    w.updateTotal();
    if (mode === 'exact') {
      assert.strictEqual(Number(box().value), (quotedCents - 500) / 100,
        `${dir}/exact/${fault}/${settleAs}/${order}/${pairing}: an exact tender still follows the total`);
    } else {
      assert.strictEqual(box().value, tenderBefore,
        `${dir}/custom/${fault}/${settleAs}/${order}/${pairing}: a custom tender still does not follow the total`);
    }
  } } } } }
  ok(`${dir}: orphaned quote requests never touch the restored quote — 32 combinations (mode × fault × settlement × order × agreeing/mixed outcomes)`);

  // ── 26. 🔴 TWO REQUESTS FOR THE SAME CART ARE DIFFERENT REQUESTS (A → B → A) ──
  //
  // This is where per-request identity earns its keep, and it needs no live-menu apply at all: it is a
  // property of the quote layer that the recovery merely exposed. Marking the in-flight request by CART
  // KEY makes two requests for the same cart indistinguishable, and the cart can return to a previous
  // state by ordinary use — add an item, remove it again. Then the FIRST request for cart A settles
  // while the THIRD (also for cart A) is the one being awaited: under cart-key identity the stale reply
  // matches, is accepted as current, and clears the marker — so the reply anyone was actually waiting
  // for is discarded in its turn. The customer's displayed total comes from a request that was
  // superseded twice over.
  {
    const w = loadForm(dir);
    const deferreds = [];
    w.__respond = (url) => {
      if (url.includes('/menu/')) return new Promise(() => {});
      if (!/quote/i.test(url)) return new Promise(() => {});
      let d; const pr = new Promise((resolve, reject) => { d = { resolve, reject }; });
      pr.catch(() => {}); deferreds.push(d); return pr;
    };
    const dish = w.liveMenuGlobalGet('MENU')[0], other = w.liveMenuGlobalGet('MENU')[1];
    w.selectPay('cash');

    w.chg(dish.id, 1);          // cart A  → request 1
    w.chg(other.id, 1);         // cart B  → request 2
    w.chg(other.id, -1);        // cart A again → request 3
    assert.ok(deferreds.length >= 3,
      `${dir}: non-vacuity — three separate quote requests went out (${deferreds.length})`);

    const reply = (cents) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, total_cents: cents }) });
    // The FIRST cart-A request settles while the THIRD is the one being awaited.
    deferreds[0].resolve(reply(111100));
    await settle();
    assert.notStrictEqual(w.__serverQuote.cents, 111100,
      `${dir}: 🔴 a superseded request for the SAME cart must not be accepted as the current one`);
    // …and the reply that was actually being awaited still lands.
    deferreds[2].resolve(reply(222200));
    await settle();
    assert.strictEqual(w.__serverQuote.cents, 222200,
      `${dir}: 🔴 …and the request being awaited is not discarded by the stale one having matched first`);
    ok(`${dir}: two requests for the same cart are told apart (A → B → A, stale reply first)`);
  }

  // ── 27. 🔴 RETURNING TO AN ALREADY-QUOTED CART SUPERSEDES TOO ──
  //
  // The transition that fires NO request, which is why it looked like a no-op. Quote cart A and set an
  // exact tender from it; add an item (request for B goes out); remove it again. The cached-cart
  // short-circuit returns early — and B is still outstanding. When it settles it passes the guard,
  // clears the cache of the cart actually on screen, and the next exact-mode updateTotal lowers the
  // tender. Nothing to do with a failed apply: this is the live forms as they ship.
  for (const outcome of ['rejects', 'succeeds']) {
    const w = loadForm(dir);
    const deferreds = [];
    w.__respond = (url) => {
      if (!/quote/i.test(url)) return new Promise(() => {});
      let d; const pr = new Promise((resolve, reject) => { d = { resolve, reject }; });
      pr.catch(() => {}); deferreds.push(d); return pr;
    };
    const dish = w.liveMenuGlobalGet('MENU')[0], other = w.liveMenuGlobalGet('MENU')[1];
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');

    w.chg(dish.id, 1);                                  // cart A → request 1
    const reply = (cents) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, total_cents: cents }) });
    deferreds[0].resolve(reply(35000));                 // A is quoted and CACHED
    await settle();
    assert.strictEqual(w.__serverQuote.cents, 35000, `${dir}/${outcome}: non-vacuity — cart A is cached`);
    w.setCashTendered(w.redeemAdjustedTotal());         // exact tender, on A's quote
    const tenderBefore = box().value;

    w.chg(other.id, 1);                                 // cart B → request 2 goes out
    const before = deferreds.length;
    w.chg(other.id, -1);                                // …and straight back to cart A — fires NOTHING
    assert.strictEqual(deferreds.length, before,
      `${dir}/${outcome}: non-vacuity — returning to the cached cart really does fire no request`);

    // B settles, long after the customer went back to A.
    if (outcome === 'rejects') deferreds[1].reject(new Error('quote failed'));
    else deferreds[1].resolve(reply(9900));
    await settle();

    assert.strictEqual(w.__serverQuote.cents, 35000,
      `${dir}/${outcome}: 🔴 a request for the cart the customer LEFT must not touch the cached quote`);
    w.updateTotal();
    assert.strictEqual(box().value, tenderBefore,
      `${dir}/${outcome}: 🔴 …so the exact tender is still what they chose`);
    ok(`${dir}: returning to an already-quoted cart supersedes the request left behind (B ${outcome})`);
  }

  // ── 28. …BUT THE SAME-CART DEDUPE MUST *NOT* SUPERSEDE ──
  //
  // The over-correction, and it is a real one: "every return supersedes" is nearly the rule but not
  // quite. A second call for the cart ALREADY being quoted must leave that request alone — it is the
  // reply this very call wants. Superseding there orphans it, so the reply is ignored when it lands and
  // the cart is never quoted at all: the display falls open to calcTotal and stays there until the cart
  // changes. Asserted so a future tidy-up cannot make the four returns uniform and call it a
  // simplification.
  {
    const w = loadForm(dir);
    const deferreds = [];
    w.__respond = (url) => {
      if (!/quote/i.test(url)) return new Promise(() => {});
      let d; const pr = new Promise((resolve, reject) => { d = { resolve, reject }; });
      pr.catch(() => {}); deferreds.push(d); return pr;
    };
    w.selectPay('cash');
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);        // cart A → one request goes out
    assert.strictEqual(deferreds.length, 1, `${dir}: non-vacuity — exactly one request so far`);
    w.updateTotal();                                    // same cart again → the dedupe path
    w.updateTotal();
    assert.strictEqual(deferreds.length, 1,
      `${dir}: non-vacuity — the dedupe really did prevent a second request`);

    deferreds[0].resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, total_cents: 41000 }) });
    await settle();
    assert.strictEqual(w.__serverQuote.cents, 41000,
      `${dir}: 🔴 the reply the deduped calls were waiting for must still be accepted`);
    ok(`${dir}: the same-cart dedupe does NOT orphan the request it is waiting for`);
  }

  // ── 29. 🔴 A SYNCHRONOUS FAILURE MID-TRANSITION SUPERSEDES TOO — THE FLOOR ──
  //
  // The last control-flow path. requestServerQuote wraps its body in try/catch, and if anything throws
  // BEFORE the token is taken — building the cart items, say — the error was swallowed and the PREVIOUS
  // request's token stayed current. That request then settled, passed the guard, cleared the cache of
  // the cart on screen, and the next exact-mode updateTotal lowered the tender.
  //
  // Not reachable with valid cart data today, which is the point: the guarantee should hold on every
  // path, not on the ones anyone thought to enumerate. The failure is injected the way the gate injected
  // it — by making the cart-items builder throw across the transition back to a cached cart.
  for (const outcome of ['rejects', 'succeeds']) {
    const w = loadForm(dir);
    const deferreds = [];
    w.__respond = (url) => {
      if (!/quote/i.test(url)) return new Promise(() => {});
      let d; const pr = new Promise((resolve, reject) => { d = { resolve, reject }; });
      pr.catch(() => {}); deferreds.push(d); return pr;
    };
    const dish = w.liveMenuGlobalGet('MENU')[0], other = w.liveMenuGlobalGet('MENU')[1];
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');
    const reply = (cents) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, total_cents: cents }) });

    w.chg(dish.id, 1);                                  // cart A → request 1
    deferreds[0].resolve(reply(35000));
    await settle();
    assert.strictEqual(w.__serverQuote.cents, 35000, `${dir}/${outcome}: non-vacuity — cart A is cached`);
    w.setCashTendered(w.redeemAdjustedTotal());
    const tenderBefore = box().value;

    w.chg(other.id, 1);                                 // cart B → request 2 goes out
    assert.ok(deferreds.length >= 2, `${dir}/${outcome}: non-vacuity — B's request is outstanding`);

    // …and the transition back to A happens while the items builder is broken, so requestServerQuote
    // throws before it can take a token. Everything downstream of it is guarded already, so the only
    // thing under test is what the catch leaves behind.
    const realBuilder = w.redeemCartItems;
    w.redeemCartItems = () => { throw new Error('cart builder exploded'); };
    try { w.chg(other.id, -1); } catch (_) { /* the transition itself may surface it; the state is what matters */ }
    w.redeemCartItems = realBuilder;

    if (outcome === 'rejects') deferreds[1].reject(new Error('quote failed'));
    else deferreds[1].resolve(reply(9900));
    await settle();

    assert.strictEqual(w.__serverQuote.cents, 35000,
      `${dir}/${outcome}: 🔴 a request left live by a synchronous failure must not clobber the cache`);
    w.updateTotal();
    assert.strictEqual(box().value, tenderBefore,
      `${dir}/${outcome}: 🔴 …so the exact tender is still what the customer chose`);
    ok(`${dir}: a synchronous failure mid-transition still supersedes (stale request ${outcome})`);
  }

  // ── 30. …AND SO DOES A REDEMPTION TAKING OVER THE TOTAL ──
  // The same defect through the other door that returns without firing. Not named in the gate; included
  // because leaving a known-reachable instance because nobody pointed at it is the exact habit these
  // rounds have been about.
  {
    const w = loadForm(dir);
    const deferreds = [];
    w.__respond = (url) => {
      if (!/quote/i.test(url)) return new Promise(() => {});
      let d; const pr = new Promise((resolve, reject) => { d = { resolve, reject }; });
      pr.catch(() => {}); deferreds.push(d); return pr;
    };
    const dish = w.liveMenuGlobalGet('MENU')[0], other = w.liveMenuGlobalGet('MENU')[1];
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const reply = (cents) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, total_cents: cents }) });

    w.chg(dish.id, 1);
    deferreds[0].resolve(reply(35000));
    await settle();
    assert.strictEqual(w.__serverQuote.cents, 35000, `${dir}: non-vacuity — cart A is cached`);

    w.chg(other.id, 1);                                 // request for cart B goes out
    assert.ok(deferreds.length >= 2, `${dir}: non-vacuity — B's request is outstanding`);
    // A reward takes over the total: requestServerQuote now returns without firing…
    w.__ACCOUNT = { getRedeemPayload: () => ({ reward_id: 'r1' }), getRedeemQuoteTotalCents: () => 30000,
                    getRedeemQuote: () => ({ total_cents: 30000 }), customerIdToken: async () => null,
                    classifyRedeemError: () => null, restoreRedeem: () => {}, setRestoring: () => {} };
    w.chg(other.id, -1);                                // …back to cart A, through the redemption return
    deferreds[1].resolve(reply(9900));                  // B lands
    await settle();
    w.__ACCOUNT = null;                                 // the customer removes the reward
    assert.strictEqual(w.__serverQuote.cents, 35000,
      `${dir}: 🔴 a reply for a cart left behind must not clobber the cache through the redemption path`);
    ok(`${dir}: a redemption taking over the total also supersedes what was outstanding`);
  }

  /* ══ 1B TASK 7 — AVAILABILITY SURVIVES A LIVE MENU REPLACEMENT ═════════════════════════════════
     The overlay is a separate feed from the catalog, and the catalog can move the key the overlay was
     written against. What must hold: a catalog replacement never resurrects an item the kitchen has
     already disabled. */

  // ── 31. A REPLACED TILE COMES BACK DISABLED ──
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    const key = w.availKey(dir === 'xpizza-orders' ? dish.name : dish.id);
    await loadAvail(w, { [key]: { available: false } });
    assert.ok(w.document.getElementById('card-' + dish.id).className.includes('sold-out'),
      `${dir}: non-vacuity — the tile is disabled to begin with`);

    await serve(w, envelope(B.rid, B.menu(w)));           // a live upgrade rebuilds every tile
    const card = w.document.getElementById('card-' + dish.id);
    assert.ok(card.className.includes('sold-out'),
      `${dir}: 🔴 the replaced tile is still marked sold out`);
    const addBtn = w.document.getElementById('qty-add-' + dish.id);
    if (addBtn) assert.strictEqual(addBtn.disabled, true, `${dir}: …and its add control is still disabled`);
    assert.ok(card.querySelector('.agotado-pill'), `${dir}: …and still carries the Agotado pill`);
    ok(`${dir}: a tile replaced by a live upgrade comes back with the availability overlay applied`);
  }

  // ── 32. …AND THE CATALOG CANNOT ADD IT TO THE CART ──
  // The overlay is not just paint: chg() consults it. A replaced tile must be non-orderable, not merely
  // greyed — the two come apart if the reapply touches only the markup.
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    await loadAvail(w, { [w.availKey(dir === 'xpizza-orders' ? dish.name : dish.id)]: { available: false } });
    await serve(w, envelope(B.rid, B.menu(w)));
    w.chg(dish.id, 1);
    assert.strictEqual(w.cartItemCount(), 0,
      `${dir}: 🔴 an 86'd item cannot be added after the catalog replaced its tile`);
    ok(`${dir}: a replaced 86'd tile is non-orderable, not merely greyed`);
  }

  // ── 33. 🔴 A RENAME MUST NOT MOVE THE KEY OUT FROM UNDER THE FLAG ──
  // x_pizza is 86'd BY NAME, so a catalog rename changes the key the overlay was written against and the
  // lookup misses — the kitchen's flag silently stops applying and the item is orderable again. la_musa
  // is 86'd by id, which a rename does not touch; asserted on both so the difference is pinned rather
  // than assumed, and so a future change to either key strategy has to face this test.
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    const wasName = dish.name;
    await loadAvail(w, { [w.availKey(dir === 'xpizza-orders' ? wasName : dish.id)]: { available: false } });
    assert.ok(w.document.getElementById('card-' + dish.id).className.includes('sold-out'),
      `${dir}: non-vacuity — 86'd under the identity it had`);

    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: wasName + ' Especial' };   // the catalog renames it
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(w.liveMenuGlobalGet('MENU')[0].name, wasName + ' Especial',
      `${dir}: non-vacuity — the rename really landed`);

    const card = w.document.getElementById('card-' + dish.id);
    assert.ok(card.className.includes('sold-out'),
      `${dir}: 🔴 a renamed dish is STILL sold out — the catalog cannot un-86 it`);
    w.chg(dish.id, 1);
    assert.strictEqual(w.cartItemCount(), 0, `${dir}: 🔴 …and still cannot be ordered`);
    ok(`${dir}: a catalog rename cannot move the availability key out from under the kitchen's flag`);
  }

  // ── 34. FAIL-OPEN IS PRESERVED — the overlay only ever blocks on an explicit false ──
  // The rename-awareness widens what is CONSULTED, so it must not widen what BLOCKS: an absent entry, or
  // a stale `true` under an old key, must still leave the item sellable.
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    const wasName = dish.name;
    await loadAvail(w, { [w.availKey(dir === 'xpizza-orders' ? wasName : dish.id)]: { available: true } });
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: wasName + ' Especial' };
    await serve(w, envelope(B.rid, m));
    assert.ok(!w.document.getElementById('card-' + dish.id).className.includes('sold-out'),
      `${dir}: an explicit true under the old key does not block`);
    w.chg(dish.id, 1);
    assert.strictEqual(w.cartItemCount(), 1, `${dir}: …and it is orderable`);

    const w2 = loadForm(dir);
    const d2 = w2.liveMenuGlobalGet('MENU')[0];
    await loadAvail(w2, {});                                   // no data at all — the outage case
    await serve(w2, envelope(B.rid, B.menu(w2)));
    assert.ok(!w2.document.getElementById('card-' + d2.id).className.includes('sold-out'),
      `${dir}: an empty overlay leaves everything available (fail-open)`);
    ok(`${dir}: fail-open survives — only an explicit false blocks, under any key`);
  }

  // ── 35. …AND ON A RENDER THAT IS NOT AN APPLY ──
  // The live apply reapplies the overlay itself, so the reapply inside renderMenu is redundant THERE —
  // which is exactly why removing it survived a test that only exercised an apply. renderMenu is called
  // by other paths that do not reapply anything: a payment-return restoration is one, and it rebuilds
  // every tile. Without renderMenu's own reapply, a customer coming back from the hosted checkout sees
  // 86'd items as available and orderable.
  {
    const a = loadForm(dir);
    a.chg(a.liveMenuGlobalGet('MENU')[2].id, 1);
    const stash = JSON.parse(JSON.stringify({ form: a.snapshotForm(), ts: Date.now(), order_id: 'o1' }));

    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    await loadAvail(w, { [w.availKey(dir === 'xpizza-orders' ? dish.name : dish.id)]: { available: false } });
    assert.ok(w.document.getElementById('card-' + dish.id).className.includes('sold-out'),
      `${dir}: non-vacuity — 86'd before the restore`);

    // Written through the REAL storage API under the key the form actually reads; stubbing getItem
    // silently did nothing and the restore bailed out, which made the whole check vacuous.
    w.localStorage.setItem(dir === 'xpizza-orders' ? 'xpizza_pending_pay' : 'lamusa_pending_pay', JSON.stringify(stash));
    const cardBefore = w.document.getElementById('card-' + dish.id);
    w.restoreOrderForm();                                  // rebuilds every tile, applies no overlay of its own
    await settle();
    /* NON-VACUITY, and it is the whole test: if the restore bailed out (a rejected stash, say) the tile
       would still be carrying the class from the earlier poll and the assertion below would hold with
       the reapply deleted. Proving the node was REPLACED is what makes it a test of the re-render. */
    assert.notStrictEqual(w.document.getElementById('card-' + dish.id), cardBefore,
      `${dir}: non-vacuity — the restore really did rebuild the tiles`);
    assert.strictEqual(w.cartItemCount(), 1, `${dir}: non-vacuity — and the stashed cart came back`);
    assert.ok(w.document.getElementById('card-' + dish.id).className.includes('sold-out'),
      `${dir}: 🔴 a restoration-driven re-render still carries the overlay`);
    w.chg(dish.id, 1);
    assert.ok(!w.cartItems().some((x) => String(x.id) === String(dish.id)),
      `${dir}: 🔴 …and the 86'd item is still not orderable after a restore`);
    ok(`${dir}: a re-render that is not a live apply reapplies the overlay too`);
  }

  // ── 36. 🔴 AN EXPLICIT false UNDER *ANY* KEY WINS OVER A true UNDER ANOTHER ──
  // The previous fail-open check only ever placed a `true`, so it proved the overlay does not block on
  // one — not that a `false` still WINS when an older key says available. Those are different claims,
  // and the second is the one the rename-history exists for: the kitchen's 86 is filed under the name
  // the item had, while the catalog has since moved it to a name that may carry a stale `true`.
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    const wasName = dish.name;
    const oldKey = w.availKey(dir === 'xpizza-orders' ? wasName : dish.id);
    const newName = wasName + ' Especial';
    const newKey = w.availKey(dir === 'xpizza-orders' ? newName : dish.id);

    /* The mixed-key case only EXISTS where a rename can move the key, i.e. x_pizza. For la_musa both
       keys are the id, so `{[oldKey]:false, [newKey]:true}` collapses to one entry and the pair would
       be testing object-literal precedence rather than the availability rule. Its single-key semantics
       are asserted instead — said plainly rather than looping twice over the same key and calling it
       coverage. */
    const cases = (oldKey === newKey)
      ? [['single key false', { [oldKey]: { available: false } }]]
      : [['old false / new true', { [oldKey]: { available: false }, [newKey]: { available: true } }],
         ['old true / new false', { [oldKey]: { available: true }, [newKey]: { available: false } }]];
    assert.strictEqual(oldKey === newKey, dir === 'la-musa-orders',
      `${dir}: non-vacuity — only the brand keyed by id collapses the two keys`);
    for (const [which, map] of cases) {
      const v = loadForm(dir);
      const d = v.liveMenuGlobalGet('MENU')[0];
      await loadAvail(v, map);
      const m = B.menu(v);
      m.dishes[0] = { ...m.dishes[0], name: newName };
      await serve(v, envelope(B.rid, m));
      assert.ok(v.document.getElementById('card-' + d.id).className.includes('sold-out'),
        `${dir}/${which}: 🔴 an explicit false wins wherever it sits`);
      v.chg(d.id, 1);
      assert.strictEqual(v.cartItemCount(), 0, `${dir}/${which}: …and it stays unorderable`);
    }
    ok(`${dir}: ${oldKey === newKey ? 'an explicit false blocks (single key — a rename cannot move it)' : 'a false under any key beats a true under another — both orderings'}`);
  }

  // ── 37. la_musa ONLY — THE VARIANT LAUNCHER'S CTA FOLLOWS THE SELECTED VARIANT ──
  // A launcher is 86'd per VARIANT: the kitchen marks "Pad Thai - Pollo", not "Pad Thai". The CTA asked
  // about the launcher and so showed an enabled, priced "Agregar al carrito" for a sold-out protein. The
  // tap was already refused by chg(), so no money was at risk — but an enabled button that silently does
  // nothing is a worse answer than a disabled one.
  if (dir === 'la-musa-orders') {
    const w = loadForm(dir);
    const launcher = w.liveMenuGlobalGet('MENU').find((d) => w.itemIsLauncher(d));
    assert.ok(launcher, `${dir}: non-vacuity — the real bundle has a variant launcher`);
    const variants = w.liveMenuGlobalGet('VARIANT_ITEMS')[launcher.id].variantIds;
    const soldOutVariant = variants[1], okVariant = variants[0];
    await loadAvail(w, { [w.availKey(soldOutVariant)]: { available: false } });

    w.openDetailModal(launcher.id);
    const cta = () => w.document.getElementById('detail-cta');
    w.selectVariant(okVariant);
    assert.ok(cta().innerHTML.includes('Agregar'), `${dir}: non-vacuity — an available variant offers the CTA`);
    assert.notStrictEqual(cta().style.pointerEvents, 'none', `${dir}: …and it is tappable`);

    w.selectVariant(soldOutVariant);
    assert.ok(cta().innerHTML.includes('Agotado'),
      `${dir}: 🔴 a sold-out variant shows Agotado, not a priced Agregar`);
    assert.strictEqual(cta().style.pointerEvents, 'none', `${dir}: …and the CTA is not tappable`);

    w.selectVariant(okVariant);                            // and it comes back when the choice changes
    assert.ok(cta().innerHTML.includes('Agregar'), `${dir}: the CTA is re-evaluated on every selection change`);
    ok(`${dir}: the variant launcher's CTA follows the SELECTED variant's availability`);
  }

  // ── 38. AN OPEN MODAL'S CTA FOLLOWS A POLL THAT FLIPS AVAILABILITY ──
  // Bounded on purpose: the CTA follows, the modal body does not (re-rendering it mid-open would move
  // the option steppers under the customer's finger). chg() remains what actually refuses the add.
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU')[0];
    w.openDetailModal(dish.id);
    const cta = () => w.document.getElementById('detail-cta');
    assert.ok(cta() && !cta().innerHTML.includes('Agotado'),
      `${dir}: non-vacuity — the CTA is live before the poll`);

    await loadAvail(w, { [w.availKey(dir === 'xpizza-orders' ? dish.name : dish.id)]: { available: false } });
    assert.ok(cta().innerHTML.includes('Agotado'),
      `${dir}: 🔴 a poll that 86's the open dish updates the button the customer is about to press`);
    w.chg(dish.id, 1);
    assert.strictEqual(w.cartItemCount(), 0, `${dir}: …and the add is refused regardless`);
    ok(`${dir}: an open modal's CTA follows a poll that flips availability`);
  }

  /* ══ 1B TASK 8 — AUTHORED STRINGS ARE RENDERED BY CONTEXT ══════════════════════════════════════
     1A validates and publishes the catalog and is the primary control. These checks are the second
     line: they assume something got through it, and assert that a hostile authored value is INERT in
     every context the forms render into — not merely escaped for body text, which is the usual way a
     page that "escapes everything" still executes. */

  // ── 39. 🔴 A HOSTILE CATALOG IS INERT ON EVERY RENDER PATH, NOT JUST THE CARD ──
  //
  // THE FIXTURE USED TO STOP AT THE CARD, and that is precisely why seven unencoded sinks survived the
  // first pass: the detail modal, the launcher modal, the cart-review extras, the receipt, the
  // subcategory heading. Each is a different template, and a template nobody rendered is a template
  // nobody checked. So one hostile catalog is now walked across every surface a customer can reach, with
  // the SAME assertions applied to each — the payload must appear as text and must have produced no
  // element, no event attribute, and no script-bearing URL anywhere in that surface.
  {
    const w = loadForm(dir);
    const m = B.menu(w);
    const first = m.dishes[0];
    const MARK = 'XSSMARK';
    const payload = (ctx) => `<img src=x onerror="window.__XSS='${MARK}${ctx}'">`;
    m.dishes[0] = {
      ...first,
      name: payload('name'),
      desc: `</div><script>window.__XSS='${MARK}desc'</script>`,
      color: 'red;background:url(javascript:alert(1))',
      img: 'javascript:window.__XSS=1',
      emoji: payload('emoji'),
      subcat: payload('subcat'),
    };
    m.extras = m.extras.map((e, i) => (i === 0 ? { ...e, name: payload('extra') } : e));
    if (m.categories) m.categories = m.categories.map((c, i) => (i === 0 ? { ...c, name: payload('cat'), subcats: [payload('subcat')] } : c));
    /* 🔴 POISON EVERY DISH'S EMOJI, AND TAKE THE PHOTOS AWAY. Two coverage holes the b8 sweep found,
       both of the same shape — a surface was visited but the SINK on it was unreachable:
         • the emoji only renders when the dish has no usable photo, and the poisoned dish is in
           has_photo, so walking the modal never rendered an authored emoji at all;
         • the launcher modal shows the LAUNCHER's emoji, and only dishes[0] was poisoned.
       Emptying has_photo puts every dish on the emoji branch, and poisoning every dish means whichever
       one a surface happens to render is hostile. The photo branch is not lost — check 40 owns it. */
    m.has_photo = [];
    /* Colour too, not only the emoji: the launcher modal takes its colour from the LAUNCHER dish, and
       poisoning dishes[0] alone left that filter removable with this check still passing. */
    const HOSTILE_COLOR = 'red;background:url(javascript:alert(1))';
    /* EVERY dish, every authored display field. Names are made unique per index so a brand that refuses
       duplicate keys still ACCEPTS this snapshot — a fixture the form rejects proves nothing. `choice`
       is carried because the variant rows render it, and beverages are dishes like any other, so the
       list-layout row template is covered by the same sweep rather than by a special case. */
    m.dishes = m.dishes.map((d, i) => (i === 0
      ? { ...d, choice: d.choice === undefined ? undefined : payload('choice') }
      : { ...d, name: payload('name' + i), emoji: payload('emoji'), color: HOSTILE_COLOR,
          choice: d.choice === undefined ? undefined : payload('choice') }));
    // An option whose ID is hostile, not just its name — the id lands in data- attributes and in the
    // quoted id= of the option row, which is a different context from the body text beside it.
    m.extras = m.extras.concat([{ ...m.extras[0], id: payload('eid'), name: payload('extraname') }]);
    /* The launcher's LABEL is authored too ("Proteína"), and it only arrives with a served
       variant_items block — which nothing in this walk used to send, so the label was rendered from the
       page's own literal and its filter was never exercised. The ids stay valid: this check is about
       what the renderer does with hostile TEXT, and a block refused by validation renders nothing. */
    if (dir === 'la-musa-orders') {
      const vi = w.liveMenuGlobalGet('VARIANT_ITEMS');
      const lk = Object.keys(vi)[0];
      m.variant_items = { [lk]: { ...vi[lk], label: payload('label') } };
    }
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(w.liveMenuGlobalGet('MENU')[0].name, m.dishes[0].name,
      `${dir}: non-vacuity — the hostile snapshot was ACCEPTED (validation is not an XSS filter)`);

    /* ONE ASSERTION SET, APPLIED PER SURFACE. Written once so a surface added later is one line to
       cover, rather than a new set of ad-hoc checks that may or may not match the others. */
    const assertInert = (root, surface) => {
      assert.ok(root, `${dir}/${surface}: the surface rendered`);
      const els = [...root.querySelectorAll('*')];
      assert.deepStrictEqual([...root.querySelectorAll('script')].map((x) => x.tagName), [],
        `${dir}/${surface}: 🔴 the payload created no script element`);
      const evil = els.flatMap((el) => [...el.attributes])
        .filter((a) => /^on/i.test(a.name) && a.value.includes(MARK));
      assert.deepStrictEqual(evil.map((a) => `${a.ownerElement.tagName}[${a.name}]`), [],
        `${dir}/${surface}: 🔴 no element carries an event attribute from the payload`);
      els.filter((el) => el.hasAttribute && el.hasAttribute('src')).forEach((el) =>
        assert.ok(!/javascript:/i.test(el.getAttribute('src')), `${dir}/${surface}: 🔴 no javascript: src`));
      els.filter((el) => el.hasAttribute && el.hasAttribute('style')).forEach((el) =>
        assert.ok(!/javascript:|expression\(/i.test(el.getAttribute('style')), `${dir}/${surface}: 🔴 no script-bearing style`));
      assert.strictEqual(w.__XSS, undefined, `${dir}/${surface}: 🔴 nothing executed`);
    };
    const reached = [];
    /* `mustShow` takes the CONTEXT the payload must have come from, not just `true`. Every payload
       carries its own context marker, and the dish NAME is on almost every surface — so "some marker is
       present" was satisfied by the name alone, and a surface whose own sink rendered nothing still
       passed. Asking for XSSMARKextra on the cart sheet is what makes the extras line load-bearing. */
    const visit = (root, surface, mustShow) => {
      assertInert(root, surface);
      if (mustShow) {
        assert.ok(root.textContent.includes(MARK + mustShow),
          `${dir}/${surface}: non-vacuity — the ${mustShow} payload really was rendered here, as text`);
      }
      reached.push(surface);
    };

    // 1. the card grid
    /* Inertness is asserted on EVERY grid; the name payload is required across their UNION, because
       which grid holds the poisoned dish is a function of its category and is not this check's business.
       Requiring it on grid #0 pinned the test to a menu layout instead of to the payload. */
    const grids = containersOf(w).map((id) => w.document.getElementById(id));
    grids.forEach((g, i) => visit(g, 'card-grid#' + i, null));
    assert.ok(grids.some((g) => g && g.textContent.includes(MARK + 'name')),
      `${dir}: non-vacuity — the hostile dish NAME was rendered on one of the card grids`);
    // 2. the ordinary detail modal
    w.openDetailModal(first.id);
    visit(w.document.getElementById('detail-scroll'), 'detail-modal', 'emoji');
    w.chg(first.id, 1);                       // qty>0 renders the option rows, which carry option names
    w.openDetailModal(first.id);
    visit(w.document.getElementById('detail-scroll'), 'detail-modal+options', 'extra');
    w.closeDetailModal();
    // 3. the cart review sheet, including the per-item extras line
    /* 🔴 AN OPTION MUST ACTUALLY BE ON THE ITEM. The extras line is built from the SELECTED options, so
       with none chosen the sheet rendered an empty list and the sink was never exercised — the mutant
       that prints those names raw survived a check that claimed to cover the cart. Driven through the
       real writer (the form's own toggle) rather than by poking state, so what is proved is what the
       page does. The two brands key options differently: x_pizza per pizza INSTANCE, la_musa by id. */
    const hostileExtraId = m.extras[0].id;
    if (dir === 'xpizza-orders') w.toggleDetailExtra(hostileExtraId, first.id, 0);
    else w.chgDetailExtra(hostileExtraId, first.id, 1);
    w.openCartReview();
    visit(w.document.getElementById('cart-review-body'), 'cart-review', 'extra');
    w.closeCartReview();
    // 4. the PAY-STEP summary — a separate template from the cart sheet, and the one the customer is
    //    looking at while they enter a card. It was not on this walk at all.
    w.renderStage2Summary();
    visit(w.document.getElementById('s2-summary'), 'stage2-summary', 'name');
    // 5. the category tabs, where the authored CATEGORY name lands.
    const tabs = w.document.getElementById('cat-tabs');
    if (tabs) visit(tabs, 'category-tabs', 'cat');
    // 6. the receipt
    w.buildOrder();
    w.showSuccess();
    visit(w.document.getElementById('s5'), 'receipt', 'name');
    // 7. la_musa's launcher modal and its subcategory headings
    if (dir === 'la-musa-orders') {
      const launcher = w.liveMenuGlobalGet('MENU').find((d) => w.itemIsLauncher(d));
      if (launcher) {
        w.openDetailModal(launcher.id);
        const lm = w.document.getElementById('detail-scroll');
        visit(lm, 'launcher-modal', 'emoji');
        assert.ok(lm.textContent.includes(MARK + 'label'),
          `${dir}/launcher-modal: non-vacuity — the served variant LABEL was rendered here, as text`);
        assert.ok(lm.textContent.includes(MARK + 'choice'),
          `${dir}/launcher-modal: non-vacuity — and each variant's CHOICE was rendered here, as text`);
        w.closeDetailModal();
      }
      visit(w.document.getElementById('menu-sections'), 'subcategory-headings', 'subcat');
    }
    assert.ok(reached.length >= 5, `${dir}: non-vacuity — every surface was actually visited (${reached.join(', ')})`);
    ok(`${dir}: a hostile catalog is inert on ${reached.length} render paths (${reached.join(', ')})`);
  }

  // ── 40. 🔴 A MERCHANT-SUPPLIED IMAGE IS REJECTED, AND THE TILE FALLS BACK ──
  // The URL policy is only meaningfully tested against a value the MERCHANT supplies. la_musa's photo
  // path is derived from the dish id, so the only URLs it builds are ones the form composed itself —
  // that test passed with the policy reverted to the identity function. The `img` field is the authored
  // one, and this asserts both halves: the hostile URL never reaches the DOM, and a LEGITIMATE one still
  // does, because an over-rejecting policy hides real photos and nothing complains.
  {
    const w = loadForm(dir);
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], img: 'javascript:window.__XSS=1' };
    m.dishes[1] = { ...m.dishes[1], img: 'https://cdn.test/real-photo.png?v=1&w=2' };
    await serve(w, envelope(B.rid, m));

    const hostileCard = w.document.getElementById('card-' + m.dishes[0].id);
    [...hostileCard.querySelectorAll('img')].forEach((i) =>
      assert.ok(!/javascript:/i.test(i.getAttribute('src') || ''), `${dir}: 🔴 a javascript: image never reaches src`));

    if (dir === 'xpizza-orders') {
      assert.ok(hostileCard.querySelector('.pizza-photo-label'),
        `${dir}: 🔴 …and the tile falls back to its placeholder rather than to a broken image`);
      // x_pizza renders the authored img directly, so the ACCEPT half is observable there.
      const goodCard = w.document.getElementById('card-' + m.dishes[1].id);
      const good = [...goodCard.querySelectorAll('img')].map((i) => i.getAttribute('src'));
      assert.deepStrictEqual(good, ['https://cdn.test/real-photo.png?v=1&w=2'],
        `${dir}: 🔴 a legitimate https photo — ampersand and all — still renders (got ${JSON.stringify(good)})`);

      /* 🔴 AND THE ATTRIBUTE ENCODING IS PINNED BY A ROUND-TRIP, not by "one of these two spellings".
         `?v=1&w=2` cannot tell the two apart: `&w` is not an entity, so the parser hands back the same
         string whether or not the & was encoded, and the encoding could be deleted with this check
         still green. A literal `&amp;` in the URL is the case that separates them — encoded it decodes
         back to `&amp;`, unencoded it decodes to `&`, a URL pointing somewhere else. */
      const ampUrl = 'https://cdn.test/a&amp;b.png?x=&lt;y';
      const m2 = B.menu(w);
      m2.dishes[2] = { ...m2.dishes[2], img: ampUrl };
      await serve(w, envelope(B.rid, m2));
      const ampGot = [...w.document.getElementById('card-' + m2.dishes[2].id).querySelectorAll('img')].map((i) => i.getAttribute('src'));
      assert.deepStrictEqual(ampGot, [ampUrl],
        `${dir}: 🔴 an approved CARD url survives the quoted attribute byte-for-byte (got ${JSON.stringify(ampGot)})`);
      // …and the DETAIL MODAL, which is a separate template with its own interpolation. Dropping the
      // encoding there passed every check until this line existed.
      w.openDetailModal(m2.dishes[2].id);
      const ampDetail = [...w.document.getElementById('detail-scroll').querySelectorAll('img')].map((i) => i.getAttribute('src'));
      assert.deepStrictEqual(ampDetail, [ampUrl],
        `${dir}: 🔴 …and so does the DETAIL hero (got ${JSON.stringify(ampDetail)})`);
      w.closeDetailModal();
    } else {
      /* 🔴 la_musa's card NEVER RENDERS THE AUTHORED `img` FIELD — its photo path is composed from the
         dish id and has_photo. So the merchant-controlled input to the URL on this brand is the ID, and
         that is what has to be exercised: an id that would break out of the src attribute must produce
         no img at all, and the tile must fall back. Asserting the `img` field here would have been
         testing a surface this form does not have. */
      const evilId = 'x" onerror="window.__XSS=1';
      const m2 = B.menu(w);
      m2.dishes = m2.dishes.concat([{ ...m2.dishes[0], id: evilId, name: 'Hostil', img: undefined }]);
      m2.has_photo = [evilId];
      await serve(w, envelope(B.rid, m2));
      const evilCard = w.document.getElementById('card-' + evilId);
      assert.ok(evilCard, 'la_musa: non-vacuity — the hostile-id dish rendered a tile');
      assert.deepStrictEqual([...evilCard.querySelectorAll('img')].map((i) => i.getAttribute('src')), [],
        'la_musa: 🔴 an id that cannot form a safe URL produces no img at all');
      assert.ok(evilCard.querySelector('.pizza-photo-label'),
        'la_musa: 🔴 …and the tile falls back to its placeholder');
      const evilAttrs = [...evilCard.querySelectorAll('*')].flatMap((el) => [...el.attributes])
        .filter((a) => /^on/i.test(a.name) && a.value.includes('__XSS'));
      assert.deepStrictEqual(evilAttrs.map((a) => a.name), [], 'la_musa: 🔴 and it created no event attribute');

      /* 🔴 THE MODAL MAKES THE SAME DECISION, and it is a SEPARATE template. The card was fixed and the
         modal was not, and no test could tell: both branch on "does this dish have a photo", and when
         the image branch asks the URL policy while the placeholder branch asks has_photo, a REJECTED
         photo satisfies neither and the hero renders empty. Only reachable when the two disagree, which
         is exactly what a hostile id produces. */
      w.openDetailModal(evilId);
      const evilModal = w.document.getElementById('detail-scroll');
      assert.deepStrictEqual([...evilModal.querySelectorAll('img')].map((i) => i.getAttribute('src')), [],
        'la_musa: 🔴 the detail hero emits no img for an id that cannot form a safe URL');
      assert.ok(evilModal.querySelector('.detail-photo-label'),
        'la_musa: 🔴 …and the detail hero falls back to its placeholder, not to an empty box');
      w.closeDetailModal();

      /* 🔴 AND AN APPROVED URL SURVIVES THE ATTRIBUTE BYTE-FOR-BYTE. Passing the URL policy and being
         safe to drop between quotes are different questions: the policy rejects quotes and angle
         brackets but ALLOWS `&`, and an unencoded `&` is decoded by the HTML parser — `&amp;` in the
         path comes back out as `&`, a URL that silently points somewhere else. Nothing about that is an
         injection, which is why only a round-trip assertion catches it. */
      const ampId = 'a&amp;b';
      const m3 = B.menu(w);
      m3.dishes = m3.dishes.concat([{ ...m3.dishes[0], id: ampId, name: 'Ampersand', img: undefined }]);
      m3.has_photo = [ampId];
      await serve(w, envelope(B.rid, m3));
      /* BOTH TEMPLATES, because they are two different lines and each encodes on its own. Asserting
         only the card left the modal's hero free to drop the encoding: the mutant that does exactly
         that survived a check that read as though it covered the URL context. */
      const ampSrc = [...w.document.getElementById('card-' + ampId).querySelectorAll('img')].map((i) => i.getAttribute('src'));
      assert.deepStrictEqual(ampSrc, ['images/' + ampId + '-card.webp'],
        `la_musa: 🔴 an approved CARD url reaches the DOM unchanged — no entity decoding (got ${JSON.stringify(ampSrc)})`);
      w.openDetailModal(ampId);
      const ampHero = [...w.document.getElementById('detail-scroll').querySelectorAll('img')].map((i) => i.getAttribute('src'));
      assert.deepStrictEqual(ampHero, ['images/' + ampId + '-hero.webp'],
        `la_musa: 🔴 …and so does the HERO url (got ${JSON.stringify(ampHero)})`);
      w.closeDetailModal();

      /* 🔴 AND THE LAUNCHER MODAL, the fifth template and the last one unpinned. It is a DIFFERENT
         hero from the ordinary detail modal's, built in its own template, so it needed its own
         round-trip — dropping the encoding there passed everything else. The launcher id carries the
         ampersand, which means building a real launcher: a dish with that id, a photo for it, and a
         variant block pointing at variant dishes that genuinely resolve. */
      const lId = 'lnch&amp;x';
      const m4 = B.menu(w);
      const liveVI = w.liveMenuGlobalGet('VARIANT_ITEMS');
      const srcKey = Object.keys(liveVI)[0];
      m4.dishes = m4.dishes.concat([{ ...m4.dishes[0], id: lId, name: 'Launcher Amp', img: undefined }]);
      m4.has_photo = [lId];
      m4.variant_items = { [lId]: { ...liveVI[srcKey] } };
      await serve(w, envelope(B.rid, m4));
      assert.ok(w.liveMenuGlobalGet('VARIANT_ITEMS')[lId], 'la_musa: non-vacuity — the ampersand launcher applied');
      w.openDetailModal(lId);
      const lModal = w.document.getElementById('detail-scroll');
      assert.strictEqual(lModal.querySelectorAll('.detail-variant-row').length, liveVI[srcKey].variantIds.length,
        'la_musa: non-vacuity — it really rendered as a LAUNCHER, not as an ordinary dish');
      const lHero = [...lModal.querySelectorAll('img')].map((i) => i.getAttribute('src'));
      assert.deepStrictEqual(lHero, ['images/' + lId + '-hero.webp'],
        `la_musa: 🔴 …and the LAUNCHER hero url survives the attribute byte-for-byte (got ${JSON.stringify(lHero)})`);
      w.closeDetailModal();
    }
    assert.strictEqual(w.__XSS, undefined, `${dir}: nothing executed`);
    ok(`${dir}: a merchant-supplied image URL is policed — hostile rejected, legitimate kept`);
  }

  // ── 41. 🔴 …INCLUDING AN IDENTIFIER THAT USED TO REACH A HANDLER ──
  // The id was concatenated into onclick="chg(<id>,1)". No escape makes that generally safe, so the
  // class was removed: ids live in data- attributes and one delegated listener resolves them by lookup.
  {
    const w = loadForm(dir);
    const m = B.menu(w);
    const hostileId = dir === 'xpizza-orders' ? '9\" onmouseover=\"window.__XSS=1' : 'x\" onmouseover=\"window.__XSS=1';
    m.dishes = m.dishes.concat([{ ...m.dishes[0], id: hostileId, name: 'Hostil' }]);
    await serve(w, envelope(B.rid, m));
    assert.ok(w.liveMenuGlobalGet('MENU').some((d) => d.id === hostileId),
      `${dir}: non-vacuity — the hostile id was accepted into MENU`);

    /* 🔴 ASSERTED ON THE DOM, NOT ON THE SERIALIZED STRING. innerHTML round-trips the ESCAPED value, so
       `data-id="9&quot; onmouseover=…"` contains the literal text `onmouseover=` while being nothing but
       an attribute value — a string search reports an injection that does not exist. What matters is
       whether an element actually HAS such an attribute, so that is what is checked. */
    const all = containersOf(w).flatMap((id) => {
      const el = w.document.getElementById(id);
      return el ? [...el.querySelectorAll('*')] : [];
    });
    assert.ok(all.length > 5, `${dir}: non-vacuity — there are elements to inspect`);
    const eventAttrs = all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)));
    const describe = (a) => `${a.ownerElement.tagName}.${a.ownerElement.className}[${a.name}="${a.value.slice(0, 60)}"]`;
    const injected = eventAttrs.filter((a) => a.value.includes('__XSS') || a.value.includes(hostileId));
    assert.strictEqual(injected.length, 0,
      `${dir}: 🔴 no element may carry an event attribute built from authored data — found: ${injected.map(describe).join(' | ')}`);
    assert.strictEqual(w.__XSS, undefined, `${dir}: nothing executed`);
    ok(`${dir}: an authored identifier cannot reach an event handler`);
  }

  // ── 41. THE DELEGATED LISTENER STILL DOES THE JOB — clicked, not called ──
  // Removing the inline handlers is only safe if the controls still work, and the tests everywhere else
  // call chg()/openDetailModal() directly, so they would not notice. These click.
  {
    const w = loadForm(dir);
    const dish = w.liveMenuGlobalGet('MENU').find((d) => !w.document.getElementById('qty-add-' + d.id) === false);
    const addBtn = w.document.getElementById('qty-add-' + dish.id);
    assert.ok(addBtn, `${dir}: the add control exists`);
    addBtn.click();
    assert.strictEqual(w.cartItemCount(), 1, `${dir}: 🔴 clicking + adds through the delegate`);
    addBtn.click();
    assert.strictEqual(w.cartItemCount(), 2, `${dir}: …and again`);
    const minus = w.document.getElementById('minus-' + dish.id);
    if (minus) { minus.click(); assert.strictEqual(w.cartItemCount(), 1, `${dir}: and − removes`); }

    // The card opens the modal…
    const w2 = loadForm(dir);
    /* 🔴 NOT THE FIRST DISH. A delegate that ignored its data-id and always resolved MENU[0] would pass
       a first-dish test perfectly — the assertion would be true for the wrong reason. Picking one
       further down is what makes "it resolved the id" mean anything. */
    const menu2 = w2.liveMenuGlobalGet('MENU');
    const d2 = menu2.find((d, i) => i > 0 && w2.document.getElementById('card-' + d.id)) || menu2[2];
    assert.notStrictEqual(String(d2.id), String(menu2[0].id), `${dir}: non-vacuity — a NON-first dish was chosen`);
    const card2 = w2.document.getElementById('card-' + d2.id);
    const target = dir === 'xpizza-orders' ? card2 : card2.querySelector('.pizza-photo[data-act="open"]') || card2;
    target.click();
    assert.ok(w2.document.getElementById('detail-modal').className.includes('open'),
      `${dir}: clicking the tile opens the detail modal`);
    /* …ON THE RIGHT DISH. "It opened" is too weak: openDetailModal adds the open class BEFORE it
       resolves the id, so a delegate that passed the raw attribute string (x_pizza's ids are numbers,
       and '2' === 2 is false) still opened an EMPTY modal and passed. The title is what proves the id
       was resolved back to a real dish. */
    assert.strictEqual(w2.document.getElementById('detail-header-title').textContent, d2.name,
      `${dir}: 🔴 …and on the dish that was clicked — the id was resolved, not passed through raw`);

    // …but a click on the quantity overlay's own space does not, exactly as stopPropagation did.
    const w3 = loadForm(dir);
    const d3 = w3.liveMenuGlobalGet('MENU')[0];
    const overlay = w3.document.getElementById('card-' + d3.id).querySelector('.qty-overlay');
    assert.ok(overlay, `${dir}: the overlay exists`);
    overlay.click();
    assert.ok(!w3.document.getElementById('detail-modal').className.includes('open'),
      `${dir}: 🔴 a click on the overlay itself still does NOT open the modal (stopPropagation preserved)`);
    ok(`${dir}: the delegated listener drives add, remove, open — and preserves stopPropagation`);
  }

  // ── 42. 🔴 THE SAVED MODE IS LOAD-BEARING — THE STALE TENDER/FLAG PAIR ──
  //
  // Found by the gate, and it is the case that justifies assigning the mode rather than re-deriving it.
  // A quote lands while the customer sits in exact mode: the success handler updates key/cents and
  // refreshes ONLY the summary — it does not run updateTotal — so the tender keeps the OLD total while
  // the quote now says a different one. The pair on screen is (old tender, exact=true), which is stale
  // but is what the customer has. A failed apply captures that pair; re-deriving would compute
  // |old tender - new total| > 0.005 → custom, silently converting them to a mode they never chose and
  // stopping their tender from tracking the total. The saved value restores what was actually there.
  {
    const w = loadForm(dir);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.selectPay('cash');
    const panel = w.document.getElementById('cash-change-panel');
    if (panel) panel.style.display = 'block';
    const box = () => w.document.getElementById('cash-tendered');

    const localTotal = w.calcTotal();
    w.__serverQuote.key = w.serverQuoteCartKey();
    w.__serverQuote.cents = Math.round(localTotal * 100);
    w.__serverQuote.inflight = null; w.__serverQuote.inflightKey = null;
    w.setCashTendered(w.redeemAdjustedTotal());          // exact, on the quote that is current NOW
    const tenderBefore = box().value;

    // A newer quote lands with a DIFFERENT total. Only the summary refreshes, so the tender stays put
    // and the exact flag stays true — the stale pair.
    w.__serverQuote.cents = Math.round((localTotal - 30) * 100);
    const staleTotal = w.redeemAdjustedTotal();
    assert.notStrictEqual(Number(tenderBefore), staleTotal,
      `${dir}: non-vacuity — the tender and the current total genuinely disagree now`);

    const realTender = w.onCashTenderedInput;
    w.onCashTenderedInput = function () {
      const out = realTender.apply(this, arguments);
      if (w.liveMenuGlobalGet('MENU')[0].name === 'Should Not Survive') throw new Error('tender hint exploded');
      return out;
    };
    const m = B.menu(w);
    m.dishes[0] = { ...m.dishes[0], name: 'Should Not Survive' };
    await serve(w, envelope(B.rid, m));
    w.onCashTenderedInput = realTender;

    assert.strictEqual(w.__liveMenu.applier.state().lastError.message, 'tender hint exploded',
      `${dir}: non-vacuity — the apply failed`);
    assert.strictEqual(box().value, tenderBefore, `${dir}: the tender is unchanged`);
    // 🔴 Still EXACT: move the total and the tender must follow. Re-derived, the mode would have become
    // custom and the tender would sit still.
    w.__serverQuote.cents = Math.round((localTotal - 45) * 100);
    w.updateTotal();
    assert.strictEqual(Number(box().value), (localTotal - 45),
      `${dir}: 🔴 the mode the customer had (exact) is restored, not re-derived from the stale pair`);
    ok(`${dir}: a stale tender/flag pair is restored as it was — the saved mode is load-bearing`);
  }

  // ── 27. …WHILE A SUCCESSFUL APPLY STILL DROPS THE STALE QUOTE ──
  // The other half: invalidation moved to the commit, so it must still happen when the menu really
  // changes — a quoted total that outlived the prices it was quoted for is the display-side version of
  // the silent adoption the cart refuses.
  {
    const w = loadForm(dir);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);
    w.__serverQuote.key = w.serverQuoteCartKey();
    w.__serverQuote.cents = 123400;
    await serve(w, envelope(B.rid, B.menu(w)));
    assert.strictEqual(w.__liveMenu.applier.state().lastError, null, `${dir}: non-vacuity — this apply succeeded`);
    assert.strictEqual(w.__serverQuote.cents, null, `${dir}: 🔴 the stale quote is dropped on success`);
    ok(`${dir}: a successful apply still invalidates the cached quote`);
  }

  // ── 23. A RENDERER THAT CANNOT DRAW AT ALL IS REPORTED, NOT PAPERED OVER ──
  // If the redraw itself throws — the renderer is broken for the OLD menu too — there is nothing left
  // to fall back to. The applier says so rather than reporting success over an unknown screen.
  {
    const w = loadForm(dir);
    const realRender = w.renderMenu;
    w.renderMenu = () => { throw new Error('renderer is broken'); };
    await serve(w, envelope(B.rid, B.menu(w)));
    w.renderMenu = realRender;
    const st = w.__liveMenu.applier.state();
    assert.ok(st.fatal, `${dir}: 🔴 an unrecoverable render is reported as fatal, not as a refusal`);
    assert.match(st.fatal.message, /renderer is broken/, `${dir}: with the reason`);

    /* 🔴 1B Task 9 — AND A PAGE IN THAT STATE DOES NOT ASK FOR MONEY. Reporting 'broken' was the whole
       of the old behaviour: it was recorded, and the form would still take the order. The amount was
       never the exposure (the server re-prices) — what the customer could do is confirm an order
       against a menu the page can no longer vouch for. Driven through the REAL send path, not by
       calling the gate, so what is proved is that no charge leaves: submitOrder() reaches its fetch
       only past refuseConflictedSend, and the same gate guards chargeOnlineOrder. */
    /* Copied into THIS realm with a spread: w.__calls is a jsdom Array, and deepStrictEqual compares
       prototypes, so a cross-realm empty array is not deepStrictEqual to [] — it reports `actual: []`
       against `expected: []` and throws anyway. Cost an hour once already in this project. */
    const chargeUrls = (c) => [...c].filter((u) => /createOrder|chargeOnlineOrder/.test(u));
    assert.deepStrictEqual(chargeUrls(w.__calls), [],
      `${dir}: premise — nothing had charged before this point`);
    w.chg(w.liveMenuGlobalGet('MENU')[0].id, 1);           // the REAL quantity writer, not poked state
    assert.ok(w.cartLines().length > 0, `${dir}: non-vacuity — the cart really holds a line to send`);
    assert.strictEqual([...w.cartConflicts()].length, 0,
      `${dir}: non-vacuity — and that line is NOT conflicted, so only the broken state can refuse it`);
    assert.strictEqual(w.refuseConflictedSend('t9'), true,
      `${dir}: 🔴 the send gate refuses while the applier reports fatal`);
    try { await w.submitOrder('cash'); } catch (_) { /* the form may bail in its own way; the fetch is the assertion */ }
    assert.deepStrictEqual(chargeUrls(w.__calls), [],
      `${dir}: 🔴 …and the real submit path reached NO charge endpoint (${JSON.stringify(chargeUrls(w.__calls))})`);
    const err = w.document.getElementById('err3') || w.document.getElementById('err1');
    assert.match((err && err.textContent) || '', /[Rr]ecarg/,
      `${dir}: 🔴 …and the customer is told to reload rather than left guessing`);
    ok(`${dir}: a renderer that cannot draw the old menu either is reported fatal — and blocks the charge`);
  }

  // ── 22. A CATEGORY THE UPGRADE REMOVES LEAVES THE SCREEN ──
  // renderMenu only fills the categories in the CURRENT set, so a dropped one used to keep its old
  // cards: an apply reporting success while showing dishes the catalog no longer sells.
  if (dir === 'la-musa-orders') {
    const w = loadForm(dir);
    const cats = w.liveMenuGlobalGet('CATEGORIES');
    const doomed = cats[0];
    const stillThere = w.liveMenuGlobalGet('MENU').filter((d) => d.cat === doomed.id)[0];
    assert.ok(stillThere && painted(w).includes(stillThere.name), `${dir}: non-vacuity — its dishes are on screen now`);
    const m = B.menu(w);
    m.categories = m.categories.filter((c) => c.id !== doomed.id);
    m.dishes = m.dishes.filter((d) => d.cat !== doomed.id);
    await serve(w, envelope(B.rid, m));
    assert.ok(!painted(w).includes(stillThere.name),
      `${dir}: 🔴 the removed category's cards are gone — not new-plus-stale`);
    assert.ok(!w.document.getElementById('menu-' + doomed.id), `${dir}: and its section is gone entirely`);
    ok(`${dir}: a category the upgrade removes leaves the screen with its dishes`);
  }

  // ── 23. A SNAPSHOT FOR THE OTHER BRAND IS NOT A DEGRADED MENU ──
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

  /* ── 🔴 THE ORDER ID IS THE PAYMENT IDEMPOTENCY ANCHOR, SO IT MUST NOT COLLIDE ────────────────
     Asserted for BOTH brands from one loop, because the defect was an ASYMMETRY: x_pizza carried a
     CSPRNG suffix and la_musa did not, so two la_musa orders in the same second produced the same id
     and the second was absorbed into the first as a retry — a lost sale, not a double charge. Both
     forms also emit the same 'PZX-' prefix into a shared id space, so the collision was never confined
     to one restaurant. A per-brand test would have passed on x_pizza and never been written for the
     brand that needed it. */
  {
    const w = loadForm(dir);
    await serve(w, envelope(B.rid, B.menu(w)));
    const ids = new Set();
    for (let i = 0; i < 400; i++) ids.add(w.genOrderId());
    assert.strictEqual(ids.size, 400,
      `${dir}: 🔴 400 order ids generated in the same second are all distinct (got ${ids.size})`);
    const one = [...ids][0];
    assert.match(one, /^[A-Za-z0-9_-]{1,64}$/,
      `${dir}: 🔴 …and the id still satisfies the server's order_id allowlist (${one})`);
    assert.match(one, /-[0-9A-HJKMNP-TV-Z]{8}$/,
      `${dir}: 🔴 …via an 8-character high-entropy suffix, not a longer timestamp (${one})`);
    // NON-VACUITY: the timestamp prefix really is shared across the batch, so the distinctness above is
    // the SUFFIX doing the work and not the clock ticking during the loop.
    const prefixes = new Set([...ids].map((x) => x.slice(0, x.lastIndexOf('-'))));
    assert.ok(prefixes.size <= 2,
      `${dir}: non-vacuity — the batch shares its timestamp, so entropy is what separates the ids (${prefixes.size} prefixes)`);
    ok(`${dir}: the order id carries CSPRNG entropy — same-second orders cannot collide on the idempotency anchor`);
  }

  // ── 🔴 AN EMPTY ID IS NOT AN ID, AND THE DISH VALIDATOR IS WHERE THAT IS DECIDED ─────────────
  // Independent of any variant block, because that is where the guarantee has to live: '' keys prices,
  // 86s and cart lines, renders as id="card-", and resolves against itself. Both brands.
  {
    const w = loadForm(dir);
    await serve(w, envelope(B.rid, B.menu(w)));
    const before = painted(w);
    const menuBefore = w.liveMenuGlobalGet('MENU');
    const m = B.menu(w);
    m.dishes = m.dishes.concat([{ ...m.dishes[0], id: '', name: 'Sin Id' }]);
    await serve(w, envelope(B.rid, m));
    assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore,
      `${dir}: 🔴 a dish with an EMPTY id is refused whole — MENU is the identical prior array`);
    assert.strictEqual(painted(w), before, `${dir}: 🔴 …and nothing rendered`);
    // The same rule for an OPTION, which shares the record validator and the same consequences.
    const m2 = B.menu(w);
    m2.extras = m2.extras.concat([{ ...m2.extras[0], id: '', name: 'Sin Id' }]);
    await serve(w, envelope(B.rid, m2));
    assert.strictEqual(painted(w), before, `${dir}: 🔴 an OPTION with an empty id is refused whole too`);
    ok(`${dir}: a record with an empty id is refused whole — dishes and options alike`);
  }

  // ── 🔴 A LAUNCHER'S variant_items IS VALIDATED, NOT ASSUMED ──────────────────────────────────
  // la_musa only — x_pizza has no variant launchers. The block was accepted as "an object" and never
  // looked inside, so an authored basePrice could be a string, a NaN, or absent and it would be priced
  // with and printed as whatever arrived. Each shape below is refused WHOLE: the launcher is what the
  // customer taps to see prices, so a half-applied one is a menu that quotes from a value nobody set.
  if (dir === 'la-musa-orders') {
    const w = loadForm(dir);
    await serve(w, envelope(B.rid, B.menu(w)));
    /* The shared fixture does not carry variant_items — worth stating plainly, because it means every
       other check in this file serves a snapshot WITHOUT one, and the launcher surfaces they walk are
       the page's own literal rather than anything served. This check is the only place a launcher block
       arrives over the wire, so it builds one from the live global and corrupts that. */
    const liveVI = w.liveMenuGlobalGet('VARIANT_ITEMS');
    const launcherKey = Object.keys(liveVI)[0];
    assert.ok(launcherKey, 'non-vacuity: the form really does carry a launcher to corrupt');
    const cfg = { ...liveVI[launcherKey] };

    const corrupt = {
      'a basePrice that is a string': { ...cfg, basePrice: '307' },
      'a basePrice that is NaN': { ...cfg, basePrice: NaN },
      'a basePrice of zero': { ...cfg, basePrice: 0 },
      'a missing basePrice': (() => { const c = { ...cfg }; delete c.basePrice; return c; })(),
      'an empty variantIds': { ...cfg, variantIds: [] },
      'a variantId naming no dish': { ...cfg, variantIds: [...cfg.variantIds, 'no_such_dish'] },
      /* 🔴 THE TYPE-MISMATCH COUNTEREXAMPLE. This is the shape that used to PASS validation and then
         render nothing: the validator asked String(vid) while the renderer asks p.id === vid, so a
         numeric id matched one and not the other, and the customer got a required choice group with no
         choices in it. Both sides now ask sameDishId. */
      'a variantId of the wrong TYPE (validates loosely, renders nothing)': { ...cfg, variantIds: cfg.variantIds.map((v) => Number(v.replace(/\D/g, '')) || 1) },
      'a variantId that is null': { ...cfg, variantIds: [...cfg.variantIds, null] },
      'a variantId that is an empty string': { ...cfg, variantIds: [...cfg.variantIds, ''] },
    };
    /* 🔴 THE EMPTY-ID SHAPE, which is the ONE the vid type/empty check refuses alone. Every other
       corrupt shape is caught by whichever guard sees it first, so none of them could tell that check
       apart from sameDishId — and I wrongly wrote it off as equivalent on that basis. It is not:
       sameDishId('', '') is TRUE, so a dish carrying an empty id and a launcher pointing at it satisfy
       the resolution check and are refused only because an empty string is not a usable id. Absence of
       a distinguishing case is not proof that none exists, which is exactly the failure class this
       project keeps banking. */
    {
      const before = painted(w);
      const menuBefore = w.liveMenuGlobalGet('MENU');
      const m = B.menu(w);
      m.dishes = m.dishes.concat([{ ...m.dishes[0], id: '', name: 'Sin Id' }]);
      m.variant_items = { '': { ...cfg, variantIds: [''] } };
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore,
        `${dir}: 🔴 an EMPTY dish id, which resolves against itself, is refused — MENU is the identical prior array`);
      assert.strictEqual(painted(w), before, `${dir}: 🔴 …and nothing rendered`);
    }
    for (const [label, bad] of Object.entries(corrupt)) {
      const before = painted(w);
      const menuBefore = w.liveMenuGlobalGet('MENU');
      const m = B.menu(w);
      m.variant_items = { [launcherKey]: bad };
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `${dir}: 🔴 ${label} is refused — MENU is the identical prior array`);
      assert.strictEqual(painted(w), before, `${dir}: 🔴 ${label} is refused — nothing rendered`);
    }
    /* 🔴 THE DISCRIMINATING CASE: A DISH WHOSE ID IS NOT A STRING. Every corrupt shape above is refused
       by whichever guard happens to see it first, so they could not tell the guards apart — all three
       mutants survived a table that looked thorough. What separates them is a dish id that COERCES
       equal without BEING equal: 'x' vs the number that stringifies to it. Under a coercing validator
       the snapshot is accepted and the renderer, which compares strictly, then draws a launcher with no
       choices — the exact reachable state the gate reported. */
    for (const [label, build] of Object.entries({
      'a variantId that only matches after coercion': (m, numericId) => {
        m.dishes = m.dishes.concat([{ ...m.dishes[0], id: numericId, name: 'Numerico' }]);
        m.variant_items = { [launcherKey]: { ...cfg, variantIds: [String(numericId)] } };
      },
      'a launcher KEY that only matches its dish after coercion': (m, numericId) => {
        m.dishes = m.dishes.concat([{ ...m.dishes[0], id: numericId, name: 'Numerico' }]);
        m.variant_items = { [String(numericId)]: { ...cfg } };
      },
    })) {
      const before = painted(w);
      const menuBefore = w.liveMenuGlobalGet('MENU');
      const m = B.menu(w);
      build(m, 7);
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore, `${dir}: 🔴 ${label} is refused — MENU is the identical prior array`);
      assert.strictEqual(painted(w), before, `${dir}: 🔴 ${label} is refused — nothing rendered`);
    }

    // A launcher key naming no dish at all — the same rule from the other direction.
    {
      const before = painted(w);
      const m = B.menu(w);
      m.variant_items = { no_such_launcher: cfg };
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(painted(w), before, `${dir}: 🔴 a launcher key naming no dish is refused`);
    }
    // NON-VACUITY: the untouched block still applies, so the refusals above are the corruption talking
    // and not a snapshot this form rejects for some unrelated reason.
    /* 🔴 NON-VACUITY THAT PROVES THE SUPPLIED BLOCK LANDED. Asserting VARIANT_ITEMS[launcherKey] merely
       exists proved nothing: the page ships that key as a literal, so the check passed whether the
       served block applied or was dropped on the floor. The supplied block therefore carries a value
       the literal does not have, and that value is what is read back — and read back off the SCREEN as
       well, because a global nobody renders is not evidence the customer saw a working launcher. */
    {
      const m = B.menu(w);
      const distinct = cfg.basePrice + 7;
      m.variant_items = { [launcherKey]: { ...cfg, basePrice: distinct } };
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(w.liveMenuGlobalGet('VARIANT_ITEMS')[launcherKey].basePrice, distinct,
        `${dir}: non-vacuity — the SUPPLIED block applied, not the page's own literal`);
      w.openDetailModal(launcherKey);
      const modal = w.document.getElementById('detail-scroll');
      assert.ok(modal.textContent.includes('desde L ' + distinct),
        `${dir}: non-vacuity — and the applied basePrice is what the launcher shows`);
      const rows = modal.querySelectorAll('.detail-variant-row');
      assert.strictEqual(rows.length, cfg.variantIds.length,
        `${dir}: 🔴 the launcher renders one row per variant — never a required group with no choices (got ${rows.length})`);
      w.closeDetailModal();
    }
    /* 🔴 THE RETAINED BLOCK, VALIDATED AGAINST THE DISHES THAT ARE ARRIVING. A snapshot that OMITS
       variant_items keeps the one in force — and nothing re-checked it against the new dish list, so
       dropping the variant dishes in an ordinary menu update left a launcher referencing dishes that no
       longer exist. The card still priced it, the modal still opened, and the required choice group was
       empty: an unorderable dish, with no error anywhere. Every other check in this file serves a
       snapshot with variant_items ABSENT, which is exactly why none of them noticed. */
    {
      const before = painted(w);
      const menuBefore = w.liveMenuGlobalGet('MENU');
      const m = B.menu(w);
      assert.strictEqual(m.variant_items, undefined, 'premise: the shared fixture omits variant_items');
      const retained = w.liveMenuGlobalGet('VARIANT_ITEMS')[launcherKey];
      const dropped = new Set(retained.variantIds);
      m.dishes = m.dishes.filter((d) => !dropped.has(d.id));
      assert.ok(m.dishes.length < menuBefore.length, 'non-vacuity: the update really does drop the variant dishes');
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(w.liveMenuGlobalGet('MENU'), menuBefore,
        `${dir}: 🔴 a snapshot that strands the RETAINED launcher is refused whole — MENU is the identical prior array`);
      assert.strictEqual(painted(w), before, `${dir}: 🔴 …and nothing rendered`);
    }
    // …and dropping the LAUNCHER dish itself, the same rule from the other side.
    {
      const before = painted(w);
      const m = B.menu(w);
      m.dishes = m.dishes.filter((d) => d.id !== launcherKey);
      await serve(w, envelope(B.rid, m));
      assert.strictEqual(painted(w), before, `${dir}: 🔴 a snapshot that strands the retained launcher KEY is refused whole`);
    }
    ok(`${dir}: a launcher's variant_items is validated — 12 corrupt shapes refused whole, including the two that only differ under coercion, the intact one applied`);
  }

  /* ── 🔴 THE RENDERER IS STRICT, AND DEGRADES CLEANLY RATHER THAN CRASHING ──────────────────────
     Validation now guarantees every variantId resolves, which makes the renderer's own comparison and
     its miss-guard unreachable from the feed — and therefore unpinned: loosening `sameDishId` in the
     renderer, or deleting the `if (!v) return`, changed nothing any test could see. Unreachable is not
     the same as unimportant: these two lines are the floor under a validator that someone will
     eventually relax, and a floor nobody tests is a floor nobody notices giving way.
     So MENU is corrupted DIRECTLY — the one way to put the renderer in the state its guards exist for —
     and both properties are asserted at once: the strict comparison does not match a type-mismatched
     id, and an unresolvable id is skipped rather than dereferenced. */
  if (dir === 'la-musa-orders') {
    const w = loadForm(dir);
    const m = B.menu(w);
    const launcherKey = Object.keys(w.liveMenuGlobalGet('VARIANT_ITEMS'))[0];
    const cfg = { ...w.liveMenuGlobalGet('VARIANT_ITEMS')[launcherKey] };
    m.variant_items = { [launcherKey]: cfg };
    await serve(w, envelope(B.rid, m));

    w.openDetailModal(launcherKey);
    const healthy = w.document.getElementById('detail-scroll').querySelectorAll('.detail-variant-row').length;
    assert.strictEqual(healthy, cfg.variantIds.length,
      `${dir}: non-vacuity — a healthy launcher renders one row per variant (got ${healthy})`);
    w.closeDetailModal();

    // Retype ONE variant dish's id in the live MENU: '…_sin' becomes a Number-typed id that no longer
    // matches strictly. Nothing in the feed can produce this — that is the point of doing it by hand.
    const live = w.liveMenuGlobalGet('MENU');
    const victim = live.find((d) => d.id === cfg.variantIds[0]);
    assert.ok(victim, 'non-vacuity: the variant dish to retype was found in the live MENU');
    victim.id = { toString: () => cfg.variantIds[0] };   // stringifies to the id, is not the id

    let threw = null;
    try { w.openDetailModal(launcherKey); } catch (e) { threw = e; }
    assert.strictEqual(threw, null,
      `${dir}: 🔴 an unresolvable variant is SKIPPED, never dereferenced — the modal must not throw (${threw && threw.message})`);
    const degraded = w.document.getElementById('detail-scroll').querySelectorAll('.detail-variant-row').length;
    assert.strictEqual(degraded, cfg.variantIds.length - 1,
      `${dir}: 🔴 the renderer's comparison is STRICT — an id that only coerces equal resolves to nothing (got ${degraded} rows, expected ${cfg.variantIds.length - 1})`);
    w.closeDetailModal();
    ok(`${dir}: the variant renderer is strict and skips what it cannot resolve — it never dereferences a miss`);
  }
}

OPEN.forEach((d) => { try { d.window.close(); } catch (_) {} });
console.log(`\n${n} checks passed across both forms.`);
