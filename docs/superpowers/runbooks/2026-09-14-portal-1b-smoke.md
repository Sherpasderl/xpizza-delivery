# Runbook — Portal 1B smoke (serve the live catalog to both order forms)

**Owner-run. The branch is local-only and gated; nothing has been pushed or deployed.**

At the end of this, both customer order forms paint instantly from their committed bundle, then
upgrade in place to the live 1A catalog — and an order placed through either one is charged the
amount the server prices, not the amount the browser displayed.

**What 1B changes about money: nothing, and that is the claim to verify.** The live menu determines
what is *shown*. `createOrder` and `chargeOnlineOrder` recompute the total from the catalog
server-side and read no client-supplied money field. Step 6 is where you confirm that with your own
eyes rather than on the strength of the suite.

---

## 0. The two things that will bite, if anything does

| Allowlist | Where | Symptom if missed |
|---|---|---|
| **CORS** — each form's origin | `PUBLIC_MENU_ORIGINS` in `xpizza-functions/index.js` (**code** → needs a functions redeploy) | The live upgrade never lands. The form still works, painting its committed bundle forever, so this looks like *"1B didn't ship"* rather than a config gap. There is no error on screen by design — a menu that cannot refresh must not break ordering. |
| **Cache key** — rid in the URL **path** | `getPublicMenu/menu/<rid>` | Deliberately not `Vary: rid`. `Vary` keys on request *headers*, not the query, so a CDN could hand one brand's menu to the other. If you ever see la_musa dishes on the x_pizza form, this is the first thing to check. |

---

## 1. Pre-deploy — the suite, green, locally

```bash
cd xpizza-functions
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test          # expect EXIT 0
```

Confirm these four lines appear. They are the 1B-specific ones, and a green run without them means
something is not being executed:

```
22 whole-flow checks passed across both forms.      # the 11-cell matrix, both brands
11 charge-boundary checks passed.                   # the money proof
103 checks passed across both forms.                # live-apply (jsdom load-execution)
mutation anchors: OK (292 mutants, ...)             # no mutant is testing nothing
```

**The endpoint's emulator test must be run GREEN before deploying.** It is not part of `npm test`
because it needs the emulator:

```bash
cd xpizza-functions
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:public-menu
```

---

## 2. Deploy the function

```bash
firebase deploy --only functions:getPublicMenu --project xpizza-delivery
```

**Pin `--project` every time.** The ambient gcloud default drifts, and a deploy to the wrong project
fails in a way that looks like success.

If a new form domain is going live in the same pass, add it to `PUBLIC_MENU_ORIGINS` **before** this
step — it is code, so it ships with the function, not after it.

## 3. Deploy both forms

```bash
netlify deploy --prod --site <x-pizza-site-id>   --dir xpizza-orders
netlify deploy --prod --site <la-musa-site-id>   --dir la-musa-orders
```

Explicit `--site` on both. The linked-site default is whichever directory was touched last, which is
exactly the kind of thing that puts one brand's form on the other brand's domain.

---

## 4. Smoke — the menu path

Do this on **both** forms. They differ materially (x_pizza prices by NAME with per-instance extras;
la_musa prices by ID with qty-aware extras and variant launchers), so passing on one says nothing
about the other.

| # | Do this | Expect |
|---|---|---|
| 4.1 | Load the form with a cold cache | Dishes appear **immediately** — that is the committed bundle, not the network. Nothing blank, no spinner where a menu should be. |
| 4.2 | Watch the network panel | One request to `getPublicMenu/menu/<rid>`. Second load: `304`, and nothing repaints. |
| 4.3 | Edit one dish's price in the portal and publish | |
| 4.4 | Reload the form | The new price is showing. Only the tiles that changed were re-rendered — scroll position and any open category are where you left them. |
| 4.5 | While the form is open, publish another change | It lands without a reload, and **without the page jumping**. |

## 5. Smoke — the cart path

| # | Do this | Expect |
|---|---|---|
| 5.1 | Add a dish to the cart | |
| 5.2 | In the portal, **remove** that dish and publish | The cart line stays on screen, marked — it does **not** vanish. A line disappearing from a cart is the failure this whole slice was built to prevent. |
| 5.3 | Try to submit | Blocked, with the line **named**: *"Algunos productos de tu carrito cambiaron: …"* |
| 5.4 | Remove the line; add a different dish | Submit is available again. |
| 5.5 | Add a dish, then **86 it** from the kitchen display | Submit is blocked and the line is named as *"Agotado: … Quitá ese producto para continuar."* — not "changed". It is not changed; it is sold out, and the only action that helps is removing it. |
| 5.6 | Add a dish, then **reprice** it in the portal | Submit is blocked. The line can be charged at neither the price agreed nor the new one; removing and re-adding is the way through, and then the total shown is the new price. |
| 5.7 | Open a dish modal, publish a change, close the modal | Nothing moves while the modal is open. The change lands when it closes. |

## 6. 🔴 The money check — do this one deliberately

This is the point of the whole slice. Place **one real order on each form** and verify the amount.

| # | Do this | Expect |
|---|---|---|
| 6.1 | Build a cart and go to checkout | Note the total on screen. |
| 6.2 | Place the order (cash) | |
| 6.3 | Open the order in Firestore / the dispatch view | `total_cents` equals what was on screen. |
| 6.4 | Repeat with an **online card** order | The PixelPay amount equals the order's `total_cents`. The browser never sets this amount; it is read from the order record, which was written from the server recompute. |
| 6.5 | Check the order's `order_id` | Ends in an 8-character suffix (e.g. `PZX-260914-193055-K3M7Q2XB`). Both brands. Without it, two orders placed in the same second collide on the payment idempotency anchor and the second sale is silently absorbed into the first. |

**If 6.3 or 6.4 disagree, stop and roll back.** A displayed-vs-charged mismatch is the one failure in
this slice that costs real money, in whichever direction it goes.

---

## 7. Rollback

The forms and the function are independent, and the form is the safer thing to revert:

```bash
# The form: redeploy the previous Netlify deploy from the dashboard, or
netlify deploy --prod --site <site-id> --dir <dir>   # from the previous commit
```

A form on the previous build stops calling `getPublicMenu` and serves its committed bundle. That is a
complete, working menu — 1B's whole design is that the live feed is an *upgrade* over a bundle that
already works, so losing the feed costs freshness and nothing else.

Reverting the **function** alone is rarely what you want: with the forms still deployed, they simply
stop upgrading and fall back to their bundles, which is the same outcome with more moving parts.

---

## 8. Watch, for the first day

| Log line | Means | Act if |
|---|---|---|
| `menu_apply_refused` | A snapshot was rejected whole and the last-good menu is still standing. | It repeats for the same rid — the published catalog has something the forms will not accept. |
| `menu_apply_recovery_failed` | An apply failed **and** the redraw failed. The form now blocks its own charge and tells the customer to reload. | Ever. This one should not happen. |
| `cart_conflict_blocked_send` | A customer was stopped at the send with a conflicted cart. | The rate is more than occasional — a publish during peak hours will produce a burst of these, which is the system working. |
| `cart_blocked_send_menu_broken` | A charge was blocked because the page admitted it was broken. | Ever. Same as above. |
| Rate-limit hits on the **`quote_ip`** bucket | Checkouts are re-quoting more than expected. | Any sustained spike. Until T9 a failed quote re-requested forever (reply → summary render → request → reply), hammering `quoteOrder` from a customer already mid-checkout; that loop is closed, and this bucket is where its return would show first. |
