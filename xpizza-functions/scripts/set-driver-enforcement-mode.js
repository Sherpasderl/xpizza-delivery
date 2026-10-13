#!/usr/bin/env node
/**
 * Set the driver-eligibility enforcement mode at platform_config/driver_enforcement_mode (PLAN-S1 §14).
 *   'tolerant'  → removes the key (absent = tolerant = the S1a-dark default; a missing account is legacy-allowed)
 *   'closed'    → enforces the §2 invariant — REFUSED unless lib/driver-flip-prep.FLIP_PREP_READY is true, so the
 *                 flip can never outrun the deferred §13 reader filtering.
 *
 * DRY-RUN by default; pass --apply to write. Server-only (platform_config is .write:false) → unrestricted Admin.
 *
 *   node scripts/set-driver-enforcement-mode.js <tolerant|closed>            # dry run
 *   node scripts/set-driver-enforcement-mode.js <tolerant|closed> --apply    # write
 */
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { decideEnforcementWrite } = require('../lib/driver-flip-prep');

(async () => {
  const apply = process.argv.includes('--apply');
  const mode = process.argv.slice(2).find((a) => a !== '--apply');
  // Mixed/foreign emulator signals ⇒ refuse before any client; no signal ⇒ the intended production write proceeds.
  require('../tools/emu-mixed-guard')('set-driver-enforcement-mode');

  const decision = decideEnforcementWrite(mode);
  if (!decision.ok) { console.error(`REFUSED: ${decision.reason}`); process.exit(2); }

  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} · enforcement mode → ${mode} (writes ${JSON.stringify(decision.value)} at platform_config/driver_enforcement_mode)`);
  if (!apply) { console.log('dry run complete — pass --apply to write'); process.exit(0); }

  initializeApp({ databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com' });
  const ref = getDatabase().ref('platform_config/driver_enforcement_mode');
  if (decision.value === null) await ref.remove(); else await ref.set(decision.value);
  console.log(`done: enforcement mode is now ${mode}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
