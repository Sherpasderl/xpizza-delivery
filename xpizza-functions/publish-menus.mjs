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

  // The code-derived payloads (the same extractor the golden just validated) — now the YARDSTICK, not the source.
  const manifests = Object.fromEntries(RESTAURANT_IDS.map((rid) => [rid, extractManifest(rid)]));

  /* 1D add-product A §0.4/§0b.3 — the manifest is derived from the ACTIVE CATALOG (the same authority publishEdited
     and rollback-version write from), through the ONE conditional writer (catalog/kds-manifest.js): stamped with the
     active generation, and a no-op when a newer generation is already stored. Products added in the portal are in the
     active catalog, so they get their KDS rows; with no additions the rows equal the code-derived ones (golden). */
  const require = createRequire(import.meta.url);
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL });
  const fs = admin.firestore();
  const { getActivePointer } = require('./catalog/catalog-firestore');
  const { previewVersion } = require('./catalog/catalog-publish');
  const { writeKdsManifest } = require('./catalog/kds-manifest');
  const { generateKdsManifest } = require('./catalog/generate-form-bundle');
  for (const rid of RESTAURANT_IDS) {
    const ptr = await getActivePointer(fs, rid);
    if (!ptr || !ptr.version) { console.log(`[publish] ${rid}: no active version — skipped`); continue; }
    const items = (await previewVersion(fs, rid, ptr.version)).items;
    const live = generateKdsManifest(rid, { items });
    const extra = live.filter((r) => !manifests[rid].some((c) => c.key === r.key)).map((r) => r.key);
    console.log(`[publish] ${rid}: active ${ptr.version}@${ptr.generation} → ${live.length} rows (${extra.length ? `not in code: ${extra.join(', ')}` : 'identical keys to the code-derived manifest'})`);
    if (!COMMIT) continue;
    const r = await writeKdsManifest(admin.database(), rid, { catalog: { items }, generation: ptr.generation, versionId: ptr.version });
    console.log(`[publish] ${rid}: ${r.written ? 'wrote /menus/' + rid : 'NOT written (' + r.reason + ')'} → ${DB_URL}`);
  }
  console.log(COMMIT ? '[publish] done' : '[publish] dry-run OK — re-run with --commit to publish to Firebase.');
  process.exit(0);
}

main().catch((e) => { console.error('[publish] ERROR', e); process.exit(1); });
