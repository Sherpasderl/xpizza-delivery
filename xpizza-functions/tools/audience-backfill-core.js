'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1 §5, r2 §2; rule 23) — the OWNER's marker backfill core. Every delivered / completed order,
// read in pages by key (≤ pageSize per read), marks its brand with the codes of its identity — the SAME rules as the live writer
// (marketing/audience-writer codesOf: the frozen codes, else a card guest's verified phone, else the member's CURRENT verified identity) —
// at the order's OWN fulfilment month (delivered_at / completed_at, else created_at): never «now», never below the 24-month cutoff.
// The writer's own monotonic mark ⇒ a re-run renews nothing and it commutes with the live writer. apply:false (the default) writes
// nothing. Counts only — no uid, phone, email or code is ever returned or logged.
const AC = require('../marketing/audience-core');
const BO = require('../marketing/brand-of');
const AW = require('../marketing/audience-writer');

const PAGE = 500;
const fulfilledAt = (o) => [o.delivered_at, o.completed_at, o.created_at].find((t) => Number.isSafeInteger(t) && t > 0) || null;

async function runBackfill(db, { key, nowMs, apply = false, pageSize = PAGE, log = console }) {
  if (typeof key !== 'string' || key.length < AC.KEY_MIN) throw new Error('audience-backfill: AUDIENCE_KEY_V1 missing or too short (fail-closed)');
  const cutoff = AC.cutoffMonth(nowMs);
  const out = { scanned: 0, fulfilled: 0, marked: 0, skipped: { pre_cutoff: 0, no_identity: 0, brand_unresolved: 0 }, byBrand: {} };
  let cursor = null;
  for (;;) {
    let q = db.ref('orders').orderByKey();
    if (cursor !== null) q = q.startAfter(cursor);
    const page = (await q.limitToFirst(pageSize).once('value')).val() || {};
    const ids = Object.keys(page).sort();
    for (const id of ids) {
      const o = page[id]; out.scanned += 1;
      if (!o || !AC.FULFILLED.includes(o.status)) continue;
      out.fulfilled += 1;
      const at = fulfilledAt(o); const month = AC.hnMonthOf(at);
      if (month === null || month < cutoff) { out.skipped.pre_cutoff += 1; continue; }
      const brandId = await BO.brandOf(db, o.restaurant_id, { nowMs, cached: true });
      if (!brandId) { out.skipped.brand_unresolved += 1; continue; }
      const codes = await AW.codesOf(db, { audience_ids: o.audience_ids == null ? null : o.audience_ids, customer_uid: o.customer_uid == null ? null : o.customer_uid, 'guest_verified/phone_hash': o.guest_verified && o.guest_verified.phone_hash ? o.guest_verified.phone_hash : null }, brandId, key);
      if (!codes) { out.skipped.no_identity += 1; continue; }
      out.marked += 1; out.byBrand[brandId] = (out.byBrand[brandId] || 0) + 1;
      if (apply) for (const h of ['p', 'e'].filter((k) => codes[k]).map((k) => codes[k])) await AW.mark(db, brandId, h, month);
    }
    if (ids.length < pageSize) break;
    cursor = ids[ids.length - 1];
  }
  try { log.log('audience_backfill', JSON.stringify({ apply, cutoff, scanned: out.scanned, fulfilled: out.fulfilled, marked: out.marked, skipped: out.skipped, byBrand: out.byBrand })); } catch (_) {}
  return out;
}

module.exports = { runBackfill, PAGE };
