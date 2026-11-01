'use strict';
// PLAN-avail-identity r1 — the restaurant's AVAILABILITY IDENTITY served as data: body.avail_identity = { field } in the public menu,
// from the ONE rule the server uses (menu-pricing.js availIdentityField, which itemPricingKey reads through). The customer app maps
// /restaurants/{rid}/item_availability/{availKey(dish[field])} onto its dishes. Catalogs: the code-seeded x_pizza / la_musa (the rule
// is brand-keyed); the pure matrix adds synthetic tb_ brands and O1b branch rids. Run: node catalog/avail-identity.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildPublicMenu, REPRESENTATION_VERSION, BODY_CONTRACT } = require('./public-menu');
const MP = require('../menu-pricing');
const { availKey } = require('../avail-key');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('avail-identity: FAILED — exited without completing'); process.exitCode = 1; } });
const known = new Set(['x_pizza', 'la_musa']);
const active = { isActive: async () => true };
async function seeded(rid) {
  const db = makeDb();
  const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'avail-id' });
  await publishVersion(db, rid, input, { expected });
  return db;
}

// 🔒 FROZEN: itemPricingKey EXACTLY as it was at origin/main 8a31e2a3 (menu-pricing.js:144-154), verbatim — the reference the refactor
// must equal. Never "fix" or re-derive this copy; it is the pre-change behaviour.
const PRICING_KEY_STAMP = Symbol.for('xpizza.d4.pricingKeyStamp');
function frozenItemPricingKey(item, restaurantId) {
  const raw = restaurantId === 'la_musa' ? (item && item.id) : (item && item.name);
  if (item && typeof item === 'object') {
    const stamped = item[PRICING_KEY_STAMP];
    if (typeof stamped === 'string' && stamped) return stamped;
  }
  return raw;
}

// each form's AVAIL_IDENTITY, read from its HTML; only the exact `return item.<f>;` shape is accepted (anything else fails closed)
function formAvailField(rel) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  const all = [...html.matchAll(/function AVAIL_IDENTITY\(item\)\s*\{\s*return item\.([A-Za-z_]+);\s*\}/g)];
  const any = (html.match(/function AVAIL_IDENTITY\b/g) || []).length;
  assert.ok(all.length === 1 && any === 1, `AVAIL-ID-FORM-SHAPE ${rel}: expected exactly one \`function AVAIL_IDENTITY(item){ return item.<field>; }\` (got ${all.length} plain / ${any} total) — the form's rule changed shape; review it`);
  return all[0][1];
}

(async () => {
  // ── 1. FROZEN EQUIVALENCE (Codex P2-2): the refactored itemPricingKey == the pre-change copy, across the whole matrix ──
  assert.strictEqual(MP.PRICING_KEY_STAMP, PRICING_KEY_STAMP, 'premise: the same stamp symbol');
  const stamp = (o, v) => Object.assign(o, { [PRICING_KEY_STAMP]: v });
  const ITEMS = [
    ['id≠name', () => ({ id: 'tb-id-1', name: 'TB Dish' })], ['only id', () => ({ id: 'tb-id-2' })], ['only name', () => ({ name: 'TB Only Name' })],
    ['neither', () => ({})], ['id 0', () => ({ id: 0, name: 'TB Zero' })], ["name ''", () => ({ id: 'tb-id-3', name: '' })],
    ['null', () => null], ['undefined', () => undefined], ['0', () => 0], ["''", () => ''], ['false', () => false],
    ['stamp equal', () => stamp({ id: 'tb-id-4', name: 'TB S' }, 'TB S')], ['stamp different', () => stamp({ id: 'tb-id-5', name: 'TB A' }, 'tb-other')],
    ["stamp ''", () => stamp({ id: 'tb-id-6', name: 'TB E' }, '')], ['stamp number', () => stamp({ id: 'tb-id-7', name: 'TB N' }, 7)],
    ['stamp object', () => stamp({ id: 'tb-id-8', name: 'TB O' }, { k: 1 })], ['stamp on falsy fields', () => stamp({ id: 0, name: '' }, 'tb-stamped')],
  ];
  const RIDS = ['x_pizza', 'la_musa', 'tb_brand_new', 'tb_brand_new_centro', 'la_musa_centro', '', undefined, ' la_musa '];
  let cells = 0;
  for (const rid of RIDS) for (const [label, make] of ITEMS) {
    assert.deepStrictEqual(MP.itemPricingKey(make(), rid), frozenItemPricingKey(make(), rid), `AVAIL-ID-FROZEN-EQUIVALENCE rid=${JSON.stringify(rid)} item=${label}`);
    cells++;
  }
  assert.strictEqual(MP.availIdentityField('la_musa'), 'id', 'AVAIL-ID-FIELD la_musa');
  for (const rid of ['x_pizza', 'tb_brand_new', 'tb_brand_new_centro', 'la_musa_centro']) assert.strictEqual(MP.availIdentityField(rid), 'name', `AVAIL-ID-FIELD ${rid} (a La Musa BRANCH keeps name, as today)`);
  ok(`itemPricingKey == the FROZEN pre-change copy over ${cells} cells (ids/names/falsy items/every stamp case × brands, tb_ brands, O1b branches incl. la_musa_centro, '', undefined, padded)`);

  // ── 2. the envelope serves the rule, from the NORMALIZED rid (Codex P1), and it equals the server's per-dish key ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const db = await seeded(rid);
    const out = await buildPublicMenu(db, rid, { known, ...active });
    assert.deepStrictEqual(out.body.avail_identity, { field: MP.availIdentityField(rid) }, `AVAIL-ID-ENVELOPE ${rid}`);
    assert.ok(out.body.dishes.length > 0, 'premise: dishes');
    for (const d of out.body.dishes) {
      const v = d[out.body.avail_identity.field];
      assert.ok(v !== undefined && v !== null && v !== '', `AVAIL-ID-EVERY-DISH-KEYED ${rid} ${JSON.stringify(d.name || d.id)}`);
      assert.strictEqual(availKey(v), availKey(MP.itemPricingKey(d, rid)), `AVAIL-ID-ENVELOPE-EQ-SERVER ${rid} ${JSON.stringify(d.name || d.id)}`);
    }
    for (const f of Object.keys(out.body.dishes[0])) assert.notStrictEqual(f, 'avail_identity', 'AVAIL-ID-NEVER-ON-A-DISH');
  }
  const padded = await buildPublicMenu(await seeded('la_musa'), ' la_musa ', { known, ...active });
  assert.deepStrictEqual(padded.body.avail_identity, { field: 'id' }, 'AVAIL-ID-NORMALIZED-RID (\' la_musa \' is served as la_musa: id)');
  ok('body.avail_identity = {field} per restaurant, computed from the normalized rid (\' la_musa \' → id); every dish keyed; availKey(dish[field]) == the server\'s itemPricingKey; never on a dish record');

  // ── 3. the forms' own literal rule == the envelope's, per restaurant (the forms stay byte-identical) ──
  assert.strictEqual(formAvailField('xpizza-orders/index.html'), MP.availIdentityField('x_pizza'), 'AVAIL-ID-ENVELOPE-EQ-FORMS x_pizza');
  assert.strictEqual(formAvailField('la-musa-orders/index.html'), MP.availIdentityField('la_musa'), 'AVAIL-ID-ENVELOPE-EQ-FORMS la_musa');
  ok("each form's AVAIL_IDENTITY (the exact `return item.<f>;` shape, else fail closed) == the envelope's field for its restaurant");

  // ── 4. declared; the representation marker is NOT this slice's (STOP 8 ruling (i): PLAN 4 owns the 1d.3 bump; avail-identity ships WITH or AFTER it) ──
  assert.deepStrictEqual(BODY_CONTRACT.avail_identity, { required: true, type: 'object' }, 'AVAIL-ID-DECLARED-REQUIRED');
  assert.ok(!require('../tools/avail-identity-inverse').HUNKS.some((h) => /REPRESENTATION_VERSION/.test(h.now + h.was)), 'AVAIL-ID-REPRESENTATION-UNCHANGED (no avail-identity hunk owns the version line)');
  const markerN = (v) => { const m = /^1d\.(\d+)$/.exec(String(v)); assert.ok(m, `AVAIL-ID-REPRESENTATION-SHAPE ${v}`); return Number(m[1]); };
  assert.ok(markerN(REPRESENTATION_VERSION) >= markerN('1d.2'), `AVAIL-ID-REPRESENTATION-NOT-LOWERED (${REPRESENTATION_VERSION} ≥ the 8a31e2a3 base 1d.2)`);
  ok('declared in the body contract as required; the representation marker is not owned by this slice and never lowered below the base 1d.2');

  FINISHED = true;
  console.log(`avail-identity: OK (${n})`);
})().catch((e) => { console.error('avail-identity: FAILED —', e && e.stack || e); process.exit(1); });
