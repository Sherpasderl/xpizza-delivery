// PLAN-forms-fonts-preconnect r6.1 §5 — the order forms load their fonts SELF-HOSTED and connect early ONLY to their real
// boot origins. Static guards over the REAL files each form ships (index.html, account.js, netlify.toml), both forms.
// The pipeline itself (pins, generated css/OFL, site identity) is platform/fonts/build-fonts.test.mjs; the browser proofs
// (no reflow, pixel equivalence, census) are the CDP harness at hand-back.
// Run: node forms-fonts.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, loadManifest } from './platform/fonts/build-fonts.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const p = plan('orders-form', loadManifest());
const HOSTED = { 'DM Sans': ['DM Sans Fallback', 'DM Sans Fallback Roboto'], 'Playfair Display': ['Playfair Display Fallback', 'Playfair Display Fallback Noto'] };

for (const site of p.sites) {
  const read = (f) => readFileSync(join(ROOT, site, f), 'utf8');
  const html = read('index.html'), acct = read('account.js'), toml = read('netlify.toml');

  for (const [name, src] of [['index.html', html], ['account.js', acct], [p.cssName, read(p.cssName)]]) {
    assert.doesNotMatch(src, /fonts\.(googleapis|gstatic)\.com/, `🔴 ${site}/${name} still loads Google Fonts`);
    assert.doesNotMatch(src, /Special Elite['"]?\s*[,)]?[^;]*url\(|family=Special/, `${site}/${name}: Special Elite is not loaded (ruling a)`);
  }
  ok(`${site}: no Google Fonts request anywhere; Special Elite not loaded`);

  // preloads ⇔ the manifest's critical set, attributes complete, before the font css, which is before the page's own <style>
  const pre = [...html.matchAll(/<link rel="preload"([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(pre.map((a) => a.match(/href="([^"]+)"/)[1]).sort(), [...p.preload].sort(), `${site}: preload ⇔ the manifest's critical set`);
  for (const a of pre) { assert.match(a, /as="font"/); assert.match(a, /type="font\/woff2"/); assert.match(a, /\bcrossorigin\b/, 'a font preload without crossorigin is fetched twice'); }
  const at = (s) => html.indexOf(s);
  assert.ok(at('rel="preload"') > 0 && at('rel="preload"') < at(`href="${p.cssName}"`) && at(`href="${p.cssName}"`) < at('<style'), `${site}: preload → ${p.cssName} → the page's <style>`);
  ok(`${site}: preloads = ${p.preload.join(', ')} (as=font, woff2, crossorigin), before ${p.cssName}, before the page's styles`);

  // preconnect = EXACTLY the form's two boot origins, each crossorigin, each DERIVED from the form's own constant
  const origin = (re, what) => { const m = html.match(re); assert.ok(m, `${site}: ${what} constant not found`); return new URL(m[1].replace(/'\s*\+.*$/, '')).origin; };
  const want = [origin(/const PUBLICMENU_URL\s*=\s*'([^']+)'/, 'PUBLICMENU_URL'), origin(/const AVAIL_URL\s*=\s*'([^']+)/, 'AVAIL_URL')].sort();
  const pc = [...html.matchAll(/<link rel="preconnect"([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(pc.map((a) => a.match(/href="([^"]+)"/)[1]).sort(), want, `🔴 ${site}: the preconnect set must be exactly the boot origins ${want}`);
  for (const a of pc) assert.match(a, /\bcrossorigin\b/, `${site}: the boot fetches use the anonymous pool — a preconnect without crossorigin is wasted`);
  ok(`${site}: preconnect = exactly ${want.join(' + ')} (crossorigin), derived from its PUBLICMENU_URL / AVAIL_URL`);

  // every stack that names a hosted face carries its metric-matched fallbacks RIGHT AFTER it
  let stacks = 0;
  for (const [name, src] of [['index.html', html], ['account.js', acct]]) {
    for (const [fam, fbs] of Object.entries(HOSTED)) {
      for (const m of src.matchAll(new RegExp(`'${fam}'(?! Fallback)`, 'g'))) {
        const tail = src.slice(m.index, m.index + 160).replace(/\s+/g, '');
        if (/^'[^']+'\)/.test(tail) || /local\(/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;   // a quoted name, not a stack
        assert.ok(tail.startsWith(`'${fam}',${fbs.map((f) => `'${f}'`).join(',')},`.replace(/\s+/g, '')), `🔴 ${site}/${name}: a ${fam} stack without its fallbacks: ${src.slice(m.index, m.index + 90)}`);
        stacks++;
      }
    }
  }
  assert.ok(stacks >= 8, `${site}: expected the ≥8 hosted-face stacks (--display/--stamp/--sans/--body, --rk-sans/--rk-serif, the inline fallbacks), found ${stacks}`);
  ok(`${site}: all ${stacks} hosted-face stacks name their metric-matched fallbacks right after the face`);

  assert.match(toml, /for = "\/fonts\/\*"[\s\S]*?Cache-Control = "public, max-age=31536000, immutable"/, `${site}: /fonts/* is served immutable`);
  assert.match(toml, /bake-form-bundle\.js --this-form && node \.\.\/platform\/stamp-version\.js && node \.\.\/xpizza-functions\/tools\/form-bundle-live-check\.js --this-form/, `${site}: Plan 4's bake → stamp → check is untouched`);
  ok(`${site}: /fonts/* immutable; the build command is still bake → stamp → check`);
}
console.log(`\nforms-fonts: OK (${n})`);
