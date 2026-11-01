'use strict';
// PLAN-guest-checkout-server §1.4 — the ONE cart signature: platform/client/cart-sig.js is canonical; every deployed copy is
// BYTE-IDENTICAL (written by `npm run sync:client`). The targets are DATA: the functions + every platform-context `orders`
// deployment's folder in platform/sites.json. On main there is none yet (the customer app's entry arrives with f838eaa7); the
// fixture cell proves the rule then reaches customer-app/ automatically, so a stale or missing capp copy fails here at assembly.
// Run: node cart-sig-sync.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const canonical = fs.readFileSync(path.join(ROOT, 'platform', 'client', 'cart-sig.js'));
const targets = (sites) => ['xpizza-functions', ...new Set(sites.deployments.filter((d) => d.app === 'orders' && d.context === 'platform').map((d) => d.folder))];

const live = targets(JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'sites.json'), 'utf8')));
for (const f of live) {
  const p = path.join(ROOT, f, 'cart-sig.js');
  assert.ok(fs.existsSync(p), `🔴 ${f}/cart-sig.js is missing — run npm run sync:client`);
  assert.ok(fs.readFileSync(p).equals(canonical), `🔴 ${f}/cart-sig.js drifted from platform/client/cart-sig.js — run npm run sync:client`);
}
ok(`every deployed copy is byte-identical to the canonical file (${live.join(', ')})`);

const withApp = targets(JSON.parse(fs.readFileSync(path.join(__dirname, 'test', 'fixtures', 'sites.f838eaa7.json'), 'utf8')));
assert.deepStrictEqual(withApp, ['xpizza-functions', 'customer-app'], 'with f838eaa7\'s manifest the customer app\'s folder is a target');
const sync = fs.readFileSync(path.join(__dirname, 'tools', 'sync-client.js'), 'utf8');
assert.ok(/d\.app === 'orders' && d\.context === 'platform'/.test(sync) && /'cart-sig\.js'/.test(sync), 'sync-client writes the same targets');
ok('the targets are manifest data: with f838eaa7\'s orders-app the customer app\'s copy is guarded too; sync-client writes the same set');

const CS = require('./cart-sig');
assert.strictEqual(CS.canonicalJson({ b: 1, a: [undefined, { d: undefined, c: 'ñ' }] }), '{"a":[null,{"c":"ñ"}],"b":1}');
ok('canonicalJson: sorted keys, undefined keys dropped, undefined array slots → null');

console.log(`\ncart-sig-sync.guard: OK (${n})`);
