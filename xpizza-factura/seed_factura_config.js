'use strict';

/**
 * Seed /restaurants/{RID}/factura_config with TEMP (FACTURA DE PRUEBA) values so the whole
 * pipeline can be exercised before SAR issues X. Pizza's real CAI. Run ONCE.
 *
 * SAFETY: self-aborts if a live counter exists (seq.last_reserved >= range_start) so it can
 * never clobber issued numbers. To go live, update fields individually (see FACTURA_PLAN §11),
 * do NOT re-run this. Config via .env: FB_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS, RESTAURANT_ID.
 */

require('dotenv').config();
const admin = require('firebase-admin');

const RID = process.env.RESTAURANT_ID || 'x_pizza';
const RANGE_START = 1;
const RANGE_END = 8000;

// TEMP placeholder values — replace with real SAR values at go-live.
const TEMP_CONFIG = {
  restaurant_name: 'X PIZZA',
  legal_name: 'SHERPA S. DE R.L.',
  rtn: '05019024114145',
  address_1: 'BLVD. LOS PROCERES, 1RA CALLE, 20 AVE. N.O.',
  address_2: 'SAN PEDRO SULA, CORTES, HONDURAS',
  email: 'sherpasderl@gmail.com',
  phone: '(504) 9373-6607 / 9251-0352',
  cai_code: 'TEMP-CAI-PENDIENTE-SAR',
  establecimiento: '000',
  punto: '001',
  tipo: '01',
  prefix: '000-001-01',
  range_start: RANGE_START,
  range_end: RANGE_END,
  fecha_limite: '2026-12-31', // ISO YYYY-MM-DD
  is_temp: true,
  stamp_preview: '*** FACTURA DE PRUEBA ***',
  seq: { last_reserved: RANGE_START - 1, pending: {} },
};

async function main() {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.FB_DATABASE_URL,
  });
  const ref = admin.database().ref(`restaurants/${RID}/factura_config`);
  const existing = (await ref.once('value')).val();

  if (existing && existing.seq && existing.seq.last_reserved >= RANGE_START) {
    console.error(`ABORT: live counter present (seq.last_reserved=${existing.seq.last_reserved}). Refusing to clobber. Update fields individually instead.`);
    process.exit(1);
  }

  await ref.set(TEMP_CONFIG);
  console.log(`Seeded /restaurants/${RID}/factura_config (is_temp=true, range ${RANGE_START}-${RANGE_END}).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
