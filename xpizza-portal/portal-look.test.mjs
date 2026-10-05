// The portal's LOOK is the owner-approved LIGHT Bold Editorial (2026-10-05): light on EVERY device (no toggle), Archivo
// actually loaded for display type. Pins the three facts the live portal got wrong (it rendered black, in system type):
//   1. <html data-theme="light"> — exactly "light", never "dark", so neither the explicit dark block nor an OS dark-mode
//      preference can apply (the prefers-color-scheme block is guarded by :not([data-theme="light"]));
//   2. exactly ONE Google Fonts stylesheet, Archivo as the 600..800 weight range (covers the 750/800 in use), no Hanken;
//   3. the CSP already admits fonts.googleapis.com (style-src) and fonts.gstatic.com (font-src).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
// LAST declaration wins within a rule (the CSS cascade inside one block)
const decl = (body, prop) => { const all = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*var\\(--([a-z0-9-]+)\\)`, 'g'))]; return all.length ? all[all.length - 1][1] : null; };
const hasBg = (body) => /(?:^|;)\s*background(?:-color)?\s*:/.test(body);

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
      bySel.set(key, { ...prev, color: c || prev.color, bg: hasBg(body) ? b : prev.bg, paintsBg: prev.paintsBg || hasBg(body), order });
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
      if (!D.anc.length || !D.last.size) continue;
      const a = D.anc[D.anc.length - 1];
      if (!a.size || !subset(a, RC)) continue;
      const key = [...D.last].sort().join('.');
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
