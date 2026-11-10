// Customer app — self-hosted fonts, no reflow (PLAN-capp-S7a r3.3 F4; owner rule: no pop-in from our code). Static guards over the
// REAL files the page ships: index.html, capp-fonts.css, capp.css, fonts/. The CLS=0 proof in a real browser is review/capp-perf/capp-perf.cdp.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');
const html = read('index.html'), fontsCss = read('capp-fonts.css'), appCss = read('capp.css');
const faces = [...fontsCss.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
const family = (f) => (f.match(/font-family:'([^']+)'/) || [])[1];
const primary = faces.filter((f) => /url\(fonts\//.test(f));
const fallback = faces.filter((f) => /src:local\(/.test(f));

test('the page loads NO third-party font (no Google Fonts swap)', () => {
  for (const f of readdirSync(HERE).filter((n) => /\.(html|css)$/.test(n))) {
    assert.doesNotMatch(read(f), /fonts\.(googleapis|gstatic)\.com/, `🔴 ${f} still loads Google Fonts`);
  }
});

test('every self-hosted face is font-display:optional (it never swaps after paint)', () => {
  assert.equal(primary.length, 4, 'Red Hat Text + Display, latin + latin-ext');
  for (const f of primary) assert.match(f, /font-display:optional/, `🔴 ${family(f)} would swap: ${f.slice(0, 80)}`);
  assert.doesNotMatch(fontsCss, /font-display:\s*(swap|fallback|block|auto)/, 'no other display policy anywhere');
});

test('the preloads are exactly the two latin files, as=font, type woff2, crossorigin, before the stylesheets', () => {
  const pre = [...html.matchAll(/<link rel="preload"([^>]*)>/g)].map((m) => m[1]);
  const hrefs = pre.map((a) => a.match(/href="([^"]+)"/)[1]).sort();
  const latin = primary.filter((f) => /U\+0000-00FF/.test(f)).map((f) => f.match(/url\(([^)]+)\)/)[1]).sort();
  assert.deepEqual(hrefs, latin, 'preload ⇔ the latin src of each family (a mismatched URL would download twice and miss the window)');
  for (const a of pre) { assert.match(a, /as="font"/); assert.match(a, /type="font\/woff2"/); assert.match(a, /\bcrossorigin\b/, 'font preloads need crossorigin or they are not reused'); }
  const at = (s) => html.indexOf(s);
  assert.ok(at('rel="preload"') < at('capp-fonts.css') && at('capp-fonts.css') < at('capp.css'), 'preload → capp-fonts.css → capp.css');
});

test('fonts/: every file is referenced, every reference exists, and each name carries its own content hash (safe to cache immutably)', () => {
  const files = readdirSync(join(HERE, 'fonts')).filter((n) => n.endsWith('.woff2')).sort();
  const refs = [...fontsCss.matchAll(/url\(fonts\/([^)]+)\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(refs, files);
  for (const n of files) {
    const h = createHash('sha256').update(readFileSync(join(HERE, 'fonts', n))).digest('hex').slice(0, 10);
    assert.equal(n.split('.').slice(-2, -1)[0], h, `🔴 ${n}: the name's hash is not its bytes' hash`);
  }
  assert.match(read('fonts/OFL.txt'), /SIL Open Font License, Version 1\.1/, 'the OFL travels with the fonts');
  assert.match(read('netlify.toml'), /for = "\/fonts\/\*"[\s\S]*?Cache-Control = "public, max-age=31536000, immutable"/);
});

test('every fallback face is metric-matched (size-adjust + ascent/descent/line-gap overrides)', () => {
  assert.equal(fallback.length, 8);
  for (const f of fallback) for (const d of ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']) assert.match(f, new RegExp(`${d}:[\\d.]+%`), `${family(f)} lacks ${d}`);
});

test('every Red Hat stack in capp.css names its two metric-matched fallbacks right after the face', () => {
  const stacks = [...appCss.matchAll(/--[\w-]+:\s*('Red Hat (?:Text|Display)'[^;]*);/g)].map((m) => m[1]);
  assert.equal(stacks.length, 4, '--f-ui, --f-disp, --rht, --rhd');
  for (const s of stacks) {
    const fam = s.match(/^'(Red Hat (?:Text|Display))'/)[1];
    assert.match(s.replace(/\s+/g, ''), new RegExp(`^'${fam}','${fam}Fallback','${fam}FallbackRoboto',`.replace(/ /g, '')), `🔴 ${s}`);
  }
  const named = new Set(fallback.map(family));
  assert.deepEqual([...named].sort(), ['Red Hat Display Fallback', 'Red Hat Display Fallback Roboto', 'Red Hat Text Fallback', 'Red Hat Text Fallback Roboto']);
});
