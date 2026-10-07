'use strict';
// The ADVISORY index report: accurate descriptions, decided by the INSTALLED Firebase CLI's own matchers
// (incl. the three shapes a hand-written comparison got wrong — codex stats build r3). It is not a gate:
// it never refuses, never claims a deploy is safe. Run: node tools/firestore-indexes-report.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('./firestore-indexes-report');
const { findFirebaseTools } = require('./firebase-cli-nodelete');
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const api = R.loadFirebaseApi(findFirebaseTools().root);
const NAME = 'projects/xpizza-delivery/databases/(default)/collectionGroups';
const ix = (cg, fields, id = 'X') => ({ name: `${NAME}/${cg}/indexes/${id}`, queryScope: 'COLLECTION', fields });
const LOCAL = JSON.parse(fs.readFileSync(R.inventoryFile(), 'utf8'));
/* The remote as it stands once the committed overrides are deployed. Exemptions carry no index; a field that KEEPS an index
   (1D D4-c2a: identity_evidence.vid, ascending, collection scope) carries it in the API's shape. */
const statsRemote = LOCAL.fieldOverrides.map((o) => ({ name: `${NAME}/${o.collectionGroup}/fields/${o.fieldPath}`,
  indexConfig: { indexes: (o.indexes || []).map((i) => ({ queryScope: i.queryScope, fields: [{ fieldPath: o.fieldPath, order: i.order }], state: 'READY' })), usesAncestorConfig: false } }));
const withIdx = (indexes) => ({ indexes, fieldOverrides: LOCAL.fieldOverrides });

(async () => {
  // 1. EXACT MATCH (remote carries the implicit __name__ in the direction Firebase derives) → nothing
  //    skipped, nothing created; the committed file vs a remote already carrying the stats overrides → nothing.
  {
    const local = withIdx([{ collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'DESCENDING' }] }]);
    const remote = { indexes: [ix('orders', [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'DESCENDING' }, { fieldPath: '__name__', order: 'DESCENDING' }])], fields: statsRemote };
    const r = R.describe(api, local, remote);
    assert.deepStrictEqual([r.indexesSkipped.length, r.indexesCreated.length, r.overridesSkipped.length, r.overridesUpdated.length], [0, 0, 0, 0]);
    const r2 = R.describe(api, LOCAL, { indexes: [], fields: statsRemote });
    assert.deepStrictEqual([r2.indexesSkipped.length, r2.indexesCreated.length, r2.overridesSkipped.length, r2.overridesUpdated.length], [0, 0, 0, 0]);
    ok('exact match (implicit __name__ in Firebase\'s derived direction) and the committed file re-deployed → nothing to report');
  }

  // 2. codex r3 shape A: a NON-DEFAULT __name__ direction → the remote index is SKIPPED and the file's
  //    index will be CREATED (Firebase does not consider them the same).
  {
    const local = withIdx([{ collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }] }]);
    const r = R.describe(api, local, { indexes: [ix('orders', [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: '__name__', order: 'DESCENDING' }])], fields: statsRemote });
    assert.strictEqual(r.indexesSkipped.length, 1); assert.strictEqual(r.indexesCreated.length, 1);
    ok('non-default __name__ direction: remote SKIPPED + file index CREATED (Firebase\'s own matcher)');
  }

  // 3. codex r3 shape B: a vectorConfig DIMENSION change → skipped + created.
  {
    const vec = (d) => ({ fieldPath: 'embedding', vectorConfig: { dimension: d, flat: {} } });
    const local = withIdx([{ collectionGroup: 'docs', queryScope: 'COLLECTION', fields: [vec(256)] }]);
    const r = R.describe(api, local, { indexes: [ix('docs', [vec(128), { fieldPath: '__name__', order: 'ASCENDING' }])], fields: statsRemote });
    assert.strictEqual(r.indexesSkipped.length, 1); assert.strictEqual(r.indexesCreated.length, 1);
    ok('vector dimension change: remote SKIPPED + file index CREATED');
  }

  // 4. codex r3 shape C: a TTL field whose indexes are INHERITED, declared locally as ttl:true + indexes:[]
  //    → reported as an UPDATE (the deploy would change that field's indexing), not as "nothing to do".
  {
    const local = { indexes: [], fieldOverrides: [...LOCAL.fieldOverrides, { collectionGroup: 'sessions', fieldPath: 'expires_at', ttl: true, indexes: [] }] };
    const ttlRemote = { name: `${NAME}/sessions/fields/expires_at`, ttlConfig: { state: 'ACTIVE' }, indexConfig: { usesAncestorConfig: true, indexes: [{ queryScope: 'COLLECTION', fields: [{ fieldPath: 'expires_at', order: 'ASCENDING' }] }, { queryScope: 'COLLECTION', fields: [{ fieldPath: 'expires_at', order: 'DESCENDING' }] }] } };
    const r = R.describe(api, local, { indexes: [], fields: [...statsRemote, ttlRemote] });
    assert.deepStrictEqual(r.overridesUpdated.map((o) => o.fieldPath), ['expires_at']);
    assert.strictEqual(r.overridesSkipped.length, 0);
    ok('TTL field with inherited indexes vs local ttl:true + indexes:[] → reported as an UPDATE');
  }

  // 5. remote-only → SKIPPED (not deleted); local-only → CREATED; the rendered report is ADVISORY,
  //    exits 0, and claims no safety guarantee.
  {
    const lines = [];
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idxrep-')), 'firestore.indexes.json');
    fs.writeFileSync(tmp, JSON.stringify(withIdx([{ collectionGroup: 'new_cg', queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }, { fieldPath: 'b', order: 'ASCENDING' }] }])));
    const remoteOnlyIx = ix('orders', [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'ASCENDING' }, { fieldPath: '__name__', order: 'ASCENDING' }]);
    const remoteOnlyOv = { name: `${NAME}/catalog/fields/blob`, indexConfig: { indexes: [], usesAncestorConfig: false } };
    const code = await R.run({ projectId: 'p', file: tmp, api, list: async () => ({ indexes: [remoteOnlyIx], fields: [...statsRemote, remoteOnlyOv], edition: 'STANDARD' }), out: (l) => lines.push(l) });
    const text = lines.join('\n');
    assert.strictEqual(code, 0, 'advisory: never refuses');
    assert.match(text, /ADVISORY REPORT — not a gate/);
    assert.match(text, /remote composite indexes the deploy will SKIP \(not delete\)[^\n]*: 1/);
    assert.match(text, /remote field overrides the deploy will SKIP \(not delete\)[^\n]*: 1/);
    assert.match(text, /composite indexes the deploy will CREATE: 1/);
    assert(text.includes('catalog/fields/blob') && text.includes('/orders/indexes/'));
    assert(!/REFUSED|delete nothing|safe to deploy|guarantee/i.test(text), 'the report makes no safety claim');
    ok('remote-only → listed as SKIPPED (not deleted); local-only → CREATED; ADVISORY, exit 0, no safety claim');
  }

  // 6. Read-only + project-pinned: missing / wrong project → exit 2 (spawned); no mutating API in the source.
  {
    for (const args of [[], ['--project', 'lamusa-social']]) {
      let code = 0;
      try { execFileSync(process.execPath, [path.join(__dirname, 'firestore-indexes-report.js'), ...args], { stdio: 'pipe', env: { ...process.env, GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' } }); }
      catch (e) { code = e.status; }
      assert.strictEqual(code, 2);
    }
    const src = fs.readFileSync(path.join(__dirname, 'firestore-indexes-report.js'), 'utf8').replace(/\/\/.*$/gm, '');
    assert(!/\.(create|patch|delete|deploy)\(|createIndex|patchField|deleteIndex|deleteField/.test(src), 'no mutating call');
    ok('read-only (no mutating call) and --project pinned (exit 2)');
  }
  console.log(`\nfirestore-indexes-report: ${n} cells passed`);
  __finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
