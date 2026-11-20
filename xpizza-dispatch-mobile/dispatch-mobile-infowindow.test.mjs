import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Polish §4b (CTA audit #8) — the mobile map driver bubble was info-only (name + status), a dead-end: to
// act you had to leave the map, find the order and open it. Give it two READ-ONLY shortcuts into existing
// flows: «Llamar» = tel: the driver, «Ver pedido» = openDetail of the order they carry (only when they carry
// one). No new mutation — the PWA's read-only contract (exactly 3 write sites, enforced by readonly.test.mjs)
// is untouched. This extracts the real openDriverInfo and inspects the bubble HTML it sets.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

function fn(src, name) {
  let at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error('fn not found: ' + name);
  let i = src.indexOf('{', at), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) break; } }
  return src.slice(at, i + 1);
}
const src = fn(html, 'openDriverInfo');

function run({ driver, order }) {
  let content = '';
  const driverInfoWindow = { setContent: (h) => { content = h; }, open() {}, close() {} };
  const marker = {};
  const deps = {
    STORE: { drivers: { d1: driver }, orders: order ? { o1: order } : {} },
    driverMarkers: { d1: marker },
    driverInfoWindow,
    google: { maps: { event: { addListenerOnce() {} }, InfoWindow: class {} } },
    orderForDriver: () => (order ? 'o1' : null),
    displayLabel: (oid) => '#A7K2',
    DRIVER_STATUS_ES: { en_route_delivery: 'En camino', available: 'Disponible' },
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])),
    map: {},
    openDetail: () => {},
    document: { querySelector: () => null },
  };
  const names = Object.keys(deps);
  new Function(...names, `${src}\n; return openDriverInfo;`)(...names.map((k) => deps[k]))('d1');
  return content;
}

test('§4b: a driver with a phone AND an order gets both «Llamar» (tel:) and «Ver pedido»', () => {
  const c = run({ driver: { name: 'Carlos Mejía', status: 'en_route_delivery', phone: '50499112233' }, order: { customer_name: 'María' } });
  assert.match(c, /href="tel:50499112233"/, 'Llamar is a tel: link to the driver');
  assert.match(c, />Llamar</, 'the Llamar label is present');
  assert.match(c, /data-iw-order="o1"[\s\S]*>Ver pedido</, '«Ver pedido» carries the order id');
});

test('§4b: a driver with NO order shows «Llamar» only (no «Ver pedido»)', () => {
  const c = run({ driver: { name: 'Lucía', status: 'available', phone: '50499000000' }, order: null });
  assert.match(c, /href="tel:/, 'Llamar still shows');
  assert.ok(!c.includes('Ver pedido'), 'no «Ver pedido» when the driver carries no order');
});

test('§4b: a driver with no phone shows no «Llamar»', () => {
  const c = run({ driver: { name: 'Sin Tel', status: 'available' }, order: null });
  assert.ok(!c.includes('tel:') && !c.includes('>Llamar<'), 'no Llamar without a phone');
});

test('§4b: the bubble still shows name + status (unchanged)', () => {
  const c = run({ driver: { name: 'Carlos Mejía', status: 'en_route_delivery', phone: '1' }, order: { customer_name: 'María' } });
  assert.match(c, /Carlos Mejía/);
  assert.match(c, /En camino/);
});
