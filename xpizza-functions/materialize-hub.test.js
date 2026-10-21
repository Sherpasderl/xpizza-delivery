'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §E "legacy materialization fallback") — a PRE-SNAPSHOT pending order
// (no charge-time hub_lat/hub_lng) materializes with ITS restaurant's identity hub (deps.hubFor), never the x_pizza constant:
//   • a stamped order is byte-identical to today (the deps restaurant object, no read);
//   • an unstamped order → { ...deps.restaurant, lat/lng from hubFor(order.restaurant_id) }; unresolved → null coords (the task
//     materializes; the order then takes the hub_unresolved intake path);
//   • x_pizza's identity hub is byte-equal to index.js's RESTAURANT lat/lng (so an x_pizza legacy order is unchanged);
//   • both materialize callers (pixelpay-confirm's confirmAndMaterialize, resolve-manual) feed buildMaterializeUpdates the
//     materializeRestaurant(deps, order) result. Run: node materialize-hub.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { materializeRestaurant, buildMaterializeUpdates } = require('./materialize');
const { IDENTITIES } = require('./seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = { lat: 1, lng: 2, name: 'Base Name', phone: '+1' };
const hubs = { tb_centro: { lat: 15.51, lng: -88.03 } };
const reads = [];
const deps = { restaurant: BASE, hubFor: async (rid) => { reads.push(rid); return hubs[rid] || null; } };

(async () => {
  assert.strictEqual(await materializeRestaurant(deps, { restaurant_id: 'tb_centro', hub_lat: 15.6, hub_lng: -88.2 }), BASE, 'stamped → the same deps object');
  assert.deepStrictEqual(reads, [], 'and no read');
  ok('a stamped order: the deps restaurant object as today, no identity read');

  assert.deepStrictEqual(await materializeRestaurant(deps, { restaurant_id: 'tb_centro' }), { ...BASE, lat: 15.51, lng: -88.03 }, 'an unstamped order takes ITS restaurant identity hub');
  assert.deepStrictEqual(await materializeRestaurant(deps, { restaurant_id: 'tb_centro', hub_lat: 15.6 }), { ...BASE, lat: 15.51, lng: -88.03 }, 'a half stamp reads the identity');
  assert.deepStrictEqual(reads, ['tb_centro', 'tb_centro']);
  ok('an unstamped order: lat/lng from ITS restaurant identity (hubFor(order.restaurant_id))');

  for (const o of [{ restaurant_id: 'tb_unknown' }, { restaurant_id: null }, {}]) {
    assert.deepStrictEqual(await materializeRestaurant(deps, o), { ...BASE, lat: null, lng: null }, `unresolved ${JSON.stringify(o)} → null coords (never the base / x_pizza hub)`);
  }
  const failing = { restaurant: BASE, hubFor: async () => { throw new Error('rtdb down'); } };
  assert.deepStrictEqual(await materializeRestaurant(failing, { restaurant_id: 'tb_centro' }), { ...BASE, lat: null, lng: null }, 'a failed read → null coords');
  ok('unresolved (unknown / null rid / failed read) → null coords: the task materializes hub-less and the order takes the intake alert path');

  const u = buildMaterializeUpdates({ orderId: 'O1', order: { restaurant_id: 'tb_unknown', order_type: 'delivery', lat: 15.5, lng: -88 }, trackingToken: 'T', now: 5,
    restaurant: await materializeRestaurant(deps, { restaurant_id: 'tb_unknown' }), paymentMethod: 'online' });
  const pickup = u['tasks/O1_pickup'];
  assert.ok(pickup, 'the pickup task still materializes');
  assert.deepStrictEqual([pickup.destination_lat, pickup.destination_lng], [null, null], 'with null hub coords (no x_pizza guess)');
  ok('end-to-end: buildMaterializeUpdates with the unresolved result writes a pickup task with null coords');

  // x_pizza byte-equality: index.js RESTAURANT lat/lng === the seeded x_pizza identity hub
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const m = /const RESTAURANT = \{\s*lat: ([-0-9.]+),\s*lng: ([-0-9.]+),/.exec(idx);
  assert.ok(m, 'premise: index.js RESTAURANT literal found');
  assert.deepStrictEqual([Number(m[1]), Number(m[2])], [IDENTITIES.x_pizza.hub_lat, IDENTITIES.x_pizza.hub_lng], 'RESTAURANT lat/lng === seeded x_pizza hub (full precision)');
  ok('x_pizza: the identity hub is byte-equal to index.js RESTAURANT lat/lng — an x_pizza legacy order materializes exactly as before');

  // both materialize callers route the fallback through materializeRestaurant; both deps factories supply hubFor
  for (const f of ['pixelpay-confirm.js', 'resolve-manual.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const calls = src.split('buildMaterializeUpdates({').length - 1;
    assert.strictEqual(calls, 1, `${f}: one buildMaterializeUpdates call`);
    assert.ok(/const restaurant = await materializeRestaurant\(deps, order\);[\s\S]{0,1600}buildMaterializeUpdates\(\{/.test(src), `${f}: the fallback is materializeRestaurant(deps, order), right before the build`);
  }
  for (const fac of ['confirmDeps', 'resolveDeps']) {
    const body = idx.slice(idx.indexOf(`function ${fac}(db)`), idx.indexOf(`function ${fac}(db)`) + 1500);
    assert.ok(/hubFor: \(rid\) => hubForFresh\(db, rid\)/.test(body), `${fac} supplies hubFor = hubForFresh`);
  }
  ok('wiring: pixelpay-confirm + resolve-manual feed buildMaterializeUpdates materializeRestaurant(deps, order); confirmDeps + resolveDeps supply hubFor = hubForFresh');

  console.log(`\nmaterialize-hub: OK (${n})`);
})().catch((e) => { console.error('materialize-hub FAILED:', e); process.exit(1); });
