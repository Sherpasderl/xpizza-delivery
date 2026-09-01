# BUILD RELAY — Phase 1d Stage 2b: the `snapshotFor` read-side fallback ladder (additive)

**To:** executor session · **From:** advisor. **Supersedes** the earlier 2b draft (the seq addition is now DONE in 2b-pre @ 6f5ba89 — mirrors + snapshots carry `seq`, verified live). This builds the READ-side disaster fallback that replaces `codeFor` in Stage 2c. **Additive + INERT:** `snapshotFor` is built + unit-tested, the resolver RECORDS the state the ladder needs on the happy path, but the live fallback path STILL returns `codeFor` (the flip to `snapshotFor` + dropping `tablesEqual` is 2c). Provable by: pricing byte-unchanged; `snapshotFor` correct in isolation.

## 🔴 Type: MONEY-CRITICAL (this prices orders during a Firestore outage in 2c). Heaviest codex money grill. Build LOCAL-ONLY. INERT here (unused until 2c).

## Base
Fresh worktree off `origin/main @ 6f5ba89` (2b-pre). Branch `feat/phase1d-stage2b-snapshotFor-ladder`. Work in `catalog/pricing-tables.js` (resolver), `catalog/catalog.js` (surface version+seq), a new `catalog/snapshot-fallback.js` (the pure ladder), + a bounded RTDB mirror READER, + tests.

## What 2b-pre already gives you (verified live)
- RTDB `/catalog_snapshot/{rid}` = `{version, seq, rid, menu, extras, at}` — self-describing WITH the ordinal (`seq`), Firestore-independent (prod: x_pizza seq=1, la_musa seq=1).
- Firestore `active_snapshot` carries `seq` (coherent with the pointer, in the flip tx).
- `readVersionDocs` returns `{itemDocs, extraDocs, seq}`.

## Wiring: surface `versionId` + `seq` to the resolver (additive)
Today `reader.getTables(rid)` returns only tables (pricing-tables.js:99); the resolver never learns which version/seq it served. Thread it through (additive — extra fields, existing consumers ignore them):
- `getRestaurantDocs(rid)` → add `seq` to its `{versionId, itemDocs, extraDocs}` return (from `readVersionDocs.seq`).
- `catalog.js` `getTables(rid)` → return `{ versionId, seq, menu, extras }` (or attach them) so the resolver can read them. On the FLAT (un-migrated) path there's no version → `versionId=null, seq=null`.

## The two pieces of PER-INSTANCE state (recorded on the happy path — additive, changes nothing served)
- **`lastKnownActive[rid]` = `{versionId, seq}`** — updated whenever the resolver learns the active version (from `getTables`' surfaced version/seq), EVEN if the tables read then failed. This is the ordinal the K check compares against.
- **`lastGood[rid]` = `{versionId, seq, menu, extras}`** — the tables from the MOST RECENT SUCCESSFUL serve. The freshest coherent thing this instance holds.

## `snapshotFor(rid, { mirrorReader, K = 1 })` — the ladder (pure/testable)
Entered ONLY when the live catalog read (the versioned reader) has FAILED/timed out. Never serves a price it can't vouch for.
1. **In-memory last-good** — if `lastGood[rid]` present, return its tables (no I/O; by construction its `seq` ≥ `lastKnownActive.seq`). The common case (a warm instance whose Firestore blipped).
2. **RTDB mirror, version-checked** — else (a COLD instance, no `lastGood`) read `/catalog_snapshot/{rid}` via `mirrorReader` (Firestore-INDEPENDENT, BOUNDED by a deadline — a hung RTDB must not hang the order). Then:
   - **`seq` ABSENT on the mirror → FAIL CLOSED (step 3).** Never distance-zero. (A pre-seq mirror must never read as fresh — the whole reason 2b-pre + the backfill re-run exist.)
   - If `lastKnownActive[rid].seq` IS known: serve ONLY if `lastKnownActive.seq − mirror.seq <= K` (K small, default 1). `> K` → FAIL CLOSED (a stale N-2+ mirror is refused).
   - If `lastKnownActive[rid]` is UNKNOWN (truly cold, Firestore never reachable so the version was never learned): serve the mirror's self-described `seq` as the **disaster fallback** (staleness bounded by 1b serialization+ack + K; delta bounded by the 1d publish-bounds) + alarm `catalog_served_from_mirror_cold`.
3. **Fail-closed** — no `lastGood`, no coherent/fresh-enough mirror → THROW `snapshot_fallback_unavailable`. The 2c caller turns this into an order REJECT + alarm (never an uncertain price). Firestore AND RTDB both down = platform-wide outage; a reject is correct there.

## FORWARD-FLAGS folded in (from the 2b-pre gate)
- **(a) A REAL-PROJECTION RTDB READ test.** The mirror READER (`mirrorReader`) must be tested against the ACTUAL projection it parses — not only a hand-built fake object. Mirror the executor's `mirror-rtdb.test.js` approach: write a real mirror payload (via `makeRtdbMirror` into a capture), then feed THAT captured value into `mirrorReader` and assert the ladder reads `seq`/`menu`/`extras` correctly. A fake reader fed a hand-built object would miss a wrong projection (the exact class of bug that's bitten mirror-write AND backfill this program). This test is REQUIRED.
- **(b) `flipPointer` seq-check (S3 fold from 2b-pre).** `flipPointer` currently asserts `snapshot.version === versionId` but not `seq`. Tighten to also require `Number.isInteger(snapshot.seq)` (and, if cheap, that it matches the version's seq) — so no path can write a snapshot with a version but no/……wrong ordinal. Update the isolated lease-mechanics tests that build minimal snapshots to include a `seq`.

## 🔒 Guards / invariants
- **ADDITIVE + INERT:** `getPricingTables` still returns exactly today's result — happy path serves the catalog (with `tablesEqual`), the fallback path STILL returns `codeFor`. The only behavior change is recording `lastKnownActive`/`lastGood` (unused) + surfacing version/seq (extra fields). `snapshotFor` is defined + exported + unit-tested but NOT called from the live fallback. **Prove `getPricingTables` byte-identical** (happy + code-fallback), and that `snapshotFor` is unreachable from the live path.
- **`snapshotFor` NEVER serves an unvouched price:** in-mem last-good (coherent), or a mirror within K with a present `seq`, or (cold-no-known-active) the mirror as bounded disaster fallback — else FAIL CLOSED. Absent `seq` is always fail-closed. (The 1a value-guard still rejects a corrupt value at the calculator regardless.)
- **Bounded** RTDB read (deadline); **K default 1**, env-tunable, documented (1b serialization+ack ⇒ mirror ≤1 behind a successful publish ⇒ K=1 admits exactly that, fail-close on ≥2).
- `tablesEqual` / the gate-drop / `codeFor`→`snapshotFor` swap / retiring `menu-pricing.js` — UNTOUCHED (that's 2c).

## Tests (unit — pure ladder + the real-projection reader test)
- In-mem last-good returned with NO RTDB read.
- Cold + mirror within K: `lastKnownActive.seq=N`, mirror.seq=N → served; N-1 (K=1) → served; N-2 → FAIL CLOSED.
- Cold + `seq` ABSENT on mirror → FAIL CLOSED (never distance-zero).
- Cold + no last-known-active (Firestore-dark) → mirror served + `catalog_served_from_mirror_cold` alarm.
- Fail-closed: RTDB unreachable / mirror absent / too stale → throws `snapshot_fallback_unavailable`.
- Bounded: a hung `mirrorReader` → times out, not a hang.
- **REAL-PROJECTION reader test (forward-flag a):** `makeRtdbMirror`→capture→`mirrorReader` reads it correctly.
- **INERT proof:** `getPricingTables` byte-identical before/after; `snapshotFor` not reachable live.
- `node --check`; wire tests into `package.json` (explicit chain); full suite green.

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **codex money gate** (ladder correctness: K bound via seq, absent-seq fail-closed, cold-disaster path, fail-closed; the real-projection reader test; flipPointer seq-check; ADDITIVE/inert [pricing byte-unchanged, snapshotFor dormant]; bounded RTDB read).
- Deploy (owner, post-gate): `pricing-tables.js` + `catalog.js` are the per-order read path → a **functions deploy IS needed** (unlike 2b-pre), even though inert. Full `--only functions`. Prove-in-prod: pricing identical (inert), zero new alarms, and the still-pending **la_musa heartbeat**.

## Handback DoD
Branch@SHA (off 6f5ba89); the `snapshot-fallback.js` ladder + the resolver record-only hooks + the version/seq surfacing; the bounded mirror reader; the forward-flags (real-projection reader test + flipPointer seq-check); the unit tests with output; the INERT proof (getPricingTables byte-identical, snapshotFor dormant); full suite green.

## Context — Stage 2 remaining
2a (checkout displayed==charged, proactive-quote — advisor drafting next) + 2b (THIS) are the preconditions for **2c (the flip: wire snapshotFor + drop tablesEqual + retire menu-pricing.js → snapshotFor)** — the small irreversible cutover on a frozen menu, after the la_musa heartbeat + the RTDB-rules verification.

---
*Relay artifact (advisor→executor). Stage 2b — the read-side fallback ladder, additive + inert, so 2c's authority-flip drops onto a proven, bounded, seq-checked fallback.*
