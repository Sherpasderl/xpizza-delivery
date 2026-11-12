'use strict';
// The SDK order-id namespace (advisor ruling replacing gate 0; NOTE-sdk-d4-order-id-namespace.md): `sdk_` + the app's id
// grammar. placeSdkOrder admits ONLY it; every other creator refuses ANY id with the prefix. No minter (the frozen forms' and the
// app's genOrderId, the directory's /^[A-Z]{2,5}$/ prefix) can produce it — proven here against the REAL minters' grammar.
// Run: node payments/sdk/d4-order-id.test.js
const assert = require('assert');
let pass = 0; const fails = [];
const cell = (L, fn) => { try { fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const NS = () => require('./order-id');

cell('SDK-D4-NS-GRAMMAR', (L) => {
  for (const id of ['sdk_261112-101500-ABCDEFGH', 'sdk_000101-000000-0123456Z']) assert.ok(NS().isSdkOrderId(id), `${L}: ${id} is an SDK id`);
  for (const id of ['sdk_', 'sdk_261112-101500-abcdefgh', 'sdk_261112-101500-ABCDEFGI', 'sdk_261112-101500-ABCDEFGL', 'sdk_261112-101500-ABCDEFGO', 'sdk_261112-101500-ABCDEFGU',
    'SDK_261112-101500-ABCDEFGH', 'sdk_261112-1015-ABCDEFGH', 'XPZ261112-101500-ABCDEFGH', '', null, 5])
    assert.ok(!NS().isSdkOrderId(id), `${L}: ${JSON.stringify(id)} is NOT an SDK id`);
});
cell('SDK-D4-NS-PREFIX', (L) => {
  for (const id of ['sdk_', 'sdk_x', 'sdk_261112-101500-ABCDEFGH', 'sdk_anything at all']) assert.ok(NS().inSdkNamespace(id), `${L}: ${id} is IN the namespace (refused by every other creator)`);
  for (const id of ['SDK_x', 'xsdk_1', 'sdk-1', 'XPZ261112-1015-ABCDEFGH', '', null, undefined, 7]) assert.ok(!NS().inSdkNamespace(id), `${L}: ${JSON.stringify(id)} is not`);
});
cell('SDK-D4-NS-MINTERS-DISJOINT', (L) => {
  // the REAL minters: the app's genOrderId (capp-api.js) over every directory-valid prefix shape; the forms' prefixes
  const shapePrefix = /^[A-Z]{2,5}$/;   // directory/presentation-shape.js order_id_prefix
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'customer-app', 'capp-api.js'), 'utf8');
  const charset = (src.match(/const ID_CHARS = '([^']+)'/) || [])[1];
  assert.ok(charset && /^[0-9A-Z]+$/.test(charset), `${L}: premise — the app's id charset is digits + UPPERCASE (${charset})`);
  for (const p of ['XPZ', 'LMS', 'AB', 'ABCDE']) {
    assert.ok(shapePrefix.test(p), `${L}: premise — ${p} is a directory-valid prefix`);
    const minted = `${p}261112-101500-${charset.slice(0, 8)}`;
    assert.ok(!NS().inSdkNamespace(minted), `${L}: a minted ${minted} is never in the namespace`);
  }
  assert.ok(!shapePrefix.test('sdk_'), `${L}: 'sdk_' can never be a directory prefix`);
  for (const form of ['xpizza-orders', 'la-musa-orders']) {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', form, 'index.html'), 'utf8');
    const p = (html.match(/order_id_prefix:"([^"]*)"/) || [])[1];
    assert.ok(p && !NS().inSdkNamespace(p + '261112-1015'), `${L}: ${form}'s prefix ${p} never mints into the namespace`);
  }
});

console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-order-id: OK (${pass})`);
process.exit(fails.length ? 1 : 0);
