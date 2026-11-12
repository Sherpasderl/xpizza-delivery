'use strict';
// S1b (PLAN-portal-item-edit r6 §2.4; D4c-grill/item-s1/S1b-DESIGN.md) — the resolution stage's WIRING guard.
//   1. Each of the four cart endpoints runs the stage ONCE, after its tables resolve (and, in the two order endpoints, after the
//      D4-grace stamp), and BEFORE every check, price, reward step and fingerprint the handler runs.
//   2. The refusals: the order endpoints send the stage's own refusal; quoteOrder stays fail-soft (200 ok:false);
//      quoteRedemption keeps its { ok:false, … } envelope. The 503 menu_updating path is untouched.
//   3. Glossary S1-1: the brand config's `item_key` (how a reorder recipe names a dish) and a LINE's `item_key` never meet —
//      the config readers never read a line's field, and the stage never reads the config.
// Run: node resolvelines-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, require('./tools/s2bext-module-inverse').unapplyS2bextModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8')))));
const src = read('index.js');
const STAGE = 'RL.resolveLines(restaurantId, body, ';

const ENDPOINTS = [
  { name: 'createOrder', start: "createOrderApp.all('*', async (req, res) => {", end: "chargeOnlineApp.all('*', async (req, res) => {",
    after: ['await resolvePricingTables(restaurantId)', 'const grace = await resolveGraceKeys('],
    before: ['validateOrderPayload(body, restaurantId, pricingTables)', 'computeIncomingFingerprint(', 'checkItemAvailability(', 'absentFromMenu(body.items',
      'GI.groupIssues(', '/* extras:begin cash */', 'weekendOnlyViolation(body.items', 'resolveRedemptionForOrder(', 'pricedLineItems(body.items'] },
  { name: 'chargeOnlineOrder', start: "chargeOnlineApp.all('*', async (req, res) => {", end: "confirmOnlineApp.all('*', async (req, res) => {",
    after: ['await resolvePricingTables(restaurantId)', 'const grace = await resolveGraceKeys('],
    before: ['validateOrderPayload(body, restaurantId, pricingTables)', 'prepareRedemption(', 'checkItemAvailability(', 'absentFromMenu(body.items',
      'GI.groupIssues(', 'weekendOnlyViolation(body.items', 'pricedLineItems(body.items'] },
  { name: 'quoteOrder', start: 'exports.quoteOrder = onRequest(', end: 'exports.quoteRedemption = onRequest(',
    after: ['const tables = await resolvePricingTables(restaurantId);', "if (!tables) return res.status(200).json({ ok: false, error: 'pricing_unavailable' });"],
    before: ['GI.groupIssues(', 'extrasCheckFor(restaurantId, tables, body.items)', 'computeServerTotal(body.items, restaurantId, tables)'] },
  { name: 'quoteRedemption', start: 'exports.quoteRedemption = onRequest(', end: '\nexports.',
    after: ["if (!quoteTables) return res.status(200).json({ ok: false, error: 'pricing_unavailable' });"],
    before: ['GI.groupIssues(', 'extrasCheckFor(restaurantId, quoteTables, body.items)', 'quoteRedemptionCore(db, {'] },
];

// ── 1 ──
{
  assert.strictEqual(src.split("const RL = require('./catalog/resolve-lines');").length - 1, 1, '🔴 the stage module is required once');
  assert.strictEqual(src.split(STAGE).length - 1, 4, '🔴 the stage runs in exactly the four cart endpoints');
  for (const e of ENDPOINTS) {
    const s = src.indexOf(e.start); assert.ok(s >= 0, `anchor: ${e.name}`);
    const t = src.indexOf(e.end, s + e.start.length); assert.ok(t > s, `anchor end: ${e.name}`);
    const body = src.slice(s, t);
    assert.strictEqual(body.split(STAGE).length - 1, 1, `🔴 RLW-ONCE ${e.name} runs the stage exactly once`);
    const at = body.indexOf(STAGE);
    for (const a of e.after) { const i = body.indexOf(a); assert.ok(i >= 0, `anchor: ${e.name} ${a}`); assert.ok(i < at, `🔴 RLW-AFTER ${e.name}: the stage runs after ${a}`); }
    for (const b of e.before) { const i = body.indexOf(b); assert.ok(i >= 0, `anchor: ${e.name} ${b}`); assert.ok(at < i, `🔴 RLW-BEFORE ${e.name}: the stage runs before ${b}`); }
  }
  ok('the stage runs once in each of the four cart endpoints: after its tables (and grace), before every check, price, reward and fingerprint');
}

// ── 2 ──
{
  const line = (needle) => { const i = src.indexOf(needle); assert.ok(i >= 0, needle); return src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i)); };
  const order = 'if (!rl.ok) { const rf = RL.resolutionRefusal(rl); return res.status(rf.status).json(rf.body); }';
  assert.strictEqual(src.split(order).length - 1, 2, '🔴 RLW-ORDER-REFUSAL the two order endpoints send the stage\'s refusal as is');
  assert.ok(line("RL.resolveLines(restaurantId, body, tables)").includes("if (!rl.ok) return res.status(200).json({ ok: false, error: rl.code });"), '🔴 RLW-QUOTE-SOFT quoteOrder stays fail-soft');
  assert.ok(line('RL.resolveLines(restaurantId, body, quoteTables)').includes('return res.status(rf.status).json({ ok: false, ...rf.body });'), '🔴 RLW-REDEEM-ENVELOPE quoteRedemption keeps its { ok:false } envelope');
  assert.strictEqual(src.split("res.status(503).json({ ...MENU_UPDATING });").length - 1, 3, 'RLW-MENU-UPDATING the three 503 menu_updating refusals (create, charge, the charge\'s reserve) are untouched');
  assert.match(read('catalog/menu-gates.js'), /const MENU_UPDATING = Object\.freeze\(\{ error: 'menu_updating', detail: 'El menú se está actualizando — probá de nuevo en un momento', retryable: true \}\);/, 'RLW-MENU-UPDATING its body is today\'s');
  ok('order endpoints send 409 menu_changed / 400 invalid_line; quoteOrder fail-soft; quoteRedemption { ok:false }; 503 menu_updating untouched');
}

// ── 3 ──
{
  const stage = read('catalog/resolve-lines.js');
  assert.ok(!/RESTAURANT_CONFIG|CONFIG\.item_key|config\.item_key|ITEM_KEY/.test(stage), '🔴 RLW-SEP the stage never reads the brand config\'s item_key');
  const root = path.join(__dirname, '..');
  for (const f of ['xpizza-orders/account.js', 'la-musa-orders/account.js', 'd4b-reorder-reader.mjs', 'xpizza-functions/contract/capp/brand-config.mjs']) {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(/item_key/.test(t), `premise: ${f} reads the config field`);
    assert.ok(!/(?:\bit|\bline|\bitem|\bl|\]|\))\.item_key\b|\[['"]item_key['"]\]/.test(t.replace(/\b(?:RC|c|b\.config|config|CONFIG)\.item_key\b/g, '')), `🔴 RLW-SEP ${f} reads only the CONFIG's item_key, never a line's`);
  }
  ok('S1-1: the config\'s item_key and a line\'s item_key never meet (the stage reads no config; the config readers read no line)');
}

console.log(`\nresolvelines-wiring.guard: OK (${n})`);
