'use strict';
// fix/sdk-token-null-5f (owner ruling 11-18, card items 2; D4c-grill/privacy-5f/PLAN-card-token-cleanup.md (b)) — the reusable card
// token lives OUTSIDE the record (owner GO 11-18, airtight by construction): payment_sdk_tokens/{oid}/{attempt_id}, written AHEAD of the
// claim (concurrently with the claim's existing round trips), the record keeping only the pointer token_attempt; only
// payments/sdk/record-token.js touches it. It is NULLED (the whole node removed, the pointer dropped) once nothing can read it: the order is finished (status delivered/completed, payment_terminal,
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
const world = (script = {}, { eligible = () => false, hooks = {} } = {}) => {
  const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tn_rest', customer_uid: 'uid_A', customer_name: 'Ana Pérez', total_cents: 100, pay_deadline_at: T0 + 900000 } } }, { now: () => T0, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => T0, voidEligible: eligible, ppNamespace: 'sandbox', goLive: async () => {}, verifyIdToken: async () => ({ uid: 'uid_A' }) };
  return { db, fake, deps, rec: () => db.getAt(`payment_sdk/${OID}`), ord: () => db.getAt(`orders/${OID}`), node: () => db.getAt(`payment_sdk_tokens/${OID}`) };
};
const ATT = 'att_tn_place_00000001';
const card = (save) => ({ card_ref: 'new', display: DISP, save, vault_gen: 0 });
const place = async (w, token, save, att = ATT) => {
  const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: att, token, amount_cents: 100, card: card(save) });
  assert.strictEqual(p.outcome, 'placed', 'premise: the real coordinator placed the order');
};
// the token is GONE: no pointer, no legacy field, no node
const gone = (w) => { const r = w.rec() || {}; return r.token === undefined && r.token_attempt === undefined && w.node() == null; };
const deliver = async (w) => { await w.db.ref(`orders/${OID}/status`).set('delivered'); };
const hashes = (w) => Object.values(w.rec().attempts || {}).map((a) => a.token_hash);
const REV = (cents) => ({ items: [{ name: 'tb_item', qty: 1, unit: cents / 100 }], total_cents: cents, delivery_cents: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── the node: the record never holds the token; the claim points at its attempt; the token sits at payment_sdk_tokens/{oid}/{aid} ──
  await cell('TN-NODE-NOT-RECORD', async (L) => {
    const w = world(); await place(w, 'T-node', false);
    assert.ok(!JSON.stringify(w.rec()).includes('T-node'), `${L}: the payment_sdk record holds NO token value`);
    assert.strictEqual(w.rec().token_attempt, ATT, `${L}: the claim points at its attempt (the last claim wins, as before)`);
    assert.deepStrictEqual(w.node(), { [ATT]: { t: 'T-node', uid: 'uid_A' } }, `${L}: the token sits at payment_sdk_tokens/{oid}/{attempt_id}`);
  });
  // ── the re-authorize readers use the POINTED attempt's token (the last claim wins), read BEFORE any money op is journaled ──
  await cell('TN-REAUTH-POINTER', async (L) => {
    const w = world({ authorize: [{ outcome: 'definitive_decline', code: 'X' }, { outcome: 'approved' }, { outcome: 'approved' }] }, { eligible: () => true });
    const p1 = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_tn_first_00000001', token: 'T-loser', amount_cents: 100, card: card(false) });
    await place(w, 'T-winner', false, 'att_tn_second_0000002');
    assert.ok(p1.outcome !== 'placed' && w.rec().token_attempt === 'att_tn_second_0000002', `premise: the second attempt placed and is pointed at (${p1.outcome})`);
    await w.db.ref(`orders/${OID}/status`).set('preparing');
    const r = await C.requestDecrease(w.deps, { orderId: OID, new_total_cents: 80, revision: REV(80) });
    const auths = w.fake.calls.filter((c) => c.action === 'authorize');
    assert.ok(r && auths.length === 3, `premise: the decrease re-authorized (${JSON.stringify(r)}, ${auths.length} auths)`);
    assert.strictEqual(auths[2].token, 'T-winner', `${L}: the decrease re-authorizes with the WINNING attempt's token from the node`);
  });
  await cell('TN-READ-BEFORE-JOURNAL', async (L) => {
    let fail = false;
    const w = world({ authorize: [{ outcome: 'approved' }] }, { eligible: () => true, hooks: { beforeRead: async (p) => { if (fail && String(p).startsWith('payment_sdk_tokens')) throw Object.assign(new Error('read failed'), { code: 'unavailable' }); } } });
    await place(w, 'T-rf', false);
    await w.db.ref(`orders/${OID}/status`).set('preparing');
    const ops0 = Object.keys(w.rec().ops || {}).length;
    fail = true;
    await assert.rejects(() => C.requestDecrease(w.deps, { orderId: OID, new_total_cents: 80, revision: REV(80) }));
    assert.strictEqual(Object.keys(w.rec().ops || {}).length, ops0, `${L}: a failed token read journals NO money op (the read precedes dispatch)`);
    assert.strictEqual(w.fake.callCount('authorize'), 1, `${L}: no PSP call`);
  });
  // ── Codex #158 r1 F1: two requests with the SAME attempt id and DIFFERENT tokens both pass the replay check — the token is CREATE-ONCE
  //    per attempt: the second is refused before any claim, so the stored token is always the one the claim authorized ──
  await cell('TN-ATTEMPT-CONFLICT', async (L) => {
    const w = world({ authorize: [{ outcome: 'approved' }, { outcome: 'approved' }, { outcome: 'approved' }] }, { eligible: () => true });
    const go = (tok) => C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: tok, amount_cents: 100, card: card(false) });
    const [ra, rb] = await Promise.all([go('T-A'), go('T-B')]);
    const placedTok = w.fake.calls.filter((c) => c.action === 'authorize').map((c) => c.token);
    assert.ok(placedTok.length === 1, `premise: ONE authorize for the attempt (${JSON.stringify([ra.outcome, rb.outcome])})`);
    assert.deepStrictEqual(w.node(), { [ATT]: { t: placedTok[0], uid: 'uid_A' } }, `${L}: the stored token is the one the placement authorized (never overwritten by a same-id request)`);
    assert.ok([ra, rb].some((r) => r.outcome === 'refused' && r.reason === 'attempt_token_conflict') || [ra, rb].every((r) => r.outcome !== 'refused'), `${L}: a same-id request with a DIFFERENT token is refused (attempt_token_conflict) (${JSON.stringify([ra, rb])})`);
    await w.db.ref(`orders/${OID}/status`).set('preparing');
    await C.requestDecrease(w.deps, { orderId: OID, new_total_cents: 80, revision: REV(80) });
    const all = w.fake.calls.filter((c) => c.action === 'authorize').map((c) => c.token);
    assert.strictEqual(all[all.length - 1], placedTok[0], `${L}: a later decrease re-authorizes with the SAME token the placement authorized`);
  });
  await cell('TN-NULL-NO-SAVE', async (L) => {
    const w = world(); await place(w, 'T-nosave', false); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(w.ord().payment_terminal && w.rec().phase === 'frozen', `${L}: premise — the real sweeper settled the delivered order`);
    assert.ok(gone(w), `${L}: a terminal, closed order with no save ⇒ the token node and the pointer are gone`);
    assert.deepStrictEqual(hashes(w), [H('T-nosave')], `${L}: the attempt's token_hash is kept`);
  });
  await cell('TN-NULL-AFTER-VAULT', async (L) => {
    const w = world(); await place(w, 'T-save', true); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().vault && w.rec().vault.state, 'done', `${L}: premise — the vault step ran on this visit`);
    const cards = Object.values(w.db.getAt('customer_cards/uid_A/cards') || {});
    assert.ok(cards.length === 1 && cards[0].token === 'T-save', `${L}: the saved card got the token (from the node) BEFORE it was nulled`);
    assert.ok(gone(w), `${L}: the same visit nulls the token once the vault is settled`);
    assert.deepStrictEqual(hashes(w), [H('T-save')], `${L}: token_hash kept`);
  });
  await cell('TN-KEPT-WHILE-VAULT-OWED', async (L) => {
    const w = world(); await place(w, 'T-owed', true); await deliver(w);
    await C.settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.ord().payment_terminal && !(w.rec().vault && w.rec().vault.state), `${L}: premise — terminal, the vault not yet run`);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: a save still owed ⇒ kept`);
    assert.deepStrictEqual(w.node(), { [ATT]: { t: 'T-owed', uid: 'uid_A' } }, `${L}: the vault can still read it`);
    await K.completeVaultForOrder(w.deps, OID);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'nulled', `${L}: once the vault is settled ⇒ nulled`);
    assert.ok(gone(w), `${L}: gone`);
  });
  await cell('TN-NULL-CANCELLED', async (L) => {
    const w = world(); await place(w, 'T-cancel', false);
    const c = await C.cancelSdkOrder(w.deps, { orderId: OID });
    assert.ok(w.ord().payment_cancel && w.rec().phase === 'cancelled' && !w.ord().payment_terminal, `${L}: premise — a committed cancel (${c && c.outcome}), never payment_terminal`);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(gone(w), `${L}: a cancelled order's token does not stay forever`);
    assert.deepStrictEqual(hashes(w), [H('T-cancel')], `${L}: token_hash kept`);
  });
  // ── an ORPHAN: the write-ahead landed, the claim lost (the order was cancelled between them) ⇒ swept once the order is finished ──
  await cell('TN-ORPHAN-SWEPT', async (L) => {
    let n = 0; let w = null;
    // the REAL cancel commits right before the claim's CAS reads the record (the 2nd transaction on it, after the create)
    w = world({}, { hooks: { beforeTx: async (p) => { if (String(p) === `payment_sdk/${OID}` && ++n === 2) await C.cancelSdkOrder(w.deps, { orderId: OID }); } } });
    const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T-orphan', amount_cents: 100, card: card(false) });
    assert.ok(p.outcome !== 'placed' && !(w.rec() || {}).token_attempt && w.fake.callCount('authorize') === 0, `premise: the claim LOST after the write-ahead (${p.outcome}), nothing dispatched`);
    assert.deepStrictEqual(w.node(), { [ATT]: { t: 'T-orphan', uid: 'uid_A' } }, 'premise: the write-ahead token landed');
    await SW.visitDueOrder(w.deps, OID);
    await K.nullSpentToken(w.deps, OID);
    assert.strictEqual(w.node(), null, `${L}: a write-ahead token whose order is finished is swept (never outlives the order)`);
  });
  // ── Codex #158 r1 F2 (a): the cancel cleanup removes the due entry while the write-ahead is in flight, then the record create fails —
  //    an orphan token node with NO due entry; the sweeper's bounded walk of payment_sdk_tokens itself removes it (the order is finished) ──
  await cell('TN-ORPHAN-NO-DUE', async (L) => {
    let w = null; let armed = true;
    w = world({}, { hooks: { beforeTx: async (p) => { if (armed && String(p) === `payment_sdk/${OID}`) { armed = false; await C.cancelSdkOrder(w.deps, { orderId: OID }); await w.db.ref(`payment_sdk_due/${OID}`).set(null); throw Object.assign(new Error('record create failed'), { code: 'unavailable' }); } } } });
    await assert.rejects(() => C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T-nodue', amount_cents: 100, card: card(false) }));
    assert.ok(w.node() && w.db.getAt(`payment_sdk_due/${OID}`) == null && w.ord().payment_cancel, 'premise: an orphan token node, no due entry, a finished order');
    await SW.sweepSdkPayments(w.deps);
    assert.strictEqual(w.node(), null, `${L}: the sweeper's own walk of payment_sdk_tokens removes an orphan no due entry points at`);
  });
  await cell('TN-KEPT-WHILE-OPEN', async (L) => {
    const w = world(); await place(w, 'T-open', false);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(!w.ord().payment_terminal && w.rec().phase === 'open', `${L}: premise — a live (placed, not terminal) order`);
    assert.deepStrictEqual(w.node(), { [ATT]: { t: 'T-open', uid: 'uid_A' } }, `${L}: an open order keeps its token (a decrease re-authorizes with it)`);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: not terminal ⇒ kept`);
  });
  await cell('TN-KEPT-RECORD-NOT-CLOSED', async (L) => {
    const w = world(); await place(w, 'T-lock', false); await deliver(w);
    await C.settleTerminal(w.deps, { orderId: OID });
    await w.db.ref(`payment_sdk/${OID}/lock`).set({ op_id: 'op_x', at: T0 });   // a money operation in flight
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: a locked record ⇒ kept`);
    assert.deepStrictEqual(w.node(), { [ATT]: { t: 'T-lock', uid: 'uid_A' } }, `${L}: kept`);
  });
  await cell('TN-IDEMPOTENT', async (L) => {
    const w = world(); await place(w, 'T-idem', false); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    const v = w.rec().version;
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'none', `${L}: nothing left to null`);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().version, v, `${L}: a later visit writes nothing to the record (no version bump)`);
  });
  // ── owner 11-18 «keep our platform fast and seamless»: the write-ahead adds NO sequential round trip to the checkout claim. Every
  //    database op is delayed D; the REAL placeOriginal is timed with the real write-ahead and with it stubbed to a no-op ──
  await cell('TN-LATENCY', async (L) => {
    const RT = require('./record-token'); const real = RT.stashToken; const D = 15;
    const time = async (i) => { const w = world({}, { hooks: { beforeRead: () => sleep(D), beforeTx: () => sleep(D), beforeWrite: () => sleep(D) } }); const t = Date.now(); await place(w, `T-lat-${i}`, false, `att_tn_latency_${String(i).padStart(7, '0')}`); return Date.now() - t; };
    const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const withStash = []; const without = [];
    try {
      for (let i = 0; i < 5; i++) { RT.stashToken = real; withStash.push(await time(i)); RT.stashToken = async () => {}; without.push(await time(i + 10)); }
    } finally { RT.stashToken = real; }
    const delta = med(withStash) - med(without);
    console.log(`    latency: claim median ${med(withStash)} ms with the write-ahead vs ${med(without)} ms without (D = ${D} ms/op) — delta ${delta} ms`);
    assert.ok(typeof real === 'function', `${L}: premise — record-token.stashToken exists`);
    assert.ok(delta < D / 2, `${L}: the write-ahead runs CONCURRENTLY with the claim's existing round trips (delta ${delta} ms < ${D / 2} ms)`);
  });
  // the reader CENSUS (Codex #149) moved: payment_sdk's token has ONE owner (payments/sdk/record-token.js) and a TREE-WIDE guard,
  // payments/sdk/record-token.guard.test.js (owner 11-18 «airtight», Codex #150) — every token site, record escape and owner call pinned.
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\ntoken-null: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stderr.write(`token-null: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
