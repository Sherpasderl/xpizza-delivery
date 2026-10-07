// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — the portal CORS allowlist, moved VERBATIM from index.js (its rationale
// comment stays at the import site there). Shared by index.js and portal/functions.js.
const PORTAL_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  'https://sherpa-portal.netlify.app',   // portal 2b-2a go-live (2026-09-08)
];

module.exports = { PORTAL_ORIGINS };
