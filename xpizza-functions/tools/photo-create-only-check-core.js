'use strict';
// DISH PHOTOS E4 (3) — the owner's real-GCS create-only check, CORE (pure over injected stores; the CLI is tools/photo-create-only-check.js).
// Why: the Storage emulator lets two CONCURRENT create-only saves both win (heavy 2026-11-01), so only real GCS can prove the guarantee
// processPhoto's draft writes rely on. One throwaway object: drafts/__acceptance__/e4-<16 random hex>-card.webp in the PRIVATE bucket.
//   0 REFUSALS before any client (codex r1): a storage-emulator override in the environment; a private or public bucket identity that
//     cannot be resolved from what production reads (photos/buckets.js over the project's own deploy dotenv params — the operator's shell
//     never decides them); the two being equal; --bucket not the private one.
//     NO privacy probe (advisor ruling, codex r2): bucket IAM alone cannot prove privacy (inherited grants, object ACLs), so a partial
//     probe would only add false assurance. The target is pinned to production's private-bucket identity, and the object is a 2-byte
//     throwaway at a random path, deleted by generation.
//   1 the path must not exist (else REFUSED, nothing touched)
//   2 two concurrent createIfAbsent through the real adapter → PASS iff exactly one created:true and the other created:false, SAME generation
//   3 cleanup: delete ONLY the generations this run's results hold as created — GENERATION-SCOPED (a versioned bucket would otherwise keep a
//     noncurrent copy; codex r1) — and verify each generation is gone (generation-scoped metadata → 404); an object left live whose
//     generation this run does not hold (a create that threw after writing) is NEVER deleted — it is reported.
// exitCode: 0 PASS + clean · 1 FAIL + clean · 2 REFUSED · 3 cleanup not confirmed (loud, with the path)
const { privateBucketName, publicBucketName } = require('../photos/buckets');
const RE_HEX16 = /^[0-9a-f]{16}$/;
const PARAM_KEYS = Object.freeze(['PHOTOS_PRIVATE_BUCKET', 'PHOTOS_PUBLIC_BUCKET']);
const EMULATOR_VARS = Object.freeze(['FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST']);
const is404 = (e) => e && (e.code === 404 || e.code === '404');

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

// → the refusal when the environment points Storage at an emulator (the evidence must be real GCS), else null
function refuseEmulatorEnv(env) {
  const set = EMULATOR_VARS.filter((k) => typeof env[k] === 'string' && env[k].trim() !== '');
  return set.length ? `${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} set — this check must run against real GCS, never an emulator` : null;
}

// a dotenv file, ONE LINE AT A TIME (codex r2): read in small chunks; each complete line is handed out and then dropped — the file is
// never buffered whole. ENOENT surfaces on the first iteration (the caller treats it as "no such file").
function* dotenvLines(file, { fsImpl = require('fs'), chunk = 4096 } = {}) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(chunk); let rest = '';
    for (;;) {
      const nRead = fsImpl.readSync(fd, buf, 0, chunk, null);
      if (nRead === 0) break;
      const parts = (rest + buf.toString('utf8', 0, nRead)).split(/\r?\n/);
      rest = parts.pop();
      for (const line of parts) yield line;
    }
    if (rest) yield rest;
  } finally { fsImpl.closeSync(fd); }
}

// the two photo bucket params from the project's deploy dotenv files — the files the deployed functions' params are read from
// (.env, then .env.<projectId> overriding it). ONLY these two keys are RETAINED; every other line is scanned and discarded unstored.
function readBucketParams(functionsDir, projectId, { lines = dotenvLines } = {}) {
  const out = {};
  for (const name of ['.env', `.env.${projectId}`]) {
    try {
      for (const line of lines(require('path').join(functionsDir, name))) {
        const m = /^\s*(PHOTOS_PRIVATE_BUCKET|PHOTOS_PUBLIC_BUCKET)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
      }
    } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
  }
  return out;
}

// the dry-run plan: the resolved bucket NAMES (not secrets — they let the owner confirm the target) and nothing else from the dotenv
function dryRunMessage({ projectId, privateBucket, publicBucket, bucket }) {
  return `photo-create-only-check: DRY — project ${projectId}; private ${privateBucket}, public ${publicBucket}. With --yes: write ONE throwaway object drafts/__acceptance__/e4-<random>-card.webp to gs://${bucket} twice, concurrently, create-only; then delete only the generation(s) it created, generation-scoped, and verify them gone.`;
}

// the private + public identities through photos/buckets.js (production's resolvers), from the dotenv params and the stated project only
function resolveTargets({ projectId, params }) {
  let priv = null;
  try { priv = privateBucketName({ param: () => params.PHOTOS_PRIVATE_BUCKET || '', env: { GCLOUD_PROJECT: projectId } }); } catch (_) { priv = null; }
  const pub = publicBucketName({ param: () => params.PHOTOS_PUBLIC_BUCKET || '' });
  return { privateBucket: priv, publicBucket: pub };
}

// → null when --bucket is THE private bucket and both identities are resolved and distinct, else the refusal reason
function checkTarget({ bucket, privateBucket, publicBucket }) {
  if (!privateBucket) return 'the private photo bucket could not be resolved for this project';
  if (!publicBucket) return 'the public photo bucket (PHOTOS_PUBLIC_BUCKET) could not be resolved for this project — both identities are required';
  if (privateBucket === publicBucket) return `the private and public photo buckets resolve to the SAME bucket (${privateBucket}) — refusing`;
  if (bucket === publicBucket) return `--bucket ${bucket} is the PUBLIC photo bucket — this check only ever writes to the private one`;
  if (bucket !== privateBucket) return `--bucket ${bucket} is not the private photo bucket (${privateBucket})`;
  return null;
}

// generation-SCOPED operations over a @google-cloud/storage Bucket: one exact generation, live or noncurrent
function makeGenerationOps(bucket) {
  return {
    async deleteGeneration(path, gen) {
      try { await bucket.file(path, { generation: gen }).delete(); return 'deleted'; } catch (e) { if (is404(e)) return 'missing'; throw e; }
    },
    async generationExists(path, gen) {
      try { await bucket.file(path, { generation: gen }).getMetadata(); return true; } catch (e) { if (is404(e)) return false; throw e; }
    },
  };
}

async function runCheck({ store, gens, randomHex, log = console }) {
  const path = acceptancePath(randomHex());
  if (await store.metadata(path)) return { verdict: 'REFUSED', reason: `${path} already exists`, path, exitCode: 2 };
  // allSettled never throws: a failed create is a result, and cleanup below always runs
  const settled = await Promise.allSettled([0, 1].map(() => store.createIfAbsent(path, Buffer.from('e4'), { contentType: 'image/webp' })));
  const held = new Set(settled.filter((s) => s.status === 'fulfilled' && s.value && s.value.created === true).map((s) => String(s.value.generation)));
  const results = settled.map((s) => (s.status === 'fulfilled' ? { created: s.value.created, generation: String(s.value.generation) } : { error: String((s.reason && s.reason.message) || s.reason).slice(0, 160) }));
  const ok = results.length === 2 && results.every((r) => !r.error) && results.map((r) => r.created).sort().join() === 'false,true' && results[0].generation === results[1].generation;
  const verdict = ok ? 'PASS' : 'FAIL';

  const cleanup = { ok: true, deleted: [], detail: '' };
  const problems = [];
  try {
    for (const g of [...held].sort()) {
      cleanup.deleted.push([g, await gens.deleteGeneration(path, g)]);
      if (await gens.generationExists(path, g)) problems.push(`CLEANUP-FAILED: ${path} generation ${g} (created by this run) still exists`);
    }
    const left = await store.metadata(path);
    if (left && !held.has(String(left.generation))) problems.push(`CLEANUP-FAILED: ${path} generation ${left.generation} remains — not created by a result this run holds, so it was NOT deleted; remove it by hand`);
  } catch (e) {
    problems.push(`CLEANUP-FAILED: ${path} — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  if (problems.length) { cleanup.ok = false; cleanup.detail = problems.join('; '); }
  log.log(`photo-create-only-check: ${verdict} ${JSON.stringify(results)}`);
  if (!cleanup.ok) log.log(cleanup.detail);
  return { verdict, results, path, cleanup, exitCode: !cleanup.ok ? 3 : ok ? 0 : 1 };
}

module.exports = { parseArgs, refuseEmulatorEnv, dotenvLines, readBucketParams, dryRunMessage, resolveTargets, checkTarget, makeGenerationOps, runCheck, acceptancePath };
