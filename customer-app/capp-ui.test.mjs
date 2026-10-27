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
  // the REAL stylesheet is inlined so visibility (display:none up the tree) is real in jsdom's cascade — focus may only land on what shows
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '').replace('</head>', () => `<style>${css}</style></head>`);
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
  const ae = b.w.document.activeElement;
  assert.ok(ae && ae.dataset.id === id && b.q('#layer').contains(ae) && reach(b, ae), '🔴 focus stays on the result — in the search layer, never the inert store copy');
});

// ── Codex S1b r2 regressions (each fails on revert) ──
// reachable as a user sees it: not inside an inert subtree, nothing display:none up the tree (the real capp.css is inlined)
function reach(b, el) { if (!el || el.closest('[inert]')) return false; for (let n = el; n; n = n.parentElement) { if (n.hidden || b.w.getComputedStyle(n).display === 'none') return false; } return true; }
const tabbables = (b, root) => [...root.querySelectorAll('button:not([disabled]),input,[tabindex]:not([tabindex="-1"]),a[href]')].filter((x) => reach(b, x));

test('r2 #1: an EDIT into a choice is refused when its LAUNCHER is sold out (CTA and save)', () => {
  const m = boot('la_musa').ui.menu; const [lk, g] = Object.entries(m.groups)[0]; const [ca, cb] = g.choices;
  const sold = new Set();
  const b = boot('la_musa', { unavailable: sold });
  b.ui.cart.add(ca, [], 1); b.ui.render();
  b.click('#cart-bar'); b.click(b.qa('.cline [data-act="edit"]')[0]);
  sold.add(lk);
  b.click(`.detail-variant-row[data-id="${cb}"]`);
  assert.ok(b.q('#detail-cta').disabled, '🔴 the edit CTA is disabled while the launcher is sold out');
  b.click('#detail-cta');
  assert.deepEqual(J(b.ui.cart.lines().map((l) => l.key)), [ca], '🔴 the cart is unchanged');
  assert.ok(b.q('#detail-modal').classList.contains('open'), 'the sheet stays open');
});

test('r2 #2: search focus is restored INSIDE the search layer — after its sheet closes and after a result «+»', () => {
  const b = boot('la_musa');
  b.click('[data-act="ssearch"]');
  const inp = b.q('#sq'); inp.value = 'Pork'; inp.dispatchEvent(new b.w.Event('input', { bubbles: true }));
  const open = b.q('#sresults .txtbtn'); const id = open.dataset.id; open.focus();
  b.click(open);
  assert.ok(b.q('#detail-modal').classList.contains('open'));
  b.click('#detail-close');
  const ae = b.w.document.activeElement;
  assert.ok(b.q('#layer').contains(ae) && reach(b, ae) && ae.dataset.id === id, '🔴 closing the sheet returns focus to the search result, not the inert store');
  const add = b.q(`#sresults .qty-add-btn[data-id="${id}"]`); add.focus(); b.click(add);
  const ae2 = b.w.document.activeElement;
  assert.ok(b.q('#layer').contains(ae2) && reach(b, ae2) && ae2.dataset.id === id, '🔴 after «+» focus is on a VISIBLE control of that result in the layer');
  const minus = b.q(`#sresults .qty-ctrl-btn[data-act="dec"][data-id="${id}"]`); assert.ok(reach(b, minus), 'premise: «−» shows'); minus.focus(); b.click(minus);
  assert.equal(b.ui.cart.count(), 0);
  const ae3 = b.w.document.activeElement;
  assert.ok(b.q('#layer').contains(ae3) && reach(b, ae3) && ae3.dataset.id === id, '🔴 «−» to zero hides «−»: focus moves to the VISIBLE «+», never the hidden control');
});

test('r2 #3: keyboard focus survives renderDetail() and render() while the sheet is open', () => {
  const b = boot('x_pizza'); const m = b.ui.menu; const d = configurable(m); const [e1] = m.extrasFor(d.key);
  b.ui.cart.add(d.key, [], 1); b.ui.render();
  b.click(`.txtbtn[data-id="${d.key}"]`);
  const sel = `.detail-extras-row[data-eid="${e1.key}"][data-inst="0"]`;
  b.q(sel).focus(); key(b, 'Enter', sel);
  assert.deepEqual(J(b.ui.cart.lines()[0].ex), [{ [e1.key]: 1 }]);
  assert.equal(b.w.document.activeElement, b.q(sel), '🔴 focus stays on the toggled row after renderDetail()');
  key(b, ' ', b.w.document.activeElement);
  assert.deepEqual(J(b.ui.cart.lines()[0].ex), [{}], '🔴 …so a second Space toggles it back');
  b.q(sel).focus(); b.ui.render();
  assert.equal(b.w.document.activeElement, b.q(sel), '🔴 a full render() with the sheet open keeps focus on the row');
});

test('r2 #4: the cart «+» keeps focus on «+» (the descriptor carries the direction), so the next activation adds, never removes', () => {
  const b = boot('la_musa'); const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf && !b.ui.menu.pickupOnlyCats.has(String(x.cat)));
  b.ui.cart.add(d.key, [], 2); b.ui.render();
  b.click('#cart-bar');
  const plus = b.q(`[data-act="rev"][data-rev="1"][data-key="${d.key}"]`); plus.focus(); b.click(plus);
  assert.equal(b.ui.cart.count(), 3);
  assert.equal(b.w.document.activeElement.dataset.rev, '1', '🔴 focus stays on «+»');
  b.click(b.w.document.activeElement);
  assert.equal(b.ui.cart.count(), 4, '🔴 the next activation adds again');
  const minus = b.q(`[data-act="rev"][data-rev="-1"][data-key="${d.key}"]`); minus.focus(); b.click(minus);
  assert.equal(b.w.document.activeElement.dataset.rev, '-1', 'and «−» keeps «−»');
});

test('r2 #5: the Tab trap counts only VISIBLE controls — a hidden «+» is never an endpoint', () => {
  const b = boot('la_musa');
  b.click('[data-act="ssearch"]');
  const inp = b.q('#sq'); inp.value = 'Pork'; inp.dispatchEvent(new b.w.Event('input', { bubbles: true }));
  const adds = b.qa('#sresults .qty-add-btn'); const lastAdd = adds[adds.length - 1]; const lid = lastAdd.dataset.id; lastAdd.focus(); b.click(lastAdd);
  const L = b.q('#layer');
  assert.equal(reach(b, L.querySelector(`.qty-add-btn[data-id="${lid}"]`)), false, 'premise: the added result\'s «+» is now hidden');
  const f = tabbables(b, L); const first = f[0], last = f[f.length - 1];
  last.focus(); key(b, 'Tab', last);
  assert.equal(b.w.document.activeElement, first, '🔴 Tab from the last VISIBLE control wraps to the first');
  first.focus(); first.dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(b.w.document.activeElement, last, '🔴 Shift+Tab from the first lands on the last VISIBLE control, never a hidden one');
});

// ══ S2b — the checkout UI over the REAL capp-checkout + capp-api against a SCRIPTED server (capp-api.test.mjs's server() pattern) ══
const CK = require('./capp-checkout.js');
const CA = require('./capp-api.js');
const EP = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus' };
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
const FEE = 4500;
// the quote answers from the body actually sent: food = Σ line subtotals; net deliberately ≠ food + fee + tip (+ 7 cents) so a
// UI that adds anything itself shows the wrong Total
const QUOTE = (body) => { const food = body.items.reduce((a, i) => a + Math.round(i.subtotal * 100), 0); const fee = body.mode === 'delivery' ? FEE : 0; const tip = body.tip_cents || 0;
  return { status: 200, json: { ok: true, total_cents: food, net_total_cents: food + fee + tip + 7, ...(body.mode === 'delivery' ? { delivery: { mode: 'delivery', delivery_cents: fee, promo_discount_cents: 0, policy_version: 'p1', from_cents: 3500, max_km: 6 } } : {}) } }; };
function scripted(script) {
  const calls = [];
  const fetch = async (url, init) => {
    const ep = Object.keys(EP).find((k) => url.startsWith(EP[k]));
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ ep, body, url, headers: (init && init.headers) || {} });
    const q = script[ep] || []; const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${ep}`);
    if (r === 'network') throw new TypeError('Failed to fetch');
    const res = typeof r === 'function' ? await r(body, url) : r;   // a function may defer its answer (a late response)
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
  };
  return { fetch, calls, of: (ep) => calls.filter((c) => c.ep === ep) };
}
function fakeTimers() { let id = 0; const q = new Map(); const ms = new Map(); return { ms, setTimeout: (f, d) => { q.set(++id, f); ms.set(id, d); return id; }, clearTimeout: (h) => q.delete(h), setInterval: () => ++id, clearInterval: () => {}, flush() { const fs = [...q.values()]; q.clear(); for (const f of fs) f(); }, get size() { return q.size; } }; }
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 25) => { for (let i = 0; i < n; i++) await tick(); };
const GEO_OK = { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) };
const GEO_NO = { getCurrentPosition: (_ok, no) => no({ code: 1 }) };
let RB = 0;
const INTAKE = 'k_intake_test';   // a test value; production's is deploy-time config, never committed
function bootCo({ script = {}, config = {}, member = null, geo = GEO_OK, search = '', storage = memStore(), priceSheet, rid = 'x_pizza', pre, realSheet = false, mountOpts = {} } = {}) {
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '').replace('</head>', () => `<style>${css}</style></head>`);
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-ui.js', ...(realSheet ? ['capp-confirm-quote.js'] : [])]) w.eval(readFileSync(join(HERE, f), 'utf8'));
  if (pre) pre(w);   // window stubs the page has before the app boots (google.maps, console)
  const srv = scripted({ quoteOrder: [QUOTE], ...script });
  const events = []; const nav = []; const timers = fakeTimers(); const sheets = [];
  const ui = w.CappUI.mount(w.document, { envelope: PROV[rid].envelope, now: NOON, onEvent: (n, d) => events.push([n, d]),
    config: { ...CONFIG[rid], restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: EP, branch: 'Centro', intakeKey: INTAKE, ...config },
    CappCheckout: CK, CappApi: CA, member, geolocation: geo, navigate: (u) => nav.push(u), search, timers,
    priceSheet: realSheet ? undefined : priceSheet || ((o) => { sheets.push(o); return Promise.resolve(false); }),   // realSheet: the ported confirmPriceSheet
    apiOpts: { fetch: srv.fetch, storage, now: () => NOON().getTime(), sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RB++ * 7) % 256), setInterval: () => 0, clearInterval: () => {} }, ...mountOpts });
  const q = (sel) => w.document.querySelector(sel); const qa = (sel) => [...w.document.querySelectorAll(sel)];
  const click = async (sel) => { const el = typeof sel === 'string' ? q(sel) : sel; assert.ok(el, `premise: ${sel} exists`); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); };
  const type = async (sel, v) => { const el = q(sel); assert.ok(el, `premise: ${sel}`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); await settle(); };
  const text = (sel) => { const el = typeof sel === 'string' ? q(sel) : sel; if (!el) return null; const tw = w.document.createTreeWalker(el, 4); const out = []; for (let nd = tw.nextNode(); nd; nd = tw.nextNode()) { const t = nd.nodeValue.replace(/\s+/g, ' ').trim(); if (t) out.push(t); } return out.join(' '); };
  const m = ui.menu;
  const plain = m.dishes.find((x) => !x.launcher && !x.variantOf && !m.pickupOnlyCats.has(String(x.cat)));
  const pickOnly = m.dishes.find((x) => !x.launcher && !x.variantOf && m.pickupOnlyCats.has(String(x.cat)));
  return { w, ui, q, qa, click, type, text, events, nav, timers, srv, storage, sheets, plain, pickOnly };
}
const cta = (b) => b.text('#cta');
// to «Entrega & Pago» with one plain dish (delivery, the device location known)
async function toCheckout(b, extra) { b.ui.cart.inc(b.plain.key); if (extra) extra(b); b.ui.render(); await b.click('#cart-bar'); await b.click('[data-act="checkout"]'); }
// a guest delivery checkout filled up to the payment method
async function filled(b, pay = 'cash') {
  await toCheckout(b);
  await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]');
  await b.type('#f-details', 'Portón negro'); await b.type('#f-name', 'Ana'); await b.type('#f-phone', '9999 0000');
  await b.click(`[data-act="pay"][data-val="${pay}"]`);
}
const L_ = (cents) => 'L ' + (cents % 100 === 0 ? (cents / 100).toLocaleString('en-US') : (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }));

test('S2b checkout: a guest delivery renders the drawn «Entrega & Pago» inside .screen — ASAP only, the map chrome, no footer, no factura', async () => {
  const b = bootCo(); await toCheckout(b);
  assert.ok(b.q('.screen > .flow#flow'), 'the checkout renders inside <div class="screen">');
  assert.equal(b.text('.flowbar h1'), 'Entrega & Pago');
  assert.deepEqual(b.qa('.fsec > h2').map((h) => h.textContent), ['Entrega', 'Tus datos', 'Tu pedido', 'Pago']);
  assert.equal(b.qa('.opts .opt').length, 1, 'ASAP only — no «Programar» card (S4)');
  assert.equal(b.text('.opts .opt'), `Lo antes posible ≈ ${CONFIG.x_pizza.etaDel[0]} min`);
  assert.ok(!/Programar/.test(b.text('.screen')), 'no «Programar» anywhere');
  assert.ok(b.q('button.map .pin') && b.text('button.map .tag') === 'Tu ubicación' && b.text('button.map .adj') === 'Ajustar pin', 'the drawn map chrome');
  assert.ok(b.q('button.map svg.mapsvg') && !b.q('[data-gmap]'), 'no Maps key ⇒ the schematic map, no live map container');
  assert.equal(b.text('[data-act="more"]'), 'Agregar email / notas', 'no «factura / » (no fiscal flag)');
  assert.ok(!/factura|RTN/i.test(b.text('.screen')), 'no factura / RTN UI');
  assert.ok(!/Escribinos al/.test(b.w.document.body.textContent), 'no «¿Problemas con tu pedido? Escribinos al …» footer');
  assert.equal(b.text('.line'), '¿Ya tenés cuenta? Entrá');
  await b.click('[data-act="signin"]');
  assert.deepEqual(J(b.events.at(-1)), ['signin', { ctx: 'checkout' }], '«Entrá» is a host event');
  assert.equal(b.srv.of('quoteOrder').length, 1, 'one quote on entry (the device location is known)');
  assert.equal(b.srv.of('quoteOrder')[0].body.mode, 'delivery');
});

test('S2b gates: every missingStep copy on the CTA, in the prototype order, then «Continuar»', async () => {
  const b = bootCo({ geo: GEO_NO });
  await toCheckout(b, (x) => x.ui.cart.inc(x.pickOnly.key));
  assert.equal(cta(b), 'Quitá los platos solo para Pickup');
  assert.ok(b.q('#cta').disabled);
  assert.ok(b.text('.gate b').endsWith('es solo para Pickup'));
  await b.click('[data-act="rm-po"]');
  assert.equal(b.ui.cart.count(), 1, '«Quitar del pedido» removed the pickup-only line');
  assert.equal(cta(b), 'Ajustá el pin a tu dirección');
  assert.ok(b.text('.locrow').startsWith('Ubicación desactivada'), 'geo denied ⇒ the drawn row');
  assert.equal(b.srv.of('quoteOrder').length, 0, 'no address ⇒ no delivery quote (never a guessed Envío)');
  assert.ok(b.text('.ostot').includes('Envío · según tu dirección'));
  await b.click('[data-act="pin"]');
  assert.ok(b.q('#layer .pinstep'), 'the full-screen pin step');
  assert.ok(!b.q('.simstrip') && !/Simulación/.test(b.text('#layer')), 'the prototype-only strip is dropped');
  b.ui.state.pinDraft = { lat: 15.5, lng: -88 };   // the schematic map has no pan: the draft a live map would report
  await b.click('[data-act="pin-done"]');
  assert.equal(b.text('button.map .tag'), 'Pin en el restaurante');
  assert.equal(cta(b), 'Agregá Detalles adicionales');
  await b.type('#f-details', 'Portón negro');
  assert.equal(cta(b), 'Escribí tu nombre');
  await b.type('#f-name', 'Ana');
  assert.equal(cta(b), 'Escribí tu WhatsApp');
  await b.type('#f-phone', '9999 0000');
  assert.equal(cta(b), 'Elegí cómo pagar');
  await b.click('[data-act="more"]');
  await b.type('#f-email', 'ana@');
  assert.equal(cta(b), 'Revisá tu correo');
  await b.type('#f-email', 'ana@correo.com');
  await b.click('[data-act="pay"][data-val="cash"]');
  assert.equal(cta(b), 'Continuar');
  assert.ok(!b.q('#cta').disabled);
});

test('S2b G0: a closed store — ASAP «No disponible · cerrado» disabled and the CTA gate', async () => {
  const b = bootCo({ config: { hours: Array(7).fill([8, 0, 9, 0]) } });
  await toCheckout(b);
  assert.ok(b.q('.opts .opt').disabled);
  assert.equal(b.text('.opts .opt span'), 'No disponible · cerrado');
  assert.equal(cta(b), 'No disponible · cerrado');
  assert.ok(b.q('#cta').disabled);
});

test('S2b pickup: the branch row; «Confirmar pedido · L x» (cash) / «Pagar · L x» (card) from the QUOTED Total', async () => {
  const b = bootCo(); await toCheckout(b);
  await b.click('[data-act="type"][data-val="pickup"]');
  assert.equal(b.text('.urows .urow b'), `${CONFIG.x_pizza.name} · Centro`);
  assert.equal(b.srv.of('quoteOrder').at(-1).body.mode, 'pickup', 're-quoted on the mode change');
  await b.type('#f-name', 'Ana'); await b.type('#f-phone', '99990000');
  await b.click('[data-act="pay"][data-val="cash"]');
  const net = b.plain.price * 100 + 7;
  assert.equal(cta(b), `Confirmar pedido · ${L_(net)}`);
  await b.click('[data-act="pay"][data-val="online"]');
  assert.equal(cta(b), `Pagar · ${L_(net)}`);
  assert.ok(!b.text('.ostot').includes('Envío'), 'no Envío row for pickup');
});

test('S2b out of zone: the quote refusal ⇒ the drawn gate and the CTA copy; «Recoger en tienda» switches to pickup', async () => {
  const b = bootCo({ script: { quoteOrder: [{ status: 200, json: { ok: false, error: 'outside_delivery_bands' } }, QUOTE] } });
  await toCheckout(b);
  assert.equal(cta(b), 'Fuera de la zona de delivery');
  assert.equal(b.text('.gate b'), `${CONFIG.x_pizza.name} no llega a esta dirección`);
  assert.ok(b.q('button.map.out'));
  await b.click('.gate [data-act="type"][data-val="pickup"]');
  assert.equal(b.ui.state.flow.mode, 'pickup');
  assert.ok(!b.q('.gate'));
});

test('S2b totals: Subtotal / Envío / Total come from the quote — Total = net_total_cents, never net + tip; Propina only > 0', async () => {
  const b = bootCo(); await filled(b);
  const food = b.plain.price * 100;
  const rows = b.qa('.ostot .sumrow').map((r) => b.text(r));
  assert.deepEqual(rows, [`Subtotal ${L_(food)}`, `Envío ${L_(FEE)}`, `Total ${L_(food + FEE + 7)}`], 'no Propina row at 0; Total = the quote');
  assert.ok(b.q('.ostot [data-act="feeinfo"]'), 'the ⓘ shows once the quote carries from / max_km');
  await b.click('[data-act="feeinfo"]');
  assert.ok(b.text('#layer .errsheet p').includes('Desde L 35; zona de entrega hasta 6 km de'), b.text('#layer .errsheet p'));
  await b.click('#layer [data-act="lclose"]');
  await b.click('#cta');
  await b.click('[data-act="tipc"][data-val="40"]');
  assert.equal(b.srv.of('quoteOrder').at(-1).body.tip_cents, 4000, 're-quoted FOR the tip');
  assert.equal(b.text('.tipfoot .sumrow.tot'), `Total ${L_(food + FEE + 4000 + 7)}`, '🔴 the tip quote\'s net — not net + tip');
  await b.click('[data-act="back"]');
  assert.ok(b.qa('.ostot .sumrow').some((r) => b.text(r) === `Propina ${L_(4000)}`), 'Propina shows once > 0');
  assert.equal(b.text('.ostot .sumrow.tot'), `Total ${L_(food + FEE + 4000 + 7)}`);
});

test('S2b tip step: presets from TIP_PRESETS + «Otro»; «Hacer pedido» disabled until a choice AND its quote; «Otro» capped at TIP_MAX', async () => {
  const b = bootCo(); await filled(b); await b.click('#cta');
  assert.ok(b.q('.screen .tipwrap'), 'the tip screen inside .screen');
  assert.deepEqual(b.qa('.tipchips .chip').map((c) => c.textContent), [...CK.TIP_PRESETS.map((v) => (v ? `L ${v}` : 'Sin propina')), 'Otro']);
  assert.ok(b.q('[data-act="tip-place"]').disabled, 'nothing chosen ⇒ disabled');
  assert.equal(b.text('.tipfoot .sumrow'), 'Propina —');
  await b.click('[data-act="tipc"][data-val="0"]');
  assert.ok(!b.q('[data-act="tip-place"]').disabled, '«Sin propina» is a choice');
  assert.equal(b.text('.tipfoot .sumrow'), 'Propina Sin propina');
  await b.click('[data-act="tipc"][data-val="other"]');
  for (const k of ['1', '9', '9', '9', '9']) await b.click(`#layer [data-act="tk"][data-val="${k}"]`);
  assert.equal(b.q('#layer [data-field="tipOther"]').value, '1999', '🔴 the digit past L 2,000 is refused');
  await b.click('#layer [data-act="tk"][data-val="del"]'); await b.click('#layer [data-act="tk"][data-val="del"]');
  await b.click('#layer [data-act="tip-save"]');
  assert.deepEqual(J(b.ui.state.flow.tipChoice), { kind: 'other', lempiras: 19 });
  assert.equal(b.srv.of('quoteOrder').at(-1).body.tip_cents, 1900);
  const net = b.plain.price * 100 + FEE + 1900 + 7;
  assert.equal(b.text('[data-act="tip-place"]'), `Hacer pedido · ${L_(net)}`);
  assert.ok(!b.q('[data-act="tip-place"]').disabled);
});

test('S2b placing: «Realizando pedido…»; «Volver» sends NOTHING; «Se ve bien» → Enviando → createOrder with the displayed Total → the check beat → «placed»', async () => {
  const b = bootCo({ script: { createOrder: [{ status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } }] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="20"]');
  await b.click('[data-act="tip-place"]');
  assert.equal(b.text('#layer .placing h2'), 'Realizando pedido…');
  assert.equal(b.q('#layer [data-act="placing-go"]').textContent, 'Se ve bien (0:02)');
  await b.click('#layer [data-act="placing-back"]');
  assert.equal(b.q('#layer').innerHTML, '');
  b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 0, '🔴 «Volver» = zero requests (the 2 s timer is cancelled too)');
  await b.click('[data-act="tip-place"]');
  b.timers.flush(); await settle();   // the 2 s fill
  assert.ok(b.q('.screen .sending'));
  assert.equal(b.srv.of('createOrder').length, 1);
  const net = b.plain.price * 100 + FEE + 2000 + 7;
  assert.ok(b.text('.sndcard').includes(`Efectivo al entregar · ${L_(net)}`) && b.text('.sndcard').includes('Incluye propina L 20'));
  assert.ok(b.q('#sspin .sok'), 'the check beat');
  assert.equal(b.events.filter((e) => e[0] === 'placed').length, 0, 'the beat runs first');
  b.timers.flush();
  assert.equal(J(b.events.at(-1))[0], 'placed');
  assert.equal(b.events.at(-1)[1].kind, 'placed');
});

test('S2b card: Enviando → redirect — navigate gets the checkout URL, the creds are stashed first', async () => {
  const b = bootCo({ script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }] } });
  await filled(b, 'online'); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.deepEqual(b.nav, ['https://pay.test/1']);
  const stash = JSON.parse(b.storage.getItem('ta_pending_pay'));
  assert.equal(stash.t, 'pt_1', 'the poll token is stashed before the redirect');
  assert.equal(b.srv.of('chargeOnlineOrder')[0].body.payment_method, 'online');
});

test('S2b card RESUMED: an issued checkout at OTHER economics ⇒ Enviando shows the STORED totals, then the stored URL', async () => {
  const storage = memStore(); const t = NOON().getTime(); const id = 'TA261020-190000-OLDOLDOL';
  storage.setItem('capp:rid_a:pending_place', JSON.stringify({ order_id: id, method: 'online', body_sig: 'older-cart', expected_net_cents: 12345, totals: { ready: true, total: 12345, tip: 500 },
    dispatched: 1, unresolved: false, card: true, admitted: false, issued: true, checkout_url: 'https://pay.test/old', checkout_at: t, ts: t, last_send: t, expires_at: t + 3600000 }));
  storage.setItem('ta_pending_pay', JSON.stringify({ order_id: id, t: 'pt_old', order: {}, form: null, ts: t }));
  const b = bootCo({ storage, script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  await filled(b, 'online'); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.deepEqual(b.nav, ['https://pay.test/old']);
  assert.equal(b.srv.of('chargeOnlineOrder').length, 0, 'nothing re-sent');
  assert.ok(b.q('.screen .sending'));
  assert.ok(b.text('.sndcard').includes('Tarjeta · PixelPay · L 123.45'), '🔴 the STORED net, not the current quote: ' + b.text('.sndcard'));
  assert.ok(b.text('.sndcard').includes('Incluye propina L 5'));
});

test('S2b closure: the sheet is «{name} cerró a las …» + «Tu pedido no se envió.» with ONE «Cerrar» — no «Programar», no schedule hint; G0 marked', async () => {
  const b = bootCo({ script: { createOrder: [{ status: 400, json: { error: 'Restaurant closed' } }] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.text('#layer .errsheet h2'), `${CONFIG.x_pizza.name} cerró a las 9:45 p.m.`);
  assert.equal(b.text('#layer .errsheet p'), 'Tu pedido no se envió.');
  assert.deepEqual(b.qa('#layer .errsheet .acts button').map((x) => x.textContent), ['Cerrar']);
  assert.ok(!b.text('#layer').includes(CK.CLOSED_SHEET.scheduleHint) && !/Programar/.test(b.text('#layer')));
  assert.ok(b.q('.screen .tipwrap'), 'over the screen of the tap (P placeTap)');
  await b.click('#layer [data-act="lclose"]');
  assert.ok(b.q('[data-act="tip-place"]').disabled, 'G0: «Hacer pedido» is off');
  await b.click('.topbar [data-act="back"]');
  assert.equal(cta(b), 'No disponible · cerrado', 'G0 closedRefused');
});

test('S2b «Sin conexión»: a network drop ⇒ the drawn sheet; «Reintentar» re-sends the SAME order id', async () => {
  const b = bootCo({ script: { createOrder: ['network', { status: 200, json: { ok: true, order_id: 'X' } }] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.text('#layer .errsheet h2'), 'Sin conexión');
  assert.equal(b.text('#layer .errsheet p'), 'No pudimos enviar tu pedido. Revisá tu conexión e intentá de nuevo; tu pedido está intacto.');
  assert.deepEqual(b.qa('#layer .errsheet .acts button').map((x) => x.textContent), ['Reintentar', 'Cerrar']);
  assert.ok(b.q('.screen .tipwrap'), 'back where the customer tapped');
  await b.click('#layer [data-act="err-retry"]');
  const [a, c] = b.srv.of('createOrder');
  assert.equal(c.body.order_id, a.body.order_id, '🔴 the same placement identity');
  assert.ok(b.q('#sspin .sok'));
});

test('S2b existing order: the Q9 recovery sheet — copy, «Referencia #ABCD», NO «Escribir a la tienda», «Volver al pedido»', async () => {
  const b = bootCo({ script: { createOrder: [{ status: 409, json: { error: 'order_exists', reason: 'live' } }] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  const id = b.srv.of('createOrder')[0].body.order_id;
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'Necesitamos revisar tu pedido');
  assert.ok(b.q('#layer .errsheet .icon.calm'));
  assert.equal(b.text('#layer .errsheet p'), 'Ya existe un pedido con este número, así que no lo enviamos de nuevo para no duplicarlo. Escríbenos y lo revisamos.');
  assert.equal(b.text('#layer .errsheet p.note'), `Referencia #${id.slice(-4).toUpperCase()}`);
  assert.ok(!/Escribir a la tienda/.test(b.text('#layer')) && !b.q('#layer [data-act="wa"]'));
  assert.deepEqual(b.qa('#layer .errsheet .acts button').map((x) => [x.className, x.textContent]), [['btn2 wide', 'Volver al pedido']]);
  await b.click('#layer [data-act="lclose"]');
  assert.equal(b.q('#layer').innerHTML, '');
});

test('S2b «El precio cambió»: the ported sheet is passed through place({ sheet }) with the DISPLAYED Total; agreed ⇒ the SAME id re-sent', async () => {
  const sheets = [];
  const b = bootCo({ priceSheet: (o) => { sheets.push(o); return Promise.resolve(true); }, script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 99900 } }, { status: 200, json: { ok: true, order_id: 'X' } }] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.deepEqual(sheets, [{ oldCents: b.plain.price * 100 + FEE + 7, newCents: 99900 }]);
  const [a, c] = b.srv.of('createOrder');
  assert.equal(c.body.order_id, a.body.order_id);
});

const RET = (pay, id = 'TA261020-190500-ABCDWXYZ') => `?pay=${pay}&order=${id}&t=pt_9`;
test('S2b ?pay= return: paid ⇒ the check beat then «placed»; verifying ⇒ Enviando with the EXACT confirming line', async () => {
  const p = bootCo({ search: RET('complete'), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'paid', tracking_token: 'tt' } }] } });
  await p.ui.returning; await settle();
  assert.ok(p.q('.screen .sending') && p.q('#sspin .sok'));
  p.timers.flush();
  assert.equal(p.events.at(-1)[0], 'placed');
  const v = bootCo({ search: RET('complete'), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'verifying' } }] } });
  await v.ui.returning; await settle();
  assert.ok(v.q('.screen .sending'));
  assert.equal(v.text('.shint'), 'Estamos confirmando tu pago con el banco.');
  assert.equal(v.q('#layer').innerHTML, '', 'no sheet, no button');
  assert.equal(v.q('.sndcard button'), null);
});

test('S2b ?pay= return: closed_refunded ⇒ the Q9 refund sheet (name + amount, ONE «Volver al inicio» → «home»)', async () => {
  const b = bootCo({ search: RET('complete'), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'closed_refunded', refunded_total_cents: 48500 } }] } });
  await b.ui.returning; await settle();
  assert.equal(b.text('#layer .errsheet h2'), 'Te reembolsamos tu pago');
  assert.ok(b.q('#layer .errsheet .icon.ok'));
  assert.equal(b.text('#layer .errsheet p'), `${CONFIG.x_pizza.name} ya había cerrado cuando se confirmó tu pago. Te devolvimos el total completo, L 485; no se te cobrará.`);
  assert.deepEqual(b.qa('#layer .errsheet .acts button').map((x) => [x.className, x.textContent]), [['primary', 'Volver al inicio']]);
  await b.click('#layer [data-act="home"]');
  assert.deepEqual(b.events.at(-1), ['home', undefined]);
});

// a REAL card send (the app's own writer) up to the PixelPay redirect: the record is issued and the order body stashed
const CHECKOUT = { status: 200, json: { ok: true, checkout_url: 'https://pay.example/c', poll_token: 'pt_1' } };
async function cardRedirected(storage) {
  const a = bootCo({ storage, script: { chargeOnlineOrder: [CHECKOUT] } });
  await placeVia(a, 'online');
  assert.equal(a.nav.length, 1, 'premise: redirected to the hosted checkout');
  const sent = a.srv.of('chargeOnlineOrder')[0].body;
  const snap = J(a.ui.cart.snapshot());
  a.ui.destroy();
  return { id: sent.order_id, sent, snap };
}
// the hosted-checkout return on the SAME storage (a new page), the host restoring the cart as it does
async function returned(storage, search, script, snap) {
  const r = bootCo({ storage, search, script });
  if (snap) r.ui.restore(snap);
  await r.ui.returning; await settle();
  return r;
}
const writes = (b) => b.srv.of('createOrder').length + b.srv.of('chargeOnlineOrder').length;
const placeRec = (st) => JSON.parse(st.getItem('capp:rid_a:pending_place') || 'null');

test('S2b ?pay= return: a DEFINITIVE cancel with the checkout restored ⇒ «Pago no completado»; «Usar otra tarjeta» re-opens the placing card and sends the restored order (P2-4)', async () => {
  const storage = memStore();
  const { id, sent, snap } = await cardRedirected(storage);
  const c = await returned(storage, RET('cancel', id), { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }], chargeOnlineOrder: [CHECKOUT] }, snap);
  assert.equal(c.text('#layer .errsheet h2'), 'Pago no completado');
  assert.equal(c.text('#layer .errsheet p'), 'Tu banco no autorizó el pago. Podés intentar con otra tarjeta o pagar en efectivo; tu pedido está intacto.');
  assert.deepEqual(c.qa('#layer .errsheet .acts button').map((x) => x.textContent), ['Pagar en efectivo', 'Usar otra tarjeta']);
  const f = c.ui.state.flow;
  assert.deepEqual(J([f.mode, f.pin, f.name, f.details, f.pay, f.tipChoice !== null]),
    [sent.order_type, { lat: sent.lat, lng: sent.lng, confirmed: true }, sent.customer_name, sent.address_details, 'online', true], '🔴 the whole checkout context is back');
  await c.click('#layer [data-act="err-card"]'); await settle();
  assert.equal(c.q('#layer .sheet').getAttribute('aria-label'), 'Realizando pedido', '🔴 «Usar otra tarjeta» never silently does nothing');
  await c.click('#layer [data-act="placing-go"]');
  const again = c.srv.of('chargeOnlineOrder');
  assert.equal(again.length, 1);
  assert.notEqual(again[0].body.order_id, id, 'the cancelled order was cleared: a NEW placement');
  assert.deepEqual([again[0].body.lat, again[0].body.lng, again[0].body.customer_name, again[0].body.customer_phone], [sent.lat, sent.lng, sent.customer_name, sent.customer_phone]);
  // «Pagar en efectivo» stays the host event (ruling pending)
  const k = await returned(memStore(), RET('cancel', id), { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] });
  assert.equal(k.q('#layer [data-act="err-cash"]'), null, 'no context here ⇒ U3');
  const storage2 = memStore(); const r2 = await cardRedirected(storage2);
  const m = await returned(storage2, RET('cancel', r2.id), { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] }, r2.snap);
  await m.click('#layer [data-act="err-cash"]');
  assert.equal(m.events.at(-1)[0], 'pay-cash');
});

test('S2b ?pay= return: a definitive cancel WITHOUT the checkout context ⇒ the generic held state (U3), never a «Usar otra tarjeta» that does nothing (P2-4)', async () => {
  const c = await returned(memStore(), RET('cancel'), { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] });
  assert.equal(c.text('#layer .errsheet h2'), 'No pudimos enviar tu pedido');
  assert.equal(c.q('#layer [data-act="err-card"]'), null);
});

test('S2b ?pay= return: a 403 poll ⇒ the recovery sheet', async () => {
  const f = await returned(memStore(), RET('complete', 'TA261020-190500-QRST'), { paymentStatus: [{ status: 403, json: {} }] });
  assert.equal(f.text('#layer .errsheet h2'), 'Necesitamos revisar tu pedido');
  assert.equal(f.text('#layer .errsheet p.note'), 'Referencia #QRST');
});

test('S2b ?pay= return: the server still calls it PENDING ⇒ «Tu pago todavía está en verificación»; dismissed, re-tried (card AND cash) or reloaded the order stays LOCKED — zero writes, the same identity; a definitive poll releases it (P1-1)', async () => {
  const storage = memStore();
  const { id, snap } = await cardRedirected(storage);
  const PEND = { status: 200, json: { ok: true, state: 'pending' } };
  const h = await returned(storage, RET('cancel', id), { paymentStatus: [PEND] }, snap);
  assert.equal(h.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación', '🔴 never «Pago no completado» while the server says pending');
  assert.ok(h.q('#layer .errsheet .icon.calm svg circle'), 'the calm tint + the clock (#mk-pending)');
  assert.equal(h.text('#layer .errsheet p'), 'Estamos confirmando tu pago con el banco. No hace falta pagar de nuevo; esperá un momento mientras termina.');
  assert.deepEqual(h.qa('#layer .errsheet .acts button').map((x) => [x.className, x.textContent]), [['primary', 'Volver al pedido']]);
  await h.click('#layer [data-act="lclose"]');
  assert.ok(h.q('.screen .flow'), '«Volver al pedido» lands on «Entrega & Pago»');
  assert.deepEqual([placeRec(storage).order_id, placeRec(storage).pay_pending], [id, true], 'the lock is on the record');
  const polls0 = h.srv.of('paymentStatus').length;
  // the card again, through the real buttons
  await h.click('#cta'); await h.click('[data-act="tip-place"]'); await h.click('#layer [data-act="placing-go"]');
  assert.equal(writes(h), 0, '🔴 zero chargeOnlineOrder / createOrder while pending');
  assert.equal(h.nav.length, 0, '🔴 the lock is recovery only — never back into the checkout');
  assert.equal(h.srv.of('paymentStatus').length, polls0 + 1, 'recovery only: one poll');
  assert.equal(h.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación');
  // cash on the same page
  await h.click('#layer [data-act="lclose"]');
  await h.click('[data-act="pay"][data-val="cash"]'); await h.click('#cta'); await h.click('[data-act="tip-place"]'); await h.click('#layer [data-act="placing-go"]');
  assert.equal(writes(h), 0, '🔴 cash is refused too');
  h.ui.destroy();
  // a reload (no ?pay=) keeps the lock
  const r = bootCo({ storage, script: { paymentStatus: [PEND] } }); r.ui.restore(snap);
  await placeVia(r, 'online');
  assert.equal(writes(r), 0, '🔴 a reload never re-opens payment');
  assert.equal(r.nav.length, 0, '🔴 a reload keeps the pending lock — recovery only, never back into the checkout');
  assert.equal(r.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación');
  assert.deepEqual([placeRec(storage).order_id, placeRec(storage).pay_pending], [id, true], 'the identity is retained');
  r.ui.destroy();
  // the bank answers: a definitive cancel releases it (the authoritative «Pago no completado»)
  const d = bootCo({ storage, script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] } }); d.ui.restore(snap);
  await placeVia(d, 'online');
  assert.equal(writes(d), 0);
  assert.equal(d.text('#layer .errsheet h2'), 'Pago no completado');
  assert.equal(placeRec(storage), null, 'released');
});

test('S2b ?pay=cancel WITHOUT usable credentials ⇒ the pending held state, locked, zero server calls — never «Tu banco no autorizó» (P2-5)', async () => {
  const storage = memStore();
  const { id, snap } = await cardRedirected(storage);
  storage.removeItem('ta_pending_pay');   // the stash is gone (another tab, cleared storage)
  const c = await returned(storage, '?pay=cancel', {}, snap);
  assert.equal(c.srv.calls.length, 0, 'zero server calls');
  assert.equal(c.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación');
  assert.ok(!/no autorizó/.test(c.text('#layer') || ''));
  assert.deepEqual([placeRec(storage).order_id, placeRec(storage).pay_pending], [id, true], 'locked on its record');
  const n = await returned(memStore(), '?pay=cancel', {});
  assert.equal(n.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación', 'no record, no creds: still no rejection copy');
});

// the owner-approved held-states mockup (MOCKUP-capp-S2b-held-states.html)
const sheetOf = (b) => ({ label: b.q('#layer .sheet').getAttribute('aria-label'), h2: b.text('#layer .errsheet h2'), p: b.text('#layer .errsheet p'),
  icon: b.q('#layer .errsheet .icon').className, clock: !!b.q('#layer .errsheet .icon svg circle'), acts: b.qa('#layer .errsheet .acts button').map((x) => [x.className, x.textContent, x.dataset.act]) });
async function placeVia(b, pay = 'cash') {
  await filled(b, pay); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
}
test('S2b #mk-paused: a 423 ordering_paused ⇒ «{name} no está recibiendo pedidos…», amber clock, ONE «Entendido» that keeps the checkout intact', async () => {
  const b = bootCo({ script: { createOrder: [{ status: 423, json: { error: 'ordering_paused' } }] } });
  await placeVia(b);
  assert.deepEqual(sheetOf(b), { label: `${CONFIG.x_pizza.name} no está recibiendo pedidos en este momento`, h2: `${CONFIG.x_pizza.name} no está recibiendo pedidos en este momento`,
    p: 'Tu pedido no se envió ni se cobró nada; está intacto para que lo intentés en unos minutos.', icon: 'icon warn', clock: true, acts: [['primary', 'Entendido', 'lclose']] });
  const lines = J(b.ui.cart.lines());
  await b.click('#layer [data-act="lclose"]');
  assert.equal(b.q('#layer').innerHTML, '');
  assert.deepEqual(J(b.ui.cart.lines()), lines, 'the cart is untouched');
  assert.ok(b.q('.screen .flow') && !b.q('.screen .tipwrap'), 'over «Entrega & Pago», as drawn');
  assert.equal(b.q('#f-details').value, 'Portón negro', 'the details are untouched');
});
test('S2b #mk-generic: an unexpected refusal, a card checkout not opened, a payment reference not saved ⇒ ONE «No pudimos enviar tu pedido» (red ✕, «Reintentar» + «Cerrar»)', async () => {
  const G = { label: 'No pudimos enviar tu pedido', h2: 'No pudimos enviar tu pedido', p: 'Intentá de nuevo en un momento; tu pedido está intacto.', icon: 'icon', clock: false,
    acts: [['primary', 'Reintentar', 'err-retry'], ['btn2 wide', 'Cerrar', 'lclose']] };
  // the REAL refusal shapes: badRequest (index.js:241, a validation detail :629) and unauthorized (index.js:237)
  const e = bootCo({ script: { createOrder: [{ status: 400, json: { error: 'Bad Request', detail: 'customer_phone must be 8–15 digits' } }] } });
  await placeVia(e);
  assert.deepEqual(sheetOf(e), G, 'kind error (400 Bad Request)');
  const u = bootCo({ script: { createOrder: [{ status: 401, json: { error: 'Unauthorized', detail: 'invalid bearer token' } }] } });
  await placeVia(u);
  assert.deepEqual(sheetOf(u), G, 'kind error (401 Unauthorized)');
  assert.ok(e.q('#f-details') && !e.q('.screen .tipwrap'), 'over «Entrega & Pago», as drawn');
  const n = bootCo({ script: { chargeOnlineOrder: [{ status: 500, json: { error: 'Payment not configured' } }] } });
  await placeVia(n, 'online');
  assert.deepEqual(sheetOf(n), G, 'kind payment_not_completed');
  assert.equal(n.nav.length, 0);
  const store = memStore(); const setItem = store.setItem; store.setItem = (k, v) => { if (k === 'ta_pending_pay') throw new Error('quota'); return setItem(k, v); };
  const s = bootCo({ storage: store, script: { chargeOnlineOrder: [{ status: 200, json: { ok: true, checkout_url: 'https://pay.example/c', poll_token: 'pt_1' } }] } });
  await placeVia(s, 'online');
  assert.deepEqual(sheetOf(s), G, 'kind stash_failed');
  assert.equal(s.nav.length, 0, '🔴 no redirect without the stored reference');
  await e.click('#layer [data-act="lclose"]');
  assert.equal(e.q('#layer').innerHTML, '', '«Cerrar» closes');
});
test('S2b #mk-generic «Reintentar» re-sends the SAME order id', async () => {
  const b = bootCo({ script: { createOrder: [{ status: 400, json: { error: 'Bad Request', detail: 'customer_phone must be 8–15 digits' } }, { status: 200, json: { ok: true, order_id: 'X' } }] } });
  await placeVia(b);
  await b.click('#layer [data-act="err-retry"]'); await settle();
  const [a, c] = b.srv.of('createOrder');
  assert.ok(c, 'a second send');
  assert.equal(c.body.order_id, a.body.order_id);
});

test('S2b sheets are dialogs: the screen is inert behind them, focus moves in, Tab stays in; Escape never dismisses the refund sheet', async () => {
  const b = bootCo({ script: { createOrder: ['network'] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.ok(b.q('.screen').hasAttribute('inert') && !b.q('#layer').hasAttribute('inert'));
  assert.ok(b.q('#layer').contains(b.w.document.activeElement), 'focus moved into the sheet');
  const f = tabbables(b, b.q('#layer')); f.at(-1).focus(); key(b, 'Tab', f.at(-1));
  assert.equal(b.w.document.activeElement, f[0], 'Tab wraps inside');
  key(b, 'Escape', f[0]);
  assert.equal(b.q('#layer').innerHTML, '', 'Escape closes «Sin conexión» (it has «Cerrar»)');
  const r = bootCo({ search: RET('complete'), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'closed_refunded', refunded_total_cents: 100 } }] } });
  await r.ui.returning; await settle();
  key(r, 'Escape', r.q('#layer button'));
  assert.ok(r.q('#layer .errsheet'), 'the refund sheet stays until «Volver al inicio»');
});

test('S2b 426: a refused FIRST dispatch is the shared self-update path (no sheet here); a 426 after an admission keeps the identity ⇒ the recovery sheet', async () => {
  const a = bootCo({ script: { createOrder: [{ status: 426, json: { error: 'update_required' } }] } });
  await filled(a); await a.click('#cta'); await a.click('[data-act="tipc"][data-val="0"]');
  await a.click('[data-act="tip-place"]'); await a.click('#layer [data-act="placing-go"]');
  assert.equal(a.q('#layer').innerHTML, '', 'no S2b sheet for update_required');
  assert.ok(a.q('.screen .tipwrap'));
  const b = bootCo({ script: { chargeOnlineOrder: [{ status: 202, json: { ok: true, status: 'in_progress' } }, { status: 426, json: {} }] } });
  await filled(b, 'online'); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.text('#layer .errsheet h2'), 'Necesitamos revisar tu pedido', 'the kept identity (update_required: true) shows the recovery sheet as drawn');
  assert.equal(b.nav.length, 0);
});

test('S2b map: a configured Maps key ⇒ a live-map container inside the drawn chrome + ONE loader script; no key ⇒ nothing loads', async () => {
  const b = bootCo({ config: { mapsKey: 'k_test' } }); await toCheckout(b);
  assert.ok(b.q('button.map [data-gmap="preview"]') && b.q('button.map .pin') && b.q('button.map .adj'), 'the container sits inside the drawn chrome');
  const scripts = () => b.qa('script[src^="https://maps.googleapis.com/maps/api/js"]');
  assert.equal(scripts().length, 1);
  assert.ok(scripts()[0].src.includes('key=k_test'));
  await b.click('[data-act="pin"]');
  assert.ok(b.q('#layer .pinstep [data-gmap="pin"]'));
  assert.equal(scripts().length, 1, 'loaded once');
  const n = bootCo(); await toCheckout(n);
  assert.equal(n.qa('script[src*="maps.googleapis.com"]').length, 0);
});

test('S2b r2: «Entrega & Pago» has NO back control (P:1884-1885) — only the tip step has «Volver a Entrega y Pago»', async () => {
  const b = bootCo(); await filled(b);
  assert.equal(b.q('.flowbar').querySelectorAll('button').length, 0, '🔴 the checkout flowbar has no button');
  assert.equal(b.text('.flowbar'), 'Entrega & Pago');
  await b.click('#cta');
  assert.equal(b.q('.topbar [data-act="back"]').getAttribute('aria-label'), 'Volver a Entrega y Pago');
});

test('S2b r2: the pin toast lives the prototype\'s 2.2 s (P toast() :1377) and is gone before a sheet opens', async () => {
  const b = bootCo({ script: { createOrder: ['network'] } }); await toCheckout(b);
  await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]');
  assert.equal(b.text('#toast'), 'Pin confirmado');
  assert.ok(b.q('#toast').classList.contains('on'));
  const ids = [...b.timers.ms.entries()].filter(([, d]) => d === 2200);
  assert.equal(ids.length, 1, '🔴 the toast timer is 2200 ms');
  b.timers.flush();
  assert.ok(!b.q('#toast').classList.contains('on'), 'the toast is hidden after its lifetime');
  await b.type('#f-details', 'Portón'); await b.type('#f-name', 'Ana'); await b.type('#f-phone', '99990000');
  await b.click('[data-act="pay"][data-val="cash"]'); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
  await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.text('#layer .errsheet h2'), 'Sin conexión');
  assert.ok(!b.q('#toast').classList.contains('on'), '🔴 no toast over the open sheet');
});

const popped = async () => { await new Promise((r) => setTimeout(r, 30)); await settle(); };   // jsdom fires popstate from a timer task
test('S2b r2: device back (history) — tip → «Entrega & Pago» → the cart → the menu; the tip «←» walks the same history', async () => {
  const b = bootCo(); const H = b.w.history;
  b.ui.cart.inc(b.plain.key); b.ui.render();
  const n0 = H.length;
  await b.click('#cart-bar');
  assert.equal(H.length, n0 + 1, 'the cart is a back step (pushState)');
  await b.click('[data-act="checkout"]');
  assert.equal(H.length, n0 + 2);
  await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]');
  await b.type('#f-details', 'Portón'); await b.type('#f-name', 'Ana'); await b.type('#f-phone', '99990000'); await b.click('[data-act="pay"][data-val="cash"]');
  await b.click('#cta');
  assert.ok(b.q('.tipwrap')); assert.equal(H.length, n0 + 3);
  await b.click('.topbar [data-act="back"]'); await popped();   // its history.back() lands (the skipped popstate)
  assert.ok(b.q('.screen .flow'), 'the tip «←» → «Entrega & Pago»');
  assert.equal(H.length >= n0 + 3 && H.state.ca, 2, 'the history is back in step');
  assert.equal(b.ui.state.flow.name, 'Ana', 'every field survives');
  await b.click('#cta'); assert.ok(b.q('.tipwrap'));
  H.back(); await popped();
  assert.ok(b.q('.screen .flow'), '🔴 device back from the tip step → «Entrega & Pago»');
  H.back(); await popped();
  assert.ok(b.q('.screen .storewrap') && b.q('#layer .sheet[aria-label="Tu pedido"]'), '🔴 device back from «Entrega & Pago» → the store with the cart open');
  H.back(); await popped();
  assert.ok(b.q('.screen .storewrap') && !b.q('#layer .sheet'), '🔴 device back from the cart → the menu');
  await b.click('#cart-bar'); await b.click('[data-act="cartclose"]');
  assert.ok(!b.q('#layer .sheet'), 'the cart X is a back step too');
});

test('S2b r2: «Agregar más platos» → the menu (history walked back); a device back during «Realizando pedido…» = «Volver» (nothing sent)', async () => {
  const b = bootCo(); await toCheckout(b);
  await b.click('[data-act="sumtoggle"]'); await b.click('[data-act="addmore"]');
  assert.ok(b.q('.screen .storewrap') && !b.q('#layer .sheet'));
  assert.equal(b.ui.state.stack.length, 0);
  const c = bootCo({ script: { createOrder: [{ status: 200, json: { ok: true, order_id: 'X' } }] } });
  await filled(c); await c.click('#cta'); await c.click('[data-act="tipc"][data-val="0"]'); await c.click('[data-act="tip-place"]');
  assert.ok(c.q('#layer .placing'));
  c.w.history.back(); await popped();
  assert.ok(!c.q('#layer .placing'));
  c.timers.flush(); await settle();
  assert.equal(c.srv.of('createOrder').length, 0, '🔴 nothing sent');
});

// ── OWNER 2026-10-21 (DECISIONS:2072): only a location-DENIED customer must confirm the pin; a detected GPS fix is a real location ──
test('S2b pin gate: a DETECTED GPS fix passes the pin gate with NO pin step (P flow); the body carries the fix with pin_confirmed:true', async () => {
  const b = bootCo({ geo: GEO_OK, script: { createOrder: [{ status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } }] } });
  await toCheckout(b);
  assert.equal(cta(b), 'Agregá Detalles adicionales', '🔴 GPS detected ⇒ the CTA as in P (no «Ajustá el pin a tu dirección»)');
  assert.equal(b.text('button.map .tag'), 'Tu ubicación', 'the drawn tag: not «Pin confirmado» until the customer confirms on the pin step (P f.pinOk)');
  assert.ok(b.text('.urow').includes('Ajustá el pin a tu dirección'), 'the drawn row sub-line, as in P');
  await b.type('#f-details', 'Portón negro'); await b.type('#f-name', 'Ana'); await b.type('#f-phone', '9999 0000');
  await b.click('[data-act="pay"][data-val="cash"]');
  assert.equal(cta(b), 'Continuar', 'ready with no pin step');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  b.timers.flush(); await settle();
  const sent = b.srv.of('createOrder')[0].body;
  assert.deepEqual([sent.lat, sent.lng, sent.pin_confirmed], [15.52, -88.04, true], '🔴 the device fix, truthfully pin_confirmed');
  assert.equal(b.srv.of('quoteOrder').at(-1).body.pin.confirmed, true, 'the quote carries the same confirmed fix');
});

test('S2b pin gate: geolocation DENIED (or failed) ⇒ «Ajustá el pin a tu dirección» until the pin step is confirmed', async () => {
  for (const geo of [GEO_NO, { getCurrentPosition: (_ok, no) => no({ code: 3 }) }, null]) {
    const b = bootCo({ geo });
    await toCheckout(b);
    assert.equal(cta(b), 'Ajustá el pin a tu dirección', `🔴 ${geo ? 'denied/failed' : 'no geolocation'} ⇒ the pin gate`);
    await b.click('[data-act="pin"]');
    b.ui.state.pinDraft = { lat: 15.5, lng: -88 };
    await b.click('[data-act="pin-done"]');
    assert.equal(cta(b), 'Agregá Detalles adicionales', 'confirmed on the pin step ⇒ the next gate');
  }
});

// ── S2b r1 (Codex) ──
// a minimal google.maps the page would load: each Map keeps its own centre; `pan` moves it WITHOUT an idle (as a drag in flight)
function gmaps(w, gc) {
  const maps = [];
  class Map { constructor(el, o) { this.el = el; this.c = { ...o.center }; this.l = {}; maps.push(this); } addListener(n, f) { this.l[n] = f; }
    getCenter() { const c = this.c; return { lat: () => c.lat, lng: () => c.lng }; } pan(lat, lng) { this.c = { lat, lng }; } idle() { if (this.l.idle) this.l.idle(); } }
  w.google = { maps: { Map } };
  if (gc) w.google.maps.Geocoder = class { geocode(req, cb) { gc.push({ at: J(req.location), reply: (results, status = 'OK') => cb(results, status) }); } };   // S2b-geo: the test releases each reply
  return maps;
}
test('S2b r1 P1-2: «Listo» confirms the ACTIVE map\'s centre at the tap (no idle yet); an obsolete map\'s late idle never moves the pin or the preview', async () => {
  let maps;
  const b = bootCo({ config: { mapsKey: 'k_test' }, pre: (w) => { maps = gmaps(w); } });
  await toCheckout(b); await settle();
  await b.click('[data-act="pin"]'); await settle();
  const m = maps.filter((x) => x.el.dataset.gmap === 'pin').at(-1); assert.ok(m, 'premise: the pin-step map');
  m.pan(15.54, -88.06);   // dragged; Google has not fired idle yet
  await b.click('[data-act="pin-done"]'); await settle();
  assert.deepEqual(J(b.ui.state.flow.pin), { lat: 15.54, lng: -88.06, confirmed: true }, '🔴 the visible centre is the confirmed pin');
  assert.deepEqual(J(b.srv.of('quoteOrder').at(-1).body.pin), { lat: 15.54, lng: -88.06, confirmed: true }, '🔴 …and the quoted one');
  m.pan(15.6, -88.1); m.idle();   // the closed map's late idle
  b.ui.render(); await settle();   // a fresh preview map is centred from the app's state
  assert.deepEqual(J(b.ui.state.flow.pin), { lat: 15.54, lng: -88.06, confirmed: true });
  const pv = maps.filter((x) => x.el.dataset.gmap === 'preview').at(-1);
  assert.deepEqual(J(pv.c), { lat: 15.54, lng: -88.06 }, '🔴 the preview is centred on the confirmed pin, not the stale draft');
  // a reopened step: the OLD map's idle is dropped, the new map's centre is what «Listo» takes
  await b.click('[data-act="pin"]'); await settle();
  const m2 = maps.filter((x) => x.el.dataset.gmap === 'pin').at(-1); assert.notEqual(m2, m);
  m.pan(15.7, -88.2); m.idle();
  await b.click('[data-act="pin-done"]'); await settle();
  assert.deepEqual(J(b.ui.state.flow.pin), { lat: 15.54, lng: -88.06, confirmed: true });
});

test('S2b r1 P2-3: destroy() during «Realizando pedido…» cancels the placement — zero createOrder, no render, no host event', async () => {
  const b = bootCo();
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'Realizando pedido', 'premise: the 2 s auto-send is armed');
  const ev0 = b.events.length;
  b.ui.destroy();
  assert.equal(b.q('#layer').innerHTML, '', 'teardown takes every sheet off the page');
  const html = b.q('#app').innerHTML;
  b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 0, '🔴 nothing is sent after teardown');
  assert.equal(b.events.length, ev0);
  assert.equal(b.q('#app').innerHTML, html, 'no render after teardown');
});

test('S2b r1 P2-6: failed quotes are never a dead end — the generic held state, «Reintentar» re-asks the SAME state; connectivity back ⇒ a price', async () => {
  const b = bootCo({ script: { quoteOrder: ['network', 'network', 'network', 'network', 'network', 'network', QUOTE] } });
  await toCheckout(b); await settle();
  assert.equal(b.text('#layer .errsheet h2'), 'No pudimos enviar tu pedido', 'the failure is visible');
  assert.deepEqual(b.qa('#layer .errsheet .acts button').map((x) => [x.textContent, x.dataset.act]), [['Reintentar', 'err-requote'], ['Cerrar', 'lclose']]);
  let n = b.srv.of('quoteOrder').length;
  for (let i = 0; i < 8 && !/L /.test(b.text('.sumrow.tot') || ''); i++) {
    await b.click('#layer [data-act="err-requote"]'); await settle();
    assert.ok(b.srv.of('quoteOrder').length > n, '🔴 «Reintentar» asks again'); n = b.srv.of('quoteOrder').length;
  }
  assert.match(b.text('.sumrow.tot'), /L /, '🔴 the price arrives once the network is back');
  assert.equal(b.q('#layer').innerHTML, '');
  // a closed sheet waits: re-renders of the same failed state do not loop requests
  const c = bootCo({ script: { quoteOrder: ['network'] } });
  await toCheckout(c); await settle();
  const k = c.srv.of('quoteOrder').length;
  await c.click('#layer [data-act="lclose"]'); c.ui.render(); c.ui.render(); await settle();
  assert.equal(c.srv.of('quoteOrder').length, k, 'no request loop on the same failed state');
});

test('S2b r1 P2-7: an accepted price increase ⇒ «Enviando» shows the ceiling actually sent', async () => {
  const b = bootCo({ priceSheet: () => Promise.resolve(true), script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 99900 } }, { status: 200, json: { ok: true, order_id: 'X' } }] } });
  await placeVia(b);
  const [, second] = b.srv.of('createOrder');
  assert.ok(second, 'premise: the agreed re-send');
  assert.ok(b.q('.screen .sending'));
  assert.match(b.text('.sndcard'), /L 999/, '🔴 the displayed Total = the ceiling sent');
});

test('S2b r1 intake key: createOrder and chargeOnlineOrder carry it, the quote and the poll do not; missing ⇒ a config error, «Hacer pedido» disabled, nothing sent, the record clean', async () => {
  const b = bootCo(); await placeVia(b);
  const AUTH = `Bearer ${INTAKE}`;
  assert.equal(b.srv.of('createOrder')[0].headers.Authorization, AUTH);
  assert.equal(b.srv.of('quoteOrder')[0].headers.Authorization, undefined, 'the public quote gets nothing extra');
  const o = bootCo({ script: { chargeOnlineOrder: [CHECKOUT] } }); await placeVia(o, 'online');
  assert.equal(o.srv.of('chargeOnlineOrder')[0].headers.Authorization, AUTH);
  const errs = [];
  const n = bootCo({ config: { intakeKey: undefined }, pre: (w) => { w.console.error = (...a) => errs.push(a.join(' ')); } });
  assert.deepEqual(errs, ['capp: config error — intakeKey missing; placing disabled']);
  await filled(n); await n.click('#cta'); await n.click('[data-act="tipc"][data-val="0"]');
  assert.ok(n.q('[data-act="tip-place"]').disabled, '🔴 «Hacer pedido» stays disabled');
  n.ui.state.layerKind = null; await n.click('[data-act="tip-place"]'); n.timers.flush(); await settle();
  assert.equal(n.srv.of('createOrder').length + n.srv.of('chargeOnlineOrder').length, 0, '🔴 nothing is sent');
  assert.equal(n.storage.getItem('capp:rid_a:pending_place'), null, 'no dispatch ⇒ the record stays clean');
  const pk = bootCo({ config: { intakeKey: '' } }); await toCheckout(pk); await pk.click('[data-act="type"][data-val="pickup"]'); await settle();
  await pk.type('#f-name', 'Ana'); await pk.type('#f-phone', '9999 0000'); await pk.click('[data-act="pay"][data-val="cash"]'); await settle();
  assert.ok(pk.q('#cta').disabled, 'the pickup CTA (it places) is disabled too');
});

// ── S2b r2 (Codex) ──
test('S2b r2 P1-1: the lock write FAILS ⇒ still locked in this page (dismiss → card and cash: zero writes); a reload derives it from the card record — one poll first, zero sends', async () => {
  const storage = memStore();
  const { id, snap } = await cardRedirected(storage);
  const set = storage.setItem; let failPlace = false;
  storage.setItem = (k, v) => { if (failPlace && k === 'capp:rid_a:pending_place') throw new Error('quota'); return set(k, v); };
  failPlace = true;
  const PEND = { status: 200, json: { ok: true, state: 'pending' } };
  const h = await returned(storage, RET('cancel', id), { paymentStatus: [PEND] }, snap);
  assert.equal(h.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación');
  assert.notEqual(placeRec(storage).pay_pending, true, 'premise: the lock write failed');
  await h.click('#layer [data-act="lclose"]');
  await h.click('#cta'); await h.click('[data-act="tip-place"]'); await h.click('#layer [data-act="placing-go"]');
  assert.equal(h.nav.length, 0, '🔴 the unpersisted lock: recovery only — never back into the checkout');
  await h.click('#layer [data-act="lclose"]');
  await h.click('[data-act="pay"][data-val="cash"]'); await h.click('#cta'); await h.click('[data-act="tip-place"]'); await h.click('#layer [data-act="placing-go"]');
  assert.equal(writes(h), 0, '🔴 an unpersisted lock still blocks every send in this page');
  h.ui.destroy(); failPlace = false;
  // reload: no pay_pending on the record — the card attempt on it is enough
  const r = bootCo({ storage, script: { paymentStatus: [PEND] } }); r.ui.restore(snap);
  await placeVia(r);   // cash
  assert.deepEqual([writes(r), r.srv.of('paymentStatus').length], [0, 1], '🔴 a reload: one poll FIRST, zero createOrder');
  r.ui.destroy();
  const o = bootCo({ storage, script: { paymentStatus: [PEND] } }); o.ui.restore(snap);
  await placeVia(o, 'online');
  assert.deepEqual([writes(o), o.srv.of('paymentStatus').length, o.nav], [0, 1, ['https://pay.example/c']], '🔴 card: one poll, then back to ITS checkout — zero charges');
});

test('S2b r2 P1-2: «Cancelar» makes the pin-step map obsolete — a late idle never moves the pin or the preview', async () => {
  let maps;
  const b = bootCo({ config: { mapsKey: 'k_test' }, pre: (w) => { maps = gmaps(w); } });
  await toCheckout(b); await settle();
  const pin0 = J(b.ui.state.flow.pin);
  await b.click('[data-act="pin"]'); await settle();
  const m = maps.filter((x) => x.el.dataset.gmap === 'pin').at(-1);
  m.pan(16, -89);
  await b.click('.pinstep [data-act="lclose"]'); await settle();   // «Cancelar»
  m.idle();   // the detached map's late idle
  b.ui.render(); await settle();
  assert.deepEqual(J(b.ui.state.flow.pin), pin0, 'the pin is unchanged');
  const pv = maps.filter((x) => x.el.dataset.gmap === 'preview').at(-1);
  assert.deepEqual(J(pv.c), { lat: pin0.lat, lng: pin0.lng }, '🔴 the preview stays on the pin after «Cancelar»');
});

test('S2b r2 P2-3: destroy() takes the REAL «El precio cambió» sheet off the page and the transport never sends after it — a surviving «Confirmar» click sends nothing', async () => {
  const b = bootCo({ realSheet: true, script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 99900 } }, { status: 200, json: { ok: true, order_id: 'X' } }] } });
  await placeVia(b);
  const sheet = b.q('.cq-sheet'); assert.ok(sheet, 'premise: the ported sheet is open');
  const confirm = [...sheet.querySelectorAll('button')].at(-1);
  b.ui.destroy();
  assert.equal(b.q('.cq-sheet'), null, '🔴 teardown removes the price sheet');
  confirm.dispatchEvent(new b.w.MouseEvent('click', { bubbles: true })); await settle();
  assert.equal(b.srv.of('createOrder').length, 1, '🔴 the agreed re-send never leaves a torn-down page');
});

test('S2b r2 OWNER (B): a cancel return with NO record and NO creds ⇒ the pending sheet ONCE, no poll; «Volver al pedido» ⇒ an UNLOCKED checkout (a new placement goes out); the sheet does not come back', async () => {
  const storage = memStore();
  const c = await returned(storage, '?pay=cancel', {});
  assert.equal(c.srv.calls.length, 0, 'nothing to poll');
  assert.equal(c.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación');
  assert.ok(!/no autorizó/.test(c.text('#layer') || ''));
  await c.click('#layer [data-act="lclose"]');
  c.ui.render(); await settle();
  assert.equal(c.q('#layer').innerHTML, '', 'shown once: a re-render does not bring it back');
  assert.equal(placeRec(storage), null, 'nothing locked');
  c.ui.cart.inc(c.plain.key); c.ui.openCheckout(); await settle();   // the cart's «Ir a pagar» path (asks for the location)
  await c.type('#f-details', 'Portón negro'); await c.type('#f-name', 'Ana'); await c.type('#f-phone', '9999 0000');
  await c.click('[data-act="pay"][data-val="cash"]'); await c.click('#cta'); await c.click('[data-act="tipc"][data-val="0"]');
  await c.click('[data-act="tip-place"]'); await c.click('#layer [data-act="placing-go"]');
  assert.equal(c.srv.of('createOrder').length, 1, '🔴 (B): the checkout is unlocked — a new placement goes out');
});

// a response the test releases later (destroy lands while the request is in flight)
const deferred = (res) => { let go; const p = new Promise((r) => { go = r; }); return { fn: () => p.then(() => res), go }; };
test('S2b r3 P2-3a: a 202 that lands AFTER destroy() ⇒ the transport never re-sends — one charge; the record keeps the 202 (admitted, unresolved)', async () => {
  const storage = memStore();
  const d = deferred({ status: 202, json: { status: 'in_progress' } });
  const b = bootCo({ storage, script: { chargeOnlineOrder: [d.fn, CHECKOUT] } });
  await placeVia(b, 'online');
  assert.equal(b.srv.of('chargeOnlineOrder').length, 1, 'premise: the first charge is in flight');
  b.ui.destroy();
  d.go(); await settle(50);
  assert.equal(b.srv.of('chargeOnlineOrder').length, 1, '🔴 zero charges after teardown (the 202 retry is gated)');
  const rec = placeRec(storage);
  assert.deepEqual([rec.admitted, rec.unresolved, rec.dispatched], [true, true, 1], 'the 202 is persisted: the next page recovers, never re-charges');
  assert.equal(b.nav.length, 0);
});

test('S2b r3 P2-3b: a late «price_increased» after destroy() is PERSISTED but never rendered — no price sheet, no layer, no re-send', async () => {
  for (const pay of ['online', 'cash']) {
    const storage = memStore();
    const d = deferred({ status: 409, json: { error: 'price_increased', net_total_cents: 99900 } });
    const ep = pay === 'online' ? 'chargeOnlineOrder' : 'createOrder';
    const b = bootCo({ storage, realSheet: true, script: { [ep]: [d.fn, pay === 'online' ? CHECKOUT : { status: 200, json: { ok: true, order_id: 'X' } }] } });
    await placeVia(b, pay);
    const id = b.srv.of(ep)[0].body.order_id;
    b.ui.destroy();
    d.go(); await settle(50);
    assert.equal(b.q('.cq-sheet'), null, `🔴 ${pay}: no price sheet after teardown`);
    assert.equal(b.q('#layer').innerHTML, '', `${pay}: nothing rendered`);
    assert.equal(writes(b), 1, `🔴 ${pay}: no re-send`);
    const rec = placeRec(storage);
    assert.equal(rec.order_id, id, `${pay}: the identity is kept`);
    if (pay === 'online') assert.equal(rec.unresolved, false, '🔴 card: the definitive refusal is persisted (settled — no checkout exists)');
  }
});

test('S2b r3 P2-5: a CASH record on file + a credentialless cancel ⇒ locked, the RECOVERY sheet (no bank in a cash order — never «Estamos confirmando tu pago»); dismissed, the card (and cash) send NOTHING with the retained id; a reload stays locked', async () => {
  const storage = memStore();
  const a = bootCo({ storage, script: { createOrder: ['network'] } });
  await placeVia(a);
  const id = a.srv.of('createOrder')[0].body.order_id;
  assert.equal(placeRec(storage).order_id, id, 'premise: a cash placement on record after the network failure');
  a.ui.destroy();
  const c = await returned(storage, '?pay=cancel', {});
  assert.equal(c.srv.calls.length, 0, 'no creds: nothing to poll');
  assert.equal(c.q('#layer .sheet').getAttribute('aria-label'), 'Necesitamos revisar tu pedido', '🔴 a cash record at the return: the recovery sheet');
  assert.ok(!/confirmando tu pago/.test(c.text('#layer') || ''), 'no bank copy for cash');
  assert.deepEqual([placeRec(storage).order_id, placeRec(storage).pay_pending], [id, true], 'the cash record is locked');
  await c.click('#layer [data-act="lclose"]');
  c.ui.cart.inc(c.plain.key); c.ui.openCheckout(); await settle();   // the cart's «Ir a pagar» path (asks for the location)
  await c.type('#f-details', 'Portón negro'); await c.type('#f-name', 'Ana'); await c.type('#f-phone', '9999 0000');
  for (const pay of ['online', 'cash']) {
    await c.click(`[data-act="pay"][data-val="${pay}"]`); await c.click('#cta');
    if (c.q('[data-act="tipc"][data-val="0"]')) await c.click('[data-act="tipc"][data-val="0"]');
    if (c.q('[data-act="tip-place"]')) await c.click('[data-act="tip-place"]');
    if (c.q('#layer [data-act="placing-go"]')) await c.click('#layer [data-act="placing-go"]');
    assert.equal(c.q('#layer .sheet').getAttribute('aria-label'), 'Necesitamos revisar tu pedido', `🔴 ${pay}: a locked cash record's later tap ⇒ the recovery sheet`);
    await c.click('#layer [data-act="lclose"]');
  }
  assert.deepEqual([writes(c), c.srv.of('paymentStatus').length], [0, 0], '🔴 zero charges, zero createOrder, zero polls with the retained id (only the quote went out)');
  c.ui.destroy();
  const r = bootCo({ storage, script: {} });
  await placeVia(r, 'online');
  assert.deepEqual([writes(r), r.q('#layer .sheet').getAttribute('aria-label')], [0, 'Necesitamos revisar tu pedido'], '🔴 a reload stays locked (recovery)');
});

// ── S2b-geo (MOCKUP-capp-S2b-geo-address.html frames A1 / b / b2 / c; advisor rulings 2026-10-26) ──
const GEO = {
  full: [{ address_components: [{ long_name: '10', types: ['street_number'] }, { long_name: 'Calle 10', types: ['route'] }, { long_name: 'Jardines del Valle', types: ['neighborhood', 'political'] }, { long_name: 'San Pedro Sula', types: ['locality', 'political'] }] }],
  street: [{ address_components: [{ long_name: 'Calle 10', types: ['route'] }, { long_name: 'San Pedro Sula', types: ['locality'] }] }],
  area: [{ address_components: [{ long_name: 'Unnamed Road', types: ['route'] }, { long_name: 'Jardines del Valle', types: ['neighborhood'] }] }],
  none: [{ address_components: [{ long_name: 'San Pedro Sula', types: ['locality'] }] }],
};
const bold = (b) => b.text('.urows .urow[data-act="pin"] .t b');
const sub = (b) => b.text('.urows .urow[data-act="pin"] .t > span');
function bootGeo(o = {}) { const gc = []; let maps; const b = bootCo({ ...o, config: { mapsKey: 'k_test', ...(o.config || {}) }, pre: (w) => { maps = gmaps(w, gc); } }); b.gc = gc; b.maps = () => maps; return b; }

test('S2b-geo a GPS fix (a CONFIRMED pin) ⇒ ONE geocode at the device fix; A1 «Calle 10, Col. Jardines del Valle» replaces «Tu ubicación»; re-renders never ask again', async () => {
  const b = bootGeo(); await toCheckout(b); await settle();
  assert.deepEqual(b.gc.map((r) => r.at), [{ lat: 15.52, lng: -88.04 }], 'one request, at the confirmed fix');
  assert.equal(bold(b), 'Tu ubicación', 'c: pending ⇒ today\'s row, byte for byte');
  b.gc[0].reply(GEO.full); await settle();
  assert.equal(bold(b), 'Calle 10, Col. Jardines del Valle', '🔴 A1');
  assert.equal(sub(b), 'Ajustá el pin a tu dirección', 'the sub (the pin-step state) is unchanged');
  b.ui.render(); await settle(); b.ui.render(); await settle();
  assert.equal(bold(b), 'Calle 10, Col. Jardines del Valle', '🔴 A1 survives a full re-render (the row template reads the geo line)');
  assert.equal(b.gc.length, 1, '🔴 one geocode per confirmed pin version');
});

test('S2b-geo frames b / b2 / c: street only «Calle 10»; colonia only «Col. Jardines del Valle» (never an invented street); nothing / a failure ⇒ «Tu ubicación»', async () => {
  for (const [results, status, want] of [[GEO.street, 'OK', 'Calle 10'], [GEO.area, 'OK', 'Col. Jardines del Valle'], [GEO.none, 'OK', 'Tu ubicación'], [null, 'ZERO_RESULTS', 'Tu ubicación'], [null, 'ERROR', 'Tu ubicación']]) {
    const b = bootGeo(); await toCheckout(b); await settle();
    b.gc[0].reply(results, status); await settle();
    assert.equal(bold(b), want, `${status} ${JSON.stringify(results && results[0].address_components.map((c) => c.long_name))}`);
    b.ui.render(); await settle(); assert.equal(b.gc.length, 1, 'a failure settles the version: no retry');
  }
});

test('S2b-geo «Listo» on a moved pin ⇒ a new version, its own geocode; released B then A, A is discarded; «Listo» on the same spot asks nothing', async () => {
  const b = bootGeo(); await toCheckout(b); await settle();
  await b.click('[data-act="pin"]'); await settle();
  b.maps().filter((x) => x.el.dataset.gmap === 'pin').at(-1).pan(15.54, -88.06);
  await b.click('[data-act="pin-done"]'); await settle();
  assert.deepEqual(b.gc.map((r) => r.at), [{ lat: 15.52, lng: -88.04 }, { lat: 15.54, lng: -88.06 }], 'A (the fix), then B (the moved pin)');
  b.gc[1].reply(GEO.area); await settle();
  assert.equal(bold(b), 'Col. Jardines del Valle', 'B applies');
  b.gc[0].reply(GEO.full); await settle();
  assert.equal(bold(b), 'Col. Jardines del Valle', '🔴 A\'s late reply never overwrites B');
  await b.click('[data-act="pin"]'); await settle(); await b.click('[data-act="pin-done"]'); await settle();
  assert.equal(b.gc.length, 2, '«Listo» without moving: the same pin, no second geocode');
  assert.equal(bold(b), 'Col. Jardines del Valle');
});

test('S2b-geo a reply for A that lands AFTER the pin moved to B (B still pending) is discarded — the row stays today\'s until B answers', async () => {
  const b = bootGeo(); await toCheckout(b); await settle();
  await b.click('[data-act="pin"]'); await settle();
  b.maps().filter((x) => x.el.dataset.gmap === 'pin').at(-1).pan(15.54, -88.06);
  await b.click('[data-act="pin-done"]'); await settle();
  b.gc[0].reply(GEO.full); await settle();
  assert.equal(bold(b), 'Tu ubicación', '🔴 superseded: never A\'s street on B\'s pin');
  b.gc[1].reply(GEO.street); await settle();
  assert.equal(bold(b), 'Calle 10');
});

test('S2b-geo location denied: the unconfirmed restaurant fallback is NEVER geocoded («Mové el pin a tu puerta» stays); confirmed on the pin step ⇒ its geo line replaces it', async () => {
  const b = bootGeo({ geo: GEO_NO, config: { loc: { lat: 15.5, lng: -88.0 } } }); await toCheckout(b); await settle();
  assert.equal(b.gc.length, 0, '🔴 an unconfirmed fallback pin: zero geocodes');
  assert.equal(bold(b), 'Mové el pin a tu puerta');
  await b.click('[data-act="pin"]'); await settle(); await b.click('[data-act="pin-done"]'); await settle();
  assert.equal(b.gc.length, 1, 'confirmed ⇒ one geocode');
  assert.equal(bold(b), 'Mové el pin a tu puerta', 'pending ⇒ today\'s copy');
  b.gc[0].reply(GEO.full); await settle();
  assert.equal(bold(b), 'Calle 10, Col. Jardines del Valle', '🔴 the geo line replaces «Mové el pin a tu puerta» (ruling 3)');
});

test('S2b-geo «Realizando pedido…» and «Enviando tu pedido…» carry the SAME line; with no geo line they keep today\'s «Detalles adicionales»', async () => {
  for (const [results, want] of [[GEO.full, 'Calle 10, Col. Jardines del Valle'], [GEO.area, 'Col. Jardines del Valle'], [GEO.none, 'Portón negro']]) {
    let go; const held = new Promise((r) => { go = r; });
    const b = bootGeo({ script: { createOrder: [() => held.then(() => ({ status: 200, json: { ok: true, order_id: 'X' } }))] } });
    await filled(b); b.gc.forEach((r) => r.reply(results)); await settle();
    await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
    assert.equal(b.text(b.qa('#layer .placing .prow')[1].querySelector('.t span')), want, `«Realizando»: ${want}`);
    await b.click('#layer [data-act="placing-go"]');
    assert.equal(b.text(b.q('.sndcard .prow .t b')), want, `«Enviando»: ${want}`);
    go(); await settle(); b.ui.destroy();
  }
});

test('S2b-geo a RESTORED return (the card checkout context from the stash) ⇒ its confirmed pin is geocoded once', async () => {
  const storage = memStore();
  const { id, snap } = await cardRedirected(storage);
  const gc = []; let maps;
  const c = bootCo({ storage, search: RET('cancel', id), config: { mapsKey: 'k_test' }, pre: (w) => { maps = gmaps(w, gc); }, script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] } });
  c.ui.restore(snap); await c.ui.returning; await settle();
  assert.equal(c.text('#layer .errsheet h2'), 'Pago no completado', 'premise: the context is back');
  assert.equal(gc.length, 1, '🔴 the restored pin: one geocode');
  assert.deepEqual(gc[0].at, { lat: c.ui.state.flow.pin.lat, lng: c.ui.state.flow.pin.lng });
  gc[0].reply(GEO.full); await settle();
  assert.equal(bold(c), 'Calle 10, Col. Jardines del Valle', 'the checkout under the sheet shows it');
  assert.equal(c.text('#layer .errsheet h2'), 'Pago no completado', 'the reply re-render keeps the sheet');
});

test('S2b-geo pickup: no geocode, no line', async () => {
  const b = bootGeo(); await toCheckout(b); await settle();
  b.gc[0].reply(GEO.full); await settle();
  await b.click('[data-act="type"][data-val="pickup"]'); await settle();
  assert.equal(b.gc.length, 1, 'pickup asks nothing');
  assert.ok(!b.q('.urows .urow[data-act="pin"]'), 'no address row on pickup');
});

// ── S2b-geo r1 (Codex): a geocode reply never re-renders — it patches the address text in place ──
test('S2b-geo r1 P1: A\'s reply landing while the pin editor is open (panned to B, no idle yet) never rebuilds the editor — «Listo» confirms B', async () => {
  const b = bootGeo(); await toCheckout(b); await settle();
  assert.equal(b.gc.length, 1, 'premise: A\'s geocode is pending');
  await b.click('[data-act="pin"]'); await settle();
  const m = b.maps().filter((x) => x.el.dataset.gmap === 'pin').at(-1);
  m.pan(15.54, -88.06);
  b.gc[0].reply(GEO.full); await settle();
  assert.ok(m.el.isConnected, '🔴 the live editor map survives the reply');
  assert.equal(b.maps().filter((x) => x.el.dataset.gmap === 'pin').length, 1, 'no second editor map was built');
  await b.click('[data-act="pin-done"]'); await settle();
  assert.deepEqual(J(b.ui.state.flow.pin), { lat: 15.54, lng: -88.06, confirmed: true }, '🔴 «Listo» confirms B, never the old A');
  assert.deepEqual(b.gc.map((r) => r.at), [{ lat: 15.52, lng: -88.04 }, { lat: 15.54, lng: -88.06 }], 'B asks for itself');
  b.gc[1].reply(GEO.area); await settle();
  assert.equal(bold(b), 'Col. Jardines del Valle');
});

test('S2b-geo r1 P2: the coordinates are captured WITH the version; work made obsolete while Maps loads is never sent — editor opened, GPS fix A, «Listo» on B, then Maps loads ⇒ exactly ONE geocode, for B', async () => {
  let fix = null;
  const gc = [];
  const b = bootCo({ config: { mapsKey: 'k_test', loc: { lat: 15.5, lng: -88.0 } }, geo: { getCurrentPosition: (ok) => { fix = ok; } } });
  await toCheckout(b); await settle();
  await b.click('[data-act="pin"]'); await settle();   // the editor's draft: the restaurant fallback (B)
  fix({ coords: { latitude: 15.52, longitude: -88.04 } }); await settle();   // GPS fix A: a confirmed pin, its geocode waits for Maps
  assert.deepEqual(J(b.ui.state.flow.pin), { lat: 15.52, lng: -88.04, confirmed: true }, 'premise: A is the confirmed pin');
  await b.click('[data-act="pin-done"]'); await settle();   // «Listo» confirms the editor's draft B
  assert.deepEqual(J(b.ui.state.flow.pin), { lat: 15.5, lng: -88.0, confirmed: true }, 'premise: B confirmed while Maps is still loading');
  gmaps(b.w, gc); b.w.__cappMapsReady(); await settle();
  assert.deepEqual(gc.map((r) => r.at), [{ lat: 15.5, lng: -88.0 }], '🔴 one geocode, for B — A\'s obsolete request never left');
  gc[0].reply(GEO.street); await settle();
  assert.equal(bold(b), 'Calle 10');
});

test('S2b-geo r1 P3: a reply during «Enviando»\'s completion (the green check) patches the address in place — the check stays; during «Realizando» the countdown node survives', async () => {
  const b = bootGeo({ script: { createOrder: [{ status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } }] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  const cd = b.q('#layer [data-act="placing-go"] .cd');
  assert.ok(cd && b.gc.length === 1, 'premise: «Realizando» open, the geocode pending');
  b.gc[0].reply(GEO.full); await settle();
  assert.equal(b.q('#layer [data-act="placing-go"] .cd'), cd, '🔴 the «Realizando» card is not rebuilt');
  assert.equal(b.text(b.qa('#layer .placing .prow')[1].querySelector('.t span')), 'Calle 10, Col. Jardines del Valle', '«Realizando»: patched in place');
  // a second flow: the reply lands while the completion check shows
  const s = bootGeo({ script: { createOrder: [{ status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } }] } });
  await filled(s); await s.click('#cta'); await s.click('[data-act="tipc"][data-val="0"]'); await s.click('[data-act="tip-place"]'); await s.click('#layer [data-act="placing-go"]');
  assert.ok(s.q('#sspin.done'), 'premise: «Enviando» shows the completion check');
  s.gc[0].reply(GEO.area); await settle();
  assert.ok(s.q('#sspin.done'), '🔴 the check stays (no rebuild)');
  assert.equal(s.text(s.q('.sndcard .prow .t b')), 'Col. Jardines del Valle', '«Enviando»: patched in place');
});

// ── S2b-geo body (PLAN-colonia §1): the order request the REAL UI sends ──
test('S2b-geo body: the UI\'s createOrder / chargeOnlineOrder carry address_area once the confirmed pin\'s reply landed; submitted while pending ⇒ none (never waits)', async () => {
  for (const pay of ['cash', 'online']) {
    const ep = pay === 'online' ? 'chargeOnlineOrder' : 'createOrder';
    const ok = pay === 'online' ? { status: 200, json: { ok: true, checkout_url: 'https://pay.example/c', poll_token: 'pt_1' } } : { status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } };
    const b = bootGeo({ script: { [ep]: [ok] } });
    await filled(b, pay); b.gc.forEach((r) => r.reply(GEO.full)); await settle();
    await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
    assert.equal(b.srv.of(ep)[0].body.address_area, 'Jardines del Valle', `🔴 ${pay}: the bound area rides the order`);
    assert.ok(!('address_area' in b.srv.of('quoteOrder').at(-1).body), `${pay}: never in the quote`);
    const p = bootGeo({ script: { [ep]: [ok] } });
    await filled(p, pay);   // the reply never lands
    await p.click('#cta'); await p.click('[data-act="tipc"][data-val="0"]'); await p.click('[data-act="tip-place"]'); await p.click('#layer [data-act="placing-go"]');
    assert.equal(p.srv.of(ep).length, 1, `${pay}: submit did not wait for the geocode`);
    assert.ok(!('address_area' in p.srv.of(ep)[0].body), `🔴 ${pay}: pending at submit ⇒ no address_area`);
  }
});


// ── S7a-1 client foundation (PLAN-capp-S7a r1 → r3.1): the HOSTED mount — history adapter, onCartChange, the countdown never freezes ──
// a shell stand-in implementing EXACTLY the approved adapter (PLAN-capp-S7a r2 §1.3; Codex r1 P2-9): { push, back, go, owns,
// subscribe } — frozen, so any other member the UI reached for would be undefined. The test-side helpers live OUTSIDE it.
function shellHist() {
  const st = { entries: 0, pushes: 0 }; let fn = null;
  const adapter = Object.freeze({ push() { st.entries++; st.pushes++; }, back() { if (st.entries) st.entries--; }, go(k) { st.entries = Math.max(0, st.entries + k); }, owns() { return st.entries > 0; },
    subscribe: (f) => { fn = f; return () => { fn = null; }; } });
  return { adapter, st, device: () => { const r = fn ? fn() : 'none'; if (r === 'consumed' && st.entries) st.entries--; return r; }, get subscribed() { return !!fn; } };
}
const HOSTED_KEYS = { cartKey: 'capp:rid_a:cart', placedKey: 'capp:rid_a:placed' };

test('S7a-1 history adapter: hosted ⇒ CappUI never touches window.history; device back = consumed (cart closes) / pass (store root); destroy unsubscribes', async () => {
  const H = shellHist();
  const b = bootCo({ mountOpts: { history: H.adapter } });
  const len0 = b.w.history.length;
  b.ui.cart.inc(b.plain.key); b.ui.render(); await b.click('#cart-bar');
  assert.ok(b.q('#layer .sheet'), 'premise: the cart is open');
  assert.equal(b.w.history.length, len0, '🔴 hosted: no window.history push');
  assert.deepEqual([H.st.pushes, H.st.entries], [1, 1], '🔴 the documented adapter receives the push (Codex r1 P2-9)');
  assert.equal(H.device(), 'consumed'); await settle();
  assert.equal(b.q('#layer').innerHTML, '', 'the cart closed');
  assert.equal(H.device(), 'pass', 'store root ⇒ the shell pops to its recorded predecessor');
  b.ui.destroy(); assert.equal(H.subscribed, false, 'destroy unsubscribes');
});

test('S7a-1 N2 (non-negotiable): device back during «Realizando pedido…» CANCELS — consumed, ZERO sends, and the cart is NEVER frozen; «Enviando» ⇒ blocked', async () => {
  const H = shellHist(); const storage = memStore();
  const b = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { history: H.adapter } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'Realizando pedido', 'premise: the countdown is armed');
  assert.equal(H.device(), 'consumed', '🔴 countdown back is consumed as cancellation');
  b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 0, '🔴 countdown back cancels: zero sends');
  const cart = JSON.parse(storage.getItem('capp:rid_a:cart') || 'null');
  assert.ok(!cart || cart.frozen_for === undefined, '🔴 cancelling the countdown never freezes');
  // sending is blocked
  let go; const held = new Promise((r) => { go = r; });
  const s2 = bootCo({ storage: memStore(), config: HOSTED_KEYS, mountOpts: { history: shellHist().adapter }, script: { createOrder: [() => held.then(() => ({ status: 200, json: { ok: true, order_id: 'X' } }))] } });
  const H2 = s2.ui; await filled(s2); await s2.click('#cta'); await s2.click('[data-act="tipc"][data-val="0"]'); await s2.click('[data-act="tip-place"]'); await s2.click('#layer [data-act="placing-go"]');
  assert.equal(H2.deviceBack(), 'blocked', '«Enviando» is not a back step');
  go(); await settle();
});

test('S7a-1 onCartChange: after successful mutations and delivery/pickup changes (with the mode); never after a refused write; a throwing hook never affects the UI', async () => {
  const seen = [];
  const b = bootCo({ mountOpts: { onCartChange: (s) => seen.push(s) } });
  b.ui.cart.inc(b.plain.key); b.ui.render(); await settle();
  await b.click(`.qty-ctrl-btn[data-act="inc"][data-id="${b.plain.key}"]`).catch(() => {});
  const n0 = seen.length;
  await b.click('[data-act="mode"][data-val="pickup"]');
  assert.equal(seen.length, n0 + 1, 'a mode change notifies');
  assert.deepEqual([seen.at(-1).mode, seen.at(-1).rid], ['pickup', 'rid_a']);
  // a refused write (over the 50 cap) notifies nothing
  const k = b.plain.key; for (let i = 0; i < 60; i++) { try { b.ui.cart.inc(k); } catch (_) { break; } }   // fill to the 50 cap
  const n1 = seen.length;
  b.ui.render(); await b.click(`.qty-ctrl-btn[data-act="inc"][data-id="${k}"]`).catch(() => {});
  assert.equal(seen.length, n1, 'a refused write notifies nothing');
  const t = bootCo({ mountOpts: { onCartChange: () => { throw new Error('shell bug'); } } });
  await t.click('[data-act="mode"][data-val="pickup"]');
  assert.ok(t.q('.screen'), 'a throwing hook never breaks the UI');
});

test('S7a-1 Codex r1 P2-6: after a REAL pending cancel return (pay_pending) the held sheet and the lock report `blocked` — never consumed-then-pass, the store is never torn down over the lock', async () => {
  const storage = memStore();
  const a = bootCo({ storage, config: HOSTED_KEYS, script: { chargeOnlineOrder: [CHECKOUT] } });
  await placeVia(a, 'online'); const id = a.srv.of('chargeOnlineOrder')[0].body.order_id; const snap = J(a.ui.cart.snapshot()); a.ui.destroy();
  const H = shellHist();
  const c = bootCo({ storage, search: RET('cancel', id), config: HOSTED_KEYS, mountOpts: { history: H.adapter }, script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  c.ui.restore(snap); await c.ui.returning; await settle();
  assert.equal(c.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación', 'premise: the pending held state');
  assert.equal(placeRec(storage).pay_pending, true, 'premise: locked on its record');
  assert.deepEqual([H.device(), H.device()], ['blocked', 'blocked'], '🔴 the held sheet ⇒ blocked');
  await c.click('#layer [data-act="lclose"]');
  const seen = []; for (let i = 0; i < 6; i++) { seen.push(H.device()); await settle(); }
  assert.ok(!seen.includes('pass'), `🔴 a held lock never passes to the shell (${seen.join(',')})`);
  assert.equal(seen.at(-1), 'blocked', 'the store root under a lock is blocked');
  assert.deepEqual([writes(c), placeRec(storage).pay_pending], [0, true], 'nothing sent; the lock is kept');
});

test('S7a-1 Codex r1 P2-7: hosted restore of a v2 PICKUP snapshot frozen for A ⇒ the pickup mode, and the cart is READ-ONLY — «+» and a mode change land nothing and notify nothing', async () => {
  const b0 = bootCo(); b0.ui.cart.inc(b0.plain.key);
  const snap = { ...J(b0.ui.cart.snapshot()), rid: 'rid_a', mode: 'pickup', cart_gen: 'GEN_A', frozen_for: 'TA_A' };   // the REAL writer's v2 lines
  const storage = memStore(); const t0 = NOON().getTime();
  storage.setItem('capp:rid_a:cart', JSON.stringify(snap));
  storage.setItem('capp:rid_a:pending_place', JSON.stringify({ order_id: 'TA_A', method: 'cash', card: false, dispatched: 1, cart_gen: 'GEN_A', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }));
  const seen = [];
  const b = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { onCartChange: (x) => seen.push(x) } });
  b.ui.restore(snap); await settle();
  assert.deepEqual([b.ui.state.mode, b.ui.cart.count()], ['pickup', 1], '🔴 the persisted mode is restored with the lines');
  await b.click('#cart-bar'); await b.click('#layer [data-act="rev"][data-rev="1"]');
  assert.equal(b.ui.cart.count(), 1, '🔴 a frozen cart rejects «+»');
  await b.click('#layer [data-act="lclose"]').catch(() => {});
  await b.click('[data-act="mode"][data-val="delivery"]');   // the store's delivery/pickup toggle (asserted present)
  assert.deepEqual([b.ui.state.mode, seen.length, JSON.parse(storage.getItem('capp:rid_a:cart')).frozen_for], ['pickup', 0, 'TA_A'], 'no mode change, nothing notified, still frozen');
});

test('S7a-1 Codex r1 P2-8: the freeze persists the REAL v2 snapshot with no stored cart beforehand — a reload hydrates every line', async () => {
  const storage = memStore();
  const b = bootCo({ storage, config: HOSTED_KEYS, script: { createOrder: ['network'] } });
  await placeVia(b, 'cash');
  const c = JSON.parse(storage.getItem('capp:rid_a:cart'));
  assert.deepEqual([c.v, typeof c.frozen_for], [2, 'string'], '🔴 the supplied snapshot\'s v2 is kept');
  const r = bootCo({ storage, config: HOSTED_KEYS }); const h = r.ui.restore(c);
  assert.deepEqual([h.dropped, r.ui.cart.count()], [0, b.ui.cart.count()], 'every line hydrates');
});

// a FAITHFUL session history for the shell nav (Codex r2 New 4): indexed entries, async popstate carrying the destination state
function faithfulWin() {
  const win = { _l: null, q: [] };
  win.history = { entries: [null], i: 0, get state() { return this.entries[this.i]; },
    pushState(st) { this.entries = this.entries.slice(0, this.i + 1); this.entries.push(st); this.i = this.entries.length - 1; },
    go(k) { const j = Math.max(0, Math.min(this.entries.length - 1, this.i + k)); if (j === this.i) return; this.i = j; win.q.push({ state: this.entries[j] }); },
    back() { this.go(-1); }, forward() { this.go(1); } };
  win.addEventListener = (t, f) => { if (t === 'popstate') win._l = f; };
  win.removeEventListener = () => { win._l = null; };
  win.device = () => { win.history.back(); const out = []; while (win.q.length) { const e = win.q.shift(); out.push(win._l ? win._l(e) : 'none'); } return out[0]; };
  return win;
}

test('S7a-1 composed: the REAL CappUI under the shell nav — Buscar → store → checkout → tip, device backs walk ONE stack (tip → checkout → cart → menu), the store root returns to Buscar with its query', async () => {
  const { createShellNav } = await import('./capp-shell-nav.js').then((m) => m.default || m);
  const win = faithfulWin(); const device = () => win.device();
  const shown = []; const nav = createShellNav({ win, onShow: (e, x) => shown.push({ name: e.name, restored: x && x.restored }), onLeave: () => {} });
  nav.go({ name: 'search' }); nav.go({ name: 'store', rid: 'rid_a' }, { q: 'pizza', scroll: 40 });
  const b = bootCo({ mountOpts: { history: nav.adapterFor(nav.current()) } });
  await filled(b); await b.click('#cta');
  assert.equal(b.ui.state.screen, 'tip', 'premise: the tip step');
  assert.equal(device(), 'consumed'); await settle(); assert.equal(b.ui.state.screen, 'checkout', 'tip → «Entrega & Pago»');
  assert.equal(device(), 'consumed'); await settle(); assert.equal(b.ui.state.screen, 'store');
  for (let i = 0; i < 4 && b.ui.state.screen !== 'store'; i++) { device(); await settle(); }
  if (b.q('#layer .sheet')) { assert.equal(device(), 'consumed'); await settle(); }
  assert.equal(device(), 'pass', 'the store root');
  assert.deepEqual(shown.at(-1), { name: 'search', restored: { q: 'pizza', scroll: 40 } }, '🔴 back to Buscar with its query');
});

test('Codex r2 P2-6: a CASH order_exists recovery lock ⇒ after «Volver al pedido» device back walks the store but NEVER passes — the frozen-for-order cart keeps the store', async () => {
  const storage = memStore(); const H = shellHist();
  const b = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { history: H.adapter }, script: { createOrder: [{ status: 409, json: { error: 'order_exists' } }] } });
  await placeVia(b, 'cash');
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'Necesitamos revisar tu pedido', 'premise: the held recovery sheet');
  const id = b.srv.of('createOrder')[0].body.order_id;
  assert.equal(H.device(), 'blocked', 'the held sheet ⇒ blocked');
  await b.click('#layer [data-act="lclose"]');
  const seen = []; for (let i = 0; i < 6; i++) { seen.push(H.device()); await settle(); }
  assert.ok(!seen.includes('pass'), `🔴 a recovery lock never passes to the shell (${seen.join(',')})`);
  assert.deepEqual([seen.at(-1), JSON.parse(storage.getItem('capp:rid_a:cart')).frozen_for, writes(b)], ['blocked', id, 1], 'the root under the lock is blocked; still frozen; nothing re-sent');
});

test('Codex r2 New 1: after a restore that found the cart PURCHASED (cleared), a NEW cart in the same mount places normally — never «Necesitamos revisar tu pedido»', async () => {
  const b0 = bootCo(); b0.ui.cart.inc(b0.plain.key);
  const snap = { ...J(b0.ui.cart.snapshot()), rid: 'rid_a', mode: 'delivery', cart_gen: 'GEN_A', frozen_for: 'TA_A' };
  const storage = memStore();
  storage.setItem('capp:rid_a:cart', JSON.stringify(snap));
  storage.setItem('capp:rid_a:placed', JSON.stringify({ order_id: 'TA_A', cart_gen: 'GEN_A', outcome: 'placed', at: NOON().getTime() }));
  const b = bootCo({ storage, config: HOSTED_KEYS, script: { createOrder: [{ status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } }] } });
  assert.deepEqual(J(b.ui.restore(snap)), { cleared: true }, 'premise: the purchased cart is cleared, not restored');
  await placeVia(b, 'cash');   // a new dish: a NEW cart
  assert.equal(writes(b), 1, '🔴 a new cart after a purchased restore places normally');
  assert.ok(!/Necesitamos revisar/.test(b.text('#layer') || ''), 'never the recovery sheet');
  assert.notEqual(JSON.parse(storage.getItem('capp:rid_a:cart') || '{}').cart_gen, 'GEN_A', 'a new generation');
});

test('Codex r2 New 3: a REAL CappUI holding a create-order response (sending) is never torn down by the shell — tab / the shell\'s back refused, the mount alive; it leaves once settled', async () => {
  const { createShellNav } = await import('./capp-shell-nav.js').then((m) => m.default || m);
  const win = faithfulWin(); const left = [];
  const nav = createShellNav({ win, onShow: () => {}, onLeave: (e) => left.push(e) });
  nav.go({ name: 'search' }); nav.go({ name: 'store', rid: 'rid_a' });
  let release; const held = new Promise((r) => { release = r; });
  const b = bootCo({ storage: memStore(), config: HOSTED_KEYS, mountOpts: { history: nav.adapterFor(nav.current()) }, script: { createOrder: [() => held.then(() => ({ status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } }))] } });
  await placeVia(b, 'cash');
  assert.equal(b.ui.state.screen, 'sending', 'premise: «Enviando», the response held');
  assert.deepEqual([nav.tab({ name: 'orders' }), nav.back(), nav.go({ name: 'search' }), left.length, nav.current().name], [false, false, false, 0, 'store'], '🔴 a sending mount is never left or destroyed');
  release(); await settle();
});

test('advisor ruling (a): a frozen-but-NOT-live cart (§1.4, the lock expired, no marker) may be LEFT — tab and Back leave, the cart is still frozen on return; an UNKNOWN freeze state still blocks', async () => {
  const { createShellNav } = await import('./capp-shell-nav.js').then((m) => m.default || m);
  const b0 = bootCo(); b0.ui.cart.inc(b0.plain.key);
  const snap = { ...J(b0.ui.cart.snapshot()), rid: 'rid_a', mode: 'delivery', cart_gen: 'GEN_A', frozen_for: 'TA_OLD' };   // no pending_place: not live
  const storage = memStore(); storage.setItem('capp:rid_a:cart', JSON.stringify(snap));
  const mountUnder = (nav) => { const b = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { history: nav.adapterFor(nav.current()) } }); b.ui.restore(snap); return b; };
  // a tab leaves
  const w1 = faithfulWin(); const left = []; const n1 = createShellNav({ win: w1, onShow: () => {}, onLeave: (e) => left.push(e) });
  n1.go({ name: 'search' }); n1.go({ name: 'store', rid: 'rid_a' }); mountUnder(n1); await settle();
  assert.deepEqual([n1.tab({ name: 'orders' }), left.length, n1.current().name], [true, 1, 'orders'], '🔴 a frozen-not-live cart may be left (tab)');
  // device Back from the store root leaves
  const w2 = faithfulWin(); const n2 = createShellNav({ win: w2, onShow: () => {}, onLeave: () => {} });
  n2.go({ name: 'search' }); n2.go({ name: 'store', rid: 'rid_a' }); mountUnder(n2); await settle();
  assert.deepEqual([w2.device(), n2.current().name], ['pass', 'search'], '🔴 a frozen-not-live cart may be left (Back)');
  // on return: still frozen (read-only), the recovery sheet on placement
  assert.equal(JSON.parse(storage.getItem('capp:rid_a:cart')).frozen_for, 'TA_OLD', 'still frozen on return');
  const back = mountUnder(createShellNav({ win: faithfulWin(), onShow: () => {}, onLeave: () => {} })); await settle();
  await back.click('#cart-bar'); await back.click('#layer [data-act="rev"][data-rev="1"]');
  assert.equal(back.ui.cart.count(), 1, 're-mounted frozen: «+» refused');
  // an UNKNOWN freeze state (an unreadable cart) still blocks leaving — fail closed
  const H = shellHist(); const u = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { history: H.adapter } }); u.ui.restore(snap); await settle();
  const g = storage.getItem; storage.getItem = (k) => { if (k === 'capp:rid_a:cart') throw new Error('read'); return g(k); };
  assert.deepEqual([u.ui.deviceBack('leave'), H.device()], ['blocked', 'blocked'], '🔴 an unknown freeze state never leaves');
  storage.getItem = g;
});

const OK_CASH_UI = { status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } };
const navOf = async (onLeave) => { const { createShellNav } = await import('./capp-shell-nav.js').then((m) => m.default || m); return createShellNav({ win: faithfulWin(), onShow: () => {}, onLeave }); };

test('Codex r3 #1 (P1): a PURCHASED-snapshot restore clears the in-memory cart too — the purchased lines can never be re-sent under a new generation (openCheckout ⇒ zero new sends)', async () => {
  const storage = memStore();
  const b = bootCo({ storage, config: HOSTED_KEYS, script: { createOrder: [OK_CASH_UI] } });
  await placeVia(b, 'cash'); b.timers.flush(); await settle();
  assert.equal(writes(b), 1, 'premise: A purchased');
  const snap = JSON.parse(storage.getItem('capp:rid_a:cart'));
  assert.deepEqual(J(b.ui.restore(snap)), { cleared: true });
  assert.equal(b.ui.cart.count(), 0, '🔴 the purchased lines are cleared from memory');
  b.ui.openCheckout(); await settle();
  for (const sel of ['#cta', '[data-act="tipc"][data-val="0"]', '[data-act="tip-place"]', '#layer [data-act="placing-go"]']) { if (b.q(sel)) await b.click(sel); }
  b.timers.flush(); await settle();
  assert.equal(writes(b), 1, '🔴 zero new sends of the purchased cart');
});

test('Codex r3 #2: a shell screen opened over a store in «Realizando pedido…» tears the mount down — the countdown is cancelled, ZERO sends', async () => {
  let b; const left = []; const nav = await navOf((e) => { left.push(e); b.ui.destroy(); });
  nav.go({ name: 'search' }); nav.go({ name: 'store', rid: 'rid_a' });
  b = bootCo({ storage: memStore(), config: HOSTED_KEYS, mountOpts: { history: nav.adapterFor(nav.current()) }, script: { createOrder: [OK_CASH_UI] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'Realizando pedido', 'premise: the countdown is armed');
  assert.equal(nav.go({ name: 'search' }), true);
  b.timers.flush(); await settle();
  assert.deepEqual([left.length, writes(b)], [1, 0], '🔴 go() leaves through the teardown: the countdown never sends');
});

test('Codex r3 #3: the terminal-success exception (r3 §1.7) — a SETTLED placed, durably reconciled, may leave «Enviando»; an UNSETTLED one may not', async () => {
  const SHM = await import('./capp-shell.js').then((m) => m.default || m);
  for (const settled of [true, false]) {
    let b; const left = []; const nav = await navOf((e) => { left.push(e); b.ui.destroy(); });
    nav.go({ name: 'store', rid: 'rid_a' });
    const storage = memStore();
    if (!settled) { const si = storage.setItem; storage.setItem = (k, v) => { if (k === 'capp:rid_a:placed') throw new Error('quota'); return si(k, v); }; }
    b = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { history: nav.adapterFor(nav.current()) }, script: { createOrder: [OK_CASH_UI] } });
    await placeVia(b, 'cash'); b.timers.flush(); await settle();
    const out = (b.events.find((e) => e[0] === 'placed') || [])[1];
    assert.equal(b.ui.state.screen, 'sending', 'premise: «Enviando»');
    if (settled) {
      assert.ok(out && SHM.isTerminal(J(out)), 'premise: the real placed event is terminal');
      assert.deepEqual([nav.go({ name: 'tracker' }), left.length, nav.current().name], [true, 1, 'tracker'], '🔴 a durably reconciled success may leave «Enviando»');
    } else {
      assert.deepEqual([nav.go({ name: 'tracker' }), left.length], [false, 0], 'an unsettled end keeps the store');
    }
  }
});

test('Codex r3 #5: an UNREADABLE placement record is UNKNOWN — leave and device Back stay blocked (a live freeze is never read as leaveable)', async () => {
  const storage = memStore(); const H = shellHist();
  const b = bootCo({ storage, config: HOSTED_KEYS, mountOpts: { history: H.adapter }, script: { createOrder: [{ status: 409, json: { error: 'order_exists' } }] } });
  await placeVia(b, 'cash');
  await b.click('#layer [data-act="lclose"]');
  for (let i = 0; i < 6; i++) { if (H.device() === 'blocked') break; await settle(); }
  const g = storage.getItem; storage.getItem = (k) => { if (k === 'capp:rid_a:pending_place') throw new Error('read'); return g(k); };
  assert.deepEqual([b.ui.deviceBack('leave'), H.device()], ['blocked', 'blocked'], '🔴 an unreadable record never makes the store leaveable');
  storage.getItem = g;
});

test('Codex r4 #1: after a ROOT exit released the sentinel, Buscar → store → «Realizando pedido…» → device Back still CANCELS the countdown (re-armed) — zero sends', async () => {
  const { createShellNav } = await import('./capp-shell-nav.js').then((m) => m.default || m);
  const win = faithfulWin(); let b;
  const nav = createShellNav({ win, onShow: () => {}, onLeave: () => b && b.ui.destroy() });
  assert.equal(win.device(), 'exit', 'premise: Inicio at the root releases the sentinel');
  nav.go({ name: 'search' }); nav.go({ name: 'store', rid: 'rid_a' });
  b = bootCo({ storage: memStore(), config: HOSTED_KEYS, mountOpts: { history: nav.adapterFor(nav.current()) }, script: { createOrder: [OK_CASH_UI] } });
  await filled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'Realizando pedido', 'premise: the countdown is armed');
  assert.equal(win.device(), 'consumed', '🔴 the device Back reaches the mount (the sentinel was re-armed)');
  b.timers.flush(); await settle();
  assert.equal(writes(b), 0, '🔴 the countdown is cancelled: zero sends');
});

test('Codex r4 #2: order A\'s terminal success never carries into order B — an UNSETTLED B whose lock expired stays blocked in «Enviando»', async () => {
  const storage = memStore();
  const b = bootCo({ storage, config: HOSTED_KEYS, script: { createOrder: [OK_CASH_UI] } });
  await placeVia(b, 'cash'); b.timers.flush(); await settle();
  const snapA = JSON.parse(storage.getItem('capp:rid_a:cart'));
  assert.deepEqual(J(b.ui.restore(snapA)), { cleared: true }, 'premise: A purchased; its cart cleared (memory included)');
  assert.equal(b.ui.deviceBack('leave'), 'pass', 'premise: A settled and reconciled ⇒ may leave');
  const si = storage.setItem; storage.setItem = (k, v) => { if (k === 'capp:rid_a:placed') throw new Error('quota'); return si(k, v); };   // B's marker never lands
  b.ui.cart.inc(b.plain.key); b.ui.openCheckout(); await settle();
  await b.click('#cta');
  await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  b.timers.flush(); await settle();
  assert.deepEqual([writes(b), b.ui.state.screen], [2, 'sending'], 'premise: B sent, «Enviando»');
  const rec = JSON.parse(storage.getItem('capp:rid_a:pending_place')); rec.expires_at = 0; si('capp:rid_a:pending_place', JSON.stringify(rec));   // B's lock expired
  assert.equal(b.ui.deviceBack('leave'), 'blocked', '🔴 an unsettled B never inherits A\'s terminal success');
});

// ── PLAN-capp-S7a r3.3-F2 [r2 ruling 2] (perf, APPROVED): availability re-checked at DISPATCH + the unavailable-lines gate ──
// the REAL UI through its own controls; the host's live availability is the Set it mutates (as the shell will), the dispatch read
// is opts.readAvailability (the forms' loadAvailability semantics: a failed read CLEARS sold-outs — agotado-failopen)
const sent = (b) => b.srv.of('createOrder').length + b.srv.of('chargeOnlineOrder').length;
async function toPlacing(b, pay) { await filled(b, pay); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); }
for (const pay of ['cash', 'online']) {
  test(`perf r2-2 (${pay}): a dish that sells out DURING the countdown ⇒ the dispatch re-check sends NOTHING, back with the cart open`, async () => {
    const sold = new Set();
    const b = bootCo({ script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }] },
      mountOpts: { unavailable: sold, readAvailability: () => Promise.resolve([...sold]) } });
    await toPlacing(b, pay);
    assert.ok(b.q('#layer [data-act="placing-go"]'), 'premise: «Realizando pedido…» is counting down');
    sold.add(b.plain.key);   // the host's live read lands mid-countdown
    b.timers.flush(); await settle();
    assert.equal(sent(b), 0, '🔴 nothing is dispatched for a line now unavailable');
    assert.deepEqual(J(b.events.find((e) => e[0] === 'dispatch_refused')), ['dispatch_refused', { reason: 'unavailable', keys: [b.plain.key] }]);
    assert.ok(b.q('#layer .cline'), 'the cart is open, the line still in it (never removed silently)');
    assert.notEqual(b.ui.state.screen, 'sending', 'not left on «Enviando»');
  });
  test(`perf r2-2 (${pay}): a known-unavailable line gates the CTA before any countdown`, async () => {
    const sold = new Set();
    const b = bootCo({ mountOpts: { unavailable: sold, readAvailability: () => Promise.resolve([...sold]) } });
    await filled(b, pay); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]');
    sold.add(b.plain.key); b.ui.render(); await settle();
    assert.equal(b.q('[data-act="tip-place"]').disabled, true, '🔴 the tip step\'s place button is disabled');
    await b.click('[data-act="tip-place"]');
    assert.equal(b.q('#layer [data-act="placing-go"]'), null, '🔴 no countdown starts');
    b.timers.flush(); await settle();
    assert.equal(sent(b), 0, '🔴 nothing is dispatched');
  });
}
test('perf r2-2: the dispatch read FAILS ⇒ fail-open exactly like the forms — stale sold-outs are CLEARED and the order is sent', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold, readAvailability: () => Promise.reject(new Error('net')) } });
  await toPlacing(b, 'cash');
  sold.add(b.plain.key);   // a stale sold-out the failed read cannot confirm
  b.timers.flush(); await settle();
  assert.equal(sold.size, 0, 'the failed read cleared the stale sold-out (agotado-failopen)');
  assert.equal(b.srv.of('createOrder').length, 1, 'the order is sent; the server stays the authority');
});
test('perf r2-2: a dispatch read that never answers is bounded (1.5 s) and fails open', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold, readAvailability: () => new Promise(() => {}) } });
  await toPlacing(b, 'cash');
  b.timers.flush(); await settle();   // the countdown → send → the re-check is pending on its bound
  assert.equal(b.srv.of('createOrder').length, 0, 'premise: waiting on the bounded read');
  assert.ok([...b.timers.ms.values()].includes(1500), 'the bound is 1.5 s');
  b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 1, 'the bound expired ⇒ fail-open ⇒ sent');
});
test('perf r2-2: a function-form availability input is overridden by the fresh dispatch read (it cannot be mutated)', async () => {
  let key = null;
  const b = bootCo({ mountOpts: { unavailable: () => false, readAvailability: () => Promise.resolve([key]) } });
  key = b.plain.key;
  await toPlacing(b, 'cash');
  b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 0, '🔴 the fresh read says sold ⇒ nothing sent');
});
test('perf r2-2 (pickup): a known-unavailable line disables «Confirmar pedido» on «Entrega & Pago» (pickup places from there)', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold, readAvailability: () => Promise.resolve([...sold]) } });
  await toCheckout(b); await b.click('[data-act="type"][data-val="pickup"]');
  await b.type('#f-name', 'Ana'); await b.type('#f-phone', '99990000'); await b.click('[data-act="pay"][data-val="cash"]');
  assert.equal(b.q('#cta').disabled, false, 'premise: ready to place');
  sold.add(b.plain.key); b.ui.render(); await settle();
  assert.equal(b.q('#cta').disabled, true, '🔴 the pickup CTA is disabled for an unavailable line');
  await b.click('#cta'); b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 0, 'nothing is dispatched');
});

// ── Codex perf-core r1 fixes #3 / #4 / #7 + the owner's frame 14 (MOCKUP-capp-S7a-states.html, approved 2026-10-27) ──
const heldRead = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };
test('perf-core r1 #3: a function-form host is never overridden — refused at dispatch, then the host says available ⇒ placement re-enabled', async () => {
  let hostSold = false; let key = null;
  const b = bootCo({ mountOpts: { unavailable: () => hostSold, readAvailability: () => Promise.resolve([key]) } });
  key = b.plain.key;
  await toPlacing(b, 'cash'); b.timers.flush(); await settle();
  assert.equal(b.srv.of('createOrder').length, 0, 'premise: the dispatch read refused it');
  hostSold = true; b.ui.render(); await settle();
  assert.equal(b.q('#layer [data-act="checkout"]').disabled, true, 'the host now reports it sold: «Ir al checkout» disabled');
  hostSold = false; b.ui.render(); await settle();
  assert.equal(b.q('#layer [data-act="checkout"]').disabled, true, 'a mere re-render is NOT an availability update: the refusal stands (r2 #6)');
  b.ui.availabilityUpdated(); await settle();
  assert.equal(b.q('#layer [data-act="checkout"]').disabled, false, '🔴 the host says available again ⇒ re-enabled (no stale override)');
  assert.equal(b.q('#layer .cline.sold-out'), null, 'the mark cleared with it');
});
test('perf-core r1 #4: a DESTROYED mount never applies its held read to the host\'s live Set', async () => {
  const sold = new Set(); const d = heldRead();
  const b = bootCo({ mountOpts: { unavailable: sold, readAvailability: () => d.p } });
  await toPlacing(b, 'cash'); b.timers.flush(); await settle();
  b.ui.destroy();
  sold.add('host-newer');   // the host's newer state, after the mount died
  d.res([]); await settle();
  assert.deepEqual([...sold], ['host-newer'], '🔴 the stale read did not clear the host\'s newer state');
  assert.equal(b.srv.of('createOrder').length, 0, 'and nothing was sent');
});
test('perf-core r1 #7: «Usar otra tarjeta» (which calls placeTap directly) never starts a countdown for a sold line — it opens the cart instead', async () => {
  const storage = memStore();
  const { id, snap } = await cardRedirected(storage);
  const sold = new Set();
  const c = bootCo({ storage, search: RET('cancel', id), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }], chargeOnlineOrder: [CHECKOUT] }, mountOpts: { unavailable: sold } });
  c.ui.restore(snap); await c.ui.returning; await settle();
  assert.deepEqual(c.qa('#layer .errsheet .acts button').map((x) => x.textContent), ['Pagar en efectivo', 'Usar otra tarjeta'], 'premise: the definitive-cancel sheet');
  sold.add(c.plain.key);
  await c.click('#layer [data-act="err-card"]'); await settle();
  assert.notEqual(c.q('#layer .sheet') && c.q('#layer .sheet').getAttribute('aria-label'), 'Realizando pedido', '🔴 no countdown for a sold line');
  assert.ok(c.text('#layer .cartnote[role="status"]').includes('se agotó'), 'the cart explains which dish sold out');
  c.timers.flush(); await settle();
  assert.equal(c.srv.of('chargeOnlineOrder').length, 0, 'nothing is charged');
});
test('frame 14: a sold cart line keeps its row — «Agotado» in the price slot, + inert, trash live; one note line per dish; Subtotal and «Ir al checkout» exclude / wait', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold } });
  const m = b.ui.menu; const other = m.dishes.find((x) => !x.launcher && !x.variantOf && x.key !== b.plain.key && !m.pickupOnlyCats.has(String(x.cat)));
  b.ui.cart.inc(b.plain.key); b.ui.cart.inc(other.key); b.ui.render(); await b.click('#cart-bar');
  const before = b.qa('#layer .cline').map((l) => l.children.length);
  sold.add(b.plain.key); b.ui.render(); await settle();
  const line = b.qa('#layer .cline').find((l) => l.classList.contains('sold-out'));
  assert.ok(line, 'the sold line is marked');
  assert.deepEqual(b.qa('#layer .cline').map((l) => l.children.length), before, '🔴 no new element in any row (no row growth)');
  assert.equal(b.text(line.querySelector('.cl-p')), 'Agotado', '«Agotado» takes the price slot');
  assert.equal(line.querySelector('[data-rev="1"]').disabled, true, 'its + is inert');
  assert.equal(line.querySelector('[data-rev="-1"]').disabled, false, 'its trash stays live');
  assert.equal(b.text('#layer .cartnote[role="status"]'), `${b.plain.name} se agotó. Quitalo para enviar tu pedido.`, 'the approved note, one line for the one dish');
  assert.equal(b.text('#layer .ctot .sumrow'), `Subtotal L ${other.price}`, '🔴 the Subtotal leaves the sold line out');
  assert.equal(b.q('#layer [data-act="checkout"]').disabled, true, '🔴 «Ir al checkout» waits until it is removed');
  line.querySelector('[data-rev="1"]').disabled = false; await b.click(line.querySelector('[data-rev="1"]'));
  assert.equal(b.ui.cart.count(), 2, '🔴 the + handler itself refuses a sold line (not only the disabled attribute)');
  b.q('#layer [data-act="checkout"]').disabled = false; await b.click('#layer [data-act="checkout"]');
  assert.equal(b.events.some((e) => e[0] === 'checkout'), false, '🔴 the checkout handler itself waits too');
  b.ui.render(); await settle();
  await b.click(b.qa('#layer .cline').find((l) => l.classList.contains('sold-out')).querySelector('[data-rev="-1"]'));
  assert.equal(b.q('#layer .cartnote[role="status"]'), null, 'removed ⇒ the note clears');
  assert.equal(b.q('#layer [data-act="checkout"]').disabled, false, 'removed ⇒ «Ir al checkout» is live again');
});
test('frame 14: two sold dishes ⇒ one note line EACH; an update that says a dish is back clears its mark', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold } });
  const m = b.ui.menu; const other = m.dishes.find((x) => !x.launcher && !x.variantOf && x.key !== b.plain.key && !m.pickupOnlyCats.has(String(x.cat)));
  b.ui.cart.inc(b.plain.key); b.ui.cart.inc(other.key); b.ui.render(); await b.click('#cart-bar');
  sold.add(b.plain.key); sold.add(other.key); b.ui.render(); await settle();
  assert.deepEqual(b.qa('#layer .cartnote[role="status"] .cn-l').map((x) => x.textContent), [`${b.plain.name} se agotó. Quitalo para enviar tu pedido.`, `${other.name} se agotó. Quitalo para enviar tu pedido.`]);
  sold.delete(other.key); b.ui.render(); await settle();
  assert.deepEqual(b.qa('#layer .cline.sold-out').length, 1, 'the dish that came back is no longer marked');
});
test('frame 14: a dish that sells out while on «Entrega & Pago» — the summary\'s + refuses it there too', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold } });
  await filled(b, 'cash'); await b.click('[data-act="sumtoggle"]');
  const plus = b.q(`[data-act="rev"][data-rev="1"][data-key="${b.plain.key}"]`);
  assert.ok(plus && !b.q('#layer .sheet'), 'premise: the checkout summary\'s own + (no layer open)');
  sold.add(b.plain.key);
  await b.click(plus);
  assert.equal(b.ui.cart.count(), 1, '🔴 the checkout summary\'s + handler refuses a sold line');
});
for (const pay of ['cash', 'online']) {
  test(`perf-core r2 #6 (${pay}): a FUNCTION host refused at dispatch ⇒ the cart shows frame 14 (note, mark, Subtotal, CTA, + gate) until an update or removal`, async () => {
    let key = null;
    const b = bootCo({ script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }] },
      mountOpts: { unavailable: () => false, readAvailability: () => Promise.resolve([key]) } });
    key = b.plain.key;
    await toPlacing(b, pay); b.timers.flush(); await settle();
    assert.equal(sent(b), 0, 'premise: refused at dispatch');
    const line = b.qa('#layer .cline').find((l) => l.classList.contains('sold-out'));
    assert.ok(line, '🔴 the refused line carries the frame-14 mark (function host)');
    assert.equal(b.text('#layer .cartnote[role="status"]'), `${b.plain.name} se agotó. Quitalo para enviar tu pedido.`, '🔴 the note is shown');
    assert.equal(b.text('#layer .ctot .sumrow'), 'Subtotal L 0', '🔴 the Subtotal leaves it out (no L 340)');
    assert.equal(b.q('#layer [data-act="checkout"]').disabled, true, '🔴 «Ir al checkout» waits');
    line.querySelector('[data-rev="1"]').disabled = false; await b.click(line.querySelector('[data-rev="1"]'));
    assert.equal(b.ui.cart.count(), 1, '🔴 + stays 1 → 1');
    b.ui.availabilityUpdated(); await settle();
    assert.equal(b.q('#layer .cline.sold-out'), null, 'the host\'s authoritative update clears the refusal');
  });
}
test('perf-core r2 #6: removing the refused line clears its refusal (the dish is not left sold elsewhere)', async () => {
  let key = null;
  const b = bootCo({ mountOpts: { unavailable: () => false, readAvailability: () => Promise.resolve([key]) } });
  key = b.plain.key;
  await toPlacing(b, 'cash'); b.timers.flush(); await settle();
  assert.ok(b.q('#layer .cline.sold-out'), 'premise: refused');
  await b.click(b.q('#layer .cline.sold-out [data-rev="-1"]'));
  assert.equal(b.ui.cart.count(), 0, 'removed');
  b.ui.state.layerKind = null; b.ui.state.screen = 'store'; b.ui.render(); await settle();   // back on the menu
  await b.click(`.qty-add-btn[data-id="${b.plain.key}"]`);   // the store's own + (its handler refuses a sold dish)
  assert.equal(b.ui.cart.count(), 1, '🔴 removed ⇒ the refusal is gone: the dish can be added again');
});
test('perf-core r3 #1 (Set host): a sold dish\'s item-detail «+» is inert — disabled, and its handler refuses; − stays live', async () => {
  const sold = new Set();
  const b = bootCo({ mountOpts: { unavailable: sold } });
  b.ui.cart.inc(b.plain.key); sold.add(b.plain.key); b.ui.render(); await settle();
  await b.click(`.txtbtn[data-id="${b.plain.key}"]`);
  const plus = b.q('#detail-step [data-delta="1"]'), minus = b.q('#detail-step [data-delta="-1"]');
  assert.equal(plus.disabled, true, '🔴 the detail + is disabled for a sold dish');
  assert.equal(minus.disabled, false, 'its − stays live (removal stays possible)');
  plus.disabled = false; await b.click(plus);
  assert.equal(b.ui.cart.count(), 1, '🔴 the detail + handler itself refuses (1 → 1)');
});
test('perf-core r3 #1 (function host): after a dispatch refusal the item-detail «+» is inert too', async () => {
  let key = null;
  const b = bootCo({ mountOpts: { unavailable: () => false, readAvailability: () => Promise.resolve([key]) } });
  key = b.plain.key;
  await toPlacing(b, 'cash'); b.timers.flush(); await settle();
  assert.ok(b.q('#layer .cline.sold-out'), 'premise: refused at dispatch');
  b.ui.state.layerKind = null; b.ui.state.screen = 'store'; b.ui.render(); await settle();
  await b.click(`.txtbtn[data-id="${b.plain.key}"]`);
  const plus = b.q('#detail-step [data-delta="1"]');
  assert.equal(plus.disabled, true, '🔴 the refused dish\'s detail + is disabled');
  plus.disabled = false; await b.click(plus);
  assert.equal(b.ui.cart.count(), 1, '🔴 the detail + handler refuses the refused dish (1 → 1)');
});


// ── S7a-2 (PLAN-capp-S7a r2 §2.2): the guest location SEEDS the checkout pin — decided ONCE, before any render can geocode ──
const SEED = { lat: 15.531, lng: -88.021, confirmed: true };
const geoCount = () => { const g = { n: 0, getCurrentPosition(ok) { g.n++; ok({ coords: { latitude: 15.52, longitude: -88.04 } }); } }; return g; };
test('S7a-2 seed: a FRESH store entry ⇒ the checkout flow is created with the guest pin; ONE geocode at it; the device is not asked', async () => {
  const geo = geoCount();
  const b = bootGeo({ geo, mountOpts: { seedPin: () => SEED } });
  await toCheckout(b); await settle();
  assert.deepEqual(J(b.ui.state.flow.pin), SEED, '🔴 the flow is created with the guest pin');
  assert.equal(geo.n, 0, 'a seeded pin ⇒ no geolocation request');
  assert.deepEqual(b.gc.map((r) => r.at), [{ lat: SEED.lat, lng: SEED.lng }], '🔴 one geocode, at the seed');
});
test('S7a-2 seed: an EXISTING flow is never reseeded — a guest location that changes later neither moves the pin nor geocodes again', async () => {
  let seed = SEED;
  const b = bootGeo({ geo: geoCount(), mountOpts: { seedPin: () => seed } });
  await toCheckout(b); await settle();
  const before = J(b.ui.state.flow.pin);
  seed = { lat: 15.6, lng: -88.1, confirmed: true };
  b.ui.deviceBack(); await settle(); await b.click('[data-act="checkout"]'); await settle();
  assert.deepEqual(J(b.ui.state.flow.pin), before, 'the mount\'s own flow wins');
  assert.equal(b.gc.length, 1, 'no second geocode');
});
test('S7a-2 seed: a RESTORED return wins over the guest location — its own pin, ONE geocode at it, the seed never applied', async () => {
  const storage = memStore();
  const { id, snap } = await cardRedirected(storage);
  const gc = []; let seedAsked = 0;
  const c = bootCo({ storage, search: RET('cancel', id), config: { mapsKey: 'k_test' }, pre: (w) => { gmaps(w, gc); }, mountOpts: { seedPin: () => { seedAsked++; return SEED; } },
    script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] } });
  c.ui.restore(snap); await c.ui.returning; await settle();
  assert.notDeepEqual({ lat: c.ui.state.flow.pin.lat, lng: c.ui.state.flow.pin.lng }, { lat: SEED.lat, lng: SEED.lng });
  assert.equal(gc.length, 1); assert.deepEqual(gc[0].at, { lat: c.ui.state.flow.pin.lat, lng: c.ui.state.flow.pin.lng }, '🔴 the restored pin, once');
  assert.equal(seedAsked, 0, 'the seed is not even read');
});
test('S7a-2 seed: a pin the customer confirms (pin step «Listo», a GPS fix) is reported to the shell (onEvent pin)', async () => {
  const b = bootCo({ geo: geoCount() });
  await toCheckout(b); await settle();
  assert.deepEqual(J(b.events.filter(([n]) => n === 'pin').map(([, d]) => d)), [{ lat: 15.52, lng: -88.04, confirmed: true, source: 'gps' }]);
  await b.click('[data-act="pin"]'); b.ui.state.pinDraft = { lat: 15.5, lng: -88 }; await b.click('[data-act="pin-done"]');
  assert.deepEqual(J(b.events.filter(([n]) => n === 'pin').at(-1)[1]), { lat: 15.5, lng: -88, confirmed: true, source: 'pin' });
});

// ── frame 12 (owner-approved 2026-10-27, D1 ruled (a)): «Agotado» takes the PRICE SLOT — no marks line, so the row never grows ──
test('frame 12: a dish that sells out while the menu is open shows «Agotado» in its price slot; no marks line is added; its + is dimmed', () => {
  const sold = new Set();
  const b = boot('x_pizza', { unavailable: sold });
  const d = b.ui.menu.dishes.find((x) => !x.launcher && !x.variantOf && !x.tags.length);
  const row = () => b.q(`#dish-${d.key}`);
  const before = { kids: row().querySelector('.txtbtn').children.length, marks: !!row().querySelector('.marks') };
  sold.add(d.key); b.ui.render();
  assert.equal(b.text(`#dish-${d.key} .prrow .pr`), 'Agotado', '«Agotado» is the price');
  assert.equal(!!row().querySelector('.marks'), before.marks, '🔴 no marks line appears (no row growth)');
  assert.equal(row().querySelector('.txtbtn').children.length, before.kids, 'the same nodes, the price text replaced');
  assert.ok(row().classList.contains('sold-out'), 'P\'s .sold-out dims its +');
  sold.delete(d.key); b.ui.render();
  assert.equal(b.text(`#dish-${d.key} .prrow .pr`), `L ${d.price}`, 'back on sale ⇒ its price again');
});

// ── Codex s7a2 r1 #2 (P1): frame 10's status read RELEASES the payment lock once the server answers definitively ──
test('Codex s7a2 r1 #2: a pending cancel return locks the order; «Ver estado del pedido» → paid ⇒ the lock is released and the store can be left', async () => {
  const storage = memStore();
  const a = bootCo({ storage, config: HOSTED_KEYS, script: { chargeOnlineOrder: [CHECKOUT] } });
  await placeVia(a, 'online'); const id = a.srv.of('chargeOnlineOrder')[0].body.order_id; const snap = J(a.ui.cart.snapshot()); a.ui.destroy();
  const H = shellHist();
  const c = bootCo({ storage, search: RET('cancel', id), config: HOSTED_KEYS, mountOpts: { history: H.adapter },
    script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }, { status: 200, json: { ok: true, state: 'paid' } }] } });
  c.ui.restore(snap); await c.ui.returning; await settle();
  await c.click('#layer [data-act="lclose"]');
  assert.equal(c.ui.deviceBack('leave'), 'blocked', 'premise: locked');
  c.ui.state.screen = 'store'; c.ui.render(); await settle();
  assert.ok(c.ui.openCart(), 'premise: the cart opens');
  await c.click('#layer [data-act="frozen-status"]'); await settle(); await settle();
  assert.notEqual(c.ui.deviceBack('leave'), 'blocked', '🔴 a definitive «paid» releases the lock: the customer can leave');
});

// ── PLAN-capp-signin-required r5.4 G1 (frozen approved mockup 2026-10-27, frames 1 / 1b / 6): app guests pay CARD ONLY, leave an
//    email, and ONE invariant refuses any guest cash dispatch locally. DARK behind cfg.guestCardOnly (absent ⇒ the S2 checkout) ──
const GUEST = { guestCardOnly: true };
EP.requestCheckoutCode = '/x/rc'; EP.verifyCheckoutCode = '/x/vc';   // the confirmed wire contract (advisor 2026-10-27), for the scripted server
const CODE_OK = { requestCheckoutCode: [{ status: 200, json: { ok: true, resend_in_s: 41 } }], verifyCheckoutCode: [{ status: 200, json: { ok: true, checkout_ticket: 'tk_1' } }] };
async function viaCode(b, code = '482913') {   // the frame-2 sheet: the code pasted whole, then «Verificar y hacer pedido»
  await settle(); const box = b.q('#layer .otp input[data-i="0"]'); assert.ok(box, 'premise: the code sheet'); box.value = code; box.dispatchEvent(new b.w.Event('input', { bubbles: true })); await settle();
  await b.click('#layer [data-act="otp-verify"]'); await settle();
}
async function guestFilled(b, email = 'ana.perez@gmail.com') {
  await toCheckout(b);
  await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]');
  await b.type('#f-details', 'Portón negro'); await b.type('#f-name', 'Ana'); await b.type('#f-phone', '9999 0000');
  if (email !== null) await b.type('#f-email', email);
}
test('G1 frame 1: a guest sees ONE payment option (card, selected), cash ABSENT, the fixed line; «Tus datos» = the sign-in row, the WhatsApp note, a required email, «Agregar notas»', async () => {
  const b = bootCo({ config: GUEST });
  await toCheckout(b); await settle();
  assert.deepEqual(b.qa('[data-act="pay"]').map((x) => [x.dataset.val, x.getAttribute('aria-pressed')]), [['online', 'true']], '🔴 cash is absent for a guest');
  assert.equal(b.ui.state.flow.pay, 'online');
  assert.equal(b.text('.paynote'), 'Pagás con tarjeta. Creá una cuenta para pagar en efectivo y sumar recompensas.');
  assert.equal(b.text('[aria-label="Tus datos"] .signin .primary'), 'Entrá o creá tu cuenta');
  assert.equal(b.q('[aria-label="Tus datos"] .signin .primary').dataset.act, 'signin');
  assert.equal(b.text('#f-phone + .note'), 'Te enviamos un código por WhatsApp para confirmarlo. Al continuar aceptás recibir mensajes de WhatsApp sobre este pedido.');
  assert.equal(b.text('label[for="f-email"]'), 'Correo * · para tu recibo');
  assert.equal(b.text('[aria-label="Tus datos"] [data-act="more"]'), 'Agregar notas');
  assert.ok(!/¿Ya tenés cuenta\?/.test(b.text('[aria-label="Tus datos"]')), 'the small link is replaced by the row');
  const m = bootCo({ config: GUEST, member: MEMBER_LIKE() });
  await toCheckout(m); await settle();
  assert.ok(m.qa('[data-act="pay"]').length === 0 || m.q('[data-act="pay"][data-val="cash"]') || m.q('[data-act="showpay"]'), 'a member keeps today\'s payment choice');
});
const MEMBER_LIKE = () => ({ uid: 'u1', name: 'Ana Pérez', phone: '96123344', email: 'ana@x.com', idToken: 'tok', lastPay: 'cash' });
test('G1 frame 1b: the guest email is required (format only) — empty or invalid ⇒ «Revisá tu correo»; invalid ⇒ the field red; valid ⇒ the next step', async () => {
  const b = bootCo({ config: GUEST });
  await guestFilled(b, null); await settle();
  assert.equal(b.text('#cta'), 'Revisá tu correo', '🔴 an empty email blocks a guest');
  await b.type('#f-email', 'ana.perez@gmail'); b.ui.render(); await settle();
  assert.equal(b.text('#cta'), 'Revisá tu correo'); assert.ok(b.q('#f-email').closest('.fld').classList.contains('bad'), 'the drawn red field');
  await b.type('#f-email', 'ana.perez@gmail.com'); await settle();
  assert.ok(!b.q('#f-email').closest('.fld').classList.contains('bad'), 'the red clears as soon as it is valid');
  assert.notEqual(b.text('#cta'), 'Revisá tu correo');
});
test('G1 §3.2: ONE invariant — a guest flow carrying cash (a restore, a stale tender) is refused LOCALLY with frame 6 at the tap, at send and at «Pagar en efectivo»; zero sends', async () => {
  const b = bootCo({ config: GUEST, script: { chargeOnlineOrder: [CHECKOUT] } });
  await guestFilled(b); await settle();
  b.ui.state.flow.pay = 'cash';   // as a restore / stale state would leave it
  await b.click('#cta'); await settle();
  if (b.q('[data-act="tipc"]')) { await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); }
  await settle();
  assert.equal(b.text('#layer .errsheet h2'), 'No pudimos enviar tu pedido');
  assert.equal(b.text('#layer .errsheet p'), 'El pago en efectivo es solo para cuentas. Pagá con tarjeta o creá tu cuenta.', '🔴 frame 6, refused locally');
  assert.equal(writes(b), 0, '🔴 nothing sent');
  assert.deepEqual(b.qa('#layer .errsheet button').map((x) => [x.textContent.trim(), x.dataset.act]), [['Pagar con tarjeta', 'guest-card'], ['Creá tu cuenta', 'guest-signup']]);
  await b.click('#layer [data-act="guest-card"]'); await settle();
  assert.equal(b.ui.state.flow.pay, 'online', '«Pagar con tarjeta» selects card');
});
test('G1 §3.2: «Pagar en efectivo» on a guest\'s failed-card sheet never reaches cash — frame 6, no pay-cash host event', async () => {
  const b = bootCo({ config: GUEST });
  await guestFilled(b); await settle();
  b.ui.state.err = null; b.ui.state.layerKind = 'err';
  // the failed-card sheet, as the outcome renders it
  b.ui.state.err = { title: 'Pago no completado', body: '…', acts: [{ act: 'err-cash', label: 'Pagar en efectivo', primary: true }] }; b.ui.render(); await settle();
  await b.click('#layer [data-act="err-cash"]'); await settle();
  assert.equal(b.text('#layer .errsheet p'), 'El pago en efectivo es solo para cuentas. Pagá con tarjeta o creá tu cuenta.');
  assert.ok(!b.events.some(([n]) => n === 'pay-cash'), '🔴 a guest never reaches cash');
});
test('G1 §3.2 transport: the api itself refuses a guest cash placement before any record or send (guest_cash_not_allowed, local)', async () => {
  const storage = memStore();
  const api = CA.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: EP, guestCardOnly: true }, CappCheckout: CK, member: null,
    fetch: async () => { throw new Error('🔴 nothing may be sent'); }, storage, now: () => NOON().getTime(), sleep: async () => {} });
  const f = CK.freshFlow(null); f.pay = 'cash';
  const out = await api.place({ flow: f, ctx: { restaurantId: 'rid_a', items: [], itemsText: '', member: null, headers: {} } });
  assert.deepEqual(J(out), { kind: 'guest_cash_not_allowed', local: true });
  f.pay = 'online';
  assert.deepEqual(J(await api.place({ flow: f, ctx: { restaurantId: 'rid_a', items: [], itemsText: '', member: null, headers: {} } })), { kind: 'guest_ticket_invalid', local: true }, '🔴 §4: no ticket ⇒ nothing recorded or sent');
  assert.deepEqual(J(await api.place({ flow: f, checkoutTicket: { ticket: 'tk', expires_at: NOON().getTime() - 1 }, ctx: { restaurantId: 'rid_a', items: [], itemsText: '', member: null, headers: {} } })), { kind: 'guest_ticket_invalid', local: true }, 'an expired ticket is no ticket');
  assert.equal(storage.getItem('capp:rid_a:pending_place'), null); assert.equal(storage.getItem('ta_pending_pay'), null);
});
test('G1 server refusals: guest_email_required ⇒ frame 1b (the email red, «Revisá tu correo» until edited); guest_cash_not_allowed ⇒ frame 6', async () => {
  const b = bootCo({ config: GUEST, script: { ...CODE_OK, chargeOnlineOrder: [{ status: 400, json: { ok: false, error: 'guest_email_required' } }] } });
  await guestFilled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await viaCode(b); await settle();
  assert.equal(b.ui.state.screen, 'checkout'); assert.equal(b.text('#cta'), 'Revisá tu correo', '🔴 the server\'s email refusal shows frame 1b');
  assert.ok(b.q('#f-email').closest('.fld').classList.contains('bad'));
  await b.type('#f-email', 'ana.perez@gmail.com.hn'); await settle();
  assert.notEqual(b.text('#cta'), 'Revisá tu correo', 'editing the email clears it');
  const c = bootCo({ config: GUEST, script: { ...CODE_OK, chargeOnlineOrder: [{ status: 400, json: { ok: false, error: 'guest_cash_not_allowed' } }] } });
  await guestFilled(c); await c.click('#cta'); await c.click('[data-act="tipc"][data-val="0"]'); await c.click('[data-act="tip-place"]'); await viaCode(c); await settle();
  assert.equal(c.text('#layer .errsheet p'), 'El pago en efectivo es solo para cuentas. Pagá con tarjeta o creá tu cuenta.');
});

// ── G2 frame 1c (approved): the sign-in row atop a guest's «Tus datos», two variants, chosen by the LOCAL device marker (§4c) ──
test('G2 frame 1c: a device that had an account ⇒ «Ya tenés cuenta en este teléfono» + «Entrá de nuevo · ···· 3344» (last 4 only); its tap pre-fills the FULL number; no marker ⇒ «Entrá o creá tu cuenta»', async () => {
  const b = bootCo({ config: GUEST, mountOpts: { deviceAccount: () => ({ e164: '+50496123344', last4: '3344' }) } });
  await toCheckout(b); await settle();
  assert.equal(b.text('.signin .note'), 'Ya tenés cuenta en este teléfono');
  assert.equal(b.text('.signin .primary'), 'Entrá de nuevo · ···· 3344');
  assert.ok(!/96123344|9612/.test(b.q('.signin').textContent), '🔴 only the last 4 digits are displayed');
  await b.click('.signin .primary');
  assert.deepEqual(J(b.events.filter(([n]) => n === 'signin').at(-1)[1]), { ctx: 'checkout-returning', prefill: '+50496123344' }, '🔴 the full number is pre-filled at sign-in');
  assert.equal(b.ui.state.screen, 'checkout', 'the checkout step is kept');
  const n = bootCo({ config: GUEST, mountOpts: { deviceAccount: () => null } });
  await toCheckout(n); await settle();
  assert.equal(n.text('.signin'), 'Entrá o creá tu cuenta'); assert.equal(n.q('.signin .note'), null);
  const x = bootCo({ config: GUEST, mountOpts: { deviceAccount: () => { throw new Error('storage'); } } });
  await toCheckout(x); await settle();
  assert.equal(x.text('.signin'), 'Entrá o creá tu cuenta', 'an unreadable marker degrades to the plain row');
});

// ── G3 (frames 2, 2b–2d, 3a, 3b): the guest's WhatsApp code — asked at «Hacer pedido», nothing sent until it verifies ──
async function toCodeSheet(b) { await guestFilled(b); await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await settle(); }
test('G3 frame 2: «Hacer pedido» ⇒ the code sheet (nothing sent): the code is requested for THIS phone, store and cart; a whole pasted code fills the six boxes; verify ⇒ the order goes out WITH its ticket', async () => {
  const b = bootCo({ config: GUEST, script: { ...CODE_OK, chargeOnlineOrder: [CHECKOUT] } });
  await toCodeSheet(b);
  assert.equal(b.text('#layer .sg .bm'), 'Confirmá tu WhatsApp'); assert.equal(b.text('#layer .sg .h1'), 'Ingresá el código');
  assert.match(b.text('#layer .sg .sub'), /^Te lo enviamos por WhatsApp al \+504 9999.?0000 ?\.$/);
  assert.equal(b.qa('#layer .otp input').length, 6); assert.ok(b.q('#layer [data-act="otp-verify"]').disabled, 'disabled until the sixth digit');
  assert.equal(b.text('#layer .sg .fine'), 'No creamos una cuenta; solo confirmamos que este número es tuyo. Tu pedido sale al verificar.');
  assert.equal(writes(b), 0, '🔴 nothing sent behind the sheet');
  const rq = b.srv.of('requestCheckoutCode')[0].body;
  assert.deepEqual(rq, { phone_e164: '+50499990000', restaurant_id: 'rid_a', cart_fp: String(b.ui.state.q.sig) }, 'bound to phone + store + cart');
  const box = b.q('#layer .otp input[data-i="0"]'); box.value = '482 913'; box.dispatchEvent(new b.w.Event('input', { bubbles: true })); await settle();
  assert.deepEqual(b.qa('#layer .otp input').map((x) => x.value), ['4', '8', '2', '9', '1', '3'], 'a pasted code (with a space) fills all six');
  assert.match(b.text('#layer [data-act="otp-verify"]'), /^Verificar y hacer pedido · L /); assert.ok(!b.q('#layer [data-act="otp-verify"]').disabled);
  await b.click('#layer [data-act="otp-verify"]'); await settle();
  const vb = b.srv.of('verifyCheckoutCode')[0].body;
  assert.deepEqual(vb, { ...rq, order_id: vb.order_id, code: '482913' });
  assert.equal(b.q('#layer [data-act="placing-go"]'), null, '🔴 no «Realizando pedido…» window after verify (the tap is the commit)');
  assert.equal(b.srv.of('chargeOnlineOrder')[0].body.checkout_ticket, 'tk_1', '🔴 the order carries its ticket');
  assert.match(vb.order_id, /^TA\d{6}-\d{6}-[0-9A-Z]{8}$/, 'the client-minted id (the forms\' genOrderId shape)');
  assert.equal(b.srv.of('chargeOnlineOrder')[0].body.order_id, vb.order_id, '🔴 the order is placed under the order id its code was verified for');
});
test('G3 frames 2b–2d: wrong ⇒ red boxes + one red line, cleared; expired ⇒ the amber line + «Reenviar código» at once; too many ⇒ boxes inert + minutes + the two exits; never sent', async () => {
  const b = bootCo({ config: GUEST, script: { requestCheckoutCode: [{ status: 200, json: { ok: true, resend_in_s: 41 } }],
    verifyCheckoutCode: [{ status: 400, json: { ok: false, error: 'code_wrong' } }, { status: 400, json: { ok: false, error: 'code_expired' } }, { status: 429, json: { ok: false, error: 'too_many_attempts', retry_in_s: 540 } }] } });
  await toCodeSheet(b);
  await viaCode(b);
  assert.ok(b.q('#layer .otp').classList.contains('bad')); assert.equal(b.text('#layer .inline.err'), 'Ese código no es. Revisalo e intentá de nuevo.');
  assert.deepEqual(b.qa('#layer .otp input').map((x) => x.value), ['', '', '', '', '', ''], 'cleared'); assert.match(b.text('#layer .rowx'), /^Reenviar en 0:41 Cambiar número$/);
  await viaCode(b);
  assert.equal(b.text('#layer .inline.warn'), 'Este código ya venció. Pedí uno nuevo.'); assert.equal(b.text('#layer .rowx'), 'Reenviar código Cambiar número');
  await viaCode(b);
  assert.equal(b.text('#layer .inline.mute'), 'Demasiados intentos. Probá de nuevo en 9 min.');
  assert.ok(b.q('#layer .otp').classList.contains('off') && b.qa('#layer .otp input').every((x) => x.disabled));
  assert.equal(b.text('#layer .rowx'), 'Cambiar número ¿Ya tenés cuenta? Entrá');
  assert.equal(writes(b), 0, '🔴 never sent');
});
test('G3 frames 3a / 3b: the code could not be sent ⇒ «Intento 2 de 3» with «Reintentar»; the last attempt ⇒ «Reintentar en m:ss» disabled + «Cambiar número» + «Volver al pedido»; never sent', async () => {
  const b = bootCo({ config: GUEST, script: { requestCheckoutCode: [{ status: 502, json: { ok: false, error: 'send_failed', attempt: 2, max_attempts: 3 } }, { status: 502, json: { ok: false, error: 'send_failed', attempt: 3, max_attempts: 3 } }] } });
  await toCodeSheet(b);
  assert.equal(b.text('#layer .errsheet h2'), 'No pudimos enviar tu código por WhatsApp');
  assert.match(b.text('#layer .errsheet p'), /^Revisá que \+504 9999.?0000 tenga WhatsApp y señal\. Tu pedido está intacto; no se envió ni se cobró nada\.$/);
  assert.equal(b.text('#layer .errsheet .note'), 'Intento 2 de 3'); assert.ok(b.q('#layer .errsheet .icon.warn'));
  assert.deepEqual(b.qa('#layer .errsheet button').map((x) => x.textContent), ['Reintentar', 'Cambiar número']);
  await b.click('#layer [data-act="otp-resend"]'); await settle();
  assert.equal(b.text('#layer .errsheet p'), 'Lo intentamos 3 veces sin éxito. Tu pedido no se envió ni se cobró nada. Probá con otro número, o entrá con tu cuenta.');
  const btns = b.qa('#layer .errsheet button'); assert.match(btns[0].textContent, /^Reintentar en 10:00$/); assert.ok(btns[0].disabled, '🔴 3b: «Reintentar» waits out the block');
  assert.deepEqual(btns.slice(1).map((x) => x.textContent), ['Cambiar número', 'Volver al pedido']);
  assert.equal(writes(b), 0, '🔴 never sent');
  await b.click('#layer [data-act="otp-change"]'); await settle();
  assert.equal(b.ui.state.screen, 'checkout'); assert.equal(b.w.document.activeElement && b.w.document.activeElement.id, 'f-phone', '«Cambiar número» ⇒ Tus datos, the phone focused');
});
test('G3: a server guest_ticket_invalid (expired / consumed) ⇒ the code sheet again, nothing else sent', async () => {
  const b = bootCo({ config: GUEST, script: { requestCheckoutCode: [{ status: 200, json: { ok: true, resend_in_s: 41 } }], verifyCheckoutCode: [{ status: 200, json: { ok: true, checkout_ticket: 'tk_1' } }],
    chargeOnlineOrder: [{ status: 400, json: { ok: false, error: 'guest_ticket_invalid' } }] } });
  await toCodeSheet(b); await viaCode(b); await settle();
  assert.ok(b.q('#layer .otp'), '🔴 re-verify'); assert.equal(b.srv.of('requestCheckoutCode').length, 2);
});

// ── G4 frame 4 (approved): a MEMBER whose session did not verify server-side is never turned into a cash guest ──
test('G4 frame 4: a member\'s order refused by the GUEST gate (token not verified) ⇒ «Tu sesión se interrumpió» + «Volver a entrar»; cash and data intact; never a guest', async () => {
  const b = bootCo({ config: GUEST, member: MEMBER_LIKE(), script: { createOrder: [{ status: 400, json: { ok: false, error: 'guest_cash_not_allowed' } }] } });
  await toCheckout(b); await settle();
  await b.type('#f-details', 'Portón negro'); await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]');
  assert.equal(b.ui.state.flow.pay, 'cash', 'premise: the member pays cash');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]'); await settle();
  assert.equal(b.text('#layer .errsheet h2'), 'Tu sesión se interrumpió');
  assert.equal(b.text('#layer .errsheet p'), 'Volvé a entrar para enviar tu pedido. Tu pedido está intacto y no se cobró nada; tus datos y tu forma de pago quedan igual.');
  assert.ok(b.q('#layer .errsheet .icon.calm'));
  assert.deepEqual(b.qa('#layer .errsheet button').map((x) => [x.textContent, x.dataset.act]), [['Volver a entrar', 'reauth'], ['Cerrar', 'lclose']]);
  assert.equal(b.ui.state.flow.pay, 'cash', '🔴 never silently a guest: the cash tender stays');
  assert.ok(!/El pago en efectivo es solo para cuentas/.test(b.text('#layer')), 'not the guest refusal');
  await b.click('#layer [data-act="reauth"]');
  assert.deepEqual(J(b.events.filter(([n]) => n === 'signin').at(-1)[1]), { ctx: 'reauth' });
});

const CU = createRequire(import.meta.url)('./capp-ui.js');   // the pure renderers, in this realm
// ── G5 frame 7 (approved): the SIGNUP GRANT rides on the placed outcome; the account offer card renders only while it is live ──
test('G5: a guest\'s paid card return carries the signup grant on its placed outcome (frame 7\'s input); a member\'s never does', async () => {
  const storage = memStore();
  const grant = { token: 'sg_1', expires_at: NOON().getTime() + 15 * 60e3 };
  const a = bootCo({ storage, config: GUEST, script: { ...CODE_OK, chargeOnlineOrder: [{ status: 200, json: { ...CHECKOUT.json, signup_grant: grant } }] } });   // the contract: the grant comes with the charge's success
  await guestFilled(a); await a.click('#cta'); await a.click('[data-act="tipc"][data-val="0"]'); await a.click('[data-act="tip-place"]'); await viaCode(a); await settle();
  const id = a.srv.of('chargeOnlineOrder')[0].body.order_id; const snap = J(a.ui.cart.snapshot()); a.ui.destroy();
  // Codex guest r1 #4: the paid status carries NO grant (none is promised) — it comes from this order's stash, across the redirect
  const c = bootCo({ storage, config: GUEST, search: RET('complete', id), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'paid' } }] } });
  c.ui.restore(snap); const out = await c.ui.returning; await settle();
  assert.equal(out.kind, 'placed'); assert.deepEqual(J(out.signup_grant), grant, '🔴 the charge\'s grant reaches the post-order offer across the redirect');
  assert.equal(storage.getItem('ta_pending_pay'), null, 'the stash (and its grant) is cleared once placed');
  const m = CA.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: EP, guestCardOnly: true }, CappCheckout: CK, member: MEMBER_LIKE(),
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, order_id: 'TA1', signup_grant: grant }) }), storage: memStore(), now: () => NOON().getTime(), sleep: async () => {} });
  const f = CK.freshFlow(MEMBER_LIKE()); f.pay = 'cash';
  const mo = await m.place({ flow: f, ctx: { restaurantId: 'rid_a', items: [], itemsText: '', member: MEMBER_LIKE(), headers: {} } });
  assert.equal(mo.signup_grant, undefined, 'a member has no grant to redeem');
});
test('G5 frame 7: the offer card — one benefit, the verified phone (read-only) + «Tu número ya está confirmado.», the email editable, «Crear mi cuenta» / «Ahora no»; nothing without a live grant', () => {
  const JD = JSDOM;
  const html = CU.accountOfferHtml({ grant: { token: 'sg_1', expires_at: 2000 }, now: 1000, phone: '+504 9612-3344', email: 'ana.perez@gmail.com' });
  const d = new JD(`<div>${html}</div>`).window.document;
  assert.equal(d.querySelector('.h1').textContent, 'Guardá tus datos para la próxima');
  assert.equal(d.querySelector('.sub').textContent, 'La próxima vez pedís sin escribir nada ni esperar un código.');
  assert.ok(d.querySelector('#offer-phone').readOnly); assert.equal(d.querySelector('#offer-phone').value, '+504 9612-3344');
  assert.equal(d.querySelector('.badge').textContent.trim(), 'Tu número ya está confirmado.');
  assert.ok(!d.querySelector('#offer-email').readOnly, 'the email can be corrected'); assert.equal(d.querySelector('#offer-email').value, 'ana.perez@gmail.com');
  assert.deepEqual([...d.querySelectorAll('button')].map((b) => [b.textContent, b.dataset.act]), [['Crear mi cuenta', 'offer-create'], ['Ahora no', 'offer-skip']]);
  assert.equal(CU.accountOfferHtml({ grant: { token: 'sg_1', expires_at: 2000 }, now: 2000 }), '', '🔴 an expired grant ⇒ no offer (a normal signup instead)');
  assert.equal(CU.accountOfferHtml({}), '');
});

test('G advisor 2026-10-27: a guest\'s declined card ⇒ «Pago no completado» with NO cash option anywhere — only «Usar otra tarjeta»', async () => {
  const storage = memStore();
  const a = bootCo({ storage, config: GUEST, script: { ...CODE_OK, chargeOnlineOrder: [CHECKOUT] } });
  await guestFilled(a); await a.click('#cta'); await a.click('[data-act="tipc"][data-val="0"]'); await a.click('[data-act="tip-place"]'); await viaCode(a); await settle();
  const id = a.srv.of('chargeOnlineOrder')[0].body.order_id; const snap = J(a.ui.cart.snapshot()); a.ui.destroy();
  const c = bootCo({ storage, config: GUEST, search: RET('cancel', id), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'failed' } }] } });
  c.ui.restore(snap); await c.ui.returning; await settle();
  assert.equal(c.text('#layer .errsheet h2'), 'Pago no completado');
  assert.equal(c.text('#layer .errsheet p'), 'Tu banco no autorizó el pago. Podés intentar con otra tarjeta; tu pedido está intacto.');
  assert.deepEqual(c.qa('#layer .errsheet button').map((x) => [x.textContent, x.dataset.act]), [['Usar otra tarjeta', 'err-card']], '🔴 a guest never sees a cash option');
  assert.ok(!/efectivo/i.test(c.text('#layer')), 'no cash anywhere on the sheet');
  c.ui.state.flow.pay = 'cash';   // whatever the restore left
  await c.click('#layer [data-act="err-card"]'); await settle();
  assert.equal(c.ui.state.flow.pay, 'online', '🔴 «Usar otra tarjeta» explicitly selects online');
  assert.ok(!/No pudimos enviar tu pedido|efectivo/i.test(c.text('#layer') || ''), 'no cash refusal follows');
});

// ── Codex guest r1 #2 / #7: the code sheet's continuations are owned — closing cancels them; every request is bounded ──
test('Codex guest r1 #2: closing the code sheet while its verification waits ⇒ a LATE success never sends (no window, no order)', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const b = bootCo({ config: GUEST, script: { requestCheckoutCode: [{ status: 200, json: { ok: true, resend_in_s: 41 } }], verifyCheckoutCode: [() => held], chargeOnlineOrder: [CHECKOUT] } });
  await toCodeSheet(b);
  const box = b.q('#layer .otp input[data-i="0"]'); box.value = '482913'; box.dispatchEvent(new b.w.Event('input', { bubbles: true })); await settle();
  await b.click('#layer [data-act="otp-verify"]');
  await b.click('#layer [data-act="lclose"]'); await settle();
  release({ status: 200, json: { ok: true, checkout_ticket: 'tk_late' } }); await settle(); await settle();
  assert.equal(writes(b), 0, '🔴 a closed verification never sends'); assert.equal(b.q('#layer [data-act="placing-go"]'), null);
  assert.notEqual(b.ui.state.screen, 'sending');
});
test('Codex guest r1 #7: a hung code request is BOUNDED ⇒ 3a «Intento 1 de 3»; «Reintentar» sends a fresh request; the late first answer is dropped; «Reenviar» is never a silent no-op', async () => {
  let lateFirst; const hung = new Promise((r) => { lateFirst = r; });
  const b = bootCo({ config: GUEST, script: { requestCheckoutCode: [() => hung, { status: 200, json: { ok: true, resend_in_s: 41 } }] } });
  await toCodeSheet(b);
  assert.equal(b.srv.of('requestCheckoutCode').length, 1);
  b.timers.flush(); await settle();   // the bound elapses
  assert.equal(b.text('#layer .errsheet h2'), 'No pudimos enviar tu código por WhatsApp'); assert.equal(b.text('#layer .errsheet .note'), 'Intento 1 de 3', '🔴 a hung request ends in the drawn retry state');
  await b.click('#layer [data-act="otp-resend"]'); await settle();
  assert.equal(b.srv.of('requestCheckoutCode').length, 2, 'a fresh request');
  assert.ok(b.q('#layer .otp'), 'the code sheet again');
  lateFirst({ status: 502, json: { ok: false, error: 'send_failed', attempt: 3, max_attempts: 3 } }); await settle();
  assert.ok(b.q('#layer .otp') && !b.q('#layer .errsheet'), '🔴 the superseded late answer is dropped');
  // «Reenviar código» while a request is still in flight starts a NEW one (never a no-op)
  let hang2; const h2 = new Promise((r) => { hang2 = r; }); void hang2;
  const c = bootCo({ config: GUEST, script: { requestCheckoutCode: [() => h2, { status: 200, json: { ok: true, resend_in_s: 41 } }] } });
  await toCodeSheet(c);
  assert.equal(c.text('#layer .rowx [data-act="otp-resend"]'), 'Reenviar código', 'premise: no timer yet');
  await c.click('#layer .rowx [data-act="otp-resend"]'); await settle();
  assert.equal(c.srv.of('requestCheckoutCode').length, 2, '🔴 «Reenviar» while busy sends a fresh request');
});

test('Codex guest r2 #2: a browser / device BACK while the verification waits ⇒ the late success never sends (one layer teardown)', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const b = bootCo({ config: GUEST, script: { requestCheckoutCode: [{ status: 200, json: { ok: true, resend_in_s: 41 } }], verifyCheckoutCode: [() => held], chargeOnlineOrder: [CHECKOUT] } });
  await toCodeSheet(b);
  const box = b.q('#layer .otp input[data-i="0"]'); box.value = '482913'; box.dispatchEvent(new b.w.Event('input', { bubbles: true })); await settle();
  await b.click('#layer [data-act="otp-verify"]');
  b.ui.deviceBack(); await settle();
  assert.equal(b.q('#layer .otp'), null, 'premise: Back left the sheet');
  release({ status: 200, json: { ok: true, checkout_ticket: 'tk_late' } }); await settle(); await settle();
  assert.equal(writes(b), 0, '🔴 a verification abandoned by Back never sends'); assert.notEqual(b.ui.state.screen, 'sending');
});

// ── S-picker (PLAN-intl-phone r2.3; MOCKUP-intl-phone-picker-APPROVED-2026-10-27 frames 4–6): behind the runtime intlPhone ──
const INTL = { intlPhone: true };
const loadPhone = (w) => w.eval(readFileSync(join(HERE, 'capp-phone.js'), 'utf8'));   // the page loads it (shell.html), as here
const bootIntl = (o = {}) => bootCo({ ...o, config: { ...INTL, ...(o.config || {}) }, pre: loadPhone });
async function intlFilled(b, cc, digits, pay = null) {
  await toCheckout(b); await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]');
  await b.type('#f-details', 'Portón negro'); await b.type('#f-name', 'Ana');
  if (cc) { await b.click('[data-act="cc"]'); await b.click(`#layer [data-act="cc-pick"][data-cc="${cc}"]`); }
  await b.type('#f-phone', digits);
  if (pay) await b.click(`[data-act="pay"][data-val="${pay}"]`);
}
test('S-picker frame 4: the WhatsApp field = the country button «+504» + the input «9999-9999»; flag ABSENT ⇒ today\'s single «+504 9999-9999» input', async () => {
  const b = bootIntl(); await toCheckout(b);
  const row = b.q('.fld .phonerow'); assert.ok(row, 'the phone row');
  assert.equal(b.text('.fld .cc'), '+504'); assert.equal(b.q('.fld .cc').getAttribute('aria-label'), 'País del número: Honduras +504');
  assert.equal(b.q('#f-phone').getAttribute('placeholder'), '9999-9999'); assert.ok(b.q('#f-phone-cc').hidden, 'Honduras: no country note');
  // the flag-absent page (index.html) does not even load the picker module: it must never reach for it
  const o = bootCo(); await toCheckout(o);
  assert.equal(o.ui.state.screen, 'checkout', '🔴 off: the page never reaches for the picker module (its checkout opens)');
  assert.equal(o.q('.fld .phonerow'), null, '🔴 off: no picker without the runtime flag'); assert.equal(o.q('#f-phone').getAttribute('placeholder'), '+504 9999-9999', 'off: unchanged');
});
test('S-picker frame 5: the country sheet — «País del número» + its line, the ten countries in order, the current one in accent with a check; the button shows it open', async () => {
  const b = bootIntl(); await toCheckout(b); await b.click('[data-act="cc"]');
  assert.equal(b.q('#layer .sheet').getAttribute('aria-label'), 'País del número');
  assert.equal(b.text('#layer .sheethead h2'), 'País del número Solo cambia el código de tu WhatsApp. Entregamos únicamente en Honduras.');
  assert.deepEqual(b.qa('#layer .crow').map((r) => [b.text(r), r.classList.contains('on')]), [['Honduras +504', true], ['Estados Unidos +1', false], ['México +52', false], ['Guatemala +502', false],
    ['El Salvador +503', false], ['Nicaragua +505', false], ['Costa Rica +506', false], ['Panamá +507', false], ['Belice +501', false], ['España +34', false]]);
  assert.ok(b.q('#layer .crow.on svg'), 'the check'); assert.equal(b.q('#layer .crow.on').getAttribute('aria-pressed'), 'true');
  assert.ok(b.q('.fld .cc').classList.contains('focus'), 'the button shows the sheet open');
  await b.click('#layer [data-act="lclose"]'); assert.equal(b.q('#layer .sheet'), null); assert.equal(b.text('.fld .cc'), '+504', 'closing changes nothing');
});
test('S-picker frame 6: Estados Unidos ⇒ «+1», «(555) 123-4567», «Estados Unidos · 10 dígitos»; typing formats and caps; complete ⇒ «se guarda como +1 (305) 555-0147»', async () => {
  const b = bootIntl(); await toCheckout(b); await b.click('[data-act="cc"]'); await b.click('#layer [data-act="cc-pick"][data-cc="1"]');
  assert.equal(b.q('#layer .sheet'), null, 'the pick closes the sheet');
  assert.equal(b.text('.fld .cc'), '+1'); assert.equal(b.q('#f-phone').getAttribute('placeholder'), '(555) 123-4567');
  assert.equal(b.text('#f-phone-cc'), 'Estados Unidos · 10 dígitos');
  await b.type('#f-phone', '305555014799');
  assert.equal(b.q('#f-phone').value, '(305) 555-0147', '🔴 the local format, capped at 10');
  assert.equal(b.text('#f-phone-cc'), 'Estados Unidos · 10 dígitos · se guarda como +1 (305) 555-0147');
  await b.click('[data-act="cc"]'); await b.click('#layer [data-act="cc-pick"][data-cc="501"]');
  assert.equal(b.q('#f-phone').value, '305-5550', 'another country keeps the digits, capped to ITS length (Belice 7)');
});
test('S-picker wire: the order carries the chosen country\'s E.164 (+504 too, with the picker on); flag absent ⇒ «+504 9999-0000» as today', async () => {
  const b = bootIntl({ script: { createOrder: [OK_CASH_UI] } }); await intlFilled(b, '1', '3055550147', 'cash');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.srv.of('createOrder')[0].body.customer_phone, '+13055550147', '🔴 E.164 of the chosen country');
  const h = bootIntl({ script: { createOrder: [OK_CASH_UI] } }); await intlFilled(h, null, '9999 0000', 'cash');
  await h.click('#cta'); await h.click('[data-act="tipc"][data-val="0"]'); await h.click('[data-act="tip-place"]'); await h.click('#layer [data-act="placing-go"]');
  assert.equal(h.srv.of('createOrder')[0].body.customer_phone, '+50499990000');
  const o = bootCo({ script: { createOrder: [OK_CASH_UI] } }); await placeVia(o);
  assert.equal(o.srv.of('createOrder')[0].body.customer_phone, '+504 9999-0000', 'off: unchanged');
});
test('S-picker guest code: the WhatsApp code is asked for the chosen country\'s E.164, and the sheet names it in its own format', async () => {
  const b = bootIntl({ config: GUEST, script: CODE_OK }); await intlFilled(b, '1', '3055550147'); await b.type('#f-email', 'ana.perez@gmail.com');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await settle();
  assert.equal(b.srv.of('requestCheckoutCode')[0].body.phone_e164, '+13055550147', '🔴 the code goes to THIS number');
  assert.match(b.text('#layer .sg .sub'), /\+1 \(305\) 555-0147/);
});
test('S-picker restore + member: a stored E.164 keeps its country (the return\'s body, a member\'s number); a bare local number is Honduras', async () => {
  const m = { uid: 'u1', name: 'Ana', phone: '+13055550147', email: 'a@b.co' };
  const b = bootIntl({ member: m }); await toCheckout(b);
  assert.match(b.text(b.q('[data-act="editwho"]').closest('.urow')), /\+1 \(305\) 555-0147/, 'the member row in the number\'s own format');
  await b.click('[data-act="editwho"]'); assert.equal(b.text('.fld .cc'), '+1'); assert.equal(b.q('#f-phone').value, '(305) 555-0147');
  const l = bootIntl({ member: { ...m, phone: '96123344' } }); await toCheckout(l); await l.click('[data-act="editwho"]');
  assert.equal(l.text('.fld .cc'), '+504'); assert.equal(l.q('#f-phone').value, '9612-3344');
});
test('S-picker member path (5f intl recon): a member\'s non-HN number is sent as ITS E.164; an unreadable one opens «Tus datos» in edit and is never sent as a +504 guess', async () => {
  const m = { uid: 'u1', name: 'Ana', phone: '+13055550147', email: 'a@b.co', idToken: 'tok' };
  const b = bootIntl({ member: m, script: { createOrder: [OK_CASH_UI] } }); await toCheckout(b);
  await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]'); await b.type('#f-details', 'Portón negro'); await b.click('[data-act="pay"][data-val="cash"]');
  assert.ok(b.q('[data-act="editwho"]'), 'premise: the member row (no edit)');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.srv.of('createOrder')[0].body.customer_phone, '+13055550147', '🔴 the member\'s own E.164, as-is');
  for (const bad of ['13055550147', '+44 20 7946 0958', '96123', '9612+3344', 'abc96123344', '( +44 ) 123456']) {   // + Codex S-picker r1 #2
    const u = bootIntl({ member: { ...m, phone: bad } }); await toCheckout(u);
    assert.equal(u.q('[data-act="editwho"]'), null, `${bad}: no member row`);
    assert.equal(u.q('#f-phone').value, '', `🔴 ${bad}: never composed into a +504 guess`); assert.equal(u.text('.fld .cc'), '+504');
  }
  // flag absent: today's member path, unchanged (every member is +504)
  const o = bootCo({ member: { ...m, phone: '96123344' }, script: { createOrder: [OK_CASH_UI] } }); await toCheckout(o);
  await o.click('[data-act="pin"]'); await o.click('[data-act="pin-done"]'); await o.type('#f-details', 'Portón negro'); await o.click('[data-act="pay"][data-val="cash"]');
  await o.click('#cta'); await o.click('[data-act="tipc"][data-val="0"]'); await o.click('[data-act="tip-place"]'); await o.click('#layer [data-act="placing-go"]');
  assert.equal(o.srv.of('createOrder')[0].body.customer_phone, '+504 9612-3344', 'off: unchanged');
});
test('Codex S-picker r1 #1: a pasted / autofilled QUALIFIED number is read as E.164 first — its own country, never truncated into the selected one; an unsupported one is refused on blur, nothing sent', async () => {
  for (const [raw, cc, shown] of [['+13055550147', '+1', '(305) 555-0147'], ['+50499990000', '+504', '9999-0000'], ['0013055550147', '+1', '(305) 555-0147'], ['+52 55 1234 5678', '+52', '55 1234 5678']]) {
    const b = bootIntl(); await toCheckout(b); await b.type('#f-phone', raw);
    assert.equal(b.text('.fld .cc'), cc, `🔴 ${raw}: a qualified paste keeps its own country`); assert.equal(b.q('#f-phone').value, shown, `${raw}: its own national digits`);
  }
  const blur = async (b) => { b.q('#f-phone').dispatchEvent(new b.w.FocusEvent('focusout', { bubbles: true })); await settle(); };
  const g = bootIntl({ config: GUEST, script: CODE_OK }); await intlFilled(g, null, '+44 20 7946 0958'); await g.type('#f-email', 'ana.perez@gmail.com');
  assert.equal(g.q('#f-phone').value, '+44 20 7946 0958', 'while typing: kept as typed'); assert.ok(g.q('#cta').disabled, 'incomplete'); assert.equal(cta(g), 'Escribí tu WhatsApp');
  g.q('#f-phone').focus(); await blur(g);
  assert.equal(g.text('.fld .cc'), '+504', 'the country kept'); assert.equal(g.q('#f-phone').value, '', '🔴 an unsupported number is cleared on blur');
  g.q('#cta').dispatchEvent(new g.w.MouseEvent('click', { bubbles: true })); await settle();
  assert.equal(g.srv.of('requestCheckoutCode').length, 0, '🔴 nothing sent for it');
  const w = bootIntl(); await toCheckout(w); await w.type('#f-phone', '+1305555014'); await blur(w);
  assert.deepEqual([w.text('.fld .cc'), w.q('#f-phone').value], ['+504', ''], 'a supported code with the wrong length: refused, never truncated');
});
test('S-picker (advisor): a number TYPED by hand from «+» is never cleared mid-typing, is never complete as national digits, and resolves to its country when the last digit lands', async () => {
  const b = bootIntl({ script: { createOrder: [OK_CASH_UI] } }); await intlFilled(b, null, '', 'cash');
  let typed = '';
  for (const ch of '+13055550147') {
    typed += ch; await b.type('#f-phone', typed);
    if (typed.length < 12) {
      assert.equal(b.q('#f-phone').value, typed, `🔴 «${typed}»: kept as typed, never cleared mid-typing`);
      assert.equal(b.text('.fld .cc'), '+504', 'the country unchanged until it parses');
      assert.ok(b.q('#cta').disabled, `«${typed}»: incomplete (disabled)`); assert.equal(cta(b), 'Escribí tu WhatsApp');
    }
  }
  assert.equal(b.text('.fld .cc'), '+1', 'complete ⇒ its country'); assert.equal(b.q('#f-phone').value, '(305) 555-0147');
  // a qualified text with exactly 8 digits («+13055550») is NOT a valid Honduras number
  const h = bootIntl({ config: GUEST, script: CODE_OK }); await intlFilled(h, null, '+13055550'); await h.type('#f-email', 'ana.perez@gmail.com');
  assert.ok(h.q('#cta').disabled, '🔴 a qualified text is never sent as national digits (the order stays incomplete)');
  for (const sel of ['#cta', '[data-act="tipc"][data-val="0"]', '[data-act="tip-place"]']) { const e = h.q(sel); if (e) { e.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true })); await settle(); } }
  assert.equal(h.srv.of('requestCheckoutCode').length, 0, '🔴 a qualified text is never sent as national digits');
});

// ── S4 (PLAN-capp-S4 r5; the owner's frames + N1 / N3 / N4; ruling (a): ends at placed{scheduled}) — behind the runtime schedulingLive ──
const S4_FX = JSON.parse(readFileSync(join(HERE, 'fixtures/s7a2/directory.json'), 'utf8'));
const S4_ENTRY = S4_FX.scenarios.complete.body.restaurants.find((r) => r.schedule);
// the store config from the REAL writer (the shell's configFor on the 5f-served directory entry): hours + the served schedule + the flag
const S4_CFG = (() => { const c = require('./capp-shell.js').configFor(S4_ENTRY, { endpoints: EP, intakeKey: INTAKE, schedulingLive: true }); return { hours: c.hours, schedule: c.schedule, schedulingLive: c.schedulingLive }; })();
const hnT = (d, h, mi = 0) => new Date(Date.UTC(2026, 9, d, h + 6, mi));   // Honduras wall-clock (UTC−6), October 2026
const S4_QUOTE = (body) => (body.schedule_only ? { status: 200, json: { ok: true, schedule: S4_ENTRY.schedule } } : QUOTE(body));
const S4_MEMBER = { uid: 'u1', name: 'Ana', phone: '99990000', email: 'a@b.co', idToken: 'tok' };
const loadSched = (w) => w.eval(readFileSync(join(HERE, 'capp-schedule.js'), 'utf8'));   // shell.html loads it, as here
function bootS4({ at = hnT(20, 13, 1), member = S4_MEMBER, script = {}, config = {}, clock = null, storage, search = '' } = {}) {
  const c = clock || { t: at.getTime() };
  const b = bootCo({ member, config: { ...S4_CFG, ...config }, script: { quoteOrder: [S4_QUOTE], ...script }, pre: loadSched, mountOpts: { now: () => new Date(c.t) }, ...(storage ? { storage } : {}), search });
  b.clock = c; return b;
}
const schedFill = async (b, pay = 'cash') => { await b.click('[data-act="pin"]'); await b.click('[data-act="pin-done"]'); await b.type('#f-details', 'Portón negro'); if (b.q('#f-name')) { await b.type('#f-name', 'Ana'); await b.type('#f-phone', '9999 0000'); } if (b.q(`[data-act="pay"][data-val="${pay}"]`)) await b.click(`[data-act="pay"][data-val="${pay}"]`); };
const dayChips = (b) => b.qa('.daychip').map((x) => [b.text(x.querySelector('b')), b.text(x.querySelector('span')), x.disabled]);

test('S4 premise: the store config comes from the shell\'s configFor on the 5f-served entry (the served schedule + the flag)', () => {
  assert.equal(S4_CFG.schedulingLive, true); assert.deepEqual(S4_CFG.schedule, S4_ENTRY.schedule);
  const off = require('./capp-shell.js').configFor(S4_ENTRY, { endpoints: EP });
  assert.equal(off.schedulingLive, undefined, 'flag absent ⇒ nothing'); assert.equal(off.schedule, undefined);
});
test('S4 frames 1/2: «Lo antes posible» + «Programar» («Hasta 7 días»); the picker: 7 day chips (N4), EVERY slot of the day (N3), the drawn note; the CTA «Elegí un horario»; a slot ⇒ the card shows it', async () => {
  const b = bootS4({ at: hnT(20, 19, 5) });   // Tuesday 7:05 p.m.: open (closes 7:45), no slot left today (lead 60)
  await toCheckout(b);
  assert.deepEqual(b.qa('.opts .opt').map((o) => [b.text(o.querySelector('b')), b.text(o.querySelector('span')), o.getAttribute('aria-pressed')]), [['Lo antes posible', b.text('.opts .opt span'), 'true'], ['Programar', 'Hasta 7 días', 'false']]);
  await b.click('[data-act="time"][data-val="schedule"]');
  assert.deepEqual(dayChips(b), [['Hoy', 'Sin horarios', true], ['Mañana', '21 oct', false], ['Jue', '22 oct', false], ['Vie', '23 oct', false], ['Sáb', '24 oct', false], ['Dom', '25 oct', false], ['Lun', '26 oct', false]]);
  assert.equal(b.q('.daychip[aria-pressed="true"]').dataset.val, '2026-10-21', 'the first day with slots');
  assert.equal(b.qa('.slotgrid .chip').length, 31, '🔴 N3: every slot (12:00…7:30 p.m.), no 12-chip cap');
  assert.equal(b.text('.slotgrid + .note'), 'Cada horario es una ventana de 30 minutos.');
  assert.equal(cta(b), 'Elegí un horario'); assert.ok(b.q('#cta').disabled);
  await b.click('.slotgrid .chip');
  assert.equal(b.text('.opts .opt[data-val="schedule"] span'), 'Mañana · 12:00 p.m. – 12:30 p.m.');
  assert.equal(b.q('.slotgrid .chip[aria-pressed="true"]').textContent, '12:00 p.m.');
});
test('S4 the wire: a scheduled cash order carries scheduled_for (the slot START) + entry_mode; quotes never do; the outcome is placed{scheduled, scheduled_for} (ruling (a))', async () => {
  const b = bootS4({ script: { createOrder: [(body) => ({ status: 200, json: { ok: true, scheduled: true, order_id: body.order_id, scheduled_for: body.scheduled_for, release_at: body.scheduled_for - 3600000 } })] } });
  await toCheckout(b); await schedFill(b); await b.click('[data-act="time"][data-val="schedule"]'); await b.click('.daychip[data-val="2026-10-21"]');
  const chip = b.q('.slotgrid .chip'); const slot = Number(chip.dataset.val); await b.click(chip);
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  assert.match(b.text('#layer .placing'), /Mañana · 12:00 p\.m\. – 12:30 p\.m\./, 'the placing card\'s clock row = the slot (P:1986)');
  await b.click('#layer [data-act="placing-go"]');
  const sent = b.srv.of('createOrder')[0].body;
  assert.equal(sent.scheduled_for, slot, '🔴 the slot START'); assert.equal(sent.entry_mode, 'app', 'the app contract on cash (r2 §7)');
  assert.ok(b.srv.of('quoteOrder').filter((c) => !c.body.schedule_only).every((c) => !('scheduled_for' in c.body)), 'never in a quote');
  await settle(); b.timers.flush(); await settle();   // the 600 ms beat (the harness's timers)
  const placed = b.events.filter((e) => e[0] === 'placed').pop();
  assert.ok(placed, 'placed'); assert.deepEqual([placed[1].scheduled, placed[1].scheduled_for], [true, slot], '🔴 placed{scheduled, scheduled_for} to the host');
});
test('S4 closed: the schedule is preselected, «Lo antes posible» disabled; the closure gate is ASAP-only — a scheduled order places while closed', async () => {
  const b = bootS4({ at: hnT(20, 20, 30), script: { createOrder: [(body) => ({ status: 200, json: { ok: true, scheduled: true, order_id: body.order_id, scheduled_for: body.scheduled_for } })] } });
  await toCheckout(b); await schedFill(b);
  assert.ok(b.q('.opts .opt[data-val="asap"]').disabled); assert.equal(b.text('.opts .opt[data-val="asap"] span'), 'No disponible · cerrado');
  assert.equal(b.q('.opts .opt[data-val="schedule"]').getAttribute('aria-pressed'), 'true', 'P:1803 preselect');
  assert.equal(cta(b), 'Elegí un horario', '🔴 not «cerrado»: the closure gate is ASAP-only');
  await b.click('.slotgrid .chip'); assert.notEqual(cta(b), 'No disponible · cerrado');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.srv.of('createOrder').length, 1, 'placed while closed');
});
test('S4 the closure sheet (P:1974): «… cerró a las …» + «Podés programarlo…» + [Programar][Cerrar]; «Programar» ⇒ the picker, the slot cleared', async () => {
  const b = bootS4({ at: hnT(20, 13, 1), script: { createOrder: [{ status: 400, json: { error: 'Restaurant closed' } }] } });
  await toCheckout(b); await schedFill(b);
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.match(b.text('#layer .errsheet p'), /^Tu pedido no se envió\. Podés programarlo para el próximo horario disponible\.$/);
  assert.deepEqual(b.qa('#layer .errsheet button').map((x) => x.textContent), ['Programar', 'Cerrar']);
  await b.click('#layer [data-act="err-sched"]');
  assert.equal(b.q('.opts .opt[data-val="schedule"]').getAttribute('aria-pressed'), 'true'); assert.equal(cta(b), 'Elegí un horario', '🔴 the closure refusal no longer blocks a scheduled order');
});
test('S4 frame G: a GUEST tapping «Programar» ⇒ the host\'s sign-in (ctx schedule), the order stays ASAP; once signed in, the picker opens', async () => {
  const b = bootS4({ member: null }); await toCheckout(b);
  await b.click('[data-act="time"][data-val="schedule"]');
  const si = b.events.filter((e) => e[0] === 'signin').pop(); assert.ok(si, '🔴 frame G: a guest\'s «Programar» asks for the account');
  assert.deepEqual(J(si), ['signin', { ctx: 'schedule' }]);
  assert.equal(b.q('.opts .opt[data-val="asap"]').getAttribute('aria-pressed'), 'true', 'still ASAP'); assert.equal(b.q('.daychips'), null);
  b.ui.setMember(S4_MEMBER); await settle();
  assert.equal(b.q('.opts .opt[data-val="schedule"]').getAttribute('aria-pressed'), 'true', '🔴 signed in ⇒ the picker'); assert.ok(b.q('.daychips'));
});
test('S4 N1 (owner, Option 1): the server refuses the slot ⇒ «Ese horario ya no está disponible» + [Elegir otro horario][Cerrar]; «Elegir otro horario» ⇒ the picker, the slot cleared', async () => {
  const b = bootS4({ script: { createOrder: [{ status: 400, json: { error: 'Bad Request', detail: 'Invalid scheduled time (closed_at_slot)' } }] } });
  await toCheckout(b); await schedFill(b); await b.click('[data-act="time"][data-val="schedule"]'); await b.click('.slotgrid .chip');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.text('#layer .errsheet h2'), 'Ese horario ya no está disponible');
  assert.equal(b.text('#layer .errsheet p'), 'Tu pedido no se envió ni se cobró nada. Elegí otro horario; tu pedido está intacto.');
  assert.deepEqual(b.qa('#layer .errsheet button').map((x) => x.textContent), ['Elegir otro horario', 'Cerrar']);
  await b.click('#layer [data-act="err-slot"]');
  assert.equal(cta(b), 'Elegí un horario', '🔴 the slot cleared'); assert.ok(b.q('.slotgrid'));
});
test('S4 the pre-dispatch re-check: a slot no longer offered when sending is cleared — NOTHING is sent, the picker asks again', async () => {
  const clock = { t: hnT(20, 13, 1).getTime() };
  const b = bootS4({ clock, script: { createOrder: [OK_CASH_UI] } });
  await toCheckout(b); await schedFill(b); await b.click('[data-act="time"][data-val="schedule"]');
  await b.click('.daychip[data-val="2026-10-20"]'); await b.click('.slotgrid .chip');   // today 2:15 p.m.
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]');
  clock.t = hnT(20, 13, 50).getTime();   // the lead now excludes 2:15 p.m.
  await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.srv.of('createOrder').length, 0, '🔴 nothing sent for a stale slot'); assert.equal(cta(b), 'Elegí un horario');
});
test('S4 row 10 (owner: dim, note A): a scheduled send left unresolved fixes the slot — cards, days and slots disabled, «Estamos confirmando este horario…», «Reintentar» re-sends the SAME body', async () => {
  const b = bootS4({ script: { createOrder: ['network', (body) => ({ status: 200, json: { ok: true, idempotent: true, order_id: body.order_id } })] } });
  await toCheckout(b); await schedFill(b); await b.click('[data-act="time"][data-val="schedule"]'); await b.click('.slotgrid .chip');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.equal(b.text('#layer .errsheet h2'), 'Sin conexión', 'premise: the drawn «Sin conexión»');
  await b.click('#layer [data-act="lclose"]');
  assert.ok(b.q('.opts .opt[data-val="asap"]').disabled, 'the cards fixed'); assert.equal(b.q('.opts .opt[data-val="schedule"]').getAttribute('aria-pressed'), 'true', 'the pressed «Programar» as drawn');
  assert.ok(b.qa('.daychip').every((x) => x.disabled) && b.qa('.slotgrid .chip:not([aria-pressed="true"])').every((x) => x.disabled), '🔴 days and the other slots dimmed (.45)');
  assert.equal(b.q('.slotgrid .chip[aria-pressed="true"]').disabled, false, 'the chosen slot as drawn (solid)');
  assert.deepEqual(b.qa('.slotgrid ~ .note').map((n) => b.text(n)), ['Cada horario es una ventana de 30 minutos.', 'Estamos confirmando este horario; no se puede cambiar mientras tanto.']);
  assert.equal(cta(b), 'Reintentar');
  const first = b.srv.of('createOrder')[0].body;
  b.q('.slotgrid .chip:last-child').dispatchEvent(new b.w.MouseEvent('click', { bubbles: true })); await settle();   // a forced tap changes nothing
  // the flow changed behind the lock (another slot, other notes — e.g. a restore): the retained identity still replays what it SENT
  b.ui.state.flow.slot = Number(b.q('.slotgrid .chip:last-child').dataset.val); b.ui.state.flow.notes = 'otra nota';
  await b.click('#cta'); await settle();
  const re = b.srv.of('createOrder')[1];
  assert.ok(re, 'premise: re-sent'); assert.deepEqual(J(re.body), J(first), '🔴 the SAME body (r1 §3.4)');
});
test('S4 P2: the schedule is revalidated in the background (schedule_only, never awaited); a changed one is HELD and applied at the next picker action', async () => {
  const changed = J(S4_ENTRY.schedule); changed.hours.wed = { open: true, start: '12:00', end: '13:00' };
  const b = bootS4({ script: { quoteOrder: [(body) => (body.schedule_only ? { status: 200, json: { ok: true, schedule: changed } } : QUOTE(body))] } });
  await toCheckout(b); await settle();
  const so = b.srv.of('quoteOrder').find((c) => c.body.schedule_only);
  assert.deepEqual(J(so.body), { schedule_only: true, entry_mode: 'app', restaurant_id: 'rid_a' });
  await b.click('[data-act="time"][data-val="schedule"]'); await b.click('.daychip[data-val="2026-10-21"]');
  assert.equal(b.qa('.slotgrid .chip').length, 4, '🔴 applied on the user\'s action: Wednesday is now 12:00–1:00 p.m. (4 slots)');
});
test('S4 the placed sending row (P:2038): delivery «Entrega · {slot}»', async () => {
  const b = bootS4({ script: { createOrder: [() => new Promise(() => {})] } });
  await toCheckout(b); await schedFill(b); await b.click('[data-act="time"][data-val="schedule"]'); await b.click('.daychip[data-val="2026-10-21"]'); await b.click('.slotgrid .chip');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  assert.match(b.text('.sndcard'), /Entrega · Mañana · 12:00 p\.m\. – 12:30 p\.m\./);
});
test('S4 row 9 (owner-approved): a paid scheduled card order whose slot went to review ⇒ «Tu pago está hecho; estamos revisando tu horario», ONE «Entendido», no payment action, nothing re-sent', async () => {
  const storage = memStore();
  const a = bootS4({ storage, script: { chargeOnlineOrder: [CHECKOUT] } });
  await toCheckout(a); await schedFill(a, 'online'); await a.click('[data-act="time"][data-val="schedule"]'); await a.click('.daychip[data-val="2026-10-21"]'); await a.click('.slotgrid .chip');
  await a.click('#cta'); await a.click('[data-act="tipc"][data-val="0"]'); await a.click('[data-act="tip-place"]'); await a.click('#layer [data-act="placing-go"]');
  assert.equal(a.nav.length, 1, 'premise: redirected'); const id = a.srv.of('chargeOnlineOrder')[0].body.order_id; const snap = J(a.ui.cart.snapshot()); a.ui.destroy();
  const r = bootS4({ storage, search: `?pay=complete&order=${id}&t=pt_1`, script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'scheduled_review' } }] } });
  r.ui.restore(snap); await r.ui.returning; await settle();
  assert.equal(r.text('#layer .errsheet h2'), 'Tu pago está hecho; estamos revisando tu horario', '🔴 row 9: paid, the slot under review (never «confirming»)');
  assert.equal(r.text('#layer .errsheet p'), 'Tu horario ya no estaba disponible cuando se confirmó el pago. No hace falta pagar de nuevo: te escribimos por WhatsApp para acordar otro horario.');
  assert.deepEqual(r.qa('#layer .errsheet button').map((x) => x.textContent), ['Entendido'], '🔴 one action, no payment offer');
  assert.equal(r.srv.of('chargeOnlineOrder').length, 0, 'nothing re-sent');
});
test('S4 N1 then a NEW slot: after a definitive refusal the next send carries the customer\'s new choice (never a replay of the refused slot)', async () => {
  const b = bootS4({ script: { createOrder: [{ status: 400, json: { error: 'Bad Request', detail: 'Invalid scheduled time (closed_at_slot)' } }, (body) => ({ status: 200, json: { ok: true, scheduled: true, order_id: body.order_id, scheduled_for: body.scheduled_for } })] } });
  await toCheckout(b); await schedFill(b); await b.click('[data-act="time"][data-val="schedule"]'); await b.click('.daychip[data-val="2026-10-21"]'); await b.click('.slotgrid .chip');
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  await b.click('#layer [data-act="err-slot"]'); await b.click('.daychip[data-val="2026-10-22"]');
  const chip = b.q('.slotgrid .chip:nth-child(3)'); const fresh = Number(chip.dataset.val); await b.click(chip);
  await b.click('#cta'); await b.click('[data-act="tipc"][data-val="0"]'); await b.click('[data-act="tip-place"]'); await b.click('#layer [data-act="placing-go"]');
  const sends = b.srv.of('createOrder');
  assert.equal(sends.length, 2); assert.equal(sends[1].body.scheduled_for, fresh, '🔴 the new slot, not the refused one');
});
test('S4 restore (r1 §3.3): a returned scheduled order comes back with its slot chosen; an ASAP one stays ASAP', async () => {
  const storage = memStore();
  const a = bootS4({ storage, script: { chargeOnlineOrder: [CHECKOUT] } });
  await toCheckout(a); await schedFill(a, 'online'); await a.click('[data-act="time"][data-val="schedule"]'); await a.click('.daychip[data-val="2026-10-21"]'); await a.click('.slotgrid .chip');
  await a.click('#cta'); await a.click('[data-act="tipc"][data-val="0"]'); await a.click('[data-act="tip-place"]'); await a.click('#layer [data-act="placing-go"]');
  const sent = a.srv.of('chargeOnlineOrder')[0].body; const snap = J(a.ui.cart.snapshot()); a.ui.destroy();
  const r = bootS4({ storage, search: `?pay=cancel&order=${sent.order_id}&t=pt_1`, script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] } });
  r.ui.restore(snap); await r.ui.returning; await settle();
  assert.equal(r.ui.state.flow.time, 'schedule'); assert.equal(r.ui.state.flow.slot, sent.scheduled_for, '🔴 the slot restored');
});
