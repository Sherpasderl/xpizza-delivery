# Dispatch D — Chrome: nav rail, order drawer, roster/cash, liveness, alerts

**Status:** DESIGN (approved mockup + critique P2 liveness) → relay to auditor for **codex gate** → owner deploy.
**Date:** 2026-09-20
**Base:** verify `origin/main` directly before building. File: `xpizza-dispatch/index.html`. Own worktree.
**Fidelity target — EXACT:** the approved mockup **https://claude.ai/artifact/FhdBztp7Uce9NN5uUgQP5g**. Reproduce its nav rail, order drawer, roster, cash bar, liveness pip, auto-assign toggle, and alerts affordance.
**Money-adjacency:** the drawer, rail, liveness, and roster are **display-only, NOT money-adjacent**. The cash/cuadre bar and the alerts→Reconciliación entry only *link/display*; they perform **no cuadre math or write** (the actual reconciliation logic lives in its shipped panel). Any control that would trigger a refund/cancel from the drawer routes to the existing gated server call, unchanged. **Full codex gate.**

## Motivation
The mockup's chrome carries real dispatcher capability that the current board either fragments or lacks: a persistent **nav rail** naming every surface (Despacho · Pedidos · Comms · Programados · Reconciliación · Repartidores · Ajustes), a right-side **order-detail drawer** (the mockup's presentation of the shipped order modal, incl. **Factura·RTN**), the honest **driver roster** + **cash/cuadre bar**, a topbar **board-liveness heartbeat** (critique P2 — nothing today signals the board itself is live vs frozen), the **Auto-asignar** toggle, and an **alerts** affordance for non-order exceptions (e.g. a GPS-dark driver).

## Scope (all in `xpizza-dispatch/index.html`, additive)
1. **Nav rail** — the left icon rail from the mockup: Despacho (active), Pedidos, Comms (with the existing inbound-WhatsApp unhandled badge), Programados, Reconciliación, Repartidores, Ajustes; tooltips name each. Wire each item to the surface it already represents in the board (existing tabs/panels/modals — Comms → the existing messages modal, Reconciliación → the shipped panel, etc.). No new backend; the rail is navigation over existing surfaces.
2. **Order-detail drawer** — migrate the **shipped** `renderOrderDetailModal` content (Cliente · Entrega · Pedido · Pago · **Factura·RTN** iff `rtn_cliente` · Repartidor · Timeline · cancel-reason) into the mockup's right-side drawer presentation. **Read-only, brand-agnostic, every field `escapeHtml`'d** — all invariants from the shipped modal carry over verbatim (this is a presentation move, not a content change). Drawer is Escape-closable, focus-trapped, restores focus. Footer actions (Asignar/Reasignar → command palette; Llamar; Cancelar → the existing gated `cancelOrderRemote`) reuse existing handlers.
3. **Driver roster** — the mockup's roster with **honest liveness** exactly as the board already models it (GPS vivo/inactivo/sin-señal via `last_ping`; push-reachability separate from GPS; status Es-copy; active-order count; the GPS-dark alarm row; call-driver). No liveness-logic change — same `isStalePing`/`hasPushReachability`/dot vocabulary; only the presentation matches the mockup.
4. **Cash / cuadre bar** — the roster-footer strip showing shift cash + pending cuadres + a "Reconciliar" link to the shipped Reconciliación panel. **Display + navigation only — no cuadre computation or write here** (reads existing values; the panel owns the logic). If the displayed figures require a new read, it is read-only over existing nodes.
5. **Board-liveness heartbeat (critique P2)** — a topbar pip that reflects RTDB connection/last-event freshness: "en vivo · hace Ns", turning amber when no board event has landed within a threshold (so a frozen board can't masquerade as live). Driven by the existing RTDB subscription's event timing / `.info/connected`; **read-only, no writes**.
6. **Auto-asignar toggle + alerts** — the refined Auto-asignar switch (drives the existing auto-assign setting, unchanged) and an alerts affordance surfacing non-order exceptions (GPS-dark driver, etc.) that used to live only in the Torre list (post relay B).

## Invariants (no-regression)
- **Drawer content == shipped modal content**, field-for-field, with the same escaping, the same brand-agnostic Factura gating (`rtn_cliente` present), the same read-only guarantee (no writes on open, no new subscriptions). Only the container/presentation changes.
- **No liveness/assignment/cuadre logic touched** — `isStalePing`, `hasPushReachability`, dot vocabulary, auto-assign setting, and every server call are unchanged; this relay is chrome + presentation + one read-only heartbeat.
- **Heartbeat is read-only** — it observes connection/event freshness; it never writes.
- **Overlays escape their container** — drawer/menus use fixed/dialog, not clipped by an `overflow` ancestor.
- **XSS** — every customer field in the drawer/roster `escapeHtml`'d (attribute sinks too).
- **Brand-agnostic**; shared file, both brands.
- **Fidelity** — rail, drawer, roster, cash bar, pip, toggle match the mockup exactly.

## Gate focus (codex, on the build diff)
- Drawer is a faithful move of the shipped modal: no field added/removed, escaping intact, Factura block still iff `rtn_cliente`, no write on open, focus-trap + Esc + restore.
- Roster liveness uses the existing predicates unchanged (no new "invented" driver state).
- Heartbeat performs no writes; amber logic is purely observational.
- Cash bar does no cuadre math/write — display + link only.
- Nav rail wires to existing surfaces; no dead/new backend.
- XSS across drawer/roster; overlays not clipped.
- Visual/interaction fidelity to the mockup.

## Test plan
- Open a delivery order with a factura (e.g. the real La Musa RTN case) → drawer shows Factura·RTN; a no-RTN order shows none; pickup shows no Entrega. Esc closes + restores focus. No DB write on open.
- Roster: a GPS-dark driver shows the alarm row; a stale-but-reachable driver shows amber "GPS inactivo" not gray; an unreachable driver shows "Sin notificaciones" — matching current truth.
- Kill the RTDB connection (or simulate stale) → the heartbeat goes amber; restore → green. No writes emitted.
- Cash bar shows shift figures + links to Reconciliación; performs no write.
- Nav items open their existing surfaces.
- Hostile customer fields render as text in the drawer.
- Side-by-side vs mockup.

## If APPROVED → deploy (owner)
`git fetch` + confirm `origin/main`. Dispatch Netlify `xpizzadispatch` git-CD (explicit `--site …778` if CLI). No functions/rules. Verify against the mockup: rail, drawer (incl. Factura), roster liveness, cash bar, heartbeat.

## Sequencing note
Recommended relay order to the auditor: **A (assign/command-palette) → B (one queue/one count) → C (theme + rename + cleanup) → D (chrome)**, each additive and gated, together landing the approved mockup. C's theme tokens underpin B/D visuals, so if built in parallel worktrees, land C's tokens first or share them. All four are fidelity-checked against **https://claude.ai/artifact/FhdBztp7Uce9NN5uUgQP5g**.
