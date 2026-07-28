# HANDOFF → functions executor — Order-received WhatsApp for ONLINE orders

**Branch:** `feat/online-order-received` (off live `main` `50b4ff8`). **Design gated:** codex design-gate R1→R2 **APPROVED** — full design + rationale + the exact code block in `docs/superpowers/specs/2026-07-27-online-order-received-design.md` (read it first).

**What + why:** Online (prepaid) customers currently get NO "order received" WhatsApp — only cash/pickup do (sent inline by `createOrder`). Online goes `chargeOnlineOrder → confirmOnlinePayment → confirmAndMaterialize`, none of which notify. Verified live today (order PZX-260727-173138 got its first message only at `out_for_delivery`). Close the gap.

## The change — ONE site, additive, money-path-free
`xpizza-functions/index.js`, function **`sendOrderStatusNotifications`**. Insert the order-received branch **immediately before `index.js:2814`** — the line `if (!['out_for_delivery', 'delivered', 'cancelled'].includes(after)) return;` — i.e. after the tracking-page mirror block that already runs for `after==='new'`. `ServerValue` is imported (L57); `order`, `orderId`, `after`, `restaurantId`, `trackingToken`, `db`, `whatsapp` are all already in scope here.

```js
if (after === 'new') {
  // Order-received confirmation — ONLINE orders only (cash/pickup already got it inline from createOrder).
  if (!order) { console.warn(`orderReceived: order ${orderId} not loaded on 'new', skipping`); return; }   // trigger allows order=null — guard before any order.*
  if (order.payment_method !== 'online') return;                       // cash/pickup → createOrder already sent (no double-send)
  if (!order.customer_phone) return;
  if (!(await whatsapp.isEnabledForRestaurant(db, restaurantId))) return;

  // Mark-before-send (mirror notifyPickupReady): atomic claim so a duplicate 'new' write / trigger redelivery can't double-send.
  let claim;
  try { claim = await db.ref(`orders/${orderId}/order_received_notified_at`).transaction((cur) => (cur ? undefined : ServerValue.TIMESTAMP)); }
  catch (e) { console.warn(`orderReceived: claim failed ${orderId}`, e.message); return; }
  if (!claim.committed) return;   // already sent

  const body = (order.order_type === 'pickup')
    ? whatsapp.tplPickupReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, pickupTime: order.pickup_time || 'standard', trackingToken, restaurantId })
    : whatsapp.tplOrderReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, trackingToken, restaurantId });

  // sendMessage RETURNS null on failure (bad phone / no config / provider error) — it does NOT throw.
  // Marker already committed (at-most-once, no auto-retry — same tradeoff as notifyPickupReady). Record a
  // failed send so it's visible/recoverable, never silently marked sent.
  let res = null;
  try { res = await whatsapp.sendMessage(order.customer_phone, body, restaurantId); }
  catch (e) { console.error(`orderReceived: send threw ${orderId}`, e.message); }
  if (res == null) {
    try { await db.ref(`orders/${orderId}/order_received_send_unresolved_at`).set(ServerValue.TIMESTAMP); } catch (_) {}
    console.warn(`orderReceived: send unresolved (null) ${orderId} — marked for visibility, not retried`);
  }
  return;   // 'new' handled — do NOT fall through to the delivery/cancel logic below
}
```

## Why it's safe (codex-verified in the design gate)
- **No double-send:** `createOrder` rejects `payment_method:'online'` (index.js:443); online never routes through it. The `payment_method==='online'` gate = exactly the gap.
- **Unified live signal:** both unscheduled materialize (`buildMaterializeUpdates` → `status:'new'`) and scheduled release (scheduled-release-core → same builder) converge on `status:'new'`. Held states (scheduled hold, paid-after-close manual_review) never reach `'new'` → correctly get no message.
- **At-most-once:** the transaction claim on `order_received_notified_at`. The marker is a SIBLING of `/status` → does NOT re-trigger this watcher.
- **Money-path untouched:** purely additive to an existing best-effort trigger; fail-open throughout.
- **Per-restaurant:** routes via `order.restaurant_id`; La Musa uses its own UltraMsg instance.
- **Scheduled orders** get "received" at RELEASE (when they go live), not at checkout — accepted for v1.

## Tests
- Extend `whatsapp-config.test.js` (or add a focused unit) for the decision logic if you can extract the branch into a testable pure helper (e.g. `shouldSendOrderReceived(order, after)` → true only for `after==='new' && payment_method==='online' && customer_phone`). Assert: online+new → send; cash+new → skip; online+preparing/ready → skip; missing phone → skip.
- Run the full functions suite green (`npm test`).
- The at-most-once claim + sibling-marker-no-retrigger are best verified in the **RTDB emulator** (Java on PATH — see the deploy runbook) or by careful review; note it in your report.

## Deploy (owner runs — report so it can be sequenced)
Functions only; no rules, no forms. **Gotcha (bit us before): a full `firebase deploy --only functions` can SILENTLY SKIP a changed function** — after deploy, verify `sendOrderStatusNotifications`' Cloud Run revision bumped; if not, force `firebase deploy --only functions:sendOrderStatusNotifications`. Complete env + BOTH driver+payment code + zero-prune as always. Forward-only.

## Handoff back
Advisor is NOT editing functions on this branch — you are sole editor. Push `feat/online-order-received`, report the SHA + test results + emulator/review note. Advisor runs codex-on-diff (heavy on: no double-send, at-most-once claim, order=null guard, sendMessage-null handling, money-path-untouched) → owner deploys functions (verify the revision bump). Deploy is a `git merge` into main (main may have advanced) + functions deploy.
