// «Envío» step 1 (PLAN-portal-envio-step1 r2 §3, §6–§8; build conditions C1–C2) — the Sherpa-admin delivery-fee SCREEN under a
// REAL DOM: jsdom over the shipped index.html with the REAL app.js, ventas.js, shell.js and envio.js (auth.js stubbed).
// The server is 5f's REAL getDeliveryPricingCore / setDeliveryPricingCore (xpizza-functions/delivery/pricing-admin-core.js,
// 0021632f) over the functions suites' own faithful in-memory RTDB (test/_fake-rtdb-sdk.js, strict) — never a hand-built 200.
// On top of it, a TRANSPORT layer that can fail AFTER the commit (a 503, a dropped connection, a body that doesn't parse), so the
// UNKNOWN → fresh-GET recovery is proven against a write that really landed. Run: node --test xpizza-portal/envio-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, settle } from './ventas-harness.mjs';
import { MAP_ORIGIN, PORTAL_ORIGIN, childMessage } from './envio-map-protocol.js';

const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const { fakeRtdb } = require('../xpizza-functions/test/_fake-rtdb-sdk.js');
const CORE = require('../xpizza-functions/delivery/pricing-admin-core.js');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');

const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, name) => ({ rid, brand_id: 'marca_e', role: 'owner', state: 'member', caps: OWNER_CAPS, name, identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
const E1 = (over = {}) => ({ brands: [{ brand_id: 'marca_e', name: 'Pizzería Del Valle' }], branches: [branch('r_cen', 'Centro')], membership_writes_enabled: false, ...over });
const POLICY = (version, bands) => ({ policy_version: version, bands, history: [], updated_at: 1, updated_by: 'uAdmin' });
const B3 = [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 5000 }];
// the platform's restaurants, as getDeliveryPricing's directory reads them (registry + identity + brand name)
const WORLD = {
  ids: ['r_xp', 'r_lm', 'r_far'],
  restaurants: {
    r_xp: { identity: { brand_id: 'b_xp', name: 'X. Pizza', location_name: 'Centro', hub_lat: 15.5075, hub_lng: -88.0398 } },
    r_lm: { identity: { brand_id: 'b_lm', name: 'La Musa', location_name: 'Centro', hub_lat: 15.5041, hub_lng: -88.0385 } },
    r_far: { identity: { brand_id: 'b_far', name: 'Sin Pin', location_name: 'Norte' } },
  },
  brands: { b_xp: { name: 'X. Pizza' }, b_lm: { name: 'La Musa' }, b_far: { name: 'Sin Pin' } },
};

// ── the server: 5f's REAL cores over the faithful fake RTDB, plus a transport layer ─────────────────────────────────────────
function server({ policy = POLICY(3, B3), admins = { uAdmin: true }, registry } = {}) {
  const db = fakeRtdb({ platform_admins: admins, ...(policy ? { platform_config: { delivery_pricing: policy } } : {}), restaurants: WORLD.restaurants, brands: WORLD.brands }, { strict: true });
  const srv = {
    db, uid: null, at: 0, commits: 0, posts: [], gets: 0,
    fault: { post: null, get: null },   // post: 'before503' | 'after503' | 'afterDrop' | 'afterMalformed' | 'drop' ; get: 'fail' | 'hold'
    hold: { get: null, post: null },
  };
  const deps = () => ({ db, verifyIdToken: async (t) => { if (t !== 'TK-test' || !srv.uid) throw new Error('bad'); return { uid: srv.uid }; },
    timestamp: () => ++srv.at, readRegistry: registry || (async () => ({ ok: true, fresh: true, ids: WORLD.ids })) });
  const req = (body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer TK-test' : null), body });
  const answer = (out) => (out.status === 200 ? okJson(out.body) : { ok: false, status: out.status, json: async () => out.body, text: async () => JSON.stringify(out.body), headers: { get: () => null } });
  const ver = () => { const v = db.ref(CORE.PATH); return v; };
  srv.version = async () => { const n = (await ver().once('value')).val(); return n ? n.policy_version : 0; };
  srv.node = async () => (await db.ref(CORE.PATH).once('value')).val();
  srv.handle = async (fn, body) => {
    if (fn === 'getDeliveryPricing') {
      srv.gets++;
      if (srv.hold.get) await srv.hold.get;
      if (srv.fault.get === 'fail') { srv.fault.get = null; throw new TypeError('Failed to fetch'); }
      return answer(await CORE.getDeliveryPricingCore(deps(), req(undefined)));
    }
    if (fn === 'setDeliveryPricing') {
      srv.posts.push(body);
      if (srv.hold.post) await srv.hold.post;
      const f = srv.fault.post; srv.fault.post = null;
      if (f === 'drop') throw new TypeError('Failed to fetch');
      if (f === 'before503') return answer({ status: 503, body: { error: 'unavailable', retryable: true } });
      const before = await srv.version();
      const out = await CORE.setDeliveryPricingCore(deps(), req(body));
      if ((await srv.version()) !== before) srv.commits++;
      if (f === 'after503') return answer({ status: 503, body: { error: 'unavailable', retryable: true } });
      if (f === 'afterDrop') throw new TypeError('Failed to fetch');
      if (f === 'afterMalformed') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }, text: async () => '', headers: { get: () => null } };
      return answer(out);
    }
    return null;
  };
  return srv;
}

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__envio-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => { if (globalThis.__tokenHold) await globalThis.__tokenHold; const f = globalThis.__onToken; if (f) { globalThis.__onToken = null; queueMicrotask(f); } return globalThis.__tokenValue === undefined ? "TK-test" : globalThis.__tokenValue; };\n'
    + 'export const login = async () => {};\nexport const logout = async () => {};\nexport const watchAuth = () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__envio-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__envio-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'envio']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__envio-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

let lastPage = null;   // each new page signs the previous one out: its view unmounts and its map timers stop (no cross-test leaks)
async function page({ e1 = E1({ platform_admin: true }), srv = server(), cache = null, uid = 'uAdmin', e1Cache = null } = {}) {
  if (lastPage) { try { lastPage.d.dispatchEvent(new lastPage.w.CustomEvent('portal:auth', { detail: { uid: null } })); } catch (_) { /* gone */ } lastPage = null; }
  const dom = new JSDOM(HTML, { url: `${PORTAL_ORIGIN}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true });
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (cache) w.sessionStorage.setItem(`sherpa.portal.envio.${uid}`, JSON.stringify(cache));
  if (e1Cache) w.sessionStorage.setItem(`sherpa.portal.branches.${uid}`, JSON.stringify(e1Cache));
  globalThis.__branchesDirect = true;
  globalThis.__tokenHold = null;
  globalThis.__tokenValue = undefined;
  const st = { e1 };
  const calls = installFetch(async (fn) => {
    const last = calls[calls.length - 1];
    if (fn === 'getMyBranches') { if (st.holdE1) await st.holdE1; return okJson(st.e1); }
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    if (fn === 'getEditableCatalog') return okJson({ source: { restaurant_id: 'r_cen', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v1' });
    const r = await srv.handle(fn, last && last.body);
    if (r) return r;
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }), text: async () => '', headers: { get: () => null } };
  });
  const mods = await loadAll();
  mods.envio._envioTiming.deadlineMs = 5000;   // a timeout cell shortens it before opening
  const d = w.document;
  const reg = () => mods.shell._registered.find((r) => r.id === 'envio');
  const host = () => reg().main;
  const text = () => host().textContent.replace(/\s+/g, ' ');
  const btn = (label, root = host()) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const rows = () => [...host().querySelectorAll('.band')].map((b) => [b.querySelector('input[data-f="km"]').value, b.querySelector('input[data-f="fee"]').value]);
  const input = (i, f) => host().querySelectorAll('.band')[i].querySelector(`input[data-f="${f}"]`);
  const type = (i, f, v) => { const n = input(i, f); n.value = v; n.dispatchEvent(new w.Event('input')); };
  const bar = () => host().querySelector('.rbar');
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async (u = uid) => {
    srv.uid = u;
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: u } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(40);
  };
  const open = async () => { reg().nav.click(); await settle(30); };
  const frame = () => host().querySelector('iframe');
  const fromMap = (data, { origin = MAP_ORIGIN, source } = {}) => {
    w.dispatchEvent(new w.MessageEvent('message', { data, origin, source: source === undefined ? frame().contentWindow : source }));
  };
  const mount = () => mods.envio._envioState.map && mods.envio._envioState.map.mount;
  lastPage = { dom, w, d, mods, st, srv, calls, reg, host, text, btn, rows, input, type, bar, n, signIn, open, frame, fromMap, mount };
  return lastPage;
}
const posted = (P) => {   // what the parent posted to the map frame
  const out = [];
  const f = P.frame();
  if (!f.__spy) { f.__spy = out; const real = f.contentWindow.postMessage.bind(f.contentWindow); f.contentWindow.postMessage = (m, o) => { out.push([m, o]); try { real(m, o); } catch (_) { /* jsdom origin */ } }; }
  return f.__spy;
};

// ── gating ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('a merchant (no platform_admin) never gets the nav item, the chip, the view, a pricing request or a map frame', async () => {
  const P = await page({ e1: E1() });
  await P.signIn('uMerchant');
  assert.ok(P.reg().nav.classList.contains('hidden') && P.reg().mn.classList.contains('hidden'));
  assert.ok(P.d.getElementById('navadmlabel').classList.contains('hidden'), 'no «Sherpa · Admin» group label');
  P.mods.shell.goto('envio'); await settle(20);
  assert.ok(P.host().classList.contains('hidden'), 'a forced goto falls back to the default view');
  assert.equal(P.n('getDeliveryPricing').length, 0);
  assert.equal(P.d.querySelector('iframe'), null);
});

test('an admin gets «Sherpa · Admin» → «Envío» (gold inset when on), the «Envío Admin» chip and the neutral admin scope', async () => {
  const P = await page();
  await P.signIn();
  const label = P.d.getElementById('navadmlabel');
  assert.ok(!label.classList.contains('hidden'));
  assert.equal(label.textContent.replace(/\s+/g, ' ').trim(), 'Sherpa Admin');
  assert.ok(P.reg().nav.classList.contains('adm') && !P.reg().nav.classList.contains('hidden'));
  assert.equal(P.reg().mn.textContent.replace(/\s+/g, ' ').trim(), 'Envío Admin');
  assert.ok(P.reg().mn.querySelector('.adm-tag'));
  assert.equal(label.compareDocumentPosition(P.reg().nav) & P.w.Node.DOCUMENT_POSITION_FOLLOWING, P.w.Node.DOCUMENT_POSITION_FOLLOWING, 'the item sits under its label');
  assert.ok(!P.d.getElementById('app').classList.contains('admview'));
  await P.open();
  assert.ok(P.d.getElementById('app').classList.contains('admview'), 'the neutral «Sherpa · Todas las marcas» scope shows on the admin view');
  assert.ok(P.reg().nav.classList.contains('on'));
  P.d.getElementById('switcher').click();
  assert.ok(P.d.getElementById('switchmenu').classList.contains('hidden'), 'the switcher opens nothing on an admin view');
  P.d.getElementById('navprod').click(); await settle();
  assert.ok(!P.d.getElementById('app').classList.contains('admview'), 'leaving restores the restaurant scope');
});

// ── first paint / loading ───────────────────────────────────────────────────────────────────────────────────────────────
test('first paint comes from the session cache BEFORE the GET answers; the fresh answer then swaps in place', async () => {
  const srv = server({ policy: POLICY(4, [{ max_km: 2.5, cents: 3000 }]) });
  let release; srv.hold.get = new Promise((r) => { release = r; });
  const P = await page({ srv, cache: { policy_version: 3, bands: B3, branches: [] } });
  await P.signIn();
  await P.open();
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '50']], 'painted from the cache with the GET still pending');
  release(); await settle(30);
  assert.deepEqual(P.rows(), [['2.5', '30']], 'the fresh policy swapped in');
  assert.equal(JSON.parse(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin')).policy_version, 4, 're-cached');
});

test('no cache: the table area is reserved and quiet (no rule speaks) until the answer; then the policy and the picker fill it', async () => {
  const srv = server();
  let release; srv.hold.get = new Promise((r) => { release = r; });
  const P = await page({ srv });
  await P.signIn(); await P.open();
  assert.equal(P.host().querySelectorAll('.band').length, 1);
  assert.ok(!/Falta/.test(P.text()), 'no validation text before the answer');
  assert.ok(P.input(0, 'km').disabled);
  release(); await settle(30);
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '50']]);
  assert.equal(P.host().querySelector('.pick b').textContent, 'La Musa', 'the first branch with a pin, es-sorted (no brand named in code)');
  assert.equal(P.host().querySelector('.pick .pk span').textContent, '1 sucursal');
});

// ── editing / validation (frame 2) ──────────────────────────────────────────────────────────────────────────────────────
test('frame 2: a 12 km band is refused inline; the limit shows the last VALID band; Guardar disabled; legend «Tramo rechazado»', async () => {
  const P = await page({ srv: server({ policy: POLICY(3, [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 6000 }, { max_km: 10, cents: 8000 }]) }) });
  await P.signIn(); await P.open();
  P.btn('Agregar tramo').click();
  const km = P.input(3, 'km');
  P.type(3, 'km', '12'); P.type(3, 'fee', '100');
  assert.equal(P.input(3, 'km'), km, 'typing never rebuilds the row (the caret stays)');
  const row = P.host().querySelectorAll('.band')[3];
  assert.equal(row.querySelector('.berr').textContent, 'Máximo 10 km. Más lejos no entregamos.');
  assert.ok(km.parentElement.classList.contains('bad'));
  assert.equal(km.getAttribute('aria-invalid'), 'true');
  assert.equal(km.getAttribute('aria-describedby'), row.querySelector('.berr').id);
  assert.equal(P.host().querySelector('.limit').textContent.replace(/\s+/g, ' '), 'Límite de entrega · el último tramo válido10 km');
  assert.ok(P.bar().classList.contains('show'));
  assert.equal(P.bar().querySelector('.rb-t').textContent, 'Corregí 1 tramo para poder guardar');
  assert.ok(P.bar().querySelector('.ebdot').classList.contains('ered'));
  assert.ok(P.btn('Guardar', P.bar()).disabled);
  assert.ok(!P.btn('Descartar', P.bar()).disabled, 'Descartar always works');
  assert.deepEqual([...P.host().querySelectorAll('.legend span')].map((s) => s.textContent), ['Tramo de tarifa', 'Límite de entrega', 'Tramo rechazado']);
  assert.ok(P.text().includes('El tramo de 12 km no se dibuja como entrega: queda fuera del máximo de 10 km.'));
  P.btn('Descartar', P.bar()).click(); await settle();
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '60'], ['10', '80']]);
  assert.ok(!P.bar().classList.contains('show'));
});

test('add / remove: 20 rows disable «Agregar tramo» with «Máximo 20 tramos.»; the last row can\'t be removed («Dejá al menos un tramo.»)', async () => {
  const P = await page({ srv: server({ policy: POLICY(3, [{ max_km: 3, cents: 4000 }]) }) });
  await P.signIn(); await P.open();
  P.host().querySelector('.bdel').click(); await settle();
  assert.equal(P.host().querySelectorAll('.band').length, 1);
  assert.ok(P.text().includes('Dejá al menos un tramo.'));
  for (let i = 0; i < 19; i++) P.btn('Agregar tramo').click();
  assert.equal(P.host().querySelectorAll('.band').length, 20);
  assert.ok(P.btn('Agregar tramo').disabled);
  assert.ok(P.text().includes('Máximo 20 tramos.'));
});

// ── confirm + save (frame 3) through the REAL writer ────────────────────────────────────────────────────────────────────
async function editTo10(P) {   // 3/40 6/50 → 3/40 6/60 10/80 (Igual · Cambia · Nuevo, limit 6 → 10)
  P.type(1, 'fee', '60');
  P.btn('Agregar tramo').click();
  P.type(2, 'km', '10'); P.type(2, 'fee', '80');
  await settle();
}
test('frame 3: the confirm is a diff — Igual / Cambia / Nuevo, the limit callout; «Guardar tarifas» writes through the REAL writer', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  assert.equal(P.bar().querySelector('.rb-t').textContent, 'Cambios sin guardar');
  P.btn('Guardar', P.bar()).click(); await settle();
  const m = P.host().querySelector('[role="dialog"]');
  assert.ok(m);
  assert.equal(m.querySelector('h2').textContent, 'Confirmar tarifas de envío');
  assert.deepEqual([...m.querySelectorAll('.edrow')].map((r) => r.textContent), ['Hasta 3 kmL 40Igual', 'Hasta 6 kmL 50L 60Cambia', 'Hasta 10 kmL 80Nuevo']);
  assert.equal(m.querySelector('.ecallout').textContent,
    'El límite de entrega pasa de 6 km a 10 km para todos los restaurantes. Las direcciones entre 6 y 10 km ya se pueden pedir desde que guardés.');
  assert.equal(P.d.activeElement.textContent, 'Volver');
  P.btn('Guardar tarifas', m).click(); await settle(30);
  assert.deepEqual(P.srv.posts, [{ expected_policy_version: 3, bands: [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 6000 }, { max_km: 10, cents: 8000 }] }]);
  const node = await P.srv.node();
  assert.equal(node.policy_version, 4);
  assert.deepEqual(node.bands, [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 6000 }, { max_km: 10, cents: 8000 }]);
  assert.equal(P.host().querySelector('[role="dialog"]'), null);
  assert.equal(P.d.getElementById('opstoast').textContent, 'Tarifas guardadas');
  assert.ok(!P.bar().classList.contains('show'));
  assert.equal(JSON.parse(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin')).policy_version, 4);
});

test('superseded: another writer moved the version → the conflict box (the owner\'s sentence), the draft dropped, no bar; «Recargar» re-reads', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  await P.srv.db.ref(CORE.PATH).set(POLICY(4, [{ max_km: 5, cents: 7000 }]));   // someone else saved meanwhile
  P.btn('Guardar', P.bar()).click(); await settle();
  P.btn('Guardar tarifas').click(); await settle(30);
  assert.ok(P.text().includes('Alguien más cambió las tarifas, recargá'));
  assert.ok(P.text().includes('Tus cambios no se guardaron. Recargá para ver la versión actual y volvé a editar sobre ella.'));
  assert.ok(!P.bar().classList.contains('show'), 'the save bar hides while the banner shows');
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '50']], 'the draft is NOT kept');
  assert.ok(P.input(0, 'km').disabled);
  P.btn('Recargar').click(); await settle(30);
  assert.deepEqual(P.rows(), [['5', '70']]);
  assert.ok(!P.text().includes('Alguien más'));
  assert.equal((await P.srv.node()).policy_version, 4, 'nothing written by us');
});

for (const [label, fault] of [['commit, then a 503', 'after503'], ['commit, then the connection drops', 'afterDrop'], ['commit, then a 200 that does not parse', 'afterMalformed']]) {
  test(`UNKNOWN (${label}) → a FRESH GET finds expected+1 with the SENT bands → SAVED; one commit, one POST`, async () => {
    const P = await page();
    await P.signIn(); await P.open();
    await editTo10(P);
    P.btn('Guardar', P.bar()).click(); await settle();
    const getsBefore = P.srv.gets;
    P.srv.fault.post = fault;
    P.btn('Guardar tarifas').click(); await settle(40);
    assert.equal(P.srv.commits, 1);
    assert.equal(P.srv.posts.length, 1, 'never a second POST');
    assert.equal(P.srv.gets, getsBefore + 1, 'one recovery GET');
    assert.equal(P.d.getElementById('opstoast').textContent, 'Tarifas guardadas');
    assert.ok(!P.text().includes('No se pudieron guardar'));
    assert.equal((await P.srv.node()).policy_version, 4);
  });
}

test('not landed (a 503 before the commit): the error box keeps the draft; «Reintentar» resends the SAME attempt → one commit', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  P.btn('Guardar', P.bar()).click(); await settle();
  P.srv.fault.post = 'before503';
  P.btn('Guardar tarifas').click(); await settle(40);
  assert.ok(P.text().includes('No se pudieron guardar las tarifas'));
  assert.ok(P.text().includes('Tus cambios siguen acá. Revisá tu internet y volvé a intentar; si sigue igual, escribinos.'));
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '60'], ['10', '80']], 'the draft is kept');
  assert.ok(P.input(0, 'km').disabled, 'frozen to the attempt');
  assert.ok(P.bar().classList.contains('show'));
  assert.equal(P.srv.commits, 0);
  P.btn('Reintentar').click(); await settle(40);
  assert.equal(P.srv.posts.length, 2);
  assert.deepEqual(P.srv.posts[1], P.srv.posts[0], 'the SAME attempt (same version, same bands)');
  assert.equal(P.srv.commits, 1);
  assert.equal(P.d.getElementById('opstoast').textContent, 'Tarifas guardadas');
});

test('a failed recovery GET stays UNKNOWN: the error box, the attempt kept; «Reintentar» re-reads first and never re-POSTs a landed write', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  P.btn('Guardar', P.bar()).click(); await settle();
  P.srv.fault.post = 'afterDrop';
  P.srv.fault.get = 'fail';
  P.btn('Guardar tarifas').click(); await settle(40);
  assert.equal(P.srv.commits, 1);
  assert.ok(P.text().includes('No se pudieron guardar las tarifas'));
  assert.equal(P.mods.envio._envioState.phase, 'unknown');
  assert.ok(P.mods.envio._envioState.attempt, 'the attempt is kept');
  P.btn('Reintentar').click(); await settle(40);
  assert.equal(P.srv.posts.length, 1, 'no blind resend');
  assert.equal(P.d.getElementById('opstoast').textContent, 'Tarifas guardadas');
  assert.equal(P.srv.commits, 1);
});

test('while an attempt is in flight editing is frozen, and a revalidation answer changes neither the attempt nor the draft', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  P.btn('Guardar', P.bar()).click(); await settle();
  let release; P.srv.hold.post = new Promise((r) => { release = r; });
  P.btn('Guardar tarifas').click(); await settle(10);
  const a = P.mods.envio._envioState.attempt;
  assert.ok(Object.isFrozen(a) && a.expectedVersion === 3);
  assert.ok(P.input(1, 'fee').disabled && P.btn('Agregar tramo').disabled);
  assert.ok(P.btn('Guardar tarifas').disabled, 'no double submit');
  P.reg().nav.click(); await settle(10);   // a second visit to the nav item is a no-op while mounted
  assert.equal(P.mods.envio._envioState.attempt, a);
  release(); await settle(30);
  assert.equal(P.srv.commits, 1);
});

test('sign-out during the token wait: nothing is sent', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  P.btn('Guardar', P.bar()).click(); await settle();
  let release; globalThis.__tokenHold = new Promise((r) => { release = r; });
  P.btn('Guardar tarifas').click(); await settle(5);
  P.d.dispatchEvent(new P.w.CustomEvent('portal:auth', { detail: { uid: null } }));
  globalThis.__tokenHold = null; release(); await settle(30);
  assert.equal(P.srv.posts.length, 0);
  assert.equal(P.srv.commits, 0);
});

test('no token at send time (still on the page): nothing is sent; the error box keeps the draft; «Reintentar» sends once a token is back', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  P.btn('Guardar', P.bar()).click(); await settle();
  globalThis.__tokenValue = '';
  P.btn('Guardar tarifas').click(); await settle(30);
  assert.equal(P.srv.posts.length, 0);
  assert.ok(P.text().includes('No se pudieron guardar las tarifas'));
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '60'], ['10', '80']]);
  globalThis.__tokenValue = undefined;
  P.btn('Reintentar').click(); await settle(40);
  assert.equal(P.srv.posts.length, 1);
  assert.equal(P.srv.commits, 1);
});

test('a save answer that lands AFTER sign-out never says «Tarifas guardadas» nor re-caches (C1)', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  await editTo10(P);
  P.btn('Guardar', P.bar()).click(); await settle();
  let release; P.srv.hold.post = new Promise((r) => { release = r; });
  P.btn('Guardar tarifas').click(); await settle(10);
  P.d.dispatchEvent(new P.w.CustomEvent('portal:auth', { detail: { uid: null } })); await settle();
  release(); await settle(40);
  assert.equal(P.srv.commits, 1, 'premise: the write did land');
  assert.notEqual(P.d.getElementById('opstoast').textContent, 'Tarifas guardadas');
  assert.equal(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin'), null);
});

test('sign-out clears this session\'s envío cache (shell clearPersisted)', async () => {
  const P = await page();
  await P.signIn(); await P.open();
  assert.ok(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin'), 'premise: cached');
  P.d.dispatchEvent(new P.w.CustomEvent('portal:auth', { detail: { uid: null } })); await settle();
  assert.equal(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin'), null);
});

// ── malformed / first policy ────────────────────────────────────────────────────────────────────────────────────────────
test('no policy yet (version 0): one empty row with the hints, Guardar disabled until valid; the first save says «queda en»', async () => {
  const P = await page({ srv: server({ policy: null }) });
  await P.signIn(); await P.open();
  assert.deepEqual(P.rows(), [['', '']]);
  assert.ok(P.text().includes('Falta la distancia.'));
  assert.ok(P.btn('Guardar', P.bar()).disabled);
  P.type(0, 'km', '4'); P.type(0, 'fee', '35'); await settle();
  assert.ok(!P.btn('Guardar', P.bar()).disabled);
  P.btn('Guardar', P.bar()).click(); await settle();
  assert.equal(P.host().querySelector('[role="dialog"] .ecallout').textContent, 'El límite de entrega queda en 4 km para todos los restaurantes.');
  P.btn('Guardar tarifas').click(); await settle(30);
  assert.equal((await P.srv.node()).policy_version, 1);
});

test('malformed with a VALID version: the box + an empty table, and a save REPLACES it through the real writer', async () => {
  const P = await page({ srv: server({ policy: { policy_version: 5, bands: 'nope', history: [], updated_at: 1, updated_by: 'x' } }) });
  await P.signIn(); await P.open();
  assert.ok(P.text().includes('No pudimos leer las tarifas guardadas.') && P.text().includes('Guardá una tabla nueva para reemplazarlas.'));
  assert.deepEqual(P.rows(), [['', '']]);
  P.type(0, 'km', '5'); P.type(0, 'fee', '50'); await settle();
  P.btn('Guardar', P.bar()).click(); await settle();
  P.btn('Guardar tarifas').click(); await settle(30);
  const node = await P.srv.node();
  assert.equal(node.policy_version, 6);
  assert.deepEqual(node.bands, [{ max_km: 5, cents: 5000 }]);
});

test('malformed with an INVALID version: «…Escribinos.», read-only, no save bar — never a save loop', async () => {
  const P = await page({ srv: server({ policy: { policy_version: 'x', bands: [] } }) });
  await P.signIn(); await P.open();
  assert.ok(P.text().includes('No pudimos leer las tarifas guardadas.') && P.text().includes('Escribinos.'));
  assert.ok(P.input(0, 'km').disabled);
  assert.ok(!P.bar().classList.contains('show'));
});

// ── session hygiene (F4 / C1) ───────────────────────────────────────────────────────────────────────────────────────────
test('a FORGED cached flag shows the nav, but the server refuses: «No tenés acceso a esta sección.», the cache cleared', async () => {
  const P = await page({ srv: server({ admins: {} }), cache: { policy_version: 3, bands: B3, branches: [] } });
  await P.signIn(); await P.open();
  assert.ok(P.text().includes('No tenés acceso a esta sección.'));
  assert.equal(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin'), null);
  assert.equal(P.host().querySelector('.band'), null, 'nothing cached is shown');
});

test('revocation by a fresh E1 (even a PARTIAL one): the nav goes, the view is left, the cache and the frame are gone', async () => {
  // a reload: the CACHED E1 still says admin; the fresh one is PARTIAL (a degraded row) and has no platform_admin
  let release;
  const P = await page({ e1: E1({ branches: [{ ...branch('r_cen', 'Centro'), degraded: true }] }), e1Cache: E1({ platform_admin: true }),
    cache: { policy_version: 3, bands: B3, branches: [] } });
  P.st.holdE1 = new Promise((r) => { release = r; });
  P.srv.uid = 'uAdmin';
  P.d.dispatchEvent(new P.w.CustomEvent('portal:auth', { detail: { uid: 'uAdmin' } }));
  P.d.dispatchEvent(new P.w.CustomEvent('portal:signed-in'));
  await settle(30);
  await P.open(); await settle(10);
  assert.ok(!P.host().classList.contains('hidden') && P.frame(), 'premise: open from the cached admin E1, the frame up');
  release(); await settle(40);
  assert.ok(P.reg().nav.classList.contains('hidden'));
  assert.ok(P.host().classList.contains('hidden'));
  assert.equal(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin'), null);
  assert.equal(P.d.querySelector('iframe'), null);
});

test('a late GET after sign-out never repaints or re-caches (C1: the generation moves first)', async () => {
  const srv = server();
  let release; srv.hold.get = new Promise((r) => { release = r; });
  const P = await page({ srv });
  await P.signIn(); await P.open();
  P.d.dispatchEvent(new P.w.CustomEvent('portal:auth', { detail: { uid: null } }));
  release(); await settle(30);
  assert.equal(P.w.sessionStorage.getItem('sherpa.portal.envio.uAdmin'), null);
});

test('UID switch: the next account never reads the previous account\'s envío cache', async () => {
  const P = await page({ cache: { policy_version: 9, bands: [{ max_km: 9, cents: 9900 }], branches: [] }, uid: 'uOther' });
  await P.signIn('uAdmin');
  const srvHold = new Promise(() => {});   // the GET never answers: only the cache could paint
  P.srv.hold.get = srvHold;
  await P.open();
  assert.ok(!P.rows().some(([k]) => k === '9'), 'uOther\'s cache is not this session\'s');
});

// ── the map frame (C2) ──────────────────────────────────────────────────────────────────────────────────────────────────
test('C2 handshake: listening → the latest render (exact origin, this mount); only ready clears the deadline; a wrong origin / source / mount is dropped', async () => {
  const P = await page();
  await P.signIn(); await P.open(); await settle(5);
  const f = P.frame();
  assert.ok(f, 'the frame is created after first paint');
  assert.equal(f.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  assert.equal(f.getAttribute('src'), `${MAP_ORIGIN}/map.html#m=${P.mount()}`);
  const out = posted(P);
  P.fromMap(childMessage('listening', P.mount()), { origin: PORTAL_ORIGIN }); await settle();
  P.fromMap(childMessage('listening', P.mount()), { source: P.w }); await settle();
  P.fromMap(childMessage('listening', 'b'.repeat(32))); await settle();
  assert.equal(out.length, 0, 'dropped: wrong origin, wrong source, wrong mount');
  P.fromMap(childMessage('listening', P.mount())); await settle();
  assert.equal(out.length, 1);
  assert.equal(out[0][1], MAP_ORIGIN, 'exact targetOrigin, never *');
  assert.equal(out[0][0].kind, 'render');
  assert.equal(out[0][0].mount, P.mount());
  assert.deepEqual(out[0][0].hub, { lat: 15.5041, lng: -88.0385 });
  assert.deepEqual(out[0][0].bands, [{ km: 3, fee: 4000, ok: true }, { km: 6, fee: 5000, ok: true }]);
  P.type(1, 'km', '12'); await settle();
  assert.deepEqual(out[out.length - 1][0].bands, [{ km: 3, fee: 4000, ok: true }, { km: 12, fee: 5000, ok: false }], 'input re-renders the rings (view keep)');
  assert.equal(out[out.length - 1][0].view, 'keep');
});

test('C2: `listening` alone never clears the absolute deadline — only `ready` does', async () => {
  const P = await page();
  P.mods.envio._envioTiming.deadlineMs = 1000;
  await P.signIn(); await P.open(); await settle(5);
  P.fromMap(childMessage('listening', P.mount())); await settle();
  assert.ok(!P.text().includes('No se pudo cargar el mapa.'));
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(P.text().includes('No se pudo cargar el mapa.'), 'the deadline fired: listening is not ready');
});

test('ready in time clears the deadline; a failed / auth refusal / timeout shows ONE line in the box (no shift) + one console.warn without the key', async () => {
  const warns = []; const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const P = await page();
    P.mods.envio._envioTiming.deadlineMs = 1000;
    await P.signIn(); await P.open(); await settle(5);
    P.fromMap(childMessage('listening', P.mount())); P.fromMap(childMessage('ready', P.mount()));
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(!P.text().includes('No se pudo cargar el mapa.'), 'ready cleared the deadline');
    P.fromMap(childMessage('failed', P.mount(), 'auth_failure')); await settle();
    assert.ok(!P.text().includes('No se pudo cargar el mapa.'), 'a failure AFTER ready is ignored');

    const Q = await page();
    Q.mods.envio._envioTiming.deadlineMs = 1000;
    await Q.signIn(); await Q.open(); await settle(5);
    const box = Q.host().querySelector('.emap');
    const before = box.children.length;
    Q.fromMap(childMessage('failed', Q.mount(), 'auth_failure')); await settle();
    assert.equal(box.querySelector('.mapline').textContent, 'No se pudo cargar el mapa.');
    assert.ok(box.contains(box.querySelector('.mapline')) && box.children.length === before, 'the line lives INSIDE the fixed box: nothing below moves');
    assert.ok(warns.some((x) => x === 'envio map: auth_failure'));
    assert.ok(!warns.some((x) => /AIza|key=/.test(x)), 'no key in the warning');
    Q.fromMap(childMessage('ready', Q.mount())); await settle();
    assert.equal(box.querySelector('.mapline').textContent, 'No se pudo cargar el mapa.', 'a late ready after failure is ignored');
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(warns.filter((x) => x.startsWith('envio map')), ['envio map: auth_failure'], 'one warning, not a second for the timeout');
  } finally { console.warn = realWarn; }
});

test('picker: search focused on open, filters, Enter picks, Esc closes; a pick re-renders with view reset; a branch with no pin says so', async () => {
  const P = await page();
  await P.signIn(); await P.open(); await settle(5);
  const out = posted(P);
  P.fromMap(childMessage('listening', P.mount())); await settle();
  P.host().querySelector('.pick').click(); await settle();
  const search = P.host().querySelector('.psearch input');
  assert.equal(P.d.activeElement, search);
  assert.equal(search.placeholder, 'Buscar restaurante o sucursal');
  assert.deepEqual([...P.host().querySelectorAll('.pitem .pt')].map((x) => x.textContent), ['La Musa', 'Sin Pin', 'X. Pizza']);
  assert.ok(P.host().querySelector('.pitem.pcur svg'), 'the current choice carries the check');
  search.value = 'pizza'; search.dispatchEvent(new P.w.Event('input'));
  assert.deepEqual([...P.host().querySelectorAll('.pitem .pt')].map((x) => x.textContent), ['X. Pizza']);
  search.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter' })); await settle();
  assert.equal(P.host().querySelector('.pick b').textContent, 'X. Pizza');
  assert.equal(P.d.activeElement, P.host().querySelector('.pick'));
  const last = out[out.length - 1][0];
  assert.equal(last.view, 'reset');
  assert.deepEqual(last.hub, { lat: 15.5075, lng: -88.0398 });
  assert.deepEqual(last.others, [{ lat: 15.5041, lng: -88.0385 }]);
  P.host().querySelector('.pick').click(); await settle();
  const s2 = P.host().querySelector('.psearch input');
  s2.value = 'sin'; s2.dispatchEvent(new P.w.Event('input'));
  s2.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter' })); await settle();
  assert.equal(P.host().querySelector('.mapline').textContent, 'Esta sucursal no tiene ubicación todavía.');
  P.host().querySelector('.pick').click(); await settle();
  P.host().querySelector('.psearch input').dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Escape' })); await settle();
  assert.ok(P.host().querySelector('.pickmenu').classList.contains('hidden'));
});

test('the map caption (mockup .mz; advisor ruling (a), Maps terms keep Google\'s logo visible): the picked label, follows a pick, gone with the line', async () => {
  // X. Pizza gets a second branch, so the picker LABEL («X. Pizza · Centro») differs from the brand name
  const srv = server({ registry: async () => ({ ok: true, fresh: true, ids: [...WORLD.ids, 'r_xp2'] }) });
  await srv.db.ref('restaurants/r_xp2/identity').set({ brand_id: 'b_xp', name: 'X. Pizza', location_name: 'Norte', hub_lat: 15.53, hub_lng: -88.03 });
  const P = await page({ srv });
  await P.signIn(); await P.open(); await settle(5);
  const chip = () => P.host().querySelector('.emap .emz');
  assert.ok(chip(), 'the caption chip is in the map box');
  assert.equal(chip().textContent, 'Anillos desde el pin de La Musa. Línea recta, no calles.');
  assert.ok(!chip().classList.contains('hidden'));
  P.host().querySelector('.pick').click(); await settle();
  const search = P.host().querySelector('.psearch input');
  search.value = 'pizza'; search.dispatchEvent(new P.w.Event('input'));
  search.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter' })); await settle();
  assert.equal(P.host().querySelector('.pick b').textContent, 'X. Pizza · Centro');
  assert.equal(chip().textContent, 'Anillos desde el pin de X. Pizza · Centro. Línea recta, no calles.');
  P.host().querySelector('.pick').click(); await settle();
  const s2 = P.host().querySelector('.psearch input');
  s2.value = 'sin'; s2.dispatchEvent(new P.w.Event('input'));
  s2.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: 'Enter' })); await settle();
  assert.equal(P.host().querySelector('.mapline').textContent, 'Esta sucursal no tiene ubicación todavía.');
  assert.ok(chip().classList.contains('hidden'), 'one line only: no caption over a box with no map');
});

test('the directory failed (branches_unavailable): the pricing still loads; the box says «No pudimos cargar las sucursales.»; no frame', async () => {
  const P = await page({ srv: server({ registry: async () => ({ ok: false }) }) });
  await P.signIn(); await P.open(); await settle(5);
  assert.deepEqual(P.rows(), [['3', '40'], ['6', '50']]);
  assert.equal(P.host().querySelector('.mapline').textContent, 'No pudimos cargar las sucursales.');
  assert.ok(P.host().querySelector('.pick').disabled);
  assert.equal(P.frame(), null);
});
