# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: **merchant owners** of restaurants on the Sherpa delivery platform (X. Pizza and La Musa today), logging in to view and manage their own live menu. The portal is **owner-only and tenant-isolated** — a merchant sees only the restaurants they own; internal staff and dispatchers use separate tools, not this portal.

## Product Purpose

Sherpa's self-serve **merchant portal** — the front door for restaurants on the last-mile delivery platform to view (and, in progress, edit) their live catalog: prices, items, categories, availability, and add-ons. It publishes changes to the authoritative catalog that serves the customer order forms and the kitchen display. Success is a merchant managing their own menu with no engineer in the loop.

## Positioning

A **brand-agnostic, multi-tenant merchant OS** where the **catalog is the pricing authority** and onboarding a merchant is **config, not code**. Delivery is the wedge; SAR (Honduras) fiscal-as-a-service is the moat, offered to X. Pizza only today. Every capability is designed to work for any merchant by configuration alone.

## Operating Context

Firebase-Auth login (WhatsApp/email accounts) → restaurant switcher → menu. The Firestore **catalog is the single source of truth**, served to the order forms and the KDS. Catalog changes flow through a **money-gated write path**: validate → server-diff → owner fiscal acknowledgement (X. Pizza SAR) → verify-before-flip → one-click rollback. Strict Content-Security-Policy; owner-only tenant isolation enforced server-side. Merchants may check the portal on a phone as well as a counter screen.

## Capabilities and Constraints

- **Live (slice 2b-2a):** owner login, restaurant switcher, read-only menu view (categories / items / prices / extras), tenant-isolated.
- **In progress:** the editor (2b-2b/c/d — edit prices/items/categories/extras → review → publish; instant "86" sold-out); then **Ventas** merchant analytics.
- **Money/fiscal-gated:** pricing changes are validated, server-diffed, owner-fiscal-acknowledged (X. Pizza), verified before flip, and reversible.
- **Brand-agnostic / multi-tenant:** per-merchant config (key strategy, fiscal flag); a third merchant onboards by config with no code change.
- **Stack:** static vanilla-JS + ES modules + Firebase Auth via CDN, **no build step**, git-CD Netlify — the same mold as the existing staff apps.
- **Deferred (not merchant-facing yet):** offering KDS/POS modules to merchants — the post-consolidation "full Sherpa OS" phase.

## Brand Commitments

- Name: **Sherpa** — the metaphor works three ways: carry the load (delivery), guide the terrain (abstract the fiscal/operational complexity), know the mountain (local expertise).
- Language: **Spanish (es-HN)**.
- Binding identity constraints: **Hanken Grotesk**; a KDS-cued, sober visual identity; the owner's standing bar — **elegance is as important as functionality**, and **the build must match the approved mockup exactly** (not a close copy).
- **Fiscal (SAR factura) is X. Pizza-only** — never a tenant/portal feature.

## Evidence on Hand

- Live portal: `https://sherpa-portal.netlify.app` (read-only, in production).
- Approved editor mock: `docs/superpowers/assets/2026-09-07-portal-editor-mock.html` (the pinned design reference for the editor).
- Real merchants: X. Pizza and La Musa (both owned). No invented merchants, metrics, or testimonials — future work must not fabricate any.

## Product Principles

1. **Brand-agnostic by config** — every capability works for any merchant; no hardcoded brand branches.
2. **The catalog is the money authority** — changes are money-gated, byte-safe, and reversible.
3. **Seamless, zero-friction merchant experience** — elegance equal to function.
4. **Build exactly to the approved mockup; certainty over guessing.**
5. **Fiscal is a per-merchant capability** (X. Pizza-only today), never a special-cased brand.

## Accessibility & Inclusion

Spanish (es-HN) interface. **WCAG AA** is the target; a technical audit found gaps to close — mobile controls, muted-text contrast, and focus visibility. Usage spans a phone and a counter screen, so touch targets and glanceability matter.
