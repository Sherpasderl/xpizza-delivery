'use strict';
// S2-core (PLAN-structure-S2core-r3 §3.1, §3.4; T4, T5, T27, T28) — the EXTRA allocator. A new extra arrives as a temporary ref
// ({ ref: 'tmp:…', price, display: { name, cat } }) and leaves with a server-owned key and UI id:
//   name mode (x_pizza): key = the tidy name, display.id = 'e' + (the highest e-number + 1)
//   id mode   (la_musa): key = display.id = a slug of the name, unique among extras
// Refused: an active extra's name (name_taken) or an active dish's name (name_taken); a key an EXTRA once had (reserved, kind extra →
// name_needs_new_id until S2b; a retired DISH key does not block); a name carrying , | + [ ] (extra_name_unsafe); a key or id the
// client invented (client_supplied_key); any new extra while the extrasCatalog switch is off (extras_catalog_not_supported_yet).
// Over the REAL built sources. Run: node catalog/extras-allocate.test.js
const assert = require('assert');
const { allocateExtras, EXTRA_LABEL_UNSAFE } = require('./extras-allocate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { reservedKeySet, unionReserved, emptyReserved } = require('./reserved-keys');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const refused = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return e; } assert.fail(`not refused (${code})`); };
const reserved = (dish = [], extra = []) => reservedKeySet(unionReserved(emptyReserved(), { dish, extra }, 'v-x').doc);
const run = (rid, incoming, { stored = null, switchOn = true, res = reserved() } = {}) => {
  const live = buildSourceFromCode(rid);
  return allocateExtras({ incoming, stored, activeExtras: live.extras, activeItems: live.items, keyMode: rid === 'la_musa' ? 'id' : 'name', reserved: res, switchOn });
};
const withNew = (rid, display, price = 15, ref = 'tmp:abcdefgh1') => { const s = buildSourceFromCode(rid); s.extras.push({ ref, price, display: { price, ...display } }); return s; };

cell('XA-NAME-MODE x_pizza: key = name, display.id = next e-number, price mirrored', (L) => {
  const { source, allocated } = run('x_pizza', withNew('x_pizza', { name: '  Jalapeño ', cat: 'Vegetales & Hierbas' }));
  const row = source.extras.find((e) => e.key === 'Jalapeño');
  assert.ok(row, `${L}: allocated (${JSON.stringify(allocated)})`);
  const maxE = Math.max(...buildSourceFromCode('x_pizza').extras.map((e) => Number(String(e.display.id).slice(1))));
  assert.deepStrictEqual([row.display.id, row.display.name, row.price, row.display.price, 'ref' in row], [`e${maxE + 1}`, 'Jalapeño', 15, 15, false], L);
});
cell('XA-PRICE-MIRROR both modes (T4, m4): a new extra priced only at the top level leaves with display.price mirrored, and the reverse', (L) => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const s = buildSourceFromCode(rid); const g = s.extras[0].display.cat;
    s.extras.push({ ref: 'tmp:mirror-top-1', price: 21, display: { name: 'Solo Arriba', cat: g } });
    s.extras.push({ ref: 'tmp:mirror-dsp-1', display: { name: 'Solo Adentro', cat: g, price: 22 } });
    const { source } = run(rid, s);
    const a = source.extras.find((e) => e.display.name === 'Solo Arriba'); const b = source.extras.find((e) => e.display.name === 'Solo Adentro');
    assert.deepStrictEqual([a.price, a.display.price, b.price, b.display.price], [21, 21, 22, 22], `${L}: ${rid}`);
    require('./source-store').validateSource(source, rid);   // the 2a validator's inline-price agreement holds
  }
});
cell('XA-ID-MODE la_musa: key = display.id = slug', (L) => {
  const { source } = run('la_musa', withNew('la_musa', { name: 'Salsa Verde', cat: 'Salsas' }));
  const row = source.extras.find((e) => e.display.name === 'Salsa Verde');
  assert.deepStrictEqual([row.key, row.display.id], ['salsa_verde', 'salsa_verde'], L);
});
cell('XA-COLLIDE-ACTIVE-EXTRA both modes: an active extra\'s name is name_taken', () => {
  refused(() => run('x_pizza', withNew('x_pizza', { name: 'salsa roja', cat: 'Salsas & Queso' })), 'name_taken');
  const ex = buildSourceFromCode('la_musa').extras[0];
  refused(() => run('la_musa', withNew('la_musa', { name: ex.display.name.toUpperCase(), cat: ex.display.cat })), 'name_taken');
});
cell('XA-COLLIDE-ACTIVE-DISH both modes: an active dish\'s name is name_taken', () => {
  refused(() => run('x_pizza', withNew('x_pizza', { name: 'Margherita', cat: 'Salsas & Queso' })), 'name_taken');
  const dish = buildSourceFromCode('la_musa').items[0];
  refused(() => run('la_musa', withNew('la_musa', { name: dish.display.name, cat: 'Salsas' })), 'name_taken');
});
cell('XA-RETIRED-EXTRA both modes: a key an extra once had is name_needs_new_id; a retired DISH key does not block', (L) => {
  refused(() => run('x_pizza', withNew('x_pizza', { name: 'Jamón Viejo', cat: 'Carnes' }), { res: reserved([], ['Jamón Viejo']) }), 'name_needs_new_id');
  refused(() => run('la_musa', withNew('la_musa', { name: 'Salsa Vieja', cat: 'Salsas' }), { res: reserved([], ['salsa_vieja']) }), 'name_needs_new_id');
  const ok1 = run('x_pizza', withNew('x_pizza', { name: 'Plato Viejo', cat: 'Carnes' }), { res: reserved(['Plato Viejo'], []) });
  assert.ok(ok1.source.extras.some((e) => e.key === 'Plato Viejo'), `${L}: a retired dish key does not block an extra`);
});
cell('XA-NAME-UNSAFE: , | + [ ] in a new extra\'s name is extra_name_unsafe naming the characters', () => {
  for (const nm of ['Bacon + Cheddar', 'Salsa, picante', 'Doble | Queso', 'Queso [extra]']) {
    const e = refused(() => run('x_pizza', withNew('x_pizza', { name: nm, cat: 'Carnes' })), 'extra_name_unsafe');
    assert.strictEqual(e.field, 'name');
  }
});
cell('XA-UNSAFE-IS-THE-CAPP-RULE: the server predicate equals the capp serializer\'s and the capp menu\'s (byte-drift pin)', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..', '..', 'customer-app');
  for (const [f, name] of [['capp-serialize.js', 'UNSAFE_LABEL'], ['capp-menu.js', 'LABEL_UNSAFE']]) {
    const m = fs.readFileSync(path.join(root, f), 'utf8').match(new RegExp(`const ${name} = (/[^\\n]*?/);`));
    assert.ok(m, `the capp declares ${name} in ${f}`);
    assert.strictEqual(m[1], String(EXTRA_LABEL_UNSAFE), `${f}'s ${name} is the server's EXTRA_LABEL_UNSAFE byte for byte`);
  }
});
cell('XA-CLIENT-KEY: a new extra carrying a key the server did not allocate is client_supplied_key; a re-saved allocation is kept', (L) => {
  const s = withNew('x_pizza', { name: 'Jalapeño', cat: 'Carnes' }); const row = s.extras[s.extras.length - 1]; delete row.ref; row.key = 'Jalapeño'; row.display.id = 'e99';
  refused(() => run('x_pizza', s), 'client_supplied_key');
  const first = run('x_pizza', withNew('x_pizza', { name: 'Jalapeño', cat: 'Carnes' })).source;
  const again = run('x_pizza', clone(first), { stored: first }).source;
  assert.deepStrictEqual(again.extras, first.extras, `${L}: the stored allocation is kept on a re-save`);
});
cell('XA-SWITCH-OFF: any new extra while extrasCatalog is off is extras_catalog_not_supported_yet; no new extra is a no-op', (L) => {
  refused(() => run('x_pizza', withNew('x_pizza', { name: 'Jalapeño', cat: 'Carnes' }), { switchOn: false }), 'extras_catalog_not_supported_yet');
  const same = buildSourceFromCode('x_pizza');
  assert.deepStrictEqual(run('x_pizza', clone(same), { switchOn: false }).source, same, `${L}: today's drafts pass untouched`);
});
if (fails.length) { console.log(`extras-allocate FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`extras-allocate: OK (${n})`);
