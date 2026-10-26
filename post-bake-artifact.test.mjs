// PLAN 4 (bake from published) r3 §6 / §8.1 / §8.3 / §8.4 — THE POST-BAKE ARTIFACT, BOOTED.
// Run: node post-bake-artifact.test.mjs
//
// A REAL published menu (seed + the reviewed migration rows → publishVersion → buildPublicMenu, identity laid on) with
// published-only changes on top is BAKED by the real bake (contract + projection + fail-closed splice) into a temp copy of each
// form, and the BAKED index.html is booted in jsdom with the live fetch NEVER settling (and, separately, failing). What the
// page holds before any live apply is the bake: a repriced dish and a repriced option show the published price; an added dish
// appears and a removed one is absent; option groups, "no options", required choices and the gates follow the bake; an 86
// from the availability feed still applies; the reward picker shows the published icons; the pre-apply records carry no
// identity keys. A later live apply still upgrades — including badges, badge priority, an option map and a reward icon (§8.4)
// — and a malformed one refuses and keeps the last good menu. Both option-map value kinds render in each form (§8.3). One
// COMBINED body (photos + a renamed category + badge_priority + reward_icon) goes through serve, bake AND live apply (§8.1).
// A synthetic third brand (a temp copy of a form, under synthetic_3) boots its own bake.
import assert from 'node:assert';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { loadForm, closeAll, counter, settle, serve, envelope, loadAvail } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { bakeForm } = require('./tools/bake-form-bundle');
const { FORMS } = require('./tools/splice-form-bundle');
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion } = require('./catalog/catalog-publish');
const { buildSourceCandidate } = require('./catalog/candidate-validate');
const { buildPublicMenu } = require('./catalog/public-menu');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const DATA = require('./tools/migrations/2026-10-26-menu-structure.json');

const { ok, count } = counter();
const clone = (v) => JSON.parse(JSON.stringify(v));
const P = (v) => JSON.parse(JSON.stringify(v));   // out of the page's realm (a cross-realm array fails deepStrictEqual on its prototype)
const TEMP = [];

async function published(rid, mutateSource = null) {
  const source = clone(buildSourceFromCode(rid));
  const rows = DATA.restaurants[rid];
  if (rows.structure) Object.assign(source.structure, clone(rows.structure));
  for (const [coll, list] of [['items', source.items], ['extras', source.extras]]) {
    for (const [key, row] of Object.entries(rows[coll] || {})) Object.assign(list.find((x) => x.key === key).display, clone(row.display));
  }
  if (mutateSource) mutateSource(source);
  const db = makeDb();
  const { inputs, built } = buildSourceCandidate(rid, source);
  await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'artifact' }, { expected: { activeVersionId: null } });
  const m = await buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true });
  const menu = clone(m.body);
  menu.dishes.forEach((d, i) => { d.dish_id = `d${i}`; });            // identity as production overlays it
  menu.extras.forEach((e, i) => { e.extra_id = `x${i}`; });
  return { rid: m.rid, representation_version: m.representation_version, menu };
}
// Bake an envelope into a temp copy of the form; → the BAKED html.
async function baked(dir, rid, env) {
  const tmp = mkdtempSync(join(tmpdir(), 'postbake-')); TEMP.push(tmp);
  for (const f of ['index.html', 'form-group-picker.js']) copyFileSync(join(dirname(FORMS[dir === 'xpizza-orders' ? 'x_pizza' : 'la_musa']), f), join(tmp, f));
  const res = await bakeForm(rid, join(tmp, 'index.html'), { fetchJson: async () => clone(env) });
  assert.deepStrictEqual(res.refusals, [], `${dir}: the bake accepted the published body`);
  return readFileSync(join(tmp, 'index.html'), 'utf8');
}
const boot = async (dir, html) => { const w = loadForm(dir, { html }); await settle(); return w; };
const painted = (w, ids) => ids.map((id) => (w.document.getElementById(id) || { innerHTML: '' }).innerHTML).join('');
const errShown = (w) => ['err1', 'err3'].some((id) => { const e = w.document.getElementById(id); return e && e.style.display === 'block' && /menú/.test(e.textContent); });

try {
  // ═══ X. PIZZA ═══
  {
    const dir = 'xpizza-orders', rid = 'x_pizza';
    const env = await published(rid);
    const m = env.menu;
    const marg = m.dishes.find((d) => d.name === 'Margherita'); marg.price += 11;                     // repriced dish
    const roja = m.extras.find((e) => e.name === 'Salsa Roja'); roja.price += 7;                     // repriced option
    m.dishes.push({ ...clone(m.dishes.find((d) => d.name === 'Ham')), id: 99, name: 'Diavola', price: 333, dish_id: 'dnew' });   // added
    m.dishes = m.dishes.filter((d) => d.name !== 'Spinach');                                         // removed
    m.extras_by_category = { ...m.extras_by_category, ny: ['Salsas & Queso', 'e9'] };                // §8.3: a category AND one extra (Prosciutto, by id)
    const html = await baked(dir, rid, env);
    const w = await boot(dir, html);
    const MENU = w.liveMenuGlobalGet('MENU'), EXTRAS = w.liveMenuGlobalGet('EXTRAS');
    assert.strictEqual(MENU.find((d) => d.name === 'Margherita').price, marg.price, 'the published dish price before any live fetch');
    assert.strictEqual(EXTRAS.find((e) => e.name === 'Salsa Roja').price, roja.price, 'the published option price');
    assert.ok(MENU.some((d) => d.name === 'Diavola') && !MENU.some((d) => d.name === 'Spinach'), 'added appears, removed is absent');
    assert.ok(painted(w, ['menu-individual']).includes('Diavola') && !painted(w, ['menu-individual']).includes('Spinach'), '… on the painted page too');
    assert.ok(painted(w, ['menu-individual']).includes(String(marg.price)), 'the painted card shows the published price');
    assert.ok(MENU.every((d) => !('dish_id' in d)) && EXTRAS.every((e) => !('extra_id' in e)), 'pre-apply records carry no identity keys (payloads unchanged)');
    assert.deepStrictEqual(w.__calls.filter((u) => /\/menu\//.test(u)).length >= 1 && w.liveMenuGlobalGet('MENU') === MENU, true, 'the live fetch never settled — this IS the bake');
    // options: individual = every category; ny = Salsas & Queso + Prosciutto only; Nutella none
    const groups = (name) => (w.extrasOfferedFor(MENU.find((d) => d.name === name)) || null);
    assert.deepStrictEqual(P(groups('Margherita').map((g) => g.cat)), ['Salsas & Queso', 'Carnes', 'Vegetales & Hierbas']);
    assert.deepStrictEqual(P(groups('Margherita NY').map((g) => [g.cat, g.extras.map((e) => e.name)])),
      [['Salsas & Queso', ['Salsa Roja', 'Salsa Blanca', 'Salsa Calabrian Chili', 'Mozzarella', 'Whipped Ricotta']], ['Carnes', ['Prosciutto']]], '§8.3: a category entry AND an extra-key entry render');
    assert.strictEqual(groups('Nutella'), null, 'Nutella offers nothing (its published extras_policy none)');
    assert.strictEqual(MENU.find((d) => d.name === 'Nutella').extras_policy, 'none');
    // gates
    assert.deepStrictEqual(P([w.liveMenuGlobalGet('WEEKEND_ONLY_CATS'), w.liveMenuGlobalGet('PICKUP_ONLY_CATS')]), [['ny'], ['ny']], 'the NY gates come from the bake');
    // 86
    await loadAvail(w, { [w.availKey('Carnivora')]: { available: false, updated_at: 1 } });
    assert.strictEqual(w.isSoldOut(MENU.find((d) => d.name === 'Carnivora')), true, 'an 86 still applies from the availability feed');
    // rewards: the published icons
    const cat = w.buildRedeemCatalog();
    assert.strictEqual(cat.find((r) => r.name === 'Mushroom').icon, 'mushroom'); assert.strictEqual(cat.find((r) => r.name === 'Anchovies').icon, 'fish');
    assert.ok(!errShown(w), 'no broken-menu announcement');
    ok('x_pizza baked page: published prices (dish + option), added / removed dish, option groups incl. an extra-key entry, Nutella none, NY gates, an 86, reward icons — before any live fetch, no identity keys');

    // a later live apply still upgrades: a repriced dish + a changed option map + a reward icon
    const later = clone(env); later.menu.dishes.find((d) => d.name === 'Margherita').price += 1;
    later.menu.extras_by_category = { ...later.menu.extras_by_category, ny: ['Carnes'] };
    later.menu.dishes.find((d) => d.name === 'Mushroom').reward_icon = 'leaf';
    await serve(w, envelope(rid, later.menu, '1d.3'));
    assert.strictEqual(w.liveMenuGlobalGet('MENU').find((d) => d.name === 'Margherita').price, marg.price + 1, 'the live apply upgrades the price');
    assert.deepStrictEqual(P(w.liveMenuGlobalGet('EXTRAS_BY_CATEGORY').ny), ['Carnes'], '§8.4: … and the option map, live');
    assert.deepStrictEqual(P(w.extrasOfferedFor(w.liveMenuGlobalGet('MENU').find((d) => d.name === 'Margherita NY')).map((g) => g.cat)), ['Carnes']);
    assert.strictEqual(w.buildRedeemCatalog().find((r) => r.name === 'Mushroom').icon, 'leaf', '§8.4: … and a reward icon, without a reload');
    // a malformed one refuses and keeps the last good menu
    const bad = clone(later); bad.menu.extras_by_category = { ...bad.menu.extras_by_category, ghost: ['Carnes'] }; bad.menu.dishes[0].price += 50;
    await serve(w, envelope(rid, bad.menu, '1d.3'));
    assert.deepStrictEqual(P(w.liveMenuGlobalGet('EXTRAS_BY_CATEGORY').ny), ['Carnes'], 'a malformed map refuses the snapshot whole');
    assert.notStrictEqual(w.liveMenuGlobalGet('MENU')[0].price, bad.menu.dishes[0].price, '… and its prices with it (the last good menu stands)');
    ok('x_pizza: a later live apply upgrades price, option map and reward icon without a reload; a malformed map refuses whole and the last good menu stands');

    // the live menu UNAVAILABLE: the baked page stands, no broken announcement
    const w2 = loadForm(dir, { html }); w2.__respond = () => Promise.reject(new Error('offline')); await settle();
    try { await w2.__liveMenu.feed.refresh(); } catch (_) { /* the feed's own failure handling */ }
    await settle();
    assert.strictEqual(w2.liveMenuGlobalGet('MENU').find((d) => d.name === 'Margherita').price, marg.price, 'the bake stands while the live menu is unavailable');
    assert.ok(!errShown(w2));
    ok('x_pizza: with the live menu UNAVAILABLE the baked menu stands (no announcement)');
  }

  // ═══ LA MUSA (+ the COMBINED body: photos + renamed category + badge_priority + reward_icon through serve, bake, live apply) ═══
  {
    const dir = 'la-musa-orders', rid = 'la_musa';
    const env = await published(rid, (source) => {
      const cat = source.structure.categories.find((c) => c.id === 'dim_sum'); cat.name = 'Dim Sum de la casa';        // renamed category
    });
    const m = env.menu;
    assert.ok(m.photos && Object.keys(m.photos).length, 'SERVE: the combined body carries photos');
    assert.strictEqual(m.categories.find((c) => c.id === 'dim_sum').name, 'Dim Sum de la casa', 'SERVE: … a renamed category');
    assert.ok(Array.isArray(m.badge_priority) && m.dishes.some((d) => d.reward_icon), 'SERVE: … badge_priority and reward_icon');
    m.badge_priority = ['must_try', 'signature_special', 'chefs_pick', 'crowd_favourite', 'most_ordered', 'price_pending'];   // published order differs from TAG_PRIORITY
    const dish = m.dishes.find((d) => Array.isArray(d.tags) && d.tags.includes('must_try') && d.tags.includes('signature_special'))
      || m.dishes.find((d) => Array.isArray(d.tags) && d.tags.includes('must_try'));
    if (dish && !dish.tags.includes('signature_special')) dish.tags = ['signature_special', ...dish.tags];
    const item = m.dishes.find((d) => d.cat === 'rice' && !d.variantOf);
    m.extras_by_item = { ...m.extras_by_item, [item.id]: [m.extras.find((e) => e.cat !== 'Proteínas').id] };   // §8.3: an extra-key entry
    m.dishes.find((d) => d.id === 'dimsum_01').price += 9;
    const html = await baked(dir, rid, env);
    const B = JSON.parse(html.match(/window\.__FORM_MENU_BUNDLE__ = (\{.*?\});<\/script>/s)[1].replace(/\\u003C/g, '<'));
    assert.ok(B.photos && B.badge_priority && B.categories.find((c) => c.id === 'dim_sum').name === 'Dim Sum de la casa' && B.dishes.some((d) => d.reward_icon), 'BAKE: every combined field reached the bundle');
    const w = await boot(dir, html);
    const MENU = w.liveMenuGlobalGet('MENU');
    assert.strictEqual(MENU.find((d) => d.id === 'dimsum_01').price, m.dishes.find((d) => d.id === 'dimsum_01').price, 'the published price before any live fetch');
    assert.deepStrictEqual(P(w.liveMenuGlobalGet('BADGE_PRIORITY')), m.badge_priority, 'the published badge order, not TAG_PRIORITY');
    assert.strictEqual(w.pickBadge(['signature_special', 'must_try']).label, m.badges.must_try.label, 'the badge chosen follows the PUBLISHED priority');
    assert.ok(w.document.body.innerHTML.includes('Dim Sum de la casa'), 'the renamed category paints');
    const g = w.extrasGroupsForItem(MENU.find((d) => d.id === item.id));
    assert.ok(g.some((x) => x.extras.some((e) => e.id === m.extras_by_item[item.id][0])), '§8.3: an extra-key entry renders in la_musa too');
    assert.ok(w.extrasGroupsForItem(MENU.find((d) => d.cat === 'dim_sum')).length > 0, 'category entries render');
    const rc = w.buildRedeemCatalog();
    assert.strictEqual(rc.find((r) => r.key === 'dimsum_01').icon, 'dumpling'); assert.strictEqual(rc.find((r) => r.key === 'rice_white').icon, 'rice');
    const launcher = Object.keys(w.liveMenuGlobalGet('VARIANT_ITEMS'))[0];
    assert.ok(launcher && w.GroupPicker.choiceRows(w.liveMenuGlobalGet('VARIANT_ITEMS')[launcher], MENU, null).length >= 2, 'required choices are drawable from the bake');
    assert.ok(!errShown(w));
    ok('la_musa baked page (COMBINED body): photos + renamed category + published badge order + reward icons reached serve AND bake; published prices, an extra-key option entry, required choices — before any live fetch');

    // LIVE APPLY of the combined body + changes to badges / priority (§8.1 live-apply leg, §8.4)
    const later = clone(env);
    later.menu.badge_priority = ['chefs_pick', 'must_try', 'signature_special', 'crowd_favourite', 'most_ordered', 'price_pending'];
    later.menu.badges = { ...later.menu.badges, must_try: { ...later.menu.badges.must_try, label: 'Imperdible hoy' } };
    later.menu.dishes.find((d) => d.id === 'dimsum_01').reward_icon = 'star';
    await serve(w, envelope(rid, later.menu, '1d.3'));
    assert.deepStrictEqual(P(w.liveMenuGlobalGet('BADGE_PRIORITY')), later.menu.badge_priority, 'LIVE APPLY: the badge priority applies live');
    assert.strictEqual(w.liveMenuGlobalGet('TAG_BADGES').must_try.label, 'Imperdible hoy', 'LIVE APPLY: a renamed badge applies live');
    assert.strictEqual(w.buildRedeemCatalog().find((r) => r.key === 'dimsum_01').icon, 'star', 'LIVE APPLY: a reward icon applies live');
    assert.ok(w.document.body.innerHTML.includes('Dim Sum de la casa'), 'LIVE APPLY: the renamed category stands');
    const bad = clone(later); bad.menu.badge_priority = ['ghost'];
    await serve(w, envelope(rid, bad.menu, '1d.3'));
    assert.deepStrictEqual(P(w.liveMenuGlobalGet('BADGE_PRIORITY')), later.menu.badge_priority, 'a malformed priority refuses; the last good one stands');
    ok('la_musa: the combined body LIVE-APPLIES (priority, renamed badge, reward icon, renamed category); a malformed priority refuses and the last good menu stands');
  }

  // ═══ A SYNTHETIC THIRD BRAND — a temp copy of a form, baked under synthetic_3 ═══
  {
    const env = await published('x_pizza');
    env.rid = 'synthetic_3';
    env.menu.dishes.find((d) => d.name === 'Ham').price = 123;
    const html = await baked('xpizza-orders', 'synthetic_3', env);
    const w = await boot('xpizza-orders', html);
    assert.strictEqual(w.liveMenuGlobalGet('MENU').find((d) => d.name === 'Ham').price, 123, 'the third brand boots its own bake');
    const wrong = clone(env); wrong.rid = 'x_pizza';
    const tmp = mkdtempSync(join(tmpdir(), 'postbake-')); TEMP.push(tmp);
    for (const f of ['index.html', 'form-group-picker.js']) copyFileSync(join(dirname(FORMS.x_pizza), f), join(tmp, f));
    const r = await bakeForm('synthetic_3', join(tmp, 'index.html'), { fetchJson: async () => wrong });
    assert.ok(r.refusals.some((x) => /bake_wrong_rid/.test(x)), 'another brand\'s body is refused for it');
    ok('synthetic_3: a third brand\'s form boots its own bake; another brand\'s body is refused for it');
  }
} finally {
  closeAll();
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
}
console.log(`\npost-bake-artifact: OK (${count()})`);
