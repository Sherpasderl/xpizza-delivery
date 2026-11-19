'use strict';
// card-cleanup (owner UNPARKED 11-18; PLAN-card-token-cleanup «PLAN DELTA» (1)–(7)) — the ONE provider-delete queue,
// provider_token_deletes/{sha256(token)} = { token, sources: { <src>: { aid, uid, at } }, tries?, next_at?, ok_at? } (server-only; rules
// deny). Keyed by the token's hash, so the same token arriving from an order and from a saved card is ONE item. Producers never write the
// path themselves: they ride enqueueEntries() in their own atomic update (record-token.enqueueAndDrop — the node is never dropped
// without its handle). THIS module is the only code that names the queue path (record-token.guard RT-QUEUE).
//
// drainProviderDeletes — bounded (key-order pages behind a rotating cursor), run by the SDK sweeper:
//   • INERT while the SDK config is unconfigured / off (deps.ppNamespace 'unconfigured'): no provider call; items stay; ONE create-once
//     alert if any item exists (SDK go-live gate GL-1/GL-2 in the plan).
//   • per item: the OWNERSHIP re-check first — a live saved card (customer_cards/{uid}/by_hash/{hash}) or another order's live node
//     (record-token.hasLiveRefs) keeps the token: the item is closed «owned» with NO provider call (the owner keeps the handle).
//   • the probe rule (Q1/Q2): 200 ⇒ record OUR 200 (ok_at), then remove; 400 on a first try ⇒ UNKNOWN: kept, retried with backoff,
//     alerted; 400 after OUR recorded 200 ⇒ absent ⇒ remove; 401 / 403 ⇒ STOP the whole drain + one alert (keys); anything else (timeout,
//     5xx, no status) ⇒ UNKNOWN, retried with backoff, alerted after MAX_TRIES. Logs and alerts: fixed codes and counts only.
const crypto = require('crypto');
const ROOT = 'provider_token_deletes';
const CURSOR = 'provider_token_deletes_cursor';
const BATCH = 25;
const MAX_TRIES = 5;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const backoffMs = (tries) => Math.min(24 * 3600 * 1000, 10 * 60 * 1000 * 2 ** Math.max(0, tries - 1));

// the multi-path entries that queue one token for one source — for the CALLER's atomic update
function enqueueEntries(token, srcKey, src) {
  const h = hashOf(token);
  return { [`${ROOT}/${h}/token`]: token, [`${ROOT}/${h}/sources/${srcKey}`]: src };
}

async function owned(deps, h, it) {
  if (await require('./record-token').hasLiveRefs(deps.db, h)) return true;   // another order's live node still holds it
  for (const s of Object.values(isObj(it.sources) ? it.sources : {})) {
    if (isObj(s) && typeof s.uid === 'string' && s.uid && (await deps.db.ref(`customer_cards/${s.uid}/by_hash/${h}`).once('value')).exists()) return true;   // a live saved card
  }
  return false;
}

async function page(db, batch) {
  const cur = (await db.ref(CURSOR).once('value')).val();
  const get = async (after) => { const q = db.ref(ROOT).orderByKey(); const v = (await (after ? q.startAt(after).limitToFirst(batch + 1) : q.limitToFirst(batch)).once('value')).val() || {}; return Object.entries(v).filter(([k]) => k !== after).slice(0, batch); };
  let rows = await get(typeof cur === 'string' ? cur : null);
  if (!rows.length && typeof cur === 'string') rows = await get(null);   // past the end: wrap
  await db.ref(CURSOR).set(rows.length === batch ? rows[rows.length - 1][0] : null);   // a short page ends the lap
  return rows;
}

async function drainProviderDeletes(deps, { batch = BATCH } = {}) {
  const C = require('./coordinator');
  const out = { done: 0, owned: 0, absent: 0, unknown: 0, failed: 0, stopped: false, inert: false };
  if (deps.ppNamespace === 'unconfigured') {
    out.inert = true;
    const any = (await deps.db.ref(ROOT).orderByKey().limitToFirst(1).once('value')).exists();
    if (any) await C.alertOnce(deps, 'provider_delete_unconfigured', 'queue', {});
    return out;
  }
  const now = deps.clock();
  for (const [h, it] of await page(deps.db, batch)) {
    if (!isObj(it) || typeof it.token !== 'string' || !it.token) continue;
    if (Number.isFinite(it.next_at) && it.next_at > now) continue;
    try {
      if (await owned(deps, h, it)) { await deps.db.ref(`${ROOT}/${h}`).remove(); out.owned += 1; continue; }
      const r = await deps.psp.pspDeleteToken({ token: it.token });
      if (r.status === 200 && r.success === true) {
        await deps.db.ref(`${ROOT}/${h}/ok_at`).set(now);   // OUR 200 recorded first: a later 400 then means «absent»
        await deps.db.ref(`${ROOT}/${h}`).remove(); out.done += 1;
      } else if (r.status === 400 && Number.isFinite(it.ok_at)) {
        await deps.db.ref(`${ROOT}/${h}`).remove(); out.absent += 1;
      } else if (r.status === 401 || r.status === 403) {
        await C.alertOnce(deps, 'provider_delete_auth', 'queue', {}); out.stopped = true; break;
      } else {
        const tries = (Number.isInteger(it.tries) ? it.tries : 0) + 1;
        await deps.db.ref(`${ROOT}/${h}`).update({ tries, next_at: now + backoffMs(tries), last_status: Number.isInteger(r.status) ? r.status : 0 });
        if (r.status === 400 || tries >= MAX_TRIES) await C.alertOnce(deps, 'provider_delete_unknown', 'queue', {});
        out.unknown += 1;
      }
    } catch (_) { out.failed += 1; }   // one item never blocks the page; no identifier in any log
  }
  return out;
}

module.exports = { enqueueEntries, drainProviderDeletes, hashOf, ROOT, MAX_TRIES };
