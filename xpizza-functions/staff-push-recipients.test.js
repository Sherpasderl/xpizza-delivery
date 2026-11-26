'use strict';
// S2 (PLAN-brand-agnostic-convergence r9 §3-S, #334-4): staff-push recipients = the CURRENT dispatchers only.
// A staff push carries a customer's name (formatNewOrder / formatStuck), so the fan-out sends only to a subscribed uid whose
// dispatchers/{uid} exists AT SEND TIME — the predicate of authorizeDispatcherActionWithUid and of the dispatchers rules.
//   SPR-ONLY-DISPATCHERS  a subscribed non-dispatcher (e.g. any staff / driver account that registered a subscription) is not a recipient
//   SPR-REVOKED           removing dispatchers/{uid} stops that uid's pushes at the next send (revocation, no other step)
//   SPR-FAIL-CLOSED       a dispatcher check that cannot be read excludes the uid (never sends on an unverified device)
//   SPR-WIRING            index.js fanoutStaffPush's one send maps over staffRecipients(db, <subscribed uids>) — no other fan-out path
// Run: node staff-push-recipients.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { makeHonestDb } = require('./_honest-rtdb-model');
const SP = require('./staff-push');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const SUB = (k) => ({ subscription: { endpoint: `https://push.example/${k}`, keys: { p256dh: 'p', auth: 'a' } }, updated_at: 1 });

(async () => {
  await cell('SPR-ONLY-DISPATCHERS: a subscribed non-dispatcher is never a recipient', async (L) => {
    const db = makeHonestDb({ dispatchers: { d1: true, d2: { email: 'x' } }, staff_push: { d1: SUB('d1'), d2: SUB('d2'), staff9: SUB('s9'), drv7: SUB('v7') } });
    const got = await SP.staffRecipients(db, ['d1', 'd2', 'staff9', 'drv7']);
    assert.deepStrictEqual(got, ['d1', 'd2'], `🔴 ${L}`);
  });
  await cell('SPR-REVOKED: removing dispatchers/{uid} stops that uid at the next send', async (L) => {
    const db = makeHonestDb({ dispatchers: { d1: true, d2: true }, staff_push: { d1: SUB('d1'), d2: SUB('d2') } });
    assert.deepStrictEqual(await SP.staffRecipients(db, ['d1', 'd2']), ['d1', 'd2'], `${L}: premise`);
    await db.ref('dispatchers/d2').remove();
    assert.deepStrictEqual(await SP.staffRecipients(db, ['d1', 'd2']), ['d1'], `🔴 ${L}`);
  });
  await cell('SPR-FAIL-CLOSED: a dispatcher check that cannot be read excludes the uid', async (L) => {
    const db = makeHonestDb({ dispatchers: { d1: true, d2: true } }, { beforeRead: async (p) => { if (p === 'dispatchers/d2') throw new Error('unavailable'); } });
    assert.deepStrictEqual(await SP.staffRecipients(db, ['d1', 'd2']), ['d1'], `🔴 ${L}`);
  });
  await cell('SPR-WIRING: index.js fanoutStaffPush sends only to staffRecipients(db, <subscribed uids>)', async (L) => {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true });
    const fn = ast.body.find((s) => s.type === 'FunctionDeclaration' && s.id && s.id.name === 'fanoutStaffPush');
    assert.ok(fn, `${L}: fanoutStaffPush present`);
    const body = src.slice(fn.start, fn.end);
    const sends = body.match(/sendStaffPush\(/g) || [];
    assert.strictEqual(sends.length, 1, `${L}: one send site`);
    assert.ok(/Promise\.allSettled\(\(await require\('\.\/staff-push'\)\.staffRecipients\(db, Object\.keys\(all\)\)\)\.map\(\(uid\) => sendStaffPush\(db, uid, payload\)\)\)/.test(body), `🔴 ${L}: the one send maps over staffRecipients(db, <subscribed uids>), not every subscription`);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`staff-push-recipients: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
