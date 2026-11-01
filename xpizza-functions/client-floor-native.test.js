'use strict';
// PLAN-capp-native-shell D1 (c) — the native shell's version floor is PER DEPLOYMENT: the manifest-declared native deployment is
// exempt from the APP floor (a web floor raise never 426s a store-lagged native) and answers only to
// platform_config/client_floor_native/{deployment}; every other request keeps exactly today's app floor. The headers come from the
// REAL readClientHeaders over a request shaped like the stamped clients'. Run: node client-floor-native.test.js
const assert = require('assert');
const CF = require('./client-floor');
const M = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NATIVE = M.PLATFORM.nativeDeployment();
const hdrs = (deployment, compat, app = 'orders') => CF.readClientHeaders({ headers: { 'x-client-app': app, 'x-client-deployment': deployment, 'x-client-build': 'b1', 'x-client-compat': String(compat) } });
const fakeDb = (vals, reads = []) => ({ ref: (p) => ({ get: async () => { reads.push(p); return { val: () => (p in vals ? vals[p] : null) }; } }) });
const silent = { error() {}, log() {} };

(async () => {
  assert.strictEqual(NATIVE, 'orders-app-native', 'premise: the manifest declares the native deployment');
  const web = hdrs('orders-app', 3), nat = hdrs(NATIVE, 3), form = hdrs('orders-xpizza', 3);
  assert.deepStrictEqual([web.deployment, nat.deployment, nat.compat], ['orders-app', NATIVE, 3], 'premise: the real header reader');

  // 1. the APP floor (today's call: isBelowFloor(h, 'orders', appFloor)) — raised above every client's compat
  assert.strictEqual(CF.isBelowFloor(web, 'orders', 5), true, 'the web capp below the app floor ⇒ 426 (unchanged)');
  assert.strictEqual(CF.isBelowFloor(form, 'orders', 5), true, 'a form below the app floor ⇒ 426 (unchanged)');
  assert.strictEqual(CF.isBelowFloor(nat, 'orders', 5), false, '🔴 a web floor raise must never 426 the store-lagged native');
  assert.strictEqual(CF.isBelowFloor({ app: null, deployment: null, compat: null }, 'orders', 0), true, 'header-less ⇒ the app floor (unchanged)');
  assert.strictEqual(CF.isBelowFloor(hdrs('orders-app-nativ', 1), 'orders', 5), true, 'an UNKNOWN id is not the native one ⇒ the app floor');
  assert.strictEqual(CF.isBelowFloor(web, 'orders', 3), false); assert.strictEqual(CF.isBelowFloor(web, 'orders', null), false, 'OFF ⇒ never below');
  ok('the app floor refuses the web capp / forms / header-less / unknown ids exactly as before, and never the declared native deployment');

  // 2. no native block ⇒ nothing is exempt (byte-identical behaviour to before D1)
  const c = JSON.parse(JSON.stringify(M.PLATFORM.sites)); delete c.deployments.find((d) => d.id === 'orders-app').native;
  const P0 = M.loadPlatform(c, M.PLATFORM.compat);
  assert.strictEqual(CF.isBelowFloor(nat, 'orders', 5, P0), true, '🔴 with no native block the id is just an unknown header ⇒ the app floor applies');
  ok('no native block in the manifest ⇒ the same id gets the app floor (nothing exempt)');

  // 3. the per-request floor: the native key for the native deployment only; the app key for everyone else
  const reads = [];
  const reader = CF.createFloorReader({ getDb: () => fakeDb({ 'platform_config/client_floor/orders': 5, [`platform_config/client_floor_native/${NATIVE}`]: 4 }, reads), log: silent });
  const rn = await CF.floorForRequest(reader, nat, 'orders'), rw = await CF.floorForRequest(reader, web, 'orders'), rf = await CF.floorForRequest(reader, form, 'orders');
  assert.deepStrictEqual([rn, rw, rf], [{ floor: 4, scope: 'native' }, { floor: 5, scope: 'app' }, { floor: 5, scope: 'app' }]);
  assert.deepStrictEqual(reads.sort(), ['platform_config/client_floor/orders', `platform_config/client_floor_native/${NATIVE}`], 'one read per key (the cache holds both)');
  assert.strictEqual(CF.isBelowFloorFor(nat, 'orders', rn), true, 'the native below ITS floor ⇒ 426');
  assert.strictEqual(CF.isBelowFloorFor(hdrs(NATIVE, 4), 'orders', rn), false, 'at its floor ⇒ admitted');
  assert.strictEqual(CF.isBelowFloorFor(hdrs(NATIVE, 9, 'kitchen'), 'orders', rn), true, 'a foreign app header has no compat ⇒ below');
  assert.strictEqual(CF.isBelowFloorFor(web, 'orders', rw), true); assert.strictEqual(CF.isBelowFloorFor(hdrs('orders-app', 5), 'orders', rw), false);
  ok('floorForRequest reads client_floor_native/{id} for the native deployment and client_floor/{app} for every other request; isBelowFloorFor applies the matching one');

  // 4. a native floor ABSENT ⇒ OFF for natives (never falls back to the app floor), with the app floor set
  const r2 = CF.createFloorReader({ getDb: () => fakeDb({ 'platform_config/client_floor/orders': 5 }), log: silent });
  const off = await CF.floorForRequest(r2, nat, 'orders');
  assert.deepStrictEqual(off, { floor: null, scope: 'native' }); assert.strictEqual(CF.isBelowFloorFor(hdrs(NATIVE, 1), 'orders', off), false);
  ok('no native floor set ⇒ natives are admitted even with the app floor raised (never a fallback to the app floor)');
  console.log(`client-floor-native: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
