# Rewards B2 — Go-Live Runbook (T7)

**Owner-executed.** The executor never deploys, merges to `main`, or flips flags. This is the ordered,
copy-pasteable procedure with a verification checkpoint after every step. The advisor verifies each
canary result vs prod before the atomic flip.

**State at start:** B2 T1–T6 built + gated on `feat/rewards-phase-b2`. B1 money-path is already live-inert
on `main` (behind `config/redemption_enabled` OFF). Ships **inert**: with `redemption_live` OFF and the
allowlist empty, the redeem affordance is invisible to everyone and `quoteRedemption` 409s — display
surfaces (chip / pane / cart-earn) go live, redemption does not, until the atomic flip.

**Golden rule (order):** functions **before** forms. The forms call `quoteRedemption`; that endpoint must
exist in prod before any UI can invoke it. Do not merge the forms first.

---

## Step 0 — Pre-flight (no writes)

```bash
cd ~/Downloads/xpizza-rewards          # or your deploy checkout
git fetch origin
git log --oneline origin/main -3       # confirm you're reconciling against the REAL current live main
git log --oneline origin/feat/rewards-phase-b2 -8
```

- [ ] Confirm `origin/main` is the actual current live state (a stale checkout silently regresses live — see the standing deploy rule).
- [ ] Confirm the branch tip is the T6 SHA the advisor approved.
- [ ] `cd xpizza-functions && npm test` → green end-to-end (includes `rewards-parity.guard.test.js`).
- [ ] **Aesthetic sign-off done** (your on-device pass — every screen: chip, Mis premios pane, cart-earn, redeem affordance, quote review, success badge, guest claim card; no cramming, alignment, seamless). This is the one gate only you can run.

---

## Step 1 — Deploy functions (the quote endpoint) FIRST

The forms depend on `exports.quoteRedemption`. Deploy it (with the whole function set — never a partial
that would prune live functions and leave drivers unassignable).

```bash
cd ~/Downloads/xpizza-rewards/xpizza-functions
# Deploy from a checkout whose index.js contains BOTH driver-native AND payment code + the complete
# gcloud-managed env (a partial deploy prunes live fns). Confirm this checkout is whole first.
firebase deploy --only functions
```

**Verify:**
- [ ] Deploy reports **47 functions**, no deletions/prunes.
- [ ] `quoteRedemption` Cloud Run revision **bumped** (new revision timestamp).
- [ ] The intake functions (`createOrder`, `chargeOnlineOrder`, `confirmOnlineOrder`) revisions bumped (they carry the B2 uid-first reorder from T1).
- [ ] **Env note:** `quoteRedemption` is read-only — token verify + RTDB reads + `computeServerTotal` (menu-pricing). It needs **no** PixelPay/WhatsApp secret. Confirm it responds (a smoke `POST` with no token → `401 login_required`; a guest-style malformed call → typed JSON, not a 500). A fresh function starts with no env — that's fine here because it needs none.

---

## Step 2 — Deploy rules (the client-readable `redemption_live` leaf)

Rules **must** be emulator-verified before deploy (RTDB rules have no `numChildren()`; only the emulator
catches rule bugs). The T2 emulator test already proves the leaf-cascade; re-run it, then sync + deploy.

```bash
cd ~/Downloads/xpizza-rewards/xpizza-functions
npm run sync:rules                     # copies xpizza-reference/database.rules.json → database.rules.json (SoT is the reference)
node scripts/assert-rules-synced.js    # or: npm run check:rules  (sync + all rules guards)

# Emulator-verify the B2 rules (SHOW the run — do not claim it):
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"; export JAVA_HOME=/opt/homebrew/opt/openjdk
firebase emulators:exec --only database --project demo-xpizza "node test/rewards-config-rules.emulator.test.js"

firebase deploy --only database
```

**Verify:**
- [ ] Emulator run **shown** green: a customer CAN read `config/rewards_public/redemption_live`; CANNOT read `config/rewards_public` itself, a sibling under it, `config/redemption_allowlist`, or any other `config/*`; CANNOT write `redemption_live`; the `user_rewards` spine holds (owner reads own incl. `canary`, other uid + anon denied, client `set(.../canary)` denied by `.write:false`).
- [ ] `--only database` deploy succeeds.

---

## Step 3 — Merge B2 forms → `main` (git-CD), still INERT

With functions + rules live, merge the forms. `redemption_live` is still OFF and the allowlist empty →
the redeem affordance is invisible to all; the display surfaces (chip / pane / cart-earn line) go live.

- [ ] Merge `feat/rewards-phase-b2` → `main` (your normal merge/PR flow).
- [ ] Netlify git-CD picks up both `xpizza-orders` and `la-musa-orders`.

**Verify on the LIVE forms (both brands), logged in as a normal (non-allowlisted) account:**
- [ ] Chip shows the balance; **Mis premios** pane renders (X. Pizza punch card / La Musa milestone bar).
- [ ] Cart-earn line shows "ganás X" (logged-in) / register nudge (guest).
- [ ] **No redeem affordance anywhere** (flag OFF, not allowlisted) — this confirms inert.
- [ ] Guest checkout unchanged; a normal paid order still completes (money path byte-identical).

---

## Step 4 — Canary (your account only) — smoke-test the full money path

Turn redemption on for **only your uid** via Admin/console writes (not the global flag). The affordance
appears for you (read-own `canary` OR the allowlist), everyone else stays inert.

**Console / Admin writes** (rid = `x_pizza` and `la_musa`; `{uid}` = your customer uid):

```
config/redemption_allowlist/{uid}            = true          # server-side gate for quote + intake
user_rewards/{uid}/x_pizza/canary            = true          # read-own client gate (affordance visible)
user_rewards/{uid}/la_musa/canary            = true
```

Ensure your canary account has a redeemable balance on each brand (X. Pizza `available ≥ card_size`;
La Musa `available ≥` the min offered tier) — top up `balance` Admin-side if needed.

**Smoke matrix — run each on the LIVE forms; the advisor verifies each vs prod before the flip:**

Display + quote (both brands):
- [ ] Redeem affordance now visible; pick a reward → the struck-through review shows the **server** discount + new total (X. Pizza cheapest pizza struck; La Musa item "GRATIS", total unchanged).
- [ ] The pay-step total (`#pixelpay-amount`) shows the **server quote** total while the reward is pending (the T4-R1 fix) — never client full price.

Cash:
- [ ] Normal cash order with reward → placed at discounted total; on completion the hold **consumes** (balance drops, reserved clears).
- [ ] Cancel a redeemed cash order → the hold **reverses** (balance restored).
- [ ] Scheduled cash (held → release → consume); cancel-before-release releases cleanly.

Online (PixelPay):
- [ ] Normal online with reward → charge == **discounted** total; consume-at-confirm; factura correct.
- [ ] Refund a redeemed online order → credit reverses `debit_applied`.
- [ ] Manual-reconciliation resolved BOTH ways (abandon/refund → release, no credit; materialize → sale → consume).
- [ ] Scheduled-online confirm → hold → release; `held_closed_at_materialize` → hold.
- [ ] Sweeps backstop: an abandoned hold past `hosted_expires_at` is reclaimed; consume-recovery is no-op-safe.

Fallbacks + guest:
- [ ] Force a redemption failure (e.g. drain the balance mid-flow) → typed message + "Continuar sin premio" places a **fresh** full-price order (new `order_id`, never a same-id redeem retry).
- [ ] A regular-cart `item_unavailable` / `closed` routes to the **existing** cart/closed error path with the reward **preserved** (not the redemption fallback).
- [ ] Success screen shows the earn badge (+ redeemed note when applied); guest post-order shows the profile-claim card.
- [ ] Guest path byte-identical — guest sends **no** `body.redeem`, hits no redemption code.

---

## Step 5 — Atomic flip (redemption live for everyone)

Remove the canary/allowlist, then flip both flags in a **single multi-location update** so there is no
window where the UI is live but the server isn't (or vice-versa).

**Remove canary first** (optional cleanup):
```
config/redemption_allowlist/{uid}   = null
user_rewards/{uid}/x_pizza/canary   = null
user_rewards/{uid}/la_musa/canary   = null
```

**The flip — ONE atomic write (multi-location update at the root):**
```json
{
  "config/redemption_enabled": true,
  "config/rewards_public/redemption_live": true
}
```

**Verify:**
- [ ] Both brands: the redeem affordance is now visible to any eligible logged-in customer; a real redemption completes at the discounted charge.
- [ ] Display surfaces unchanged; guests still unaffected.

### Rollback (instant)

Same write set, inverted — one atomic update:
```json
{
  "config/redemption_enabled": false,
  "config/rewards_public/redemption_live": false
}
```
This hides the affordance and closes the server gate immediately. In-flight reserved holds settle/reverse
through the existing B1 lifecycle (consume on completion, reverse on cancel) — no orphaned state.

---

## Notes

- Restaurant ids: `x_pizza`, `la_musa`. User rewards node: `user_rewards/{uid}/{rid}` → `{ balance, reserved, lifetime, canary, ledger, reservations }`, `available = balance − reserved`.
- `redemption_live` (client-readable leaf) gates the **UI affordance**; `redemption_enabled` (staff-only) gates the **server** quote/intake. The atomic flip sets both true together; the allowlist/canary let one account run ahead for the canary.
- The parity guard (`rewards-parity.guard.test.js`) runs in `npm test` — any future rewards edit that isn't mirrored across both forms fails CI before it can reach a deploy.
