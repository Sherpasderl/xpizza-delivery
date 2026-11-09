// Customer app — S2-checkout: card payment INSIDE the installed app (PLAN-capp-native-shell-and-payments r3.8 §2 steps 1–6,
// §2.7–§2.9; CONTRACT-sdk-checkout r3, APPROVED AS CONTRACT 11-08; MOCKUP-capp-S2-sdk-checkout v2, owner-approved — v3 pending, so
// this file is the LOGIC: the markup lands once v3 is approved). Pure: no DOM, no I/O, no clock of its own. Dark unless runtime.sdkPay
// AND runtime.mode === 'native' (advisor Q7: the website keeps the hosted page).
//   · readPlacement — a placeSdkOrder / placeSdkStatus body read against the contract's exact keys per outcome (§2.4); anything else
//     is `invalid` (fail closed: the app asks the status, never guesses «placed» or a decline)
//   · nextStep — outcome → the frame and its actions (owner ruling 3: a guest is card-only, never cash)
//   · cardsVm / placeBody / newAttemptId / switchStep — §6 saved cards, the §2.1 body (the client never sends an amount), §5's switch
//   · formVm — frame 3 over an ABSTRACT field interface (advisor Q9, PCI unsettled): it reads per-field STATES (`empty | invalid |
//     past | valid`, + touched, + brand), never card values; domValidators serve only a DOM implementation, if that is the one chosen
// Copy: mockup v2's strings (COPY), kept in one place for v3. No hold words (owner 11-07); no wallet; no hosted fallback.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappPayCard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUTCOMES = Object.freeze(['placed', 'declined', 'action_required', 'bank_pending', 'under_review', 'expired', 'unavailable', 'not_allowed']);
  const BUCKETS = Object.freeze(['retryable', 'hard', 'wrong_data', 'token_expired']);
  const BRANDS = Object.freeze({ visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', other: '' });
  const str = (s) => typeof s === 'string' && s !== '', int = Number.isInteger, bool = (b) => typeof b === 'boolean';
  const obj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const cardOk = (c) => obj(c) && Object.keys(c).length === 2 && has(BRANDS, c.brand) && typeof c.last4 === 'string' && /^\d{4}$/.test(c.last4);
  // §2.4 — the exact keys per outcome
  const RESP = {
    placed: { order_id: str, tracking_token: str, card: cardOk },
    declined: { order_id: str, attempt_id: str, decline: (x) => BUCKETS.includes(x), pay_deadline_at: int },
    action_required: { order_id: str, attempt_id: str, challenge: (c) => obj(c) && str(c.continuation_id) && int(c.expires_at) && has(c, 'sdk_payload') && Object.keys(c).length === 3 },
    bank_pending: { order_id: str, attempt_id: str },
    under_review: { order_id: str },
    expired: { order_id: str, safe_to_switch: bool },
    unavailable: { retry_after_s: int },
    not_allowed: { reason: (x) => x === 'scheduled' },
  };
  const OPTIONAL = { placed: { adjust_grant: str } };   // guests, only in the response of the request that placed the order

  function readPlacement(r) {
    if (!obj(r) || !OUTCOMES.includes(r.outcome)) return { outcome: 'invalid' };
    const spec = RESP[r.outcome], opt = OPTIONAL[r.outcome] || {};
    for (const k of Object.keys(r)) if (k !== 'outcome' && !has(spec, k) && !has(opt, k)) return { outcome: 'invalid' };
    for (const [k, ok] of Object.entries(spec)) if (!has(r, k) || !ok(r[k])) return { outcome: 'invalid' };
    for (const [k, ok] of Object.entries(opt)) if (has(r, k) && !ok(r[k])) return { outcome: 'invalid' };
    return { ...r };
  }

  // outcome → { frame, acts, … } — ctx: { guest, cashAllowed }
  function nextStep(r, ctx) {
    const c = obj(ctx) ? ctx : {}, cash = c.guest !== true && c.cashAllowed === true;
    const withCash = (acts) => (cash ? [...acts, 'cash'] : acts);
    switch (r && r.outcome) {
      case 'placed': return { frame: 'placed', acts: [], poll: false };
      case 'declined':
        if (r.decline === 'token_expired') return { frame: 'token_expired', bucket: r.decline, acts: withCash(['add_card']), poll: false };
        if (r.decline === 'wrong_data') return { frame: 'wrong_data', bucket: r.decline, acts: withCash(['fix', 'other_card']), poll: false };
        return { frame: 'declined', bucket: r.decline, acts: withCash(['other_card']), poll: false };
      case 'action_required': return { frame: 'verify', well: true, acts: [], poll: false };
      case 'bank_pending': return { frame: 'verify', well: false, acts: [], poll: true };
      case 'under_review': return { frame: 'review', acts: [], poll: false };
      case 'expired': return { frame: 'checkout', poll: r.safe_to_switch !== true, acts: [] };
      case 'unavailable': return { frame: 'unavailable', acts: c.guest === true ? ['retry'] : withCash([]), retry_after_s: r.retry_after_s, poll: false };
      case 'not_allowed': return { frame: 'checkout', reason: r.reason, acts: [], poll: false };
      default: return { frame: 'verify', well: false, acts: [], poll: true };   // unreadable ⇒ ask placeSdkStatus; never placed, never declined
    }
  }

  // mockup v2's copy (v3 may change it). A guest's body never offers cash (owner ruling 3)
  const COPY = Object.freeze({
    declined: Object.freeze({
      retryable: { title: 'Tu banco no autorizó el pago', body: 'Parece que la tarjeta no tiene fondos suficientes. Podés probar otra tarjeta o pagar en efectivo; tu pedido sigue igual.', guest: 'Parece que la tarjeta no tiene fondos suficientes. Podés probar otra tarjeta; tu pedido sigue igual.' },
      hard: { title: 'Tu banco no autorizó el pago', body: 'Tu banco rechazó esta tarjeta. Probá con otra o pagá en efectivo; tu pedido sigue igual.', guest: 'Tu banco rechazó esta tarjeta. Probá con otra; tu pedido sigue igual.' },
      wrong_data: { title: 'Revisá los datos de la tarjeta', body: 'Algún dato no coincide con tu banco. Corregilo o probá otra tarjeta; tu pedido sigue igual.', guest: 'Algún dato no coincide con tu banco. Corregilo o probá otra tarjeta; tu pedido sigue igual.' },
      token_expired: { title: 'Tu tarjeta guardada venció', body: 'Agregá una tarjeta para pagar en línea, o pagá en efectivo al recibir tu pedido.', guest: 'Agregá una tarjeta para pagar en línea.' },
    }),
    acts: Object.freeze({ other_card: 'Probar otra tarjeta', cash: 'Pagar en efectivo', fix: 'Corregir datos', add_card: 'Agregar tarjeta', retry: 'Reintentar' }),
    review: 'Estamos confirmando tu pago con el banco. Te avisamos en cuanto esté listo.',   // owner ruling 4 (final)
  });
  const declineBody = (bucket, ctx) => { const d = has(COPY.declined, bucket) ? COPY.declined[bucket] : COPY.declined.hard; return obj(ctx) && (ctx.guest === true || ctx.cashAllowed !== true) ? d.guest : d.body; };

  // §6 listCards → rows (served order: newest first) + the first non-expired selected (no default card)
  const CARD_ROW = { card_id: str, brand: (x) => has(BRANDS, x), last4: (x) => typeof x === 'string' && /^\d{4}$/.test(x), exp_month: (x) => int(x) && x >= 1 && x <= 12, exp_year: (x) => int(x) && x >= 1000 && x <= 9999, expired: bool };
  const rowOk = (c) => obj(c) && Object.keys(c).length === 6 && Object.entries(CARD_ROW).every(([k, ok]) => has(c, k) && ok(c[k]));
  const mmyy = (m, y) => `${String(m).padStart(2, '0')}/${String(y % 100).padStart(2, '0')}`;
  const cardLabel = (brand, last4) => `${BRANDS[brand] ? BRANDS[brand] + ' ' : ''}···· ${last4}`;
  function cardsVm(list) {
    const rows = (obj(list) && Array.isArray(list.cards) ? list.cards : []).filter(rowOk)
      .map((c) => ({ card_id: c.card_id, label: cardLabel(c.brand, c.last4), sub: c.expired ? `Venció en ${mmyy(c.exp_month, c.exp_year)}` : `Vence ${mmyy(c.exp_month, c.exp_year)}`, expired: c.expired }));
    const first = rows.find((r) => !r.expired);
    return { rows, selected: first ? first.card_id : null };
  }

  // §2.1 — the priced order body + the attempt + the card; the server prices it (never an amount from here)
  const ATTEMPT_RE = /^[A-Za-z0-9_-]{16,64}$/;
  const displayOk = (d) => obj(d) && Object.keys(d).length === 4 && has(BRANDS, d.brand) && typeof d.last4 === 'string' && /^\d{4}$/.test(d.last4) && int(d.exp_month) && d.exp_month >= 1 && d.exp_month <= 12 && int(d.exp_year) && d.exp_year >= 1000 && d.exp_year <= 9999;
  function placeBody(base, card, attemptId, ctx, replacesOrderId = null) {
    if (!obj(base) || !str(base.order_id) || typeof attemptId !== 'string' || !ATTEMPT_RE.test(attemptId) || !obj(card)) return null;
    const guest = obj(ctx) && ctx.guest === true;
    let c = null;
    if (card.kind === 'saved' && !guest && Object.keys(card).length === 2 && str(card.card_id)) c = { kind: 'saved', card_id: card.card_id };
    else if (card.kind === 'new' && Object.keys(card).length === 5 && str(card.sdk_token) && bool(card.save) && (card.authentication_identifier === null || str(card.authentication_identifier)) && displayOk(card.display)) {
      c = { kind: 'new', sdk_token: card.sdk_token, save: guest ? false : card.save, authentication_identifier: card.authentication_identifier, display: { ...card.display } };
    }
    if (!c) return null;
    const { amount_cents: _a, ...priced } = base;   // never an amount
    return { ...priced, attempt_id: attemptId, replaces_order_id: typeof replacesOrderId === 'string' && replacesOrderId ? replacesOrderId : null, card: c };
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const newAttemptId = (randomBytes) => { const b = randomBytes(24); let s = 'att_'; for (let i = 0; i < b.length; i++) s += B64[b[i] & 63]; return s; };

  // §5 — cash only once the pending order is safe_to_switch; otherwise keep polling
  const switchStep = (r) => (obj(r) && r.cancelled === true && r.safe_to_switch === true ? 'cash' : 'poll');

  // frame 3 over the abstract field interface — states only (`value` is never read)
  const FIELDS = ['number', 'expiry', 'cvv', 'name'];
  const ERR = { number: 'Revisá el número de tarjeta', expiry: 'Revisá la fecha de vencimiento', past: 'Esta tarjeta ya venció', cvv: 'El CVV tiene 3 dígitos', cvv4: 'El CVV tiene 4 dígitos', name: 'Escribí el nombre como aparece en la tarjeta' };
  // the primary names the first fix (v6's missing-step rule; v2 draws «Revisá el vencimiento»; the others follow it — v3 to confirm)
  const FIX = { number: 'Revisá el número', expiry: 'Revisá el vencimiento', cvv: 'Revisá el CVV', name: 'Escribí el nombre' };
  function formVm(states, ctx) {
    const S = obj(states) ? states : {}, member = obj(ctx) && ctx.member === true;
    const st = (f) => (obj(S[f]) && ['empty', 'invalid', 'past', 'valid'].includes(S[f].state) ? S[f].state : 'empty');
    const brand = obj(S.number) && has(BRANDS, S.number.brand) ? S.number.brand : null;
    const errors = {};
    for (const f of FIELDS) {
      const s = st(f), shown = obj(S[f]) && S[f].touched === true && s !== 'valid' && s !== 'empty';
      errors[f] = !shown ? null : f === 'expiry' && s === 'past' ? ERR.past : f === 'cvv' && brand === 'amex' ? ERR.cvv4 : ERR[f];
    }
    const firstBad = FIELDS.find((f) => st(f) !== 'valid');
    return { errors, brand, primary: firstBad ? { label: FIX[firstBad], enabled: false } : { label: 'Usar esta tarjeta', enabled: true }, save: member ? { shown: true, on: true } : { shown: false, on: false } };
  }

  // used ONLY by a DOM implementation of the fields (if PCI allows one): Luhn, brand, expiry vs now, CVV by brand, name
  const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  const brandOf = (d) => (/^4/.test(d) ? 'visa' : /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d) ? 'mastercard' : /^3[47]/.test(d) ? 'amex' : 'other');
  const luhn = (d) => { let sum = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; } return sum % 10 === 0; };
  const domValidators = {
    number(v) { const d = digits(v); if (!d) return { state: 'empty', brand: null }; const b = brandOf(d); return { state: d.length >= 13 && d.length <= 19 && luhn(d) ? 'valid' : 'invalid', brand: b }; },
    expiry(v, now) {
      const s = String(v == null ? '' : v).trim(); if (!s) return { state: 'empty' };
      const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(s); if (!m) return { state: 'invalid' };
      const mo = +m[1], yr = 2000 + +m[2]; if (mo < 1 || mo > 12) return { state: 'invalid' };
      const d = new Date(now), y0 = d.getUTCFullYear(), m0 = d.getUTCMonth() + 1;
      return { state: yr < y0 || (yr === y0 && mo < m0) ? 'past' : 'valid', exp_month: mo, exp_year: yr };
    },
    cvv(v, brand) { const d = digits(v); if (!d) return { state: 'empty' }; return { state: d.length === (brand === 'amex' ? 4 : 3) ? 'valid' : 'invalid' }; },
    name(v) { return { state: String(v == null ? '' : v).trim() ? 'valid' : 'empty' }; },
  };

  return { readPlacement, nextStep, declineBody, cardsVm, cardLabel, placeBody, newAttemptId, switchStep, formVm, domValidators, COPY, OUTCOMES, BUCKETS };
});
