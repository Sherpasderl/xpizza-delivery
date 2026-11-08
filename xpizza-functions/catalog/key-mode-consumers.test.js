'use strict';
// S0 — every serving / money consumer keys by the TABLES' mode (ruling R3), and the fiscal fence refuses a non-name
// effective mode on a platform-factura restaurant (relay invariant 6). Run: node catalog/key-mode-consumers.test.js
// Each consumer is driven with the same line under the id mode, the name mode, and no mode: the id mode must pick the
// slug, the name mode the name, and no mode today's rule — so dropping the mode at any one consumer is visible here.
const assert = require('assert');
const MP = require('../menu-pricing');
const { checkItemAvailability } = require('../availability-gate');
const { absentFromMenu } = require('./menu-gates');
const { groupIssues } = require('./group-intake');
const { dishQtyOf } = require('../ratings/dish-qty');
const { normalizeCartForFingerprint } = require('../quote-token');
const { lineItemKey, lineExtraKeys } = require('./extras-intake');
const { normalizeReorderItems } = require('../reorder-normalize');
const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
const { fiscalKeyModeOk } = require('../factura/eligibility');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const RID = 'tb_merch_3';   // a non-la_musa rid: its DEFAULT is name, so only a passed mode can make it key by id
const SLUG = 'tb_slug', NAME = 'TB Name', XSLUG = 'tb_x', XNAME = 'TB Extra';
const line = () => ({ id: SLUG, name: NAME, qty: 1, extras: [{ id: XSLUG, name: XNAME, qty: 1 }] });
const tablesFor = (mode) => MP.attachTablesKeyMode({ restaurantId: RID, menu: { [SLUG]: 100, [NAME]: 200 }, extras: { [XSLUG]: 10, [XNAME]: 20 } }, mode);

(async () => {
  // availability: the 86 gate reads the node under the key the order is priced by
  {
    const db = (node) => ({ ref: () => ({ once: async () => ({ val: () => node }) }) });
    const { availKey } = require('../avail-key');
    const off = (k) => ({ [availKey(k)]: { available: false } });
    const blockedBy = async (node, mode) => (await checkItemAvailability(db(node), [line()], RID, mode)).blocked.length;
    assert.strictEqual(await blockedBy(off(SLUG), 'id'), 1, 'id mode reads the slug');
    assert.strictEqual(await blockedBy(off(SLUG), 'name'), 0);
    assert.strictEqual(await blockedBy(off(NAME), 'name'), 1, 'name mode reads the name');
    assert.strictEqual(await blockedBy(off(NAME), undefined), 1, 'no mode = today (name for this rid)');
    ok('availability gate keys by the passed mode');
  }
  // the menu-updating gate
  {
    const known = new Set([SLUG]);
    assert.deepStrictEqual(absentFromMenu([line()], RID, known, 'id'), []);
    assert.deepStrictEqual(absentFromMenu([line()], RID, known, 'name'), [NAME]);
    assert.deepStrictEqual(absentFromMenu([line()], RID, known), [NAME], 'no mode = today');
    ok('menu-updating gate keys by the passed mode');
  }
  // required-choice groups: a bare launcher is detected under the priced key
  {
    const gates = (k) => ({ groups: { launchers: new Set([k]), parentOf: new Map() }, known: new Set([SLUG, NAME]), knownExtras: new Set() });
    const issues = (k, mode) => groupIssues({ caps: { render: true }, gates: gates(k), items: [line()], restaurantId: RID, keyMode: mode });
    assert.ok(await issues(SLUG, 'id'), 'id mode sees the slug launcher');
    assert.strictEqual(await issues(SLUG, 'name'), null);
    assert.ok(await issues(NAME, undefined), 'no mode = today');
    ok('group intake keys by the passed mode');
  }
  // dish quantities for ratings
  {
    const ctx = (k) => ({ usableAsIdentity: true, objects: [{ kind: 'dish', legacyKey: k, canonicalId: 'cid_1' }] });
    assert.deepStrictEqual(dishQtyOf([line()], RID, ctx(SLUG), 'id'), { cid_1: 1 });
    assert.strictEqual(dishQtyOf([line()], RID, ctx(SLUG), 'name'), null);
    assert.deepStrictEqual(dishQtyOf([line()], RID, ctx(NAME)), { cid_1: 1 }, 'no mode = today');
    ok('rating dish quantities key by the passed mode');
  }
  // the quote fingerprint: issue and verify both pass the tables' mode, so they agree; the mode changes what is bound
  {
    const fp = (mode) => JSON.stringify(normalizeCartForFingerprint([line()], RID, mode));
    assert.notStrictEqual(fp('id'), fp('name'), 'the fingerprint binds the priced key');
    assert.strictEqual(fp(undefined), fp('name'), 'no mode = today');
    assert.ok(fp('id').includes(SLUG) && !fp('id').includes(NAME));
    ok('quote fingerprint keys by the passed mode');
  }
  // per-product extras: item and extra keys come from the tables' own mode
  {
    assert.strictEqual(lineItemKey(line(), tablesFor('id'), RID), SLUG);
    assert.strictEqual(lineItemKey(line(), tablesFor('name'), RID), NAME);
    assert.strictEqual(lineItemKey(line(), tablesFor(null), RID), NAME, 'no mode = today');
    assert.deepStrictEqual(lineExtraKeys(line(), tablesFor('id'), RID), [XSLUG]);
    assert.deepStrictEqual(lineExtraKeys(line(), tablesFor('name'), RID), [XNAME]);
    ok('extras eligibility keys items and extras by the tables\' mode');
  }
  // the reorder recipe's item allowlist (its extras model stays on the rid rule — ruling R5)
  {
    assert.strictEqual(normalizeReorderItems([line()], RID, tablesFor('id')).length, 1);
    assert.strictEqual(JSON.stringify(normalizeReorderItems([line()], RID, tablesFor('name'))), JSON.stringify(normalizeReorderItems([line()], RID, tablesFor(null))), 'no mode = today');
    assert.notStrictEqual(JSON.stringify(normalizeReorderItems([{ id: SLUG, name: 'TB Nope', qty: 1 }], RID, tablesFor('id'))), '[]', 'id mode allowlists by the slug');
    assert.strictEqual(JSON.stringify(normalizeReorderItems([{ id: SLUG, name: 'TB Nope', qty: 1 }], RID, tablesFor('name'))), '[]', 'name mode does not');
    ok('reorder allowlist keys items by the tables\' mode');
  }
  // the fiscal fence — EFFECTIVE mode, at the request head and in the redeemed factura pricer
  {
    assert.strictEqual(fiscalKeyModeOk('x_pizza', undefined), true, 'pre-snapshot x_pizza passes');
    assert.strictEqual(fiscalKeyModeOk('x_pizza', 'name'), true);
    assert.strictEqual(fiscalKeyModeOk('x_pizza', 'id'), false);
    assert.strictEqual(fiscalKeyModeOk('la_musa', 'id'), true, 'not a platform-factura restaurant');
    assert.strictEqual(fiscalKeyModeOk('x_pizza', 'ID'), false, 'a malformed mode is refused too');
    const xt = (mode) => MP.attachTablesKeyMode({ restaurantId: 'x_pizza', menu: { Pepperoni: 300 }, extras: {} }, mode);
    const red = { ok: true, model: 'add_free', freeItems: [{ item_id: 'Pepperoni', qty: 1 }] };
    const r = (mode) => applyRedemptionToPricing({ restaurantId: 'x_pizza', items: [{ name: 'Pepperoni', qty: 1, extras: [] }], redemption: red, totalLempiras: 300, tables: xt(mode) });
    assert.strictEqual(r('id').error, 'fiscal_key_mode_unsupported', 'the redeemed factura pricer refuses an id mode');
    assert.notStrictEqual(r(null).error, 'fiscal_key_mode_unsupported', 'no mode = today');
    assert.notStrictEqual(r('name').error, 'fiscal_key_mode_unsupported');
    ok('fiscal fence: effective mode at the request head and in the redeemed pricer');
  }
  console.log(`\nkey-mode-consumers: OK (${n})`);
})().catch((e) => { console.error('key-mode-consumers FAILED:', e); process.exit(1); });
