// Portal «Marketing» — the writes whose outcome is not proven yet, kept OUTSIDE any dialog (Codex r2 + r3, advisor rulings 11-14:
// operation identity, and ONE server call per operation).
//   programming a NEW offer / «Repetir» — ONE call each (3a e3c5f7366: marketingOfferSave program:true · marketingOfferRepeat with
//     source_id + dates + program), carrying a client op_id. The op_id is minted when the review step (or the repeat sheet) opens,
//     stored in localStorage (shared across tabs) keyed by user + restaurant (brand) + kind + source, with its created_at, and REUSED
//     by every retry until an outcome PROVES it (a reply for it; a duplicate; an op_id conflict). It is dropped at 6 days (< the
//     server's 7-day claim). Storage failure ⇒ module state only — the server's 409 duplicate backstop covers the residue.
//   known-id writes (a draft save / edit / publish / pause / resume / end) — an UNKNOWN outcome blocks further writes to THAT offer
//     until a read shows its rev ≥ the rev the write would make (Codex r3 P2-8).
const KEY = (uid) => `sherpa.portal.mkt.ops.${uid}`;   // one envelope PER USER (Codex r3 P1-4)
export const OP_TTL_MS = 6 * 86400000;                 // < 3a's OP_TTL_MS (7 days): never retry an op the server may have forgotten
const S = { uid: null, ops: new Map(), unsettled: new Map(), now: () => Date.now() };

const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; } };
function save() {
  if (!S.uid) return;
  try { const st = store(); if (st) st.setItem(KEY(S.uid), JSON.stringify({ uid: S.uid, ops: [...S.ops], unsettled: [...S.unsettled] })); } catch (_) { /* full / blocked: module state still holds */ }
}
function load(uid) {
  S.uid = uid; S.ops = new Map(); S.unsettled = new Map();
  if (!uid) return;
  try {
    const st = store();
    const v = st ? JSON.parse(st.getItem(KEY(uid)) || 'null') : null;
    if (v && v.uid === uid && Array.isArray(v.ops) && Array.isArray(v.unsettled)) { S.ops = new Map(v.ops); S.unsettled = new Map(v.unsettled); }
  } catch (_) { /* unreadable: start clean */ }
  expire();
}
// another tab may have minted / proven an op since: re-read the shared envelope before deciding (unreadable ⇒ keep module state)
function refresh() {
  if (!S.uid) return;
  try {
    const st = store();
    const v = st ? JSON.parse(st.getItem(KEY(S.uid)) || 'null') : null;
    if (v && v.uid === S.uid && Array.isArray(v.ops)) { S.ops = new Map(v.ops); if (Array.isArray(v.unsettled)) S.unsettled = new Map(v.unsettled); }
  } catch (_) { /* storage failure: module state stands */ }
  expire();
}
function expire() {
  const t = S.now();
  let changed = false;
  for (const [k, op] of S.ops) if (!(Number.isSafeInteger(op.at) && t - op.at < OP_TTL_MS)) { S.ops.delete(k); changed = true; }
  if (changed) save();
}
// the session's user (marketing.js on portal:auth): another user never inherits these
export function forUser(uid) { if (uid !== S.uid) load(uid); }
// every completion is bound to the user it started for: ticket() at the start; another user's ticket mutates nothing
export const ticket = () => S.uid;
const mine = (who) => who === undefined || who === S.uid;

export const opKey = (brandId, kind, sourceId = '') => `${brandId}|${kind}|${sourceId}`;
const newOpId = () => `op_${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
// THE op_id of this key's operation: the pending one (any tab's, younger than 6 days), else a new one — recorded before any request
export function opFor(k, who) {
  if (!mine(who)) return null;
  refresh();
  const cur = S.ops.get(k);
  if (cur) return cur.op_id;
  const op = { op_id: newOpId(), at: S.now() };
  S.ops.set(k, op); save();
  return op.op_id;
}
export const pendingOpId = (k) => { refresh(); const cur = S.ops.get(k); return cur ? cur.op_id : null; };
// an outcome PROVED the operation (its reply, a duplicate, an op_id conflict): the next one is new. Only the op_id it proved.
export function dropOp(k, opId, who) {
  if (!mine(who)) return;
  refresh();
  const cur = S.ops.get(k);
  if (cur && cur.op_id === opId) { S.ops.delete(k); save(); }
}

export function markUnsettled(offerId, sentRev, who) { if (!mine(who)) return; S.unsettled.set(offerId, { sentRev }); save(); }
export const unsettled = (offerId) => S.unsettled.has(offerId);
// a successful read of offers settles a known-id write ONLY on rev proof (rev ≥ the sent rev); a lower rev proves nothing
export function reconcile(offers) {
  let changed = false;
  for (const id of [...S.unsettled.keys()]) {
    const o = offers.find((x) => x && x.id === id);
    if (o && Number.isSafeInteger(o.rev) && o.rev >= S.unsettled.get(id).sentRev) { S.unsettled.delete(id); changed = true; }
  }
  if (changed) save();
  return changed;
}
export const _opsState = S;   // test-only (S.now is the ledger's clock)
