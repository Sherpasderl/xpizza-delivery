# RELAY (advisor → executor) — Portal 2b-2b: Price Editing + Bold-Editorial Re-skin

**Authoritative:** spec `docs/superpowers/specs/2026-09-08-portal-2b2b-price-editing-design.md` · plan `docs/superpowers/plans/2026-09-08-portal-2b2b-price-editing.md` · **exact UI target** (visual + interaction) `docs/superpowers/assets/2026-09-07-portal-editor-mock.html` · design system `xpizza-portal/DESIGN.md` (Bold Editorial). Build to them.

**Base:** branch off `origin/main` (confirm head with advisor; `git fetch` first). TDD, task-by-task, **LOCAL-ONLY**. Do NOT push/deploy.

**Design status:** codex design-money-gate **APPROVE** after 4 passes (7→3→2→0 findings folded). The invariants below ARE those folded findings — build them exactly.

**🔴 MONEY + FISCAL surface.** This writes catalog prices that serve the customer order forms and print on the SAR factura. A wrong ack, a forged fiscal attestation, or a mispriced publish is a live incident. Codex **money-gates every task** (heaviest on Task 6 attestation + Task 7 publish-states); Task 2b (backend field) gated too.

**What it is:** the portal's first WRITE — edit **prices** of existing items + existing options, end-to-end (edit → review → SAR-attest → publish → verify-before-flip → live, rollback), wired to the deployed `editCatalog`/`publishEdited`; PLUS re-skin the whole portal to Bold-Editorial. Frontend + ONE additive backend field.

**8 tasks (full detail in the plan):** 1 re-skin → 2 api client → **2b backend `usesPlatformFactura` on getEditableCatalog** → 3 price edit (row/drawer) → 4 inline option-price editor → 5 review-from-server-diff → 6 SAR attestation → 7 publish states → 8 wiring guard + smoke.

**Non-negotiable invariants (the gate's findings — build + test each):**
1. **Exact-set ack:** send `acknowledgedChanges` = the RAW `editCatalog` `diff.largeChangeSet` objects **verbatim** ({key,surface}); NEVER rebuild from rendered rows, never a count/boolean. `ackMatches` sentinel-collapses anything else. It may be `[]`.
2. **Seal ≠ ack-set (codex NEW-HIGH):** the fiscal SEAL lists **every fiscal price change** from server `diff.changed` (surface item|extra, field price) — a modest X.Pizza edit (299→310) has an EMPTY `largeChangeSet` but STILL shows the seal + requires `fiscalAck`. Publish then sends `fiscalAck:true` AND `acknowledgedChanges:[]`. Test this case.
3. **Brand-agnostic fiscal:** gate the seal on `usesPlatformFactura` from the getEditableCatalog response (Task 2b) — NEVER `rid==='x_pizza'`, never the mock's `BRAND.fiscal`.
4. **Every server error → a designed panel:** the 6 primary (`stale_edit`,`edit_superseded`,`large_change_unconfirmed`,`not_owner`,`fiscal_ack_required`,`store_unavailable`) each first-class; a generic durable panel (retry/reload) for ALL others (`bad_source`/`bad_request`/`invalid_source`/`source_missing`/`live_version_unavailable`/`draft_build_failed`/`publish_failed`/auth). No unhandled toast. **`not_owner` is a real designed screen** (reachable via API/wiring — write-auth admits dispatchers).
5. **edit_superseded recovery re-calls `editCatalog`** for a fresh diff+token; NEVER retry `publishEdited` with the stale token.
6. **Strip every non-price mutator** (name/contenteditable/add/delete/option-name — key-writing, 2b-2c); wiring test asserts none is active. Only price fields editable.
7. **Mock = VISUAL reference, not verbatim port for money surfaces:** re-implement review/diff/attestation/publish against the SERVER with `createElement`/`textContent`, no `innerHTML`, no inline `onclick`/`style`, **no demo-outcome selector** (`#demoOut` must not ship), no client-derived diff.
8. **Zero-price cannot publish** ("Sin precio", disabled). **price===display.price** kept synced. Bearer in header. Typed `Unavailable`/`NotAuthorized`.

**Gate (post-build, per task):** advisor source-audit + codex money-gate → owner deploys. Deploy = TWO artifacts: the Task-2b functions redeploy (getEditableCatalog) + the frontend to `sherpa-portal.netlify.app` (explicit `--site 06b6d13d-…`). editCatalog/publishEdited already live.

**Deferred (NOT this slice):** add/remove/rename item, add/remove option, category edits (key-writing → 2b-2c after key-strategy deploys); instant-86 (2b-2d); images; horario.

**Build TDD, LOCAL-ONLY. Hand back per task. Watch the recurring integration-gap class — pure-module tests pass while a DOM handler is unwired (the 2b-2a switcher shipped display-only); wire every affordance + assert it. Flag any current-source surprise rather than forcing the plan.**
