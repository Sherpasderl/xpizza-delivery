'use strict';
// DISH PHOTOS A2 step 13 — photos/sweep-io.js: the sweep MODE (RTDB config/photos_sweep: exactly 'dry_run' | 'live', anything else /
// absent / unreadable → 'off'; 'live' without PHOTOS_PUBLIC_BUCKET → 'dry_run'), the generation-matched GCS delete adapter, and runSweep
// over every restaurant in the registry (one rid's failure never stops the others). Run: node photos/sweep-io.test.js
const assert = require('assert');
const { modeOf, makeGcsDeleter, runSweep } = require('./sweep-io');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const err = (code) => Object.assign(new Error(`gcs ${code}`), { code });
(async () => {
  const rtdb = (v, fail) => ({ ref: (p) => ({ once: async () => { assert.strictEqual(p, 'config/photos_sweep'); if (fail) throw new Error('down'); return { val: () => v }; } }) });
  for (const [v, bucket, want] of [[null, 'b', 'off'], ['off', 'b', 'off'], ['LIVE', 'b', 'off'], [true, 'b', 'off'], ['dry_run', 'b', 'dry_run'], ['live', 'b', 'live'], ['live', '', 'dry_run'], ['dry_run', '', 'dry_run']]) {
    assert.strictEqual(await modeOf(rtdb(v), bucket), want, `SWEEP-MODE ${JSON.stringify(v)} bucket=${JSON.stringify(bucket)}`);
  }
  assert.strictEqual(await modeOf(rtdb(null, true), 'b'), 'off', 'SWEEP-MODE-UNREADABLE-OFF');
  ok("mode: exactly 'dry_run' / 'live' (else off; unreadable → off); live without a public bucket → dry_run");

  const calls = [];
  const bucket = { file: (p) => ({ async delete(o) { calls.push([p, o]); if (p === 'gone') throw err(404); if (p === 'moved') throw err(412); if (p === 'boom') throw err(503); } }) };
  const D = makeGcsDeleter(bucket);
  assert.deepStrictEqual([await D.deleteIfGeneration('x', '7'), await D.deleteIfGeneration('gone', '7'), await D.deleteIfGeneration('moved', '7')], ['deleted', 'missing', 'other_generation'], 'SWEEP-GCS-DELETE');
  assert.deepStrictEqual(calls[0], ['x', { ifGenerationMatch: '7' }], 'SWEEP-GCS-GENERATION-MATCHED');
  await assert.rejects(() => D.deleteIfGeneration('boom', '7'), (e) => e.code === 503, 'SWEEP-GCS-OTHER-ERRORS-PROPAGATE');
  calls.length = 0;
  assert.deepStrictEqual([await D.deleteAny('x'), await D.deleteAny('gone')], ['deleted', 'missing'], 'SWEEP-GCS-DELETE-ANY (codex r2: a pending_public path)');
  assert.deepStrictEqual(calls.map(([p, o]) => [p, o]), [['x', undefined], ['gone', undefined]], 'SWEEP-GCS-DELETE-ANY-UNCONDITIONAL');
  await assert.rejects(() => D.deleteAny('boom'), (e) => e.code === 503, 'SWEEP-GCS-DELETE-ANY-OTHER-ERRORS-PROPAGATE');
  ok('gcs deleter: ifGenerationMatch; 404 → missing, 412 → other_generation (done, never deleted); other errors propagate; deleteAny (pending_public paths) unconditional, 404 → missing');

  const seen = []; const warns = [];
  const r = await runSweep({ mode: 'live', listRids: async () => ['tb_a', 'tb_b', 'tb_c'], log: { warn: (x) => warns.push(x), info: () => {} },
    sweepRid: async (deps, rid) => { seen.push([rid, deps.mode]); if (rid === 'tb_b') throw new Error('rid down'); return { rid, deleted: [] }; } });
  assert.deepStrictEqual(seen, [['tb_a', 'live'], ['tb_b', 'live'], ['tb_c', 'live']], 'SWEEP-RUN-EVERY-RID');
  assert.deepStrictEqual(r.failed, ['tb_b'], 'SWEEP-RUN-ONE-FAILURE-ISOLATED');
  assert.deepStrictEqual(await runSweep({ mode: 'off', listRids: async () => { throw new Error('should not list'); } }), { mode: 'off' }, 'SWEEP-RUN-OFF-READS-NOTHING');
  ok('runSweep: every registry rid in turn; one rid failing is logged and never stops the others; off lists nothing');
  // codex r1 P1-1: photoSweep reads the mode FIRST and builds NO Storage / Firestore dependency when it is off
  const { sweepEntry } = require('./sweep-io');
  let built = 0;
  assert.deepStrictEqual(await sweepEntry({ readMode: async () => 'off', build: () => { built++; throw new Error('must not build'); } }), { mode: 'off' }, 'SWEEP-ENTRY-OFF-BUILDS-NOTHING');
  assert.strictEqual(built, 0, 'SWEEP-ENTRY-OFF-NO-BUILD');
  const ran = await sweepEntry({ readMode: async () => 'dry_run', build: () => { built++; return { listRids: async () => ['tb_a'], sweepRid: async (d, rid) => ({ rid, mode: d.mode }) }; } });
  assert.deepStrictEqual([built, ran.mode, ran.results], [1, 'dry_run', [{ rid: 'tb_a', mode: 'dry_run' }]], 'SWEEP-ENTRY-ON-BUILDS-ONCE');
  ok('sweepEntry: off → returns before building any dependency (no bucket constructed); on → builds once and runs');
  console.log(`sweep-io: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('sweep-io: FAILED —', e && e.stack || e); process.exit(1); });
