# BUILD RELAY — Phase 1d Stage 1b: coherent snapshot + RTDB mirror on publish (the fallback infra)

**To:** executor session · **From:** advisor. **Program:** Sherpa platform 1d (spec `2026-08-31-phase1d-...-design.md`, R4-SOUND — see the "version-checked snapshot fallback" + "RTDB mirror + provable staleness bound" sections). This is the **write-side infrastructure** for the fallback that will REPLACE the hand-maintained code tables in Stage 2. Stage 1b **only writes** the snapshot + mirror on publish/rollback; **NOTHING reads them yet** (the resolver still parity-gates against the code tables). So this is **additive + INERT** — provable by: publish emits a coherent snapshot + mirror, and the live pricing path is byte-unchanged.

## 🔴 Type: MONEY-adjacent (it's on the publish pipeline that flips live pricing; the snapshot IS the future price source) but INERT (unread until Stage 2). Codex money gate. Owner runs the publish/backfill. Build LOCAL-ONLY.

## Base
Fresh worktree off the current tip **`origin/main` @ `6042a9d`** (Stage 1a complete; confirm `git rev-parse origin/main` = 6042a9d — deploy/merge Stage 1a first if not). Branch `feat/phase1d-stage1b-snapshot-mirror`. Commit LOCAL-ONLY. All work is in `catalog/catalog-publish.js` + a new backfill tool + emulator tests.

## The mechanism (faithful to the R4-SOUND spec)

### 1. Firestore snapshot = the COHERENCE ANCHOR (written IN the pointer-flip transaction)
The snapshot must be coherent with the active pointer by construction — so it goes into the SAME Firestore transaction as the flip.
- New ref: `snapshotRefOf(db, rid)` = `restaurants/{rid}/meta/active_snapshot`.
- `writeVersion` (catalog-publish.js:123) already computes `{ menuTable, extraTable }` via `normalizeInputs` — **return them** (add to its return object) so the caller can build the snapshot. Snapshot shape (same `{key:price}` shape `codeFor` returns today, PLUS the version witness): `{ version: versionId, rid, menu: menuTable, extras: extraTable, at: serverTimestamp }`.
- `flipPointer(db, rid, token, versionId)` → `flipPointer(db, rid, token, versionId, snapshot)`: inside the existing transaction, after the owner-token + server-expiry checks, write BOTH: `tx.set(pointerRef, { version, at }); tx.set(snapshotRef, snapshot)`. Atomic → the Firestore snapshot can NEVER be out of step with the active pointer. This is the source of truth for "what version is live" (the spec's coherence anchor).

### 2. RTDB mirror = the Firestore-INDEPENDENT disaster fallback (self-describing, acked)
Written AFTER the flip, for reads during a Firestore outage. It carries its OWN version witness so a reader never needs Firestore to know what it holds.
- DI the RTDB handle (catalog-publish.js currently takes only Firestore `db`): add a `mirror` dependency to `publishVersion(db, rid, input, { mirror } = {})` — `mirror` is `(rid, snapshotPayload) => Promise<void>` that writes `/catalog_snapshot/{rid}` = `{ version, rid, menu, extras, at }`. Prod injects a `getDatabase()`-backed writer (in `tools/publish-version.js`); tests inject a fake/emulator writer.
- **Mirror-ack = publish completion, under the held lease:** write the mirror AFTER `flipPointer` and AWAIT it, BEFORE `releaseLease` (the lease is released in the `finally` at :168 — put the mirror write inside the `try`, before `return`). Because `acquireLease` already **serializes** publishes per rid (refuses a live lease → `publish_locked`, LEASE_MS=120s), holding the lease through the mirror-ack means the next publish cannot start until this one's mirror is acked → the mirror is bounded to at most ONE in-flight publish behind the Firestore pointer (the spec's staleness bound (a)+(b)).
- **Mirror write is best-effort-with-ALARM, never a flip-abort:** the flip already succeeded and Firestore is coherent + serving; the mirror is only the disaster fallback. Wrap the mirror write in a bounded deadline; on failure/timeout, fire a distinct alarm (`catalog_mirror_write_failed`, restaurantId+version) and let `publishVersion` RETURN SUCCESS (the flip stands). A hard mirror failure means the mirror is >1 behind — the Stage 2 read-side max-version-distance `K` check (NOT built here) is the backstop that fail-closes on a too-stale mirror. State this explicitly in the handback: mirror failure alarms, never rolls back the flip.
- If `mirror` is absent (legacy/unit callers that don't test the mirror), skip the mirror write + `console.warn` — but `tools/publish-version.js` MUST inject it.

### 3. Rollback re-emits BOTH (else the fallback lags the active version)
`rollbackVersion` (catalog-publish.js:186) currently only flips. It reads the target version via `readVersionDocs` (already) — use those tables to build the snapshot and: pass it to `flipPointer` (snapshot in the flip tx) + write the RTDB mirror (acked, same as publish). A rollback to version N must leave `active_snapshot` = N and `/catalog_snapshot/{rid}` = N.

### 4. Backfill the CURRENT active versions (they predate Stage 1b → no snapshot yet)
x_pizza `v-…965446` and la_musa `v-…969834` are live but have no `active_snapshot`/mirror. Add `tools/backfill-snapshot.js`: for each rid, read the CURRENT active version (`getActiveVersionId` → `readVersionDocs`), build the snapshot from its tables, and write `active_snapshot` (coherent — same version, NO pointer change) + the RTDB mirror (acked). Idempotent (re-running overwrites with the same coherent snapshot). This establishes the fallback for the already-published versions without churning the active pointer.

## 🔒 Guards / invariants
- **ADDITIVE + INERT:** the resolver (`pricing-tables.js`), the reader (`catalog-firestore.js`), `computeServerTotal`/`pricedLineItems`/reward pricing, and the per-order pricing path are **diff-empty** — NOTHING reads `active_snapshot` or `/catalog_snapshot` yet. The live money path is byte-unchanged. Prove it.
- **COHERENCE by construction:** the Firestore snapshot is written in the flip transaction → it is impossible for `active_version` to point at N while `active_snapshot` is N-1. (The RTDB mirror CAN lag by one publish — that's expected and bounded; the K read-check handles it in Stage 2.)
- **Serialization is EXISTING** (the lease) — do NOT add a second lock; verify + rely on it. The only new serialization property is that the mirror-ack now happens under the held lease.
- **Never abort a flip on a mirror failure** (Firestore is the coherence source; mirror is best-effort + alarmed).
- **Snapshot size:** one small Firestore doc per rid (`{version, menu:{~24-44 keys}, extras:{~14 keys}}` ≪ 1MB) — fine. Do not write per-item docs; the snapshot is a single self-contained doc (fast one-read fallback).

## Tests (emulator — Firestore + a fake/emulator RTDB mirror)
- **Coherence in the flip tx:** after `publishVersion`, `active_snapshot.version` == `active_version.version` == the new versionId, and `active_snapshot.menu/extras` deep-equal the version's tables. Simulate a flip-tx failure (e.g. lease lost) → NEITHER pointer NOR snapshot moved (atomic).
- **RTDB mirror:** written to `/catalog_snapshot/{rid}` with `{version, rid, menu, extras}` matching the active version; the mirror write is AWAITED (publish doesn't resolve until acked).
- **Mirror failure is non-fatal:** inject a `mirror` that rejects → `publishVersion` still RESOLVES success, the pointer+Firestore-snapshot are coherent, and `catalog_mirror_write_failed` alarmed. The flip is NOT rolled back.
- **Rollback re-emits:** publish v1,v2 → rollback to v1 → `active_snapshot` and the RTDB mirror are BOTH v1 (coherent with the rolled-to pointer).
- **Serialization (existing, re-assert):** a second `publishVersion` while a live lease is held → `publish_locked`.
- **Backfill:** on a version published WITHOUT a snapshot (simulate the current state), `backfill-snapshot.js` writes a coherent `active_snapshot` + mirror for the CURRENT active version, no pointer change, idempotent.
- **ADDITIVE proof:** a pricing read (`getPricingTables` / `computeServerTotal` through the resolver) returns byte-identical results before/after — the snapshot/mirror are unread.
- `node --check`; wire any new test into `package.json` (explicit chain); full `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` green (esp. `catalog-versioned.emulator.test.js`, `catalog-parity.emulator.test.js`).

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **codex money gate** (coherence-in-flip-tx; mirror-failure-alarms-not-aborts; serialization via the existing lease; ADDITIVE/INERT [pricing path diff-empty, snapshot unread]; rollback re-emits; backfill idempotent + coherent).
- Deploy (owner, post-gate): `catalog-publish.js` is WRITE-side (used by `tools/publish-version.js` / `rollbackVersion` CLIs), **NOT the per-order path** — so **no per-order functions deploy is required for the write path.** Confirm with a grep whether any DEPLOYED function requires `catalog-publish.js` (I believe none — the resolver reads via `catalog-firestore.js`); if any does, deploy it. Land the snapshots by running **`node tools/backfill-snapshot.js`** (project-pinned `GOOGLE_CLOUD_PROJECT=xpizza-delivery`, ADC, from the deploy worktree/functions dir) → emits `active_snapshot` + `/catalog_snapshot` for BOTH current active versions, no pointer churn. Verify (a) both `active_snapshot` docs are coherent with their pointers, (b) both RTDB mirrors present + self-describing, (c) a pricing read still serves identically (inert), (d) zero new alarms.

## Handback DoD
Branch@SHA (off 6042a9d); the `catalog-publish.js` diff (writeVersion returns tables; flipPointer writes the snapshot in-tx; publishVersion mirror-ack-under-lease + alarm; rollbackVersion re-emits); `tools/backfill-snapshot.js`; the emulator tests (coherence/mirror/mirror-fail/rollback/serialization/backfill/additive) with output; the ADDITIVE/diff-empty proof (resolver/reader/pricing path unchanged, snapshot unread); the mirror-failure-never-aborts statement; the K-check-deferred-to-Stage-2 note; full suite green.

## Context — where this sits
Stage 1a (value guard) ✅ gated SOUND. Stage 1b = THIS (write-side snapshot + mirror, inert). **Stage 2 (next, the flip):** wire the READ-side fallback ladder (in-memory last-good → RTDB mirror version-checked with max-distance `K` → fail-closed), drop `tablesEqual` (catalog-authoritative), retire `menu-pricing.js` → `snapshotFor`, and the checkout-confirm displayed==charged. Stage 2 is the money-critical cutover, on a frozen menu, AFTER the la_musa `pricing_catalog_hit` heartbeat is finally observed.

---
*Relay artifact (advisor→executor). Stage 1b of 1d — the coherent snapshot + RTDB mirror write infra, additive + inert, so Stage 2's authority-flip has a proven fallback already in place.*
