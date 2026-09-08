# RELAY (advisor → executor) — Key-Strategy → Per-Merchant Config

**Authoritative:** spec `docs/superpowers/specs/2026-09-08-key-strategy-config-design.md` · plan `docs/superpowers/plans/2026-09-08-key-strategy-config.md`. Build to them.

**Base:** branch off `origin/main` (confirm head with the advisor — `git fetch` first). TDD, task-by-task, **LOCAL-ONLY**. Do NOT push/deploy.

**🔴 MONEY AUTHORITY — the pricing key.** A wrong key silently misprices/rejects a live order or corrupts a SAR factura. The design was **codex money-gated BLOCK → REVISE → REVISE → APPROVE** (4 passes); the invariants below ARE the folded findings — build them exactly, they are non-negotiable.

**What it is:** move the item/extra/availability KEY derivation from the hardcoded `rid === 'la_musa' ? id : name` ternary (6 copies) to a per-merchant `keyMode`, read from the already-seeded `pricing_key_mode`. **Byte-identical no-op for x_pizza+la_musa; pure-config for a third merchant.** Unblocks the portal write slices (2b-2b/c/d).

**6 tasks (full detail in the plan):** (1) resolver + `defaultKeyMode` frozen fallback; (2) serving reads `keyMode` via `createCatalogReader` + the outage ladder + flat path; (2b) all 3 availability call sites; (3) publish + rollback snapshot `source.key_mode`; (4) `key_mode` a source field, validated against; (5) effective-mode fiscal fence; (6) honored-flag regression + full parity sweep + scoped guard.

**Non-negotiable invariants (the money-gate's findings — diff-prove each):**
1. **Byte-identical no-op** for x_pizza/la_musa: `keyMode` absent ⇒ `defaultKeyMode(rid)` ⇒ today's exact ternary. Current pre-snapshot versions serve unchanged. Proven by the §6 parity surface.
2. **`defaultKeyMode(rid)` is the ONLY surviving key-deciding brand literal** — everything else routes through the resolver. Scoped grep-guard (Task 6) allowlists non-key brand logic (weekend/redeem/display/routing).
3. **`keyMode` lives in the SOURCE (`source.key_mode`)** — set from the profile at build (generic merchant reads/pins it; legacy x_pizza/la_musa derive `defaultKeyMode`, byte-identical), **validated against the stored keys** (`validateSource` derives through `source.key_mode`), and **snapshotted from the source into the version at publish AND rollback**. NO fresh profile read at publish (drift = blocker).
4. **Serving adds NO new read:** version path via `createCatalogReader` (record already read); **flat/pre-publish path carries `profile.pricing_key_mode`** (`readFlatDocs` already reads the profile — id-keyed merchant serves id-correct); the **outage ladder** (`pricing-tables.js` recordGood/lastGood + `snapshot-fallback.js` mirror) carries `keyMode`. All fail-CLOSED; absent ⇒ fallback (byte-identical).
5. **All THREE availability call sites** pass `keyMode` from the already-resolved `pricingTables`: `index.js:737,1256` + `rewards-redeem-intake.js:72`. Availability key must never drift from the pricing key.
6. **Fiscal fence = EFFECTIVE mode:** assert `!usesPlatformFactura(rid) || (keyMode || defaultKeyMode(rid)) === 'name'` (fail closed) before BOTH non-redeem `pricedLineItems` (`index.js:898,1361`) AND redeemed `applyXPizza` (`rewards-redeem-pricing.js:46`). **NEVER raw `keyMode === 'name'`** — pre-snapshot x_pizza has `keyMode` undefined and a raw check rejects every live factura on deploy.
7. **Rename coupling preserved:** `keyMode:'name'` keeps key ≡ display name (rename = new key, fiscal depends on it); `validateSource` derives through the configured mode.
8. **`keyMode` drives ONLY the key.** `byId` also toggles the extras cardinality model (id⇒qty-aware/dedup, name⇒count-once) — the only two supported combos; a guard-test asserts exactly those (a config id-keyed merchant inherits qty-aware extras — documented, not silently generalized). Do NOT add a third combo. Decoupling is a deferred axis.

**Deferred (NOT this slice):** id-keyed platform fiscal (fenced by #6), redemption-model axis, extras-cardinality-model axis.

**Gate (post-build, per task):** advisor source-audit + the **HEAVIEST codex money-gate** → owner deploys (a byte-identical no-op: serving versions have no snapshot → fallback → today; the snapshot populates on the next publish; no flip, no forced republish).

**Build TDD, LOCAL-ONLY. Hand back per task. Flag any current-source surprise (as the gate did on the outage ladder / 3rd availability site / extras-model coupling / flat path) rather than forcing the plan.**
