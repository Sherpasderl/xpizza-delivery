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

// ---- rule table: parse every flat CSS rule as { parts:[selector,…], body } (skip @-rules / nested) ----
const styleSrc = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const RULES = [];
for (const m of styleSrc.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
  const sel = m[1].trim().replace(/\s+/g, ' ');
  if (/[{}]/.test(sel) || /^@/.test(sel)) continue;
  RULES.push({ parts: sel.split(',').map(s => s.trim()), body: m[2] });
}
// value of `prop` from the LAST rule that lists EXACTLY `sel` as one of its comma-parts (cascade: last wins)
const decl = (sel, prop) => {
  let v;
  for (const r of RULES) {
    if (!r.parts.includes(sel)) continue;
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'); let mm;
    while ((mm = re.exec(r.body))) v = mm[1].trim();
  }
  return v;
};

// ---- color math (rgb kept in 0..1) ----
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const RGBA = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)/;
// resolve ANY CSS color value (against a theme's token map) → { rgb, a }: keyword, #hex, rgb(a), var(--x[,fb]), gradient(first stop)
const resolveColor = (M, v) => {
  v = String(v).trim();
  if (v === 'white') return { rgb: [1, 1, 1], a: 1 };
  if (v === 'black') return { rgb: [0, 0, 0], a: 1 };
  const vm = v.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\)$/);
  if (vm) { const t = M[vm[1]]; if (t !== undefined) return resolveColor(M, t); if (vm[2]) return resolveColor(M, vm[2]); throw new Error(`undefined var ${vm[1]}`); }
  if (v.startsWith('linear-gradient')) { const c = v.match(/#[0-9a-fA-F]{3,8}|var\([^)]+\)|rgba?\([^)]+\)|white|black/); return resolveColor(M, c[0]); }
  if (/^#/.test(v)) return { rgb: hex(v), a: 1 };
  const rm = v.match(RGBA); if (rm) return { rgb: [+rm[1] / 255, +rm[2] / 255, +rm[3] / 255], a: rm[4] !== undefined ? +rm[4] : 1 };
  throw new Error(`cannot resolve color: ${v}`);
};
const overC = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
// composite a chain of layer VALUES (nearest-first; last must resolve opaque) → the real pixel rgb behind the text
const composite = (M, layers) => {
  let bg = resolveColor(M, layers[layers.length - 1]); assert.ok(bg.a >= 1, `bg chain tail opaque: ${layers[layers.length - 1]}`); bg = bg.rgb;
  for (let i = layers.length - 2; i >= 0; i--) { const c = resolveColor(M, layers[i]); bg = overC(c.rgb, c.a, bg); }
  return bg;
};
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const cratio = (a, b) => { const la = L(a), lb = L(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const val = (M, t) => (M[t] !== undefined ? M[t] : t);                 // token name → its value, else literal
const opaqueRgb = (M, spec) => (Array.isArray(spec) ? composite(M, [val(M, spec[0]), val(M, spec[1])]) : resolveColor(M, val(M, spec)).rgb);

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
// COMPUTED contrast ≥4.5:1 (large ≥3:1) for functional text, in BOTH themes — sampled from the REAL COMPONENTS,
// not hand-picked token pairs. For each functional element the guard reads its ACTUAL declared `color`,
// composites its ACTUAL `background` over the real ancestor chain, and multiplies in any `opacity` on the
// element/ancestors. So a fg reverted to white-on-pastel (on-button), a soft pill sampled over the wrong
// surface, or an `opacity` that dims meta below AA each go RED here — the class the token-pair guard missed.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Base text tokens on their grounds (these caught the muted-text regression — keep them).
  const TOKEN_PAIRS = [
    ['--text', '--bg'], ['--text', '--surface'], ['--text-soft', '--surface'],
    ['--text-dim', '--surface'], ['--text-dim', '--surface-2'], ['--gold', '--surface'],
  ];
  // Real functional components. bg = layer VALUES nearest→base (a {sel} reads that rule's actual `background`);
  // op = { sels } whose real `opacity` multiplies, over `backdrop`. Colors/opacity all READ from the file.
  const rd = (x, M) => (typeof x === 'string' ? x : decl(x.sel, 'background'));
  const COMPS = [
    { n: 'hot count .tree-group-meta.hot', fg: '.tree-group-meta.hot', bg: [{ sel: '.tree-group-meta.hot' }] },
    { n: 'hot count .panel-count.hot', fg: '.panel-count.hot', bg: [{ sel: '.panel-count.hot' }] },
    { n: '.dispatcher-alert', fg: '.dispatcher-alert', bg: [{ sel: '.dispatcher-alert' }] },
    { n: 'active Cola count', fg: '.cola-seg-btn.on .cola-seg-n', bg: [{ sel: '.cola-seg-btn.on .cola-seg-n' }, { sel: '.cola-seg-btn.on' }] },
    { n: 'status available', fg: '.status-pill.available', bg: [{ sel: '.status-pill.available' }, '--card-1'] },
    { n: 'status assigned', fg: '.status-pill.assigned', bg: [{ sel: '.status-pill.assigned' }, '--card-1'] },
    { n: 'status en_route', fg: '.status-pill.en_route_delivery', bg: [{ sel: '.status-pill.en_route_delivery' }, '--card-1'] },
    { n: 'status off_shift', fg: '.status-pill.off_shift', bg: [{ sel: '.status-pill.off_shift' }, '--card-1'] },
    { n: 'stale row .dm meta', fg: '.who .dm', bg: ['--card-1', '--surface'], op: { sels: ['.driver-row.stale'], backdrop: '--surface' } },
    { n: 'handled msg body', fg: '.msg-row.handled .msg-row-body', bg: ['--surface'], op: { sels: ['.msg-row.handled'], backdrop: '--surface' } },
    { n: 'btn assign-self', fg: '.unassigned-card .assign-self-btn', bg: [{ sel: '.unassigned-card .assign-self-btn' }] },
    { n: 'btn od-action primary', fg: '.od-action-btn.primary', bg: [{ sel: '.od-action-btn.primary' }] },
    { n: 'btn msg-action primary', fg: '.msg-action-btn.primary', bg: [{ sel: '.msg-action-btn.primary' }] },
    { n: 'btn recon materialize', fg: '.recon-btn.materialize', bg: [{ sel: '.recon-btn.materialize' }] },
    { n: 'btn recon refund', fg: '.recon-btn.refund', bg: [{ sel: '.recon-btn.refund' }] },
    { n: 'od-row phone link', fg: '.od-row a', bg: ['--surface'] },
  ];
  for (const [M, tag] of [[DARK, 'dark'], [LIGHT, 'light']]) {
    for (const [fg, bg] of TOKEN_PAIRS) {
      const c = cratio(opaqueRgb(M, fg), opaqueRgb(M, bg));
      assert.ok(c >= 4.5, `${tag} ${fg} on ${bg} = ${c.toFixed(2)} ≥ 4.5`);
    }
    for (const comp of COMPS) {
      const fgVal = decl(comp.fg, 'color');
      assert.ok(fgVal, `${tag} ${comp.n}: real color declaration found`);
      let fg = resolveColor(M, fgVal).rgb;
      let bg = composite(M, comp.bg.map(x => { const v = rd(x, M); assert.ok(v, `${comp.n}: background declaration found`); return val(M, v); }));
      if (comp.op) {
        let a = 1; for (const s of comp.op.sels) { const o = decl(s, 'opacity'); if (o !== undefined) a *= parseFloat(o); }
        const bd = resolveColor(M, val(M, comp.op.backdrop)).rgb;
        fg = overC(fg, a, bd); bg = overC(bg, a, bd);   // opacity dims text AND its bg over the backdrop
      }
      const c = cratio(fg, bg);
      assert.ok(c >= 4.5, `${tag} REAL ${comp.n} (fg ${fgVal}) = ${c.toFixed(2)} ≥ 4.5`);
    }
    // white notification-badge text on the SOLID badge-red
    const badge = cratio(hex('#ffffff'), opaqueRgb(M, '--accent-solid'));
    assert.ok(badge >= 4.5, `${tag} badge white on --accent-solid = ${badge.toFixed(2)}`);
  }
  ok('computed WCAG ≥4.5:1 from REAL components (declared fg + composited ancestor bg + opacity) in both themes');
}

// ─────────────────────────────────────────────────────────────────────────────
// No ORPHANED hardcoded color — SELECTOR-SCOPED. Every component rule is parsed; a hex is legal only on the
// specific selector granted it (brand mark/chips, info-window, badge/switch white), and a raw rgba background
// (dark OR white) is legal only on the known scrim/brand selectors. A dark rgba tile bg or a stray brand hex
// on any other selector fails here.
// ─────────────────────────────────────────────────────────────────────────────
{
  const isRoot = (part) => /:root\b/.test(part) || /^[\d.]+%$/.test(part) || /^(from|to)$/.test(part);
  // key ⊆ compound-part grants these hexes. Split on COMMAS first, so a co-selector (`.rest-x_pizza, .ex`)
  // can't launder a brand hex onto an unrelated part — EVERY part carrying the literal must be granted.
  const HEX_OK = [
    ['.tb-brand', ['#e85a58', '#cc2e2c', '#fff']],       // brand mark gradient + white glyph
    ['.rest-x_pizza', ['#F6935F']], ['.rest-la_musa', ['#46C7BB']], // restaurant-brand chips
    ['.aa-sw', ['#fff']],                                // auto-assign switch thumb
    ['.info-window', ['#0a0a0a', '#555', '#fff']],       // always-white Google info bubble
    ['.rn', ['#fff']], ['.rail-badge', ['#fff']],        // white text on red count badges
  ];
  // parts allowed a raw (non-var) rgba background: full-cover scrims + brand-tinted chips
  const BG_RGBA_OK = ['.msg-modal', '.order-detail-modal', '.overlay-bg', '.comms-scrim', '.rest-x_pizza', '.rest-la_musa'];
  const grantsHex = (part, h) => HEX_OK.some(([k, list]) => part.includes(k) && list.some(a => a.toLowerCase() === h.toLowerCase()));
  let hexOrphans = [], bgOrphans = [];
  for (const r of RULES) {
    const parts = r.parts.filter(p => !isRoot(p));       // ignore :root token blocks / keyframe stops
    if (!parts.length) continue;
    for (const d of r.body.split(';')) {
      // a hex applies to EVERY comma-part of the rule → each part must be granted it
      for (const hm of d.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const h = hm[0];
        for (const part of parts) if (!grantsHex(part, h)) hexOrphans.push(`${h} @ ${part}`);
      }
      // raw rgba background applies to every comma-part → each must be an allowed scrim/brand part
      const bm = d.match(/(?:^|\b)(background(?:-color)?)\s*:\s*(.+)/);
      if (bm && /rgba?\(/.test(bm[2]) && !/var\(/.test(bm[2])) {
        for (const part of parts) if (!BG_RGBA_OK.some(k => part.includes(k))) bgOrphans.push(`${bm[2].trim()} @ ${part}`);
      }
    }
  }
  assert.deepStrictEqual(hexOrphans, [], `no hex literal on an un-granted selector part (found: ${hexOrphans.join(' ; ')})`);
  assert.deepStrictEqual(bgOrphans, [], `no un-tokenized rgba background off the scrim/brand allowlist (found: ${bgOrphans.join(' ; ')})`);
  ok('orphan guard is selector-scoped (comma-split): brand hex + scrim rgba only on their own parts; a co-selector or dark tile bg fails');
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
