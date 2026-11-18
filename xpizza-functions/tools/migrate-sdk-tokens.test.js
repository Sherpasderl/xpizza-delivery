'use strict';
// owner GO 11-18: the one-time migration of legacy card tokens off payment_sdk/{oid} (tools/migrate-sdk-tokens.js), on the honest RTDB
// model with records written the way the old claim wrote them (token on the record, token_hash per attempt). Run: node tools/migrate-sdk-tokens.test.js
const assert = require('assert');
const crypto = require('crypto');
const { makeHonestDb } = require('../_honest-rtdb-model');
const M = require('./migrate-sdk-tokens');
const T = require('../payments/sdk/record-token');
const H = (t) => crypto.createHash('sha256').update(t).digest('hex');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// LEGACY records from the REAL writer: the real placeOriginal places each order, then the record is put back in the pre-change shape
// (the token ON the record, no pointer, no node) — exactly what the old claim left
const { makeAdapter } = require('../payments/sdk/psp-adapter');
const { makeFakePsp } = require('../payments/sdk/fake-adapter');
const C = require('../payments/sdk/coordinator');
const T0 = 1_800_000_000_000; const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
const ORDER = { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tn_rest', customer_uid: 'uid_A', customer_name: 'Ana', total_cents: 100, pay_deadline_at: T0 + 900000 };
async function seed(hooks = {}) {
  const db = makeHonestDb({ orders: { o_match: { ...ORDER }, o_unmatched: { ...ORDER }, o_new: { ...ORDER } } }, { now: () => T0, ...hooks });
  const deps = { db, psp: makeAdapter(makeFakePsp({}).impl), clock: () => T0, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {} };
  for (const [oid, att, tok] of [['o_match', 'att_mig_match_000001', 'T-m'], ['o_unmatched', 'att_mig_unmatch_00001', 'T-u'], ['o_new', 'att_mig_new_00000001', 'T-c']]) {
    const p = await C.placeOriginal(deps, { orderId: oid, attempt_id: att, token: tok, amount_cents: 100, card: { card_ref: 'new', display: DISP, save: false, vault_gen: 0 } });
    assert.strictEqual(p.outcome, 'placed', 'premise: placed by the real coordinator');
  }
  for (const [oid, legacy] of [['o_match', 'T-m'], ['o_unmatched', 'T-not-any-attempt']]) {   // back to the pre-change shape
    await db.ref(`payment_sdk/${oid}`).update({ token: legacy, token_attempt: null }); await db.ref(`payment_sdk_tokens/${oid}`).set(null);
  }
  return db;
}
(async () => {
  const db = await seed(); const before = JSON.stringify(db.root);
  const dry = await M.migrate({ rtdb: db });
  assert.deepStrictEqual(dry, { dryRun: true, records: 3, withToken: 2, matched: 1, unmatched: 1, migrated: 0, raced: 0 }, '🔴 MIG-DRY: the dry run counts');
  assert.strictEqual(JSON.stringify(db.root), before, '🔴 MIG-DRY: the dry run writes nothing');
  assert.ok(!JSON.stringify(dry).includes('o_') && !JSON.stringify(dry).includes('T-'), 'MIG-DRY: counts only');
  ok('dry run: counts only (records, legacy tokens, matched to an attempt by hash, unmatched), nothing written');
  const r = await M.migrate({ rtdb: db, apply: true });
  assert.deepStrictEqual(r, { dryRun: false, records: 3, withToken: 2, matched: 1, unmatched: 1, migrated: 1, raced: 0 }, '🔴 MIG-APPLY: one migrated');
  const m = db.getAt('payment_sdk/o_match');
  assert.ok(m.token === undefined && m.token_attempt === 'att_mig_match_000001', '🔴 MIG-APPLY: the record keeps only the pointer to the MATCHING attempt (one CAS)');
  assert.deepStrictEqual(db.getAt('payment_sdk_tokens/o_match'), { att_mig_match_000001: 'T-m' }, '🔴 MIG-APPLY: the token sits at payment_sdk_tokens/{oid}/{attempt}');
  assert.strictEqual(await T.readToken(db, 'o_match', m), 'T-m', '🔴 MIG-APPLY: the real reader finds it');
  assert.strictEqual(db.getAt('payment_sdk/o_unmatched/token'), 'T-not-any-attempt', '🔴 MIG-APPLY: an unmatched token is left untouched (never guessed)');
  assert.strictEqual(db.getAt('payment_sdk_tokens/o_unmatched'), null, 'MIG-APPLY: nothing written for it');
  ok('--apply: a matched legacy token moves to the node (write-ahead) and the record to the pointer in one CAS; unmatched untouched');
  const again = JSON.stringify(db.root);
  assert.deepStrictEqual(await M.migrate({ rtdb: db, apply: true }), { dryRun: false, records: 3, withToken: 1, matched: 0, unmatched: 1, migrated: 0, raced: 0 }, '🔴 MIG-IDEMPOTENT');
  assert.strictEqual(JSON.stringify(db.root), again, '🔴 MIG-IDEMPOTENT: a rerun writes nothing');
  ok('idempotent: a rerun finds nothing left to move and writes nothing');
  // a concurrent change between the read and the CAS: the record's token changed ⇒ «raced», the record is left as the other writer made it
  let armed = false; let raced = null;
  raced = await seed({ beforeTx: async (p) => { if (armed && p === 'payment_sdk/o_match') { armed = false; await raced.ref('payment_sdk/o_match/token').set('T-newer'); } } });
  armed = true;
  const r2 = await M.migrate({ rtdb: raced, apply: true });
  assert.ok(r2.raced === 1 && r2.migrated === 0 && raced.getAt('payment_sdk/o_match/token') === 'T-newer', '🔴 MIG-RACE: a token changed under the migration is left for the next run (never overwritten)');
  ok('a token changed between the read and the CAS is never overwritten (raced)');
  console.log(`migrate-sdk-tokens: OK (${n})`);
})().catch((e) => { process.stderr.write(`migrate-sdk-tokens: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
