'use strict';
// PLAN-3a-capp-sponsored-read r0 (advisor APPROVED 11-14; Q6, DARK) — the «Patrocinado» home read, for the directory's owner (5f) to
// inject as readSponsored: sponsoredOf(deps) → { rid } | null. Platform-wide (ONE slot per HN week). A READ only — no money, no ledger.
//   { rid } only while ALL hold: platform_config/marketing.anuncio_enabled (its ONE reader); the current HN week's slot names a
//   booking that is ACTIVE (not cancelled; its week is now); and that branch is visible NOW by THE rule (anuncio-model
//   anuncioVisible: the public rating AND ops-core controlOf open — not paused, not closed by its hours, not inactive). Anything
//   else — off, no booking, hidden, a malformed node, an outage, a timeout — is null. The caller emits `sponsored` only when non-null
//   AND the rid is one of its own listed rows (the directory stays the ONE «listed» authority).
// Never failing, never blocking: catalog/serve-memo (the offers read's numbers) keyed by the HN WEEK, so the rollover at Monday 00:00
// HN reads the new week at once; the reads are memoized, the visibility is judged at serve time (hours exact per request; a pause
// stale ≤ the memo).
const CFG = require('./config');
const AM = require('./anuncio-model');
const { isBrandId } = require('../brands/brand-model');

const OK_TTL_MS = 60 * 1000;
const FAIL_TTL_MS = 30 * 1000;
const STALE_MAX_MS = 5 * 60 * 1000;
const SPONSORED_TIMEOUT_MS = 1500;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// the read behind the memo, for ONE week → { on:false, week } | { on:true, week, rid:null } | { on:true, week, rid, booking, stats,
// identity, control, thresholds }. A config outage THROWS (a failed read: nothing served), never a guessed «on».
async function readSponsored(week, deps) {
  const db = deps.rtdb || require('firebase-admin/database').getDatabase();
  const val = async (p) => (await db.ref(p).once('value')).val();
  const cfg = await CFG.readMarketingConfig(db);
  if (cfg.unavailable) throw new Error('sponsored_config_unavailable');
  if (cfg.anuncio_enabled !== true) return { on: false, week };
  const slot = await val(`anuncio_slots/${week}`);
  if (!isObj(slot) || !isBrandId(slot.rid) || !AM.BOOKING_ID_RE.test(String(slot.booking_id))) return { on: true, week, rid: null };
  const rid = slot.rid;
  const [booking, stats, identity, control] = await Promise.all([val(`anuncio_bookings/${rid}/${slot.booking_id}`), val(`public_stats/${rid}`),
    val(`restaurants/${rid}/identity`), val(`order_control/${rid}/current`)]);
  return { on: true, week, rid, booking, stats, identity, control, thresholds: cfg.thresholds };
}
const SM = require('../catalog/serve-memo').createServeMemo({ okTtlMs: OK_TTL_MS, failTtlMs: FAIL_TTL_MS, staleMaxMs: STALE_MAX_MS,
  timeoutMs: SPONSORED_TIMEOUT_MS, timeoutError: 'sponsored_timeout', absentLog: 'directory_sponsored_absent', defaultRead: readSponsored });

// a memoized read → { rid } | null, judged at nowMs
function sponsoredFrom(raw, nowMs) {
  if (!isObj(raw) || raw.on !== true || raw.week !== AM.weekOf(nowMs) || !isBrandId(raw.rid)) return null;
  const b = raw.booking;
  if (!isObj(b) || b.rid !== raw.rid || b.week !== raw.week || AM.bookingStatus(b, nowMs) !== 'active') return null;
  if (!AM.anuncioVisible({ stats: raw.stats, identity: raw.identity, control: raw.control, thresholds: raw.thresholds, nowMs }).visible) return null;
  return { rid: raw.rid };
}

// the directory's hook. Never throws, never awaits.
function sponsoredOf(deps = {}) {
  try {
    const nowMs = deps.now ? deps.now() : Date.now();
    const m = SM.memoFor(AM.weekOf(nowMs), deps);
    return m ? sponsoredFrom(m.raw, nowMs) : null;
  } catch (_) { return null; }
}

module.exports = { sponsoredOf, sponsoredFrom, OK_TTL_MS, FAIL_TTL_MS, STALE_MAX_MS, SPONSORED_TIMEOUT_MS, _state: SM.state };
