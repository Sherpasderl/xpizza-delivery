// «No amber» (OWNER 2026-11-12, «Amber makes it look like excel»; the owner-approved pastel-chips mockup, advisor ruling 11-13) — the
// merchant portal carries NO amber / gold hue anywhere, in either theme. Every chip, pill, tag, callout and seal speaks the pastel set by
// MEANING: lavender = Recomendada · sky = unpublished · mint = Admin Sherpa / Sherpa-only · sand = caution (the SAR seal: sand + ink).
// COMPUTED over the shipped files, not a class list: styles.css is resolved through its OWN tokens per theme (the light block, the dark
// block, the system-dark block — jsdom never substitutes var(), so the test does), then every colour in every declaration is measured;
// the portal's own JS and HTML are scanned for literal colours too (an SVG fill or an inline style would bypass the sheet).
// Amber / gold = hue 33°–62° at saturation ≥ 0.25 (sand sits at 26°–30°, below the band; red / green / sky / mint / lavender far from it).
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

// every colour literal in a value → [r, g, b, a] (0..1)
function colours(v) {
  const out = [];
  for (const m of v.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    let h = m[1]; if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) continue;
    out.push([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1));
  }
  for (const m of v.matchAll(/rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/gi)) {
    const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    out.push([+m[1] / 255, +m[2] / 255, +m[3] / 255, a]);
  }
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
export const isAmber = (c) => { if (c[3] === 0) return false; const { h, s, l } = hsl(c); return h >= 33 && h <= 62 && s >= 0.25 && l > 0.05 && l < 0.97; };

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
      for (const c of colours(resolve(value, t))) if (isAmber(c)) bad.add(`${name}: ${sel} { ${prop}: ${value} }`);
    }
  }
  // a defined amber / gold token is a trap left for the next rule: none may remain
  for (const [name, t] of Object.entries(themes)) for (const [k, v] of Object.entries(t)) for (const c of colours(v)) if (isAmber(c)) bad.add(`${name}: token --${k}: ${v}`);
  return [...bad].sort();
}
const SOURCES = readdirSync(DIR).filter((f) => (f.endsWith('.js') || f.endsWith('.html')) && !f.startsWith('__'));
export function amberInSource(text) {
  const bad = [];
  for (const c of colours(text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) if (isAmber(c)) bad.push(c.map((x) => Math.round(x * 255)).join(','));
  return bad;
}

test('NO AMBER: styles.css resolves to no amber / gold hue in any declaration or token — light, dark and the system-dark block', () => {
  const bad = amberInSheet(CSS);
  assert.deepEqual(bad, [], `🔴 amber / gold in the sheet:\n  ${bad.join('\n  ')}`);
});

test('NO AMBER: no portal script or page carries an amber / gold colour literal (an SVG fill or a style string would bypass the sheet)', () => {
  assert.ok(SOURCES.includes('app.js') && SOURCES.includes('index.html'), `premise: the portal's sources (${SOURCES.length})`);
  const bad = SOURCES.flatMap((f) => amberInSource(readFileSync(join(DIR, f), 'utf8')).map((c) => `${f}: rgb(${c})`));
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
