// slice2-contrast.test.js — WCAG 2.1 AA contrast for every NEW slice-2 fg/bg pair (stacked surfaces + map).
// Run: `node slice2-contrast.test.js`  (ESM, no framework — repo idiom).
//
// Token VALUES are parsed from index.html's :root (last definition wins = the SLICE2:PRESENTATION override),
// so a token recolour is caught. The overview-map pin INK choices are read from overview-map.js SOURCE (not
// hard-coded), so reverting the queued pin from `--muted` back to the sub-AA `--dim` turns this RED (the
// pre-compaction near-miss: --dim #8A94A6 = 3.06:1 < 4.5). Thresholds: large text (≥24px, or ≥18.66px AND
// bold ≥700) = AA 3.0; else 4.5; non-text UI strokes = 3.0.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, 'index.html'), 'utf8');
const mapSrc = readFileSync(join(__dir, 'overview-map.js'), 'utf8');

// ---- parse :root custom properties (last definition wins = SLICE2 override) ----
const tokens = {};
for (const m of html.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,6}|var\(--[\w-]+\))\s*;/g)) tokens[m[1]] = m[2];
function resolve(expr, seen = 0) {
  assert.ok(seen < 10, `token cycle resolving ${expr}`);
  const v = expr.startsWith('var(') ? tokens[expr.slice(6, -1)] : expr;
  assert.ok(v, `unresolved ${expr}`);
  return v.startsWith('var(') ? resolve(v, seen + 1) : v;
}
function ruleProp(selector, prop) {
  // The LAST rule block that DEFINES this prop wins — mirrors the cascade when SLICE2:PRESENTATION appends an
  // override after the baseline rule. A partial override (e.g. `.sv-nav-primary { flex-wrap:wrap; }`) that does
  // not set the prop correctly falls through to the earlier rule that does (the slice-1 background).
  const needle = selector + ' {';
  let from = 0, found = null;
  for (let i = html.indexOf(needle, from); i !== -1; i = html.indexOf(needle, from)) {
    const block = html.slice(i, html.indexOf('}', i));
    const m = block.match(new RegExp(prop + ':\\s*(var\\(--[\\w-]+\\)|#[0-9A-Fa-f]{3,6})'));
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
const need = (px, w) => (px >= 24 || (px >= 18.66 && w >= 700)) ? 3.0 : 4.5;
// Composite an OPAQUE colour painted at `a` over `bg` → the actually-rendered colour (Codex r1 P2-8: the map
// pins carry a rendered opacity, so contrast must be measured on the COMPOSITED result, not the raw tokens).
const composite = (hex, bg, a) => {
  const f = hx(hex), b = hx(bg);
  const mix = (sh) => Math.round(a * ((f >> sh) & 255) + (1 - a) * ((b >> sh) & 255));
  return '#' + [16, 8, 0].map((sh) => mix(sh).toString(16).padStart(2, '0')).join('');
};

// Read the SLICE2 CSS colors from their rule blocks (source-coupled → mutant-killable).
const bagA = ruleProp('.bagtag.a', 'color'), bagABg = ruleProp('.bagtag.a', 'background');
const bagB = ruleProp('.bagtag.b', 'color'), bagBBg = ruleProp('.bagtag.b', 'background');
const pactual = ruleProp('.pactual', 'color'), pactualBg = ruleProp('.pactual', 'background');
const lockFg = ruleProp('.lockchip', 'color'), lockBg = ruleProp('.lockchip', 'background');
const stripLbl = ruleProp('.strip .st .lbl', 'color');
const stripOn = ruleProp('.strip .st.on .lbl', 'color');
const capFg = ruleProp('.map-cap', 'color'), capBg = ruleProp('.map-cap', 'background');
const noteFg = ruleProp('.map-note', 'color'), noteBg = ruleProp('.map-note', 'background');

const S = 'var(--surface)';

// Overview-map pin INK + fill read from overview-map.js source: the queued pin `txt`, its dim `fill`, and the
// opacity. The number must be drawn at FULL opacity (opacity on the PATH, not the group) so it stays AA; this
// test COMPOSITES the dim pin fill over the map background and measures the number against THAT (Codex r1 P2-8).
const queuedTxt = (mapSrc.match(/const txt = \(on \|\| done\) \? '#fff' : '(var\(--[\w-]+, #[0-9A-Fa-f]{6}\))';/) || [])[1];
assert.ok(queuedTxt, 'could not read the queued-pin text colour from overview-map.js source');
const queuedTxtToken = queuedTxt.replace(/,\s*#[0-9A-Fa-f]{6}\)/, ')');
const pinFill = (mapSrc.match(/const fill = done \? 'var\(--sv-ok, #15803D\)' : on \? '#14306B' : '(var\(--[\w-]+, #[0-9A-Fa-f]{3,6}\))';/) || [])[1];
assert.ok(pinFill, 'could not read the queued-pin fill from overview-map.js source');
const pinFillToken = pinFill.replace(/,\s*#[0-9A-Fa-f]{3,6}\)/, ')');
const pinOpacity = parseFloat((mapSrc.match(/stroke-width="2"\$\{\(on \|\| done\) \? '' : ' opacity="([\d.]+)"'\}/) || [])[1]);
assert.ok(pinOpacity > 0 && pinOpacity <= 1, 'queued pin opacity must sit on the PATH (stroke-width="2"${...opacity}) — not the group');
// The number must be drawn at FULL opacity: the <g class="om-stop"> must NOT carry a dim opacity (that would
// composite the TEXT too and pull it below AA — the original bug).
assert.ok(!/class="om-stop"[^>]*\$\{on \? '' : ' opacity/.test(mapSrc), 'queued-pin GROUP must not be dimmed — opacity belongs on the pin shape only');

const mapBg = ruleProp('.map', 'background');                       // var(--surface-3)
const queuedPinFillComposited = composite(resolve(pinFillToken), resolve(mapBg), pinOpacity);  // dim pin fill over the map bg

// Nav button colours (Codex r1 P2-8 — the primary replaces the sub-AA --waze/--maps tints; the destination line
// and the single-order injected line are included).
const navMain = ruleProp('.nav-btn.waze-btn', 'color'), navMainBg = ruleProp('.nav-btn.waze-btn', 'background');
const navDest = ruleProp('.nav-btn.waze-btn .nav-dest', 'color');
const mapsFg = ruleProp('.nav-btn.maps-btn', 'color'), mapsBg = ruleProp('.nav-btn.maps-btn', 'background');
const svNavBg = ruleProp('.sv-nav-primary', 'background'), svNavDest = ruleProp('.sv-nav-primary .sv-nav-dest', 'color');

// R7 Cuenta / «App de navegación» nav-pref screens (SLICE2:NAVPREF-CSS) — steel-blue (--accent) primary + the
// option/detail/sign-out inks. `.set-opt.sel` background carries a fallback token, so its wash is read as the token.
const saveFg = ruleProp('.set-foot .set-save', 'color'), saveBg = ruleProp('.set-foot .set-save', 'background');
const optFg = ruleProp('.set-opt', 'color'), optBg = ruleProp('.set-opt', 'background');
const optDFg = ruleProp('.set-opt .set-opt-d', 'color');
const rowDFg = ruleProp('.set-row .set-d', 'color');
const signoutFg = ruleProp('.set-signout', 'color');

// [label, fgExpr, bgExpr, px, weight]  (bgExpr may be a literal #hex composited colour)
const PAIRS = [
  ['bagtag.a (stop 1 ink)', bagA, bagABg, 12, 800],
  ['bagtag.b (stop 2+ ink, dark on celeste)', bagB, bagBBg, 12, 800],
  ['pactual "Parada actual"', pactual, pactualBg, 11.5, 700],
  ['lockchip copy', lockFg, lockBg, 12.5, 600],
  ['strip label (upcoming)', stripLbl, S, 11.5, 700],
  ['strip label (active)', stripOn, S, 11.5, 700],
  ['map caption', capFg, capBg, 11, 600],
  ['map "sin ubicación" note', noteFg, noteBg, 11, 600],
  ['overview-map ACTIVE pin number (#fff on marino)', '#FFFFFF', '#14306B', 11, 800],
  ['overview-map QUEUED pin number (COMPOSITED over the dim pin)', queuedTxtToken, queuedPinFillComposited, 11, 800],
  ['nav primary «Navegar con {app}»', navMain, navMainBg, 13, 800],
  ['nav primary destination «→ {dest}»', navDest, navMainBg, 11, 700],
  ['nav secondary (Maps)', mapsFg, mapsBg, 13, 800],
  ['single-order nav injected destination «→ {dest}»', svNavDest, svNavBg, 11, 700],
  // R7 nav-pref screens (steel-blue --accent primary)
  ['navApp «Guardar» (white on steel-blue)', saveFg, saveBg, 16, 800],
  ['navApp option label (ink on surface-2)', optFg, optBg, 14, 700],
  ['navApp option detail (text-soft on surface-2)', optDFg, optBg, 12, 500],
  ['navApp selected option label (ink on steel wash)', optFg, 'var(--sv-p-bg)', 14, 700],
  ['Cuenta row detail (text-soft on surface)', rowDFg, 'var(--surface)', 12.5, 600],
  ['Cuenta «Cerrar sesión» (text-soft on bg)', signoutFg, 'var(--bg)', 13, 600],
];

let passed = 0;
const fails = [];
for (const [label, fgE, bgE, px, w] of PAIRS) {
  const fg = resolve(fgE), bg = resolve(bgE);
  const cr = Math.round(ratio(fg, bg) * 100) / 100, thr = need(px, w);
  if (cr >= thr) passed += 1;
  else fails.push(`${label}: ${cr}:1 < ${thr} (${fg} on ${bg}, ${px}px/${w})`);
}
assert.deepEqual(fails, [], `slice-2 AA contrast failure(s):\n  ${fails.join('\n  ')}`);

// Guard the known near-miss explicitly: the queued pin must NOT be --dim (3.06:1 on surface, sub-AA).
assert.ok(!/const txt = on \? '#fff' : 'var\(--dim/.test(mapSrc), 'queued pin reverted to --dim (sub-AA) — must stay --muted');

console.log(`✓ slice2-contrast: ${passed}/${PAIRS.length} new fg/bg pairs meet WCAG AA`);
