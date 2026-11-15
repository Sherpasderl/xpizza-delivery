// Portal «Marketing» — the writes whose outcome is not known yet, kept OUTSIDE any dialog (Codex r2, advisor ruling 11-14: operation
// identity, not content matching). Module state that survives close / reopen, mirrored in sessionStorage (try/catch: no storage ⇒
// module state only).
//   create / repeat — each operation carries a client op_id, made when it starts and REUSED by every retry of it (the server is
//     idempotent per (restaurant, op_id) once 3a lands: IDEMPOTENT_OPS). Keyed per (rid, kind, source offer). An UNKNOWN outcome
//     blocks that key until a successful read PROVES it (a record carrying our op_id), or — once the server is idempotent — the retry
//     itself is safe by construction.
//   known-id writes (save / state move) — an UNKNOWN outcome blocks further writes to THAT offer until a successful read reconciles it:
//     rev ≥ the rev the write would have made ⇒ it landed; anything else ⇒ a conflict, and the next write starts from that read.
export const IDEMPOTENT_OPS = true;   // 3a c5bbce740: create / repeat idempotent per (restaurant, op_id), 7-day claim — a retry reusing the op_id is safe (pinned-ref cells)
const KEY = (uid) => `sherpa.portal.mkt.ops.${uid}`;   // one envelope PER USER: a switch never overwrites another user's (Codex r3 P1-4)
const S = { uid: null, ops: new Map(), unsettled: new Map() };

const store = () => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (_) { return null; } };
function save() {
  const st = store(); if (!st) return;
  if (!S.uid) return;
  try { st.setItem(KEY(S.uid), JSON.stringify({ uid: S.uid, ops: [...S.ops], unsettled: [...S.unsettled] })); } catch (_) { /* full / blocked: module state still holds */ }
}
function loadFor(uid) {
  S.uid = uid; S.ops = new Map(); S.unsettled = new Map();
  const st = store(); if (!st) return;
  try {
    const v = uid ? JSON.parse(st.getItem(KEY(uid)) || 'null') : null;
    if (v && v.uid === uid && Array.isArray(v.ops) && Array.isArray(v.unsettled)) { S.ops = new Map(v.ops); S.unsettled = new Map(v.unsettled); }
  } catch (_) { /* unreadable: start clean */ }
}
// the session's user (marketing.js on portal:auth): another user never inherits these
export function forUser(uid) { if (uid !== S.uid) loadFor(uid); }

export const opKey = (rid, kind, sourceId = '') => `${rid}|${kind}|${sourceId}`;
// every completion is bound to the user it started for (Codex r3 P1-4): ticket() at the start; a mutation carrying another user's
// ticket is a no-op (a late reply after an account switch never touches the new user's ledger)
export const ticket = () => S.uid;
const mine = (who) => who === undefined || who === S.uid;
const newOpId = () => `op_${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
// the op_id of THIS key's operation: the pending one if a retry, else a new one (recorded before the request leaves)
export function beginOp(k) {
  const cur = S.ops.get(k);
  if (cur) return cur.op_id;
  const op = { op_id: newOpId(), unknown: false };
  S.ops.set(k, op); save();
  return op.op_id;
}
export function markUnknown(k, who) { if (!mine(who)) return; const cur = S.ops.get(k); if (cur) { cur.unknown = true; save(); } }
export function settleOp(k, who) { if (mine(who) && S.ops.delete(k)) save(); }   // saved, or refused (nothing landed): the next operation is a new one
export const opBlocked = (k) => { const cur = S.ops.get(k); return !!(cur && cur.unknown && !IDEMPOTENT_OPS); };
export const pendingOpId = (k) => { const cur = S.ops.get(k); return cur ? cur.op_id : null; };

export function markUnsettled(offerId, sentRev, who) { if (!mine(who)) return; S.unsettled.set(offerId, { sentRev }); save(); }
export const unsettled = (offerId) => S.unsettled.has(offerId);

// every successful read of offers (marketing.js load, the builder's own reads) reconciles: a record carrying a pending op_id proves
// that operation; a known-id write is settled by the record's rev
export function reconcile(offers) {
  let changed = false;
  for (const [k, op] of S.ops) if (offers.some((o) => o && o.op_id === op.op_id)) { S.ops.delete(k); changed = true; }
  for (const id of [...S.unsettled.keys()]) {
    // only REV PROOF settles it (Codex r3 P2-8): a read holding the offer at rev ≥ the rev the write would make. A lower rev proves
    // nothing (the write may still be running); not in this read (another branch) ⇒ it stays
    const o = offers.find((x) => x && x.id === id);
    if (o && Number.isSafeInteger(o.rev) && o.rev >= S.unsettled.get(id).sentRev) { S.unsettled.delete(id); changed = true; }
  }
  if (changed) save();
  return changed;
}
export const _opsState = S;   // test-only
