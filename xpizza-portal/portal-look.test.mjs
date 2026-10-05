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

for (const [sel, label] of [['.pdelta.dn', 'the price-decrease %'], ['.err', 'the login error']]) {
  test(`AA: ${label} (${sel}) text clears 4.5:1 on its soft background in the light theme`, () => {
    const body = ruleBody(sel);
    const fg = token(varOf(body, 'color'));
    const bg = token(varOf(body, 'background'));
    const r = contrast(fg, bg);
    assert.ok(r >= 4.5, `${sel}: ${fg} on ${bg} = ${r.toFixed(2)}:1 (needs ≥ 4.5)`);
  });
}
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
