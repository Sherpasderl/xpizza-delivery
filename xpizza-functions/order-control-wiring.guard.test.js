'use strict';
// D4-c4 — where the pause switch is wired, and where it is NOT (PLAN-D4c4 rev 13 §3/§0.4/§0.5/§0.9). Run: node order-control-wiring.guard.test.js
//   1. PROOF (i): the slice's inverse (tools/d4c4-inverse.js) turns the candidate index.js back into e1aeb3f's BYTE-FOR-BYTE
//      (needs git history — any worktree of this repo has it), with sensitivity: a byte changed inside a hunk and a byte
//      changed outside every hunk are each detected. Proof (ii) — the fold + c5 inverse → the bb37684 pin — is
//      portal/portal-split.test.js and catalog/identity-record-guards.test.js.
//   2. The seam ORDER in the handlers (the runtime behaviour is test/order-control.emulator.test.js).
//   3. Captured-payment code never reads the switch.
//   4. dispatch's committed copy of the shared module is byte-identical and loads as a classic browser script.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { unapplyD4c4, HUNKS } = require('./tools/d4c4-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const idx = read('index.js');

// ── 1. proof (i) ────────────────────────────────────────────────────────────────────────────────────────────────────
const BASE = execFileSync('git', ['show', 'e1aeb3f:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.strictEqual(unapplyD4c4(idx), BASE, '🔴 index.js minus the D4-c4 hunks is not e1aeb3f:index.js — something beyond the stated seams changed');
assert.ok(HUNKS.length >= 8);
{
  const inHunk = idx.replace("if (acq.reason === 'order_control') {", "if (acq.reason === 'order_controL') {");
  let detected; try { detected = unapplyD4c4(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('exports.createOrder = onRequest(', 'exports.createOrder = onRequest( ');
  assert.notStrictEqual(outside, idx);
  assert.notStrictEqual(unapplyD4c4(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  const dup = idx + HUNKS[0][0];
  assert.throws(() => unapplyD4c4(dup), /not found exactly once/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyD4c4(candidate index.js) === e1aeb3f:index.js byte-for-byte (${HUNKS.length} hunks); a byte inside a hunk, a byte outside every hunk and a duplicated hunk are each detected`);

// ── 2. seam order ───────────────────────────────────────────────────────────────────────────────────────────────────
const slice = (start, end) => { const a = idx.indexOf(start); const b = idx.indexOf(end, a + 1); assert.ok(a >= 0 && b > a, `markers: ${start.slice(0, 40)} … ${end.slice(0, 40)}`); return idx.slice(a, b); };
const order = (body, marks, label) => {
  let at = -1;
  for (const m of marks) { const i = body.indexOf(m, at + 1); assert.ok(i > at, `${label}: "${m}" after the previous mark`); at = i; }
};
const co = slice('const createOrderApp', 'exports.createOrder = onRequest(');
order(co, [
  'const cls = classifyExistingOrder(', "return res.status(409).json(OE.orderExistsBody(oe.reason, orderId));", 'returning idempotent',
  "return res.status(409).json(OE.orderExistsBody('client_update_race', orderId));",
  'const ctlP = OC.orderControlFor(db, restaurantId);', 'restIdentity = await getRestaurantIdentity(db, restaurantId);',
  'const ctl = await ctlP;', 'return OC.respond(res, ctl);', 'if (!restIdentity.active)', 'checkItemAvailability(', 'checkRateLimit(',
], 'createOrder');
assert.strictEqual((co.match(/OC\.orderControlFor\(/g) || []).length, 1, 'createOrder reads the switch once');
assert.ok(co.indexOf('getRestaurantIdentity(') > co.indexOf("orderExistsBody('client_update_race'"), 'the identity read is NOT moved earlier (§0.5)');
ok('createOrder: classifier → idempotent / order_exists → the :839 client_update_race → THEN the control read starts, alongside the (unmoved) identity read → the decision → before active / availability / rate-limit / any write');

const ch = slice('const chargeOnlineApp', 'exports.chargeOnlineOrder = onRequest(');
order(ch, [
  'let controlArmed = null;', 'const ctlP = OC.orderControlFor(db, restaurantId);', 'clsG = await classifyHostedAttempt(',
  "OE.orderExistsBody('binding_format_invalid', orderId)", "return CF.updateRequired(res, 'orders', ordersFloor);",
  'const g = OCS.chargePreGate(await ctlP, clsG);', 'return OC.respond(res, g.refuse);', 'controlArmed = g.arm;',
  'checkItemAvailability(', 'checkRateLimit(', "OE.orderExistsBody('conflict', orderId)", 'reserveRedemption(',
  'canonicalChargeFp, floorBelow, controlArmed !== null);',
  "if (acq.outcome === 'conflict') {", 'await releaseHoldIfOwned();', "if (acq.reason === 'order_control') {", 'return OC.respond(res, controlArmed);',
  'OE.orderExistsBody(acq.reason ||', "if (acq.outcome === 'closed') {",
], 'chargeOnlineOrder');
assert.strictEqual((ch.match(/OC\.orderControlFor\(/g) || []).length, 1, 'chargeOnlineOrder reads the switch once');
ok('chargeOnlineOrder: control read alongside classify → :1511 → the floor → the PRE-GATE → availability / rate-limit / probe refusals / reserve → acquire(armed) → conflict: owned-hold cleanup → the order_control branch (recorded kind) → c5\'s mapping, unchanged');

const rel = slice('exports.releaseScheduledOrder = onRequest(', '// User Profiles P0');
order(rel, ["if (order.status !== 'scheduled')", "const ctl = await OC.orderControlFor(db, order.restaurant_id || 'x_pizza');", 'return OC.respond(res, ctl);', 'const patch = { release_at:', 'patch.scheduled_blocked = null', 'releaseScheduledCore('], 'releaseScheduledOrder');
assert.ok(/function scheduledReleaseDeps\(db\) \{\n  return \{ db, alert: [^\n]+\n    orderControl: \(rid\) => OC\.orderControlFor\(db, rid\) \};/.test(idx), 'the release core gets the reader for EVERY release (sweep, manual, recovery)');
ok('scheduled: the release deps carry the reader (sweep + manual + stale recovery share finalizeRelease); the manual release checks BEFORE the override clears scheduled_blocked');

for (const fn of ['exports.quoteOrder = onRequest(', 'exports.quoteRedemption = onRequest(']) {
  const q = slice(fn, 'exports.');
  assert.ok(!/orderControlFor|OC\.|OCS\./.test(q), `${fn} must not read the switch (rev 13 removed the quote gates)`);
}
assert.strictEqual((idx.match(/OC\.orderControlFor\(/g) || []).length, 4, 'exactly four reads: createOrder, chargeOnlineOrder, the release deps, the manual release');
ok('NOT wired: quoteOrder / quoteRedemption (removed in rev 13); index.js reads the switch at exactly four places');

// ── 3. captured-payment code never reads the switch ────────────────────────────────────────────────────────────────
const CAPTURED = ['materialize.js', 'materialize-guard.js', 'pixelpay-confirm.js', 'pixelpay-hosted-webhook.js', 'resolve-manual.js', 'manual-resolve.js',
  'cancel-order.js', 'cancel-order-core.js', 'paid-after-close-notify.js', 'n2-paid-strand-decision.js', 'pixelpay-cancel.js'];
for (const f of CAPTURED) {
  if (!fs.existsSync(path.join(__dirname, f))) continue;
  assert.ok(!/order-control|order_control/.test(read(f)), `🔴 ${f} reads the pause switch — captured payments must proceed exactly as today`);
}
const diffed = execFileSync('git', ['diff', '--name-only', 'e1aeb3f', '--', ...CAPTURED, 'restaurant-config.js', 'scheduled-orders.js', 'createorder-classify.js', 'order-exists.js'], { cwd: __dirname, encoding: 'utf8' }).trim();
assert.strictEqual(diffed, '', `🔴 pinned modules changed vs e1aeb3f: ${diffed}`);
ok('captured-payment / resolver / cancel / paid-after-close modules never mention the switch, and (with restaurant-config, scheduled-orders, the classifier and order-exists) are byte-identical to e1aeb3f');

// ── 4. the shared module in dispatch ───────────────────────────────────────────────────────────────────────────────
const canon = read('order-control-state.js');
const copy = fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch', 'order-control-state.js'), 'utf8');
assert.strictEqual(copy, canon, '🔴 xpizza-dispatch/order-control-state.js drifted — run `npm run sync:client`');
{
  const win = {}; const ctx = vm.createContext({ self: win });
  vm.runInContext(copy, ctx, { filename: 'order-control-state.js' });
  const B = win.OrderControlState; const N = require('./order-control-state');
  assert.ok(B && typeof B.effectiveState === 'function', 'loads as a classic script → window.OrderControlState');
  for (const [cur, now] of [[null, 1], [{ paused: true }, 1], [{ paused: true, until: 5 }, 4], [{ paused: true, until: 5 }, 5], [{ paused: 'true' }, 1], [{ paused: false, until: 'x' }, 1]]) {
    assert.deepStrictEqual({ ...B.effectiveState(cur, now) }, N.effectiveState(cur, now));
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch', 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="order-control-state.js"></script>') > -1 && html.indexOf('<script src="order-control-state.js"></script>') < html.indexOf('<script type="module">'), 'dispatch loads it before its module code');
}
ok('dispatch: its committed order-control-state.js is byte-identical to the functions\' (sync:client), loads as a classic script (window.OrderControlState) and answers exactly as the Node module');

console.log(`\norder-control-wiring.guard: OK (${n})`);
