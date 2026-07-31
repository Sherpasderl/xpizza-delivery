# HANDOFF → AUDITOR: dispatch Part-B — final codex-on-diff gate

**Written:** 2026-07-31 (executor session). **Action for the auditor session:** run a codex-on-diff over the un-gated tail of the dispatch redesign, report findings, executor fixes, then owner merges → deploys → version-bumps. **The gate has NOT been run on this range yet** — that is this session's job.

---

## Where / what

- **Worktree:** `/Users/xavierlacayo/Downloads/xpizza-dispatch-redesign` — branch **`docs/dispatch-redesign-spec`** (pushed to origin).
- **Local preview:** `http://localhost:8777` (worktree `xpizza-dispatch/`). Mockup reference served at `http://localhost:8778/dispatch-board-v6.html`.
- **HEAD:** `ffb52bb`. **Build state:** `node --test xpizza-dispatch/dispatch-*.test.js` = 5/5 pass; index.html div-balanced; `node --check` on the extracted module clean; server 200.
- This is a **client dashboard** (`xpizza-dispatch/index.html` + pure `dispatch-*.js` modules). **NO `functions/` / money-server code** in scope. Everything is client-render.

## Already gated (context — do NOT re-litigate unless the tail changed it)

- **codex-on-diff `1845bf6→693c273`** (Part-B batch T13-refine + T14–19): 4 BLOCKING XSS-escaping guards + 1 a11y nit → fixed in **`fc67b79`**. Money path (T18 Cancel) verdict = APPROVED (new UI entry point reusing vetted `XPD.cancelOrderRemote`; no money-logic change).
- **Independent T18 money-gate** = APPROVE-WITH-CHANGES → both findings closed in this tail (see `67582dc`, `3a1fb36` below).

## GATE THIS RANGE: `fc67b79..ffb52bb` (4 commits, 3 files)

Run FROM the worktree, read-only, stdin nulled:
```
cd /Users/xavierlacayo/Downloads/xpizza-dispatch-redesign
PROMPT="$(cat <prompt-file>)"; ~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null
```
Suggested review command inside the prompt: `git diff fc67b79 ffb52bb -- xpizza-dispatch/`

### Commit-by-commit — what changed + what to scrutinize

**`67582dc` — money-gate ① cash-label normalize.** Added `isCashPayment(pm)` = `String(pm||'').trim().toLowerCase()` ∈ {cash, efectivo}, mirroring `xpizza-driver/cash-helpers.js`. Used at BOTH display sites (Comms subtitle + order-row payChip). VERIFY: display-only (no settlement/cuadre/write path); predicate shape matches the isCashPayment invariant; both call sites converted (no stray non-normalized `=== 'cash'` left).

**`3a1fb36` — money-gate ② picked_up cancelability (owner decision: YES cancelable).** Removed `picked_up` from the modal `cancellable` guard → Cancel now SHOWS for out-for-delivery orders; server already supports in-progress cancel (voids charge + recalls driver), so client + server now AGREE. VERIFY: guard is `!['cancelled','delivered','completed'].includes(order.status)`; this is the intended reconciliation (client was hiding what server allows), NOT a new money path; `getPickupQueue` still excludes `picked_up` as a DONE pickup (separate, correct).

**`28a2492` — preview polish (on-device pass). TOUCHES A TESTED MODULE + BASE `.ord`.**
- `dispatch-aging.js`: `formatAging` now caps — `<1h`→`M:SS`, `<24h`→`Nh`, else `Nd` (was unbounded `M:SS` → a 20-day test order rendered `29280:22` overflowing the row). Test updated (`dispatch-aging.test.js`: +`1h`/`2h`/`1d`/`20d` cases). Import bumped `?v=1`→`?v=2`. VERIFY: the cap logic + tests; no other consumer of `formatAging` breaks (it's the live-tick `[data-aging]` updater + order rows).
- `index.html`: card shape (padding/radius/inset) promoted from `.ord.unassigned-card` → **base `.ord`** (En Fila queue used bare `.ord` → the `#` clipped under the left band + rows overflowed). `.cust` now `flex:1`+ellipsis; `.num`/`.ord-age` `flex:none`; `.rtab-pane` got horizontal padding. Drivers now default **collapsed** (removed the auto-expand-all init + the now-dead `expandedDriversInitialized` flag) → no more "Sin pedidos asignados" under every driver. VERIFY: base `.ord` change doesn't regress the unassigned cards (they carry both `ord` + `unassigned-card`); no dropped behavior; collapse default doesn't strand the inline `.dt` summary for drivers WITH orders.

**`ffb52bb` — Comms tab shows recent conversations.** `renderCommsTab` was unhandled-only → empty once chats were handled, making the Task-12 thread unreachable. Now lists recent conversations (last 24h, deduped to latest inbound per `phoneTail`), unhandled flagged `Sin atender` + sorted first; tap → `openCommsThread`. `tab-comms-n` still = unhandled count. Added `.comms-flag` CSS. VERIFY: `escapeHtml` on `m.from`/body (data-comms-from + preview); dedup/sort correctness; no write; the 24h `received_at` cutoff handling for messages missing `received_at` (treated as 0 → excluded — intended).

## Guardrails to assert (same as prior passes)
Zero-write (no new RTDB/Firestore writes; T18 cancel is the only money-adjacent action and is a pre-approved reuse); `escapeHtml` on ALL dynamic content; no dropped handler/binding; div-balanced; no dead CSS/vars; a11y on icon-only buttons. **No new money path in this tail** — ① and ② are display-normalize + a guard-relax reconciling client to the already-vetted server.

## After the gate
Executor fixes any findings → owner: **version bump `v1.5.8·dispatch`** (topbar `data-version-display`) → **merge `docs/dispatch-redesign-spec` → `main`** (⚠ `git fetch` + confirm `origin/main` current first — stale checkout regresses live) → **deploy** (git-CD) = **Phase 1 DONE**. Full task ledger: `docs/superpowers/plans/2026-07-28-dispatch-phase1.md` Session revision R8. On-device: whole board reviewed live incl. Task-12 thread (Javi Prueba ↔ order #2) + En Fila queue + Cancel/Message/Call modal.
