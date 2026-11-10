'use strict';
// INTL PHONE S-core step 3 (build order: CASE = FLAG) — the wire contract, applied ON TOP of validateOrderPayload's result so that
// validateOrderPayload and sanitizePhone stay untouched. Pure; mutates only the `errors` / `fields` it is handed; never logs a phone.
//   strict !== true (flag OFF / absent) → a no-op: today's lenient sanitizePhone result stands, byte-for-byte.
//   strict === true                      → body.customer_phone parsed by phone/intl.js parseSubmitted:
//       valid   → fields.customer_phone = canonical '+CCnational' (the forms' '+504 9795-0000' → '+50497950000', as today)
//       invalid → fields.customer_phone = '' and the EXISTING error (index.js:634), exactly once
//       absent / empty → untouched (the required-field check owns it)
const { parseSubmitted } = require('./intl');
const LEGACY_PHONE_ERROR = 'customer_phone must be 8–15 digits';

function applyWireContract(strict, body, errors, fields) {
  if (strict !== true) return;
  const raw = body ? body.customer_phone : undefined;
  if (raw == null || raw === '') return;
  const p = parseSubmitted(raw);
  if (p) { fields.customer_phone = p.canonical; return; }
  fields.customer_phone = '';
  if (!errors.includes(LEGACY_PHONE_ERROR)) errors.push(LEGACY_PHONE_ERROR);
}

module.exports = { applyWireContract, LEGACY_PHONE_ERROR };
