# International phone input (country-code dropdown) — design

_Date: 2026-07-24 · Branch: `feature/intl-phone-input` (off `origin/main` fc87907) · Both forms: `xpizza-orders/index.html` + `la-musa-orders/index.html`_

## Goal

Let customers enter a **non-Honduras** phone number (e.g. US). Today both forms **hardwire +504**: the input formatter force-prepends `504`, caps at 11 digits, pre-fills `+504 ` on focus, and validation demands "504 + 8 digits", so a US number gets mangled. Replace the single field with a **country-code dropdown** (default +504) so any listed country's number is captured correctly and flows to WhatsApp.

## Current bug (verified, identical on both forms)

- Input: `<input id="cphone" placeholder="+504 9999-9999" maxlength="14">`.
- Formatter (`input` listener): strips non-digits → `if(!raw.startsWith('504')) raw='504'+…` → `raw.substring(0,11)` → formats `+504 XXXX-XXXX`; `focus` pre-fills `+504 `.
- Validation (Paso-1 gate — `goToLocation`, x_pizza ~1938 / la_musa ~2413): `phoneDigits.length !== 11` → "Debe ser +504 seguido de 8 dígitos."
- Submit: `customer_phone = document.getElementById('cphone').value.trim()` (the formatted string).
- **WhatsApp `normalizePhone()` already handles full international numbers** — it only prepends 504 to a *bare 8-digit* number; a full number keeps its code. **No server/functions change needed.**

## Approach: country-code selector + local number

Replace the single input with a **two-part control**: a country-code button `[+504 ▾]` + a local-number input. The input holds **local digits only**, formatted per the selected country. On submit, `customer_phone` = the full number `+<code> <formatted-local>`.

### Country list (config; adjustable)

```js
const PHONE_COUNTRIES = [
  { code:'504', name:'Honduras',       len:8  },   // default — XXXX-XXXX
  { code:'1',   name:'Estados Unidos', len:10 },   // (XXX) XXX-XXXX
  { code:'502', name:'Guatemala',      len:8  },
  { code:'503', name:'El Salvador',    len:8  },
  { code:'505', name:'Nicaragua',      len:8  },
  { code:'506', name:'Costa Rica',     len:8  },
  { code:'52',  name:'México',         len:10 },
  { code:'34',  name:'España',         len:9  },
];
```

Default = index 0 (Honduras +504), so a local customer types 8 digits exactly as today.

### Components (both forms, identical)

1. **Markup** — a `.phone-row` wrapping a `.cc-btn` (shows `+<code> ▾`) + the existing `#cphone` input (local digits) + a `.cc-menu` dropdown (country name + `+code`, no flags — [[no-cheap-emoji-in-form-chrome]]). Remove the `maxlength="14"` and the `+504` placeholder; placeholder becomes the local format for the selected country.
2. **State** — a module var `phoneCC` (selected country `code`, default `'504'`).
3. **Formatter (rewritten)** — the `#cphone` `input` listener strips to digits, **caps at the selected country's `len`** (no 504 force-prepend), and formats: Honduras/8-digit → `XXXX-XXXX`; US → `(XXX) XXX-XXXX`; else clean space-grouping. The `focus` pre-fill of `+504 ` is **removed** (the code lives in the button).
4. **Dropdown** — click `.cc-btn` toggles `.cc-menu`; selecting a country sets `phoneCC`, updates the button label + input placeholder + `maxlength`-equivalent (the `len`), clears the input, closes the menu; an outside-click closes it.
5. **Validation (rewritten)** — in the Paso-1 gate, replace `phoneDigits.length !== 11` with `phoneDigits.length !== countryFor(phoneCC).len`; message: "Número inválido. Ingresá los N dígitos de tu número." (N = the country's `len`).
6. **Submit** — `customer_phone = '+' + phoneCC + ' ' + <formatted local>` (a full, human-readable international number that `normalizePhone` accepts). Replaces the bare `#cphone.value.trim()`.
7. **Draft snapshot** — save/restore `phoneCC` alongside `cphone` (the `fields` object at ~2490 / ~2943 and its restore at ~2504 / ~2956), so a restored draft re-selects the right country.

## Data flow

pick country (`phoneCC`) + type local digits → formatter shows local per-country → submit builds `customer_phone = "+504 9999-9999"` / `"+1 (555) 123-4567"` → order payload → server stores it + `normalizePhone()` (strips to digits; full number keeps its code) → WhatsApp send. Dashboard/receipt show `customer_phone` verbatim (unchanged).

## Error handling / edge cases

- **Paste** a full `+1 555…` while Honduras is selected → the formatter strips to digits + caps at Honduras `len` (8), so it won't silently mis-store; the customer must pick the country first (matches an explicit-selector model). _(Nice-to-have, optional: detect a pasted leading known code and auto-select it — out of scope unless requested.)_
- **Country switch** clears the number (avoids a Honduras number lingering under +1).
- **Validation** blocks submit until the local length matches the selected country.
- **Restore** re-selects `phoneCC`; if a legacy draft lacks it, default to `'504'`.
- **Back-compat:** existing orders' `customer_phone` strings are unaffected; `normalizePhone` already tolerates them.

## Server / WhatsApp

**No change.** `normalizePhone()` (whatsapp.js) already: strips to digits, prepends 504 only for a bare 8-digit number, accepts 10–15 digit full numbers. A `+1…` (11 digits) passes through with its code intact. Verified.

## Testing (both forms — inline JS, no harness → manual)

- Default Honduras: type 8 digits → `+504 XXXX-XXXX`; submit → `customer_phone` starts `+504`.
- Switch to Estados Unidos +1 → placeholder `(555) 123-4567`; type 10 digits → formats US; submit → `customer_phone` starts `+1`.
- Validation: wrong digit count for the selected country → blocked with the N-digit message; correct count → proceeds.
- Dropdown open/close (click + outside-click); switching country clears the field.
- Draft save → reload/restore → the country + number come back.
- No emoji anywhere in the control.

## Gate & rollout

- **Advisor gate:** source-verify + **codex-on-diff** (standing discipline; focus: the control always yields a valid full international `customer_phone`; Honduras flow unchanged; paste/backspace/country-switch edge cases; no XSS in the dropdown; both forms identical).
- **Deploy:** form-only, **both** `orders.xpizza.hn` and `orders.lamusa.hn` (git-CD on merge to main). No functions deploy.
- **Ownership:** executor builds on this branch (both forms); advisor gates; **Xavier deploys**.

## Out of scope

- Server/`normalizePhone` changes (already handles it).
- Auto-detecting a pasted country code (optional future nicety).
- Full searchable all-countries list (the fixed list covers Honduras + US + the region + España).
- Number-type/line validation beyond digit count.
