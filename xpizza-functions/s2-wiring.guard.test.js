'use strict';
// S2 (D4c-grill/item-s1/S2-DESIGN.md §1.4 + §2 r1; Codex S2 code r1) — the WIRING of the S2 server rules (static):
//   1. the pickup-only backstop answers with ITS OWN status at all four endpoints (409 pickup_only_item, retryable 503
//      menu_updating) — quoteOrder included (Codex r1 P2-4) — and sits in the card path's fresh-only gate chain;
//   2. no early release of a reused reward hold is wired anywhere (Codex r1 P1-1 → today's behaviour);
//   3. both edit handlers run the ONE edit preflight; the publish runs no second registry pass;
//   4. the slice's test-only inverse returns every pinned file it edits to its base byte for byte; same-line edits only.
// Behaviour is pinned by the S2 unit files and test/{pickup-backstop,item-key-wins}.emulator.test.js. Run: node s2-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => require('./tools/dpao-module-inverse').unapplyDpaoModule(f, require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule(f, require('./tools/zones-module-inverse').unapplyZonesModule(f, require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/d4-intake-inverse').unapplyD4Module(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))))));
const peelTip = (f, s) => (f === 'index.js' ? require('./tools/tippref-inverse').unapplyTipprefIndex(s) : s);   /* DRYRUN R-WIRE (2e asm5): tip C's tippref layer is newer than this pin's base — peeled first */
const idx = read('index.js');

// ── 1 ──
{
  const between = (a, b) => { const s = idx.indexOf(a); const t = idx.indexOf(b, s + a.length); assert.ok(s >= 0 && t > s, `anchor ${a}`); return idx.slice(s, t); };
  const quote = between('exports.quoteOrder = onRequest(', 'exports.quoteRedemption = onRequest(');
  assert.ok(/pickupRefusal\(\{[^}]*kind: 'quote'[^}]*\}\); if \(pk\) \{ if \(pk\.status === 503\) res\.set\('Retry-After', '2'\); return res\.status\(pk\.status\)\.json\(pk\.body\); \}/.test(quote), '🔴 S2W-QUOTE quoteOrder answers the backstop with its own status (409 / retryable 503), never a fail-soft 200');
  const redeem = idx.slice(idx.indexOf('exports.quoteRedemption = onRequest('));
  assert.ok(/pickupRefusal\(\{[^}]*kind: 'quote'[^}]*\}\); if \(pk\) return res\.status\(pk\.status\)\.json\(pk\.body\);/.test(redeem), '🔴 S2W-REDEEM quoteRedemption answers with the backstop\'s status');
  assert.strictEqual(idx.split("kind: 'binding', body, gates: gateReader() }); if (pk) { if (pk.status === 503) res.set('Retry-After', '2'); return res.status(pk.status).json(pk.body); }").length - 1, 1, '🔴 S2W-CASH createOrder judges a binding order once, after the group rules');
  assert.ok(idx.includes('(await DW.refusalGate(dq, releaseHoldIfOwned, orderId)) || (await pickupGate()) || applyConfirmedNetGate({'), '🔴 S2W-CARD the card path judges it inside the fresh-only gate chain');
  ok('the backstop answers with its own status at all four endpoints; the card path judges it in the fresh-only gate chain');
}
// ── 2 ──
{
  assert.ok(!/releaseReused|rewards-reuse-release/.test(idx) && !/releaseReused/.test(read('hosted-charge-flow.js')), '🔴 S2W-NO-EARLY-RELEASE no early release of a reused hold is wired');
  ok('no early release of a reused reward hold is wired (today\'s behaviour)');
}
// ── 3 ──
{
  const save = read('catalog/edit-catalog-handler.js'); const pub = read('catalog/publish-edited-handler.js');
  assert.strictEqual(save.split("require('./edit-preflight').runEditPreflight(").length - 1, 1, '🔴 S2W-PREFLIGHT-SAVE the save runs the edit preflight once');
  assert.strictEqual(pub.split("require('./edit-preflight').runEditPreflight(").length - 1, 1, '🔴 S2W-PREFLIGHT-PUB the publish runs the edit preflight once');
  assert.ok(pub.indexOf("require('./edit-preflight').runEditPreflight(") < pub.indexOf('validateSource(draft, rid);'), '🔴 S2W-PREFLIGHT-PUB before its validator');
  assert.ok(!pub.includes('FK.renamedLabels(') && !pub.includes('RK.renameConflicts('), '🔴 S2W-ONE-PASS the publish handler never re-judges renamed labels itself (the preflight does; additions keep their own registry check)');
  ok('both edit handlers run the one preflight (the publish before its validator); no second registry pass');
}
// ── 4 ──
{
  const I = require('./tools/s2-module-inverse');
  for (const f of I.FILES) {
    const now = peelTip(f, read(f));
    const back = I.unapplyS2Module(f, now);
    const base = execFileSync('git', ['show', `${I.BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.strictEqual(crypto.createHash('sha256').update(back).digest('hex'), crypto.createHash('sha256').update(base).digest('hex'), `🔴 S2W-INVERSE ${f} round trip to ${I.BASE}`);
    assert.strictEqual(back.split('\n').length, now.split('\n').length, `🔴 S2W-SAME-LINE ${f}: no line added`);
  }
  ok(`the inverse returns each of the ${I.FILES.length} pinned files to ${I.BASE} byte for byte; same-line edits only`);
}
console.log(`\ns2-wiring.guard: OK (${n})`);
