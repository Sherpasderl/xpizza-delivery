'use strict';
// ---------------------------------------------------------------------------
// THE PINNED ALLOWLIST of every `firebase … deploy` instruction in the repo (codex stats build r5; advisor
// ruling 2026-10-05). tools/deploy-instruction-scan.test.js requires the repo's occurrences — normalized by
// tools/deploy-instruction-scan.js — to equal this list EXACTLY (file, command, count). A NEW or CHANGED
// deploy instruction anywhere fails the test with its file and line, until a reviewed pin is added here.
//
// Each entry is classified by tools/deploy-instruction-classify.js, and the test re-derives the class:
//   functions-only    --only functions / functions:<name>[,…]
//   hosting-database  --only database / hosting
//   rules-only        --only firestore:rules        (runs firebase.json's firestore predeploy hooks)
//   wrapper-doc       the sanctioned wrapper's documented command (only in its three own files)
//   mention           a bare prose mention of the CLI verb, with no flags — not an instruction
// Nothing FORBIDDEN may be pinned: no --force, no bare `firestore`, no firestore:indexes outside the wrapper,
// no flags without --only. Reviewed and classified 2026-10-05 (42 occurrences in 40 entries).
// ---------------------------------------------------------------------------
const PINS = [
  { file: "FACTURA_HANDOFF_BRIEF.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "HANDOFF-order-number-and-abandoned-cancel-DEPLOY.md", command: "firebase deploy --only functions --project xpizza-delivery", class: "functions-only", count: 1 },
  { file: "KDS_2C_PLAN.md", command: "firebase deploy --only database", class: "hosting-database", count: 1 },
  { file: "KDS_2C_PLAN.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "LA_MUSA_DEPLOY_RUNBOOK.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "LA_MUSA_DEPLOY_RUNBOOK.md", command: "firebase deploy --only functions --project xpizza-delivery", class: "functions-only", count: 1 },
  { file: "LA_MUSA_DEPLOY_RUNBOOK_S3.md", command: "firebase deploy --only functions --project xpizza-delivery", class: "functions-only", count: 1 },
  { file: "LA_MUSA_EXECUTOR_PROMPT.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "LA_MUSA_HANDOFF_BRIEF.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "LA_MUSA_PHASE0_STATUS.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "LA_MUSA_PROPOSAL_E.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "PHASE1_STEP1B_QUALITY_RUNNER.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "README.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "REWARDS_B2_GOLIVE_RUNBOOK.md", command: "firebase deploy --only database", class: "hosting-database", count: 1 },
  { file: "REWARDS_B2_GOLIVE_RUNBOOK.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "VERSION.md", command: "firebase deploy --only database", class: "hosting-database", count: 1 },
  { file: "docs/superpowers/HANDOFF-online-order-received.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "docs/superpowers/HANDOFF-online-order-received.md", command: "firebase deploy --only functions:sendOrderStatusNotifications", class: "functions-only", count: 1 },
  { file: "docs/superpowers/handoffs/2026-07-24-user-profiles-p0-frontend-executor-handoff.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "docs/superpowers/plans/2026-06-28-driver-p2-stacked-p3-cash.md", command: "firebase deploy --only database", class: "hosting-database", count: 1 },
  { file: "docs/superpowers/plans/2026-07-24-user-profiles-p0-backend.md", command: "firebase deploy --only database", class: "hosting-database", count: 1 },
  { file: "docs/superpowers/plans/2026-07-24-user-profiles-p0-backend.md", command: "firebase deploy --only functions --project xpizza-delivery", class: "functions-only", count: 1 },
  { file: "docs/superpowers/plans/2026-07-24-user-profiles-p0-frontend.md", command: "firebase deploy --only functions", class: "functions-only", count: 2 },
  { file: "docs/superpowers/plans/2026-08-25-phase1a-catalog-schema-parity.md", command: "firebase deploy --only firestore:rules", class: "rules-only", count: 1 },
  { file: "docs/superpowers/plans/2026-09-26-preparing-whatsapp-notification.md", command: "firebase deploy --only functions:notifyPreparing", class: "functions-only", count: 1 },
  { file: "docs/superpowers/runbooks/2026-09-06-portal-2a-cutover.md", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "docs/superpowers/runbooks/2026-09-07-portal-2b2a-golive.md", command: "firebase deploy --only functions:getMyRestaurants,functions:getEditableCatalog", class: "functions-only", count: 2 },
  { file: "docs/superpowers/runbooks/2026-09-14-portal-1b-smoke.md", command: "firebase deploy --only functions:getPublicMenu --project xpizza-delivery", class: "functions-only", count: 1 },
  { file: "docs/superpowers/runbooks/2026-09-18-portal-1d-D1-identity.md", command: "firebase deploy --only functions --project xpizza-delivery", class: "functions-only", count: 1 },
  { file: "docs/superpowers/specs/2026-08-04-driver-accept-diagnostics-optionB.md", command: "firebase deploy --only functions:driverDiagIngest", class: "functions-only", count: 1 },
  { file: "docs/superpowers/specs/2026-08-09-whatsapp-conversation-mute.md", command: "firebase deploy --only functions:onIncomingWhatsApp", class: "functions-only", count: 1 },
  { file: "xpizza-functions/claim-order-discovery.test.js", command: "firebase deploy", class: "mention", count: 1 },
  { file: "xpizza-functions/claim-order-discovery.test.js", command: "firebase deploy source discovery has no runtime env", class: "mention", count: 1 },
  { file: "xpizza-functions/claim-order.js", command: "firebase deploy", class: "mention", count: 1 },
  { file: "xpizza-functions/package.json", command: "firebase deploy --only database", class: "hosting-database", count: 1 },
  { file: "xpizza-functions/package.json", command: "firebase deploy --only functions", class: "functions-only", count: 1 },
  { file: "xpizza-functions/scripts/test-ingest.js", command: "firebase deploy", class: "mention", count: 1 },
  { file: "xpizza-functions/tools/deploy-indexes.js", command: "firebase deploy --only firestore:indexes --non-interactive --project <pinned-and-checked>", class: "wrapper-doc", count: 1 },
  { file: "xpizza-functions/tools/firebase-cli-nodelete.js", command: "firebase deploy --only firestore:indexes --non-interactive --project <pinned>", class: "wrapper-doc", count: 1 },
  { file: "xpizza-functions/tools/firestore-indexes-report.js", command: "firebase deploy --only firestore:indexes --non-interactive", class: "wrapper-doc", count: 1 },
];

module.exports = { PINS };
