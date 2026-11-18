'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1 §2 «quote» row; r2 §1/§2) — resolveAudience: the customer's KIND at the quote's brand.
//   Called only for an audience-exposed quote (program ON and ≥ 1 audience offer in the rid's mirror — offer-wire decides); everything
//   else costs +0. TWO rounds, all reads parallel inside a round, least privilege (leaves, never the private node):
//     1. user_profiles/{uid}/phone_hash ∥ user_private/{uid}/email ∥ user_private/{uid}/email_verified ∥ user_orders/{uid}
//        orderByChild('ts').limitToLast(50);
//     2. the brand of each DISTINCT fulfilled history rid (marketing/brand-of, per-instance cache) ∥ customer_seen/{brand}/{h} per code.
//   NEW ⇔ no fulfilled order at the brand in that window AND no live marker (m ≥ the 24-month cutoff; an expired marker the sweep has not
//   reached yet never makes anyone RETURNING). Any read failure / no uid / no brand / no key / nothing verified ⇒ kind 'none' (no audience
//   offer; the price seen is the price paid — r2 §3, never an UNKNOWN hold). Logs a code only — no uid / phone / email / code.
// → { kind: 'new' | 'returning' | 'none', ids: { p?, e?, kv } | null, brandId | null }
const AC = require('./audience-core');
const BO = require('./brand-of');

const HISTORY_MAX = 50;
const NONE = Object.freeze({ kind: 'none', ids: null, brandId: null });
const codeOf = (e) => (e && e.code != null ? String(e.code).slice(0, 40) : 'unknown');
const val = async (q) => (await q.once('value')).val();

async function resolveAudience(db, { uid, rid, key, nowMs, log = console }) {
  if (typeof uid !== 'string' || !uid) return NONE;
  try {
    const brandId = await BO.brandOf(db, rid, { nowMs, cached: true });
    if (!brandId) return NONE;
    const [phoneHash, email, emailVerified, hist] = await Promise.all([
      val(db.ref(`user_profiles/${uid}/phone_hash`)),
      val(db.ref(`user_private/${uid}/email`)),
      val(db.ref(`user_private/${uid}/email_verified`)),
      val(db.ref(`user_orders/${uid}`).orderByChild('ts').limitToLast(HISTORY_MAX)),
    ]);
    const ids = AC.idsOf({ key, brandId, phoneHash, email, emailVerified });
    if (!ids) return NONE;
    const rows = hist && typeof hist === 'object' ? Object.values(hist) : [];
    const rids = [...new Set(rows.filter((r) => r && AC.FULFILLED.includes(r.status) && typeof r.restaurant === 'string' && r.restaurant).map((r) => r.restaurant))];
    const cutoff = AC.cutoffMonth(nowMs);
    const live = (m) => !!m && typeof m === 'object' && typeof m.m === 'string' && cutoff !== null && m.m >= cutoff;
    const codes = ['p', 'e'].filter((k) => ids[k]);
    const [brands, marks] = await Promise.all([
      Promise.all(rids.map(async (r) => { const b = await BO.brandOf(db, r, { nowMs, cached: true }); if (b === null) { const e = new Error('brand'); e.code = 'history_brand'; throw e; } return [r, b]; })),
      Promise.all(codes.map(async (k) => [k, live(await val(db.ref(`customer_seen/${brandId}/${ids[k]}`)))])),
    ]);
    const kind = AC.kindOf({ brandId, rows, brandOfRid: Object.fromEntries(brands), markers: Object.fromEntries(marks) });
    return { kind, ids, brandId };
  } catch (e) {
    try { log.warn('audience_unavailable', JSON.stringify({ rid, code: codeOf(e) })); } catch (_) {}
    return NONE;
  }
}

module.exports = { resolveAudience, HISTORY_MAX };
