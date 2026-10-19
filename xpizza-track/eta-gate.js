"use strict";
// ── eta-gate — WHEN the tracker may show minutes (F4 · PLAN-tracker-fixes §5 · BUILD-tracker-F4 §4) ──
//
// A pure function: no DOM, no clock of its own, no network. The tracker (index.html) owns every effect — the Directions
// requests, the sub-line, the expiry timer — and asks this module only whether the minutes may be shown, and until when.
//
// Minutes ("Llega en ~N min" / "Tu pedido está llegando") are shown ONLY when ALL hold:
//   • the order's live delivery is active on the page (`active`) and it has a finite location;
//   • that location's MEASURED time is under 90 s old by SERVER time (`nowLocal + serverOffset − loc.at`); before the
//     page knows the server offset, nothing is fresh;
//   • the route answer is the LATEST request's (`reqId`), under 120 s old by LOCAL time, for the SAME destination, and its
//     origin is under 200 m from the latest location sample supplied (not the animated marker). The 200 m matches the
//     tracker's request trigger (a move of ≥ 200 m sends a new request), so a request goes out exactly when its predecessor
//     stops counting.
// Both ages stay in their own clock domain; `remainingMs` is the time until the first of the two limits is reached (a duration,
// so the caller's timer needs no clock conversion). Boundaries are strict: at exactly 90 s / 120 s / 200 m it is not shown.
//
// The minutes are the route time rounded UP (no added dwell); 45 s or less is "Tu pedido está llegando".
// Same bytes load as a classic browser script AND a Node module (no ESM), like status-view.js.

const ETA_LOC_MAX_MS = 90000;
const ETA_RESULT_MAX_MS = 120000;
const ETA_ORIGIN_MAX_M = 200;

function etaMinutesText(travelSec) {
  return travelSec <= 45 ? 'Tu pedido está llegando' : `Llega en ~${Math.ceil(travelSec / 60)} min`;
}

// s: { active, loc: {lat, lng, at}, dest: {lat, lng}, result: {reqId, atLocal, origin, dest, travelSec} | null,
//      latestReqId, nowLocal, serverOffset, dist: (a, b) => metres }  →  { show, text, remainingMs }
function etaGate(s) {
  const off = { show: false, text: null, remainingMs: null };
  if (!s || !s.active) return off;
  const loc = s.loc;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || !Number.isFinite(loc.at)) return off;
  if (!Number.isFinite(s.serverOffset)) return off;
  const locAge = s.nowLocal + s.serverOffset - loc.at;
  if (!(locAge < ETA_LOC_MAX_MS)) return off;
  const r = s.result;
  if (!r || r.reqId !== s.latestReqId || !Number.isFinite(r.atLocal) || !Number.isFinite(r.travelSec)) return off;
  const resAge = s.nowLocal - r.atLocal;
  if (!(resAge < ETA_RESULT_MAX_MS)) return off;
  const dest = s.dest;
  if (!dest || !r.dest || r.dest.lat !== dest.lat || r.dest.lng !== dest.lng) return off;
  if (!r.origin || !(s.dist(r.origin, loc) < ETA_ORIGIN_MAX_M)) return off;
  return { show: true, text: etaMinutesText(r.travelSec), remainingMs: Math.min(ETA_LOC_MAX_MS - locAge, ETA_RESULT_MAX_MS - resAge) };
}

const EtaGate = { etaGate, etaMinutesText, ETA_LOC_MAX_MS, ETA_RESULT_MAX_MS, ETA_ORIGIN_MAX_M };
if (typeof module !== "undefined" && module.exports) module.exports = EtaGate;
if (typeof window !== "undefined") { window.EtaGate = EtaGate; }
