'use strict';
// Portal 1D · D4-P1 — THE GENERATOR FOR THE MONEY CONTROL (§8a). Kept for provenance, NOT run by CI.
//
// 🔴 WHY THIS EXISTS. `catalog/d4p1-money-precontrol.golden.json` had NO GENERATOR. Its provenance
// assertion only checks that `captured_from` LOOKS LIKE a sha, so an independent reviewer could not
// establish the file was produced from the real producers rather than typed by hand — and it was partly
// typed: the `reward` entries are hand-trimmed subsets of what `computeRedemption` actually returns
// (la_musa's real freeItems carry `cost_pts`; the golden's do not). The ORDER control has a real
// generator (test/d4p1-capture-order-control.js) and is reproducible; the money one was not.
//
// 🔴 THIS MUST NEVER BE RE-RUN TO OVERWRITE THE COMMITTED GOLDEN. Same rule as the order capture: the
// golden froze pre-P1 values at dc7d9f7, and regenerating it against current code would make the control
// agree with whatever the code now does, which is the one thing a control exists to refuse. Run it to a
// TEMP FILE and DIFF. A diff in the money values means either a real regression or a catalog price change
// — and the two are told apart by looking at whether `input.tables` moved.
//
//   CAPTURE_OUT=/tmp/money.json node test/d4p1-capture-money-control.js
//   # then compare against catalog/d4p1-money-precontrol.golden.json
//
// 🔴 VERIFIED 2026-09-26: EVERY MONEY VALUE REPRODUCES — total, net_plain, net_reward, redemption,
// factura and sensitivity_dearer_total, for both brands, plus input.tables and x_pizza's input.cart.
// So the committed control is DERIVED, not typed, which is what could not be established before.
//
// ONE KNOWN, COSMETIC DIFFERENCE, recorded rather than papered over: the committed golden's la_musa cart
// carries the SLUG in its `name` field ("dimsum_01") where the catalog's display name is "Sichuan Spicy
// Wonton". This generator emits the display name, because that is what a real client sends. It changes no
// money: la_musa prices by ID, which is exactly why all its values still reproduce. Do not "fix" the
// golden to match — it is a pre-P1 capture and its inputs are frozen; this note is the explanation a
// future diff needs.
//
// 🔴 IT IS OFFLINE AND DETERMINISTIC, DELIBERATELY. Unlike the order capture it needs no emulator and no
// handler: every money producer here is a pure function of (cart, tables, reward), and the catalog
// snapshot is built from the repo's own seeds. So reproducibility can be audited from a checkout alone,
// which is the property finding 3 was actually asking for. The cost is that it does NOT exercise the
// handler path — that is the emulator control's job (test/d4p1-money-noop.emulator.test.js), and the
// reward path beyond `computeRedemption` remains uncovered by BOTH; see the coverage note in the
// unit control.
const { execSync } = require('child_process');
const { writeFileSync } = require('fs');

const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { computeServerTotal } = require('../menu-pricing');
const { computeServerNet } = require('../compute-server-net');
const { pricedLineItems } = require('../factura/pricing');
const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
const { computeRedemption } = require('../rewards-redeem');

const OUT = process.env.CAPTURE_OUT;
if (!OUT) {
  console.error('usage: CAPTURE_OUT=/tmp/money.json node test/d4p1-capture-money-control.js');
  console.error('       🔴 do NOT point CAPTURE_OUT at catalog/d4p1-money-precontrol.golden.json');
  process.exit(1);
}
if (/d4p1-money-precontrol\.golden\.json$/.test(OUT)) {
  console.error('REFUSED: CAPTURE_OUT names the committed control. Regenerating it would make the control');
  console.error('agree with current code, which is what it exists to refuse. Write to a temp file and diff.');
  process.exit(2);
}

const json = (v) => JSON.parse(JSON.stringify(v));
/* Keys SORTED so a reproduction differs only when a VALUE differs. The committed golden's x_pizza menu
   has the same 24 entries in a different order — comparing raw JSON would report a difference that is
   not a difference. */
const sortedObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/* THE TABLES, AS THE SERVER WOULD SERVE THEM. Shaped exactly like resolvePricingTables' contract
   ({ restaurantId, menu, extras }) and keyed the way each brand keys: x_pizza by NAME, la_musa by ID. */
function tablesFor(rid) {
  const snap = catalogSnapshot(rid);
  const byId = rid === 'la_musa';
  const menu = {}; for (const it of snap.items) menu[byId ? it.display.id : it.key] = it.price;
  const extras = {}; for (const ex of snap.extras) extras[byId ? ex.display.id : ex.key] = ex.price;
  return { restaurantId: rid, menu: sortedObj(menu), extras: sortedObj(extras) };
}

/* THE CART, FROM THE CATALOG — BUT SELECTED BY NAME, NOT BY INDEX.
   🔴 MY FIRST VERSION PICKED `snap.items[0]` AND `[1]` AND DID NOT REPRODUCE THE GOLDEN. It priced
   Carnivora + Crispy Bacon where the capture had priced Sopressatta Chili Honey + Carnivora, so every
   money value differed — and NOT because money had moved. A generator that selects fixtures POSITIONALLY
   is not reproducible: any catalog reordering silently re-points it at different dishes, and the diff
   then reports a regression that does not exist.
   So the selection is an explicit, recorded INPUT CHOICE — the one the pre-P1 capture made. Changing a
   name here invalidates every comparison against the committed control; that is the point of naming them.
   The prices still come from the catalog, so a real price change shows up as a value difference. */
const CONTROL_CART = {
  x_pizza: { lines: [['Sopressatta Chili Honey', 2], ['Carnivora', 1]], extra: 'Salsa Roja', redeem: 'Carnivora' },
  la_musa: { lines: [['dimsum_01', 2]], extra: 'rice_white', redeem: 'dimsum_01' },
};

function cartFor(rid) {
  const snap = catalogSnapshot(rid);
  const spec = CONTROL_CART[rid];
  const byId = rid === 'la_musa';
  const findItem = (nm) => {
    const rec = snap.items.find((it) => (byId ? it.display.id : it.key) === nm || it.display.name === nm);
    if (!rec) throw new Error(`${rid}: the control cart names ${JSON.stringify(nm)} and the catalog no longer has it — the control's inputs are stale, which is a different problem from money moving`);
    return rec;
  };
  const e0 = snap.extras.find((ex) => (byId ? ex.display.id : ex.key) === spec.extra || ex.display.name === spec.extra);
  if (!e0) throw new Error(`${rid}: the control cart names extra ${JSON.stringify(spec.extra)} and the catalog no longer has it`);
  const line = (rec, qty, extras) => (byId
    ? { id: rec.display.id, name: rec.display.name, cat: rec.display.cat, qty, price: rec.price, extras }
    : { name: rec.display.name, qty, price: rec.price, extras });
  return spec.lines.map(([nm, qty], i) => line(findItem(nm), qty, i === 0
    ? [byId ? { id: e0.display.id, name: e0.display.name, price: e0.price, qty: 1 }
             : { instance: 0, name: e0.display.name, price: e0.price }]
    : []));
}

/* THE REDEEM REQUEST — an INPUT, frozen here, so the reward is RESOLVED by the real producer rather than
   supplied already-resolved.
   🔴 THE TARGET IS NAMED, NOT POSITIONAL, for the same reason the cart lines are. My first version took
   `cart[1]` — which is undefined for la_musa, whose control cart has a single line, and which would have
   silently re-pointed at a different dish for x_pizza if the lines were ever reordered. Positional
   selection in a control fixture is the defect twice over. */
function redeemFor(rid) {
  const target = CONTROL_CART[rid].redeem;
  return rid === 'la_musa'
    ? { type: 'points_ala_carte', items: [{ id: target, qty: 1 }] }
    : { type: 'free_pizza_choice', item_id: target };
}

const out = {
  _provenance: {
    captured_from: execSync('git rev-parse HEAD').toString().trim(),
    generator: 'test/d4p1-capture-money-control.js',
    what: 'MONEY control for D4-P1 (§8a), derived from the real producers. OFFLINE and DETERMINISTIC: '
        + 'tables and cart come from the repo catalog snapshot, the reward from computeRedemption. '
        + 'Never regenerate over the committed control — run to a temp file and diff.',
  },
  brands: {},
};

for (const rid of ['x_pizza', 'la_musa']) {
  const tables = tablesFor(rid);
  const cart = cartFor(rid);
  const redeem = redeemFor(rid);
  const reward = computeRedemption({ redeem, items: json(cart), restaurantId: rid });
  if (!reward || reward.ok !== true) throw new Error(`${rid}: the reward did not resolve: ${JSON.stringify(reward)}`);

  const total = json(computeServerTotal(json(cart), rid, tables));
  const dearer = json(cart); dearer[0].qty += 1;

  out.brands[rid] = {
    input: { cart, redeem, reward: json(reward), tables },
    total,
    net_plain: json(computeServerNet({ items: json(cart), reward: null, rid, tables })),
    net_reward: json(computeServerNet({ items: json(cart), reward: json(reward), rid, tables })),
    redemption: json(applyRedemptionToPricing({ items: json(cart), restaurantId: rid, redemption: json(reward), totalLempiras: total.total, tables })),
    sensitivity_dearer_total: json(computeServerTotal(dearer, rid, tables)),
  };
  if (rid === 'x_pizza') out.brands[rid].factura = json(pricedLineItems(json(cart), tables.menu, tables.extras));
}

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log('MONEY CAPTURE OK ->', OUT);
console.log('now DIFF it against catalog/d4p1-money-precontrol.golden.json — do not overwrite that file');
