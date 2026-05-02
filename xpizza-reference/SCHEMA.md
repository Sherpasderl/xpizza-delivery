# X Pizza Delivery — Firebase Schema

Realtime Database structure for the in-house delivery operation. Replaces Onfleet.

## Top-level nodes

```
/dispatchers/{uid}                  — boolean flag, presence = dispatcher role
/drivers/{driver_uid}               — driver profile + live state
/tasks/{task_id}                    — pickup or delivery task
/orders/{order_id}                  — full order record (mirrors Sheet)
/config                             — restaurant coords, geofence, thresholds
```

---

## /dispatchers/{uid}

Just a presence map. If a UID is here, they have admin write access.

```json
{
  "Lk93jq...": true,
  "Pm44ab...": true
}
```

---

## /drivers/{driver_uid}

Driver profile + live state. UID matches Firebase Auth UID.

```json
{
  "name": "Hermez Talavera",
  "phone": "+50499999999",
  "active": true,
  "status": "available",
  "lat": 15.5074,
  "lng": -88.0398,
  "accuracy": 12,
  "heading": 145,
  "speed": 8.2,
  "last_ping": 1714579200000,
  "current_task_id": null,
  "shift_started_at": 1714579100000,
  "shift_ended_at": null,
  "arrived_at_restaurant_at": null
}
```

**status** enum: `off_shift | available | assigned | at_restaurant | en_route_delivery | returning | on_break`

State transitions (see `xpizza-delivery.js`):
- `off_shift` → `available` (driver taps Start Shift)
- `available` → `assigned` (dispatcher assigns + driver accepts)
- `assigned` → `at_restaurant` (geofence enter, no current_task)
- `at_restaurant` → `en_route_delivery` (geofence exit with current_task)
- `en_route_delivery` → `returning` (driver taps Delivered)
- `returning` → `at_restaurant` (geofence enter)
- any → `off_shift` (driver taps End Shift)

---

## /tasks/{task_id}

Pickup or delivery leg. Each order generates two tasks: one pickup at restaurant, one delivery to customer. They reference each other via `linked_task_id`. Delivery has `depends_on_task_id = pickup_task_id` (mirrors Onfleet linked-task model).

Task ID convention: `{order_id}_pickup` and `{order_id}_delivery`.

```json
{
  "order_id": "ORD-1730412345",
  "type": "delivery",
  "status": "assigned",
  "assigned_driver_id": "Lk93jq...",
  "linked_task_id": "ORD-1730412345_pickup",
  "depends_on_task_id": "ORD-1730412345_pickup",
  "destination_lat": 15.5132,
  "destination_lng": -88.0245,
  "destination_address": "Col. Trejo, 3 Calle...",
  "address_details": "Casa azul, portón negro",
  "recipient_name": "María Reyes",
  "recipient_phone": "+50498765432",
  "payment_method": "efectivo",
  "total": 450,
  "notes": "1x Margherita, 2x Pepperoni (extra queso)",
  "created_at": 1714579100000,
  "assigned_at": 1714579150000,
  "accepted_at": 1714579165000,
  "completed_at": null
}
```

**type** enum: `pickup | delivery`
**status** enum: `pending | assigned | accepted | in_progress | completed | cancelled`

---

## /orders/{order_id}

Full order record. Same shape as the Make.com webhook payload, plus task references and status.

```json
{
  "order_id": "ORD-1730412345",
  "customer_name": "María Reyes",
  "customer_phone": "+50498765432",
  "items": [...],
  "items_text": "1x Margherita, 2x Pepperoni (extra queso)",
  "total": 450,
  "lat": 15.5132,
  "lng": -88.0245,
  "maps_link": "https://maps.google.com/...",
  "address_detected": "Col. Trejo, 3 Calle...",
  "address_details": "Casa azul, portón negro",
  "payment_method": "efectivo",
  "order_type": "delivery",
  "pickup_time": null,
  "timestamp": "2026-05-01T19:18:00-06:00",
  "status": "out_for_delivery",
  "pickup_task_id": "ORD-1730412345_pickup",
  "delivery_task_id": "ORD-1730412345_delivery",
  "created_at": 1714579100000
}
```

**status** enum: `new | preparing | ready | out_for_delivery | delivered | cancelled`

---

## /config

```json
{
  "restaurant_lat": 15.507489753573818,
  "restaurant_lng": -88.0398486953722,
  "geofence_radius_m": 50,
  "stale_ping_threshold_s": 90,
  "ping_interval_ms": 10000
}
```

---

## Indexing notes

For query performance, add these `.indexOn` rules in `database.rules.json`:
- `tasks` indexed on `assigned_driver_id`, `order_id`, `status`
- `orders` indexed on `status`, `created_at`

(Already included in the rules file.)

## Why no driver location history node

We considered `/driver_locations/{driver_id}/{timestamp}` for breadcrumbs/trail rendering. Skipping in v1 — current position only. If we ever want trail playback for incident review, add it later as a capped node (last 1000 pings per driver via Cloud Function).
