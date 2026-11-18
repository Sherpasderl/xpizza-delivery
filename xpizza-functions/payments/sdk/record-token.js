'use strict';
// owner 11-18 «airtight» (advisor, Codex #150 REVISE): the ONE module that touches payment_sdk/{orderId}.token — the reusable card token
// a placement stores for the later re-authorizations. Every reader and writer goes through here: the claim (coordinator placeOriginal),
// the decrease and the increase refusal (coordinator re-authorize), the vault step (cards.completeVaultForOrder) and the null
// (cards.nullSpentToken). payments/sdk/record-token.guard.test.js (tools/sdk-token-census) fails on any other `token` access in the tree
// that is not a reviewed, pinned non-record site, and on any payment_sdk record leaving whole (spread, assign, serialize, forward).
// Semantics are EXACTLY the bare property's (a pure move): tokenOf(rec) is rec.token.
const KEY = 'token';
const tokenOf = (rec) => rec[KEY];
function setToken(rec, token) { rec[KEY] = token; }
function dropToken(rec) { delete rec[KEY]; }
module.exports = { tokenOf, setToken, dropToken };
