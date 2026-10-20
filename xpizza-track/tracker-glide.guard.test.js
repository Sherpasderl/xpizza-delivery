'use strict';
// F4 — THE GLIDE IS PRESERVED (owner rule; BUILD-tracker-F4 §0, T1). Run: node xpizza-track/tracker-glide.guard.test.js
//   1. driver-glide.js is BYTE-IDENTICAL to the engine shipped at main 9947464c, and to the dispatch board's copy (one shared
//      engine, three byte-equal files).
//   2. updateDriverMap() and hideDriverMap() in index.html are byte-identical to S5 5a7e9bdc (pinned by sha256 of their exact
//      source text), and their call sites keep today's semantics: hideDriverMap() once at the top of render, updateDriverMap(data)
//      exactly once, inside the mapEligible guard; the "do NOT cancel the glide in hideDriverMap" comment stays.
//   3. The one NEW glide call (F4 §5) is a single cancel(DRV), guarded by a REAL sampling-owner change.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const GLIDE_SHA = 'ac1a349887bc0a12c14253f0dff9a581517851fc2cf872e08820ec717f57015f';            // main 9947464c
const UPDATE_SHA = '59dfba9dedd7ab12d4c2fdc51263a6e363800943c6311b60ecae89990e5ad0cd';           // 5a7e9bdc updateDriverMap
const HIDE_SHA = 'da5fb0c788dbc1e937440f4873104e9b1c8fe37df44024208953c1ba40bde44c';             // 5a7e9bdc hideDriverMap

const glide = read('driver-glide.js');
assert.strictEqual(sha(glide), GLIDE_SHA, '🔴 xpizza-track/driver-glide.js changed — the glide engine must stay byte-identical');
assert.strictEqual(sha(fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch', 'driver-glide.js'), 'utf8')), GLIDE_SHA, '🔴 the dispatch copy drifted from the shared engine');
ok('driver-glide.js is byte-identical to main and to the dispatch board\'s copy');

const html = read('index.html');
function fnText(head) {
  const a = html.indexOf(`    ${head}`);
  assert.ok(a !== -1, `${head} present`);
  assert.strictEqual(html.indexOf(`    ${head}`, a + 1), -1, `${head} defined once`);
  return html.slice(a, html.indexOf('\n    }\n', a) + '\n    }\n'.length);
}
assert.strictEqual(sha(fnText('async function updateDriverMap(')), UPDATE_SHA, '🔴 updateDriverMap() changed');
assert.strictEqual(sha(fnText('function hideDriverMap(')), HIDE_SHA, '🔴 hideDriverMap() changed');
assert.ok(fnText('function hideDriverMap(').includes('Do NOT cancel the glide here.'), 'the no-cancel rule stays documented');
ok('updateDriverMap() and hideDriverMap() are byte-identical to S5 (sha256 of their exact source)');

const count = (s) => html.split(s).length - 1;
assert.strictEqual(count('      hideDriverMap();'), 1, 'hideDriverMap() is called once, at the top of render');
assert.strictEqual(count('updateDriverMap(data);'), 2, 'updateDriverMap(data): two call sites — the synchronous one (map exists) and the owner-gated one while Maps loads');
assert.ok(/if \(v\.mapEligible\) \{\s*if \(dMap\) updateDriverMap\(data\);[^\n]*\n\s*else \{[\s\S]{0,900}?const mapOwner = lastRealOwner;\s*loadMaps\(\)\.then\(\(\) => \{ if \(mapOwner === lastRealOwner\) updateDriverMap\(data\); \}\);\s*\}\s*\}/.test(html),
  'updateDriverMap: synchronous when the live map exists (today\'s timing); owner-gated after Maps loads only while it is still loading (codex build r1 P1 / r2)');
assert.ok(html.indexOf('      hideDriverMap();') < html.indexOf('if (dMap) updateDriverMap(data);'), 'hide first, then (maybe) show');
ok('the call sites keep today\'s semantics: hide at the top of render, show once inside the mapEligible guard (owner-gated after Maps loads)');

// the glide engine is touched in exactly three places: its creation, the existing update, and F4's single guarded cancel
const glideCalls = html.match(/dGlide\.(update|cancel)\(/g) || [];
assert.deepStrictEqual(glideCalls.sort(), ['dGlide.cancel(', 'dGlide.update('], 'one update (existing), one cancel (F4)');
assert.ok(/if \(lastRealOwner !== null && owner !== lastRealOwner && dGlide\) dGlide\.cancel\(DRV\);/.test(html), 'the cancel runs only on a REAL sampling-owner change');
ok('the only new glide call is ONE cancel(DRV), guarded by a real owner/shift replacement');

console.log(`\ntracker-glide.guard: OK (${n})`);
