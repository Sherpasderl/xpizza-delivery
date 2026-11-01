// Customer app — the native shell's bootstrap (PLAN-capp-native-shell §1.2; BUILD-ORDER N2). The runtime comes from the REAL
// manifest (platform/sites.json → PLATFORM.appRuntime(), the D3 block); the shell is the REAL shell.html's own module list.
// Key values are never printed (assert.ok on equality). Run: node --test customer-app/capp-boot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');
const Boot = require('./capp-boot.js');
const CappSignupApi = require('./capp-signup-api.js');
const M = require(join(ROOT, 'xpizza-functions/platform-manifest.js'));
const LOCK = JSON.parse(readFileSync(join(ROOT, 'platform/native/vendor/firebasejs.lock.json'), 'utf8'));
const RT0 = M.PLATFORM.appRuntime();
const RT = (x = {}) => ({ mode: 'native', ...RT0, sdk_base: `./vendor/firebasejs/${LOCK.version}/`, flags: {}, ...x });
const res = (status, body, etag) => ({ status, headers: { get: (h) => (h === 'ETag' ? etag || null : null) }, json: async () => { if (body === 'bad') throw new Error('not json'); return body; } });
// a fake CappShellUI that captures the mount options (the unit cells); the integration cell mounts the REAL one
const capture = () => { const c = {}; return { c, CappShellUI: { mount: (doc, opts) => { c.doc = doc; c.opts = opts; return { fake: true }; } } }; };

test('N2: the order endpoint list is EXACTLY capp-api.js\'s (one source)', () => {
  const used = [...new Set([...readFileSync(join(HERE, 'capp-api.js'), 'utf8').matchAll(/\bE\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual([...Boot.ORDER_ENDPOINTS].sort(), used, '🔴 the boot builds a different endpoint set than capp-api calls');
});

test('N2: the runtime from the REAL manifest block — every endpoint on the ONE functions host; the keys passed through; every flag DARK when absent', () => {
  assert.ok(RT0 && typeof RT0.functions_base === 'string', 'premise: the manifest carries the app runtime (D3)');
  const r = Boot.runtimeFor(RT(), CappSignupApi);
  assert.deepEqual(Object.keys(r.endpoints).sort(), [...Boot.ORDER_ENDPOINTS].sort());
  for (const [n, u] of Object.entries(r.endpoints)) assert.equal(u, `${RT0.functions_base}/${n}`);
  assert.ok(r.intakeKey === RT0.intake_key && r.mapsKey === RT0.maps_key, 'the intake and Maps keys come from the manifest');
  for (const k of ['signup', 'intlPhone', 'guestCardOnly', 'schedulingLive']) assert.equal(k in r, false, `🔴 ${k} must be absent (dark) without its flag`);
  const on = Boot.runtimeFor(RT({ flags: { signup: true, intlPhone: true, guestCardOnly: true, schedulingLive: true } }), CappSignupApi);
  assert.deepEqual([on.intlPhone, on.guestCardOnly, on.schedulingLive], [true, true, true]);
  assert.deepEqual(Object.keys(on.signup.endpoints), [...CappSignupApi.ENDPOINTS], 'signup endpoints = CappSignupApi.ENDPOINTS');
  for (const [n, u] of Object.entries(on.signup.endpoints)) assert.equal(u, `${RT0.functions_base}/${n}`);
  assert.ok(on.signup.firebase === RT0.firebase, 'the Firebase web config is the manifest\'s');
  const truthy = Boot.runtimeFor(RT({ flags: { signup: 'yes', intlPhone: 1 } }), CappSignupApi);
  assert.equal('signup' in truthy || 'intlPhone' in truthy, false, 'only a literal true flips a flag');
});

test('N2: fetchEnvelope — getPublicMenu with the rid in the PATH, If-None-Match, 200 / 304 / 5xx / network / bad JSON', async () => {
  const calls = []; let next;
  const { c, CappShellUI } = capture();
  Boot.boot({}, { runtime: RT(), CappShellUI, CappSignupApi, fetch: async (u, i) => { calls.push([u, i]); return next(); } });
  const E = c.opts.fetchEnvelope;
  next = () => res(200, { rid: 'r_1', menu: 1 }, '"e1"');
  assert.deepEqual(await E('r_1', null), { status: 200, body: { rid: 'r_1', menu: 1 }, etag: '"e1"' });
  assert.equal(calls[0][0], `${RT0.functions_base}/${RT0.menu_endpoint}/menu/r_1`); assert.deepEqual(calls[0][1].headers, {}); assert.equal(calls[0][1].cache, 'no-store');
  next = () => res(304, null, '"e1"');
  assert.deepEqual(await E('r_1', '"e1"'), { status: 304, etag: '"e1"' }); assert.deepEqual(calls[1][1].headers, { 'If-None-Match': '"e1"' });
  next = () => res(503); assert.deepEqual(await E('r_1', null), { status: 503 });
  next = () => { throw new Error('offline'); }; assert.deepEqual(await E('r_1', null), { status: 0 });
  next = () => res(200, 'bad'); assert.deepEqual(await E('r_1', null), { status: 0 });
  await E('a/b?c', null); assert.equal(calls.at(-1)[0], `${RT0.functions_base}/${RT0.menu_endpoint}/menu/a%2Fb%3Fc`, 'the rid is path-encoded');
});

test('N2: fetchDirectory — no endpoint configured ⇒ { status: 0 } with NO request (the drawn directory failure); configured ⇒ its URL', async () => {
  const calls = [];
  const a = capture(); Boot.boot({}, { runtime: RT(), CappShellUI: a.CappShellUI, CappSignupApi, fetch: async (u) => { calls.push(u); return res(200, {}); } });
  assert.deepEqual(await a.c.opts.fetchDirectory(null), { status: 0 }); assert.equal(calls.length, 0);
  const b = capture(); Boot.boot({}, { runtime: RT({ directory_endpoint: 'dirX' }), CappShellUI: b.CappShellUI, CappSignupApi, fetch: async (u) => { calls.push(u); return res(200, { ok: 1 }, '"d"'); } });
  assert.deepEqual(await b.c.opts.fetchDirectory(null), { status: 200, body: { ok: 1 }, etag: '"d"' }); assert.equal(calls[0], `${RT0.functions_base}/dirX`);
});

test('N2: readAvailability is FAIL-OPEN null and never guesses an availability identity (advisor ruling; the envelope will carry it — LAUNCH BLOCKER)', async () => {
  let fetched = 0; const { c, CappShellUI } = capture();
  Boot.boot({}, { runtime: RT(), CappShellUI, CappSignupApi, fetch: async () => { fetched++; return res(200, { anything: false }); } });
  assert.equal(await c.opts.readAvailability('r_1', { dishes: [] }), null, '🔴 availability must stay fail-open until the identity is served');
  assert.equal(fetched, 0, 'no RTDB read while it cannot be mapped');
});

test('N2: loadSdk imports the BUNDLED SDK (the vendored, locked version) — never gstatic', async () => {
  const imported = []; const { c, CappShellUI } = capture();
  Boot.boot({}, { runtime: RT(), CappShellUI, CappSignupApi, importModule: async (p) => { imported.push(p); return p.endsWith('firebase-app.js') ? { initializeApp: 'IA' } : { auth: 'AM' }; } });
  const sdk = await c.opts.loadSdk();
  assert.deepEqual(imported, [`./vendor/firebasejs/${LOCK.version}/firebase-app.js`, `./vendor/firebasejs/${LOCK.version}/firebase-auth.js`]);
  assert.ok(imported.every((p) => !/gstatic|https?:/.test(p)), '🔴 a runtime SDK fetch');
  assert.deepEqual(sdk, { initializeApp: 'IA', authMod: { auth: 'AM' } });
  assert.equal('auth' in c.opts, false, 'no auth instance passed — the shell owns its CappAuthState under runtime.signup');
});

test('N2: other mount options pass through unchanged; no runtime ⇒ no mount', () => {
  const { c, CappShellUI } = capture(); const storage = {}, onEvent = () => {};
  Boot.boot({ d: 1 }, { runtime: RT(), CappShellUI, CappSignupApi, storage, onEvent, now: () => 5 });
  assert.equal(c.opts.storage, storage); assert.equal(c.opts.onEvent, onEvent); assert.equal(c.opts.now(), 5); assert.deepEqual(c.doc, { d: 1 });
  for (const k of ['fetch', 'importModule', 'CappShellUI', 'CappSignupApi']) assert.equal(k in c.opts, false, `${k} is the boot's, not the shell's`);
  let mounted = 0; const none = { mount: () => { mounted++; } };
  assert.equal(Boot.boot({}, { CappShellUI: none, CappSignupApi }), null); assert.equal(Boot.boot({}, { runtime: { flags: {} }, CappShellUI: none, CappSignupApi }), null);
  for (const mode of [undefined, '', 'desktop', 'Web']) assert.equal(Boot.boot({}, { runtime: RT({ mode }), CappShellUI: none, CappSignupApi }), null, `an invalid mode ${JSON.stringify(mode)} never mounts (never a guessed mode)`);
  assert.equal(mounted, 0);
  for (const mode of ['web', 'native']) assert.ok(Boot.boot({}, { runtime: RT({ mode }), CappShellUI: { mount: () => ({ ok: mode }) }, CappSignupApi }), `${mode} mounts`);
});

test('N2: the REAL shell.html modules + the boot (auto-run on CAPP_RUNTIME) paint the shell with EVERY request still pending — no awaited network at boot', () => {
  const shell = readFileSync(join(HERE, 'shell.html'), 'utf8');
  const scripts = [...shell.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.includes('capp-shell-ui.js') && scripts.at(-1) === 'capp-shell-ui.js', 'premise: shell.html loads the shell last');
  const dom = new JSDOM(shell.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
  const w = dom.window; let requests = 0;
  w.fetch = () => { requests++; return new Promise(() => {}); };   // the network never answers
  w.setInterval = () => 0;
  for (const f of scripts) w.eval(readFileSync(join(HERE, f), 'utf8'));
  w.CAPP_RUNTIME = RT({ directory_endpoint: 'dirX' });
  w.eval(readFileSync(join(HERE, 'capp-boot.js'), 'utf8'));
  assert.ok(w.CappBoot && w.CappBoot.instance, '🔴 the boot did not mount the shell');
  assert.ok(w.document.querySelector('.tabbar'), 'the shell painted (its tab bar) before any response');
  assert.ok(w.document.querySelector('#app').innerHTML.length > 100);
  assert.ok(requests >= 1, 'premise: the directory request went out (and is still pending)');
  dom.window.close();
});
