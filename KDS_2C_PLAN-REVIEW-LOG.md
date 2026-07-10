# Plan Review Log: KDS Phase 2c — Pickup-Ready WhatsApp
Started session (2026-07-10). MAX_ROUNDS=5.

## Round 1 — Codex

Findings:

1. **`sent_at` will be falsely written on failed sends.** `whatsapp.sendMessage()` catches failures and returns `null`; it does not throw ([whatsapp.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/whatsapp.js:104), [whatsapp.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/whatsapp.js:138)). The plan’s “On send success” step is wrong if implemented as `await sendMessage(); set sent_at`.  
Fix: only set `sent_at` when `sendMessage()` returns a non-null provider result; otherwise leave `sent_at` absent and write failure telemetry.

2. **The redelivery guard is misstated.** `before !== after` does not suppress Firebase redelivery of the same transition; a redelivered `new -> ready` event still has `before='new'`, `after='ready'` ([existing sender uses this only as no-op guard](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:2525)).  
Fix: make the transaction the explicit redelivery authority and add a test that invokes the same event twice and asserts one send.

3. **Manual recovery can still create duplicates.** `claimed_at && !sent_at` does not mean “not sent”; it also covers “provider accepted, function died/timed out before recording success.” A dispatcher manual resend could duplicate the customer WhatsApp.  
Fix: record `send_started_at` before the UltraMsg call and treat missing `sent_at` as `unknown_result`, requiring human verification before any manual resend.

4. **Missing `tracking_token` can produce a bad customer message.** The plan requires `customer_phone` but not `tracking_token`, while `tplPickupReady` is supposed to include a tracking link; existing tracking URL code will happily build a URL with a bad token ([whatsapp.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/whatsapp.js:206)).  
Fix: either require `order.tracking_token` before claiming/sending, or make the pickup-ready template omit the link when absent.

5. **Pre-claim skip/failure paths are not observable.** If order load, kill-switch read, missing phone, missing token, or restaurant config causes an early return, no `/pickup_ready_notifications/{orderId}` record exists, so ops cannot distinguish “not eligible” from “trigger never ran.”  
Fix: write a separate non-sending diagnostic record such as `skipped_at/skipped_reason` after safe eligibility classification, without ever clearing or reusing `claimed_at`.

6. **Rules coverage is incomplete for “admin-only.”** The plan says public/staff cannot read/write, but dispatchers are also authenticated clients and current rules grant broad dispatcher powers elsewhere ([database.rules.json](/Users/xavierlacayo/xpizza-lamusa/xpizza-reference/database.rules.json:49)).  
Fix: add explicit top-level `"pickup_ready_notifications": { ".read": false, ".write": false }` and emulator/guard tests proving public, kitchen staff, dispatcher, and driver clients are all denied.

7. **Rules deploy mechanics are underspecified for this repo.** The canonical rules live in `xpizza-reference/database.rules.json`, while `xpizza-functions/database.rules.json` is generated and checked by `sync:rules`/`check:rules` ([package.json](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/package.json:12)).  
Fix: state that the canonical rules file is changed, `npm run check:rules` syncs/verifies the deploy artifact, and the new guard is wired into the rules check.

8. **No test is specified for delivery-order non-send under duplicate trigger load.** The plan’s strongest wrong-channel guarantee depends on `order_type === 'pickup'`, but this needs regression coverage against delivery `ready` transitions because delivery orders also pass through `ready` in the assignment machine ([AUTO_ASSIGNABLE_STATUSES](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:3078)).  
Fix: add emulator/unit coverage: delivery order `ready` produces no claim and no WhatsApp; pickup order `ready` produces exactly one claim/send.

9. **Simpler alternative is not fairly weighed.** Folding a pickup-ready branch into `sendOrderStatusNotifications` would reuse the already-loaded order and run after the existing tracking mirror logic ([index.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/index.js:2535)), reducing another status trigger and duplicate reads.  
Fix: either justify the separate trigger against that concrete reuse benefit, or implement inside the existing trigger with the same separate-tree claim.

VERDICT: REVISE
### Claude's response (R1 → R2 revision)
Incorporated 1–8: (1) gate `sent_at` on a non-null `sendMessage` return + try/catch (handles null-return AND throw); (2) transaction is the SOLE redelivery authority, `before!==after` demoted to a no-op guard + double-invocation test; (3) added `send_started_at` + an honest 5-state record (sent / clean-error / UNKNOWN / claimed-only / skipped) — no blind auto-resend on unknown; (4) omit the tracking link when `tracking_token` absent (don't block the message); (5) diagnostic `skipped_at`/`skipped_reason` for ineligible early-returns; (6) explicit top-level `pickup_ready_notifications: {".read":false,".write":false}` + 4-client (public/kitchen/dispatcher/driver) guard test; (7) canonical `xpizza-reference/database.rules.json` + `check:rules` sync wired; (8) delivery-`ready`-no-send regression test. Rejected 9 with reason: keep the separate trigger to freeze the live money-adjacent `sendOrderStatusNotifications` path byte-for-byte; the only cost is one extra order read, worth it vs regression risk on the live delivery/cancel sender.

## Round 2 — Codex

Findings:

1. **`send_error_at` is not a “clean failure” state with the current WhatsApp client.** `sendMessage()` returns `null` for provider rejection, missing config, invalid phone, invalid body, and caught transport exceptions ([whatsapp.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/whatsapp.js:107)); a transport exception after the request reached UltraMsg can still mean the customer got the message. The plan’s “safe to resend” interpretation for `send_error_at` can create duplicates.  
Fix: either change `sendMessage` to return structured outcomes distinguishing preflight/provider-rejected/transport-unknown, or treat every post-`send_started_at` null as UNKNOWN and never label it safe to resend.

2. **The plan says it will write `send_error`, but the caller has no error detail.** The proposed `try { result = await sendMessage(...) } catch {}` cannot observe why `sendMessage` returned `null`, because the client swallows and logs internally ([whatsapp.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/whatsapp.js:138)).  
Fix: add a structured `sendMessageDetailed()`/result object, or limit the recorded field to a generic `send_result: 'null'` without pretending it identifies the failure.

3. **Ops observability conflicts with the rules model.** The plan says “dispatcher/ops reading the tree interprets,” but rules explicitly deny all client reads, including dispatcher ([KDS_2C_PLAN.md](/Users/xavierlacayo/xpizza-lamusa/KDS_2C_PLAN.md:24), [KDS_2C_PLAN.md](/Users/xavierlacayo/xpizza-lamusa/KDS_2C_PLAN.md:31)). That makes missed/unknown recovery operationally inaccessible unless someone uses Admin SDK/logs.  
Fix: state the recovery view is via Admin-only tooling/callable, or add a dispatcher-gated callable later; do not imply direct dispatcher RTDB reads.

4. **Missing `restaurant_id` still falls back to X. Pizza and can wrong-channel a pickup send.** The plan is strict on `order_type`, but `restaurantId = order.restaurant_id || 'x_pizza'` means any malformed La Musa pickup lacking `restaurant_id` sends from X. Pizza. Existing intake writes `restaurant_id`, so this is probably rare, but it violates the stated fail-safe posture.  
Fix: require `restaurant_id` for pickup-ready sends, or explicitly allow the fallback only for proven pre-La-Musa legacy X. Pizza orders.

5. **No-op status rewrites need to be an explicit early return.** The prose says `before !== after` is a no-op guard, but the eligibility list does not clearly include it. Without an early return, an already-`ready` rewrite could claim/send later if no prior claim exists.  
Fix: specify `if (after !== 'ready' || before === after) return` before any diagnostic/claim/send work.

VERDICT: REVISE
### Claude's response (R2 → R3 revision)
Incorporated all 5: (1/2) collapsed `send_error_at`+`send_error` → a single `send_unresolved_at` (any null-return OR throw after send_started_at); dropped the fake error string and the unsafe "clean failure ⇒ safe resend" — a null from sendMessage can mean the customer already received it, so no post-attempt state is ever auto-labeled safe (structured sendMessageDetailed → v2); (3) recovery view is Admin-SDK/Cloud-Logging/future-callable only, NOT a direct dispatcher RTDB read (consistent with the deny-all rules); (4) require `restaurant_id` — no `'x_pizza'` fallback for a customer-facing send; missing ⇒ skip(no_restaurant_id); (5) explicit `if (after !== 'ready' || before === after) return;` as the first line before any diagnostic/claim work.

## Round 3 — Codex

Findings:

1. **`send_started_at` must be durably written before the UltraMsg call, or the recovery state can lie.** If the `send_started_at` write fails but the implementation still sends, the node can remain `claimed_at`-only while the customer may have received the WhatsApp; the plan then labels that state “not sent ⇒ safe to resend” ([KDS_2C_PLAN.md](/Users/xavierlacayo/xpizza-lamusa/KDS_2C_PLAN.md:24), [KDS_2C_PLAN.md](/Users/xavierlacayo/xpizza-lamusa/KDS_2C_PLAN.md:32)).  
Fix: explicitly require `await send_started_at` succeeds before calling `sendMessage`; if that write fails, abort without sending and swallow/log.

2. **Unknown restaurant IDs can still wrong-channel through X. Pizza.** The plan requires `restaurant_id` present, but `whatsapp.resolveWhatsappConfig()` routes every non-`la_musa` ID to the X. Pizza UltraMsg config ([whatsapp.js](/Users/xavierlacayo/xpizza-lamusa/xpizza-functions/whatsapp.js:107)). If a future/typo restaurant has `identity.whatsapp_enabled === true`, pickup-ready can send from X. Pizza’s number.  
Fix: eligibility must require a supported WhatsApp restaurant ID, currently `x_pizza` or `la_musa`, or add a resolver that fails closed for unknown IDs.

3. **Diagnostic `skipped_at` can race with an already-claimed/sent node and make the record contradictory.** A redelivered event reads current mutable order state, so if `order_type`, `customer_phone`, `restaurant_id`, or enablement changes after a real send, a later invocation can write `skipped_at` onto a node that already has `claimed_at`/`sent_at`; the plan says `skipped_at` means “never attempted” ([KDS_2C_PLAN.md](/Users/xavierlacayo/xpizza-lamusa/KDS_2C_PLAN.md:16), [KDS_2C_PLAN.md](/Users/xavierlacayo/xpizza-lamusa/KDS_2C_PLAN.md:33)).  
Fix: write skip diagnostics only if no `claimed_at` exists, preferably with a transaction/update guard, and define interpretation priority as `sent/claimed` beats `skipped`.

VERDICT: REVISE
### Claude's response (R3 → R4 revision)
Incorporated all 3: (1) `send_started_at` is awaited BEFORE `sendMessage`; if that write fails, abort without sending → `claimed_at`-only truthfully means never-attempted; (2) eligibility requires `restaurant_id ∈ {x_pizza, la_musa}` (supported set) — unknown/typo IDs fail closed (no X. Pizza routing via resolveWhatsappConfig's non-la_musa default); (3) the skip diagnostic is a guarded transaction that aborts if `claimed_at`/`sent_at` exists, + explicit precedence `sent/claimed` > `skipped`. Added skip-guard + durable-start test coverage.

## Round 4 — Codex

No material blockers found in R3.

The plan now closes the previously material gaps: durable `send_started_at` before any provider call, fail-closed supported restaurant IDs, guarded skip diagnostics, no `x_pizza` fallback for customer-facing pickup-ready sends, and null `sendMessage` results treated as unresolved rather than safe failures.

Residual risk is inherent and acknowledged: once `send_started_at` is written, any unconfirmed outcome must remain human-verified because the current WhatsApp client cannot distinguish provider rejection from transport-unknown. That preserves at-most-once and avoids blind resends.

VERDICT: APPROVED