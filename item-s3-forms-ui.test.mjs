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
      const b = plain(body); const r = resolveLines(rid, b, ctl.P.tables); if (!r.ok) return res({ ok: false, error: r.code });
      const t = computeServerTotal(b.items, rid, ctl.P.tables);
      return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) });
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
  const ctl = { P, menu: () => P.env, menuCalls: 0, quotes: [], sent: [], sends };
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

closeAll();
clearTimeout(WATCHDOG);
console.log('\nitem-s3-forms-ui: OK');
process.exit(0);
