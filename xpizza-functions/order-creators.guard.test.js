'use strict';
// PLATFORM F2 Q2 (PLAN-F2-query-rules §2, "FUTURE ownership") — every order-CREATING write writes a VALIDATED restaurant_id, so the
// KDS's exact-location feed can never miss a future order (the census proves the past). Offline; wired into npm test.
//   1. From the R3 write inventory (contract/census.json): the sites that write an order's identity / creation fields (order_id,
//      created_at) are EXACTLY the pinned creators, and each also writes restaurant_id. A new creator fails until reviewed here.
//   2. Each creator's handler validates the rid through resolveRestaurantId(body.restaurant_id, restaurantRegistry().known()).
//   3. The dead client creator createOrderWithTasks (present in every SDK copy) is called by NO deployed app — only by the
//      reference test harness page.
// Run: node order-creators.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CREATORS = ['xpizza-functions/index.js#chargeOnlineApp.all', 'xpizza-functions/index.js#createOrderApp.all'];
const census = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract', 'census.json'), 'utf8'));
const fields = new Map();
for (const w of census.writes) {
  const [file, fn, field] = w.key.split('#');
  const site = `${file}#${fn}`;
  if (!fields.has(site)) fields.set(site, new Set());
  fields.get(site).add(field);
}
const creators = [...fields].filter(([, f]) => f.has('order_id') || f.has('created_at')).map(([s]) => s).sort();
assert.deepStrictEqual(creators, CREATORS, `the order-creating write sites are exactly the pinned creators (a new one must be reviewed for restaurant_id): ${creators.join(', ')}`);
for (const c of CREATORS) assert.ok(fields.get(c).has('restaurant_id'), `${c} writes restaurant_id`);
console.log(`  ✓ 1 the R3 write inventory's order creators are exactly ${CREATORS.length} (createOrder, chargeOnlineOrder) and each writes restaurant_id`);

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
for (const name of ["createOrderApp.all('*', async", "chargeOnlineApp.all('*', async"]) {
  const i = src.indexOf(name); assert.ok(i >= 0, `${name} found`);
  const next = src.slice(i + name.length).search(/\n[a-zA-Z]+App\.(all|post|use)\(|\nexports\./);
  const body = src.slice(i, next < 0 ? undefined : i + name.length + next);
  assert.ok(body.includes('resolveRestaurantId(body.restaurant_id, restaurantRegistry().known())'), `${name} validates the rid through resolveRestaurantId against the known registry`);
}
console.log('  ✓ 2 both creators validate the rid: resolveRestaurantId(body.restaurant_id, restaurantRegistry().known())');

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'platform', 'sites.json'), 'utf8'));
const deployed = [...new Set(sites.deployments.map((d) => d.folder))];
const callers = [];
for (const folder of deployed) {
  const dir = path.join(__dirname, '..', folder);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/\.(html|js|mjs)$/.test(f) || /\.test\./.test(f) || f === 'xpizza-delivery.js') continue;
    if (/createOrderWithTasks\s*\(/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) callers.push(`${folder}/${f}`);
  }
}
assert.deepStrictEqual(callers, [], `no deployed app calls the dead client creator createOrderWithTasks (${callers.join(', ')})`);
console.log(`  ✓ 3 no deployed app (${deployed.length} folders in platform/sites.json) calls the dead client creator createOrderWithTasks`);
console.log('order-creators.guard: OK (3)');
