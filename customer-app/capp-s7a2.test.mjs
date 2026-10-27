// Customer app S7a-2 (PLAN-capp-S7a r1-r3.4; MOCKUP-capp-S7a-states frames 1–9 APPROVED 2026-10-27): the directory contract fake
// (pinned to the REAL 5f handler's output), the client directory store, Inicio / Buscar from the real served envelopes, and the
// shell driven through the REAL shell.html + modules in jsdom.
// Run: node --test customer-app/capp-s7a2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');
const CappDirectory = require('./capp-directory.js'), CappEligibility = require('./capp-eligibility.js');
const CappHome = require('./capp-home.js'), CappShell = require('./capp-shell.js'), CappMenu = require('./capp-menu.js'), CappUI = require('./capp-ui.js');
const { provisionBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const PROV = { x_pizza: await quiet(() => provisionBrand('x_pizza')), la_musa: await quiet(() => provisionBrand('la_musa')) };
const FX = JSON.parse(readFileSync(join(HERE, 'fixtures/s7a2/directory.json'), 'utf8'));
const SC = FX.scenarios;
const RUNTIME = { endpoints: { quoteOrder: '/x/q', createOrder: '/x/c', chargeOnlineOrder: '/x/p', paymentStatus: '/x/s' }, intakeKey: 'k_test' };
const T0 = new Date(2026, 9, 20, 19, 5).getTime();   // Tuesday 7:05 p.m. — both stores open (the seeded hours)
const J = (x) => JSON.parse(JSON.stringify(x));

// ── the contract fake ──
// the 5f allowlist, in output order (directory.js ENTRY_FIELDS / BODY_FIELDS at the pinned commit)
const ENTRY_FIELDS = ['restaurant_id', 'name', 'kicker', 'unit', 'cuisines', 'logo_url', 'logo_wide', 'hero_url', 'asset_base', 'branch', 'pickup_addr', 'coverage_km', 'hub_lat', 'hub_lng',
  'eta_delivery_min', 'eta_pickup_min', 'payments', 'pickup', 'schedule', 'schedule_state', 'fee', 'promo', 'order_id_prefix', 'house', 'meals', 'degraded'];
const BODY_FIELDS = ['representation_version', 'complete', 'platform', 'restaurants', 'unavailable'];
test('contract fake: produced by the pinned 5f commit; every 200 body is exactly the 5f schema; the declared statuses / validators', () => {
  assert.equal(FX.source.commit, 'eb6d9558d2bea94bbb2d0a1829db3be72d07a419');
  assert.equal(FX.source.blobs['directory/directory.js'], 'b462c1b21704e47565e5907e86b80fed8de9ed3a', 'the handler blob the fixture came from');
  // Codex s7a2 r1 #10: the CONTENTS are pinned — the generator's digest of every scenario, recomputed here and pinned literally (a hand
  // edit, e.g. a fee, fails; a regeneration from the real handler that changes anything must update this line on purpose)
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
  const digest = createHash('sha256').update(canon(FX.scenarios)).digest('hex');
  assert.equal(digest, FX.scenarios_sha256, '🔴 the fixture contents match the digest its generator wrote');
  assert.equal(digest, '115f98189d64c572ba996d56c2bae0827f81e0a4de54fd65a88e6195f6381a14', '🔴 the fixture contents are the pinned generation');
  for (const [k, s] of Object.entries(SC)) {
    if (s.status !== 200) continue;
    assert.deepEqual(Object.keys(s.body), BODY_FIELDS, `${k}: body schema`);
    for (const r of s.body.restaurants) assert.deepEqual(Object.keys(r), ENTRY_FIELDS, `${k}: entry schema`);
  }
  assert.equal(SC.complete.headers['Cache-Control'], 'public, max-age=30'); assert.match(SC.complete.headers.ETag, /^"[0-9a-f]{64}"$/);
  assert.equal(SC.not_modified.status, 304); assert.equal(SC.not_modified.body, null);
  for (const k of ['partial_presentation', 'partial_unavailable']) { assert.equal(SC[k].body.complete, false); assert.equal(SC[k].headers.ETag, undefined, `${k}: a partial never carries a validator`); }
  assert.deepEqual(SC.partial_unavailable.body.unavailable, ['la_musa']);
  assert.equal(SC.unavailable_503.status, 503); assert.deepEqual(SC.unavailable_503.body, { ok: false, error: 'directory_unavailable', retryable: true });
  assert.deepEqual(SC.zero.body.restaurants, []); assert.equal(SC.zero.body.complete, true);
  assert.deepEqual(SC.tombstone.body.restaurants.map((r) => r.restaurant_id), ['x_pizza']);
  // the house ids are x_pizza's CANONICAL dish ids from the real publish (the S0 rig)
  const ids = new Set(PROV.x_pizza.envelope.menu.dishes.map((d) => d.dish_id));
  assert.ok(SC.complete.body.restaurants[0].house.length === 4 && SC.complete.body.restaurants[0].house.every((h) => ids.has(h)));
});

// ── the client directory store ──
function memStorage(init = {}) { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, _m: m }; }
const resp = (k) => ({ status: SC[k].status, body: SC[k].body, etag: SC[k].headers.ETag });
function rigDir({ storage = memStorage(), script = [], now = { t: T0 } } = {}) {
  const calls = [];
  const elig = CappEligibility.createEligibility({ now: () => now.t });
  const dir = CappDirectory.createDirectory({ storage, now: () => now.t, eligibility: elig, fetchDirectory: async (etag) => { calls.push(etag); const n = script.shift(); return typeof n === 'string' ? resp(n) : n || { status: 0 }; } });
  return { dir, elig, calls, storage, now };
}
const stored = (body, at, etag = SC.complete.headers.ETag) => ({ 'capp:directory': JSON.stringify({ v: 1, body, etag, fetched_at: at }) });

test('directory: cold ⇒ loading; a complete 200 lists, verifies (enterable), and is stored with its validator', async () => {
  const R = rigDir({ script: ['complete'] });
  assert.equal(R.dir.boot().phase, 'cold');
  const v = await R.dir.revalidate();
  assert.equal(v.phase, 'ready'); assert.deepEqual(v.rows.map((r) => r.rid), ['x_pizza', 'la_musa']);
  assert.equal(R.dir.state('x_pizza'), 'enterable'); assert.equal(R.calls[0], null);
  assert.equal(JSON.parse(R.storage.getItem('capp:directory')).etag, SC.complete.headers.ETag);
});
test('directory: a stored body < 24 h paints at boot as PRESENTATION (listed, never enterable); ≥ 24 h, future > 5 min, or a partial ⇒ discarded', () => {
  const ok = rigDir({ storage: memStorage(stored(SC.complete.body, T0 - 60 * 60 * 1000)) });
  const v = ok.dir.boot();
  assert.equal(v.phase, 'ready'); assert.equal(v.presentation, true); assert.equal(v.rows.length, 2);
  assert.equal(ok.dir.state('x_pizza'), 'held', 'presentation is not eligibility');
  for (const at of [T0 - 24 * 60 * 60 * 1000, T0 + 5 * 60 * 1000 + 1]) assert.equal(rigDir({ storage: memStorage(stored(SC.complete.body, at)) }).dir.boot().phase, 'cold');
  assert.equal(rigDir({ storage: memStorage(stored(SC.partial_presentation.body, T0)) }).dir.boot().phase, 'cold', 'only a COMPLETE body is ever trusted from storage');
});
test('directory: revalidation sends the stored etag; a matching 304 verifies; a 304 naming another etag ⇒ re-fetched WITHOUT a validator', async () => {
  const R = rigDir({ storage: memStorage(stored(SC.complete.body, T0 - 1000)), script: ['not_modified'] });
  R.dir.boot(); await R.dir.revalidate();
  assert.equal(R.calls[0], SC.complete.headers.ETag); assert.equal(R.dir.state('la_musa'), 'enterable');
  const R2 = rigDir({ storage: memStorage(stored(SC.complete.body, T0 - 1000)), script: [{ status: 304, etag: '"other"' }, 'complete'] });
  R2.dir.boot(); await R2.dir.revalidate();
  assert.deepEqual(R2.calls, [SC.complete.headers.ETag, null], '🔴 a 304 naming another etag is re-fetched without a validator');
});
test('directory: a complete body omitting a shown store TOMBSTONES it in place (disabled, same slot) until the next visit; it is never enterable', async () => {
  const R = rigDir({ script: ['complete', 'tombstone'] });
  R.dir.boot(); await R.dir.revalidate(); await R.dir.revalidate();
  assert.deepEqual(R.dir.view().rows.map((r) => [r.rid, r.gone]), [['x_pizza', false], ['la_musa', true]]);
  assert.equal(R.dir.state('la_musa'), 'gone');
  assert.deepEqual(JSON.parse(R.storage.getItem('capp:directory')).body.restaurants.map((r) => r.restaurant_id), ['x_pizza'], 'removed from the stored body');
  R.dir.visit();
  assert.deepEqual(R.dir.view().rows.map((r) => r.rid), ['x_pizza']);
});
test('directory: a PARTIAL verifies what it lists; an omitted store is held (never tombstoned); the stored body is not overwritten; the partial note', async () => {
  const R = rigDir({ script: ['complete', 'partial_unavailable'] });
  R.dir.boot(); await R.dir.revalidate();
  const before = R.storage.getItem('capp:directory');
  const v = await R.dir.revalidate();
  assert.equal(v.partial, true); assert.deepEqual(v.rows.map((r) => [r.rid, r.gone]), [['x_pizza', false], ['la_musa', false]]);
  assert.equal(R.dir.state('x_pizza'), 'enterable'); assert.equal(R.dir.state('la_musa'), 'held', '🔴 a partial never tombstones the store it omits');
  assert.equal(R.storage.getItem('capp:directory'), before);
});
test('directory: 503 / offline change nothing; with nothing to show ⇒ the error phase (frame 7); a later success clears it', async () => {
  const R = rigDir({ script: ['unavailable_503', { status: 0 }, 'complete'] });
  R.dir.boot(); assert.equal((await R.dir.revalidate()).phase, 'error'); assert.equal((await R.dir.revalidate()).phase, 'error');
  assert.equal((await R.dir.revalidate()).phase, 'ready');
  const P = rigDir({ storage: memStorage(stored(SC.complete.body, T0 - 1000)), script: ['unavailable_503'] });
  P.dir.boot(); const v = await P.dir.revalidate();
  assert.equal(v.phase, 'ready'); assert.equal(v.failed, true); assert.equal(P.dir.state('x_pizza'), 'held', 'a presentation row stays held');
});
test('directory: eligibility expires on its own clock (60 s) — a verified row reverts to held without any new response', async () => {
  const R = rigDir({ script: ['complete'] });
  R.dir.boot(); await R.dir.revalidate();
  R.now.t += 59 * 1000; assert.equal(R.dir.state('x_pizza'), 'enterable');
  R.now.t += 1000; assert.equal(R.dir.state('x_pizza'), 'held');
});

// ── Inicio / Buscar (pure renderers over the real envelopes) ──
function rowsOf(body, menus = { x_pizza: 'fresh', la_musa: 'fresh' }) {
  return body.restaurants.map((entry) => {
    const rid = entry.restaurant_id, cfg = CappShell.configFor(entry, RUNTIME), st = menus[rid] || null;
    const view = st && st !== 'failed' ? { sections: CappUI.viewSections(CappMenu.adaptMenu(PROV[rid].envelope), cfg) } : null;
    return { rid, entry, cfg, view, menuState: st, gone: false, held: false };
  });
}
const VM = (over = {}) => ({ phase: 'ready', partial: false, rows: rowsOf(SC.complete.body), platform: SC.complete.body.platform, now: new Date(T0), auth: 'guest', cuisine: '', filters: new Set(),
  schedulingLive: false, outOfZone: false, tab: 'home', cartN: 0, q: '', recent: [], ...over });
const dom = (html) => new JSDOM(`<div id="x">${html}</div>`).window.document;
// the visible text: every text node, trimmed, joined by one space (spans are spaced by CSS, not by literal spaces)
const txt = (el) => { if (!el) return null; const tw = el.ownerDocument.createTreeWalker(el, 4); const out = []; for (let n = tw.nextNode(); n; n = tw.nextNode()) { const t = n.nodeValue.replace(/\s+/g, ' ').trim(); if (t) out.push(t); } return out.join(' '); };

test('Inicio S5-absent: no statistics rows; «Destacados» = «Abiertos ahora y para pedir hoy», open first then directory order', () => {
  const d = dom(CappHome.homeHtml(VM()));
  const secs = [...d.querySelectorAll('.hsec')].map((s) => s.getAttribute('aria-label'));
  assert.deepEqual(secs, ['Destacados', 'La casa recomienda', 'Todos los restaurantes']);
  assert.ok(!/más pedido|volvieron a pedir|vuelven a pedir|%/.test(d.querySelector('#x').textContent), 'nothing from statistics');
  assert.equal(txt(d.querySelector('.hsec[aria-label="Destacados"] p')), 'Abiertos ahora y para pedir hoy');
  // 6:00 p.m.: x_pizza open (12–7:45), la_musa open (5–8:45); 8:00 p.m.: only la_musa ⇒ it leads
  const late = dom(CappHome.homeHtml(VM({ now: new Date(2026, 9, 20, 20, 0) })));
  assert.deepEqual([...late.querySelectorAll('.hsec[aria-label="Destacados"] .scard .rt')].map((b) => b.dataset.rid), ['la_musa', 'x_pizza'], '🔴 Destacados: open first, then directory order');
});
test('Inicio house: ids ⇒ those canonical dishes (a dish the loaded menu lacks is dropped); absent ⇒ catalog-tag fallback; [] ⇒ hidden', () => {
  const xp = SC.complete.body.restaurants[0];
  const withHouse = (house) => { const rows = rowsOf(SC.complete.body); rows[0] = { ...rows[0], entry: { ...xp, house } }; return rows; };
  const names = (rows) => [...dom(CappHome.homeHtml(VM({ rows }))).querySelectorAll('.hsec[aria-label="La casa recomienda"] .dcard .nm')].map((n) => n.textContent);
  assert.deepEqual(names(withHouse(xp.house)), ['Sweet Corn & Calabrian Chili', 'Pancetta Vodka Sauce', 'Pistaccio Mortadella', 'Prosciutto']);
  assert.deepEqual(names(withHouse(['ZZZZZZZZZZ', ...xp.house.slice(0, 2)])), ['Pistaccio Mortadella', 'Prosciutto'], 'an unknown id is dropped; the rest in menu order');
  assert.deepEqual(names(withHouse([])), [], 'house: [] hides the row');
  // absent ⇒ the tag fallback: photographed dishes tagged signature / chefs_pick / must_try (x_pizza's catalog carries none ⇒ tagged here)
  const tagged = rowsOf(SC.complete.body);
  const photographed = tagged[0].view.sections.flatMap((s) => s.items).filter((it) => it.img).slice(0, 2).map((it) => it.id);
  tagged[0] = { ...tagged[0], entry: { ...xp, house: null }, view: { sections: tagged[0].view.sections.map((s) => ({ ...s, items: s.items.map((it) => (photographed.includes(it.id) ? { ...it, tags: ['chefs_pick'] } : it)) })) } };
  assert.equal(photographed.length, 2, 'premise');
  assert.deepEqual(names(tagged), tagged[0].view.sections.flatMap((s) => s.items).filter((it) => photographed.includes(it.id)).map((it) => it.n), '🔴 house absent ⇒ the catalog-tag fallback');
  assert.deepEqual(names(rowsOf({ ...SC.complete.body, restaurants: [{ ...xp, house: null }] })), [], 'absent + no tags ⇒ no row (never invented)');
});
test('Inicio fees: «Envío desde L 45» only for a PRICED fee; no fee text otherwise — never «Envío gratis» / L 0; the promo is the MEMBER price', () => {
  const none = dom(CappHome.homeHtml(VM({ rows: rowsOf(SC.fee_none.body) })));
  const lm = none.querySelector('.rlist .rcard[data-rid="la_musa"]');
  assert.ok(!/Envío/.test(txt(lm)), `🔴 an unpriced fee draws no fee text: ${txt(lm)}`); assert.ok(!/L 0\b/.test(txt(lm)));
  const guest = dom(CappHome.homeHtml(VM()));
  assert.match(txt(guest.querySelector('.rlist .rcard[data-rid="x_pizza"] .meta')), /Envío desde L 45$/);
  assert.equal(txt(guest.querySelector('.scard .tag-deal')), 'Envío gratis con tu cuenta');
  const member = dom(CappHome.homeHtml(VM({ auth: 'member' })));
  assert.match(txt(member.querySelector('.rlist .rcard[data-rid="x_pizza"] .meta')), /Envío gratis$/);
  assert.equal(member.querySelector('.tag-deal'), null);
  // unresolved: neither variant; the guest pill's slot is reserved (no line appears under a finger when auth lands)
  const unres = dom(CappHome.homeHtml(VM({ auth: 'unresolved' })));
  assert.equal(unres.querySelector('.tag-deal'), null);
  assert.match(txt(unres.querySelector('.rlist .rcard[data-rid="x_pizza"] .meta')), /Envío desde L 45$/);
  assert.equal(unres.querySelector('.rlist .rcard[data-rid="x_pizza"] .pill.deal').getAttribute('style'), 'visibility:hidden');
});
test('Inicio states: 1 loading line · 7 error · 2 zero · 3 B all closed (2nd sentence only while scheduling is live) · 9 partial · 4 out of zone', () => {
  assert.equal(txt(dom(CappHome.homeHtml(VM({ rows: [], phase: 'cold' }))).querySelector('.home-body')), 'Cargando restaurantes…');
  const err = dom(CappHome.homeHtml(VM({ rows: [], phase: 'error' })));
  assert.equal(txt(err.querySelector('.home-body')), 'No pudimos cargar los restaurantes Revisá tu conexión e intentá de nuevo. Reintentar');
  assert.equal(err.querySelector('.btn2').dataset.act, 'dir-retry');
  assert.equal(txt(dom(CappHome.homeHtml(VM({ rows: [] }))).querySelector('.home-body')), 'Todavía no hay restaurantes aquí Pronto vas a poder pedir en San Pedro Sula.');
  const night = new Date(2026, 9, 20, 22, 30);
  assert.equal(txt(dom(CappHome.homeHtml(VM({ now: night }))).querySelector('.hnote')), 'Ahora no hay restaurantes abiertos.', '🔴 3 B: the 2nd sentence only while scheduling is live');
  assert.equal(txt(dom(CappHome.homeHtml(VM({ now: night, schedulingLive: true }))).querySelector('.hnote')), 'Ahora no hay restaurantes abiertos. Podés programar tu pedido.');
  assert.equal(dom(CappHome.homeHtml(VM())).querySelector('.hnote'), null, 'open stores ⇒ no note');
  const part = dom(CappHome.homeHtml(VM({ partial: true })));
  assert.equal(txt(part.querySelector('.hnote')), 'Algunos restaurantes no cargaron. Reintentar');
  assert.equal(part.querySelector('.hnote .lnk').dataset.act, 'dir-retry');
  const oz = dom(CappHome.homeHtml(VM({ outOfZone: true })));
  assert.equal(txt(oz.querySelector('.home-body')), 'Ningún restaurante entrega en esta dirección Probá otra dirección o recogé en tienda. Cambiar dirección');
});
test('coverage: frame 4 only when EVERY store answers «outside»; an unknown coverage is never counted as outside', () => {
  const rows = rowsOf(SC.complete.body);
  const far = { lat: 15.9, lng: -87.5 }, near = { lat: 15.5075, lng: -88.0398 };
  assert.equal(CappHome.allOutOfZone(rows, far), true); assert.equal(CappHome.allOutOfZone(rows, near), false);
  const unknown = rows.map((r, i) => (i ? { ...r, entry: { ...r.entry, coverage_km: null } } : r));
  assert.equal(CappHome.allOutOfZone(unknown, far), false); assert.equal(CappHome.allOutOfZone(rows, null), false);
  // the limit itself: exactly coverage_km is inside
  const e = rows[0].entry, km = CappHome.kmBetween({ lat: e.hub_lat, lng: e.hub_lng }, far);
  assert.equal(CappHome.covers({ ...e, coverage_km: km }, far), true); assert.equal(CappHome.covers({ ...e, coverage_km: km - 1e-9 }, far), false);
});
test('Buscar: dish hits are the DISPLAYED items (a launcher «desde L min», never a raw variant child), directory → section → item order, capped at 12', () => {
  const m = CappHome.searchModel(rowsOf(SC.complete.body), 'a');
  assert.equal(m.dishes.length, 12, 'capped at 12');
  const ordered = rowsOf(SC.complete.body).flatMap((r) => r.view.sections.flatMap((s) => s.items.filter((it) => CappHome.norm(it.n + ' ' + it.d).includes('a')).map((it) => `${r.rid}/${it.id}`))).slice(0, 12);
  assert.deepEqual(m.dishes.map((h) => `${h.r.id}/${h.it.id}`), ordered);
  const menu = CappMenu.adaptMenu(PROV.la_musa.envelope);
  const launcher = menu.dish(Object.keys(menu.groups)[0]); assert.ok(launcher && launcher.launcher, 'premise: la_musa has a launcher');
  const child = menu.dish(menu.groups[launcher.key].choices[0]);
  const hits = CappHome.searchModel(rowsOf(SC.complete.body), launcher.name).dishes;
  assert.ok(hits.some((h) => h.it.id === launcher.key), 'the launcher is found');
  assert.ok(!hits.some((h) => h.it.id === child.key), 'its variant child is not a hit of its own');
  const d = dom(CappHome.searchHtml(VM({ tab: 'search', q: launcher.name })));
  const row = d.querySelector(`.srow[data-id="${launcher.key}"] .pr`);
  assert.equal(txt(row), `desde L ${Math.min(...menu.groups[launcher.key].choices.map((k) => menu.dish(k).price))}`);
});
test('Buscar: «No encontramos» ONLY when every menu answered; a partial shows its note (frame 8); pending menus show «Buscando platos…» (frame 6)', () => {
  const nothing = 'zzzqqq';
  assert.match(txt(dom(CappHome.searchHtml(VM({ tab: 'search', q: nothing }))).querySelector('#results')), /^No encontramos «zzzqqq»/);
  for (const st of ['stale', 'presentation', 'failed']) {
    const r = txt(dom(CappHome.searchHtml(VM({ tab: 'search', q: nothing, rows: rowsOf(SC.complete.body, { x_pizza: 'fresh', la_musa: st }) }))).querySelector('#results'));
    assert.ok(!/No encontramos/.test(r), `${st}: never «No encontramos» over a partial`); assert.match(r, /^Algunos menús no cargaron; puede haber más platos\./);
  }
  const found = dom(CappHome.searchHtml(VM({ tab: 'search', q: 'camar', rows: rowsOf(SC.complete.body, { x_pizza: 'failed', la_musa: 'fresh' }) })));
  assert.equal(txt(found.querySelector('.results > .note')), 'Algunos menús no cargaron; puede haber más platos.');
  assert.ok(found.querySelectorAll('.srow[data-act="open-dish"]').length > 0);
  const loading = dom(CappHome.searchHtml(VM({ tab: 'search', q: 'pizza', rows: rowsOf(SC.complete.body, {}) })));
  assert.deepEqual([...loading.querySelectorAll('h3')].map((h) => h.textContent), ['Restaurantes', 'Platos']);
  assert.equal(txt(loading.querySelector('.note.sload')), 'Buscando platos…');
});

// ── the shell, through the REAL shell.html ──
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// stampedDir: a copy of customer-app/ stamped by the REAL platform/stamp-version.js — the page's own sherpa-client.js runs on its
// stamped identity and capp-api.js runs in the page realm (its SherpaClient.fetch arm), the network = pageFetch (window.fetch)
function bootShell({ dirScript = ['complete'], envelope = 'ok', storage, auth = 'guest', now, geolocation = null, search = '', fetchLog = [], apiFetch = null, runtime = RUNTIME, stampedDir = null, pageFetch = null, mountExtra = {} } = {}) {
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const html = readFileSync(join(stampedDir || HERE, 'shell.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '').replace('</head>', () => `<style>${css}</style></head>`);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://app.test/' });
  const w = dom.window;
  if (stampedDir) { w.fetch = pageFetch; w.eval(readFileSync(join(stampedDir, 'sherpa-client.js'), 'utf8')); }   // the page's FIRST script
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-confirm-quote.js', 'capp-checkout.js', 'capp-api.js', 'capp-ui.js', 'capp-eligibility.js', 'capp-auth-state.js',
    'capp-menu-cache.js', 'capp-directory.js', 'capp-shell.js', 'capp-shell-nav.js', 'capp-home.js', 'capp-device-account.js', 'capp-auth-firebase.js', 'capp-signup-api.js', 'capp-signup.js', 'capp-shell-ui.js']) w.eval(readFileSync(join(HERE, f), 'utf8'));
  const dirCalls = [], envCalls = [], pend = {}, events = [];
  const fetchDirectory = async (etag) => { dirCalls.push(etag); const n = dirScript.length > 1 ? dirScript.shift() : dirScript[0]; if (n === 'hang') return new Promise(() => {}); if (n && n.p) return n.p; return typeof n === 'string' ? resp(n) : n; };
  const fetchEnvelope = (rid, etag) => {
    envCalls.push(rid);
    const mode = typeof envelope === 'function' ? envelope(rid) : envelope;
    if (mode === 'hold') { const d = deferred(); (pend[rid] = pend[rid] || []).push(d); return d.p; }
    if (mode === 'fail') return Promise.resolve({ status: 500 });
    return Promise.resolve({ status: 200, body: J(PROV[rid].envelope), etag: PROV[rid].etag });
  };
  const clock = now || { t: T0 };
  const ui = w.CappShellUI.mount(w.document, { CappCheckout: require('./capp-checkout.js'), fetchDirectory, fetchEnvelope, readAvailability: async () => [], onEvent: (n, d) => events.push([n, J(d)]), runtime, storage: storage || memStorage(), now: () => clock.t,
    auth: { state: () => auth }, geolocation, search, timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: () => 0, clearInterval: () => {} }, uiOpts: { CappCheckout: require('./capp-checkout.js'), CappApi: stampedDir ? w.CappApi : require('./capp-api.js'), apiOpts: { ...(stampedDir ? {} : { fetch: (u, i) => { fetchLog.push(String(u)); return apiFetch ? apiFetch(String(u), i) : new Promise(() => {}); } }), now: () => clock.t, sleep: async () => {} } }, ...mountExtra });
  const q = (s) => w.document.querySelector(s), qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (s) => { const el = typeof s === 'string' ? q(s) : s; assert.ok(el, `premise: ${s} exists`); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
  const release = (rid, body) => { const d = (pend[rid] || []).shift(); d.resolve({ status: 200, body: body || J(PROV[rid].envelope), etag: body ? '"changed"' : PROV[rid].etag }); };
  return { w, ui, q, qa, click, dirCalls, envCalls, release, pend, clock, events };
}

test('shell: Inicio paints the directory-only rows BEFORE any envelope lands; menu rows fill in as each lands (never waits for all)', async () => {
  const S = bootShell({ envelope: 'hold' });
  await flush();
  assert.deepEqual(S.qa('.rlist .rcard').map((b) => b.dataset.rid), ['x_pizza', 'la_musa'], 'the list is painted with every envelope pending');
  assert.equal(S.q('.hsec[aria-label="La casa recomienda"]'), null, 'no menu-derived row yet');
  S.release('x_pizza'); await flush();
  assert.ok(S.q('.hsec[aria-label="La casa recomienda"]'), 'x_pizza\'s house row fills in while la_musa is still pending');
  assert.equal(S.pend.la_musa.length, 1);
});
test('shell: ONE cache — Buscar reuses Inicio\'s in-flight requests (no duplicate), and the search fills in as they land', async () => {
  const S = bootShell({ envelope: 'hold' });
  await flush();
  assert.deepEqual(S.envCalls.sort(), ['la_musa', 'x_pizza']);
  S.click('.tabbar [data-tab="search"]'); await flush();
  const i = S.q('#gq'); i.focus(); i.value = 'camar'; i.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
  assert.equal(S.q('.note.sload').textContent, 'Buscando platos…');
  assert.deepEqual(S.envCalls.sort(), ['la_musa', 'x_pizza'], 'no second request');
  S.release('la_musa'); S.release('x_pizza'); await flush();
  assert.ok(S.qa('.srow[data-act="open-dish"]').length > 0); assert.equal(S.q('.results > .note'), null, 'complete ⇒ no partial note');
  assert.equal(document_focus(S), 'gq', 'typing keeps the caret in the field across re-renders');
});
const document_focus = (S) => S.w.document.activeElement && S.w.document.activeElement.id;
test('shell: a tap on a PRESENTATION row is HELD (pressed) and opens the moment the verification lands; an eligible row opens at once', async () => {
  const gate = deferred();
  const storage = memStorage({ ...stored(SC.complete.body, T0 - 1000), [`capp:menu:x_pizza`]: JSON.stringify({ v: 1, rid: 'x_pizza', etag: PROV.x_pizza.etag, fetched_at: T0 - 1000, body: PROV.x_pizza.envelope }) });
  const S = bootShell({ dirScript: [gate, 'complete'], storage });
  assert.equal(S.qa('.rlist .rcard').length, 2, 'presentation painted synchronously at boot');
  S.click('.rlist .rcard[data-rid="x_pizza"]');
  assert.ok(S.q('.rlist .rcard[data-rid="x_pizza"]').classList.contains('held'), 'the drawn pressed state'); assert.equal(S.ui.store(), null);
  gate.resolve(resp('complete')); await flush();
  assert.equal(S.ui.store().rid, 'x_pizza', 'opened on the verified response'); assert.ok(S.q('.store-nav, .stick'), 'the store surface');
  S.click('[data-act="back"]'); await flush();
  assert.equal(S.ui.store(), null); assert.ok(S.q('.rlist'));
  S.click('.rlist .rcard[data-rid="la_musa"]'); await flush();
  assert.equal(S.ui.store().rid, 'la_musa', 'verified < 60 s ⇒ in');
});
test('shell: a held tap whose directory read FAILS shows frame 7; «Reintentar» re-reads', async () => {
  const storage = memStorage(stored(SC.complete.body, T0 - 1000));
  const S = bootShell({ dirScript: ['unavailable_503', 'unavailable_503', 'complete'], storage });
  await flush();
  assert.equal(S.qa('.rlist .rcard').length, 2, 'a failed revalidation keeps the presentation list');
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.equal(S.q('.empty b').textContent, 'No pudimos cargar los restaurantes');
  S.click('[data-act="dir-retry"]'); await flush();
  assert.equal(S.qa('.rlist .rcard').length, 2);
});
test('shell: a Buscar dish result opens THAT dish\'s sheet in its store; Back returns to Buscar with the query', async () => {
  const S = bootShell();
  await flush();
  S.click('.tabbar [data-tab="search"]'); await flush();
  const i = S.q('#gq'); i.value = 'camar'; i.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
  const hit = S.q('.srow[data-act="open-dish"]'); const key = hit.dataset.id;
  S.click(hit); await flush();
  assert.equal(S.ui.store().rid, 'la_musa');
  assert.ok(S.q('#detail-modal').classList.contains('open')); assert.equal(S.q('#detail-header-title').textContent, S.ui.store().ui.menu.dish(key).name);
  S.ui.nav.back(); await flush();
  assert.equal(S.ui.store(), null); assert.equal(S.q('#gq').value, 'camar', 'the recorded predecessor keeps its query');
  assert.deepEqual(J(S.ui.state.recent), ['camar'], 'the search is remembered');
});
test('shell: a TOMBSTONED row stays in its slot, disabled; a tap does nothing; it leaves on the next visit to Inicio', async () => {
  const S = bootShell({ dirScript: ['complete', 'tombstone'] });
  await flush();
  await S.ui.dir.revalidate(); await flush();
  const lm = S.q('.rlist .rcard[data-rid="la_musa"]');
  assert.ok(lm.disabled && lm.classList.contains('gone'));
  S.click(lm); await flush(); assert.equal(S.ui.store(), null);
  S.click('.tabbar [data-tab="search"]'); await flush(); S.click('.tabbar [data-tab="home"]'); await flush();
  assert.deepEqual(S.qa('.rlist .rcard').map((b) => b.dataset.rid), ['x_pizza']);
});

test('shell location: «Entregar en» → «Usar mi ubicación actual» → the soft-ask (first time) → allowed ⇒ the GPS fix is the CONFIRMED guest location, persisted', async () => {
  const storage = memStorage();
  const S = bootShell({ storage, geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  await flush();
  S.click('[data-act="addr"]'); assert.deepEqual(S.qa('#layer .navrow').map((b) => b.textContent.trim()), ['Usar mi ubicación actual', 'Agregar dirección']);
  S.click('[data-act="loc-use"]'); assert.equal(S.q('#layer .softask h2').textContent, 'Encontrá restaurantes cerca de vos');
  S.click('[data-act="loc-allow"]'); await flush();
  assert.deepEqual(J(S.ui.state.loc), { lat: 15.52, lng: -88.04, confirmed: true, source: 'gps', v: 1 });
  assert.deepEqual(JSON.parse(storage.getItem('capp:guest_loc')), { lat: 15.52, lng: -88.04, confirmed: true, source: 'gps', v: 1 });
  assert.equal(S.q('#toast').textContent, 'Ubicación activada');
  S.click('[data-act="addr"]'); S.click('[data-act="loc-use"]'); await flush();
  assert.equal(S.q('#layer').innerHTML, '', 'asked once: no second soft-ask');
});
test('shell location: denied ⇒ the drawn «Ubicación desactivada · Activar» row and NO location (no fallback pin); the pin editor\'s «Cancelar» changes nothing', async () => {
  const S = bootShell({ geolocation: { getCurrentPosition: (ok, no) => no(new Error('denied')) } });
  await flush();
  S.click('[data-act="addr"]'); S.click('[data-act="loc-use"]'); S.click('[data-act="loc-allow"]'); await flush();
  assert.equal(S.ui.state.loc, null); assert.equal(S.q('.locrow span').textContent, 'Ubicación desactivada');
  S.click('[data-act="addr"]'); S.click('[data-act="addr-new"]');
  assert.equal(S.q('#layer .pinstep .foot b').textContent, 'Confirmá dónde entregamos');
  S.click('#layer [data-act="lclose"]');
  assert.equal(S.ui.state.loc, null, '🔴 an editor cancel leaves the guest location unchanged');
});
test('shell location: the guest location drives frame 4 (every store outside) and SEEDS the store\'s checkout pin', async () => {
  const far = { lat: 15.9, lng: -87.5, confirmed: true, source: 'pin', v: 3 };
  const S = bootShell({ storage: memStorage({ 'capp:guest_loc': JSON.stringify(far) }) });
  await flush();
  assert.equal(S.q('.home-body .empty b').textContent, 'Ningún restaurante entrega en esta dirección');
  const near = { lat: 15.531, lng: -88.021, confirmed: true, source: 'pin', v: 1 };
  const N = bootShell({ storage: memStorage({ 'capp:guest_loc': JSON.stringify(near) }) });
  await flush();
  N.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const ui = N.ui.store().ui; ui.cart.inc(ui.menu.dishes.find((d) => !d.launcher && !d.variantOf).key); ui.render();
  N.click('#cart-bar'); N.click('[data-act="checkout"]'); await flush();
  assert.deepEqual({ lat: ui.state.flow.pin.lat, lng: ui.state.flow.pin.lng, confirmed: ui.state.flow.pin.confirmed }, { lat: near.lat, lng: near.lng, confirmed: true });
});

// ── r3.3-F2: browse-only on a stored (presentation) menu; enabled in place; a changed menu adopted at checkout entry (frame 13) ──
const storedMenu = (rid, body = PROV[rid].envelope) => ({ [`capp:menu:${rid}`]: JSON.stringify({ v: 1, rid, etag: PROV[rid].etag, fetched_at: T0 - 60 * 60 * 1000, body }) });
const repriced = (name, plus) => { const env = J(PROV.x_pizza.envelope); const d = env.menu.dishes.find((x) => x.name === name); d.price += plus; return env; };
async function enterOnPresentation() {
  const S = bootShell({ envelope: 'hold', storage: memStorage(storedMenu('x_pizza')) });
  await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.equal(S.ui.store().rid, 'x_pizza', 'premise: verified directory + a stored body ⇒ in');
  return S;
}
test('browse-only: a store entered on its STORED menu has every ordering control inert (the existing disabled attribute); a forced tap changes nothing', async () => {
  const S = await enterOnPresentation(); const ui = S.ui.store().ui;
  assert.equal(ui.orderable(), false);
  const adds = S.qa('.qty-add-btn'); assert.ok(adds.length > 0 && adds.every((b) => b.disabled && b.getAttribute('aria-disabled') === 'true'));
  const plain = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
  S.click(`.qty-add-btn[data-id="${plain.key}"]`); assert.equal(ui.cart.count(), 0, 'the handler refuses too (mutate is the choke point)');
  S.click(`.txtbtn[data-id="${plain.key}"]`); await flush();
  assert.ok(S.q('#detail-cta').disabled, '«Agregar» inert'); assert.ok(S.q('#detail-cta').textContent.startsWith('Agregar'), 'its label unchanged (no geometry change)');
});
test('browse-only: the verified IDENTICAL menu turns the controls live IN PLACE — the same nodes, no re-render; ordering works', async () => {
  const S = await enterOnPresentation(); const ui = S.ui.store().ui;
  const node = S.q('.qty-add-btn'), scroller = S.q('#scroller');
  S.release('x_pizza'); await flush(); await flush();
  assert.equal(ui.orderable(), true);
  assert.equal(S.q('.qty-add-btn'), node, '🔴 the same node — enabled in place'); assert.equal(S.q('#scroller'), scroller);
  assert.equal(node.disabled, false); assert.equal(S.q('[data-ord]'), null);
  S.click(node); assert.equal(ui.cart.count(), 1);
  S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush();
  assert.equal(ui.state.screen, 'checkout', 'same fingerprint ⇒ nothing to adopt; checkout opens');
});
test('browse-only: a CHANGED menu keeps the surface (its prices) while the customer is in it; at checkout entry it is adopted and the cart discloses the change (frame 13) BEFORE the quote', async () => {
  const S = await enterOnPresentation(); const ui0 = S.ui.store().ui;
  const carn = ui0.menu.dishes.find((d) => d.name === 'Carnivora'); assert.ok(carn, 'premise');
  const priceBefore = S.q(`.txtbtn[data-id="${carn.key}"]`).closest('.row').textContent;
  S.release('x_pizza', repriced('Carnivora', 26)); await flush(); await flush();
  assert.equal(ui0.orderable(), true); assert.equal(S.ui.store().ui, ui0, 'never remounted while visible');
  assert.equal(S.q(`.txtbtn[data-id="${carn.key}"]`).closest('.row').textContent, priceBefore, 'never re-priced while visible');
  S.click(`.qty-add-btn[data-id="${carn.key}"]`); S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush();
  const ui1 = S.ui.store().ui;
  assert.notEqual(ui1, ui0, 'adopted at checkout entry'); assert.equal(ui1.state.screen, 'store'); assert.equal(ui1.state.layerKind, 'cart');
  assert.deepEqual(S.qa('#layer .cartnote[role="status"] .cn-l').map((l) => l.textContent), ['Cambió el precio de Carnivora: antes L 340, ahora L 366.'], '🔴 frame 13: the price notice line');
  assert.equal(S.q('#layer .cline .cl-p').innerHTML, '<s class="cl-old">L 340</s>L 366');
  assert.equal(txt(S.q('#layer .ctot .sumrow')), 'Subtotal L 366', 'totals at the new price');
  S.click('[data-act="checkout"]'); await flush();
  assert.equal(ui1.state.screen, 'checkout', 'continuing is acceptance');
});

// ── frames 10 and 11 (S7a-1 shell UI, approved 2026-10-27) ──
const ORDER = 'XPZ261020-190500-ABCDWXYZ';
const frozenCart = () => { const m = CappMenu.adaptMenu(PROV.x_pizza.envelope); const d = m.dishes.find((x) => !x.launcher && !x.variantOf && !m.pickupOnlyCats.has(String(x.cat)));
  return { 'capp:x_pizza:cart': JSON.stringify({ v: 2, lines: [{ key: d.key, qty: 1, ex: [{}], added: 1 }], rid: 'x_pizza', mode: 'delivery', cart_gen: 'g_1', frozen_for: ORDER }) }; };
test('frame 10: a cart frozen for a placement is read-only — the note, its controls disabled, «Ver estado del pedido» reads the STATUS (the recovery sheet) and sends NOTHING', async () => {
  const fetchLog = [];
  const S = bootShell({ storage: memStorage(frozenCart()), fetchLog });
  await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  S.click('#cart-bar'); await flush();
  assert.equal(txt(S.q('#layer .cartnote')), 'Tu pedido se está confirmando; no se puede cambiar mientras tanto.');
  assert.ok(S.qa('#layer .cline.frozen button').length >= 3 && S.qa('#layer .cline.frozen button').every((b) => b.disabled));
  assert.equal(S.q('#layer [data-act="checkout"]'), null, 'no «Ir al checkout»');
  const cta = S.q('#layer .sheetbar .primary'); assert.equal(cta.textContent, 'Ver estado del pedido');
  S.click(cta); await flush(); await flush();
  assert.match(txt(S.q('#layer')), /Necesitamos revisar tu pedido/, 'not live, no credentials ⇒ the recovery sheet');
  assert.deepEqual(fetchLog, [], '🔴 zero sends');
  S.click('#layer [data-act="lclose"]'); await flush();
  const add = S.qa('.qty-add-btn[data-act="inc"]').find((b) => !b.disabled); S.click(add);
  assert.equal(S.ui.store().ui.cart.count(), 1, 'still frozen: a tap through the store is refused');
});
test('frame 11: a fresh return this phone cannot tie to ONE store ⇒ the neutral surface (no tab bar, no store mounted); «Ir a Inicio»; a later boot does not show it again', async () => {
  const storage = memStorage();
  const S = bootShell({ storage, search: `?pay=complete&order=${ORDER}&t=pt_9` });
  await flush();
  assert.equal(S.q('.empty.neutral b').textContent, 'No encontramos este pedido en este teléfono');
  assert.equal(S.q('.empty.neutral .note').textContent, `Pedido #${ORDER}`);
  assert.equal(S.q('.tabbar'), null); assert.equal(S.ui.store(), null);
  assert.equal(JSON.parse(storage.getItem('capp:return')).order, ORDER, 'the handoff is kept (removed only on an authoritative outcome)');
  S.click('[data-act="neutral-home"]'); await flush();
  assert.ok(S.q('.rlist'));
  const again = bootShell({ storage }); await flush();
  assert.equal(again.q('.empty.neutral'), null, 'a resumed, ownerless handoff never re-shows the surface');
});
test('return: a return OWNED by one store (its pay stash) enters THAT store with the return, once — even on a cold boot (no directory yet)', async () => {
  const storage = memStorage({ 'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_1' }) });
  const S = bootShell({ storage, search: `?pay=complete&order=${ORDER}&t=pt_9` });
  await flush(); await flush();
  assert.equal(S.ui.store() && S.ui.store().rid, 'x_pizza');
  assert.equal(S.ui.store().ui.state.screen, 'sending', 'the store handles its return (polling)');
  assert.equal(S.ui.state.ret, null, 'the return is handed to its store ONCE (no later mount is given it)');
  assert.equal(S.ui.nav.tab({ name: 'home' }), false, 'sending ⇒ the store cannot be left (S7a-1 r3.2 ruling (a))');
});

// ── Codex s7a2 r1 ──
test('Codex s7a2 r1 #1 (P1): checkout adoption carries the IN-MEMORY cart — a cart whose persistence fails loses nothing across the remount', async () => {
  const base = memStorage(storedMenu('x_pizza'));
  const storage = { ...base, getItem: base.getItem, removeItem: base.removeItem, key: base.key, get length() { return base.length; },
    setItem: (k, v) => { if (k === 'capp:x_pizza:cart') throw new Error('quota'); base.setItem(k, v); } };
  const S = bootShell({ envelope: 'hold', storage });
  await flush(); S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const ui0 = S.ui.store().ui; const carn = ui0.menu.dishes.find((d) => d.name === 'Carnivora');
  S.release('x_pizza', repriced('Carnivora', 26)); await flush(); await flush();
  S.click(`.qty-add-btn[data-id="${carn.key}"]`); assert.equal(ui0.cart.count(), 1, 'premise: one in the cart (its persistence failed)');
  S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush();
  assert.notEqual(S.ui.store().ui, ui0, 'premise: adopted');
  assert.equal(S.ui.store().ui.cart.count(), 1, '🔴 the in-memory cart crossed the remount');
});

test('Codex s7a2 r1 #3: a STALE menu (verified > 60 s ago) never authorizes ordering — browse-only, revalidated, live in place when FRESH', async () => {
  let n = 0;
  const S = bootShell({ envelope: (rid) => (rid === 'x_pizza' && ++n > 1 ? 'hold' : 'ok') });
  await flush();
  S.clock.t += 61 * 1000;   // the fresh body ages into STALE; its revalidation will be held
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  if (!S.ui.store()) { await S.ui.dir.revalidate(); await flush(); S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); }
  const ui = S.ui.store().ui;
  assert.equal(S.ui.cache.peek('x_pizza').state, 'stale', 'premise: stale');
  assert.equal(ui.orderable(), false, '🔴 a stale body is browse-only');
  S.release('x_pizza'); await flush(); await flush();
  assert.equal(ui.orderable(), true, 'the fresh body turns it live in place');
});

test('Codex s7a2 r1 #4: a LATER terminal outcome settles the return handoff — pending return (kept) → «Ver estado del pedido» → paid ⇒ capp:return removed', async () => {
  const t0 = T0, polls = [{ ok: true, state: 'pending' }, { ok: true, state: 'paid' }];
  const storage = memStorage({ ...frozenCart(),
    'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_1', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, dispatched: 1, cart_gen: 'g_1', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }) });
  const apiFetch = async (u) => { const j = u.startsWith('/x/s') ? (polls.length > 1 ? polls.shift() : polls[0]) : { ok: false }; return { status: 200, ok: true, json: async () => j }; };
  const S = bootShell({ storage, search: `?pay=cancel&order=${ORDER}&t=pt_9`, apiFetch });
  await flush(); await flush();
  assert.equal(S.ui.store() && S.ui.store().rid, 'x_pizza', 'premise: the owner store handles its return');
  assert.ok(storage.getItem('capp:return'), 'premise: a pending outcome keeps the handoff');
  S.click('#layer [data-act="lclose"]'); await flush();
  S.ui.store().ui.state.screen = 'store'; S.ui.store().ui.render(); S.ui.store().ui.openCart(); await flush();
  S.click('#layer [data-act="frozen-status"]'); await flush(); await flush();
  assert.equal(storage.getItem('capp:return'), null, '🔴 the later terminal outcome settled the handoff');
});

test('Codex s7a2 r1 #5: a tap HELD while the directory read is in flight is released to frame 7 when that read fails', async () => {
  const gate = deferred();
  // menus held: no other event may re-run the held-tap check (only the directory's own notification can release it)
  const S = bootShell({ dirScript: [gate, 'complete'], envelope: 'hold', storage: memStorage(stored(SC.complete.body, T0 - 1000)) });
  S.click('.rlist .rcard[data-rid="x_pizza"]');
  assert.ok(S.q('.rlist .rcard[data-rid="x_pizza"]').classList.contains('held'), 'premise: held while the read is in flight');
  gate.resolve(resp('unavailable_503')); await flush();
  assert.equal(txt(S.q('.empty b')), 'No pudimos cargar los restaurantes', '🔴 the failed read releases the held tap to frame 7');
});

test('Codex s7a2 r1 #6: frame 13 discloses PER CONFIGURATION — two changed configurations of one dish ⇒ two lines, each with its own unit prices', async () => {
  const S = bootShell({ envelope: 'ok' });
  await flush();
  // the mockup's cart (plain + Pepperoni), last seen at today's prices, restored onto a menu where Carnivora is +26
  const ui0 = (S.click('.rlist .rcard[data-rid="x_pizza"]'), await flush(), S.ui.store().ui);
  const m = ui0.menu, carn = m.dishes.find((d) => d.name === 'Carnivora'), pep = m.extrasFor(carn.key).find((e) => e.name === 'Pepperoni');
  const c = (p) => Math.round(p * 100);
  const snap = { v: 2, rid: 'x_pizza', mode: 'delivery', cart_gen: 'g_2', lines: [{ key: carn.key, qty: 2, ex: [{}, { [pep.key]: 1 }], added: 1, seen: [{ b: c(carn.price - 26), x: {} }, { b: c(carn.price - 26), x: { [pep.key]: c(pep.price) } }] }] };
  ui0.restore(snap); ui0.openCart(); await flush();
  assert.deepEqual(S.qa('#layer .cartnote[role="status"] .cn-l').map((l) => l.textContent),
    [`Cambió el precio de Carnivora: antes L ${carn.price - 26}, ahora L ${carn.price}.`, `Cambió el precio de Carnivora + Pepperoni: antes L ${carn.price - 26 + pep.price}, ahora L ${carn.price + pep.price}.`],
    '🔴 one line per changed configuration, with its configured unit prices');
});

test('Codex s7a2 r1 #7: an UNPRICED fee never carries a promotional claim — no «Envío gratis» for a member, no guest pill / tag, no «Envío gratis» chip', () => {
  const rows = rowsOf(SC.fee_none.body).map((r) => (r.rid === 'la_musa' ? { ...r, entry: { ...r.entry, promo: { free_delivery: true, label: 'x' } } } : r));
  for (const auth of ['member', 'guest']) {
    const d = dom(CappHome.homeHtml(VM({ rows, auth })));
    const lm = d.querySelector('.rlist .rcard[data-rid="la_musa"]'), sc = d.querySelector('.scard .rt[data-rid="la_musa"]').closest('.scard');
    assert.ok(!/Envío gratis/.test(txt(lm)) && !/Envío gratis/.test(txt(sc)), `🔴 ${auth}: no promotional claim without a priced fee`);
  }
  assert.ok(![...dom(CappHome.homeHtml(VM({ rows: rows.filter((r) => r.rid === 'la_musa'), auth: 'member' }))).querySelectorAll('.fchip')].some((b) => /Envío gratis/.test(b.textContent)), 'no free-delivery chip from an unpriced store');
});

test('Codex s7a2 r1 #8: ADJACENT tombstones keep their slots — [A,B,C,D] then complete [A,D] shows A,B(gone),C(gone),D; the next visit shows A,D', async () => {
  const e0 = SC.complete.body.restaurants[0];
  const body = (ids) => ({ ...SC.complete.body, restaurants: ids.map((id) => ({ ...e0, restaurant_id: id })) });
  const R = rigDir({ script: [{ status: 200, body: body(['a', 'b', 'c', 'd']), etag: '"1"' }, { status: 200, body: body(['a', 'd']), etag: '"2"' }] });
  R.dir.boot(); await R.dir.revalidate(); await R.dir.revalidate();
  assert.deepEqual(R.dir.view().rows.map((r) => `${r.rid}${r.gone ? '·gone' : ''}`), ['a', 'b·gone', 'c·gone', 'd'], '🔴 every tombstone keeps its slot until the next visit');
  R.dir.visit();
  assert.deepEqual(R.dir.view().rows.map((r) => r.rid), ['a', 'd']);
});

test('Codex s7a2 r1 #9: never «No encontramos» over an incomplete DIRECTORY — cold ⇒ «Buscando platos…»; error or partial ⇒ the partial note', () => {
  const q = 'zzzqqq';
  const cold = txt(dom(CappHome.searchHtml(VM({ tab: 'search', q, rows: [], phase: 'cold' }))).querySelector('#results'));
  assert.ok(!/No encontramos/.test(cold) && /Buscando platos…/.test(cold), `🔴 a cold directory is loading: ${cold}`);
  for (const over of [{ rows: [], phase: 'error' }, { partial: true }]) {
    const r = txt(dom(CappHome.searchHtml(VM({ tab: 'search', q, ...over }))).querySelector('#results'));
    assert.ok(!/No encontramos/.test(r) && /^Algunos menús no cargaron; puede haber más platos\./.test(r), `🔴 ${JSON.stringify(over)}: never «No encontramos» — ${r}`);
  }
  assert.match(txt(dom(CappHome.searchHtml(VM({ tab: 'search', q }))).querySelector('#results')), /^No encontramos/, 'a ready, complete directory with every menu fresh still says it');
});

// ── PLAN-capp-signin-required r5.4 G2: the device marker (§4c) and the guest Cuenta tab (frame 5b) ──
const DA = require('./capp-device-account.js');
test('G2 §4c device marker: the full E.164 + a hint (never a token); last 4 for display; malformed never stored; only forget() clears it', () => {
  const st = memStorage();
  assert.equal(DA.read(st), null);
  assert.equal(DA.remember(st, '96123344'), false, 'not E.164 ⇒ never stored'); assert.equal(DA.read(st), null);
  assert.equal(DA.remember(st, '+50496123344'), true);
  assert.deepEqual(DA.read(st), { e164: '+50496123344', last4: '3344' });
  assert.deepEqual(JSON.parse(st.getItem('capp:device_account')), { v: 1, account: true, e164: '+50496123344' }, '🔴 no token, no name');
  assert.equal(DA.forget(st), true); assert.equal(DA.read(st), null);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(DA.read(broken), null); assert.equal(DA.remember(broken, '+50496123344'), false);
});
test('G2 frame 5b: a guest\'s Cuenta tab = ONE «Entrá o creá tu cuenta» + three benefits, «Pedidos» and «Ayuda» kept; unresolved ⇒ the card hidden (geometry kept); a member ⇒ the host', async () => {
  const GR = { ...RUNTIME, guestCardOnly: true };
  const S = bootShell({ auth: 'guest', runtime: GR }); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.equal(txt(S.q('.flowbar h1')), 'Cuenta');
  assert.deepEqual(S.qa('.guestcard li').map((l) => txt(l)), ['Efectivo al entregar o al recoger', 'Recompensas, promos y envío gratis', 'Programá pedidos y guardá tu dirección']);
  assert.equal(S.qa('.guestcard button.primary').length, 1); assert.equal(txt(S.q('.guestcard .primary')), 'Entrá o creá tu cuenta');
  assert.deepEqual(S.qa('.rows .rowbtn').map((b) => txt(b)), ['Pedidos Los de este teléfono', 'Ayuda']);
  assert.equal(S.q('.tabbar [data-tab="account"]').getAttribute('aria-current'), 'true');
  const U = bootShell({ auth: 'unresolved', runtime: GR }); await flush();
  U.click('.tabbar [data-tab="account"]'); await flush();
  assert.equal(U.q('.guestcard').getAttribute('style'), 'visibility:hidden', '🔴 never shown as a guest before auth resolves');
  assert.equal(U.q('.guestcard button'), null, 'no actionable button while unresolved');
  const M = bootShell({ auth: 'member', runtime: GR }); await flush();
  M.click('.tabbar [data-tab="account"]'); await flush();
  assert.equal(M.q('.guestcard'), null, 'a member\'s Cuenta is the host\'s (a later slice)');
});

test('Codex guest r1 #3: with the guest flag ABSENT the Cuenta tab is exactly the S7a-2 behaviour — a host event, Inicio stays, the DOM unchanged', async () => {
  const S = bootShell({ auth: 'guest' }); await flush();
  const before = S.q('#app').innerHTML;
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.deepEqual(S.events.filter(([n]) => n === 'tab'), [['tab', { tab: 'account' }]], 'the host gets the tab, as before');
  assert.equal(S.q('.guestcard'), null, '🔴 no guest Cuenta without the flag');
  assert.equal(S.ui.state.tab, 'home'); assert.equal(S.q('#app').innerHTML, before, 'the DOM is byte-identical');
});

// advisor 2026-10-27: shell.html is an orders-app ENTRYPOINT — the real stamp tool stamps it, SherpaClient goes live on it, and the
// shell's createOrder carries X-Client-Deployment: orders-app (the server's deployment gate)
test('stamp: shell.html is stamped as orders-app; on the stamped shell SherpaClient is LIVE and the shell\'s createOrder carries X-Client-Deployment: orders-app', async () => {
  const { mkdtempSync, cpSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const Stamp = require(join(ROOT, 'platform/stamp-version.js'));
  const tmp = mkdtempSync(join(tmpdir(), 'capp-stamp-')), dir = join(tmp, 'customer-app');
  cpSync(HERE, dir, { recursive: true, filter: (src) => !/node_modules/.test(src) });
  try {
    const r = Stamp.stamp(dir, { siteName: 'sherpa-pedir', commit: 'c0ffee', env: 'preview' });
    assert.ok(r.ok, r.error); assert.equal(r.deployment, 'orders-app');
    assert.ok(r.files.includes('shell.html'), '🔴 shell.html is stamped');
    assert.ok(readFileSync(join(dir, 'shell.html'), 'utf8').includes('<meta name="sherpa-deployment" content="orders-app">'));
    const sent = [];
    const pageFetch = async (u, i) => {
      const url = String(u), ep = url.split('?')[0].split('/').pop(); sent.push({ ep, h: (i && i.headers) || {} });
      const body = i && i.body ? JSON.parse(i.body) : null;
      const json = ep === 'quoteOrder' ? { ok: true, total_cents: body.items.reduce((a, x) => a + Math.round(x.subtotal * 100), 0), net_total_cents: body.items.reduce((a, x) => a + Math.round(x.subtotal * 100), 0) + 4500,
        delivery: { mode: 'delivery', delivery_cents: 4500, promo_discount_cents: 0, policy_version: 'p1', from_cents: 3500, max_km: 6 } }
        : ep === 'createOrder' ? { ok: true, order_id: body.order_id } : { build: r.build, compat: r.compat };
      return { status: 200, ok: true, json: async () => json, clone() { return this; } };
    };
    const EPS = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus' };
    const S = bootShell({ stampedDir: dir, pageFetch, runtime: { ...RUNTIME, endpoints: EPS }, geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
    try {
      assert.equal(S.w.SherpaClient.inert, false, '🔴 SherpaClient is live on the stamped shell');
      assert.equal(S.w.SherpaClient.identity.deployment, 'orders-app');
      await flush();
      S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); await flush();
      const ui = S.ui.store().ui; assert.equal(ui.orderable(), true, 'premise: a verified menu');
      const plain = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
      ui.cart.inc(plain.key); ui.render();
      const type = (sel, v) => { const el = S.q(sel); assert.ok(el, `premise: ${sel}`); el.value = v; el.dispatchEvent(new S.w.Event('input', { bubbles: true })); };
      S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush();
      S.click('[data-act="pin"]'); await flush(); S.click('[data-act="pin-done"]'); await flush();
      type('#f-details', 'Portón negro'); type('#f-name', 'Ana'); type('#f-phone', '9999 0000'); await flush();
      S.click('[data-act="pay"][data-val="cash"]'); await flush();
      S.click('#cta'); await flush(); S.click('[data-act="tipc"][data-val="0"]'); await flush(); S.click('[data-act="tip-place"]'); await flush();
      S.click('#layer [data-act="placing-go"]'); await flush(); await flush();
      const co = sent.filter((s) => s.ep === 'createOrder');
      assert.equal(co.length, 1, 'premise: the shell sent ONE createOrder');
      assert.equal(co[0].h['X-Client-Deployment'], 'orders-app', '🔴 the shell\'s createOrder carries X-Client-Deployment: orders-app');
      assert.equal(co[0].h['X-Client-App'], 'orders'); assert.equal(co[0].h['X-Client-Build'], r.build);
    } finally { S.w.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── G6: the in-app sign-in, owned by the shell when the runtime carries the signup config (DARK: absent ⇒ exactly as before) ──
function fakeFirebase({ persisted = null } = {}) {
  const calls = { load: 0, ct: [], out: 0 }; let listeners = [], user = persisted;
  const auth = { get currentUser() { return user ? { uid: user, getIdToken: async () => `id:${user}` } : null; } };
  const emitU = () => { for (const l of listeners) l(user ? { uid: user } : null); };
  const authMod = { browserLocalPersistence: 'LOCAL', getAuth: () => auth, setPersistence: async () => {},
    onAuthStateChanged: (a, next) => { listeners.push(next); Promise.resolve().then(() => next(user ? { uid: user } : null)); return () => { listeners = listeners.filter((x) => x !== next); }; },
    signInWithCustomToken: async (a, t) => { calls.ct.push(t); user = t.replace(/^ct:/, ''); emitU(); return { user: { uid: user } }; },
    signOut: async () => { calls.out++; user = null; emitU(); } };
  return { calls, loadSdk: async () => { calls.load++; return { initializeApp: () => ({}), authMod }; } };
}
const SU_EP = Object.fromEntries(['requestOtp', 'verifyOtp', 'getSignupConfig', 'googleStart', 'googleSignIn', 'completeProfile', 'redeemSignupGrant'].map((k) => [k, `https://fn.test/${k}`]));
const SU_RUNTIME = { ...RUNTIME, guestCardOnly: true, signup: { firebase: { apiKey: 'k_test', projectId: 'p' }, endpoints: SU_EP } };
function signupServer(verify) {
  const sent = [];
  const fetch = async (u, i) => { const ep = u.split('?')[0].split('/').pop(); sent.push([ep, i && i.body ? JSON.parse(i.body) : null]);
    const j = ep === 'getSignupConfig' ? { ok: true, terms_url: 'https://legal.test/t', privacy_url: 'https://legal.test/p', legal_ready: true, google_enabled: false } : ep === 'verifyOtp' ? verify : { ok: true, cooldown: 30 };
    return { status: 200, json: async () => j }; };
  return { fetch, sent };
}
const ANA = { ok: true, token: 'ct:u_ana', is_new: false, name: 'Ana Pérez', completion: 'complete', profile: { name: 'Ana Pérez', email: 'ana@gmail.com' } };
const suHost = (S) => S.q('#su-host');
async function signInViaSheet(S) {
  S.click('.tabbar [data-tab="account"]'); await flush();
  S.click('.guestcard .primary'); await flush();
  const h = suHost(S); assert.ok(h && h.classList.contains('open'), 'premise: the sheet opened in the shell\'s own layer');
  const ph = h.querySelector('#su-phone'); ph.value = '99990000'; ph.dispatchEvent(new S.w.Event('input', { bubbles: true }));
  S.click(h.querySelector('[data-su="phone-go"]')); await flush();
  const b0 = h.querySelector('[data-su-otp="0"]'); b0.value = '482913'; b0.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
  S.click(h.querySelector('[data-su="verify"]')); await flush(); await flush();
}

test('G6 flag-absent: no runtime.signup ⇒ «Entrá o creá tu cuenta» is the HOST\'s \'signin\' event, as before — no SDK load, no sheet layer', async () => {
  const fb = fakeFirebase();
  const S = bootShell({ auth: 'guest', runtime: { ...RUNTIME, guestCardOnly: true }, mountExtra: { loadSdk: fb.loadSdk } }); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush(); S.click('.guestcard .primary'); await flush();
  assert.deepEqual(S.events.filter((e) => e[0] === 'signin'), [['signin', { ctx: 'account' }]]);
  assert.equal(suHost(S), null); assert.equal(fb.calls.load, 0, '🔴 the Auth SDK is never loaded without the signup config');
});
test('G6 shell: the SDK after the first paint; «Entrá» opens the sheet; a verified existing account ⇒ member, the device marker + the profile cache; an ordinary sign-out clears the cache, keeps the marker', async () => {
  const fb = fakeFirebase(); const srv = signupServer(ANA); const storage = memStorage();
  const S = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: srv.fetch } });
  assert.equal(fb.calls.load, 0, 'never before the first paint'); await flush(); await flush();
  assert.equal(fb.calls.load, 1, 'loaded after it');
  await signInViaSheet(S);
  assert.deepEqual(srv.sent.filter((x) => x[0] !== 'getSignupConfig'), [['requestOtp', { phone: '+50499990000', context: 'platform' }], ['verifyOtp', { phone: '+50499990000', code: '482913', context: 'platform' }]]);
  assert.deepEqual(fb.calls.ct, ['ct:u_ana']);
  assert.equal(txt(suHost(S).querySelector('.sg .h1')), '¡Hola de nuevo, Ana!');
  S.click(suHost(S).querySelector('[data-su="finish"]')); await flush();
  assert.equal(suHost(S).classList.contains('open'), false, 'closed');
  assert.deepEqual(JSON.parse(storage.getItem('capp:device_account')), { v: 1, account: true, e164: '+50499990000' });
  assert.deepEqual(JSON.parse(storage.getItem('capp:member_profile')), { v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' });
  assert.deepEqual(J(S.ui.state.member), { uid: 'u_ana', name: 'Ana Pérez', phone: '99990000', email: 'ana@gmail.com', idToken: 'id:u_ana' });
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.deepEqual(S.events.filter((e) => e[0] === 'tab').pop(), ['tab', { tab: 'account' }], 'a member\'s Cuenta is the host\'s');
  await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush();
  assert.equal(storage.getItem('capp:member_profile'), null, '🔴 an ordinary sign-out clears the cached profile');
  assert.ok(storage.getItem('capp:device_account'), 'the device marker is kept (§4c)');
  assert.equal(S.ui.state.member, null);
});
test('G6 shell: a RESTORED session autofills from the cached profile of THAT uid at once; another uid\'s cache is never used', async () => {
  const prof = JSON.stringify({ v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' });
  const fb = fakeFirebase({ persisted: 'u_ana' });
  const S = bootShell({ auth: 'unresolved', storage: memStorage({ 'capp:member_profile': prof }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.deepEqual(J(S.ui.state.member), { uid: 'u_ana', name: 'Ana Pérez', phone: '99990000', email: 'ana@gmail.com', idToken: 'id:u_ana' }, '🔴 restored ⇒ autofilled from the cache');
  const fb2 = fakeFirebase({ persisted: 'u_other' });
  const O = bootShell({ auth: 'unresolved', storage: memStorage({ 'capp:member_profile': prof }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb2.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.deepEqual(J(O.ui.state.member), { uid: 'u_other', name: '', phone: '', email: '', idToken: 'id:u_other' }, '🔴 another member\'s cached profile is never shown');
});
