'use strict';

/**
 * First-print bring-up: render a sample FACTURA DE PRUEBA straight to the USB printer,
 * bypassing Firebase entirely. Use this to confirm the printer + Zadig/WinUSB + VID/PID
 * are working BEFORE wiring the live RTDB agent. Run on the Surface: node tools/print-sample.js
 */

require('dotenv').config();
const usb = require('usb');
const { renderFactura } = require('../src/escpos');

const VID = parseInt(process.env.USB_VID || '0x04B8', 16);
const PID = parseInt(process.env.USB_PID || '0x0202', 16);

const record = {
  restaurant_name: 'X PIZZA', legal_name: 'SHERPA S. DE R.L.', rtn: '05019024114145',
  address_1: 'BLVD. LOS PROCERES, 1RA CALLE, 20 AVE. N.O.',
  address_2: 'SAN PEDRO SULA, CORTES, HONDURAS',
  email: 'sherpasderl@gmail.com', phone: '(504) 9373-6607 / 9251-0352',
  cai_code: 'TEMP-CAI-PENDIENTE-SAR', factura_number: '000-001-01-00000001',
  pedido: 'PRUEBA-1', fecha: '25/06/2026', hora: '07:24:16 PM', cliente: '', rtn_cliente: '',
  items: [
    { qty: 2, description: 'PIZZA PEPPERONI MEDIANA', desc_pct: 0, base_cents: 34783 },
    { qty: 1, description: 'COCA-COLA 600ML', desc_pct: 0, base_cents: 2608 },
  ],
  desc_general_pct: 0, desc_rebaja_cents: 0, exonerado_cents: 0, exento_cents: 0,
  gravado_15_cents: 37391, gravado_18_cents: 0, isv_15_cents: 5609, isv_18_cents: 0,
  subtotal_cents: 37391, isv_total_cents: 5609, total_cents: 43000,
  forma_de_pago_label: 'EFECTIVO', cambio_cents: 7000,
  fecha_limite: '20/11/2026', rango_desde: '000-001-01-00000001', rango_hasta: '000-001-01-00008000',
  is_temp: true,
};

const device = usb.findByIds(VID, PID);
if (!device) {
  console.error(`Printer not found (VID=0x${VID.toString(16)} PID=0x${PID.toString(16)}). Check Zadig + the SP-variant PID.`);
  process.exit(1);
}
device.open();
const iface = device.interfaces[0];
iface.claim();
const out = iface.endpoints.find((e) => e.direction === 'out');
out.transfer(renderFactura(record, 2), (err) => {
  iface.release(true, () => device.close());
  if (err) { console.error('print failed:', err.message); process.exit(1); }
  console.log('Sample factura sent (2 copies). Check the paper.');
});
