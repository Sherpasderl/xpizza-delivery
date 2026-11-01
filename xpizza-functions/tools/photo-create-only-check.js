#!/usr/bin/env node
'use strict';
// DISH PHOTOS E4 (3) — the OWNER's real-GCS create-only check (a deploy-time acceptance item; the executor never runs it against prod):
//
//   node tools/photo-create-only-check.js --project xpizza-delivery --bucket <the private photo bucket>          # prints the plan, writes nothing
//   node tools/photo-create-only-check.js --project xpizza-delivery --bucket <the private photo bucket> --yes    # the owner
//
// Two CONCURRENT create-only saves of ONE throwaway object drafts/__acceptance__/e4-<random>-card.webp through the real adapter
// (photos/gcs-store.js) → PASS iff exactly one creates and the other meets the 412 with the same generation; then ONLY the generations
// this run created are deleted (generation-matched, photos/sweep-io.js) and the path is confirmed gone. Logic + exit codes:
// tools/photo-create-only-check-core.js. The project is NEVER inferred (require-project, --project mandatory); --bucket has no default and
// must equal the configured PRIVATE bucket (photos/buckets.js), never the public one. A refusal touches nothing.
const crypto = require('crypto');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // before any client
const { parseArgs, checkTarget, runCheck, acceptancePath } = require('./photo-create-only-check-core');

const args = parseArgs(process.argv.slice(2));
if (args.error) { console.error(`photo-create-only-check: REFUSED — ${args.error}`); process.exit(2); }
const { privateBucketName, publicBucketName } = require('../photos/buckets');
let expectedBucket = '';
try { expectedBucket = privateBucketName({ param: () => process.env.PHOTOS_PRIVATE_BUCKET || '', env: { GCLOUD_PROJECT: PROJECT_ID } }); } catch (_) { expectedBucket = ''; }
const refusal = checkTarget({ bucket: args.bucket, expectedBucket, publicBucket: publicBucketName({ param: () => process.env.PHOTOS_PUBLIC_BUCKET || '' }) });
if (refusal) { console.error(`photo-create-only-check: REFUSED — ${refusal}`); process.exit(2); }

if (!args.yes) {
  console.log(`photo-create-only-check: DRY — would write ONE throwaway object ${acceptancePath('0'.repeat(16)).replace('0'.repeat(16), '<random>')} to gs://${args.bucket} (project ${PROJECT_ID}) twice, concurrently, create-only; then delete only the generation(s) it created. Re-run with --yes.`);
  process.exit(0);
}

const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT_ID });
const bucket = admin.storage().bucket(args.bucket);
const { makeGcsStore } = require('../photos/gcs-store');
const { makeGcsDeleter } = require('../photos/sweep-io');

runCheck({ store: makeGcsStore(bucket), deleter: makeGcsDeleter(bucket), randomHex: () => crypto.randomBytes(8).toString('hex') })
  .then((r) => {
    console.log(JSON.stringify({ project: PROJECT_ID, bucket: args.bucket, path: r.path, verdict: r.verdict, results: r.results, reason: r.reason, cleanup: r.cleanup }, null, 1));
    process.exit(r.exitCode);
  })
  .catch((e) => { console.error(`photo-create-only-check: ERROR — ${String((e && e.message) || e).slice(0, 200)} (nothing was written if this happened before the creates)`); process.exit(3); });
