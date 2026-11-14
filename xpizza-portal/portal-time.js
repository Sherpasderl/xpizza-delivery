// THE portal clock (advisor 11-13): ONE 12-hour formatter for the whole portal, the customer app's «p. m.» form (capp-order.js /
// form-live-status.js): «3:10 p. m.», «12:05 a. m.». Honduras time (UTC-6 all year, no DST — the server's clock). Inicio reads it;
// Sucursales' 24 h strings (branch-logic hhmm) move to it in the Figtree text-fit pass. Its own module: branch-logic.js is frozen
// byte-for-byte to its 1a base (branches-1b's W-OFF oracle composes it).
const HN_OFFSET_MS = 6 * 3600 * 1000;
export function clock12(ms) {
  if (!Number.isFinite(ms)) return '';
  const t = new Date(ms - HN_OFFSET_MS);
  const h = t.getUTCHours();
  return `${(h % 12) || 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h >= 12 ? 'p. m.' : 'a. m.'}`;
}
