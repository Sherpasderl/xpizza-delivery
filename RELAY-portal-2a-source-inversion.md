# RELAY (advisor → executor) — Portal Phase 2a: the COMPLETE source inversion

**Authoritative:** plan `docs/superpowers/plans/2026-09-06-portal-2a-source-inversion.md` · spec `docs/superpowers/specs/2026-09-06-portal-2a-source-inversion-design.md`. Build to them.

**Base:** branch off `origin/main` @ **8422437**. TDD, task-by-task, **backend only (no UI)**, LOCAL-ONLY. Do NOT push/deploy/cut-over.

**🔴 This is the pricing/menu SOURCE OF TRUTH — the most money/fiscal-adjacent build to date. Owner's bar: airtight, no silent-drift landmines, "looks like it cost a billion dollars."** The approach was already codex design-grilled (REVISE → all findings folded into the spec); the built diff gets the HARDEST codex money-gate.

**What it does:** make `restaurants/{rid}/source` (Firestore) the single authority for everything menu-derived; publish + every server consumer sources from it; `menu-pricing.js` retires to a frozen bootstrap/fallback. Cut over as a **provable byte-identical no-op** (store seeded from code → pre-flip code-vs-store parity gate).

**10 tasks (full detail in the plan):** (1) `source-store.js` reader/validator/`sourceToBuildInputs`/`canonicalize` + schema-completeness test; (2) `buildCatalogV2` structured `formData` path == text path; (3) seed code→store (round-trip proven); (4) publish-from-store + **the pre-flip parity gate** (code-built vs store-built descriptor, fail-closed before flip); (5-8) migrate the four drift-prone consumers — `weekendOnlyViolation`, reward eligibility (X.Pizza + La Musa), `reorder-normalize`, `restaurant-id` — each to store/catalog with a per-consumer parity test; (9) the **no-code-authority landmine guard** + wire tests + full suite EXIT 0; (10) cutover runbook.

**Non-negotiable invariants (diff-prove):**
- **Provable no-op:** the cutover fail-closes unless build-from-store is canonically identical to build-from-code (counts + both hashes + structure), per brand. `publishVersion` self-integrity is necessary but NOT sufficient (a wrong-but-positive price hashes fine) — the explicit code-vs-store pre-flip compare is the cornerstone (grill C3).
- **Complete schema (grill C1):** every `readLiteral` field + every consumer input is in the store (`has_photo`, full extras shape incl. la_musa `by_category`/`by_item`, `item_order`). A test enumerates the code literal set and asserts coverage.
- **No landmine (grill C5):** after 2a, NO production consumer reads `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` as a live authority (fallback only) — asserted by the guard test. Weekend gate + reward eligibility are money-adjacent (pre-charge / redemption) — migrate carefully.
- **Serving untouched (grill C4):** the resolver/ladder/mirror + `menu-pricing.js`-as-fallback are NOT changed — 2a changes only what feeds a publish + what consumers read as source.
- **Fail-closed everywhere; canonical serialization pinned; both brands proven; all existing catalog/fiscal/rewards/menu-parity tests stay green** (catalog output is byte-identical at cutover).
- **No actual menu edit in 2a** — 2a only proves the inverted pipeline reproduces today's menu identically. First real edit is 2b (the UI).

**Gate (post-build):** advisor source-audit + HARDEST codex money-gate (framed per the spec's Gate section) → then the owner-run gated cutover (parity confirmation before the flip). 

**Build TDD, backend-only, LOCAL-ONLY, base 8422437. Hand back per-task; flag any current-source surprise (as you did on the pickup-modal la-musa blocker) rather than forcing the plan.**
