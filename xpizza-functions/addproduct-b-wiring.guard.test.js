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
// The stacked-tracker slice landed on top of PB-2 → its inverse is reversed FIRST, before add-product B's.
const { unapplyStackedTracker } = require('./tools/stacked-tracker-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// D4-c2b landed on top of the stacked-tracker slice (main 2cb5a1c): its one delimited index.js block (tools/d4c2b-inverse.js,
// advisor ruling N1) is reversed FIRST, then the stacked-tracker inverse, before add-product B's proof.
// D12b landed on top of D4-c2b: its ONE delimited, byte-pinned index.js block (tools/d12b-inverse.js unapplyD12bIndex) is reversed
// after the WhatsApp-cancel block (tools/wacancel-inverse.js unapplyWaCancelIndex), which is reversed after the per-product extras blocks
// (tools/extras-inverse.js unapplyExtrasIndex — the newest, reversed FIRST).
const idx = unapplyStackedTracker(require('./tools/d4c2b-inverse').unapplyD4c2b(require('./tools/d12b-inverse').unapplyD12bIndex(require('./tools/wacancel-inverse').unapplyWaCancelIndex(require('./tools/extras-inverse').unapplyExtrasIndex(require('./tools/serial3-inverse').unapplySerial3Index(require('./tools/h0-inverse').unapplyH0Index(require('./tools/s1a-inverse').unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(read('index.js')))))))))))))))))))))))))))));
const BASE = execFileSync('git', ['show', '4e2a710:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// ── (i) ──────────────────────────────────────────────────────────────────────────────────────────────────────────
assert.strictEqual(unapplyAddProductB(idx), BASE, '🔴 index.js minus the add-product B hunks is not 4e2a710:index.js — something beyond the stated seams changed');
assert.ok(INDEX_HUNKS.length >= 6, `the hunks are enumerated (${INDEX_HUNKS.length})`);
{ let folds; try { folds = unapplyAddProductB(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(read('index.js')))))))))))))))) === BASE; } catch (_) { folds = false; }
  assert.ok(!folds, 'non-vacuity: without the D4-c2b inverse the real index.js does NOT fold back (its block is present)'); }
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
// codex PB-1 r1 P1-3 — the BOUND-REUSE fast path and the preparation-failure precedence, pinned by position
{
  const ch = idx.slice(idx.indexOf('chargeOnlineApp.all('));
  const probe = ch.indexOf('const boundAcq = await BR.probeBoundReuse(db, { orderId, uid: customer_uid, rid: restaurantId, body, now: Date.now() });');
  const prep = ch.indexOf('const prep = await prepareRedemption(db, { redeem: body.redeem');
  const classify = ch.indexOf('clsG = await classifyHostedAttempt(');
  const reserve = ch.indexOf('reserveRedemption(');
  const acquire = ch.indexOf('acq = await acquireHostedAttempt(');
  const auth = ch.indexOf('customer_uid = await Promise.race(');
  assert.ok(auth > 0 && probe > auth && prep > probe && classify > prep && reserve > classify && acquire > reserve,
    `bound reuse: verified identity (${auth}) < probe (${probe}) < prepareRedemption (${prep}) < classify (${classify}) < reserve (${reserve}) < acquire (${acquire})`);
  const gate = ch.lastIndexOf('if (body.redeem != null && customer_uid && groupCapabilities().render) {', probe);
  assert.ok(gate > 0 && probe - gate < 200, 'the fast path runs only for a reward, a verified customer and the render capability');
  const blockEnd = ch.indexOf('\n  }\n', probe);
  const block = ch.slice(probe, blockEnd);
  assert.ok(/const flow = await resolveBoundReuse\(\{ acq: boundAcq,/.test(block) && /return res\.status\(flow\.respond\.status\)\.json\(flow\.respond\.body\);/.test(block),
    'a bound reuse answers through the hosted-flow reuse branch and RETURNS');
  const WRITES = /\.(set|update|transaction|remove|push|setWithPriority)\(|reserveRedemption|acquireHostedAttempt|createHostedCharge/;
  assert.ok(!WRITES.test(block), 'the fast-path block performs no write and reaches no reserve / acquire / charge');
  const br = read('catalog/bound-reuse.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!WRITES.test(br) && /catch \(_\) \{\s*return null;/.test(br), 'catalog/bound-reuse.js is read-only and any error → null (the current path)');
  const fail = ch.indexOf('const pr = GI.prepFailureRefusal(await GI.groupIssues({');
  const failGate = ch.indexOf('if (!prep.ok) {');
  const prepReturn = ch.indexOf('return res.status(prep.status).json({ ...prep.body, order_id: orderId });');
  assert.ok(failGate > prep && fail > failGate && prepReturn > fail && prepReturn - failGate < 1200, 'the precedence check runs ONLY inside the preparation-failure branch, before its own error');
  // codex PB-1 r2 P2-a: the render capability wraps the WHOLE precedence block — with it off, the failure branch reads nothing
  const branch = ch.slice(failGate, prepReturn);
  const renderGuard = branch.indexOf('if (groupCapabilities().render) {');
  const gateRead = branch.indexOf('gateReader().intakeGatesFor(restaurantId)');
  assert.ok(renderGuard > 0 && gateRead > renderGuard, 'the precedence gate read sits INSIDE the render-capability guard');
  assert.strictEqual(branch.split('intakeGatesFor(').length - 1, 1, 'and it is the branch\'s only gate read');
  const bind = idx.indexOf("...(redemptionCanonical && groupCapabilities().render && CI.chargeInputsFingerprint(body) ? { charge_inputs_fp: CI.chargeInputsFingerprint(body) } : {}),");
  const pendingAt = idx.indexOf('const pendingOrderRecord = {');
  assert.ok(pendingAt > 0 && bind > pendingAt && bind - pendingAt < 2000, 'the charge-input fingerprint is bound on the pending reward order (render capability only)');
}
ok('PROOF (ii): seam order — cash refusal after the unknown-key refusal and before the first write and the reserve; card decision after the menu pre-gate and before reserve/acquire; the guard reaches acquire (after reuse, before CAS); quote checks behind the render capability');

// ── (iii) §0d.6 — no brand branch in group behaviour ─────────────────────────────────────────────────────────────
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const BRAND = /\b(x_pizza|la_musa)\b|restaurantId\s*===|rid\s*===|===\s*['"](x_pizza|la_musa)['"]/;
  for (const f of ['catalog/group-index.js', 'catalog/group-intake.js', 'catalog/platform-groups.js', 'catalog/bound-reuse.js', 'catalog/charge-inputs.js']) {
    assert.ok(!BRAND.test(strip(read(f))), `${f}: no brand literal or rid comparison`);
  }
  const ap = strip(read('catalog/add-product.js'));
  const groupCode = ap.slice(ap.indexOf('const isGroupVariant'), ap.indexOf('function compareToActive'));
  assert.ok(groupCode.length > 1000 && !BRAND.test(groupCode), 'add-product.js group code (prepareGroups / rewriteGroupRefs): no brand branch');
  assert.ok(BRAND.test("if (restaurantId === 'la_musa') {}") && BRAND.test('rid === x'), 'non-vacuity: the detector fires on planted brand branches');
}
ok('PROOF (iii): the group modules and the add-product group code carry no brand literal and no rid comparison (§0d.6, scoped to group behaviour)');

console.log(`\naddproduct-b-wiring.guard: OK (${n})`);
