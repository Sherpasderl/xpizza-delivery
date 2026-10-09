'use strict';
// 1D add-product PHASE A — the slice's wiring proofs (PLAN-addproduct rev 5 §0.6, §0b.1). Run: node addproduct-wiring.guard.test.js
//  (i)  unapplyAddProduct(index.js) === 37dcf43:index.js byte-for-byte; the fold inverse reproduces the base fold;
//       sensitivity: a byte inside a hunk, a byte outside every hunk, a duplicated hunk are each detected.
//  (ii) seam order: createOrder refuses an unknown key BEFORE its first write (and before the weekend check, from the
//       SAME gate snapshot); chargeOnlineOrder refuses a FRESH unknown-key checkout before reserving and arms the menu
//       guard otherwise; acquireHostedAttempt's guard sits after every reuse/terminal return and before the CAS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyAddProduct, unapplyAddProductFold, INDEX_HUNKS, PORTAL_HUNKS } = require('./tools/addproduct-inverse');
const { foldPortalSplit } = require('./tools/portal-split');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const git = (spec) => execFileSync('git', ['show', spec], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const idx = read('index.js');
const BASE = git('37dcf43:xpizza-functions/index.js');

// ── (i) ──────────────────────────────────────────────────────────────────────────────────────────────────────────
assert.strictEqual(unapplyAddProduct(idx), BASE, '🔴 index.js minus the add-product hunks is not 37dcf43:index.js — something beyond the stated seams changed');
assert.ok(INDEX_HUNKS.length >= 7 && PORTAL_HUNKS.length >= 4);
{
  const [now] = INDEX_HUNKS[2];
  const at = idx.indexOf(now) + Math.floor(now.length / 2);
  const inHunk = idx.slice(0, at) + (idx[at] === 'x' ? 'y' : 'x') + idx.slice(at + 1);
  let detected; try { detected = unapplyAddProduct(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('function scheduledReleaseDeps(db) {', 'function scheduledReleaseDeps(db)  {');
  assert.notStrictEqual(unapplyAddProduct(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  const dup = idx + INDEX_HUNKS[0][0];
  assert.throws(() => unapplyAddProduct(dup), /not found exactly once/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyAddProduct(candidate index.js) === 37dcf43:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes are each detected`);

{
  // the fold: index.js + the moved blocks → the base fold (the chain the integration-parent guards run FIRST)
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'apfold-'));
  try {
    execFileSync('bash', ['-c', `git -C "${path.join(__dirname, '..')}" archive 37dcf43 xpizza-functions | tar -x -C "${tmp}"`]);
    const baseFold = require(path.join(tmp, 'xpizza-functions', 'tools', 'portal-split')).foldPortalSplit(path.join(tmp, 'xpizza-functions'));
    assert.strictEqual(unapplyAddProductFold(foldPortalSplit()), baseFold, '🔴 the portal fold minus the add-product hunks is not the 37dcf43 fold');
    const fold = foldPortalSplit();
    const [pnow] = PORTAL_HUNKS[0];
    const k = fold.indexOf(pnow) + 2;
    let detected; try { detected = unapplyAddProductFold(fold.slice(0, k) + '#' + fold.slice(k + 1)) !== baseFold; } catch (_) { detected = true; }
    assert.ok(detected, 'a byte changed inside a moved-block hunk is detected');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
ok(`PROOF (ii) basis: the portal fold minus the add-product hunks (${PORTAL_HUNKS.length} moved-block + ${INDEX_HUNKS.length} index) === the 37dcf43 fold; a moved-block byte change is detected`);

// ── seam order ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const co = idx.slice(idx.indexOf('createOrderApp.all('));
  const refuse = co.indexOf('const unknownKeys = absentFromMenu(body.items, restaurantId, intakeGates.known);');
  const weekend = co.indexOf('const weekendBad = weekendOnlyViolation(body.items, restaurantId, fMs, weekendKeys);');
  const firstWrite = co.indexOf("const cbase = db.ref(`recent_order_content/");
  const dedupe = co.indexOf('classifyCreateOrder') > -1 ? co.indexOf('classifyCreateOrder') : co.indexOf('order_exists');
  assert.ok(refuse > 0 && weekend > refuse && firstWrite > weekend, `createOrder: unknown-key refusal (${refuse}) < weekend check (${weekend}) < first write (${firstWrite})`);
  assert.ok(dedupe > 0 && dedupe < refuse, 'createOrder: AFTER the existing-order dedupe/classification');
  assert.ok(/const weekendKeys = intakeGates\.weekend;/.test(co.slice(refuse, weekend)), 'the weekend set comes from the SAME snapshot');
  const ch = idx.slice(idx.indexOf('chargeOnlineApp.all('));
  const pre = ch.indexOf("const mg = OCS.chargePreGate('menu_updating', clsForMenu);");
  const reserve = ch.indexOf('reserveRedemption(');
  const acquire = ch.indexOf('acq = await acquireHostedAttempt(');
  assert.ok(pre > 0 && reserve > pre && acquire > reserve, `charge: menu pre-gate (${pre}) < reserve (${reserve}) < acquire (${acquire})`);
  assert.ok(/canonicalChargeFp, floorBelow, controlArmed !== null, menuArmed\);/.test(ch), 'the menu guard flag reaches acquireHostedAttempt');
  assert.ok(/if \(acq\.reason === 'menu_updating'\)/.test(ch), 'the guard\'s conflict maps to the retryable 503');
  const hc = read('pixelpay-hosted-charge.js');
  const reuseRet = hc.indexOf("return { outcome: 'reuse'");
  const guard = hc.indexOf("if (menuRefuseFresh === true) return { outcome: 'conflict', reason: 'menu_updating' };");
  const cas = hc.indexOf('const tx = await orderRef.transaction(');
  assert.ok(reuseRet > 0 && guard > reuseRet && cas > guard, `acquire: reuse returns (${reuseRet}) < menu guard (${guard}) < CAS (${cas})`);
}
ok('seam order: createOrder refuses an unknown key after dedupe, before the weekend check (same snapshot) and before any write; charge refuses a FRESH one before reserving and arms the guard; acquire\'s guard is after every reuse return and before the CAS');

console.log(`\naddproduct-wiring.guard: OK (${n})`);
