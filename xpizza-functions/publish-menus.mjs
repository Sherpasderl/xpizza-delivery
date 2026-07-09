'use strict';
// ── publish-menus — OWNER-RUN publisher for the menu manifests → Firebase /menus/{rid} ───────────
// (KDS Phase 2b · Slice 2 · KDS_2B_PLAN.md §3 "Publish is an explicit owner-run script that regenerates
//  from the forms and refuses to publish if the golden fails.")
//
// Flow (safe by default):
//   1. Regenerate menus/*.json from the order forms (build-menus.mjs — READ-ONLY on the forms).
//   2. Run the keys-golden (menus.test.mjs). If it FAILS → non-zero exit, NOTHING is written to Firebase.
//   3. DEFAULT = dry-run: validates + prints what WOULD publish, writes nothing to Firebase.
//      With --commit: writes each manifest to Firebase /menus/{rid} (an OWNER action, like a deploy).
//
// The Firebase write is guarded behind --commit and needs admin creds + DB URL (same pattern as
// seed_identity.js): GOOGLE_APPLICATION_CREDENTIALS (applicationDefault) + optional FB_DATABASE_URL
// (defaults to the prod RTDB). Run from xpizza-functions/:
//   node publish-menus.mjs            # dry-run: regenerate + golden, no Firebase write
//   node publish-menus.mjs --commit   # owner: after golden passes, write /menus/{rid}
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RESTAURANT_IDS, extractManifest } from './menu-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const DB_URL = process.env.FB_DATABASE_URL || 'https://xpizza-delivery-default-rtdb.firebaseio.com';

function runStep(label, file) {
  console.log(`[publish] ${label} …`);
  const r = spawnSync(process.execPath, [join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[publish] ABORT — ${label} failed (exit ${r.status}). Nothing published.`);
    process.exit(1);
  }
}

async function main() {
  // 1) Regenerate the committed manifests from the forms, then 2) gate on the keys-golden.
  runStep('regenerate manifests (build-menus)', 'build-menus.mjs');
  runStep('keys-golden (menus.test)', 'menus.test.mjs');

  // Extract the exact payloads we'd publish (in-memory — same extractor the golden just validated).
  const manifests = Object.fromEntries(RESTAURANT_IDS.map((rid) => [rid, extractManifest(rid)]));

  if (!COMMIT) {
    for (const rid of RESTAURANT_IDS) console.log(`[publish] DRY-RUN would write /menus/${rid} (${manifests[rid].length} items)`);
    console.log('[publish] dry-run OK — re-run with --commit to publish to Firebase.');
    process.exit(0);
  }

  // 3) --commit: write to Firebase /menus/{rid}. Owner action; needs admin creds (like a deploy).
  const require = createRequire(import.meta.url);
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL });
  const db = admin.database();
  for (const rid of RESTAURANT_IDS) {
    await db.ref(`menus/${rid}`).set(manifests[rid]);
    console.log(`[publish] wrote /menus/${rid} (${manifests[rid].length} items) → ${DB_URL}`);
  }
  console.log('[publish] done');
  process.exit(0);
}

main().catch((e) => { console.error('[publish] ERROR', e); process.exit(1); });
