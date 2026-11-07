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

  assert.match(toml, /for = "\/fonts\/\*\.woff2"\s*\n\s*\[headers\.values\]\s*\n\s*Cache-Control = "public, max-age=31536000, immutable"/, `${site}: the hashed /fonts/*.woff2 are served immutable`);
  assert.doesNotMatch(toml, /for = "\/fonts\/\*"\s*\n/, `🔴 ${site}: immutable must not cover the whole /fonts/ folder (fonts/OFL.txt is not content-hashed — Codex r1 P3)`);
  assert.match(toml, /bake-form-bundle\.js --this-form && node \.\.\/platform\/stamp-version\.js && node \.\.\/xpizza-functions\/tools\/form-bundle-live-check\.js --this-form/, `${site}: Plan 4's bake → stamp → check is untouched`);
  ok(`${site}: only the hashed /fonts/*.woff2 are immutable (OFL.txt normal); the build command is still bake → stamp → check`);
}
// §4.1 / r6.2 — the committed rendered-font census (forms-fonts.cdp.mjs, both brands): gate (b) has a verdict for EVERY primary
// declaration the candidate ships and none is a FAIL; every painted hosted run matches a DECLARED discrete face; Special Elite paints
// nowhere; every state's NORMALIZED gate (c) diff is 0 (the raw diff is informational — r6.2).
{
  const css = readFileSync(join(ROOT, 'xpizza-orders', p.cssName), 'utf8');
  const decls = [...css.matchAll(/@font-face\{font-family:'(DM Sans|Playfair Display)';font-style:(\w+);font-weight:(\d+);[^}]*unicode-range:([^}]+)\}/g)].map((m) => `${m[1]}|${m[3]}|${m[4]}`).sort();
  const AVAIL = { 'DM Sans': [300, 400, 500, 600, 700, 800], 'Playfair Display': [600, 700, 900] };
  const match = (w, a) => { if (a.includes(w)) return w; const below = a.filter((x) => x < w).reverse(), above = a.filter((x) => x > w);
    if (w >= 400 && w <= 500) return above.filter((x) => x <= 500)[0] ?? below[0] ?? above.find((x) => x > 500); return w < 400 ? (below[0] ?? above[0]) : (above[0] ?? below[0]); };
  for (const rid of ['x_pizza', 'la_musa']) {
    const c = JSON.parse(readFileSync(join(ROOT, 'platform/fonts/census', `orders-form.census.${rid}.json`), 'utf8'));
    const verdicts = c.gateB.map((v) => `${v.family}|${v.weight}|${v.raw}`).sort();
    assert.deepEqual(verdicts, decls, `${rid}: gate (b) carries a verdict for exactly the shipped primary declarations`);
    for (const v of c.gateB) assert.match(v.verdict, /^(covered|r1 subset-only|r2 weight-unrequested)$/, `🔴 ${rid}: ${v.family} ${v.weight} — ${v.verdict}`);
    for (const [st, nodes] of Object.entries(c.states)) for (const nd of nodes.candidate) for (const r of nd.runs) {
      assert.doesNotMatch(r.font, /Special Elite/, `${rid} ${st}: Special Elite painted`);
      const fam = Object.keys(AVAIL).find((f) => r.font === f || r.font.startsWith(`${f} `));
      if (fam) assert.ok(AVAIL[fam].includes(match(Number(nd.weight) || 400, AVAIL[fam])), `${rid} ${st}: ${fam} ${nd.weight} matches no declared face`);
    }
    for (const [st, d] of Object.entries(c.normalized)) assert.equal(d, 0, `🔴 ${rid} ${st}: the NORMALIZED gate (c) diff must be 0`);
    assert.ok(Object.keys(c.raw).length === Object.keys(c.normalized).length, `${rid}: a raw (informational) record for every state`);
  }
  ok('the committed census (both brands): gate (b) verdicts for exactly the shipped declarations, none FAIL; every hosted run matches a declared face; no Special Elite; normalized gate (c) = 0 in every state (raw recorded, informational)');
}
console.log(`\nforms-fonts: OK (${n})`);
