// slice3-contrast.test.js — WCAG 2.1 AA contrast for every NEW slice-3 fg/bg pair (batch-3 PRESENTATION-3 CSS:
// the enRestaurante «1 bolsa» bag chip + the cobrar-row icon tiles). Run: `node slice3-contrast.test.js`.
//
// Token VALUES are parsed from index.html's :root (last definition wins = the Cuadra override), and each colour
// is read from its OWN rule block (source-coupled → mutant-killable): reverting the bag chip from --success back
// to --green (#2F9E66 on #EBF7F0 = 3.08:1 < 4.5, the Codex r1 P2) turns this RED. Thresholds: text (<18.66px, or
// <24px non-bold) = AA 4.5; the icon GLYPHS are graphical objects = 3.0 (WCAG 1.4.11).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, 'index.html'), 'utf8');

// ---- parse :root custom properties (last definition wins = the Cuadra override) ----
const tokens = {};
for (const m of html.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,6}|var\(--[\w-]+\))\s*;/g)) tokens[m[1]] = m[2];
function resolve(expr, seen = 0) {
  assert.ok(seen < 10, `token cycle resolving ${expr}`);
  if (!expr.startsWith('var(')) return expr;
  const key = expr.slice(4, -1).split(',')[0].trim().replace(/^--/, '');   // var(--success, #fb) → success
  const v = tokens[key];
  assert.ok(v, `unresolved ${expr} (token --${key})`);
  return resolve(v, seen + 1);
}
function ruleProp(selector, prop) {
  const needle = selector + ' {';
  let from = 0, found = null;
  for (let i = html.indexOf(needle, from); i !== -1; i = html.indexOf(needle, from)) {
    const block = html.slice(i, html.indexOf('}', i));
    const m = block.match(new RegExp(prop + ':\\s*(var\\(--[\\w-]+(?:,\\s*#[0-9A-Fa-f]{3,6})?\\)|#[0-9A-Fa-f]{3,6})'));
    if (m) found = m[1];
    from = i + needle.length;
  }
  assert.ok(found, `${selector}: no ${prop}`);
  return found;
}
// ---- WCAG relative luminance + contrast ----
const hx = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return parseInt(h, 16); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const Lum = (hex) => { const n = hx(hex); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const ratio = (fg, bg) => { const a = Lum(fg) + 0.05, b = Lum(bg) + 0.05; return (Math.max(a, b) / Math.min(a, b)); };

// batch-3 CSS colours, read from their rule blocks (source-coupled)
const chipFg = ruleProp('#screen-onshift .items-card .items-head .bag-chip', 'color');
const chipBg = ruleProp('#screen-onshift .items-card .items-head .bag-chip', 'background');
const okFg = ruleProp('#screen-onshift .pay-ro-card .ico.ok', 'color');
const okBg = ruleProp('#screen-onshift .pay-ro-card .ico.ok', 'background');
const warnFg = ruleProp('#screen-onshift .pay-ro-card .ico.warn', 'color');
const warnBg = ruleProp('#screen-onshift .pay-ro-card .ico.warn', 'background');
const neutFg = ruleProp('#screen-onshift .pay-ro-card .ico', 'color');
const neutBg = ruleProp('#screen-onshift .pay-ro-card .ico', 'background');

// Inicio commit (a): login labels + «¿Olvidaste…?» link sit on the page bg; esperando «Hablá con despacho» sub sits
// on the co-card; the clock illus glyph is a graphical object on its wash. Source-coupled → mutant-killable.
const loginLblFg = ruleProp('#screen-login .login-lbl', 'color');
const loginLinkFg = ruleProp('.text-link', 'color');
const espSubFg = ruleProp('#screen-companion .co-row .co-row-d', 'color');
const espCardBg = ruleProp('#screen-companion .co-card', 'background');
const illusFg = ruleProp('#screen-companion .co-illus', 'color');
const illusBg = ruleProp('#screen-companion .co-illus', 'background');
const pageBg = 'var(--bg)';
// Inicio c: the practica «Nada de esto es real» banner + the demo «NO es real» ribbon.
const bannerBg = ruleProp('#screen-companion .co-banner', 'background');
const bannerTxFg = ruleProp('#screen-companion .co-banner-tx', 'color');
const bannerBFg = ruleProp('#screen-companion .co-banner-tx b', 'color');
const ribbonFg = ruleProp('#screen-companion .co-demo-ribbon', 'color');
const ribbonBg = ruleProp('#screen-companion .co-demo-ribbon', 'background');

// [label, fgExpr, bgExpr, threshold]
const PAIRS = [
  ['«1 bolsa» bag chip TEXT (12px/700)', chipFg, chipBg, 4.5],
  ['cobrar icon OK glyph (graphical)', okFg, okBg, 3.0],
  ['cobrar icon WARN glyph (graphical)', warnFg, warnBg, 3.0],
  ['cobrar icon NEUTRAL glyph (graphical)', neutFg, neutBg, 3.0],
  ['login «Correo»/«Contraseña» label (11.5px/700)', loginLblFg, pageBg, 4.5],
  ['login «¿Olvidaste…?» link (13px/600)', loginLinkFg, pageBg, 4.5],
  ['esperando «Hablá con despacho» sub', espSubFg, espCardBg, 4.5],
  ['esperando clock illus glyph (graphical)', illusFg, illusBg, 3.0],
  ['practica banner body text', bannerTxFg, bannerBg, 4.5],
  ['practica banner title «Nada de esto es real»', bannerBFg, bannerBg, 4.5],
  ['practica demo «NO es real» ribbon (12px/800)', ribbonFg, ribbonBg, 4.5],
];

let passed = 0;
const fails = [];
for (const [label, fgE, bgE, thr] of PAIRS) {
  const fg = resolve(fgE), bg = resolve(bgE);
  const cr = Math.round(ratio(fg, bg) * 100) / 100;
  if (cr >= thr) passed += 1;
  else fails.push(`${label}: ${cr}:1 < ${thr} (${fg} on ${bg})`);
}
assert.deepEqual(fails, [], `slice-3 AA contrast failure(s):\n  ${fails.join('\n  ')}`);

// Guard the exact Codex near-miss: the bag chip must NOT revert to --green (#2F9E66 → 3.08:1 sub-AA on --green-bg).
assert.ok(!/\.bag-chip\s*\{[^}]*color:\s*var\(--green[,)]/.test(html), 'bag chip reverted to --green (3.08:1 sub-AA) — must stay --success');

console.log(`✓ slice3-contrast: ${passed}/${PAIRS.length} new fg/bg pairs meet WCAG AA`);
