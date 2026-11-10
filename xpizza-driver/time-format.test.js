// time-format.test.js — the shared clock formatter. Spec: es-HN, hour:'numeric' (no leading zero for the afternoon),
// minute:'2-digit', hour12:false (24h convention, matching the approved cuadre date line + the disponible header).
import assert from 'node:assert/strict';
import { fmtClockHM } from './time-format.js';
let passed = 0; const t = (n, f) => { f(); passed += 1; };

t('24h, 2-digit hour + minute (es-HN · hour12:false — the exact string the cuadre date line produces)', () => {
  // es-HN hour:'numeric' hour12:false renders a 2-digit hour («07:16», not «7:16»); the mockup's hand-written «7:16»
  // is cosmetic — the advisor ruled consistency with the APPROVED cuadre formatter wins, and this IS that formatter.
  assert.match(fmtClockHM(new Date(2026, 9, 27, 7, 16).getTime()), /^07:16$/);
  assert.match(fmtClockHM(new Date(2026, 9, 27, 15, 30).getTime()), /^15:30$/);
  assert.match(fmtClockHM(new Date(2026, 9, 27, 9, 5).getTime()), /^09:05$/);
});
t('matches the cuadre spec exactly (same Intl options)', () => {
  const ms = Date.now();
  assert.equal(fmtClockHM(ms), new Date(ms).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: false }));
});
console.log(`✓ time-format: ${passed} tests passed`);
