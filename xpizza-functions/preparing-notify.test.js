'use strict';
// Fix A (preparing WhatsApp) — PURE unit tests: tplPreparing copy (both brands, both order types,
// readiness wording) + resolvePrepEtaMin (config value → minutes, single neutral fallback). Node-run,
// in the main npm chain. The TRIGGER's concurrency/failure/marker properties are proven separately by
// test/preparing-ready.emulator.test.js (owner-run).
// Run: node preparing-notify.test.js

// la_musa creds so trackingUrl resolves La Musa's own base (call-time env read), like the emulator test.
process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA = process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA || 'instanceTEST';
process.env.ULTRAMSG_TOKEN_LA_MUSA = process.env.ULTRAMSG_TOKEN_LA_MUSA || 'tokTEST';
process.env.TRACKING_BASE_LA_MUSA = process.env.TRACKING_BASE_LA_MUSA || 'https://track.lamusa.hn';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const whatsapp = require('./whatsapp');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── resolvePrepEtaMin: finite>0 → value; else the SINGLE neutral fallback ──
const RP = whatsapp.resolvePrepEtaMin;
assert.strictEqual(typeof RP, 'function', 'resolvePrepEtaMin exported');
assert.strictEqual(RP(20), 20, 'finite positive → itself');
assert.strictEqual(RP(30), 30, 'finite positive → itself');
const FB = RP(undefined);
assert.ok(Number.isFinite(FB) && FB > 0, 'absent → a finite positive fallback');
assert.strictEqual(RP(null), FB, 'null → fallback');
assert.strictEqual(RP(NaN), FB, 'NaN → fallback');
assert.strictEqual(RP(0), FB, '0 → fallback (not a usable ETA)');
assert.strictEqual(RP(-5), FB, 'negative → fallback');
assert.strictEqual(RP('20'), FB, 'non-number string → fallback (config must be a number)');
ok(`resolvePrepEtaMin: value/absent/NaN/≤0/non-number → number/fallback (${FB})`);

// The fallback must be a SINGLE neutral constant — the same regardless of brand context (it is a pure
// arg-only fn, so there is no brand input; this asserts the fn signature stays brand-blind).
assert.strictEqual(RP.length, 1, 'resolvePrepEtaMin takes ONLY the config value (no brand arg → brand-agnostic)');
ok('resolvePrepEtaMin is brand-blind (single arg)');

// ── tplPreparing: readiness wording, copy varies by order_type, both brands ──
const TP = whatsapp.tplPreparing;
assert.strictEqual(typeof TP, 'function', 'tplPreparing exported');

for (const rid of ['x_pizza', 'la_musa']) {
  // pickup
  const p = TP({ customerName: 'Ana', etaMinutes: 20, orderType: 'pickup', trackingToken: 'TK1', restaurantId: rid });
  assert.ok(p.includes('preparando'), `[${rid}] pickup: says preparando`);
  assert.ok(p.includes('~20 min'), `[${rid}] pickup: interpolates the ETA`);
  assert.ok(/listo para recoger/i.test(p), `[${rid}] pickup: readiness-for-pickup wording`);
  assert.ok(p.includes(whatsapp.brandFor(rid)) || p.includes(whatsapp.itemsEmojiFor(rid)), `[${rid}] pickup: brand-scoped chrome`);
  assert.ok(p.includes(whatsapp.trackingUrl('TK1', rid)), `[${rid}] pickup: tracking link when token present`);
  // NOT a dispatch/arrival promise
  assert.ok(!/sale hacia vos|en camino en ~|llega en ~|llegada/i.test(p), `[${rid}] pickup: no dispatch/arrival promise`);

  // delivery
  const d = TP({ customerName: 'Ana', etaMinutes: 30, orderType: 'delivery', trackingToken: 'TK2', restaurantId: rid });
  assert.ok(d.includes('preparando') && d.includes('~30 min'), `[${rid}] delivery: preparando + ETA`);
  assert.ok(/estará listo en ~30 min/i.test(d), `[${rid}] delivery: readiness wording (estará listo)`);
  assert.ok(/salga en camino/i.test(d), `[${rid}] delivery: promises the next update, not this ETA's arrival`);
  assert.ok(!/sale hacia vos|estará listo para recoger/i.test(d), `[${rid}] delivery: not pickup copy, no "sale hacia vos"`);
  assert.ok(d.includes(whatsapp.trackingUrl('TK2', rid)), `[${rid}] delivery: tracking link when token present`);
  ok(`${rid}: tplPreparing pickup + delivery (readiness, ETA, brand, link)`);
}

// tracking link OMITTED when no token (never build a URL from an absent token) — mirror tplPickupReady
const noTok = TP({ customerName: 'Ana', etaMinutes: 20, orderType: 'pickup', trackingToken: null, restaurantId: 'x_pizza' });
assert.ok(noTok.includes('preparando') && !/https?:\/\//.test(noTok), 'no token → message intact, no URL');
ok('tracking link omitted when token absent');

// ── config-driven: NO per-brand prep-eta literal in whatsapp.js (brand-agnostic tenet) ──
const src = fs.readFileSync(path.join(__dirname, 'whatsapp.js'), 'utf8');
// isolate the prep-eta code region and assert it doesn't branch on a brand id or hardcode 20/30
const region = src.slice(src.indexOf('function resolvePrepEtaMin'), src.indexOf('function resolvePrepEtaMin') + 400);
assert.ok(!/x_pizza|la_musa/.test(region), 'resolvePrepEtaMin does not branch on a brand id');
assert.ok(!/\b20\b|\b30\b/.test(region), 'resolvePrepEtaMin does not hardcode the seeded per-brand values');
ok('prep-ETA resolver is config-driven (no brand literal, no seeded value in code)');

console.log(`\npreparing-notify.test.js: ${n} passed`);
