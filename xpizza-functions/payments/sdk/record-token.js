'use strict';
// owner GO 11-18 («airtight» by construction; Codex #150/#156): the reusable card token a placement keeps for the later re-authorizations
// lives OUTSIDE the payment record, at payment_sdk_tokens/{orderId}/{attempt_id} (server-only: rules .read/.write false), and THIS module
// is the only code that names that path (payments/sdk/record-token.guard.test.js). The record keeps only a non-secret pointer,
// token_attempt — the attempt whose token the re-authorizations use (the LAST claim wins, exactly as the old rec.token did).
//   stashToken     the WRITE-AHEAD, before the claim's CAS and concurrently with its existing round trips (no added checkout latency);
//   claimFor       inside the claim's CAS: point the record at its attempt (and drop a legacy rec.token);
//   readToken      the pointed attempt's token (decrease / increase refusal — read BEFORE any money op is journaled);
//   readAttemptToken  one attempt's token (the vault: the winning attempt, hash-verified by the caller);
//   hasToken / dropPointer  inside the null's CAS;  dropTokens  removes the whole node (the null, and orphans of a finished order).
// LEGACY (records written before this change, until the owner-run migration tools/migrate-sdk-tokens.js has run): the record itself
// holds `token`; the readers fall back to it HERE ONLY. A follow-up commit removes the fallback once the migration has run.
const KEY = 'token';
const node = (db, orderId, attemptId) => db.ref(attemptId ? `payment_sdk_tokens/${orderId}/${attemptId}` : `payment_sdk_tokens/${orderId}`);
const stashToken = (db, orderId, attemptId, token) => node(db, orderId, attemptId).set(token);
function claimFor(rec, attemptId) { rec.token_attempt = attemptId; delete rec[KEY]; }
async function readAttemptToken(db, orderId, rec, attemptId) {
  const t = typeof attemptId === 'string' && attemptId ? (await node(db, orderId, attemptId).once('value')).val() : null;
  return typeof t === 'string' ? t : rec ? rec[KEY] : undefined;   // LEGACY fallback (pre-migration records)
}
const readToken = (db, orderId, rec) => readAttemptToken(db, orderId, rec, rec && rec.token_attempt);
const hasToken = (rec) => !!rec && (typeof rec.token_attempt === 'string' || typeof rec[KEY] === 'string');
function dropPointer(rec) { delete rec.token_attempt; delete rec[KEY]; }
const dropTokens = (db, orderId) => node(db, orderId).remove();
const hasTokens = async (db, orderId) => (await node(db, orderId).once('value')).exists();
module.exports = { stashToken, claimFor, readToken, readAttemptToken, hasToken, dropPointer, dropTokens, hasTokens };
