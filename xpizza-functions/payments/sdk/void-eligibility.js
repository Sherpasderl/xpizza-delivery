'use strict';
// PRODUCTION void eligibility for ADJUSTMENTS — FAILS CLOSED: every leg is "not void-eligible", so a decrease takes rule 4.
// The coordinator receives this through deps.voidEligible; nothing in production passes another implementation. A CANCEL uses
// its own rule below (deps.cancelVoidEligible).
function voidEligible(/* leg, now */) { return false; }

// CANCEL ONLY (owner 2026-11-10 «release it right away when possible»; PixelPay answers Q4/Q6): a cancelled order's hold is voided
// when it is still voidable — the same Honduras day it was authorized, before the 22:00 batch cut with a 10-minute margin (the last
// void starts before 21:50). Any other hold expires on its own and is never captured. The hold's time is its leg's journal time
// (the auth is journaled immediately before the PSP call). Adjustments never use this rule.
const HN_OFFSET_MS = -6 * 3600 * 1000;      // America/Tegucigalpa: UTC−6, no daylight saving
const DAY_MS = 24 * 3600 * 1000;
const VOID_CUTOFF_MIN = 21 * 60 + 50;       // 21:50 local
const hnDay = (ms) => Math.floor((ms + HN_OFFSET_MS) / DAY_MS);
const hnMinute = (ms) => Math.floor((((ms + HN_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60000);
function cancelVoidEligible(leg, now) {
  const at = leg && leg.created_at;
  if (!Number.isFinite(at) || !Number.isFinite(now) || now < at) return false;
  return hnDay(at) === hnDay(now) && hnMinute(now) < VOID_CUTOFF_MIN;
}
module.exports = { voidEligible, cancelVoidEligible, VOID_CUTOFF_MIN };
