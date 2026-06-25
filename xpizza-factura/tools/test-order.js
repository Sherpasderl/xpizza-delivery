'use strict';

/**
 * End-to-end harness (no PixelPay, no index.js changes): allocate a factura for a SAMPLE
 * order directly against the real RTDB via the tested helper. The running print_agent then
 * picks it up from /facturas and prints physical paper — exercising the WHOLE pipeline
 * (reserve number -> render -> print) exactly as the live DB trigger will, minus the trigger.
 *
 * Run on any machine with Firebase creds: node tools/test-order.js
 * (have print_agent.js running on the Surface to see paper come out.)
 */

require('dotenv').config();
const admin = require('firebase-admin');
const { allocateFacturaNumber } = require('../src/factura-helpers');

const RID = process.env.RESTAURANT_ID || 'x_pizza';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.FB_DATABASE_URL,
});
const db = admin.database();

// firebase-admin Ref already matches the interface factura-helpers expects
// (once('value')->{val}, set, update, transaction). No adapter needed.

const orderId = `PRUEBA-${Date.now()}`;
const order = {
  orderId,
  status: 'new',
  items: [
    { qty: 2, description: 'PIZZA PEPPERONI MEDIANA', line_gross_cents: 40000 },
    { qty: 1, description: 'COCA-COLA 600ML', line_gross_cents: 3000 },
    { qty: 1, description: 'PALITROQUES DE AJO', line_gross_cents: 9000 },
  ],
  total_cents: 52000, subtotal_cents: 45217, tax_cents: 6783,
  payment_method: 'cash', customer_name: 'CLIENTE DE PRUEBA',
  razon_social: '', rtn_cliente: '', cash_tendered_cents: 60000,
};

(async () => {
  const r = await allocateFacturaNumber(db, { restaurantId: RID, orderId, order, now: Date.now() });
  console.log('allocateFacturaNumber:', JSON.stringify(r, null, 2));
  console.log(r.ok
    ? `OK — factura written to /facturas/${RID}/${orderId}. The print agent should print it now.`
    : `NOT issued (${r.reason || r.skipped}).`);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
