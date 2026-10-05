'use strict';
// The index-deploy preflight (codex stats build r2, B4'), against MOCKED remote listings shaped like the
// Firestore Admin API v1 responses. Run: node tools/firestore-indexes-preflight.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const P = require('./firestore-indexes-preflight');
// 🔴 A SUITE THAT STOPS EARLY MUST NOT EXIT 0. If an awaited promise never settles, Node drains the event
// loop and exits 0 mid-cell — a silent pass. The suite must reach its last line to succeed.
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing (an awaited promise never settled)'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NAME = 'projects/xpizza-delivery/databases/(default)/collectionGroups';

// API-shaped raw listings → normalized, as listRemote does.
const rawIndex = (cg, fields, scope = 'COLLECTION') => P.normalizeRemoteIndex({ name: `${NAME}/${cg}/indexes/CICAg123`, queryScope: scope, fields: [...fields, { fieldPath: '__name__', order: 'ASCENDING' }], state: 'READY' });
const rawField = (cg, fp, indexes, extra = {}) => P.normalizeRemoteField({ name: `${NAME}/${cg}/fields/${fp}`, indexConfig: { indexes, usesAncestorConfig: false }, ...extra });
const LOCAL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
const STATS_REMOTE = LOCAL.fieldOverrides.map((o) => rawField(o.collectionGroup, o.fieldPath, []));
const quiet = () => {};

(async () => {
  // 1. Normalization of real API shapes: implicit __name__ dropped; the database default and
  //    ancestor-inheriting fields are not overrides.
  {
    const ix = rawIndex('orders', [{ fieldPath: 'restaurant_id', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'DESCENDING' }]);
    assert.strictEqual(P.indexKey(ix), P.indexKey({ collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'restaurant_id', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'DESCENDING' }] }));
    assert.strictEqual(P.normalizeRemoteField({ name: `${NAME}/__default__/fields/*`, indexConfig: { indexes: [] } }), null);
    assert.strictEqual(P.normalizeRemoteField({ name: `${NAME}/x/fields/y`, indexConfig: { usesAncestorConfig: true } }), null);
    assert.deepStrictEqual(P.normalizeRemoteField({ name: `${NAME}/x/fields/y`, indexConfig: { usesAncestorConfig: true }, ttlConfig: { state: 'ACTIVE' } }), { collectionGroup: 'x', fieldPath: 'y', indexes: null, ttl: true });
    ok('remote API shapes normalize: implicit __name__ dropped, default + inheriting fields ignored, TTL kept');
  }

  // 2. 🔴 A REMOTE-ONLY composite index → REFUSE (exit 1), naming it.
  {
    const lines = [];
    const code = await P.run({ projectId: 'p', list: async () => ({ indexes: [rawIndex('orders', [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'ASCENDING' }])], fieldOverrides: STATS_REMOTE }), out: (l) => lines.push(l) });
    assert.strictEqual(code, 1);
    assert(lines.some((l) => /REFUSED/.test(l)) && lines.some((l) => /would be DELETED/.test(l) && /"orders"/.test(l)));
    ok('remote-only composite index → REFUSED, named as "would be DELETED"');
  }

  // 3. 🔴 A REMOTE-ONLY field override (e.g. a console TTL policy or an exemption) → REFUSE; and a
  //    shared override whose remote config differs (the deploy would CHANGE it) → REFUSE.
  {
    const lines = [];
    const ttl = P.normalizeRemoteField({ name: `${NAME}/sessions/fields/expires_at`, indexConfig: { usesAncestorConfig: true }, ttlConfig: { state: 'ACTIVE' } });
    assert.strictEqual(await P.run({ projectId: 'p', list: async () => ({ indexes: [], fieldOverrides: [...STATS_REMOTE, ttl] }), out: (l) => lines.push(l) }), 1);
    assert(lines.some((l) => /would be RESET/.test(l) && /expires_at/.test(l)));
    const changed = STATS_REMOTE.map((o, i) => (i ? o : { ...o, indexes: [{ queryScope: 'COLLECTION', fields: [{ fieldPath: o.fieldPath, order: 'ASCENDING' }] }] }));
    const l2 = [];
    assert.strictEqual(await P.run({ projectId: 'p', list: async () => ({ indexes: [], fieldOverrides: changed }), out: (l) => l2.push(l) }), 1);
    assert(l2.some((l) => /would CHANGE/.test(l)));
    ok('remote-only field override (TTL) → REFUSED as "would be RESET"; a differing shared override → "would CHANGE"');
  }

  // 4. EXACT MATCH → pass; LOCAL-ONLY additions → pass; today's prod (empty remote, advisor-verified) → pass.
  {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idxpf-')), 'firestore.indexes.json');
    const withIdx = { indexes: [{ collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'ASCENDING' }] }], fieldOverrides: LOCAL.fieldOverrides };
    fs.writeFileSync(tmp, JSON.stringify(withIdx));
    assert.strictEqual(await P.run({ projectId: 'p', file: tmp, list: async () => ({ indexes: [rawIndex('orders', [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'created_at', order: 'ASCENDING' }])], fieldOverrides: STATS_REMOTE }), out: quiet }), 0, 'exact match');
    assert.strictEqual(await P.run({ projectId: 'p', file: tmp, list: async () => ({ indexes: [], fieldOverrides: [] }), out: quiet }), 0, 'local-only additions');
    assert.strictEqual(await P.run({ projectId: 'p', list: async () => ({ indexes: [], fieldOverrides: [] }), out: quiet }), 0, 'the committed file vs an empty remote');
    assert.strictEqual(await P.run({ projectId: 'p', list: async () => ({ indexes: [], fieldOverrides: STATS_REMOTE }), out: quiet }), 0, 'the committed file after its own deploy (idempotent)');
    ok('exact match / local-only additions / empty remote / re-deploy of the same file → pass');
  }

  // 5. It reads the SAME file firebase.json deploys, and refuses a missing/wrong project with EXIT 2
  //    before any client exists (spawned for real).
  {
    const fb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8'));
    assert.strictEqual(fb.firestore.indexes, 'firestore.indexes.json');
    for (const args of [[], ['--project', 'lamusa-social']]) {
      let code = 0, out = '';
      try { execFileSync(process.execPath, [path.join(__dirname, 'firestore-indexes-preflight.js'), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never' } }); }
      catch (e) { code = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
      assert.strictEqual(code, 2, `args ${JSON.stringify(args)} exited ${code}`);
      assert.match(out, /project_guard_refused/);
    }
    const src = fs.readFileSync(path.join(__dirname, 'firestore-indexes-preflight.js'), 'utf8');
    assert(!/\.(create|patch|delete)\(/.test(src.replace(/\/\/.*$/gm, '')), 'the preflight calls no mutating API');
    ok('reads the deployed file; missing/wrong project → exit 2 (spawned); no mutating API call in the source');
  }
  console.log(`\nfirestore-indexes-preflight: ${n} cells passed`);
  __finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
