'use strict';
// PLAN 4 (bake from published) r3 §3 / §6 — the BAKE, through the real pieces:
//   bodies: a REAL catalog published by publishVersion and served by buildPublicMenu (+ published-only changes on top)
//   transport: the live check's REAL getJson against a LOOPBACK server (the fresh-read URL and header are asserted)
//   splice: the real fail-closed spliceFormFile into a TEMP copy of each form (its own form-group-picker.js beside it)
// Every named refusal leaves the form byte-unchanged; the CLI exits non-zero without --this-form or outside a form folder;
// a bake that changes the menu changes the stamp's build hash; and the live check passes on what the bake wrote.
// Run: node tools/bake-form-bundle.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { validateEnvelope, projectMenu, bakeForm, KNOWN_REPRESENTATIONS } = require('./bake-form-bundle');
const { getJson, compareBundle } = require('./form-bundle-live-check');
const { extractBundle } = require('../catalog/splice-form-bundle');
const { FORMS } = require('./splice-form-bundle');
const { makeDb } = require('../catalog/firestore-fake');
const { publishVersion } = require('../catalog/catalog-publish');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { buildPublicMenu } = require('../catalog/public-menu');
const { buildSourceFromCode } = require('./seed-source-store');
const { computeBuild } = require('../../platform/stamp-version');
const DATA = require('./migrations/2026-10-26-menu-structure.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('bake-form-bundle: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));

// A REAL published body: the seed source + the reviewed migration rows (so badge_priority / reward_icon / extras_policy are
// present as they will be live), published, then served.
async function servedEnvelope(rid) {
  const source = clone(buildSourceFromCode(rid));
  const rows = DATA.restaurants[rid];
  if (rows.structure) Object.assign(source.structure, clone(rows.structure));
  for (const [coll, list] of [['items', source.items], ['extras', source.extras]]) {
    for (const [key, row] of Object.entries(rows[coll] || {})) Object.assign(list.find((x) => x.key === key).display, clone(row.display));
  }
  const db = makeDb();
  const { inputs, built } = buildSourceCandidate(rid, source);
  await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'bake' }, { expected: { activeVersionId: null } });
  const served = await buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true });
  // the identity overlay as production lays it (the fake registry may lay none): ids on every record
  const menu = clone(served.body);
  menu.dishes.forEach((d, i) => { d.dish_id = `d${i}`; d.identity_id = `i${i}`; });
  menu.extras.forEach((e, i) => { e.extra_id = `x${i}`; });
  return { rid: served.rid, representation_version: served.representation_version, menu };
}

// A temp copy of a form folder (index.html + its own form-group-picker.js).
const TEMP = [];
function tempForm(rid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bake-${rid}-`)); TEMP.push(dir);
  const src = path.dirname(FORMS[rid]);
  for (const f of ['index.html', 'form-group-picker.js']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return { dir, file: path.join(dir, 'index.html') };
}

// A loopback server answering one envelope, recording each request's URL and cache-control header.
function serveEnvelope(state) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      state.requests.push({ url: req.url, cacheControl: req.headers['cache-control'] });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state.envelope));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}
// The form's PUBLICMENU_URL pointed at the loopback server (the bake reads the form's OWN url).
const pointAt = (file, port) => {
  const html = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, html.replace(/const PUBLICMENU_URL\s*=\s*'[^']+'/, `const PUBLICMENU_URL = 'http://127.0.0.1:${port}'`));
};
const loopbackFetch = (url, opts) => getJson(url, { ...opts, get: http.get, timeoutMs: 3000, totalMs: 5000 });

(async () => {
  const ENV = { x_pizza: await servedEnvelope('x_pizza'), la_musa: await servedEnvelope('la_musa') };
  const state = { envelope: null, requests: [] };
  const server = await serveEnvelope(state);
  const port = server.address().port;
  try {
    // ── 1. a real published body bakes: fresh read, identity keys stripped, everything else verbatim, check passes ──
    for (const rid of ['x_pizza', 'la_musa']) {
      const { dir, file } = tempForm(rid); pointAt(file, port);
      state.envelope = ENV[rid]; state.requests = [];
      assert.deepStrictEqual(validateEnvelope(ENV[rid], rid, { groupPicker: require(path.join(dir, 'form-group-picker.js')) }), []);
      const res = await bakeForm(rid, file, { fetchJson: loopbackFetch, buildStartMs: 1761500000000 });
      assert.deepStrictEqual(res.refusals, []); assert.strictEqual(res.changed, true);
      assert.strictEqual(state.requests.length, 1);
      assert.strictEqual(state.requests[0].url, `/menu/${rid}?_bake=1761500000000`, 'the form\'s own url + a build-unique query');
      assert.strictEqual(state.requests[0].cacheControl, 'no-cache');
      const baked = extractBundle(fs.readFileSync(file, 'utf8'));
      assert.deepStrictEqual(baked, projectMenu(ENV[rid].menu));
      for (const k of ['dish_id', 'identity_id']) assert.ok(baked.dishes.every((d) => !(k in d)), `${k} stripped from dishes`);
      assert.ok(baked.extras.every((e) => !('extra_id' in e)), 'extra_id stripped');
      const verbatim = clone(ENV[rid].menu); verbatim.dishes.forEach((d) => { delete d.dish_id; delete d.identity_id; }); verbatim.extras.forEach((e) => { delete e.extra_id; });
      assert.deepStrictEqual(baked, verbatim, 'every other field verbatim (photos, badges, badge_priority, reward_icon, extras_policy, gates, maps…)');
      const chk = compareBundle(baked, ENV[rid].menu);
      assert.deepStrictEqual(chk, { fail: [], warn: [] }, 'the live check passes on what the bake wrote');
      const again = await bakeForm(rid, file, { fetchJson: loopbackFetch, buildStartMs: 1761500000001 });
      assert.strictEqual(again.changed, false, 'idempotent');
    }
    assert.strictEqual(ENV.la_musa.menu.badge_priority.length, 6); assert.ok(ENV.x_pizza.menu.dishes.find((d) => d.name === 'Nutella').extras_policy === 'none');
    ok('real published bodies (both brands, migrated fields included) bake: fresh read (?_bake=<build-start> + no-cache), identity keys stripped, the rest verbatim; the live check then passes; a re-bake is idempotent');

    // ── 2. published-only changes reach the bake (an added and a removed dish, a repriced dish and option, a gate, a priority) ──
    {
      const rid = 'la_musa';
      const { file } = tempForm(rid); pointAt(file, port);
      const e = clone(ENV[rid]); const m = e.menu;
      const added = { ...clone(m.dishes.find((d) => !d.variantOf && !(m.variant_items && m.variant_items[d.id]))), id: 'new_dish_99', name: 'Plato nuevo', price: 199 };
      delete added.dish_id; delete added.identity_id;
      const repriced = m.dishes[0]; repriced.price += 7; m.extras[0].price += 3;
      const removable = m.dishes.find((d) => d !== repriced && !d.variantOf && !(m.variant_items && m.variant_items[d.id]) && !Object.keys(m.extras_by_item || {}).includes(d.id));
      m.dishes = m.dishes.filter((d) => d !== removable).concat([added]);
      m.badge_priority = m.badge_priority.slice().reverse();
      state.envelope = e;
      const res = await bakeForm(rid, file, { fetchJson: loopbackFetch });
      assert.deepStrictEqual(res.refusals, []);
      const baked = extractBundle(fs.readFileSync(file, 'utf8'));
      assert.ok(baked.dishes.some((d) => d.id === 'new_dish_99' && d.price === 199), 'an added dish appears');
      assert.ok(!baked.dishes.some((d) => d.id === removable.id), 'a removed dish is absent');
      assert.strictEqual(baked.dishes.find((d) => d.id === repriced.id).price, ENV[rid].menu.dishes[0].price + 7, 'a repriced dish');
      assert.strictEqual(baked.extras[0].price, ENV[rid].menu.extras[0].price + 3, 'a repriced option');
      assert.deepStrictEqual(baked.badge_priority, ENV[rid].menu.badge_priority.slice().reverse(), 'a changed badge priority');
      const xr = 'x_pizza'; const xf = tempForm(xr); pointAt(xf.file, port);
      const xe = clone(ENV[xr]); xe.menu.weekend_only_cats = []; state.envelope = xe;
      assert.deepStrictEqual((await bakeForm(xr, xf.file, { fetchJson: loopbackFetch })).refusals, []);
      assert.deepStrictEqual(extractBundle(fs.readFileSync(xf.file, 'utf8')).weekend_only_cats, [], 'a gate change');
      ok('published-only changes are baked: an added dish appears, a removed one is absent, a repriced dish and option, a reversed badge priority, a lifted weekend gate');
    }

    // ── 3. every named refusal: no file change, the refusal named ──
    {
      const R = [
        ['wrong rid', (e) => { e.rid = 'la_musa'; }, /bake_wrong_rid/],
        ['unknown representation', (e) => { e.representation_version = '2a.0'; }, /bake_unknown_representation/],
        ['no menu', (e) => { delete e.menu; }, /bake_menu_missing/],
        ['no dishes', (e) => { e.menu.dishes = []; }, /bake_apply_dishes_missing/],
        ['no extras collection', (e) => { delete e.menu.extras; }, /bake_apply_extras_missing/],
        ['no categories', (e) => { e.menu.categories = []; }, /bake_apply_categories_missing/],
        ['a duplicate dish id', (e) => { e.menu.dishes[1].id = e.menu.dishes[0].id; }, /bake_apply_dish_duplicate/],
        ['a duplicate extra id', (e) => { e.menu.extras[1].id = e.menu.extras[0].id; }, /bake_apply_extra_duplicate/],
        ['an empty dish id', (e) => { e.menu.dishes[0].id = ''; }, /bake_apply_dish_malformed@0/],
        ['an empty dish name', (e) => { e.menu.dishes[0].name = ''; }, /bake_apply_dish_malformed@0/],
        ['a zero dish price', (e) => { e.menu.dishes[0].price = 0; }, /bake_apply_dish_malformed@0/],
        ['a NEGATIVE dish price (Codex r1 #2)', (e) => { e.menu.dishes[0].price = -5; }, /bake_apply_dish_malformed@0/],
        ['a non-integer dish price', (e) => { e.menu.dishes[0].price = 12.5; }, /bake_apply_dish_malformed@0/],
        ['a NaN extra price', (e) => { e.menu.extras[0].price = NaN; }, /bake_apply_extra_malformed@0/],
        ['a dish in no category', (e) => { e.menu.dishes[0].cat = 'ghost'; }, /bake_apply_dish_orphan@0/],
        ['a duplicate category', (e) => { e.menu.categories.push(clone(e.menu.categories[0])); }, /bake_apply_category_duplicate/],
        ['a malformed category', (e) => { e.menu.categories[0] = { id: '' }; }, /bake_apply_category_malformed@0/],
        ['an off-policy extras_policy', (e) => { e.menu.dishes[0].extras_policy = 'some'; }, /bake_apply_dish_extras_policy@0/],
        ['a reward_icon outside the set', (e) => { e.menu.dishes[0].reward_icon = 'pizza'; }, /bake_apply_reward_icon:dish@0/],
        ['an extra reward_icon outside the set', (e) => { e.menu.extras[0].reward_icon = 'gift'; }, /bake_apply_reward_icon:extra@0/],
        ['a gate naming no category', (e) => { e.menu.weekend_only_cats = ['ghost']; }, /bake_apply_gate_unknown_category:weekend_only_cats=ghost/],
        ['a malformed gate', (e) => { e.menu.pickup_only_cats = 'ny'; }, /bake_apply_gate_malformed:pickup_only_cats/],
        ['a variantOf naming no launcher map', (e) => { e.menu.dishes[0].variantOf = 9999; }, /bake_apply_variant_uncovered@0/],
        ['an unknown has_photo shape', (e) => { e.menu.has_photo = 'x'; }, /bake_has_photo_malformed/],
      ];
      const RLM = [
        ['the variant map DELETED while dishes still carry variantOf (Codex r1 #3, real-writer body)', (e) => { delete e.menu.variant_items; }, /bake_apply_variant_uncovered@\d+/],
        ['a variant group naming no dish', (e) => { const k = Object.keys(e.menu.variant_items)[0]; e.menu.variant_items[k].variantIds = ['ghost_dish']; }, /bake_apply_variant_id_orphan@bake/],
        ['an option map keyed by no category', (e) => { e.menu.extras_by_category = { ...e.menu.extras_by_category, ghost: [] }; }, /bake_apply_option_map_key:extras_by_category\.ghost/],
        ['an option map keyed by no dish', (e) => { e.menu.extras_by_item = { ...(e.menu.extras_by_item || {}), ghost_dish: [] }; }, /bake_apply_option_map_key:extras_by_item\.ghost_dish/],
        ['an option value naming neither a category nor an extra', (e) => { const k = Object.keys(e.menu.extras_by_category)[0]; e.menu.extras_by_category[k] = ['nothing']; }, /bake_apply_option_map_value:extras_by_category\..+=nothing/],
        ['a malformed badge', (e) => { e.menu.badges = { ...e.menu.badges, bad: { cls: '' } }; }, /bake_apply_badge_malformed:bad/],
        ['a priority naming no badge', (e) => { e.menu.badge_priority = ['ghost']; }, /bake_apply_badge_priority_unknown:ghost/],
        ['a duplicate priority entry', (e) => { e.menu.badge_priority = ['must_try', 'must_try']; }, /bake_apply_badge_priority_malformed/],
      ];
      let count = 0;
      for (const [rid, rows] of [['x_pizza', R], ['la_musa', RLM]]) {
        const { file } = tempForm(rid); pointAt(file, port);
        const before = fs.readFileSync(file, 'utf8');
        for (const [label, mut, re] of rows) {
          const e = clone(ENV[rid]); mut(e); state.envelope = e;
          const res = await bakeForm(rid, file, { fetchJson: loopbackFetch });
          assert.ok(res.refusals.some((x) => re.test(x)), `${rid} ${label}: expected ${re}, got ${JSON.stringify(res.refusals)}`);
          assert.strictEqual(res.changed, false);
          assert.strictEqual(fs.readFileSync(file, 'utf8'), before, `🔴 ${rid} ${label}: the form changed`);
          count += 1;
        }
      }
      // an option value naming an individual EXTRA KEY (not a category) is legal (§8.3 — both namespaces)
      const e = clone(ENV.la_musa); const k = Object.keys(e.menu.extras_by_category)[0]; e.menu.extras_by_category[k] = [e.menu.extras[0].id];
      assert.deepStrictEqual(validateEnvelope(e, 'la_musa', { groupPicker: require(path.join(path.dirname(FORMS.la_musa), 'form-group-picker.js')) }), []);
      ok(`${count} named refusals each leave the form byte-unchanged (wrong rid, version, missing collections, duplicate / empty ids, bad prices, dangling category / variant / option refs, malformed gates / badges / priority / icons); an extra-key option value is legal`);
    }

    // ── 4. a fetch that fails refuses too (nothing written) ──
    {
      const { file } = tempForm('x_pizza');
      const before = fs.readFileSync(file, 'utf8');
      const res = await bakeForm('x_pizza', file, { fetchJson: async () => { throw new Error('answered 503'); } });
      assert.ok(/bake_fetch_failed: answered 503/.test(res.refusals[0])); assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
      ok('an unreachable / failing published menu refuses: nothing written');
    }

    // ── 5. the stamp hashes the BAKED bytes: a changed published menu changes the build hash ──
    {
      const { dir, file } = tempForm('x_pizza'); pointAt(file, port);
      state.envelope = ENV.x_pizza; await bakeForm('x_pizza', file, { fetchJson: loopbackFetch });
      const h1 = computeBuild(dir, ['index.html']);
      const e = clone(ENV.x_pizza); e.menu.dishes[0].price += 1; state.envelope = e;
      await bakeForm('x_pizza', file, { fetchJson: loopbackFetch });
      assert.notStrictEqual(computeBuild(dir, ['index.html']), h1, 'a repriced published dish moves the build hash');
      ok('bake → stamp: a changed published menu changes the stamp\'s build hash (the hash covers the baked bytes)');
    }

    // ── 6. the CLI: --this-form is required; outside a registered form folder it fails ──
    {
      const tool = path.join(__dirname, 'bake-form-bundle.js');
      const a = spawnSync(process.execPath, [tool], { cwd: path.dirname(FORMS.x_pizza), encoding: 'utf8' });
      assert.strictEqual(a.status, 1); assert.ok(/--this-form is required/.test(a.stderr));
      const b = spawnSync(process.execPath, [tool, '--this-form'], { cwd: os.tmpdir(), encoding: 'utf8' });
      assert.strictEqual(b.status, 1); assert.ok(/not a registered form/.test(b.stderr));
      assert.deepStrictEqual([...KNOWN_REPRESENTATIONS], ['1d.1', '1d.2', '1d.3']);
      ok('CLI: no --this-form → exit 1 (it never rewrites a working tree); --this-form outside a registered form folder → exit 1; accepts 1d.1/1d.2/1d.3');
    }

    // ── 7. the EXTENDED live check: the display structures the forms boot from — baked-but-different FAILS, published-only WARNS ──
    {
      const pub = clone(ENV.la_musa.menu);
      const baked = projectMenu(pub);
      const k = Object.keys(baked.extras_by_category)[0];
      const bad = clone(baked);
      bad.badge_priority = bad.badge_priority.slice().reverse();
      bad.extras_by_category[k] = [];
      bad.badges[Object.keys(bad.badges)[0]].label = 'Otro';
      const xb = projectMenu(clone(ENV.x_pizza.menu)); xb.weekend_only_cats = ['individual'];
      const fails = compareBundle(bad, pub).fail.join('\n');
      assert.ok(/badge_priority order/.test(fails), 'a reordered priority FAILS');
      assert.ok(new RegExp(`extras_by_category ${k}`).test(fails), 'a changed option-map entry FAILS');
      assert.ok(/badge \w+ label/.test(fails), 'a changed badge FAILS');
      assert.ok(/weekend_only individual: baked but absent/.test(compareBundle(xb, ENV.x_pizza.menu).fail.join('\n')), 'a baked gate the published menu lacks FAILS');
      const old = clone(baked); delete old.badge_priority; delete old.badges; delete old.extras_by_category;
      const w = compareBundle(old, pub);
      assert.deepStrictEqual(w.fail, [], 'an older bundle missing the new structures does not FAIL…');
      assert.ok(w.warn.some((x) => /badge_priority order: published only/.test(x)) && w.warn.some((x) => /^badge /.test(x)), '…it WARNS (published-only)');
      ok('extended live check: a reordered priority, a changed option-map entry or badge, and a baked-only gate FAIL; structures only the published menu has WARN');
    }

    // ── 8. it runs inside a FORM's Netlify build, where xpizza-functions' npm deps are NOT installed: built-ins only ──
    {
      const hook = "const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,p,...a){if(!r.startsWith('.')&&!r.startsWith('/')&&!r.startsWith('node:')&&!M.builtinModules.includes(r))throw new Error('NON-BUILTIN '+r);return o.call(this,r,p,...a)};";
      const load = `${hook}require(${JSON.stringify(path.join(__dirname, 'bake-form-bundle.js'))});require(${JSON.stringify(path.join(path.dirname(FORMS.x_pizza), 'form-group-picker.js'))});console.log('ok')`;
      const r = spawnSync(process.execPath, ['-e', load], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `🔴 the bake requires a non-built-in module: ${r.stderr}`);
      ok('the bake (and the form\'s picker it loads) resolves Node built-ins only — it can run in a form\'s Netlify build');
    }
  } finally { server.close(); for (const d of TEMP) fs.rmSync(d, { recursive: true, force: true }); }
  FINISHED = true;
  console.log(`\nbake-form-bundle: OK (${n})`);
})().catch((e) => { console.error('bake-form-bundle: FAILED', e); process.exit(1); });
