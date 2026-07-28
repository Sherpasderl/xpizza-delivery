# Dispatch Redesign — Torre de Control — Design

**Date:** 2026-07-28
**Status:** Revised R1 (advisor/codex gate = REVISE, direction approved) → delta re-gate → phased build (each phase its own plan + codex-on-diff)
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

**Visual tokens (source of truth — `:root`, `index.html:18–35`):** `--bg #1a212c`, `--surface #232b39`, `--surface-2 #2d3645`, `--surface-3 #3d475a`, `--border #3a4458`, `--border-soft #2a3142`, `--text #f1f5f9`, `--text-soft #94a3b8`, `--text-dim #64748b`, `--accent #dc2626`, `--success #16a34a`, `--warn #f59e0b`, `--info #3b82f6`, `--teal #0d9488`. The `--*-soft` alpha variants (`--accent-soft`, `--success-soft`, `--warn-soft`, `--info-soft`) are **intentionally reused** for tinted fills (badges, hover states) rather than inventing new alphas. Fonts: **Plus Jakarta Sans** (UI), **IBM Plex Mono** (numbers/`#N`).

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
│ ☰  X Dispatch  [X.Pizza ▾]   KPIs: En turno·Sin asignar·Activos  │
│              (on-time% deferred→1b)  Auto-asignar  ⌘K  msgs  ⇥    │
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
- **KPI group** (borderless, hairline dividers, count-up on load): En turno · Sin asignar · Activos. **On-time % is NOT a firm Phase-1 KPI** — a true customer-facing on-time rate needs an SLA/promise time that does not exist yet (see §5.2 and §7). It lands as a fast-follow tied to predictor graduation (Phase 1b) + a pre-pickup drive estimate; in the interim it may appear only as a clearly-labeled **"estimado (preview)"** read off the shadow prediction (read-only display, never written back — respects the inviolable shadow boundary).
- **Auto-asignar** toggle (existing `setAutoAssignEnabled`), **⌘K** search/command entry, **messages** icon (inbound badge), **⇥** (toggle right rail).

### 5.2 Torre de control (exceptions-first) — *flagship, Phase 1*
- Promotes dispatcher alerts from a floating strip into a **categorized priority queue**: severity-ranked (red → amber → neutral), each row = icon · title · one-line detail · **"Tomar" (take-ownership)** on hover.
- **Alert registry, not a fixed 7-type list.** The backend writes more than the 7 well-known types — also `factura_*` alerts (which carry **no `type` field**) and payment/scheduled **sub-kinds** beyond the base set. A 7-only queue would silently bury real alerts — the opposite of the visibility goal. So the Torre is driven by an **alert registry**: known types map to a category + icon + severity; **anything unrecognized (incl. `factura_*` and new breach sub-kinds) falls into a generic "Otros / Revisar" bucket** so nothing is ever dropped.
- Known categories map to existing signals: driver-dark (`driver_freshness_stale` — derived, see below), no-driver (`no_drivers_available`), takeover (`no_response_takeover` / `assignment_strand`), payment (`payment_hosted_stale_no_callback`, `payment_reconcile_breaches`, `payment_aged_refund_pending` + sub-kinds), fiscal (`factura_*`), late (see next bullet). Reuses `dismissDispatcherAlert`.
- **`driver_freshness_stale` is a derived state, not just a banner.** Today it renders no banner but drives `staleDriverUids` and the red GPS-dark driver rows. It stays **first-class** in the new IA; the move must preserve its existing effects — regression-test that dismiss, the chime, and the red-row rendering all survive (see §10).
- **Lateness header — scoped to what's computable.** A promise/SLA time does **not** exist yet (§7). So the header aggregates only computable signals: **out-of-delivery orders exceeding their live post-pickup ETA** (the Phase-1a ETA is post-pickup only, `driver-eta.js:16`) plus **static-threshold aging** (orders past X min since created without delivery). It is **not** a promise-based on-time metric — that is deferred with the on-time KPI (§5.1).
- **"Tomar" is a local highlight only** — single-dispatcher operation, so no claim/assignee is written (resolved: no multiple dispatchers).

### 5.3 Sin asignar + rich order rows — *Phase 1*
Each order card surfaces, on its face (no click):
- `#N` (mono), customer, **live aging timer**. **Baselines from currently-subscribed data only:** created-time (unassigned), then assigned / picked-up / delivered timestamps (available on `orders`/`tasks`). **Kitchen-phase aging is NOT computable from current subscriptions** — it needs `order_timelines`, which dispatch does not subscribe to; Phase 1 either excludes kitchen-phase aging or **explicitly adds a read-only `order_timelines` subscription** (declared, not hand-waved). Green→amber→red band on the card edge.
- Items summary; **payment type** (Efectivo L… / Pagado online) from existing order data; **WhatsApp status** (sent) from automessage state; **ETA** when out-for-delivery (post-pickup); assigned driver + status dot.
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
- **Programados needs a dedicated read-only subscription — this is NOT "no backend."** `subscribeToOrders()` **filters out** scheduled/releasing orders, and held orders have no tasks/tracking. Full scheduled visibility requires a **dedicated read-only scheduled-orders subscription**; if we don't add it, the Programados badge must be scoped to **released-scheduled only** and labeled as such. Decision to make at the Phase-1 plan: add the read-only sub (full visibility) vs. released-only (smaller scope).
- **Driver roster rows:** avatar + status dot, GPS-liveness, and **surfaced quick actions on the card face** — `Llamar` (existing `tel:${d.phone}`, mint), **Mensaje in-app** (new, periwinkle — §5.7), `⋯` (more: last location, reassign, force off-shift — existing). Per-driver active task + ETA; the GPS-dark red row (C1) stays.

### 5.6 Customer in-app WhatsApp reply thread — *Phase 2*
- A **glass conversation sheet** (opened from Comms / the inbound-message affordance) showing a real two-way thread: **staged automessages inline** (tagged "Automático", from `sendOrderStatusNotifications`), inbound customer messages, and **manual dispatcher replies typed in-app**.
- **Transport reality — UltraMsg QR gateway, not the official Cloud API.** We send via UltraMsg's unofficial QR gateway (`/messages/chat`), **not** the WhatsApp Business Cloud API. So the **24h/template-window rule does not apply / is not enforced by this path** — my earlier framing was wrong. The real risk is a **number ban** for unsolicited or out-of-window sends. Phase 2 therefore adds an **operator-policy / ban-risk guard** (e.g. only allow manual sends in an active inbound conversation, rate-limit, discourage cold outbound) — **not** API template-window semantics. **Surface the guard only when it binds.** Replaces today's `wa.me` deep-link bounce-out.
- **A dedicated dispatcher send function is required — reusing `sendMessage()` is not enough.** The automessage `sendMessage()` is **best-effort, null-on-failure**; a manual dispatcher reply needs a **dedicated authenticated dispatcher-send Cloud Function** with: caller auth, an **audit trail**, explicit **delivery state** (queued/sent/failed) surfaced back to the composer, and a **failure contract** (the composer must show send-failed, not silently drop).

### 5.7 In-app dispatcher → driver messaging — *Phase 2*
- Driver **Mensaje in-app** action pushes a message into the **driver app via FCM** (`push_subscription`). Not WhatsApp — drivers are already in-app. **Note:** the existing `sendDriverPush` is an **assignment helper**, not a general messaging channel — this needs its own messaging path, not a reuse of that helper.
- **Full scope (nothing halfway):** a **message store** (dispatcher↔driver), **RTDB rules** for it, a **callable send function** (authenticated + **anti-spoof** so a driver can't post as dispatch or another driver), **FCM push**, and a **full two-way conversation thread in BOTH UIs** — the dispatcher Comms surface *and* a real thread in the driver app (`xpizza-driver`, native), not a minimal inbox. Driver reads and replies; dispatcher sees replies in the same Comms surface.
- This is the heaviest new piece → its **own hard gate**; treat messaging as money-adjacent for codex (tamper/spoof, delivery guarantees, stuck states).

### 5.8 Cobertura de capacidades — *Phase 1*
- A collapsible footer drawer listing every capability (✓ existing-now-visible, ★ new) — the at-a-glance **full-visibility proof** Xavier asked for. Default collapsed.

### 5.9 Command palette (⌘K) — *Phase 3, differentiator*
- Search orders/drivers + run actions (assign, cancel, message, jump-to-pin). **No console in the 19-platform benchmark ships one** — a genuine differentiator. Finishing-phase.

## 6. Visual system

- **Tokens:** the canonical dispatch palette (§2) is the source of truth. Depth is achieved with **gradient + shadow layers on top** of those tokens (subtle vertical card gradient, `0 4px 16px` shadow, `inset 0 1px 0` top highlight) — **not** by changing base token values.
- **Typography:** Plus Jakarta Sans (UI, weights 400–800), IBM Plex Mono (`#N`, timers, currency, ETA) with `tnum`.
- **Icons:** one SVG `<symbol>` sprite. Set `stroke: currentColor` / `fill: none` **on each `<symbol>` (or the rendered `.ic` `<svg>`), not on a wrapping `<g>` inside `<defs>`** — that approach does **not** propagate through `<use>` and renders black-filled (a bug caught in the mockup). Color via `currentColor`; action glyphs carry pastel tints (mint/periwinkle/slate). **Prototype the exact sprite in-browser and verify rendering before swapping any live icons.**
- **Glass:** `backdrop-filter: blur()` on floating panels (conversation sheet, ETA callout, map controls, legend).
- **Motion inventory:** count-up KPIs; ticking aging timers; staggered entrance (exceptions, chat bubbles); hover lifts; gentle pulse on hot count + GPS-dark; the animated route + sonar. **All wrapped in `@media (prefers-reduced-motion: reduce)`.**

## 7. Data & backend

- **Phase 1 is client-side + read-only reads — NOT "no backend" absolutely.** It's an IA/visual layer over subscribed data, with these honest caveats:
  - Client-side compute: aging timers (created/assigned/pickup/delivery timestamps), lateness aggregation (post-pickup ETA + static thresholds — *not* a promise metric), reading `driver_cash` for the cash bar.
  - **New read-only subscriptions may be required:** a **scheduled-orders** subscription for full Programados visibility (`subscribeToOrders` filters them out), and optionally **`order_timelines`** if we want kitchen-phase aging. These are read-only, no writes — but they are backend surface area to declare, not "nothing."
  - **On-time %** is deferred (no SLA/promise exists) — preview-only off the shadow prediction in the interim, real metric with predictor graduation.
  - No money-path change.
- **Phase 2 backend:** a **dedicated authenticated dispatcher-send Cloud Function** for customer replies (audit + delivery-state + failure contract; UltraMsg QR transport + ban-risk guard — **not** Cloud-API template logic); driver messaging (message store + RTDB rules + callable send + FCM + anti-spoof + driver-app receive/reply UI).
- **Phase 3:** command palette (client search over subscribed data); motion polish (client-only).

## 8. Phasing (by leverage)

| Phase | Scope | Backend? | Gate |
|---|---|---|---|
| **1 — Exceptions-first + full visibility** | Torre de control (alert-registry + fallback bucket), computable lateness header, rich order/driver rows + aging (subscribed-data baselines), surfaced driver call, cash bar, collapsible rails, Cobertura, visual system (icons/glass/depth). **On-time% deferred / preview-only.** | Client-side + possible **read-only** subs (scheduled-orders; optional `order_timelines`) — **no writes, no money path** | advisor + codex-on-diff |
| **1b (fast-follow)** | Real SLA-based on-time% + lateness, tied to **predictor graduation** + a pre-pickup drive estimate | Depends on predictor graduation | advisor + codex |
| **2 — Comms** | Customer in-app reply (**UltraMsg transport** + dedicated authenticated send fn + audit/delivery-state + **ban-risk guard**); in-app dispatcher→driver messaging (store + rules + callable + FCM + anti-spoof + both UIs) | Yes (Cloud Function, FCM, driver app) | advisor + codex (money-adjacent, **hard gate**) |
| **3 — Palette + polish** | ⌘K command palette; animated route + sonar; motion finishing | Client-only | advisor + codex |

Phase 1 is the highest-leverage, lowest-risk chunk (the ⅔ "buried" fix, no money path), and ships first. Each phase gets its own implementation plan. The on-time KPI is explicitly **sequenced to 1b** so Phase 1 never promises a metric that isn't computable yet.

## 9. Non-goals (this redesign)

- **Road-snapping the glide** — explored 2026-07-28 and **parked** (see the parked-decision memo / `2026-07-28-road-snap-validation-spike-design.md`).
- **Route optimization / multi-stop sequencing, proof-of-delivery, analytics/on-time dashboard, drag-drop assign** — real capability gaps from the benchmark, but separate future work, not this IA/visibility redesign.
- No change to assignment logic, pricing, refund, or any money path — this is presentation + comms.

## 10. Risks & guardrails

- **No money-path regression.** Phase 1 must not alter `assignOrderToDriver`, `cancelOrderRemote`, `resolveReconciliation`, or the glide. Codex-on-diff every build (money or not — standing discipline), with the focus on correctness/stale-UI/XSS-in-new-chrome for the non-money phases.
- **Don't drop existing behavior while reorganizing** — the **alert registry (incl. the `factura_*` / sub-kind fallback bucket)**, `driver_freshness_stale`'s derived effects (`staleDriverUids`, red GPS-dark rows, chime, dismiss), all dispatcher actions, scheduled orders, `#N`, delivered+search, reconciliation must remain reachable/functional in the new IA. Regression-test each.
- **Comms (Phase 2)** is the risk-carrying phase: **UltraMsg ban-risk** (unsolicited/out-of-window sends), a proper dispatcher-send failure contract, driver-message spoofing/tamper, stuck-message states, and driver-app receive reliability. Gate it hard.
- **`index.html` is a large shared hot file — Phase-1 extraction guard:** build **pure modules first** (Torre alert-registry/render, aging compute, lateness aggregation, conversation-thread assembly) with their own Node tests (per the `driver-glide.js`/`driver-eta.js` pattern), then land **one thin integration patch** into `index.html`. **No opportunistic rewrites** of untouched code, and **coordinate ownership with the parallel session** before editing the shared file.
- **XSS:** all customer/driver message content and order fields rendered in new chrome must go through the existing `escapeHtml`.

## 11. Testing

- Pure/extractable render + compute units (aging, lateness aggregation, conversation-thread assembly) as Node-testable modules where feasible, following the `driver-glide.test.js` pattern.
- Manual: verify every existing action still fires from its new location; verify collapse/focus states; verify `prefers-reduced-motion`; verify no console errors and no dropped subscription.
- Phase 2: dispatcher-send success/failure surfacing (composer failure contract); UltraMsg ban-risk guard behavior (block/allow by conversation state); driver-app message receipt/reply; tamper/spoof attempts.

## 12. Resolved decisions (2026-07-28)

1. **"Tomar" (take-ownership)** — **local highlight only**, no claim/assignee write. Single-dispatcher operation, no collision risk.
2. **Aging timer baseline** — **created-time** for the unassigned queue; **status-relative** once in flight.
3. **Right-rail density** — **driver roster is always visible** (never behind a tab); Pedidos/Programados/Comms/Caja are the switchable region below it, with a persistent cash/cuadre bar above.
4. **Conversation sheet placement** — **floating glass panel over the map** (the reviewed mockup direction).
5. **Driver-app messaging** — **the full two-way conversation thread** in the driver app, not a minimal inbox. Nothing halfway.

---

## Revision log

**R1 (2026-07-28) — folded in advisor/codex REVISE (direction approved):**
- **A. Phase-1 data honesty:** on-time% deferred to 1b (no SLA/promise exists; preview-only off the shadow prediction, read-only); lateness header rescoped to computable signals (post-pickup ETA + static aging); Programados needs a declared read-only scheduled subscription (or released-only scope) — not "no backend"; aging baselines scoped to subscribed data, `order_timelines` declared if kitchen-phase aging wanted.
- **B. Torre fidelity:** replaced the fixed "7 types" with an **alert registry + generic fallback bucket** (catches `factura_*` and payment/scheduled sub-kinds so nothing is buried); `driver_freshness_stale` kept first-class as a derived state (`staleDriverUids`/red rows/chime/dismiss must survive).
- **C. Comms transport:** reframed from WhatsApp Cloud-API 24h/template to **UltraMsg QR gateway reality** (ban-risk guard, not template windows); added a **dedicated authenticated dispatcher-send fn** (audit + delivery state + failure contract) instead of reusing best-effort `sendMessage()`; driver messaging keeps full scope (store + rules + callable + FCM + anti-spoof + both UIs), noting `sendDriverPush` is only an assignment helper.
- **D. Guardrails:** Phase-1 module-extraction guard (pure modules + one thin patch, no opportunistic rewrites, coordinate the shared `index.html`); icon sprite stroke on each `<symbol>`/rendered `<svg>` + in-browser prototype; token citation fixed to `:root` (18–35) with intentional `--*-soft` reuse.

→ Sent back for delta re-gate (codex thread held open).

---

*Mockup reference: full v6 in the visual companion (`.superpowers/brainstorm/`), the locked visual direction — glass depth + motion, true palette, line-icon system, pastel action icons.*
