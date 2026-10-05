#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// FIRESTORE INDEX DEPLOY PREFLIGHT — READ-ONLY. MANDATORY before every
//     firebase deploy --only firestore:indexes --project xpizza-delivery
//
// 🔴 WHY (codex stats build r2, B4'): firestore.indexes.json is a WHOLE-DATABASE inventory. The Firebase
// CLI DELETES every remote composite index and RESETS every remote field override that the file omits
// (firebase-tools lib/firestore/api.js). The file's first author was the stats track (nine field
// exemptions), so from now on anything added in the console — a composite index for some future query,
// a TTL policy — would be silently destroyed by the next index deploy.
//
// This lists the REMOTE composite indexes and field overrides (Firestore Admin API, read-only) and
// REFUSES — exit 1, naming each one — if the remote holds anything the local file does not, or a
// field override whose remote configuration the deploy would CHANGE. Local-only additions pass (that is
// what a deploy is for). The fix for a refusal is to ADD the remote definition to firestore.indexes.json
// (copy it from the output), never to deploy over it.
//
//   node tools/firestore-indexes-preflight.js --project xpizza-delivery
//
// --project is mandatory (tools/require-project.js, exit 2 on a missing/wrong project). Needs ADC with
// datastore.indexes.list. Reads nothing else and writes nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FILE = () => {
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  if (!fb.firestore || !fb.firestore.indexes) throw new Error('firebase.json declares no firestore.indexes file');
  return path.join(ROOT, fb.firestore.indexes);   // the SAME file the deploy will push
};

const unquote = (p) => String(p).split('.').map((s) => s.replace(/^`|`$/g, '')).join('.');
const canon = (v) => JSON.stringify(v, Object.keys(v).sort());
const fieldKey = (f) => (f.order ? `${f.fieldPath}:${f.order}` : f.arrayConfig ? `${f.fieldPath}:${f.arrayConfig}` : `${f.fieldPath}:vector`);

// A composite index, in firestore.indexes.json form, as a comparable key. The implicit trailing
// __name__ the API reports is dropped (firestore.indexes.json omits it).
function indexKey(ix) {
  let fields = (ix.fields || []).map((f) => ({ fieldPath: unquote(f.fieldPath), ...(f.order ? { order: f.order } : {}), ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : {}) }));
  if (fields.length && fields[fields.length - 1].fieldPath === '__name__') fields = fields.slice(0, -1);
  return `${ix.collectionGroup}|${ix.queryScope || 'COLLECTION'}|${fields.map(fieldKey).join(',')}`;
}
function normalizeRemoteIndex(r) {
  const m = /collectionGroups\/([^/]+)\/indexes\//.exec(r.name || '');
  return { collectionGroup: m ? m[1] : '?', queryScope: r.queryScope || 'COLLECTION', fields: r.fields || [] };
}
// A field override, as { collectionGroup, fieldPath, indexes:[...sorted], ttl? }.
function overrideConfig(o) {
  const idx = (o.indexes || []).map((i) => {
    const f = (i.fields && i.fields[0]) || i;
    return `${i.queryScope || 'COLLECTION'}:${f.order || f.arrayConfig || ''}`;
  }).sort();
  return { indexes: idx, ttl: !!o.ttl };
}
function normalizeRemoteField(r) {
  const m = /collectionGroups\/([^/]+)\/fields\/(.+)$/.exec(r.name || '');
  if (!m) return null;
  if (m[1] === '__default__' && m[2] === '*') return null;     // the database-wide default, not an override
  const ttl = !!(r.ttlConfig && r.ttlConfig.state && r.ttlConfig.state !== 'STATE_UNSPECIFIED');
  const usesAncestor = !!(r.indexConfig && r.indexConfig.usesAncestorConfig);
  if (usesAncestor && !ttl) return null;                         // inherits: nothing for the file to carry
  return { collectionGroup: m[1], fieldPath: unquote(m[2]), indexes: usesAncestor ? null : ((r.indexConfig && r.indexConfig.indexes) || []), ttl };
}

/**
 * compareInventory(local, remote) → { ok, remoteOnlyIndexes, remoteOnlyOverrides, changedOverrides }
 *   local:  parsed firestore.indexes.json
 *   remote: { indexes: [firestore.indexes.json-shaped], fieldOverrides: [{collectionGroup, fieldPath, indexes|null, ttl}] }
 */
function compareInventory(local, remote) {
  const localIdx = new Set((local.indexes || []).map(indexKey));
  const remoteOnlyIndexes = (remote.indexes || []).filter((r) => !localIdx.has(indexKey(r)));
  const localOv = new Map((local.fieldOverrides || []).map((o) => [`${o.collectionGroup}|${unquote(o.fieldPath)}`, o]));
  const remoteOnlyOverrides = [], changedOverrides = [];
  for (const r of remote.fieldOverrides || []) {
    const k = `${r.collectionGroup}|${r.fieldPath}`;
    const l = localOv.get(k);
    if (!l) { remoteOnlyOverrides.push(r); continue; }
    const rc = overrideConfig({ indexes: r.indexes || [], ttl: r.ttl }), lc = overrideConfig(l);
    if (r.indexes !== null && canon(rc) !== canon(lc)) changedOverrides.push({ remote: r, local: l });
    else if (r.ttl !== !!l.ttl) changedOverrides.push({ remote: r, local: l });
  }
  return { ok: !remoteOnlyIndexes.length && !remoteOnlyOverrides.length && !changedOverrides.length, remoteOnlyIndexes, remoteOnlyOverrides, changedOverrides };
}

// The live listing (Firestore Admin API v1, read-only). Injected in tests.
async function listRemote(projectId) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/datastore'], projectId });
  const fsApi = google.firestore({ version: 'v1', auth });
  const parent = `projects/${projectId}/databases/(default)/collectionGroups/-`;
  const all = async (fn, params, key) => { const out = []; let pageToken; do { const r = await fn({ ...params, pageToken }); out.push(...((r.data && r.data[key]) || [])); pageToken = r.data && r.data.nextPageToken; } while (pageToken); return out; };
  const idx = await all((p) => fsApi.projects.databases.collectionGroups.indexes.list(p), { parent }, 'indexes');
  const fields = await all((p) => fsApi.projects.databases.collectionGroups.fields.list(p), { parent, filter: 'indexConfig.usesAncestorConfig:false OR ttlConfig:*' }, 'fields');
  return { indexes: idx.map(normalizeRemoteIndex), fieldOverrides: fields.map(normalizeRemoteField).filter(Boolean) };
}

async function run({ projectId, file = DEFAULT_FILE(), list = listRemote, out = console.log }) {
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  const remote = await list(projectId);
  const r = compareInventory(local, remote);
  out(`remote: ${remote.indexes.length} composite index(es), ${remote.fieldOverrides.length} field override(s); local file: ${(local.indexes || []).length} / ${(local.fieldOverrides || []).length}`);
  if (r.ok) { out('OK — the local file carries every remote definition; `firebase deploy --only firestore:indexes` will delete or reset nothing.'); return 0; }
  out('🔴 REFUSED — deploying firestore.indexes.json now would DELETE or RESET these remote definitions:');
  for (const i of r.remoteOnlyIndexes) out(`  composite index (would be DELETED): ${JSON.stringify(i)}`);
  for (const o of r.remoteOnlyOverrides) out(`  field override (would be RESET):   ${JSON.stringify(o)}`);
  for (const c of r.changedOverrides) out(`  field override (would CHANGE):     remote ${JSON.stringify(c.remote)}  vs local ${JSON.stringify(c.local)}`);
  out('Add each to firestore.indexes.json (copy the definition above), re-run this preflight, and only then deploy.');
  return 1;
}

async function main() {
  const { requireProject } = require('./require-project');
  const projectId = requireProject({ requireFlag: true });   // exit 2 before any client exists
  return run({ projectId });
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error('firestore-indexes-preflight failed:', (e && e.message) || e); process.exit(1); });
}

module.exports = { compareInventory, normalizeRemoteIndex, normalizeRemoteField, indexKey, run, listRemote };
