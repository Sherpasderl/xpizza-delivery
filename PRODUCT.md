# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Installed iOS home-screen PWA (standalone display mode), phone-only, portrait. Not a native binary: confirmed 2026-09-21 that the PWA stays. The iOS design language is a visual commitment (see Brand Commitments), not a platform change.

## Stack

Existing codebase; no stack question was owed. Static HTML/CSS/ES modules served as-is by Netlify per-folder git-CD (`xpizza-dispatch-mobile/netlify.toml`, no build step). Firebase Web SDK v10.13.2 (Auth + Realtime Database) via the shared `xpizza-delivery.js`, Google Maps JS + Static Maps, a static-shell service worker, and Web Push (VAPID). Tests run on `node --test`.

## Users

**Primary: the owner-dispatcher.** Runs the floor of two restaurants from a phone, one-handed, often walking — kitchen pass, dining room, parking lot. Peak load is Friday and Saturday night. Screen is frequently at low brightness in a bright kitchen. Their standing question is *what needs me right now*, not *what is the status of everything*.

**Secondary: a substitute manager.** Covers a shift occasionally, has never been trained on the app, and has not seen the desktop dispatch board. Everything they need must be learnable from the screen itself.

**Not a user:** drivers (they have their own app) and kitchen staff (they have the KDS).

## Product Purpose

Watch live delivery and pickup orders across both restaurant brands, and get a driver onto an unassigned delivery fast — from anywhere in the building, without going to the desktop dispatch station. Success is that no order sits unassigned longer than it should, and that the owner can leave the desk.

## Positioning

The companion surface to the desktop dispatch board, not a replacement for it. It shares the desktop's assignment rules byte-for-byte — the same SDK entrypoints, the same compare-and-set guards — so the phone can never create a state the desktop would refuse. Its advantage is location, not capability: the same authority, carried.

## Operating Context

- San Pedro Sula, Honduras. Timezone `America/Tegucigalpa`. Currency Lempiras (`L`).
- Two brands from two kitchens: **X. Pizza** (`x_pizza`) and **La Musa** (`la_musa`), each with its own hub coordinates.
- Order lifecycle mirrors the kitchen display system: `new` → `preparing` → `ready` → `out_for_delivery` → `delivered`/`completed`, plus `scheduled` orders that activate at their slot time.
- Every delivery order gets a driverless `_delivery` task at creation, so a driver can be assigned while the food is still cooking.
- Drivers ping GPS roughly every 10 s; a ping older than 90 s is stale.
- Surrounding surfaces the same staff use: the desktop dispatch board, the kitchen KDS, and the driver app.

## Capabilities and Constraints

**Does today:** live order board across both brands; filter by unassigned / delivery / pickup / scheduled; order detail with itemized contents; assign and reassign a driver; live driver map with road routing; read-only driver roster; opt-in staff web push.

**Hard constraints that survive the redesign:**
- **Exactly two mutation sites**, enforced by `readonly.test.mjs`: the assignment write (`assignOrderToDriver` / `reassignOrder`) and the user's own push subscription. Everything else is read-only.
- **Desktop parity**: assignment goes through the bundled SDK entrypoints unchanged. `driver-glide.js` is byte-identical to the desktop copy and `parity.test.mjs` enforces it.
- The six pure modules (`board-model`, `dispatch-aging`, `reassign-model`, `slot-format`, `push-support`, `driver-glide`) stay DOM-free and node-testable. 22 tests must stay green.
- Firebase RTDB rules gate reads to staff accounts; a customer token authenticates but sees an empty board.
- Static hosting, no build step, no CSP currently shipped.
- iOS standalone PWA miscomputes viewport height at first paint; the shell height must be pinned from `visualViewport`.

**Approved additions (2026-09-21), neither of which writes to the database:** a `tel:` action to call the customer from the order detail (the desktop has this; the phone does not), and a sign-out control (none exists anywhere today).

**Decided 2026-09-21 — aging thresholds unified.** The phone no longer passes its own `{amber:480, red:900}`. Both surfaces now call `agingBand(secs)` bare, so the single source of truth is the module default in `dispatch-aging.js`: **amber at 5 min, red at 10 min**. The clock is total age from `created_at`, so the phone applies heat only while an order is still in `nuevos`/`preparacion`, or while it has no driver at any stage — an order 25 minutes into a normal delivery is not late, and reddening it would drown the ones that are.

**Decided 2026-09-21 — driver picker excludes off-shift.** `driverPickList` ranks by distance to the hub alone, which put a driver who had gone home (but parked near the restaurant) at the top of the list for the app's only mutation. The picker now shows on-shift drivers only, grouped Disponibles / En entrega, with a quiet line naming how many are hidden. The map already behaved this way; the two now agree.

**Decided 2026-09-21 — pickup is called "Pickup".** One name, everywhere: the filter chip, the card state line, and the order detail. It replaces the four that were in use ("Pickup", "Recoger", "Recoge el cliente", "Listo para recoger"). Delivery remains "Entrega". This deliberately diverges from the desktop's "Recoger".

**Decided 2026-09-21 — Completados is capped to today.** Scoped to the current Tegucigalpa day and sorted by completion time, newest first, so the list cannot grow unbounded across a service. Header reads "Completados hoy".

## Brand Commitments

- **Language: Honduran Spanish, voseo.** "actualizá", "reintentá", "iniciá sesión", "añadí". Not neutral es-419. This is load-bearing and must survive any rewrite.
- **Two-brand identity is first-class.** X. Pizza and La Musa must be distinguishable at a glance on every order, in bright-kitchen conditions.
- **Status color inherits the kitchen display system** so the phone and the KDS read alike for the same staff.
- **Visual world (pinned by the user, 2026-09-21): native iOS.** The app should read as a beautiful, first-party-quality iOS app. Executed at full fidelity as the platform's own design language, not as a stylistic quotation of it.
- Product name in the shell: **Dispatch**. Full title "Dispatch · X. Pizza + La Musa".

## Evidence on Hand

- Working implementation at `xpizza-dispatch-mobile/` and the authoritative desktop board at `xpizza-dispatch/index.html`.
- Shared SDK `xpizza-delivery.js` (1100+ lines) carrying every data contract.
- Self-hosted Hanken Grotesk variable font at `xpizza-dispatch-mobile/fonts/`.
- App icons at 192/512 and an apple-touch-icon.
- A design critique of this surface at `.impeccable/critique/2026-09-21T00-21-57Z__xpizza-dispatch-mobile-index-html.md` (17/40) and one of the desktop board (25/40).
- **No real customer data, order history, or driver records may be invented.** Screenshots and mocks use synthetic names; real figures come from the live database only.
- There is no logo file for either restaurant brand in this folder; brand identity currently exists only as two hex values.

## Product Principles

1. **Answer "what needs me now" before "what is everything doing."** The phone is not a status mirror of the desktop; it is a triage surface for someone in motion.
2. **Never present stale data as live.** Connection state, GPS freshness, and order age are claims the interface makes and must be able to back.
3. **The assignment is the product.** It is the only thing the phone changes, it is irreversible in the moment, and it deserves the most care of any interaction here.
4. **Learnable without training.** A substitute manager on their first Saturday must be able to work it from the screen alone.
5. **Read at arm's length, one-handed, at low brightness.** Legibility in the real scene outranks density and outranks decoration.

## Accessibility & Inclusion

- Primary user is over 50 with presbyopia and frequently works without reading glasses. Type must respond to iOS Dynamic Type; a fixed-px scale is a product failure, not a style choice.
- WCAG 2.1 AA as the floor for text, controls, and focus, in **both** light and dark appearance.
- The whole assignment path must be operable by VoiceOver and by an external keyboard. It currently is not.
