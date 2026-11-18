'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1 §5, BRIEF §5; rule 39 bounded sweeps) — the two scheduled, BOUNDED, RESUMABLE cleanups.
//   expireMarkers(db, { nowMs, limit }): the 24-month retention (owner DECISIONS:5013). For each brand (the brands registry's keys), the flat
//     month index customer_seen_m/{brand} read with orderByKey().endBefore(<cutoff month>).limitToFirst(<budget left>) — the oldest overdue
//     entries across EVERY overdue month; for each `<YYYY-MM>_<h>`: the marker customer_seen/{brand}/{h} is deleted ONLY if its m still
//     equals that month (a transaction — a refreshed customer survives), then the entry. ≤ limit entries per run in total; an unfinished
//     backlog continues next run.
//   expireIds(db, { nowMs, limit }): the audience_ids deadline — audience_ids_by_day read with orderByKey().endBefore(<today − 30 d>)
//     .limitToFirst(limit), WHATEVER the order's status (a stuck order needs its own limit: escalation only changes payment_status). For an
//     order whose frozen offer is audience 'new' (incl. nuevos): FIRST the create-if-absent decision orders/{id}/offer_reconcile =
//     { funded_by: 'sherpa', reason: 'ids_expired', at } (never overwriting one), THEN the codes + the entry in one update.
// Logs counts only.
const AC = require('./audience-core');

const DEADLINE_DAYS = 30;     // r4.1 §5 (a recommendation the owner may change)
const LIMIT = 500;            // entries per run (each sweep)
const val = async (db, p) => (await db.ref(p).once('value')).val();

async function expireMarkers(db, { nowMs, limit = LIMIT, log = console }) {
  const cutoff = AC.cutoffMonth(nowMs);
  if (cutoff === null) throw new Error('audience sweep: no clock');
  const brands = Object.keys((await val(db, 'brands')) || {}).sort();
  let budget = limit; let scanned = 0; let deleted = 0;
  for (const b of brands) {
    if (budget <= 0) break;
    const page = (await db.ref(`customer_seen_m/${b}`).orderByKey().endBefore(cutoff).limitToFirst(budget).once('value')).val() || {};
    for (const k of Object.keys(page).sort()) {
      const kp = AC.keyParts(k);
      budget -= 1; scanned += 1;
      if (kp) {
        let hit = false;
        await db.ref(`customer_seen/${b}/${kp.id}`).transaction((cur) => { hit = false; if (cur === null) return null; if (cur.m !== kp.date) return undefined; hit = true; return null; });
        if (hit) deleted += 1;
      }
      await db.ref(`customer_seen_m/${b}/${k}`).remove();
    }
  }
  try { log.log('audience_marker_sweep', JSON.stringify({ scanned, deleted, cutoff })); } catch (_) {}
  return { scanned, deleted };
}

async function expireIds(db, { nowMs, limit = LIMIT, log = console }) {
  const before = AC.dayBefore(nowMs, DEADLINE_DAYS);
  if (before === null) throw new Error('audience sweep: no clock');
  const page = (await db.ref('audience_ids_by_day').orderByKey().endBefore(before).limitToFirst(limit).once('value')).val() || {};
  let deleted = 0; let decided = 0;
  for (const k of Object.keys(page).sort()) {
    const kp = AC.keyParts(k);
    if (!kp) { await db.ref(`audience_ids_by_day/${k}`).remove(); continue; }
    const id = kp.id;
    if ((await val(db, `orders/${id}/offer/audience`)) === 'new') {
      let made = false;
      await db.ref(`orders/${id}/offer_reconcile`).transaction((cur) => { if (cur !== null) { made = false; return undefined; } made = true; return { funded_by: 'sherpa', reason: 'ids_expired', at: nowMs }; });
      if (made) decided += 1;
    }
    await db.ref().update({ [`orders/${id}/audience_ids`]: null, [`audience_ids_by_day/${k}`]: null });
    deleted += 1;
  }
  try { log.log('audience_ids_sweep', JSON.stringify({ deleted, decided, before })); } catch (_) {}
  return { deleted, decided };
}

module.exports = { expireMarkers, expireIds, DEADLINE_DAYS, LIMIT };
