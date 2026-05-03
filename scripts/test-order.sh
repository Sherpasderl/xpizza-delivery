#!/usr/bin/env bash
# X Pizza — inject a test order via Firebase CLI
#
# Bypasses Make.com and the order form's closed-hours guard. Writes directly
# to Firebase using the same shape the createOrder Cloud Function would.
# This triggers all downstream behavior: auto-assign, push notifications,
# timeout monitoring, etc.
#
# Usage:
#   ./test-order.sh                          # default test order
#   ./test-order.sh "Maria Lopez" 350        # custom name + total
#   ./test-order.sh "Maria Lopez" 350 1km    # location preset (1km / 3km / far)
#
# Requires: firebase CLI logged in to xpizza-delivery project.

set -e

PROJECT="xpizza-delivery"

# Defaults
CUSTOMER_NAME="${1:-TEST Cliente $(date +%H%M)}"
TOTAL="${2:-250}"
LOCATION_PRESET="${3:-1km}"

# Coordinate presets (relative to restaurant at 15.5075, -88.0398)
case "$LOCATION_PRESET" in
  1km)
    LAT="15.5135"; LNG="-88.0420"; ADDRESS="Test address ~1km de restaurante"
    ;;
  3km)
    LAT="15.5305"; LNG="-88.0480"; ADDRESS="Test address ~3km de restaurante"
    ;;
  far)
    LAT="15.5805"; LNG="-88.1000"; ADDRESS="Test address lejos del restaurante"
    ;;
  *)
    LAT="15.5135"; LNG="-88.0420"; ADDRESS="Test address (default)"
    ;;
esac

# Generate unique order ID — TEST prefix + timestamp + random
ORDER_ID="TEST-$(date +%Y%m%d-%H%M%S)-$RANDOM"
NOW_MS=$(date +%s)000

PICKUP_TASK_ID="${ORDER_ID}_pickup"
DELIVERY_TASK_ID="${ORDER_ID}_delivery"

# Restaurant coords (must match Cloud Function constants)
REST_LAT="15.507489753573818"
REST_LNG="-88.0398486953722"
REST_NAME="X. Pizza"
REST_PHONE="+50499999999"

echo "Injecting test order: $ORDER_ID"
echo "  Customer: $CUSTOMER_NAME"
echo "  Total:    L$TOTAL"
echo "  Location: $LOCATION_PRESET ($LAT, $LNG)"
echo ""

# Build the atomic write payload matching createOrder Cloud Function exactly
PAYLOAD=$(cat <<EOF
{
  "orders/${ORDER_ID}": {
    "order_id": "${ORDER_ID}",
    "customer_name": "${CUSTOMER_NAME}",
    "customer_phone": "+50488888888",
    "items_text": "Pizza pepperoni mediana (test)",
    "items_count": 1,
    "subtotal": ${TOTAL},
    "delivery_fee": 0,
    "total": ${TOTAL},
    "lat": ${LAT},
    "lng": ${LNG},
    "address_detected": "${ADDRESS}",
    "address_details": "Casa azul (test)",
    "notes": "Test order via CLI",
    "maps_link": "https://maps.google.com/?q=${LAT},${LNG}",
    "payment_method": "Efectivo",
    "order_type": "delivery",
    "status": "new",
    "pickup_task_id": "${PICKUP_TASK_ID}",
    "delivery_task_id": "${DELIVERY_TASK_ID}",
    "created_at": ${NOW_MS}
  },
  "tasks/${PICKUP_TASK_ID}": {
    "order_id": "${ORDER_ID}",
    "type": "pickup",
    "status": "pending",
    "assigned_driver_id": null,
    "linked_task_id": "${DELIVERY_TASK_ID}",
    "depends_on_task_id": null,
    "destination_lat": ${REST_LAT},
    "destination_lng": ${REST_LNG},
    "destination_address": "${REST_NAME}",
    "recipient_name": "${REST_NAME}",
    "recipient_phone": "${REST_PHONE}",
    "notes": "Pizza pepperoni mediana (test)",
    "created_at": ${NOW_MS}
  },
  "tasks/${DELIVERY_TASK_ID}": {
    "order_id": "${ORDER_ID}",
    "type": "delivery",
    "status": "pending",
    "assigned_driver_id": null,
    "linked_task_id": "${PICKUP_TASK_ID}",
    "depends_on_task_id": "${PICKUP_TASK_ID}",
    "destination_lat": ${LAT},
    "destination_lng": ${LNG},
    "destination_address": "${ADDRESS}",
    "address_details": "Casa azul (test)",
    "recipient_name": "${CUSTOMER_NAME}",
    "recipient_phone": "+50488888888",
    "payment_method": "Efectivo",
    "total": ${TOTAL},
    "notes": "Pizza pepperoni mediana (test)",
    "created_at": ${NOW_MS}
  }
}
EOF
)

# Write atomically to root with a multi-path update
# firebase database:update merges all paths in one atomic write, which is
# what the autoAssign trigger needs to fire correctly (all three records
# present when /orders/{orderId} create event fires).
# Write the payload to a temp file. firebase database:update with stdin (`-`)
# is broken in some firebase-tools versions (socket hangup); a real file works.
TMPFILE=$(mktemp /tmp/xpizza-test-order.XXXXXX.json)
echo "$PAYLOAD" > "$TMPFILE"

# Multi-path atomic update — all three records (order + pickup task +
# delivery task) write together in one operation so the autoAssign trigger
# fires with everything present.
firebase database:update / "$TMPFILE" --project $PROJECT --force

rm -f "$TMPFILE"

echo ""
echo "✅ Test order injected: $ORDER_ID"
echo ""
echo "Watch for behavior:"
echo "  - Dispatcher: order appears in SIN ASIGNAR"
echo "  - 30s grace, then auto-assign fires (if enabled)"
echo "  - Driver gets push, 60s acceptance countdown begins"
echo ""
echo "Cleanup later:"
echo "  firebase database:remove /orders/${ORDER_ID} --project $PROJECT --force"
echo "  firebase database:remove /tasks/${PICKUP_TASK_ID} --project $PROJECT --force"
echo "  firebase database:remove /tasks/${DELIVERY_TASK_ID} --project $PROJECT --force"
