// Brand-helper + real-renderer tests — run: `node brand-helpers.test.js` (no framework, repo idiom).
// The chip test LIFTS the actual escapeHtml/restaurantMeta/restaurantChip source out of index.html and
// runs it, so it exercises the real renderer (not a copy). The greeting test uses the real driverGreeting
// + encodeURIComponent and asserts index.html wires them. A sensitivity-proven literal guard fails if the
// old hard-coded greeting or the old la_musa ternary is reintroduced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { brandLabel, brandMeta, driverGreeting } from './brand-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(join(here, 'index.html'), 'utf8');
const helpersSrc = fs.readFileSync(join(here, 'brand-helpers.js'), 'utf8');

let passed = 0;
function t(name, fn) { fn(); passed++; }

// ---- lift the REAL renderer functions out of index.html and instantiate them ----
function lift(re, what) { const m = indexSrc.match(re); if (!m) throw new Error('could not lift ' + what); return m[0]; }
const escSrc  = lift(/function escapeHtml\(s\) \{[\s\S]*?\n\}/, 'escapeHtml');
const metaSrc = lift(/function restaurantMeta\(order\) \{[\s\S]*?\n\}/, 'restaurantMeta');
const chipSrc = lift(/function restaurantChip\(order, size\) \{[\s\S]*?\n\}/, 'restaurantChip');
const { restaurantChip } = new Function('brandMeta',
  `${escSrc}\n${metaSrc}\n${chipSrc}\n return { escapeHtml, restaurantMeta, restaurantChip };`)(brandMeta);

const XP = { restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza' };
const LM = { restaurant_id: 'la_musa', restaurant_display_name: 'La Musa' };
const RM = { restaurant_id: 'pizza_roma', restaurant_display_name: 'Pizza Roma' };

// ---- brandLabel / brandMeta / driverGreeting (helpers) ----
t('brandLabel: trims; absent/blank -> empty', () => {
  assert.equal(brandLabel(RM), 'Pizza Roma');
  assert.equal(brandLabel({ restaurant_display_name: '  Pizza Roma  ' }), 'Pizza Roma');
  assert.equal(brandLabel({}), '');
  assert.equal(brandLabel({ restaurant_display_name: '   ' }), '');
  assert.equal(brandLabel(null), '');
});
t('brandMeta: configured brands keep their color; 3rd brand + nameless -> neutral', () => {
  assert.deepEqual(brandMeta(XP), { label: 'X. Pizza', cls: 'xp' });
  assert.deepEqual(brandMeta(LM), { label: 'La Musa', cls: 'lm' });
  assert.deepEqual(brandMeta(RM), { label: 'Pizza Roma', cls: 'neutral' });   // 3rd brand: no color -> neutral
  // nameless overrides color to neutral even for a known id (P2a):
  assert.deepEqual(brandMeta({ restaurant_id: 'x_pizza' }), { label: '', cls: 'neutral' });
  assert.deepEqual(brandMeta({ restaurant_id: 'la_musa', restaurant_display_name: ' ' }), { label: '', cls: 'neutral' });
});
t('driverGreeting: per-brand; neutral when absent/blank; never a hard-coded brand', () => {
  assert.equal(driverGreeting(XP), 'Hola, soy su repartidor de X. Pizza.');
  assert.equal(driverGreeting(LM), 'Hola, soy su repartidor de La Musa.');
  assert.equal(driverGreeting(RM), 'Hola, soy su repartidor de Pizza Roma.');
  assert.equal(driverGreeting({}), 'Hola, soy su repartidor.');
  assert.equal(driverGreeting({ restaurant_display_name: '   ' }), 'Hola, soy su repartidor.');
});

// ---- the REAL chip renderer: exact escaped output ----
t('chip: configured brands render label + brand color (exact markup)', () => {
  assert.equal(restaurantChip(XP), '<span class="rchip xp"><span class="rdot"></span>X. Pizza</span>');
  assert.equal(restaurantChip(LM, 'sm'), '<span class="rchip lm sm"><span class="rdot"></span>La Musa</span>');
  assert.equal(restaurantChip(RM), '<span class="rchip neutral"><span class="rdot"></span>Pizza Roma</span>');
});
t('chip: nameless brand -> NO chip at all (empty string), for both known ids + 3rd', () => {
  assert.equal(restaurantChip({ restaurant_id: 'x_pizza' }), '');
  assert.equal(restaurantChip({ restaurant_id: 'la_musa', restaurant_display_name: '' }), '');
  assert.equal(restaurantChip({ restaurant_id: 'pizza_roma', restaurant_display_name: '   ' }), '');
  assert.equal(restaurantChip(null), '');
});
t('chip: dynamic label is HTML-escaped (exact expected strings, not just "no raw <&")', () => {
  assert.equal(restaurantChip({ restaurant_id: 'x_pizza', restaurant_display_name: '<img src=x onerror=alert(1)>' }),
    '<span class="rchip xp"><span class="rdot"></span>&lt;img src=x onerror=alert(1)&gt;</span>');
  assert.equal(restaurantChip({ restaurant_id: 'x_pizza', restaurant_display_name: 'A & B' }),
    '<span class="rchip xp"><span class="rdot"></span>A &amp; B</span>');
  assert.equal(restaurantChip({ restaurant_id: 'x_pizza', restaurant_display_name: '"Q" \'z\'' }),
    '<span class="rchip xp"><span class="rdot"></span>&quot;Q&quot; &#039;z&#039;</span>');
});

// ---- greeting as it is actually sent: encodeURIComponent, NOT HTML-escaped ----
t('greeting: index.html wires encodeURIComponent(driverGreeting(order)) at BOTH sites', () => {
  const n = (indexSrc.match(/\?text=\$\{encodeURIComponent\(driverGreeting\(order\)\)\}/g) || []).length;
  assert.equal(n, 2);
});
t('greeting: URL-encoded param is single-param-safe and round-trips (accents/&/quotes/+/%/#/emoji/blank)', () => {
  const names = ['Café & Más', '"Q"', 'A+B', '50% Off', '#1 Pizza', '🍕 Pizza', 'Niño', '   '];
  for (const restaurant_display_name of names) {
    const order = { restaurant_id: 'pizza_roma', restaurant_display_name };
    const g = driverGreeting(order);
    const enc = encodeURIComponent(g);                 // exactly what index.html puts in ?text=
    assert.ok(!/[ &]/.test(enc), `raw space/& would break the wa.me param for "${restaurant_display_name}": ${enc}`);
    assert.equal(decodeURIComponent(enc), g);          // nothing lost; the greeting is NOT HTML-escaped
  }
  // the greeting is not pre-escaped: an & in the name stays '&' in the greeting string itself
  assert.equal(driverGreeting({ restaurant_display_name: 'A & B' }), 'Hola, soy su repartidor de A & B.');
});

// ---- literal guard, sensitivity-proven ----
t('literal-guard: no brand-name literal in the greeting/chip code; guard HAS teeth', () => {
  const BRAND = /X\.? ?Pizza|La Musa/;   // case-sensitive: matches display literals, not the snake_case ids
  const greetingLines = indexSrc.split('\n').filter((l) => l.includes('driverGreeting(order)'));
  const regions = { helpers: helpersSrc, renderer: metaSrc + '\n' + chipSrc, greetings: greetingLines.join('\n') };
  assert.equal(greetingLines.length, 2, 'expected exactly the two greeting link lines');
  for (const [k, region] of Object.entries(regions)) {
    assert.ok(region.length > 0, `region ${k} must be non-empty (extraction sanity)`);
    assert.ok(!BRAND.test(region), `brand literal leaked into ${k}: ${region}`);
  }
  // sensitivity: the guard MUST fire if the old greeting or the old la_musa ternary comes back.
  assert.ok(BRAND.test(`encodeURIComponent('Hola, soy del repartidor de X. Pizza.')`), 'guard cannot catch the old greeting');
  assert.ok(BRAND.test(`order.restaurant_id === 'la_musa' ? { label: 'La Musa' } : { label: 'X. Pizza' }`), 'guard cannot catch the old ternary');
});

console.log(`✓ brand-helpers: ${passed} tests passed`);
