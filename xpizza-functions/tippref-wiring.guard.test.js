'use strict';
// PLAN-capp-tip-step r6 §1 — the member last-tip WIRING (tools/tippref-inverse.js, composed INNERMOST — inside unapplySbIndex — in
// every chain):
//   1. EXACT: index.js minus the four tippref hunks === BASE byte-for-byte; exactly their whole lines removed;
//   2. PLACEMENT: each hook runs only AFTER acceptance — the held cash commit (right before its 200), the immediate cash commit
//      (right after its write's catch), the hosted card path right after `if (flow.respond) return …` (every non-issuing path —
//      refusals, the gate, reuse, a failed checkout — has already returned: the charge ISSUED);
//   3. BEHAVIOUR (each hook lifted and RUN): it awaits TP.recordLastTip with the VERIFIED customer_uid (never a body uid), the
//      body, orderType and orderId — and nothing else;
//   4. sensitivity: a missing / duplicated / shared-line marker throws; a byte outside every hunk fails the pin.
// Run: node tippref-wiring.guard.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { unapplyTipprefIndex, HUNKS } = require('./tools/tippref-inverse');

const BASE = 'ba47f627';   // origin/main at the slice's branch point (feat/capp-tip-server)
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const live = require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))));
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// 1. exact
assert.notStrictEqual(unapplyTipprefIndex(live), live, 'non-vacuity');
const peelNewer = (s) => ['s2-module-inverse', 's1d-module-inverse', 'reservedkeys-module-inverse', 'resolvelines-module-inverse', 'frozenkeys-module-inverse', 'keymode-module-inverse'].reduce((acc, m) => { const M = require('./tools/' + m); return M[Object.keys(M).find((k) => /^unapply/.test(k))]('index.js', acc); }, s);   /* DRYRUN R-WIRE (2e asm5): main's S0/S1a + S1b–S2 layers are newer than BASE — peeled after tippref (same order as the composed chains) */
assert.strictEqual(peelNewer(unapplyTipprefIndex(live)), base, `🔴 index.js minus the tippref hunks is not ${BASE}:index.js`);
assert.strictEqual(live.split('\n').length - unapplyTipprefIndex(live).split('\n').length, 12, 'exactly the hunks\' whole lines removed (require 3 + three hooks × 3)');
ok(`exact: index.js minus the four tippref hunks === ${BASE} byte-for-byte; exactly their 12 whole lines removed`);

// 2. placement
const H = Object.fromEntries(HUNKS.map((h) => [h.name, h]));
const block = (h) => live.slice(live.lastIndexOf('\n', live.indexOf(h.begin)) + 1, live.indexOf(h.end) + h.end.length + 1);
const prevLine = (h) => { const a = live.lastIndexOf('\n', live.indexOf(h.begin)); return live.slice(live.lastIndexOf('\n', a - 1) + 1, a); };
const nextLines = (h, k) => live.slice(live.indexOf(h.end) + h.end.length + 1).split('\n').slice(0, k).join('\n');
assert.ok(prevLine(H.require).includes("const TIP = require('./tip');"), '🔴 the require sits right after the tip.js require');
assert.ok(/^\s+\/\/ No tracking token, no "order received" WhatsApp/.test(nextLines(H['cash-held'], 1)) && nextLines(H['cash-held'], 2).includes("scheduled: true"), '🔴 the held hook sits right before the scheduled 200 (after the held commit succeeded)');
{ const before = live.slice(0, live.indexOf(H['cash-held'].begin)); const tail = before.slice(before.lastIndexOf('await db.ref().update(heldUpdates);')); assert.ok(tail.includes("return res.status(500).json({ error: 'Database write failed'"), '🔴 the held hook follows the held commit and its failure return'); }
assert.strictEqual(prevLine(H['cash-live']), '  }', '🔴 the live hook follows the immediate write\'s try/catch');
{ const before = live.slice(0, live.indexOf(H['cash-live'].begin)); const tail = before.slice(before.lastIndexOf('await db.ref().update(updates);')); assert.ok(tail.includes("return res.status(500).json({ error: 'Database write failed'"), '🔴 the live hook follows the immediate commit and its failure return'); }
assert.strictEqual(prevLine(H['card-issued']), '  if (flow.respond) return res.status(flow.respond.status).json(flow.respond.body);', '🔴 the card hook sits right after every non-issuing path returned (flow.respond)');
assert.strictEqual(nextLines(H['card-issued'], 1), '  const hosted = flow.hosted;', 'the card hook precedes the issued checkout\'s use');
assert.strictEqual((unapplyTipprefIndex(live).match(/recordLastTip|tip-pref/g) || []).length, 0, 'no last-tip reference outside the hunks');
ok('placement: the require beside tip.js; held — after the held commit, before its 200; live — after the immediate commit; card — right after flow.respond (an ISSUED charge only); nothing outside the hunks');

// 3. behaviour — run each hook as written
for (const name of ['cash-held', 'cash-live', 'card-issued']) {
  const src = block(H[name]);
  const calls = [];
  const body = { tip_choice: true, tip_cents: 2000, uid: 'u_evil', customer_uid: 'u_evil' };
  const ctx = { db: { tag: 'db' }, customer_uid: 'u_verified', body, orderType: 'delivery', orderId: 'XP-1',
    TP: { recordLastTip: async (db, args) => { calls.push([db, args]); return { written: true }; } } };
  vm.runInNewContext(`(async () => {\n${src}\n})()`, ctx);
  assert.strictEqual(calls.length, 1, `🔴 ${name}: exactly one recordLastTip`);
  assert.strictEqual(calls[0][0], ctx.db, `${name}: the request's db`);
  const a = calls[0][1];   // built inside the vm realm: compare by value (+ the body by identity), not by prototype
  assert.deepStrictEqual([Object.keys(a).sort(), a.uid, a.body === body, a.orderType, a.orderId], [['body', 'orderId', 'orderType', 'uid'], 'u_verified', true, 'delivery', 'XP-1'], `🔴 ${name}: the VERIFIED customer_uid (never a body uid), the body, orderType, orderId`);
  assert.ok(/^\s+await TP\.recordLastTip\(/m.test(src), `${name}: awaited (Cloud Functions may freeze after the response)`);
}
ok('behaviour: each hook awaits recordLastTip(db, { uid: customer_uid (verified), body, orderType, orderId }) once — a body uid is never passed');

// 4. sensitivity
assert.throws(() => unapplyTipprefIndex(live.replace(H['card-issued'].end, '')), /missing|more than once|malformed/, 'a missing end marker throws');
assert.throws(() => unapplyTipprefIndex(live + `\n${H.require.begin}\n${H.require.end}\n`), /more than once/, 'a duplicated marker throws');
assert.throws(() => unapplyTipprefIndex(live.replace(`\n  ${H['cash-live'].begin}`, ` ${H['cash-live'].begin}`)), /own lines/, 'a shared-line marker throws');
assert.notStrictEqual(unapplyTipprefIndex(live.replace('const hosted = flow.hosted;', 'const hosted = flow.hosted; ')), base, 'a byte outside every hunk fails the pin');
ok('sensitivity: missing / duplicated / shared-line markers throw; a byte outside every hunk fails the pin');

console.log(`tippref-wiring.guard: OK (${n})`);
