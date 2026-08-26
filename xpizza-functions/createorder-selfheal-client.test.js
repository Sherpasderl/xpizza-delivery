'use strict';
// Client self-heal parity (Task 2 — F4 + N1), BOTH order forms. The heal logic is inline in the form HTML
// (no module boundary), so this locks the invariants + byte-parallelism structurally in source (the form-parity
// pattern). Runtime behavior is covered by the manual smoke checklist in the build handback.
// Run: node createorder-selfheal-client.test.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const FORMS = {
  'la-musa': path.join(__dirname, '..', 'la-musa-orders', 'index.html'),
  'x-pizza': path.join(__dirname, '..', 'xpizza-orders', 'index.html'),
};
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

for (const [brand, file] of Object.entries(FORMS)) {
  const src = fs.readFileSync(file, 'utf8');
  const has = (re, msg) => assert.ok(re.test(src), `[${brand}] ${msg}`);

  // F4 (cash) — order_conflict self-heal, guarded one-shot, fresh id
  has(/err\.error === 'order_conflict'/, 'cash: handles order_conflict');
  has(/if\(!window\.__conflictHealed\)\{[\s\S]*?window\.__conflictHealed = true;/, 'cash: one-shot heal guard set');
  has(/window\.__pendingOrder = null; window\.__resumeOrderId = null;[\s\S]*?currentOrder\.order_id = genOrderId\(\);[\s\S]*?return submitOrder\(paymentStatus\);/, 'cash: clears ids + mints fresh id + resubmits ONCE');
  has(/err\.reason==='closed'/, 'cash: specific message for reason:closed');

  // F4 (online) — Order conflict/closed self-heal via processPixelPay, guarded one-shot
  has(/cfg\.error==='Order conflict' \|\| cfg\.error==='Order closed'/, 'online: handles Order conflict/closed');
  has(/window\.__pendingOrder = null; window\.__resumeOrderId = null;[\s\S]*?currentOrder\.order_id = genOrderId\(\);[\s\S]*?return processPixelPay\(\);/, 'online: clears ids + mints fresh id + retries ONCE');

  // N1 — free_order_stale unlock
  has(/err\.error === 'free_order_stale'/, 'free_order_stale handled');
  has(/free_order_stale'\)\{[\s\S]*?clearRedeem[\s\S]*?syncFreeOrderUI\(\)/, 'free_order_stale: clears reward + syncFreeOrderUI un-greys payment methods');

  // per-submit heal-guard reset (so each user submit gets exactly one auto-heal)
  has(/window\.__conflictHealed = false;/, 'processPayment resets __conflictHealed per user submit');

  ok(`${brand}: F4 cash + F4 online + N1 + heal-guard reset present`);
}

// Byte-parallel: the same set of self-heal tokens appears in BOTH forms (no drift between brands).
const tokens = ["err.error === 'order_conflict'", "err.error === 'free_order_stale'", "window.__conflictHealed = false;", "cfg.error==='Order conflict' || cfg.error==='Order closed'", 'syncFreeOrderUI()'];
const counts = Object.fromEntries(Object.entries(FORMS).map(([b, f]) => [b, tokens.map((t) => fs.readFileSync(f, 'utf8').includes(t))]));
assert.deepEqual(counts['la-musa'], counts['x-pizza'], 'both forms carry the identical self-heal handler set (byte-parallel)');
ok('both forms byte-parallel on the self-heal handler set');

console.log(`\ncreateorder-selfheal-client.test.js: ${pass} passed`);
