'use strict';
// The PixelPay fixture REDACTOR (Codex S0/S1 r1 P1-2): an ALLOWLIST schema. Only the fields listed below survive, each with a type /
// format / range check; EVERY other value — identifiers, tokens, hashes, payloads, histories, card fields, anything unknown — is
// replaced by `<field>` (null stays null, so the SHAPE is kept). Free text survives only when it EXACTLY matches the catalogue of
// fixed system messages recorded from the sandbox; anything else becomes `<message>`. Stricter can only remove.
const { parseLempiras } = require('../pixelpay-adapter');

const enumOf = (vals, ci = false) => (v) => typeof v === 'string' && vals.includes(ci ? v.toLowerCase() : v);
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const bool = (v) => typeof v === 'boolean';
const amount = (v) => parseLempiras(v) != null;
const MESSAGES = Object.freeze([
  'Información obtenida con exito', 'Transacción denegada', 'El monto enviado es mayor al monto autorizado', 'Pago realizado exitosamente',
  'Error al encontrar el cobro', 'Transacción anulada exitosamente', 'Transacción completada exitosamente',
  'El banco emisor de la tarjeta no esta dispuesto a aceptar la transacción o esta tarjeta no admite transacciones en línea.',
]);
const MESSAGE_PATTERNS = Object.freeze([/^La transacción ha sido autorizada con éxito por la cantidad de L \d{1,6}\.\d{2}$/]);
const message = (v) => typeof v === 'string' && (MESSAGES.includes(v) || MESSAGE_PATTERNS.some((re) => re.test(v)));
const DATA = Object.freeze({
  transaction_type: enumOf(['auth', 'capture', 'void', 'sale', 'songbird', 'payload', 'router', 'refund']),
  transaction_approved_amount: amount, transaction_amount: amount,
  transaction_redeemed_points: intIn(0, 9999),
  response_approved: bool, response_incomplete: bool,
  response_code: (v) => typeof v === 'string' && /^\d{2}$/.test(v),
  response_reason: message,
  status: enumOf(['authorized', 'paid', 'voided', 'expired', 'declined', 'refunded', 'pending', 'active', 'failed', 'cancelled']),
  attemps: intIn(0, 99),
  network: enumOf(['visa', 'mastercard', 'amex', 'other'], true),
  type: enumOf(['credit', 'debit', 'prepaid'], true),
});
const TOP = Object.freeze({ success: bool, message });
// Codex S0/S1 r2: property NAMES are allowlisted too — a key never seen in a recorded envelope is DROPPED (never echoed into a
// placeholder), counted under the fixed label `_dropped_keys`. Known keys whose values are not in the schema become `<key>`.
const KNOWN_TOP = Object.freeze(['success', 'message', 'data', 'errors', 'action']);
const KNOWN_DATA = Object.freeze([...Object.keys(DATA), 'response_cvn', 'response_avs', 'response_cavv', 'transaction_id', 'transaction_time',
  'transaction_date', 'response_time', 'transaction_auth', 'transaction_reference', 'transaction_terminal', 'transaction_merchant', 'installment_type',
  'installment_months', 'payment_uuid', 'payment_hash', 'payload', 'history',
  // tokenization (tokenize-*.json)
  'address', 'bin', 'city', 'country', 'hash', 'last', 'mask', 'phone', 'state', 'token', 'zip']);

const placeholder = (k, v) => (v === null ? null : `<${k}>`);
function redactObject(obj, schema, known) {
  const out = {}; let dropped = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!known.includes(k)) { dropped += 1; continue; }
    out[k] = Object.prototype.hasOwnProperty.call(schema, k) && schema[k](v) ? v : placeholder(k, v);
  }
  if (dropped) out._dropped_keys = dropped;
  return out;
}
function redact(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return '<body>';
  const out = {}; let dropped = 0;
  for (const [k, v] of Object.entries(envelope)) {
    if (!KNOWN_TOP.includes(k)) { dropped += 1; continue; }
    if (k === 'data') out.data = v && typeof v === 'object' && !Array.isArray(v) ? redactObject(v, DATA, KNOWN_DATA) : placeholder('data', v);
    else out[k] = Object.prototype.hasOwnProperty.call(TOP, k) && TOP[k](v) ? v : placeholder(k, v);
  }
  if (dropped) out._dropped_keys = dropped;
  return out;
}
module.exports = { redact, MESSAGES, MESSAGE_PATTERNS };
