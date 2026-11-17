'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §6; Codex #108 r1 #13) — the PRIVATE LEDGER WRITE guard. contract/census-build.js inventories
// ORDER fields, not other roots, so the ledger's own writes are pinned here, by source scan:
//   · every non-test source that names a ledger path (`ledger_alloc` / `ledger_settings` / `ledger/`) or attaches a `ledger:` field is on
//     the allowlist, at exactly the reviewed number of sites — a new writer is RED until reviewed;
//   · each reviewed site rides the write it must ride (the cash multi-path updates, the hosted claim txn, the SDK record create);
//   · the ledger roots stay rule-less (server-only by RTDB's default deny) and the root grants nothing.
// Run: node ledger-writes.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const files = execFileSync('git', ['ls-files', '*.js'], { cwd: __dirname, encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => !/(^|\/)(node_modules|test)\//.test(f) && !/\.test\.js$/.test(f) && !/^tools\//.test(f));
// a ledger PATH literal, the snapshot's own `ledger:` field forms, or allocPath( — the rewards/driver ledgers' own `ledger:` keys are not ours
const LEDGER_RE = /['"`]ledger(?:_alloc|_settings|\/)|\bledger: (?:ledgerSnap|require\('[./]*ledger\/alloc-snapshot'\))|allocPath\(/g;
const ALLOW = {   // file → reviewed sites (S1)
  'ledger/alloc-snapshot.js': 1,          // allocPath's own definition
  'ledger/rebuild.js': 10,                // S5: the nightly rebuild — reads ledger_alloc / ledger/open / ledger/orders leaves / ledger/run; the per-order patch (projection | stale_hold) below
  'ledger/commission-rate.js': 1,         // S4: the commission setting's NODE constant (read by the nightly job; written only by the owner CLI below)
  'index.js': 3,                          // cash held + cash ASAP (allocPath) + the hosted acquire argument
  'pixelpay-hosted-charge.js': 1,         // `ledger:` inside the exclusive payment_attempts claim
  'payments/sdk/coordinator.js': 1,       // `ledger:` inside the payment_sdk record create
};
const found = {};
for (const f of files) {
  const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const c = (s.match(LEDGER_RE) || []).length + (f === 'index.js' ? (s.match(/snapshotOf\(pendingOrderRecord/g) || []).length : 0);
  if (c) found[f] = c;
}
assert.deepStrictEqual(found, ALLOW, '🔴 LEDGER-WRITES: an unreviewed ledger write site (or a reviewed one went missing)');
ok(`ledger writes only at the ${Object.values(ALLOW).reduce((a, b) => a + b, 0)} reviewed sites in ${Object.keys(ALLOW).length} files`);

// LEDGER S2: the capture evidence — written ONLY by the two void paths' existing post-void updates, through the non-throwing builder
{
  const EV_RE = /capture_evidence\/|capture-evidence'\)\.evidenceOf\(/g;
  const ev = {};
  for (const f of files) { const c = (fs.readFileSync(path.join(__dirname, f), 'utf8').match(EV_RE) || []).length; if (c) ev[f] = c; }
  assert.deepStrictEqual(ev, { 'ledger/capture-evidence.js': 1, 'pixelpay-confirm.js': 2, 'pixelpay-hosted-webhook.js': 2 }, '🔴 LEDGER-WRITES: an unreviewed capture_evidence writer (or a reviewed one went missing)');
  const CF = fs.readFileSync(path.join(__dirname, 'pixelpay-confirm.js'), 'utf8');
  const vd = CF.indexOf("voidReason: 'xpizza_mismatch_void'"); const evc = CF.indexOf("'capture_evidence/confirm'");
  assert.ok(vd > 0 && evc > vd && evc - vd < 900, '🔴 LEDGER-WRITES: the confirm evidence rides the post-void attempt update (void first)');
  const WH = fs.readFileSync(path.join(__dirname, 'pixelpay-hosted-webhook.js'), 'utf8');
  const vp = WH.indexOf('await deps.voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId: hostedOrderId'); const evw = WH.indexOf("'capture_evidence/webhook'");
  assert.ok(vp > 0 && evw > vp && evw - vp < 600, '🔴 LEDGER-WRITES: the webhook evidence rides voidPaid\'s post-void attempt update (void first)');
  ok('capture_evidence: only the confirm mismatch void and the webhook voidPaid write it, each in its post-void update');
}

const IDX = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const lineOf = (re) => { const m = IDX.match(re); assert.ok(m, `🔴 LEDGER-WRITES: missing ${re}`); return m.index; };
const held = lineOf(/heldUpdates\[LA\(\)\.allocPath\(orderId\)\] = LA\(\)\.snapshotOf\(heldUpdates\[`orders\/\$\{orderId\}`\], LA\(\)\.modeOf\(\{ body, clientHdr \}\)\);/);
assert.ok(held < IDX.indexOf('await db.ref().update(heldUpdates);', held) && IDX.indexOf('await db.ref().update(heldUpdates);', held) - held < 400, '🔴 the held snapshot rides the held multi-path update (just before it)');
const live = lineOf(/updates\[LA\(\)\.allocPath\(orderId\)\] = LA\(\)\.snapshotOf\(updates\[`orders\/\$\{orderId\}`\], LA\(\)\.modeOf\(\{ body, clientHdr \}\)\);/);
assert.ok(IDX.indexOf('await db.ref().update(updates);', live) - live < 400 && IDX.indexOf('await db.ref().update(updates);', live) > live, '🔴 the ASAP snapshot rides the order\'s multi-path update (just before it)');
lineOf(/LA\(\)\.snapshotOf\(pendingOrderRecord, LA\(\)\.modeOf\(\{ body, clientHdr \}\)\)/);
const HC = fs.readFileSync(path.join(__dirname, 'pixelpay-hosted-charge.js'), 'utf8');
const claim = HC.indexOf("const claim = await db.ref(`payment_attempts/${attemptId}`).transaction((cur) => {");
assert.ok(claim > 0 && HC.indexOf("...(ledgerSnap ? { ledger: require('./ledger/alloc-snapshot').withCommittedCreatedAt(ledgerSnap, committed.created_at) } : {})", claim) > claim && HC.indexOf("...(ledgerSnap ? { ledger: require('./ledger/alloc-snapshot').withCommittedCreatedAt(ledgerSnap, committed.created_at) } : {})", claim) - claim < 900, '🔴 the hosted snapshot rides the exclusive claim');
const CO = fs.readFileSync(path.join(__dirname, 'payments/sdk/coordinator.js'), 'utf8');
assert.ok(/await R\.createRecord\(deps\.db, orderId, \{ flow: 'sdk_auth_v1', phase: 'open', [^\n]*ledger: require\('\.\.\/\.\.\/ledger\/alloc-snapshot'\)\.snapshotOf\(order, require\('\.\.\/\.\.\/ledger\/alloc-snapshot'\)\.modeOf\(\{ sdk: true/.test(CO), '🔴 the SDK snapshot rides the open record create (mode sdk)');
ok('the cash held + ASAP snapshots ride their multi-path updates; the hosted one the exclusive claim; the SDK one the record create (mode sdk)');

const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
assert.ok(!('.read' in R) && !('.write' in R) && !Object.keys(R).some((k) => k.startsWith('$')), 'premise: the root grants nothing, no root wildcard');
for (const node of ['ledger_alloc', 'ledger', 'ledger_settings']) assert.ok(!(node in R), `🔴 ${node} must stay rule-less (server-only by default deny)`);
ok('ledger_alloc / ledger / ledger_settings: no rule, no root grant, no root wildcard ⇒ every client denied');
// LEDGER S4: ledger_settings is written ONLY by the owner's append-only CLI (tools/ is outside the scan above, so it is pinned here)
{
  const tools = execFileSync('git', ['ls-files', 'tools/*.js'], { cwd: __dirname, encoding: 'utf8' }).split('\n').filter((f) => f && !/\.test\.js$/.test(f));
  const users = tools.filter((f) => /ledger_settings|ledger\/commission-rate'\)/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepStrictEqual(users.sort(), ['tools/set-commission-rate-core.js', 'tools/set-commission-rate.js'], '🔴 LEDGER-WRITES: only the owner commission CLI touches ledger_settings');
  ok('ledger_settings: only tools/set-commission-rate(-core).js (append-only, never retro)');
}
// LEDGER S4: the nightly rebuild's window indexes (PLAN-5f-ledger-shadow-s1-r3 §3) — rules-only, on server-only / staff-read nodes
{
  const IX = (node) => R[node]['.indexOn'] || [];
  for (const f of ['created_at', 'delivered_at', 'cancelled_at', 'refunded_at', 'fulfilled_offline_at', 'extra_payment_review']) assert.ok(IX('orders').includes(f), `🔴 LEDGER-WRITES: orders .indexOn ${f}`);
  for (const f of ['paid_at', 'uncertain_at', 'order_id', 'refunded_at', 'voided_at', 'failed_at', 'flagged_at']) assert.ok(IX('payment_attempts').includes(f), `🔴 LEDGER-WRITES: payment_attempts .indexOn ${f}`);
  assert.strictEqual(R.payment_attempts['.read'], false, 'premise: payment_attempts stays server-only');
  ok('the nightly window indexes are declared (orders 6, payment_attempts 7); payment_attempts stays server-only');
}
// LEDGER S5: the nightly rebuild writes ONLY through ONE multi-path update (ledger/orders/{id} replaced whole + ledger/open/{id}), the
// run record (two sets on ONE ref) and the create-once alarm transaction — no remove, no push, no other root
{
  const s = fs.readFileSync(path.join(__dirname, 'ledger/rebuild.js'), 'utf8');
  const count = (re) => (s.match(re) || []).length;
  assert.deepStrictEqual([count(/\bdb\.ref\(\)\.update\(/g), count(/\.update\(patch\)/g), count(/\brunRef\.set\(/g), count(/\.set\(/g), count(/\.transaction\(/g), count(/\.remove\(/g), count(/\.ref\([^)]*\)\.push\(/g)],
    [1, 1, 2, 2, 1, 0, 0], '🔴 LEDGER-WRITES: the rebuild gained an unreviewed write');
  const fn = s.slice(s.indexOf('async function rebuildOrder('), s.indexOf('\n}\n', s.indexOf('async function rebuildOrder(')));
  assert.deepStrictEqual((fn.match(/\[`([a-z_]+\/[a-z_]+)\//g) || []).map((x) => x.slice(2, -1)), ['ledger/open', 'ledger/orders', 'ledger/orders', 'ledger/open', 'ledger/orders'], '🔴 LEDGER-WRITES: the per-order patch writes only ledger/orders + ledger/open (the stale_hold leaf, the whole projection; the last is the result check)');
  assert.ok(/const runRef = db\.ref\(`ledger\/run\/\$\{date\}`\)/.test(s) && /db\.ref\(`dispatcher_alerts\/ledger_run_\$\{date\}`\)\.transaction\(\(cur\) => \(cur === null \? payload : undefined\)\)/.test(s), '🔴 LEDGER-WRITES: the run record ref + the create-once alarm');
  ok('the nightly rebuild: one per-order update (ledger/orders + ledger/open), the run record, one create-once alarm — nothing else');
}
console.log(`ledger-writes.guard: OK (${n})`);
