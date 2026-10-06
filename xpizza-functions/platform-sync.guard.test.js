'use strict';
// P-SELFUPDATE — the platform manifest: bundled copy == canonical (drift), shape valid, and the DERIVED order-site CORS
// lists are byte-identical to the pre-manifest literals (advisor ruling, origins option A), plus a synthetic third
// deployment's origin appears in BOTH lists.
// Run: node platform-sync.guard.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const M = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// 1. DRIFT — the bundled copy is byte-identical to the canonical repo files
for (const f of ['sites.json', 'compat.json']) {
  const canon = fs.readFileSync(path.join(__dirname, '..', 'platform', f));
  const bundled = fs.readFileSync(path.join(__dirname, 'platform', f));
  assert.ok(canon.equals(bundled), `🔴 platform/${f} drifted from <repo>/platform/${f} — run \`npm run sync:platform\``);
}
ok('bundled platform/sites.json + compat.json are byte-identical to the canonical <repo>/platform copies');

// 2. SHAPE
assert.deepStrictEqual(M.validateManifest(M.PLATFORM.sites), []);
assert.deepStrictEqual(M.validateCompat(M.PLATFORM.compat, M.PLATFORM.sites.apps), []);
ok('the manifest and the compat generations validate');

// 3. BYTE-IDENTICAL derived lists — the expectations are the literal arrays index.js carried at ba29282
//    (ACCOUNT_ORIGINS :6085-6088, PUBLIC_MENU_ORIGINS :6123-6127), written out independently here.
const LITERAL_ACCOUNT_ORIGINS = ['https://orders.xpizza.hn', 'https://orders.lamusa.hn'];
const LITERAL_PUBLIC_MENU_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, 'https://orders.xpizza.hn', 'https://orders.lamusa.hn'];
const wire = (list) => JSON.stringify(list.map((o) => (o instanceof RegExp ? { re: o.source, flags: o.flags } : o)));
assert.strictEqual(wire(M.PLATFORM.ACCOUNT_ORIGINS), wire(LITERAL_ACCOUNT_ORIGINS), '🔴 ACCOUNT_ORIGINS changed — production CORS must be unchanged');
assert.strictEqual(wire(M.PLATFORM.PUBLIC_MENU_ORIGINS), wire(LITERAL_PUBLIC_MENU_ORIGINS), '🔴 PUBLIC_MENU_ORIGINS changed — production CORS must be unchanged');
ok('derived ACCOUNT_ORIGINS / PUBLIC_MENU_ORIGINS are byte-identical (members AND order) to the ba29282 literals');

// 4. index.js CONSUMES the derived lists (no literal list left behind)
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
assert.ok(/const \{ ACCOUNT_ORIGINS \} = require\('\.\/platform-manifest'\)\.PLATFORM;/.test(src), 'index.js derives ACCOUNT_ORIGINS');
assert.ok(/const \{ PUBLIC_MENU_ORIGINS \} = require\('\.\/platform-manifest'\)\.PLATFORM;/.test(src), 'index.js derives PUBLIC_MENU_ORIGINS');
assert.ok(!/const (ACCOUNT_ORIGINS|PUBLIC_MENU_ORIGINS) = \[/.test(src), '🔴 a literal ACCOUNT_ORIGINS / PUBLIC_MENU_ORIGINS array is back in index.js');
ok('index.js takes both lists from the manifest; no literal list remains');

// 5. A SYNTHETIC THIRD DEPLOYMENT → its origin appears in BOTH lists, after today's, no code change
const synth = JSON.parse(JSON.stringify(M.PLATFORM.sites));
synth.deployments.push({ id: 'orders-synth', app: 'orders', folder: 'synth-orders', entrypoints: ['index.html'], context: 'synthetic_3', origins: ['https://orders.synthetic.test'] });
const P3 = M.loadPlatform(synth, M.PLATFORM.compat);
assert.deepStrictEqual(P3.ACCOUNT_ORIGINS, [...LITERAL_ACCOUNT_ORIGINS, 'https://orders.synthetic.test']);
assert.strictEqual(wire(P3.PUBLIC_MENU_ORIGINS), wire([...LITERAL_PUBLIC_MENU_ORIGINS, 'https://orders.synthetic.test']));
assert.ok(P3.isValidCombination('orders', 'orders-synth', 'synthetic_3') && !P3.isValidCombination('orders', 'orders-synth', 'x_pizza'));
ok('a synthetic third orders deployment adds its origin to BOTH lists and is a valid heartbeat combination');

// 6. VALIDATION REFUSES bad configuration (wildcards, http, paths, duplicates, unknown app, bad context, compat < 1)
const bad = (mut, re) => { const c = JSON.parse(JSON.stringify(M.PLATFORM.sites)); mut(c); assert.throws(() => M.loadPlatform(c, M.PLATFORM.compat), re); };
bad((c) => { c.deployments[0].origins = ['https://*.xpizza.hn']; }, /exact https origin/);
bad((c) => { c.deployments[0].origins = ['http://orders.xpizza.hn']; }, /exact https origin/);
bad((c) => { c.deployments[0].origins = ['https://orders.xpizza.hn/']; }, /exact https origin/);
bad((c) => { c.deployments[1].origins = ['https://orders.xpizza.hn']; }, /listed twice/);
bad((c) => { c.deployments[0].app = 'ordrs'; }, /unknown app/);
bad((c) => { c.deployments[0].context = 'X Pizza'; }, /bad context/);
bad((c) => { c.deployments.push({ ...c.deployments[0] }); }, /duplicate deployment|listed twice/);
bad((c) => { c.deployments[0].entrypoints = ['../index.html']; }, /bad entrypoints/);
assert.throws(() => M.loadPlatform(M.PLATFORM.sites, { schema: 1, generations: { ...M.PLATFORM.compat.generations, orders: 0 } }), /integer ≥ 1/);
ok('validation refuses wildcard / http / path-bearing / duplicate origins, unknown apps, bad contexts, bad entrypoints, compat < 1');

console.log(`platform-sync.guard: OK (${n})`);
