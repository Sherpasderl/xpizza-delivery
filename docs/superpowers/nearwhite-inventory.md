# X. Pizza Near-White — Complete Warm-Literal Inventory (auditable control, codex #1/#3)

Every warm-neutral hex in `la-musa-orders/account.js` (injected styles) and `xpizza-orders/index.html`
CSS, classified **SWAP** (→ per-brand `CONFIG.palette`, X. Pizza near-white / La Musa = exact current
literal) / **KEEP-EXACT** (same value both brands) / **TEXT** (ink/label, a11y-classified, unchanged).
No warm neutral is left unclassified. Non-neutral colors (brand red, success green, per-item card
accents, cool greys) are out of scope and listed at the bottom for completeness.

Grep basis: `grep -oE '#[0-9A-Fa-f]{3,6}'` over both files, every occurrence contextualized.

## A. `account.js` injected-style warm neutrals → `CONFIG.palette` (SWAP)

| # | current literal (La Musa keeps) | count | where / purpose | palette key | X. Pizza near-white | class |
|---|---|---|---|---|---|---|
| 1 | `#FFFDFA` | 2 | `.acct-sheet` / panel bg | `screen` | `#FCFCFB` | SWAP |
| 2 | `#FBF6EE` | 5 | `.acct-compact` / `.acct-verified-ro` row fill | `tint` | `#F6F6F4` | SWAP |
| 3 | `#F4EEE4` | 2 | `.acct-iconbtn:hover` + `.acct-acard--tapped` fill | `tint2` | `#F1F1EF` | SWAP |
| 4 | `#F0E8DA` | 4 | `.acct-cav` avatar / chip bg | `chip` | `#EFEFEC` | SWAP |
| 5 | `#EFE7DA` | 2 | `.acct-cfm-cancel` btn + `.acct-nad-map` bg | `fillA` | `#EDEDEA` | SWAP |
| 6 | `#EDE5D9` | 8 | light divider / card border | `line` | `#ECECEA` | SWAP |
| 7 | `#E7DFD3` | 2 | disabled-button fill (`.acct-cta`/`.acct-save-addr-btn`) — stray-cream risk | `fillB` | `#E8E8E5` | SWAP |
| 8 | `#E4DAC7` | 2 | `.acct-fs-overlay` + `.acct-map-preview` map bg (STRAY-CREAM RISK on near-white) | `mapbg` | `#E7E7E3` | SWAP |
| 9 | `#E2D8C8` | 13 | primary card/pane border | `line2` | `#E2E2DE` | SWAP |
| 10 | `#D8CBB8` | 1 | `.acct-picker-new` dashed border | `line3` | `#D6D6D0` | SWAP |
| 11 | `#CFC2B1` | 3 | inactive address dot / mid border | `dot` | `#CFCFC9` | SWAP |

## B. `xpizza-orders/index.html` warm neutrals (SWAP — X. Pizza only; La Musa index.html UNTOUCHED)

| current | where | X. Pizza near-white | class |
|---|---|---|---|
| `#FBF7F2` | `:root --cream` (ground) + the `var(--cream,#FBF7F2)` fallback in the pay-return overlay | `#FCFCFB` | SWAP |
| `#F5EFE6` | `:root --surface` (inset) | `#F5F5F3` | SWAP |
| `#E8E0D5` | `:root --border` | `#E6E6E2` | SWAP |
| `#D4C8BA` | `:root --border2` | `#D6D6D0` | SWAP |
| `#D9D2C5` | `.detail-drag-handle` bg (warm drag pill) | `#D6D6D0` | SWAP |

## C. KEEP-EXACT (same value both brands — NOT parameterized, documented so the zero-stray grep whitelists them)

| literal | where | why KEEP |
|---|---|---|
| `#F3E7CC` | account.js `.acct-soon-tag` bg AND selection ring (dual-use) | GOLD-accent tint (on-brand on X. Pizza's gold accent), identical both brands |
| `#F5E6C0` | index.html `:root --gold-lt` | gold light tint (accent family), X. Pizza only, not a ground neutral |
| `#fff` | white card backgrounds (both files) | white cards stay white; separation via Part B shadow |
| `#1E1B18` | account.js map-pin balloon (fill/stroke) | near-black pin, intentional both brands (account-visual-polish) |
| `#F2F2F2` `#F0F0F0` `#E2E2E2` | index.html `.sched-*` | already COOL grey (no warmth) — fine on near-white, not a cream swap |
| `rgba(40,28,12,*)` / `rgba(30,28,24,*)` | shadow tints (both files) | dark shadow tint, not a ground neutral — intended |

## D. TEXT / ink (a11y-classified, unchanged — codex #5)

| literal | role | a11y on `#FCFCFB` |
|---|---|---|
| `#17130F` `#1E1B18` `#2A231C` `#6B5E52` | primary/dark ink | fine |
| `#5b4f41` (`.acct-savetoggle`), `#4A4038` (`.acct-nad-savechk`) | label text | fine (dark warm ink) |
| `#5A4F47` (index.html) | body text | fine |
| `#8C7B6E` | MUTED/secondary text ONLY | ≈3.95:1 — OK for muted, NOT small required labels |
| `#B3A594` | DECORATIVE / placeholder / faint-icon / eyebrow ONLY | ≈2.34:1 — never a required label/price/status |

**a11y check (T6):** the eyebrow "ENTREGAR A" / "ELEGÍ UNA DIRECCIÓN" use `#B3A594` — decorative section labels (not required form labels/price/status), acceptable per the decorative-only classification. No required label/price/status uses `#B3A594` or small `#8C7B6E` on the new ground. (Verify on-device at deploy.)

## E. Non-neutral (out of scope — brand/semantic, unchanged both brands)
Brand red family (`#C8321A` `#9E2412` `#7A2515` `#A0321A` `#8F2413` …), destructive `#C0392B`/`#B23B3B`,
success green (`#2A6A42` `#A8D8BA` `#D4EDDE` `#E7F0E9` `#EAF4EF` `#E8F5EE` `#BFE0CC` …), per-item pizza-card
accent `color:` values (`#8A7A5A` `#7A6A3A` `#5A4A3A` `#5A3A20` `#6B3020` `#8B3A1A` `#8A3A2A` `#3A5A7A`
`#3A6A2A` `#7A5A08` `#B8860B` …), map-toggle `#333`. La Musa accent `#B61218` is CONFIG-only (line 8) — no
body literal. None are warm-neutral ground; all untouched.

## Palette summary (CONFIG.palette)
```
La Musa:  screen:#FFFDFA tint:#FBF6EE tint2:#F4EEE4 chip:#F0E8DA fillA:#EFE7DA line:#EDE5D9
          fillB:#E7DFD3 mapbg:#E4DAC7 line2:#E2D8C8 line3:#D8CBB8 dot:#CFC2B1   (= current literals → byte-identical)
X. Pizza: screen:#FCFCFB tint:#F6F6F4 tint2:#F1F1EF chip:#EFEFEC fillA:#EDEDEA line:#ECECEA
          fillB:#E8E8E5 mapbg:#E7E7E3 line2:#E2E2DE line3:#D6D6D0 dot:#CFCFC9
```
