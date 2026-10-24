'use strict';
// Order colonia (PLAN-colonia-address-area r1 §3) — the server policy addressAreaFrom, case by case. Kept = a short label with
// no digit, no `#<>` and no street/house token; everything else → '' (omitted by the writers).
const assert = require('assert');
const { addressAreaFrom, STREET_TOKENS, MAX_LEN } = require('./address-area');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const KEPT = [
  ['Colonia Trejo', 'Colonia Trejo'],
  ['Res. Los Castaños', 'Res. Los Castaños'],
  ['  Barrio  Río\tPiedras ', 'Barrio Río Piedras'],
  ['Col. Jardines del Valle', 'Col. Jardines del Valle'],        // NFKC: a no-break space → a space
  ['Casamata', 'Casamata'],                                            // whole words: `casa` is not a substring match
  ['Lotería', 'Lotería'],
  ['Kmart', 'Kmart'],
  ['x'.repeat(MAX_LEN), 'x'.repeat(MAX_LEN)],                          // exactly the cap
  [' ' + 'y'.repeat(MAX_LEN) + '   ', 'y'.repeat(MAX_LEN)],            // collapse + trim BEFORE the length check
];
for (const [v, want] of KEPT) assert.strictEqual(addressAreaFrom(v), want, `kept: ${JSON.stringify(v)}`);
ok(`kept (${KEPT.length}): plain colonia / residencial / barrio labels, whitespace collapsed + trimmed, accents and case as given, exactly ${MAX_LEN} chars; whole-word matching keeps Casamata / Lotería / Kmart`);

const OMITTED = [
  'x'.repeat(MAX_LEN + 1),                                             // over the cap → DROP (never truncated)
  'Col. 21 de Octubre', 'Col. Trejo 12', 'Col. １２',                  // any digit (NFKC folds the full-width ones)
  'Casa 14 Calle 3', 'CALLE Real', 'Cálle Real', 'Avenida Circunvalación', 'Ave Juan Pablo', 'Av. Junior', 'Km cinco',
  'Bulevar del Norte', 'Boulevard Morazán', 'Blvd. Suyapa', 'Pasaje Los Pinos', 'Sendero X', 'Bloque B', 'Lote Las Flores',
  'Apto Centro', 'Carretera a Tela', 'frente a la casa verde',
  '#Trejo', '<b>Trejo</b>', 'Trejo>', 'Colonia Trejo, casa',
  '', '   ', '\u0000\u0007',
];
for (const v of OMITTED) assert.strictEqual(addressAreaFrom(v), '', `omitted: ${JSON.stringify(v)}`);
ok(`omitted (${OMITTED.length}): over ${MAX_LEN}, any digit (incl. full-width), every street/house token (case + accent-folded), # < >, empty / blank / control-only`);

for (const t of STREET_TOKENS) {
  assert.strictEqual(addressAreaFrom(`Zona ${t}`), '', `token ${t} (lower)`);
  assert.strictEqual(addressAreaFrom(`Zona ${t.toUpperCase()}`), '', `token ${t} (upper)`);
}
assert.deepStrictEqual([...STREET_TOKENS].sort(), ['apto', 'av', 'ave', 'avenida', 'bloque', 'blvd', 'boulevard', 'bulevar', 'calle', 'carretera', 'casa', 'km', 'lote', 'pasaje', 'sendero']);
ok(`every listed token (${STREET_TOKENS.length}, the advisor's list + av / blvd) is refused in either case`);

for (const v of [123, 0, {}, { toString: () => 'Colonia Trejo' }, ['Colonia Trejo'], null, undefined, true, NaN]) {
  assert.strictEqual(addressAreaFrom(v), '', `non-string omitted: ${String(v && v.constructor && v.constructor.name)}`);
}
ok('non-strings (number / object incl. a toString trap / array / null / undefined / boolean / NaN) are omitted, never stringified');

console.log(`\naddress-area: OK (${n})`);
