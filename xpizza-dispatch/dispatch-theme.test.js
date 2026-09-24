// xpizza-dispatch/dispatch-theme.test.js
//
// Slice C-1 — two-theme pastel token system + rename + dead-CSS (design:
// docs/superpowers/specs/2026-09-20-dispatch-C-theme-system-rename-design.md).
//
// Guards (all on the shipped file): both themes COMPLETE (same token set); COMPUTED WCAG contrast ≥4.5:1 for
// functional text in BOTH themes — including rgba text ALPHA-COMPOSITED over its real backdrop and every
// on-button foreground (white/dark-ink on the --primary/--success/--warn fills); no orphaned hardcoded color
// that would break light mode, SELECTOR-SCOPED so an allowlisted brand hex can't leak onto an unrelated
// element and no un-tokenized rgba component background (dark OR white) can pass outside the known scrims;
// the theme toggle persists + is localStorage-guarded; rename touched VISIBLE TEXT ONLY (Despacho) with every
// torre-* DOM id + the $('torre-list') wire intact; the dead card-system CSS + #risk-summary/updateRiskSummary
// are gone while the live rules survive.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ---- parse the two token blocks ----
const darkBlock = (html.match(/:root \{([^}]*--primary:[^}]*)\}/) || [])[1];
const lightBlock = (html.match(/:root\[data-theme="light"\] \{([\s\S]*?)\}/) || [])[1];
assert.ok(darkBlock && lightBlock, 'both :root (dark) and :root[data-theme="light"] token blocks present');
const parse = (b) => { const m = {}; for (const mm of b.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) m[mm[1]] = mm[2].trim(); return m; };
const DARK = parse(darkBlock), LIGHT = parse(lightBlock);

// ---- color math (rgb kept in 0..1) ----
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const RGBA = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/;
const parseColor = (v) => {
  if (/^#/.test(v)) return { rgb: hex(v), a: 1 };
  const m = v.match(RGBA);
  assert.ok(m, `color parses: ${v}`);
  return { rgb: [+m[1] / 255, +m[2] / 255, +m[3] / 255], a: m[4] !== undefined ? +m[4] : 1 };
};
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const cratio = (a, b) => { const la = L(a), lb = L(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const val = (M, t) => (M[t] !== undefined ? M[t] : t);                 // token name → its value, else literal
// Resolve a background spec to an OPAQUE rgb. spec = token/literal (opaque), or [softToken, baseToken]
// meaning: composite the (rgba) soft token OVER the opaque base — i.e. the real pixel behind the text.
const opaqueRgb = (M, spec) => {
  if (Array.isArray(spec)) {
    const soft = parseColor(val(M, spec[0])), base = parseColor(val(M, spec[1])).rgb;
    return soft.rgb.map((c, i) => c * soft.a + base[i] * (1 - soft.a));
  }
  const c = parseColor(val(M, spec));
  return c.rgb; // functional backdrops here are opaque
};

// ─────────────────────────────────────────────────────────────────────────────
// Both themes are COMPLETE — the light theme redefines every theme-varying token the dark theme sets, so no
// element can borrow the dark theme's value in light mode.
// ─────────────────────────────────────────────────────────────────────────────
{
  const themed = Object.keys(DARK);
  const missing = themed.filter(k => !(k in LIGHT));
  assert.deepStrictEqual(missing, [], `light theme defines every dark token (missing: ${missing.join(', ')})`);
  for (const k of ['--bg', '--surface', '--text', '--text-dim', '--primary', '--primary-fg', '--accent', '--accent-solid', '--success', '--success-fg', '--warn', '--warn-fg', '--surface-4', '--card-1', '--map-bg', '--track', '--sel'].filter(x => x in DARK)) {
    assert.ok(LIGHT[k] && DARK[k], `both themes define ${k}`);
  }
  // dark ≠ light for the ground/surfaces (proves the light theme actually inverts, not a copy)
  assert.notStrictEqual(DARK['--bg'], LIGHT['--bg'], 'bg differs between themes');
  assert.notStrictEqual(DARK['--surface'], LIGHT['--surface'], 'surface differs between themes');
  ok(`both themes complete: light redefines all ${themed.length} dark tokens; grounds differ`);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTED contrast ≥4.5:1 (large ≥3:1) for functional text in BOTH themes. rgba pill/backdrops are
// ALPHA-COMPOSITED over the real surface, and the on-button foregrounds (white/dark-ink on the --primary/
// --success/--warn fills) are sampled explicitly — so a fg reverted to white-on-pastel goes RED here.
// ─────────────────────────────────────────────────────────────────────────────
{
  // [fgToken, bgSpec, {large?}]  — bgSpec: token/literal (opaque) or [softToken, baseToken] (composited)
  const PAIRS = [
    ['--text', '--bg'], ['--text', '--surface'],
    ['--text-soft', '--surface'], ['--text-dim', '--surface'], ['--text-dim', '--surface-2'],
    // semantic text on its own -soft pill (rgba composited over the card surface)
    ['--primary', ['--primary-soft', '--surface']],
    ['--accent', ['--accent-soft', '--surface']],
    ['--success', ['--success-soft', '--surface']],
    ['--warn', ['--warn-soft', '--surface']],
    ['--info', ['--info-soft', '--surface']],
    // semantic text directly on surface (chips without a pill) — incl. the gold capability labels
    ['--success', '--surface'], ['--warn', '--surface'], ['--info', '--surface'], ['--gold', '--surface'],
    // ON-BUTTON foregrounds — the pairs the old guard skipped; these must fail on a white-on-pastel revert
    ['--primary-fg', '--primary'], ['--success-fg', '--success'], ['--warn-fg', '--warn'],
  ];
  for (const [M, tag] of [[DARK, 'dark'], [LIGHT, 'light']]) {
    for (const [fg, bg, opt] of PAIRS) {
      const c = cratio(opaqueRgb(M, fg), opaqueRgb(M, bg));
      const min = opt && opt.large ? 3 : 4.5;
      assert.ok(c >= min, `${tag} ${fg} on ${Array.isArray(bg) ? bg.join('∘') : bg} = ${c.toFixed(2)} ≥ ${min}`);
    }
    // white notification-badge text on the SOLID badge-red
    const badge = cratio(hex('#ffffff'), opaqueRgb(M, '--accent-solid'));
    assert.ok(badge >= 4.5, `${tag} badge white on --accent-solid = ${badge.toFixed(2)}`);
  }
  ok('computed WCAG contrast ≥4.5:1 (incl. alpha-composited pills + on-button foregrounds) in both themes');
}

// ─────────────────────────────────────────────────────────────────────────────
// No ORPHANED hardcoded color — SELECTOR-SCOPED. Every component rule is parsed; a hex is legal only on the
// specific selector granted it (brand mark/chips, info-window, badge/switch white), and a raw rgba background
// (dark OR white) is legal only on the known scrim/brand selectors. A dark rgba tile bg or a stray brand hex
// on any other selector fails here.
// ─────────────────────────────────────────────────────────────────────────────
{
  let style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));
  style = style.replace(/\/\*[\s\S]*?\*\//g, '');   // drop comments (hex/ids inside them aren't rules)
  // Rule-based scoping (NOT a range-strip — single-line :root blocks made a range-strip over-consume): parse
  // every flat rule, then skip :root token blocks, at-rules, and @keyframes stops; the rest are components.
  const skipSel = (sel) => /:root\b/.test(sel) || /^@/.test(sel) || /^[\d.]+%$/.test(sel) || /^(from|to)$/.test(sel) || sel === '';
  // selector → hex literals it is allowed to carry (substring match: key ⊆ rule selector)
  const HEX_OK = [
    ['.tb-brand', ['#e85a58', '#cc2e2c', '#fff']],       // brand mark gradient + white glyph
    ['.rest-x_pizza', ['#F6935F']], ['.rest-la_musa', ['#46C7BB']], // restaurant-brand chips
    ['.aa-sw', ['#fff']],                                // auto-assign switch thumb
    ['.info-window', ['#0a0a0a', '#555', '#fff']],       // always-white Google info bubble
    ['.rn', ['#fff']], ['.rail-badge', ['#fff']],        // white text on red count badges
  ];
  // selectors allowed a raw (non-var) rgba background: full-cover scrims + brand-tinted chips
  const BG_RGBA_OK = ['.msg-modal', '.order-detail-modal', '.overlay-bg', '.comms-scrim', '.rest-x_pizza', '.rest-la_musa'];
  const ruleRe = /([^{}]+)\{([^{}]+)\}/g;
  let m, hexOrphans = [], bgOrphans = [];
  while ((m = ruleRe.exec(style))) {
    const sel = m[1].trim().replace(/\s+/g, ' '), body = m[2];
    if (skipSel(sel)) continue; // :root token blocks, at-rules, keyframe stops
    for (const d of body.split(';')) {
      // hex literals — must be granted to this selector
      for (const hm of d.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const h = hm[0];
        const granted = HEX_OK.some(([k, list]) => sel.includes(k) && list.some(a => a.toLowerCase() === h.toLowerCase()));
        if (!granted) hexOrphans.push(`${h} @ ${sel}`);
      }
      // raw rgba background — must be a known scrim/brand selector
      const bm = d.match(/(?:^|\b)(background(?:-color)?)\s*:\s*(.+)/);
      if (bm && /rgba?\(/.test(bm[2]) && !/var\(/.test(bm[2])) {
        if (!BG_RGBA_OK.some(k => sel.includes(k))) bgOrphans.push(`${bm[2].trim()} @ ${sel}`);
      }
    }
  }
  assert.deepStrictEqual(hexOrphans, [], `no hex literal on an un-granted selector (found: ${hexOrphans.join(' ; ')})`);
  assert.deepStrictEqual(bgOrphans, [], `no un-tokenized rgba background off the scrim/brand allowlist (found: ${bgOrphans.join(' ; ')})`);
  ok('orphan guard is selector-scoped: brand hex + scrim rgba only on their own selectors; a stray dark tile bg fails');
}

// ─────────────────────────────────────────────────────────────────────────────
// Rename = VISIBLE TEXT ONLY (Despacho); every torre-* DOM id + the renderDispatcherAlerts wire intact.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /<title>X Pizza · Despacho<\/title>/, 'title renamed to Despacho');
  assert.match(html, /<span class="tb-brand"><span class="tb-x">X<\/span> Despacho<\/span>/, 'topbar brand renamed');
  assert.match(html, /<h3>Despacho<\/h3>/, 'left-rail exceptions heading renamed');
  assert.doesNotMatch(html, />Torre de control</, 'no visible "Torre de control" text remains');
  // DOM ids / wiring intact (renaming visible text must not touch these)
  assert.match(html, /id="torre-list"/, '#torre-list id intact');
  assert.match(html, /\$\('torre-list'\)/, "renderDispatcherAlerts still wires \$('torre-list')");
  assert.match(html, /class="torre-head"/, '.torre-head class intact');
  assert.match(html, /class="torre-count/, '.torre-count class intact');
  ok('rename touched visible text only (Despacho); torre-* ids + $(\'torre-list\') wire intact');
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme toggle — persisted, localStorage-guarded, default dark, sets data-theme, sun/moon icons present.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /<symbol id="i-sun"/, 'sun icon present');
  assert.match(html, /<symbol id="i-moon"/, 'moon icon present');
  assert.match(html, /id="theme-toggle"/, 'toggle button present');
  const init = html.slice(html.indexOf('function initTheme('), html.indexOf('function initTheme(') + 1500);
  assert.match(init, /try \{ theme = localStorage\.getItem\('despacho-theme'\) \|\| 'dark'; \} catch \(_\) \{\}/, 'reads localStorage guarded, default dark');
  assert.match(init, /try \{ localStorage\.setItem\('despacho-theme', theme\); \} catch \(_\) \{\}/, 'writes localStorage guarded');
  assert.match(init, /setAttribute\('data-theme', 'light'\)/, 'applies data-theme=light');
  assert.match(init, /removeAttribute\('data-theme'\)/, 'clears data-theme for dark (default)');
  ok('theme toggle: persisted + guarded + default dark + data-theme on <html> + sun/moon');
}

// ─────────────────────────────────────────────────────────────────────────────
// Dead-CSS cleanup — the dual card system + orphan risk-summary are gone; live rules survive; no undefined var.
// ─────────────────────────────────────────────────────────────────────────────
{
  for (const dead of ['.order-card', '.driver-card', '.sidebar', '.layout ', '#risk-summary', 'function updateRiskSummary']) {
    assert.ok(!html.includes(dead), `dead code removed: ${dead}`);
  }
  for (const live of ['.map-ctrl ', '.status-dot', '.panel-section', '.tree-group ', '.driver-row', '.ord ', '.ex ']) {
    assert.ok(html.includes(live), `live rule intact: ${live}`);
  }
  assert.match(html, /--success-hover:/, '--success-hover now defined (was undefined)');
  // no undefined var(--…) — the --surface-4 class of bug: every var referenced in the stylesheet must be
  // DEFINED somewhere in it (a :root block, a theme block, or a per-element rule); a reference with no
  // definition anywhere (as --surface-4 was) fails here. Palette-token theme-parity is covered by group 1.
  {
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const referenced = new Set([...style.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));
    const defined = new Set([...style.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    const undef = [...referenced].filter(k => !defined.has(k));
    assert.deepStrictEqual(undef, [], `every referenced var(--…) has a definition (undefined: ${undef.join(', ')})`);
    // and the specific token that regressed is defined in BOTH themes
    assert.ok('--surface-4' in DARK && '--surface-4' in LIGHT, '--surface-4 defined in both themes');
  }
  ok('dead card-system CSS + risk-summary retired; live rules intact; every var(--…) has a definition');
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner ruling: the map follows the theme — dark = DARK_MAP_STYLE, light = NORMAL map; toggled LIVE.
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.match(html, /styles: currentMapStyles\(\),/, 'map init picks style from currentMapStyles() (not a hardcoded DARK_MAP_STYLE)');
  assert.match(html, /map\.setOptions\(\{ styles: currentMapStyles\(\) \}\)/, 'the theme toggle swaps the LIVE map via setOptions');
  const m = html.match(/function currentMapStyles\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'currentMapStyles source located');
  const DARK_SENTINEL = ['__DARK_MAP__'];
  // eslint-disable-next-line no-new-func
  const light = new Function('document', 'DARK_MAP_STYLE', `${m[0]}; return currentMapStyles;`)({ documentElement: { getAttribute: () => 'light' } }, DARK_SENTINEL);
  // eslint-disable-next-line no-new-func
  const dark = new Function('document', 'DARK_MAP_STYLE', `${m[0]}; return currentMapStyles;`)({ documentElement: { getAttribute: () => null } }, DARK_SENTINEL);
  assert.deepStrictEqual(light(), [], 'light theme → normal map (styles: [])');
  assert.strictEqual(dark(), DARK_SENTINEL, 'dark theme → DARK_MAP_STYLE');
  ok('map follows the theme: light → normal map, dark → DARK_MAP_STYLE, swapped live via setOptions');
}

console.log(`\ndispatch-theme: OK (${n} groups)`);
