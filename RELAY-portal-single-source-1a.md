# RELAY → EXECUTOR — Portal Single-Source 1A (catalog = complete, valid, safe display source)

**Spec:** `docs/superpowers/specs/2026-09-09-portal-single-source-1a-catalog-display-schema-design.md` (rev 5, design-grill APPROVED after 4 rounds — read it fully).
**Plan:** `docs/superpowers/plans/2026-09-09-portal-single-source-1a-catalog-display-schema.md` (9 tasks).
**Branch:** off `origin/main` = **`4d6697c`** (the deployed 2b-2b slice — "an acknowledgement is not a bearer instrument"), backend-only + a re-seed cutover. NOTE: 2b-2b **is merged + pushed + deployed** (owner did it during the smoke; `origin/main` is `4d6697c`, **not** e202e62 — that was the 2b-2b *base*, 31 commits back). The advisor's earlier "off e202e62 / nothing pushed" was a stale-ref error, corrected here. Only the 1A **design/plan/relay docs** (dfcaa91→69bc04b, docs-only) are unpushed. Build task-by-task LOCAL-ONLY; after each, hand back for advisor source-audit + codex money-gate before the next.

## Why this exists
The portal edits the live catalog (what the SERVER charges), but the customer form displays a static bundle generated from the CODE bootstrap — so a portal price edit changed the charge, not the display (Carnívora 340-shown/350-charged). 1A makes the live catalog the ONE complete display source. 1A is the foundation; 1B serves it, 1C guarantees charge==confirmed. **Portal stays PAUSED for real edits until the customer slices ship.**

## Standing invariants (every task)
1. **Zero charged-value change, no reverted live edit.** `computeServerTotal` + the numeric pricing/extras tables byte-identical pre/post, both brands. Never rebuild authoritative prices from code literals — the migration builds from the CAPTURED ACTIVE VERSION.
2. **Charging namespace ≠ display namespace ≠ dish/extra namespace.** X.Pizza has a dish AND an extra "Pepperoni" — never conflate. Carry display metadata ALONGSIDE the unchanged numeric charging table.
3. **Derivable from the immutable version alone** — no served/display field from `meta/source` or a code literal.
4. **Fail-closed everywhere**; **brand-agnostic** (no `rid==='x_pizza'`; keying via the existing resolver).
5. **Tests originate from the real reader/writer** for parity claims; mutation-verify discriminating tests (a mutant must actually hit the target).

## The load-bearing gotchas the grill surfaced (don't rediscover them)
- **Migration = field-level provenance MERGE:** captured active version wins for prices (edit-preserving); the ABSENT display fields (extras name/cat, exposure) come from the deployed serving artifacts (only place they exist today); reconcile via the pricing resolver; **reject ambiguous matches** (never guess). Also **upgrade `meta/source` drafts** to the new schema without publishing their edits, or the merchant's next portal publish fails validation.
- **Exposure is a COMMITTED contract** (Task 1): `(category allow − item deny + item add)`, ordered (extra-category, then EXTRAS); Nutella→∅, rice_03→+proteins, launcher-inherited-by-variants; legacy maps = DERIVED output, not a second source. La Musa dup-reject is **per submitted line**, not global.
- **"desde" is DERIVED** (min selectable variant); launcher price stays L414; **emit a derived `basePrice` compat alias** in the bundle so the current La Musa form keeps working pre-1B.
- **Rendering-safety at 1A, both sinks:** reject body-context markup (La Musa `innerHTML`) AND **attribute-breaking quotes** (X.Pizza `alt="${p.name}"` — a `"` with no angle brackets still injects). Enumerate per each brand's real sinks; the render-layer fix is 1B, but no unsafe value may be activated now.
- **Validator on EVERY publish path** (`publish-version` bypasses `validateSource` today) + **pointer-flip CAS** on expected active version + draft revision — this also closes the inherited 2b-2b publish-freshness race.
- **Version identity** content-hash covers the WHOLE served payload (today pricing-only, so a display change is invisible to it); version reads never fall back to active/flat records.

## Gate posture
Advisor source-audits + codex money-gates each task (heaviest: T2 validator/safety, T7 publish-paths/CAS, T8 migration). Gate-until-APPROVE on money-adjacent. Then the closing full-slice gate → **owner runs the Task 9 cutover** (capture→migrate→parity suite→publish-from-store→verify→prod check; strict-reader-compatible rollback). Nothing merges/deploys/pushes without the owner.
