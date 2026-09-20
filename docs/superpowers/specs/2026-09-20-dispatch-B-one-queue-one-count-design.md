# Dispatch B — One action queue, one count (surface consolidation)

**Status:** DESIGN (from `/impeccable critique` P1 + approved direction mockup) → relay to auditor for **codex gate** → owner deploy.
**Date:** 2026-09-20
**Base:** verify `origin/main` tip directly (`git ls-remote origin`) before building — [[verify-remote-git-state-directly]]. File: `xpizza-dispatch/index.html`. Own worktree off origin/main — [[parallel-session-file-coordination]].
**Fidelity target — EXACT:** the approved mockup **https://claude.ai/artifact/FhdBztp7Uce9NN5uUgQP5g** (owner: "what I saw in the mockup is exactly what I want in the real app"). See [[build-exact-to-mockup-and-quality]], [[dispatch-impeccable-polish]]. Build to the mockup's "Cola de acción" column: one ordered queue + one count + segmented filter.
**Money-adjacency:** NOT money-adjacent (display/queue reorganization over existing order state; no charge, no assignment-semantics change). Still **full codex gate** — [[codex-gate-always]].

## Motivation (critique P1)
The same unassigned order appears in **three surfaces with three affordances and three counts**: "Sin asignar" left rail (`renderUnassignedSection` ~:3270, has an Asignar button), "En Fila → Entrega" right rail (`renderPedidosTab` ~:3461, modal-only), and the Torre alert list (`renderDispatcherAlerts` ~:2800). Counts diverge: KPI `stat-pending` (`getPendingOrders`), the En-Fila badge (`enFilaAttentionCount`), and the Torre alert count. Working-memory tax + "which one do I act on?" — the opposite of scanability.

## Goal
Collapse the order-action surfaces into **one "Cola de acción" queue** with **one authoritative "needs me now" count**, exactly as the mockup shows: a single ordered list (unassigned + stalled + at-risk), a segmented filter (Todos · Sin asignar · Detenidos · En riesgo) with per-segment counts, and the same count mirrored in the header and the topbar KPI. The map becomes the ambient layer; a card exists **only** when an order needs a human.

## Scope (all in `xpizza-dispatch/index.html`, additive to the redesign)
1. **Single queue data model.** One selector builds the queue from order state: unassigned pending (the existing `getPendingOrders` predicate — `!assigned_driver_id && status not in {cancelled,completed}`, kept byte-identical), plus **stalled** assignments (existing `isStalledAssignment`, display-only) and **at-risk** (existing `deliveryRisk` "slipping"/aging bands). Deduplicate by `order_id` (an order appears once). Order the queue by urgency (red/late → amber/aging → green), matching the mockup's edge-band ordering.
2. **One count.** A single `needsActionCount = queue.length`. Render it in the Cola header ("N necesitan acción"), the topbar KPI ("En cola"), and drop the divergent second/third counts. Per-segment counts (Todos/Sin asignar/Detenidos/En riesgo) are derived filters of the one queue, shown in the segmented control exactly as the mockup.
3. **Preserve every per-order action inline.** Each queue row keeps its real affordances from the current board: **Asignar** (unassigned) / **Reasignar** (stalled) → opens the command palette (see relay A); **Ver detalle** → order drawer (relay D); **···** menu (Ver detalle · Llamar cliente · Asignar/Reasignar · Cancelar·reembolso). Card-body click → drawer; action buttons `stopPropagation` (no swallowed assign — the shipped rule at the card/button handlers).
4. **Retire the duplicate surfaces.** The "Sin asignar" separate list and the "En Fila" order rows fold into the one Cola; the Torre alert list's order-attention items are represented by the queue (non-order alerts — e.g. driver GPS-dark — move to the alerts affordance in relay D). No order is actionable from two places.

## Invariants (no-regression — [[no-regression-hard-rule]])
- **`getPendingOrders` predicate byte-identical** (the completed/cancelled exclusion shipped earlier); the queue is a superset view (adds stalled + at-risk), never a different pending rule.
- **No assignment/cancel logic touched** — assign/reassign/self/cancel all still route through their existing server calls unchanged (this relay only reorganizes *where rows appear* and *how the count is derived*).
- **Read-only re: data** — no new writes/subscriptions; the queue reads order state already in memory.
- **XSS** — every customer field (`customer_name`, `items_text`, address, etc.) stays `escapeHtml(String(...))`'d in the new row template.
- **Brand-agnostic** — no `restaurant_id` literal; both brands share the file ([[brand-agnostic-no-hardwiring]]).
- **Fidelity** — layout, segmented control, edge bands, chips, spacing, and copy match the mockup's Cola column exactly.

## Gate focus (codex, on the build diff)
- The one-count derivation cannot double-count or drop an order (dedup by `order_id`; a stalled order that is also unassigned appears once).
- No order becomes actionable from two surfaces; no order silently disappears from the queue that the old three surfaces would have shown (assert the union: old {unassigned ∪ stalled-surfaced ∪ at-risk} == new queue).
- `getPendingOrders` unchanged; no assignment-semantics drift.
- XSS on the new row markup; stopPropagation on action buttons preserved.
- Visual + interaction fidelity to the mockup Cola.

## Test plan
- Seed unassigned + stalled + at-risk orders → each appears once, urgency-ordered; the header count, KPI, and segment counts agree and equal the queue length.
- Assign an order → it leaves the queue and the count decrements everywhere at once.
- A row that is both unassigned and at-risk shows once with both cues; no duplicate.
- Action buttons act without opening the drawer; card body opens the drawer.
- Hostile `customer_name`/`items_text` render as text.
- Compare side-by-side against the mockup Cola (layout, bands, chips, copy).

## If APPROVED → deploy (owner)
`git fetch` + confirm `origin/main`. Dispatch Netlify `xpizzadispatch` git-CD (explicit `--site ac3fa94a-564a-4df4-9428-34e6cb41f778` if CLI — [[netlify-deploy-mechanics]]). No functions/rules. Verify against the mockup: one queue, one count, actions inline.
