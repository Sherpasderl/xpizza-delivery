# Portal 2b-2b — Price Editing + Bold-Editorial Re-skin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`. Governance: **executor builds LOCAL-ONLY**; advisor source-audits each task; **codex money-gates** the build (writes to the live catalog / SAR factura); owner deploys. Do NOT push/deploy.

**Goal:** Add price editing (items + existing options) end-to-end over the deployed `editCatalog`/`publishEdited` backend, and re-skin the whole portal to Bold-Editorial — matching the approved mock exactly.

**Architecture:** Frontend slice on `xpizza-portal/` (vanilla ES modules, no build, git-CD Netlify) **+ ONE additive backend field** (`usesPlatformFactura` on `getEditableCatalog`, Task 2b — requires a functions redeploy). The UI is a faithful presenter of server truth; all authz/diff/token/fiscal re-checked server-side.

**Tech Stack:** static HTML + ES modules, Firebase Auth (CDN), the existing portal modules.

## Global Constraints (every task)
- **The approved mock is the VISUAL/interaction target:** `docs/superpowers/assets/2026-09-07-portal-editor-mock.html` — match its look and interaction exactly, and port its CSS/skin (Task 1) + non-money markup faithfully. **BUT it is a mock:** for money surfaces it uses `innerHTML`, inline `onclick`/`style`, a CLIENT-side diff, a hard-coded `BRAND.fiscal`, and a demo publish-outcome selector — **do NOT port any of those.** Re-implement every money surface (review/diff/attestation/publish/states) against the **server** diff/token with `createElement`/`textContent`, no inline handlers/styles, **no demo-outcome selector**, and **never a client-derived ack**. Design system: `xpizza-portal/DESIGN.md` (Bold Editorial).
- **Strip every non-price mutator** (codex #5): the mock has item-name editing (contenteditable), add/delete item, option-name edits — all write pricing KEYS → **out of scope (2b-2c, key-strategy prereq)**. Disable/remove them; a wiring test asserts none is active. Only price fields (item + existing option) are editable.
- **Money surface:** the review/diff/attestation renders server strings via `createElement`/`textContent` — NEVER `innerHTML`. Strict CSP — no inline `style=`, no `unsafe-inline`.
- **The ack echoes the EXACT `{key,surface}` set** the server returned — verbatim objects, never a count/boolean/re-derived list (`ackMatches` sentinel-collapses anything else).
- **Brand-agnostic:** no `rid==='x_pizza'` literal; the fiscal seal gates on `usesPlatformFactura`/the capability flag from the catalog.
- **Bearer token in the header, never the URL.** Preserve the typed `Unavailable`(503/network) vs `NotAuthorized`(403) distinction (already in `api.js`).
- **No-regression:** the live 2b-2a read-only paths (login, switcher, tenant isolation, render) stay green after the re-skin.
- **Test cmd:** `cd xpizza-portal && npm test` (node `--test` `.mjs`). Browser smoke via impeccable finish-review.

---

## File Structure
- Modify `xpizza-portal/styles.css` — Bold-Editorial skin (tokens, display type, components) from the mock; light default + dark variant.
- Modify `xpizza-portal/api.js` — add `editCatalog`, `publishEdited`.
- Create `xpizza-portal/editor.js` — edit state (dirty/draft), row + drawer price editing, the inline option-editor.
- Create `xpizza-portal/review.js` — review + SAR attestation + receipt + the 6 states (textContent-only).
- Modify `xpizza-portal/render.js` / `app.js` / `boot.js` — wire edit affordances + the review bar + the drawer.
- Modify/extend `xpizza-portal/*.test.mjs` + `portal-wiring.test.mjs`.

---

## Task 1: Bold-Editorial re-skin (read-only portal, no behavior change)
**Files:** Modify `xpizza-portal/styles.css`, `index.html` (structure parity w/ mock), `boot.js`; Test: `render.test.mjs`, `portal-wiring.test.mjs`.
**Interfaces — Produces:** the Bold-Editorial token set + component classes matching the mock (`.railitem`, `.detail`, `.row`, `.tab`, `.price`, `.tog`, `.rbar`, `.drawer`, etc.), light default + `[data-theme="dark"]`.

- [ ] **Step 1: Failing test** — extend `portal-wiring.test.mjs` to assert `styles.css` defines the Bold-Editorial tokens (`--ink:#0A0A0B`, `--green:#0E9F5B`, `--disp`) and NO leftover sapphire (`#5B8DEF`/`#2D5FD0`), and no inline `style=` in `index.html`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — port the mock's `<style>` into `styles.css` verbatim (tokens, display type, all components, the mobile top-bar, browser-surface theming, reduced-motion), light default + dark variant. Extract any inline styles. Keep the existing read-only DOM structure; only re-skin.
- [ ] **Step 4: Run → PASS**; visually confirm the live read-only portal now renders Bold-Editorial (both themes) with menu/switcher/tenant-isolation unchanged.
- [ ] **Step 5: Commit** — `feat(portal): bold-editorial re-skin (read-only, no behavior change)`

---

## Task 2: API client — editCatalog + publishEdited
**Files:** Modify `xpizza-portal/api.js`; Test: `api.test.mjs`.
**Interfaces — Produces:** `editCatalog({rid, source}) → {diff, token, updateTime}`; `publishEdited({rid, token, acknowledgedChanges, fiscalAck}) → {versionId}`; both throw typed `ApiError` (`Unavailable` vs `NotAuthorized`) and surface the server `error` code (`stale_edit`/`edit_superseded`/`large_change_unconfirmed`/`not_owner`/`fiscal_ack_required`/`store_unavailable`).

- [ ] **Step 1: Failing test** — `editCatalog`/`publishEdited` POST with bearer in HEADER (not URL), rid `encodeURIComponent`'d, non-2xx → typed `ApiError` carrying `.code` (the server `error`), 503/network → `Unavailable`, 403 → `NotAuthorized`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add both calls mirroring the existing `apiFetch` pattern; map the response `error` codes to `.code`; never treat non-2xx as success.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(portal): editCatalog + publishEdited api client (typed errors)`

---

## Task 2b: Backend — expose the fiscal capability flag on getEditableCatalog (codex #3)
**Files:** Modify `xpizza-functions/catalog/portal-reads.js` (getEditableCatalog response), `xpizza-functions/index.js` (wire if needed); Test: `xpizza-functions/catalog/portal-reads.test.js`.
**Interfaces — Produces:** `getEditableCatalog` returns `usesPlatformFactura: boolean` (from the server-side `usesPlatformFactura(rid)` Set-flag in `factura/eligibility.js`) alongside `{source, sourceUpdateTime, activeVersionId}`. The ONLY functions change in this slice — additive, read-only.

- [ ] **Step 1: Failing test** — `getEditableCatalog` for x_pizza returns `usesPlatformFactura:true`; for la_musa (and a hypothetical config-only merchant) `false`. No behavior change to the existing fields; owner-only auth unchanged.
- [ ] **Step 2: Run → FAIL** (`cd xpizza-functions && node catalog/portal-reads.test.js`).
- [ ] **Step 3: Implement** — add `usesPlatformFactura: usesPlatformFactura(rid)` to the response object (import from `factura/eligibility.js`). Purely additive; do not touch auth/validation/source read.
- [ ] **Step 4: Run → PASS**; full `cd xpizza-functions && npm test` EXIT 0 (no regression to the portal-read/auth suites).
- [ ] **Step 5: Commit** — `feat(catalog): expose usesPlatformFactura on getEditableCatalog (brand-agnostic fiscal signal)`

> This task ships with the slice and requires a **functions redeploy** at deploy time (getEditableCatalog is live). Codex-gate it (light — additive read field, but it's a live portal-read endpoint).

---

## Task 3: Edit state + price editing (item row + drawer), dirty tracking, review bar
**Files:** Create `xpizza-portal/editor.js`; Modify `render.js`, `app.js`; Test: `editor.test.mjs`, `portal-wiring.test.mjs`.
**Interfaces — Consumes:** the loaded catalog. **Produces:** a client draft (`STATE`) diffed against the loaded original (`ORIG`); `pendingCount()`; the review bar shows when dirty; the drawer opens with an editable price. Editing changes `price` AND `display.price` together (validateSource contract).

- [ ] **Step 1: Failing test** — editing an item/extra price updates the draft, `pendingCount()` reflects it, a zero/nonpositive price marks the row "Sin precio" and is not publishable; `price===display.price` always.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — port the mock's editor state + row/drawer price inputs + dirty/review-bar logic into `editor.js`, wired to the loaded catalog. **Deferred (2b-2c):** add/remove/rename item, add/remove option, category edits — render those affordances disabled/omitted (they write keys → key-strategy prereq). "86" omitted (2b-2d).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(portal): price editing (row + drawer) with dirty tracking`

---

## Task 4: Inline option-editor (edit existing option prices; shared-group note; scroll-preserve)
**Files:** Modify `xpizza-portal/editor.js`; Test: `editor.test.mjs`.
**Interfaces — Produces:** expandable group in the drawer → each existing option's price editable; a "grupo compartido — en N productos" note; editing an option price mutates the shared group (propagates) and feeds the draft/diff (surface `extra`). Drawer re-render preserves `.dwb` scrollTop.

- [ ] **Step 1: Failing test** — editing an option price updates the shared group + the draft (surface `extra`); `groupUsage(gid)` counts products using the group; re-render preserves scroll position. **Add-option/remove-option are DEFERRED (2b-2c, key-writing).**
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — port the mock's `drawerGroup` + `dwOptPrice` + scroll-preserve; disable add/remove-option (2b-2c).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(portal): inline option price editing with shared-group note`

---

## Task 5: Review flow — editCatalog → diff render (textContent-only, exact-set model)
**Files:** Create `xpizza-portal/review.js`; Modify `editor.js`; Test: `review.test.mjs`.
**Interfaces — Consumes:** `editCatalog` `{diff, token}`. **Produces:** the review model — per-price `was→now` + delta chip (amber for >50%/big, else up/down), the `largeChangeSet` captured **verbatim** as the ack set; built with `createElement`/`textContent`.

- [ ] **Step 1: Failing test** — from a real `editCatalog` diff fixture (originate from the server diff shape, NOT hand-built): the review renders one row per changed price with `was→now` tabular; a >50% swing carries the amber `.big` flag; the ack set equals the server `largeChangeSet` `{key,surface}` objects verbatim (deep-equal, both directions). Assert the review DOM has **no `innerHTML`**.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — port the mock's `diffModel`→`openReview` render (but consume the SERVER diff, not a client re-derive) into `review.js`, textContent-only; capture `largeChangeSet` for replay.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(portal): review screen from server diff (exact-set, textContent-only)`

---

## Task 6: SAR attestation (X.Pizza-only, conditional) + the publish gate
**Files:** Modify `xpizza-portal/review.js`; Test: `review.test.mjs`.
**Interfaces — Produces:** the gold seal listing each fiscal price old→new + one "Autorizo" that satisfies the large-change ack AND the fiscal ack; publish disabled until acked (and never with a zero price). Shown iff `usesPlatformFactura(rid)` AND ≥1 fiscal price change; La Musa / no-price-change → a plain large-change confirm or none.

- [ ] **Step 1: Failing test** — X.Pizza + a price change → the seal renders, lists the exact set, publish disabled until "Autorizo"; La Musa → no seal (a plain ack iff big changes); a no-price-change review → no seal; zero price → publish stays disabled. Gate on the capability flag, NOT `rid`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — port the mock's seal + attestation VISUALLY, gated on `usesPlatformFactura` from the `getEditableCatalog` response (Task 2b) — **NOT the mock's hard-coded `BRAND.fiscal`**, and NOT `rid`. The seal lists **every fiscal price change from the server `diff.changed`** (surface item|extra, field price) old→new — **NOT `largeChangeSet`** (which holds only >50%/new/zero and is EMPTY for a modest fiscal change; codex NEW-HIGH). The "Autorizo" checkbox sends `fiscalAck:true`; `acknowledgedChanges` is *separately* the raw `largeChangeSet` verbatim (may be `[]`).
  - **Add a test:** a modest X.Pizza price change (e.g. 299→310, `largeChangeSet` empty) STILL renders the seal old→new and, on Autorizo, publishes with `fiscalAck:true` AND `acknowledgedChanges: []`. A >50% change renders in both the seal (from `diff.changed`) and carries a non-empty `acknowledgedChanges`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(portal): unified per-price SAR attestation (server fiscal flag, brand-agnostic)`

---

## Task 7: publishEdited + publish states (receipt + the 6 conflict/error states) — HARDEST GATE
**Files:** Modify `xpizza-portal/review.js`, `editor.js`; Test: `review.test.mjs`, `portal-wiring.test.mjs`.
**Interfaces — Consumes:** `publishEdited`. **Produces:** in-flight → success receipt (new version + Historial/rollback route) | one of the 6 first-class state panels keyed by the server `error` code. The publish call sends the exact `acknowledgedChanges` set + `fiscalAck`.

- [ ] **Step 1: Failing test** — publish sends the ack set **verbatim from the server `diff.largeChangeSet`** (not rebuilt from rows) + `fiscalAck`; each of the SIX primary `error` codes maps to its OWN designed panel (`stale_edit`, `edit_superseded`, `large_change_unconfirmed`, `not_owner` [a designed "solo el propietario puede publicar un cambio fiscal" screen — NOT a generic fallback], `fiscal_ack_required`, `store_unavailable`); AND **every OTHER server `error`** (`bad_source`/`bad_request`/`invalid_source`/`source_missing`/`live_version_unavailable`/`draft_build_failed`/`publish_failed`/auth errors) maps to a **generic DURABLE error panel** (retry/reload) — assert NO server error yields an unhandled toast (codex #1); success renders the durable receipt with the version id; **the `edit_superseded` recovery re-calls `editCatalog`** for a FRESH diff+token and re-renders the review — it MUST NOT retry `publishEdited` with the stale token (codex #6). `portal-wiring` asserts every state handler + the publish button are wired (no display-only control — the 2b-2a switcher lesson).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — re-implement the publish state machine against the real `publishEdited` response (NOT the mock's demo-outcome selector): map the six primary codes to their panels, a **default branch** routes any other/unmapped server error to the generic durable panel, `edit_superseded`→re-call `editCatalog`; receipt + rollback-into-Historial on success; commit `STATE→ORIG`.
- [ ] **Step 4: Run → PASS**; `cd xpizza-portal && npm test` EXIT 0.
- [ ] **Step 5: Commit** — `feat(portal): publish states — durable receipt + 6 first-class conflict/error screens`

---

## Task 8: Wiring guard + browser smoke + no-regression + finish-review
**Files:** Modify `xpizza-portal/portal-wiring.test.mjs`; then the browser pass.
- [ ] **Step 1: Extend `portal-wiring.test.mjs`** — every interactive element has a wired handler; every called fn defined/imported; every module reachable from `index.html`; **no `innerHTML` on the review/diff/attestation**; no inline `style=`; **no inline `onclick`**. PLUS (this slice's guards): **no non-price mutator is wired** (no rename/contenteditable-title/add-item/delete-item/add-option/remove-option/option-name handler active — codex #5); **no demo-outcome selector present** (`#demoOut` must not ship — codex #7); **every server `error` code maps to a panel** (assert the state-router has no unhandled-toast fallthrough — codex #1). (The recurring integration-gap class — pure tests miss DOM wiring + shipped demo scaffolding.)
- [ ] **Step 2: Browser smoke (impeccable finish-review + real browser):** the full edit→review→attest→publish→receipt path; the 6 states; option-editor scroll-preserve; both themes; mobile no-overflow; the read-only paths unchanged.
- [ ] **Step 3: `cd xpizza-portal && npm test` EXIT 0**; no-regression on 2b-2a read paths.
- [ ] **Step 4: Commit** — `test(portal): wiring guard + smoke for the price-editing write path`

---

## Self-Review
- **Spec coverage:** re-skin → T1; API → T2; price edit (row/drawer) → T3; option prices → T4; review/exact-set → T5; attestation → T6; publish states → T7; wiring/smoke → T8. All spec sections mapped.
- **Placeholder scan:** none — each task cites the mock as the concrete UI source + concrete test assertions.
- **Type consistency:** `editCatalog→{diff,token}` (T2) consumed by T5; `largeChangeSet` `{key,surface}` set threads T5→T6→T7 verbatim; `publishEdited(token, acknowledgedChanges, fiscalAck)` (T2) called in T7.
- **Money-safety:** exact-set ack (T5/T7), token binding + the 6 states (T7), owner-bound fiscal (T6, server-enforced), zero-guard (T3/T6), textContent-only (T5). HARDEST codex money-gate on T7 (+ T6). Key-writing ops deferred to 2b-2c behind key-strategy.

## Execution Handoff
Built by the executor session task-by-task; advisor source-audit + codex **money-gate** each task (heaviest on T6/T7); impeccable finish-review for mock fidelity; then owner deploys BOTH: the Task-2b functions redeploy (`getEditableCatalog` + `usesPlatformFactura`) AND the frontend to `sherpa-portal.netlify.app` (the rest of the backend — editCatalog/publishEdited — is already live). Relay after the codex design-gate on this plan folds.
