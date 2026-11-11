'use strict';
// S1d (D4c-grill/item-s1/S1d-DESIGN.md + the advisor's rulings) — the WIRING of labels, fiscal descriptions and stored keys (static).
//   1. The two order endpoints refuse an opaque key with no label on a platform-factura restaurant (503 labels_unavailable)
//      right after the resolution stage — before any write — and price + describe factura lines from the SAME guarded tables
//      (labels and version).
//   2. The order records store the pricing version: the cash builder calls (immediate + held) and the charge's pending record.
//   3. The served item_keys map is on the ENDPOINT path only (never the overlay-free body the bake reads).
//   4. The slice's test-only inverse returns every pinned file it edits to its base byte for byte; same-line edits only.
// Behaviour is pinned by the S1d unit files and test/labels-routes.emulator.test.js. Run: node s1d-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => require('./tools/dpao-module-inverse').unapplyDpaoModule(f, require('./tools/zones-module-inverse').unapplyZonesModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8')));
const peelTip = (f, s) => (f === 'index.js' ? require('./tools/tippref-inverse').unapplyTipprefIndex(s) : s);   /* DRYRUN R-WIRE (2e asm5): tip C's tippref layer is newer than this pin's base — peeled first */
const src = read('index.js');
const STAGE = 'RL.resolveLines(restaurantId, body, pricingTables); if (!rl.ok) { const rf = RL.resolutionRefusal(rl); return res.status(rf.status).json(rf.body); }';
const GATE = " if (usesPlatformFactura(restaurantId) && RL.labelGap(body, pricingTables)) return res.status(503).json({ error: 'labels_unavailable', retryable: true }); }";

// ── 1 ──
{
  const ends = [["createOrderApp.all('*', async (req, res) => {", "chargeOnlineApp.all('*', async (req, res) => {"], ["chargeOnlineApp.all('*', async (req, res) => {", "confirmOnlineApp.all('*', async (req, res) => {"]];
  for (const [a, b] of ends) {
    const s = src.indexOf(a); const t = src.indexOf(b, s + a.length); assert.ok(s >= 0 && t > s, `anchor ${a}`);
    const body = src.slice(s, t);
    assert.strictEqual(body.split(STAGE + GATE).length - 1, 1, `🔴 S1DW-GATE ${a.slice(0, 14)}: the label gate follows the stage on the same line, once`);
    assert.ok(body.indexOf(STAGE + GATE) < body.indexOf('validateOrderPayload(body, restaurantId, pricingTables)'), `🔴 S1DW-GATE ${a.slice(0, 14)}: before any check or write`);
  }
  assert.strictEqual(src.split("pricedLineItems(body.items, facturaMenu, facturaExtras, require('./menu-pricing').labelsOfTables(pricingTables), menuOrderVersionOf(pricingTables))").length - 1, 2, '🔴 S1DW-FACTURA both non-redeem factura sites price and describe from the same guarded tables');
  ok('both order endpoints gate an unlabelled opaque key right after the stage; factura lines read the same tables\' labels and version');
}
// ── 2 ──
{
  assert.strictEqual(src.split('restaurantId, priceBreakdown, facturaPriced, cashTenderedCents, freeOrder, rewardStamp, menuVersionId: menuOrderVersionOf(pricingTables),').length - 1, 2, '🔴 S1DW-VERSION the immediate and the held cash orders store the pricing version');
  assert.strictEqual(src.split('cash_tendered_cents: 0, menu_version_id: menuOrderVersionOf(pricingTables),').length - 1, 1, '🔴 S1DW-VERSION the charge\'s pending record stores it');
  // codex S1d r1 #1: the reward stamp carries the free item's key into the summary
  assert.ok(src.includes("? freeItems.map((fi) => ({ name: fi.name || fi.item_id, qty: Number(fi.qty) || 1, ...(typeof fi.item_id === 'string' && fi.item_id ? { item_key: fi.item_id } : {}) }))"), '🔴 S1DW-FREE-KEY the free rows carry their key');
  ok('the cash (immediate + held) and charge records store the pricing version');
}
// ── 3 ──
{
  const pm = read('catalog/public-menu.js');
  const line = pm.split('\n').find((l) => l.includes('const enriched = deps.overlayIdentity === false ? { body, applied: true } :'));
  assert.ok(line && line.includes('withServedItemKeys(') && line.indexOf('withServedItemKeys(') > line.indexOf(': await applyIdentityToServedBody('), '🔴 S1DW-ENDPOINT item_keys are added on the endpoint path only');
  ok('item_keys are added on the endpoint path only (the bake\'s overlay-free body never carries them)');
}
// ── 4 ──
{
  const I = require('./tools/s1d-module-inverse');
  const BASE_SHA = {
    'catalog/catalog-firestore.js': '3c146cb02e98ca6bd98bd9344729d510e9d0ce8ccf5923d21595281f7b50b1b1',
    'catalog/catalog-publish.js': 'd782d1a9d2f4909eccf7cad706a6328acc7a015146afb6e7f2651216ff2c9a40',
    'catalog/catalog.js': '7e9edf09cb7fd47e654c4f20549f7e51114c943b09cce5a9aca85bcd3deb2790',
    'catalog/mirror-rtdb.js': 'f7f8dceb5965486113d7101357a8bd561217e83a0e81f3c9f5af890474bc6278',
    'catalog/pricing-tables.js': '252e33dbfa51e09a93d2e63bdedd1ffaf7c0a2e95d32dda949881e84a660b1a6',
    'catalog/snapshot-fallback.js': 'd4cb12959f277e3619133cba00acbebf693dc9edbc204fe8afaa8c1454f03293',
    'index.js': 'bbd9456ffb06f6fbd8b9ae29a19095a599af89611d6bbb88c5fafba7c72d432e',
    'menu-pricing.js': 'fc649044a111538f6f3657cceb9e8560da22a02da93c6a4dd6350ad1044c1aa0',
    'rewards-redeem-pricing.js': '5c027d19f8406f74d7df12fc36187ee696926e7839b8e5c0dfe630ae228aa8db',
    'catalog/public-menu.js': '1877c1ba0d4e6e4adde65594e29b6840313228b8223d9cede08e9a5747087be5',
    'create-order-build.js': '04ba4ad210cd2cca19b9cb237d1f78832cc3988410a0c1f0f412be0c95207219',
  };
  assert.deepStrictEqual([...I.FILES].sort(), Object.keys(BASE_SHA).sort(), 'S1DW-INVERSE the slice edits exactly these pinned files');
  for (const [f, want] of Object.entries(BASE_SHA)) {
    const now = peelTip(f, read(f));
    const back = I.unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, now));
    assert.strictEqual(crypto.createHash('sha256').update(Buffer.from(back, 'utf8')).digest('hex'), want, `🔴 S1DW-INVERSE ${f} round trip to a79f66c5`);
    assert.strictEqual(back.split('\n').length, now.split('\n').length, `🔴 S1DW-SAME-LINE ${f}: no line added`);
  }
  ok('the inverse returns each pinned file to a79f66c5 byte for byte; same-line edits only');
}
console.log(`\ns1d-wiring.guard: OK (${n})`);
