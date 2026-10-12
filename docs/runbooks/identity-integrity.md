# Runbook: the identity integrity monitor (alerts, findings, rollout)

Design: `PLAN-D4c2b.md` rev 14. Code:
- `xpizza-functions/catalog/identity-integrity.js` (what a finding means);
- `xpizza-functions/catalog/identity-integrity-state.js` (how findings are kept);
- `xpizza-functions/catalog/identity-integrity-monitor.js` (the scheduled checks; `verifyIdentityIntegrity` in `index.js`);
- tools:
  - `tools/record-evidence-boundary.js`
  - `tools/ack-identity-finding.js`
  - `tools/setup-identity-alerts.js` (with `tools/identity-alerts.json`)

## What it is — and what it never does

Every 15 minutes the monitor checks, for every restaurant:
- **A. The active binding.** The live version's identity stamps against the evidence c2a recorded when that version was certified: coverage, the `final_digest` recomputed from the version docs, and the registry rows.
- **B. The activation audit.** Every activation since the boundary, in order, including that each rollback restored an unaltered version.

It is ALERT-ONLY:
- It never blocks, repairs or rolls back anything.
- It writes only its own state, `catalog_integrity/{rid}` in RTDB. No client can read or write that state.
- Every Firestore read is in a read-only transaction: no locks, no retries.
- Reads are paced at ≤ 100 per second, one restaurant at a time.
- It SKIPS a restaurant the merchant is working on right now: a live publish lease, a draft edited in the last 10 min, or a pointer that moved in the last 10 min. That restaurant is checked once idle.

It does NOT check (deferred to c2c):
- the RTDB mirror/carrier copies;
- a retained version BEFORE it is activated.

An altered rollback target is detected by the audit after the rollback completes, not before.

## Alerts — what each email means

Alerts are LEVEL-triggered from the monitor's state. Every run writes one `identity_integrity_state` line per restaurant: `{rid, open_violations, open_gaps, open_degraded, stale}`.

| Email | Means | First step |
|---|---|---|
| `open_violations > 0` | an open VIOLATION finding (table below) | `--list`, then confirm read-only (below) |
| `open_degraded > 0` | a registry key row missing for > 2 h on a live object | confirm; repair the key row (D1 tooling) |
| `stale > 0` | the restaurant is NOT being checked. Reasons, in the run log `stale_reasons`: `coverage_gap` (no completed check for 45 min, not explained by merchant activity); `merchant_active` (deferred for activity for > 2 h); `backlog` / `backlog_age` (the audit is > 40 generations or > 2 h behind); `state_growth` (> 2,000 findings or > 1 MiB of state); `state_unreadable` | read `identity_integrity_check` / `identity_integrity_run` logs for that rid |
| heartbeat absent 45 min | no run completed its enumeration with nothing stale | check the job is ENABLED, then the function logs |
| `open_gaps > 0` | (no email — informational) unattested generations, or rollbacks whose history predates c2a | review at leisure |

A finding stays OPEN until YOU acknowledge it — even after the condition clears, by a repair or a new publish. So an alert keeps firing every 15 min until acknowledged; it can never be lost to a crash. Acknowledge only after confirming the cause.

## Findings: meaning and read-only confirmation

List them:

```bash
cd xpizza-functions
node tools/ack-identity-finding.js --project xpizza-delivery --rid <rid> --list
```

| Finding (class) | Meaning | Confirm (read-only) |
|---|---|---|
| `stamps_changed` (violation) | The live version's identity stamps differ from what was certified (digest mismatch) | Recompute with `finalDigestOfVersion` over the version docs vs the evidence `final_digest`. Compare the version's `menu_items` / `extras` `display.identity_id` with the previous known-good export |
| `coverage_broken` (violation) | An object unstamped, an id duplicated in a kind, or the object count ≠ the certified `final_count` | Count the version docs and their stamps |
| `registry_disagrees` (violation) | A live object's `ids/*` or `keys/*` row disagrees (retired, foreign kind, names another key/id) | Read the named rows (`identity/{kind}/ids|keys`) |
| `decertified` (violation) | A version certified before is no longer `identity_certified` | Read `versions/{v}.identity_certified` and the version's evidence |
| `evidence_malformed` / `evidence_mismatch` (violation) | An evidence doc of the wrong shape, or naming another version/generation | Read the doc in `identity_evidence` |
| `active_version_missing` (violation) | The pointer names a version record that does not exist | Read `meta/active_version` and `versions/{v}` |
| `rollback_target_altered` (violation) | A certified rollback's `final_digest` ≠ its version's binding origin (first certified publish or certification) | Compare the two evidence docs |
| `degraded` (degraded) | A `missing_key_row` pair, unrepaired for > 2 h | Read the key row |
| `unattested{generation_gap}` (gap) | An activation since the boundary has no evidence: an old CLI was used | Which CLI ran then? Every activation CLI must run from the merged SHA or later |
| `unattested{boundary_unknown}` / `{pre_boundary}` (gap) | Generation recorded before the boundary was known / relabelled after it was written | Informational |
| `history_unknown` (gap) | A rollback to a version whose original publish predates c2a (no binding origin) | Informational; republishing attests it |

Acknowledge (DRY RUN unless `--apply`):

```bash
node tools/ack-identity-finding.js --project xpizza-delivery --rid <rid> --finding <id> --note "<what you checked and found>" --by "<your name>" --apply
```

Acknowledgement and the summary update are one transaction, so the next summary line already excludes the finding. If the condition comes back later, a NEW finding opens.

## Containment (a real violation)

1. **Stop new orders for that restaurant** with c4's order control (`docs/runbooks/order-control.md`): `node tools/order-control.js --project xpizza-delivery --rid <rid> --pause [--for 2h] --reason "identity integrity" --actor "<you>" --apply`. It never touches money or orders already paid.
2. **Do not publish or roll back while investigating.** A publish holds the 120 s lease (`catalog-publish.js:66`), and you would overwrite the state you need to read.
3. **Recover by activating a VERIFIED state, never by editing a certified version in place:**
   - publish a NEW version from a verified draft; or
   - roll back to a version whose binding origin verifies (its rollback evidence must match the origin's `final_digest`).
4. Resume orders (`--resume`) after the next monitor run shows the active binding `ok`. Then acknowledge the finding with what you found.

The recovery steps were rehearsed on the emulators through the real publish path (`test/c2b-integrity.emulator.test.js`).

### Known cause: an operator re-add of a deleted or used name (certified restaurant)

An operator publish (`tools/publish-version.js`, or `publishVersion` directly) of a draft that RE-ADDS a deleted name, or reuses a used name on another object, writes a version marked `identity_certified` with that object UNSTAMPED. That is a real anomaly ("certified but a stamp is broken"), so the monitor opens `coverage_broken` with `unstamped` = the number of re-added objects, and a new one at every later generation that still carries them. The merchant portal cannot produce this: it refuses a client-supplied key for a new product.

What to do — do NOT just acknowledge:
1. Confirm it: the active version's `menu_items` / `extras` without `display.identity_id` are exactly the re-added names.
2. Re-certify the restaurant with the bootstrap CLI (pause the monitor job first, see below): `node tools/bootstrap-identity.js --rid=<rid> --project xpizza-delivery` (dry run: review the stamping plan, then add `--apply`), or roll back to the last version the monitor reported `ok`.
3. After the next monitor run shows the active binding `ok`, acknowledge each `coverage_broken` finding with what you did (the findings stay open until then — they are sticky by design).

The writer behaviour itself (it should refuse or stamp such a re-add) is logged as a D4 follow-up for main; c2b only reports it.

## Growth limit: 200 restaurants per run (enumeration)

The monitor enumerates restaurants with ONE limited query of at most 201 restaurant documents. Its cost is reserved before it is issued, and the 201st document only detects overflow. Above 200 restaurants:
- **What happens:** every run checks and summarizes only the first 200 restaurant ids (in sorted order). It logs `identity_integrity_enumeration_truncated` (`listed: "> 200"`), and the enumeration counts as INCOMPLETE, so the run emits NO heartbeat. Restaurants past the first 200 get no checks and no summary lines.
- **How you hear about it:** the heartbeat absence alert (45 min) opens and stays open. Check the logs for `identity_integrity_enumeration_truncated`.
- **What to do:** coverage past 200 needs a follow-up slice — raise `ENUMERATION_MAX` (if the run's read and time budget allow), or page the enumeration across runs. Until it lands, the restaurants past the first 200 are unmonitored. Do not acknowledge the absence alert as a false alarm.
- **Onboarding checklist:** when onboarding a restaurant, count the restaurant documents. **If there are more than 150 restaurants, schedule the pagination slice.**

## Rollout gate + provisioning requirement: every restaurant has its `restaurants/{rid}` DOCUMENT

The monitor enumerates restaurant DOCUMENTS (a limited query). The platform registry (`listDocuments`) also sees "missing" parents: a restaurant that exists only as subcollections. Such a restaurant is INVISIBLE to the monitor.
- **Gate — before deploy, and at each onboarding:** verify, read-only, that every restaurant has its `restaurants/{rid}` document. List the ids with and without `showMissing`; the two lists must be identical. *Verified by the advisor on 2026-10-11 (Firestore REST, ids only): existing docs = [la_musa, x_pizza]; with showMissing = the same two, both existing; zero missing-parent restaurants.*
- **Provisioning requirement (admin-portal / onboarding slice):** onboarding MUST create the `restaurants/{rid}` document.
- **Rail:** if the monitor ever enumerates ZERO restaurants, it logs `identity_integrity_enumeration_empty` and emits no heartbeat, so the absence alert fires. Treat that as this gate failing.

## Bootstrap / migration CLIs

`tools/bootstrap-identity.js` has no publish lease. Pause the monitor job first, run it, then resume:

```bash
gcloud scheduler jobs pause firebase-schedule-verifyIdentityIntegrity-us-central1 --location us-central1 --project xpizza-delivery
# … run the CLI …
gcloud scheduler jobs resume firebase-schedule-verifyIdentityIntegrity-us-central1 --location us-central1 --project xpizza-delivery
```

Every activation/certification CLI (`publish-version.js`, `rollback-version.js`, `bootstrap-identity.js`, `migrate-catalog-display.js`) runs ONLY from a worktree at the c2a merged SHA or later. An older checkout writes no evidence, and the monitor reports the gap.

## Rollout (PLAN-D4c2b §10.2), in order

1. **RTDB rules:** `npm run deploy:rules` (adds the `catalog_integrity` deny; `check:rules` runs the guard first).
2. **Deploy ONLY the monitor, with its job PAUSED:**
   - Run `firebase deploy --only functions:verifyIdentityIntegrity` (scoped; env parity with the other functions checked first).
   - Then pause the job immediately (command above) and confirm it is PAUSED.
3. **The boundary** (WRITE-ONCE; the advisor's ruling N2):
   - The input is the recorded observation `tools/identity-boundary-records/2026-10-09.json` (DECISIONS 2026-10-09 "c2b N2 BOUNDARY"). G0 is never derived from today's pointer.
   - Dry run first, review, then apply:
     ```bash
     node tools/record-evidence-boundary.js --project xpizza-delivery --from-rollout-record tools/identity-boundary-records/2026-10-09.json
     node tools/record-evidence-boundary.js --project xpizza-delivery --from-rollout-record tools/identity-boundary-records/2026-10-09.json --apply
     ```
   - It is accepted only if the pointer is unchanged since the record, or every generation since then has evidence. A gap is REFUSED; stop and report.
4. **Record each restaurant's `publishedited` POST-200 latency baseline** (for the passive guard).
5. **GATE.** Before resuming the job (the job stays PAUSED for all of this — `install` and `accept-portal` need no heartbeat):
   - ALL alert metrics + policies are INSTALLED (`install`: metrics first, then policies; idempotent). The integrity alerts are NOT yet armed — that needs a live heartbeat, so it is step 8;
   - the §6a portal-latency alarms are ACCEPTED;
   - every portal function's baseline is recorded:
     ```bash
     node tools/setup-identity-alerts.js --project xpizza-delivery --channel <verified email channel> thresholds
     node tools/setup-identity-alerts.js --project xpizza-delivery --channel <…> plan
     node tools/setup-identity-alerts.js --project xpizza-delivery --channel <…> install
     node tools/setup-identity-alerts.js --project xpizza-delivery --channel <…> accept-portal <function>     # each of the five
     ```
6. **Resume the job.** The PASSIVE GUARD is active for the next 10 organic publishes:
   - each publish is compared PER RESTAURANT with that restaurant's recorded baseline and tagged overlapped/not from log timestamps;
   - if any sample is > max(baseline) + 150 ms, or any new error appears, the ADVISOR pauses the job, waits ≤ 300 s for the in-flight run to finish (confirmed in the logs), and investigates before resuming.
7. **First runs.** Every enumerated merchant must be covered, with ZERO violations; any violation means stop and investigate. Expected:
   - **x_pizza:** `pre_boundary` until its next organic publish, then `ok`.
   - **la_musa:** `uncertified`.
8. **Arm and accept the integrity alerts** (the job is now RESUMED):
   - Run `arm`. It refuses unless the job is ENABLED; it waits (≤ 30 min) for a heartbeat METRIC POINT ingested after the absence policy's last change (a raw log line is not enough), then runs the REVISION-TRANSITION acceptance: it prints `firebase deploy --only functions:verifyIdentityIntegrity --project xpizza-delivery` — redeploy the UNCHANGED function — and passes only when a heartbeat arrives from the NEW revision, the service-level series has no 45-min gap, and you confirm NO absence email arrived (an unanswered prompt is a failure at its bound, never a hang):
     ```bash
     node tools/setup-identity-alerts.js --project xpizza-delivery --channel <…> arm
     ```
   - Run `accept-integrity`.
   - Run `accept-absence` — a GUIDED MANUAL step. The tool NEVER pauses or resumes the job itself; YOU do, with the commands it prints, and it only READS the scheduler state to verify:
     1. It REFUSES unless the job is ENABLED at the start, so an incident pause or a bootstrap pause is never touched.
     2. It prints the pause command: run it. It verifies the state reads PAUSED (≤ 15 min).
     3. It drains the in-flight run and re-reads the last ingested heartbeat; the absence clock starts there.
     4. It asks, each prompt bounded, until 80 min after that heartbeat. Pass = the absence email within 45 + 25 min.
     5. It prints the resume command: run it. It verifies ENABLED (≤ 15 min).
     On a timeout or an error it STOPS without changing anything and prints the CURRENT state plus the resume command. If the state is not ENABLED, resume the job yourself:
     ```bash
     gcloud scheduler jobs resume firebase-schedule-verifyIdentityIntegrity-us-central1 --location us-central1 --project xpizza-delivery
     ```
   - Run the acknowledgement path on the emulator: `npm run test:c2b-integrity`.
   - Then the 48 h observation.

Honest limit of the acceptance: Cloud Monitoring has no incidents API. The tool checks the policy's own aggregated series, and the owner confirms the open/close emails at its prompts.
