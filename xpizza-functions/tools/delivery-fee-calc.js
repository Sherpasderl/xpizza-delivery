'use strict';
// OFFLINE ENVÍO CALCULATOR (advisor 2026-11-10, PLAN-delivery-pricing-app-only r0 §4). Before a restaurant is switched ON, the
// owner checks a proposed band table against real places: every pin is priced by the SAME pure functions the order path uses
// (delivery/delivery-pricing.js readPricing + quoteDelivery), so a proposal the server would refuse is refused here too.
// No database, no network: the hub and the pins come from the input file.
//
//   node tools/delivery-fee-calc.js proposal.json
//   proposal.json = { bands: [{ max_km, cents }, …], free_delivery: bool, hub: { lat, lng }, radius_km?: number,
//                     pins: [{ label, lat, lng }, …] }
// radius_km: the restaurant's own delivery radius — the app's coverage is min(last band, radius_km), as quoteDeliveryFor.
const fs = require('fs');
const P = require('../delivery/delivery-pricing');

const PREVIEW_RID = 'preview';
const PREVIEW_MEMBER = 'preview-member';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// → { ok: false, error } | { ok: true, max_km, rows: [{ label, lat, lng, km, band, fee_cents, guest_pays_cents, member_pays_cents, refusal? }] }
function calculate({ bands, free_delivery = false, hub, pins, radius_km } = {}) {
  const pricing = P.readPricing({ policy_version: 1, bands, restaurants: { [PREVIEW_RID]: { active: true, free_delivery: free_delivery === true } } }, PREVIEW_RID);
  if (!pricing || pricing.invalid) return { ok: false, error: 'bands_invalid' };
  if (!hub || !isNum(hub.lat) || !isNum(hub.lng)) return { ok: false, error: 'hub_invalid' };
  if (!Array.isArray(pins)) return { ok: false, error: 'pins_invalid' };
  if (radius_km !== undefined && !(isNum(radius_km) && radius_km > 0)) return { ok: false, error: 'radius_invalid' };
  const last = pricing.bands[pricing.bands.length - 1].max_km;
  const maxKm = radius_km === undefined ? last : Math.min(last, radius_km);
  const rows = pins.map((p, i) => {
    const pin = { lat: p && p.lat, lng: p && p.lng, confirmed: true };
    const label = p && typeof p.label === 'string' && p.label ? p.label : `pin${i + 1}`;
    const guest = P.quoteDelivery({ pricing, hub, mode: 'delivery', pin, customerUid: null, maxKm });
    const member = P.quoteDelivery({ pricing, hub, mode: 'delivery', pin, customerUid: PREVIEW_MEMBER, maxKm });
    const km = isNum(pin.lat) && isNum(pin.lng) ? Math.round(P.haversineKm(hub.lat, hub.lng, pin.lat, pin.lng) * 1000) / 1000 : null;
    if (guest.refusal) return { label, lat: pin.lat, lng: pin.lng, km, band: null, fee_cents: null, guest_pays_cents: null, member_pays_cents: null, refusal: guest.refusal };
    return { label, lat: pin.lat, lng: pin.lng, km, band: guest.ctx.band, fee_cents: guest.ctx.delivery_cents,
      guest_pays_cents: P.netDeliveryCents(guest.ctx), member_pays_cents: P.netDeliveryCents(member.ctx) };
  });
  return { ok: true, max_km: maxKm, rows };
}

const lps = (c) => `L ${(c / 100).toFixed(2)}`;

function main(argv) {
  let input;
  try { input = JSON.parse(fs.readFileSync(argv[0], 'utf8')); } catch (e) { process.stderr.write(`cannot read the proposal: ${e.message}\n`); return 1; }
  const r = calculate(input);
  if (!r.ok) { process.stderr.write(`refused: ${r.error}\n`); return 1; }
  const out = [`coverage ${r.max_km} km · ${r.rows.length} pin(s) · columns: pin, km, band, fee, guest pays, member pays`];
  for (const x of r.rows) {
    out.push(x.refusal ? `${x.label}\t${x.km === null ? '-' : x.km}\trefused: ${x.refusal}`
      : `${x.label}\t${x.km}\tband ${x.band + 1}\t${lps(x.fee_cents)}\t${lps(x.guest_pays_cents)}\t${lps(x.member_pays_cents)}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { calculate };
