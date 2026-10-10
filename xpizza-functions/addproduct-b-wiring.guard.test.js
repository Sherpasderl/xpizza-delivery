'use strict';
// 1D add-product PHASE B (rev 6, UNIFORM) — the slice's wiring proofs. Run: node addproduct-b-wiring.guard.test.js
//  (i)   unapplyAddProductB(index.js) === 4e2a710:index.js byte-for-byte; a byte inside a hunk, a byte outside every hunk,
//        and a duplicated hunk are each detected.
//  (ii)  seam order: createOrder's group refusal sits after the unknown-key refusal and before the first write and the
//        redemption reserve; chargeOnlineOrder's group decision sits after the menu pre-gate and before the reserve and
//        acquire; the choice guard reaches acquireHostedAttempt, whose guard sits after every reuse/terminal return and
//        before the CAS; both quote checks are behind the render capability (no read while it is off).
//  (iii) §0d.6, scoped to group behaviour: the group modules and the add-product group code never branch on a brand.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyAddProductB, INDEX_HUNKS } = require('./tools/addproduct-b-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const idx = read('index.js');
const BASE = execFileSync('git', ['show', '4e2a710:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// ── (i) ──────────────────────────────────────────────────────────────────────────────────────────────────────────
assert.strictEqual(unapplyAddProductB(idx), BASE, '🔴 index.js minus the add-product B hunks is not 4e2a710:index.js — something beyond the stated seams changed');
assert.ok(INDEX_HUNKS.length >= 6, `the hunks are enumerated (${INDEX_HUNKS.length})`);
{
  const [now] = INDEX_HUNKS[2];
  const at = idx.indexOf(now) + Math.floor(now.length / 2);
  const inHunk = idx.slice(0, at) + (idx[at] === 'x' ? 'y' : 'x') + idx.slice(at + 1);
  let detected; try { detected = unapplyAddProductB(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('function scheduledReleaseDeps(db) {', 'function scheduledReleaseDeps(db)  {');
  assert.notStrictEqual(unapplyAddProductB(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyAddProductB(idx + INDEX_HUNKS[0][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyAddProductB(index.js) === 4e2a710:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes are each detected`);

// ── (ii) seam order ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const co = idx.slice(idx.indexOf('createOrderApp.all('));
  const unknown = co.indexOf('const unknownKeys = absentFromMenu(body.items, restaurantId, intakeGates.known);');
  const group = co.indexOf('const groupRefusal = GI.cashRefusal(await GI.groupIssues({');
  const weekend = co.indexOf('const weekendBad = weekendOnlyViolation(body.items, restaurantId, fMs, weekendKeys);');
  const firstWrite = co.indexOf("const cbase = db.ref(`recent_order_content/");
  const reserve = co.indexOf('const rd = await resolveRedemptionForOrder(db, {');
  assert.ok(unknown > 0 && group > unknown && weekend > group && firstWrite > weekend && reserve > firstWrite,
    `createOrder: unknown-key (${unknown}) < group refusal (${group}) < weekend (${weekend}) < first write (${firstWrite}) < reserve (${reserve})`);
  assert.ok(/gates: intakeGates, items: body\.items/.test(co.slice(group, weekend)), 'the cash group rule reads the SAME snapshot');

  const ch = idx.slice(idx.indexOf('chargeOnlineApp.all('));
  const pre = ch.indexOf("const mg = OCS.chargePreGate('menu_updating', clsForMenu);");
  const gd = ch.indexOf('const gd = GI.chargeDecision(await GI.groupIssues({');
  const reserveC = ch.indexOf('reserveRedemption(');
  const acquire = ch.indexOf('acq = await acquireHostedAttempt(');
  assert.ok(pre > 0 && gd > pre && reserveC > gd && acquire > reserveC, `charge: menu pre-gate (${pre}) < group decision (${gd}) < reserve (${reserveC}) < acquire (${acquire})`);
  assert.ok(/gates: intakeGates, items: body\.items,[\s\S]{0,200}rewardKeys: \(redemptionFreeItems \|\| \[\]\)/.test(ch.slice(gd, reserveC)), 'the card rule reads the SAME snapshot and the SERVER-resolved reward keys');
  assert.ok(/canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed, choiceArmed\);/.test(ch), 'the choice guard flag reaches acquireHostedAttempt');
  assert.ok(/if \(acq\.reason === 'choice_required'\)[\s\S]{0,200}status\(409\)/.test(ch), 'the guard\'s conflict maps to 409 choice_required');

  const hc = read('pixelpay-hosted-charge.js');
  const reuseRet = hc.indexOf("return { outcome: 'reuse'");
  const guard = hc.indexOf("if (choiceRefuseFresh === true) return { outcome: 'conflict', reason: 'choice_required' };");
  const cas = hc.indexOf('const tx = await orderRef.transaction(');
  assert.ok(reuseRet > 0 && guard > reuseRet && cas > guard, `acquire: reuse returns (${reuseRet}) < choice guard (${guard}) < CAS (${cas})`);

  for (const ep of ['exports.quoteOrder = onRequest(', 'exports.quoteRedemption = onRequest(']) {
    const q = idx.slice(idx.indexOf(ep), idx.indexOf(ep) + 6000);
    const gate = q.indexOf('if (groupCapabilities().render) {');
    const readAt = q.indexOf('gates: await gateReader().intakeGatesFor(restaurantId)');
    assert.ok(gate > 0 && readAt > gate && readAt - gate < 200, `${ep}: the group check (and its gate read) is behind the render capability`);
  }
}
ok('PROOF (ii): seam order — cash refusal after the unknown-key refusal and before the first write and the reserve; card decision after the menu pre-gate and before reserve/acquire; the guard reaches acquire (after reuse, before CAS); quote checks behind the render capability');

// ── (iii) §0d.6 — no brand branch in group behaviour ─────────────────────────────────────────────────────────────
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const BRAND = /\b(x_pizza|la_musa)\b|restaurantId\s*===|rid\s*===|===\s*['"](x_pizza|la_musa)['"]/;
  for (const f of ['catalog/group-index.js', 'catalog/group-intake.js', 'catalog/platform-groups.js']) {
    assert.ok(!BRAND.test(strip(read(f))), `${f}: no brand literal or rid comparison`);
  }
  const ap = strip(read('catalog/add-product.js'));
  const groupCode = ap.slice(ap.indexOf('const isGroupVariant'), ap.indexOf('function compareToActive'));
  assert.ok(groupCode.length > 1000 && !BRAND.test(groupCode), 'add-product.js group code (prepareGroups / rewriteGroupRefs): no brand branch');
  assert.ok(BRAND.test("if (restaurantId === 'la_musa') {}") && BRAND.test('rid === x'), 'non-vacuity: the detector fires on planted brand branches');
}
ok('PROOF (iii): the group modules and the add-product group code carry no brand literal and no rid comparison (§0d.6, scoped to group behaviour)');

console.log(`\naddproduct-b-wiring.guard: OK (${n})`);
