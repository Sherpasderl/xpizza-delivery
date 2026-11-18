'use strict';
// fix/sdk-token-null-5f (owner ruling 11-18, card items 2; D4c-grill/privacy-5f/PLAN-card-token-cleanup.md (b)) — the reusable card
// token on payment_sdk/{oid}.token is NULLED once nothing can read it: the order is finished (status delivered/completed, payment_terminal,
// or a committed cancel / expiry — payment_cancel) AND the record is closed (not open / adjusting, no lock, no unanswered money op) AND the vault no longer owes a
// read (the winning attempt did not ask to save, or rec.vault.state is set). token_hash (per attempt) is KEPT. ONE CAS on the
// record, in the sweeper right after the vault step. Real coordinator + real sweeper + real cards on the honest RTDB model; the
// provider is the fake adapter. Run: node payments/sdk/token-null.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const C = require('./coordinator');
const K = require('./cards');
const SW = require('./sweeper');
const T0 = 1_800_000_000_000;   // 2027-01-15
const H = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
const OID = 'tn_order_1';
const world = (script = {}) => {
  const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tn_rest', customer_uid: 'uid_A', customer_name: 'Ana Pérez', total_cents: 100, pay_deadline_at: T0 + 900000 } } });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => T0, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, verifyIdToken: async () => ({ uid: 'uid_A' }) };
  return { db, fake, deps, rec: () => db.getAt(`payment_sdk/${OID}`), ord: () => db.getAt(`orders/${OID}`) };
};
const card = (save) => ({ card_ref: 'new', display: DISP, save, vault_gen: 0 });
const place = async (w, token, save) => {
  const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_tn_place_00000001', token, amount_cents: 100, card: card(save) });
  assert.strictEqual(p.outcome, 'placed', 'premise: the real coordinator placed the order');
  assert.strictEqual(w.rec().token, token, 'premise: the record carries the token');
};
const deliver = async (w) => { await w.db.ref(`orders/${OID}/status`).set('delivered'); };
const hashes = (w) => Object.values(w.rec().attempts || {}).map((a) => a.token_hash);

(async () => {
  await cell('TN-NULL-NO-SAVE', async (L) => {
    const w = world(); await place(w, 'T-nosave', false); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(w.ord().payment_terminal && w.rec().phase === 'frozen', `${L}: premise — the real sweeper settled the delivered order`);
    assert.strictEqual(w.rec().token, undefined, `${L}: a terminal, closed order with no save ⇒ the token is gone`);
    assert.deepStrictEqual(hashes(w), [H('T-nosave')], `${L}: the attempt's token_hash is kept`);
  });
  await cell('TN-NULL-AFTER-VAULT', async (L) => {
    const w = world(); await place(w, 'T-save', true); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().vault && w.rec().vault.state, 'done', `${L}: premise — the vault step ran on this visit`);
    const cards = Object.values(w.db.getAt('customer_cards/uid_A/cards') || {});
    assert.ok(cards.length === 1 && cards[0].token === 'T-save', `${L}: the saved card got the token BEFORE it was nulled`);
    assert.strictEqual(w.rec().token, undefined, `${L}: the same visit nulls the record's token once the vault is settled`);
    assert.deepStrictEqual(hashes(w), [H('T-save')], `${L}: token_hash kept`);
  });
  await cell('TN-KEPT-WHILE-VAULT-OWED', async (L) => {
    const w = world(); await place(w, 'T-owed', true); await deliver(w);
    await C.settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.ord().payment_terminal && !(w.rec().vault && w.rec().vault.state), `${L}: premise — terminal, the vault not yet run`);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: a save still owed ⇒ kept`);
    assert.strictEqual(w.rec().token, 'T-owed', `${L}: the vault can still read it`);
    await K.completeVaultForOrder(w.deps, OID);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'nulled', `${L}: once the vault is settled ⇒ nulled`);
    assert.strictEqual(w.rec().token, undefined, `${L}: gone`);
  });
  await cell('TN-NULL-CANCELLED', async (L) => {
    const w = world(); await place(w, 'T-cancel', false);
    const c = await C.cancelSdkOrder(w.deps, { orderId: OID });
    assert.ok(w.ord().payment_cancel && w.rec().phase === 'cancelled' && !w.ord().payment_terminal, `${L}: premise — a committed cancel (${c && c.outcome}), never payment_terminal`);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().token, undefined, `${L}: a cancelled order's token does not stay forever`);
    assert.deepStrictEqual(hashes(w), [H('T-cancel')], `${L}: token_hash kept`);
  });
  await cell('TN-KEPT-WHILE-OPEN', async (L) => {
    const w = world(); await place(w, 'T-open', false);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(!w.ord().payment_terminal && w.rec().phase === 'open', `${L}: premise — a live (placed, not terminal) order`);
    assert.strictEqual(w.rec().token, 'T-open', `${L}: an open order keeps its token (a decrease re-authorizes with it)`);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: not terminal ⇒ kept`);
  });
  await cell('TN-KEPT-RECORD-NOT-CLOSED', async (L) => {
    const w = world(); await place(w, 'T-lock', false); await deliver(w);
    await C.settleTerminal(w.deps, { orderId: OID });
    await w.db.ref(`payment_sdk/${OID}/lock`).set({ op_id: 'op_x', at: T0 });   // a money operation in flight
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: a locked record ⇒ kept`);
    assert.strictEqual(w.rec().token, 'T-lock', `${L}: kept`);
  });
  await cell('TN-IDEMPOTENT', async (L) => {
    const w = world(); await place(w, 'T-idem', false); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    const v = w.rec().version;
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'none', `${L}: nothing left to null`);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().version, v, `${L}: a later visit writes nothing (no version bump)`);
  });
  // the reader CENSUS (Codex #149) moved: payment_sdk's token has ONE owner (payments/sdk/record-token.js) and a TREE-WIDE guard,
  // payments/sdk/record-token.guard.test.js (owner 11-18 «airtight», Codex #150) — every token site, record escape and owner call pinned.
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\ntoken-null: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stderr.write(`token-null: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
