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
console.log(`ledger-writes.guard: OK (${n})`);
