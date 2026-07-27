# X. Pizza Near-White Ground + Enhanced Photos — Design Spec

**Date:** 2026-07-26 · Advisor-designed, owner-approved decisions (mockups: bg-compare `af4a8d92`, photo-filter `c4dfceab`, end-state `e76345ce`). Branch `feat/xpizza-nearwhite` (off live `main` `4b64e80`). Deploy: Netlify CLI per-folder.

## Goal
Move the **X. Pizza** order form from its warm cream ground to a **crisp near-white (`#FCFCFB`)**, and swap in the owner's **Pixelmator-enhanced photos**, for a cleaner, brighter, more food-forward look. **La Musa stays exactly as it is (warm cream) — byte-identical.** This is the FIRST batch that deliberately edits `index.html` (the neutral tokens live there) — that's in-scope here (unlike the account-layer batches).

## Owner-locked decisions
- **Ground:** near-white `#FCFCFB` (NOT stark `#FFFFFF`). Keep the tiniest warmth so it's clean, not clinical.
- **Scope:** **X. Pizza only.** La Musa keeps cream. Since the two forms share `account.js`, this requires a **per-brand neutral palette** (below).
- **Photos:** the owner's enhanced files (already in `/Users/xavierlacayo/Downloads/xpizza-images/Enhanced/`, same filenames). **No CSS filter** — the enhancement is baked into the files.

## Part A — X. Pizza `index.html` ground re-tune (per-form, isolated)
`xpizza-orders/index.html` `:root` currently: `--cream:#FBF7F2` (page/paper ground), `--surface:#F5EFE6` (inset surface: inputs, section-heads), `--border:#E8E0D5`, `--border2:#D4C8BA`, `--charcoal:#1E1B18` (text), plus `--gold` (accent). `html`/`body` background is `var(--cream)`.
**Change** the warm neutrals to near-white / cool-neutral (keep `--charcoal` + `--gold`):
- `--cream #FBF7F2 → #FCFCFB` (the near-white ground)
- `--surface #F5EFE6 → #F5F5F3` (barely-there cool inset)
- `--border #E8E0D5 → #E6E6E2` (cool light border)
- `--border2 #D4C8BA → #D6D6D0` (cool mid border)
(Proposed starting values — final tuning is an on-device eyeball; keep the drift small and NEUTRAL-cool, not blue.) `la-musa-orders/index.html` is UNTOUCHED.

## Part B — Card separation re-tune (near-white ground) — codex R1 #4
Today cards are white (`#fff`) floating on cream; the warm-vs-white contrast separates them. On `#FCFCFB` that contrast nearly vanishes — and the proposed borders are weak against the ground (`#E6E6E2` ≈ 1.22:1, `#D6D6D0` ≈ 1.42:1) — fragile on mobile. So do NOT rely on border-only + "fix reactively." **Give the core form cards a small DEFAULT elevation:** `.pizza-card`, `.order-review`, `.section`, `.loc-card`, `.pay-card`, `.pixelpay-box` (index.html) each get a subtle shadow (e.g. `box-shadow:0 1px 2px rgba(30,28,24,.04), 0 6px 16px -12px rgba(30,28,24,.18)`) AND keep a defined border. Account cards-in-form + the sheet get the same treatment via the palette. Tune to "clearly a card, not heavy." **Required: on-device/mobile visual QA at 360/390/414px confirming every card surface reads as distinct** — not a post-hoc "only where it disappears."

## Part C — `account.js` per-brand neutral palette (the shared-file work)
`account.js` is byte-identical past the ~20-line CONFIG block and already interpolates `${CONFIG.accent}` into its injected `<style>`. Extend that pattern: add a **`CONFIG.palette`** neutral set and reference it wherever a warm-neutral literal currently appears in the injected styles, so the account layer (sheet + the cards it renders INTO the form) matches each brand's ground.

**STEP 1 — build a COMPLETE literal inventory (codex R1 #1/#3).** The table below is a SEED, not the full list. The executor MUST grep `account.js` (and `index.html`) for EVERY warm-neutral hex and classify each as one of: **SWAP** (→ near-white via `CONFIG.palette`), **KEEP-EXACT** (semantic/accent — same value both brands), or **TEXT** (ink/label — a11y-checked, see Non-negotiables → Accessibility). Codex already surfaced literals the seed missed — include them and any others found: `#CFC2B1`, `#D8CBB8`, `#E7DFD3`, `#EFE7DA`, `#E4DAC7` (warm fills/dashed-borders/map-placeholder/inactive-dot), and warm text-ish `#5b4f41`/`#4A4038` (classify TEXT). No warm neutral may remain unclassified — an un-parameterized cream literal would ship stray cream on X. Pizza's near-white ground (map placeholder, disabled button, dashed border, inactive address dot).

Seed table (extend to the full inventory):
| current (La Musa keeps) | token | X. Pizza near-white | class |
|---|---|---|---|
| `#FFFDFA` | `palette.screen` (sheet/panel bg) | `#FCFCFB` | SWAP |
| `#FBF6EE` | `palette.tint` (card/row fill) | `#F6F6F4` | SWAP |
| `#F0E8DA` | `palette.chip` (avatar/chip bg) | `#EFEFEC` | SWAP |
| `#EDE5D9` | `palette.line` (light divider) | `#ECECEA` | SWAP |
| `#E2D8C8` | `palette.line2` (border) | `#E2E2DE` | SWAP |
| `#F4EEE4`,`#EFE7DA`,`#E7DFD3`,`#E4DAC7` | `palette.tint2/fill*` | cool near-white equivalents | SWAP |
| `#CFC2B1`,`#D8CBB8` | `palette.line3` (mid border/dashed/dot) | cool mid neutral | SWAP |
| `#F3E7CC` | `palette.selTint` — used by BOTH `.acct-soon-tag` bg AND `.acct-acard.acct-on2` selection ring | **KEEP-EXACT** (gold-accent tint; La Musa = X. Pizza = `#F3E7CC`) | KEEP |
| `#5b4f41`,`#4A4038`,`#8C7B6E`,`#B3A594` | (ink/label) | unchanged | TEXT (Non-negotiables → Accessibility) |

- **`CONFIG.palette`** lives in the CONFIG block (allowed to differ per form). **La Musa's `palette` = the exact current literals** for every SWAP token → La Musa renders **byte-identical**. **X. Pizza's `palette` = the near-white column.** KEEP-EXACT tokens are the same value in both.
- Replace the classified neutral literals in the injected-style template strings with `${CONFIG.palette.X}`. Leave TEXT/ink + `${CONFIG.accent}` untouched.
- account.js CODE past CONFIG stays **byte-identical** between forms (only CONFIG.palette differs) — invariant HOLDS.
- **Priority order:** the cards that render INTO the form (`#acct-deliver`/`#acct-s2-summary`: `.acct-compact`, `.acct-deliver`, `.acct-cp-card`, `.acct-verified-ro`) FIRST; then the full sheet (Mi Cuenta/Cambiar/Creá perfil) with the same palette.

## Part C-verify — La Musa byte-identical PROOF (codex R1 #2, not grep-alone)
Grep proves coverage candidates but NOT identical rendering. Require ALL of: (a) `account.js` **code diff past the CONFIG block** between the two forms = empty (only CONFIG/palette differs); (b) grep for ANY remaining warm-neutral hex in the injected styles that isn't a CONFIG.palette reference or a classified KEEP/TEXT → must be zero; (c) a **computed-style / rendered diff for La Musa**: open La Musa, snapshot computed background/border colors of the account chip, an in-form card (`.acct-compact`/`.acct-cp-card`), and the sheet — must equal the pre-change values exactly. La Musa is the safety line.

## Part D — Enhanced photo swap (X. Pizza)
Replace the 16 photos in `xpizza-orders/images/*.jpg` with the enhanced versions from `/Users/xavierlacayo/Downloads/xpizza-images/Enhanced/` (identical filenames → clean drop-in, zero code/reference change). Commit the new binaries to the branch (they deploy with the form via Netlify). **No CSS filter** anywhere. La Musa images untouched.

## Non-negotiables
- **La Musa byte-identical** — `la-musa-orders/index.html` untouched; `la-musa-orders/account.js` renders identically (its `CONFIG.palette` = current literal values); La Musa images untouched. This is the hard safety line.
- **account.js CODE identical past CONFIG** — only the CONFIG block (now including `palette`) differs between the two forms. Verify with a Node compare.
- **No money-path/logic change** — pure color tokens + image assets. `processPayment`, order flow, account logic all untouched.
- **Guest byte-identical (X. Pizza)** structurally — guests see the new near-white ground (that's the intended change) but no new SDK/logic; the change is CSS-token + assets only.
- **Accessibility (codex R1 #5) — classify faint neutrals by role.** On `#FCFCFB`: `#1E1B18`/`#17130F`/`#5A4F47`/`#7A5A08` are fine. `#8C7B6E` ≈ 3.95:1 → OK for MUTED/secondary text only, NOT small required labels/status; `#B3A594` ≈ 2.34:1 → DECORATIVE / placeholder / faint-icon ONLY. **Verify no required label, price, or status text uses `#B3A594` (or `#8C7B6E` at small size) against the new ground**; if one does, darken it. Borders aren't text-contrast but ARE the sole separator in places (Part B's shadow covers that).
- **No cheap emoji** (unchanged).

## Codex design-gate: R1 REVISE (folded) → this revision
#1/#3 complete-inventory requirement + classify every warm literal (SWAP/KEEP-EXACT/TEXT), incl. the ones codex found (`#CFC2B1`,`#D8CBB8`,`#E7DFD3`,`#EFE7DA`,`#E4DAC7`,`#5b4f41`,`#4A4038`); `#F3E7CC` = KEEP-EXACT (dual-use gold tint). #2 La-Musa proof = code-diff-past-CONFIG + zero-stray-warm-grep + computed-style diff (not grep alone). #4 core cards get a default subtle shadow + mandatory mobile visual QA (borders alone too weak on near-white). #5 faint-neutral a11y classification (`#B3A594` decorative-only, `#8C7B6E` muted-only). Full parameterization retained (codex: safer than phasing, given strict gates).

## Out of scope
La Musa's ground (stays cream). Any layout/logic change. CSS photo filters (owner chose baked-in enhanced files). Other brands.

## Gate focus (codex design-review)
1. **La Musa byte-identical:** does the `CONFIG.palette` refactor guarantee La Musa renders exactly as today (palette = current literals; no stray hardcoded neutral left un-parameterized that would only match one brand)? How to verify (rendered-diff / literal grep)?
2. **Invariant:** account.js code past CONFIG stays identical between forms; only CONFIG.palette differs.
3. **Card separation:** on near-white, do all card surfaces (menu items, sections, account cards-in-form, sheet) still read as distinct without heavy shadows? Any card that disappears?
4. **Coverage:** are ALL form-facing warm neutrals converted for X. Pizza (no stray cream tint left on a card/row against the near-white ground)? A grep for remaining warm-neutral literals in X. Pizza's rendered styles.
5. **Contrast/a11y** on the lighter ground (placeholders, faint labels, borders).
6. **Photo swap** is a clean filename-identical drop-in (no broken refs); La Musa images untouched.
