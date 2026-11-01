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
function bootShell({ dirScript = ['complete'], envelope = 'ok', storage, auth = 'guest', now, geolocation = null, search = '', fetchLog = [], apiFetch = null, runtime = RUNTIME, stampedDir = null, pageFetch = null, mountExtra = {}, media = null, url = null } = {}) {
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const html = readFileSync(join(stampedDir || HERE, 'shell.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '').replace('</head>', () => `<style>${css}</style></head>`);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: url || 'https://app.test/' });
  const w = dom.window;
  if (media) w.matchMedia = media.matchMedia;   // D-2: the viewport the shell reads at mount (a controllable matchMedia)
  if (stampedDir) { w.fetch = pageFetch; w.eval(readFileSync(join(stampedDir, 'sherpa-client.js'), 'utf8')); }   // the page's FIRST script
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-confirm-quote.js', 'capp-checkout.js', 'capp-api.js', 'capp-ui.js', 'capp-eligibility.js', 'capp-auth-state.js',
    'capp-menu-cache.js', 'capp-directory.js', 'capp-shell.js', 'capp-shell-nav.js', 'capp-home.js', 'capp-device-account.js', 'capp-auth-firebase.js', 'capp-signup-api.js', 'capp-signup.js', 'capp-schedule.js', 'capp-phone.js', 'capp-routes.js', 'capp-view.js', 'capp-shell-ui.js']) w.eval(readFileSync(join(HERE, f), 'utf8'));
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
  { const row = S.q('.rlist .rcard[data-rid="x_pizza"]'); assert.ok(!!row && row.classList.contains('held'), 'the drawn pressed state'); } assert.equal(S.ui.store(), null);   // null-safe: an unverified entry removes the row (s7a2-15 dies HERE, by name)
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
  { const row = S.q('.rlist .rcard[data-rid="x_pizza"]'); assert.ok(!!row && row.classList.contains('held'), 'the drawn pressed state: held while the read is in flight'); }
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
  // PLAN-capp-desktop-website r2 (advisor ruling): «Pedidos» has no screen ⇒ its row is left out (capp-home ORDERS_SCREEN)
  assert.deepEqual(S.qa('.rows .rowbtn').map((b) => txt(b)), ['Ayuda']);
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
    // the site name from the manifest (config), never a literal — platform-domain-swap scans tests too
    const site = (JSON.parse(readFileSync(join(ROOT, 'platform/sites.json'), 'utf8')).deployments.find((d) => d.folder === 'customer-app') || {}).netlify_site;
    assert.ok(typeof site === 'string' && site.length > 0, 'premise: the manifest names the app\'s Netlify site');
    const r = Stamp.stamp(dir, { siteName: site, commit: 'c0ffee', env: 'preview' });
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
function fakeFirebase({ persisted = null, hold = null, failSignOut = 0 } = {}) {
  const calls = { load: 0, ct: [], out: 0 }; let listeners = [], user = persisted;
  // hold: { on, q } — while on, every token read waits for the test to release it (a slow SDK)
  const tok = (u) => (hold && hold.on ? new Promise((r) => hold.q.push(() => r(`id:${u}`))) : Promise.resolve(`id:${u}`));
  const auth = { get currentUser() { const u = user; return u ? { uid: u, getIdToken: () => tok(u) } : null; } };
  const emitU = () => { for (const l of listeners) l(user ? { uid: user } : null); };
  const authMod = { browserLocalPersistence: 'LOCAL', getAuth: () => auth, setPersistence: async () => {},
    onAuthStateChanged: (a, next) => { listeners.push(next); Promise.resolve().then(() => next(user ? { uid: user } : null)); return () => { listeners = listeners.filter((x) => x !== next); }; },
    signInWithCustomToken: async (a, t) => { calls.ct.push(t); user = t.replace(/^ct:/, ''); emitU(); return { user: { uid: user } }; },
    signOut: async () => { calls.out++; if (failSignOut > 0) { failSignOut--; throw new Error('network'); } user = null; emitU(); } };
  return { calls, loadSdk: async () => { calls.load++; return { initializeApp: () => ({}), authMod }; } };
}
const SU_EP = Object.fromEntries(require('./capp-signup-api.js').ENDPOINTS.map((k) => [k, `https://fn.test/${k}`]));   // the ONE source of the set
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
  assert.equal(await S.ui.state.member.getIdToken(), 'id:u_ana', 'the transport\'s send-time token comes from the SDK');
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.equal(S.q('.acct-hero .t b') && S.q('.acct-hero .t b').textContent, 'Ana Pérez', 'G7: a member\'s Cuenta is the shell\'s (under runtime.signup)'); assert.equal(S.events.filter((e) => e[0] === 'tab').length, 0);
  await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush();
  assert.equal(storage.getItem('capp:member_profile'), null, '🔴 an ordinary sign-out clears the cached profile');
  assert.ok(storage.getItem('capp:device_account'), 'the device marker is kept (§4c)');
  assert.equal(S.ui.state.member, null);
});
test('G6 shell: a RESTORED session autofills from the cached profile of THAT uid at once; another uid\'s cache is never used', async () => {
  const prof = JSON.stringify({ v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' });
  const fb = fakeFirebase({ persisted: 'u_ana' });
  const S = bootShell({ auth: 'unresolved', storage: memStorage({ 'capp:member_profile': prof, 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_ana' }) }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.deepEqual(J(S.ui.state.member ?? null), { uid: 'u_ana', name: 'Ana Pérez', phone: '99990000', email: 'ana@gmail.com', idToken: 'id:u_ana' }, '🔴 restored ⇒ autofilled from the cache');
  const fb2 = fakeFirebase({ persisted: 'u_other' });
  const O = bootShell({ auth: 'unresolved', storage: memStorage({ 'capp:member_profile': prof, 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_other' }) }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb2.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.deepEqual(J(O.ui.state.member ?? null), { uid: 'u_other', name: '', phone: '', email: '', idToken: 'id:u_other' }, '🔴 another member\'s cached profile is never shown');
  // Codex G7 r1 #2 purges a mismatched cache first; when that removal FAILS, the read itself still refuses another uid's profile
  const stuck = memStorage({ 'capp:member_profile': prof, 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_other' }) }); stuck.removeItem = () => { throw new Error('denied'); };
  const fb3 = fakeFirebase({ persisted: 'u_other' });
  const P = bootShell({ auth: 'unresolved', storage: stuck, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb3.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.equal(stuck.getItem('capp:member_profile'), prof, 'premise: the purge could not remove the cache');
  assert.deepEqual(J(P.ui.state.member ?? null), { uid: 'u_other', name: '', phone: '', email: '', idToken: 'id:u_other' }, '🔴 another member\'s cached profile is never shown (the purge failed)');
});

// ── Codex G6 r1 (#1 / #2 / #3): the member never outlives its session in the mounted checkout ──
const quoteOk = async (u, i) => { const b = JSON.parse(i.body); const food = b.items.reduce((a, x) => a + Math.round(x.subtotal * 100), 0);
  return { status: 200, ok: true, json: async () => ({ ok: true, total_cents: food, net_total_cents: food + 4500, delivery: { mode: 'delivery', delivery_cents: 4500, promo_discount_cents: 0, policy_version: 'p1', from_cents: 3500, max_km: 6 } }) }; };
async function toShellCheckout(S) {
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); await flush();
  const ui = S.ui.store().ui; const plain = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
  ui.cart.inc(plain.key); ui.render(); S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush(); await flush();
  assert.equal(ui.state.screen, 'checkout', 'premise: the checkout is mounted');
  return ui;
}
async function sheetVerify(S, phone = '99990000') {
  const h = suHost(S); const ph = h.querySelector('#su-phone'); ph.value = phone; ph.dispatchEvent(new S.w.Event('input', { bubbles: true }));
  S.click(h.querySelector('[data-su="phone-go"]')); await flush();
  const b0 = h.querySelector('[data-su-otp="0"]'); b0.value = '482913'; b0.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
  S.click(h.querySelector('[data-su="verify"]')); await flush(); await flush();
}
test('Codex G6 r1 #1: a sign-out — and a close mid-completion — reaches the MOUNTED checkout: its next send carries no member token', async () => {
  const quotes = []; const apiFetch = (u, i) => { if (u.startsWith('/x/q')) { quotes.push(i.headers['x-firebase-id-token'] || null); return quoteOk(u, i); } return new Promise(() => {}); };
  const fb = fakeFirebase();
  const S = bootShell({ auth: 'unresolved', runtime: SU_RUNTIME, apiFetch, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush();
  const ui = await toShellCheckout(S);
  S.click('#app [data-act="signin"]'); await flush(); await sheetVerify(S);
  assert.equal(fb.calls.out, 0, '🔴 mid-sheet the SDK callback never signs the sheet\'s own session out (the sheet owns its outcome)');
  S.click(suHost(S).querySelector('[data-su="finish"]')); await flush(); await flush();
  S.click('#app [data-act="type"][data-val="pickup"]'); await flush(); await flush();
  assert.equal(quotes[quotes.length - 1], 'id:u_ana', 'premise: the member\'s quote carries the member token');
  await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush(); await flush();
  const n = quotes.length; S.click('#app [data-act="type"][data-val="delivery"]'); await flush(); S.click('#app [data-act="type"][data-val="pickup"]'); await flush(); await flush();   // pickup as a guest: never quoted yet
  assert.ok(quotes.length > n, 'premise: a new send'); assert.equal(quotes[quotes.length - 1], null, '🔴 after a sign-out the mounted checkout sends no member token');
  // a close MID-completion: never a member in the checkout — before or after the close
  const q2 = []; const fb2 = fakeFirebase();
  const M = bootShell({ auth: 'unresolved', runtime: SU_RUNTIME, apiFetch: (u, i) => { if (u.startsWith('/x/q')) { q2.push(i.headers['x-firebase-id-token'] || null); return quoteOk(u, i); } return new Promise(() => {}); },
    mountExtra: { loadSdk: fb2.loadSdk, signupFetch: signupServer({ ok: true, token: 'ct:u_new', is_new: true, completion: 'needed' }).fetch } }); await flush(); await flush();
  await toShellCheckout(M);
  M.click('#app [data-act="signin"]'); await flush(); await sheetVerify(M);
  assert.equal(txt(suHost(M).querySelector('.sg .h1')), 'Tu correo', 'premise: verified, completion owed');
  assert.equal(fb2.calls.out, 0, '🔴 mid-sheet the SDK callback never signs the sheet\'s own session out (the sheet owns its outcome)');
  M.click('#app [data-act="type"][data-val="pickup"]'); await flush(); await flush();
  assert.equal(q2[q2.length - 1], null, '🔴 mid-completion the checkout is not a member');
  M.click(suHost(M).querySelector('[data-su="close"]')); await flush(); await flush();
  M.click('#app [data-act="type"][data-val="delivery"]'); await flush(); await flush();
  assert.equal(q2[q2.length - 1], null, '🔴 closed mid-completion ⇒ no member token');
  assert.equal(M.ui.state.member, null);
});
test('Codex G6 r2 #2 — the ALLOW-list: a restored uid is a member ONLY with its completion mark; the mark is written at «Listo», cleared by a confirmed sign-out', async () => {
  const boot = (fb, storage) => bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } });
  // a crash between the SDK persisting the uid and «Listo»: the uid is there, no mark
  const fb = fakeFirebase({ persisted: 'u_new' }); const S = boot(fb, memStorage()); await flush(); await flush(); await flush();
  assert.equal(S.ui.state.member, null, '🔴 a restored uid without its mark is never a member'); assert.equal(fb.calls.out, 1, 'signed out');
  // a mark for A, B restored ⇒ signed out
  const fb2 = fakeFirebase({ persisted: 'u_b' }); const st2 = memStorage({ 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_a' }) });
  const B = boot(fb2, st2); await flush(); await flush(); await flush();
  assert.equal(B.ui.state.member, null, '🔴 another uid\'s mark never admits this one'); assert.equal(fb2.calls.out, 1);
  // a completed member restores normally
  const fb3 = fakeFirebase({ persisted: 'u_ana' }); const M = boot(fb3, memStorage({ 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_ana' }) })); await flush(); await flush(); await flush();
  assert.equal(M.ui.state.member && M.ui.state.member.uid, 'u_ana'); assert.equal(fb3.calls.out, 0, 'never signed out');
  // «Listo» writes the mark; a confirmed sign-out clears it
  const st4 = memStorage(); const fb4 = fakeFirebase(); const P = boot(fb4, st4); await flush(); await flush();
  await signInViaSheet(P); P.click(suHost(P).querySelector('[data-su="finish"]')); await flush();
  assert.deepEqual(JSON.parse(st4.getItem('capp:member_complete')), { v: 1, uid: 'u_ana' }, 'written at «Listo»');
  await (await fb4.loadSdk()).authMod.signOut(); await flush();
  assert.equal(st4.getItem('capp:member_complete'), null, 'cleared by the confirmed sign-out');
});
test('Codex G6 r2 #2 — a REJECTED sign-out admits nothing: still not a member at the next restore, and the sign-out is retried', async () => {
  const storage = memStorage(); const fb = fakeFirebase({ persisted: 'u_new', failSignOut: 1 });
  const S = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush(); await flush();
  assert.equal(S.ui.state.member, null); assert.equal(fb.calls.out, 1, 'premise: the sign-out was tried (and rejected)');
  // the next page load: the SDK still restores u_new (the sign-out never happened)
  const fb2 = fakeFirebase({ persisted: 'u_new' });
  const R = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb2.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush(); await flush();
  assert.equal(R.ui.state.member, null, '🔴 still not a member after a rejected sign-out'); assert.equal(fb2.calls.out, 1, 'retried');
});
test('Codex G6 r1 #3: a member apply delayed by a slow token never lands after a sign-out or a switch to another account', async () => {
  for (const after of ['signout', 'switch']) {
    const hold = { on: false, q: [] }; const fb = fakeFirebase({ hold }); const storage = memStorage();
    const S = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush();
    S.click('.tabbar [data-tab="account"]'); await flush(); S.click('.guestcard .primary'); await flush(); await sheetVerify(S);
    hold.on = true; S.click(suHost(S).querySelector('[data-su="finish"]')); await flush();
    assert.equal(S.ui.state.member, null, 'premise: A\'s apply is waiting on its token');
    const { authMod } = await fb.loadSdk();
    // the switch: B, an account whose completion is on record (the allow-list admits it)
    if (after === 'signout') await authMod.signOut(); else { storage.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_b' })); await authMod.signInWithCustomToken(null, 'ct:u_b'); }
    await flush(); hold.on = false; for (const r of hold.q.splice(0)) r(); await flush(); await flush();
    if (after === 'signout') assert.equal(S.ui.state.member, null, '🔴 a late apply never revives a signed-out member');
    else assert.equal(S.ui.state.member && S.ui.state.member.uid, 'u_b', '🔴 a late apply for A never overwrites B');
  }
});
test('Codex G6 r3: a complete account that leaves the sheet by Back then ✕ is a marked member and restores normally after a reload', async () => {
  const storage = memStorage(); const fb = fakeFirebase();
  const S = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush();
  await signInViaSheet(S);
  assert.equal(txt(suHost(S).querySelector('.sg .h1')), '¡Hola de nuevo, Ana!', 'premise');
  S.click(suHost(S).querySelector('[data-su="back"]')); await flush(); S.click(suHost(S).querySelector('[data-su="close"]')); await flush(); await flush();
  assert.deepEqual(JSON.parse(storage.getItem('capp:member_complete')), { v: 1, uid: 'u_ana' }, '🔴 marked');
  assert.equal(S.ui.state.member && S.ui.state.member.uid, 'u_ana', 'a member now'); assert.equal(fb.calls.out, 0);
  const fb2 = fakeFirebase({ persisted: 'u_ana' });
  const R = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb2.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush(); await flush();
  assert.equal(R.ui.state.member && R.ui.state.member.uid, 'u_ana', '🔴 the reload restores the completed account'); assert.equal(fb2.calls.out, 0, 'never signed out');
});
test('Codex G6 r4: a guest exit after a complete sign-in leaves NO mark and no member (its sign-out stands)', async () => {
  const storage = memStorage(); const fb = fakeFirebase();
  const S = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush();
  await toShellCheckout(S);
  S.click('#app [data-act="signin"]'); await flush(); await sheetVerify(S);
  const h = suHost(S); S.click(h.querySelector('[data-su="back"]')); await flush(); S.click(h.querySelector('[data-su="back"]')); await flush();
  S.click(h.querySelector('[data-su="guest"]')); await flush(); await flush();
  assert.equal(storage.getItem('capp:member_complete'), null, '🔴 never marked'); assert.equal(S.ui.state.member, null); assert.equal(fb.calls.out, 1, 'signed out');
});

// ── S4 in the shell: ONE runtime switch (it replaces opts.schedulingLive) ──
test('S4 shell: runtime.schedulingLive drives the Inicio cues (frame 3 B\'s sentence + «Programar pedido»); absent ⇒ none, as before', async () => {
  const late = { t: new Date(2026, 9, 20, 23, 30).getTime() };   // every store closed
  const on = bootShell({ now: late, runtime: { ...RUNTIME, schedulingLive: true } }); await flush();
  assert.match(txt(on.q('.hnote')) || '', /Podés programar tu pedido\./, '🔴 the cue from the runtime');
  assert.ok(on.qa('.pill.sched').length > 0, '«Programar pedido» where the SERVED schedule offers a slot');
  const off = bootShell({ now: late }); await flush();
  assert.equal(/Podés programar/.test(txt(off.q('.hnote')) || ''), false); assert.equal(off.qa('.pill.sched').length, 0);
});
test('S4 frame G in the shell (schedulingLive + G6): a guest\'s «Programar» in the mounted checkout opens the sheet with ONLY the G=B subtitle and the guest exit; G6 without the flag keeps its member-only gate', async () => {
  const fb = fakeFirebase();
  const S = bootShell({ auth: 'unresolved', runtime: { ...SU_RUNTIME, schedulingLive: true }, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } }); await flush(); await flush();
  const ui = await toShellCheckout(S);
  S.click('#app [data-act="time"][data-val="schedule"]'); await flush();
  const h = suHost(S); assert.ok(h && h.classList.contains('open'), 'premise: the sheet');
  assert.equal(txt(h.querySelector('.sg .sub')), 'Para programar tu pedido necesitás una cuenta.', '🔴 G = B');
  assert.equal(txt(h.querySelector('[data-su="guest"]')), 'Prefiero seguir como invitado');
  S.click(h.querySelector('[data-su="guest"]')); await flush();
  assert.equal(ui.state.flow.time, 'asap', 'the order stays ASAP');
});

// ── S7a-2 follow-up (MOCKUP-capp-S7a-states frames 15–18, approved) ──
test('S7a-2 frames 16 / 17 / 18: every menu down ⇒ «No pudimos buscar platos» + [Reintentar] under the directory\'s matches; no city ⇒ «{N} restaurantes»; no recents ⇒ the search .empty (no button)', () => {
  const allDown = rowsOf(SC.complete.body, { x_pizza: 'failed', la_musa: 'failed' });
  const down = dom(CappHome.searchHtml(VM({ tab: 'search', q: 'camarones', rows: allDown })));
  assert.equal(txt(down.querySelector('#results')), 'No pudimos buscar platos Ningún menú cargó. Revisá tu conexión e intentá de nuevo. Reintentar', '🔴 F16: the drawn all-menus-down block');
  assert.equal(down.querySelector('.empty .btn2').dataset.act, 'menus-retry');
  const nm = CappHome.storeOf(allDown[0]).name;
  const withStore = dom(CappHome.searchHtml(VM({ tab: 'search', q: nm, rows: allDown })));
  assert.deepEqual([...withStore.querySelectorAll('#results > h3, #results > .empty > b')].map((x) => x.textContent), ['Restaurantes', 'No pudimos buscar platos'], 'F16: the directory\'s matches above');
  const one = txt(dom(CappHome.searchHtml(VM({ tab: 'search', q: 'camarones', rows: rowsOf(SC.complete.body, { x_pizza: 'failed', la_musa: 'fresh' }) }))).querySelector('#results'));
  assert.ok(!/No pudimos buscar platos/.test(one), 'F16 premise: one menu answered ⇒ not frame 16');
  const noCity = { ...SC.complete.body.platform }; delete noCity.city_label;
  const home = dom(CappHome.homeHtml(VM({ platform: noCity })));
  assert.equal(txt(home.querySelector('.hsec[aria-label="Todos los restaurantes"] .hd p')), '2 restaurantes', '🔴 F17: «{N} restaurantes», never a bare number');
  assert.equal(txt(dom(CappHome.homeHtml(VM())).querySelector('.hsec[aria-label="Todos los restaurantes"] .hd p')), '2 en San Pedro Sula', 'F17 premise: with a city, as before');
  const empty = dom(CappHome.searchHtml(VM({ tab: 'search' })));
  assert.equal(txt(empty.querySelector('#results')), 'Buscá restaurantes o platos Tus búsquedas recientes van a aparecer aquí.', '🔴 F18: no recents ⇒ the drawn .empty');
  assert.ok(empty.querySelector('#results .empty svg') && !empty.querySelector('#results .empty button'), 'F18: the search icon, no button');
  const rec = dom(CappHome.searchHtml(VM({ tab: 'search', recent: ['pizza'] })));
  assert.equal(rec.querySelector('#results .empty'), null); assert.equal(rec.querySelector('#results h3').textContent, 'Búsquedas recientes');
});
test('S7a-2 frame 15: a held tap whose MENU does not load ⇒ «No pudimos abrir {restaurante}» over Inicio, the row still pressed; «Reintentar» re-fetches and enters; «Cerrar» releases the row', async () => {
  let mode = 'fail';
  const S = bootShell({ envelope: (rid) => (rid === 'la_musa' ? mode : 'ok') });
  await flush();
  const nm = S.q('.rlist .rcard[data-rid="la_musa"]') && CappHome.storeOf({ rid: 'la_musa', entry: SC.complete.body.restaurants.find((r) => r.restaurant_id === 'la_musa'), cfg: {} }).name;
  const before = S.envCalls.filter((r) => r === 'la_musa').length;
  mode = 'hold'; S.click('.rlist .rcard[data-rid="la_musa"]'); await flush();
  assert.ok(S.envCalls.filter((r) => r === 'la_musa').length > before, 'F15: the tap re-fetches the failed menu');
  assert.equal(S.q('#layer .errsheet'), null, '🔴 F15-refetch: no sheet while the re-fetch is in flight (the row pressed)');
  while ((S.pend.la_musa || []).length) { S.pend.la_musa.shift().resolve({ status: 500 }); await flush(); }   // the re-fetch (and its one retry) fails
  mode = 'fail';
  assert.equal(S.q('#layer .errsheet h2') && S.q('#layer .errsheet h2').textContent, `No pudimos abrir ${nm}`, '🔴 F15: the sheet over Inicio');
  assert.equal(S.q('#layer .errsheet p').textContent, 'Su menú no cargó. Revisá tu conexión e intentá de nuevo.');
  assert.deepEqual(S.qa('#layer .errsheet button').map((b) => b.textContent), ['Reintentar', 'Cerrar']);
  assert.ok(S.q('#layer .errsheet .icon.warn'), 'the .warn tint («Sin conexión»\'s)');
  assert.ok(S.q('.rlist .rcard[data-rid="la_musa"]').classList.contains('held'), '🔴 F15-held: the row stays pressed under the sheet');
  assert.equal(S.ui.store(), null);
  S.click('#layer [data-act="menu-close"]'); await flush();
  assert.equal(S.q('#layer .errsheet'), null); assert.ok(!S.q('.rlist .rcard[data-rid="la_musa"]').classList.contains('held'), 'F15: «Cerrar» releases the row');
  S.click('.rlist .rcard[data-rid="la_musa"]'); await flush();
  assert.ok(S.q('#layer .errsheet'), 'premise: the sheet again');
  mode = 'ok'; S.click('#layer [data-act="menu-retry"]'); await flush();
  assert.equal(S.ui.store() && S.ui.store().rid, 'la_musa', '🔴 F15-retry: «Reintentar» re-fetches and enters');
});

// ── G7 member Cuenta (MOCKUP-capp-member-cuenta-APPROVED-2026-10-27: frames 1 / 1b / 2 / 3 / 4a / 4b) — under runtime.signup ──
const G7_RUNTIME = SU_RUNTIME;   // the endpoint set (ENDPOINTS) carries setPromos
const G7_PROFILE = (o = {}) => ({ uid: 'u_ana', name: 'Ana Pérez', phone: '+50496123344', email: 'ana.perez@gmail.com', ...o });
const g7Store = (profile) => { const st = memStorage({ 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_ana' }) }); DA.remember(st, '+50496123344'); if (profile) DA.rememberProfile(st, profile); return st; };
// Codex G7 r1 #4 / r2: the setPromos fake mirrors 3a's REAL platform handler EXACTLY (wip/guest-s3 deb1594b: signup-endpoints.js setPromos +
// scopeOf, signup-core.js setPromos with confirm): the same checks in the same order and the same answers. ASSEMBLY OBLIGATION (train):
// a contract test against that real handler (TRAIN-NEXT-INVENTORY.md). state: 'ok' | 'not_completed' | 'legal_unconfigured' | 'deleted' | 'aborted'
function setPromosHandler(i, state = 'ok') {
  if (state === true) state = 'ok'; if (state === false) state = 'not_completed';
  if (!i || i.method !== 'POST') return [405, { ok: false }];
  let b = null; try { b = JSON.parse(i.body); } catch (_) { b = null; } b = b && typeof b === 'object' ? b : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  // scopeOf: no `context` key ⇒ the forms' path (a known restaurant_id — none here); else EXACTLY context:'platform' and no restaurant_id key
  const scope = !has('context') ? null : b.context === 'platform' && !has('restaurant_id') ? '_platform' : null;
  if (!scope) return [400, { ok: false, reason: 'bad_request' }];
  if (!(i.headers && i.headers['x-firebase-id-token'])) return [401, { ok: false, reason: 'unauthenticated' }];
  if (typeof b.value !== 'boolean') return [400, { ok: false, reason: 'bad_request' }];
  if (state === 'legal_unconfigured' || state === 'not_completed' || state === 'aborted') return [400, { ok: false, reason: state }];
  if (state === 'deleted') return [403, { ok: false, reason: 'deleted' }];
  return [200, { ok: true, value: b.value }];   // the committed value read back
}
function g7Server(promosOk = true) {
  const sent = [];
  const fetch = async (u, i) => { const ep = u.split('?')[0].split('/').pop(); sent.push([ep, i && i.body ? JSON.parse(i.body) : null, i && i.headers ? i.headers['x-firebase-id-token'] : null]);
    const [status, j] = ep === 'setPromos' ? setPromosHandler(i, promosOk) : [200, ep === 'getSignupConfig' ? { ok: true, terms_url: 'https://legal.test/t', privacy_url: 'https://legal.test/p', legal_ready: true, google_enabled: false } : { ok: true }];
    return { status, json: async () => j }; };
  return { fetch, sent };
}
test('G7 setPromos fake (Codex G7 r1 #4): as strict as the real handler — today\'s restaurant_id shape, a tokenless call, a non-boolean value and a GET are refused; the client\'s request passes', async () => {
  const P = (body, headers = { 'x-firebase-id-token': 't' }, method = 'POST') => setPromosHandler({ method, headers, body: JSON.stringify(body) }, true);
  assert.deepEqual(P({ restaurant_id: 'r1', value: true }), [400, { ok: false, reason: 'bad_request' }], '🔴 G7-fake: no context ⇒ bad_request, as the handler without restaurant_id');
  assert.deepEqual(P({ context: 'platform', restaurant_id: null, value: true }), [400, { ok: false, reason: 'bad_request' }], '🔴 G7-fake: both selectors ⇒ bad_request (deb1594b scopeOf: the restaurant_id KEY at all)');
  assert.deepEqual(setPromosHandler({ method: 'POST', headers: { 'x-firebase-id-token': 't' }, body: JSON.stringify({ context: 'platform', value: true }) }, 'deleted'), [403, { ok: false, reason: 'deleted' }], 'a tombstone ⇒ 403, as the handler');
  assert.deepEqual(P({ context: 'platform', value: true }, {}), [401, { ok: false, reason: 'unauthenticated' }], '🔴 G7-fake: no ID token ⇒ unauthenticated');
  assert.deepEqual(P({ context: 'platform', value: 'yes' }), [400, { ok: false, reason: 'bad_request' }], '🔴 G7-fake: a non-boolean value ⇒ bad_request');
  assert.deepEqual(P({ context: 'platform', value: true }, undefined, 'GET'), [405, { ok: false }]);
  const srv = g7Server(), api = require('./capp-signup-api.js').createSignupApi({ endpoints: { setPromos: 'https://ep.test/setPromos' }, fetch: srv.fetch });
  assert.deepEqual(await api.setPromos({ idToken: 'id:u_ana', value: false }), { ok: true, value: false }, '🔴 G7-fake: the client\'s real request is accepted (the value read back)');
  assert.deepEqual(await api.setPromos({ idToken: null, value: false }), { ok: false, reason: 'unauthenticated' }, 'a tokenless client call is refused, as in production');
});
async function g7Boot({ profile = G7_PROFILE({ promos: true }), srv = g7Server(), fbOpts = {}, media = null } = {}) {
  const fb = fakeFirebase({ persisted: 'u_ana', ...fbOpts });
  const store = g7Store(profile);
  const S = bootShell({ auth: 'unresolved', storage: store, runtime: G7_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: srv.fetch }, media });
  await flush(); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush();
  return { S, fb, srv, store };
}
const g7Rows = (S) => S.qa('.flow .rows .rowbtn').map((b) => txt(b));
test('G7 frame 1 / 4a: the member\'s Cuenta from the cached profile — the initial, name / phone / email on three lines, Pedidos · Promociones (on) · Ayuda, the session group, «v0.1.0»; never the host\'s tab event', async () => {
  const { S } = await g7Boot();
  assert.equal(S.events.filter((e) => e[0] === 'tab').length, 0, '🔴 G7-shell: the member\'s Cuenta is the shell\'s (no host event)');
  assert.equal(txt(S.q('.acct-hero .av')), 'A');
  assert.deepEqual([...S.qa('.acct-hero .t > *')].map((x) => x.textContent), ['Ana Pérez', '+504 9612-3344', 'ana.perez@gmail.com'], '🔴 G7-hero: name, phone, email on three lines');
  // PLAN-capp-desktop-website r2 (advisor ruling): «Pedidos» has no screen ⇒ its row is left out (capp-home ORDERS_SCREEN)
  assert.deepEqual(g7Rows(S), ['Promociones Ofertas por correo y WhatsApp', 'Ayuda', 'Cerrar sesión', 'Olvidar este teléfono Cierra tu sesión y deja de recordar tu número']);
  assert.equal(S.qa('.flow .rows').length, 2); assert.ok(S.q('.flow .rows.sess'));
  const sw = S.q('[data-act="promos"] .switch');
  assert.equal(sw.getAttribute('aria-checked'), 'true', '🔴 G7-promos: the cached value'); assert.equal(S.q('[data-act="promos"]').getAttribute('aria-disabled'), null);
  assert.equal(S.q('.flow .credit.ver').textContent, 'v0.1.0', '🔴 G7-version: SYSTEM_VERSION');
  assert.ok(!/recompens/i.test(txt(S.q('.flow'))), 'no rewards row (decision 1)');
});
test('G7 frame 1b: Promociones flips at once and calls setPromos (context platform, the member token); success keeps it and updates the cache; failure reverts + «No se guardó el cambio. Intentá de nuevo.»', async () => {
  const ok = await g7Boot();
  ok.S.click('[data-act="promos"]');
  assert.equal(ok.S.q('[data-act="promos"] .switch').getAttribute('aria-checked'), 'false', '🔴 G7-optimistic: the new value at once');
  await flush();
  const call = ok.srv.sent.find((x) => x[0] === 'setPromos');
  assert.deepEqual([call[1], call[2]], [{ context: 'platform', value: false }, 'id:u_ana'], '🔴 G7-setPromos: contract §6');
  assert.equal(ok.S.q('[data-act="promos"] .switch').getAttribute('aria-checked'), 'false');
  assert.equal(JSON.parse(ok.store.getItem('capp:member_profile')).promos, false, 'the cache follows a confirmed change');
  const bad = await g7Boot({ srv: g7Server(false) });
  bad.S.click('[data-act="promos"]'); await flush();
  assert.equal(bad.S.q('[data-act="promos"] .switch').getAttribute('aria-checked'), 'true', '🔴 G7-revert: back to its value');
  assert.equal(bad.S.q('#toast').textContent, 'No se guardó el cambio. Intentá de nuevo.', '🔴 G7-toast');
  assert.equal(JSON.parse(bad.store.getItem('capp:member_profile')).promos, true);
});
test('G7 frame 4b: no served promotions value ⇒ the switch INERT (aria-disabled, the .45); a uid without a cached profile ⇒ the placeholder bars, the rows usable', async () => {
  const noVal = await g7Boot({ profile: G7_PROFILE() });
  assert.equal(noVal.S.q('[data-act="promos"]').getAttribute('aria-disabled'), 'true', '🔴 G7-inert: no value served ⇒ inert');
  noVal.S.click('[data-act="promos"]'); await flush();
  assert.equal(noVal.srv.sent.filter((x) => x[0] === 'setPromos').length, 0, 'an inert switch sends nothing');
  const bare = await g7Boot({ profile: null });
  assert.equal(bare.S.qa('.acct-hero .t .bar').length, 3, '🔴 G7-placeholder: three static bars'); assert.ok(bare.S.q('.acct-hero .av.ph'));
  assert.ok(bare.S.q('[data-act="signout"]') && bare.S.q('[data-act="help"]'), 'the rows usable (Ayuda; «Pedidos» is left out — no orders screen)');
});
// Codex G7 r1 #3: the promotions consent rides the REAL sign-in — the server's profile.promos (an existing account), or the value a
// successful completeProfile stored (a new one) — into «Listo», the cache and the Cuenta switch; none stored (a legacy account,
// completion 'off') ⇒ the switch stays INERT and a tap sends nothing (contract §5: promos OMITTED when no consent is stored)
async function g7SignIn(verify, { complete } = {}) {
  const fb = fakeFirebase(); const srv = signupServer(verify); const storage = memStorage();
  const S = bootShell({ auth: 'unresolved', storage, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: srv.fetch } }); await flush(); await flush();
  await signInViaSheet(S);
  const h = suHost(S);
  if (complete) {
    const em = h.querySelector('#su-email'); em.value = 'ana@gmail.com'; em.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
    S.click(h.querySelector('[data-su="email-go"]')); await flush();
    const nm = h.querySelector('#su-name'); nm.value = 'Ana Pérez'; nm.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
    for (const id of ['su-terms', ...(complete.promos ? ['su-promos'] : [])]) { const c = h.querySelector('#' + id); c.checked = true; c.dispatchEvent(new S.w.Event('change', { bubbles: true })); await flush(); }
    S.click(h.querySelector('[data-su="save"]')); await flush(); await flush();
  }
  S.click(h.querySelector('[data-su="finish"]')); await flush(); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush();
  const row = S.q('[data-act="promos"]'), sw = row && row.querySelector('.switch');
  return { S, srv, storage, row, live: !!row && row.getAttribute('aria-disabled') === null, on: sw ? sw.getAttribute('aria-checked') : null };
}
test('G7 Codex r1 #3: an EXISTING account\'s stored consent (verifyOtp profile.promos) reaches the Cuenta — the switch LIVE at the server\'s value, cached', async () => {
  const r = await g7SignIn({ ...ANA, profile: { ...ANA.profile, promos: false } });
  assert.deepEqual([r.live, r.on], [true, 'false'], '🔴 G7-consent: the server\'s value, live');
  assert.equal(JSON.parse(r.storage.getItem('capp:member_profile')).promos, false, '🔴 G7-consent: cached with the profile');
});
test('G7 Codex r1 #3: a NEW account\'s promotions choice, saved by completeProfile, reaches the Cuenta — the switch LIVE at that value', async () => {
  const r = await g7SignIn({ ...ANA, is_new: true, completion: 'needed', profile: null }, { complete: { promos: true } });
  const cp = r.srv.sent.find((x) => x[0] === 'completeProfile');
  assert.equal(cp && cp[1].promos, true, 'premise: the choice was sent');
  assert.deepEqual([r.live, r.on], [true, 'true'], '🔴 G7-consent: the saved choice, live');
  assert.equal(JSON.parse(r.storage.getItem('capp:member_profile')).promos, true);
});
test('G7 Codex r1 #3: a LEGACY account (completion \'off\', no consent stored ⇒ no profile.promos) — the switch INERT and a tap sends nothing (setPromos would answer not_completed)', async () => {
  const r = await g7SignIn({ ...ANA, completion: 'off', profile: { name: 'Ana Pérez', email: 'ana@gmail.com' } });
  assert.equal(r.live, false, '🔴 G7-legacy: no stored consent ⇒ the switch is never live');
  assert.equal(r.on, 'false', '🔴 G7-legacy: settled with no stored consent ⇒ OFF + dimmed (ruling (ii), OWNER-PENDING) — never «ON» without consent');
  r.S.click('[data-act="promos"]'); await flush();
  assert.equal(r.srv.sent.filter((x) => x[0] === 'setPromos').length, 0, '🔴 G7-legacy: a tap sends nothing');
});
test('G7 Codex r1 #3 / contract §6: the switch and the cache keep the value setPromos READ BACK from the committed record, not the one sent', async () => {
  const srv = g7Server(); const f0 = srv.fetch;
  srv.fetch = async (u, i) => (u.split('?')[0].endsWith('/setPromos') ? (srv.sent.push(['setPromos', JSON.parse(i.body), i.headers['x-firebase-id-token']]), { status: 200, json: async () => ({ ok: true, value: true }) }) : f0(u, i));
  const r = await g7Boot({ srv });
  r.S.click('[data-act="promos"]'); await flush(); await flush();
  assert.equal(srv.sent.find((x) => x[0] === 'setPromos')[1].value, false, 'premise: the tap sent «off»');
  assert.equal(r.S.q('[data-act="promos"] .switch').getAttribute('aria-checked'), 'true', '🔴 G7-readback: the committed value wins');
  assert.equal(JSON.parse(r.store.getItem('capp:member_profile')).promos, true, '🔴 G7-readback: cached as committed');
});
// Codex G7 r1 #2 (P1 privacy) + #5, advisor ruling 2026-10-31: a cached profile is SHOWN only once the SDK's first auth state names
// its uid (local persistence restore, no network wait); until then neutral placeholders at the reserved 78 px (ruling A — no reflow);
// a mismatch or a guest PURGES that cache. Once the SDK says member U (U's mark), U's cache is shown at once, independent of the ID
// token; the switch is live only once the member is applied. Ruling (ii), OWNER-PENDING: a SETTLED member with no stored consent ⇒
// the switch OFF + dimmed (never «ON» without consent); while loading it keeps frame 4b's ON-dimmed placeholder.
const anaText = (S) => /Ana|ana\.perez|9612/.test(S.q('#app') ? S.q('#app').textContent : '');
test('G7 decision 7 / Codex r1 #2: while the session RESOLVES, a profile on this device draws the member GEOMETRY with neutral placeholders — never its name, phone or email; none ⇒ the guest\'s', async () => {
  const fb = fakeFirebase({ persisted: 'u_ana' });
  const S = bootShell({ auth: 'unresolved', storage: g7Store(G7_PROFILE({ promos: true })), runtime: G7_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: g7Server().fetch } });
  S.click('.tabbar [data-tab="account"]');
  assert.equal(S.qa('.acct-hero .t .bar').length, 3, '🔴 G7-privacy: the member geometry, as placeholders, before the SDK answers');
  assert.equal(anaText(S), false, '🔴 G7-privacy: no cached personal data before the SDK names the uid');
  assert.deepEqual([S.q('[data-act="promos"]').getAttribute('aria-disabled'), S.q('[data-act="promos"] .switch').getAttribute('aria-checked')], ['true', 'true'], 'loading ⇒ frame 4b\'s ON-dimmed placeholder');
  await flush(); await flush();
  assert.equal(S.q('.acct-hero .t b') && S.q('.acct-hero .t b').textContent, 'Ana Pérez', 'the SDK named u_ana ⇒ her cached profile');
  const G = bootShell({ auth: 'unresolved', storage: memStorage(), runtime: G7_RUNTIME, mountExtra: { loadSdk: fakeFirebase({}).loadSdk, signupFetch: g7Server().fetch } });
  G.click('.tabbar [data-tab="account"]');
  assert.equal(G.q('.acct-hero'), null); assert.ok(G.q('.guestcard'), 'no profile ⇒ the guest\'s geometry');
});
test('G7 Codex r1 #2: ANOTHER account restores on this device — the previous account\'s cached profile is never shown and is purged', async () => {
  const st = memStorage({ 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_bob' }) }); DA.rememberProfile(st, G7_PROFILE({ promos: true }));
  const S = bootShell({ auth: 'unresolved', storage: st, runtime: G7_RUNTIME, mountExtra: { loadSdk: fakeFirebase({ persisted: 'u_bob' }).loadSdk, signupFetch: g7Server().fetch } });
  S.click('.tabbar [data-tab="account"]');
  assert.equal(anaText(S), false, '🔴 G7-privacy: not before the SDK answers');
  await flush(); await flush();
  assert.equal(anaText(S), false, '🔴 G7-privacy: not after another uid restored');
  assert.equal(st.getItem('capp:member_profile'), null, '🔴 G7-privacy: the mismatched cache is purged');
});
test('G7 Codex r1 #2: a SIGNED-OUT device — the cached profile is never shown; the guest\'s Cuenta once the SDK answers; the cache purged', async () => {
  const st = g7Store(G7_PROFILE({ promos: true }));
  const S = bootShell({ auth: 'unresolved', storage: st, runtime: G7_RUNTIME, mountExtra: { loadSdk: fakeFirebase({ persisted: null }).loadSdk, signupFetch: g7Server().fetch } });
  S.click('.tabbar [data-tab="account"]');
  assert.equal(anaText(S), false, '🔴 G7-privacy: not before the SDK answers');
  await flush(); await flush();
  assert.ok(S.q('.guestcard'), 'the guest\'s Cuenta'); assert.equal(anaText(S), false);
  assert.equal(st.getItem('capp:member_profile'), null, '🔴 G7-privacy: purged on a confirmed guest');
});
test('G7 Codex r1 #5: auth says member, the ID token still pending — the Cuenta draws the member\'s cached profile at once (never the guest card), the switch live once the member is applied', async () => {
  const hold = { on: true, q: [] };
  const fb = fakeFirebase({ persisted: 'u_ana', hold });
  const S = bootShell({ auth: 'unresolved', storage: g7Store(G7_PROFILE({ promos: true })), runtime: G7_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: g7Server().fetch } });
  await flush(); await flush();
  assert.ok(hold.q.length > 0, 'premise: the token read is pending');
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.equal(S.q('.guestcard'), null, '🔴 G7-pending: never the guest card for a member whose token is pending');
  assert.equal(S.q('.acct-hero .t b') && S.q('.acct-hero .t b').textContent, 'Ana Pérez', '🔴 G7-pending: the uid-validated cache at once');
  assert.equal(S.q('[data-act="promos"]').getAttribute('aria-disabled'), 'true', 'the switch waits for the applied member');
  const hero0 = S.q('.acct-hero');
  hold.on = false; hold.q.splice(0).forEach((f) => f()); await flush(); await flush();
  assert.equal(S.q('.guestcard'), null); assert.equal(S.q('.acct-hero .t b').textContent, 'Ana Pérez');
  assert.equal(S.q('[data-act="promos"]').getAttribute('aria-disabled'), null, '🔴 G7-pending: live once applied');
  assert.ok(hero0, 'the member geometry throughout');
});
test('G7 frame 3: «Cerrar sesión» — no confirmation; the guest\'s Cuenta at once; the profile cache cleared on the confirmed sign-out; the device marker KEPT', async () => {
  const { S, fb, store } = await g7Boot();
  S.click('[data-act="signout"]');
  assert.ok(S.q('.guestcard'), '🔴 G7-signout: the guest\'s Cuenta at once'); assert.equal(S.q('#layer .errsheet'), null, 'no confirmation');
  await flush();
  assert.equal(fb.calls.out, 1); assert.equal(store.getItem('capp:member_profile'), null, 'no personal data stays on show');
  assert.ok(store.getItem('capp:device_account'), '🔴 G7-marker: an ordinary sign-out keeps the device marker');
});
test('G7 frame 2: «Olvidar este teléfono» asks first («¿Olvidar este teléfono?» + the body, [Olvidar este teléfono][Cancelar]); Cancelar changes nothing; confirming forgets the marker and signs out', async () => {
  const { S, fb, store } = await g7Boot();
  S.click('[data-act="forget"]');
  assert.equal(S.q('#layer .errsheet h2') && S.q('#layer .errsheet h2').textContent, '¿Olvidar este teléfono?', '🔴 G7-forget-sheet');
  assert.equal(S.q('#layer .errsheet p').textContent, 'Cerramos tu sesión y este teléfono deja de recordar tu número: la próxima vez lo escribís de nuevo. Tu cuenta y tus pedidos no se borran.');
  assert.deepEqual(S.qa('#layer .errsheet button').map((b) => b.textContent), ['Olvidar este teléfono', 'Cancelar']); assert.ok(S.q('#layer .errsheet .icon.calm'));
  S.click('#layer [data-act="lclose"]'); await flush();
  assert.equal(S.q('#layer .errsheet'), null); assert.equal(fb.calls.out, 0); assert.ok(store.getItem('capp:device_account'), 'Cancelar keeps everything');
  S.click('[data-act="forget"]'); S.click('#layer [data-act="forget-confirm"]'); await flush();
  assert.equal(store.getItem('capp:device_account'), null, '🔴 G7-forget: the device marker removed'); assert.equal(fb.calls.out, 1); assert.ok(S.q('.guestcard'));
});
test('G7 a REJECTED sign-out restores the member (nothing pretends to be signed out)', async () => {
  const { S, fb } = await g7Boot({ fbOpts: { failSignOut: 1 } });
  S.click('[data-act="signout"]'); await flush(); await flush();
  assert.equal(fb.calls.out, 1); assert.equal(S.q('.acct-hero .t b') && S.q('.acct-hero .t b').textContent, 'Ana Pérez', '🔴 G7-reject: still the member');
  // the Cuenta alone cannot tell (it reads the cache of the uid auth names): the SESSION is the member's again — checkout included
  assert.equal(S.ui.state.member && S.ui.state.member.uid, 'u_ana', '🔴 G7-reject: the member is restored, not only drawn');
});
test('G7 flag absent: without runtime.signup a member\'s Cuenta stays the HOST\'s tab event, as before', async () => {
  const S = bootShell({ auth: 'member', runtime: { ...RUNTIME, guestCardOnly: true } }); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.deepEqual(S.events.filter((e) => e[0] === 'tab').pop(), ['tab', { tab: 'account' }]); assert.equal(S.q('.acct-hero'), null);
});

test('Part B (b) in the shell: runtime.intlPhone reaches the sign-in sheet (the .cc button); absent ⇒ the «+504» span', async () => {
  const on = bootShell({ auth: 'unresolved', runtime: { ...SU_RUNTIME, intlPhone: true }, mountExtra: { loadSdk: fakeFirebase({}).loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush(); on.click('.tabbar [data-tab="account"]'); await flush(); on.click('.guestcard .primary'); await flush();
  assert.ok(suHost(on).querySelector('.phonerow button.cc'), '🔴 SP-shell: the flag reaches the sheet');
  const off = bootShell({ auth: 'unresolved', runtime: SU_RUNTIME, mountExtra: { loadSdk: fakeFirebase({}).loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush(); off.click('.tabbar [data-tab="account"]'); await flush(); off.click('.guestcard .primary'); await flush();
  assert.equal(suHost(off).querySelector('.phonerow button.cc'), null); assert.ok(suHost(off).querySelector('.phonerow span.cc'));
});


// ── PLAN-capp-desktop-website r2 D-2: the APPROVED v6 desktop switched on — ONE breakpoint (≥ 1024 px, capp-view.js) read
// SYNCHRONOUSLY at mount, the v6 view-conditional DOM (the store's deskcart aside, the checkout's col-b = «Tu pedido»), the cart
// aside kept in sync, state preserved across a resize, the phone below the breakpoint unchanged, and «Pedidos» (no orders screen
// exists) offered nowhere. The viewport is a controllable matchMedia installed before the REAL shell mounts.
function fakeMedia(desk) {
  const subs = new Set(); let cur = desk;
  const mql = (q) => ({ media: q, get matches() { return /min-width:\s*1024px/.test(q) ? cur : false; }, addEventListener: (t, f) => { if (t === 'change') subs.add(f); }, removeEventListener: (t, f) => subs.delete(f) });
  return { matchMedia: mql, set(v) { if (v === cur) return; cur = v; for (const f of [...subs]) f({ matches: v }); }, subs };
}
const DESK_SETTLE = 300;   // > the view's resize debounce
async function deskStore(desk, items = 1) {
  const media = fakeMedia(desk);
  const S = bootShell({ media }); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const ui = S.ui.store().ui;
  const plain = ui.menu.dishes.filter((d) => !d.launcher && !d.variantOf);
  for (let i = 0; i < items; i++) S.click(`.qty-add-btn[data-id="${plain[i].key}"]`);
  await flush();
  return { S, ui, media, plain };
}
const pedidoCount = (S) => S.qa('section[aria-label="Resumen del pedido"]').length;

test('D-2 view: ONE breakpoint (≥1024) read synchronously; a crossing notifies once after the debounce; no matchMedia ⇒ phone', async () => {
  const CappView = require('./capp-view.js');
  assert.equal(CappView.BREAKPOINT, 1024); assert.equal(CappView.QUERY, '(min-width: 1024px)');
  const m = fakeMedia(true), v = CappView.createView({ matchMedia: m.matchMedia });
  assert.equal(v.desk(), true, 'synchronous at creation');
  const seen = []; v.subscribe((d) => seen.push(d));
  m.set(false); m.set(true); m.set(false); await flush(DESK_SETTLE);
  assert.deepEqual(seen, [false], 'a burst of crossings settles to ONE notification with the final value');
  assert.equal(v.desk(), false);
  assert.equal(CappView.createView({}).desk(), false, 'no matchMedia ⇒ the phone layout');
  v.destroy(); assert.equal(m.subs.size, 0, 'destroy unsubscribes');
});

test('D-2 mount: the desktop class is on #app BEFORE the first paint returns (no pop-in); the phone never gets it', () => {
  const D = bootShell({ media: fakeMedia(true) });
  assert.ok(D.q('#app').classList.contains('desk'), '🔴 desk not set synchronously at mount');
  assert.ok(D.q('.desknav'), 'the v6 desknav is in the first paint');
  const P = bootShell({ media: fakeMedia(false) });
  assert.equal(P.q('#app').classList.contains('desk'), false);
});

test('D-2 store (v6 :1628): desktop ⇒ the deskcart aside inside storewrap, no close button; an item edit refreshes it (v6 syncPill :1726); phone ⇒ no aside', async () => {
  const { S, ui, plain } = await deskStore(true, 1);
  const aside = S.q('.storewrap > aside.deskcart[aria-label="Tu pedido"]');
  assert.ok(aside, '🔴 no deskcart aside on the desktop store');
  assert.equal(aside.querySelector('[data-act="cartclose"]'), null, 'the aside has no close button (v6 cartInner(rid, true))');
  assert.equal(aside.querySelectorAll('.cline').length, 1);
  S.click(`.qty-add-btn[data-id="${plain[1].key}"]`);
  assert.equal(S.q('.deskcart').querySelectorAll('.cline').length, 2, '🔴 an item edit must refresh the aside (syncPill)');
  assert.equal(ui.cart.count(), 2);
  assert.ok(S.q('.deskcart [data-act="checkout"]'), 'the aside carries «Ir al checkout»');
  // the path where ONLY syncPill updates (no full render): the dish sheet stays open while its quantity changes
  S.click(`.txtbtn[data-id="${plain[0].key}"]`); assert.ok(ui.state.open, 'premise: the dish sheet is open');
  S.click('#detail-modal .detail-step-btn[data-delta="1"]');
  assert.equal(ui.cart.count(), 3, 'premise: the sheet\'s + added one'); assert.ok(ui.state.open, 'premise: the sheet stayed open (no re-render)');
  assert.equal(S.q('.deskcart .cline .cstep span').textContent, '2', '🔴 the dish sheet\'s edit must refresh the aside (syncPill)');
  const P = await deskStore(false, 1);
  assert.equal(P.S.q('.deskcart'), null, 'the phone store has no aside');
});

test('D-2 checkout (v6 :1886-1887): desktop ⇒ col-b = «Tu pedido» (MOVED, once), col-a without it; phone ⇒ no col-b, «Tu pedido» once in col-a', async () => {
  const { S, ui } = await deskStore(true, 1);
  S.click('.deskcart [data-act="checkout"]'); await flush();
  assert.equal(ui.state.screen, 'checkout');
  assert.ok(S.q('.flow > .col-b > section[aria-label="Resumen del pedido"]'), '🔴 desktop: «Tu pedido» in col-b');
  assert.equal(S.q('.col-a section[aria-label="Resumen del pedido"]'), null, 'not also in col-a');
  assert.equal(pedidoCount(S), 1, '🔴 «Tu pedido» exactly once (moved, never duplicated)');
  const P = await deskStore(false, 1);
  P.S.click('#cart-bar'); P.S.click('[data-act="checkout"]'); await flush();
  assert.equal(P.S.q('.col-b'), null, 'phone: no col-b');
  assert.ok(P.S.q('.col-a section[aria-label="Resumen del pedido"]')); assert.equal(pedidoCount(P.S), 1);
});

test('D-2 resize: crossing the breakpoint re-renders the view and PRESERVES state — the cart, the screen, a typed field', async () => {
  const { S, ui, media } = await deskStore(true, 2);
  media.set(false); await flush(DESK_SETTLE);
  assert.equal(S.q('#app').classList.contains('desk'), false); assert.equal(S.q('.deskcart'), null, 'phone: the aside is gone');
  assert.equal(ui.cart.count(), 2, '🔴 the cart survives the crossing'); assert.ok(S.q('#cart-bar'));
  media.set(true); await flush(DESK_SETTLE);
  assert.equal(S.q('.deskcart').querySelectorAll('.cline').length, 2, 'desktop again: the aside with both lines');
  S.click('.deskcart [data-act="checkout"]'); await flush();
  const nm = S.q('#flow input[type="text"], #flow input:not([type])');
  assert.ok(nm, 'premise: a text field on the checkout');
  nm.value = 'Ana Prueba'; nm.dispatchEvent(new S.w.Event('input', { bubbles: true }));
  const id = nm.id;
  media.set(false); await flush(DESK_SETTLE);
  assert.equal(ui.state.screen, 'checkout', 'still on the checkout'); assert.equal(S.q('.col-b'), null);
  assert.equal(id ? S.q('#' + id).value : S.q('#flow input').value, 'Ana Prueba', '🔴 a typed field survives the crossing');
  assert.equal(pedidoCount(S), 1);
});

test('D-2 no-regression: below the breakpoint the store and the checkout are BYTE-IDENTICAL to a shell with no viewport signal at all', async () => {
  const run = async (media) => {
    const S = bootShell(media ? { media } : {}); await flush();
    S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
    const ui = S.ui.store().ui; S.click(`.qty-add-btn[data-id="${ui.menu.dishes.find((d) => !d.launcher && !d.variantOf).key}"]`); await flush();
    const store = S.q('#app').innerHTML; S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush();
    return { store, checkout: S.q('#app').innerHTML, cls: S.q('#app').className };
  };
  const a = await run(fakeMedia(false)), b = await run(null);
  assert.equal(a.store, b.store, '🔴 the phone store changed'); assert.equal(a.checkout, b.checkout, '🔴 the phone checkout changed'); assert.equal(a.cls, b.cls);
});

test('D-2 «Pedidos»: NO reachable orders control anywhere — tabbar, desknav, the member Cuenta, the guest card — on desktop AND phone', async () => {
  for (const desk of [true, false]) {
    const H = bootShell({ media: fakeMedia(desk), runtime: { ...RUNTIME, guestCardOnly: true } }); await flush();
    assert.equal(H.qa('[data-tab="orders"]').length, 0, `🔴 home (${desk ? 'desktop' : 'phone'}): an orders control`);
    H.click('.tabbar [data-tab="account"]'); await flush();
    assert.ok(H.q('.guestcard'), 'premise: the guest card');
    assert.equal(H.qa('[data-tab="orders"]').length, 0, `🔴 guest Cuenta (${desk ? 'desktop' : 'phone'}): an orders control`);
    const { S } = await g7Boot({ media: fakeMedia(desk) });
    assert.ok(S.q('.acct-hero'), 'premise: the member Cuenta');
    assert.equal(S.qa('[data-tab="orders"]').length, 0, `🔴 member Cuenta (${desk ? 'desktop' : 'phone'}): an orders control`);
    assert.ok(!S.qa('.rows .rowbtn').some((b) => /Pedidos/.test(b.textContent)), 'no «Pedidos» row');
  }
});

test('D-2 the signup surface follows the breakpoint (its .app host carries desk too, both ways)', async () => {
  const media = fakeMedia(true);
  const { S } = await g7Boot({ media });
  const host = S.q('#su-host'); assert.ok(host, 'premise: the signup host exists (runtime.signup)');
  assert.ok(host.classList.contains('desk'), '🔴 the signup host misses desk');
  media.set(false); await flush(DESK_SETTLE);
  assert.equal(host.classList.contains('desk'), false);
});

// ── Codex D-2 r1 (3 P2s) ──
test('D-2 r1 #1: desktop → phone with an ASIDE control focused ⇒ focus moves to the visible phone equivalent (the cart bar) and the menu scroll is kept; phone → desktop with the cart bar focused ⇒ focus moves into the aside', async () => {
  const { S, media } = await deskStore(true, 2);
  const plus = S.q('.deskcart .cstep button[data-rev="1"]'); assert.ok(plus, 'premise: an aside stepper'); plus.focus();
  assert.equal(S.w.document.activeElement, plus, 'premise: focused');
  S.q('#scroller').scrollTop = 300;
  media.set(false); await flush(DESK_SETTLE);
  assert.equal(S.q('.deskcart'), null, 'premise: the phone view');
  assert.equal(S.w.document.activeElement, S.q('#cart-bar'), '🔴 r1 #1: focus dropped to BODY instead of the visible cart bar');
  assert.equal(S.q('#scroller').scrollTop, 300, '🔴 r1 #1: the menu scroll was reset');
  media.set(true); await flush(DESK_SETTLE);
  assert.ok(S.q('.deskcart').contains(S.w.document.activeElement), '🔴 r1 #1: from the (now hidden) cart bar, focus moves into the aside');
  assert.equal(S.q('#scroller').scrollTop, 300);
});

test('D-2 r1 #2: the aside «Editar» returns focus to THAT aside control when the dish sheet closes (never the hidden cart bar)', async () => {
  const { S, ui } = await deskStore(true, 0);
  const dressed = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && ui.menu.extrasFor(d.key).length);
  assert.ok(dressed, 'premise: a dish with extras (its cart line is editable)');
  ui.cart.add(dressed.key, [], 1); ui.render();
  const ed = S.q(`.deskcart [data-act="edit"][data-key="${dressed.key}"]`); assert.ok(ed, 'premise: the aside line «Editar»');
  ed.focus(); S.click(ed); await flush();
  assert.ok(ui.state.open, 'premise: the dish sheet opened for editing');
  S.click('#detail-overlay'); await flush();
  assert.equal(ui.state.open, null, 'premise: closed');
  const back = S.w.document.activeElement;
  assert.ok(back && S.q('.deskcart') && S.q('.deskcart').contains(back) && back.dataset.act === 'edit' && back.dataset.key === dressed.key, `🔴 r1 #2: focus returned to ${back && (back.id || back.className || back.tagName)} instead of the aside «Editar»`);
});

test('D-2 r1 #3: browse-only ⇒ the ASIDE\'s ordering controls are disabled like the cart sheet\'s (ONE selector source), also after a syncPill refresh', async () => {
  const media = fakeMedia(true);
  const S = bootShell({ envelope: 'hold', storage: memStorage(storedMenu('x_pizza')), media }); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const ui = S.ui.store().ui; assert.equal(ui.orderable(), false, 'premise: browse-only (a stored, unverified menu)');
  ui.cart.add(ui.menu.dishes.find((d) => !d.launcher && !d.variantOf).key, [], 1); ui.render();   // a cart carried from an earlier visit
  const ctl = S.qa('.deskcart .cstep button, .deskcart [data-act="checkout"]');
  assert.ok(ctl.length >= 3, 'premise: the aside shows a line and its checkout');
  assert.ok(ctl.every((b) => b.disabled && b.getAttribute('aria-disabled') === 'true'), `🔴 r1 #3: enabled aside controls in browse-only: ${ctl.filter((b) => !b.disabled).map((b) => b.dataset.act + (b.dataset.rev || '')).join(', ')}`);
  S.click(`.txtbtn[data-id="${ui.cart.lines()[0].key}"]`); await flush();
  const after = S.qa('.deskcart .cstep button, .deskcart [data-act="checkout"]');
  assert.ok(after.every((b) => b.disabled), '🔴 r1 #3: a re-rendered aside re-enabled its controls');
});


// ── PLAN-capp-desktop-D4a-routing r2 (APPROVED, Phase 1 = URL REFLECTION): the URL follows the screen by replaceState (the sentinel
// state and the search kept), cold-link / reload hydration through the shared non-placement entry, a payment return always owns
// the boot, unverified ≠ absent, one hydration generation. The REAL shell, a real jsdom URL; routing on = the web boot's flag.
const routeShell = (path, x = {}) => bootShell({ ...x, url: `https://app.test${path}${x.search || ''}`, mountExtra: { ...(x.mountExtra || {}), routing: true } });
const where = (S) => S.w.location.pathname;
const anyDish = (rid = 'x_pizza') => CappMenu.adaptMenu(PROV[rid].envelope).dishes.find((d) => !d.launcher && !d.variantOf);
const cartOf = (rid, key, qty = 1) => ({ [`capp:${rid}:cart`]: JSON.stringify({ v: 2, lines: [{ key, qty, ex: [{}], added: 1 }], rid, mode: 'delivery', cart_gen: 'g_c' }) });

test('D-4a reflection: every screen change REPLACES the pathname — the sentinel state, history.length and the search untouched', async () => {
  const S = routeShell('/', { search: '?utm=a', runtime: { ...RUNTIME, guestCardOnly: true } }); await flush();   // Cuenta is the shell's
  const len0 = S.w.history.length, st0 = JSON.stringify(S.w.history.state);
  assert.equal(where(S), '/');
  S.click('.tabbar [data-tab="search"]'); await flush(); assert.equal(where(S), '/buscar', '🔴 the URL does not follow Buscar');
  S.click('.tabbar [data-tab="account"]'); await flush(); assert.equal(where(S), '/cuenta');
  S.click('.tabbar [data-tab="home"]'); await flush(); assert.equal(where(S), '/');
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); assert.equal(where(S), '/r/x_pizza');
  const ui = S.ui.store().ui, d = ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  S.click(`.txtbtn[data-id="${d.key}"]`); await flush(); assert.equal(where(S), `/r/x_pizza/plato/${encodeURIComponent(d.key)}`);
  S.click('#detail-overlay'); await flush(); assert.equal(where(S), '/r/x_pizza');
  S.click(`.qty-add-btn[data-id="${d.key}"]`); S.click('#cart-bar'); await flush(); assert.equal(where(S), '/r/x_pizza/pedido');
  S.click('[data-act="checkout"]'); await flush(); assert.equal(where(S), '/r/x_pizza/pago');
  assert.equal(S.w.location.search, '?utm=a', '🔴 the search must survive every reflection');
  assert.equal(S.w.history.length, len0, '🔴 reflection must never add history entries');
  assert.equal(JSON.stringify(S.w.history.state), st0, 'the sentinel state is kept');
});

test('D-4a sentinel unchanged: a device Back runs ONE in-app back; a BLOCKED back («Enviando…») changes nothing and the URL keeps the locked path', async () => {
  const S = routeShell('/'); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const ui = S.ui.store().ui, d = ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  S.click(`.qty-add-btn[data-id="${d.key}"]`); S.click('#cart-bar'); S.click('[data-act="checkout"]'); await flush();
  ui.state.screen = 'sending'; ui.render(); await flush();
  S.w.history.back(); await flush(); await flush();   // a REAL device Back: the browser leaves the sentinel, popstate fires
  assert.equal(ui.state.screen, 'sending', 'premise: blocked — nothing changed');
  assert.equal(where(S), '/r/x_pizza/pago', '🔴 a blocked back must leave the URL on the locked screen');
  assert.equal(JSON.stringify(S.w.history.state), '{"capp_shell":1}', 'the sentinel re-armed');
  ui.state.screen = 'checkout'; ui.render(); await flush();
  S.w.history.back(); await flush(); await flush();   // unblocked: ONE in-app back (checkout ⇒ the cart, as today)
  assert.notEqual(ui.state.screen, 'checkout', 'one in-app back ran'); assert.equal(where(S), '/r/x_pizza/pedido');
});

test('D-4a precedence: a payment RETURN owns the boot — the owner store resolves it, the deep-linked store is never entered; persisted ⇒ the boot strips the query, memory ⇒ the query survives every reflection', async () => {
  const t0 = T0, ret = `?pay=cancel&order=${ORDER}&t=pt_9`;
  const recs = () => ({ ...frozenCart(), 'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_1', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, dispatched: 1, cart_gen: 'g_1', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }) });
  const apiFetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) });
  // the deep-linked store is READY first (its menu answers) while the owner's menu is held: only the precedence rule keeps it out
  const ownerLate = (rid) => (rid === 'x_pizza' ? 'hold' : 'ok');
  const P = routeShell('/r/la_musa/pago', { storage: memStorage(recs()), search: ret, apiFetch, envelope: ownerLate }); await flush(); await flush();
  assert.ok(!P.ui.store() || P.ui.store().rid !== 'la_musa', '🔴 the deep-linked store was entered while a return owns the boot');
  P.release('x_pizza'); await flush(); await flush();
  assert.equal(P.ui.store() && P.ui.store().rid, 'x_pizza', '🔴 the return owner handles the boot (never the deep-linked store)');
  assert.equal(P.w.location.search, '', 'persisted ⇒ the boot (not the router) stripped the query');
  const st = memStorage(recs()), real = st.setItem; st.setItem = (k, v) => { if (k === 'capp:return') throw new Error('quota'); real(k, v); };
  const M = routeShell('/r/la_musa/pago', { storage: st, search: ret, apiFetch }); await flush(); await flush();
  assert.equal(M.ui.store() && M.ui.store().rid, 'x_pizza', 'memory mode: still the owner');
  assert.equal(M.w.location.search, ret, '🔴 memory mode: the return query is the ONLY evidence — it must survive the reflections');
});

test('D-4a cold entry: /r/{rid} ⇒ that store; /pedido ⇒ the cart; /pago ⇒ the checkout through the tap path; the URL kept', async () => {
  const d = anyDish();
  const A = routeShell('/r/x_pizza'); await flush(); await flush();
  assert.equal(A.ui.store() && A.ui.store().rid, 'x_pizza', '🔴 a cold store link must enter that store'); assert.equal(where(A), '/r/x_pizza');
  const B = routeShell('/r/x_pizza/pedido', { storage: memStorage(cartOf('x_pizza', d.key)) }); await flush(); await flush();
  assert.equal(B.ui.store().ui.state.layerKind, 'cart', '🔴 /pedido opens the cart'); assert.equal(where(B), '/r/x_pizza/pedido');
  const C = routeShell('/r/x_pizza/pago', { storage: memStorage(cartOf('x_pizza', d.key)) }); await flush(); await flush();
  assert.equal(C.ui.store().ui.state.screen, 'checkout', '🔴 /pago opens the checkout'); assert.equal(where(C), '/r/x_pizza/pago');
  const E = routeShell('/r/x_pizza/pago'); await flush(); await flush();
  assert.equal(E.ui.store().ui.state.screen, 'store', 'an empty cart ⇒ the store'); assert.equal(where(E), '/r/x_pizza');
});

test('D-4a cold /pago under a LOCK: the lock is checked FIRST and resolved by status only — frozen ⇒ «Necesitamos revisar», a live card send ⇒ its status poll — ZERO sends', async () => {
  const sends = [];
  const F = routeShell('/r/x_pizza/pago', { storage: memStorage(frozenCart()), fetchLog: sends }); await flush(); await flush();
  assert.equal(F.ui.store().ui.state.screen, 'store', 'no checkout over a lock');
  assert.match(txt(F.q('#layer')), /Necesitamos revisar tu pedido/, '🔴 a frozen cart ⇒ the recovery sheet');
  const t0 = T0, polls = [];
  const live = { ...frozenCart(), 'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_1', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, pay_pending: true, dispatched: 1, cart_gen: 'g_1', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }) };
  const apiFetch = async (u) => { polls.push(u.split('?')[0]); return { status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) }; };
  const L = routeShell('/r/x_pizza/pago', { storage: memStorage(live), apiFetch }); await flush(); await flush();
  assert.ok(polls.length >= 1 && polls.every((u) => u === '/x/s'), `🔴 only status reads (${polls.join(',')})`);
  assert.equal(L.ui.store().ui.state.screen, 'store'); assert.ok(L.q('#layer .errsheet'), 'a held sheet, never the checkout');
  assert.deepEqual(sends.filter((x) => /createOrder|chargeOnlineOrder|\/x\/c|\/x\/p/.test(String(x))), [], '🔴 zero sends');
});

test('D-4a cold dish: resolved against the VERIFIED FRESH body — waits on a presentation body, opens on the fresh one; absent from the fresh body ⇒ the store', async () => {
  const d = anyDish();
  const W = routeShell(`/r/x_pizza/plato/${encodeURIComponent(d.key)}`, { envelope: 'hold', storage: memStorage(storedMenu('x_pizza')) }); await flush(); await flush();
  const ui = W.ui.store() && W.ui.store().ui;
  assert.ok(ui, 'premise: the store mounts on its stored (presentation) menu');
  assert.equal(ui.state.open, null, '🔴 never opened on the unverified presentation body');
  W.release('x_pizza'); await flush(); await flush();
  assert.ok(W.ui.store().ui.state.open, '🔴 the fresh body confirmed the dish ⇒ its sheet opens');
  assert.equal(where(W), `/r/x_pizza/plato/${encodeURIComponent(d.key)}`);
  const N = routeShell('/r/x_pizza/plato/no_such_dish'); await flush(); await flush();
  assert.equal(N.ui.store().ui.state.open, null); assert.equal(where(N), '/r/x_pizza', '🔴 absent from the fresh body ⇒ the store, URL replaced');
});

test('D-4a unverified ≠ absent: offline / 503 / partial keep the link PENDING (URL kept, nothing entered); only a fresh COMPLETE directory without the store ⇒ silent Inicio', async () => {
  for (const sc of ['unavailable_503', 'partial_unavailable']) {
    const S = routeShell('/r/la_musa', { dirScript: [sc] }); await flush(); await flush();
    assert.equal(S.ui.store(), null, `${sc}: nothing entered`); assert.equal(where(S), '/r/la_musa', `🔴 ${sc}: unverified must keep the requested route`);
  }
  const G = routeShell('/r/la_musa', { dirScript: ['tombstone'] }); await flush(); await flush();
  assert.equal(G.ui.store(), null); assert.equal(where(G), '/', '🔴 confirmed absent (complete, not listed) ⇒ silent Inicio');
  assert.equal(G.q('.errsheet'), null, 'silent: no new copy, no sheet');
  const U = routeShell('/no/such/path'); await flush(); assert.equal(where(U), '/', 'an unknown path ⇒ Inicio');
});

test('D-4a generation: a user navigation CANCELS a pending cold link — a late verification never enters the old target', async () => {
  const late = deferred();
  const S = routeShell('/r/x_pizza', { dirScript: [{ p: late.p }] }); await flush();
  assert.equal(S.ui.store(), null, 'premise: the directory has not answered (pending)');
  S.click('.tabbar [data-tab="search"]'); await flush();
  late.resolve(resp('complete')); await flush(); await flush();
  assert.equal(S.ui.store(), null, '🔴 a cancelled cold link entered its store after the user left');
  assert.equal(where(S), '/buscar');
});

test('D-4a native / routing off: no replaceState from the router and no hydration (byte-identical boot)', async () => {
  const S = bootShell({ url: 'https://app.test/r/x_pizza' });
  let calls = 0; const real = S.w.history.replaceState.bind(S.w.history); S.w.history.replaceState = (...a) => { calls++; return real(...a); };
  await flush(); await flush();
  S.click('.tabbar [data-tab="search"]'); await flush();
  assert.equal(S.ui.store(), null, 'no hydration without routing'); assert.equal(calls, 0, 'no reflection without routing');
});

test('D-4a cold /pago, every UNREADABLE lock case (Codex r2 #4): the marker (reconcile fails), the freeze state (unknown), the pending record ⇒ «Sin conexión» with a status-only retry — never the checkout, ZERO sends', async () => {
  const d = anyDish();
  for (const key of ['capp:x_pizza:placed', 'capp:x_pizza:cart', 'capp:x_pizza:pending_place']) {
    const st = memStorage(cartOf('x_pizza', d.key)), real = st.getItem;
    let armed = false; st.getItem = (k) => { if (armed && k === key) throw new Error('unreadable'); return real(k); };
    const sends = [];
    const S = routeShell('/r/x_pizza/pago', { storage: st, fetchLog: sends });
    armed = true;   // the boot's own reads (directory, menus) are fine; the store's lock reads are not
    await flush(); await flush();
    const ui = S.ui.store() && S.ui.store().ui;
    assert.ok(ui, `${key}: premise: the store mounted`);
    assert.notEqual(ui.state.screen, 'checkout', `🔴 ${key}: never the checkout over an unreadable lock`);
    assert.equal(ui.state.layerKind, 'err', `🔴 ${key}: the offline sheet must show`);
    assert.match(txt(S.q('#layer')), /Sin conexión/, `${key}: the offline sheet`);
    assert.ok(S.q('#layer [data-act="frozen-status"]'), `${key}: «Reintentar» re-reads the STATUS (recoverLocked), never a send`);
    assert.deepEqual(sends.filter((x) => /\/x\/c|\/x\/p/.test(String(x))), [], `🔴 ${key}: zero sends`);
  }
});

test('D-4a §4: ADOPTION never discards a lock — a staged fresh body is NOT adopted (the mount is not torn down) while a payment lock is held, on the TAP path too', async () => {
  const t0 = T0, d = anyDish();
  const storage = memStorage({ ...storedMenu('x_pizza'), ...cartOf('x_pizza', d.key),
    'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_c', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, pay_pending: true, dispatched: 1, cart_gen: 'g_c', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }) });
  const apiFetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) });
  const S = bootShell({ envelope: 'hold', storage, apiFetch }); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const ui0 = S.ui.store().ui;
  S.release('x_pizza', repriced(d.name, 26)); await flush(); await flush();
  assert.ok(S.ui.store().adopt, 'premise: a CHANGED fresh body is staged for adoption');
  assert.equal(ui0.lockedNow(), true, 'premise: the payment lock is held');
  S.click('#cart-bar'); await flush(); S.click('#layer [data-act="checkout"]'); await flush(); await flush();
  assert.equal(S.ui.store().ui, ui0, '🔴 adoption tore down a LOCKED mount');
});

// ── Codex D-4a code r1 (the reviewer's repro sequences) ──
test('D-4a r1 P1: a device Back while a cold link is HELD cancels it — a delayed directory never mounts the store (nor re-arms the sentinel)', async () => {
  const late = deferred();
  const S = routeShell('/r/x_pizza', { dirScript: [{ p: late.p }] }); await flush();
  assert.equal(S.ui.store(), null, 'premise: held (the directory has not answered)');
  S.w.history.back(); await flush(); await flush();
  late.resolve(resp('complete')); await flush(); await flush();
  assert.equal(S.ui.store(), null, '🔴 r1 P1: a Back did not cancel the held cold link');
});

test('D-4a r1 P2: a cold /pago on a PRESENTATION menu keeps its intent — the fresh menu arriving opens the checkout (never left on the store)', async () => {
  const d = anyDish();
  const S = routeShell('/r/x_pizza/pago', { envelope: 'hold', storage: memStorage({ ...storedMenu('x_pizza'), ...cartOf('x_pizza', d.key) }) }); await flush(); await flush();
  const ui = S.ui.store() && S.ui.store().ui; assert.ok(ui, 'premise: mounted on the stored (presentation) menu');
  assert.equal(ui.orderable(), false, 'premise: not orderable yet');
  S.release('x_pizza'); await flush(); await flush();
  assert.equal(S.ui.store().ui.state.screen, 'checkout', '🔴 r1 P2: the fresh menu must run the pending /pago');
  assert.equal(where(S), '/r/x_pizza/pago');
});

test('D-4a r1 P2: a LOCKED cold dish with a staged CHANGED menu never opens on the old mount (stale prices) — it stays pending', async () => {
  const t0 = T0, d = anyDish();
  const storage = memStorage({ ...storedMenu('x_pizza'), ...cartOf('x_pizza', d.key),
    'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_c', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, pay_pending: true, dispatched: 1, cart_gen: 'g_c', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }) });
  const apiFetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) });
  const S = routeShell(`/r/x_pizza/plato/${encodeURIComponent(d.key)}`, { envelope: 'hold', storage, apiFetch }); await flush(); await flush();
  const ui0 = S.ui.store().ui;
  S.release('x_pizza', repriced(d.name, 26)); await flush(); await flush();
  assert.ok(S.ui.store().adopt && ui0.lockedNow(), 'premise: a changed fresh body staged + a held lock');
  assert.equal(S.ui.store().ui.state.open, null, '🔴 r1 P2: the dish opened on the OLD mount (stale prices)');
  assert.equal(where(S), `/r/x_pizza/plato/${encodeURIComponent(d.key)}`, 'still pending: the requested route kept');
});

test('D-4a r1 P2: hydration is gated on bootReturn.mode ∈ {none, invalid} — an OWNERLESS resumed handoff does not hydrate the linked store', async () => {
  const storage = memStorage({ 'capp:return': JSON.stringify({ v: 1, pay: 'complete', order: ORDER, t: 'pt_9', owner: null, at: T0 }) });
  const S = routeShell('/r/x_pizza', { storage }); await flush(); await flush();
  assert.equal(S.ui.store(), null, '🔴 r1 P2: a resumed (ownerless) return let the deep link hydrate');
});
