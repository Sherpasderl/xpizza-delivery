// The portal's LOOK is the owner-approved LIGHT Bold Editorial (2026-10-05): light on EVERY device (no toggle), Archivo
// actually loaded for display type. Pins the three facts the live portal got wrong (it rendered black, in system type):
//   1. <html data-theme="light"> — exactly "light", never "dark", so neither the explicit dark block nor an OS dark-mode
//      preference can apply (the prefers-color-scheme block is guarded by :not([data-theme="light"]));
//   2. exactly ONE Google Fonts stylesheet, Archivo as the 600..800 weight range (covers the 750/800 in use), no Hanken;
//   3. the CSP already admits fonts.googleapis.com (style-src) and fonts.gstatic.com (font-src).
//
// COLOUR GUARANTEE (advisor ruling, codex r6 — a change of model): no colour can change without failing this test (the
// FREEZE below). The discovering sweep and the allowlist grammar are AIDS: the sweep does not see DOM placement made by JS
// (e.g. review.js decides which container an element is rendered in), so it makes no completeness claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = read('./index.html');
const css = read('./styles.css');
const toml = read('./netlify.toml');

test('the page is LIGHT on every device: <html data-theme="light">, never "dark"', () => {
  const tag = html.match(/<html\b[^>]*>/);
  assert.ok(tag, 'an <html> tag');
  assert.match(tag[0], /\sdata-theme="light"/, 'data-theme is exactly "light"');
  assert.equal((tag[0].match(/data-theme=/g) || []).length, 1, 'one data-theme attribute');
  assert.ok(!/data-theme="dark"/.test(html), 'no data-theme="dark" anywhere in the page');
});

test('OS dark mode cannot override the explicit light attribute; the dark blocks are kept (unused)', () => {
  const media = css.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*([^{]+)\{/);
  assert.ok(media, 'the prefers-color-scheme:dark block exists (kept for a future toggle)');
  assert.match(media[1], /:root:not\(\[data-theme="light"\]\)/, 'its selector is guarded by :not([data-theme="light"])');
  assert.ok(/:root\[data-theme="dark"\]\s*\{/.test(css), 'the explicit dark block is kept');
  assert.ok(/:root,\s*:root\[data-theme="light"\]\s*\{/.test(css), 'the light tokens apply to :root and [data-theme="light"]');
});

test('fonts: exactly one Google Fonts stylesheet — Archivo, weight range 600..800; no Hanken anywhere', () => {
  const sheets = [...html.matchAll(/<link\b[^>]*href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"[^>]*>/g)].map((m) => m[0]);
  const stylesheets = sheets.filter((l) => /rel="stylesheet"/.test(l));
  assert.equal(stylesheets.length, 1, `exactly one Google Fonts stylesheet (got ${stylesheets.length})`);
  assert.match(stylesheets[0], /href="https:\/\/fonts\.googleapis\.com\/css2\?family=Archivo:wght@600\.\.800&display=swap"/);
  assert.ok(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/.test(html), 'preconnect to the CSS host kept');
  assert.ok(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/.test(html), 'preconnect to the font host kept');
  assert.ok(!/Hanken/i.test(html) && !/Hanken/i.test(css), 'Hanken Grotesk is gone (nothing referenced it)');
  assert.match(css, /--disp:'Archivo'/, 'the display stack leads with Archivo — the face now loaded');
});

test('every rule that sets the Archivo display face (font-family:var(--disp)) declares a weight inside the loaded 600..800 range', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*font-family\s*:\s*var\(--disp\)[^{}]*)\}/g)];
  assert.ok(rules.length > 0, 'non-vacuity: --disp rules were found');
  for (const [, sel, body] of rules) {
    const w = [...body.matchAll(/font-weight\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(w.length, 1, `${sel.trim()}: declares exactly one font-weight (an inherited weight could fall outside the loaded range)`);
    assert.ok(w[0] >= 600 && w[0] <= 800, `${sel.trim()}: weight ${w[0]} is inside the loaded 600..800 range`);
  }
});

// ── WCAG AA (4.5:1) for the two text-on-soft pairs light mode exposed (codex REVISE on 0ae145f) ──
const lightBlock = css.match(/:root,\s*:root\[data-theme="light"\]\s*\{([^}]*)\}/)[1];
const token = (name) => { const m = lightBlock.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`)); assert.ok(m, `light token --${name}`); return m[1]; };
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const ruleBody = (sel) => { const m = css.match(new RegExp(`${sel.replace(/\./g, '\\.')}\\{([^}]*)\\}`)); assert.ok(m, `rule ${sel}`); return m[1]; };
const varOf = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*var\\(--([a-z0-9-]+)\\)`)); assert.ok(m, `${prop} is a token`); return m[1]; };

const AA_PAIRS = [
  ['.pdelta.dn', 'the price-decrease %'], ['.err', 'the login error'],
  ['.tag.new', 'the NEW tag'], ['.dchip.add', 'the added diff chip'], ['.opill.ok', 'the paid order pill'], ['.bchip.add', 'the added bundle chip'],
  ['.del:hover', 'the delete hover'], ['.dchip.rem', 'the removed diff chip'], ['.model:hover', 'the modifier delete hover'],
  ['.opill.refund', 'the refund order pill'], ['.premove:hover', 'the remove hover'], ['.bchip.rem', 'the removed bundle chip'],
];
for (const [sel, label] of AA_PAIRS) {
  test(`AA: ${label} (${sel}) text clears 4.5:1 on its soft background in the light theme`, () => {
    const body = ruleBody(sel);
    const fg = token(varOf(body, 'color'));
    const bg = token(varOf(body, 'background'));
    const r = contrast(fg, bg);
    assert.ok(r >= 4.5, `${sel}: ${fg} on ${bg} = ${r.toFixed(2)}:1 (needs ≥ 4.5)`);
  });
}
// ═══ COLOUR FREEZE (advisor ruling after codex r6) — complete by construction ═══════════════════════════════════════
// Every LIGHT-applicable declaration of color / background / background-color / border-color, as (at-rule context, the
// EXACT selector text, property, value with whitespace normalised), plus every token of the light :root block, is frozen
// in portal-colour-freeze.golden.json. ANY difference fails: a new, changed or removed declaration, a changed selector, a
// changed token. Order-insensitive (a multiset with counts), so reordering rules is not a change; value whitespace is
// normalised, so a reformat is not a change. Not light-applicable (excluded): the dark-scheme @media and the
// `:root[data-theme="dark"]` theme selectors. Regenerate ONLY with the AA review: PORTAL_FREEZE_WRITE=1 node --test …
const FREEZE_PROPS = new Set(['color', 'background', 'background-color', 'border-color']);
const FREEZE_FILE = new URL('./portal-colour-freeze.golden.json', import.meta.url);
function colourFreezeOf(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = [];
  let tokens = null;
  const walk = (str, ctx) => {
    let i = 0;
    while (i < str.length) {
      const open = str.indexOf('{', i);
      if (open < 0) break;
      const prelude = str.slice(i, open).trim();
      let depth = 1, k = open + 1;
      while (k < str.length && depth) { if (str[k] === '{') depth += 1; else if (str[k] === '}') depth -= 1; k += 1; }
      const body = str.slice(open + 1, k - 1);
      if (prelude.startsWith('@')) {
        if (!(/^@media/.test(prelude) && /prefers-color-scheme\s*:\s*dark/.test(prelude))) walk(body, [...ctx, prelude.replace(/\s+/g, ' ')]);
      } else if (!ctx.length && normSel(prelude) === ':root,:root[data-theme="light"]') {
        tokens = Object.fromEntries(parseDecls(body).filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value]));
      } else if (!splitSelectors(prelude).every((x) => /^:root\[data-theme="dark"\]/.test(x.trim()))) {
        for (const d of parseDecls(body)) if (FREEZE_PROPS.has(d.prop)) decls.push([ctx.join(' '), prelude, d.prop, d.value]);
      }
      i = k;
    }
  };
  walk(text, []);
  return { tokens: tokens || {}, declarations: decls.map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x)) };
}
function freezeDiff(cssText, golden) {
  const cur = colourFreezeOf(cssText);
  const count = (list) => { const m = new Map(); for (const x of list) { const k = JSON.stringify(x); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const a = count(cur.declarations), b = count(golden.declarations);
  const added = [], removed = [];
  for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) || 0); i += 1) added.push(k);
  for (const [k, n] of b) for (let i = 0; i < n - (a.get(k) || 0); i += 1) removed.push(k);
  const tokenChanges = [];
  for (const t of new Set([...Object.keys(cur.tokens), ...Object.keys(golden.tokens)])) if (cur.tokens[t] !== golden.tokens[t]) tokenChanges.push(`${t}: ${golden.tokens[t]} → ${cur.tokens[t]}`);
  return { added, removed, tokenChanges };
}
const FREEZE_MSG = 'colour change: re-run the AA review (advisor + codex) and update the golden in the same commit';

// DISCOVERING SWEEP (codex r2 S1) — every LIGHT-mode text-on-soft pairing in styles.css, found by parsing, not listed:
//   (a) a rule that sets BOTH a text color and a -soft background;
//   (b) a DESCENDANT rule (`A … B`) whose text sits on a -soft background INHERITED from an ancestor rule R whose last
//       compound contains A's classes (e.g. `.prow .arr` inside `.prow.big`) — using the most specific color override that
//       applies inside R (e.g. `.prow.big .arr`), and skipping a descendant that paints its own background;
//   (c) a -soft background rule with no color of its own: the SAME element's base color (a less specific rule on it), else
//       the inherited body ink.
// Both colors resolve through the light :root tokens; contrast is asserted UNROUNDED ≥ 4.5. Dark-scheme blocks are excluded.
function parseRules(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const walk = (str) => {
    let i = 0;
    while (i < str.length) {
      const open = str.indexOf('{', i);
      if (open < 0) break;
      const prelude = str.slice(i, open).trim();
      let depth = 1, k = open + 1;
      while (k < str.length && depth) { if (str[k] === '{') depth += 1; else if (str[k] === '}') depth -= 1; k += 1; }
      const body = str.slice(open + 1, k - 1);
      if (prelude.startsWith('@media')) { if (!/prefers-color-scheme\s*:\s*dark/.test(prelude)) walk(body); }
      else if (!prelude.startsWith('@')) out.push({ prelude, body });
      i = k;
    }
  };
  walk(text);
  return out;
}
const splitSelectors = (p) => { const r = []; let d = 0, cur = ''; for (const ch of p) { if (ch === '(') d += 1; if (ch === ')') d -= 1; if (ch === ',' && !d) { r.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) r.push(cur.trim()); return r; };
const compounds = (sel) => sel.replace(/\s*[>+~]\s*/g, ' ').split(/\s+/).filter(Boolean);
const classesOf = (c) => new Set((c.replace(/::?[a-z-]+(\([^)]*\))?/g, '').match(/\.[A-Za-z0-9_-]+/g) || []).map((x) => x.slice(1)));
const subset = (a, b) => [...a].every((x) => b.has(x));
const pseudosOf = (c) => new Set(c.match(/::?[a-z-]+(\([^)]*\))?/g) || []);
const tagOf = (c) => { const m = c.match(/^[A-Za-z][A-Za-z0-9-]*|^\*/); return m ? m[0].toLowerCase() : ''; };
// ONE declaration normaliser for BOTH the grammar and the sweep (codex r5 e): property names LOWERCASED (so `COLOR:` is
// the same declaration everywhere), a CSS escape in a property name FLAGGED (the grammar refuses it), values
// whitespace-normalised with `var( --x )` → `var(--x)`.
const normDeclValue = (v) => v.trim().replace(/\s+/g, ' ').replace(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g, 'var($1)');
function parseDecls(body) {
  return body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    if (i < 0) return null;
    const raw = d.slice(0, i).trim();
    return { raw, prop: raw.toLowerCase(), value: normDeclValue(d.slice(i + 1)), escaped: raw.includes('\\') };
  }).filter(Boolean);
}
// LAST declaration wins within a rule: the last declaration of the property decides (a non-var() value → no token)
const decl = (body, prop) => { const re = new RegExp(`^${prop}$`); let v = null; for (const d of parseDecls(body)) if (re.test(d.prop)) { const m = d.value.match(/^var\((--[a-z0-9-]+)\)$/); v = m ? m[1].slice(2) : null; } return v; };
const hasBg = (body) => parseDecls(body).some((d) => /^background(-color)?$/.test(d.prop));
// a background that PAINTS its own ground; transparent / none / inherit RETAIN the ancestor's (codex r4 #5, ruling A1)
const paintsOwnBg = (body) => { const bg = parseDecls(body).filter((d) => /^background(-color)?$/.test(d.prop)); if (!bg.length) return false; return !['transparent', 'none', 'inherit'].includes(bg[bg.length - 1].value.toLowerCase()); };

function discoverSoftPairs(cssText) {
  // the CASCADE within one selector: rules with the same selector merge, a later declaration wins per property
  const bySel = new Map();
  parseRules(cssText).forEach(({ prelude, body }, order) => {
    for (const sel of splitSelectors(prelude)) {
      if (/data-theme="dark"|:not\(\[data-theme="light"\]\)|^:root/.test(sel)) continue;
      const key = sel.replace(/\s+/g, ' ');
      const cs = compounds(key);
      const prev = bySel.get(key) || { sel: key, cs, last: classesOf(cs[cs.length - 1]), lastPseudo: pseudosOf(cs[cs.length - 1]), lastTag: tagOf(cs[cs.length - 1]), anc: cs.slice(0, -1).map(classesOf), color: null, bg: null, paintsBg: false, order };
      const c = decl(body, 'color'), b = decl(body, 'background(?:-color)?');
      bySel.set(key, { ...prev, color: c || prev.color, bg: hasBg(body) ? b : prev.bg, paintsBg: hasBg(body) ? paintsOwnBg(body) : prev.paintsBg, order });
    }
  });
  const entries = [...bySel.values()];
  const sameAnc = (x, y) => x.length === y.length && x.every((a, i) => a.size === y[i].size && subset(a, y[i]));
  const pairs = [];
  const soft = entries.filter((e) => e.bg && /-soft$/.test(e.bg));
  for (const R of soft) {
    if (R.color) pairs.push({ where: R.sel, fg: R.color, bg: R.bg, kind: 'same-rule' });                       // (a)
    else {
      // (c) a ground-only rule: its text color is first the SAME element's BASE declaration — a rule on the same element
      //     at equal-or-lower specificity (same ancestors, last compound's classes AND pseudo-classes ⊆ R's), e.g. `.dwf .delx`
      //     beneath `.dwf .delx:hover` — the most specific (then latest) one; only when none exists, the inherited body ink
      // the SAME element: B names ≥ 1 of R's classes (a bare type selector like `a` is NOT the same element) and no
      // conflicting element type
      const base = entries.filter((B) => B !== R && B.color && B.last.size > 0 && (B.lastTag === '' || B.lastTag === R.lastTag) && sameAnc(B.anc, R.anc) && subset(B.last, R.last) && subset(B.lastPseudo, R.lastPseudo))
        .sort((x, y) => ((x.last.size + x.lastPseudo.size) - (y.last.size + y.lastPseudo.size)) || (x.order - y.order));
      if (base.length) pairs.push({ where: `${R.sel} (base color from ${base[base.length - 1].sel})`, fg: base[base.length - 1].color, bg: R.bg, kind: 'base-color' });
      else pairs.push({ where: `${R.sel} (inherited body text)`, fg: 'ink', bg: R.bg, kind: 'inherited-ink' });
    }
    // (a') SAME-ELEMENT refinements: a more specific selector on the same element (same ancestors, last compound ⊇ R's)
    //      that sets a color but not its own background renders that color on R's soft ground (e.g. `.tag.x{color}`)
    for (const D of entries) {
      // D must be AT LEAST as specific as R on that element — classes AND pseudo-classes (`.del` does not refine `.del:hover`)
      if (D === R || !D.color || D.paintsBg || !R.last.size || !(R.lastTag === '' || D.lastTag === R.lastTag) || !sameAnc(D.anc, R.anc) || !subset(R.last, D.last) || !subset(R.lastPseudo, D.lastPseudo)) continue;
      if (D.last.size === R.last.size && D.lastPseudo.size === R.lastPseudo.size && D.order < R.order) continue;   // equal specificity: the later rule wins
      pairs.push({ where: `${R.sel} refined by ${D.sel}`, fg: D.color, bg: R.bg, kind: 'refinement' });
    }
    const RC = R.last;
    // (b) descendants: group candidate rules by their target (last compound), keep those whose ancestor classes ⊆ R's
    const targets = new Map();
    for (const D of entries) {
      // a TYPE-only last compound (`.zz b`) is a descendant too (codex r5 d: the type-only exemption from crossings rests on this)
      if (!D.anc.length || (!D.last.size && !D.lastTag)) continue;
      const a = D.anc[D.anc.length - 1];
      if (!a.size || !subset(a, RC)) continue;
      const key = D.last.size ? [...D.last].sort().join('.') : `<${D.lastTag}>`;
      if (!targets.has(key)) targets.set(key, []);
      targets.get(key).push({ D, spec: a.size });
    }
    for (const [key, list] of targets) {
      if (list.some(({ D }) => D.paintsBg)) continue;                                // the descendant paints its own ground
      const withColor = list.filter(({ D }) => D.color).sort((x, y) => (x.spec - y.spec) || (x.D.order - y.D.order));
      if (!withColor.length) continue;
      const eff = withColor[withColor.length - 1].D;                                 // the most specific (then latest) override
      pairs.push({ where: `${R.sel} → .${key} (via ${eff.sel})`, fg: eff.color, bg: R.bg, kind: 'descendant' });
    }
  }
  return pairs;
}
const allTokens = Object.fromEntries([...lightBlock.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));

// FAIL-CLOSED GUARD (advisor ruling, codex r3 — option A): the sweep does NOT model the full cascade, so every construct
// that could change a light-mode text-on-soft decision and that it does not model is REFUSED, by rule. Scoped to what
// can matter: color / background / background-color declarations, the rules that set them, and at-rules.
const TEXT_GROUND = new Set(['color', 'background', 'background-color']);
function cssRefusals(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const declsOf = (body) => body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); return i < 0 ? null : { prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() }; }).filter(Boolean);
  const checkRule = (prelude, body) => {
    const ds = declsOf(body);
    const tg = ds.filter((d) => TEXT_GROUND.has(d.prop));
    for (const d of tg) {
      if (/!\s*important/i.test(d.value)) out.push(`${prelude} — !important on ${d.prop}`);
      if (/var\(\s*--[A-Za-z0-9-]+\s*,/.test(d.value)) out.push(`${prelude} — var() with a fallback in ${d.prop}`);
    }
    for (const p of TEXT_GROUND) if (ds.filter((d) => d.prop === p).length > 1) out.push(`${prelude} — ${p} declared twice`);
    if (ds.some((d) => d.prop === 'background') && ds.some((d) => d.prop === 'background-color')) out.push(`${prelude} — background AND background-color`);
    if (tg.length && /:(is|where|not|has)\(/.test(prelude)) out.push(`${prelude} — a functional pseudo-class in a rule that sets color/background`);
  };
  const walk = (str) => {
    let i = 0;
    while (i < str.length) {
      const semi = str.indexOf(';', i), open = str.indexOf('{', i);
      // a block-less at-rule (@import, @charset, @layer x;) ends at ';' before any '{'
      if (semi >= 0 && (open < 0 || semi < open) && /^\s*@/.test(str.slice(i, semi))) { out.push(`${str.slice(i, semi).trim()} — at-rule not modelled`); i = semi + 1; continue; }
      if (open < 0) break;
      const prelude = str.slice(i, open).trim();
      let depth = 1, k = open + 1;
      while (k < str.length && depth) { if (str[k] === '{') depth += 1; else if (str[k] === '}') depth -= 1; k += 1; }
      const body = str.slice(open + 1, k - 1);
      if (prelude.startsWith('@media')) { if (!/prefers-color-scheme\s*:\s*dark/.test(prelude)) walk(body); }
      else if (prelude.startsWith('@keyframes')) { if (/(?:^|[;{\s])(color|background(?:-color)?)\s*:/.test(body)) out.push(`${prelude} — a @keyframes that sets color/background`); }
      else if (prelude.startsWith('@')) out.push(`${prelude} — at-rule not modelled`);
      else for (const sel of splitSelectors(prelude)) { if (!/data-theme="dark"|:not\(\[data-theme="light"\]\)|^:root/.test(sel)) { checkRule(sel, body); } }
      i = k;
    }
  };
  walk(text);
  return [...new Set(out)];
}

// ALLOWLIST GRAMMAR (advisor ruling, codex r4 — a denylist always leaks). In light-mode-applicable CSS every declaration
// that can affect a text-on-soft decision must take the ONE modelled form, else the test fails naming the rule:
//   R1 color / background / background-color = exactly var(--token) (whitespace-normalised; the token defined in the light
//      :root block) or transparent / inherit / currentColor (+ background:none ≡ transparent, ruling A1) — or a PINNED literal;
//   R2 custom properties (--x:) only inside the exact theme-token blocks;
//   R3 inside @media(prefers-color-scheme:dark) only the guarded theme block (+ the PINNED display-only icon rules);
//   R4 a selector beginning with :root only as an exact theme block (+ the PINNED icon rules).
// PINS (rulings B2, C2) — today's working declarations, each pinned EXACTLY; a new literal or a changed pin fails.
const PINNED_LITERALS = [
  ['.thumb .cam', 'background', 'rgba(0,0,0,.5)'], ['.thumb .cam', 'color', '#fff'],
  ['.uphoto .uprm', 'background', 'rgba(0,0,0,.6)'], ['.uphoto .uprm', 'color', '#fff'],
  ['.oav', 'color', '#fff'], ['.sealbadge', 'color', '#1c1608'],
  ['.tog i', 'background', '#fff'], ['.motog i', 'background', '#fff'],
  ['.scrim', 'background', 'rgba(8,7,6,.6)'], ['.dscrim', 'background', 'rgba(8,7,6,.5)'],
];
const PINNED_ICON_RULES = {
  top: [':root[data-theme="dark"] .tbtn .moon,:root[data-theme="dark"] .miconbtn .moon', ':root[data-theme="dark"] .tbtn .sun,:root[data-theme="dark"] .miconbtn .sun'],
  darkMedia: [':root:not([data-theme="light"]) .tbtn .moon,:root:not([data-theme="light"]) .miconbtn .moon', ':root:not([data-theme="light"]) .tbtn .sun,:root:not([data-theme="light"]) .miconbtn .sun'],
};
const THEME_LIGHT = ':root,:root[data-theme="light"]', THEME_DARK = ':root[data-theme="dark"]', THEME_DARK_MEDIA = ':root:not([data-theme="light"])';
const normSel = (p) => p.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
const normVal = (v) => v.trim().replace(/\s+/g, ' ').replace(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g, 'var($1)');
const LIGHT_TOKENS = new Set([...lightBlock.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// ── codex r5 (advisor ruling): REFUSAL BY CONSTRUCTION, no new modelling ────────────────────────────────────────────
//   (a) `color` never `transparent`; `inherit` / `currentColor` on color only as the 4 PINNED sites. `background`:
//       transparent / inherit / none modelled; `currentColor` refused.
//   (b) nested CSS — `&`, or a rule / at-rule INSIDE a rule body — refused.
//   (c) exactly ONE light :root block, ONE `:root[data-theme="dark"]`, ONE guarded dark-media block; a token declared once
//       per block.
//   (d) a rule that sets color/background must be one the sweep fully resolves: a single compound, or a plain descendant
//       chain with NO CROSSING. Pseudo-elements, attribute selectors and child/sibling combinators are refused, as is any
//       crossing — except the 21 EXACT pins below (selector + its color/background declarations; a crossing pin also
//       freezes its PARTNER set, so a new partner fails).
//       CROSSING (C2) = two rules whose LAST compounds share a CLASS (incl. state classes like `.on`), under ancestor
//       chains that DIFFER and are not refinements of each other (`.prow` vs `.prow.big` is the refinement the sweep
//       resolves), and BOTH set color or background. TYPE-only overlap (`.x b` vs `.y b`) is NOT a crossing: a type-only
//       rule on a soft ground is covered by the sweep's ANCESTOR-GROUND resolution — see the fixture
//       'type-only descendant on a soft ancestor fails via the sweep'.
//   (e) ONE declaration normaliser (parseDecls: lowercased property names) feeds BOTH the grammar and the sweep; a CSS
//       escape in a property name is refused.
const A1_INHERIT_PINS = ['.railitem', '.mgmain', '.mtop .mswitch', '.switchmenu-item'];   // color:inherit, ruling a1
// 7 pseudo-element rules (6 selectors; ::selection appears twice) + 4 attribute/child sites — exact color/background
const PINNED_COMPLEX = {
  '::selection': ['background:var(--tint2)', 'background:var(--tint2);color:var(--ink)'],   // two rules (:58, :396)
  '.tab.on::after': ['background:var(--green)'],
  '.search input::placeholder': ['color:var(--mute2)'],
  '::-webkit-scrollbar-thumb': ['background:var(--line)'],
  '::-webkit-scrollbar-thumb:hover': ['background:var(--mute2)'],
  '::-webkit-scrollbar-track': ['background:transparent'],
  '.fld>label': ['color:var(--mute2)'],
  '.fld input[type=text]': ['background:var(--board-2);color:var(--ink)'],
  '.hours input[type=time]': ['background:var(--board-2);color:var(--ink)'],
  '.btn.accent[data-busy] .spin': ['color:var(--card)'],
};
// the 10 C2 crossings — exact color/background declarations AND the frozen partner set
const PINNED_CROSSINGS = {
  '.switch .chev': { tg: 'color:var(--mute2)', partners: ['.mtop .mswitch .chev'] },
  '.mtop .mswitch .chev': { tg: 'color:var(--mute2)', partners: ['.switch .chev'] },
  '.railitem.on .rcount': { tg: 'color:var(--accent);background:var(--tint2)', partners: ['.rcount'] },
  '.fiscal .ack': { tg: 'background:transparent', partners: ['.ack'] },
  '.fiscal .ackt': { tg: 'color:var(--on-dark)', partners: ['.ackt'] },
  '.gtype button.on': { tg: 'background:var(--accent);color:var(--accent-ink)', partners: ['.daychip.on', '.mnav .mn.on', '.nav.on', '.railitem.on', '.switchmenu-item.on', '.tab.on', '.tab.on::after', '.tslot.on'] },
  '.mnav .mn.on': { tg: 'background:var(--tint2);color:var(--accent)', partners: ['.daychip.on', '.gtype button.on', '.nav.on', '.railitem.on', '.switchmenu-item.on', '.tab.on', '.tab.on::after', '.tslot.on'] },
  '.modgrp.open .mgchev': { tg: 'color:var(--ink)', partners: ['.mgchev', '.mgchev:hover'] },
  '.prow .was': { tg: 'color:var(--mute)', partners: ['.sealbody .seachg .sv .was'] },
  '.sealbody .seachg .sv .was': { tg: 'color:var(--mute)', partners: ['.prow .was'] },
};
// the two crossing pins that legitimately sit INSIDE a soft-ground container: proven PRESENT (not absent) as the sweep's
// computed pair, where-string + both tokens frozen, and ≥ 4.5 (advisor ruling)
const SOFT_PRESENT_PINS = [
  { where: '.fiscal → .ackt (via .fiscal .ackt)', fg: 'on-dark', bg: 'gold-soft' },
  { where: '.prow.big → .was (via .prow .was)', fg: 'mute', bg: 'amber-soft' },
];

const tgOf = (decls) => decls.filter((d) => TEXT_GROUND.has(d.prop)).map((d) => `${d.prop}:${d.value}`).join(';');
const isComplexSel = (sel) => /::|\[|[>+~]/.test(sel);
const ancOf = (sel) => compounds(sel.replace(/\s*[>+~]\s*/g, ' ')).slice(0, -1).map((c) => [...classesOf(c), tagOf(c)].filter(Boolean).sort().join('.'));
const lastClassesOf = (sel) => { const cs = compounds(sel.replace(/\s*[>+~]\s*/g, ' ')); return classesOf(cs[cs.length - 1]); };
const refinesAnc = (x, y) => x.length === y.length && x.every((a, i) => { const A = new Set(a.split('.').filter(Boolean)), B = new Set(y[i].split('.').filter(Boolean)); return subset(A, B) || subset(B, A); });

// every LIGHT-applicable non-theme rule, one record per selector
function lightRecords(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const recs = [], theme = { light: [], dark: [], darkMedia: [] }, structural = [];
  const walk = (str, ctx) => {
    let i = 0;
    while (i < str.length) {
      const open = str.indexOf('{', i);
      if (open < 0) break;
      const prelude = str.slice(i, open).trim();
      let depth = 1, k = open + 1;
      while (k < str.length && depth) { if (str[k] === '{') depth += 1; else if (str[k] === '}') depth -= 1; k += 1; }
      const body = str.slice(open + 1, k - 1);
      const sel = normSel(prelude);
      if (prelude.startsWith('@media')) {
        if (/prefers-color-scheme\s*:\s*dark/.test(prelude)) { if (ctx === 'dark') structural.push(`${prelude} — nested dark-scheme @media`); else walk(body, 'dark'); }
        else walk(body, ctx === 'dark' ? 'dark' : 'light');
      } else if (prelude.startsWith('@')) { if (ctx === 'dark') structural.push(`${prelude} — R3 an at-rule inside the dark-scheme @media`); }
      else {
        if (/[{}]/.test(body) || /&/.test(prelude) || /&/.test(body)) structural.push(`${sel} — (b) nested CSS (\`&\` or a rule inside a rule body)`);
        const decls = parseDecls(body);
        if (ctx === 'dark') {
          if (sel === THEME_DARK_MEDIA) theme.darkMedia.push(decls);
          else if (PINNED_ICON_RULES.darkMedia.includes(sel)) { if (decls.some((d) => d.prop !== 'display')) structural.push(`${sel} — a pinned icon rule may declare ONLY display`); }
          else structural.push(`${sel} — R3 a non-theme rule inside @media(prefers-color-scheme:dark) applies on OS-dark devices in light mode`);
        } else if (sel === THEME_LIGHT) theme.light.push(decls);
        else if (sel === THEME_DARK) theme.dark.push(decls);
        else if (PINNED_ICON_RULES.top.includes(sel)) { if (decls.some((d) => d.prop !== 'display')) structural.push(`${sel} — a pinned icon rule may declare ONLY display`); }
        else if (splitSelectors(prelude).some((x) => /^:root\b/.test(x.trim()))) structural.push(`${sel} — R4 a :root selector that is not an exact theme block`);
        else for (const one of splitSelectors(prelude)) { const os = normSel(one); recs.push({ sel: os, decls, tg: tgOf(decls), hasTG: decls.some((d) => TEXT_GROUND.has(d.prop)), complex: isComplexSel(os), multi: compounds(os.replace(/\s*[>+~]\s*/g, ' ')).length > 1, last: lastClassesOf(os), anc: ancOf(os) }); }
      }
      i = k;
    }
  };
  walk(text, 'light');
  return { recs, theme, structural };
}
// C2 partners of a record: other color/background-setting records whose LAST compound shares a class, under a different
// ancestor chain that is not a refinement of this one
function crossingPartners(r, recs) {
  return [...new Set(recs.filter((t) => t !== r && t.hasTG && [...t.last].some((c) => r.last.has(c))
    && t.anc.join(' ') !== r.anc.join(' ') && !refinesAnc(t.anc, r.anc)).map((t) => t.sel))].sort();
}

function grammarViolations(cssText) {
  const { recs, theme, structural } = lightRecords(cssText);
  const out = [...structural];
  const pinSeen = new Set();
  // (c) theme blocks
  for (const [name, blocks] of [['light :root', theme.light], [':root[data-theme="dark"]', theme.dark], ['guarded dark-media :root', theme.darkMedia]]) {
    if (blocks.length !== 1) out.push(`(c) exactly ONE ${name} theme block is allowed (found ${blocks.length})`);
    for (const decls of blocks) { const seen = new Set(); for (const d of decls) { if (!d.prop.startsWith('--')) continue; if (seen.has(d.prop)) out.push(`(c) ${name}: token ${d.prop} declared twice`); seen.add(d.prop); } }
  }
  for (const r of recs) {
    // (e) + R1/R2/(a) per declaration
    for (const d of r.decls) {
      if (d.escaped) { out.push(`${r.sel} — (e) a CSS escape in the property name ${d.raw}`); continue; }
      if (d.prop.startsWith('--')) { out.push(`${r.sel} — R2 custom property ${d.prop} outside the theme-token blocks`); continue; }
      if (!TEXT_GROUND.has(d.prop)) continue;
      const v = d.value;
      const m = v.match(/^var\((--[a-z0-9-]+)\)$/);
      if (m && LIGHT_TOKENS.has(m[1].slice(2))) continue;
      const lv = v.toLowerCase();
      if (d.prop === 'color') {
        if ((lv === 'inherit') && A1_INHERIT_PINS.includes(r.sel)) { pinSeen.add(`a1|${r.sel}`); continue; }
        if (['transparent', 'inherit', 'currentcolor'].includes(lv)) { out.push(`${r.sel} — (a) color:${v} is refused (transparent never; inherit/currentColor only at the 4 pinned sites)`); continue; }
      } else {
        if (['transparent', 'inherit'].includes(lv) || (d.prop === 'background' && lv === 'none')) continue;
        if (lv === 'currentcolor') { out.push(`${r.sel} — (a) ${d.prop}:currentColor is refused (unmodelled)`); continue; }
      }
      const pin = PINNED_LITERALS.find(([ps, pp, pv]) => ps === r.sel && pp === d.prop && pv === v);
      if (pin) { pinSeen.add(pin.join('|')); continue; }
      out.push(`${r.sel} — R1 ${d.prop}:${v} is not the modelled form nor a pinned literal`);
    }
    if (!r.hasTG) continue;
    // (d) structure of a color/background-setting selector
    if (r.complex) {
      const allowed = PINNED_COMPLEX[r.sel];
      if (allowed && allowed.includes(r.tg)) { pinSeen.add(`complex|${r.sel}|${r.tg}`); continue; }
      out.push(`${r.sel} — (d) a pseudo-element / attribute / child-or-sibling selector that sets color/background (${r.tg}) is not a pinned site`);
      continue;
    }
    if (!r.multi) continue;
    const partners = crossingPartners(r, recs);
    if (!partners.length) continue;
    const pin = PINNED_CROSSINGS[r.sel];
    if (pin && pin.tg === r.tg && JSON.stringify(pin.partners) === JSON.stringify(partners)) { pinSeen.add(`cross|${r.sel}`); continue; }
    out.push(`${r.sel} — (d) a CROSSING (shares a last-compound class with ${partners.join(', ')} under a different ancestor chain) that is not the pinned one${pin ? ` (pinned: ${pin.tg} × ${pin.partners.join(', ')})` : ''}`);
  }
  return { violations: [...new Set(out)], pinSeen };
}

test('COLOUR FREEZE: every light-applicable colour declaration and light token equals the frozen golden', () => {
  if (process.env.PORTAL_FREEZE_WRITE === '1') { writeFileSync(FREEZE_FILE, `${JSON.stringify(colourFreezeOf(css), null, 1)}\n`); return; }
  const golden = JSON.parse(readFileSync(FREEZE_FILE, 'utf8'));
  assert.ok(golden.declarations.length > 100 && Object.keys(golden.tokens).length > 20, 'non-vacuity: the golden freezes the real sheet');
  const d = freezeDiff(css, golden);
  assert.deepEqual(d, { added: [], removed: [], tokenChanges: [] }, `🔴 ${FREEZE_MSG}\n  added: ${d.added.join('\n         ')}\n  removed: ${d.removed.join('\n           ')}\n  tokens: ${d.tokenChanges.join(', ')}`);
});

test('COLOUR FREEZE catches every codex r6 example; reformatting or reordering is not a change', () => {
  const golden = JSON.parse(readFileSync(FREEZE_FILE, 'utf8'));
  const changed = (cssText) => { const d = freezeDiff(cssText, golden); return d.added.length + d.removed.length + d.tokenChanges.length > 0; };
  const swap = (a, b) => { assert.equal(css.split(a).length - 1, 1, `fixture anchor is unique: ${a}`); return css.replace(a, b); };
  // codex r6's evasions — each is a COLOUR change, so the freeze fails
  assert.ok(changed(swap('}.ackt b{color:var(--amber)}', '}.ackt b{color:var(--mute2)}')), '🔴 a .ackt b colour change (a multi-level ancestor ground) fails');
  assert.ok(changed(css + '\n.fiscal p:hover{color:var(--mute2)}'), '🔴 a new .fiscal p:hover pair (a hover variant) fails');
  assert.ok(changed(css + '\n#loginerr{color:var(--red)}'), '🔴 an ID selector colour fails');
  assert.ok(changed(css.replace(/(\.seal\{[^}]*?background:)var\(--[a-z0-9-]+\)/, '$1var(--amber-soft)')), '🔴 a .seal background change (DOM placement made by review.js) fails');
  assert.ok(changed(css.replace(/(--mute:)\s*#[0-9A-Fa-f]{6}/, '$1#777777')), '🔴 a light token value change fails');
  assert.ok(changed(swap('.pdelta.up{color:var(--amber);', '.pdelta.up{')), '🔴 a REMOVED colour declaration fails');
  assert.ok(changed(swap('.pdelta.up{color:var(--amber);', '.pdelta.up.x{color:var(--amber);')), '🔴 a changed selector fails');
  assert.ok(changed(css + '\n@media(max-width:1px){.zzm{border-color:var(--line)}}'), '🔴 a new border-color inside a light @media fails');
  // NOT changes: value whitespace and rule order
  assert.ok(!changed(swap('.pdelta.up{color:var(--amber);', '.pdelta.up{color:  var( --amber ) ;')), 'a whitespace-only reformat of a VALUE still matches');
  const rule = css.match(/\n\s*\.pdelta\.up\{[^}]*\}/)[0];
  assert.ok(!changed(css.replace(rule, '') + rule), 'a REORDERED rule still matches (order-insensitive)');
});

test('ALLOWLIST GRAMMAR: every light-applicable color/background declaration takes the modelled form; today\'s sheet passes', () => {
  const g = grammarViolations(css);
  assert.deepEqual(g.violations, [], `🔴 not in the modelled grammar:\n  ${g.violations.join('\n  ')}`);
  for (const pin of PINNED_LITERALS) assert.ok(g.pinSeen.has(pin.join('|')), `pinned literal still present EXACTLY (a change or removal fails): ${pin.join(' ')}`);
  for (const sel of A1_INHERIT_PINS) assert.ok(g.pinSeen.has(`a1|${sel}`), `pinned color:inherit still present: ${sel}`);
  for (const [sel, tgs] of Object.entries(PINNED_COMPLEX)) for (const tg of tgs) assert.ok(g.pinSeen.has(`complex|${sel}|${tg}`), `pinned complex selector still present EXACTLY: ${sel} {${tg}}`);
  for (const sel of Object.keys(PINNED_CROSSINGS)) assert.ok(g.pinSeen.has(`cross|${sel}`), `pinned crossing still present EXACTLY (declarations + partners): ${sel}`);
});


test('ALLOWLIST GRAMMAR refuses codex r4\'s 5 evasions and a raw literal; allows the modelled forms', () => {
  const g = (frag) => grammarViolations(css + '\n' + frag).violations;
  const pairsFail = (frag) => discoverSoftPairs(css + '\n' + frag).filter((p) => !(contrast(allTokens[p.fg], allTokens[p.bg]) >= 4.5));
  const REFUSED = {
    'E1 a :root-prefixed rule': ':root .tag{color:var(--amber-soft)}',
    'E2 a plain rule inside the dark-scheme @media': '@media(prefers-color-scheme:dark){.tag{color:var(--amber-soft)}}',
    'E3 an indirect token swap': '.tag{--amber:var(--amber-soft)}',
    'E4a a hex color': '.tag{color:#FBF0DC}',
    'raw rgb()': '.tag{color:rgb(1,2,3)}',
    'a named color': '.tag{color:white}',
    'a gradient ground': '.tag{background:linear-gradient(#fff,#000)}',
    'a token not in the light :root': '.tag{color:var(--nope)}',
    'a pinned literal CHANGED': '.oav{color:#ffe}',
    'a pinned icon rule given a color': ':root[data-theme="dark"] .tbtn .moon,:root[data-theme="dark"] .miconbtn .moon{color:var(--ink)}',
  };
  for (const [label, frag] of Object.entries(REFUSED)) assert.ok(g(frag).length > 0, `🔴 the grammar must refuse: ${label}`);
  // E4b — a spaced var() is MODELLED (allowed by the grammar) AND resolved by the sweep, so the 1:1 pair fails there
  assert.deepEqual(g('.tag{color:var( --amber-soft )}'), [], 'a whitespace-varied var() is the modelled form');
  assert.ok(pairsFail('.tag{color:var( --amber-soft )}').length > 0, '🔴 E4b: the spaced var() is RESOLVED by the sweep (amber-soft on amber-soft fails), not assumed ink');
  // E5 — background:transparent / none on a descendant RETAINS the inherited soft ground
  assert.ok(pairsFail('.prow.big .psub{background:transparent;color:var(--mute2)}').length > 0, '🔴 E5: background:transparent on a descendant keeps the soft ground (checked)');
  assert.ok(pairsFail('.prow.big .psub{background:none;color:var(--mute2)}').length > 0, '🔴 A1: background:none ≡ transparent, the soft ground is kept');
  assert.equal(pairsFail('.prow.big .psub{background:var(--board);color:var(--mute2)}').length, 0, 'an OPAQUE descendant ground replaces the soft one (mute2 on white passes)');
  const ALLOWED = {
    'var(--light-token)': '.okx{color:var(--ink);background:var(--board)}',
    'spaced var()': '.okx{color:var(  --ink  )}',
    'background transparent / inherit': '.okx{background:transparent}.oky{background:inherit}',   // (r5 a: color:inherit/currentColor are now REFUSED outside the 4 pins)
    'background:none': '.okx{background:none}',
    'a non-text property literal': '.okx{border-color:#ccc;box-shadow:0 0 0 1px #000}',
    'a light @media rule': '@media(max-width:920px){.okx{color:var(--ink)}}',
  };
  for (const [label, frag] of Object.entries(ALLOWED)) assert.deepEqual(g(frag), [], `the grammar must ALLOW: ${label}`);
});

test('the 2 soft-container crossings are PRESENT as the sweep\'s computed pair, tokens frozen, ≥ 4.5 (true by computation)', () => {
  const pairs = discoverSoftPairs(css);
  for (const sp of SOFT_PRESENT_PINS) {
    const real = pairs.find((x) => x.where === sp.where);
    assert.ok(real, `🔴 PRESENT: the sweep computes ${sp.where}`);
    assert.deepEqual([real.fg, real.bg], [sp.fg, sp.bg], `🔴 ${sp.where}: both tokens frozen (--${sp.fg} on --${sp.bg})`);
    const r = contrast(allTokens[real.fg], allTokens[real.bg]);
    assert.ok(r >= 4.5, `${sp.where}: ${r.toFixed(4)}:1 ≥ 4.5 unrounded`);
  }
});

test('r5 GRAMMAR refuses every new construct and codex\'s examples; allows the plain forms', () => {
  const g = (frag) => grammarViolations(css + '\n' + frag).violations;
  const pairsFail = (frag) => discoverSoftPairs(css + '\n' + frag).filter((p) => !(contrast(allTokens[p.fg], allTokens[p.bg]) >= 4.5));
  const REFUSED = {
    '(a) color:transparent': '.zza{color:transparent}',
    '(a) a NEW color:inherit': '.zza{color:inherit}',
    '(a) color:currentColor': '.zza{color:currentColor}',
    '(a) background:currentColor': '.zza{background:currentColor}',
    '(b) nested & rule': '.zzb{&:hover{color:var(--ink)}}',
    '(b) a rule inside a rule body': '.zzb{color:var(--ink); .zzc{color:var(--ink)}}',
    '(c) a second light :root block': ':root,:root[data-theme="light"]{--ink:#000000}',
    '(c) a token declared twice in the light block': null,   // built below
    '(d) codex: .panel .tag{color}': '.panel .tag{color:var(--ink)}',
    '(d) codex: .panel .oav{background}': '.panel .oav{background:var(--board)}',
    '(d) a NEW .on-state crossing': '.zzd .zzq.on{color:var(--ink)}',
    '(d) a NEW class crossing (.x .ack)': '.x .ack{color:var(--ink)}',
    '(d) a NEW partner for a pinned crossing': '.was{color:var(--ink)}',
    '(d) a NEW pseudo-element': '.zze::before{color:var(--ink)}',
    '(d) a NEW attribute selector': '.zze[data-x]{color:var(--ink)}',
    '(d) a NEW child combinator': '.zze>.zzf{color:var(--ink)}',
    '(d) a pinned complex selector with CHANGED declarations': '.fld>label{color:var(--mute)}',
    '(e) an escaped property name': '.zzg{c\\olor:var(--ink)}',
  };
  REFUSED['(c) a token declared twice in the light block'] = css.replace(/(:root,\s*:root\[data-theme="light"\]\s*\{)/, '$1--ink:#0A0A0B;') === css ? null : '__REPLACE__';
  for (const [label, frag] of Object.entries(REFUSED)) {
    if (frag === '__REPLACE__') { assert.ok(grammarViolations(css.replace(/(:root,\s*:root\[data-theme="light"\]\s*\{)/, '$1--ink:#0A0A0B;')).violations.some((v) => /declared twice/.test(v)), `🔴 the grammar must refuse: ${label}`); continue; }
    assert.ok(g(frag).length > 0, `🔴 the grammar must refuse: ${label}`);
  }
  // (e) the ONE normaliser: an UPPERCASE property is the same declaration for the grammar AND the sweep
  assert.ok(g('.zzh{COLOR:#fff}').length > 0, '(e) COLOR: is normalised and refused as a hex literal');
  assert.ok(pairsFail('.pdelta.up{COLOR:var(--amber-soft)}').length > 0, '(e) COLOR: is normalised for the SWEEP too (amber-soft on amber-soft fails)');
  // type-only exemption PROVEN: a type-only descendant on a soft ancestor fails via the sweep's ancestor-ground resolution
  assert.deepEqual(g('.zzt{background:var(--amber-soft)} .zzt b{color:var(--amber-soft)}'), [], 'type-only overlap is not a crossing (grammar allows it)');
  assert.ok(pairsFail('.zzt{background:var(--amber-soft)} .zzt b{color:var(--amber-soft)}').length > 0, '🔴 type-only descendant on a soft ancestor fails via the sweep (the claim that exempts type-only overlap from crossings)');
  // ALLOWED: a harmless new plain chain on a unique class; background transparent/inherit/none
  assert.deepEqual(g('.zzq1 .zzr1{color:var(--ink)}'), [], 'a harmless plain chain on a unique class is allowed (no crossing)');
  assert.deepEqual(g('.zzs{background:inherit}.zzu{background:none}.zzv{background-color:transparent}'), [], 'background transparent / inherit / none stay modelled');
});

test('FAIL-CLOSED GUARD: today\'s styles.css uses NO construct the sweep does not model (scoped to text-on-soft)', () => {
  assert.deepEqual(cssRefusals(css), [], `🔴 unmodelled constructs in light-mode rules:\n  ${cssRefusals(css).join('\n  ')}`);
});

test('FAIL-CLOSED GUARD fires on every refused construct, and allows the out-of-scope uses', () => {
  const REFUSED = {
    '!important on color': '.x{color:var(--ink)!important}',
    '!important on background': '.x{background:var(--green-soft) !important}',
    'var() fallback in color': '.x{color:var(--ink, #000)}',
    'var() fallback in background-color': '.x{background-color:var(--gold-soft,transparent)}',
    ':is() in a color rule': '.x:is(.y){color:var(--ink)}',
    ':where() in a background rule': ':where(.x) .y{background:var(--red-soft)}',
    ':not() in a color rule': '.x:not(.y){color:var(--ink)}',
    ':has() in a background rule': '.x:has(.y){background:var(--amber-soft)}',
    '@supports': '@supports (display:grid){.x{color:var(--ink)}}',
    '@layer (block)': '@layer base{.x{color:var(--ink)}}',
    '@layer (statement)': '@layer base, theme;',
    '@container': '@container (min-width:400px){.x{color:var(--ink)}}',
    '@import': '@import url("x.css");',
    '@keyframes that sets color': '@keyframes k{from{color:var(--ink)}to{color:var(--green-soft)}}',
    'color declared twice': '.x{color:var(--ink);color:var(--green-soft)}',
    'background declared twice': '.x{background:var(--board);background:var(--green-soft)}',
    'background + background-color': '.x{background:var(--board);background-color:var(--green-soft)}',
  };
  for (const [label, frag] of Object.entries(REFUSED)) assert.ok(cssRefusals(css + '\n' + frag).length > 0, `🔴 the guard must refuse: ${label}`);
  const ALLOWED = {
    '!important on display': '.y{display:none !important}',
    '!important on max-height': '.y{max-height:0!important}',
    ':not() on a margin-only rule': '.y .z:not(:first-child){margin-left:8px}',
    '@keyframes without color': '@keyframes k{from{opacity:0}to{opacity:1}}',
    'var() fallback outside color/background': '.y{border-color:var(--line,transparent)}',
    'light @media': '@media(max-width:920px){.y{color:var(--ink)}}',
    'dark-scheme @media': '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .y{color:var(--ink) !important}}',
  };
  for (const [label, frag] of Object.entries(ALLOWED)) assert.deepEqual(cssRefusals(css + '\n' + frag), [], `the guard must ALLOW (out of scope): ${label}`);
});

test('LAST declaration wins within a rule (the sweep reads what the browser renders)', () => {
  const p = discoverSoftPairs('.lw{color:var(--ink);background:var(--green-soft);color:var(--green-soft)}').find((x) => x.where === '.lw');
  assert.ok(p, 'the pair is discovered'); assert.equal(p.fg, 'green-soft', 'the LAST color declaration is the one paired');
});

test('DISCOVERING SWEEP: every light-mode text-on-soft pairing (incl. inherited soft backgrounds) clears 4.5:1, unrounded', () => {
  const pairs = discoverSoftPairs(css);
  assert.ok(pairs.length >= 20, `non-vacuity: the sweep discovered the soft pairings (${pairs.length})`);
  assert.ok(pairs.some((p) => p.kind === 'descendant' && /\.prow\.big → \.arr/.test(p.where)), 'non-vacuity: an INHERITED pairing (.prow.big → .arr) is discovered');
  const bad = [];
  for (const p of pairs) {
    const fg = allTokens[p.fg], bg = allTokens[p.bg];
    assert.ok(fg && bg, `${p.where}: both colors resolve through the light tokens (--${p.fg} / --${p.bg})`);
    const r = contrast(fg, bg);
    if (!(r >= 4.5)) bad.push(`${p.where}: --${p.fg} ${fg} on --${p.bg} ${bg} = ${r.toFixed(4)}:1`);
  }
  assert.deepEqual(bad, [], `🔴 light-mode text on a soft background below 4.5:1:\n  ${bad.join('\n  ')}`);
});

test('the discovering sweep catches the defects it exists for (fixtures)', () => {
  const failing = (extra) => discoverSoftPairs(css + '\n' + extra).filter((p) => !(contrast(allTokens[p.fg], allTokens[p.bg]) >= 4.5));
  assert.equal(failing('').length, 0, 'the shipped stylesheet is clean');
  assert.ok(failing('.newpair{color:var(--green);background:var(--green-soft)}').length > 0, 'a new same-rule sub-4.5 pair fails');
  assert.ok(failing('.tagx{background:var(--amber-soft)} .tagx .sub{color:var(--mute2)}').length > 0, 'a descendant on an INHERITED soft ground fails');
  assert.ok(failing('.prow.big .arr{color:var(--mute2)}').length > 0, 'reverting the .prow.big override fails (the most specific rule wins)');
  assert.ok(failing('.tag{color:var(--board)}').length > 0, 'an existing pill turned unreadable fails');
  assert.ok(failing('.zz .item{color:var(--red)} .zz .item:hover{background:var(--red-soft)}').length > 0, 'a ground-only hover over a base color below 4.5 fails (the base color is resolved, not assumed ink)');
  const pz = discoverSoftPairs('a{color:var(--green-soft)} .chipq{background:var(--green-soft)}').find((x) => /^\.chipq/.test(x.where));
  assert.equal(pz.kind, 'inherited-ink', 'a bare type selector (`a`) is NOT the same element as `.chipq` — no false base color');
});

test('the dark theme keeps its green/red text values (dark unchanged)', () => {
  for (const blk of [css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)[1], css.match(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/)[1]]) {
    assert.match(blk, /--green-text:#3FD98A;/); assert.match(blk, /--red-text:#F0685A;/);
    assert.match(blk, /--green:#3FD98A;/); assert.match(blk, /--red:#F0685A;/);
  }
});

test('the CSP already admits the two Google font hosts (unchanged)', () => {
  const csp = (toml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/) || [])[1] || '';
  assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/, 'style-src allows fonts.googleapis.com');
  assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/, 'font-src allows fonts.gstatic.com');
});
