// «No amber» (OWNER 2026-11-12, «Amber makes it look like excel»; the owner-approved pastel-chips mockup, advisor ruling 11-13) — the
// merchant portal carries NO amber / gold hue anywhere, in either theme. Every chip, pill, tag, callout and seal speaks the pastel set by
// MEANING: lavender = Recomendada · sky = unpublished · mint = Admin Sherpa / Sherpa-only · sand = caution (the SAR seal: sand + ink).
// COMPUTED over the shipped files, not a class list: styles.css is resolved through its OWN tokens per theme (the light block, the dark
// block, the system-dark block — jsdom never substitutes var(), so the test does), then every colour in every declaration is measured;
// the portal's own JS and HTML are scanned for literal colours too (an SVG fill or an inline style would bypass the sheet).
// Amber / gold = hue 31°–62° at saturation ≥ 0.25 (darkorange 32.9° in; sand sits at 26°–30°, below the band; red / green / sky / mint / lavender far from it).
// Run: node --test xpizza-portal/portal-no-amber.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(DIR, 'styles.css'), 'utf8');

const blockAfter = (css, sel) => { const i = css.indexOf(sel); assert.ok(i >= 0, `premise: the token block ${sel}`); const a = css.indexOf('{', i + sel.length - 1), b = css.indexOf('}', a); return css.slice(a + 1, b); };
const tokensOf = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const THEMES = (css) => {
  const light = tokensOf(blockAfter(css, ':root, :root[data-theme="light"]{'));
  return { light, dark: { ...light, ...tokensOf(blockAfter(css, ':root[data-theme="dark"]{')) },
    system: { ...light, ...tokensOf(blockAfter(css, '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){')) } };
};
const resolve = (v, t) => { let out = v; for (let i = 0; i < 8; i++) out = out.replace(/var\(--([\w-]+)(?:\s*,\s*([^)]+))?\)/g, (m, k, fb) => (k in t ? t[k] : (fb || m))); return out; };

// every colour in a value → [r, g, b, a] (0..1): #hex (3/4/6/8), rgb()/rgba() and hsl()/hsla() in the comma AND the space syntax
// (percent channels, a / alpha), and — with `named` — every CSS named colour (Codex HIGH r1 P2: «gold», «orange», «goldenrod» …)
const NAMED = Object.freeze({ aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32' });
const num = (x, max) => (String(x).endsWith('%') ? parseFloat(x) / 100 * max : parseFloat(x));
const alphaOf = (x) => (x === undefined ? 1 : (String(x).endsWith('%') ? parseFloat(x) / 100 : parseFloat(x)));
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
function colours(v, { named = false } = {}) {
  const out = [];
  for (const m of String(v).matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    let h = m[1]; if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) continue;
    out.push([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1));
  }
  const ch = '([+-]?[\\d.]+%?)';
  const sep = '\\s*[,\\s]\\s*';
  for (const m of String(v).matchAll(new RegExp(`rgba?\\(\\s*${ch}${sep}${ch}${sep}${ch}(?:\\s*[,/]\\s*${ch})?\\s*\\)`, 'gi'))) {
    out.push([num(m[1], 255) / 255, num(m[2], 255) / 255, num(m[3], 255) / 255, alphaOf(m[4])]);
  }
  for (const m of String(v).matchAll(new RegExp(`hsla?\\(\\s*([+-]?[\\d.]+)(deg|turn|rad)?${sep}${ch}${sep}${ch}(?:\\s*[,/]\\s*${ch})?\\s*\\)`, 'gi'))) {
    let h = parseFloat(m[1]); if (m[2] === 'turn') h *= 360; else if (m[2] === 'rad') h = h * 180 / Math.PI;
    h = ((h % 360) + 360) % 360;
    out.push([...hslToRgb(h, parseFloat(m[3]) / 100, parseFloat(m[4]) / 100), alphaOf(m[5])]);
  }
  if (named) for (const w of String(v).toLowerCase().match(/[a-z]+/g) || []) if (Object.prototype.hasOwnProperty.call(NAMED, w)) out.push(colours(`#${NAMED[w]}`)[0]);
  return out;
}
function hsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s, l };
}
export const isAmber = (c) => { if (c[3] === 0) return false; const { h, s, l } = hsl(c); return h >= 31 && h <= 62 && s >= 0.25 && l > 0.05 && l < 0.97; };

// the declarations of a sheet, with the selector each belongs to (comments stripped; @media bodies included)
function declarations(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out.push({ sel, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() }); }
  }
  return out;
}
// THE ONE EXEMPTION (advisor 11-13, option (a)): the photo drawer's «Así se ve en el pedido» preview draws the CUSTOMER order page's card
// in that page's own colours — «faithful preview of the customer order page's card; changes with that page». Exactly this selector,
// property and value; anything else on it (or this value anywhere else) is judged like every other rule. The customer-side gold price is
// on the owner's list as a separate question.
export const EXEMPT = Object.freeze([Object.freeze({ sel: '.phoprice', prop: 'color', value: '#7A5A08' })]);
const exempt = (sel, prop, value) => EXEMPT.some((e) => e.sel === sel && e.prop === prop && e.value === value);
export function amberInSheet(css) {
  const bad = new Set();
  const themes = THEMES(css);
  for (const [name, t] of Object.entries(themes)) {
    for (const { sel, prop, value } of declarations(css)) {
      if (prop.startsWith('--')) continue;   // a token DEFINITION is judged where it is used (an unused one is reported below)
      if (exempt(sel, prop, value)) continue;
      for (const c of colours(resolve(value, t), { named: true })) if (isAmber(c)) bad.add(`${name}: ${sel} { ${prop}: ${value} }`);
    }
  }
  // a defined amber / gold token is a trap left for the next rule: none may remain
  for (const [name, t] of Object.entries(themes)) for (const [k, v] of Object.entries(t)) for (const c of colours(v)) if (isAmber(c)) bad.add(`${name}: token --${k}: ${v}`);
  return [...bad].sort();
}
const SOURCES = readdirSync(DIR).filter((f) => (f.endsWith('.js') || f.endsWith('.html')) && !f.startsWith('__'));
// a JS / HTML source WITHOUT its comments — a real tokenizer (Codex HIGH r1 P2): string and template contents are kept (a // inside
// a string is not a comment), line and block comments go, HTML <!-- --> comments go. (No regex-literal colour exists in the portal; a
// regex is scanned as code, which can only over-report.)
function withoutComments(src, html) {
  if (html) return src.replace(/<!--[\s\S]*?-->/g, ' ');
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; } out += src.slice(i, j + 1); i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}
// where a colour can be written in a script or a page: an attribute, a declaration in a style string, setAttribute, style.<prop> =,
// style.setProperty — the value there is parsed WITH named colours; everywhere else only colour SYNTAX counts (copy that names «gold»
// is not a colour)
const PROPS = 'fill|stroke|color|stop-color|flood-color|lighting-color|background|background-color|border|border-color|border-top-color|border-bottom-color|outline-color|caret-color|accent-color|text-decoration-color|box-shadow|text-shadow';
const CONTEXTS = [
  new RegExp(`\\b(?:${PROPS})\\s*=\\s*(["'])([^"']*)\\1`, 'gi'),
  new RegExp(`\\b(?:${PROPS})\\s*:\\s*([^;"'\`}<>]+)`, 'gi'),
  /setAttribute\(\s*['"`](?:fill|stroke|color|stop-color|flood-color|style)['"`]\s*,\s*(['"`])([^'"`]*)\1/gi,
  /\.style\.(?:color|background|backgroundColor|fill|stroke|borderColor|outlineColor|boxShadow)\s*=\s*(['"`])([^'"`]*)\1/gi,
  /\.style\.setProperty\(\s*['"`][\w-]+['"`]\s*,\s*(['"`])([^'"`]*)\1/gi,
];
export function amberInSource(text, { html = /<(?:!doctype|html|svg|div|span)\b/i.test(text) && !/\b(?:const|let|function|import)\b/.test(text) } = {}) {
  const code = withoutComments(text, html);
  const found = [...colours(code)];
  for (const re of CONTEXTS) for (const m of code.matchAll(re)) found.push(...colours(m[m.length - 1], { named: true }));
  return [...new Set(found.filter(isAmber).map((c) => c.map((x) => Math.round(x * 255)).join(',')))];   // one report per colour
}

test('NO AMBER: styles.css resolves to no amber / gold hue in any declaration or token — light, dark and the system-dark block', () => {
  const bad = amberInSheet(CSS);
  assert.deepEqual(bad, [], `🔴 amber / gold in the sheet:\n  ${bad.join('\n  ')}`);
});

test('NO AMBER: no portal script or page carries an amber / gold colour literal (an SVG fill or a style string would bypass the sheet)', () => {
  assert.ok(SOURCES.includes('app.js') && SOURCES.includes('index.html'), `premise: the portal's sources (${SOURCES.length})`);
  const bad = SOURCES.flatMap((f) => amberInSource(readFileSync(join(DIR, f), 'utf8'), { html: f.endsWith('.html') }).map((c) => `${f}: rgb(${c})`));
  assert.deepEqual(bad, [], `🔴 amber / gold literals:\n  ${bad.join('\n  ')}`);
});

test('the meanings, by computed colour (light + dark): lavender = Recomendada · sky = unpublished · mint = Sherpa-only · sand = caution / the seal', () => {
  const themes = THEMES(CSS);
  const decl = declarations(CSS);
  const valueOf = (selRe, prop) => { const d = decl.find((x) => selRe.test(x.sel) && x.prop === prop); assert.ok(d, `premise: ${selRe} ${prop}`); return d.value; };
  const expect = [
    [/^\.kid \.rec$/, 'background', 'lav-soft'], [/^\.recpill\.recpill-on$/, 'color', 'lav-text'], [/^\.mk-rec$/, 'background', 'lav-soft'],
    [/^\.tag$/, 'color', 'sky-text'], [/^\.envio \.echip\.echg$/, 'color', 'sky-text'],
    [/^\.adm-tag$/, 'color', 'mint-text'], [/^\.envio \.epill$/, 'background', 'mint-soft'],
    [/^\.prow\.big$/, 'background', 'sand-soft'], [/^\.mgshared$/, 'color', 'sand-text'], [/^\.ops \.callout$/, 'background', 'sand-soft'],
    [/^\.seal$/, 'background', 'sand-soft'], [/^\.sealbadge$/, 'background', 'ink'],
  ];
  for (const [name, t] of Object.entries(themes)) {
    for (const [sel, prop, tok] of expect) {
      assert.ok(tok in t, `premise: --${tok} is defined (${name})`);
      assert.equal(resolve(valueOf(sel, prop), t).includes(t[tok]), true, `${name}: ${sel} ${prop} is --${tok}`);
    }
  }
});

test('non-vacuity: the measure finds amber / gold (today\'s tokens, a raw literal, an rgb()) and passes sand, sky, mint, lavender, red, green', () => {
  for (const c of ['#8A5200', '#FBF0DC', '#EBD6A6', '#8A6A12', '#E3B54A', '#FBF4E1', '#E3D2A0', 'rgb(232,162,62)', '#f59e0b', '#fbbf24']) assert.equal(colours(c).every(isAmber), true, `${c} is amber / gold`);
  for (const c of ['#FF8C00']) assert.equal(colours(c).every(isAmber), true, `${c} (darkorange, 32.9°) is amber`);
  for (const c of ['#7A4A24', '#F7EEE5', '#E6D2BE', '#E6BC93', '#2B2119', '#1E4E99', '#0E6A55', '#4E3DA6', '#D23425', '#0A6E3E', '#FFFFFF', '#0A0A0B']) assert.equal(colours(c).some(isAmber), false, `${c} is not`);
  const planted = `${CSS}\n.x{background:#E3B54A}`;
  assert.ok(amberInSheet(planted).some((b) => b.includes('.x {')), 'a planted amber rule is reported');
  assert.ok(amberInSource('const fill = "#f59e0b";').length === 1, 'a planted literal in a script is reported');
});

test('the .phoprice exemption covers ONLY that selector, property and value (the customer card preview)', () => {
  assert.deepEqual(EXEMPT, [{ sel: '.phoprice', prop: 'color', value: '#7A5A08' }], 'one entry, exactly');
  assert.ok(declarations(CSS).some((d) => d.sel === '.phoprice' && d.prop === 'color' && d.value === '#7A5A08'), 'premise: the preview\'s price rule is in the sheet');
  assert.ok(amberInSheet(`${CSS}\n.phoprice{background:#E3B54A}`).some((b) => b.includes('.phoprice { background')), 'another property on it is judged');
  assert.ok(amberInSheet(`${CSS}\n.other{color:#7A5A08}`).some((b) => b.includes('.other {')), 'the same value elsewhere is judged');
  assert.ok(amberInSheet(`${CSS}\n.phoprice b{color:#7A5A08}`).some((b) => b.includes('.phoprice b {')), 'a descendant is judged');
});

test('Codex HIGH r1 P2 — unbypassable: SVG fill="gold", fill="hsl(45,100%,50%)", and #f59e0b after an https:// string are all caught', () => {
  assert.ok(amberInSource('<svg><rect fill="gold"/></svg>').length > 0, 'a named colour in an SVG attribute');
  assert.ok(amberInSource('<svg><rect fill="hsl(45,100%,50%)"/></svg>').length > 0, 'hsl() in an SVG attribute');
  assert.ok(amberInSource('const u = "https://cdn.test/x"; const c = "#f59e0b";').length > 0, 'a literal after a // INSIDE a string (strings are not comments)');
  // the rest of the colour syntax, in the script and in the sheet
  for (const js of ["el.setAttribute('fill', 'orange');", "el.style.color = 'goldenrod';", "el.style.setProperty('background-color', 'darkorange');",
    'const s = `color:hsla(40 90% 50% / .8)`;', 'const s = "background: rgb(232 162 62)";', "const svg = '<circle stroke=\"DarkGoldenRod\"/>';"]) {
    assert.ok(amberInSource(js).length > 0, `caught: ${js}`);
  }
  for (const rule of ['.x{color:gold}', '.x{background:hsl(45deg 100% 50%)}', '.x{border-color:hsla(40,90%,50%,.5)}', '.x{fill:Orange}', '.x{color:rgb(232 162 62 / 50%)}']) {
    assert.ok(amberInSheet(`${CSS}\n${rule}`).some((b) => b.includes('.x {')), `caught in the sheet: ${rule}`);
  }
  // and nothing else: a comment, or copy that merely NAMES a colour outside any colour context, is not a colour
  assert.deepEqual(amberInSource('// #f59e0b\n/* fill="gold" */\nconst t = "Socio Gold · orange juice";'), [], 'comments and plain copy are not colours');
});
