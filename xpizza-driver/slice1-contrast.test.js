// slice1-contrast.test.js — WCAG 2.1 AA contrast for every slice-1 card fg/bg pair.
// Run: `node slice1-contrast.test.js`  (ESM, no framework — repo idiom).
//
// Token VALUES are parsed from index.html's :root (last definition wins — the Cuadra override), so a
// token recolour is caught. The .sv-chip.ok text colour is read from its RULE in index.html (not
// hard-coded), so reverting it from --success-hover back to --sv-ok (which is 4.40:1 on the green tint)
// turns this test RED — see mutant drv1-14. Thresholds: large text (≥24px, or ≥18.66px AND bold ≥700) =
// AA 3.0; else 4.5. Measured 2026-10-20; advisor ruling A pinned .sv-chip.ok → --success-hover.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, 'index.html'), 'utf8');

// ---- parse :root custom properties (last definition wins = Cuadra override) ----
const tokens = {};
for (const m of html.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,6}|var\(--[\w-]+\))\s*;/g)) tokens[m[1]] = m[2];
function resolve(expr, seen = 0) {
  assert.ok(seen < 10, `token cycle resolving ${expr}`);
  const v = expr.startsWith('var(') ? tokens[expr.slice(6, -1)] : expr;
  assert.ok(v, `unresolved ${expr}`);
  return v.startsWith('var(') ? resolve(v, seen + 1) : v;
}
// pull a property's value from a specific CSS rule block in index.html (source-coupled)
function ruleProp(selector, prop) {
  const i = html.indexOf(selector + ' {');
  assert.notEqual(i, -1, `rule ${selector} not found`);
  const block = html.slice(i, html.indexOf('}', i));
  const m = block.match(new RegExp(prop + ':\\s*(var\\(--[\\w-]+\\)|#[0-9A-Fa-f]{3,6})'));
  assert.ok(m, `${selector}: no ${prop}`);
  return m[1];
}

// ---- WCAG relative luminance + contrast ----
const hx = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return parseInt(h, 16); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const Lum = (hex) => { const n = hx(hex); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const ratio = (fg, bg) => { const a = Lum(fg) + 0.05, b = Lum(bg) + 0.05; return (Math.max(a, b) / Math.min(a, b)); };
const need = (px, w) => (px >= 24 || (px >= 18.66 && w >= 700)) ? 3.0 : 4.5;

const chipOk = ruleProp('.sv-chip.ok', 'color');   // read from source → mutant-killable
const S = 'var(--surface)', S2 = 'var(--surface-2)', MUT = 'var(--sv-muted)', INK = 'var(--sv-ink)', ACC = 'var(--accent)';

// [label, fgExpr, bgExpr, px, weight]
const PAIRS = [
  ['sv-name', INK, S, 21, 800], ['sv-amt', INK, S, 27, 800], ['sv-amt .cur', MUT, S, 16, 700],
  ['sv-bignum', ACC, S, 48, 800], ['sv-sub', MUT, S, 14, 400], ['sv-lbl', MUT, S, 11.5, 700],
  ['sv-addr', INK, S, 15, 400], ['sv-item', INK, S2, 14.5, 400], ['sv-item b', ACC, S2, 14.5, 700],
  ['sv-ref-lbl', MUT, S2, 11, 700], ['sv-ref-tx', INK, S2, 14, 400], ['sv-paywith', MUT, S2, 13.5, 400],
  ['sv-paywith b', INK, S2, 13.5, 700], ['sv-nav-primary', '#FFFFFF', ACC, 15, 800], ['sv-nav-other', MUT, S, 13, 700],
  ['sv-ct', INK, S, 14, 800], ['sv-ct.wa', '#0B7A3B', 'var(--sv-ok-bg)', 14, 800],
  ['sv-rchip.xp', ACC, 'var(--sv-p-bg)', 11, 800], ['sv-rchip.lm', 'var(--lamusa)', '#FBEDEE', 11, 800],
  ['sv-rchip.neutral', MUT, S, 11, 800], ['sv-chip.ok', chipOk, 'var(--sv-ok-bg)', 11, 800],
  ['sv-chip.p', ACC, 'var(--sv-p-bg)', 11, 800], ['sv-chip.warn', 'var(--sv-warn)', 'var(--sv-warn-bg)', 11, 800],
  ['sv-chip.ghost', MUT, 'var(--sv-ghost-bg)', 11, 800], ['sv-reminder b', INK, 'var(--sv-warn-bg)', 14, 700],
  ['sv-reminder span', MUT, 'var(--sv-warn-bg)', 13, 400], ['sv-arrived', 'var(--sv-ok)', S, 13.5, 700],
  ['sv-foot-note', MUT, S, 12.5, 400], ['sv-onum', MUT, S, 13, 700],
];

let passed = 0;
const fails = [];
for (const [label, fgE, bgE, px, w] of PAIRS) {
  const fg = resolve(fgE), bg = resolve(bgE);
  const cr = Math.round(ratio(fg, bg) * 100) / 100, thr = need(px, w);
  if (cr >= thr) passed += 1;
  else fails.push(`${label}: ${cr}:1 < ${thr} (${fg} on ${bg}, ${px}px/${w})`);
}
assert.deepEqual(fails, [], `AA contrast failure(s):\n  ${fails.join('\n  ')}`);
console.log(`✓ slice1-contrast: ${passed}/${PAIRS.length} fg/bg pairs meet WCAG AA`);
