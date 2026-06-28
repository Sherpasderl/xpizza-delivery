# Plan Review Log: La Musa plan RE-VALIDATION against current `main`
Act 1 (grill-with-docs) complete — RE-VALIDATION locked (`LA_MUSA_REVALIDATION.md`); CONTEXT.md/ADRs unchanged (no new domain term; Phase 0 rule-shape flagged, not decided, per Xavier). MAX_ROUNDS=5.

## Round 1 — Codex (thread 019f0f1b-c010-7b40-8db6-947ba7fdb54b) — VERDICT: REVISE
1. `database.rules.json` path/claim wrong — only `xpizza-reference/database.rules.json` found; it has a `/restaurants/factura_config` deny.
2. F2 overstated as "no `/restaurants` rule".
3. `payment_attempts` not tagged with `restaurant_id`.
4. **MISS:** factura allocator `allocateFacturaOnSale` will fail+alert on La Musa sales (no `la_musa` factura_config) despite the carve-out.
5. **MISS:** native `ingestDriverLocation`/`isHubResolvable()` reject `la_musa` → geofence skipped/misrouted.
6. `pickEligibleDriver` has no order/hub context; timeout-reassignment + `reassertAssignable` need it too.
7. Public `confirmOnlinePayment` endpoint still live + reaches `confirmAndMaterialize`.
8. Phase 0 too bundled for a rules-sensitive change.
9. "`createOrderWithTasks` deletable" stated too confidently.

### Claude's response (arbiter)
- **Accepted #4, #5** as genuine misses — verified in code (`allocateFacturaOnSale` does `restaurant_id || FACTURA_RESTAURANT_ID`; `isHubResolvable` only resolves `x_pizza`). Added as GAPs **F3** (factura allocator opt-out — flagged highest-value) and **F4** (native ingest hub resolution).
- **#1/#2 — corrected, but Codex was partly wrong:** the **deployed** rules file is `xpizza-functions/database.rules.json` (per `firebase.json`), which has **no `/restaurants` stanza** — my original claim held for the deployed file. Codex cited the non-deployed `xpizza-reference` copy. Sharpened F2 to cite the deployed file + note the two-copy drift.
- **Accepted #3** (payment_attempts not tagged — added as still-open HOLD; plan step 11 covers it), **#6** (pickEligibleDriver call-sites — added), **#7** (external confirm endpoint — clarified S2), **#8** (Phase 0 now sequenced rules→seed→reads), **#9** (softened to "no static production caller; deletion needs workflow confirmation").
- **Rejected nothing outright;** #1 partially corrected rather than adopted verbatim.

## Round 2 — Codex (same thread) — VERDICT: REVISE
Confirmed F2 (deployed-vs-reference correction right), F3, F4 are correctly stated. Remaining:
1. HOLDS row mis-cited `pixelpay-hosted-charge.js:89` as restaurant_id-stamping evidence — that module writes the (untagged) attempt, not the stamp.
2. F3 fix danger: `not_due` is the Sale-pending default eligibility keys on; don't reuse it for La Musa.
3. Top summary stale ("two factual claims / one open question") vs F1–F4.
4. "plan already incorporates the factura carve-out" too confident — code carve-out incomplete (F3).

### Claude's response (arbiter)
All four accepted (precise tightening, no redesign): (1) dropped `:89` from stamping evidence, kept it as the untagged-attempt gap; (2) F3 now says skip-by-restaurant_id or explicit `external_pos`/`not_applicable`, never `not_due`; (3) Verdict made count-free (F1–F4 / P0); (4) softened both "already incorporates" lines to "intended carve-out; code needs F3."

## Round 3 — Codex (same thread) — VERDICT: APPROVED
"No remaining blocking issues found. The revised F2 deployed-vs-reference framing is correct, F3 now avoids the `not_due` trap, F4 matches the native ingest code, and the summary no longer overstates the factura carve-out as already complete."

**Resolution: CONVERGED in 3 rounds.** RE-VALIDATION (`LA_MUSA_REVALIDATION.md`) is signed off. Net: design holds; corrections = S1–S3 (re-point hosted module / confirm-callers / line drift), F1 (md5 gate), F2/P0 (RTDB-rules exposure — flagged for executor), F3 (factura allocator opt-out for la_musa — highest value), F4 (native ingest hub resolution). No code written; one dual-approved step at a time from Phase 0.
