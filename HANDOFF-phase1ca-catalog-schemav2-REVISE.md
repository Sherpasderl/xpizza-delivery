# REVISE RELAY — Phase 1c-a: close the display-reader trust-boundary gap + tighten two coverage items

**To:** executor · **From:** advisor. **Base:** your `feat/phase1ca-catalog-schemav2 @ 9cb098b`. **Gate result: REVISE** — PIN 1 is SOUND (codex confirmed byte-invisibility by demonstration; the pricing reader provably projects exactly `['key','price']` against schema-v2 docs, all seed invariants preserved, extras/PIN-2/dormancy all confirmed). ONE blocking fix + two should-fix. Small delta; commit LOCAL-ONLY on the same branch.

## 🔴 BLOCKING — `getRestaurantMenu` can return a partial menu on a duplicated `item_order`
`catalog/catalog-menu.js` (the item_order regeneration contract, ~:51-58) checks every ordered key EXISTS and `item_order.length === records.length`, but NOT that `item_order` has no DUPLICATES. So records `[A,B]` with `item_order` `[A,A]` passes (`has(A)` twice, length `2===2`), returns `[A,A]`, and **silently drops B** — a partial menu, which contradicts this reader's stated "can never return a plausible-partial menu" trust boundary. Dormant in 1c-a (nothing reads it), but 1c-b's bundle generation depends on exactly this contract → close it now.
- **Fix:** assert `item_order` keys are UNIQUE (e.g. `new Set(item_order).size === item_order.length`, else throw `menu_structure_bad: … item_order has duplicate keys`), so the covered-set is a genuine bijection with the records. (The uniqueness check + the existing exists + length checks together prove every record is emitted exactly once.)
- **Test:** a case with `item_order` containing a duplicate (and one record thereby uncovered) → throws, not a silent `[A,A]` drop.

## 🟡 SHOULD-FIX 1 — the explicit drop-field mutation test the handback described isn't present
The handback stated "dropping a single field (desc) during extraction fails the round-trip." Codex found NO explicit test that deletes `display.desc` and asserts the round-trip fails — the existing deep-equality WOULD catch a real drop, but the described negative test isn't there. Add the explicit falsifiable test: mutate an extracted record to drop a display field (`desc`) → assert the round-trip comparison FAILS. Make losslessness mutation-proven, not just deep-equality-implied. (Either the claimed test was mischaracterized or it's missing — align the code to the claim.)

## 🟡 SHOULD-FIX 2 — `sliceLiteral`/`readSetLiteral` are brace-balanced by RAW characters, not string/comment-aware
`catalog/form-menu-source.js` (~:33-53) counts delimiters without skipping string contents, so a future item `description` (or any field) containing `]`/`}`/`[`/`{` inside a quote would mis-slice. Current literals are simple enough that it works (codex confirmed), and the bootstrap is a ONE-TIME operation whose result is caught by the round-trip parity (a bad slice → parity FAILS loudly, never a silent mis-seed) — so this is not a correctness risk. But harden it cheaply OR document it explicitly: either make the scanner skip string literals, or add a top-of-function comment that it assumes quote-free structural delimiters + relies on the round-trip parity as the backstop, and add a guard test asserting the current forms slice cleanly. Your call which; note it in the handback.

## Not changing (confirmed fine — do NOT touch)
- PIN 1: all live-path files byte-empty; `{key,price}` top-level pristine; nested `display`; pricing reader unchanged. **Do not touch.**
- Nested-display decision, deferred `price>0`, `item_order` in structure, profile-LAST-with-structure-before, reconcile/chunk/overwrite/allowlist, dormancy, PIN 2 — all confirmed SOUND.
- Forward (1c-b/1d, NOT now): the version record needs explicit count/hash fields — 1d publish hooks add those deliberately; leave 1c-a's structure as `{schema_version, item_order, categories, …}`.

## Re-gate
Commit the delta LOCAL-ONLY → handback with the uniqueness fix + test, the explicit drop-field mutation test, and the slicer hardening/doc decision → advisor light re-gate (source-audit the delta + codex delta-verify) → then owner re-seed + `verify-catalog` (production catalog == code tables) → NO functions deploy → then 1c-b.

---
*Relay artifact (advisor→executor) — remove from the main tree before any ff-merge (diff-confirm identical first).*
