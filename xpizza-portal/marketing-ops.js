// Portal «Marketing» — the writes whose outcome is not proven yet, kept OUTSIDE any dialog (Codex r2–r4, advisor rulings 11-14).
//   RULE A (r4) — a SENT operation is FROZEN. Programming a new offer / «Repetir» is ONE server call carrying a client op_id; the moment
//     it is sent, its exact payload is stored WITH its op_id, and every retry resends THAT payload until an outcome proves it (a reply
//     for it, a duplicate, an explicit refusal). The dialog shows it read-only meanwhile: a different campaign is a new, explicit action.
//   RULE B (r4) — one storage key PER OPERATION: `sherpa.op.{uid}.{brand}.{kind}.{source}` → { op_id, payload, created_at }. No
//     whole-envelope rewrite: another tab never overwrites an unrelated key; settling removes only its own key. In-memory state is
//     authoritative in this tab (a failed setItem never replaces it with the persisted copy); storage is read only for a key this tab
//     does not hold (another tab's pending operation is adopted). Entries are dropped at 6 days (< the server's 7-day claim).
//   known-id writes (a draft save / edit / pause / resume / end) — an UNKNOWN outcome blocks further writes to THAT offer until a
//     read shows its rev ≥ the rev the write would make (r3 P2-8); per-offer keys `sherpa.unsettled.{uid}.{offerId}` → { sentRev }.
export const OP_TTL_MS = 6 * 86400000;   // < 3a's OP_TTL_MS (7 days): never retry an op the server may have forgotten
const S = { uid: null, ops: new Map(), unsettled: new Map(), now: () => Date.now() };

const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; } };
const opStoreKey = (k) => `sherpa.op.${S.uid}.${k}`;
const unsetStoreKey = (id) => `sherpa.unsettled.${S.uid}.${id}`;
function put(key, value) { try { const st = store(); if (st) st.setItem(key, JSON.stringify(value)); } catch (_) { /* quota / blocked: memory stands */ } }
function drop(key) { try { const st = store(); if (st) st.removeItem(key); } catch (_) { /* memory stands */ } }
function get(key) { try { const st = store(); const v = st ? st.getItem(key) : null; return v ? JSON.parse(v) : null; } catch (_) { return null; } }
const fresh = (op) => !!op && typeof op.op_id === 'string' && Number.isSafeInteger(op.created_at) && S.now() - op.created_at < OP_TTL_MS;

// the session's user (marketing.js on portal:auth): another user never inherits these
export function forUser(uid) { if (uid !== S.uid) { S.uid = uid; S.ops = new Map(); S.unsettled = new Map(); } }
// every completion is bound to the user it started for: ticket() at the start; another user's ticket mutates nothing
export const ticket = () => S.uid;
const mine = (who) => who === undefined || who === S.uid;

export const opKey = (brandId, kind, sourceId = '') => `${brandId}.${kind}.${sourceId}`;
const newOpId = () => `op_${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
// the PENDING (sent, unproven) operation of this key: this tab's, else another tab's from storage; expired ⇒ none
export function pendingOp(k) {
  if (!S.uid) return null;
  let op = S.ops.get(k);
  if (!op) { const v = get(opStoreKey(k)); if (fresh(v)) { op = v; S.ops.set(k, v); } }
  if (op && !fresh(op)) { S.ops.delete(k); drop(opStoreKey(k)); return null; }
  return op || null;
}
// SEND: the pending operation of this key if any (its frozen payload is what goes), else a NEW one frozen with `payload` — stored
// before the request leaves
export function sendOp(k, payload, who) {
  if (!mine(who) || !S.uid) return null;
  const cur = pendingOp(k);
  if (cur) return cur;
  const op = { op_id: newOpId(), payload, created_at: S.now() };
  S.ops.set(k, op); put(opStoreKey(k), op);
  return op;
}
// an outcome PROVED the operation: remove ONLY its own key, and only if it is still that op_id
export function settleOp(k, opId, who) {
  if (!mine(who)) return;
  const cur = S.ops.get(k) || get(opStoreKey(k));
  if (cur && cur.op_id === opId) { S.ops.delete(k); drop(opStoreKey(k)); }
}

export function markUnsettled(offerId, sentRev, who) { if (!mine(who) || !S.uid) return; S.unsettled.set(offerId, { sentRev }); put(unsetStoreKey(offerId), { sentRev }); }
export function unsettled(offerId) {
  if (S.unsettled.has(offerId)) return true;
  const v = S.uid ? get(unsetStoreKey(offerId)) : null;
  if (v && Number.isSafeInteger(v.sentRev)) { S.unsettled.set(offerId, v); return true; }
  return false;
}
// a successful read of offers settles a known-id write ONLY on rev proof (rev ≥ the sent rev); a lower rev proves nothing
export function reconcile(offers) {
  let changed = false;
  for (const o of offers) {
    if (!o || !unsettled(o.id)) continue;
    if (Number.isSafeInteger(o.rev) && o.rev >= S.unsettled.get(o.id).sentRev) { S.unsettled.delete(o.id); drop(unsetStoreKey(o.id)); changed = true; }
  }
  return changed;
}
export const _opsState = S;   // test-only (S.now is the ledger's clock)
