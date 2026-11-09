// TEST-ONLY fake of the SDK customer surface (CONTRACT-sdk-customer r4, APPROVED AS CONTRACT 11-08). It mirrors the server's ONE
// serializer `payViewOf` (§1.1): every level has an EXACT key set and the closed Outcome enum (§1.3); anything else THROWS — never
// laxer than production. Replace with the real serializer once D4 lands (then this file is deleted; the cells keep their names).
const OUTCOMES = ['pending', 'processing', 'action_required', 'bank_pending', 'accepted', 'declined', 'kept', 'expired', 'not_applied', 'under_review'];
const KEYS = {
  view: ['v', 'seq', 'total_cents', 'revision', 'card', 'consent', 'notice'],
  card: ['brand', 'last4'],
  consent: ['adjustment_id', 'outcome', 'old_total_cents', 'new_total_cents', 'delta_cents', 'expires_at', 'changes'],
  notice: ['kind', 'revision', 'old_total_cents', 'new_total_cents', 'changes'],
  line: ['kind', 'name', 'config', 'qty_old', 'qty_new', 'line_cents_old', 'line_cents_new', 'delta_cents'],
  component: ['kind', 'component', 'old_cents', 'new_cents', 'delta_cents'],
};
const LINE_KINDS = ['line_added', 'line_removed', 'line_unavailable', 'line_qty', 'line_price'];
const int = (n) => Number.isInteger(n);
function exact(o, keys, what, optional = []) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`fake-sdk-pay: ${what} is not an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`fake-sdk-pay: ${what} has a key the contract does not: ${k}`);
  for (const k of keys) if (!optional.includes(k) && !(k in o)) throw new Error(`fake-sdk-pay: ${what} lacks ${k}`);
  return o;
}
function change(c) {
  if (c && c.kind === 'component') {
    exact(c, KEYS.component, 'Change(component)');
    if (!['delivery', 'tip', 'discount'].includes(c.component)) throw new Error('fake-sdk-pay: component');
  } else {
    exact(c, KEYS.line, 'Change(line)');
    if (!LINE_KINDS.includes(c.kind) || typeof c.name !== 'string') throw new Error('fake-sdk-pay: line kind / name');
  }
  if (!int(c.delta_cents)) throw new Error('fake-sdk-pay: delta_cents');
  return c;
}
// §2: Σ delta_cents must equal new − old, or the server REFUSES to open the consent / notice
function reconciled(x, what) {
  const sum = x.changes.reduce((s, c) => s + change(c).delta_cents, 0);
  if (sum !== x.new_total_cents - x.old_total_cents) throw new Error(`fake-sdk-pay: ${what} changes do not add up (server refuses)`);
  return x;
}
export function payView(input) {
  exact(input, ['seq', 'total_cents', 'revision', 'card', 'consent', 'notice'], 'payView input', ['seq', 'revision', 'card', 'consent', 'notice']);
  const { seq = 1, total_cents, revision = 0, card, consent = null, notice = null } = input;
  const v = { v: 1, seq, total_cents, revision, ...(card ? { card: exact({ ...card }, KEYS.card, 'card') } : {}), consent, notice };
  exact(v, KEYS.view, 'view', ['card']);
  if (!int(seq) || !int(total_cents) || total_cents < 0 || !int(revision)) throw new Error('fake-sdk-pay: view ints');
  if (card && (!['visa', 'mastercard', 'amex', 'other'].includes(card.brand) || !/^\d{4}$/.test(card.last4))) throw new Error('fake-sdk-pay: card');
  if (consent !== null) {
    exact(consent, KEYS.consent, 'consent');
    if (!OUTCOMES.includes(consent.outcome)) throw new Error(`fake-sdk-pay: outcome ${consent.outcome} is outside the closed enum`);
    if (consent.delta_cents !== consent.new_total_cents - consent.old_total_cents) throw new Error('fake-sdk-pay: delta');
    reconciled(consent, 'consent');
  }
  if (notice !== null) { exact(notice, KEYS.notice, 'notice'); if (notice.kind !== 'decrease') throw new Error('fake-sdk-pay: notice kind'); reconciled(notice, 'notice'); }
  return JSON.parse(JSON.stringify(v));   // a snapshot, as the stream delivers it
}
export const line = (kind, name, delta_cents, o = {}) => ({ kind, name, config: null, qty_old: null, qty_new: null, line_cents_old: null, line_cents_new: null, delta_cents, ...o });
export const component = (component, old_cents, new_cents) => ({ kind: 'component', component, old_cents, new_cents, delta_cents: component === 'discount' ? old_cents - new_cents : new_cents - old_cents });
export { OUTCOMES };
