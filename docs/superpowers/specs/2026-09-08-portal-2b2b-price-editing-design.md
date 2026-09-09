# Portal 2b-2b — Price Editing + Bold-Editorial Re-skin — Design

**Status:** Design APPROVED (mockup signed off by owner 2026-09-08). Governance: executor session builds LOCAL-ONLY task-by-task; advisor source-audits each task; codex **money-gates** the build (this writes to the live catalog / SAR factura); owner deploys. Advisor + codex + impeccable finish-review gate before merge.

**Goal:** Ship the merchant portal's first WRITE capability — editing item and extra **prices** end-to-end (edit → review → SAR-attest → publish → verify-before-flip → live, with one-click rollback) — and re-skin the whole portal to the approved **Bold-Editorial** identity. This is a **frontend slice plus one small additive backend field** — a fiscal-capability flag (`usesPlatformFactura`) on the `getEditableCatalog` response (see Contract #5) — over the already-deployed `editCatalog` / `publishEdited` backend (2b-1, live since 2026-09-07). The backend field is the only functions change; it is additive and read-only, and gets its own codex gate.

**Authoritative VISUAL + interaction target:** `docs/superpowers/assets/2026-09-07-portal-editor-mock.html` (the approved bold-editorial mock). The build matches it **exactly** in look and interaction. ⚠️ **But the mock is a mock** — for the money surfaces it uses `innerHTML`, inline `onclick`/`style`, a CLIENT-side diff, a hard-coded `BRAND.fiscal`, and a demo publish-outcome selector (codex #7). Those are **NOT ported**: the implementation consumes the **server** diff/token, renders with `createElement`/`textContent`, uses no inline handlers/styles, gates fiscal on the server capability flag, has **no demo-outcome selector**, and **never client-derives the ack**. The mock is the pixel/interaction reference; the money plumbing is re-implemented against the server. Design system: `xpizza-portal/DESIGN.md` (Bold Editorial).

**⚠️ Strip every non-price mutator (codex #5):** the mock includes item-name editing (contenteditable titles), add/delete item, and option-name edits — all of which write pricing KEYS and are **out of scope** (2b-2c, key-strategy prereq). The implementation **disables/removes every non-price mutator**, and a wiring test asserts none is active (no rename/add/delete handler wired). Only price fields (item + existing option) are editable in 2b-2b.

---

## Scope

### In scope (2b-2b)
1. **Edit the price of existing items and existing options (extras/modifiers).** Item price on the row + in the drawer; option price inline in the drawer's expandable group editor. Prices are positive-integer Lempiras; `price` must equal `display.price` (validateSource contract).
2. **The edit → review → publish flow**, wired to the deployed cloud functions:
   - `editCatalog` — validate → CAS draft write (Firestore `updateTime` precondition) → server rename-aware diff → HMAC edit-token.
   - `publishEdited` — token re-match → `largeChangeSet` acknowledgement (exact `{key,surface}` set) → **X.Pizza owner-bound fiscal ack** → `publishVersion` verify-before-flip → live.
3. **The inline option-editor** in the item drawer: expand a group → edit each existing option's **price**, with the shared-group "en N productos" note (edits propagate to every product using the group and flow into the same review/attestation).
4. **The six PRIMARY money states**, each a first-class screen (not a toast): `stale_edit` (409), `edit_superseded` (409), `large_change_unconfirmed` (400), `not_owner` (403 — a **designed** "solo el propietario puede publicar un cambio fiscal" screen; it is reachable via the API / a wiring bug even though `getEditableCatalog` is owner-only, so it is NOT assumed-unreachable), `fiscal_ack_required` (403), `store_unavailable` (503, retryable). **PLUS a generic durable error panel** (retry/reload guidance) for every OTHER server `error` the two handlers can return — `bad_source`, `bad_request`, `invalid_source`, `source_missing`, `live_version_unavailable`, `draft_build_failed`, `publish_failed`, and the auth errors (`missing_bearer_token`, `invalid_credentials`, `not_authorized`, `authorization_unavailable`). **Every server `error` code maps to a designed panel; none is an unhandled toast.** (codex design-gate finding #1/#2.)
5. **Unified per-price SAR attestation** — X.Pizza only, conditional on ANY fiscal price change. ⚠️ (codex NEW-HIGH) the gold seal lists **every fiscal price change** — sourced from the server `diff.changed` price entries (`surface: item|extra`, `field: 'price'`), old→new — **including a modest change where `largeChangeSet` is empty** (a small X.Pizza price edit still requires fiscal ack). One "Autorizo" checkbox serves as both the fiscal ack and the large-change ack. **Two distinct payloads:** `fiscalAck` (boolean) AND `acknowledgedChanges` = the raw `largeChangeSet` **verbatim, possibly `[]`** (the >50%/new/zero subset — the seal's *displayed* rows are the superset from `diff.changed`, the *ack set* is `largeChangeSet`). Never shown for La Musa or when there is no fiscal price change.
6. **Durable success receipt** (new version id + route into Historial/rollback) — not a disappearing toast.
7. **Re-skin the entire live portal to Bold-Editorial** (light default + dark variant) per the mock + DESIGN.md — the currently-live read-only 2b-2a portal is still the old sober skin; this slice replaces it.

### Out of scope (explicitly deferred, named)
- **Add / remove / rename items, add / remove options, category-structure editing** — these CREATE or drop pricing **keys**. Key derivation is still `rid==='la_musa'?id:name`; the **key-strategy→config** generalization (gated-complete, not yet deployed) is the HARD prerequisite. → **2b-2c**, after key-strategy deploys. The mock shows these affordances; in 2b-2b they are **not built** (rendered disabled or omitted per the plan), realized in 2b-2c.
- **Instant "86" / availability** — a separate instant RTDB channel (`restaurants/{rid}/item_availability`), not a catalog publish. → **2b-2d**.
- **Image upload** — no backend (`has_photo` bool only). Drawer upload stays "próximamente".
- **`horario`** — no profile write path exists (none of the 4 portal endpoints writes the profile). Its own slice with its own gating.

**Why price-only is the right first write slice** (executor, source-verified): a price edit is the ONLY menu operation that drives the *entire* pipeline — `priceSanity` fires on nonpositive / newly-priced / >50%-swing, so a price edit exercises diff → `largeChangeSet` → exact-set ack → token re-match → fiscal gate → publish → flip. Maximum pipeline coverage per unit of UI, and it writes no keys.

---

## Architecture

Static vanilla-JS + ES modules + Firebase Auth via CDN, **no build step**, git-CD Netlify — the existing `xpizza-portal/` mold (`boot.js`, `app.js`, `api.js`, `render.js`, `portal-logic.js`, `auth.js`, `firebase.js`, `styles.css`, `netlify.toml`). 2b-2a is live read-only; 2b-2b adds the write path + re-skins.

**Data flow (the write path):**
```
load menu (getEditableCatalog, owner-only, validated)
  → edit a price (item row / drawer / option) → dirty state, live pending-count
  → "Revisar y publicar"
      → editCatalog(draft)  →  { diff, token }        (validate + CAS + server diff)
      → render the review: per-price was→now + delta, amber >50% flag,
        the SAR seal (X.Pizza) listing every fiscal price change (from diff.changed)
      → "Autorizar y publicar" (checkbox gates)  →  publishEdited(token, acknowledgedChanges, fiscalAck)
          → success receipt (new version) | one of the 6 states
```

**The client owns nothing security-critical.** editCatalog/publishEdited re-validate ownership, re-derive the diff, re-match the token, and re-check the fiscal owner binding server-side. The UI is a faithful presenter of server truth.

**New/changed files (frontend + ONE additive backend field — `usesPlatformFactura` on `getEditableCatalog`, see Contract #5 / Task 2b; the rest of the backend is already deployed):**
- `xpizza-portal/styles.css` — replace the sober skin with Bold-Editorial (tokens, display type, components) mirroring the mock. Light default + dark variant.
- `xpizza-portal/editor.js` (new) — the edit state model (dirty tracking, the draft), the drawer + inline option-editor, the review model.
- `xpizza-portal/review.js` (new) — the review/attestation/receipt/conflict screens, built with `createElement`/`textContent` (money surface — never `innerHTML`), echoing the server's exact `{key,surface}` set.
- `xpizza-portal/api.js` — add `editCatalog` + `publishEdited` calls (bearer in header, typed `Unavailable` vs `NotAuthorized` errors already present).
- `xpizza-portal/render.js` / `app.js` — wire edit affordances into the read-only render; the drawer.
- Tests: `xpizza-portal/*.test.mjs` — unit + the **portal-wiring** integration test (every called fn defined/imported/reachable, no HTML sinks, no inline `style=`).

---

## The contract the UI MUST hold (source-verified, non-negotiable)

1. **The acknowledgement is an EXACT set.** `publishEdited`'s `ackMatches` requires equal membership both directions; each entry must be a real `{key:string, surface:string}` object or it collapses to a sentinel that can never match (boolean/count/subset/superset all fail). The client MUST **preserve the raw server objects** from `editCatalog`'s `diff.largeChangeSet` and send them back **verbatim** — derive display labels only in a *parallel* view model, **never rebuild the ack objects from rendered rows** (codex #4). Never a count, boolean, or re-derived list.
2. **The token binds to the exact diff.** If the draft or the live version moves between review and publish → `409 edit_superseded`. Reachable whenever two tabs / two people touch one menu — a normal state with its own re-review screen, not a generic error.
3. **`stale_edit` on the draft write** (`409` from editCatalog) — the draft changed since load; reload + re-apply.
4. **X.Pizza fiscal publish requires `role==='owner'` AND `fiscalAck===true`** — distinct errors `not_owner` vs `fiscal_ack_required`. Owner binding is server-side (`restaurants/{rid}/owners/{uid}`, deny-by-default). Write-auth admits dispatchers/kitchen staff (`catalog-edit-auth.js`), and `getEditableCatalog` is owner-only so the normal UI load blocks staff — but `not_owner` is still reachable via the API or a wiring bug, so it is a **first-class designed screen** ("solo el propietario puede publicar un cambio fiscal"), NOT a generic fallback. La Musa: no fiscal gate.
5. **Effective-mode / brand-agnostic:** the fiscal seal shows iff the merchant **uses the platform factura** AND there is a real fiscal price change — gated on a **server capability flag**, never a `rid==='x_pizza'` literal. ⚠️ `getEditableCatalog` today returns only `{source, sourceUpdateTime, activeVersionId}` — it does NOT expose fiscal capability (codex #3). So this slice **adds `usesPlatformFactura` (bool) to the `getEditableCatalog` response** (from the server-side `usesPlatformFactura(rid)` Set-flag — the canonical pattern) and the UI reads it. No client-side brand list. A config-only non-fiscal merchant returns `false` → no seal.
6. **A zero/nonpositive price cannot publish** — render "Sin precio", flag the row, disable publish (`priceSanity` would reject `nonpositive` server-side anyway; the UI fails fast).
7. **Money surface = `textContent` only.** The review/diff renders server strings via `createElement`/`textContent`, never `innerHTML`.

---

## Error handling — the six states

| Server | State | Recovery |
|---|---|---|
| 409 `stale_edit` | draft moved since load | reload + re-apply |
| 409 `edit_superseded` | reviewed against stale live version | re-review |
| 400 `large_change_unconfirmed` | >50%/new/zero not acknowledged | show the exact set, require the ack |
| 403 `not_owner` | non-owner publishing a fiscal change | **designed** "solo el propietario puede publicar un cambio fiscal" screen (reachable via API/wiring — not assumed-unreachable) |
| 403 `fiscal_ack_required` | owner didn't attest | the SAR seal ack |
| 503 `store_unavailable` | catalog service down (retryable) | retry; draft is safe, nothing changed live |

Each is a designed panel (icon + named problem + recovery action), matching the mock. Publish has real states: in-flight (spinner) → success receipt | conflict panel.

---

## Testing

- **Unit** (Node/`.test.mjs`): the review model builds the exact `{key,surface}` ack set from a server diff fixture (originate the fixture from the real diff shape, not hand-built); price validation (zero → blocked); the effective-mode fiscal-seal gate (X.Pizza+fiscal-change shows; La Musa / no-price-change hides); **a modest X.Pizza price change (empty `largeChangeSet`) still shows the seal + requires `fiscalAck`, and publishes with `acknowledgedChanges: []`**; every server `error` code maps to a designed panel (no unhandled toast).
- **Integration-gap guard** (the recurring lesson — pure-module tests pass while DOM wiring is broken): `portal-wiring.test.mjs` asserts every called function is defined/imported, every module reachable from `index.html`, **no `innerHTML` on the review/diff**, no inline `style=` (strict CSP). Include a handler for every interactive element the mock shows (the 2b-2a switcher shipped display-only because a pure test couldn't catch a missing DOM handler — every affordance must be wired).
- **Browser smoke** (impeccable finish-review + a real-browser pass): the full edit→review→attest→publish→receipt path, the 6 states (via the same demo affordance or forced), the inline option-editor scroll-preserve, both themes, mobile no-overflow.
- **No-regression:** the live 2b-2a read-only paths (login, switcher, tenant isolation, menu render) still pass after the re-skin.

---

## Deploy

Two deploy artifacts: (1) the **Task-2b functions redeploy** (`getEditableCatalog` + `usesPlatformFactura`) and (2) the **frontend** to the existing `sherpa-portal.netlify.app` (deploy with explicit `--site 06b6d13d-…`; repo default-links to catering). Prereqs already satisfied by 2b-1/2b-2a deploy (editCatalog/publishEdited live, `EDIT_TOKEN_SECRET` set, owner reverse-index seeded, PORTAL_ORIGINS + GCP referrer allowlist include the portal domain). **One functions redeploy IS required** — the additive `usesPlatformFactura` field on `getEditableCatalog` (Task 2b); no other backend change and no new origin. Owner deploys after the gates pass; smoke = first real edit→publish→rollback in prod.

---

## Self-review
- **Coverage:** price editing (item+option) → the flow; the 6 states; unified attestation; option-editor; re-skin; deferrals named with reasons. ✓
- **Consistency:** the exact-set ack, token binding, owner-bound fiscal, effective-mode, zero-guard, textContent-only all trace to source (`publish-edited-handler.js`, `catalog-edit.js`, `source-store.js`). ✓
- **Scope:** single implementable slice (frontend over deployed backend); key-writing ops deferred to 2b-2c behind the key-strategy prereq. ✓
- **Ambiguity:** "price editing" = existing items + existing options only; add/remove/rename explicitly out. ✓
