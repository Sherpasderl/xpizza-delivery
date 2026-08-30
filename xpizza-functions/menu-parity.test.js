'use strict';

// Form-vs-server PARITY (B1) — the real guard, replacing A1's self-referential snapshot. Parses the
// in-tree La Musa order form (la-musa-orders/index.html) and asserts EXACT id-set equality in BOTH
// directions (form ids === server ids), with equal prices, for MENU (40) and EXTRAS (14). Subset-only
// would leave server-only stale ids as accepted tamper surface (the server prices any known id), so
// this asserts equality. Run: node menu-parity.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');

const FORM = readFileSync(join(__dirname, '..', 'la-musa-orders', 'index.html'), 'utf8');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Slice a top-level `const <NAME> = [ … ];` array literal out of the form source. The array's close
// is the first `];` after the declaration (item `tags:[]` arrays never produce `];`).
function sliceArray(src, constName) {
  const start = src.indexOf(`const ${constName} = [`);
  assert.notStrictEqual(start, -1, `${constName} array not found in form`);
  const end = src.indexOf('];', start);
  assert.notStrictEqual(end, -1, `${constName} array close not found`);
  return src.slice(start, end);
}
// La Musa entry = `{ id:"slug", … price:NNN … }` with price after id — pull id→price.
function parseEntries(block) {
  const out = {};
  const re = /id:"([a-z0-9_]+)"[^}]*?price:(\d+)/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = Number(m[2]);
  return out;
}
// X. Pizza entry = `{ id:N, cat:'…', name:'…', price:NNN, … }` — NAME-keyed (the server prices by exact
// item.name; the numeric form id is ignored). name is a single-quoted string (no apostrophes) BEFORE price.
function parseNameEntries(block) {
  const out = {};
  const re = /name:'([^']+)'[^}]*?price:(\d+)/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = Number(m[2]);
  return out;
}

function assertExactParity(label, form, server, expectedCount) {
  assert.equal(Object.keys(form).length, expectedCount, `${label}: parsed ${Object.keys(form).length} form entries, expected ${expectedCount}`);
  assert.deepStrictEqual(
    Object.keys(form).sort(), Object.keys(server).sort(),
    `${label}: id-set mismatch — form-only: [${Object.keys(form).filter((k) => !(k in server))}], server-only: [${Object.keys(server).filter((k) => !(k in form))}]`,
  );
  for (const id of Object.keys(form)) {
    assert.equal(form[id], server[id], `${label}: price mismatch for ${id} (form ${form[id]} vs server ${server[id]})`);
  }
}

const formMenu = parseEntries(sliceArray(FORM, 'MENU'));
const formExtras = parseEntries(sliceArray(FORM, 'EXTRAS'));

assertExactParity('MENU', formMenu, MENU_BY_RESTAURANT.la_musa, 44); ok('form MENU (44) === server la_musa menu (exact id-set + prices)');
assertExactParity('EXTRAS', formExtras, EXTRAS_BY_RESTAURANT.la_musa, 14); ok('form EXTRAS (14) === server la_musa extras (exact id-set + prices)');

// ── X. Pizza 3-source parity (NAME-keyed) — closes the "no automated form↔price guard" gap that the NY
// split had to hand-verify. Drift across the 3 hand-synced sources now FAILS CI instead of mis-pricing live. ──
const FORM_X = readFileSync(join(__dirname, '..', 'xpizza-orders', 'index.html'), 'utf8');
const X_JSON = JSON.parse(readFileSync(join(__dirname, '..', 'menus', 'x_pizza.json'), 'utf8'));

// 1. MENU (money-critical): form name→price === X_PIZZA_MENU, exact name-set both ways + price equality.
assertExactParity('x_pizza MENU', parseNameEntries(sliceArray(FORM_X, 'MENU')), MENU_BY_RESTAURANT.x_pizza, 24);
ok('form MENU (24) === server x_pizza menu (exact name-set + prices)');
// 2. EXTRAS: form name→price === x_pizza extras.
assertExactParity('x_pizza EXTRAS', parseNameEntries(sliceArray(FORM_X, 'EXTRAS')), EXTRAS_BY_RESTAURANT.x_pizza, 14);
ok('form EXTRAS (14) === server x_pizza extras (exact name-set + prices)');
// 3. KDS manifest (3rd source): menus/x_pizza.json key-set === X_PIZZA_MENU key-set (name-only; json has no prices).
const jsonKeys = X_JSON.map((e) => e.key).sort();
const serverMenuKeys = Object.keys(MENU_BY_RESTAURANT.x_pizza).sort();
assert.equal(jsonKeys.length, 24, `x_pizza.json: parsed ${jsonKeys.length} keys, expected 24 (broken parse or drift)`);
assert.deepStrictEqual(jsonKeys, serverMenuKeys,
  `x_pizza.json manifest key-set mismatch — json-only: [${jsonKeys.filter((k) => !serverMenuKeys.includes(k))}], server-only: [${serverMenuKeys.filter((k) => !jsonKeys.includes(k))}]`);
ok('menus/x_pizza.json KDS manifest (24) === X_PIZZA_MENU key-set (name-only)');

console.log(`menu-parity: OK (${n} cases)`);
