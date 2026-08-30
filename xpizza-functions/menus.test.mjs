'use strict';
// ── menus.test — the KEYS-GOLDEN for the menu manifest (KDS Phase 2b · Slice 2 · KDS_2B_PLAN.md §3/§11)
//
// The whole point of Slice 2: prove the form-derived manifest keys are EXACTLY the server pricing keys
// (MENU_BY_RESTAURANT[rid]) — a manifest entry the server never prices, or a server-valid item missing
// from the manifest, FAILS the build. This ties the forms ↔ menu-pricing.js: any drift is caught here.
//
// It asserts against the COMMITTED menus/*.json (what actually ships), and also cross-checks that a
// fresh extraction from the forms matches the committed files (so a stale commit is caught too).
// Run: node menus.test.mjs   (from xpizza-functions/)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RESTAURANT_IDS, extractManifest, serializeManifest } from './menu-extract.mjs';

const require = createRequire(import.meta.url);
const { MENU_BY_RESTAURANT } = require('./menu-pricing');
const { availKey } = require('./avail-key'); // canonical encoder — the RTDB-safe/unique check

const __dirname = dirname(fileURLToPath(import.meta.url));
const MENUS_DIR = join(__dirname, '..', 'menus');

// Expected item counts (snapshot) — pins the manifest size so an unintended menu change shows here.
const EXPECTED_COUNT = { x_pizza: 24, la_musa: 44 };
const RTDB_FORBIDDEN = /[.#$[\]/]/; // chars RTDB rejects in a key path segment

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

function loadCommitted(rid) {
  const raw = readFileSync(join(MENUS_DIR, `${rid}.json`), 'utf8');
  return { raw, manifest: JSON.parse(raw) };
}

for (const rid of RESTAURANT_IDS) {
  const { raw, manifest } = loadCommitted(rid);

  // 0) The committed file is exactly what the extractor produces today (no stale / hand-edited commit).
  assert.strictEqual(
    raw, serializeManifest(extractManifest(rid)),
    `${rid}: committed menus/${rid}.json is stale — re-run \`node build-menus.mjs\``,
  );
  ok(`${rid}: committed menus/${rid}.json == fresh extraction (not stale)`);

  // 1) Snapshot: count matches the pinned expectation.
  assert.strictEqual(
    manifest.length, EXPECTED_COUNT[rid],
    `${rid}: manifest has ${manifest.length} items, expected ${EXPECTED_COUNT[rid]}`,
  );
  ok(`${rid}: manifest count == ${EXPECTED_COUNT[rid]} (snapshot)`);

  // 2) THE keys-golden: manifest key-set === server pricing key-set, EXACT, both directions.
  const manifestKeys = new Set(manifest.map((m) => m.key));
  const serverKeys = new Set(Object.keys(MENU_BY_RESTAURANT[rid]));
  assert.strictEqual(manifestKeys.size, manifest.length, `${rid}: manifest has duplicate keys`);
  const missing = [...serverKeys].filter((k) => !manifestKeys.has(k)); // server key not in manifest
  const extra = [...manifestKeys].filter((k) => !serverKeys.has(k));   // manifest key server never prices
  assert.deepStrictEqual(
    { missing, extra }, { missing: [], extra: [] },
    `${rid}: manifest keys != MENU_BY_RESTAURANT keys — missing (server-only): [${missing}], extra (manifest-only): [${extra}]`,
  );
  ok(`${rid}: manifest key-set === MENU_BY_RESTAURANT[${rid}] key-set (exact, ${serverKeys.size} keys)`);

  // 3) availKey()-encoded keys are RTDB-safe (no . # $ [ ] /) AND collision-free per restaurant.
  const encoded = new Set();
  for (const { key } of manifest) {
    const ek = availKey(key);
    assert.ok(!RTDB_FORBIDDEN.test(ek), `${rid}: availKey('${key}') = '${ek}' contains an RTDB-forbidden char`);
    assert.ok(!encoded.has(ek), `${rid}: availKey collision on '${ek}'`);
    encoded.add(ek);
  }
  assert.strictEqual(encoded.size, manifest.length, `${rid}: availKey encoding collapsed distinct keys`);
  ok(`${rid}: all ${manifest.length} keys availKey()-safe + unique (RTDB path-safe)`);

  // 4) Every entry: label non-empty string, category non-empty string.
  for (const entry of manifest) {
    assert.strictEqual(typeof entry.key, 'string');
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0, `${rid}: empty label for key '${entry.key}'`);
    assert.ok(typeof entry.category === 'string' && entry.category.length > 0, `${rid}: empty category for key '${entry.key}'`);
    assert.deepStrictEqual(Object.keys(entry).sort(), ['category', 'key', 'label'], `${rid}: unexpected entry shape for '${entry.key}'`);
  }
  ok(`${rid}: every entry { key, label, category } well-formed (non-empty label + category)`);
}

console.log(`menus.test: OK (${n} cases)`);
