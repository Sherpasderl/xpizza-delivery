// practica-fixture.js — the SYNTHETIC demo order for the Inicio-c practica demo. DATA ONLY. The brand is the
// registry-only THIRD merchant 'synthetic_3' (name 's3') — the repo's canonical synthetic brand, defined at
// xpizza-functions/test/client-floor-cli.emulator.test.js — kept here as DATA so the demo controller holds no
// literal brand (Codex r1 #5). Everything here is inert: no RTDB, no real order, never X. Pizza / La Musa.
export const SYNTHETIC_DEMO_BRAND = { restaurant_id: 'synthetic_3', restaurant_display_name: 's3' };

// Build the demo order around the driver's restaurant anchor (passed in; the controller passes XPD.RESTAURANT). Cash,
// so the demo exercises cobrar + vuelto. A fixed id/display so nothing collides with a real order.
export function practicaDemoOrder(restaurant) {
  const R = restaurant && Number.isFinite(restaurant.lat) ? restaurant : { lat: 15.5074, lng: -88.0398 };
  const cx = R.lat + 0.012, cy = R.lng - 0.012;
  return {
    orderId: 'practica-demo',
    pickupTask: { destination_lat: R.lat, destination_lng: R.lng, destination_address: 'Local de ejemplo' },
    deliveryTask: { destination_lat: cx, destination_lng: cy, destination_address: 'Col. de ejemplo, casa 00', recipient_name: 'Cliente de ejemplo' },
    order: {
      customer_name: 'Cliente de ejemplo', customer_phone: '', payment_method: 'cash', total: 350, cash_tendered_cents: 40000,
      display_number: '00', restaurant_id: SYNTHETIC_DEMO_BRAND.restaurant_id, restaurant_display_name: SYNTHETIC_DEMO_BRAND.restaurant_display_name,
      address_detected: 'Col. de ejemplo, casa 00', items_text: 'pizza de ejemplo, bebida de ejemplo', lat: cx, lng: cy,
    },
  };
}
