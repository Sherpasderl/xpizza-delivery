'use strict';
// D12b (brand display name) — wiring guard.
//   1. PROOF: tools/d12b-inverse.js turns each D12b-touched pinned module back into the D12b base (acd606e) BYTE-FOR-BYTE,
//      each hunk exactly once — the inverse the zero-diff pins apply FIRST; a byte inside/outside a hunk and a duplicated
//      hunk are each detected.
//   2. Both builders write order_tracking.restaurant_display_name from the SAME resolution as the pickup line (brandOf over
//      the same candidates, in the same order), and only when it resolves.
//   3. The tracker's pickup banner reads the PUBLIC record's restaurant_display_name, falls back to NEUTRAL copy, and keeps
//      no rid → brand-name map and no "X. Pizza" fallback.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const stripComments = require('./tools/strip-comments');
const { HUNKS, FILES, unapplyD12b, unapplyD12bIndex } = require('./tools/d12b-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const BASE = '5055cb9';   // the D12b parent (rebased from acd606e; the pinned files are identical in both)
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });

// ── 1. the inverse ──
assert.deepStrictEqual([...FILES].sort(), ['create-order-build.js', 'materialize.js']);
// BRAND-AGNOSTIC SERVER (r3 §E; newest — materialize.js) is reversed first
const bsRead = (f) => require('./tools/brand-server-inverse').unapplyBrandServerModule(f, read(f));
for (const f of FILES) assert.strictEqual(unapplyD12b(f, bsRead(f)), baseOf(f), `🔴 ${f} minus the D12b hunks is not ${BASE}:${f}`);
{
  const f = 'create-order-build.js'; const src = read(f);
  const outside = src.replace("'use strict';", "'use strict'; ");
  assert.notStrictEqual(outside, src, 'premise');
  assert.notStrictEqual(unapplyD12b(f, outside), baseOf(f), 'a byte OUTSIDE every hunk is detected');
  const h = HUNKS.find((x) => x.file === f && x.now.includes('trackBrand'));
  assert.throws(() => unapplyD12b(f, src.replace(h.now, h.now.replace('trackBrand', 'trackBrnd'))), /occurs 0 times/, 'a byte INSIDE a hunk is detected');
  assert.throws(() => unapplyD12b(f, src + h.now), /occurs 2 times/, 'a duplicated hunk is detected');
}
ok(`PROOF: unapplyD12b → ${BASE} byte-for-byte for ${FILES.length} modules (${HUNKS.length} hunks, each once); a byte inside/outside a hunk and a duplicated hunk are each detected`);

// ── 1b. index.js (codex D12b r1 P2-2): ONE delimited, byte-pinned block — requestOtp's message ──
{
  // the per-product extras blocks (the newest index.js slice), then the WhatsApp-cancel block, are reversed first, as in every fold guard
  const real = require('./tools/wacancel-inverse').unapplyWaCancelIndex(require('./tools/extras-inverse').unapplyExtrasIndex(require('./tools/serial3-inverse').unapplySerial3Index(require('./tools/h0-inverse').unapplyH0Index(require('./tools/s1a-inverse').unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/o1b-inverse').unapplyO1bIndex(read('index.js'))))))))))))))))))));
  const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(unapplyD12bIndex(real), real, 'non-vacuity: the d12b block is present and swapped back');
  assert.strictEqual(unapplyD12bIndex(real), baseIdx, `🔴 index.js minus the d12b block is not ${BASE}:index.js`);
  assert.throws(() => unapplyD12bIndex(real.replace('whatsapp.tplOtp({ code })', 'whatsapp.tplOtp({ code: 1 })')), /pinned bytes/, 'an edit INSIDE the block');
  assert.throws(() => unapplyD12bIndex(real.replace('exports.verifyOtp', '/* d12b:begin */\n/* d12b:end */\nexports.verifyOtp')), /exactly one/, 'a second block');
  assert.throws(() => unapplyD12bIndex(real.replace('/* d12b:end */', '')), /exactly one/, 'a missing delimiter');
  assert.notStrictEqual(unapplyD12bIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), baseIdx, 'a byte OUTSIDE the block survives (the base pin catches it)');
}
ok(`index.js: unapplyD12bIndex → ${BASE}:index.js byte-for-byte; an edit inside, a second block, a missing delimiter and a byte outside are each caught`);

// ── 2. the tracking brand = the pickup line's brand ──
const cob = stripComments(read('create-order-build.js')); const mat = stripComments(read('materialize.js'));
assert.ok(cob.includes('pickupLabel(hubSnap.restaurant_display_name, hubSnap.restaurant_name)') && cob.includes('const trackBrand = brandOf(hubSnap.restaurant_display_name, hubSnap.restaurant_name);'), 'createOrder: the same candidates for both');
assert.ok(mat.includes('pickupLabel(order.restaurant_display_name, live.display_name, order.restaurant_name, live.name)') && mat.includes('const trackBrand = brandOf(order.restaurant_display_name, live.display_name, order.restaurant_name, live.name);'), 'materialize: the same candidates for both');
for (const src of [cob, mat]) assert.ok(/\.\.\.\(trackBrand \? \{ restaurant_display_name: trackBrand \} : \{\}\)/.test(src), 'written only when it resolves (never undefined into RTDB)');
ok('both builders write order_tracking.restaurant_display_name from the SAME resolution as the pickup line, only when it resolves');

// ── 3. the tracker banner ── (S5: the banner's decision moved to status-view.js, shared with the order forms; the tracker
//    applies presentStatus's sub-line verbatim)
const html = read('../xpizza-track/index.html');
assert.ok(html.includes('<script src="/status-view.js"></script>') && /const v = presentStatus\(\{ \.\.\.data,/.test(html) && html.includes('subEl.textContent = v.sub;'), 'premise: the tracker renders presentStatus\'s sub-line');
const sv = read('../xpizza-track/status-view.js');
const start = sv.indexOf('const brand = '); const end = sv.indexOf("'Pasá por el restaurante a recogerlo'", start);
assert.ok(start > -1 && end > start, 'premise: the banner block');
const block = sv.slice(start, sv.indexOf('\n', start)) + '\n' + sv.slice(sv.lastIndexOf('\n', end), end + 40);
assert.ok(/r\.restaurant_display_name/.test(block) && /brand \? `Pasá por \$\{brand\} a recogerlo` : 'Pasá por el restaurante a recogerlo'/.test(block), 'reads the public record; neutral fallback');
assert.ok(!/X\.? ?Pizza|La Musa|restaurant_id/.test(stripComments(sv)), '🔴 no rid → brand map and no brand-name fallback in the shared status module');
ok('the tracker banner reads the record\'s restaurant_display_name, falls back to NEUTRAL copy, and has no rid → brand map');

console.log(`\nd12b-wiring.guard: OK (${n})`);
