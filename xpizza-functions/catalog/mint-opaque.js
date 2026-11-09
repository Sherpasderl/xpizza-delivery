'use strict';
// ---------------------------------------------------------------------------
// S1c (PLAN-portal-item-edit r6 §2.3; D4c-grill/item-s1/S1c-DESIGN.md + the owner addenda 2026-11-09) — the ONE platform switch
// for OPAQUE MINTING. ON: a new product's pricing key is `i_` + 12 random [a-z2-7], never derived from its name. Every restaurant
// together; flipped ONCE, by the owner (a one-line commit + a scoped functions deploy), and only after ALL of:
//   1. S1d is deployed (labels, factura descriptions, stored keys);
//   2. S3 is deployed (clients send item_key; the native floor is raised);
//   3. the owner has approved the La Musa POS evidence (a renamed item, a new opaque item, extras and a redemption through
//      Soft Restaurant's receiving workflow).
// If it is ever set back to false in an emergency, products already minted keep working: their keys are recorded in
// frozen_keys, which validation, the build and pricing accept whatever this switch says.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const MINT_OPAQUE = false;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function mintCapabilities() {
  return { enabled: MINT_OPAQUE === true };
}

// 12 symbols × 5 bits = 60 random bits.
function mintKey(randomBytes = crypto.randomBytes) {
  const b = randomBytes(8);
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]);
  v >>= 4n;
  let out = '';
  for (let i = 0; i < 12; i++) { out = ALPHABET[Number(v & 31n)] + out; v >>= 5n; }
  return `i_${out}`;
}

module.exports = { mintCapabilities, mintKey };
