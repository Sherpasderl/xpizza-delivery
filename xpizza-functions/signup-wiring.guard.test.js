'use strict';
// PLAN-signup-email-social phase 1 — wiring guard.
//   1. PROOF: tools/signup-inverse.js turns index.js back into the slice base BYTE-FOR-BYTE (each hunk exactly once); a byte
//      inside / outside a hunk, a duplicated hunk and a missing hunk are each detected; non-vacuity (the slice is present).
//   2. The no-ticket paths: requestOtp touches the ticket hook ONLY when a link_ticket is sent; verifyOtp's response without a
//      ticket is today's line, reached after the BC3 refresh; the ticket response is today's fields + `link`.
//   3. Both deletion callers go through the ONE deletion core (deleteAccountCore); the sweep passes its cutoff; no direct
//      accountDeleteUpdates / pruneUpdates write remains in index.js.
//   4. The five endpoints are exported with ACCOUNT_ORIGINS CORS; no brand literal in the signup modules.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const stripComments = require('./tools/strip-comments');
const { HUNKS, BASE, unapplySignupIndex } = require('./tools/signup-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const real = require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(read('index.js'))))))))))))));   // TRACKER FIXES (newest) reversed innermost, then UNASSIGN
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. the inverse ──
assert.strictEqual(unapplySignupIndex(real), baseIdx, `🔴 index.js minus the signup hunks is not ${BASE}:index.js`);
assert.notStrictEqual(real, baseIdx, 'non-vacuity: the slice is present');
assert.ok(HUNKS.length >= 6 && HUNKS.every((h) => h.file === 'index.js'));
{
  const h = HUNKS.find((x) => x.now.includes('SE.deleteAccountCore(db, ACCOUNT, { uid, phoneHash: pHash'));
  assert.ok(h, 'premise: the deleteAccount hunk');
  assert.throws(() => unapplySignupIndex(real.replace(h.now, h.now.replace('phoneHash: pHash', 'phoneHash: pHsh'))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplySignupIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplySignupIndex(real.replace(h.now, '')), /occurs 0 times/, 'a missing hunk');
  const outside = real.replace('exports.quoteOrder = onRequest(', 'exports.quoteOrder  = onRequest(');
  assert.notStrictEqual(outside, real, 'premise');
  assert.notStrictEqual(unapplySignupIndex(outside), baseIdx, 'a byte OUTSIDE every hunk survives and fails the base pin');
}
ok(`PROOF: unapplySignupIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

const src = stripComments(real);
const fnBody = (name) => { const i = src.indexOf(`exports.${name} = onRequest(`); assert.ok(i > -1, name); const j = src.indexOf('\nexports.', i + 10); return src.slice(i, j); };

// ── 2. the no-ticket paths ──
{
  const ro = fnBody('requestOtp');
  assert.ok(/if \(req\.body\.link_ticket != null\) await SE\.bindOtpTicket\(/.test(ro), 'requestOtp: the hook only with a ticket');
  assert.strictEqual((ro.match(/SE\./g) || []).length, 1, 'requestOtp: exactly one signup call');
  const vo = fnBody('verifyOtp');
  const iRefresh = vo.indexOf('await SE.refreshActivity(db, uid, now2);');
  const iWelcome = vo.indexOf('creditWelcome(');
  const iTicket = vo.indexOf('if (req.body.link_ticket != null) {');
  const iToday = vo.indexOf("return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null });");
  assert.ok(iWelcome > -1 && iRefresh > iWelcome && iTicket > iRefresh && iToday > iTicket, 'verifyOtp: today\'s writes → BC3 refresh → the ticket branch → today\'s response');
  assert.ok(vo.includes("return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null, link });"), 'the ticket response = today\'s fields + link');
  assert.ok(vo.indexOf('getAuth().createCustomToken(uid, { customer: true })') < iRefresh, 'the token is minted before (and independent of) the refresh');
}
ok('requestOtp calls the ticket hook ONLY with a link_ticket; verifyOtp: today\'s writes → the BC3 refresh → the ticket branch (today\'s fields + link) → today\'s exact response line');

// ── 3. one deletion core ──
{
  const del = fnBody('deleteAccount');
  assert.ok(del.includes('await SE.deleteAccountCore(db, ACCOUNT, { uid, phoneHash: pHash, now: Date.now() });') && !del.includes('accountDeleteUpdates'), 'deleteAccount → the core');
  const i = src.indexOf('exports.pruneInactiveAccounts = onSchedule('); const sw = src.slice(i, src.indexOf('\n);', i));
  assert.ok(/SE\.deleteAccountCore\(db, ACCOUNT, \{ uid: c\.uid, phoneHash: c\.phoneHash, now: Date\.now\(\), sweepCutoff: cutoff \}\)/.test(sw) && sw.includes('ACCOUNT.pruneCandidates(snap.val(), cutoff)'), 'the sweep → the core with its cutoff');
  assert.ok(sw.includes('await SE.pruneResidual(db)'), 'the sweep removes links to deleted accounts + expired rows');
  const noProf = sw.slice(sw.indexOf('if (!snap.exists())'), sw.indexOf('const cutoff'));
  assert.ok(/await SE\.pruneResidual\(db\)[\s\S]*return;/.test(noProf), 'codex r1 P2-10: the residual cleanup runs even when no profiles remain');
  assert.ok(!/accountDeleteUpdates|pruneUpdates\(/.test(src), 'no direct removal map left in index.js');
}
ok('deleteAccount AND the inactivity sweep go through the ONE deletion core (the sweep with its cutoff + the dead-link cleanup); no direct removal map remains in index.js');

// ── 4. endpoints + brand-agnostic ──
{
  for (const e of ['googleStart', 'googleSignIn', 'completeProfile', 'setPromos', 'getSignupConfig']) assert.ok(src.includes(`exports.${e} = onRequest(SIGNUP_OPTS, SIGNUP_H.${e});`), e);
  assert.ok(/const SIGNUP_OPTS = \{ region: 'us-central1', cors: ACCOUNT_ORIGINS,/.test(src), 'ACCOUNT_ORIGINS CORS');
  for (const f of ['signup-core.js', 'signup-endpoints.js']) assert.ok(!/x_pizza|la_musa|xpizza|lamusa|X\. ?Pizza|La Musa/i.test(stripComments(read(f))), `🔴 a brand literal in ${f}`);
}
ok('the five endpoints are exported with ACCOUNT_ORIGINS CORS; no brand literal in signup-core / signup-endpoints');

console.log(`\nsignup-wiring.guard: OK (${n})`);
