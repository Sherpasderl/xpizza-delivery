# Handoff to Advisor — Track A (profile-claim completion) code-gate

**Branch:** `feat/track-a-profile-claim` · **tip:** `d9fd2ba` · **base:** `main` (`4811267`) · nothing merged/deployed. Plan (with the 3 gated must-fix folded) @ `7934417`.
**Gate type: code-gate.** Money path UNTOUCHED (account-creation UX). Ships INDEPENDENTLY of the rewards flip. Both brands. Transport (b) — gated APPROVE-WITH-CHANGES, all 3 must-fix + 2 minor implemented.

## Commits (each an independent code-gate SHA)
| Task | SHA | What |
|---|---|---|
| 1 · functions | `9a4007e` | `claimPrefill` token-gated lookup + `order_tracking.has_profile` |
| 2 · account.js | `713b3c2` | `openLoginSheet(prefill?)` soft-fill + success-card phone/name env |
| 3 · order-form | `cfb92ba` | `handleProfileClaim()` — fragment token, early `<head>` scrub, fail-open + Referrer-Policy |
| 4 · tracker | `d9fd2ba` | guest-only card + brand-aware fragment deep-link |

## Must-fix (all folded in)
- **MF1 — token in the URL FRAGMENT.** Deep-link `orders.{brand}.hn/?claim=<order_id>#t=<token>`. An inline `<head>` script (placed BEFORE the Google Fonts link → runs before any third-party resource is referenced) captures the `#t=` token + `?claim` order_id into `window.__claimParams`, then `history.replaceState` scrubs BOTH from the URL/history immediately. `Referrer-Policy: strict-origin-when-cross-origin` on BOTH `netlify.toml` (created `la-musa-orders/netlify.toml` — see flag below).
- **MF2 — `has_profile` in the SHARED `buildMaterializeUpdates()`** (conditioned on `order.customer_uid`) → covers materialize + resolve-manual + pixelpay-confirm + scheduled-release; plus the immediate createOrder path after `attachCustomerAttribution`. Guests OMIT it → guest `order_tracking` byte-identical.
- **MF3 — per-IP throttle** on `claimPrefill` via a new `claim_ip` rate-limit bucket (10 min / 30).
- **Minor:** `claimPrefill` strict string compare + missing `order_id` → 403 + token charset-guarded (no RTDB path injection); fixed the stale `generateTrackingToken` comment (54-char alphabet / 54¹²≈6.3e20).
- NOT doing the masked-phone/server-OTP redesign (owner-deferred; after MF1 the token never leaks).

## Security shape (transport b)
- Capability = the `tracking_token` the customer already holds; bound to ONE order by a STRICT `order_tracking/{token}.order_id === order_id` compare in `claimPrefill`. Returns ONLY the order's own `{name, phone}` — no address/items/uid. Read-only. Account creation stays OTP-gated → a leaked token can at most reveal the customer's own phone, never hijack.
- The token never enters a URL sent to servers (fragment), Netlify logs, Referer, or the public `order_tracking` node (only `has_profile:true`, a boolean, is public).

## Verification
- `claim-prefill` emulator **7/7** (valid→{name,phone}; unknown/mismatched/missing/path-injection→403; order-gone→404; no uid/address leaked).
- `materialize-snapshot` **9/9** (+has_profile profiled + guest byte-identical); `materialize-attribution` **14/14** (delta = the 2 attribution paths + `order_tracking.has_profile` only); `create-order-build` **4/4** (guest byte-identical); full `xpizza-functions` `npm test` **green**.
- `rewards-parity.guard` **4/4** after every SHA (account.js byte-identical past CONFIG = 237620; all Track A UI code is OUTSIDE the parity block); inline JS syntax-valid both order forms; tracker module JS valid (ESM); forms edits mirrored across brands.

## Flags for the gate
1. **`la-musa-orders/netlify.toml` is NEW** (none existed) — I created it mirroring xpizza's (`publish = "."` + the Referrer-Policy header). Please confirm it doesn't conflict with how orders.lamusa.hn actually deploys (I can't see the Netlify UI config). If la-musa deploys via `--dir`, `publish="."` is redundant/harmless.
2. **Claim card shows on ALL guest statuses incl. cancelled** — the card is about profile creation (reorder is one benefit), so I left it status-independent. Say if you'd rather hide it on `cancelled`.
3. **`startProfileClaim` skips if `marker().name`** (already a profile on this device) — best-effort; the marker may be async-cold on a fresh deep-link load, in which case it opens the sheet (harmless — an existing user just sees the create flow they can dismiss).

Executor will action any REVISE findings. Nothing merged or deployed.
