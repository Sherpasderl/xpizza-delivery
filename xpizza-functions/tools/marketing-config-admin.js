#!/usr/bin/env node
'use strict';
// PLAN-3a-marketing-server r0 §2.6 / §5 — the OWNER's marketing-config CLI: the three switches, the Anuncio price and the thresholds
// at platform_config/marketing. DRY RUN unless --apply. One version-CAS write (marketing/config writeMarketingConfig).
//   node tools/marketing-config-admin.js --project <id> show
//   node tools/marketing-config-admin.js --project <id> set --expected <policy_version> --config '<json>' [--apply]
//     <json> = { offers_enabled, anuncio_enabled, collections_enabled, anuncio_price_cents, thresholds: { rating_min, min_ratings } }
// No brand literal; no PII (switches, a price and two thresholds only). --project must be the explicit flag.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const CFG = require('../marketing/config');

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const sub = argv.find((a) => a === 'show' || a === 'set');
if (!sub) { console.error('marketing-config-admin: REFUSED — show | set'); process.exit(2); }

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const db = admin.database();

(async () => {
  console.log(`marketing-config-admin ${sub} ${sub === 'show' ? 'READ-ONLY' : argv.includes('--apply') ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}`);
  if (sub === 'show') {
    const c = await CFG.readMarketingConfig(db);
    console.log(JSON.stringify(c, null, 2));
    process.exit(c.unavailable ? 1 : 0);
  }
  const expected = Number(flag('--expected'));
  let config;
  try { config = JSON.parse(flag('--config') || ''); } catch (_) { console.error('marketing-config-admin: REFUSED — --config is not JSON'); process.exit(2); }
  const r = await CFG.writeMarketingConfig(db, { expected, config, actor: 'cli:owner', now: Date.now(), dryRun: !argv.includes('--apply') });
  console.log(JSON.stringify(r));
  if (r.ok && r.dry_run) console.log('(dry run — nothing written; add --apply)');
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('marketing-config-admin FAILED:', e && e.message); process.exit(1); });
