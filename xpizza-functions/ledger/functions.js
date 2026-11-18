'use strict';
// LEDGER S5 — the Cloud Function of the shadow ledger's nightly rebuild. index.js re-exports it on ONE line (inverse-fold invariant:
// tools/ledgers1-module-inverse.js). Deploy selectively: rebuildLedgerNightly.
//   rebuildLedgerNightly (schedule, 03:00 + 03:30 HN) — 03:00 is the run; 03:30 is the SAFETY slot: a no-op after a finished run,
//                        otherwise a restart from scratch (ledger/rebuild.js runNightly). One instance, no platform retry (the 03:30
//                        slot IS the retry); the 400-s cap sits well inside the 540-s timeout.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getDatabase } = require('firebase-admin/database');
const RB = require('./rebuild');

// the slot is decided by the Honduras minute of the start: before :15 ⇒ the run, else the safety slot
const slotOf = (t) => (new Date(t - 6 * 3600000).getUTCMinutes() < 15 ? 'run' : 'safety');

exports.rebuildLedgerNightly = onSchedule(
  { schedule: '0,30 3 * * *', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 540, memory: '512MiB', maxInstances: 1, concurrency: 1, retryCount: 0 },
  async () => {
    try { const r = await RB.runNightly({ db: getDatabase(), clock: Date.now }, { slot: slotOf(Date.now()) }); console.log('ledger_rebuild', JSON.stringify(r)); }
    catch (e) { console.error('ledger_rebuild_failed', (e && e.code) || 'error'); }   // a code only, never a message (no PII in logs)
  },
);
exports.slotOf = slotOf;
