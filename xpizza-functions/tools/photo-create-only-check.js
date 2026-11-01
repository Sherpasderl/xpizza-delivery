#!/usr/bin/env node
'use strict';
// DISH PHOTOS E4 (3) — the OWNER's real-GCS create-only check (a deploy-time acceptance item; the executor never runs it against prod).
// Run it from the DEPLOY checkout (its xpizza-functions/.env and .env.<project> hold the photo bucket params production reads):
//
//   node tools/photo-create-only-check.js --project xpizza-delivery --bucket <the private photo bucket>          # prints the plan, writes nothing
//   node tools/photo-create-only-check.js --project xpizza-delivery --bucket <the private photo bucket> --yes    # the owner
//
// Two CONCURRENT create-only saves of ONE throwaway object drafts/__acceptance__/e4-<random>-card.webp through the real adapter
// (photos/gcs-store.js) → PASS iff exactly one creates and the other meets the 412 with the same generation; then ONLY the generations
// this run created are deleted, generation-scoped, and verified gone. THEN the E5 generation pin on a second throwaway object
// drafts/__acceptance__/e5-<random>-card.webp: created, overwritten once, read pinned to its first generation → unversioned bucket:
// refused; versioned: the old bytes (both correct); the new bytes = FAIL. Its generations are cleaned the same way.
// THEN the A2-E4 delete precondition on a third, drafts/__acceptance__/del-<random>-card.webp: created, overwritten once, deleted by the
// photo sweeper's own deleter (photos/sweep-io.js) pinned to its first generation → must be refused, the re-created object kept.
// Exit = the worst of the three (3 cleanup > 2 REFUSED > 1 FAIL > 0 PASS). Logic, refusals and exit codes: tools/photo-create-only-check-core.js.
// REFUSED (exit 2, nothing touched) before any client: no --project (require-project); a storage-emulator variable; a private or public
// bucket identity that cannot be resolved (photos/buckets.js over the project's dotenv params — never the operator's shell); the two equal;
// --bucket not the private one. There is deliberately NO privacy probe (bucket IAM alone cannot prove privacy; see the core's header).
const path = require('path');
const crypto = require('crypto');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // before any client
const C = require('./photo-create-only-check-core');
const refuse = (why) => { console.error(`photo-create-only-check: REFUSED — ${why}`); process.exit(2); };

const args = C.parseArgs(process.argv.slice(2));
if (args.error) refuse(args.error);
const emu = C.refuseEmulatorEnv(process.env);
if (emu) refuse(emu);
let params;
try { params = C.readBucketParams(path.join(__dirname, '..'), PROJECT_ID); } catch (e) { refuse(`the project's dotenv could not be read — ${String((e && e.message) || e).slice(0, 120)}`); }
const { privateBucket, publicBucket } = C.resolveTargets({ projectId: PROJECT_ID, params });
const why = C.checkTarget({ bucket: args.bucket, privateBucket, publicBucket });
if (why) refuse(why);

if (!args.yes) {
  console.log(C.dryRunMessage({ projectId: PROJECT_ID, privateBucket, publicBucket, bucket: args.bucket }));
  process.exit(0);
}

const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT_ID });
const bucket = admin.storage().bucket(args.bucket);
const { makeGcsStore } = require('../photos/gcs-store');
const { makeGcsDeleter } = require('../photos/sweep-io');

(async () => {
  const deps = { store: makeGcsStore(bucket), gens: C.makeGenerationOps(bucket), randomHex: () => crypto.randomBytes(8).toString('hex') };
  const r = await C.runCheck(deps);
  const pin = await C.runPinCheck(deps);
  const del = await C.runDeletePinCheck({ ...deps, deleter: makeGcsDeleter(bucket) });
  console.log(JSON.stringify({ project: PROJECT_ID, bucket: args.bucket,
    createOnly: { path: r.path, verdict: r.verdict, results: r.results, reason: r.reason, cleanup: r.cleanup },
    generationPin: { path: pin.path, verdict: pin.verdict, outcome: pin.outcome, versioning: pin.versioning, reason: pin.reason, cleanup: pin.cleanup },
    deletePrecondition: { path: del.path, verdict: del.verdict, result: del.result, reason: del.reason, cleanup: del.cleanup } }, null, 1));
  process.exit(C.combineExit(r.exitCode, pin.exitCode, del.exitCode));
})().catch((e) => { console.error(`photo-create-only-check: ERROR — ${String((e && e.message) || e).slice(0, 200)}`); process.exit(3); });
