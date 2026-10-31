'use strict';
// DISH PHOTOS A2 step 13 — the sweeper's I/O (photoSweep, a daily scheduled function in the photos isolation group):
//   modeOf(rtdb, publicBucket)  RTDB config/photos_sweep: exactly 'dry_run' | 'live' (advisor ruling #5); anything else, absent or
//                               unreadable → 'off'. 'live' while PHOTOS_PUBLIC_BUCKET is unset → 'dry_run' (5f): a pid must never be marked
//                               deleted while its public copies cannot be removed.
//   makeGcsDeleter(bucket)      deleteIfGeneration(path, gen): file.delete({ifGenerationMatch}) — 404 → 'missing', 412 → 'other_generation'
//                               (both "done"; an object re-created since is never deleted); any other error propagates.
//   runSweep(deps)              every restaurant in photo_registry, one at a time; a rid that throws is logged and skipped (the others run).
const MODES = new Set(['dry_run', 'live']);
const code = (e) => e && (e.code === 404 || e.code === '404' ? 404 : e.code === 412 || e.code === '412' ? 412 : null);

async function modeOf(rtdb, publicBucket) {
  let v;
  try { v = (await rtdb.ref('config/photos_sweep').once('value')).val(); } catch (_) { return 'off'; }
  if (!MODES.has(v)) return 'off';
  if (v === 'live' && !(publicBucket || '').trim()) return 'dry_run';
  return v;
}

function makeGcsDeleter(bucket) {
  return {
    async deleteIfGeneration(path, gen) {
      try { await bucket.file(path).delete({ ifGenerationMatch: gen }); return 'deleted'; }
      catch (e) { if (code(e) === 404) return 'missing'; if (code(e) === 412) return 'other_generation'; throw e; }
    },
  };
}

async function runSweep({ mode, listRids, sweepRid, log = console, ...deps }) {
  if (mode !== 'dry_run' && mode !== 'live') return { mode: 'off' };
  const rids = await listRids();
  const results = [], failed = [];
  for (const rid of rids) {
    try { results.push(await sweepRid({ ...deps, mode, log }, rid)); }
    catch (e) { failed.push(rid); log.warn(JSON.stringify({ evt: 'photo_sweep_rid_failed', rid, error: String((e && e.message) || e).slice(0, 160) })); }
  }
  return { mode, results, failed };
}

module.exports = { modeOf, makeGcsDeleter, runSweep };
