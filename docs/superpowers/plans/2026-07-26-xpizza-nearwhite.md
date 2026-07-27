# X. Pizza Near-White Ground + Enhanced Photos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** X. Pizza form → near-white `#FCFCFB` ground + enhanced photos; La Musa stays cream **byte-identical**. Spec: `docs/superpowers/specs/2026-07-26-xpizza-nearwhite-design.md` (codex design-gate APPROVED R2). Pure color-token + image-asset change; no logic/money-path.

**Branch:** `feat/xpizza-nearwhite` (off live `main` `4b64e80`). This batch DOES edit `xpizza-orders/index.html` (in-scope — the ground tokens live there). `la-musa-orders/index.html` UNTOUCHED. `account.js` neutrals become CONFIG-driven; code past CONFIG stays identical between forms.

---

## Task 1: COMPLETE warm-literal inventory + classification (do FIRST — codex #1/#3)
**Files:** none yet (produce an inventory doc `docs/superpowers/nearwhite-inventory.md`).
- [ ] **Step 1:** Grep `la-musa-orders/account.js` AND `xpizza-orders/index.html` for EVERY warm-neutral hex (`#F…`, `#E…`, `#D…`, warm greys). For each occurrence, record: value, where used (selector/purpose), and classification: **SWAP** / **KEEP-EXACT** / **TEXT**. Seed from the spec table; MUST include the codex-found ones: `#CFC2B1`, `#D8CBB8`, `#E7DFD3`, `#EFE7DA`, `#E4DAC7` (SWAP), `#5b4f41`/`#4A4038` (TEXT), `#F3E7CC` (KEEP-EXACT — dual-use gold tint). No warm neutral left unclassified.
- [ ] **Step 2:** For each SWAP token, decide the X. Pizza near-white value (cool near-white equivalent, small neutral drift — not blue). La Musa value = the exact current literal.
- [ ] **Step 3:** Commit the inventory doc — `docs(nearwhite): complete warm-literal inventory + SWAP/KEEP/TEXT classification`. (This is the auditable control the gate requires before touching the shared file.)

## Task 2: X. Pizza index.html ground re-tune
**Files:** `xpizza-orders/index.html`.
- [ ] **Step 1:** In `:root`, change the warm neutrals to near-white/cool (keep `--charcoal`, `--gold`): `--cream #FBF7F2→#FCFCFB`, `--surface #F5EFE6→#F5F5F3`, `--border #E8E0D5→#E6E6E2`, `--border2 #D4C8BA→#D6D6D0` (final values per Task 1 tuning). Plus any other warm literal used directly in index.html CSS (from the Task 1 inventory) → its X. Pizza value.
- [ ] **Step 2:** Verify `la-musa-orders/index.html` is untouched (`git diff --stat 4b64e80..HEAD -- 'la-musa-orders/index.html'` empty).
- [ ] **Step 3: Commit** — `feat(nearwhite): X.Pizza index.html ground → near-white #FCFCFB`

## Task 3: Core-card default elevation (near-white separation — codex #4)
**Files:** `xpizza-orders/index.html`.
- [ ] **Step 1:** Give `.pizza-card`, `.order-review`, `.section`, `.loc-card`, `.pay-card`, `.pixelpay-box` a subtle default shadow (e.g. `box-shadow:0 1px 2px rgba(30,28,24,.04), 0 6px 16px -12px rgba(30,28,24,.18)`) + keep their border. Tune to "clearly a card, not heavy." (La Musa index.html untouched, so this is X. Pizza-only.)
- [ ] **Step 2: Mobile visual QA** — render X. Pizza at 360/390/414px (agent-browser); confirm every card surface reads as distinct on `#FCFCFB`. Screenshot.
- [ ] **Step 3: Commit** — `feat(nearwhite): X.Pizza core-card elevation for near-white separation`

## Task 4: account.js CONFIG.palette (per-brand neutrals; La Musa byte-identical)
**Files:** `la-musa-orders/account.js` + `xpizza-orders/account.js` (CONFIG block differs; code past it identical).
- [ ] **Step 1:** Add `palette` to each form's CONFIG block. **La Musa `palette` = the exact current literal for every SWAP token** (so it renders unchanged). **X. Pizza `palette` = the near-white values** (Task 1). KEEP-EXACT tokens identical in both.
- [ ] **Step 2:** In the shared injected-style template strings, replace each classified SWAP/KEEP literal with `${CONFIG.palette.X}`. Leave TEXT/ink + `${CONFIG.accent}`. Do the cards-that-render-into-the-form FIRST (`.acct-compact`/`.acct-deliver`/`.acct-cp-card`/`.acct-verified-ro`), then the full sheet.
- [ ] **Step 3: Prove La Musa byte-identical** (codex #2, all three): (a) `diff` account.js CODE past the CONFIG block between forms → empty; (b) grep the injected styles for any warm-neutral hex NOT a `CONFIG.palette.` ref / classified KEEP / TEXT → zero; (c) render La Musa (agent-browser), snapshot computed bg/border of the account chip + an in-form card + the sheet → equal the pre-change values.
- [ ] **Step 4:** Render X. Pizza account layer (chip, in-form "Entregar a"/create-profile card, Mi Cuenta sheet) → confirm near-white, no stray cream tint, cards separate.
- [ ] **Step 5: Commit** — `feat(nearwhite): account.js CONFIG.palette — per-brand neutrals (X.Pizza near-white, La Musa unchanged)`

## Task 5: Enhanced photo swap (X. Pizza)
**Files:** `xpizza-orders/images/*.jpg`.
- [ ] **Step 1:** Copy the 16 enhanced JPEGs from `/Users/xavierlacayo/Downloads/xpizza-images/Enhanced/` over `xpizza-orders/images/` (identical filenames). Confirm all 16 basenames match (no adds/drops).
- [ ] **Step 2:** Confirm no CSS filter was introduced anywhere; image refs in index.html unchanged (filename-identical). La Musa images (`.webp`) untouched.
- [ ] **Step 3: Commit** — `feat(nearwhite): swap in enhanced X.Pizza photos (filename-identical, no CSS filter)`

## Task 6: a11y + self-review + push
- [ ] **Step 1: a11y (codex #5):** verify no required label/price/status text uses `#B3A594` (or `#8C7B6E` at small size) on `#FCFCFB`; if one does, darken it. `#B3A594` decorative/placeholder only.
- [ ] **Step 2: Final proofs:** `la-musa-orders/index.html` untouched; account.js code identical past CONFIG (both forms); zero unclassified warm neutral on X. Pizza; La Musa computed-style unchanged; X. Pizza guest load = near-white, no new SDK/logic; both node --check clean.
- [ ] **Step 3:** Push `feat/xpizza-nearwhite`, report the tip SHA for codex-on-diff. No deploy/merge.

---

## Self-Review (author, pre-handoff)
- **Spec coverage:** inventory (T1), ground (T2), card elevation (T3), account palette + La-Musa proof (T4), photos (T5), a11y + proofs (T6). All 5 codex R1 findings.
- **Watch:** T1 completeness is the crux — a missed warm literal ships stray cream on X. Pizza. T4 Step 3's THREE-part La-Musa proof is mandatory (grep alone insufficient). Card shadow is required, not reactive.
- **Placeholder scan:** none.
