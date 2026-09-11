# Dispatch — Complete Order-Detail Modal (tap any order → full details)

**Status:** DESIGN (owner-approved shape) → plan/build (executor) → codex gate → owner deploy.
**Date:** 2026-09-10
**Base:** `origin/main` = `4d6697c`, module `xpizza-dispatch/` (separate from the 1A initiative — different files, its own worktree per [[parallel-session-file-coordination]]).
**Motivation:** a real La Musa order (Multicines Plaza S.A. de C.V., `PZX-260910-180713`) carried a factura RTN (`08019003239583`) that dispatchers had no simple way to see. Order info in dispatch is fragmented (compact Torre card + partial expanded card + an alert-only modal); nothing shows the full order, and nothing shows `razon_social`/`rtn_cliente`.

## Goal
Clicking any order in dispatch opens a **detail modal showing the complete order** — including the factura RTN — read-only, brand-agnostic.

## Scope
- **Trigger:** clicking an order card/row opens the detail modal. Reuse the existing `openOrderDetailModal(orderId)` (today reached only from alert navigation); wire the order-card click to it. **The card's existing action buttons (Asignar / A mí / más) must keep working** — `stopPropagation` on those so a button tap does its action and does NOT also open the modal.
- **Content (all operationally-useful fields, grouped), from the order object already in dispatch state:**
  - **Header:** order label/id, payment/lifecycle status, aging, `order_type`, `scheduled_for` (if scheduled).
  - **Cliente:** `customer_name`, `customer_phone` (tap-to-call), `customer_email` (if present).
  - **Entrega:** `address_detected`, `address_details`, `maps_link`, `waze_link` (delivery orders only).
  - **Pedido:** `items_text` (with extras), `notes`.
  - **Pago:** `payment_method` (cash/online via existing `isCashPayment`), `payment_status`, `total`; for cash, `cash_tendered` + change if present.
  - **Factura:** `razon_social` + `rtn_cliente` — shown **only when `rtn_cliente` is present**; labeled clearly (e.g. "Factura · RTN"). Brand-agnostic (both X.Pizza and La Musa forms capture it).
  - **Repartidor:** assigned driver name (if assigned).
- **Out of scope:** any write/edit from the modal (read-only); Torre-board layout changes; any new data model (all fields already exist on the order).

## Invariants
- **XSS: every displayed field is `escapeHtml`'d.** Order fields are **customer-supplied** (`customer_name`, `notes`, `razon_social`, `rtn_cliente`, address, items_text) — they flow into the dispatch DOM and must be escaped (dispatch already has `escapeHtml`; use it on every field, especially the new factura/notes/customer ones). No field is interpolated raw into HTML or an attribute.
- **Read-only:** no writes, no new subscriptions beyond the order already in state; opening the modal changes nothing.
- **Graceful missing fields:** absent fields render `—` or the whole section hides (e.g. no Factura block when no RTN; no Entrega block for pickup); never a crash or "undefined".
- **Brand-agnostic:** the Factura block keys off `rtn_cliente` presence, not the brand; no `restaurant_id === …` literal.
- **Interaction:** click-to-open must not break assign/more/self buttons; modal is dismissable (backdrop/close/esc).

## Testing
- Clicking an order opens the modal; clicking Asignar/A mí/más does its action and does NOT open the modal (stopPropagation).
- The modal shows every present field, grouped; a hostile `customer_name`/`notes`/`razon_social`/`rtn_cliente` (e.g. `<img onerror=…>` / `" onmouseover=…`) renders as **text**, not executable HTML/attribute — both a body-context and an attribute-context field asserted.
- Factura block shown iff `rtn_cliente` present (the real `PZX-260910-180713` shows razón social + RTN; an order with no RTN shows no Factura block).
- Missing/partial order (no email, pickup with no address, cash with no tendered) degrades gracefully.
- No write occurs on open (assert no DB mutation).

## Gate focus (codex, on the build)
- **XSS**: every customer-supplied field escaped, both body and attribute sinks; no raw interpolation.
- **Read-only**: no write/mutation from the modal path.
- **Interaction**: card-click vs action-button (no swallowed assigns).
- **Brand-agnostic** factura; graceful missing fields.
