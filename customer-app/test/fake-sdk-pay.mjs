// TEST-ONLY fake of the SDK customer surface (CONTRACT-sdk-customer r4, APPROVED AS CONTRACT 11-08). It mirrors the server's ONE
// serializer `payViewOf` (§1.1): every level has an EXACT key set, every value its contract type (Codex r1 #6: a required key holding
// undefined — which JSON would silently drop — or a wrong type THROWS), the closed Outcome enum (§1.3) and the §2 reconciliation; the
// returned snapshot is checked again AFTER serialization. Never laxer than production. Replaced by the real serializer when D4 lands.
const OUTCOMES = ['pending', 'processing', 'action_required', 'bank_pending', 'accepted', 'declined', 'kept', 'expired', 'not_applied', 'under_review'];
const LINE_KINDS = ['line_added', 'line_removed', 'line_unavailable', 'line_qty', 'line_price'];
const int = (n) => Number.isInteger(n), cents = (n) => int(n) && n >= 0, intOrNull = (n) => n === null || int(n);
const str = (s) => typeof s === 'string' && s !== '', strOrNull = (s) => s === null || typeof s === 'string';
// key → value check, per level (§1.2 / §2 / §4)
const SPEC = {
  view: { v: (x) => x === 1, seq: int, total_cents: cents, revision: int, card: (x) => x === undefined || typeof x === 'object', consent: (x) => x === null || typeof x === 'object', notice: (x) => x === null || typeof x === 'object' },
  card: { brand: (x) => ['visa', 'mastercard', 'amex', 'other'].includes(x), last4: (x) => typeof x === 'string' && /^\d{4}$/.test(x) },
  consent: { adjustment_id: str, outcome: (x) => OUTCOMES.includes(x), old_total_cents: cents, new_total_cents: cents, delta_cents: int, expires_at: int, changes: Array.isArray },
  notice: { kind: (x) => x === 'decrease', revision: int, old_total_cents: cents, new_total_cents: cents, changes: Array.isArray },
  line: { kind: (x) => LINE_KINDS.includes(x), name: str, config: strOrNull, qty_old: intOrNull, qty_new: intOrNull, line_cents_old: intOrNull, line_cents_new: intOrNull, delta_cents: int },
  component: { kind: (x) => x === 'component', component: (x) => ['delivery', 'tip', 'discount'].includes(x), old_cents: cents, new_cents: cents, delta_cents: int },
};
function exact(o, spec, what, optional = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`fake-sdk-pay: ${what} is not an object`);
  for (const k of Object.keys(o)) if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new Error(`fake-sdk-pay: ${what} has a key the contract does not: ${k}`);   // own keys only (Codex r2 #2)
  for (const [k, ok] of Object.entries(spec)) {
    if (optional.includes(k) && !(k in o)) continue;
    if (!(k in o) || o[k] === undefined) throw new Error(`fake-sdk-pay: ${what} lacks ${k}`);
    if (!ok(o[k])) throw new Error(`fake-sdk-pay: ${what}.${k} has the wrong type (${JSON.stringify(o[k])})`);
  }
  return o;
}
const change = (c) => (c && c.kind === 'component' ? exact(c, SPEC.component, 'Change(component)') : exact(c, SPEC.line, 'Change(line)'));
// §2: Σ delta_cents must equal new − old, or the server REFUSES to open the consent / notice
function reconciled(x, what) {
  const sum = x.changes.reduce((s, c) => s + change(c).delta_cents, 0);
  if (sum !== x.new_total_cents - x.old_total_cents) throw new Error(`fake-sdk-pay: ${what} changes do not add up (server refuses)`);
  return x;
}
function check(v) {
  exact(v, SPEC.view, 'view', ['card']);
  if (v.card !== undefined) exact(v.card, SPEC.card, 'card');
  if (v.consent !== null) {
    exact(v.consent, SPEC.consent, 'consent');
    if (v.consent.delta_cents !== v.consent.new_total_cents - v.consent.old_total_cents) throw new Error('fake-sdk-pay: consent.delta_cents');
    reconciled(v.consent, 'consent');
  }
  if (v.notice !== null) reconciled(exact(v.notice, SPEC.notice, 'notice'), 'notice');
  return v;
}
export function payView(input) {
  exact(input, { seq: int, total_cents: cents, revision: int, card: SPEC.view.card, consent: SPEC.view.consent, notice: SPEC.view.notice }, 'payView input', ['seq', 'revision', 'card', 'consent', 'notice']);
  const { seq = 1, total_cents, revision = 0, card, consent = null, notice = null } = input;
  const v = check({ v: 1, seq, total_cents, revision, ...(card !== undefined ? { card } : {}), consent, notice });
  return check(JSON.parse(JSON.stringify(v)));   // the snapshot as the stream delivers it — checked again after serialization
}
export const line = (kind, name, delta_cents, o = {}) => ({ kind, name, config: null, qty_old: null, qty_new: null, line_cents_old: null, line_cents_new: null, delta_cents, ...o });
export const component = (component, old_cents, new_cents) => ({ kind: 'component', component, old_cents, new_cents, delta_cents: component === 'discount' ? old_cents - new_cents : new_cents - old_cents });
export { OUTCOMES };
