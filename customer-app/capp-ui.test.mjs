// Customer app S1b — the store page, item sheet and cart sheet, driven through the REAL index.html + modules in jsdom (its own
// click handlers, no re-implementation) over the REAL served envelopes (the S0 rig's real publish). Light: no emulator.
// Run: node --test customer-app/capp-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');   // resolved as the S0 form harness does
const { provisionBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const PROV = { x_pizza: await quiet(() => provisionBrand('x_pizza')), la_musa: await quiet(() => provisionBrand('la_musa')) };
const { provisionThirdBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/third-brand-fork.mjs'));
PROV.r3 = await quiet(() => provisionThirdBrand());   // the synthetic third brand (S0 rig): every dish renamed, no restaurant literal can match
// store config fixtures (the shell's data inputs; S1b takes them as given) — open all day on the injected clock
const OPEN = [12, 0, 21, 45];
const CONFIG = {
  x_pizza: { name: 'Pizzería Uno', kicker: 'Pizzería', unit: ['pizza', 'pizzas'], hours: Array(7).fill(OPEN), addr: 'Calle 1', etaDel: [30, 45], etaPick: [15, 20], feeFromCents: null, assetBase: null, entry: 'link' },
  r3: { name: 'Tercera', kicker: 'Sintético', unit: ['plato', 'platos'], hours: Array(7).fill(OPEN), addr: 'Calle 3', etaDel: [25, 35], etaPick: [10, 15], feeFromCents: null, assetBase: null, entry: 'link' },
  la_musa: { name: 'Gastro Dos', kicker: 'Gastropub', unit: ['plato', 'platos'], hours: Array(7).fill(OPEN), addr: 'Calle 2', etaDel: [35, 50], etaPick: [20, 30], feeFromCents: null, assetBase: null, entry: 'link' },
};
const NOON = () => new Date(2026, 9, 20, 19, 5);
const J = (x) => JSON.parse(JSON.stringify(x));   // values from the jsdom realm, compared in this one

function boot(rid, extra = {}) {
  const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-ui.js']) w.eval(readFileSync(join(HERE, f), 'utf8'));
  const events = [];
  const ui = w.CappUI.mount(w.document, { envelope: extra.envelope || PROV[rid].envelope, config: { ...CONFIG[rid], ...(extra.config || {}) }, now: NOON, unavailable: extra.unavailable, onEvent: (n, d) => events.push([n, d]) });
  const q = (sel) => w.document.querySelector(sel); const qa = (sel) => [...w.document.querySelectorAll(sel)];
  const click = (sel) => { const el = typeof sel === 'string' ? q(sel) : sel; assert.ok(el, `premise: ${sel} exists`); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
  // the visible text: every text node, trimmed, joined by one space (spans are spaced by CSS, not by literal spaces)
  const text = (sel) => { const el = q(sel); if (!el) return null; const tw = w.document.createTreeWalker(el, 4); const out = []; for (let nd = tw.nextNode(); nd; nd = tw.nextNode()) { const t = nd.nodeValue.replace(/\s+/g, ' ').trim(); if (t) out.push(t); } return out.join(' '); };
  return { w, ui, q, qa, click, text, events };
}
const configurable = (m) => m.dishes.find((d) => !d.launcher && !d.variantOf && m.extrasFor(d.key).length >= 2 && !m.pickupOnlyCats.has(String(d.cat)));

test('store: data-driven sections (name ?? id — the P1 data gap), one row per orderable dish, the empty cart pill', () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const b = boot(rid); const env = PROV[rid].envelope.menu;
    const tabs = b.qa('.tab').map((t) => t.textContent);
    const cats = env.categories.filter((c) => env.dishes.some((d) => String(d.cat) === String(c.id) && !d.variantOf));
    assert.deepEqual(tabs, cats.map((c) => c.name ?? String(c.id)), `${rid}: tabs from the served categories`);
    assert.equal(b.qa('.row').length, env.dishes.filter((d) => !d.variantOf).length, `${rid}: one row per dish (variant choices live in their launcher)`);
    assert.equal(b.text('#cart-bar'), 'Tu pedido · L 0');
    assert.equal(b.text('.brandname'), CONFIG[rid].name);
    assert.ok(b.text('.facts').startsWith('Abierto · cierra 9:45 p.m.'), b.text('.facts'));
  }
  const b = boot('x_pizza');
  assert.ok(b.text('.secflag') && b.text('.secflag').startsWith('Solo para Pickup'), 'the pickup-only flag from served data');
  assert.ok(b.qa('.secnote').some((n) => n.textContent === 'Solo viernes a domingo · para recoger'), 'the weekend + pickup note from served data');
});

test('store: "+" adds a plain instance, the pill counts in the restaurant\'s unit; "−" removes it', () => {
  const b = boot('x_pizza'); const m = b.ui.menu; const d = m.dishes.find((x) => !x.launcher && !x.variantOf);
  b.click(`.qty-add-btn[data-id="${d.key}"]`);
  assert.equal(b.text('#cart-bar'), `1 pizza · L ${d.price}`);
  b.click(`.qty-ctrl-btn[data-act="inc"][data-id="${d.key}"]`);
  assert.equal(b.text('#cart-bar'), `2 pizzas · L ${2 * d.price}`);
  b.click(`.qty-ctrl-btn[data-act="dec"][data-id="${d.key}"]`);
  assert.equal(b.ui.cart.count(), 1);
});

test('sheet (dish with extras): Agregar · L p → the sheet stays open to dress each instance; per-instance toggles; «Pizza n» headers', () => {
  const b = boot('x_pizza'); const m = b.ui.menu; const d = configurable(m); const [e1] = m.extrasFor(d.key);
  b.click(`.txtbtn[data-id="${d.key}"]`);
  assert.equal(b.text('#detail-header-title'), d.name);
  assert.equal(b.text('#detail-cta'), `Agregar · L ${d.price}`);
  b.click('#detail-step [data-delta="1"]');
  assert.equal(b.text('#detail-cta'), `Agregar · L ${2 * d.price}`, 'the stepper stages 2 before the first add');
  b.click('#detail-cta');
  assert.equal(b.ui.cart.count(), 2);
  assert.ok(b.q('#detail-modal').classList.contains('open'), 'with extras the sheet stays open');
  assert.deepEqual(b.qa('.detail-pizza-header').map((h) => h.textContent), ['Pizza 1', 'Pizza 2']);
  b.click(`.detail-extras-row[data-eid="${e1.key}"][data-inst="1"]`);
  assert.deepEqual(J(b.ui.cart.lines()[0].ex), [{}, { [e1.key]: 1 }], 'the toggle dresses instance 2 only');
  assert.equal(b.text('#detail-cta'), `Guardar · L ${2 * d.price + e1.price}`);
  assert.ok(b.q(`.detail-extras-row[data-eid="${e1.key}"][data-inst="1"]`).getAttribute('aria-checked') === 'true');
  assert.equal(b.qa('.grp-status.optional')[0].textContent, 'Opcional');
});

test('sheet (launcher): CTA disabled «Elegí tu …» until a choice; chip «Elegí 1 · Requerido» → «Requerido»; adds the choice', () => {
  const b = boot('la_musa'); const m = b.ui.menu; const [lk, g] = Object.entries(m.groups)[0];
  b.click(`.txtbtn[data-id="${lk}"]`);
  assert.equal(b.text('#detail-cta'), `Elegí tu ${g.label.toLowerCase()}`);
  assert.ok(b.q('#detail-cta').disabled);
  assert.equal(b.text('.grp-status.req'), 'Elegí 1 · Requerido');
  const c = m.dish(g.choices[1]);
  b.click(`.detail-variant-row[data-id="${c.key}"]`);
  assert.equal(b.text('.grp-status.done'), 'Requerido');
  assert.equal(b.text('#detail-cta'), `Agregar · L ${c.price}`);
  b.click('#detail-cta');
  assert.deepEqual(J(b.ui.cart.lines().map((l) => [l.key, l.qty])), [[c.key, 1]]);
  assert.ok(!b.q('#detail-modal').classList.contains('open'));
});

test('cart sheet: grouped lines with «+ extras» and Editar, the per-configuration stepper, Subtotal, «Ir al checkout» → the serialized body', () => {
  const b = boot('x_pizza'); const m = b.ui.menu; const d = configurable(m); const [e1] = m.extrasFor(d.key);
  b.ui.cart.add(d.key, [e1.key], 2); b.ui.cart.inc(d.key); b.ui.render();
  b.click('#cart-bar');
  const lines = b.qa('.cline');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].textContent.includes(`+ ${e1.name}`) && lines[0].textContent.includes('Editar'));
  assert.equal(b.text('.cline .cl-p'), `L ${2 * (d.price + e1.price)}`);
  assert.ok(b.text('.ctot').startsWith(`Subtotal L ${(3 * d.price + 2 * e1.price).toLocaleString('en-US')}`), b.text('.ctot'));
  b.click(b.qa('.cline')[0].querySelector('[data-rev="1"]'));
  assert.equal(b.ui.cart.count(), 4, 'the line "+" clones that configuration');
  b.click('[data-act="checkout"]');
  const [name, detail] = b.events.at(-1);
  assert.equal(name, 'checkout');
  assert.equal(detail.body.items.length, 4, 'the S1a serializer body (one line per instance)');
});

test('cart sheet: empty state; «Agotado» rows are dimmed and cannot be added', () => {
  const b = boot('la_musa');
  b.click('#cart-bar');
  assert.equal(b.text('.empty span'), 'Tu pedido está vacío.');
  const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  const s = boot('la_musa', { unavailable: new Set([d.key]) });
  const row = s.q(`#dish-${d.key}`);
  assert.ok(row.classList.contains('sold-out') && row.textContent.includes('Agotado'));
  s.click(row.querySelector('[data-act="inc"]'));
  assert.equal(s.ui.cart.count(), 0, 'a sold-out dish is never added');
});

test('restore: a line that no longer fits is dropped and counted in the prototype\'s note', () => {
  const b = boot('la_musa'); const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  const r = b.ui.restore({ v: 2, lines: [{ key: d.key, qty: 1, ex: [{}], added: 1 }, { key: 'gone', qty: 1, ex: [{}], added: 2 }] });
  assert.equal(r.dropped, 1);
  b.click('#cart-bar');
  assert.equal(b.text('.cartnote span'), '1 plato ya no está disponible');
});

test('the 1,500-character limit: an add past it is REVERTED and the owner-approved line shows', () => {
  const env = JSON.parse(JSON.stringify(PROV.x_pizza.envelope));
  const d0 = env.menu.dishes.find((x) => !x.variantOf && !(env.menu.pickup_only_cats || []).includes(x.cat));
  d0.name = 'N'.repeat(1480);
  const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '');
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-ui.js']) w.eval(readFileSync(join(HERE, f), 'utf8'));
  const ui = w.CappUI.mount(w.document, { envelope: env, config: CONFIG.x_pizza, now: NOON });
  const key = ui.menu.dishes.find((x) => x.name === d0.name).key;
  const other = ui.menu.dishes.find((x) => !x.launcher && !x.variantOf && x.key !== key).key;
  w.document.querySelector(`.qty-add-btn[data-id="${key}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(ui.cart.count(), 1, 'premise: the long dish fits');
  w.document.querySelector(`.qty-add-btn[data-id="${other}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(ui.cart.count(), 1, 'the add that would exceed 1,500 characters is reverted');
  w.document.getElementById('cart-bar').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.ok([...w.document.querySelectorAll('.cartnote span')].some((s) => s.textContent === w.CappUI.FULL_CART));
  assert.equal(w.CappUI.FULL_CART, 'Tu carrito está lleno. Empezá otro carrito con el resto de tu pedido.');
});

test('entry: link shows no close X; in-app shows it and emits «back» (S7 owns the destination)', () => {
  assert.equal(boot('x_pizza').q('[data-act="back"]'), null);
  const b = boot('x_pizza', { config: { entry: 'app' } });
  b.click('[data-act="back"]');
  assert.deepEqual(b.events.at(-1), ['back', undefined]);
});

test('the synthetic THIRD brand renders through the same renderer (the S0 r3 cells\' S1 counterpart): store, add, cart, checkout body', () => {
  const b = boot('r3'); const env = PROV.r3.envelope.menu;
  assert.equal(b.qa('.row').length, env.dishes.filter((d) => !d.variantOf).length);
  const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf && !b.ui.menu.pickupOnlyCats.has(String(x.cat)));
  b.click(`.qty-add-btn[data-id="${d.key}"]`);
  assert.equal(b.text('#cart-bar'), `1 plato · L ${d.price}`);
  b.click('#cart-bar'); b.click('[data-act="checkout"]');
  const [name, detail] = b.events.at(-1);
  assert.equal(name, 'checkout');
  assert.equal(J(detail.body.items)[0].name, d.name, 'the r3 dish (renamed «R3 …») serialized by name and id');
});

// ── Codex S1b r1 regressions (each fails on revert) ──
const key = (b, k, target) => { const el = typeof target === 'string' ? b.q(target) : target; el.dispatchEvent(new b.w.KeyboardEvent('keydown', { key: k, bubbles: true })); };
// an envelope copy with one dish's name lengthened so that a given cart lands at an exact items_text length
function longEnv(rid, dishMatch, targetLen, cartOf) {
  const env = JSON.parse(JSON.stringify(PROV[rid].envelope));
  const d = env.menu.dishes.find(dishMatch);
  const probe = boot(rid, { envelope: env }); const items = cartOf(probe); const len0 = probe.ui.cart.count() ? require('./capp-serialize.js').serialize(probe.ui.cart, probe.ui.menu).items_text.length : 0;
  void items; d.name = d.name + 'N'.repeat(targetLen - len0);
  return env;
}

test('r1 P2-1: an unavailable CHOICE is disabled in the sheet and refused on add AND on edit', () => {
  const lm = boot('la_musa'); const [lk, g] = Object.entries(lm.ui.menu.groups)[0]; const [ca, cb] = g.choices;
  const sold = new Set([cb]);
  const b = boot('la_musa', { unavailable: sold });
  b.click(`.txtbtn[data-id="${lk}"]`);
  const row = b.q(`.detail-variant-row[data-id="${cb}"]`);
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  b.click(row);
  assert.equal(b.q(`.detail-variant-row[data-id="${cb}"]`).getAttribute('aria-checked'), 'false', 'a sold choice cannot be selected');
  b.ui.state.open.staged.choice = cb;   // even if a stale state selected it, the add is refused
  b.click('#detail-cta');
  assert.equal(b.ui.cart.count(), 0, '🔴 an unavailable choice never reaches the cart');
  b.click('#detail-close');
  b.ui.cart.add(ca, [], 1); b.ui.render();
  b.click('#cart-bar'); b.click(b.qa('.cline [data-act="edit"]')[0]);
  b.ui.state.open.staged.choice = cb; b.click('#detail-cta');
  assert.deepEqual(J(b.ui.cart.lines().map((l) => l.key)), [ca], '🔴 an edit INTO an unavailable choice is refused');
  assert.ok(b.q('#detail-modal').classList.contains('open'), 'the refused edit keeps the sheet open');
});

test('r1 P2-2: availability is read LIVE — at render time and at action time, never a mount-time snapshot', () => {
  const sold = new Set();
  const b = boot('x_pizza', { unavailable: sold });
  const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  const btn = b.q(`.qty-add-btn[data-id="${d.key}"]`);
  sold.add(d.key);
  b.click(btn);   // the stale button, before any re-render
  assert.equal(b.ui.cart.count(), 0, '🔴 action time: a dish sold out after render is refused');
  b.ui.render();
  assert.ok(b.q(`#dish-${d.key}`).classList.contains('sold-out'), '🔴 render time: the row shows «Agotado» after the set changes');
  sold.delete(d.key); b.ui.render();
  b.click(`.qty-add-btn[data-id="${d.key}"]`);
  assert.equal(b.ui.cart.count(), 1, 'back in stock → addable');
});

test('r1 P2-3: keyboard — Enter / Space activate checkbox and radio rows; Escape closes the sheet and the layers', () => {
  const b = boot('x_pizza'); const m = b.ui.menu; const d = configurable(m); const [e1] = m.extrasFor(d.key);
  b.ui.cart.add(d.key, [], 1); b.ui.render();
  b.click(`.txtbtn[data-id="${d.key}"]`);
  key(b, 'Enter', `.detail-extras-row[data-eid="${e1.key}"][data-inst="0"]`);
  assert.deepEqual(J(b.ui.cart.lines()[0].ex), [{ [e1.key]: 1 }], '🔴 Enter toggles an extra');
  key(b, ' ', `.detail-extras-row[data-eid="${e1.key}"][data-inst="0"]`);
  assert.deepEqual(J(b.ui.cart.lines()[0].ex), [{}], '🔴 Space toggles it back');
  key(b, 'Escape', '#detail-close');
  assert.ok(!b.q('#detail-modal').classList.contains('open'), '🔴 Escape closes the sheet');
  const lm = boot('la_musa'); const [lk, g] = Object.entries(lm.ui.menu.groups)[0];
  lm.click(`.txtbtn[data-id="${lk}"]`);
  key(lm, ' ', `.detail-variant-row[data-id="${g.choices[0]}"]`);
  assert.equal(lm.q(`.detail-variant-row[data-id="${g.choices[0]}"]`).getAttribute('aria-checked'), 'true', '🔴 Space selects a required choice');
  lm.click('#detail-close'); lm.click('#cart-bar');
  key(lm, 'Escape', '.sheet');
  assert.equal(lm.q('.sheet'), null, '🔴 Escape closes the cart sheet');
});

test('r1 P2-4: sheets manage focus — focus moves in, the background and a closed sheet are inert, Tab stays inside, focus returns', () => {
  const b = boot('x_pizza'); const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  assert.ok(b.q('#detail-modal').hasAttribute('inert'), '🔴 the closed sheet is inert (its buttons unreachable)');
  const trigger = b.q(`.txtbtn[data-id="${d.key}"]`); trigger.focus();
  b.click(trigger);
  assert.equal(b.w.document.activeElement, b.q('#detail-close'), '🔴 focus moves into the sheet');
  assert.ok(b.q('.screen').hasAttribute('inert') && !b.q('#detail-modal').hasAttribute('inert'), '🔴 the background is inert while the sheet is open');
  const f = [...b.q('#detail-modal').querySelectorAll('button:not([disabled]),[tabindex]:not([tabindex="-1"])')];
  f[f.length - 1].focus(); key(b, 'Tab', f[f.length - 1]);
  assert.equal(b.w.document.activeElement, f[0], '🔴 Tab wraps inside the dialog');
  b.click('#detail-close');
  assert.ok(b.q('#detail-modal').hasAttribute('inert') && !b.q('.screen').hasAttribute('inert'));
  assert.equal(b.w.document.activeElement.dataset.id, d.key, '🔴 focus returns to the control that opened the sheet');
  b.q('#cart-bar').focus(); b.click('#cart-bar');
  assert.ok(b.q('.sheet').contains(b.w.document.activeElement), '🔴 focus moves into the cart sheet');
  b.click('[data-act="cartclose"]');
  assert.equal(b.w.document.activeElement, b.q('#cart-bar'), '🔴 …and returns to the pill');
});

test('r1 P2-5: a length refusal is VISIBLE where it happened — the edit sheet stays open with the owner copy; a store add toasts it', () => {
  const m0 = boot('x_pizza').ui.menu; const d = configurable(m0); const [e1] = m0.extrasFor(d.key);
  const other = m0.dishes.find((x) => !x.launcher && !x.variantOf && x.key !== d.key && !m0.pickupOnlyCats.has(String(x.cat)));
  // the cart «other + d (plain)» lands at 1,500 − 3 characters; dressing d with e1 adds « [e1]» → over the limit
  const env = longEnv('x_pizza', (x) => String(x.dish_id) === other.key, 1497, (b) => { b.ui.cart.inc(other.key); b.ui.cart.inc(d.key); });
  const b = boot('x_pizza', { envelope: env });
  b.ui.cart.inc(other.key); b.ui.cart.inc(d.key); b.ui.render();
  b.click('#cart-bar'); b.click(b.qa('.cline [data-act="edit"]').find((x) => x.dataset.key === d.key));
  b.click(`.detail-extras-row[data-eid="${e1.key}"]`); b.click('#detail-cta');
  assert.ok(b.q('#detail-modal').classList.contains('open'), '🔴 the refused edit keeps the sheet open');
  assert.ok(b.q('#detail-scroll').textContent.includes(b.w.CappUI.FULL_CART), '🔴 the owner copy shows in the sheet');
  assert.deepEqual(J(b.ui.cart.lines().find((l) => l.key === d.key).ex), [{}], 'the cart is unchanged');
  b.click('#detail-close');
  if (b.q('.sheet')) b.click('[data-act="cartclose"]');   // back on the store
  const third = m0.dishes.find((x) => !x.launcher && !x.variantOf && x.key !== d.key && x.key !== other.key && !m0.pickupOnlyCats.has(String(x.cat)));
  b.click(`.qty-add-btn[data-id="${third.key}"]`);
  assert.equal(b.ui.cart.lines().some((l) => l.key === third.key), false, 'the over-limit store add is refused');
  assert.equal(b.text('#toast'), b.w.CappUI.FULL_CART, '🔴 a refused store add is announced by the toast');
});

test('r1 P2-6: a restored OVERSIZED cart shows the warning and a DISABLED checkout immediately', () => {
  const m0 = boot('x_pizza').ui.menu;
  const [a, c] = m0.dishes.filter((x) => !x.launcher && !x.variantOf && !m0.pickupOnlyCats.has(String(x.cat)));
  const env = longEnv('x_pizza', (x) => String(x.dish_id) === a.key, 1510, (b) => { b.ui.cart.inc(a.key); b.ui.cart.inc(c.key); });
  const b = boot('x_pizza', { envelope: env });
  b.ui.restore({ v: 2, lines: [{ key: a.key, qty: 1, ex: [{}], added: 1 }, { key: c.key, qty: 1, ex: [{}], added: 2 }] });
  assert.equal(b.text('#toast'), b.w.CappUI.FULL_CART, '🔴 the warning shows on restore');
  b.click('#cart-bar');
  assert.ok(b.q('[data-act="checkout"]').disabled, '🔴 checkout is disabled');
  assert.ok(b.qa('.cartnote span').some((x) => x.textContent === b.w.CappUI.FULL_CART), '🔴 the warning shows in the cart');
});

test('r1 P2-7: cart actions keep an active search — query, results and focus survive', () => {
  const b = boot('la_musa');
  b.click('[data-act="ssearch"]');
  const inp = b.q('#sq'); inp.value = 'Pork'; inp.dispatchEvent(new b.w.Event('input', { bubbles: true }));
  const hits = b.qa('#sresults .row').length; assert.ok(hits >= 1, 'premise: results');
  const add = b.q('#sresults .qty-add-btn'); const id = add.dataset.id; add.focus();
  b.click(add);
  assert.equal(b.ui.cart.count(), 1);
  assert.equal(b.q('#sq') && b.q('#sq').value, 'Pork', '🔴 the query survives the cart action');
  assert.equal(b.qa('#sresults .row').length, hits, '🔴 the results survive');
  assert.ok(b.w.document.activeElement && b.w.document.activeElement.dataset.id === id, '🔴 focus stays on the result');
});
