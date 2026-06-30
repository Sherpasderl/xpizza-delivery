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
function sliceArray(constName) {
  const start = FORM.indexOf(`const ${constName} = [`);
  assert.notStrictEqual(start, -1, `${constName} array not found in form`);
  const end = FORM.indexOf('];', start);
  assert.notStrictEqual(end, -1, `${constName} array close not found`);
  return FORM.slice(start, end);
}
// Each entry is `{ id:"slug", … price:NNN … }` with price after id — pull id→price.
function parseEntries(block) {
  const out = {};
  const re = /id:"([a-z0-9_]+)"[^}]*?price:(\d+)/g;
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

const formMenu = parseEntries(sliceArray('MENU'));
const formExtras = parseEntries(sliceArray('EXTRAS'));

assertExactParity('MENU', formMenu, MENU_BY_RESTAURANT.la_musa, 40); ok('form MENU (40) === server la_musa menu (exact id-set + prices)');
assertExactParity('EXTRAS', formExtras, EXTRAS_BY_RESTAURANT.la_musa, 14); ok('form EXTRAS (14) === server la_musa extras (exact id-set + prices)');

console.log(`menu-parity: OK (${n} cases)`);
