#!/usr/bin/env bash
# X Pizza — inject a test order via the createOrder HTTPS endpoint
#
# This mirrors what Make.com does in production: POSTs to the createOrder
# Cloud Function URL with bearer auth. The Cloud Function then writes the
# order, sends the WhatsApp "received" message, and the rest of the pipeline
# runs normally (auto-assign, push to driver, etc).
#
# Replaces the older direct-database-write test script — that bypassed
# createOrder entirely and meant the WhatsApp #1 was never tested.
#
# Usage:
#   ./test-order.sh                          # default test order
#   ./test-order.sh "Maria Lopez" 350        # custom name + total
#   ./test-order.sh "Maria Lopez" 350 1km    # location preset (1km / 3km / far)
#
# Reads MAKE_SECRET from xpizza-functions/.env automatically.
# Phone number for testing is hardcoded below — edit if you want to test
# WhatsApp delivery to a different phone.

set -e

CREATE_ORDER_URL="https://createorder-m7syoovdsa-uc.a.run.app"
ENV_FILE="$HOME/Downloads/xpizza-delivery/xpizza-functions/.env"

# Pull MAKE_SECRET from .env. The file format is plain `KEY=value` per line.
if [ ! -f "$ENV_FILE" ]; then
  echo "Cannot find .env file at $ENV_FILE"
  exit 1
fi
MAKE_SECRET=$(grep '^MAKE_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)
if [ -z "$MAKE_SECRET" ]; then
  echo "MAKE_SECRET not found in $ENV_FILE"
  exit 1
fi

# Defaults
CUSTOMER_NAME="${1:-TEST Cliente $(date +%H%M)}"
TOTAL="${2:-250}"
LOCATION_PRESET="${3:-1km}"

# Phone number for WhatsApp delivery -- edit this to YOUR test phone.
CUSTOMER_PHONE="+50494738243"

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

# Order ID. createOrder is idempotent on order_id so repeated runs with the
# same id are safe -- but we generate fresh ones to avoid conflicts during
# rapid-fire testing.
ORDER_ID="TEST-$(date +%Y%m%d-%H%M%S)-$RANDOM"

echo "Posting test order to createOrder Cloud Function:"
echo "  Order ID: $ORDER_ID"
echo "  Customer: $CUSTOMER_NAME"
echo "  Phone:    $CUSTOMER_PHONE"
echo "  Total:    L$TOTAL"
echo "  Location: $LOCATION_PRESET ($LAT, $LNG)"
echo ""

PAYLOAD=$(cat <<EOF
{
  "order_id": "${ORDER_ID}",
  "customer_name": "${CUSTOMER_NAME}",
  "customer_phone": "${CUSTOMER_PHONE}",
  "items_text": "Pizza pepperoni mediana (test)",
  "total": ${TOTAL},
  "lat": ${LAT},
  "lng": ${LNG},
  "address_detected": "${ADDRESS}",
  "address_details": "Casa azul (test)",
  "notes": "Test order via CLI",
  "maps_link": "https://maps.google.com/?q=${LAT},${LNG}",
  "payment_method": "Efectivo",
  "order_type": "delivery"
}
EOF
)

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST "$CREATE_ORDER_URL" \
  -H "Authorization: Bearer $MAKE_SECRET" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS:/d')
STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)

echo "Response (HTTP $STATUS):"
echo "$BODY"
echo ""

if [ "$STATUS" = "200" ]; then
  echo "Order accepted by createOrder. Watch for:"
  echo "  - WhatsApp #1 'Recibimos tu pedido' arriving on $CUSTOMER_PHONE"
  echo "  - Order in dispatcher console (SIN ASIGNAR for 30s, then auto-assign)"
  echo "  - Driver push notification"
  echo ""
  echo "Cleanup later:"
  echo "  firebase database:remove /orders/${ORDER_ID} --project xpizza-delivery --force"
  echo "  firebase database:remove /tasks/${ORDER_ID}_pickup --project xpizza-delivery --force"
  echo "  firebase database:remove /tasks/${ORDER_ID}_delivery --project xpizza-delivery --force"
else
  echo "createOrder rejected the request (HTTP $STATUS)"
  echo "Check logs: firebase functions:log --only createOrder --project xpizza-delivery -n 5"
fi
