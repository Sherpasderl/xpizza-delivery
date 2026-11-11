'use strict';
// OFFLINE ENVÍO CALCULATOR (advisor 2026-11-10, PLAN-delivery-pricing-app-only r0 §4): proposed bands + a hub + sample pins
// → the fee each pin would pay, through the SAME pure pricing the order path uses. Run: node tools/delivery-fee-calc.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./delivery-fee-calc');
const P = require('../delivery/delivery-pricing');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const HUB = { lat: 14.1, lng: -87.2 };
const KM_PER_DEG = (6371 * Math.PI) / 180;
const north = (km, extra = {}) => ({ label: `tb_${km}km`, lat: HUB.lat + km / KM_PER_DEG, lng: HUB.lng, ...extra });
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 5000 }, { max_km: 9, cents: 7000 }];
const run = (over = {}) => C.calculate({ bands: BANDS, free_delivery: false, hub: HUB, pins: [north(1.5), north(4.9), north(8.5), north(9.5)], ...over });

(async () => {
  await cell('FEECALC-BANDS-PRICE-BY-DISTANCE', (L) => {
    const r = run();
    assert.strictEqual(r.ok, true, `${L}: a valid proposal is priced`);
    assert.deepStrictEqual(r.rows.map((x) => [x.label, x.band, x.fee_cents]), [['tb_1.5km', 0, 3000], ['tb_4.9km', 1, 5000], ['tb_8.5km', 2, 7000], ['tb_9.5km', null, null]], `${L}: each pin takes the first band whose max_km covers it`);
    assert.strictEqual(r.rows[3].refusal, 'outside_delivery_bands', `${L}: a pin beyond the last band is refused, never priced`);
    assert.ok(Math.abs(r.rows[1].km - 4.9) < 0.01, `${L}: km is the straight-line distance (got ${r.rows[1].km})`);
  });

  await cell('FEECALC-SAME-AS-THE-ORDER-PATH', (L) => {
    const r = run();
    const pricing = P.readPricing({ policy_version: 1, bands: BANDS, restaurants: { tb_r1: { active: true, free_delivery: false } } }, 'tb_r1');
    for (const row of r.rows) {
      const q = P.quoteDelivery({ pricing, hub: HUB, mode: 'delivery', pin: { lat: row.lat, lng: row.lng, confirmed: true }, customerUid: null });
      assert.deepStrictEqual([row.fee_cents, row.refusal || null], q.ctx ? [q.ctx.delivery_cents, null] : [null, q.refusal], `${L}: ${row.label} matches quoteDelivery`);
    }
  });

  await cell('FEECALC-FREE-DELIVERY-MEMBERS-ONLY', (L) => {
    const off = run().rows[0], on = run({ free_delivery: true }).rows[0];
    assert.deepStrictEqual([off.guest_pays_cents, off.member_pays_cents], [3000, 3000], `${L}: without the promo everyone pays the fee`);
    assert.deepStrictEqual([on.guest_pays_cents, on.member_pays_cents], [3000, 0], `${L}: with the promo a member pays 0, a guest still pays`);
  });

  await cell('FEECALC-APP-RADIUS-CAP', (L) => {
    const r = run({ radius_km: 5 });
    assert.deepStrictEqual(r.rows.map((x) => x.refusal || null), [null, null, 'outside_delivery_bands', 'outside_delivery_bands'], `${L}: the app's coverage is min(last band, the restaurant radius)`);
    assert.strictEqual(r.max_km, 5, `${L}: the reported coverage`);
    assert.strictEqual(run().max_km, 9, `${L}: no radius → the last band`);
  });

  await cell('FEECALC-INVALID-BANDS-FAIL-CLOSED', (L) => {
    for (const bands of [[], [{ max_km: 6, cents: 5000 }, { max_km: 3, cents: 3000 }], [{ max_km: 3, cents: 30.5 }], [{ max_km: 3, cents: -1 }], [{ max_km: 0, cents: 0 }], 'x']) {
      const r = run({ bands });
      assert.deepStrictEqual([r.ok, r.error, r.rows], [false, 'bands_invalid', undefined], `${L}: ${JSON.stringify(bands)} is refused with no prices`);
    }
  });

  await cell('FEECALC-BAD-INPUT-REFUSED', (L) => {
    assert.deepStrictEqual(run({ hub: { lat: 'x', lng: 1 } }), { ok: false, error: 'hub_invalid' }, `${L}: a hub without coordinates`);
    assert.deepStrictEqual(run({ pins: 'x' }), { ok: false, error: 'pins_invalid' }, `${L}: pins must be a list`);
    assert.deepStrictEqual(run({ radius_km: -2 }), { ok: false, error: 'radius_invalid' }, `${L}: a radius must be a positive number`);
    const r = run({ pins: [{ label: 'tb_bad', lat: 999, lng: 0 }] });
    assert.strictEqual(r.rows[0].refusal, 'pin_required', `${L}: a pin with impossible coordinates is refused as the order path would`);
  });

  await cell('FEECALC-CLI-OFFLINE', (L) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-feecalc-'));
    const f = path.join(d, 'in.json');
    fs.writeFileSync(f, JSON.stringify({ bands: BANDS, free_delivery: true, hub: HUB, pins: [north(1.5)] }));
    const ok = spawnSync(process.execPath, [path.join(__dirname, 'delivery-fee-calc.js'), f], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, `${L}: exit 0 (stderr ${ok.stderr})`);
    assert.match(ok.stdout, /tb_1\.5km\s.*L 30\.00.*L 0\.00/, `${L}: one line per pin, fee in lempiras, guest and member`);
    fs.writeFileSync(f, JSON.stringify({ bands: [], hub: HUB, pins: [] }));
    const bad = spawnSync(process.execPath, [path.join(__dirname, 'delivery-fee-calc.js'), f], { encoding: 'utf8' });
    assert.deepStrictEqual([bad.status, bad.stdout], [1, ''], `${L}: an invalid proposal exits 1 and prints no prices`);
    const src = fs.readFileSync(path.join(__dirname, 'delivery-fee-calc.js'), 'utf8');
    assert.deepStrictEqual([...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort(), ['../delivery/delivery-pricing', 'fs'], `${L}: no database, network or admin module`);
    fs.rmSync(d, { recursive: true, force: true });
  });

  if (fails.length) { console.log(`FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`OK (${n})`);
})();
