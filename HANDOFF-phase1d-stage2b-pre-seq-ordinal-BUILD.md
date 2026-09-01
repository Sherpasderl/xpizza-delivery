# BUILD RELAY — Phase 1d Stage 2b-pre: thread `seq` (the Firestore-independent ordinal) through the snapshot + mirror

**To:** executor session · **From:** advisor. **Why:** the Stage 2b `snapshotFor` ladder's max-version-distance `K` check must be computable WITHOUT Firestore (that is the whole point of the RTDB mirror). Today the mirror + snapshot carry `version` (a `v-<ts>-<rand>` identifier, not an ordinal) and `at` (triage-only wall clock) — neither supports a distance check. `seq` (the monotonic per-restaurant ordinal, written serially under the publish lease) is the right ordinal, and it must ride BOTH ends (the snapshot's `lastKnownActive` and the mirror) or the distance is undefined from one side. This is a **pure shape change: write-side + INERT** (a new field lands; nothing reads it until 2b). Gated separately from the ladder by design.

## 🔴 Type: MONEY-adjacent (the publish shape that feeds the Stage-2 fallback), but INERT here. Codex money gate. Build LOCAL-ONLY.

## Base
Fresh worktree off `origin/main @ 96a2431` (Stage 1b). Branch `feat/phase1d-stage2b-pre-seq-ordinal`. Work in `catalog/catalog-publish.js`, `catalog/catalog-firestore.js`, `tools/backfill-snapshot.js`, + tests. (2b then branches off THIS.)

## The four threads (all verified from source)
1. **`writeVersion` must return `seq`.** It computes `maxSeq + 1` (catalog-publish.js:190) and writes `seq: maxSeq + 1` into the record (:205), but returns `{ versionId, descriptor, menuTable, extraTable }` (:210) with no seq. Name it once (`const seq = maxSeq + 1;`), use it in the record write AND add it to the return — same one-line shape as the 1b menuTable/extraTable addition.
2. **`readVersionDocs` must surface `seq`.** It already reads the version record (`recSnap`, catalog-firestore.js:~62) and uses it for `assertComplete`, but returns only `{ itemDocs, extraDocs }` (:~73). Add `seq: (record.seq)` to the return. This is the ordinal source for BOTH `rollbackVersion` (which builds its payload from `readVersionDocs`) and any snapshot rebuild.
3. **`seq` rides BOTH the Firestore snapshot AND the RTDB mirror.**
   - `snapshotOf(rid, versionId, seq, menuTable, extraTable)` → `{ version: versionId, seq, rid, menu, extras, at }` (add the `seq` param + field). The Firestore `active_snapshot` now carries `seq` → this is `lastKnownActive`'s ordinal in 2b.
   - The mirror payload (`writeMirror` call sites in `publishVersion` + `rollbackVersion`, and `mirror-rtdb.js`'s written object) gains `seq` → `{ version, seq, rid, menu, extras, at }`.
   - `publishVersion`: pass `seq` (from writeVersion) to `snapshotOf` + the mirror payload.
   - `rollbackVersion`: pass `seq` (from `readVersionDocs`' new field) to `snapshotOf` + the mirror payload — **do NOT let rollback emit a seq-less snapshot/mirror**, or K silently breaks on exactly the rollback path where you most want a coherent fallback.
4. **`tools/backfill-snapshot.js` must write `seq`.** It reads the active version via `readVersionDocs` (now returns `seq`) → include `seq` in both the `active_snapshot` write (`snapshotOf`) and the mirror payload. **Re-running the backfill is MANDATORY, not incidental:** the two mirrors + snapshots currently live carry NO `seq`, so until the backfill re-runs they are ordinal-less.

## 🔒 Guards / invariants
- **INERT:** the added `seq` is written but READ by nothing (2b introduces the reader). The read/pricing path (`getPricingTables`, calculators) is byte-unchanged; the reader (`catalog.js`) ignores the new `readVersionDocs` field. Prove pricing byte-identical.
- **Coherence preserved:** `seq` on the Firestore `active_snapshot` rides the SAME flip transaction as the pointer (it flows through `snapshotOf` → `flipPointer`'s `tx.set`) — so the snapshot's `seq` can never disagree with the version it describes.
- **The absent-`seq` SAFETY DEFAULT is a 2b (read-side) rule, but STATE it here so 2b honors it:** a version-checked reader MUST treat "`seq` absent" as **fail-closed / too-stale**, NEVER distance-zero — else a pre-seq mirror reads as perfectly fresh, the worst possible default for a disaster fallback. (This is why the backfill re-run is mandatory: to retire the seq-less mirrors before 2b reads them.)
- Core mirror-ack/deadline/alarm/coherence logic BYTE-UNCHANGED — the only changes are the `seq` field flowing through the existing shapes.

## Tests (emulator + unit)
- After `publishVersion`: `active_snapshot.seq` and the mirror's `seq` both == the version record's `seq` (== prior maxSeq + 1); monotonic across successive publishes.
- After `rollbackVersion` to a prior version: `active_snapshot.seq` and the mirror's `seq` == the ROLLED-TO version's seq (NOT the rolled-away one) — the fail case the executor flagged.
- `readVersionDocs` returns the record's `seq`.
- Backfill writes `seq` for the current active version (emulator).
- INERT proof: `getPricingTables` byte-identical before/after; the reader ignores the new field.
- `node --check`; new/updated tests wired into `package.json`; full suite green.

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **codex money gate** (seq threaded through writeVersion→snapshot+mirror AND readVersionDocs→rollback; rollback emits the rolled-TO seq; coherence [snapshot seq in the flip tx]; INERT [pricing byte-unchanged]; the absent-seq-fail-closed default documented for 2b).
- Deploy (owner, post-gate): write-side/tool-only (catalog-publish + backfill) + the inert `readVersionDocs` field (unread until 2b) → **no per-order functions deploy needed for the pre-slice** (fold the functions deploy into 2b, which changes the resolver). Land the ordinal by re-running **`GOOGLE_CLOUD_PROJECT=xpizza-delivery node tools/backfill-snapshot.js`** → both `active_snapshot` docs + `/catalog_snapshot` mirrors now carry `seq`. Verify: both mirrors + snapshots have `seq` == their pointer's version seq; pricing identical (inert).

## Handback DoD
Branch@SHA (off 96a2431); the diffs (writeVersion return, readVersionDocs return, snapshotOf, mirror payload, publishVersion + rollbackVersion, backfill); the emulator tests incl. the rollback-emits-rolled-TO-seq case; the INERT proof; full suite green; a note confirming 2b will fail-close on absent seq.

---
*Relay artifact (advisor→executor). 2b-pre: the seq ordinal, write-side + inert — so the 2b ladder's K check is Firestore-independent from both ends. 2b (the read-path ladder) branches off this.*
