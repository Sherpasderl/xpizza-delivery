'use strict';
// DISH PHOTOS E4 (3) — the owner's real-GCS create-only check, CORE: over fake stores (no client, no I/O), plus ONE real-SDK cell
// against its own loopback server (the generation-scoped wire shape). The CLI is tools/photo-create-only-check.js.
// Run: node tools/photo-create-only-check-core.test.js
const assert = require('assert');
const { parseArgs, refuseEmulatorEnv, readBucketParams, resolveTargets, checkTarget, verifyPrivatePolicy, makeGenerationOps, runCheck, acceptancePath } = require('./photo-create-only-check-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('photo-create-only-check-core: FAILED — exited without completing'); process.exitCode = 1; } });
const HEX = 'a'.repeat(16);
const P = acceptancePath(HEX);
const quiet = { log: { log: () => {} } };

// a VERSIONING-AWARE bucket fake (codex r1): `live` path → generation; `archive` = noncurrent generations. A delete that only archives
// (an unscoped delete under versioning) keeps the generation; a generation-scoped delete removes exactly that generation.
// `serialize` = the precondition holds between concurrent creates (real GCS); false = both win (the emulator).
function fakeBucket({ serialize = true, preexisting = false, createThrows = false, deleteThrows = false, scopedDeleteArchives = false } = {}) {
  const live = new Map(); const archive = new Set(); let gen = 100; const calls = [];
  if (preexisting) live.set(P, String(++gen));
  const store = {
    async metadata(p) { return live.has(p) ? { generation: live.get(p), size: 1 } : null; },
    async createIfAbsent(p) {
      if (createThrows) { live.set(p, String(++gen)); throw Object.assign(new Error('gcs 503 after write'), { code: 503 }); }
      if (serialize && live.has(p)) return { generation: live.get(p), created: false };
      await new Promise((r) => setImmediate(r));
      if (serialize && live.has(p)) return { generation: live.get(p), created: false };
      if (live.has(p)) archive.add(`${p}#${live.get(p)}`);   // an overwrite under versioning keeps the old generation noncurrent
      const g = String(++gen); live.set(p, g); return { generation: g, created: true };
    },
  };
  const gens = {
    async deleteGeneration(p, g) {
      calls.push(['deleteGeneration', p, g]);
      if (deleteThrows) throw Object.assign(new Error('gcs 503'), { code: 503 });
      if (live.get(p) === String(g)) { live.delete(p); if (scopedDeleteArchives) archive.add(`${p}#${g}`); return 'deleted'; }
      return archive.delete(`${p}#${g}`) ? 'deleted' : 'missing';
    },
    async generationExists(p, g) { return live.get(p) === String(g) || archive.has(`${p}#${g}`); },
  };
  return { live, archive, calls, store, gens };
}
const run = (b) => runCheck({ store: b.store, gens: b.gens, randomHex: () => HEX, ...quiet });

(async () => {
  // ── 1. args + emulator refusal ──
  assert.deepStrictEqual(parseArgs(['--project', 'p', '--bucket', 'tb-priv']), { bucket: 'tb-priv', yes: false }, 'E4CLI-ARGS-DRY');
  assert.deepStrictEqual(parseArgs(['--project=p', '--bucket', 'tb-priv', '--yes']), { bucket: 'tb-priv', yes: true }, 'E4CLI-ARGS-YES');
  assert.ok(parseArgs(['--project', 'p']).error, 'E4CLI-ARGS-BUCKET-REQUIRED');
  assert.ok(parseArgs(['--project', 'p', '--bucket', 'tb-priv', '--rid', 'x']).error, 'E4CLI-ARGS-UNKNOWN-REFUSED');
  assert.strictEqual(refuseEmulatorEnv({}), null, 'E4CLI-NO-EMULATOR-OK');
  assert.strictEqual(refuseEmulatorEnv({ STORAGE_EMULATOR_HOST: '' }), null, 'E4CLI-EMPTY-EMULATOR-VAR-OK');
  assert.ok(/STORAGE_EMULATOR_HOST/.test(refuseEmulatorEnv({ STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9199' }) || ''), 'E4CLI-EMULATOR-REFUSED STORAGE_EMULATOR_HOST');
  assert.ok(/FIREBASE_STORAGE_EMULATOR_HOST/.test(refuseEmulatorEnv({ FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' }) || ''), 'E4CLI-EMULATOR-REFUSED FIREBASE_STORAGE_EMULATOR_HOST');
  ok('args: --bucket required, unknown flags refused, --yes to write; either storage-emulator variable → refused');

  // ── 2. bucket identities: production's resolvers over the project's deploy dotenv; both required, distinct; --bucket = private ──
  {
    const files = { '/fn/.env': 'PHOTOS_PRIVATE_BUCKET=tb-priv-general\nPHOTOS_PUBLIC_BUCKET="tb-pub"\nTB_OTHER_KEY=not-read\n', '/fn/.env.tb-proj': "PHOTOS_PRIVATE_BUCKET='tb-priv'\n" };
    const readFile = (p) => { if (files[p] !== undefined) return files[p]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const params = readBucketParams('/fn', 'tb-proj', { readFile });
    assert.deepStrictEqual(params, { PHOTOS_PRIVATE_BUCKET: 'tb-priv', PHOTOS_PUBLIC_BUCKET: 'tb-pub' }, 'E4CLI-DOTENV-ONLY-THE-TWO-KEYS (.env.<project> overrides .env; quotes stripped; other keys never read)');
    assert.deepStrictEqual(readBucketParams('/none', 'tb-proj', { readFile }), {}, 'E4CLI-DOTENV-ABSENT-IS-EMPTY');
    assert.throws(() => readBucketParams('/fn', 'tb-proj', { readFile: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }), /EACCES/, 'E4CLI-DOTENV-READ-ERROR-PROPAGATES');
    assert.deepStrictEqual(resolveTargets({ projectId: 'tb-proj', params }), { privateBucket: 'tb-priv', publicBucket: 'tb-pub' }, 'E4CLI-RESOLVE-BOTH');
    assert.deepStrictEqual(resolveTargets({ projectId: 'tb-proj', params: {} }), { privateBucket: 'tb-proj.firebasestorage.app', publicBucket: null }, 'E4CLI-RESOLVE-PRODUCTION-DEFAULTS');
  }
  assert.strictEqual(checkTarget({ bucket: 'tb-priv', privateBucket: 'tb-priv', publicBucket: 'tb-pub' }), null, 'E4CLI-TARGET-OK');
  assert.ok(/public photo bucket/.test(checkTarget({ bucket: 'tb-priv', privateBucket: 'tb-priv', publicBucket: null }) || ''), 'E4CLI-TARGET-PUBLIC-UNRESOLVED-REFUSED (codex r1 P1: fails CLOSED)');
  assert.ok(/could not be resolved/.test(checkTarget({ bucket: 'tb-priv', privateBucket: null, publicBucket: 'tb-pub' }) || ''), 'E4CLI-TARGET-PRIVATE-UNRESOLVED-REFUSED');
  assert.ok(/SAME bucket/.test(checkTarget({ bucket: 'tb-x', privateBucket: 'tb-x', publicBucket: 'tb-x' }) || ''), 'E4CLI-TARGET-EQUAL-REFUSED');
  assert.ok(/PUBLIC/.test(checkTarget({ bucket: 'tb-pub', privateBucket: 'tb-priv', publicBucket: 'tb-pub' }) || ''), 'E4CLI-TARGET-PUBLIC-REFUSED');
  assert.ok(/not the private/.test(checkTarget({ bucket: 'tb-other', privateBucket: 'tb-priv', publicBucket: 'tb-pub' }) || ''), 'E4CLI-TARGET-NOT-PRIVATE-REFUSED');
  assert.strictEqual(verifyPrivatePolicy({ bindings: [{ role: 'roles/storage.admin', members: ['serviceAccount:tb@x'] }] }), null, 'E4CLI-POLICY-PRIVATE-OK');
  assert.ok(verifyPrivatePolicy({ bindings: [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] }), 'E4CLI-POLICY-PUBLIC-REFUSED allUsers');
  assert.ok(verifyPrivatePolicy({ bindings: [{ role: 'roles/storage.objectViewer', members: ['allAuthenticatedUsers'] }] }), 'E4CLI-POLICY-PUBLIC-REFUSED allAuthenticatedUsers');
  assert.ok(verifyPrivatePolicy(null), 'E4CLI-POLICY-UNREADABLE-REFUSED');
  ok('identities: the two dotenv params (only) through photos/buckets.js; public unresolved / private unresolved / equal / public target / other target → refused; a publicly readable or unreadable IAM policy → refused');

  // ── 3. real GCS (serializing), versioning on: PASS; the ONE created generation deleted GENERATION-SCOPED and verified gone ──
  {
    const b = fakeBucket({ serialize: true });
    const r = await run(b);
    assert.strictEqual(r.verdict, 'PASS', `E4CLI-PASS ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.results.map((x) => x.created).sort(), [false, true], 'E4CLI-PASS one created');
    const own = r.results.find((x) => x.created).generation;
    assert.deepStrictEqual(b.calls, [['deleteGeneration', P, own]], 'E4CLI-DELETES-ONLY-OWN-GENERATION');
    assert.deepStrictEqual([r.cleanup.ok, b.live.size, b.archive.size], [true, 0, 0], 'E4CLI-CLEANUP-PASS nothing live, nothing noncurrent');
    assert.strictEqual(r.exitCode, 0, 'E4CLI-EXIT-PASS');
  }
  {
    const b = fakeBucket({ serialize: true, scopedDeleteArchives: true });
    const r = await run(b);
    assert.ok(r.cleanup.ok === false && /still exists/.test(r.cleanup.detail), `E4CLI-VERSIONED-ARCHIVE-CAUGHT ${JSON.stringify(r.cleanup)}`);
    assert.strictEqual(r.exitCode, 3, 'E4CLI-EXIT-VERSIONED-ARCHIVE');
  }
  ok('serializing bucket (real GCS): PASS; only this run\'s generation deleted, generation-scoped, and verified gone (live AND noncurrent); a delete that merely archives → exit 3');

  // ── 4. the emulator's behaviour (both win): FAIL; every generation THIS run created is deleted and verified, nothing else ──
  {
    const b = fakeBucket({ serialize: false });
    const r = await run(b);
    assert.strictEqual(r.verdict, 'FAIL', `E4CLI-FAIL-BOTH-CREATED ${JSON.stringify(r)}`);
    const own = r.results.filter((x) => x.created).map((x) => x.generation).sort();
    assert.deepStrictEqual(b.calls.map((c) => c[2]).sort(), own, 'E4CLI-FAIL-DELETES-EXACTLY-OWN-GENERATIONS');
    assert.deepStrictEqual([r.cleanup.ok, b.live.size, b.archive.size], [true, 0, 0], 'E4CLI-CLEANUP-FAIL nothing live, nothing noncurrent');
    assert.strictEqual(r.exitCode, 1, 'E4CLI-EXIT-FAIL');
  }
  {
    const store = { metadata: async () => null, createIfAbsent: async () => ({ generation: '7', created: true }) };
    const r = await runCheck({ store, gens: { deleteGeneration: async () => 'deleted', generationExists: async () => false }, randomHex: () => HEX, ...quiet });
    assert.strictEqual(r.verdict, 'FAIL', `E4CLI-TWO-CREATED-SAME-GENERATION-FAILS ${JSON.stringify(r.results)}`);
  }
  ok('non-serializing bucket (the emulator): both created → FAIL, exit 1; exactly this run\'s generations deleted and verified; two created at one generation still FAILs');

  // ── 5. refusals and loud cleanup trouble ──
  {
    const b = fakeBucket({ preexisting: true });
    const r = await run(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['REFUSED', 2], 'E4CLI-PREEXISTING-REFUSED');
    assert.deepStrictEqual([b.calls.length, b.live.size], [0, 1], 'E4CLI-PREEXISTING-TOUCHES-NOTHING');
  }
  {
    const b = fakeBucket({ createThrows: true });
    const r = await run(b);
    assert.strictEqual(r.verdict, 'FAIL', 'E4CLI-CREATE-THROWS-FAIL');
    assert.deepStrictEqual(b.calls, [], 'E4CLI-UNHELD-GENERATION-NEVER-DELETED');
    assert.ok(r.cleanup.ok === false && /not created by a result this run holds/.test(r.cleanup.detail), `E4CLI-CLEANUP-REPORTS-UNOWNED ${JSON.stringify(r.cleanup)}`);
    assert.strictEqual(r.exitCode, 3, 'E4CLI-EXIT-CLEANUP');
  }
  {
    const b = fakeBucket({ deleteThrows: true });
    const r = await run(b);
    assert.ok(r.cleanup.ok === false && r.cleanup.detail.includes(P), `E4CLI-DELETE-ERROR-LOUD ${JSON.stringify(r.cleanup)}`);
    assert.strictEqual(r.exitCode, 3, 'E4CLI-EXIT-CLEANUP-DELETE-ERROR');
  }
  ok('a pre-existing path → REFUSED (exit 2), nothing touched; a thrown create → its unheld generation never deleted, reported (exit 3); a delete error → loud with the path (exit 3)');

  // ── 6. makeGenerationOps over the REAL @google-cloud/storage, against its OWN loopback server: generation-scoped DELETE and GET ──
  {
    const http = require('http');
    const { Storage } = require('@google-cloud/storage');
    const seen = []; const gone = new Set();
    const notFound = (rs) => { rs.writeHead(404, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ error: { code: 404, message: 'No such object' } })); };
    const srv = http.createServer((rq, rs) => {
      rq.resume();
      rq.on('end', () => {
        seen.push([rq.method, rq.url]);
        const g = new URL(rq.url, 'http://x').searchParams.get('generation');
        if (gone.has(g)) return notFound(rs);
        if (rq.method === 'DELETE') { gone.add(g); rs.writeHead(204); rs.end(); return; }
        rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ name: P, bucket: 'tb-bucket', generation: g }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const saved = process.env.STORAGE_EMULATOR_HOST; delete process.env.STORAGE_EMULATOR_HOST;
    try {
      const ops = makeGenerationOps(new Storage({ projectId: 'demo-xpizza', apiEndpoint: `http://127.0.0.1:${srv.address().port}` }).bucket('tb-bucket'));
      assert.strictEqual(await ops.generationExists(P, '555'), true, 'E4CLI-REAL-SDK-EXISTS');
      assert.strictEqual(await ops.deleteGeneration(P, '555'), 'deleted', 'E4CLI-REAL-SDK-DELETE');
      assert.strictEqual(await ops.generationExists(P, '555'), false, 'E4CLI-REAL-SDK-GONE-404');
      assert.strictEqual(await ops.deleteGeneration(P, '555'), 'missing', 'E4CLI-REAL-SDK-DELETE-404-MISSING');
      const q = (m) => seen.filter((s) => s[0] === m).map((s) => new URL(s[1], 'http://x').searchParams.get('generation'));
      assert.deepStrictEqual([q('GET'), q('DELETE')], [['555', '555'], ['555', '555']], `E4CLI-REAL-SDK-GENERATION-SCOPED ${JSON.stringify(seen)}`);
    } finally { if (saved !== undefined) process.env.STORAGE_EMULATOR_HOST = saved; srv.close(); }
  }
  ok('the real SDK: generation-scoped GET and DELETE carry generation=<g> on the wire; a 404 → gone / missing');

  FINISHED = true;
  console.log(`photo-create-only-check-core: OK (${n})`);
})().catch((e) => { console.error('photo-create-only-check-core: FAILED —', e && e.stack || e); process.exit(1); });
