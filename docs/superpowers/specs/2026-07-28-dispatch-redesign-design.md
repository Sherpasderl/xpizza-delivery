# Dispatch Redesign — Torre de Control — Design

**Date:** 2026-07-28
**Status:** Draft for review → advisor gate → phased build (each phase its own plan + codex-on-diff)
**Surface:** `xpizza-dispatch/index.html` (git-CD from origin/main)
**Type:** Information-architecture + visual redesign (UI/UX). Phase 1 is a client-side reorg over existing data; later phases add comms capabilities.

---

## 1. Purpose

Xavier's brief: *"dispatch should do so much more than it does, or at least have the features more visible than they are now… surface all our capabilities for full visibility… look, feel and work like a billion bucks."*

An industry benchmark (19 last-mile platforms) plus a source-level inventory of our board produced a clear finding: **dispatch is more capable than it looks — the gap is ~⅔ buried capability, ~⅓ missing capability.** This redesign closes both, anchored on the **exceptions-first** information architecture the category leaders (Bringg, eLogii, Nash) use.

**Goals**
1. **Full visibility** — every existing capability legible on one board, nothing buried in a `⋯` menu or a collapsed sub-panel.
2. **Exceptions-first** — a categorized priority queue of things-going-wrong, not a wall of orders.
3. **New high-leverage capabilities** — in-app customer reply, in-app driver messaging, a lateness header, a per-order aging timer.
4. **Billion-dollar craft** — the true dispatch palette, a monochrome line-icon system, glass/depth, and tasteful motion.

**Success criteria**
- A dispatcher can, at a glance, see: what needs attention, who's late, who's dark, what's unassigned, cash in the street, and every driver's state — without opening a menu.
- No regression to any existing money path, subscription, or action.
- The board reads as elegant and seamless, not busy.

## 2. Current state (verified from source)

**Live subscriptions (RTDB `onValue`):** drivers, tasks, orders, manual-reconciliation, dispatcher-alerts, auto-assign-enabled, incoming WhatsApp messages.

**Dispatcher actions today:** `setAutoAssignEnabled`, `dismissDispatcherAlert`, `markMessageHandled/Unhandled`, `assignOrderToDriver`, `reassignOrder` (distance-ranked `openPicker`), `cancelOrderRemote` (money-safe refund), `endShift`, `resolveReconciliation`.

**Seven typed alerts (exist, but share one floating strip):** `driver_freshness_stale`, `no_drivers_available`, `no_response_takeover`, `assignment_strand`, `payment_hosted_stale_no_callback`, `payment_reconcile_breaches`, `payment_aged_refund_pending`.

**Present but buried / thin:** single-delivery ETA chip (Phase 1a), scheduled orders, `#N` display number, delivered + search, driver `⋯` menu (`Llamar` → `tel:${d.phone}`, last location, reassign, force off-shift), payment reconciliation panel, WhatsApp inbound triage (modal; "Responder" is a `wa.me` deep-link, **no in-app reply**).

**Where we already lead the field (invisible today):** native WhatsApp customer messaging; COD + `driver_cash` cuadre (no dispatch console in the benchmark has automated cash-close).

**Genuinely missing (out of scope for this redesign — future capability work):** route optimization/sequencing, proof-of-delivery, analytics/on-time dashboard, drag-drop assign. Noted as non-goals in §9.

**Driver-app comms facts:** `drivers/<uid>.phone` exists; drivers carry `push_subscription` / `push_reachable` (native app + FCM) → in-app dispatcher→driver push is feasible.

**Visual tokens (source of truth — `index.html:17`):** `--bg #1a212c`, `--surface #232b39`, `--surface-2 #2d3645`, `--surface-3 #3d475a`, `--border #3a4458`, `--border-soft #2a3142`, `--text #f1f5f9`, `--text-soft #94a3b8`, `--text-dim #64748b`, `--accent #dc2626`, `--success #16a34a`, `--warn #f59e0b`, `--info #3b82f6`, `--teal #0d9488`. Fonts: **Plus Jakarta Sans** (UI), **IBM Plex Mono** (numbers/`#N`).

## 3. Design principles

1. **Exceptions-first.** The left rail leads with a priority queue ("Torre de control"), not the order list.
2. **Space & elevation, not borders.** Cards are distinguished by subtle background elevation + soft shadow + a top highlight — minimal hairlines. This is the single biggest "un-busy" move.
3. **Color only where it means something.** Neutrals do ~90% of the work; `--accent`/`--warn`/`--success` appear only on status, severity, and aging.
4. **One icon language.** A monochrome line-icon sprite in the dispatch Feather style (`stroke: currentColor; stroke-width: 2`). **No emoji in chrome** (per the standing rule). Action icons carry a **soft pastel tint** on the glyph itself (call = mint, message = periwinkle, more = slate) — no chip background.
5. **Full visibility, with focus on demand.** Everything is surfaced, but the left/right rails collapse (☰ / ⇥) so the dispatcher can focus the map. A collapsed rail keeps a badge so critical counts never vanish.
6. **Tasteful depth + motion.** Glass on floating panels, layered elevation, a live glowing delivery route with a sonar pulse, ticking aging timers, count-up KPIs, hover lifts, staggered entrance. All gated behind `prefers-reduced-motion`.

## 4. Information architecture

Three columns under a topbar, over a coverage footer. Both side rails collapse.

```
┌───────────────────────────── TOPBAR ─────────────────────────────┐
│ ☰  X Dispatch  [X.Pizza ▾]   KPIs: En turno·Sin asignar·Activos·  │
│                              A tiempo%   Auto-asignar  ⌘K  msgs ⇥ │
├─────────────┬───────────────────────────────┬─────────────────────┤
│  LEFT rail  │           CENTER map          │     RIGHT rail       │
│             │                               │  ┌ Cash / cuadre bar  │
│ Torre de    │  glide pins · glowing route · │  ├ Driver roster       │
│ control     │  sonar · ETA callout (glass)· │  │  (ALWAYS visible)   │
│ (exceptions)│  controls · legend            │  │  call·msg·more      │
│             │                               │  ├ Pedidos·Programados·│
│ Sin asignar │                               │  │ Comms·Caja (tabs —  │
│ (rich rows) │                               │  └ switchable region) │
├─────────────┴───────────────────────────────┴─────────────────────┤
│ Cobertura de capacidades (collapsible drawer — full-visibility)    │
└────────────────────────────────────────────────────────────────────┘
        + CONVERSATION SHEET (glass overlay) opened from Comms
```

## 5. Component specs

### 5.1 Topbar
- **Restaurant selector** (X.Pizza / La Musa), **brand**, **☰** (toggle left rail; red dot badge when collapsed and exceptions pending).
- **KPI group** (borderless, hairline dividers, count-up on load): En turno · Sin asignar · Activos · **A tiempo %** (new). Lateness folds into the Torre header, not a separate KPI.
- **Auto-asignar** toggle (existing `setAutoAssignEnabled`), **⌘K** search/command entry, **messages** icon (inbound badge), **⇥** (toggle right rail).

### 5.2 Torre de control (exceptions-first) — *flagship, Phase 1*
- Promotes the **existing 7 alert types** from a floating strip into a **categorized priority queue**: severity-ranked (red → amber → neutral), each row = icon · title · one-line detail · **"Tomar" (take-ownership)** on hover.
- **Lateness header:** "N tarde · Xm prom" computed from existing ETA vs promise data (the Phase-1a ETA already gives per-order ETA; aggregate client-side).
- Categories map to existing signals: driver-dark (`driver_freshness_stale`), no-driver (`no_drivers_available`), late (ETA-derived), takeover (`no_response_takeover` / `assignment_strand`), payment (the 3 payment alerts).
- Reuses `dismissDispatcherAlert`. **"Tomar" is a local highlight only** — single-dispatcher operation, so no claim/assignee is written (resolved: no multiple dispatchers).

### 5.3 Sin asignar + rich order rows — *Phase 1*
Each order card surfaces, on its face (no click):
- `#N` (mono), customer, **live aging timer** (client-computed from order created/status timestamps; green→amber→red band on the card edge).
- Items summary; **payment type** (Efectivo L… / Pagado online) from existing order data; **WhatsApp status** (sent) from automessage state; **ETA** when assigned; assigned driver + status dot.
- **Assign** affordance (existing `assignOrderToDriver` / distance-ranked picker); drag-drop is a later enhancement (§9).

### 5.4 Live map — *Phase 1 (pins) + Phase 3 (motion polish)*
- Existing glide pins (`driver-glide.js`, unchanged), customer pins, restaurant pin, off-shift last-location, fit + layers controls, legend.
- Status color-coding by driver state; GPS-dark pin pulses red.
- **ETA callout** as a glass panel (ETA · distance · late-by), from the Phase-1a ETA.
- Phase 3 adds the glowing animated route + sonar as ambient polish (visual only; the underlying position is still the real glide).

### 5.5 Right rail — persistent driver roster + switchable detail — *Phase 1*
- **The driver roster is always visible** (resolved: drivers must always be on the right side). It anchors the right rail and never hides behind a tab.
- Above it, a compact **Cash / cuadre bar** (also always visible): surfaces `driver_cash` (cash-in-street total, cuadre-pending count) — read-only surfacing of the existing driver-cash stack.
- Below the roster, a **switchable detail region** with tabs **Pedidos · Programados · Comms · Caja**, each badged (neutral counts) so state is visible when not open. WhatsApp inbound lives under **Comms**.
- **Driver roster rows:** avatar + status dot, GPS-liveness, and **surfaced quick actions on the card face** — `Llamar` (existing `tel:${d.phone}`, mint), **Mensaje in-app** (new, periwinkle — §5.7), `⋯` (more: last location, reassign, force off-shift — existing). Per-driver active task + ETA; the GPS-dark red row (C1) stays.

### 5.6 Customer in-app WhatsApp reply thread — *Phase 2*
- A **glass conversation sheet** (opened from Comms / the inbound-message affordance) showing a real two-way thread: **staged automessages inline** (tagged "Automático", from `sendOrderStatusNotifications`), inbound customer messages, and **manual dispatcher replies typed in-app**.
- Composer + quick-reply chips; replies send via the **existing WhatsApp outbound path** (reuse the automessage sender).
- **24-hour window handling:** free-form allowed within 24h of the customer's last inbound; outside 24h, restrict to approved templates. **Surface the constraint only when it binds** (window expired) — no permanent "24h" chrome. Replaces today's `wa.me` deep-link bounce-out.

### 5.7 In-app dispatcher → driver messaging — *Phase 2*
- Driver **Mensaje in-app** action pushes a message into the **driver app via the existing FCM channel** (`push_subscription`). Not WhatsApp — drivers are already in-app.
- Requires: a message store (dispatcher↔driver), a send path (FCM push), and a **full two-way conversation thread in the driver app** (`xpizza-driver`, native) — **not** a minimal inbox (resolved: build the full thing, nothing halfway). Driver can read and reply; dispatcher sees replies in the same Comms surface.
- This is the heaviest new piece → its own gate; treat messaging as money-adjacent for codex (tamper/spoof, delivery guarantees, stuck states).

### 5.8 Cobertura de capacidades — *Phase 1*
- A collapsible footer drawer listing every capability (✓ existing-now-visible, ★ new) — the at-a-glance **full-visibility proof** Xavier asked for. Default collapsed.

### 5.9 Command palette (⌘K) — *Phase 3, differentiator*
- Search orders/drivers + run actions (assign, cancel, message, jump-to-pin). **No console in the 19-platform benchmark ships one** — a genuine differentiator. Finishing-phase.

## 6. Visual system

- **Tokens:** the canonical dispatch palette (§2) is the source of truth. Depth is achieved with **gradient + shadow layers on top** of those tokens (subtle vertical card gradient, `0 4px 16px` shadow, `inset 0 1px 0` top highlight) — **not** by changing base token values.
- **Typography:** Plus Jakarta Sans (UI, weights 400–800), IBM Plex Mono (`#N`, timers, currency, ETA) with `tnum`.
- **Icons:** one SVG `<symbol>` sprite; color via `currentColor`, stroke set on the icon element (so it inherits into every `<use>` — the `<g>`-in-`<defs>` approach does **not** propagate through `<use>` and renders black-filled, a bug caught in the mockup). Action glyphs carry pastel tints (mint/periwinkle/slate).
- **Glass:** `backdrop-filter: blur()` on floating panels (conversation sheet, ETA callout, map controls, legend).
- **Motion inventory:** count-up KPIs; ticking aging timers; staggered entrance (exceptions, chat bubbles); hover lifts; gentle pulse on hot count + GPS-dark; the animated route + sonar. **All wrapped in `@media (prefers-reduced-motion: reduce)`.**

## 7. Data & backend

- **Phase 1 is almost entirely client-side** — an IA/visual layer over data we already subscribe to. New client-side computation only: aging timers (from timestamps), lateness aggregation (from ETA), and reading `driver_cash` for the cash bar. No new backend, no money-path change.
- **Phase 2 backend:** customer reply send (reuse WhatsApp sender + 24h/template logic); driver messaging (message store + FCM push + driver-app receive UI).
- **Phase 3:** command palette (client search over subscribed data); motion polish (client-only).

## 8. Phasing (by leverage)

| Phase | Scope | Backend? | Gate |
|---|---|---|---|
| **1 — Exceptions-first + full visibility** | Torre de control, lateness header, rich order/driver rows + aging timers, surfaced driver call, cash bar, on-time% KPI, collapsible rails, Cobertura, visual system (icons/glass/depth) | Client-only (reads existing data) | advisor + codex-on-diff |
| **2 — Comms** | Customer in-app WhatsApp reply thread (24h/templates); in-app dispatcher→driver messaging (FCM + driver-app UI) | Yes (WhatsApp send, FCM, driver app) | advisor + codex (money-adjacent) |
| **3 — Palette + polish** | ⌘K command palette; animated route + sonar; motion finishing | Client-only | advisor + codex |

Phase 1 is the highest-leverage, lowest-risk chunk (it's the ⅔ "buried" fix and touches no money path), and should ship first. Each phase gets its own implementation plan.

## 9. Non-goals (this redesign)

- **Road-snapping the glide** — explored 2026-07-28 and **parked** (see the parked-decision memo / `2026-07-28-road-snap-validation-spike-design.md`).
- **Route optimization / multi-stop sequencing, proof-of-delivery, analytics/on-time dashboard, drag-drop assign** — real capability gaps from the benchmark, but separate future work, not this IA/visibility redesign.
- No change to assignment logic, pricing, refund, or any money path — this is presentation + comms.

## 10. Risks & guardrails

- **No money-path regression.** Phase 1 must not alter `assignOrderToDriver`, `cancelOrderRemote`, `resolveReconciliation`, or the glide. Codex-on-diff every build (money or not — standing discipline), with the focus on correctness/stale-UI/XSS-in-new-chrome for the non-money phases.
- **Don't drop existing behavior while reorganizing** — all 7 alert types, all dispatcher actions, scheduled orders, `#N`, delivered+search, reconciliation must remain reachable in the new IA.
- **Comms (Phase 2)** is the risk-carrying phase: WhatsApp 24h/template compliance, driver-message spoofing/tamper, stuck-message states, and driver-app receive reliability. Gate it hard.
- **`index.html` is a large shared hot file** — coordinate ownership before editing (parallel sessions); consider extracting new modules (e.g. a Torre de control render module, a conversation-sheet module) to keep units focused, mirroring the pure `driver-glide.js` / `driver-eta.js` pattern.
- **XSS:** all customer/driver message content and order fields rendered in new chrome must go through the existing `escapeHtml`.

## 11. Testing

- Pure/extractable render + compute units (aging, lateness aggregation, conversation-thread assembly) as Node-testable modules where feasible, following the `driver-glide.test.js` pattern.
- Manual: verify every existing action still fires from its new location; verify collapse/focus states; verify `prefers-reduced-motion`; verify no console errors and no dropped subscription.
- Phase 2: WhatsApp send within/outside the 24h window; driver-app message receipt; tamper/spoof attempts.

## 12. Resolved decisions (2026-07-28)

1. **"Tomar" (take-ownership)** — **local highlight only**, no claim/assignee write. Single-dispatcher operation, no collision risk.
2. **Aging timer baseline** — **created-time** for the unassigned queue; **status-relative** once in flight.
3. **Right-rail density** — **driver roster is always visible** (never behind a tab); Pedidos/Programados/Comms/Caja are the switchable region below it, with a persistent cash/cuadre bar above.
4. **Conversation sheet placement** — **floating glass panel over the map** (the reviewed mockup direction).
5. **Driver-app messaging** — **the full two-way conversation thread** in the driver app, not a minimal inbox. Nothing halfway.

---

*Mockup reference: full v6 in the visual companion (`.superpowers/brainstorm/`), the locked visual direction — glass depth + motion, true palette, line-icon system, pastel action icons.*
