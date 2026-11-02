'use strict';
// DISH PHOTOS E4 (3) — the owner's real-GCS create-only check, CORE: over fake stores (no client, no I/O), plus ONE real-SDK cell
// against its own loopback server (the generation-scoped wire shape). The CLI is tools/photo-create-only-check.js.
// Run: node tools/photo-create-only-check-core.test.js
const assert = require('assert');
const { parseArgs, refuseEmulatorEnv, dryRunMessage, resolveTargets, checkTarget, makeGenerationOps, runCheck, acceptancePath, pinPath, runPinCheck, combineExit, deletePinPath, runDeletePinCheck } = require('./photo-create-only-check-core');

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

  // ── 2. bucket identities: production's resolver over the COMMITTED photos config for the explicit project (no dotenv, no shell) ──
  {
    const C2 = require('../photos/photos-config');
    const loaded = (over = {}) => C2.parseLoaded(() => ({ schema: 1, public_bucket: { 'tb-proj': 'tb-pub' }, private_bucket: { 'tb-proj': 'tb-priv' }, ...over }));
    assert.deepStrictEqual(resolveTargets({ projectId: 'tb-proj', env: {}, loaded: loaded() }), { privateBucket: 'tb-priv', publicBucket: 'tb-pub', reason: null }, 'E4CLI-RESOLVE-BOTH (the committed config)');
    const notYet = resolveTargets({ projectId: 'tb-proj', env: {}, loaded: loaded({ public_bucket: { 'tb-proj': '' } }) });
    assert.deepStrictEqual(notYet, { privateBucket: 'tb-priv', publicBucket: null, reason: null }, 'E4CLI-RESOLVE-PUBLIC-NOT-YET');
    assert.ok(/not configured/.test(checkTarget({ bucket: 'tb-priv', ...notYet }) || ''), 'E4CLI-TARGET-PUBLIC-NOT-CONFIGURED-REFUSED (until launch)');
    const noPriv = resolveTargets({ projectId: 'tb-proj', env: {}, loaded: loaded({ private_bucket: {} }) });
    assert.deepStrictEqual(noPriv, { privateBucket: null, publicBucket: null, reason: 'photos_private_bucket_unknown' }, 'E4CLI-RESOLVE-NO-PRIVATE-NO-GUESS');
    assert.ok(/refused this project \(photos_private_bucket_unknown\)/.test(checkTarget({ bucket: 'tb-priv', ...noPriv }) || ''), 'E4CLI-TARGET-CONFIG-REFUSAL-REPORTED');
    assert.strictEqual(resolveTargets({ projectId: 'tb-proj', env: { GCLOUD_PROJECT: 'tb-proj-other' }, loaded: loaded() }).reason, 'photos_project_conflict', 'E4CLI-RESOLVE-SHELL-PROJECT-CONFLICT');
    assert.strictEqual(resolveTargets({ projectId: 'tb-proj', env: { PHOTOS_PRIVATE_BUCKET: 'tb-poison', PHOTOS_PUBLIC_BUCKET: 'tb-poison-2' }, loaded: loaded() }).privateBucket, 'tb-priv', 'E4CLI-LEGACY-ENV-IGNORED');
    const msg = dryRunMessage({ projectId: 'tb-proj', privateBucket: 'tb-priv', publicBucket: 'tb-pub', bucket: 'tb-priv' });
    assert.ok(msg.includes('tb-priv') && msg.includes('tb-pub'), 'E4CLI-DRY-RUN-NAMES-THE-BUCKETS (names, not secrets — the owner confirms the target)');
    // the REAL committed file: the owner-verified private name resolves; public not configured until launch
    assert.deepStrictEqual(resolveTargets({ projectId: 'xpizza-delivery', env: {} }), { privateBucket: 'xpizza-delivery.firebasestorage.app', publicBucket: null, reason: null }, 'E4CLI-RESOLVE-COMMITTED-PROD');
  }
  assert.strictEqual(checkTarget({ bucket: 'tb-priv', privateBucket: 'tb-priv', publicBucket: 'tb-pub' }), null, 'E4CLI-TARGET-OK');
  assert.ok(/public photo bucket/.test(checkTarget({ bucket: 'tb-priv', privateBucket: 'tb-priv', publicBucket: null }) || ''), 'E4CLI-TARGET-PUBLIC-UNRESOLVED-REFUSED (codex r1 P1: fails CLOSED)');
  assert.ok(/could not be resolved/.test(checkTarget({ bucket: 'tb-priv', privateBucket: null, publicBucket: 'tb-pub' }) || ''), 'E4CLI-TARGET-PRIVATE-UNRESOLVED-REFUSED');
  assert.ok(/SAME bucket/.test(checkTarget({ bucket: 'tb-x', privateBucket: 'tb-x', publicBucket: 'tb-x' }) || ''), 'E4CLI-TARGET-EQUAL-REFUSED');
  assert.ok(/PUBLIC/.test(checkTarget({ bucket: 'tb-pub', privateBucket: 'tb-priv', publicBucket: 'tb-pub' }) || ''), 'E4CLI-TARGET-PUBLIC-REFUSED');
  assert.ok(/not the private/.test(checkTarget({ bucket: 'tb-other', privateBucket: 'tb-priv', publicBucket: 'tb-pub' }) || ''), 'E4CLI-TARGET-NOT-PRIVATE-REFUSED');
  ok('identities: production\'s resolver over the COMMITTED photos config for the explicit project — both, public not yet (refused until launch), no private (reported, never guessed), a conflicting shell project refused, legacy env ignored, the real committed prod entry; public / private unresolved, equal, public, not-private targets refused');

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

  // ── 7. E5 the GENERATION PIN (advisor 2026-11-01): create-only v1 → plain overwrite v2 → a read pinned to v1 ──
  {
    const PP = pinPath(HEX);
    assert.strictEqual(PP, `drafts/__acceptance__/e5-${HEX}-card.webp`, 'E5CLI-PATH');
    assert.throws(() => pinPath('xyz'), /16 random hex/, 'E5CLI-PATH-NEEDS-HEX');
    // `mode`: how the bucket answers a read pinned to a non-live generation — 'unversioned' (gone → 404), 'versioned' (the noncurrent
    // bytes), 'ignored' (the live bytes: the emulator, probe e5-probe/RESULT.md); `versioning`: what versioningEnabled() says (or throws)
    const pinBucket = ({ mode, versioning, preexisting = false, sameGen = false }) => {
      const objs = new Map(); let gen = 500; const live = new Map(); const calls = [];
      if (preexisting) live.set(PP, String(++gen));
      const put = (p, buf) => { const g = sameGen && live.has(p) ? live.get(p) : String(++gen); objs.set(`${p}#${g}`, buf); live.set(p, g); return g; };
      const store = {
        async metadata(p) { return live.has(p) ? { generation: live.get(p), size: 1 } : null; },
        async createIfAbsent(p, buf) { if (live.has(p)) return { generation: live.get(p), created: false }; return { generation: put(p, buf), created: true }; },
        async download(p, { generation }) {
          calls.push(['download', p, generation]);
          if (mode === 'ignored') return objs.get(`${p}#${live.get(p)}`);
          if (mode === 'readError') throw Object.assign(new Error('gcs 503'), { code: 503 });
          if (live.get(p) === String(generation) || (mode === 'versioned' && objs.has(`${p}#${generation}`))) return objs.get(`${p}#${generation}`);
          throw Object.assign(new Error('object gone or replaced'), { code: 'generation_mismatch' });
        },
      };
      const gens = {
        async overwrite(p, buf) { const old = live.get(p); const g = put(p, buf); if (mode === 'unversioned' && old !== g) objs.delete(`${p}#${old}`); return g; },
        async versioningEnabled() { if (versioning instanceof Error) throw versioning; return versioning; },
        async deleteGeneration(p, g) { calls.push(['deleteGeneration', p, g]); const had = objs.delete(`${p}#${g}`); if (live.get(p) === String(g)) live.delete(p); return had ? 'deleted' : 'missing'; },
        async generationExists(p, g) { return objs.has(`${p}#${g}`); },
      };
      return { store, gens, objs, live, calls };
    };
    const pin = (b) => runPinCheck({ store: b.store, gens: b.gens, randomHex: () => HEX, ...quiet });
    let b = pinBucket({ mode: 'unversioned', versioning: false }); let r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.outcome, r.exitCode], ['PASS', 'refused', 0], `E5CLI-UNVERSIONED-REFUSED-PASS ${JSON.stringify(r)}`);
    assert.ok(b.calls.some((c) => c[0] === 'download' && c[2] === '501'), 'E5CLI-READ-PINNED-TO-THE-FIRST-GENERATION');
    assert.ok(r.cleanup.ok && b.objs.size === 0 && !b.live.has(PP), `E5CLI-CLEANUP-BOTH-GENERATIONS ${JSON.stringify(r.cleanup)}`);
    b = pinBucket({ mode: 'versioned', versioning: true }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.outcome, r.exitCode], ['PASS', 'pinned_old_bytes', 0], `E5CLI-VERSIONED-OLD-BYTES-PASS ${JSON.stringify(r)}`);
    assert.ok(r.cleanup.ok && b.objs.size === 0, `E5CLI-VERSIONED-CLEANUP-NONCURRENT-TOO ${JSON.stringify(r.cleanup)} ${[...b.objs.keys()]}`);
    b = pinBucket({ mode: 'ignored', versioning: false }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.outcome, r.exitCode], ['FAIL', 'new_bytes', 1], `E5CLI-PIN-IGNORED-FAILS ${JSON.stringify(r)}`);
    assert.ok(r.cleanup.ok && b.objs.size === 0, 'E5CLI-FAIL-STILL-CLEANS');
    b = pinBucket({ mode: 'versioned', versioning: false }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['FAIL', 1], `E5CLI-INCONSISTENT-WITH-VERSIONING-FAILS (old bytes on an unversioned bucket) ${JSON.stringify(r)}`);
    b = pinBucket({ mode: 'unversioned', versioning: true }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['FAIL', 1], `E5CLI-INCONSISTENT-WITH-VERSIONING-FAILS (refused on a versioned bucket) ${JSON.stringify(r)}`);
    for (const mode of ['unversioned', 'versioned']) {
      b = pinBucket({ mode, versioning: new Error('403 storage.buckets.get') }); r = await pin(b);
      assert.deepStrictEqual([r.verdict, r.versioning, r.exitCode], ['PASS', null, 0], `E5CLI-VERSIONING-UNKNOWN-ACCEPTS-EITHER ${mode} ${JSON.stringify(r)}`);
    }
    b = pinBucket({ mode: 'ignored', versioning: new Error('403') }); r = await pin(b);
    assert.strictEqual(r.verdict, 'FAIL', 'E5CLI-VERSIONING-UNKNOWN-STILL-FAILS-NEW-BYTES');
    b = pinBucket({ mode: 'readError', versioning: false }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.outcome, r.exitCode], ['FAIL', 'error:503', 1], `E5CLI-READ-ERROR-IS-NOT-A-REFUSAL (only generation_mismatch is the refusal) ${JSON.stringify(r)}`);
    assert.ok(r.cleanup.ok && b.objs.size === 0, 'E5CLI-READ-ERROR-STILL-CLEANS');
    b = pinBucket({ mode: 'unversioned', versioning: false, sameGen: true }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['FAIL', 1], `E5CLI-OVERWRITE-SAME-GENERATION-FAILS ${JSON.stringify(r)}`);
    assert.ok(/kept the generation/.test(r.reason) && r.outcome === null && !b.calls.some((c) => c[0] === 'download'), `E5CLI-OVERWRITE-SAME-GENERATION-NO-READ (refused before any pinned read) ${JSON.stringify(r)}`);
    b = pinBucket({ mode: 'unversioned', versioning: false, preexisting: true }); r = await pin(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['REFUSED', 2], 'E5CLI-PREEXISTING-REFUSED');
    assert.ok(!b.calls.length, 'E5CLI-PREEXISTING-NOTHING-TOUCHED');
    assert.deepStrictEqual([combineExit(0, 0), combineExit(1, 0), combineExit(0, 2), combineExit(1, 2), combineExit(3, 0), combineExit(2, 3)], [0, 1, 2, 2, 3, 3], 'E5CLI-EXIT-COMBINE (3 > 2 > 1 > 0)');
  }
  ok('generation pin: unversioned → refused PASS; versioned → the old bytes PASS; the new bytes (pin ignored) FAIL; an outcome inconsistent with the versioning FAIL; versioning unknown → either correct outcome passes, new bytes still FAIL; both generations cleaned; a pre-existing path REFUSED untouched; exit = the worse of the two checks');

  // ── 8. the pin's ops over the REAL @google-cloud/storage, against its OWN loopback server: a PLAIN upload and the bucket's versioning ──
  {
    const http = require('http');
    const { Storage, CRC32C } = require('@google-cloud/storage');
    const V2 = Buffer.from('v2'); const crc = new CRC32C(); crc.update(V2);
    const V2_HASHES = { crc32c: crc.toString(), md5Hash: require('crypto').createHash('md5').update(V2).digest('base64') };
    const seen = [];
    const srv = http.createServer((rq, rs) => {
      rq.resume();
      rq.on('end', () => {
        seen.push([rq.method, rq.url]);
        const u = new URL(rq.url, 'http://x');
        rs.writeHead(200, { 'content-type': 'application/json' });
        if (u.pathname.startsWith('/upload/')) return rs.end(JSON.stringify({ name: P, bucket: 'tb-bucket', generation: '777', ...V2_HASHES }));   // the SDK validates the upload against these
        return rs.end(JSON.stringify({ name: 'tb-bucket', versioning: { enabled: true } }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const saved = process.env.STORAGE_EMULATOR_HOST; delete process.env.STORAGE_EMULATOR_HOST;
    try {
      const ops = makeGenerationOps(new Storage({ projectId: 'demo-xpizza', apiEndpoint: `http://127.0.0.1:${srv.address().port}` }).bucket('tb-bucket'));
      assert.strictEqual(await ops.overwrite(P, V2, { contentType: 'image/webp' }), '777', 'E5CLI-REAL-SDK-OVERWRITE-GENERATION');
      const up = seen.find((x) => x[0] === 'POST' && x[1].startsWith('/upload/'));
      assert.ok(up && !/ifGenerationMatch/.test(up[1]), `E5CLI-REAL-SDK-OVERWRITE-IS-PLAIN (no precondition) ${JSON.stringify(seen)}`);
      assert.strictEqual(await ops.versioningEnabled(), true, 'E5CLI-REAL-SDK-VERSIONING');
      assert.ok(seen.some((x) => x[0] === 'GET' && new URL(x[1], 'http://x').pathname.endsWith('/b/tb-bucket')), `E5CLI-REAL-SDK-VERSIONING-READS-THE-BUCKET ${JSON.stringify(seen)}`);
    } finally { if (saved !== undefined) process.env.STORAGE_EMULATOR_HOST = saved; srv.close(); }
  }
  ok('the real SDK: the overwrite is a plain upload (no ifGenerationMatch) returning the new generation; versioning is read from the bucket resource');

  // ── 9. A2-E4 the DELETE precondition (advisor 2026-11-01; the emulator ignores it, e4-delete-probe/RESULT.md): create v1 → plain
  //       overwrite v2 → the PRODUCTION sweeper deleter's deleteIfGeneration(path, v1) must answer other_generation and leave v2 live ──
  {
    const DP = deletePinPath(HEX);
    assert.strictEqual(DP, `drafts/__acceptance__/del-${HEX}-card.webp`, 'DELCLI-PATH');
    assert.throws(() => deletePinPath('nope'), /16 random hex/, 'DELCLI-PATH-NEEDS-HEX');
    // `honours`: the bucket answers a delete pinned to a non-live generation with 412 (real GCS) — false = deletes the live one (emulator)
    const delBucket = ({ honours = true, preexisting = false, deleteThrows = false, versioned = false, lies = false }) => {
      const objs = new Map(); const live = new Map(); let gen = 900; const calls = [];
      if (preexisting) { const g = String(++gen); live.set(DP, g); objs.set(`${DP}#${g}`, 'x'); }
      const put = (p, buf) => { const old = live.get(p); const g = String(++gen); objs.set(`${p}#${g}`, buf); live.set(p, g); if (old && !versioned) objs.delete(`${p}#${old}`); return g; };
      const store = {
        async metadata(p) { return live.has(p) ? { generation: live.get(p), size: 1 } : null; },
        async createIfAbsent(p, buf) { if (live.has(p)) return { generation: live.get(p), created: false }; return { generation: put(p, buf), created: true }; },
      };
      const gens = {
        async overwrite(p, buf) { return put(p, buf); },
        async deleteGeneration(p, g) { calls.push(['deleteGeneration', p, g]); const had = objs.delete(`${p}#${g}`); if (live.get(p) === String(g)) live.delete(p); return had ? 'deleted' : 'missing'; },
        async generationExists(p, g) { return objs.has(`${p}#${g}`); },
      };
      const deleter = {
        async deleteIfGeneration(p, g) {
          calls.push(['deleteIfGeneration', p, g]);
          if (deleteThrows) throw Object.assign(new Error('gcs 503'), { code: 503 });
          if (!live.has(p)) return 'missing';
          if (lies) { const lg = live.get(p); objs.delete(`${p}#${lg}`); live.delete(p); return 'other_generation'; }   // answers 412 yet the object is gone
          if (live.get(p) !== String(g) && honours) return 'other_generation';
          const lg = live.get(p); objs.delete(`${p}#${lg}`); live.delete(p); return 'deleted';
        },
      };
      return { store, gens, deleter, objs, live, calls };
    };
    const del = (b) => runDeletePinCheck({ store: b.store, gens: b.gens, deleter: b.deleter, randomHex: () => HEX, ...quiet });
    let b = delBucket({ honours: true }); let r = await del(b);
    assert.deepStrictEqual([r.verdict, r.result, r.exitCode], ['PASS', 'other_generation', 0], `DELCLI-HONOURED-PASS ${JSON.stringify(r)}`);
    assert.ok(b.calls.some((c) => c[0] === 'deleteIfGeneration' && c[2] === '901'), 'DELCLI-DELETE-PINNED-TO-THE-FIRST-GENERATION');
    assert.ok(r.cleanup.ok && b.objs.size === 0 && !b.live.has(DP), `DELCLI-CLEANUP ${JSON.stringify(r.cleanup)}`);
    b = delBucket({ honours: true, versioned: true }); r = await del(b);
    assert.ok(r.verdict === 'PASS' && r.cleanup.ok && b.objs.size === 0, `DELCLI-VERSIONED-CLEANUP-NONCURRENT-TOO ${JSON.stringify(r)} ${[...b.objs.keys()]}`);
    b = delBucket({ honours: false }); r = await del(b);
    assert.deepStrictEqual([r.verdict, r.result, r.exitCode], ['FAIL', 'deleted', 1], `DELCLI-PRECONDITION-IGNORED-FAILS (the re-created object was deleted) ${JSON.stringify(r)}`);
    assert.ok(/re-created/.test(r.reason), `DELCLI-FAIL-SAYS-WHY ${r.reason}`);
    assert.ok(r.cleanup.ok && b.objs.size === 0, 'DELCLI-FAIL-STILL-CLEANS');
    b = delBucket({ lies: true }); r = await del(b);
    assert.deepStrictEqual([r.verdict, r.result, r.exitCode], ['FAIL', 'other_generation', 1], `DELCLI-OBJECT-MUST-SURVIVE (other_generation alone is not enough: the re-created object must still be live) ${JSON.stringify(r)}`);
    b = delBucket({ deleteThrows: true }); r = await del(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['FAIL', 1], `DELCLI-DELETE-ERROR-FAILS ${JSON.stringify(r)}`);
    assert.ok(r.cleanup.ok && b.objs.size === 0, 'DELCLI-DELETE-ERROR-STILL-CLEANS');
    b = delBucket({ preexisting: true }); r = await del(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['REFUSED', 2], 'DELCLI-PREEXISTING-REFUSED');
    assert.ok(!b.calls.length, 'DELCLI-PREEXISTING-NOTHING-TOUCHED');
  }
  ok('delete precondition: the sweeper deleter pinned to the first generation → other_generation and the re-created object stays live → PASS; a delete that removed it (the emulator) or a delete error → FAIL; both generations cleaned (noncurrent too); a pre-existing path REFUSED untouched');

  FINISHED = true;
  console.log(`photo-create-only-check-core: OK (${n})`);
})().catch((e) => { console.error('photo-create-only-check-core: FAILED —', e && e.stack || e); process.exit(1); });
