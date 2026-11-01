'use strict';
// DISH PHOTOS E4 (3) — the owner's real-GCS create-only check, CORE: over fake stores (no client, no I/O). The CLI is
// tools/photo-create-only-check.js. Run: node tools/photo-create-only-check-core.test.js
const assert = require('assert');
const { parseArgs, checkTarget, runCheck, acceptancePath } = require('./photo-create-only-check-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('photo-create-only-check-core: FAILED — exited without completing'); process.exitCode = 1; } });
const HEX = 'a'.repeat(16);
const quiet = { log: { log: () => {} } };

// a bucket fake: `serialize` = the precondition holds between concurrent creates (real GCS); false = both win (the emulator)
function fakeBucket({ serialize = true, preexisting = false, createThrows = false, deleteThrows = false } = {}) {
  const live = new Map(); let gen = 100; const deletes = [];
  if (preexisting) live.set(acceptancePath(HEX), String(++gen));
  const store = {
    async metadata(p) { return live.has(p) ? { generation: live.get(p), size: 1 } : null; },
    async createIfAbsent(p) {
      if (createThrows) { live.set(p, String(++gen)); throw Object.assign(new Error('gcs 503 after write'), { code: 503 }); }
      if (serialize && live.has(p)) return { generation: live.get(p), created: false };
      await new Promise((r) => setImmediate(r));   // both reach here before either writes when not serialized
      if (serialize && live.has(p)) return { generation: live.get(p), created: false };
      const g = String(++gen); live.set(p, g); return { generation: g, created: true };
    },
  };
  const deleter = {
    async deleteIfGeneration(p, g) {
      deletes.push([p, g]);
      if (deleteThrows) throw Object.assign(new Error('gcs 503'), { code: 503 });
      if (!live.has(p)) return 'missing';
      if (live.get(p) !== String(g)) return 'other_generation';
      live.delete(p); return 'deleted';
    },
  };
  return { live, deletes, store, deleter };
}
const run = (b, extra = {}) => runCheck({ store: b.store, deleter: b.deleter, randomHex: () => HEX, ...quiet, ...extra });

(async () => {
  // ── 1. args + target: no default bucket, --bucket must be THE private bucket, --yes to write ──
  assert.deepStrictEqual(parseArgs(['--project', 'p', '--bucket', 'tb-priv']), { bucket: 'tb-priv', yes: false }, 'E4CLI-ARGS-DRY');
  assert.deepStrictEqual(parseArgs(['--project=p', '--bucket', 'tb-priv', '--yes']), { bucket: 'tb-priv', yes: true }, 'E4CLI-ARGS-YES');
  assert.ok(parseArgs(['--project', 'p']).error, 'E4CLI-ARGS-BUCKET-REQUIRED');
  assert.ok(parseArgs(['--project', 'p', '--bucket', 'tb-priv', '--rid', 'x']).error, 'E4CLI-ARGS-UNKNOWN-REFUSED');
  assert.strictEqual(checkTarget({ bucket: 'tb-priv', expectedBucket: 'tb-priv' }), null, 'E4CLI-TARGET-OK');
  assert.ok(checkTarget({ bucket: 'tb-public', expectedBucket: 'tb-priv' }), 'E4CLI-TARGET-NOT-PRIVATE-REFUSED');
  assert.ok(checkTarget({ bucket: 'tb-priv', expectedBucket: '' }), 'E4CLI-TARGET-UNKNOWN-REFUSED');
  assert.ok(/PUBLIC/.test(checkTarget({ bucket: 'tb-pub', expectedBucket: 'tb-pub', publicBucket: 'tb-pub' })), 'E4CLI-TARGET-PUBLIC-REFUSED (even if misconfigured as the private one)');
  assert.strictEqual(acceptancePath(HEX), `drafts/__acceptance__/e4-${HEX}-card.webp`, 'E4CLI-PATH');
  assert.throws(() => acceptancePath('xyz'), /random/, 'E4CLI-PATH-NEEDS-16-HEX');
  ok('args: --bucket required, unknown flags refused, --yes to write; the target must be the configured PRIVATE bucket; a random acceptance path');

  // ── 2. real GCS (serializing): PASS, and the ONE created generation is deleted; nothing remains ──
  {
    const b = fakeBucket({ serialize: true });
    const r = await run(b);
    assert.strictEqual(r.verdict, 'PASS', `E4CLI-PASS ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.results.map((x) => x.created).sort(), [false, true], 'E4CLI-PASS one created');
    assert.deepStrictEqual(b.deletes, [[acceptancePath(HEX), r.results.find((x) => x.created).generation]], 'E4CLI-DELETES-ONLY-OWN-GENERATION');
    assert.deepStrictEqual([r.cleanup.ok, b.live.size], [true, 0], 'E4CLI-CLEANUP-PASS');
    assert.strictEqual(r.exitCode, 0, 'E4CLI-EXIT-PASS');
  }
  ok('serializing bucket (real GCS): exactly one created, the other the same generation → PASS; only that generation deleted; exit 0');

  // ── 3. the emulator's behaviour (both win): FAIL; every generation THIS run created is deleted, nothing else ──
  {
    const b = fakeBucket({ serialize: false });
    const r = await run(b);
    assert.strictEqual(r.verdict, 'FAIL', `E4CLI-FAIL-BOTH-CREATED ${JSON.stringify(r)}`);
    const own = r.results.filter((x) => x.created).map((x) => x.generation).sort();
    assert.deepStrictEqual(b.deletes.map((d) => d[1]).sort(), own, 'E4CLI-FAIL-DELETES-EXACTLY-OWN-GENERATIONS');
    assert.deepStrictEqual([r.cleanup.ok, b.live.size], [true, 0], 'E4CLI-CLEANUP-FAIL');
    assert.strictEqual(r.exitCode, 1, 'E4CLI-EXIT-FAIL');
  }
  {
    // both report created:true at the SAME generation (impossible on GCS, but the verdict must not rest on the generation check alone)
    const store = { metadata: async () => null, createIfAbsent: async () => ({ generation: '7', created: true }) };
    const r = await runCheck({ store, deleter: { deleteIfGeneration: async () => 'deleted' }, randomHex: () => HEX, ...quiet });
    assert.strictEqual(r.verdict, 'FAIL', `E4CLI-TWO-CREATED-SAME-GENERATION-FAILS ${JSON.stringify(r.results)}`);
  }
  ok('non-serializing bucket (the emulator): both created → FAIL, exit 1; exactly the generations this run created are deleted, cleanup confirmed');

  // ── 4. refusals and loud cleanup trouble ──
  {
    const b = fakeBucket({ preexisting: true });
    const r = await run(b);
    assert.deepStrictEqual([r.verdict, r.exitCode], ['REFUSED', 2], 'E4CLI-PREEXISTING-REFUSED');
    assert.deepStrictEqual([b.deletes.length, b.live.size], [0, 1], 'E4CLI-PREEXISTING-TOUCHES-NOTHING');
  }
  {
    // a create that THROWS after writing: its generation is not held, so it is NEVER deleted — reported for the owner instead
    const b = fakeBucket({ createThrows: true });
    const r = await run(b);
    assert.strictEqual(r.verdict, 'FAIL', 'E4CLI-CREATE-THROWS-FAIL');
    assert.deepStrictEqual(b.deletes, [], 'E4CLI-UNHELD-GENERATION-NEVER-DELETED');
    assert.ok(r.cleanup.ok === false && /not created by a result this run holds/.test(r.cleanup.detail), `E4CLI-CLEANUP-REPORTS-UNOWNED ${JSON.stringify(r.cleanup)}`);
    assert.strictEqual(r.exitCode, 3, 'E4CLI-EXIT-CLEANUP');
  }
  {
    const b = fakeBucket({ deleteThrows: true });
    const r = await run(b);
    assert.ok(r.cleanup.ok === false && r.cleanup.detail.includes(acceptancePath(HEX)), `E4CLI-DELETE-ERROR-LOUD ${JSON.stringify(r.cleanup)}`);
    assert.strictEqual(r.exitCode, 3, 'E4CLI-EXIT-CLEANUP-DELETE-ERROR');
  }
  ok('a pre-existing path → REFUSED (exit 2), nothing touched; a thrown create → its unheld generation is never deleted, reported (exit 3); a delete error → loud with the path (exit 3)');

  FINISHED = true;
  console.log(`photo-create-only-check-core: OK (${n})`);
})().catch((e) => { console.error('photo-create-only-check-core: FAILED —', e && e.stack || e); process.exit(1); });
