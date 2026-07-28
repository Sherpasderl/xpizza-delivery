# DESIGN — Order-received WhatsApp for ONLINE (prepaid) orders

## Problem (verified from source + live logs today)
Cash/pickup orders get an immediate "order received" WhatsApp (`tplOrderReceived`/`tplPickupReceived`) sent inline by **`createOrder`**. **Online prepaid orders go through `chargeOnlineOrder → confirmOnlinePayment → confirmAndMaterialize` (pixelpay-confirm.js) and materialize.js — NONE of which send any order-received message.** So an online customer pays, then gets **radio silence** until `sendOrderStatusNotifications` fires at `out_for_delivery` (that trigger only sends for `out_for_delivery`/`delivered`/`cancelled`). Confirmed live today (order PZX-260727-173138, online, "ready", zero sends to the customer).

## Goal
Send the order-received confirmation (with tracking link) to ONLINE customers exactly once, when their order goes live — WITHOUT touching the money path, WITHOUT double-sending to cash orders, covering both unscheduled confirm AND scheduled release.

## Key facts (verified)
- `buildMaterializeUpdates` sets **`status: 'new'`** when an order materializes (materialize.js:56/118). Scheduled orders are held at `status:'scheduled'` then released to `'new'` (scheduled-release-core). So **the status→`'new'` write is the single unified "order is now live" signal** for BOTH unscheduled online confirm and scheduled online release.
- Cash/pickup orders (`createOrder`) ALSO write `status:'new'` — but they already got their inline send. Discriminator: **`payment_method === 'online'`** identifies exactly the orders `createOrder` did NOT send for (online prepaid uses `chargeOnlineOrder`, never `createOrder` → no overlap → no double-send).
- `sendOrderStatusNotifications` is `onValueWritten('orders/{orderId}/status')` — it already loads `order`, resolves `restaurantId`, updates the tracking page for any status, and gates on `whatsapp.isEnabledForRestaurant`. It fires on the initial `status:'new'` write.
- Templates `tplOrderReceived({customerName, orderId, itemsText, total, trackingToken, restaurantId})` (delivery) and `tplPickupReceived({..., pickupTime})` (pickup) already exist; all inputs are present on a materialized order.
- Proven at-most-once: `notifyPickupReady`'s **mark-before-send** — `transaction` claim on a marker (present ⇒ abort, absent ⇒ win), then send. Reuse it.

## Design (single site, additive, money-path-free)
Add an **order-received branch to `sendOrderStatusNotifications`**, before the existing `if (!['out_for_delivery','delivered','cancelled'].includes(after)) return;`:

```
// After the existing tracking-page mirror block (which already runs for after==='new'):
if (after === 'new') {
  // Order-received confirmation — ONLINE orders only (cash/pickup already got it inline from createOrder).
  if (!order) { console.warn(`orderReceived: order ${orderId} not loaded on 'new', skipping`); return; }   // R1#1: the trigger allows order=null — guard BEFORE touching order.* (fail-open)
  if (order.payment_method !== 'online') return;                       // cash/pickup → no double-send
  if (!order.customer_phone) return;
  if (!(await whatsapp.isEnabledForRestaurant(db, restaurantId))) return;

  // Mark-before-send (mirror notifyPickupReady): atomic claim so a re-fire / duplicate 'new' write can't double-send.
  let claim;
  try { claim = await db.ref(`orders/${orderId}/order_received_notified_at`).transaction((cur) => (cur ? undefined : ServerValue.TIMESTAMP)); }
  catch (e) { console.warn(`orderReceived: claim failed ${orderId}`, e.message); return; }
  if (!claim.committed) return;                                        // already sent

  const body = (order.order_type === 'pickup')
    ? whatsapp.tplPickupReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, pickupTime: order.pickup_time || 'standard', trackingToken, restaurantId })
    : whatsapp.tplOrderReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, trackingToken, restaurantId });
  // R1#2: sendMessage RETURNS null on failure (invalid phone / no config / provider error) — it does NOT throw.
  // The marker is already committed (at-most-once, no auto-retry — same tradeoff as notifyPickupReady: a missed
  // order-received is a minor gap, a double is spam). So record a failed send instead of silently marking it sent.
  let res = null;
  try { res = await whatsapp.sendMessage(order.customer_phone, body, restaurantId); }
  catch (e) { console.error(`orderReceived: send threw ${orderId}`, e.message); }
  if (res == null) {
    try { await db.ref(`orders/${orderId}/order_received_send_unresolved_at`).set(ServerValue.TIMESTAMP); } catch (_) {}
    console.warn(`orderReceived: send unresolved (null) ${orderId} — marked for visibility, not retried`);
  }
  return;   // 'new' handled — don't fall through to the delivery/cancel logic
}
```
The write to `orders/{id}/order_received_notified_at` is a SIBLING of `/status`, so it does NOT re-trigger this function (the trigger watches `/status` only).

## Why this is safe / complete
- **No money-path change** — `pixelpay-confirm.js`/`materialize.js`/`createOrder` untouched; purely additive to an existing best-effort notification trigger. Fail-open (any error logged, order unaffected).
- **At-most-once** — the transaction claim on `order_received_notified_at` (mark-before-send) guarantees one send even if `status:'new'` is written more than once or the trigger redelivers.
- **No double-send with cash** — `payment_method==='online'` gate; online never goes through `createOrder`.
- **Covers scheduled online orders** — they release to `'new'`, hitting the same branch (the customer gets "received/preparing" at release, i.e. when the kitchen actually starts — acceptable; flag for the gate).
- **Per-restaurant** — routes via the loaded `order.restaurant_id` (same as the rest of the trigger); La Musa uses its own instance.
- **Guest/attribution unaffected** — this is server-side, keyed off the order's own `customer_phone`.

## Open questions for the gate
1. Scheduled online orders get "order received" at RELEASE (status→new), not at checkout/payment. Acceptable, or do scheduled online orders need a distinct "payment received, scheduled for HH:MM" message at confirm? (Proposal: acceptable for v1 — release is when it's live.)
2. Is `status:'new'` the ONLY entry to live, or can an online order reach a live/customer-visible state via another status without passing through `'new'`? (Believe no — buildMaterializeUpdates + scheduled release both go to `'new'`.)
3. Any online order where `createOrder` DID run (double-send risk)? (Believe no — online = chargeOnlineOrder only.)
4. Marker node `orders/{id}/order_received_notified_at`: any RTDB rule that would reject an admin write here, or any consumer that mis-reads an unknown order child? (Admin bypasses rules; new child is additive.)
