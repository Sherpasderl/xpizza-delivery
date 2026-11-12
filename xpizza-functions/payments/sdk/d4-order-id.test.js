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
// Codex handler r2: the REAL minters are EXECUTED — each genOrderId's source is cut from its file (brace-matched) and run in a
// vm sandbox with exactly the bindings it closes over, over many clocks, every directory-valid prefix shape and each form's
// embedded prefix. Nothing is synthesized: if a minter changes, this runs the new code.
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const nodeCrypto = require('crypto');
const REPO = path.join(__dirname, '..', '..', '..');
function cutFunction(src, name) {
  const i = src.indexOf(`function ${name}(`); if (i === -1) throw new Error(`no function ${name}`);
  let d = 0; for (let j = src.indexOf('{', i); j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1); }
  throw new Error('unbalanced');
}
cell('SDK-D4-NS-MINTERS-DISJOINT', (L) => {
  const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;   // validateOrderPayload's order_id allowlist
  const shapePrefix = /^[A-Z]{2,5}$/;            // directory/presentation-shape.js order_id_prefix
  const clocks = []; for (let k = 0; k < 60; k++) clocks.push(Date.UTC(2020 + (k % 10), k % 12, 1 + (k % 28), k % 24, (k * 7) % 60, (k * 13) % 60));
  const check = (label, id, prefix) => {
    assert.ok(typeof id === 'string' && id.startsWith(prefix) && /\d{6}-\d{4}/.test(id.slice(prefix.length)), `${L}: non-vacuity — ${label} really minted <prefix><yymmdd>-<time>… (${id})`);
    assert.ok(typeof id === 'string' && SERVER_ID.test(id), `${L}: ${label} minted a server-valid id (${id})`);
    assert.ok(!NS().inSdkNamespace(id) && !NS().isSdkOrderId(id), `${L}: ${label} minted ${id} — never in the SDK namespace`);
  };
  // the two frozen forms: their embedded RESTAURANT_CONFIG prefix, plus every configured prefix
  for (const form of ['xpizza-orders', 'la-musa-orders']) {
    const html = fs.readFileSync(path.join(REPO, form, 'index.html'), 'utf8');
    const fnSrc = cutFunction(html, 'genOrderId');
    const embedded = (html.match(/order_id_prefix:"([^"]*)"/) || [])[1];
    for (const prefix of [embedded, 'XPZ', 'LMS']) for (const t of clocks) {
      const ctx = vm.createContext({ RESTAURANT_CONFIG: { order_id_prefix: prefix }, crypto: { getRandomValues: (a) => nodeCrypto.randomFillSync(a) }, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } }, String, Math, Uint8Array, Uint32Array });
      check(`${form}(${prefix})`, vm.runInContext(`${fnSrc}; genOrderId()`, ctx), prefix);
    }
  }
  // the customer app: its genOrderId over every directory-valid prefix shape (2..5 uppercase letters)
  const capp = fs.readFileSync(path.join(REPO, 'customer-app', 'capp-api.js'), 'utf8');
  const fnSrc = cutFunction(capp, 'genOrderId');
  const ID_CHARS = (capp.match(/const ID_CHARS = '([^']+)'/) || [])[1];
  for (const prefix of ['AB', 'XPZ', 'LMS', 'PZXQ', 'ZZZZZ']) {
    assert.ok(shapePrefix.test(prefix), `${L}: premise — ${prefix} is directory-valid`);
    for (const t of clocks) {
      const ctx = vm.createContext({ cfg: { orderIdPrefix: prefix }, now: () => t, randomBytes: (k) => nodeCrypto.randomBytes(k), ID_CHARS, pad2: (x) => String(x).padStart(2, '0'), Date, String });
      check(`capp(${prefix})`, vm.runInContext(`${fnSrc}; genOrderId()`, ctx), prefix);
    }
  }
  assert.ok(!shapePrefix.test('sdk_'), `${L}: 'sdk_' can never be a directory prefix`);
});

console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-order-id: OK (${pass})`);
process.exit(fails.length ? 1 : 0);
