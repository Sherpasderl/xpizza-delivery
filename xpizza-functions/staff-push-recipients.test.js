'use strict';
// S2 (PLAN-brand-agnostic-convergence r9 §3-S, #334-4; Codex #414): staff-push recipients = the CURRENT dispatchers only, and a
// CONFIRMED non-dispatcher's subscription is pruned. staff-push.js staffRecipients(db, <the staff_push map the fan-out read>):
//   SPR-ONLY-DISPATCHERS  a subscribed non-dispatcher (staff / driver / merchant account) is never a recipient
//   SPR-REVOKED           removing dispatchers/{uid} stops that uid at the next send, and prunes its staff_push/{uid}
//   SPR-PRUNE-KEEPS-NEW   a subscription replaced / re-written after the fan-out's read is KEPT (compare-and-delete on the exact record)
//   SPR-UNREADABLE        a membership check that cannot be read: not a recipient, and its subscription is NEVER deleted
//   SPR-LOG               the revocation log carries a fixed category and counts only — no uid
//   SPR-WIRING            index.js fanoutStaffPush's one send maps over staffRecipients(db, all) — no other fan-out path
// The REAL triggers' delivery proof is staff-push-delivery.test.js. Run: node staff-push-recipients.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { makeHonestDb } = require('./_honest-rtdb-model');
const SP = require('./staff-push');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const SUB = (k, at = 1) => ({ subscription: { endpoint: `https://push.example/${k}`, keys: { p256dh: 'p', auth: 'a' } }, updated_at: at });
const read = async (db, p) => (await db.ref(p).once('value')).val();
const logs = () => { const out = []; const orig = console.log; console.log = (...a) => { out.push(a.join(' ')); }; return { out, done: () => { console.log = orig; } }; };

(async () => {
  await cell('SPR-ONLY-DISPATCHERS: a subscribed non-dispatcher is never a recipient', async (L) => {
    const subs = { d1: SUB('d1'), d2: SUB('d2'), staff9: SUB('s9'), drv7: SUB('v7') };
    const db = makeHonestDb({ dispatchers: { d1: true, d2: { email: 'x' } }, staff_push: subs });
    assert.deepStrictEqual(await SP.staffRecipients(db, subs), ['d1', 'd2'], `🔴 ${L}`);
  });
  await cell('SPR-REVOKED: removing dispatchers/{uid} stops that uid at the next send and prunes its subscription', async (L) => {
    const db = makeHonestDb({ dispatchers: { d1: true, d2: true }, staff_push: { d1: SUB('d1'), d2: SUB('d2') } });
    assert.deepStrictEqual(await SP.staffRecipients(db, await read(db, 'staff_push')), ['d1', 'd2'], `${L}: premise`);
    await db.ref('dispatchers/d2').remove();
    assert.deepStrictEqual(await SP.staffRecipients(db, await read(db, 'staff_push')), ['d1'], `🔴 ${L}: not a recipient`);
    assert.strictEqual(await read(db, 'staff_push/d2'), null, `🔴 ${L}: pruned`);
    assert.deepStrictEqual(await read(db, 'staff_push/d1'), SUB('d1'), `${L}: the dispatcher's own subscription untouched`);
  });
  await cell('SPR-PRUNE-KEEPS-NEW: a subscription re-written after the read is kept (compare-and-delete)', async (L) => {
    let raced = false;
    const db = makeHonestDb({ staff_push: { x1: SUB('x1') } }, { beforeTx: async (p, api) => { if (!raced && p === 'staff_push/x1') { raced = true; await api.ref('staff_push/x1').set(SUB('x1-new', 2)); } } });
    const subs = await read(db, 'staff_push');
    assert.deepStrictEqual(await SP.staffRecipients(db, subs), [], `${L}: not a recipient`);
    assert.ok(raced, `${L}: premise, the replacement landed between the read and the delete`);
    assert.deepStrictEqual(await read(db, 'staff_push/x1'), SUB('x1-new', 2), `🔴 ${L}: the replacement survives`);
  });
  await cell('SPR-UNREADABLE: an unreadable membership check excludes delivery but never deletes', async (L) => {
    const db = makeHonestDb({ dispatchers: { d1: true }, staff_push: { d1: SUB('d1'), u2: SUB('u2') } }, { beforeRead: async (p) => { if (p === 'dispatchers/u2') throw new Error('unavailable'); } });
    assert.deepStrictEqual(await SP.staffRecipients(db, { d1: SUB('d1'), u2: SUB('u2') }), ['d1'], `🔴 ${L}: excluded`);
    assert.deepStrictEqual(await read(db, 'staff_push/u2'), SUB('u2'), `🔴 ${L}: never deleted on an unknown`);
  });
  await cell('SPR-LOG: the revocation log is a fixed category with counts only (no uid)', async (L) => {
    const db = makeHonestDb({ staff_push: { u_secret_uid_123: SUB('z') } });
    const c = logs(); try { await SP.staffRecipients(db, await read(db, 'staff_push')); } finally { c.done(); }
    assert.deepStrictEqual(c.out, ['staff_push_revoked {"confirmed_absent":1,"pruned":1}'], `🔴 ${L}: ${JSON.stringify(c.out)}`);
  });
  await cell('SPR-WIRING: index.js fanoutStaffPush\'s one send maps over staffRecipients(db, all)', async (L) => {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true });
    const fn = ast.body.find((s) => s.type === 'FunctionDeclaration' && s.id && s.id.name === 'fanoutStaffPush');
    assert.ok(fn, `${L}: fanoutStaffPush present`);
    const body = src.slice(fn.start, fn.end);
    assert.strictEqual((body.match(/sendStaffPush\(/g) || []).length, 1, `${L}: one send site`);
    assert.ok(/Promise\.allSettled\(\(await require\('\.\/staff-push'\)\.staffRecipients\(db, all\)\)\.map\(\(uid\) => sendStaffPush\(db, uid, payload\)\)\)/.test(body), `🔴 ${L}: the one send maps over staffRecipients(db, all), not every subscription`);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`staff-push-recipients: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
