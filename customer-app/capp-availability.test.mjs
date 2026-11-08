// Customer app — readAvailability (PLAN-avail-identity; advisor ruling 2026-11-01): the app decides a dish's availability EXACTLY as
// the live forms do. The served body is the REAL writer's (generateFormBundle + the identity overlay); the identity field comes
// from the SERVER's one rule (menu-pricing availIdentityField — live once 5f's slice is assembled, else read from its approved commit
// e024dc6f); the forms are the REAL pages (form-harness) answering the SAME RTDB fixture.
// Run: node --test customer-app/capp-availability.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const fnRequire = createRequire(join(ROOT, 'xpizza-functions/x.js'));
const { loadForm, closeAll, settle, BRAND, serve, envelope } = await import(join(ROOT, 'form-harness.mjs'));
const CappMenu = require('./capp-menu.js'), CappAvailability = require('./capp-availability.js'), Boot = require('./capp-boot.js');
const { availKey } = require('./avail-key.js'), Reducer = require('./availability-reducer.js');
const { generateFormBundle, catalogSnapshot } = fnRequire('./catalog/generate-form-bundle');
const { applyIdentityToServedBody } = fnRequire('./catalog/identity-overlay');
const { fullRegistry } = fnRequire('./catalog/identity-fixture');
const M = fnRequire('./platform-manifest.js');

// the server's ONE identity rule (5f): the live export when assembled, else the approved commit's line, verbatim
const availIdentityField = (() => {
  const live = fnRequire('./menu-pricing.js').availIdentityField;
  if (typeof live === 'function') return live;
  const src = execFileSync('git', ['show', 'e024dc6f:xpizza-functions/menu-pricing.js'], { cwd: ROOT, encoding: 'utf8' });
  // INTERIM (until menu-pricing exports it at assembly — then this branch is dead and is removed): the line must occur EXACTLY
  // once, else RED with a label — a re-anchor or a merge can never turn the equality cells vacuous through a silent default (5f)
  const all = [...src.matchAll(/const availIdentityField = (\(rid\) => \(rid === 'la_musa' \? 'id' : 'name'\));/g)];
  assert.equal(all.length, 1, `🔴 5f's availIdentityField line must occur exactly once in e024dc6f:xpizza-functions/menu-pricing.js (found ${all.length})`);
  const m = all[0];
  return new Function(`return ${m[1]};`)();
})();
const servedBody = async (rid) => (await applyIdentityToServedBody(fullRegistry(rid), rid, generateFormBundle(rid, catalogSnapshot(rid)))).body;
// the identity where the server writes it — inside the served body (catalog/public-menu.js), pinned by the real-envelope cell below
const cappEnvelope = (rid, body, field) => envelope(rid, field ? { ...body, avail_identity: { field } } : body, '1d.3');
const mapper = () => CappAvailability.createAvailability({ availKey, decide: Reducer.decide });
const OFF = { available: false, updated_at: 1 }, ON = { available: true, updated_at: 2 };

test('the synced modules are byte-identical to the canonical server copies (the forms / KDS / server rule)', () => {
  for (const f of ['avail-key.js', 'availability-reducer.js'])
    assert.ok(readFileSync(join(HERE, f)).equals(readFileSync(join(ROOT, 'xpizza-functions', f))), `🔴 customer-app/${f} drifted from xpizza-functions/${f}`);
  const shell = readFileSync(join(HERE, 'shell.html'), 'utf8');
  for (const f of ['avail-key.js', 'availability-reducer.js', 'capp-availability.js']) assert.ok(shell.indexOf(`src="${f}"`) > 0 && shell.indexOf(`src="${f}"`) < shell.indexOf('src="capp-shell-ui.js"'), `shell.html loads ${f} before the shell`);
});

for (const dir of ['xpizza-orders', 'la-musa-orders']) {
  test(`EQUALITY with the live form (${dir}): the same RTDB node ⇒ the same sold dishes, under the served identity — a key under the OTHER identity sells nothing`, async () => {
    const rid = BRAND[dir].rid, field = availIdentityField(rid), other = field === 'id' ? 'name' : 'id';
    assert.deepEqual([rid, field], dir === 'xpizza-orders' ? ['x_pizza', 'name'] : ['la_musa', 'id'], 'premise: the server rule (x_pizza by NAME, la_musa by id)');
    const body = await servedBody(rid);
    const w = loadForm(dir); await settle();
    try {
    await serve(w, envelope(rid, body, '1d.2'));
    const items = w.liveMenuGlobalGet('MENU');
    assert.ok(items.length >= 6, 'premise: the form holds the served menu');
    // the fixture: 3 sold under the served identity, 1 explicitly available, 1 decoy sold under the OTHER identity, the rest silent
    const node = {};
    for (const it of items.slice(0, 3)) node[availKey(it[field])] = OFF;
    node[availKey(items[3][field])] = ON;
    if (String(items[4][other]) !== String(items[4][field])) node[availKey(items[4][other])] = OFF;
    const AVAIL = `${M.PLATFORM.appRuntime().availability_base}/restaurants/${rid}/item_availability.json`;
    w.__respond = (u) => (String(u) === AVAIL ? Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(node)) }) : new Promise(() => {}));
    await w.loadAvailability(); await settle();
    const formSold = items.filter((it) => w.ownSoldOut(it)).map((it) => String(it.id)).sort();
    assert.ok(formSold.length === 3, `premise: the form sells exactly the three (${formSold.length})`);
    const menu = CappMenu.adaptMenu(cappEnvelope(rid, body, field));
    assert.equal(menu.availIdentity, field);
    const cappSold = mapper().soldKeys(menu, node).map((k) => String(menu.dish(k).id)).sort();
    assert.deepEqual(cappSold, formSold, `🔴 ${dir}: the app and the form disagree on what is sold`);
    assert.ok(!cappSold.includes(String(items[4].id)) && !cappSold.includes(String(items[3].id)), 'the decoy and the explicitly-available dish stay available');
    } finally { closeAll(); }   // a failing cell must still close the page (else the run never exits)
  });
}

// FROM THE REAL WRITER (SBS 11-07): the endpoint serves { rid, representation_version, menu: body } (index.js getPublicMenu) and the
// server writes avail_identity INTO the body (catalog/public-menu.js) — so the identity the app reads must come from the envelope the
// real publish produces (contract/capp provisionBrand), never a hand-placed field: the earlier top-level builder hid a dead read
test('the REAL served envelope (the publish, seeded) carries the identity where the app reads it: availIdentity = the server rule', async () => {
  const { provisionBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
  for (const rid of ['x_pizza', 'la_musa']) {
    const log = console.log; console.log = () => {}; let pv; try { pv = await provisionBrand(rid); } finally { console.log = log; }
    const env = pv && pv.envelope;
    assert.ok(env && env.menu && Array.isArray(env.menu.dishes) && env.menu.dishes.length > 0, `premise: ${rid}'s real envelope has a menu`);
    assert.equal(CappMenu.adaptMenu(env).availIdentity, availIdentityField(rid), `🔴 ${rid}: the app reads no availability identity from the REAL served envelope — sold-out dishes would never be read`);
  }
});

test('FAIL-OPEN on an older envelope (no avail_identity): null — never a guessed identity, never an RTDB read', async () => {
  const body = await servedBody('x_pizza');
  const old = CappMenu.adaptMenu(cappEnvelope('x_pizza', body, null));
  assert.equal(old.availIdentity, null);
  assert.equal(mapper().soldKeys(old, { anything: OFF }), null);
  for (const bad of [{ field: 'slug' }, { field: '' }, 'name', null]) assert.equal(CappMenu.adaptMenu(envelope('x_pizza', { ...body, avail_identity: bad }, '1d.3')).availIdentity, null, `a malformed identity ${JSON.stringify(bad)} is no identity`);
  let fetched = 0; let opts;
  const S = { mount: (d, o) => { opts = o; return {}; } };
  Boot.boot({}, { runtime: { mode: 'native', ...M.PLATFORM.appRuntime(), flags: {}, sdk_base: './' }, CappShellUI: S, CappSignupApi: { ENDPOINTS: [] }, CappAvailability, availabilityReducer: Reducer, availKey, fetch: async () => { fetched++; return {}; } });
  assert.equal(await opts.readAvailability('x_pizza', old), null); assert.equal(fetched, 0, '🔴 no read without an identity');
});

test('the boot: the RTDB node (no-store) mapped onto the dish keys; a failed / non-200 / unreadable read ⇒ null (fail-open)', async () => {
  const body = await servedBody('la_musa'), menu = CappMenu.adaptMenu(cappEnvelope('la_musa', body, 'id'));
  const d0 = menu.dishes[0], RT = M.PLATFORM.appRuntime();
  const calls = []; let next; let opts;
  const S = { mount: (d, o) => { opts = o; return {}; } };
  Boot.boot({}, { runtime: { mode: 'native', ...RT, flags: {}, sdk_base: './' }, CappShellUI: S, CappSignupApi: { ENDPOINTS: [] }, CappAvailability, availabilityReducer: Reducer, availKey, fetch: async (u, i) => { calls.push([u, i]); return next(); } });
  next = () => ({ status: 200, json: async () => ({ [availKey(d0.id)]: OFF }) });
  assert.deepEqual(await opts.readAvailability('la_musa', menu), [d0.key]);
  assert.equal(calls[0][0], `${RT.availability_base}/restaurants/la_musa/item_availability.json`); assert.equal(calls[0][1].cache, 'no-store');
  next = () => ({ status: 401, json: async () => ({}) }); assert.equal(await opts.readAvailability('la_musa', menu), null);
  next = () => { throw new Error('offline'); }; assert.equal(await opts.readAvailability('la_musa', menu), null);
  next = () => ({ status: 200, json: async () => { throw new Error('bad'); } }); assert.equal(await opts.readAvailability('la_musa', menu), null);
  next = () => ({ status: 200, json: async () => null }); assert.deepEqual(await opts.readAvailability('la_musa', menu), [], 'an empty node sells nothing (the forms\' rule)');
});

test('key HISTORY (the forms\' availKeysFor): a dish renamed mid-session stays sold under the key it had (\'any_false\' over every key)', async () => {
  const body = await servedBody('x_pizza'), A = mapper();
  const m1 = CappMenu.adaptMenu(cappEnvelope('x_pizza', body, 'name')), d = m1.dishes.find((x) => x.name);
  const node = { [availKey(d.name)]: OFF };
  assert.deepEqual(A.soldKeys(m1, node), [d.key]);
  const renamed = JSON.parse(JSON.stringify(body));
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (String(o.id) === String(d.id) && o.name === d.name) o.name = `${d.name} (nuevo)`; Object.values(o).forEach(walk); } };
  walk(renamed);
  const m2 = CappMenu.adaptMenu(cappEnvelope('x_pizza', renamed, 'name'));
  assert.equal(m2.dishes.find((x) => String(x.id) === String(d.id)).name, `${d.name} (nuevo)`, 'premise: renamed');
  assert.ok(A.soldKeys(m2, node).includes(m2.dishes.find((x) => String(x.id) === String(d.id)).key), '🔴 a rename must not silently re-open a sold dish');
  assert.deepEqual(mapper().soldKeys(m2, node).filter((k) => String(m2.dish(k).id) === String(d.id)), [], 'a FRESH session (no history) sees only the new key');
});

// Codex r1 P2 (the exact repro, through the REAL form and the REAL boot): the first availability read FAILS → the dish is RENAMED →
// a successful read returns the OLD key false + the NEW key true. The form recorded the old key on its failed pass, so it says SOLD;
// the app must too — its history is recorded BEFORE every read (mapper.observe), never only after a success.
test('REGRESSION (Codex r1 P2): failed read → rename → old key false + new key true ⇒ the form and the app BOTH say sold', async () => {
  const dir = 'xpizza-orders', rid = BRAND[dir].rid, field = availIdentityField(rid);
  assert.equal(field, 'name', 'premise: x_pizza is keyed by NAME (a rename changes its key)');
  const RT = M.PLATFORM.appRuntime(), AVAIL = `${RT.availability_base}/restaurants/${rid}/item_availability.json`;
  const body1 = await servedBody(rid);
  const w = loadForm(dir); await settle();
  try {
    await serve(w, envelope(rid, body1, '1d.2'));
    const d = w.liveMenuGlobalGet('MENU').find((it) => it.name && w.document.getElementById('card-' + it.id));
    assert.ok(d, 'premise: a dish with a card (the form records keys for painted dishes)');
    const oldName = d.name, newName = `${d.name} (nuevo)`;
    // the app: the REAL boot with a scripted network
    let next; let opts;
    Boot.boot({}, { runtime: { mode: 'native', ...RT, flags: {}, sdk_base: './' }, CappShellUI: { mount: (x, o) => { opts = o; return {}; } }, CappSignupApi: { ENDPOINTS: [] },
      CappAvailability, availabilityReducer: Reducer, availKey, fetch: async (u) => { assert.equal(u, AVAIL); return next(); } });
    // 1. the first read FAILS — on both
    w.__respond = (u) => (String(u) === AVAIL ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) }) : new Promise(() => {}));
    await w.loadAvailability(); await settle();
    next = () => ({ status: 503, json: async () => ({}) });
    const m1 = CappMenu.adaptMenu(cappEnvelope(rid, body1, field));
    assert.equal(await opts.readAvailability(rid, m1), null, 'premise: the failed read is fail-open');
    // 2. the dish is RENAMED — the form gets the new body through its real live-menu path; the app adapts the new envelope
    const body2 = JSON.parse(JSON.stringify(body1));
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (String(o.id) === String(d.id) && o.name === oldName) o.name = newName; Object.values(o).forEach(walk); } };
    walk(body2);
    await serve(w, envelope(rid, body2, '1d.2'));
    const fd = w.liveMenuGlobalGet('MENU').find((it) => String(it.id) === String(d.id));
    assert.equal(fd && fd.name, newName, 'premise: the form holds the renamed dish');
    const m2 = CappMenu.adaptMenu(cappEnvelope(rid, body2, field)), ad = m2.dishes.find((x) => String(x.id) === String(d.id));
    assert.equal(ad.name, newName, 'premise: the app holds the renamed dish');
    // 3. a successful read: the OLD key false, the NEW key true
    const node = { [availKey(oldName)]: OFF, [availKey(newName)]: ON };
    w.__respond = (u) => (String(u) === AVAIL ? Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(node)) }) : new Promise(() => {}));
    await w.loadAvailability(); await settle();
    assert.equal(w.ownSoldOut(fd), true, 'premise: the FORM says sold (it recorded the old key on its failed pass)');
    next = () => ({ status: 200, json: async () => JSON.parse(JSON.stringify(node)) });
    const sold = await opts.readAvailability(rid, m2);
    assert.ok(Array.isArray(sold) && sold.includes(ad.key), '🔴 Codex r1 P2: the app says AVAILABLE where the form says sold (history recorded only after a successful read)');
    assert.deepEqual(mapper().soldKeys(m2, node).filter((k) => k === ad.key), [], 'non-vacuity: with NO history the same node reads available — the recorded old key is what decides');
  } finally { closeAll(); }
});
