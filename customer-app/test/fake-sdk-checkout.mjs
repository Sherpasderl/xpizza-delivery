// TEST-ONLY fake of the SDK CHECKOUT surface (CONTRACT-sdk-checkout r3, APPROVED AS CONTRACT 11-08): the placeSdkOrder /
// placeSdkStatus response for each outcome with its EXACT key set (§2.4), listCards (§6), sdkPayStatus (§9), cancelSdkPending (§5).
// Every value is type-checked; a required key holding undefined or a key the contract does not name THROWS — never laxer than the
// server. Replaced by the real endpoints' serializers when D4 lands.
const OUTCOMES = ['placed', 'declined', 'action_required', 'bank_pending', 'under_review', 'expired', 'unavailable', 'not_allowed'];
const BUCKETS = ['retryable', 'hard', 'wrong_data', 'token_expired'];
const BRANDS = ['visa', 'mastercard', 'amex', 'other'];
const str = (s) => typeof s === 'string' && s !== '', int = Number.isInteger, bool = (b) => typeof b === 'boolean';
const card = (c) => !!c && typeof c === 'object' && Object.keys(c).length === 2 && BRANDS.includes(c.brand) && typeof c.last4 === 'string' && /^\d{4}$/.test(c.last4);
const challenge = (c) => !!c && typeof c === 'object' && Object.keys(c).sort().join() === 'continuation_id,expires_at,sdk_payload' && str(c.continuation_id) && int(c.expires_at);
// §2.4 — the exact keys per outcome (adjust_grant: guests, ONLY in the request whose transaction placed the order)
const RESP = {
  placed: { outcome: (x) => x === 'placed', order_id: str, tracking_token: str, card },
  declined: { outcome: (x) => x === 'declined', order_id: str, attempt_id: str, decline: (x) => BUCKETS.includes(x), pay_deadline_at: int },
  action_required: { outcome: (x) => x === 'action_required', order_id: str, attempt_id: str, challenge },
  bank_pending: { outcome: (x) => x === 'bank_pending', order_id: str, attempt_id: str },
  under_review: { outcome: (x) => x === 'under_review', order_id: str },
  expired: { outcome: (x) => x === 'expired', order_id: str, safe_to_switch: bool },
  unavailable: { outcome: (x) => x === 'unavailable', retry_after_s: int },
  not_allowed: { outcome: (x) => x === 'not_allowed', reason: (x) => x === 'scheduled' },
};
function exact(o, spec, what, optional = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`fake-sdk-checkout: ${what} is not an object`);
  for (const k of Object.keys(o)) if (!Object.prototype.hasOwnProperty.call(spec, k) && !Object.prototype.hasOwnProperty.call(optional, k)) throw new Error(`fake-sdk-checkout: ${what} has a key the contract does not: ${k}`);
  for (const [k, ok] of Object.entries(spec)) {
    if (!(k in o) || o[k] === undefined) throw new Error(`fake-sdk-checkout: ${what} lacks ${k}`);
    if (!ok(o[k])) throw new Error(`fake-sdk-checkout: ${what}.${k} has the wrong type (${JSON.stringify(o[k])})`);
  }
  for (const [k, ok] of Object.entries(optional)) if (k in o && !ok(o[k])) throw new Error(`fake-sdk-checkout: ${what}.${k} has the wrong type`);
  return o;
}
const snap = (o) => JSON.parse(JSON.stringify(o));
// a placeSdkOrder / placeSdkStatus body; `replay: true` (a status read or a retransmission) never carries adjust_grant (§2.4)
export function placeResp(outcome, fields = {}, { replay = false } = {}) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`fake-sdk-checkout: outcome ${outcome} is outside the closed enum`);
  const r = { outcome, ...fields };
  const opt = outcome === 'placed' && !replay ? { adjust_grant: str } : {};
  exact(r, RESP[outcome], `response(${outcome})`, opt);
  return exact(snap(r), RESP[outcome], `response(${outcome})`, opt);
}
// §6 listCards — newest first; no token, ever
const CARD_ROW = { card_id: str, brand: (x) => BRANDS.includes(x), last4: (x) => typeof x === 'string' && /^\d{4}$/.test(x), exp_month: (x) => int(x) && x >= 1 && x <= 12, exp_year: (x) => int(x) && x >= 1000 && x <= 9999, expired: bool };
export function listCards(cards) {
  const r = { cards: cards.map((c) => exact({ ...c }, CARD_ROW, 'card row')) };
  exact(r, { cards: Array.isArray }, 'listCards');
  return snap(r);
}
export const sdkPayStatus = (available, retry_after_s = 0) => exact(snap({ available, retry_after_s }), { available: bool, retry_after_s: int }, 'sdkPayStatus');
export const cancelPending = (cancelled, safe_to_switch) => exact(snap({ cancelled, safe_to_switch }), { cancelled: bool, safe_to_switch: bool }, 'cancelSdkPending');
export { OUTCOMES, BUCKETS };
