// Customer app version (owner, 2026-10-24) — the driver app's pattern (its SYSTEM_VERSION constant). BUMP on EVERY release that
// ships; pre-launch stays 0.x; 1.0.0 at launch. Shown only as a muted «vX.Y.Z» line at the bottom of Cuenta (S7).
(function (root) {
  const SYSTEM_VERSION = '0.1.0';
  if (typeof module === 'object' && module.exports) module.exports = { SYSTEM_VERSION };
  else root.CAPP_SYSTEM_VERSION = SYSTEM_VERSION;
})(typeof self !== 'undefined' ? self : this);
