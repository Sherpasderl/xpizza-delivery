'use strict';
// owner GO 11-18 («airtight» by construction; Codex #150/#156): the reusable card token a placement keeps for the later re-authorizations
// lives OUTSIDE the payment record, at payment_sdk_tokens/{orderId}/{attempt_id} (server-only: rules .read/.write false), and THIS module
// is the only code that names that path (payments/sdk/record-token.guard.test.js). The record keeps only a non-secret pointer,
// token_attempt — the attempt whose token the re-authorizations use (the LAST claim wins, exactly as the old rec.token did).
//   stashToken     the WRITE-AHEAD, before the claim's CAS and concurrently with its existing round trips (no added checkout latency);
//   claimFor       inside the claim's CAS: point the record at its attempt;
//   readToken      the pointed attempt's token (decrease / increase refusal — read BEFORE any money op is journaled);
//   readAttemptToken  one attempt's token (the vault: the winning attempt, hash-verified by the caller);
//   hasToken / dropPointer  inside the null's CAS;  enqueueAndDrop  removes the node, queueing each one-off token (never a bare drop).
const node = (db, orderId, attemptId) => db.ref(attemptId ? `payment_sdk_tokens/${orderId}/${attemptId}` : `payment_sdk_tokens/${orderId}`);
// Codex #158 r1 F1: CREATE-ONCE per attempt — two requests with the same attempt id and DIFFERENT tokens can both pass the replay check;
// the first token stays, the second gets 'conflict' (its claim is refused before any PSP call). The same token again is a no-op 'ok'.
// card-cleanup r2 (PLAN DELTA r2 (A)): the node records the token's SOURCE with it, in the same transaction —
// payment_sdk_tokens/{oid}/{aid} = { t, src: 'new' | 'saved' } — so even an unclaimed write-ahead (a lost claim, the orphan walk) is known
// to be a one-off or a saved card's token.
async function stashToken(db, orderId, attemptId, token, src) {
  let conflict = false;
  const res = await node(db, orderId, attemptId).transaction((cur) => { conflict = false; if (cur == null) return { t: token, src: src === 'saved' ? 'saved' : 'new' }; if (cur && cur.t === token) return cur; conflict = true; return undefined; });
  if (conflict) return 'conflict';
  if (!res || !res.committed) throw Object.assign(new Error('token stash not committed'), { code: 'stash_not_committed' });
  return 'ok';
}
function claimFor(rec, attemptId) { rec.token_attempt = attemptId; }
async function readAttemptToken(db, orderId, rec, attemptId) {
  const v = typeof attemptId === 'string' && attemptId ? (await node(db, orderId, attemptId).once('value')).val() : null;
  return v && typeof v.t === 'string' ? v.t : undefined;
}
const readToken = (db, orderId, rec) => readAttemptToken(db, orderId, rec, rec && rec.token_attempt);
const hasToken = (rec) => !!rec && typeof rec.token_attempt === 'string';
function dropPointer(rec) { delete rec.token_attempt; }
// card-cleanup (PLAN DELTA (1) + r2 (A)): the node is NEVER dropped bare — ONE multi-path update removes exactly the attempts read (a newer
// write-ahead that lands after the read stays for the next visit) AND queues each ONE-OFF token for the provider delete. A one-off token is
// src 'new' AND not the attempt the vault saved (rec.vault done) AND not a LIVE saved card of the uid (a client re-submitting a token it once
// saved). A saved card's token is never queued here: its handle lives in customer_cards and leaves via card removal / the account fence.
async function enqueueAndDrop(db, orderId, { uid = null, vaultedAid = null, now } = {}) {
  const v = (await node(db, orderId).once('value')).val();
  const TQ = require('./token-queue');
  const upd = {};
  for (const [aid, e] of Object.entries(v && typeof v === 'object' ? v : {})) {
    upd[`payment_sdk_tokens/${orderId}/${aid}`] = null;
    if (!e || typeof e.t !== 'string' || !e.t || e.src !== 'new' || aid === vaultedAid) continue;
    if (typeof uid === 'string' && uid && (await db.ref(`customer_cards/${uid}/by_hash/${TQ.hashOf(e.t)}`).once('value')).exists()) continue;
    Object.assign(upd, TQ.enqueueEntries(e.t, `order_${orderId}`, { aid, uid: typeof uid === 'string' && uid ? uid : null, at: now }));
  }
  if (Object.keys(upd).length) await db.ref().update(upd);
  return Object.keys(v && typeof v === 'object' ? v : {}).length;
}
const hasTokens = async (db, orderId) => (await node(db, orderId).once('value')).exists();
// Codex #158 r1 F2: the orphan sweep walks the token nodes THEMSELVES (an orphan may have no due entry): key-order pages behind a rotating
// cursor (payment_sdk_tokens_cursor, server-only), wrapping at the end
async function pageTokenOrders(db, batch) {
  const cur = (await db.ref('payment_sdk_tokens_cursor').once('value')).val();
  const page = async (after) => { const q = db.ref('payment_sdk_tokens').orderByKey(); const keys = Object.keys((await (after ? q.startAt(after).limitToFirst(batch + 1) : q.limitToFirst(batch)).once('value')).val() || {}); return keys.filter((k) => k !== after).slice(0, batch); };
  let ids = await page(typeof cur === 'string' ? cur : null);
  if (!ids.length && typeof cur === 'string') ids = await page(null);   // past the end: wrap
  await db.ref('payment_sdk_tokens_cursor').set(ids.length === batch ? ids[ids.length - 1] : null);   // a short page ends the lap
  return ids;
}
module.exports = { stashToken, claimFor, readToken, readAttemptToken, hasToken, dropPointer, enqueueAndDrop, hasTokens, pageTokenOrders };
