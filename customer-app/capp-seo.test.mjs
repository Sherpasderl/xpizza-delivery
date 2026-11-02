// C-6a (PLAN-capp-website-and-leader-features §C-6; MOCKUP-capp-desktop-D3 r3, approved): the website's presentation basics — NOT
// indexed until Phase S (the in-page meta AND the site header), «Thing — what it is · Sherpa» titles per screen, the desktop footer,
// the 600–1023 px centred column. Source-level and pure (the 700 / 900 px renders are the Chrome batch's).
// Run: node --test customer-app/capp-seo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SHELL = readFileSync(join(HERE, 'shell.html'), 'utf8'), NETLIFY = readFileSync(join(HERE, 'netlify.toml'), 'utf8'), CSS = readFileSync(join(HERE, 'capp.css'), 'utf8');

// every robots directive the page or the site could emit: <meta name="robots|googlebot|…"> and X-Robots-Tag headers
const metaRobots = (html) => [...html.matchAll(/<meta\s+[^>]*name="(robots|googlebot|bingbot)"[^>]*>/gi)].map((m) => (m[0].match(/content="([^"]*)"/i) || [])[1] || '');
const headerRobots = (toml) => [...toml.matchAll(/X-Robots-Tag\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
const indexable = (v) => !/\bnoindex\b/i.test(v) || /\bindex\b(?!\w)/i.test(v.replace(/\bnoindex\b/gi, ''));
function noindexProblems(html, toml) {
  const out = [], metas = metaRobots(html), heads = headerRobots(toml);
  if (metas.length !== 1) out.push(`${metas.length} robots metas (expected exactly ONE)`);
  for (const m of metas) if (indexable(m)) out.push(`an indexable robots meta: «${m}»`);
  if (!/\[\[headers\]\]\s*for\s*=\s*"\/\*"\s*\[headers\.values\]\s*X-Robots-Tag\s*=\s*"noindex"/.test(toml)) out.push('no X-Robots-Tag noindex on every path');
  for (const h of heads) if (indexable(h)) out.push(`an indexable X-Robots-Tag: «${h}»`);
  return out;
}
test('C-6a: the site is NOT indexed until Phase S — exactly one robots meta (noindex) in the shell AND an X-Robots-Tag noindex on every path; the packaged entry IS the shell', () => {
  assert.deepEqual(noindexProblems(SHELL, NETLIFY), [], '🔴 SEO-noindex');
  assert.ok(/shell\.html/.test(readFileSync(join(HERE, '..', 'platform', 'native', 'package-capp.js'), 'utf8')), 'premise: the packager publishes shell.html as the entry (its meta ships)');
});
test('C-6a controls: an INDEXABLE tag before Phase S is caught (the plan\'s mutant) — index,follow; a second robots meta; a header turned to «all»; the meta removed', () => {
  const swap = (from, to) => SHELL.replace(from, to);
  for (const [label, html, toml] of [
    ['index,follow', swap('content="noindex"', 'content="index,follow"'), NETLIFY],
    ['a second, indexable meta', swap('<meta name="robots" content="noindex">', '<meta name="robots" content="noindex">\n<meta name="googlebot" content="index">'), NETLIFY],
    ['the header turned to all', SHELL, NETLIFY.replace('X-Robots-Tag = "noindex"', 'X-Robots-Tag = "all"')],
    ['the meta removed', swap('<meta name="robots" content="noindex">\n', ''), NETLIFY],
  ]) { assert.notEqual(html + toml, SHELL + NETLIFY, `premise: ${label} changes something`); assert.ok(noindexProblems(html, toml).length > 0, `🔴 SEO control: «${label}» must be caught`); }
});
test('C-6a: the tab title of each screen — «Thing — what it is · Sherpa» (D-3 r3 §0), the city from the DATA, never a restaurant\'s tagline', () => {
  const H = require('./capp-home.js'), P = { city_label: 'San Pedro Sula' };
  const T = [
    [{ screen: 'home', platform: P }, 'Sherpa — Pedí a domicilio en San Pedro Sula'],
    [{ screen: 'home', platform: {} }, 'Sherpa — Pedí a domicilio'],
    [{ screen: 'search', q: 'pizza' }, '«pizza» — Buscar · Sherpa'], [{ screen: 'search', q: '' }, 'Buscar · Sherpa'],
    [{ screen: 'store', step: 'store', store: 'Tienda A' }, 'Tienda A — menú y pedidos a domicilio · Sherpa'],
    [{ screen: 'store', step: 'plato', store: 'Tienda A', dish: 'Plato B' }, 'Plato B · Tienda A · Sherpa'],
    [{ screen: 'store', step: 'pedido', store: 'Tienda A' }, 'Tu pedido · Tienda A · Sherpa'],
    [{ screen: 'store', step: 'pago', store: 'Tienda A' }, 'Entrega & Pago · Sherpa'],
    [{ screen: 'order', status: 'out' }, 'Tu pedido va en camino · Sherpa'], [{ screen: 'order', status: 'delivered' }, 'Entregado · Sherpa'], [{ screen: 'order', status: 'new' }, 'Tu pedido · Sherpa'],
    [{ screen: 'orders' }, 'Pedidos · Sherpa'], [{ screen: 'account' }, 'Cuenta · Sherpa'],
  ];
  for (const [t, want] of T) assert.equal(H.titleOf(t), want, `🔴 SEO-title ${JSON.stringify(t)}`);
});
test('C-6a: the footer (desktop only, DECIDED «Ayuda · Términos · Privacidad only») and the 600–1023 px column (frame 7b, CSS only — no .desk, nothing below 600)', () => {
  const H = require('./capp-home.js');
  const L = { terms: 'https://legal.test/t', privacy: 'https://legal.test/p' };
  const full = H.footHtml({ desk: true, helpOk: true, legal: L }), bare = H.footHtml({ desk: true, helpOk: true }), bad = H.footHtml({ desk: true, helpOk: true, legal: { terms: 'javascript:x', privacy: 'http://x' } });
  const labels = (h) => [...h.matchAll(/<li>(?:<button[^>]*>|<a [^>]*>)([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(labels(full), ['Ayuda', 'Términos', 'Privacidad'], '🔴 SEO-foot: exactly the three decided links');
  assert.deepEqual(labels(bare), ['Ayuda'], '🔴 SEO-foot: no legal URL ⇒ no dead Términos / Privacidad');
  assert.deepEqual(labels(bad), ['Ayuda'], 'only https legal URLs');
  assert.deepEqual(labels(H.footHtml({ desk: true, legal: L })), ['Términos', 'Privacidad'], '🔴 SEO-foot: no support chat configured ⇒ no Ayuda (never a dead control — Codex C-6a r1 #1)');
  assert.ok(/href="https:\/\/legal\.test\/t" target="_blank" rel="noopener"/.test(full) && /data-act="site-help"/.test(full), 'the links and the support action');
  const pend = H.footHtml({ desk: true, helpOk: true, legalPending: true });
  assert.deepEqual([...pend.matchAll(/<li class="rsv" aria-hidden="true">([^<]+)/g)].map((m) => m[1]), ['Términos', 'Privacidad'], '🔴 SEO-foot: while the legal URLs may still arrive, their slots are RESERVED (no shift when they land — r1 #2)');
  assert.ok(/\.app\.desk \.dfoot li\.rsv\{visibility:hidden\}/.test(CSS), 'the reserved slots are invisible (and aria-hidden)');
  assert.ok(!/Registrá tu restaurante|Repartí con Sherpa/.test(full), 'the two recruiting links wait for their pages (DECIDED)');
  assert.equal(H.footHtml({ helpOk: true, legal: L }), '', '🔴 SEO-foot: the phone renders NO footer (its DOM unchanged)');
  assert.ok(/(^|\n)\.dfoot\{display:none\}/.test(CSS) && /\.app\.desk \.dfoot\{[^}]*display:flex/.test(CSS), '🔴 SEO-foot: hidden on the phone, shown on the desk');
  const m = CSS.match(/@media \(min-width:600px\) and \(max-width:1023\.98px\)\{([\s\S]*?)\n\}/);
  assert.ok(m, '🔴 SEO-col: the 600–1023 px rule');
  const lines = m[1].trim().split('\n').map((x) => x.trim());
  assert.deepEqual(lines.slice(0, 2), ['.app:not(.desk){background:var(--surf)}', '.app:not(.desk) .screen{left:50%;right:auto;width:600px;transform:translateX(-50%);background:var(--bg);box-shadow:0 0 0 1px var(--line)}'], '🔴 SEO-col: exactly the mockup\'s rule, on the phone shell only');
  assert.ok(/^\.app:not\(\.desk\) \.sheet,\.app:not\(\.desk\) \.detail-modal\{left:calc\(50% - 300px\);right:auto;width:600px\}/.test(lines[2] || ''), '🔴 SEO-col: the sheets JOIN the 600 px column (advisor ruling; Codex C-6a r1 #6)');
  assert.equal((CSS.match(/max-width:1023\.98px/g) || []).length, 1, 'one rule in that range (nothing else changes there)');
});
