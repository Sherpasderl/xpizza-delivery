'use strict';

/**
 * Seed /restaurants/{RID}/factura_config with TEMP (FACTURA DE PRUEBA) values so the whole
 * pipeline can be exercised before SAR issues X. Pizza's real CAI. Run ONCE.
 *
 * SAFETY (PLAN-manual-factura r3 §13, Codex #251-3): CREATE-ONLY. ONE transaction writes the TEMP config only when NO
 * factura_config exists; any existing node (a counter, the real CAI, factura_config/manual records) is refused and left
 * byte-identical. Never an unconditional .set on that parent. To go live, update fields individually (see FACTURA_PLAN
 * §11). Config via .env: FB_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS, RESTAURANT_ID.
 */

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

// create-only: the transaction writes only onto a null node (RTDB re-runs a speculative-null commit against the server
// value, so an existing config always reaches the `undefined` branch and aborts unchanged)
async function seedCreateOnly(db, rid) {
  const tx = await db.ref(`restaurants/${rid}/factura_config`).transaction((cur) => (cur === null ? TEMP_CONFIG : undefined));
  return tx.committed ? { created: true } : { created: false, reason: 'exists' };
}

async function main() {
  require('dotenv').config();
  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.FB_DATABASE_URL,
  });
  const r = await seedCreateOnly(admin.database(), RID);
  if (!r.created) {
    console.error(`ABORT: /restaurants/${RID}/factura_config already exists. Refusing to overwrite (create-only). Update fields individually instead.`);
    process.exit(1);
  }
  console.log(`Seeded /restaurants/${RID}/factura_config (is_temp=true, range ${RANGE_START}-${RANGE_END}).`);
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { seedCreateOnly, TEMP_CONFIG };
