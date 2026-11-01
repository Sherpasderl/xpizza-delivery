// Customer app — the website URL scheme (PLAN-capp-desktop-D4a-routing r2, APPROVED, Phase 1). capp-routes.js is pure: every
// scheme row, normalisation, encoding, adversarial / malformed inputs, and the ONE id domain (no '/' — refused at parse AND format)
// with a guard that every CURRENT catalog id (both brands' published bodies, legacy ids included) conforms.
// Run: node --test customer-app/capp-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const R = require('./capp-routes.js');
const fnRequire = createRequire(join(ROOT, 'xpizza-functions/x.js'));

test('every scheme row parses and formats canonically', () => {
  const rows = [
    ['/', { name: 'home' }], ['/buscar', { name: 'search' }], ['/cuenta', { name: 'account' }],
    ['/r/x_pizza', { name: 'store', rid: 'x_pizza', step: 'store' }],
    ['/r/x_pizza/pedido', { name: 'store', rid: 'x_pizza', step: 'pedido' }],
    ['/r/x_pizza/pago', { name: 'store', rid: 'x_pizza', step: 'pago' }],
    ['/r/la_musa/plato/dimsum_01', { name: 'store', rid: 'la_musa', step: 'plato', dish: 'dimsum_01' }],
  ];
  for (const [p, r] of rows) { assert.deepEqual(R.parse(p), r, p); assert.equal(R.format(r), p, `format ${p}`); }
  assert.deepEqual(Object.keys(R.WORDS).sort(), ['account', 'cart', 'checkout', 'dish', 'search', 'store'], 'the OWNER-PENDING words, one place');
});

test('normalisation: a trailing slash and repeated slashes are tolerated; case is exact; unknown shapes ⇒ null', () => {
  assert.deepEqual(R.parse('/r/x_pizza/'), { name: 'store', rid: 'x_pizza', step: 'store' });
  assert.deepEqual(R.parse('//r//x_pizza//pago'), { name: 'store', rid: 'x_pizza', step: 'pago' });
  assert.deepEqual(R.parse('/buscar/'), { name: 'search' });
  for (const p of ['/R/x_pizza', '/r/X_PIZZA', '/Buscar', '/r', '/r/x_pizza/plato', '/r/x_pizza/plato/a/b', '/r/x_pizza/menu', '/foo', 'r/x_pizza', '', null, '/r/x/pago', '/r/x_pizza/pedido/extra'])
    assert.equal(R.parse(p), null, `null: ${JSON.stringify(p)}`);
});

test('encoding: dish ids with spaces, accents, %, +, ?, # and Unicode round-trip exactly; malformed escapes, dot segments and control characters ⇒ null', () => {
  for (const dish of ['Pizza Carnívora', '50% off', 'a+b', '¿qué?', 'x#1', '炒饭', 'ñandú', '2', 'Crispy Bacon']) {
    const r = { name: 'store', rid: 'x_pizza', step: 'plato', dish };
    const p = R.format(r);
    assert.ok(!/[ %?#+]/.test(p.replace(/%[0-9A-F]{2}/g, '')), `encoded: ${p}`);
    assert.deepEqual(R.parse(p), r, `round-trip ${dish}`);
  }
  for (const p of ['/r/x_pizza/plato/%E0%A4%A', '/r/x_pizza/plato/%', '/r/x_pizza/plato/..', '/r/x_pizza/plato/.', '/r/x_pizza/plato/a%00b', '/r/x_pizza/plato/a%7Fb', `/r/x_pizza/plato/${'x'.repeat(129)}`])
    assert.equal(R.parse(p), null, `null: ${p}`);
});

test('ONE id domain: an id never contains "/" — %2F is refused by parse, format THROWS (the reflector then leaves the URL alone)', () => {
  assert.equal(R.parse('/r/x_pizza/plato/a%2Fb'), null, 'a decoded "/" ⇒ null');
  assert.equal(R.parse('/r/x%2Fpizza'), null);
  assert.throws(() => R.format({ name: 'store', rid: 'x_pizza', step: 'plato', dish: 'a/b' }), /bad step or dish id/);
  assert.throws(() => R.format({ name: 'store', rid: 'x/pizza', step: 'store' }), /bad store route/);
  assert.throws(() => R.format({ name: 'store', rid: 'X_Pizza', step: 'store' }), /bad store route/);
  assert.throws(() => R.format({ name: 'store', rid: 'x_pizza', step: 'pagar' }), /bad step/);
  assert.throws(() => R.format(null), /no route/);
});

test('GUARD: every CURRENT catalog dish id (both brands\' published bodies; the dish_id and the legacy id keyOf can fall back to) is inside the ONE domain', async () => {
  const { generateFormBundle, catalogSnapshot } = fnRequire('./catalog/generate-form-bundle');
  const { applyIdentityToServedBody } = fnRequire('./catalog/identity-overlay');
  const { fullRegistry } = fnRequire('./catalog/identity-fixture');
  const ids = [];
  for (const rid of ['x_pizza', 'la_musa']) {
    const { body } = await applyIdentityToServedBody(fullRegistry(rid), rid, generateFormBundle(rid, catalogSnapshot(rid)));
    assert.ok(R.RID_RE.test(rid), `the rid ${rid} is a valid route rid`);
    for (const d of body.dishes || []) for (const v of [d.dish_id, d.id]) if (v != null && v !== '') ids.push([rid, String(v)]);
  }
  assert.ok(ids.length > 30, `premise: the catalogs were read (${ids.length} ids)`);
  const bad = ids.filter(([rid, id]) => { try { return R.parse(R.format({ name: 'store', rid, step: 'plato', dish: id }))?.dish !== id; } catch (_) { return true; } });
  assert.deepEqual(bad, [], `🔴 catalog ids outside the ONE domain: ${JSON.stringify(bad.slice(0, 5))}`);
});
