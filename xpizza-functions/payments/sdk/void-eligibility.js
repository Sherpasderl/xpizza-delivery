'use strict';
// PRODUCTION void eligibility — FAILS CLOSED until PixelPay/BAC answer §7.V in writing (the processing date, its timezone,
// the cutoff). Every leg is "not void-eligible": a cancellation tracks the hold to its 15-day expiry and a decrease takes
// rule 4. The coordinator receives this through deps.voidEligible; nothing in production passes another implementation.
function voidEligible(/* leg, now */) { return false; }
module.exports = { voidEligible };
