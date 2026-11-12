'use strict';
// The PSP adapter contract (BRIEF r5 §7): operation-specific evidence, bound to the journaled operation. Any adapter (the
// fake, a future PixelPay one) is wrapped by makeAdapter, which validates arguments and NORMALISES results: a throw, a
// timeout or a malformed answer is `unknown` (money ops) / `inconclusive` (status) — never a decline, never a success.
const AUTH = ['approved', 'definitive_decline', 'token_expired_confirmed', 'requires_action', 'unknown'];
const CAPTURE = ['captured', 'declined', 'unknown'];
const VOID = ['voided', 'refused', 'unknown'];
const STATUS = ['authorized', 'captured', 'voided', 'expired', 'declined', 'inconclusive'];
const isPosCents = (n) => Number.isInteger(n) && n > 0;
const isNonEmpty = (s) => typeof s === 'string' && s.length > 0;

function makeAdapter(impl) {
  const settleCall = async (fn, unknown) => { try { return await fn(); } catch (_) { return unknown; } };
  return {
    // D4 (PLAN-sdk-d4-r4 rows 10, 15): the identifier and the payer are optional (absent for every pre-D4 caller), validated
    // when present and FORWARDED — this wrapper rebuilds the impl call, so a field it does not name never reaches the provider
    async pspAuthorize({ token, amount_cents, op_id, ref, authentication_identifier, payer }) {
      if (!isNonEmpty(token) || !isPosCents(amount_cents) || !isNonEmpty(op_id)) throw new Error('psp-adapter: authorize needs token, amount_cents, op_id');
      if (authentication_identifier !== undefined && authentication_identifier !== null && !isNonEmpty(authentication_identifier)) throw new Error('psp-adapter: authentication_identifier must be a string or null');
      if (payer !== undefined && !(payer && isNonEmpty(payer.name) && (payer.email === null || isNonEmpty(payer.email)))) throw new Error('psp-adapter: payer needs a name and an email (string or null)');
      const r = await settleCall(() => impl.pspAuthorize({ token, amount_cents, op_id, ref, authentication_identifier, payer }), null);
      if (!r || !AUTH.includes(r.outcome)) return { outcome: 'unknown' };
      if (r.outcome === 'approved' && (!isNonEmpty(r.uuid) || r.amount_cents !== amount_cents)) return { outcome: 'unknown', uuid: isNonEmpty(r.uuid) ? r.uuid : undefined };
      return { outcome: r.outcome, uuid: isNonEmpty(r.uuid) ? r.uuid : undefined, amount_cents: r.amount_cents, code: r.code || null };
    },
    async pspCapture({ uuid, amount_cents, op_id }) {
      if (!isNonEmpty(uuid) || !isPosCents(amount_cents) || !isNonEmpty(op_id)) throw new Error('psp-adapter: capture needs uuid, amount_cents, op_id');
      const r = await settleCall(() => impl.pspCapture({ uuid, amount_cents, op_id }), null);
      if (!r || !CAPTURE.includes(r.outcome)) return { outcome: 'unknown' };
      if (r.outcome === 'captured' && (r.uuid !== uuid || r.amount_cents !== amount_cents)) return { outcome: 'unknown' };
      return { outcome: r.outcome, uuid, amount_cents: r.amount_cents, code: r.code || null };
    },
    async pspVoid({ uuid, op_id, ref }) {
      if (!isNonEmpty(uuid) || !isNonEmpty(op_id)) throw new Error('psp-adapter: void needs uuid, op_id');
      if (ref !== undefined && !isNonEmpty(ref)) throw new Error('psp-adapter: void ref must be a non-empty string');
      const r = await settleCall(() => impl.pspVoid({ uuid, op_id, ref }), null);
      if (!r || !VOID.includes(r.outcome)) return { outcome: 'unknown' };
      if (r.outcome === 'voided' && r.uuid !== uuid) return { outcome: 'unknown' };
      return { outcome: r.outcome, uuid, code: r.code || null };
    },
    async pspStatus({ uuid }) {
      if (!isNonEmpty(uuid)) throw new Error('psp-adapter: status needs uuid');
      const r = await settleCall(() => impl.pspStatus({ uuid }), null);
      if (!r || !STATUS.includes(r.state) || r.uuid !== uuid) return { state: 'inconclusive', uuid };
      return { state: r.state, uuid, amount_cents: r.amount_cents };
    },
  };
}

// Evidence is BOUND only if it names the journaled leg's uuid and amount; anything else is inconclusive (lock kept).
const boundStatus = (ev, leg) => !!(ev && leg && ev.state !== 'inconclusive' && ev.uuid === leg.pp_uuid && ev.amount_cents === leg.amount_cents);

module.exports = { makeAdapter, boundStatus, AUTH, CAPTURE, VOID, STATUS };
