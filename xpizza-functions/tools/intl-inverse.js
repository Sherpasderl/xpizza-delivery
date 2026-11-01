'use strict';
// INTL PHONE S-core steps 3–4 + S-match (PLAN-intl-phone r2.3; BUILD-ORDER-intl-core, CASE = FLAG) — the test-only index.js INVERSE. SAME-LINE
// hunks (no line inserted ⇒ no R3 call-site line shifts): on the createOrder and chargeOnlineOrder `validateOrderPayload(...)` lines,
// the flagged wire contract is appended AFTER the call; step 4: on requestOtp's `if (!pHash)` line, the per-sender login gate
// (phone/login-gate.js) is inserted before the line's trailing comment, answering a refusal with the same uniform response.
// S-match: onIncomingWhatsApp's STATUS_CHECK suffix match (3 lines, same count) → phone/match.js samePhone (full number).
// S-match (codex r1 #4): the auto-mute READ → phone/match.js readMute (identity + legacy last-8 leaf). Writer unchanged in index.js.
// (validateOrderPayload / sanitizePhone themselves untouched; the pinned seam text
// `validateOrderPayload(body, restaurantId, pricingTables)` intact). unapplyIntlIndex swaps every hunk back, so the result === the base
// index.js byte-for-byte (intl-wiring.guard). It is the NEWEST layer: every index.js chain and fold applies it FIRST (innermost),
// inside formsignal's.
const BASE = '8a31e2a3';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables); require('./phone/wire').applyWireContract(require('./phone/flag').phoneWireStrictNow(db), body, errors, fields);   // INTL S-core step 3 — the flagged wire contract (OFF = no-op) [create]\n",
  "was": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);\n"
 },
 {
  "file": "index.js",
  "now": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables); require('./phone/wire').applyWireContract(require('./phone/flag').phoneWireStrictNow(db), body, errors, fields);   // INTL S-core step 3 — the flagged wire contract (OFF = no-op) [charge]\n",
  "was": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);\n"
 },
 {
  "file": "index.js",
  "now": "      if (!pHash) return res.status(200).json({ ok: true, cooldown: 30 }); if (!(await require('./phone/login-gate').otpLoginAllowed({ db: getDatabase(), phone, restaurantId, strict: () => require('./phone/flag').phoneWireStrictNow(getDatabase()) }))) return res.status(200).json({ ok: true, cooldown: 30 });   // uniform — no enumeration (INTL S-core step 4: the per-sender login gate refuses uniformly)\n",
  "was": "      if (!pHash) return res.status(200).json({ ok: true, cooldown: 30 });   // uniform — no enumeration\n"
 },
 {
  "file": "index.js",
  "now": "          // Match the FULL number (handles +504, 504, or just 8-digit local) — INTL S-match: phone/match.js samePhone\n          if (!require('./phone/match').samePhone(o.customer_phone, fromPhoneRaw)) {   // null / invalid never matches\n            // (was a two-way last-8 suffix match, which let +502 9795-0000 see +504 9795-0000's order)\n",
  "was": "          // Match by suffix (handles +504, 504, or just 8-digit local)\n          if (!orderPhoneDigits.endsWith(fromPhoneRaw.slice(-8))\n              && !fromPhoneRaw.endsWith(orderPhoneDigits.slice(-8))) {\n"
 },
 {
  "file": "index.js",
  "now": "      const muteRec = await require('./phone/match').readMute(mdb, restaurantId, fromPhoneRaw);   // INTL S-match (codex r1 #4): the identity leaf + the legacy last-8 leaf, latest wins — no mute lost at deploy\n",
  "was": "      const muteRec = (await mdb.ref(`whatsapp_mute/${restaurantId}/${inbound.muteKeyFor(fromPhoneRaw)}`).once('value')).val();\n"
 }
]);
function unapplyIntlIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`intl-inverse: index.js: an intl hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, unapplyIntlIndex };
