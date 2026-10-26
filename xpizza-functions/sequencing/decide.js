'use strict';
// BUILD-stacked-seq-server r2 T2 (unchanged through r5) — which stop goes first, decided ONCE at offer time, never reordered.
//
// I = the incumbent, N = the new order; legs in SECONDS: HI / HN hub → customer, IN / NI customer → customer; h = the handoff
// time at the first door. With T = the common departure (max(now, readyI, readyN)):
//   I-first: arrI = T+HI, arrN = T+HI+h+IN  → the second customer's delay plusN = HI + h + IN − HN
//   N-first: arrN = T+HN, arrI = T+HN+h+NI  → plusI = HN + h + NI − HI
// The driver → hub leg is common to both sequences and cancels, so T needs no driver leg.
// Candidates: plus ≤ 360 s (D2, UNROUNDED). The lower arrival sum wins; a tie goes to I-first (the incumbent's order time).
const H_S = 120;          // D8
const PLUS_MAX_S = 360;   // D2: +6 min

const legOk = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function decide({ legs, h = H_S } = {}) {
  if (!legs || !['HI', 'HN', 'IN', 'NI'].every((k) => legOk(legs[k]))) return { stack: false, reason: 'invalid_legs' };
  const { HI, HN, IN, NI } = legs;
  const iFirst = { first: 'I', second: 'N', plus_s: HI + h + IN - HN, sum: 2 * HI + h + IN };
  const nFirst = { first: 'N', second: 'I', plus_s: HN + h + NI - HI, sum: 2 * HN + h + NI };
  const fits = [iFirst, nFirst].filter((c) => c.plus_s <= PLUS_MAX_S);
  if (!fits.length) return { stack: false, reason: 'over_6min' };
  const best = fits.length === 2 && nFirst.sum < iFirst.sum ? nFirst : fits[0];
  return { stack: true, first: best.first, second: best.second, plus_s: best.plus_s, plus_min: Math.ceil(best.plus_s / 60) };
}

module.exports = { decide, H_S, PLUS_MAX_S };
