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
    calls.push({ ep, body, url });
    const q = script[ep] || []; const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${ep}`);
    if (r === 'network') throw new TypeError('Failed to fetch');
    const res = typeof r === 'function' ? r(body, url) : r;
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
function bootCo({ script = {}, config = {}, member = null, geo = GEO_OK, search = '', storage = memStore(), priceSheet, rid = 'x_pizza' } = {}) {
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const html = readFileSync(join(HERE, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '').replace('</head>', () => `<style>${css}</style></head>`);
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-ui.js']) w.eval(readFileSync(join(HERE, f), 'utf8'));
  const srv = scripted({ quoteOrder: [QUOTE], ...script });
  const events = []; const nav = []; const timers = fakeTimers(); const sheets = [];
  const ui = w.CappUI.mount(w.document, { envelope: PROV[rid].envelope, now: NOON, onEvent: (n, d) => events.push([n, d]),
    config: { ...CONFIG[rid], restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: EP, branch: 'Centro', ...config },
    CappCheckout: CK, CappApi: CA, member, geolocation: geo, navigate: (u) => nav.push(u), search, timers,
    priceSheet: priceSheet || ((o) => { sheets.push(o); return Promise.resolve(false); }),
    apiOpts: { fetch: srv.fetch, storage, now: () => NOON().getTime(), sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RB++ * 7) % 256), setInterval: () => 0, clearInterval: () => {} } });
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

test('S2b ?pay= return: a definitive cancel ⇒ «Pago no completado» (drawn; «Pagar en efectivo» = host event); a cancel the server still calls pending ⇒ «Tu pago todavía está en verificación» (the order stays locked); a 403 ⇒ recovery', async () => {
  const c = bootCo({ search: RET('cancel'), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] } });
  await c.ui.returning; await settle();
  assert.equal(c.text('#layer .errsheet h2'), 'Pago no completado');
  assert.equal(c.text('#layer .errsheet p'), 'Tu banco no autorizó el pago. Podés intentar con otra tarjeta o pagar en efectivo; tu pedido está intacto.');
  assert.deepEqual(c.qa('#layer .errsheet .acts button').map((x) => x.textContent), ['Pagar en efectivo', 'Usar otra tarjeta']);
  await c.click('#layer [data-act="err-cash"]');
  assert.equal(c.events.at(-1)[0], 'pay-cash');
  const h = bootCo({ search: RET('cancel'), script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  await h.ui.returning; await settle();
  assert.equal(h.q('#layer .sheet').getAttribute('aria-label'), 'Tu pago todavía está en verificación', '🔴 never «Pago no completado» while the server says pending');
  assert.ok(h.q('#layer .errsheet .icon.calm svg circle'), 'the calm tint + the clock (#mk-pending)');
  assert.equal(h.text('#layer .errsheet p'), 'Estamos confirmando tu pago con el banco. No hace falta pagar de nuevo; esperá un momento mientras termina.');
  assert.deepEqual(h.qa('#layer .errsheet .acts button').map((x) => [x.className, x.textContent]), [['primary', 'Volver al pedido']]);
  await h.click('#layer [data-act="lclose"]');
  assert.equal(h.q('#layer').innerHTML, '');
  assert.ok(h.q('.screen .flow'), '«Volver al pedido» lands on «Entrega & Pago»');
  const f = bootCo({ search: RET('complete', 'TA261020-190500-QRST'), script: { paymentStatus: [{ status: 403, json: {} }] } });
  await f.ui.returning; await settle();
  assert.equal(f.text('#layer .errsheet h2'), 'Necesitamos revisar tu pedido');
  assert.equal(f.text('#layer .errsheet p.note'), 'Referencia #QRST');
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
  const e = bootCo({ script: { createOrder: [{ status: 418, json: { error: 'teapot' } }] } });
  await placeVia(e);
  assert.deepEqual(sheetOf(e), G, 'kind error');
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
  const b = bootCo({ script: { createOrder: [{ status: 418, json: { error: 'teapot' } }, { status: 200, json: { ok: true, order_id: 'X' } }] } });
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
