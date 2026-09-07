# HANDOFF → Executor — Portal 2b-2a (merchant portal: shell + auth + READ-ONLY menu load)

**You are the executor session. Start here.** This is the entry point; it tells you what to build and exactly where to look. Build LOCAL-ONLY — do NOT push or deploy (the owner does that).

---

## What you're building

The FIRST slice of the merchant portal: a new static site `xpizza-portal/` where a merchant **owner** logs in (Firebase Auth), the portal resolves which restaurants they own, loads their live catalog via three new **read-only** Cloud Functions, and renders it in a master-detail layout. **This slice writes NOTHING to the catalog** — the editor, publish, and instant-86 are later slices (2b-2b/c/d). A safe, deployable first milestone.

## Read these, in this order

1. **`RELAY-portal-2b2a-shell-auth-read.md`** ← read FIRST. Scope + the 9 non-negotiable invariants (the codex-grill's fixes — build them as written).
2. **`docs/superpowers/plans/2026-09-07-portal-2b2a-shell-auth-read.md`** ← the 7 TDD tasks with exact code, tests, and commands. Build these, in order.
3. **`docs/superpowers/specs/2026-09-07-portal-2b2-menu-editor-design.md`** ← the why: the brand-agnostic HARD constraint (§1a), money-safety (§5), the backend contract you're building against (§2), and how this slice fits the 4-slice decomposition (§7).
4. **`docs/superpowers/assets/2026-09-07-portal-editor-mock.html`** ← UX reference for the read-only render (Tasks 4 & 6). Lift the shell markup + styles (sober palette, day/night, Hanken); strip ALL edit handlers and the inline seed data — data comes from `getEditableCatalog`.

## Base

Branch off **`origin/main` @ `7c67656`** (already pushed; contains all the docs above). Suggested branch: `feat/portal-2b2a-shell-auth-read`. `git fetch` + confirm the head before you start.

## The hard rules (full detail + evidence in the relay)

- **Read-only slice.** Writes NOTHING to the catalog. The only new writes are the owner→restaurants reverse index, via the admin `seed-owner` tool.
- **`getEditableCatalog` is OWNER-ONLY** — reuse `authorizeCatalogEdit`, then reject `auth.role !== 'owner'` (dispatchers get any rid; a merchant read must not). Read the REAL source doc via **`sourceRefOf`** (`restaurants/{rid}/meta/source`), run **`validateSource` → fail-CLOSED 503** on malformed. Wire `authorize` with **`getDatabase()`** (owners live in RTDB); read the source with `getFirestore()`.
- **BRAND-AGNOSTIC (hard):** no `x_pizza`/`la_musa` literal in new code unless it's a config/capability-flag lookup. Tests use `merch_a`/`merch_b`/`any_merchant_3`. Task 7 smoke proves a third config-only merchant renders identically.
- **Restaurant name** is at `restaurants/{rid}/identity` (`identity.name`), NOT `config/display`.
- **Do NOT touch** the key-strategy hardcoding (`rid === 'la_musa' ? id : name`) — out of scope for this read-only slice (it's a prerequisite for the *write* slices, tracked separately).
- **TDD**, and keep the existing 2a / 2b-1 / catalog / fiscal / rewards suites green. Test command (from `xpizza-functions/`): `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test`

## Workflow

Build **task-by-task**. After EACH task, **hand back** (commit + summary) for advisor source-audit + codex gate before continuing — do not run ahead. If the current source contradicts the plan (as the grill found on the source-ref path / auth tier / identity path), **STOP and flag it** — don't force the plan.

## Done (this slice)

An owner logs into `xpizza-portal/`, sees exactly the restaurants they own in the switcher, and views their live menu read-only (correct prices/categories/extras). Unauthenticated → login gate; customer/non-owner → rejected. A second config-only merchant renders identically. New Netlify site creation + deploy are the owner's actions (hand back the exact commands, do not run).
