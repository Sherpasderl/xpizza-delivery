'use strict';
/* THE §10 CUTOVER STEP, AS SOMETHING AN OPERATOR CAN ACTUALLY RUN.
 *
 * 🔴 WHY THIS FILE EXISTS. §10 says: "Run the one-time BOOTSTRAP STAMPING PASS (stamps x_pizza's live
 * version, marks ONLY the pointer-named version activated, reconciles legacy orphans — §3.0) as part
 * of the P1a cutover, before renames are ever enabled." `bootstrapIdentityStamps` was defined and
 * exported and had NO CALLER outside tests — no CLI, no npm script, nothing callable. The operation
 * the entire deploy depends on could not be run.
 *
 * That is the fourth spec-described operation this slice found absent from the tree, after the staging
 * flag (three comments, no read), the retirement (a consumed claim retired nothing), and the mint
 * path's end-to-end coverage. This one is the worst of the four only because it is the step that makes
 * every other thing take effect.
 *
 * 🔴 --dry-run IS THE DEFAULT AND --apply IS WHAT YOU TYPE. For a one-way door against a live menu the
 * safe mode must be the one you get by NOT THINKING. The pass writes in place and has no undo — it
 * stamps every object of the active version, certifies that version, and enriches the merchant's
 * source — so the first WRITE should happen only after a read-only run someone has read. The dry-run
 * output IS the pre-flight artefact: compare it against the menu, then apply.
 *
 * 🔴 AND THE PROJECT GUARD RUNS BEFORE ANYTHING ELSE, at require time, exactly as backfill-identities
 * does: before a credential is resolved, before a client exists, before a byte is read. `requireFlag`
 * means --project must be a FLAG — an inherited or stale GOOGLE_CLOUD_PROJECT would otherwise satisfy
 * the contract without the operator ever looking at which database they were about to stamp.
 *
 * EXIT CODES, and they are load-bearing for a script:
 *   0  the pass completed (or the dry run printed a plan)
 *   1  the tool's own failure — bad usage, an over-budget version, a refused pass
 *   2  RESERVED FOR THE PROJECT GUARD and nothing else, so "you pointed this at the wrong database" is
 *      distinguishable from "the work failed". backfill-identities.js:64 used to exit 2 for a usage
 *      error and that collision is why this one is stated here.
 *
 * 🔴 THE CUTOVER IS FOUR STEPS, NOT TWO, AND THAT IS THE POINT. The orphan half cannot be rehearsed
 * until the stamps exist (see the §3.0 block below), so it is SKIPPED by the first apply rather than
 * performed unrehearsed. Every one-way action is therefore preceded by a run that shows it:
 *
 * USAGE — run them in this order, one brand per run
 *   1. node tools/bootstrap-identity.js --rid=x_pizza --project xpizza-delivery            DRY RUN: stamping plan
 *   2. node tools/bootstrap-identity.js --rid=x_pizza --project xpizza-delivery --apply    WRITES: stamps + certifies ONLY
 *   3. node tools/bootstrap-identity.js --rid=x_pizza --project xpizza-delivery            DRY RUN: orphan plan
 *   4. node tools/bootstrap-identity.js --rid=x_pizza --project xpizza-delivery --apply    WRITES: retires the orphans
 *
 * Step 4 does not re-stamp — the stamping pass returns early on an already-certified version. Step 2
 * prints "STAMPING DONE — THE CUTOVER IS NOT FINISHED" rather than "DONE", because an operator who
 * reads "DONE" stops, and the retirements §3.0 asks for would never happen.
 */
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });

try { require('dotenv').config(); } catch (_) { /* dotenv is a devDependency; this needs only ADC */ }
const admin = require('firebase-admin');
const { bootstrapIdentityStamps, reconcileLegacyOrphans, readActiveVersion } = require('../catalog/identity-bootstrap');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
};
const RID = arg('rid');
const APPLY = process.argv.includes('--apply');
const KNOWN = ['x_pizza', 'la_musa'];

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT_ID,   // NEVER the ambient gcloud default
});
const db = admin.firestore();

(async () => {
  if (!RID || !KNOWN.includes(RID)) {
    console.error('usage: node tools/bootstrap-identity.js --rid=<x_pizza|la_musa> --project <id> [--apply]\n'
                + '       omit --apply for a DRY RUN — the default, because this pass has no undo\n'
                + '       one brand per run, deliberately — see the 1D runbook');
    process.exit(1);   // 🔴 NOT 2: exit 2 is the project guard's alone
  }

  /* 🔴 SAY WHICH MODE, FIRST, BEFORE ANY WORK. An operator who believes they are rehearsing and is
     actually applying is the failure this tool is shaped to prevent, and a line at the end is read
     after the writes have happened. */
  console.log(`\n${APPLY ? '🔴 APPLY — THIS WRITES, IN PLACE, WITH NO UNDO' : 'DRY RUN — nothing will be written (pass --apply to write)'}`);
  console.log(`  restaurant: ${RID}`);
  console.log(`  project:    ${PROJECT_ID}\n`);

  let active;
  try {
    active = await readActiveVersion(db, RID);
  } catch (e) {
    console.error(`\ncannot read ${RID}'s active version: ${(e && e.message) || e}`);
    console.error('Nothing was written. The pass stamps the version the pointer names, so there must be one.\n');
    process.exit(1);
  }
  console.log(`  active version: ${active.versionId} (generation ${active.generation})`);
  console.log(`  already certified: ${active.record.identity_certified === true}`);

  /* THE STAMPING PASS. In dry-run it stops at the last line before any write and reports the plan. */
  let stampReport;
  try {
    stampReport = await bootstrapIdentityStamps(db, RID, { dryRun: !APPLY });
  } catch (e) {
    console.error(`\nREFUSED — ${(e && e.message) || e}`);
    console.error('Nothing was written.\n');
    process.exit(1);
  }

  if (stampReport.already) {
    console.log('\n  this version is ALREADY certified — the pass is idempotent and did nothing.');
  } else if (!APPLY) {
    console.log(`\n  WOULD certify version ${stampReport.would_certify}`);
    console.log(`  WOULD stamp ${stampReport.dishes} dish(es) and ${stampReport.extras} extra(s), and enrich the source with the same ids:`);
    for (const kind of ['dish', 'extra']) {
      for (const o of (stampReport.would_stamp[kind] || [])) console.log(`    ${kind.padEnd(5)} ${o.canonical_id}  ${o.key}`);
    }
  } else {
    console.log(`\n  STAMPED ${stampReport.dishes} dish(es) and ${stampReport.extras} extra(s); version ${stampReport.version} is certified.`);
  }

  /* ── THE ORPHAN RECONCILIATION (§3.0) ────────────────────────────────────────────────────────
     🔴 IT CANNOT BE REHEARSED BEFORE THE STAMPS EXIST, AND THAT IS STATED RATHER THAN HIDDEN.
     `reconcileLegacyOrphans` refuses an uncertified version outright —
     `identity_reconcile_uncertified: … stamp it before reconciling, or the certified half of the
     predicate is empty` — because it decides what is orphaned by comparing the registry against the
     CERTIFIED set, and on an unstamped version that set is empty, which would make every live id look
     orphaned. So on a first dry run there is nothing honest to report about this half.
     Discovered by RUNNING the tool: the first dry run printed a perfect stamping plan and then exited
     1 on this refusal. The wrong fixes were to swallow it or to fake a plan; the right one is to say
     which half was rehearsed and which could not be, so the operator knows what they have approved.
     A dry run that silently covered one of two halves would be the worst artefact here.

     🔴 AND SAYING IT WAS NOT ENOUGH — THE FIRST VERSION OF THIS TOOL SAID ALL OF THE ABOVE AND THEN DID
     THE UNREHEARSED THING ANYWAY. `canReconcile` was `APPLY || certified`, so the apply this very
     paragraph told the operator to run performed the retirement it promised they would see first. The
     observation was right and the remedy attached to it was false, which is the harder error to catch:
     an honest, detailed disclosure reads as though the problem has been handled. The remedy is
     STRUCTURAL, not textual — skip the half that cannot be rehearsed, and make the operator run a
     rehearsal for it — and it is directly below. */
  /* 🔴 CERTIFICATION ALONE. `APPLY ||` USED TO BE HERE, AND IT BROKE THE PROMISE THE LINE BELOW MAKES.
     With `APPLY ||`, canReconcile was true on the FIRST apply whatever the certification state, and
     `dryRun: !APPLY` was then false — so the very apply this tool told the operator to run was the one
     that RETIRED, unrehearsed, while the message assured them they would see the plan first. On a
     one-way door against a live menu that is worse than an undisclosed limitation: an operator who
     reads only this output ends with retirements they never approved, believing the opposite.
     `active` is read BEFORE the stamping pass, so on a first apply this is false and the orphan half is
     SKIPPED, not silently performed. That makes the sequence four steps, every one-way action rehearsed
     before it happens:
        1. dry run   → the stamping plan (orphan half cannot be rehearsed; it says so)
        2. --apply   → stamps and certifies ONLY
        3. dry run   → now the orphan plan, against a certified version
        4. --apply   → retires
     Step 4 does not re-stamp: bootstrapIdentityStamps returns early on an already-certified version
     (identity-bootstrap.js:216) with `already: true`, which this tool reports as a no-op. VERIFIED in
     that function rather than assumed, because the whole sequence rests on it. */
  const canReconcile = active.record.identity_certified === true;
  let orphanReport = null;
  if (!canReconcile) {
    if (APPLY) {
      console.log('\n  orphans: NOT PERFORMED — and deliberately so. This apply STAMPED ONLY.');
      console.log('           The orphan pass compares the registry against the CERTIFIED set, which did');
      console.log('           not exist when this run started, so there was nothing to rehearse and');
      console.log('           nothing has been retired.');
      console.log('           🔴 NEXT: run a DRY RUN to see the orphan plan, then --apply again to retire.');
    } else {
      console.log('\n  orphans: NOT REHEARSED. The orphan pass compares the registry against the CERTIFIED');
      console.log('           set, which does not exist until the stamps land — it refuses an uncertified');
      console.log('           version rather than treating every live id as orphaned.');
      console.log('           --apply will therefore STAMP ONLY and retire nothing. To see the orphan plan:');
      console.log('           --apply (stamps), then a DRY RUN (shows the plan), then --apply again (retires).');
    }
  } else {
    try {
      orphanReport = await reconcileLegacyOrphans(db, RID, { dryRun: !APPLY });
    } catch (e) {
      console.error(`\nthe stamping pass ${APPLY ? 'COMPLETED' : 'was rehearsed'}, but orphan reconciliation failed: ${(e && e.message) || e}`);
      console.error(APPLY ? 'The stamps are written and correct. Re-run to finish the reconciliation.\n' : 'Nothing was written.\n');
      process.exit(1);
    }
    console.log(`\n  orphans: ${orphanReport.orphans} found of ${orphanReport.scanned} scanned — ${APPLY ? `${orphanReport.retired} retired` : 'would be retired (see identity_bootstrap_orphan lines above)'}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN COMPLETE. Nothing was written.');
    console.log(canReconcile
      ? 'Read the plan above against the live menu, then re-run with --apply.\n'
      : 'Read the stamping plan above against the live menu, then re-run with --apply.\n'
        + 'The ORPHAN half was not rehearsed — see above — so run a dry run again afterwards.\n');
  } else if (stampReport.already && canReconcile) {
    console.log('\nDONE. The orphan reconciliation ran; the version was already certified, so nothing was re-stamped.');
    console.log('This is a one-way door: re-running is a no-op, not a revert.\n');
  } else if (canReconcile) {
    console.log('\nDONE. The version is certified, the source carries the ids, and the orphan pass ran.');
    console.log('This is a one-way door: re-running is a no-op, not a revert.\n');
  } else {
    /* 🔴 DO NOT SAY "DONE" FOR A HALF-FINISHED CUTOVER. The stamps landed and the orphan half has not
       run at all; an operator told "DONE" here stops, and the retirements §3.0 asks for never happen. */
    console.log('\nSTAMPING DONE — THE CUTOVER IS NOT FINISHED.');
    console.log('The version is certified and the source carries the ids. NO ORPHAN WAS RETIRED.');
    console.log('🔴 NEXT: run this again WITHOUT --apply to see the orphan plan, then with --apply to retire.');
    console.log('The stamping half is a one-way door: re-running is a no-op, not a revert.\n');
  }
  process.exit(0);
})().catch((e) => {
  console.error('\nbootstrap-identity failed:', (e && e.message) || e);
  console.error('Any rows already written are CORRECT and must not be deleted — re-run to finish.\n');
  process.exit(1);
});
