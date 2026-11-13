'use strict';
// S2b (PLAN-structure-S2b-r3 §0, §1.2) — the extra-rename op on THE Extras-page writer (exposure-transitions, the portal's same bytes)
// and the dark switch. Real sources (buildSourceFromCode), read back through the REAL build. Run: node catalog/s2b-writer.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const XT = require('./exposure-transitions');
const XI = require('./extra-identity');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const refused = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return; } assert.fail(`not refused (${code})`); };

cell('S2BW-SWITCH: MINT_OPAQUE_EXTRAS ships OFF; the frozen form sources are listed by path', () => {
  assert.deepStrictEqual(XI.extraIdentityCapabilities(), { mintExtras: false });
  assert.deepStrictEqual(XI.FROZEN_FORM_SOURCES, ['xpizza-orders/index.html', 'la-musa-orders/index.html']);
});
for (const rid of ['x_pizza', 'la_musa']) {
  cell(`S2BW-RENAME ${rid}: extra.rename sets the display name and nothing else — the key, the display id, the group and the price are kept`, () => {
    const src = buildSourceFromCode(rid); const x = src.extras[0];
    const before = JSON.stringify(src);
    const out = XT.apply(src, { op: 'extra.rename', key: x.key, name: 'Nombre Nuevo S2b' }).source;
    assert.strictEqual(JSON.stringify(src), before, 'pure');
    const y = out.extras.find((e) => e.key === x.key);
    assert.ok(y, 'the key is kept');
    assert.deepStrictEqual({ ...y.display, name: x.display.name }, x.display, 'only the name changed');
    assert.strictEqual(y.display.name, 'Nombre Nuevo S2b');
    assert.strictEqual(y.price, x.price);
    if (rid === 'la_musa') buildSourceCandidate(rid, out);   // id mode: the key derives from the id, so the renamed row still builds
  });
}
cell('S2BW-RENAME-REFUSALS: an unknown extra and a blank name are refused', () => {
  const src = buildSourceFromCode('la_musa');
  refused(() => XT.apply(src, { op: 'extra.rename', key: 'no_such_extra', name: 'X' }), 'unknown_extra');
  refused(() => XT.apply(src, { op: 'extra.rename', key: src.extras[0].key, name: '  ' }), 'addition_malformed');
});

if (fails.length) { console.error(`s2b-writer FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`s2b-writer: OK (${n})`);
