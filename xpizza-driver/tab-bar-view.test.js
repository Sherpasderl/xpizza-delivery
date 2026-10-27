// tab-bar-view.test.js — the bottom nav bar builder + its DATA-GATING (ledger O6). Pure, so tested directly.
// Locks: default gating = Inicio + Cuenta only (Pedidos + Ganancias hidden until their destinations ship); fixed
// order; grid columns = visible count; active marking (.on + aria-current); each tab carries data-tab + an icon.
// Run: `node tab-bar-view.test.js`
import assert from 'node:assert/strict';
import { tabBarHtml, visibleTabs } from './tab-bar-view.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };
const keys = (opts) => visibleTabs(opts).map((x) => x.key);

t('default gating shows ONLY Inicio + Cuenta (Pedidos + Ganancias dormant)', () => {
  assert.deepEqual(keys({}), ['inicio', 'cuenta']);
  assert.deepEqual(keys({ showPedidos: false, showGanancias: false }), ['inicio', 'cuenta']);
});

t('Ganancias appears only when showGanancias===true (Pagos, R2); Pedidos only when showPedidos===true', () => {
  assert.deepEqual(keys({ showGanancias: true }), ['inicio', 'ganancias', 'cuenta']);
  assert.deepEqual(keys({ showPedidos: true }), ['inicio', 'pedidos', 'cuenta']);
  assert.deepEqual(keys({ showPedidos: true, showGanancias: true }), ['inicio', 'pedidos', 'ganancias', 'cuenta'], 'fixed order Inicio·Pedidos·Ganancias·Cuenta');
  // a truthy-but-not-true value must NOT open the gate (explicit flip only)
  assert.deepEqual(keys({ showGanancias: 1 }), ['inicio', 'cuenta'], 'only === true opens a gate');
});

t('tabBarHtml: default = 2 buttons, grid columns = visible count, data-tab present, no dormant tabs', () => {
  const h = tabBarHtml('inicio');
  const btns = h.match(/data-tab="/g) || [];
  assert.equal(btns.length, 2, 'two buttons rendered');
  assert.ok(/grid-template-columns:repeat\(2,1fr\)/.test(h), 'grid columns = 2 visible tabs');
  assert.ok(/data-tab="inicio"/.test(h) && /data-tab="cuenta"/.test(h), 'inicio + cuenta');
  assert.ok(!/data-tab="pedidos"/.test(h) && !/data-tab="ganancias"/.test(h), 'no dormant tabs rendered');
  assert.ok(/<svg/.test(h), 'icons present');
  assert.ok(/<span>Inicio<\/span>/.test(h) && /<span>Cuenta<\/span>/.test(h), 'labels present');
});

t('active marking: only the active tab gets .on + aria-current', () => {
  const hi = tabBarHtml('inicio');
  assert.ok(/class="tab-btn on" type="button" data-tab="inicio"[^>]*aria-current="page"/.test(hi), 'inicio active');
  assert.ok(/class="tab-btn" type="button" data-tab="cuenta"/.test(hi), 'cuenta not active');
  const hc = tabBarHtml('cuenta');
  assert.ok(/class="tab-btn on" type="button" data-tab="cuenta"[^>]*aria-current="page"/.test(hc), 'cuenta active');
  assert.ok(/class="tab-btn" type="button" data-tab="inicio"/.test(hc), 'inicio not active');
  assert.equal((hc.match(/ on"/g) || []).length, 1, 'exactly one active tab');
});

t('all four tabs when both gates open, in fixed order, grid=4', () => {
  const h = tabBarHtml('ganancias', { showPedidos: true, showGanancias: true });
  assert.ok(/grid-template-columns:repeat\(4,1fr\)/.test(h));
  const order = [...h.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['inicio', 'pedidos', 'ganancias', 'cuenta']);
  assert.ok(/class="tab-btn on"[^>]*data-tab="ganancias"/.test(h), 'ganancias active');
});

console.log(`✓ tab-bar-view: ${passed} tests passed`);
