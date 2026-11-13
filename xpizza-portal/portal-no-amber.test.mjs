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

// ── THE COLOUR GRAMMAR — STRICT (advisor FINAL ruling r2, codex-build-portal-ui-train-r2 #5): the guard FAILS CLOSED. A colour it can
// fully parse is measured; anything it cannot (oklch(), color-mix(), calc() inside hsl(), a system colour, an unresolved var(), a dynamic
// style write …) is a VIOLATION, never a pass, unless it is an ALLOW entry below. The rendered-page sweep in the SBS harness is the
// authoritative check (every element's computed colours, both themes, every slot); this guard keeps the source honest between slots.
const NAMED = Object.freeze({ aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32' });
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const RE_NUM = new RegExp(`^${NUM}$`, 'i');
const RE_PCT = new RegExp(`^(${NUM})%$`, 'i');
const RE_HUE = new RegExp(`^(${NUM})(deg|grad|rad|turn)?$`, 'i');
const RE_NUMTOK = new RegExp(`^${NUM}[a-z%]*`, 'i');
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
const chan = (x, max) => { const p = RE_PCT.exec(x); if (p) return parseFloat(p[1]) / 100 * max; return RE_NUM.test(x) ? parseFloat(x) : null; };
// the arguments of rgb() / hsl(): the legacy comma form «a, b, c[, d]» or the space form «a b c[ / d]» — nothing else
function fnArgs(raw) {
  const t = raw.trim();
  if (t.includes(',')) {
    const p = t.split(',').map((x) => x.trim());
    if (p.length < 3 || p.length > 4 || p.some((x) => !x || /\s/.test(x))) return null;
    return { ch: p.slice(0, 3), a: p[3] };
  }
  const parts = t.split('/'); if (parts.length > 2) return null;
  const ch = parts[0].trim().split(/\s+/); if (ch.length !== 3) return null;
  if (parts.length === 2) { const a = parts[1].trim(); if (!a || /\s/.test(a)) return null; return { ch, a }; }
  return { ch };
}
// rgb() / rgba() / hsl() / hsla() → [r, g, b, a] (0..1), or null when the arguments are not exactly that grammar (calc(), none, var(), a unit …)
function parseColourFn(name, raw) {
  const fn = name.toLowerCase(), a = fnArgs(raw); if (!a) return null;
  const alpha = a.a === undefined ? 1 : chan(a.a, 1); if (alpha === null || !Number.isFinite(alpha)) return null;
  if (fn === 'rgb' || fn === 'rgba') {
    const v = a.ch.map((x) => chan(x, 255)); if (v.some((x) => x === null || !Number.isFinite(x))) return null;
    return [...v.map((x) => clamp01(x / 255)), clamp01(alpha)];
  }
  if (fn === 'hsl' || fn === 'hsla') {
    const m = RE_HUE.exec(a.ch[0]); if (!m) return null;
    let h = parseFloat(m[1]); const u = (m[2] || 'deg').toLowerCase();
    if (u === 'turn') h *= 360; else if (u === 'rad') h = h * 180 / Math.PI; else if (u === 'grad') h *= 0.9;
    const s = chan(a.ch[1], 100), l = chan(a.ch[2], 100);
    if (![h, s, l].every((x) => x !== null && Number.isFinite(x))) return null;
    h = ((h % 360) + 360) % 360;
    return [...hslToRgb(h, clamp01(s / 100), clamp01(l / 100)), clamp01(alpha)];
  }
  return null;
}
const hexColour = (h) => {
  if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-f]/i.test(h)) return null;
  const x = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).concat(x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1);
};
// a lenient SYNTAX scan (the non-vacuity cells, the whole-script hex sweep): every #hex and every parseable rgb() / hsl() in a text
function colours(v, { named = false } = {}) {
  const out = [];
  for (const m of String(v).matchAll(/#([0-9a-f]{3,8})\b/gi)) { const c = hexColour(m[1]); if (c) out.push(c); }
  for (const m of String(v).matchAll(/\b(rgba?|hsla?)\(([^()]*)\)/gi)) { const c = parseColourFn(m[1], m[2]); if (c) out.push(c); }
  if (named) for (const w of String(v).toLowerCase().match(/[a-z]+/g) || []) if (Object.prototype.hasOwnProperty.call(NAMED, w)) out.push(hexColour(NAMED[w]));
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

// functions the guard does not model — a violation wherever they appear (hue-rotate() can carry any hue into the band)
const OPAQUE_FN = new Set(['hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'device-cmyk', 'contrast-color', 'hue-rotate', 'attr', 'env', 'image-set', '-webkit-image-set', 'element', 'paint', 'cross-fade']);
// functions whose arguments are judged in place (geometry, filters, gradients)
const CONTAINER_FN = new Set(['calc', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient', 'drop-shadow', 'blur', 'grayscale', 'saturate', 'brightness', 'contrast', 'opacity', 'invert', 'sepia']);
// identifiers that are NOT colours, allowed in a colour-bearing property; any other identifier there (Mark, Highlight, a typo) fails closed
const KEYWORDS = new Set(['none', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'important', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden', 'thin', 'medium', 'thick', 'auto', 'to', 'top', 'bottom', 'left', 'right', 'center', 'circle', 'ellipse', 'at', 'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner', 'no-repeat', 'repeat', 'repeat-x', 'repeat-y', 'space', 'round', 'cover', 'contain', 'fixed', 'scroll', 'local', 'padding-box', 'border-box', 'content-box', 'text', 'underline', 'overline', 'line-through', 'wavy', 'from-font', 'in', 'srgb', 'oklab', 'shorter', 'longer', 'increasing', 'decreasing', 'hue']);
// a colour-bearing property: anything naming a colour, plus the shorthands that carry one (fail closed: an unknown *color* property counts)
const COLOUR_PROP = (p) => /colou?r/i.test(p) || /^(-webkit-)?(background(-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?|outline|fill|stroke|box-shadow|text-shadow|text-decoration|column-rule|filter|backdrop-filter|text-stroke|text-emphasis|mask|mask-image)$/i.test(p);

// a balanced (…) from s[i] === '(' → [inside, indexAfter] (quotes respected), or null
function balanced(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { const k = s.indexOf(c, j + 1); if (k < 0) return null; j = k; continue; }
    if (c === '(') d++; else if (c === ')' && --d === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}
const topComma = (s) => { let d = 0; for (let j = 0; j < s.length; j++) { const c = s[j]; if (c === '(') d++; else if (c === ')') d--; else if (c === ',' && d === 0) return j; } return -1; };

// var() resolved across EVERY scope: a value becomes every value it can take (each definition of each token anywhere in the sheet —
// :root, a theme, a component, inside @media — and the fallback); an undefined token with no fallback stays as an unresolved marker
function expandVars(value, defs, depth = 0, budget = { n: 0 }) {
  const i = String(value).search(/var\(/i); if (i < 0) return [value];
  if (depth > 16 || ++budget.n > 50000) throw new Error('a var() chain too deep or too wide to resolve');
  const b = balanced(value, i + 3); if (!b) throw new Error('an unbalanced var()');
  const [inner, after] = b; const comma = topComma(inner);
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim(); const fb = comma < 0 ? null : inner.slice(comma + 1).trim();
  const cands = [...(defs.get(name) || [])]; if (fb !== null) cands.push(fb);
  if (!cands.length) cands.push(`__unresolved(${name})`);
  const out = new Set();
  for (const c of cands) for (const v of expandVars(value.slice(0, i) + c + value.slice(after), defs, depth + 1, budget)) {
    out.add(v); if (out.size > 4096) throw new Error('a var() chain too wide to resolve');
  }
  return [...out];
}

// judge one var-free CSS value → { found: [colours], errors: [why it fails closed] }
function judgeValue(v, colourProp, out = { found: [], errors: [] }) {
  const s = String(v); let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { const k = s.indexOf(c, i + 1); i = k < 0 ? s.length : k + 1; continue; }
    if (c === '#') { const m = /^#[\w-]*/.exec(s.slice(i)); const col = hexColour(m[0].slice(1)); if (col) out.found.push(col); else out.errors.push(`unparseable hex «${m[0]}»`); i += m[0].length; continue; }
    if (/[\d.]/.test(c) || (/[+-]/.test(c) && /[\d.]/.test(s[i + 1] || ''))) { const n = RE_NUMTOK.exec(s.slice(i)); if (n) { i += n[0].length; continue; } }
    const id = /^-{0,2}[a-z_][\w-]*/i.exec(s.slice(i));
    if (!id) { i++; continue; }
    const name = id[0].toLowerCase(), j = i + id[0].length;
    if (s[j] === '(') {
      const b = balanced(s, j); if (!b) { out.errors.push(`unbalanced «${s.slice(i, i + 40)}»`); return out; }
      const [inner, after] = b; i = after;
      if (/^(rgba?|hsla?)$/.test(name)) { const col = parseColourFn(name, inner); if (col) out.found.push(col); else out.errors.push(`unparseable «${name}(${inner})»`); }
      else if (name === '__unresolved') { if (colourProp) out.errors.push(`an unresolved var(${inner})`); }
      else if (name === 'url') {
        const u = inner.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
        if (/^data:image\/svg/i.test(u)) {
          let d; try { d = decodeURIComponent(u.slice(u.indexOf(',') + 1)); } catch { out.errors.push('an undecodable SVG data URI'); continue; }
          for (const r of amberInSource(d, { html: true })) out.errors.push(`in an SVG data URI: ${r}`);
        }
      } else if (OPAQUE_FN.has(name)) out.errors.push(`${name}() is not modelled`);
      else if (CONTAINER_FN.has(name) || !colourProp) judgeValue(inner, colourProp, out);
      else out.errors.push(`an unknown function ${name}() in a colour property`);
      continue;
    }
    i = j;
    if (Object.prototype.hasOwnProperty.call(NAMED, name)) out.found.push(hexColour(NAMED[name]));
    else if (colourProp && !KEYWORDS.has(name) && !name.startsWith('--')) out.errors.push(`an unknown identifier «${id[0]}» in a colour property`);
  }
  return out;
}

// the declarations of a sheet, with the selector each belongs to (comments stripped; @media and @keyframes bodies included)
function declarations(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out.push({ sel, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() }); }
  }
  return out;
}
const defsOf = (decl) => { const defs = new Map(); for (const d of decl) if (d.prop.startsWith('--')) { if (!defs.has(d.prop)) defs.set(d.prop, new Set()); defs.get(d.prop).add(d.value); } return defs; };
// THE ONE EXEMPTION (advisor 11-13, option (a)): the photo drawer's «Así se ve en el pedido» preview draws the CUSTOMER order page's card
// in that page's own colours — «faithful preview of the customer order page's card; changes with that page». Exactly this selector,
// property and value; anything else on it (or this value anywhere else) is judged like every other rule. The customer-side gold price is
// on the owner's list as a separate question.
export const EXEMPT = Object.freeze([Object.freeze({ sel: '.phoprice', prop: 'color', value: '#7A5A08' })]);
const exempt = (sel, prop, value) => EXEMPT.some((e) => e.sel === sel && e.prop === prop && e.value === value);
// judge «prop: value» (var() resolved across every scope of `defs`) → the reports
function judgeDecl(at, prop, value, defs) {
  const bad = [];
  let variants; try { variants = expandVars(value, defs); } catch (e) { return [`${at} — fails closed: ${e.message}`]; }
  const colourProp = !prop.startsWith('--') && COLOUR_PROP(prop);
  for (const v of variants) {
    const r = judgeValue(v, colourProp);
    if (r.found.some(isAmber)) bad.push(`${at}${v !== value ? ` → ${v}` : ''}`);
    for (const e of r.errors) bad.push(`${at} — fails closed: ${e}`);
  }
  return bad;
}
// EVERY declaration — custom properties at ANY scope included, inside @media and @keyframes — is judged after resolving its var()s
export function amberInSheet(css) {
  const decl = declarations(css), defs = defsOf(decl), bad = new Set();
  for (const { sel, prop, value } of decl) if (!exempt(sel, prop, value)) for (const b of judgeDecl(`${sel} { ${prop}: ${value} }`, prop, value, defs)) bad.add(b);
  return [...bad].sort();
}

const SOURCES = readdirSync(DIR).filter((f) => (f.endsWith('.js') || f.endsWith('.html')) && !f.startsWith('__'));
const SHEET_DEFS = defsOf(declarations(CSS));
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
// one argument of a call from code[i] → [text, indexOfTheSeparator] (stops at the top-level , or ))
function readArg(code, i) {
  let d = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === '"' || c === "'" || c === '`') { let k = j + 1; while (k < code.length && code[k] !== c) { if (code[k] === '\\') k++; k++; } j = k; continue; }
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (d === 0) return [code.slice(i, j), j]; d--; }
    else if (c === ',' && d === 0) return [code.slice(i, j), j];
  }
  return [code.slice(i), code.length];
}
// the right-hand side of an assignment from code[i] (to the top-level ; or end of line)
function readRhs(code, i) { let d = 0; for (let j = i; j < code.length; j++) { const c = code[j]; if (c === '"' || c === "'" || c === '`') { let k = j + 1; while (k < code.length && code[k] !== c) { if (code[k] === '\\') k++; k++; } j = k; continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { if (d === 0) return code.slice(i, j); d--; } else if ((c === ';' || c === '\n') && d === 0) return code.slice(i, j); } return code.slice(i); }
// a plain string literal's text, or null when the expression is anything else (a variable, a call, an interpolated template)
const literal = (t) => { const m = /^\s*(['"])([\s\S]*)\1\s*$/.exec(t); if (m && !m[2].includes(m[1])) return m[2]; const b = /^\s*`([^`]*)`\s*$/.exec(t); return b && !b[1].includes('${') ? b[1] : null; };
const kebab = (p) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const ATTR = /^(fill|stroke|color|stop-color|flood-color|lighting-color)$/i;
const declsIn = (str) => str.split(';').map((d) => { const i = d.indexOf(':'); return i > 0 ? [d.slice(0, i).trim(), d.slice(i + 1).trim()] : null; }).filter(Boolean);
// the explicit ALLOW list — the ONLY dynamic colour writes the guard accepts, each pinned to its file and exact call (a premise cell
// proves each still exists exactly once, so a stale entry is red):
const ALLOW = Object.freeze([
  Object.freeze({ file: 'branches-view.js', at: "setAttribute('stroke', stroke)", why: 'the 1a static map path helper g(); its only two callers, in the same file, pass the literal #CFD6CC and #B9C3B5, which the hex sweep measures' }),
  Object.freeze({ file: 'photo.js', at: 'setAttribute(k, v)', why: 'icon(): writes the ICONS table, a literal object of geometry only (d / cx / cy / r / x / y / width / height / rx) — a colour key in it would be judged by the key context' }),
  Object.freeze({ file: 'ops-dom.js', at: 'setAttribute(k, String(v))', why: 'the stroke-icon helper: its specs are literal {rect}/{circle} geometry objects — a colour key in one would be judged by the key context' }),
  Object.freeze({ file: 'ventas.js', at: 'setAttribute(k, v)', why: 'the el() attribute helper: every attrs object is a literal at its call site — a colour key in one would be judged by the key context' }),
]);
export function amberInSource(text, { html = /<(?:!doctype|html|svg|div|span)\b/i.test(text) && !/\b(?:const|let|function|import)\b/.test(text), file = null } = {}) {
  const code = withoutComments(text, html);
  const found = [...colours(code)], errors = [];
  const fail = (why, at) => { if (!ALLOW.some((a) => a.file === file && a.at === at)) errors.push(`fails closed: ${why} «${at}»`); };
  const judge = (prop, value, at) => { for (const r of judgeDecl(at, prop, value, SHEET_DEFS)) errors.push(r.includes('fails closed') ? r.replace(/^.* — /, '') + ` «${at}»` : `amber «${at}»`); };
  // 1. every colour FUNCTION anywhere in the code must parse (an interpolated rgb(${r} …) cannot)
  for (const m of code.matchAll(/(^|[^\w$.-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|light-dark|device-cmyk|color)\(/gi)) {
    const at = m.index + m[1].length, b = balanced(code, at + m[2].length);
    const snip = b ? code.slice(at, b[1]) : code.slice(at, at + 40);
    if (!b) fail('an unbalanced colour function', snip);
    else if (/^(rgba?|hsla?)$/i.test(m[2])) { if (!parseColourFn(m[2], b[0])) fail('an unparseable colour function', snip); }
    else fail(`${m[2]}() is not modelled`, snip);
  }
  // 2. colour attributes and style attributes in markup / strings: an interpolated value fails closed, a literal one is judged
  for (const m of code.matchAll(/\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*(["'])([^"'\n]*)\2/gi)) {
    if (m[3].includes('${')) fail('an interpolated colour attribute', m[0]); else judge(m[1], m[3], m[0]);
  }
  for (const m of code.matchAll(/\bstyle\s*=\s*(["'])([^"'\n]*)\1/gi)) {
    if (m[2].includes('${')) { for (const [p, v] of declsIn(m[2])) if (COLOUR_PROP(p) || p.startsWith('--')) { if (v.includes('${')) fail('an interpolated colour in a style attribute', m[0]); else judge(p, v, m[0]); } }
    else for (const [p, v] of declsIn(m[2])) judge(p, v, m[0]);
  }
  // 3. a colour-named key or a CSS declaration in a string — «color: x», «fill: c», «backgroundColor: 'gold'», «border-left-color:${c}»
  for (const m of code.matchAll(/(?<![\w$.-])([\w-]*(?:[Cc]olou?r|fill|Fill|stroke|Stroke|[Ss]hadow|background|Background|border|Border|outline|Outline))\s*:\s*(?!:)/g)) {
    const p = kebab(m[1]); if (!COLOUR_PROP(p) && !/^(fill|stroke)$/i.test(p)) continue;
    const rest = code.slice(m.index + m[0].length);
    if (/^['"`]/.test(rest)) { const [arg] = readArg(rest, 0); const lit = literal(arg); if (lit === null) fail('a dynamic colour value', `${m[0]}${arg.trim()}`); else judge(p, lit, `${m[0]}${arg.trim()}`); continue; }
    const v = /^[^;"'`}<>,\n]*/.exec(rest)[0].trim();
    if (!v) continue;
    if (v.includes('${')) fail('an interpolated colour value', `${m[0]}${v}`); else judge(p, v, `${m[0]}${v}`);
  }
  // 4. DOM writes: setAttribute, el.style.<colour prop> =, style.cssText, style[…], style.setProperty, Object.assign(…style…), .style =
  for (const m of code.matchAll(/\bsetAttribute\(/g)) {
    const [name, sep] = readArg(code, m.index + m[0].length); const [val, end] = readArg(code, sep + 1);
    const at = code.slice(m.index, end + 1).replace(/\s+/g, ' '), n = literal(name);
    if (n === null) { fail('a dynamic attribute name', at); continue; }
    if (!ATTR.test(n) && n.toLowerCase() !== 'style') continue;
    const v = literal(val); if (v === null) { fail('a dynamic colour attribute', at); continue; }
    if (n.toLowerCase() === 'style') for (const [p, x] of declsIn(v)) judge(p, x, at); else judge(n, v, at);
  }
  for (const m of code.matchAll(/\.style\.([A-Za-z]+)\s*(\+?=)(?!=)/g)) {
    const p = kebab(m[1]); if (!COLOUR_PROP(p) && p !== 'css-text') continue;
    const rhs = readRhs(code, m.index + m[0].length), at = `${m[0]}${rhs.trim()}`, v = literal(rhs);
    if (v === null) { fail('a dynamic style colour', at); continue; }
    if (p === 'css-text') for (const [q, x] of declsIn(v)) judge(q, x, at); else judge(p, v, at);
  }
  for (const m of code.matchAll(/\.style\s*\[/g)) fail('a computed style property', code.slice(m.index, m.index + 40).split('\n')[0]);
  for (const m of code.matchAll(/\.style\s*=(?!=)/g)) { const rhs = readRhs(code, m.index + m[0].length), v = literal(rhs), at = `${m[0]}${rhs.trim()}`; if (v === null) fail('a dynamic style string', at); else for (const [q, x] of declsIn(v)) judge(q, x, at); }
  for (const m of code.matchAll(/\bObject\.assign\(\s*([^,)]*)/g)) if (/\bstyle\b/.test(m[1])) fail('Object.assign onto a style', code.slice(m.index, m.index + 60).split('\n')[0]);
  for (const m of code.matchAll(/\.style\.setProperty\(/g)) {
    const [name, sep] = readArg(code, m.index + m[0].length); const [val, end] = readArg(code, sep + 1);
    const at = code.slice(m.index, end + 1), n = literal(name), v = literal(val);
    if (n === null || v === null) fail('a dynamic setProperty', at); else judge(n, v, at);
  }
  return [...new Set([...found.filter(isAmber).map((c) => `amber rgb(${c.slice(0, 3).map((x) => Math.round(x * 255)).join(',')})`), ...errors])];
}

test('NO AMBER: every declaration of styles.css (custom properties at any scope, @media, var() resolved across every scope) is parseable and carries no amber / gold', () => {
  const bad = amberInSheet(CSS);
  assert.deepEqual(bad, [], `🔴 amber / gold in the sheet:\n  ${bad.join('\n  ')}`);
});

test('NO AMBER: no portal script or page carries an amber / gold colour or an unjudgeable colour write (beyond ALLOW)', () => {
  assert.ok(SOURCES.includes('app.js') && SOURCES.includes('index.html'), `premise: the portal's sources (${SOURCES.length})`);
  const bad = SOURCES.flatMap((f) => amberInSource(readFileSync(join(DIR, f), 'utf8'), { html: f.endsWith('.html'), file: f }).map((c) => `${f}: ${c}`));
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
  assert.ok(amberInSource('const fill = "#f59e0b";').length > 0, 'a planted literal in a script is reported');
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

// ── advisor FINAL ruling r2 (codex-build-portal-ui-train-r2 #5): the static guard FAILS CLOSED. Every bypass Codex found, and every
// colour form the guard cannot fully parse, is RED — in any declaration (custom properties at ANY scope, inside @media), in any JS
// style.* write, SVG fill / stroke, attribute or style string — unless it is an explicit ALLOW entry below.
const SHEET_RED = [
  ['Codex r2: a scoped custom property + var()', '.x{--alert:gold}\n.y{color:var(--alert)}'],
  ['Codex r2: the same inside @media dark', '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .x{--alert:gold}}\n.y{border-color:var(--alert)}'],
  ['a custom property carrying amber at any scope, used or not', '.x{--alert:#E3B54A}'],
  ['Codex r2: hsl() in grad', '.x{color:hsl(50grad 100% 50%)}'],
  ['the grad unit is CONVERTED (65grad = 58.5°, in the band; read as 65° it would pass)', '.x{color:hsl(65grad 100% 50%)}'],
  ['Codex r2: rgb() in exponent form', '.x{color:rgb(2.55e2 1.62e2 6.2e1)}'],
  ['a var() fallback', '.x{color:var(--ink, gold)}'],
  ['fails closed: oklch()', '.x{color:oklch(80% .15 80)}'],
  ['fails closed: color-mix()', '.x{color:color-mix(in srgb, red 50%, yellow)}'],
  ['fails closed: light-dark()', '.x{color:light-dark(red, gold)}'],
  ['fails closed: calc() inside hsl()', '.x{color:hsl(calc(40deg) 90% 50%)}'],
  ['fails closed: a system colour (Mark)', '.x{color:Mark}'],
  ['fails closed: an unresolved var()', '.x{outline-color:var(--nope)}'],
  ['fails closed: lab() in a custom property', '.x{--c:lab(70 20 70)}'],
  ['fails closed: a malformed hex', '.x{color:#f59e0}'],
  ['fails closed: hue-rotate() can move any hue into the band', '.x{filter:hue-rotate(30deg)}'],
  ['an SVG data URI in the sheet', `.x{background:url("data:image/svg+xml,%3Csvg fill='%23f59e0b'/%3E")}`],
];
const SOURCE_RED = [
  ["Codex r2: el.style.borderBottomColor = 'gold'", "el.style.borderBottomColor='gold';"],
  ['a dynamic style colour', 'el.style.color = c;'],
  ['a dynamic setAttribute fill', "el.setAttribute('fill', c);"],
  ["style['color']", "el.style['color'] = 'gold';"],
  ['Object.assign onto a style', "Object.assign(el.style, { color: 'gold' });"],
  ['an interpolated SVG fill', 'const s = `<rect fill="${c}"/>`;'],
  ['an interpolated style attribute', 'const s = `<p style="color:${c}">`;'],
  ['cssText', "el.style.cssText = 'border-left-color:gold';"],
  ['setProperty with a dynamic value', "el.style.setProperty('--alert', x);"],
  ['setAttribute with a dynamic name', 'el.setAttribute(k, v);'],
  ['a colour-named key with a dynamic value', 'const o = { fill: c };'],
  ['rgb() in exponent form in a string', "const s = 'rgb(2.55e2 1.62e2 6.2e1)';"],
  ['hsl() in grad in a string', "const s = 'hsl(50grad 100% 50%)';"],
  ['an interpolated colour function', 'const s = `color: rgb(${r} 0 0)`;'],
];
// the USE site is reported (not only the definition): a token defined in a component or @media scope resolves at .y even when .y
// carries a harmless fallback — read as «undefined → fallback», it would pass
const USE_RED = [
  ['Codex r2: a scoped custom property reaches its var() use (the mint fallback does not hide it)', '.x{--alert:gold}\n.y{color:var(--alert, #0E6A55)}'],
  ['Codex r2: a custom property scoped inside @media dark reaches its use', '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .x{--alert:#E3B54A}}\n.y{background:var(--alert, #DFF4ED)}'],
];
for (const [name, rule] of SHEET_RED) {
  test(`RED (sheet) — ${name}`, () => {
    const bad = amberInSheet(`${CSS}\n${rule}`);
    assert.ok(bad.some((b) => /^(\.x|\.y|:root:not\(\[data-theme="light"\]\) \.x) \{/.test(b)), `not caught: ${rule}\n  ${bad.join('\n  ')}`);
  });
}
for (const [name, rule] of USE_RED) {
  test(`RED (use site) — ${name}`, () => {
    const bad = amberInSheet(`${CSS}\n${rule}`);
    assert.ok(bad.some((b) => b.startsWith('.y {') && !b.includes('fails closed')), `the use at .y resolves to amber: ${rule}\n  ${bad.join('\n  ')}`);
  });
}
test('fail-closed never means fail-everything: the full grammar of NON-amber colours is measured and passes (exponents, grad, turn, %, / alpha)', () => {
  for (const v of ['rgb(1e2 2e2 1e2)', 'rgb(10% 40% 80% / .5)', 'rgba(14,106,85,0.4)', 'hsl(200grad 50% 50%)', 'hsl(.5turn 50% 50%)', 'hsl(3.14rad 40% 40% / 50%)', '#0E6A55', '#4E3DA680', 'transparent', 'currentColor']) {
    const bad = amberInSheet(`${CSS}\n.z{color:${v}}`).filter((b) => b.startsWith('.z {'));
    assert.deepEqual(bad, [], `measured, not amber: ${v}`);
  }
});
for (const [name, js] of SOURCE_RED) {
  test(`RED (source) — ${name}`, () => { assert.ok(amberInSource(js).length > 0, `not caught: ${js}`); });
}

test('ALLOW: each entry is pinned — its file carries the exact call exactly once (a stale entry is red), and nothing else is allowed', () => {
  assert.equal(ALLOW.length, 4, 'four call sites, exactly');
  for (const a of ALLOW) {
    const code = readFileSync(join(DIR, a.file), 'utf8');
    assert.equal(code.split(a.at).length - 1, 1, `${a.file}: «${a.at}» occurs exactly once`);
    assert.ok(a.why.length > 40, `${a.file}: the entry says why`);
  }
  assert.ok(amberInSource("el.setAttribute('stroke', stroke);", { file: 'app.js' }).length > 0, 'an entry allows ONLY its own file');
  assert.ok(amberInSource("el.setAttribute('fill', fill);", { file: 'branches-view.js' }).length > 0, 'and ONLY its exact call');
});
