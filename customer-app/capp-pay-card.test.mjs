// S2-checkout — card payment inside the app: the LOGIC (CONTRACT-sdk-checkout r3, APPROVED AS CONTRACT 11-08; mockup v2 approved,
// v3 pending ⇒ markup later). Responses come from the strict test fake (exact keys per outcome, §2.4). Frame 3's fields sit behind an
// abstract interface (advisor Q9, PCI blocker): the form logic reads per-field STATES, never card values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { placeResp, listCards, cancelPending, OUTCOMES, BUCKETS } from './test/fake-sdk-checkout.mjs';
const require = createRequire(import.meta.url);
const P = require('./capp-pay-card.js');

const MEMBER = { guest: false, cashAllowed: true }, GUEST = { guest: true, cashAllowed: true }, NOCASH = { guest: false, cashAllowed: false };
const CARD = { brand: 'visa', last4: '4242' };
const placed = (o = {}) => placeResp('placed', { order_id: 'o1', tracking_token: 'tok_abcdefgh12', card: CARD, ...o });
const declined = (decline) => placeResp('declined', { order_id: 'o1', attempt_id: 'att_0123456789abcdef', decline, pay_deadline_at: 1 });

test('the fake is no laxer than the contract: an outcome outside the enum, a missing / extra / mistyped key, adjust_grant on a replay — refused', () => {
  assert.throws(() => placeResp('approved', {}), /closed enum/);
  assert.throws(() => placeResp('declined', { order_id: 'o1', attempt_id: 'a', pay_deadline_at: 1 }), /decline/);
  assert.throws(() => placeResp('placed', { order_id: 'o1', tracking_token: 't', card: CARD, token: 'T-1' }), /key the contract does not/);
  assert.throws(() => placeResp('declined', { order_id: 'o1', attempt_id: 'a', decline: 'insufficient', pay_deadline_at: 1 }), /decline/);
  assert.throws(() => placeResp('placed', { order_id: 'o1', tracking_token: 't', card: CARD, adjust_grant: 'g' }, { replay: true }), /adjust_grant/);
  assert.deepEqual([OUTCOMES.length, BUCKETS.length], [8, 4]);
});

test('read: every contract response is read as-is; anything else is NOT a known outcome ⇒ `invalid` (fail closed: the app asks placeSdkStatus)', () => {
  assert.equal(P.readPlacement(placed()).outcome, 'placed');
  assert.equal(P.readPlacement(declined('hard')).decline, 'hard');
  for (const bad of [null, {}, { outcome: 'approved' }, { outcome: 'declined', order_id: 'o1' }, { ...declined('hard'), decline: 'insufficient' }, { ...placed(), token: 'T-1' }, { ...placed(), card: { ...CARD, token: 'T-1' } }, 'placed']) {
    assert.equal((P.readPlacement(bad) || {}).outcome, 'invalid', `🔴 SC-read: ${JSON.stringify(bad)} is not a contract response`);
  }
});

test('next step: each outcome → its frame (§2.4 table); payment state decides, never a guess', () => {
  const step = (r, ctx = MEMBER) => P.nextStep(P.readPlacement(r), ctx) || {};
  assert.deepEqual([step(placed()).frame], ['placed'], '🔴 SC-step: placed ⇒ frame 8');
  const ar = step(placeResp('action_required', { order_id: 'o1', attempt_id: 'a', challenge: { continuation_id: 'c1', sdk_payload: 'x', expires_at: 9 } }));
  assert.deepEqual([ar.frame, ar.well], ['verify', true], '🔴 SC-step: action_required ⇒ 4 with the SDK well');
  const bp = step(placeResp('bank_pending', { order_id: 'o1', attempt_id: 'a' }));
  assert.deepEqual([bp.frame, bp.well, bp.poll], ['verify', false, true], '🔴 SC-step: bank_pending ⇒ 4 without the well, polling placeSdkStatus');
  const ur = step(placeResp('under_review', { order_id: 'o1' }));
  assert.deepEqual([ur.frame, ur.acts], ['review', []], '🔴 SC-step: under_review ⇒ the owner\'s calm notice, no action');
  assert.deepEqual(step(placeResp('expired', { order_id: 'o1', safe_to_switch: true })), { frame: 'checkout', poll: false, acts: [] }, '🔴 SC-step: expired + safe ⇒ back to checkout');
  assert.equal(step(placeResp('expired', { order_id: 'o1', safe_to_switch: false })).poll, true, '🔴 SC-step: expired, not yet safe ⇒ keep polling (never cash)');
  assert.equal(step(placeResp('not_allowed', { reason: 'scheduled' })).frame, 'checkout', 'not_allowed ⇒ checkout');
  const inv = step({ outcome: 'approved' });
  assert.deepEqual([inv.frame, inv.poll], ['verify', true], '🔴 SC-step: an unreadable response ⇒ verify + ask the status (never «placed», never a decline)');
});

test('declines (§7 buckets, owner ruling 3): retryable / hard ⇒ the decline sheet + «Probar otra tarjeta» (+ cash for a member where allowed); wrong_data ⇒ «Corregir datos»; token_expired ⇒ frame 6; a guest never sees cash', () => {
  const s = (b, ctx) => P.nextStep(P.readPlacement(declined(b)), ctx);
  assert.deepEqual([s('retryable', MEMBER).frame, s('retryable', MEMBER).acts], ['declined', ['other_card', 'cash']], '🔴 SC-decline: retryable, member ⇒ other card + cash');
  assert.deepEqual(s('hard', MEMBER).acts, ['other_card', 'cash'], '🔴 SC-decline: hard, member');
  assert.deepEqual(s('hard', GUEST).acts, ['other_card'], '🔴 SC-decline: a guest is card-only (owner ruling 3)');
  assert.deepEqual(s('hard', NOCASH).acts, ['other_card'], '🔴 SC-decline: no cash where the restaurant has none');
  assert.deepEqual([s('wrong_data', MEMBER).frame, s('wrong_data', MEMBER).acts[0]], ['wrong_data', 'fix'], '🔴 SC-decline: wrong data ⇒ «Corregir datos» first');
  assert.deepEqual([s('token_expired', MEMBER).frame, s('token_expired', MEMBER).acts], ['token_expired', ['add_card', 'cash']], '🔴 SC-decline: an expired token ⇒ frame 6 (add a card / cash)');
  assert.deepEqual(P.COPY.declined[s('retryable', MEMBER).bucket] && P.COPY.declined.retryable.body, 'Parece que la tarjeta no tiene fondos suficientes. Podés probar otra tarjeta o pagar en efectivo; tu pedido sigue igual.', 'the v2 copy (v3 may change it)');
  assert.ok(!/efectivo/.test(P.declineBody('hard', GUEST)), '🔴 SC-decline: a guest\'s body never offers cash');
});

test('unavailable (§9, frame 7): a member gets cash where allowed; a guest gets «Reintentar» after retry_after_s', () => {
  const r = placeResp('unavailable', { retry_after_s: 120 });
  assert.deepEqual(P.nextStep(P.readPlacement(r), MEMBER), { frame: 'unavailable', acts: ['cash'], retry_after_s: 120, poll: false }, '🔴 SC-unavail: member ⇒ cash');
  assert.deepEqual(P.nextStep(P.readPlacement(r), GUEST).acts, ['retry'], '🔴 SC-unavail: guest ⇒ «Reintentar» (card-only)');
});

test('saved cards (§6): newest first as served; the first NON-expired is selected (no default card); labels from brand + last4 + expiry', () => {
  const vm = P.cardsVm(listCards([{ card_id: 'c_new', brand: 'mastercard', last4: '8810', exp_month: 10, exp_year: 2026, expired: true }, { card_id: 'c_old', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028, expired: false }]));
  assert.deepEqual(vm.rows.map((r) => [r.card_id, r.label, r.sub, r.expired]), [['c_new', 'Mastercard ···· 8810', 'Venció en 10/26', true], ['c_old', 'Visa ···· 4242', 'Vence 12/28', false]], '🔴 SC-cards: rows in served order');
  assert.equal(vm.selected, 'c_old', '🔴 SC-cards: the first non-expired');
  assert.equal(P.cardsVm(listCards([{ card_id: 'c1', brand: 'other', last4: '0005', exp_month: 1, exp_year: 2020, expired: true }])).selected, null, 'all expired ⇒ none selected (frame 6)');
  assert.equal(P.cardsVm({ cards: [{ card_id: 'c', token: 'T-1' }] }).rows.length, 0, '🔴 SC-cards: a row outside the contract (a token!) is never drawn');
});

test('the placement body (§2.1): exact keys; a saved card by card_id (members only); a new card with its SDK token, save, display; the client never sends an amount', () => {
  const base = { order_id: 'o1', restaurant_id: 'r', items: [], items_text: '', quote_token: 'q', expected_net_cents: 58500 };
  const att = 'att_0123456789abcdef';
  assert.deepEqual(P.placeBody(base, { kind: 'saved', card_id: 'c_old' }, att, MEMBER), { ...base, attempt_id: att, replaces_order_id: null, card: { kind: 'saved', card_id: 'c_old' } }, '🔴 SC-body: saved');
  assert.equal(P.placeBody(base, { kind: 'saved', card_id: 'c_old' }, att, GUEST), null, '🔴 SC-body: a guest never pays with a saved card');
  const nw = { kind: 'new', sdk_token: 'sdk-T', save: true, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } };
  assert.deepEqual(P.placeBody(base, nw, att, MEMBER).card, nw, 'new');
  assert.equal(P.placeBody(base, nw, att, GUEST).card.save, false, '🔴 SC-body: a guest has no account to save to');
  assert.equal(P.placeBody(base, { ...nw, extra: 1 }, att, MEMBER), null, 'unknown card keys ⇒ no body');
  assert.equal(P.placeBody(base, nw, 'short', MEMBER), null, '🔴 SC-body: attempt_id 16–64 [A-Za-z0-9_-]');
  assert.ok(!('amount_cents' in (P.placeBody({ ...base, amount_cents: 1 }, nw, att, MEMBER) || { amount_cents: 1 })), '🔴 SC-body: never an amount (the server prices it)');
  assert.match(P.newAttemptId((n) => new Uint8Array(n).fill(7)), /^[A-Za-z0-9_-]{16,64}$/, 'a fresh attempt id');
});

test('switching to cash (§5): only once the pending order is safe_to_switch; otherwise keep polling the status', () => {
  assert.equal(P.switchStep(cancelPending(true, true)), 'cash', '🔴 SC-switch: safe ⇒ cash (a NEW order_id + replaces_order_id)');
  assert.equal(P.switchStep(cancelPending(true, false)), 'poll', '🔴 SC-switch: not yet safe ⇒ poll, never cash');
  assert.equal(P.switchStep({ cancelled: true }), 'poll', 'malformed ⇒ poll');
});

test('frame 3 form over an ABSTRACT field interface (advisor Q9): per-field states → one primary naming the first fix; errors only once touched; the save switch for members only, ON by default (owner ruling 2)', () => {
  const ok = { state: 'valid' };
  const st = (o) => ({ number: ok, expiry: ok, cvv: ok, name: ok, ...o });
  assert.deepEqual(P.formVm(st({}), { member: true }).primary, { label: 'Usar esta tarjeta', enabled: true }, '🔴 SC-form: all valid ⇒ «Usar esta tarjeta»');
  const ex = P.formVm(st({ expiry: { state: 'invalid', touched: true } }), { member: true });
  assert.deepEqual(ex.primary, { label: 'Revisá el vencimiento', enabled: false }, '🔴 SC-form: the primary names the missing step (v2 frame 3)');
  assert.equal(ex.errors.expiry, 'Revisá la fecha de vencimiento', 'the drawn inline error');
  assert.equal(P.formVm(st({ expiry: { state: 'past', touched: true } }), { member: true }).errors.expiry, 'Esta tarjeta ya venció');
  assert.equal(P.formVm(st({ expiry: { state: 'invalid', touched: false } }), { member: true }).errors.expiry, null, '🔴 SC-form: no error before the field is left');
  assert.deepEqual([P.formVm(st({}), { member: true }).save, P.formVm(st({}), { member: false }).save], [{ shown: true, on: true }, { shown: false, on: false }], '🔴 SC-form: save ON for members, absent for guests');
  assert.equal(P.formVm(st({ number: { state: 'empty' } }), { member: true }).primary.enabled, false, 'an empty field blocks');
  assert.ok(!JSON.stringify(P.formVm(st({ number: { state: 'valid', brand: 'visa', value: '4242424242424242' } }), { member: true })).includes('4242424242424242'), '🔴 SC-form: no card value ever enters the view model');
});

test('DOM-field validators (used ONLY if the DOM implementation is chosen): Luhn, brand, expiry vs now, CVV length by brand, name', () => {
  const V = P.domValidators;
  assert.deepEqual(['4242424242424242', '4242424242424241', '378282246310005', ''].map((n) => V.number(n).state), ['valid', 'invalid', 'valid', 'empty'], '🔴 SC-dom: Luhn');
  assert.deepEqual(['4242424242424242', '5555555555554444', '378282246310005', '6011111111111117'].map((n) => V.number(n).brand), ['visa', 'mastercard', 'amex', 'other'], 'brand');
  const now = Date.UTC(2026, 10, 8);
  assert.deepEqual(['12/28', '11/26', '10/26', '13/28', '1228', ''].map((e) => V.expiry(e, now).state), ['valid', 'valid', 'past', 'invalid', 'invalid', 'empty'], '🔴 SC-dom: expiry vs now (this month still valid)');
  assert.deepEqual([V.cvv('123', 'visa').state, V.cvv('1234', 'amex').state, V.cvv('12', 'visa').state, V.cvv('123', 'amex').state], ['valid', 'valid', 'invalid', 'invalid'], 'CVV by brand');
  assert.deepEqual([V.name('Ana Mejía').state, V.name('  ').state], ['valid', 'empty'], 'name');
});
