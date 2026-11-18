#!/usr/bin/env node
'use strict';
// owner GO 11-18 («airtight» by construction) — the ONE-TIME owner migration that moves every legacy card token off the payment record:
// payment_sdk/{oid}.token → payment_sdk_tokens/{oid}/{attempt_id}, the record keeping only the pointer token_attempt (exactly what a
// placement now writes, payments/sdk/record-token.js). Run AFTER the deploy whose readers use the node (they fall back to a legacy
// rec.token until then, inside record-token.js only); a follow-up commit removes that fallback once this has run.
//
// Per record holding a string `token`: the attempt is the one whose token_hash is sha256(token) (exact, never guessed — no match ⇒
// counted «unmatched», left untouched for a person; a token several attempts share with no winner yet is «deferredAmbiguous», kept). --apply: the token is written AHEAD to the node, then ONE CAS on the record moves
// the pointer and drops `token` — only if the record still holds that same token (a concurrent placement / null wins: «raced»).
//
//   node tools/migrate-sdk-tokens.js --project xpizza-delivery            (DRY RUN: counts only; writes nothing)
//   node tools/migrate-sdk-tokens.js --project xpizza-delivery --apply    (OWNER-RUN, after the reading deploy)
// Output: counts only — never an order id, token or hash. One full read of payment_sdk (a one-time owner run).
const crypto = require('crypto');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function migrate({ rtdb, apply = false }) {
  const r = { dryRun: !apply, records: 0, withToken: 0, matched: 0, unmatched: 0, migrated: 0, raced: 0, deferredAmbiguous: 0 };
  const all = (await rtdb.ref('payment_sdk').once('value')).val() || {};
  for (const oid of Object.keys(all).sort()) {
    const rec = all[oid];
    r.records += 1;
    if (!isObj(rec) || typeof rec.token !== 'string' || !rec.token) continue;
    r.withToken += 1;
    const h = sha(rec.token);
    // Codex #158 r1 F3: prefer the WINNING attempt (the order's placed leg — the vault's own rule) when its hash matches; else the first match
    const order = (await rtdb.ref(`orders/${oid}`).once('value')).val();
    const legId = isObj(order) && isObj(order.payment_placed) ? order.payment_placed.leg_id : null;
    const win = legId && isObj(rec.legs) && isObj(rec.legs[legId]) ? rec.legs[legId].attempt_id : null;
    // Codex #161 F3: with no established winner, a token shared by MORE THAN ONE attempt is never guessed (an approved-but-unplaced
    // attempt may still win on recovery) — DEFERRED: the legacy token stays (record-token's fallback serves it), retried on a later run
    const matches = Object.keys(isObj(rec.attempts) ? rec.attempts : {}).sort().filter((a) => isObj(rec.attempts[a]) && rec.attempts[a].token_hash === h);
    const winOk = !!win && matches.includes(win);
    if (!winOk && matches.length > 1) { r.deferredAmbiguous += 1; continue; }
    const aid = winOk ? win : matches[0];
    if (!aid) { r.unmatched += 1; continue; }
    r.matched += 1;
    if (!apply) continue;
    const token = rec.token;
    if ((await require('../payments/sdk/record-token').stashToken(rtdb, oid, aid, token)) === 'conflict') { r.raced += 1; continue; }   // the write-ahead, CREATE-ONCE as a placement does
    let moved = false;
    await require('../payments/sdk/record').casRecord(rtdb, oid, (x) => {
      moved = false;
      if (x.token !== token) return undefined;   // a concurrent placement / null changed it: leave it
      x.token_attempt = aid; delete x.token; moved = true;
      return x;
    });
    if (moved) r.migrated += 1; else r.raced += 1;
  }
  return r;
}

module.exports = { migrate };

if (require.main === module) {
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // THE PROJECT GUARD, before any argument or credential
  const apply = process.argv.slice(2).includes('--apply');
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID, databaseURL: RTDB_URL });
  migrate({ rtdb: admin.database(), apply })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(`migrate-sdk-tokens: failed (${e && e.code ? e.code : 'error'})`); process.exit(1); });
}
