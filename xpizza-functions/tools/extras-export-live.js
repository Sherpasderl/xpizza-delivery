#!/usr/bin/env node
'use strict';
// PER-PRODUCT EXTRAS — GATE 0 on LIVE data: a READ-ONLY export for the advisor's run (PLAN rev 2.1 §13 gate 0).
// Writes two local files per restaurant:
//   <out>/<rid>.source.json — the ACTIVE published version as a source-shaped {items, extras, structure} (previewVersion);
//   <out>/<rid>.menu.json   — the public getPublicMenu body the order forms are served (an HTTPS GET of the public endpoint).
// Then run, read-only, with no emulator:
//   node tools/extras-baseline-audit.js --rid <rid> --source <out>/<rid>.source.json
//   EXTRAS_PARITY_X_PIZZA_SOURCE=<out>/x_pizza.source.json EXTRAS_PARITY_X_PIZZA_MENU=<out>/x_pizza.menu.json \
//   EXTRAS_PARITY_LA_MUSA_SOURCE=<out>/la_musa.source.json EXTRAS_PARITY_LA_MUSA_MENU=<out>/la_musa.menu.json \
//     node ../extras-parity-current.test.mjs
//
// It only READS: one Firestore pointer read + version-doc reads per rid (application-default credentials), and a public
// GET. It writes nothing remote. emu-mixed-guard.refuseAnySignal runs FIRST (production-only: any emulator signal, coherent
// or not, refuses), then require-project (`--project` mandatory) — before any client exists (the endpoint census drives both).
// Usage: node tools/extras-export-live.js --project xpizza-delivery --out /tmp/extras-gate0 x_pizza la_musa
// PRODUCTION-ONLY (codex gate0 r1 P1-1): the public GET always reads production, so ANY emulator signal — even one coherent
// local run — is refused before any client, or an emulator source would be paired with the production menu.
require('./emu-mixed-guard').refuseAnySignal('extras-export-live');
const { requireProject } = require('./require-project');
const PROJECT = requireProject({ requireFlag: true });
const fs = require('fs');
const path = require('path');

const PUBLICMENU_URL = 'https://us-central1-xpizza-delivery.cloudfunctions.net/getPublicMenu';

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : null; };
  const out = valueOf('--out');
  const skip = new Set(['--out', out, '--project', valueOf('--project')]);
  const rids = args.filter((a) => !skip.has(a));
  if (!out || !rids.length) { console.error('usage: node tools/extras-export-live.js --project <id> --out <dir> <rid…>'); process.exit(2); }
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ projectId: PROJECT });
  const db = getFirestore();
  const { getActiveVersionId } = require('../catalog/catalog-firestore');
  const { previewVersion } = require('../catalog/catalog-publish');
  fs.mkdirSync(out, { recursive: true });
  for (const rid of rids) {
    const versionId = await getActiveVersionId(db, rid);
    if (versionId == null) throw new Error(`${rid}: no active version`);
    const p = await previewVersion(db, rid, versionId);
    const source = { restaurant_id: rid, items: p.items, extras: p.extras, structure: p.structure, _versionId: versionId };
    fs.writeFileSync(path.join(out, `${rid}.source.json`), `${JSON.stringify(source, null, 1)}\n`);
    const res = await fetch(`${PUBLICMENU_URL}/menu/${encodeURIComponent(rid)}`);
    if (!res.ok) throw new Error(`${rid}: getPublicMenu ${res.status}`);
    fs.writeFileSync(path.join(out, `${rid}.menu.json`), `${JSON.stringify(await res.json(), null, 1)}\n`);
    console.log(`${rid}: active version ${versionId} → ${out}/${rid}.source.json + .menu.json`);
  }
}
main().catch((e) => { console.error('extras-export-live FAILED:', e.message); process.exit(1); });
