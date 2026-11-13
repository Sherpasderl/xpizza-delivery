// «Envío» field focus (OWNER 11-11, live bug: the «Hasta» input in its error state showed TWO heavy ink rectangles — the global
// :focus-visible ring on the input AND the .inp wrapper's :focus-within ring). Envío fields follow the portal's field focus: the green
// border + soft green halo on the field box, the red border when invalid (a red halo when invalid AND focused) — NO ink ring on the
// input or its wrapper. COMPUTED styles over the shipped styles.css: jsdom resolves the cascade (:focus-within and :focus-visible
// included) but never substitutes var(), so the test resolves the stylesheet's OWN tokens first — the light block
// (:root, :root[data-theme="light"]) and the dark one (:root[data-theme="dark"]) — and runs every state in both themes.
// Run: node --test envio-field-focus.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const CSS = readFileSync(join(DIR, 'styles.css'), 'utf8');

const blockAfter = (sel) => { const i = CSS.indexOf(sel); assert.ok(i >= 0, `premise: the token block ${sel}`); const a = CSS.indexOf('{', i), b = CSS.indexOf('}', a); return CSS.slice(a + 1, b); };
const tokensOf = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const LIGHT = tokensOf(blockAfter(':root, :root[data-theme="light"]{'));
const DARK = { ...LIGHT, ...tokensOf(blockAfter(':root[data-theme="dark"]{')) };
const resolve = (css, t) => { let out = css; for (let i = 0; i < 6; i++) out = out.replace(/var\(--([\w-]+)\)/g, (m, k) => (k in t ? t[k] : m)); return out; };

// the two Envío field shapes, as envio.js builds them: a band's km / fee box (label.inp > input + unit) and the picker's search
function page(theme) {
  const t = theme === 'dark' ? DARK : LIGHT;
  const dom = new JSDOM(`<!doctype html><style>${resolve(CSS, t)}</style><div class="envio">
    <label class="inp" id="ok"><input id="km"><span>km</span></label>
    <label class="inp bad" id="badbox"><input id="kmbad"><span>km</span></label>
    <div class="psearch"><input id="q"></div></div>`, { pretendToBeVisual: true });
  const d = dom.window.document;
  // a color as jsdom computes it, for comparing with a resolved token
  const probe = d.createElement('i'); d.body.append(probe);
  const color = (c) => { probe.style.color = c; return dom.window.getComputedStyle(probe).color; };
  return { d, t, color, cs: (id) => dom.window.getComputedStyle(d.getElementById(id)), focus: (id) => d.getElementById(id).focus() };
}
// the global ink ring (--focus: 2px board + 4px ink), recognised by its shape whatever the computed spelling (hex / rgb, spacing)
const isInk = (shadow, p) => { const n = String(shadow).replace(/\s+/g, '').toLowerCase(); return n.includes('4px') && (n.includes(p.t.ink.toLowerCase()) || n.includes(p.color(p.t.ink).replace(/\s+/g, '').toLowerCase())); };
const hasHalo = (shadow, tok, p) => shadow.includes('3px') && shadow.replace(/\s+/g, '').toLowerCase().includes(resolve(`var(--${tok})`, p.t).replace(/\s+/g, '').toLowerCase());

for (const theme of ['light', 'dark']) {
  test(`Envío fields (${theme}): idle — no ring of any kind; the invalid box keeps its red border`, () => {
    const p = page(theme);
    for (const id of ['ok', 'badbox', 'km', 'kmbad', 'q']) assert.ok(!isInk(p.cs(id).boxShadow, p), `${id}: no ink ring at rest`);
    assert.equal(p.cs('badbox').borderTopColor, p.color(p.t.red), 'invalid: the red border');
  });
  test(`Envío fields (${theme}): focus — the green border + halo on the box; NO ink ring on the input or its wrapper`, () => {
    const p = page(theme); p.focus('km');
    assert.ok(p.d.getElementById('km').matches(':focus-visible'), 'premise: a focused text input is :focus-visible (the global ring applies)');
    assert.ok(['none', ''].includes(p.cs('km').boxShadow), 'no ink ring on the input');
    assert.ok(!isInk(p.cs('ok').boxShadow, p), 'no ink ring on the wrapper');
    assert.ok(hasHalo(p.cs('ok').boxShadow, 'tint2', p), 'the soft green halo on the field box');
    assert.equal(p.cs('ok').borderTopColor, p.color(p.t.accent), 'the green border');
  });
  test(`Envío fields (${theme}): invalid + focus — the red border and a red halo; still no ink ring (the owner’s screenshot)`, () => {
    const p = page(theme); p.focus('kmbad');
    assert.ok(['none', ''].includes(p.cs('kmbad').boxShadow), 'no ink ring on the invalid input');
    assert.ok(!isInk(p.cs('badbox').boxShadow, p), 'no ink ring on the invalid wrapper');
    assert.ok(hasHalo(p.cs('badbox').boxShadow, 'red-line', p), 'a red halo while invalid and focused');
    assert.equal(p.cs('badbox').borderTopColor, p.color(p.t.red), 'the red border stays');
  });
  test(`Envío fields (${theme}): the picker search — the green border + halo, no ink ring`, () => {
    const p = page(theme); p.focus('q');
    assert.equal(p.cs('q').borderTopColor, p.color(p.t.accent), 'the search’s green border');
    assert.ok(hasHalo(p.cs('q').boxShadow, 'tint2', p), 'the search’s soft green halo');
    assert.ok(!isInk(p.cs('q').boxShadow, p), 'no ink ring on the search');
  });
}

// ── «No amber» (OWNER 11-12) — the SAND surfaces as the browser computes them over the shipped styles.css: ENVÍO v3 A4's capped note,
// «Quitar del menú» R3's «Se quita al publicar» chip (over the base .tag, which is AMBER) and R5's reward line. Each resolves to the sand
// tokens — text, background and border — never an amber one, and its text passes AA (≥ 4.5:1) on its own background, in both themes.
const hex = (h) => { const x = String(h).trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255); };
const lum = (h) => { const [r, g, b] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
// the hue rule of portal-no-amber.test.mjs, on a computed rgb()
const AMBER = (v) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(v)); if (!m) return false; const [r, g, b] = m.slice(1, 4).map((x) => +x / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (!d) return false;
  const sat = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360;
  return h >= 33 && h <= 62 && sat >= 0.25; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
function sandPage(theme) {
  const t = theme === 'dark' ? DARK : LIGHT;
  const dom = new JSDOM(`<!doctype html><style>${resolve(CSS, t)}</style>
    <div class="envio"><div class="capnote sand" id="cap"><span>Hoy entrega hasta 6 km</span></div></div>
    <div class="irow mk-pend"><div class="iinfo"><div class="nm mk-pendtxt">Wonton<span class="tag mk-sand" id="chip">Se quita al publicar</span></div></div></div>
    <div class="mk-sandline" id="line"><span>Este producto se canjea con recompensas</span></div>`, { pretendToBeVisual: true });
  const d = dom.window.document;
  const probe = d.createElement('i'); d.body.append(probe);
  const color = (c) => { probe.style.color = c; return dom.window.getComputedStyle(probe).color; };
  return { t, color, cs: (id) => dom.window.getComputedStyle(d.getElementById(id)) };
}
for (const theme of ['light', 'dark']) {
  test(`sand, not amber (${theme}): the capped note, the pending chip and the reward line compute to the sand tokens; AA on their background`, () => {
    const p = sandPage(theme);
    // the pastel sweep (11-13) retired the amber / gold tokens: none may exist; every colour below is ALSO measured by the hue rule
    assert.deepEqual(Object.keys(p.t).filter((k) => /^(amber|gold)/.test(k)), [], 'no amber / gold token is defined');
    for (const id of ['cap', 'chip', 'line']) {
      const s = p.cs(id);
      assert.equal(s.color, p.color(p.t['sand-text']), `${id}: sand text`);
      assert.equal(s.backgroundColor, p.color(p.t['sand-soft']), `${id}: sand background`);
      assert.equal(s.borderTopColor, p.color(p.t['sand-line']), `${id}: sand border`);
      for (const v of [s.color, s.backgroundColor, s.borderTopColor]) assert.ok(!AMBER(v), `${id}: never an amber / gold hue (${v})`);
    }
    const c = contrast(p.t['sand-text'], p.t['sand-soft']);
    assert.ok(c >= 4.5, `AA: sand text on sand background ${c.toFixed(2)}:1 ≥ 4.5`);
  });
}
