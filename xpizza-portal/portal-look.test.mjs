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
  const used = [...css.matchAll(/font-weight\s*:\s*(\d{3})/g)].map((m) => Number(m[1]));
  const disp = used.filter((w) => w >= 600);
  assert.ok(disp.every((w) => w >= 600 && w <= 800), `every heavy weight in use is inside the loaded 600..800 range (${[...new Set(disp)].join(', ')})`);
});

test('the CSP already admits the two Google font hosts (unchanged)', () => {
  const csp = (toml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/) || [])[1] || '';
  assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/, 'style-src allows fonts.googleapis.com');
  assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/, 'font-src allows fonts.gstatic.com');
});
