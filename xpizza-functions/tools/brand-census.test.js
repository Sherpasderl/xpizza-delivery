'use strict';
/* Self-test of tools/brand-census.js (Phase A, report only — this proves the DETECTORS, it enforces nothing on the
 * tree). Positive AND negative controls per detector, on fixtures, against a FIXTURE vocabulary that includes a
 * brand the seed has never heard of ('brand_c'), so nothing here passes because the tool knows only two brands.
 * Run: node tools/brand-census.test.js
 */
const assert = require('assert');
const BC = require('./brand-census');

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 BRAND-CENSUS ${m}`;

const VOCAB = {
  version: 0, built_at_commit: 'fixture', sources: ['fixture'],
  brands: [
    { id: 'x_pizza', names: ['X. Pizza', 'X Pizza'], phones: ['+50497952893'], coords: [{ lat: 15.507489753573818, lng: -88.0398486953722 }], colours: ['#b8860b'], hosts: ['xpizzaorders.netlify.app'] },
    { id: 'brand_c', names: ['Casa Cero'], phones: ['+50411112222'], coords: [{ lat: 14.1, lng: -87.2 }], colours: ['#123456'], hosts: ['casacero.example'] },
  ],
  infra: ['xpizza-delivery', 'demo-xpizza'],
  market: [],
};
const match = BC.matcher(VOCAB);

// scan() reads from disk; drive its collector + matcher pieces the way scan does, through a tiny in-memory shim
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-census-'));
fs.mkdirSync(path.join(tmp, 'platform'));
fs.writeFileSync(path.join(tmp, 'platform', 'sites.json'), JSON.stringify({ deployments: [{ id: 'app', folder: 'app', entrypoints: ['index.html'] }] }));
function scanFixture(files) {
  for (const [f, src] of Object.entries(files)) { fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), src); }
  return BC.scan({ root: tmp, vocab: VOCAB, files: Object.keys(files) });
}
const has = (res, pred) => res.rows.some(pred);

try {
  // 1. folding: concatenation, constant template, same-file const alias — and a shadowed alias is UNRESOLVED, not guessed
  {
    const r = scanFixture({ 'app/a.js': "const A = 'x_' + 'pizza';\nconst B = `brand${'_c'}`;\nif (rid === A) go();\nconst S = 'x_pizza';\nfunction f(){ const S = 'other'; return S; }\nuse(S);\n" });
    assert.ok(has(r, (x) => x.kind === 'rid' && x.brand === 'x_pizza' && x.line === 1), FAIL('concatenation not folded'));
    assert.ok(has(r, (x) => x.kind === 'rid' && x.brand === 'brand_c' && x.line === 2), FAIL('constant template not folded (or brand_c not detected)'));
    assert.ok(has(r, (x) => x.kind === 'rid' && x.line === 3 && x.class === 'BEHAVIOUR'), FAIL('a const alias compared to rid must be BEHAVIOUR'));
    assert.ok(r.unresolved.some((u) => u.name === 'S'), FAIL('a shadowed alias with a brand value must be UNRESOLVED'));
  }
  ok('folding: "x_" + "pizza", a constant template, a const alias in a compare (BEHAVIOUR); a shadowed alias → unresolved');

  // 2. object keys + member access + computed constant key; a non-brand key is not a hit
  {
    const r = scanFixture({ 'app/b.js': "const T = { x_pizza: 1, brand_c: 2, other: 3 };\nT.x_pizza;\nT['brand' + '_c'];\nT.other;\n" });
    assert.ok(has(r, (x) => x.kind === 'rid' && x.ctx === 'object-key' && x.brand === 'x_pizza'), FAIL('static object key missed'));
    assert.ok(has(r, (x) => x.kind === 'rid' && x.ctx === 'member-access' && x.brand === 'x_pizza' && x.line === 2), FAIL('member access missed'));
    assert.ok(has(r, (x) => x.kind === 'rid' && x.brand === 'brand_c' && x.line === 3), FAIL('computed constant key missed'));
    assert.ok(!has(r, (x) => x.line === 4), FAIL('a non-brand member must not be a hit'));
  }
  ok('object keys, member access (T.x_pizza) and computed constant keys are hits; a non-brand key is not');

  // 3. URL / path / query context; infra names are INFRA, not brand coupling
  {
    const r = scanFixture({ 'app/c.js': "fetch('/menu?restaurant_id=x_pizza');\nref(db, 'menus/brand_c');\nconst u = 'https://us-central1-xpizza-delivery.cloud" + "functions.net/x';\nconst p = 'xpizza_party';\n" });
    assert.ok(has(r, (x) => x.line === 1 && x.match === 'url' && x.class === 'BEHAVIOUR'), FAIL('?restaurant_id=x_pizza not a url BEHAVIOUR hit'));
    assert.ok(has(r, (x) => x.line === 2 && x.brand === 'brand_c'), FAIL('db path with brand_c missed'));
    assert.ok(has(r, (x) => x.line === 3 && x.class === 'INFRA') && !has(r, (x) => x.line === 3 && x.kind === 'rid'), FAIL('a brand-named infra host must be INFRA only'));
    assert.ok(!has(r, (x) => x.line === 4 && x.kind === 'rid'), FAIL('xpizza_party is not the rid x_pizza'));
  }
  ok('URL / query / db-path contexts are BEHAVIOUR; a brand-named infra host is INFRA only; an unrelated near-miss is not a rid');

  // 4. coordinates: signed, re-spelled within tolerance, PAIR vs lone; a far value is nothing
  {
    const r = scanFixture({ 'app/d.js': "const HUB = { lat: 15.5074897, lng: -88.03984869 };\nplace(14.1, -87.2);\nconst lone = 15.50749;\nconst far = { lat: 15.6, lng: -88.1 };\n" });
    assert.ok(has(r, (x) => x.kind === 'coord' && x.match === 'coord-pair' && x.brand === 'x_pizza' && x.line === 1), FAIL('re-spelled signed coordinate pair missed'));
    assert.ok(has(r, (x) => x.kind === 'coord' && x.match === 'coord-pair' && x.brand === 'brand_c' && x.line === 2), FAIL('call-argument pair (brand_c) missed'));
    assert.ok(has(r, (x) => x.kind === 'coord' && x.match === 'coord-lone' && x.line === 3 && x.strength === 'weak'), FAIL('a lone coordinate must be weak'));
    assert.ok(!has(r, (x) => x.line === 4), FAIL('a far coordinate must not match'));
    assert.ok(has(r, (x) => x.kind === 'structural-decl' && x.token === 'HUB' && x.class === 'STRUCTURAL'), FAIL('a const holding ONE brand pair is a STRUCTURAL selection'));
  }
  ok('coordinates: signed + re-spelled within tolerance, object and call-argument pairs (incl. brand_c), lone = weak, far = nothing; one-brand pair const = STRUCTURAL');

  // 5. structural: a fixed fallback / default is STRUCTURAL; a location read from data is NOT; a two-brand table is data, not a selection
  {
    const r = scanFixture({ 'app/e.js': "const rid = cfg.rid || 'x_pizza';\nfunction g(r = 'brand_c') { return r; }\nconst hub = identity.hub;\nconst TABLE = { x_pizza: { lat: 15.5074897, lng: -88.0398487 }, brand_c: { lat: 14.1, lng: -87.2 } };\n" });
    assert.ok(has(r, (x) => x.line === 1 && x.class === 'STRUCTURAL'), FAIL("`|| 'x_pizza'` must be STRUCTURAL"));
    assert.ok(has(r, (x) => x.line === 2 && x.class === 'STRUCTURAL'), FAIL('a brand default param must be STRUCTURAL'));
    assert.ok(!has(r, (x) => x.line === 3), FAIL('a location read from data is not a hit'));
    assert.ok(!has(r, (x) => x.kind === 'structural-decl' && x.token === 'TABLE'), FAIL('a per-brand table is data, not a selection'));
  }
  ok('structural: `|| brand` and a brand default param are STRUCTURAL; identity.hub is nothing; a two-brand table is not a selection');

  // 6. weak evidence: name alias, phone, colour; comments are never tokens
  {
    const r = scanFixture({ 'app/f.js': "el.textContent = 'Bienvenido a X Pizza';\nconst t = '9795-2893';\nconst c = 'rgb(184,134,11)';\n// x_pizza la casa cero 9795-2893\n/* brand_c */\n" });
    assert.ok(has(r, (x) => x.kind === 'name' && x.strength === 'weak' && x.class === 'DISPLAY'), FAIL('brand name in copy must be weak DISPLAY'));
    assert.ok(has(r, (x) => x.kind === 'phone' && x.strength === 'weak'), FAIL('local-format phone must match (weak)'));
    assert.ok(has(r, (x) => x.kind === 'colour' && x.strength === 'weak'), FAIL('rgb() brand colour must match (weak)'));
    assert.ok(!has(r, (x) => x.line >= 4), FAIL('a comment must never produce a row'));
  }
  ok('weak evidence: name alias (DISPLAY), phone (normalised), colour (rgb→hex) are weak; comments never produce a row');

  // 7. HTML (text, attribute, inline handler, <style>, <script>), CSS file, JSON manifest; a parse error is LISTED
  {
    const r = scanFixture({
      'app/index.html': "<html><head><style>.rest-x_pizza{color:#B8860B}</style></head><body title=\"X. Pizza\" onclick=\"pick('brand_c')\">Pide en Casa Cero<script>if(rid==='x_pizza'){}</script></body></html>",
      'app/s.css': ".chip-brand_c { background: #123456 } /* x_pizza */",
      'app/manifest.json': JSON.stringify({ name: 'X. Pizza Orders', theme_color: '#b8860b', start_url: '/?restaurant_id=brand_c' }),
      'app/broken.js': 'const = ;',
    });
    const h = (pred, msg) => assert.ok(has(r, pred), FAIL(msg));
    h((x) => x.file === 'app/index.html' && x.ctx === 'html-text' && x.brand === 'brand_c', 'html text missed');
    h((x) => x.file === 'app/index.html' && x.ctx === 'html-attr:title' && x.brand === 'x_pizza', 'html attribute missed');
    h((x) => x.file === 'app/index.html' && x.scope.startsWith('<attr:onclick>') && x.brand === 'brand_c', 'inline handler body missed');
    h((x) => x.file === 'app/index.html' && x.ctx === 'css-ident' && x.brand === 'x_pizza', '<style> selector missed');
    h((x) => x.file === 'app/index.html' && x.scope.startsWith('<script@0>') && x.class === 'BEHAVIOUR', '<script> compare missed');
    h((x) => x.file === 'app/s.css' && x.brand === 'brand_c', 'css file missed');
    assert.ok(!has(r, (x) => x.file === 'app/s.css' && x.brand === 'x_pizza'), FAIL('a CSS comment produced a row'));
    h((x) => x.file === 'app/manifest.json' && x.match === 'url' && x.brand === 'brand_c', 'json manifest url missed');
    assert.ok(r.errors.some((e) => e.file === 'app/broken.js'), FAIL('a parse error must be LISTED'));
    assert.ok(!r.scanned.some((s) => s.file === 'app/broken.js'), FAIL('an unparsable file must not count as scanned'));
  }
  ok('HTML text / attribute / inline handler / <style> / <script>, a CSS file (comment ignored), a JSON manifest; a parse error is LISTED, not scanned');

  // 8. coverage: unsupported files are LISTED; excluded files carry their rule; sentinel + authority classes
  {
    const r = scanFixture({ 'app/logo.svg': '<svg/>', 'app/x.test.js': "'x_pizza'", 'app/geo.js': 'const GEO_DEFAULT = { lat: 15.5003, lng: -88.025 };\n' });
    assert.ok(r.unsupported.includes('app/logo.svg'), FAIL('an unsupported file must be LISTED'));
    assert.ok((r.excluded.test || []).includes('app/x.test.js'), FAIL('a test file must be listed under its exclusion rule'));
    assert.ok(has(r, (x) => x.file === 'app/geo.js' && x.class === 'SENTINEL'), FAIL('GEO_DEFAULT must be a SENTINEL (owner ruling), not brand debt'));
  }
  ok('coverage: unsupported files LISTED, excluded files carry their rule; GEO_DEFAULT is SENTINEL (owner ruling)');

  // 9. matcher normalisers
  assert.strictEqual(BC.normColour('#B8860B'), '#b8860b');
  assert.strictEqual(BC.normColour('#abc'), '#aabbcc');
  assert.strictEqual(BC.normColour('rgba(18, 52, 86, .5)'), '#123456');
  assert.strictEqual(BC.norm('X. Pizza'), BC.norm('xpizza'));
  assert.deepStrictEqual(match({ kind: 'string', value: 'brand_c', ctx: 'compare' }).map((h) => [h.brand, h.match]), [['brand_c', 'exact']]);
  ok('normalisers: colours (hex3 / hex8 / rgba), names, and an exact unseeded-brand id');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`brand-census.test: OK (${n} groups)`);
