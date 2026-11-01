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
// E5 — the GENERATION PIN (advisor 2026-11-01; the Storage emulator ignores `generation` on media reads — probe
// xpizza-D4c-grill/dish-photos-heavy-dce03b96/e5-probe/RESULT.md — so only real GCS can show it). A second throwaway object
// drafts/__acceptance__/e5-<16 random hex>-card.webp: create-only v1 → a plain overwrite v2 (a new generation) → a read through the
// real adapter PINNED to v1's generation. The correct outcome depends on the bucket's object versioning:
//   unversioned → the old generation is gone → REFUSED (generation_mismatch);  versioned → it survives noncurrent → v1's OLD bytes
//   (still correct: exactly the bytes the metadata described). v2's bytes = the pin ignored → FAIL. Versioning unreadable → either
//   correct outcome passes and the report says it was unknown. Cleanup as E4: only this run's generations, generation-scoped, verified.
const { privateBucketName, publicBucketName } = require('../photos/buckets');
const RE_HEX16 = /^[0-9a-f]{16}$/;
const PARAM_KEYS = Object.freeze(['PHOTOS_PRIVATE_BUCKET', 'PHOTOS_PUBLIC_BUCKET']);
const EMULATOR_VARS = Object.freeze(['FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST']);
const is404 = (e) => e && (e.code === 404 || e.code === '404');

function acceptancePath(hex) {
  if (!RE_HEX16.test(String(hex))) throw new Error('acceptancePath needs 16 random hex characters');
  return `drafts/__acceptance__/e4-${hex}-card.webp`;
}

function pinPath(hex) {
  if (!RE_HEX16.test(String(hex))) throw new Error('pinPath needs 16 random hex characters');
  return `drafts/__acceptance__/e5-${hex}-card.webp`;
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
  return `photo-create-only-check: DRY — project ${projectId}; private ${privateBucket}, public ${publicBucket}. With --yes: write ONE throwaway object drafts/__acceptance__/e4-<random>-card.webp to gs://${bucket} twice, concurrently, create-only; then ONE more, drafts/__acceptance__/e5-<random>-card.webp, created, overwritten once, and read pinned to its first generation (unversioned → refused; versioned → the old bytes); then delete only the generations it created, generation-scoped, and verify them gone.`;
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
    // E5: a PLAIN save (no precondition) → the new live generation
    async overwrite(path, buf, { contentType } = {}) {
      const f = bucket.file(path); await f.save(buf, { resumable: false, contentType }); return String(f.metadata.generation);
    },
    // E5: the bucket's object versioning → true / false (the caller treats a failed read as unknown)
    async versioningEnabled() { const [m] = await bucket.getMetadata(); return !!(m && m.versioning && m.versioning.enabled === true); },
  };
}

// delete ONLY the generations `held` (this run's), generation-scoped, verify each gone, and report anything else left live
async function cleanupHeld(path, held, { store, gens }) {
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
  return cleanup;
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

  const cleanup = await cleanupHeld(path, held, { store, gens });
  log.log(`photo-create-only-check: ${verdict} ${JSON.stringify(results)}`);
  if (!cleanup.ok) log.log(cleanup.detail);
  return { verdict, results, path, cleanup, exitCode: !cleanup.ok ? 3 : ok ? 0 : 1 };
}

// E5 — see the header. Never throws: every failure is a FAIL result, and cleanup always runs over what this run created.
async function runPinCheck({ store, gens, randomHex, log = console }) {
  const path = pinPath(randomHex());
  if (await store.metadata(path)) return { verdict: 'REFUSED', reason: `${path} already exists`, path, exitCode: 2 };
  const V1 = Buffer.from('e5-v1'), V2 = Buffer.from('e5-v2-replaced');
  const held = new Set();
  let outcome = null, versioning = null, reason = '', pass = false;
  try {
    const c = await store.createIfAbsent(path, V1, { contentType: 'image/webp' });
    if (c && c.created === true) held.add(String(c.generation));
    if (!c || c.created !== true) reason = 'the create-only save did not create';
    else {
      const g2 = String(await gens.overwrite(path, V2, { contentType: 'image/webp' }));
      held.add(g2);
      if (g2 === String(c.generation)) reason = 'the overwrite kept the generation';
      else {
        try {
          const b = await store.download(path, { generation: String(c.generation), maxBytes: 1024 });
          outcome = b.equals(V1) ? 'pinned_old_bytes' : b.equals(V2) ? 'new_bytes' : 'other_bytes';
        } catch (e) { outcome = e && e.code === 'generation_mismatch' ? 'refused' : `error:${String((e && (e.code || e.message)) || e).slice(0, 60)}`; }
        try { versioning = await gens.versioningEnabled(); } catch (_) { versioning = null; }
        const want = versioning === true ? ['pinned_old_bytes'] : versioning === false ? ['refused'] : ['refused', 'pinned_old_bytes'];
        pass = want.includes(outcome);
        if (!pass) reason = `the read pinned to the first generation → ${outcome}; expected ${want.join(' or ')} (versioning ${versioning === null ? 'unknown' : versioning ? 'on' : 'off'})`;
      }
    }
  } catch (e) { reason = String((e && e.message) || e).slice(0, 160); }
  const verdict = pass ? 'PASS' : 'FAIL';
  const cleanup = await cleanupHeld(path, held, { store, gens });
  log.log(`photo-create-only-check (generation pin): ${verdict} ${JSON.stringify({ outcome, versioning })}${reason ? ` — ${reason}` : ''}`);
  if (!cleanup.ok) log.log(cleanup.detail);
  return { verdict, outcome, versioning, reason, path, cleanup, exitCode: !cleanup.ok ? 3 : pass ? 0 : 1 };
}

// the CLI's exit code over both checks: cleanup trouble (3) > REFUSED (2) > FAIL (1) > PASS (0)
const combineExit = (...codes) => [3, 2, 1].find((c) => codes.includes(c)) || 0;

module.exports = { parseArgs, refuseEmulatorEnv, dotenvLines, readBucketParams, dryRunMessage, resolveTargets, checkTarget, makeGenerationOps, runCheck, acceptancePath, pinPath, runPinCheck, combineExit, cleanupHeld };
