# HANDOFF → order-form executor session

**What:** Rebuild "Cambiar → Usar una dirección nueva" (logged-in checkout) to use the ISOLATED account map instead of the checkout map. This SUPERSEDES the racey checkout-map fresh-pin approach (failed codex-on-diff R1–R4). Ships as ONE batch with the 5 polish fixes already on the branch.

**Branch:** `feat/loggedin-delivery-polish` (tip `2efedfd`, off live `main` `2b56d21`). Worktree suggestion: check out this branch fresh.

**Read these (on the branch):**
- Spec (codex design-gate APPROVED R2): `docs/superpowers/specs/2026-07-26-cambiar-newaddress-isolated-map-design.md`
- Plan (task-by-task, exact functions/fields): `docs/superpowers/plans/2026-07-26-cambiar-newaddress-isolated-map.md`

**Hard rules:**
- Edit `la-musa-orders/account.js`; mirror byte-identical past CONFIG into `xpizza-orders/account.js`. **index.html UNTOUCHED.**
- The isolated map writes ONLY `_nad*`. The order's checkout coordinate (`lat`/`lng`/pin/`#address-detected`) is written ONCE, at confirm, from the explicitly-placed `_nadPinTouched` value. NO checkout-map geolocation anywhere in this flow.
- Money path (`processPayment`) unchanged. Guest byte-identical. No cheap emoji.

**The two proofs that gate acceptance (codex will re-check on-diff):**
1. NO checkout-global write happens before an explicit `_nadPinTouched` placement + confirm.
2. After the flow settles, `#address-detected` == the confirmed `_nadDetected` == (save case) the saved address's `detected` — with NO async checkout-reverse-geocode drift. Test a coordinate whose checkout geocode formats differently from `_nadDetected`.
3. One-off ("usar solo esta vez") NEVER persists/defaults (`_acctAddrOneOff` true, set LAST). Save case persists + applies.
4. A delivery↔pickup toggle before payment preserves the chosen new/one-off address (retained `_acctOrderAddr`).

**FILE COORDINATION (important — parallel sessions):** the advisor session is NOT editing `account.js` — you are the SOLE editor of this file on this branch. Advisor only reads + runs the codex gates. When done, push the branch and report the tip SHA; the advisor runs codex-on-diff and loops with you until APPROVED, then the owner deploys the whole batch (Netlify CLI per-folder: xpizzaorders 6f09559f / lamusaorders f8bac377).

**Do NOT deploy/merge/run codex** — that's the advisor + owner.
