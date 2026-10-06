#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// FIRESTORE INDEX REPORT — ADVISORY ONLY. NOT A GATE.   npm run report:indexes -- --project xpizza-delivery
//
// What `npm run deploy:indexes` (tools/deploy-indexes.js: firebase deploy --only firestore:indexes
// --non-interactive, deletion never forced) WILL DO with the remote definitions, decided by FIREBASE'S OWN
// matching code: this loads the installed firebase-tools' FirestoreApi and calls its indexMatchesSpec /
// fieldMatchesSpec / upgradeOldSpec on the same file the deploy pushes. Nothing here re-implements
// Firebase's diff (an earlier hand-written comparison mis-normalized __name__ direction, vector configs
// and TTL fields with inherited indexes — codex stats build r3).
//
// Safety does NOT come from this report. It comes from deploy-indexes.js passing --non-interactive
// without the force flag, where the CLI SKIPS remote definitions the file omits instead of deleting them
// (contract re-verified by tools/firebase-cli-nodelete.js). The report just shows what is skipped, what
// will be created, and which declared field overrides will be updated — so a human can bring the file in
// line when they choose. Always exits 0 on a successful listing (2 on a missing/wrong project, 1 on an error).
// READ-ONLY: lists indexes, field overrides and the database edition; writes nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const inventoryFile = () => {
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  if (!fb.firestore || !fb.firestore.indexes) throw new Error('firebase.json declares no firestore.indexes file');
  return path.join(ROOT, fb.firestore.indexes);   // the SAME file the deploy pushes
};

function loadFirebaseApi(root) {
  const { FirestoreApi } = require(path.join(root, 'lib', 'firestore', 'api.js'));
  return new FirestoreApi();   // only its PURE matchers are used — no client call is made through it
}

/**
 * describe(api, local, remote) — Firebase's own decisions, as data.
 *   remote: { indexes: [raw API Index], fields: [raw API Field], edition }
 */
function describe(api, local, remote) {
  const spec = api.upgradeOldSpec({ indexes: local.indexes || [], fieldOverrides: local.fieldOverrides || [] });
  api.validateSpec(spec);
  const edition = remote.edition || 'STANDARD';
  const indexesSkipped = remote.indexes.filter((ix) => !spec.indexes.some((s) => api.indexMatchesSpec(ix, s, edition)));
  const indexesCreated = spec.indexes.filter((s) => !remote.indexes.some((ix) => api.indexMatchesSpec(ix, s, edition)));
  const parse = (name) => { const m = /collectionGroups\/([^/]+)\/fields\/(.+)$/.exec(name || ''); return m ? { cg: m[1], fp: m[2] } : null; };
  const overridesSkipped = remote.fields.filter((f) => { const p = parse(f.name); return p && !spec.fieldOverrides.some((s) => s.collectionGroup === p.cg && s.fieldPath === p.fp); });
  const overridesUpdated = spec.fieldOverrides.filter((s) => !remote.fields.some((f) => api.fieldMatchesSpec(f, s)));
  return { indexesSkipped, indexesCreated, overridesSkipped, overridesUpdated };
}

async function listRemote(projectId) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/datastore'], projectId });
  const fsApi = google.firestore({ version: 'v1', auth });
  const db = `projects/${projectId}/databases/(default)`;
  const parent = `${db}/collectionGroups/-`;
  const all = async (fn, params, key) => { const out = []; let pageToken; do { const r = await fn({ ...params, pageToken }); out.push(...((r.data && r.data[key]) || [])); pageToken = r.data && r.data.nextPageToken; } while (pageToken); return out; };
  const indexes = await all((p) => fsApi.projects.databases.collectionGroups.indexes.list(p), { parent }, 'indexes');
  const fields = await all((p) => fsApi.projects.databases.collectionGroups.fields.list(p), { parent, filter: 'indexConfig.usesAncestorConfig=false OR ttlConfig:*' }, 'fields');
  const d = await fsApi.projects.databases.get({ name: db });
  return { indexes, fields, edition: (d.data && d.data.databaseEdition) || 'STANDARD' };
}

async function run({ projectId, file = inventoryFile(), list = listRemote, api, out = console.log }) {
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  const remote = await list(projectId);
  const r = describe(api, local, remote);
  out('ADVISORY REPORT — not a gate. Decided by the installed Firebase CLI\'s own matchers.');
  out(`remote: ${remote.indexes.length} composite index(es), ${remote.fields.length} field override(s); file: ${(local.indexes || []).length} / ${(local.fieldOverrides || []).length}`);
  const sec = (title, list, fmt) => { out(`${title}: ${list.length}`); for (const x of list) out(`  ${fmt(x)}`); };
  sec('remote composite indexes the deploy will SKIP (not delete) — absent from the file', r.indexesSkipped, (x) => JSON.stringify({ name: x.name, queryScope: x.queryScope, fields: x.fields }));
  sec('remote field overrides the deploy will SKIP (not delete) — absent from the file', r.overridesSkipped, (x) => JSON.stringify({ name: x.name, indexConfig: x.indexConfig, ttlConfig: x.ttlConfig }));
  sec('composite indexes the deploy will CREATE', r.indexesCreated, (x) => JSON.stringify(x));
  sec('declared field overrides the deploy will CREATE or UPDATE to the file\'s config', r.overridesUpdated, (x) => JSON.stringify(x));
  out('Skipped definitions are left as they are (deploy:indexes never passes the force flag). To keep the file a faithful inventory, add them to firestore.indexes.json.');
  return 0;
}

async function main() {
  const { requireProject } = require('./require-project');
  const projectId = requireProject({ requireFlag: true });   // exit 2 before any client exists
  const { findFirebaseTools } = require('./firebase-cli-nodelete');
  return run({ projectId, api: loadFirebaseApi(findFirebaseTools().root) });
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error('firestore-indexes-report failed:', (e && e.message) || e); process.exit(1); });
}

module.exports = { describe, run, listRemote, loadFirebaseApi, inventoryFile };
