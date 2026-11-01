'use strict';
// DISH PHOTOS E4 (3) — the owner's real-GCS create-only check, CORE (pure over injected stores; the CLI is tools/photo-create-only-check.js).
// Why: the Storage emulator lets two CONCURRENT create-only saves both win (heavy 2026-11-01), so only real GCS can prove the guarantee
// processPhoto's draft writes rely on. One throwaway object: drafts/__acceptance__/e4-<16 random hex>-card.webp in the PRIVATE bucket.
//   1 the path must not exist (else REFUSED, nothing touched)
//   2 two concurrent createIfAbsent through the real adapter → PASS iff exactly one created:true and the other created:false, SAME generation
//   3 finally: delete ONLY the generations this run's results hold as created (generation-matched), then confirm the path is gone. An
//     object left behind whose generation this run does not hold (a create that threw after writing) is NEVER deleted — it is reported.
// exitCode: 0 PASS + clean · 1 FAIL + clean · 2 REFUSED · 3 cleanup not confirmed (loud, with the path)
const RE_HEX16 = /^[0-9a-f]{16}$/;

function acceptancePath(hex) {
  if (!RE_HEX16.test(String(hex))) throw new Error('acceptancePath needs 16 random hex characters');
  return `drafts/__acceptance__/e4-${hex}-card.webp`;
}

function parseArgs(argv) {
  const out = { bucket: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { i++; continue; }
    if (a.startsWith('--project=')) continue;
    if (a === '--yes') { out.yes = true; continue; }
    if (a === '--bucket' && /^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(argv[i + 1] || '')) { out.bucket = argv[++i]; continue; }
    return { error: `unknown or malformed argument ${JSON.stringify(a)}` };
  }
  if (!out.bucket) return { error: '--bucket <the private photo bucket> is required (there is no default)' };
  return out;
}

// → null when the target is THE configured private bucket, else the refusal reason
function checkTarget({ bucket, expectedBucket, publicBucket = null }) {
  if (publicBucket && bucket === publicBucket) return `--bucket ${bucket} is the PUBLIC photo bucket — this check only ever writes to the private one`;
  if (!expectedBucket) return 'the private photo bucket could not be resolved for this project';
  if (bucket !== expectedBucket) return `--bucket ${bucket} is not the private photo bucket (${expectedBucket})`;
  return null;
}

async function runCheck({ store, deleter, randomHex, log = console }) {
  const path = acceptancePath(randomHex());
  if (await store.metadata(path)) return { verdict: 'REFUSED', reason: `${path} already exists`, path, exitCode: 2 };
  // allSettled never throws: a failed create is a result, and cleanup below always runs
  const settled = await Promise.allSettled([0, 1].map(() => store.createIfAbsent(path, Buffer.from('e4'), { contentType: 'image/webp' })));
  const held = new Set(settled.filter((s) => s.status === 'fulfilled' && s.value && s.value.created === true).map((s) => String(s.value.generation)));
  const results = settled.map((s) => (s.status === 'fulfilled' ? { created: s.value.created, generation: String(s.value.generation) } : { error: String((s.reason && s.reason.message) || s.reason).slice(0, 160) }));
  const ok = results.length === 2 && results.every((r) => !r.error) && results.map((r) => r.created).sort().join() === 'false,true' && results[0].generation === results[1].generation;
  const verdict = ok ? 'PASS' : 'FAIL';

  const cleanup = { ok: true, deleted: [], detail: '' };
  try {
    for (const g of [...held].sort().reverse()) cleanup.deleted.push([g, await deleter.deleteIfGeneration(path, g)]);
    const left = await store.metadata(path);
    if (left) {
      cleanup.ok = false;
      cleanup.detail = held.has(String(left.generation))
        ? `CLEANUP-FAILED: ${path} generation ${left.generation} (created by this run) is still there`
        : `CLEANUP-FAILED: ${path} generation ${left.generation} remains — not created by a result this run holds, so it was NOT deleted; remove it by hand`;
    }
  } catch (e) {
    cleanup.ok = false;
    cleanup.detail = `CLEANUP-FAILED: ${path} — ${String((e && e.message) || e).slice(0, 160)}`;
  }
  log.log(`photo-create-only-check: ${verdict} ${JSON.stringify(results)}`);
  if (!cleanup.ok) log.log(cleanup.detail);
  return { verdict, results, path, cleanup, exitCode: !cleanup.ok ? 3 : ok ? 0 : 1 };
}

module.exports = { parseArgs, checkTarget, runCheck, acceptancePath };
