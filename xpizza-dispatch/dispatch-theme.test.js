// xpizza-dispatch/dispatch-theme.test.js
//
// Slice C-1 — two-theme pastel token system + rename + dead-CSS (design:
// docs/superpowers/specs/2026-09-20-dispatch-C-theme-system-rename-design.md).
//
// Guards (all on the shipped file): both themes COMPLETE (same token set); COMPUTED WCAG contrast ≥4.5:1 for
// functional text in BOTH themes (not intent); no orphaned hardcoded color that would break light mode; the
// theme toggle persists + is localStorage-guarded; rename touched VISIBLE TEXT ONLY (Despacho) with every
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

// ---- WCAG contrast ----
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const contrast = (a, b) => { const la = L(hex(a)), lb = L(hex(b)); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

// ─────────────────────────────────────────────────────────────────────────────
// Both themes are COMPLETE — the light theme redefines every theme-varying token the dark theme sets, so no
// element can borrow the dark theme's value in light mode.
// ─────────────────────────────────────────────────────────────────────────────
{
  const themed = Object.keys(DARK);
  const missing = themed.filter(k => !(k in LIGHT));
  assert.deepStrictEqual(missing, [], `light theme defines every dark token (missing: ${missing.join(', ')})`);
  for (const k of ['--bg', '--surface', '--text', '--text-dim', '--primary', '--primary-fg', '--accent', '--accent-solid', '--success', '--card-1', '--map-bg', '--hair', '--shadow-c', '--sel'].filter(x => x in DARK)) {
    assert.ok(LIGHT[k] && DARK[k], `both themes define ${k}`);
    if (k !== undefined) assert.notStrictEqual(LIGHT[k], undefined);
  }
  // dark ≠ light for the ground/surfaces (proves the light theme actually inverts, not a copy)
  assert.notStrictEqual(DARK['--bg'], LIGHT['--bg'], 'bg differs between themes');
  assert.notStrictEqual(DARK['--surface'], LIGHT['--surface'], 'surface differs between themes');
  ok(`both themes complete: light redefines all ${themed.length} dark tokens; grounds differ`);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTED contrast ≥4.5:1 for functional text, in BOTH themes (parsed from the actual token values).
// ─────────────────────────────────────────────────────────────────────────────
{
  const pairs = [
    // [theme map, fg token, bg token or literal]
    [DARK, '--text', '--bg'], [DARK, '--text-soft', '--surface'], [DARK, '--text-dim', '--surface'], [DARK, '--text-dim', '--surface-2'],
    [DARK, '--primary-fg', '--primary'], [DARK, '--success', '--surface'],
    [LIGHT, '--text', '--bg'], [LIGHT, '--text-soft', '--surface'], [LIGHT, '--text-dim', '--surface'], [LIGHT, '--text-dim', '--surface-2'],
    [LIGHT, '--primary-fg', '--primary'], [LIGHT, '--success', '--surface-2'], [LIGHT, '--accent', '--surface'],
  ];
  for (const [M, fg, bg] of pairs) {
    const fv = M[fg], bv = M[bg];
    if (!/^#/.test(fv) || !/^#/.test(bv)) continue;   // only hex-vs-hex
    const c = contrast(fv, bv);
    assert.ok(c >= 4.5, `${M === DARK ? 'dark' : 'light'} ${fg}(${fv}) on ${bg}(${bv}) = ${c.toFixed(2)} ≥ 4.5`);
  }
  // white notification-badge text on the SOLID badge-red (both themes)
  assert.ok(contrast('#ffffff', DARK['--accent-solid']) >= 4.5, `dark badge white on --accent-solid = ${contrast('#ffffff', DARK['--accent-solid']).toFixed(2)}`);
  assert.ok(contrast('#ffffff', LIGHT['--accent-solid']) >= 4.5, `light badge white on --accent-solid = ${contrast('#ffffff', LIGHT['--accent-solid']).toFixed(2)}`);
  ok('computed WCAG contrast ≥4.5:1 for functional text + badges in both themes');
}

// ─────────────────────────────────────────────────────────────────────────────
// No ORPHANED hardcoded color — every theme-varying color is a token. Only intentional literals remain:
// brand mark/chips, white-on-color, and the Google Maps info-window (always-white bubble) dark text.
// ─────────────────────────────────────────────────────────────────────────────
{
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // strip the two :root token blocks (definitions are allowed to be literal)
  const noRoot = style.replace(/:root(\[data-theme="light"\])? \{[\s\S]*?\n  \}/g, '');
  const allow = /#fff\b|#ffffff\b|#e85a58|#cc2e2c|#F6935F|#46C7BB|#0a0a0a|#555\b|#FBF0CE|#7A5B0C/i;  // brand · white · info-window · sched-badge comment
  const orphans = [...noRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]).filter(h => !allow.test(h));
  assert.deepStrictEqual([...new Set(orphans)], [], `no orphaned hardcoded hex outside :root (found: ${[...new Set(orphans)].join(', ')})`);
  // no raw white/near-black overlay rgba left un-tokenized in component rules (hairlines/shadows are tokens)
  assert.doesNotMatch(noRoot, /background:\s*rgba\(255,\s*255,\s*255/, 'no raw white-overlay background outside tokens');
  ok('no orphaned hardcoded color — light theme cannot borrow a dark value');
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
  const init = html.slice(html.indexOf('function initTheme('), html.indexOf('function initTheme(') + 900);
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
  ok('dead card-system CSS + risk-summary retired; live rules intact; --success-hover resolved');
}

console.log(`\ndispatch-theme: OK (${n} groups)`);
