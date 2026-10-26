'use strict';
// ORCHESTRATION O1b T5 (DECISIONS 2026-10-25 Q10) — the branch phone IS the store WhatsApp: a Honduran MOBILE, exactly as sent
// (the UI normalises — the server never trims or reformats). Used by the portal E6 / E7 only; the Sherpa CLI keeps O1a's E.164.
const HN_MOBILE = /^\+504[3789]\d{7}$/;
const isHnMobile = (v) => typeof v === 'string' && HN_MOBILE.test(v);
module.exports = { HN_MOBILE, isHnMobile };
