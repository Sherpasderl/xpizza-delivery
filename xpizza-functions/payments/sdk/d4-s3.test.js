'use strict';
// D4 S3 (PLAN-sdk-d4-r4 S3, r3 #12) — saved cards: ONE authoritative node per member, customer_cards/{uid} = { cards, by_hash, tomb }.
// Admission (A3), vault completion, removal and expiry are each ONE transaction (or one read) of that node; a removal's generation is
// monotonic, so a stale completion can never resurrect a card, and a fresh save after a removal works. Listing is read by the
// customer app's REAL cards reader (exact keys). Run: node payments/sdk/d4-s3.test.js
const assert = require('assert');
const crypto = require('crypto');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const PC = require('../../../customer-app/capp-pay-card.js');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const K = () => require('./cards');
const T0 = 1_800_000_000_000;   // 2027-01-15
const H = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
const deps = (db, t = T0) => ({ db, clock: () => t, verifyIdToken: async (x) => (x === 'idt_A' ? { uid: 'uid_A' } : x === 'idt_B' ? { uid: 'uid_B' } : (() => { throw new Error('bad'); })()) });
const save = (d, uid, token, gen) => K().completeVault(d, { uid, token, token_hash: H(token), display: DISP, vault_gen: gen });

(async () => {
  await cell('SDK-D4-SAVED-CARD-UNAVAILABLE', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-a', 0);
    const idA = Object.keys(db.getAt('customer_cards/uid_A/cards'))[0];
    const own = await K().resolveSavedCard(d, 'uid_A', idA);
    assert.ok(own && own.token === 'T-a' && own.token_hash === H('T-a'), `${L}: the owner resolves their card`);
    const foreign = await K().resolveSavedCard(d, 'uid_B', idA);
    const absent = await K().resolveSavedCard(d, 'uid_B', 'nonexistent_card_000');
    assert.deepStrictEqual([foreign, absent], [null, null], `${L}: B's token with A's card_id, and a nonexistent id ⇒ the SAME null (one identical 409 at the handler)`);
    db.setAt(`customer_cards/uid_A/cards/${idA}/expired_at`, T0);
    assert.strictEqual(await K().resolveSavedCard(d, 'uid_A', idA), null, `${L}: an EXPIRED card of the owner is not usable ⇒ the same null`);
    assert.deepStrictEqual(K().SAVED_CARD_UNAVAILABLE, { status: 409, body: { error: 'saved_card_unavailable' } }, `${L}: the one refusal body`);
  });

  await cell('SDK-D4-DUP-SAVE', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-other', 0);   // an unrelated card the member already has
    await Promise.all([save(d, 'uid_A', 'T-dup', 0), save(d, 'uid_A', 'T-dup', 0)]);
    const cards = Object.values(db.getAt('customer_cards/uid_A/cards') || {});
    assert.strictEqual(cards.filter((c) => c.token === 'T-dup').length, 1, `${L}: two concurrent completions of the same token ⇒ ONE card`);
    assert.strictEqual(cards.filter((c) => c.token === 'T-other').length, 1, `${L}: and the member's other card survives (no lost update)`);
  });

  await cell('SDK-D4-DELETE-VS-COMPLETE', async (L) => {
    // r4 setup (Codex r3 #12): an EXISTING card X with hash h; a new save of the same token admitted (vault_gen 0); X removed
    // (tomb gen 1); then the completion ⇒ DROPPED
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-x', 0);
    const X = Object.keys(db.getAt('customer_cards/uid_A/cards'))[0];
    const admittedGen = await K().vaultGenOf(d, 'uid_A', H('T-x'));
    assert.strictEqual(admittedGen, 0, `${L}: premise — admitted at gen 0`);
    assert.deepStrictEqual(await K().removeCard(d, 'uid_A', X), { removed: true }, `${L}: removed`);
    const r = await save(d, 'uid_A', 'T-x', admittedGen);
    assert.strictEqual(r.outcome, 'dropped', `${L}: the completion admitted before the removal is DROPPED — dropped: no card for h (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual(Object.keys(db.getAt('customer_cards/uid_A/cards') || {}), [], `${L}: no card for h`);
    // the reverse order: completion commits (reuses X), then the removal ⇒ no card
    const db2 = makeHonestDb({}); const d2 = deps(db2);
    await save(d2, 'uid_A', 'T-y', 0);
    const Y = Object.keys(db2.getAt('customer_cards/uid_A/cards'))[0];
    await save(d2, 'uid_A', 'T-y', 0);
    await K().removeCard(d2, 'uid_A', Y);
    assert.deepStrictEqual(Object.keys(db2.getAt('customer_cards/uid_A/cards') || {}), [], `${L}: complete-then-remove ⇒ no card`);
  });

  await cell('SDK-D4-COMPLETE-VS-REMOVE-CONCURRENT', async (L) => {
    // a completion of ANOTHER card racing a removal: the completion must never write back a stale node (that would resurrect X)
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-x', 0);
    const X = Object.keys(db.getAt('customer_cards/uid_A/cards'))[0];
    await Promise.all([save(d, 'uid_A', 'T-new', 0), K().removeCard(d, 'uid_A', X)]);
    const cards = db.getAt('customer_cards/uid_A/cards') || {};
    assert.ok(!cards[X] && db.getAt(`customer_cards/uid_A/tomb/${H('T-x')}/gen`) === 1, `${L}: the removed card stays removed — never resurrected by a concurrent completion (cards ${JSON.stringify(Object.values(cards).map((c) => c.last4 + ':' + c.token))})`);
    assert.ok(Object.values(cards).some((c) => c.token === 'T-new'), `${L}: the concurrent new card is saved`);
  });
  await cell('SDK-D4-GEN-MONOTONIC', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-m', 0);
    await K().removeCard(d, 'uid_A', Object.keys(db.getAt('customer_cards/uid_A/cards'))[0]);   // gen 1
    const genA = await K().vaultGenOf(d, 'uid_A', H('T-m'));                                       // A admitted at gen 1
    const b = await save(d, 'uid_A', 'T-m', await K().vaultGenOf(d, 'uid_A', H('T-m')));            // B saves fresh
    assert.strictEqual(b.outcome, 'created', `${L}: premise — the fresh save B creates the card`);
    await K().removeCard(d, 'uid_A', Object.keys(db.getAt('customer_cards/uid_A/cards'))[0]);   // gen 2
    const a = await save(d, 'uid_A', 'T-m', genA);
    assert.ok(a.outcome === 'dropped' && Object.keys(db.getAt('customer_cards/uid_A/cards') || {}).length === 0, `${L}: A's completion dropped — the generation never resets (got ${JSON.stringify(a)})`);
  });

  await cell('SDK-D4-FRESH-SAVE-AFTER-REMOVE', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-f', 0);
    const first = Object.keys(db.getAt('customer_cards/uid_A/cards'))[0];
    await K().removeCard(d, 'uid_A', first);
    const r = await save(d, 'uid_A', 'T-f', await K().vaultGenOf(d, 'uid_A', H('T-f')));
    const ids = Object.keys(db.getAt('customer_cards/uid_A/cards') || {});
    assert.ok(r.outcome === 'created' && ids.length === 1 && ids[0] !== first, `${L}: a NEW save after a removal creates the card again, with a new card_id (got ${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-REMOVE-TWICE', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-r', 0);
    const id = Object.keys(db.getAt('customer_cards/uid_A/cards'))[0];
    assert.deepStrictEqual(await K().removeCard(d, 'uid_A', id), { removed: true }, `${L}: first removal`);
    assert.deepStrictEqual(await K().removeCard(d, 'uid_A', id), { removed: true }, `${L}: a repeat is idempotent`);
    assert.strictEqual(db.getAt(`customer_cards/uid_A/tomb/${H('T-r')}/gen`), 1, `${L}: a repeat never bumps the generation twice`);
  });

  await cell('SDK-D4-REMOVE-FOREIGN', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-z', 0);
    const id = Object.keys(db.getAt('customer_cards/uid_A/cards'))[0];
    const before = JSON.stringify(db.getAt('customer_cards'));
    const r = await K().removeCardCore(d, { headers: { authorization: 'Bearer idt_B' }, body: { card_id: id } });
    assert.ok(r.status === 404 && JSON.stringify(db.getAt('customer_cards')) === before, `${L}: another member's card ⇒ 404, the node untouched (got ${JSON.stringify(r)})`);
    const ok = await K().removeCardCore(d, { headers: { authorization: 'Bearer idt_A' }, body: { card_id: id } });
    assert.deepStrictEqual(ok, { status: 200, body: { removed: true } }, `${L}: the owner removes it`);
    assert.strictEqual((await K().removeCardCore(d, { headers: {}, body: { card_id: id } })).status, 401, `${L}: no member ⇒ 401 (guests have no saved cards)`);
  });

  await cell('SDK-D4-LIST-SHAPE', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-old', 0);
    db.setAt(`customer_cards/uid_A/cards/${Object.keys(db.getAt('customer_cards/uid_A/cards'))[0]}/last_used_at`, T0 - 1000);
    await K().completeVault(d, { uid: 'uid_A', token: 'T-exp', token_hash: H('T-exp'), display: { brand: 'mastercard', last4: '5454', exp_month: 1, exp_year: 2026 }, vault_gen: 0 });
    const r = await K().listCardsCore(d, { headers: { authorization: 'Bearer idt_A' } });
    assert.strictEqual(r.status, 200, `${L}: 200`);
    const vm = PC.cardsVm(r.body);
    assert.ok(Array.isArray(r.body.cards) && r.body.cards.length === 2, `${L}: two cards (${JSON.stringify(r.body)})`);
    for (const c of r.body.cards) assert.deepStrictEqual(Object.keys(c).sort(), ['brand', 'card_id', 'exp_month', 'exp_year', 'expired', 'last4'], `${L}: the exact 6 keys`);
    assert.ok(!JSON.stringify(r.body).includes('T-old') && !JSON.stringify(r.body).includes(H('T-old')), `${L}: no token, no hash in the body`);
    assert.strictEqual(r.body.cards[0].last4, '5454', `${L}: newest last_used_at first`);
    assert.strictEqual(r.body.cards[0].expired, true, `${L}: a card past its expiry month is expired`);
    assert.ok(vm.rows.length === 2 && vm.selected === r.body.cards[1].card_id, `${L}: the client's real reader keeps BOTH rows (it drops malformed ones) and selects the first non-expired (got ${JSON.stringify(vm)})`);
    assert.strictEqual((await K().listCardsCore(d, { headers: {} })).status, 401, `${L}: no member ⇒ 401`);
  });

  await cell('SDK-D4-TOKEN-EXPIRED-MARKS', async (L) => {
    const db = makeHonestDb({});
    const d = deps(db);
    await save(d, 'uid_A', 'T-e', 0);
    await K().markExpired(d, 'uid_A', H('T-e'));
    const r = await K().listCardsCore(d, { headers: { authorization: 'Bearer idt_A' } });
    assert.strictEqual(r.body.cards[0].expired, true, `${L}: token_expired ⇒ the card lists as expired`);
  });


  // ── the vault write from the WINNING attempt only; the sweeper completes it after a crash (row 12) ──
  const { makeAdapter } = require('./psp-adapter');
  const { makeFakePsp } = require('./fake-adapter');
  const C = require('./coordinator');
  const OID = 'tb_vault_1';
  const vworld = (script = {}) => {
    const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tb_rest', customer_uid: 'uid_A', customer_name: 'Ana Pérez', pay_deadline_at: T0 + 900000 } } });
    const fake = makeFakePsp(script);
    return { db, fake, deps: { db, psp: makeAdapter(fake.impl), clock: () => T0, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, verifyIdToken: async () => ({ uid: 'uid_A' }) } };
  };
  const card = (save) => ({ card_ref: 'new', display: DISP, save, vault_gen: 0 });
  await cell('SDK-D4-VAULT-WINNER-ONLY', async (L) => {
    const w = vworld({ authorize: [{ outcome: 'definitive_decline', code: 'X' }] });
    await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_vault_first_00001', token: 'T-loser', amount_cents: 100, card: card(true) });
    const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_vault_second_0002', token: 'T-winner', amount_cents: 100, card: card(false) });
    assert.strictEqual(p.outcome, 'placed', `${L}: premise — the second attempt placed`);
    await K().completeVaultForOrder(w.deps, OID);
    assert.strictEqual(w.db.getAt('customer_cards/uid_A'), null, `${L}: the LOSING attempt's save:true never vaults (the winner did not ask to save)`);
    const w2 = vworld({ authorize: [{ outcome: 'definitive_decline', code: 'X' }] });
    await C.placeOriginal(w2.deps, { orderId: OID, attempt_id: 'att_vault_first_00001', token: 'T-loser', amount_cents: 100, card: card(false) });
    await C.placeOriginal(w2.deps, { orderId: OID, attempt_id: 'att_vault_second_0002', token: 'T-winner', amount_cents: 100, card: card(true) });
    await K().completeVaultForOrder(w2.deps, OID);
    const cards = Object.values(w2.db.getAt('customer_cards/uid_A/cards') || {});
    assert.ok(cards.length === 1 && cards[0].token === 'T-winner', `${L}: only the WINNER's card is vaulted`);
  });
  await cell('SDK-D4-VAULT-CRASH', async (L) => {
    const w = vworld();
    await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_vault_crash_00001', token: 'T-c', amount_cents: 100, card: card(true) });
    // the placement's own completion crashed after writing the card, before recording it: the sweeper finishes ONCE
    await K().completeVault(w.deps, { uid: 'uid_A', token: 'T-c', token_hash: H('T-c'), display: DISP, vault_gen: 0 });
    await require('./sweeper').visitDueOrder(w.deps, OID);
    await require('./sweeper').visitDueOrder(w.deps, OID);
    assert.strictEqual(Object.keys(w.db.getAt('customer_cards/uid_A/cards') || {}).length, 1, `${L}: the sweeper completes it once — no duplicate card`);
    assert.strictEqual(w.db.getAt(`payment_sdk/${OID}/vault/state`), 'done', `${L}: the record notes the vault done`);
  });
  await cell('SDK-D4-REMOVE-AFTER-ADMIT', async (L) => {
    const w = vworld();
    await K().completeVault(w.deps, { uid: 'uid_A', token: 'T-saved', token_hash: H('T-saved'), display: DISP, vault_gen: 0 });
    const id = Object.keys(w.db.getAt('customer_cards/uid_A/cards'))[0];
    const resolved = await K().resolveSavedCard(w.deps, 'uid_A', id);   // admission
    await K().removeCard(w.deps, 'uid_A', id);                          // removed AFTER admission
    const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_vault_saved_00001', token: resolved.token, amount_cents: 100, card: { card_ref: `saved:${id}`, display: resolved.display, save: false, vault_gen: 0 } });
    assert.ok(p.outcome === 'placed' && w.fake.calls.find((c) => c.action === 'authorize').token === 'T-saved', `${L}: the admitted attempt charges its BOUND token`);
    await K().completeVaultForOrder(w.deps, OID);
    assert.deepStrictEqual(Object.keys(w.db.getAt('customer_cards/uid_A/cards') || {}), [], `${L}: the card stays removed (a saved-card attempt never re-vaults)`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-s3: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
