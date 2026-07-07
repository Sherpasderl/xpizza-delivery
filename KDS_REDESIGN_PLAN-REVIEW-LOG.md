# Plan Review Log: KDS Redesign — Square visual language + scheduled identity
Started 2026-07-07 (session). MAX_ROUNDS=2. PLAN_FILE=KDS_REDESIGN_PLAN.md.
Codex read-only every round; presentational sanity pass.

## Round 1 — Codex
**Findings**

- `KDS_REDESIGN_PLAN.md` says “Zero functions changes” and “Preserved verbatim,” but the pass necessarily changes KDS browser functions for `mm:ss`, band state, all-day rail, and scheduled badges. Fix: explicitly scope “no Firebase/order lifecycle/functions backend changes” and list allowed render-only JS edits.

- Aging source of truth is contradictory: the table hardcodes 8/15 minutes, while `ready-nudge.js` has one per-restaurant prep threshold defaulting to 25 and uses `order_timelines.preparing_at`, not `released_at || created_at`. Fix: define a separate display-aging helper/config, or change the table to use the existing nudge threshold semantics; do not claim both.

- The scheduled band rule is underspecified: “carries `scheduled_for`, pre-slot” can hide late/overdue state forever if the code only checks `scheduled_for`. Fix: gold only when `scheduled_for && Date.now() < scheduled_for && status !== Listo`; after slot, fall back to elapsed/status colors.

- The current KDS already depends on DOM contracts: `#card-${id}` for ready nudge, `.nudge-overdue`, `#elapsed-${id}` for ticking, `.card` for touch drag, and inline `moveOrder` handlers. A restyle that renames/removes these silently breaks live behavior. Fix: preserve these IDs/classes/handlers or update all dependent controllers in the same diff with tests/manual checks.

- All-day rail can regress extras parsing if it reuses `parseItems()`, which currently splits on ` | ` without respecting bracket depth, while `renderItems()` has the correct bracket-aware splitter. Fix: extract a shared bracket-aware item parser from `renderItems()` without changing its output, and compute counts from active rendered KDS orders only.

- “All-day rail computed from the live queue” is ambiguous about local `Archivado`, cancelled, delivered, and restaurant-filtered state. Raw `/orders` computation would show hidden, wrong-restaurant, or terminal orders. Fix: compute the rail from the same post-filter `activeOrders` used by `render(activeOrders)`, excluding `Cancelado`/`Archivado`.

- The host-agnostic invariant is at risk from the visual-language copy and assets: hardcoded “X Pizza,” restaurant-specific logo text, or per-host font/asset paths in `xpizza-kitchen/` would violate one byte-identical folder serving both hosts. Fix: keep all restaurant identity derived from existing `XPD.KDS_RESTAURANT_ID`/`applyKdsBrand()` only.

- Font plan is incomplete: “self-host Hanken Grotesk” does not say where files come from, what license file is kept, which formats are shipped, or how cache/service-worker behavior avoids external fetches. Fix: vendor `.woff2` files under `xpizza-kitchen/`, include license/attribution, use relative `@font-face`, and remove Google Fonts links.

- Dispatch/driver scheduled badges are not just “add somewhere”: dispatch has unassigned cards, assigned task rows, expanded detail modal, map info windows, and delivered/cancelled views; driver has active card, incoming banner, queue card, and queue detail. Fix: define exactly which renderers get the badge and keep it read-only from `order.scheduled_for`.

- Dispatch/driver plan says “must not touch money/assignment logic,” but badge insertion near `total`, assign buttons, `assignOrderToDriver`, slide-confirm, and cash/vuelto UI can easily disturb event delegation or payment rows. Fix: add pure `formatScheduledSlot()`/badge markup helpers and only splice returned HTML into render templates, with no changes to handlers or SDK functions.

- KDS scheduled display already exists in `mapFirebaseOrderToCard()` and `renderCard()`: `scheduled_for` and `released_at || created_at` are present today. Treating it as new work risks deleting working behavior during restyle. Fix: preserve the existing `scheduled_for` mapping and elapsed anchor exactly, then only move its presentation.

- Contrast/reduced-motion is listed as a risk, not an implementation requirement. The late red band with white text, orange/gold with dark text, red extras on white, disabled pulse, and `nudge-overdue` animation all need concrete CSS. Fix: require tested contrast values and a `@media (prefers-reduced-motion: reduce)` rule that disables pulse/transition animations and uses a static outline.

- `Listo` band precedence conflicts with “aging band color driven by timer, not workflow column” and the table’s “Listo in Listo column = green.” Fix: state precedence explicitly: cancelled > Listo > scheduled pre-slot > elapsed aging, or whatever is intended.

- `node --check` alone will not catch broken browser module imports, CSS asset paths, or inline handler globals after a DOM rewrite. Fix: add manual smoke checks for login, render, nudge class, drag/drop, touch advance, scheduled badge, and both host pins, plus the existing `order-filter`/`ready-nudge` tests.

VERDICT: REVISE
### Claude's response (Round 1)
ACCEPTED all findings — a presentational overhaul that touches live DOM has exactly these traps. Revisions:
- Reworded scope: 'no Firebase/Cloud-Functions/order-lifecycle backend changes' + explicit allowed client render-only JS edits.
- Split display-aging (own config: elapsed-since-anchor, 8/15) from ready-nudge (25-min prep-overdue on preparing_at) — no shared-source claim.
- Added band precedence: Cancelado > Listo > scheduled-pre-slot(gold) > elapsed aging; gold only while now<scheduled_for && !Listo, else falls back.
- Added a PRESERVED DOM-CONTRACTS list (#card-${id}, #elapsed-${id}, .nudge-overdue, .card draggable, inline moveOrder/showLog handlers).
- KDS scheduled display already exists (mapFirebaseOrderToCard/renderCard + released_at anchor) — restyle, do NOT rebuild.
- All-day rail: extract a shared bracket-aware parser from renderItems (don't reuse buggy parseItems); compute from the same post-filter activeOrders, excluding Cancelado/Archivado.
- Host-agnostic reinforced: identity ONLY via KDS_RESTAURANT_ID/applyKdsBrand; no hardcoded brand/logo/per-host asset paths.
- Font: vendor .woff2 under xpizza-kitchen/ + license, relative @font-face, remove the Google Fonts <link>.
- Dispatch/driver: enumerated the exact renderers; pure formatScheduledSlot()/badge helper spliced into render templates only — no handler/SDK/money/assignment changes.
- Contrast + prefers-reduced-motion promoted from 'risk' to implementation requirement with concrete CSS.
- Testing: added a manual smoke checklist (login, render, nudge class, drag + touch advance, scheduled badge, both host pins) alongside order-filter/ready-nudge goldens + node --check.

## Round 2 — Codex
**Findings**

- The plan still conflicts with itself on `renderItems`: it says `renderItems` stays byte-for-byte, but the rail spec says to extract a shared parser from `renderItems`. That is not byte-for-byte. Fix: either copy the bracket-aware splitter into a new rail-only helper, or allow a refactor guarded by exact golden output tests for `Pizza N:` and `(todas)`.

- “Pulse reuses existing `nudge-overdue` animation semantics” is dangerous because `.nudge-overdue` is controller-owned by `ready-nudge.js`; using that same class for 15+ minute display-aging would let the nudge controller add/remove the late pulse incorrectly. Fix: create a separate display class like `.aging-late` and only reuse keyframes/timing, not the `.nudge-overdue` state class.

- Header line 2 includes “assigned employee,” but KDS does not currently map or subscribe assignment/driver data, and the plan says no Firebase reads/writes. An executor may add task/driver reads to satisfy this. Fix: remove “assigned employee” from KDS scope unless it already exists on the order record and is rendered read-only from current data.

- The automated gate says `node --check` on the KDS module, but KDS JS is inline inside `xpizza-kitchen/index.html`, not a standalone module file. This can become a fake gate. Fix: specify an extraction command/check for the inline `<script type="module">`, or move KDS JS to a real `.js` module and check that.

- Dispatch renderer naming is still ambiguous: “expanded detail modal” could miss `renderOrderExpanded(order)` versus `renderOrderDetailModal(order)`, and both are real render paths. Fix: name the exact functions/areas: `renderUnassignedSection`, `renderTaskRow`, `renderOrderExpanded`, and `renderOrderDetailModal`.

- Driver scheduled badge omits `renderQueueDetail()`. A queued scheduled order can show a badge on the queue card, then lose slot context when the driver opens the detail sheet. Fix: include `renderQueueDetail(o, seq)` in the driver target list.

- The rail needs its own regression guard. The current gate mentions existing `order-filter`/`ready-nudge` tests but not the new bracket-aware count parser, which is the highest-risk new logic touching pizza item parsing. Fix: add a small parser/count golden test covering bracketed extras with ` | `, per-instance `Pizza N:`, and `(todas)` cases.

VERDICT: REVISE
### Claude's response (Round 2) — MAX_ROUNDS=2 reached
ACCEPTED all 7 findings (no contested points — these are refinements, not a disagreement deadlock):
1. renderItems contradiction → copy the bracket-aware splitter into a NEW rail-only helper; renderItems stays byte-for-byte.
2. .nudge-overdue is controller-owned → display pulse uses a separate .aging-late class (reuse keyframes/timing only).
3. Dropped 'assigned employee' from KDS line 2 (KDS has no assignment data; would force a Firebase read) → line 2 = timer + order id.
4. node --check on inline HTML is a fake gate → syntax-check the extracted inline module + node --check the real .js modules.
5. Named exact dispatch renderers: renderUnassignedSection / renderTaskRow / renderOrderExpanded / renderOrderDetailModal.
6. Added renderQueueDetail(o, seq) to the driver badge targets.
7. Added a rail parser/count golden test (bracketed | , Pizza N:, todas).

RESOLUTION: Bounded sanity pass (2 rounds) complete. Both rounds were REVISE, but every finding across both was accepted and incorporated — no unresolved disagreements. Substantive risks (DOM contracts, controller-owned classes, parser bug, host-agnostic, no-hidden-Firebase-reads, precedence) are closed. Plan is materially hardened and ready for the executor; an optional 3rd round would likely return APPROVED.

## Round 3 — Codex (confirming, owner-authorized beyond the 2-round cap)
I re-reviewed `KDS_REDESIGN_PLAN.md`; `PLAN.md` is still the unrelated static audit plan.

No material implementation-plan flaws remain. The revised plan now closes the live-KDS break risks I flagged: `renderItems` stays untouched, display aging no longer fights `ready-nudge`, KDS avoids new assignment reads, syntax gating is real, dispatch/driver render targets are explicit, queue detail keeps scheduled context, and the rail parser gets its own golden coverage.

One wording nit remains: “No Firebase reads/writes” really means “no changes to Firebase read/write paths,” since the live apps obviously keep their existing reads/writes. That is not enough to block implementation because the surrounding scope makes the intent clear.

VERDICT: APPROVED
### Claude's response (Round 3)
APPROVED. Applied the one non-blocking wording nit: 'No Firebase reads/writes' → 'No changes to Firebase read/write paths (apps keep existing reads/writes; this pass adds none)'.

FINAL RESOLUTION: Plan APPROVED after 3 rounds (R1 REVISE 13 findings, R2 REVISE 7 findings, R3 APPROVED). Every finding accepted + incorporated; zero unresolved disagreements. Ready for executor build.
