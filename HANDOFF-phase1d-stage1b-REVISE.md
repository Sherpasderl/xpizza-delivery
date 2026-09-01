# REVISE RELAY — Phase 1d Stage 1b: fix the RTDB init in the owner-run CLIs

**To:** executor session · **From:** advisor. **Base:** the built branch `feat/phase1d-stage1b-snapshot-mirror @ afe24a1`. The codex money gate returned **REVISE** — one BLOCKING HIGH finding (a deploy-breaker) + two recommended folds. The core `catalog-publish.js` mechanism (snapshot-in-flip-tx coherence, mirror-ack-under-lease, mirror-fail-alarms-not-aborts, rollback re-emit) is **CONFIRMED SOUND** — do NOT touch it. Fix the CLI init + optionally the two folds.

## 🔴 BLOCKING (HIGH) — the owner-run CLIs can't reach RTDB → they crash at `admin.database()`
`tools/publish-version.js:22` and `tools/backfill-snapshot.js:17` call `admin.initializeApp({ credential: admin.credential.applicationDefault() })` with **NO `databaseURL`**, then call `admin.database()` (`:24` / `:19`). Under the documented `GOOGLE_CLOUD_PROJECT=xpizza-delivery` invocation, the Admin SDK **throws `Can't determine Firebase Database URL`** the moment `admin.database()` runs — so the mirror write (and the entire backfill) fails at init. `index.js:141` already pins the URL; the CLIs do not.

**Fix — add `databaseURL` to BOTH CLIs' `initializeApp`, matching index.js:141:**
```js
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: 'https://xpizza-delivery-default-rtdb.firebaseio.com',   // 1b: pin RTDB so admin.database() resolves (matches index.js)
});
```
- Apply to `tools/publish-version.js` AND `tools/backfill-snapshot.js`.
- **Add a guard/test** so this can't regress silently: a smoke test (or `node --check` isn't enough — this is a runtime init failure) that constructs the mirror path the CLI uses and asserts `admin.database()` resolves given only ADC + the pinned URL. At minimum, state in the handback that you ran `node tools/backfill-snapshot.js` against the emulator (or a probe) and `admin.database()` no longer throws. Consider centralizing the URL (a shared `const RTDB_URL` or reading `process.env.FIREBASE_DATABASE_URL || '<pinned>'`) so index.js + the CLIs share ONE source — but pinning it in both is acceptable.

## 🟡 Recommended fold #1 (NON-BLOCKING, do now while in the module — closes a Stage-2 footgun)
`flipPointer(db, rid, token, versionId, snapshot = null)` still writes the pointer WITHOUT the snapshot when `snapshot` is null (`:122`/`:134`). The production paths (`publishVersion`/`rollbackVersion`) ALWAYS pass a snapshot — CONFIRMED correct — but the exported pointer-only path means the "impossible: pointer N while snapshot N-1" guarantee is only true by caller discipline. In Stage 2 the snapshot BECOMES the price source, so a pointer-only flip would serve a stale snapshot. **Close it:** make the coherence invariant structural — either require `snapshot` (throw if absent) and update the ~4 isolated lease-mechanics tests that call `flipPointer` without one to pass a minimal snapshot, OR keep flipPointer flexible but have `publishVersion`/`rollbackVersion` assert a snapshot was built. Pick the lighter one; the goal is that no code path can move the pointer without moving the snapshot.

## 🟡 Recommended fold #2 (NON-BLOCKING, minor) — the atomicity test's load-bearing check
Codex confirms the **structural `tx.set`-inside-flipPointer test is the real atomicity proof**; the **identical-commit-timestamp test is a WEAKER secondary** (two separate writes CAN resolve to the same millisecond, esp. under the emulator — so it's not definitive). Keep both, but add a one-line comment that the structural check is primary. If fold #1 makes flipPointer require a snapshot, the residual vacuity ("flipPointer callable without a snapshot") also closes. No new test needed.

## 🔒 Guards (unchanged)
- The core `catalog-publish.js` publish/rollback/mirror logic is CONFIRMED SOUND — the only catalog-publish.js change here (if you do fold #1) is the flipPointer snapshot-requirement; the mirror-ack/coherence/deadline/alarm code stays byte-identical.
- ADDITIVE + INERT preserved: read/pricing path stays diff-empty; nothing reads the snapshot.
- The RTDB `/catalog_snapshot` server-only posture is a **Stage-2 precondition** (deployed rules == checked-in reference `xpizza-reference/database.rules.json` — no root `true`, no `/catalog_snapshot` stanza → default-deny). Carry that verification into Stage 2, NOT here.

## Tests / gate / deploy
- Full `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` green; the emulator 1b suite unchanged (except fold #1's test updates if done). The DB-URL fix needs a runtime proof (not just `node --check`).
- LOCAL-ONLY → advisor re-audit + codex re-gate on the new diff (focus: the CLIs now init RTDB correctly + `admin.database()` resolves under ADC-only; fold #1 if done makes flipPointer coherence structural; core logic byte-unchanged).
- Deploy (owner, post-gate): STILL no per-order functions deploy (write-side/tool-only). Land via `GOOGLE_CLOUD_PROJECT=xpizza-delivery node tools/backfill-snapshot.js` — which will now actually reach RTDB. Verify: both `active_snapshot` docs coherent with their pointers, both `/catalog_snapshot/{rid}` mirrors present + self-describing, pricing still identical (inert), zero new alarms.

## Handback DoD
Branch@SHA (on afe24a1); the CLI init diffs (both tools, databaseURL pinned) + the runtime proof that `admin.database()` resolves; fold #1 (if done) — the flipPointer coherence-requirement diff + updated tests; the byte-unchanged proof for the core mirror/coherence logic; full suite green.

---
*REVISE relay (advisor→executor). Blocking: the RTDB init in the CLIs; the coherence mechanism itself is sound.*
