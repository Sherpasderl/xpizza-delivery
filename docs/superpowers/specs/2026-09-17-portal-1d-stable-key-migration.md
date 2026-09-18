# Portal Single-Source 1D — Stable-Key Migration (brand-agnostic dish identity) — v2

**Status:** SPEC v2 (revised after codex design-grill #1 → re-grill pending). **Base:** origin/main `61306a5` (1A+1B live, 1C deployed-grace), verified against worktree `xpizza-1b`. **Role discipline:** executor builds local-only; advisor gates via codex (money-adjacent — never self-approve); owner deploys.

> **v2 changelog (grill #1 closed these):** D2/D3 are now SHADOW-only — legacy identity stays authoritative until the D4 flag (id-first selection was NOT byte-identical when a cart's id and name disagree). D1 is a full identity-persistence pipeline across the version-aware catalog, not a flat re-seed. Label≠identity is a hard invariant with an enumerated leak list (incl. the comped/reward factura description). Whole-flow safety gate runs BEFORE D4. D5 branch-deletion is gated on legacy-state retirement, not "one live cycle." Grounding corrected (pricing_key_mode is inert metadata; La Musa slug carries reward-prefix meaning; catalog is version-aware; resolvePriceTables receives projected tables, not docs).

---

## 1. Goal & the tenet it serves

Give **every dish (and extra) on every merchant a platform-minted, STABLE, unique, name-independent id** as its identity key; the display **name becomes a mutable label**. Every consumer resolves a placed line through **ONE brand-free path**. Delete the per-brand `restaurantId === 'la_musa' ? id : name` ternary (and its duplicate resolvers).

Serves the owner tenet (2026-09-17): brand/merchant-agnostic, built to scale, no hardwiring that needn't be. The `itemPricingKey` ternary + duplicate resolvers exist only because X.Pizza was never minted ids — accidental hardwiring.

**Win condition (testable):** the identity-path brand ternary + duplicate resolvers are **DELETED**, and a golden test over an explicit identity-module boundary fails if any `restaurantId === '<brand>'` literal reappears *in that boundary* — while leaving genuine per-merchant-fact branches (factura eligibility, weekend-only existence, reward policy) intact.

Unblocks safe self-serve portal editing (rename ≠ unhook) and makes onboarding a config act (a new dish/extra gets its id minted automatically; a merchant never types one).

> **Correction (grill #1):** "id" here means **stable + unique + name-independent**, NOT semantically empty. La Musa's slug qualifies and is grandfathered; its reward-prefix semantics are per-merchant *policy*, migrated in the later config slice, not here.

## 2. Grounded current state (source-verified 2026-09-17 @ 61306a5, grill-corrected)

| Surface | X.Pizza key | La Musa key |
|---|---|---|
| Cart wire line | `name` (UI-local numeric `p.id` NOT emitted) | `id` (slug) + `name` label |
| `itemPricingKey` `menu-pricing.js:127` | `item.name` | `item.id` |
| Duplicate resolvers | `catalog/form-menu-source.js:119,127`; probe `source-store.js:180` | same |
| Server reprice `computeServerTotal:157` | `menu[name]`, extras `extraPrices[ex.name]` per array entry | `menu[id]`, extras `extraPrices[ex.id]×qty` |
| Item-86 `availability-gate.js:43` | `availKey(name)` @ `/restaurants/{rid}/item_availability` | `availKey(id)` |
| Quote fingerprint `quote-token.js:75,98-112` | via `itemPricingKey` (dishes+options) | same |
| Reward `item_id`/`free_item_key` `rewards-redeem.js:58-98` | **name**; comped factura desc = `item_id` (`rewards-redeem-pricing.js:50,64`) | slug; reward-config reads slug PREFIX `rewards-redeem-config.js:93` |
| Factura line `factura/pricing.js:19,52` | lookup by **name**, desc = name(+extra names); X.Pizza-only `eligibility.js:34` | n/a (external POS) |
| Weekend-only `menu-pricing.js:52`, `catalog/menu-gates.js:118,195` | by **name** (merchant fact) | n/a |
| Saved reorder `reorder-normalize.js:25,33-60`; `account.js:1655` | name-bearing | id-bearing |
| Catalog dish doc `seed-catalog-core.js:62-66` | `{key:name, price, display}`, doc-id = `sha1(key).slice(0,20)` | `{key:slug,…}` |
| Catalog pipeline (drops a new field unless threaded) | publish `catalog-publish.js:276`; pricing reader `catalog-firestore.js:42`; projection `source-store.js:654`; content-hash `content-hash.js:40`; form recon `form-menu-source.js:338` | same |
| Active catalog is VERSION-aware | `catalog-firestore.js:93-99` (selected version + mirror snapshots `pricing-tables.js:147-161`) | same |
| CI manifest `menus/{rid}.json`, `menu-extract.mjs:31` | `keyField:'name'` (MENU only, not extras) | `keyField:'id'` |
| `pricing_key_mode` | **INERT metadata** — written `tools/seed-catalog.js:33`, allowlisted `seed-catalog-core.js:33`, no runtime read | same |

**Load-bearing fact:** X.Pizza dish **name** is the single identity string across all of the above; no platform-canonical id exists (UI numeric ids + `e1` extra ids exist but aren't canonical — `xpizza-orders/index.html:1456-1481`). **La Musa lives near the target** (stable slug + name label) but its wire lacks a `dish_id` field and its slug is not opaque.

## 3. Invariants (hold at EVERY task)

1. **Shadow until D4 = legacy business outputs + binding VALUES preserved (additive metadata permitted).** Through D1–D3 the **legacy identity stays authoritative**: a present id NEVER selects a different dish, changes acceptance, or changes a business output. The id is carried + **shadow-validated** (assert it resolves to the SAME dish the legacy key does; a mismatch is a bounded, non-fatal DIAGNOSTIC — it never rejects or alters the cart; log only). *Qualification (grill #2):* adding wire fields and content-hashed catalog fields necessarily changes serialized bytes — so the invariant is not literal byte-identity but: **every legacy BUSINESS output and every BINDING VALUE (fingerprints/hashes that bind carts→quotes→payments→reservations) is unchanged.** See §8 fingerprint-projection contract. Proven by composition: legacy-only, id+agreeing, and id+**disagreeing** carts all price/accept/display/bind identically pre-D4.
2. **Identity ≠ label — hard invariant.** No human-facing field ever carries an id VALUE. Enumerated leak sites to repair (grill #1): comped factura desc (`rewards-redeem-pricing.js:50,64`), summary names (`menu-pricing.js:276`, `index.js:404`), reward items_text suffix (`rewards-redeem-intake.js:67,79`), payment-return free_item (`index.js:2011`), blocked[] (`availability-gate.js:48`), pricing error strings (`menu-pricing.js:171-220`), WhatsApp (`index.js:3984`), tracker (`xpizza-track/index.html:734`), KDS labels (`xpizza-kitchen/index.html:2748`). Every key-as-label FALLBACK is replaced by a real label lookup or an explicit non-id placeholder. Gate asserts **id values do not reach display fields**, including missing-label cases.
3. **Charged == confirmed net** (1C) preserved end-to-end.
4. **Identity survives the whole catalog pipeline & versions.** The id is preserved by every projection/publish/mirror/hash/form-recon and across immutable versions; a re-seed reads-and-preserves an existing id (never re-mints); the storage doc-id is pinned stable (no longer derived from the mutable name).
5. **No 86 dropped/resurrected** across the availability re-key (full protocol §4-D4).
6. **Behavior moves only at D4, behind a reversible flag; rollback well-defined** while legacy state is still live.
7. **Ids opaque to code paths that don't own them:** stable, unique within a merchant, name-independent; dish and extra namespaces explicitly defined.

## 4. Tasks (reshaped)

### D1 — Canonical identity persistence pipeline (mint + preserve + thread; SHADOW)
- A durable per-merchant identity record mapping each dish AND extra to a minted stable id (namespace policy: dish vs extra explicit, since reward lookup searches both and availability is one flat namespace). La Musa grandfathers its slug as the id; X.Pizza mints fresh (`xp_…`).
- **Mint-once discipline:** read+preserve an existing id before minting; atomic/conditional first-write so concurrent seeds can't mint divergent ids; collision/uniqueness enforced; survives retries, reseeds, edits, publishes, rollback.
- **Thread the id through the whole pipeline** so nothing drops it: source store, immutable version publish, pricing reader, mirror snapshots, content-hash, and form/browser projections. **Pin the storage doc-id** (stop deriving from name) so a rename never moves the document.
- Platform **auto-mint** at dish/extra creation (portal/seed) — no human input.
- Nothing reads the id for selection. Byte-identical.
- **Gate focus:** reseed idempotence (id stable across re-runs, renames, version publishes); uniqueness; every projection/version/hash carries the id; no consumer selects on it; La Musa slugs unchanged.

### D2 — Cart + durable artifacts carry the id (SHADOW)
- Both forms emit `dish_id` (and extra id) on every line alongside name; La Musa adds the field too. Extras carry their canonical id.
- Durable identity-bearing artifacts learn to carry the id in shadow: quote-token fingerprint input, saved reorder recipes (`reorder-normalize.js`), reward canonicals.
- Server still keys by legacy identity; fingerprints/quotes unchanged in value. Byte-identical.
- **Gate focus:** emitted id matches catalog id; a line missing the id still prices via legacy; no fingerprint/quote value changes; no charged amount moves.

### D3 — Shadow-validate + build the full compatibility layer (legacy STILL authoritative)
- The resolver gains an id path used **only to validate agreement** with the legacy resolution (assert same dish; log mismatch); legacy selection/acceptance/output unchanged.
- Persist a complete, validated **old-key ↔ id mapping** (incl. rollback aliases). Prepare id-aware availability representation and an id-aware KDS **manifest/mapping published before D4**. Define durable-state migration contracts (in-flight signed quotes, saved reorders, pending hosted payments, scheduled orders).
- `resolvePriceTables` threading fixed (it receives projected tables, not docs — the id map is threaded upstream at projection).
- **Pre-cutover WHOLE-FLOW safety gate runs here** (before any behavior change): both brands × both payments × agreeing/disagreeing/legacy-only carts all identical; mapping complete; no leak.
- **Gate focus:** shadow validation catches disagreement without acting; mapping is total (every live dish/extra); manifest agreement both representations; durable-state contracts cover each artifact's lifetime.

### D4 — Flagged cutover to id-authoritative (only behavior change; reversible)
- Reversible RTDB flag (fail-safe = legacy) flips resolution to **id-authoritative** per merchant: a line whose id mismatches the catalog is refused even if its name would match (rename-safety begins).
- **Availability re-key protocol (grill #1 — full):** (a) old↔id mapping validated; (b) compat readers/writers deployed while legacy authoritative; (c) EVERY writer participates — server, KDS writer, stale KDS sessions, and the **scheduled reset** (`availability-reset.js:49-102`) — old writers upgraded/mediated; (d) concurrency-safe backfill (a stale `false` never overwrites a newer `true`; a reset deletion never resurrected); (e) forms' "any historical false blocks" reconciled (clearing only the new key must not leave an old alias blocking — `index.html:2331`/`:2786`); (f) precedence for false/true/**deletion** defined; fail-open preserved; (g) flip only after prerequisites hold; (h) both representations coherent through grace + rollback.
- Reward + factura lookup resolve by id; **label separation applied** — comped factura description repaired to a real name (not `item_id`), all fallbacks fixed (invariant #2).
- Grace → enforce; rollback = flip flag off (legacy still live).
- **Gate focus (hardest, money+fiscal):** re-key drops/resurrects no 86; renamed dish still prices/86s/rewards; tampered id refused; factura description still the human name; comped-line description not an id; rollback restores byte-identical legacy.

### D5 — Retire legacy + delete branch (win condition; gated on retirement criteria)
- **Only after** legacy-bearing state has aged out (cached forms, signed quotes, saved reorders, pending payments, scheduled orders — by their distinct lifetimes; explicit retirement checklist), remove the ternary + duplicate resolvers; resolver becomes id-only. Flag-rollback ends at this defined point (documented).
- **Golden test** over an explicit identity-module/function boundary: fails if any `restaurantId === '<brand>'` reappears in the boundary; NUL-safe sweep; explicitly EXCLUDES per-merchant-fact branches (factura eligibility Set, weekend-only, reward policy dispatch) — those keep their branch, only their internal key representation migrated.
- Remove inert `pricing_key_mode` writes/allowlist/test; note already-persisted profile fields are harmless residue.
- Regenerate `menus/{rid}.json` id-keyed both brands; `menu-extract.mjs` uniform; update `menus.test.mjs` keys-golden.
- **Gate focus:** no identity-path brand literal remains; per-merchant facts intact; manifest golden id-keyed; retirement criteria met before deletion.

### D6 — Closing whole-flow gate (distinct from D3 pre-cutover gate)
- Post-cutover closing gate: full matrix, mutation sweep zero-survivors on identity/pricing modules, id-leak assertion across all §3-#2 sinks, rename-safety end-to-end, branch-absence.

## 5. Risks & mitigations
- **id-first was not byte-identical** → FIXED by shadow-until-D4 (invariant #1).
- **Availability re-key** = the live-data hazard → full protocol §4-D4 incl. reset writer + stale clients + concurrency + historical-false + deletion + rollback.
- **Version-aware catalog + projections drop the field** → D1 threads the id through every stage + pins doc-id.
- **Key-as-label leaks (factura incl.)** → invariant #2, enumerated repairs, gate tests id-values-in-display.
- **Durable state (quotes/reorders/reward canonicals) outlives one cycle** → D3 migration contracts + D5 retirement criteria.
- **La Musa slug not opaque (reward prefix)** → identity only needs stable/unique/name-independent (met); prefix semantics are reward POLICY for the config slice, not 1D.
- **Factura description change = fiscal** → description stays the human name (captured checkout label vs current catalog label decided in D4 spec detail); `fiscal-representation-owner-gate` applies to any assertion change (there is none intended).
- **Delivery-pricing carry (1C):** unchanged; still owed when 2-tier delivery lands.

## 6. Test strategy
Extend 1C harnesses: composition — legacy-only / id-agree / id-**disagree** carts identical pre-D4, both brands, both payments; whole-flow — rename-safety + no-id-leak (all §3-#2 sinks) + availability no-drop; `menus.test.mjs` id-keyed at D5; mutation zero-survivors on identity path; golden branch-absence with identity-module boundary at D5. Explicitly test failure/mixed-version/missing-label cases, not only equal totals for well-formed carts.

## 7. Scope honesty
1D makes the **identity layer** brand-agnostic (how a rule FINDS a dish). It does NOT de-brand WHICH rules exist per merchant (factura mode, weekend-only, delivery tiers, reward policy, fiscal literals) — the next slice (config-ization). See `sherpa-platform-initiative` sequencing directive + `key-strategy-config-design`.

## 8. Cross-cutting contracts (grill #2 — bind every stage)

These are platform-wide requirements each stage's detailed spec must satisfy; they are the "concrete protocol" grill #2 asked for and are OWNED by the stage in brackets.

1. **Fingerprint projection [D2].** `redemptionFingerprint` (`rewards-redeem.js:24`), the reward reservation binding (`rewards-reserve.js:37,87` → `reservation_conflict`), and the quote-token fingerprint (`quote-token.js:73`) hash the WHOLE structure — a read-only probe confirmed that adding `dish_id` alone changes `redemptionFingerprint`. Contract: the shadow id lives OUTSIDE every hashed structure (a legacy-shape projection feeds all fingerprints/bindings) until the flag epoch; test retries against reservations/quotes/payment-attempts created before D2. La Musa's shadow field is `dish_id`; its existing authoritative `id` is untouched.
2. **One identity-mode snapshot per request [D4].** Read the flag ONCE per request and thread the mode through pricing, quotes, availability, rewards and factura — independent reads could split a single transaction across modes.
3. **Historical records are immutable snapshots [all].** Persisted `factura_items[].description`, `summary_lines`, `items_text` are historical — migration NEVER regenerates them from a later catalog label. `fiscal-representation-owner-gate` guards any factura-assertion change (none intended).
4. **Identity-map integrity on the PRICING path [D1/D4].** The pricing reader verifies price-table hashes, not the display content-hash (`catalog-firestore.js:66`, `catalog-integrity.js:25`) — an id↔key swap with unchanged prices could escape. Bind + validate the identity map on the money path itself.
5. **Legacy namespace collisions [D1/D4].** X.Pizza dish and extra share names (`Pepperoni`, `Prosciutto` — `menu-pricing.js:28,104`); the flat legacy `item_availability` cannot disambiguate them post-split. Define authoritative state + how existing flat entries map to the dish vs extra namespace. (Paid-cart 86 checks dishes only; reward checks can include extras — preserve that scope or design its expansion explicitly.)
6. **Alias non-reuse [D3/D5].** A retained old-key alias must NEVER remap an old recipe/cart to a DIFFERENT dish that later inherits the freed name.
7. **Additional leak sinks [D3/D4] — extend §3-#2:** checkout reward totals `fi.name||fi.item_id` (forms `:3003`/`:3549`); confirmation + fallback reward reconstruction (`:4453,4457`/`:4916,4920`); reward UI name callback `return p?p.name:id` (`:2645`/`:3189`); 2nd KDS sidebar label (`kitchen/index.html:2768`); the reward-availability synthetic **id-valued name** (`rewards-redeem-intake.js:72` — not a missing-label fallback, an actively populated id). Also: define WHEN today's La Musa missing-label slug leak is repaired (invariant #2 says every task; existing leak predates D4 — resolve the staging).
8. **Policy-key migration operational at D4 [D4, not D5].** Weekend matching uses `it.name` (`menu-pricing.js:65`); fallback-weekend + reward allowlist sets use legacy keys. Their internal key representation must migrate BY D4 or rename-safety bypasses weekend limits / rejects rewards until D5. (The branch stays; only its key rep migrates — the factura-eligibility Set holds restaurant-ids, so it does NOT migrate at all.)
9. **Dual-format manifest before cutover [D3→D5].** The production generator is `generate-form-bundle.js:65` (not only `menu-extract.mjs`); publish + test an intermediate manifest carrying BOTH representations before D4; `menus.test.mjs:19,54` compares against static `MENU_BY_RESTAURANT` while pricing is catalog-authoritative — the golden fixture must draw expected ids from the catalog/identity source and cover extras (manifest is dish-only today).
10. **Version-history & rollback ids [D1].** Existing immutable versions have no id; catalog rollback rebuilds snapshot/mirror from a retained version (`catalog-publish.js:330,364,374`). Choose: durable id registry overlaid on old versions, migrated successor versions, or old versions excluded from rollback. Name the FULL projection set: `catalog-menu.js:128`, `catalog-transform.js:11`, `catalog.js:47`, `snapshot-fallback.js:88,102,118,126`, `source-store.js:654`, `form-menu-source.js:338,353`.
11. **Reference migration [D1].** `item_order`, `extra_order`, `extras_by_item`, exposure overrides, reward allowlists, variant UI-ids (`source-store.js:467,606-648,670`) reference keys — decide per reference: stays legacy/UI vs becomes canonical.
12. **Renamed-input matching + UI-id decoupling [D1/D5].** Minting must use an immutable creation handle, NOT the price-based rename heuristic (`catalog-edit.js:79`) or mutable-key match (`seed-catalog-core.js:46`); edit API preserves the id (`edit-catalog-handler.js:79`). Decouple the `source-store.js:171` pricing-identity→UI-id-type probe but keep an explicit renderer/UI-handle contract (canonical `dish_id` ≠ a change to numeric `display.id` type).
13. **D4 mismatch semantics [D4].** Distinguish three cases: unknown/invalid canonical id (refuse), a valid id whose supplied name is stale (ACCEPT — this IS rename-safety; never mislabel from the stale name), and a conflicting legacy id. Rejecting every id/name disagreement defeats rename-safety; trusting supplied labels mislabels.
14. **Content-hash/ETag rollout [D1].** Ids change content hashes + public-menu ETags (`content-hash.js:40`, `public-menu.js:177`); define backward-compatible interpretation for old versions rather than treating any hash change as a forbidden shadow effect.
15. **Branch boundary enumeration [D5].** The golden test's identity-module boundary is an explicit function/module LIST (not a `restaurantId ===` grep — that misses `CONFIG.restaurant_id` at `account.js:1660`, `laMusa` aliases, and indirect resolvers). Separate key-SELECTION (delete) from extras arithmetic/dedup semantics (`menu-pricing.js:165-222`, `reorder-normalize.js:25-58` — merchant facts, keep).

## 9. Build process (architecture-of-record → stage-by-stage)

This document is the **architecture-of-record + contract inventory**, proven sound by codex design-grills #1–#2. It is NOT itself the executor build spec. 1D builds **1C-style, stage by stage**: for EACH of D1…D6, in sequence, write a detailed concrete-contract spec (satisfying its §4 scope + its §8-owned contracts) → codex design-grill → relay to executor → build local-only → codex money-gate → owner deploys — before starting the next stage. **Next: D1** (identity-persistence foundation) to executor-ready detail, then grill D1 specifically.
