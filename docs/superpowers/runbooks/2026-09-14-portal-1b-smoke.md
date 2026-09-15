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
36 whole-flow checks passed across both forms.      # the 18-cell matrix, both brands
11 charge-boundary checks passed.                   # the money proof
105 checks passed across both forms.                # live-apply (jsdom load-execution)
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

**If 6.3 or 6.4 disagree, record it — but read the next paragraph before treating it as a 1B defect.**

🔴 **What 1B does and does not guarantee about displayed-vs-charged.** 1B makes the *display* live and
proves the live menu never *determines* a charge. It does not guarantee the two are equal, and that is
deliberate: pricing caches and the deliberate checkout-hold make live tile-to-charge parity impossible,
so the invariant was reframed during the design grill to "the customer is charged exactly the net total
they confirmed" — and **enforcing that equality is 1C's confirmed-quote gate**, not this slice.

**The residual windows — all of them, not just the best-known one.** An earlier draft named only the
checkout-hold, which understated it:

| Window | Why the display can lag the catalog |
|---|---|
| **Checkout-hold** | A publish while the customer is at checkout is deliberately HELD so the menu does not move under them. |
| **Modal-hold / retry-hold** | The same deferral while a dish modal is open, or between createOrder retry attempts. |
| **Capture failure** | A synchronous failure in the apply path applies nothing (whole-flow cell 12) — the screen is intact but the catalog has moved. |
| **Failed quote** | When the server cannot price a cart the display falls open to client-side arithmetic over captured prices. |

`whole-flow.test.mjs` cell 12 **documents** this window and asserts the surrounding no-op properties; it
deliberately does **not** execute the mismatch as an assertion, because doing so would pin a
displayed-vs-charged difference as correct. The figures quoted there come from a measurement taken while
investigating it, not from an assertion the suite runs.

**Rewards — made SAFE in T9, freshness deferred to 1C.** An active reward used to keep its own quote
across a live apply, so a reprice left the discounted total standing with no hold involved at all
(reproduced at L340 shown / L410 charged). Two things changed, and the distinction matters: the apply
now re-**quotes** the reward, which NARROWS the window; and the reward quote is now **stamped with the
cart and reward it was priced for**, so a quote that no longer matches cannot reach a charge — the send
refuses instead. That makes the window SAFE, not closed. A customer can still be stopped and asked to
wait a moment while the reward re-prices; making that seamless is 1C's job, with the same
confirmed-total gate.

**1B narrows this window everywhere else.** Before 1B the form showed a static committed bundle while
the server charged the live catalog — the same mismatch, with no upper bound on how stale the display
could be (that is the 2b-2b bug, shown 340 / charged 350, which started this work). A live display
catches up to a merchant edit within one poll. So this step is a *record-and-report*, not a rollback
trigger, unless the gap is large or does not resolve on a reload.

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

---

## 9. Known and deliberately out of scope

Recorded here rather than only in a handback, so whoever runs this months from now sees the same list.

| # | What | Status |
|---|---|---|
| **Confirmed-total enforcement** | The customer is charged the server's current price, which can differ from the total they confirmed if the catalog moved and the form had not caught up — most reachably, a publish while they are at checkout. Measured in `whole-flow.test.mjs` cell 12: confirmed 34000, charged 38000. | **1C.** The design grill's finding #9 reframed the invariant to "charged == the net total CONFIRMED" and assigned enforcement to 1C's confirmed-quote gate; pricing caches plus the deliberate checkout-hold make live tile-to-charge parity impossible. 1B narrows the window everywhere else — before 1B the display was a static bundle with no bound on staleness. |
| **Availability-gate key coarseness on rename** | The server's 86 gate keys the way the brand prices — x_pizza by NAME — so renaming a dish leaves an 86 keyed to the old name. The client display is correct (Task 7 reapplies availability after every menu change, and an 86'd in-cart line now blocks the send), but the SERVER's gate can miss a renamed dish. | **1D.** Needs stable-id 86 keys on the server, which is 1D's surface. Scoped there deliberately; not a 1B regression — the coarseness predates this slice. |
| **"Render-only" is not literal** | 1B was described as a rendering slice. It is not: `liveMenuPrepare` now validates `variant_items` and rejects empty ids, so 1B changes which snapshots are ACCEPTED, not only how they are drawn. | **Documented.** Anything reasoning about 1B's blast radius must treat it as a prepare/validation change too — a snapshot that published fine before 1B can be refused whole after it, which is the intended behaviour but not a rendering-only one. |
| **A refused snapshot is now diagnosable** | `menu_snapshot_refused` logs the typed cause (`apply_dish_malformed@1`, `apply_variant_id_type@…`). | **Closed in T9.** Before this, a refused snapshot was indistinguishable from a network miss. If the table in §8 shows refusals, this is the line that says why. |

---

## 10. Paths examined and NOT covered by a test — and why that is the right answer

The whole-flow gate asked about four more paths. Each was traced rather than tested, because a test
would assert a branch that cannot be reached or a guarantee that is not this layer's to make. Recorded
so the reasoning is auditable and so nobody adds a test that passes for the wrong reason.

| Path | Finding |
|---|---|
| **A redemption zeroing the order total** | **Unreachable via a valid v2 redemption.** Redemption intake requires a positive PAID cart, so a v2 reward cannot take the total to zero — the `free_order` branch exists for the comped-line case, not for a zero order. Documented as unreachable rather than covered: a test driving it would have to fabricate a redemption the intake path refuses, and a green result would then be evidence about the fixture, not the code. The client flag remains refuse-only (see `charge-boundary.test.mjs`). |
| **Scheduled order + menu change between scheduling and fulfilment** | **Money-safe by construction.** The server re-prices at intake, so the amount never comes from whatever the form was showing when the slot was chosen. No client state survives to influence it. |
| **Pickup-only / weekend toggles moving under a live menu change** | **Money-safe by construction** — the toggles gate FULFILMENT, not price, and the server re-validates both at intake. ⚠️ Worth stating explicitly: this is an *amount* guarantee, not a *policy* one. A fulfilment-policy change landing under a customer mid-checkout is re-validated server-side and can REJECT the order, which is correct but is a rejection the customer sees late. Not a 1B regression — the same is true today — and outside this slice's scope. |
| **Hosted-checkout return** | **Money-safe by construction.** The hosted amount is server-fixed at charge creation and the return path reads the persisted order, so a menu change while the customer is on PixelPay's page cannot alter what is being paid. |

