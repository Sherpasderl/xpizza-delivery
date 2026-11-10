// S3 (D4c-grill/item-s1/S3-DESIGN.md D3 + the advisor's rulings 2026-11-10; OWNER-APPROVED MOCKUP-item-s3-refusals.html frames
// C1/C2/D1/D2 (X. Pizza) and E1/E2/F1/F2 (La Musa)) — THE ORDER FORMS' ITEM REFUSALS, and a live rename in an open cart.
// Run: node item-s3-forms-ui.test.mjs
// Both forms, the REAL booted page, served the REAL published body (item-s3-fixtures.mjs), the refusals answered with the REAL
// writers' bodies (resolve-lines.js resolutionRefusal; extras-intake.js refusalStatus/refusalBody):
//   R  RENAME in an OPEN cart (x_pizza; the cart's identity is the item key when the map is served — ruling 2026-11-10): the line
//      stays orderable and sends {name: new label, item_key: kept key}; with no map it blocks as today ('renamed'); a rename that
//      also changes the price still blocks ('repriced')
//   C1 menu_changed on the cash AND the card send → Paso 2, the gate «El menú se actualizó, recargá la página» + ONE «Recargar la
//      página»
//   C2 «Recargar la página» (ruling C1 (A)): the live menu refreshed IN PLACE through the form's own feed; ONLY lines whose dish is
//      gone are dropped, with the existing toast «1 producto ya no está disponible»; the total re-quoted; the button cannot
//      double-fire; a failed fetch keeps the gate with its button enabled
//   D1 extra_not_allowed → Paso 2, the gate (the server's detail, verbatim), one naming line per denied extra («extra» /
//      La Musa «acompañamiento»), [Quitar extra y seguir][Revisar pedido]
//   D2 «Quitar extra y seguir» removes ONLY the denied extra; the Plan 5 notice «Quitamos X de Y. Total nuevo: L N.» with the total
//      on screen; nothing is re-sent. «Revisar pedido» opens the existing cart review.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { counter, settle, stageSettle, loadForm, res, serve, closeAll } from './form-harness.mjs';
import { published } from './item-s3-fixtures.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { resolveLines, resolutionRefusal } = require('./catalog/resolve-lines');
const EI = require('./catalog/extras-intake');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('item-s3-forms-ui: FAILED — watchdog'); process.exit(1); }, 300000);
const plain = (x) => JSON.parse(JSON.stringify(x));
const quiet = async (fn) => { const l = console.log, wn = console.warn, er = console.error; console.log = console.warn = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.warn = wn; console.error = er; } };
const DIR = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
// per brand: dish A carries the extra the gate names; dish B is the one a later menu drops
const CASE = {
  x_pizza: { A: 'Carnivora', B: 'Margherita', extra: (w, a) => w.toggleDetailExtra('e4', a.id, 0), extraId: 'e4', word: 'extra' },
  la_musa: { A: 'Pork Belly Buns', B: 'Sichuan Spicy Wonton', extra: (w, a) => w.chgDetailExtra('rice_white', a.id, 1), extraId: 'rice_white', word: 'acompañamiento' },
};

// the endpoints: the menu from `menu()` (a function, so a cell can swap it or fail it), the quote over the version's tables
// (the stage first), the sends answered from `sends` (one scripted answer per send, then the server's success)
function wire(w, rid, ctl) {
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) { ctl.menuCalls++; const m = ctl.menu(); return m === 'fail' ? Promise.reject(new Error('offline')) : m === 'hang' ? new Promise(() => {}) : res(plain(m)); }
    const body = JSON.parse((init && init.body) || '{}');
    if (url.includes('quoteOrder')) {
      ctl.quotes.push(body);
      if (ctl.quoteAnswer) { const a = ctl.quoteAnswer(body); if (a) return Promise.resolve({ ok: a.status < 300, status: a.status, headers: { get: () => null }, json: () => Promise.resolve(plain(a.body)) }); }
      const b = plain(body); const r = resolveLines(rid, b, ctl.P.tables);
      const t = r.ok ? computeServerTotal(b.items, rid, ctl.P.tables) : null;
      const answer = () => res(!r.ok ? { ok: false, error: r.code } : t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) });
      if (ctl.holdQuotes) return new Promise((go) => { ctl.held.push(() => go(answer())); });   // P1-2: a quote still on its way
      return answer();
    }
    if (url.includes('quoteRedemption')) return new Promise(() => {});
    if (/createOrder|chargeOnlineOrder/.test(url)) {
      ctl.sent.push({ url, body });
      const a = ctl.sends.shift();
      if (a) return Promise.resolve({ ok: false, status: a.status, headers: { get: () => null }, json: () => Promise.resolve(plain(a.body)) });
      return res(url.includes('chargeOnlineOrder') ? { ok: true, checkout_url: 'https://pay.test/c', order_id: body.order_id, poll_token: 'pt' } : { ok: true });
    }
    return new Promise(() => {});
  };
}
async function boot(rid, P, sends = []) {
  const w = loadForm(DIR[rid]); await settle();
  w.HTMLElement.prototype.scrollIntoView = function () {};   // jsdom has no layout: processPayment's own validation scrolls
  const ctl = { P, menu: () => P.env, menuCalls: 0, quotes: [], sent: [], sends, held: [], holdQuotes: false, quoteAnswer: null };
  await quiet(() => serve(w, plain(P.env)));
  wire(w, rid, ctl);
  return { w, ctl };
}
const dish = (w, name) => w.liveMenuGlobalGet('MENU').find((d) => d.name === name);
const add = async (w, id) => { w.chg(/^\d+$/.test(String(id)) ? Number(id) : id, 1); await settle(); };
async function send(w, path) {
  w.selectPay(path === 'cash' ? 'cash' : 'online');
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `premise — the cart composes an order (${path})`);
  if (path === 'cash') { try { await quiet(() => w.submitOrder('confirmed')); } catch (_) {} }
  else { const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
  await settle(); await settle(); await stageSettle();   // showStage('s2', 50) lands on a timer
}
const gate = (w) => w.document.getElementById('item-gate');
const shown = (el) => !!el && el.style.display !== 'none' && !el.hidden;
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const stage = (w) => w.eval('activeStageId()');

const BASE = {}, LESS = {};
for (const rid of ['x_pizza', 'la_musa']) {
  BASE[rid] = await quiet(() => published(rid));
  const env = plain(BASE[rid].env); const b = env.menu.dishes.find((d) => d.name === CASE[rid].B);
  env.menu.dishes = env.menu.dishes.filter((d) => d !== b); delete env.menu.item_keys[String(b.id)];
  env.menu.dishes.find((d) => d.name === CASE[rid].A).price += 5;   // …and dish A repriced: a conflict that must NOT be dropped
  LESS[rid] = env;   // the later menu: dish B is gone
}

// ── R. a live RENAME in an open x_pizza cart ──
{
  const REN = await quiet(() => published('x_pizza', { rename: { key: 'Carnivora', to: 'Carnívora Suprema' } }));
  {
    const { w, ctl } = await boot('x_pizza', BASE.x_pizza);
    await add(w, dish(w, 'Carnivora').id);
    ctl.P = REN; ctl.menu = () => REN.env; await quiet(() => serve(w, plain(REN.env))); wire(w, 'x_pizza', ctl);   // serve() installs its own responder
    const l = plain(w.eval('resolvedCartLines()'))[0];
    assert.ok(!l.unresolved, `🔴 a live rename keeps the open line orderable (S3-FORM-REN-OPEN): ${l.unresolved}`);
    await send(w, 'card');
    const line = ctl.sent.at(-1).body.items[0];
    assert.deepStrictEqual([line.name, line.item_key], ['Carnívora Suprema', 'Carnivora'], '🔴 it sends {new label, kept key} (S3-FORM-REN-SEND)');
    assert.deepStrictEqual(resolveLines('x_pizza', plain({ items: [line] }), REN.tables), { ok: true }, 'the server resolves it');
  }
  {
    const bareOf = (P) => { const e = plain(P.env); delete e.menu.item_keys; return e; };
    const w = loadForm('xpizza-orders'); await settle();
    await quiet(() => serve(w, bareOf(BASE.x_pizza)));
    await add(w, dish(w, 'Carnivora').id);
    await quiet(() => serve(w, bareOf(REN)));
    assert.strictEqual(plain(w.eval('resolvedCartLines()'))[0].unresolved, 'renamed', '🔴 no map → today\'s rule: a rename still blocks (S3-FORM-REN-NOMAP)');
  }
  {
    const { w } = await boot('x_pizza', BASE.x_pizza);
    await add(w, dish(w, 'Carnivora').id);
    const env = plain(REN.env); env.menu.dishes.find((d) => d.name === 'Carnívora Suprema').price += 10;
    await quiet(() => serve(w, env));
    assert.strictEqual(plain(w.eval('resolvedCartLines()'))[0].unresolved, 'repriced', '🔴 a rename with a price change still blocks on the price (S3-FORM-REN-PRICE)');
  }
  ok('xpizza-orders: R — an open line survives a live rename and sends {new label, kept key}; no map blocks as today; a price change still blocks');
}

for (const rid of ['x_pizza', 'la_musa']) {
  const dir = DIR[rid], P = BASE[rid], c = CASE[rid];
  const MC = resolutionRefusal({ code: 'menu_changed' });
  // ── C1 on both send paths ──
  for (const path of ['cash', 'card']) {
    const { w } = await boot(rid, P, [{ status: MC.status, body: MC.body }]);
    await add(w, dish(w, c.A).id); await add(w, dish(w, c.B).id);
    await send(w, path);
    assert.strictEqual(stage(w), 's2', `🔴 ${dir} ${path}: a menu_changed refusal returns to Paso 2 (S3-FORM-C1-STAGE)`);
    assert.ok(shown(gate(w)), `🔴 ${dir} ${path}: the item gate is shown (S3-FORM-C1-GATE)`);
    assert.strictEqual(txt(gate(w).querySelector('.pickup-gate-title')), 'El menú se actualizó, recargá la página', `🔴 ${dir} ${path}: the approved title (S3-FORM-C1-TITLE)`);
    assert.deepStrictEqual([...gate(w).querySelectorAll('.pickup-gate-btn')].map((b) => [b.className, txt(b)]), [['pickup-gate-btn primary', 'Recargar la página']], `🔴 ${dir} ${path}: ONE action (S3-FORM-C1-ACT)`);
  }
  ok(`${dir}: C1 — menu_changed on the cash and the card send → Paso 2, «El menú se actualizó, recargá la página» + ONE «Recargar la página»`);

  // ── C2: the in-place reload; the double tap; the failed fetch ──
  {
    const { w, ctl } = await boot(rid, P, [{ status: MC.status, body: MC.body }]);
    const a = dish(w, c.A), b = dish(w, c.B);
    await add(w, a.id); await add(w, b.id);
    await send(w, 'cash');
    assert.ok(shown(gate(w)), 'premise: C1');
    // a failed fetch: the gate stays, its button enabled
    ctl.menu = () => 'fail';
    gate(w).querySelector('.pickup-gate-btn').click(); await settle(); await settle();
    assert.ok(shown(gate(w)) && !gate(w).querySelector('.pickup-gate-btn').disabled, `🔴 ${dir}: a failed reload keeps the gate with its button enabled (S3-FORM-C2-FAIL)`);
    // the double tap: ONE fetch
    ctl.menu = () => 'hang';   // the first tap's fetch is still in flight when the second tap lands
    const calls = ctl.menuCalls;
    gate(w).querySelector('.pickup-gate-btn').click(); gate(w).querySelector('.pickup-gate-btn').click(); await settle();
    assert.strictEqual(ctl.menuCalls - calls, 1, `🔴 ${dir}: the button cannot double-fire (S3-FORM-C2-ONCE)`);
    // a fresh page for the success path (the hung fetch above never settles)
    const f = await boot(rid, P, [{ status: MC.status, body: MC.body }]);
    await add(f.w, dish(f.w, c.A).id); await add(f.w, dish(f.w, c.B).id);
    await send(f.w, 'cash');
    f.ctl.menu = () => LESS[rid];
    const q0 = f.ctl.quotes.length;
    gate(f.w).querySelector('.pickup-gate-btn').click(); await settle(); await settle(); await settle();
    assert.ok(!shown(gate(f.w)), `🔴 ${dir}: the gate closes once the fresh menu is in (S3-FORM-C2-CLOSE)`);
    assert.strictEqual(stage(f.w), 's2', `${dir}: still on Paso 2`);
    const keys = plain(f.w.eval('resolvedCartLines().map(l => String(l.key))'));
    assert.deepStrictEqual(keys, [String(dish(f.w, c.A).id)], `🔴 ${dir}: ONLY the gone dish is dropped — the repriced one stays (S3-FORM-C2-DROP)`);
    assert.strictEqual(txt(f.w.document.getElementById('acct-toast')), '1 producto ya no está disponible', `🔴 ${dir}: the existing toast (S3-FORM-C2-TOAST)`);
    assert.ok(f.ctl.quotes.length > q0 && f.ctl.quotes.at(-1).items.length === 1, `🔴 ${dir}: the total is re-quoted for what is left (S3-FORM-C2-QUOTE)`);
    assert.strictEqual(f.ctl.sent.length, 1, `${dir}: nothing re-sent — the customer confirms again`);
  }
  ok(`${dir}: C2 — «Recargar la página» refreshes the live menu in place, drops ONLY the gone dish with the existing toast, re-quotes; one fetch per tap; a failed fetch keeps the gate`);

  // ── D1 / D2 ──
  {
    const pre = await boot(rid, P);
    const a0 = dish(pre.w, c.A);
    const ex = pre.w.liveMenuGlobalGet('EXTRAS').find((e) => e.id === c.extraId);
    assert.ok(ex, `premise: ${dir} serves ${c.extraId}`);
    const legacy = rid === 'la_musa' ? ex.id : ex.name;   // the extra's legacy key, as the server names it
    // a second option the dish is ALLOWED, kept by the repair (x_pizza: Pepperoni; la_musa: another option its category offers)
    const secondId = rid === 'x_pizza' ? 'e7' : P.body.extras.find((e) => e.id !== c.extraId && (P.body.extras_by_category[String(a0.cat)] || []).includes(e.cat)).id;
    const second = (w, a) => (rid === 'x_pizza' ? w.toggleDetailExtra(secondId, a.id, 0) : w.chgDetailExtra(secondId, a.id, 1));
    const XR = { outcome: 'denied', denied: [{ item: P.body.item_keys[String(a0.id)], extra: legacy }] };
    for (const path of ['cash', 'card']) {
      const { w, ctl } = await boot(rid, P, [{ status: EI.refusalStatus(XR), body: { ...EI.refusalBody(XR), order_id: 'X' } }]);
      const a = dish(w, c.A);
      await add(w, a.id); c.extra(w, a); await settle(); second(w, a); await settle(); await add(w, dish(w, c.B).id);
      await send(w, path);
      assert.strictEqual(stage(w), 's2', `🔴 ${dir} ${path}: extra_not_allowed returns to Paso 2 (S3-FORM-D1-STAGE)`);
      assert.ok(shown(gate(w)), `🔴 ${dir} ${path}: the gate (S3-FORM-D1-GATE)`);
      assert.strictEqual(txt(gate(w).querySelector('.pickup-gate-title')), 'Uno de los extras ya no está disponible para ese producto. Revisá tu pedido.', `🔴 ${dir}: the server's detail, verbatim (S3-FORM-D1-TITLE)`);
      assert.deepStrictEqual([...gate(w).querySelectorAll('.gate-line')].map((l) => [txt(l.querySelector('b')), txt(l)]), [[a.name, `${a.name} · ${c.word}: ${ex.name}`]], `🔴 ${dir}: one naming line per denied extra (S3-FORM-D1-LINE)`);
      assert.deepStrictEqual([...gate(w).querySelectorAll('.pickup-gate-btn')].map((b) => [b.className, txt(b)]), [['pickup-gate-btn primary', 'Quitar extra y seguir'], ['pickup-gate-btn ghost', 'Revisar pedido']], `🔴 ${dir}: [Quitar extra y seguir][Revisar pedido] (S3-FORM-D1-ACTS)`);
      if (path === 'card') {   // «Revisar pedido»: the existing cart review
        gate(w).querySelectorAll('.pickup-gate-btn')[1].click(); await settle();
        assert.ok(w.document.getElementById('cart-overlay').classList.contains('open'), `🔴 ${dir}: «Revisar pedido» opens the cart review (S3-FORM-D1-REVIEW)`);
        continue;
      }
      const q0 = ctl.quotes.length;
      gate(w).querySelector('.pickup-gate-btn.primary').click(); await settle(); await settle();
      const left = plain(w.eval('pizzaExtras'))[String(a.id)];
      const on = rid === 'la_musa' ? Object.entries(left || {}).filter(([, q]) => q > 0) : Object.values(left || {}).flatMap((inst) => Object.entries(inst).filter(([, q]) => q > 0));
      assert.deepStrictEqual(on, [[secondId, 1]], `🔴 ${dir}: ONLY the denied extra is removed; the other stays (S3-FORM-D2-REMOVE)`);
      assert.deepStrictEqual(plain(w.eval('resolvedCartLines().map(l => String(l.key))')).sort(), [String(a.id), String(dish(w, c.B).id)].sort(), `${dir}: both dishes stay`);
      assert.ok(!shown(gate(w)), `${dir}: the gate closes`);
      assert.ok(ctl.quotes.length > q0, `🔴 ${dir}: the order is re-quoted (S3-FORM-D2-QUOTE)`);
      const total = w.eval('redeemAdjustedTotal()').toFixed(0);
      assert.strictEqual(txt(w.document.querySelector('#s2-price-notice .price-change-notice')), `Quitamos ${ex.name} de ${a.name}. Total nuevo: L ${total}.`, `🔴 ${dir}: the notice names what was removed and the total on screen (S3-FORM-D2-NOTE)`);
      assert.strictEqual(ctl.sent.length, 1, `🔴 ${dir}: nothing re-sent (S3-FORM-D2-NOSEND)`);
    }
  }
  ok(`${dir}: D1/D2 — extra_not_allowed → the gate naming the dish and the ${c.word}; «Quitar extra y seguir» removes only it, re-quotes, shows the new total; «Revisar pedido» opens the cart`);
}

// ════ Codex S3 r1 fold (advisor rulings 2026-11-10) ════
const ERR3 = (w) => txt(w.document.getElementById('err3'));
const RETRY_PRICE = 'No pudimos confirmar el precio en este momento. Volvé a intentar en unos segundos — tu pedido está intacto.';   // the forms' EXISTING sentence
const releaseQuotes = async (ctl) => { ctl.holdQuotes = false; const h = ctl.held.splice(0); h.forEach((go) => go()); await settle(); await settle(); };
for (const rid of ['x_pizza', 'la_musa']) {
  const dir = DIR[rid], P = BASE[rid], c = CASE[rid];
  const MC = resolutionRefusal({ code: 'menu_changed' });
  // ── P1-2 (MONEY): after the repair (D2) and after the reload (C2), NOTHING is sent until the server quote for THAT cart is in ──
  {
    const pre = await boot(rid, P); const a0 = dish(pre.w, c.A);
    const ex = pre.w.liveMenuGlobalGet('EXTRAS').find((e) => e.id === c.extraId);
    const XR = { outcome: 'denied', denied: [{ item: P.body.item_keys[String(a0.id)], extra: rid === 'la_musa' ? ex.id : ex.name }] };
    const { w, ctl } = await boot(rid, P, [{ status: EI.refusalStatus(XR), body: { ...EI.refusalBody(XR), order_id: 'X' } }]);
    const a = dish(w, c.A); await add(w, a.id); c.extra(w, a); await settle(); await add(w, dish(w, c.B).id);
    await send(w, 'card');
    ctl.holdQuotes = true;
    gate(w).querySelector('.pickup-gate-btn.primary').click(); await settle(); await settle();
    assert.ok(ctl.held.length >= 1, `premise: ${dir} the repaired cart's quote is on its way`);
    assert.ok(!/Total nuevo/.test(txt(w.document.getElementById('s2-price-notice')) || ''), `🔴 ${dir}: no «Total nuevo» before the server quote (S3-FORM-P12-NOTOTAL)`);
    const sent0 = ctl.sent.length;
    await quiet(() => w.processPayment()); await settle(); await settle();
    assert.strictEqual(ctl.sent.length, sent0, `🔴 ${dir}: «Confirmar y enviar» sends NOTHING before the repaired cart is quoted (S3-FORM-P12-BLOCK)`);
    assert.strictEqual(ERR3(w), RETRY_PRICE, `🔴 ${dir}: …and says so with the existing sentence (S3-FORM-P12-SAY)`);
    await releaseQuotes(ctl);
    const q = ctl.quotes.at(-1); const b = plain(q); resolveLines(rid, b, P.tables);
    const cents = Math.round(computeServerTotal(b.items, rid, P.tables).total * 100);
    assert.ok(new RegExp(`Total nuevo: L ${(cents / 100).toFixed(0)}\\.`).test(txt(w.document.getElementById('s2-price-notice')) || ''), `🔴 ${dir}: the note's total IS the server quote (S3-FORM-P12-QUOTED)`);
    assert.strictEqual(w.eval('itemAwaitingQuote()'), false, `🔴 ${dir}: once quoted, «Confirmar y enviar» is no longer held (S3-FORM-P12-GO)`);
    await send(w, 'card');   // past processPayment's gate the harness sends as everywhere (its own validation chain needs layout jsdom lacks)
    assert.strictEqual(ctl.sent.length, sent0 + 1, `${dir}: …and the order goes`);
  }
  {
    const { w, ctl } = await boot(rid, P, [{ status: MC.status, body: MC.body }]);
    await add(w, dish(w, c.A).id); await add(w, dish(w, c.B).id);
    await send(w, 'cash');
    ctl.menu = () => LESS[rid]; ctl.holdQuotes = true;
    gate(w).querySelector('.pickup-gate-btn').click(); await settle(); await settle(); await settle();
    const sent0 = ctl.sent.length;
    w.selectPay('cash'); await quiet(() => w.processPayment()); await settle(); await settle();
    assert.strictEqual(ctl.sent.length, sent0, `🔴 ${dir}: after the reload, nothing is sent before the new cart is quoted (S3-FORM-P12-RELOAD)`);
    assert.strictEqual(ERR3(w), RETRY_PRICE, `🔴 ${dir}: …the form's held-price sentence, not its validation (S3-FORM-P12-RELOAD-SAY)`);
    await releaseQuotes(ctl);
  }
  ok(`${dir}: P1-2 — after «Quitar extra y seguir» and after «Recargar la página», no «Total nuevo» and no send until the server quote for that cart is in; then the note shows the SERVER total and the order goes`);

  // ── P2-4: a newer menu DEFERRED while on Paso 2, then the reload's 304 — the deferred menu is applied, never a false success ──
  {
    const { w, ctl } = await boot(rid, P, [{ status: MC.status, body: MC.body }]);
    await add(w, dish(w, c.A).id); await add(w, dish(w, c.B).id);
    await send(w, 'cash');
    ctl.menu = () => LESS[rid];
    await quiet(() => w.__liveMenu.feed.refresh()); await settle();   // a background refresh lands while Paso 2 is open → DEFERRED
    assert.ok(w.__liveMenu.applier.hasPending(), `premise: ${dir} the newer menu is held (deferred)`);
    const notModified = () => Promise.resolve({ ok: false, status: 304, headers: { get: () => null }, json: () => Promise.reject(new Error('304')) });
    const prev = w.__respond; w.__respond = (url, init) => (url.includes('/menu/') ? (ctl.menuCalls++, notModified()) : prev(url, init));
    gate(w).querySelector('.pickup-gate-btn').click(); await settle(); await settle(); await settle();
    assert.ok(!w.__liveMenu.applier.hasPending(), `🔴 ${dir}: the deferred menu is applied by the reload (S3-FORM-P24-FLUSH)`);
    assert.deepStrictEqual(plain(w.eval('resolvedCartLines().map(l => String(l.key))')), [String(dish(w, c.A).id)], `🔴 ${dir}: the gone dish is dropped — never a false success (S3-FORM-P24-DROP)`);
  }
  ok(`${dir}: P2-4 — a newer menu deferred on Paso 2 is applied by «Recargar la página» even when its fetch answers 304`);

  // ── P2-5: the QUOTE's item refusals open the same gate ──
  for (const kind of ['menu_changed', 'extra_not_allowed']) {
    const { w, ctl } = await boot(rid, P);
    const a = dish(w, c.A); await add(w, a.id); c.extra(w, a); await settle();
    const legacy = rid === 'la_musa' ? c.extraId : w.liveMenuGlobalGet('EXTRAS').find((e) => e.id === c.extraId).name;
    w.showStage('s2', 50); await stageSettle();
    ctl.quoteAnswer = () => (kind === 'menu_changed' ? { status: 200, body: { ok: false, error: 'menu_changed' } }
      : { status: 409, body: { ok: false, ...EI.refusalBody({ outcome: 'denied', denied: [{ item: P.body.item_keys[String(a.id)], extra: legacy }] }) } });
    w.requestServerQuote(true); await settle(); await settle();
    assert.ok(shown(gate(w)), `🔴 ${dir}: a QUOTE ${kind} opens the item gate (S3-FORM-P25-GATE)`);
    assert.strictEqual(txt(gate(w).querySelector('.pickup-gate-title')), kind === 'menu_changed' ? 'El menú se actualizó, recargá la página' : 'Uno de los extras ya no está disponible para ese producto. Revisá tu pedido.', `${dir}: the ${kind} gate`);
  }
  ok(`${dir}: P2-5 — a quote's menu_changed / extra_not_allowed opens the same gate as the send's`);
}

// ── P2-3: a resumed payment keeps its bound fingerprint across a rename (both forms: the pinned line keeps the name it was sent with) ──
{
  const { chargeInputsFingerprint } = require('./catalog/charge-inputs');
  const STASHK = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
  for (const [rid, key, to] of [['x_pizza', 'Carnivora', 'Carnívora Suprema'], ['la_musa', 'dimsum_02', 'Pork Belly Buns de la casa']]) {
    const dir = DIR[rid], P = BASE[rid];
    const REN = await quiet(() => published(rid, { rename: { key, to } }));
    // a rename keeps the dish's IDENTITY (S1's registry); two fixture publishes mint two registries, so carry the base's over
    for (const coll of ['dishes', 'extras']) for (const r of REN.env.menu[coll]) { const o = P.env.menu[coll].find((x) => String(x.id) === String(r.id)); if (o) { if (o.dish_id) r.dish_id = o.dish_id; if (o.extra_id) r.extra_id = o.extra_id; } }
    const first = await boot(rid, P);
    const id = rid === 'x_pizza' ? dish(first.w, 'Carnivora').id : 'dimsum_02';
    await add(first.w, id); await add(first.w, dish(first.w, CASE[rid].B).id);
    await send(first.w, 'card');
    const firstBody = first.ctl.sent.at(-1).body;
    const stash = first.w.localStorage.getItem(STASHK[dir]);
    const r = await boot(rid, REN);   // the page now serves the RENAMED dish (same id, same key, same price)
    assert.ok(dish(r.w, to), `premise: ${dir} serves the rename`);
    r.w.localStorage.setItem(STASHK[dir], stash);
    r.w.restoreOrderForm(); await settle();
    await send(r.w, 'card');
    const body = r.ctl.sent.at(-1).body;
    assert.strictEqual(body.order_id, firstBody.order_id, `${dir}: the resumed order keeps its id`);
    assert.deepStrictEqual(body.items, firstBody.items, `🔴 ${dir}: the resumed items are byte-identical across the rename (S3-FORM-P23-ITEMS)`);
    assert.strictEqual(body.items_text, firstBody.items_text, `🔴 ${dir}: …items_text too (S3-FORM-P23-TEXT)`);
    assert.strictEqual(chargeInputsFingerprint(body), chargeInputsFingerprint(firstBody), `🔴 ${dir}: the bound fingerprint holds (S3-FORM-P23-FP)`);
    assert.deepStrictEqual(resolveLines(rid, plain(body), REN.tables), { ok: true }, `${dir}: the server still resolves the resumed lines`);
  }
  ok('P2-3 — a resumed payment keeps items, items_text and its bound fingerprint across a rename (both forms)');
}

// ── P2-7: a stored reorder recipe (reorder_items[].key = the resolved pricing key = the item key) resolves by the item key ──
{
  const MARK = { x_pizza: 'xpizza_acct', la_musa: 'lamusa_acct' };
  const fb = (entry) => { const snap = (v) => ({ exists: () => v != null, val: () => v }); const user = { uid: 'u_s3', getIdToken: async () => 'tok', phoneNumber: '+50499990000' };
    return { app: {}, db: {}, auth: { currentUser: user, authStateReady: async () => {} }, authMod: { onAuthStateChanged: (a, cb) => { cb(user); return () => {}; }, signOut: async () => {} },
      dbMod: { ref: (db, path) => ({ path }), get: async (r) => snap(r && r.path === `user_orders/${user.uid}` ? { o_s3: entry } : null), onValue: (r, cb) => { cb(snap(null)); return () => {}; }, off: () => {} } }; };
  const signed = (marker) => ({ 'account.js': (code) => `try { localStorage.setItem(${JSON.stringify(marker)}, ${JSON.stringify(JSON.stringify({ uid: 'u_s3', name: 'Ana Pérez', phone: '+50499990000' }))}); } catch (_) {}\n` + code.replace('async function ensureFirebase() {', 'async function ensureFirebase() { if (window.__FB_FAKE) return window.__FB_FAKE;') });
  for (const [rid, opts, recipeKey, want] of [['x_pizza', { rename: { key: 'Carnivora', to: 'Carnívora Suprema' } }, 'Carnivora', '2'], ['la_musa', { mint: { name: 'Bao Nuevo', key: 'i_aaaaaaaaaaac' } }, 'i_aaaaaaaaaaac', 'bao_nuevo']]) {
    const dir = DIR[rid];
    const P = await quiet(() => published(rid, opts));
    const w = loadForm(dir, { transforms: signed(MARK[rid]) });
    w.__FB_FAKE = fb({ ts: 1791500000000, total: 340, order_type: 'pickup', restaurant: rid, status: 'completed', items_text: '1x x (L1)', items: [{ key: recipeKey, qty: 1 }] });
    await settle(); await quiet(() => serve(w, plain(P.env)));
    w.document.querySelector('#acct-chip button').click(); await settle();
    w.document.getElementById('acct-row-orders').click(); await settle(); await settle();
    w.document.querySelector('#acct-pane-orders .acct-ordreorder').click(); await settle(); await settle();
    assert.deepStrictEqual(plain(w.eval('resolvedCartLines().map(l => [String(l.key), l.qty])')), [[want, 1]], `🔴 ${dir}: the recipe's item key finds the dish (S3-FORM-P27-REORDER)`);
  }
  ok('P2-7 — a stored reorder recipe resolves a renamed (x_pizza) and a minted (la_musa) dish by its item key');
}

closeAll();
clearTimeout(WATCHDOG);
console.log('\nitem-s3-forms-ui: OK');
process.exit(0);
