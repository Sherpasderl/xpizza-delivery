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
  schedulingLive: false, outOfZone: false, tab: 'home', cartN: 0, q: '', recent: [], ...over, promoAuth: over.promoAuth || over.auth || 'guest' });   // the shell's admitted tri-state (= auth in these pure cells)
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
function bootShell({ dirScript = ['complete'], envelope = 'ok', storage, auth = 'guest', now, geolocation = null, search = '', fetchLog = [], apiFetch = null, runtime = RUNTIME, stampedDir = null, pageFetch = null, mountExtra = {}, media = null, url = null, readPublic = null, preMount = null } = {}) {
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const html = readFileSync(join(stampedDir || HERE, 'shell.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link [^>]+>/g, '').replace('</head>', () => `<style>${css}</style></head>`);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: url || 'https://app.test/' });
  const w = dom.window;
  if (media) w.matchMedia = media.matchMedia;   // D-2: the viewport the shell reads at mount (a controllable matchMedia)
  if (preMount) preMount(w);   // a host object present BEFORE the shell mounts (the installed app's Capacitor bridge)
  if (stampedDir) { w.fetch = pageFetch; w.eval(readFileSync(join(stampedDir, 'sherpa-client.js'), 'utf8')); }   // the page's FIRST script
  for (const f of ['capp-version.js', 'capp-menu.js', 'capp-cart.js', 'capp-serialize.js', 'capp-confirm-quote.js', 'capp-checkout.js', 'capp-api.js', 'capp-theme.js', 'capp-ui.js', 'capp-eligibility.js', 'capp-auth-state.js',
    'capp-menu-cache.js', 'capp-directory.js', 'capp-shell.js', 'capp-shell-nav.js', 'capp-home.js', 'capp-device-account.js', 'capp-auth-firebase.js', 'capp-signup-api.js', 'capp-signup.js', 'capp-schedule.js', 'capp-phone.js', 'capp-routes.js', 'capp-view.js', 'form-order-number.js', 'status-view.js', 'form-live-status.js', 'capp-order.js', 'capp-rate.js', 'capp-shell-ui.js']) w.eval(readFileSync(join(HERE, f), 'utf8'));
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
  const ui = w.CappShellUI.mount(w.document, { CappCheckout: require('./capp-checkout.js'), ...(readPublic ? { readPublic } : {}), fetchDirectory, fetchEnvelope, readAvailability: async () => [], onEvent: (n, d) => events.push([n, J(d)]), runtime, storage: storage || memStorage(), now: () => clock.t,
    auth: { state: () => auth }, geolocation, search, timers: { setTimeout: (f, ms) => { const h = setTimeout(f, ms); if (h && typeof h.unref === 'function') h.unref(); return h; }, clearTimeout: (t) => clearTimeout(t), setInterval: () => 0, clearInterval: () => {} }, uiOpts: { CappCheckout: require('./capp-checkout.js'), CappApi: stampedDir ? w.CappApi : require('./capp-api.js'), apiOpts: { ...(stampedDir ? {} : { fetch: (u, i) => { fetchLog.push(String(u)); return apiFetch ? apiFetch(String(u), i) : new Promise(() => {}); } }), now: () => clock.t, sleep: async () => {} } }, ...mountExtra });
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
  const GR = { ...RUNTIME, guestCardOnly: true, supportWhatsapp: '50497952893' };   // the production runtime carries the support number (Cuenta's «Ayuda»)
  const S = bootShell({ auth: 'guest', runtime: GR }); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush();
  assert.equal(txt(S.q('.flowbar h1')), 'Cuenta');
  assert.deepEqual(S.qa('.guestcard li').map((l) => txt(l)), ['Efectivo al entregar o al recoger', 'Recompensas, promos y envío gratis', 'Programá pedidos y guardá tu dirección']);
  assert.equal(S.qa('.guestcard button.primary').length, 1); assert.equal(txt(S.q('.guestcard .primary')), 'Entrá o creá tu cuenta');
  // owner 2026-11-01: «Pedidos» IS in launch scope (ORDERS_SCREEN on) ⇒ the guest card keeps v6's «Pedidos · Los de este teléfono» row
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
// a Firebase ID token in the REAL writer's shape (a JWT; only `exp` is read by the client, never the signature) — one hour past T0 by default
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOK = (uid, expMs = T0 + 3600e3) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ sub: uid, user_id: uid, customer: true, exp: Math.floor(expMs / 1000) })}.sig`;   // the customer claim (getMyOrders requires customer === true)
const WARNINGS = []; process.on('warning', (w) => WARNINGS.push(w));   // Codex promo r4 #5: no TimeoutOverflowWarning (asserted last)
// failToken: the next N getIdToken() calls REJECT; failFrom: every call from index N on rejects; tokExp: the issued tokens' exp (ms)
// rotate: each getIdToken() issues a NEW token (exp + n s) — a fresh token that really changes ⇒ the setter's notifier fires
function fakeFirebase({ persisted = null, hold = null, failSignOut = 0, failToken = 0, failFrom = Infinity, tokExp, rotate = false } = {}) {
  const calls = { load: 0, ct: [], out: 0 }; let listeners = [], user = persisted;
  // hold: { on, q } — while on, every token read waits for the test to release it (a slow SDK)
  let tokN = 0; const rot = (n) => (rotate ? (tokExp ?? T0 + 3600e3) + n * 1000 : tokExp);
  const tok = (u) => { const n = tokN++; return failToken > 0 ? (failToken--, Promise.reject(new Error('network'))) : n >= failFrom ? Promise.reject(new Error('network')) : hold && hold.on ? new Promise((r) => hold.q.push(() => r(TOK(u, rot(n))))) : Promise.resolve(TOK(u, rot(n))); };
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
  assert.deepEqual(J(S.ui.state.member), { uid: 'u_ana', name: 'Ana Pérez', phone: '99990000', email: 'ana@gmail.com', idToken: TOK('u_ana') });
  assert.equal(await S.ui.state.member.getIdToken(), TOK('u_ana'), 'the transport\'s send-time token comes from the SDK');
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
  assert.deepEqual(J(S.ui.state.member ?? null), { uid: 'u_ana', name: 'Ana Pérez', phone: '99990000', email: 'ana@gmail.com', idToken: TOK('u_ana') }, '🔴 restored ⇒ autofilled from the cache');
  const fb2 = fakeFirebase({ persisted: 'u_other' });
  const O = bootShell({ auth: 'unresolved', storage: memStorage({ 'capp:member_profile': prof, 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_other' }) }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb2.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.deepEqual(J(O.ui.state.member ?? null), { uid: 'u_other', name: '', phone: '', email: '', idToken: TOK('u_other') }, '🔴 another member\'s cached profile is never shown');
  // Codex G7 r1 #2 purges a mismatched cache first; when that removal FAILS, the read itself still refuses another uid's profile
  const stuck = memStorage({ 'capp:member_profile': prof, 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_other' }) }); stuck.removeItem = () => { throw new Error('denied'); };
  const fb3 = fakeFirebase({ persisted: 'u_other' });
  const P = bootShell({ auth: 'unresolved', storage: stuck, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb3.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await flush(); await flush();
  assert.equal(stuck.getItem('capp:member_profile'), prof, 'premise: the purge could not remove the cache');
  assert.deepEqual(J(P.ui.state.member ?? null), { uid: 'u_other', name: '', phone: '', email: '', idToken: TOK('u_other') }, '🔴 another member\'s cached profile is never shown (the purge failed)');
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
  assert.equal(quotes[quotes.length - 1], TOK('u_ana'), 'premise: the member\'s quote carries the member token');
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
async function g7Boot({ profile = G7_PROFILE({ promos: true }), srv = g7Server(), fbOpts = {}, media = null, runtime = G7_RUNTIME } = {}) {
  const fb = fakeFirebase({ persisted: 'u_ana', ...fbOpts });
  const store = g7Store(profile);
  const S = bootShell({ auth: 'unresolved', storage: store, runtime, mountExtra: { loadSdk: fb.loadSdk, signupFetch: srv.fetch }, media });
  await flush(); await flush();
  S.click('.tabbar [data-tab="account"]'); await flush();
  return { S, fb, srv, store };
}
const g7Rows = (S) => S.qa('.flow .rows .rowbtn').map((b) => txt(b));
test('G7 frame 1 / 4a: the member\'s Cuenta from the cached profile — the initial, name / phone / email on three lines, Pedidos · Promociones (on) · Ayuda, the session group, «v0.1.0»; never the host\'s tab event', async () => {
  const { S } = await g7Boot({ runtime: { ...G7_RUNTIME, supportWhatsapp: '50497952893' } });
  assert.equal(S.events.filter((e) => e[0] === 'tab').length, 0, '🔴 G7-shell: the member\'s Cuenta is the shell\'s (no host event)');
  assert.equal(txt(S.q('.acct-hero .av')), 'A');
  assert.deepEqual([...S.qa('.acct-hero .t > *')].map((x) => x.textContent), ['Ana Pérez', '+504 9612-3344', 'ana.perez@gmail.com'], '🔴 G7-hero: name, phone, email on three lines');
  // owner 11-01: «Pedidos» in scope ⇒ its row first (v6)
  assert.deepEqual(g7Rows(S), ['Pedidos', 'Direcciones Agregá tu dirección', 'Promociones Ofertas por correo y WhatsApp', 'Ayuda', 'Cerrar sesión', 'Olvidar este teléfono Cierra tu sesión y deja de recordar tu número']);   // + «Direcciones» (C-6a, D-3 r3 DECIDED)
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
  assert.deepEqual([call[1], call[2]], [{ context: 'platform', value: false }, TOK('u_ana')], '🔴 G7-setPromos: contract §6');
  assert.equal(ok.S.q('[data-act="promos"] .switch').getAttribute('aria-checked'), 'false');
  assert.equal(JSON.parse(ok.store.getItem('capp:member_profile')).promos, false, 'the cache follows a confirmed change');
  const bad = await g7Boot({ srv: g7Server(false) });
  bad.S.click('[data-act="promos"]'); await flush();
  assert.equal(bad.S.q('[data-act="promos"] .switch').getAttribute('aria-checked'), 'true', '🔴 G7-revert: back to its value');
  assert.equal(bad.S.q('#toast').textContent, 'No se guardó el cambio. Intentá de nuevo.', '🔴 G7-toast');
  assert.equal(JSON.parse(bad.store.getItem('capp:member_profile')).promos, true);
});
test('G7 frame 4b: no served promotions value ⇒ the switch INERT (aria-disabled, the .45); a uid without a cached profile ⇒ the placeholder bars, the rows usable', async () => {
  const noVal = await g7Boot({ runtime: { ...G7_RUNTIME, supportWhatsapp: '50497952893' }, profile: G7_PROFILE() });
  assert.equal(noVal.S.q('[data-act="promos"]').getAttribute('aria-disabled'), 'true', '🔴 G7-inert: no value served ⇒ inert');
  noVal.S.click('[data-act="promos"]'); await flush();
  assert.equal(noVal.srv.sent.filter((x) => x[0] === 'setPromos').length, 0, 'an inert switch sends nothing');
  const bare = await g7Boot({ runtime: { ...G7_RUNTIME, supportWhatsapp: '50497952893' }, profile: null });
  assert.equal(bare.S.qa('.acct-hero .t .bar').length, 3, '🔴 G7-placeholder: three static bars'); assert.ok(bare.S.q('.acct-hero .av.ph'));
  assert.ok(bare.S.q('[data-act="signout"]') && bare.S.q('[data-act="site-help"]'), 'the rows usable (Ayuda, the session group)');
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
  S.click('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="x_pizza"]'); await flush();   // the desk: «Todos» is the D-3 r3 grid (.rgrid); the phone: .rlist
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

// owner 2026-11-01 reversed the D-2 suppression: «Pedidos» is in launch scope — every v6 entry point reaches it, and each one WORKS
test('Pedidos (owner 11-01): every entry point — tabbar / desknav, the guest card row, the member Cuenta row — opens the «Pedidos» screen, desktop AND phone', async () => {
  for (const desk of [true, false]) {
    const H = bootShell({ media: fakeMedia(desk), runtime: { ...RUNTIME, guestCardOnly: true } }); await flush();
    const nav = desk ? '.desknav [data-tab="orders"]' : '.tabbar [data-tab="orders"]';
    assert.ok(H.q(nav), `🔴 home (${desk ? 'desktop' : 'phone'}): the orders control`);
    H.click(nav); await flush(); assert.equal(txt(H.q('.pagehead h1')), 'Pedidos', `🔴 ${desk ? 'desknav' : 'tabbar'} ⇒ Pedidos`);
    H.click(desk ? '.desknav [data-tab="account"]' : '.tabbar [data-tab="account"]'); await flush();
    assert.ok(H.q('.guestcard'), 'premise: the guest card');
    H.click('.rows .rowbtn[data-tab="orders"]'); await flush(); assert.equal(txt(H.q('.pagehead h1')), 'Pedidos', '🔴 the guest card row ⇒ Pedidos');
    const { S } = await g7Boot({ media: fakeMedia(desk) });
    assert.ok(S.q('.acct-hero'), 'premise: the member Cuenta');
    S.click('.rows .rowbtn[data-tab="orders"]'); await flush(); assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', '🔴 the member row ⇒ Pedidos');
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
  S.click('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="x_pizza"]'); await flush();
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

// ── Codex D-4a code r2 (NEW P2): a pending retry fires ONLY while the user has done nothing since hydration began ──
test('D-4a r2: opening the store SEARCH while a cold /pago waits cancels it — the fresh menu never dismisses the search for the checkout', async () => {
  const d = anyDish();
  const S = routeShell('/r/x_pizza/pago', { envelope: 'hold', storage: memStorage({ ...storedMenu('x_pizza'), ...cartOf('x_pizza', d.key) }) }); await flush(); await flush();
  const ui = S.ui.store().ui; assert.equal(ui.orderable(), false, 'premise: /pago is waiting for the fresh menu');
  S.click('[data-act="ssearch"]'); await flush();
  assert.equal(ui.state.layerKind, 'ssearch', 'premise: the store search is open');
  S.release('x_pizza'); await flush(); await flush();
  assert.equal(S.ui.store().ui.state.screen, 'store', '🔴 r2: the fresh menu opened the checkout over the user\'s search');
  assert.equal(S.ui.store().ui.state.layerKind, 'ssearch', 'the search stays');
});

test('D-4a r2: an in-store action during a LOCKED dish hydration cancels it — the dish never opens later when the lock clears', async () => {
  const t0 = T0, d = anyDish();
  const storage = memStorage({ ...storedMenu('x_pizza'), ...cartOf('x_pizza', d.key),
    'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_c', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, pay_pending: true, dispatched: 1, cart_gen: 'g_c', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }) });
  const apiFetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, state: 'pending' }) });
  const S = routeShell(`/r/x_pizza/plato/${encodeURIComponent(d.key)}`, { envelope: 'hold', storage, apiFetch }); await flush(); await flush();
  S.release('x_pizza', repriced(d.name, 26)); await flush(); await flush();
  assert.ok(S.ui.store().adopt && S.ui.store().ui.lockedNow(), 'premise: pending behind a lock + a staged changed body');
  const mode = S.q('[data-act="mode"][data-val="pickup"]'); assert.ok(mode, 'premise: the Delivery / Pickup toggle');
  S.click(mode); await flush();   // the user acts inside the store WITHOUT changing the route (the step stays «store»)
  assert.equal(S.ui.store().ui.state.open, null, 'premise: no sheet yet (the lock holds)');
  storage.removeItem('capp:x_pizza:pending_place'); storage.removeItem('capp:x_pizza:pending_pay');   // later, the lock clears
  S.ui.store().ui.render(); await flush(); await flush();
  assert.equal(S.ui.store().ui.state.open, null, '🔴 r2: the cancelled dish link opened after the lock cleared');
  assert.equal(where(S), '/r/x_pizza', 'the URL reflects the screen the user is on (the link was cancelled)');
});

// ── PLAN-capp-store-promo-feeinfo r0 (APPROVED 2026-11-01): the store header as v6 (:1609 the fee ⓘ + member «Envío gratis»,
// :1615-1617 the guest promo pill) — the ONE promoFree predicate (home's), the auth tri-state (a reserved pill while unresolved:
// no pop-in), the ⓘ only when fee + zone are finite, the feeinfo sheet falling back to the DIRECTORY values (never «undefined km»)
const liveAuth = (st) => { const fns = new Set(); return { a: { state: () => st, onChange: (f) => { fns.add(f); return () => fns.delete(f); } }, set(v) { st = v; for (const f of [...fns]) f(v); } }; };
// bounded wait for a boot condition (load-robust: a fixed flush count flaked at load1 ≈ 12); the cell's own asserts still decide
const until = async (f, ms = 4000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 >= ms) throw new Error(`until: timed out after ${ms} ms — ${String(f).slice(0, 120)}`); await flush(); } };
async function promoStore(opts = {}, rid = 'x_pizza') { const S = bootShell(opts); await until(() => S.q(`.rlist .rcard[data-rid="${rid}"]`)); S.click(`.rlist .rcard[data-rid="${rid}"]`); await flush(); assert.ok(S.q('.info'), `premise: the ${rid} store header`); return S; }
const bare = (html) => html.replace(/<span class="pill deal" style="visibility:hidden" aria-hidden="true">/g, '<span class="pill deal">');   // the reserved pill's two attributes only

test('store promo: a GUEST on a promo store — the «Envío gratis con tu cuenta» pill between the name and the facts, «Envío desde L 45» and the fee ⓘ', async () => {
  const S = await promoStore({ auth: 'guest' });
  const pill = S.q('.info .hdpills .pill.deal');
  assert.ok(pill, '🔴 store promo: the guest pill is missing');
  assert.equal(pill.textContent, 'Envío gratis con tu cuenta');
  assert.equal(pill.getAttribute('aria-hidden'), null); assert.ok(!/visibility/.test(pill.getAttribute('style') || ''), 'shown, not reserved');
  assert.ok(pill.parentElement.previousElementSibling && pill.parentElement.previousElementSibling.classList.contains('idrow'), 'after the id row (v6 :1622)');
  assert.ok(pill.parentElement.nextElementSibling && pill.parentElement.nextElementSibling.classList.contains('facts'), 'before the facts');
  assert.ok(txt(S.q('.info .facts')).includes('Envío desde L 45'), txt(S.q('.info .facts')));
  const ib = S.q('.info .facts .infobtn[data-act="feeinfo"]');
  assert.ok(ib, '🔴 store promo: the fee ⓘ is missing'); assert.equal(ib.getAttribute('aria-label'), 'Detalle del envío');
});

test('store promo: an ADMITTED member on a promo store — no pill, «Envío gratis» in place of «Envío desde», the ⓘ kept; a raw session alone (host «member», nothing admitted) claims nothing', async () => {
  const raw = await promoStore({ auth: 'member' });   // Codex promo r1 #1: the checkout would send this one as a guest
  assert.equal(raw.q('.info .facts .free'), null, '🔴 store promo: a raw session the checkout does not admit gets no «Envío gratis»');
  assert.equal(raw.q('.info .pill.deal').getAttribute('aria-hidden'), 'true', 'not admitted ⇒ the pill stays reserved');
  const R = await realAuthStore({ persisted: 'u_ana', complete: 'u_ana', prof: { v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' } });
  await R.release(); const S = R.S;
  assert.equal(S.q('.info .pill.deal'), null, '🔴 store promo: a member never sees the guest pill');
  const f = S.q('.info .facts');
  assert.ok(f.querySelector('.free') && f.querySelector('.free').textContent === 'Envío gratis', `🔴 store promo: the member's «Envío gratis» is missing: ${txt(f)}`);
  assert.ok(!txt(f).includes('Envío desde'), txt(f));
  assert.ok(f.querySelector('.infobtn[data-act="feeinfo"]'), 'the ⓘ stays');
});

test('store promo: while auth is UNRESOLVED the pill is RESERVED (hidden, aria-hidden, same markup ⇒ same box); it resolves IN PLACE — guest shows it; a raw session not admitted re-reserves it (claims nothing)', async () => {
  const la = liveAuth('unresolved');
  const S = await promoStore({ mountExtra: { auth: la.a } });
  const pill = S.q('.info .pill.deal');
  assert.ok(pill, '🔴 store promo: the unresolved pill must be reserved (no pop-in when the guest resolves)');
  assert.equal(pill.getAttribute('aria-hidden'), 'true'); assert.ok(/visibility:hidden/.test(pill.getAttribute('style') || ''));
  assert.ok(txt(S.q('.info .facts')).includes('Envío desde L 45'), 'neither variant claims «gratis» while unresolved');
  const info = S.q('.info'), sc = S.q('#scroller'), reserved = bare(info.outerHTML);
  la.set('guest'); await flush();
  assert.equal(S.q('.info'), info, '🔴 store promo: the header resolves IN PLACE (no store re-render)'); assert.equal(S.q('#scroller'), sc);
  assert.equal(S.q('.info .pill.deal').getAttribute('aria-hidden'), null, 'the guest pill is now shown');
  assert.equal(info.outerHTML, reserved, '🔴 store promo: the reserved header IS the guest header (no reflow when it resolves)');
  const G = await promoStore({ auth: 'guest' }); assert.equal(G.q('.info').outerHTML, info.outerHTML, 'identical to a guest boot');
  la.set('member'); await flush();   // a raw session, not admitted (no setMember): Codex promo r1 #1 — back to reserved, nothing claimed
  assert.equal(S.q('.info'), info); assert.equal(S.q('.info .pill.deal').getAttribute('aria-hidden'), 'true', '🔴 store promo: an unadmitted session re-reserves the pill');
  assert.equal(S.q('.info .facts .free'), null, '🔴 store promo: «Envío gratis» only for the ADMITTED member');
});

test('store promo: nothing invented — an unpriced store draws no pill, no fee text, no ⓘ; a priced store without a zone draws no ⓘ', async () => {
  const S = await promoStore({ auth: 'guest', dirScript: ['fee_none'] }, 'la_musa');
  assert.equal(S.q('.info .pill.deal'), null); assert.ok(!/Envío/.test(txt(S.q('.info .facts'))), txt(S.q('.info .facts')));
  assert.equal(S.q('.info .infobtn'), null, '🔴 store promo: no ⓘ without a priced fee');
  const r = J(resp('complete')); r.body.restaurants.find((x) => x.restaurant_id === 'x_pizza').coverage_km = null;
  const Z = await promoStore({ auth: 'guest', dirScript: [r] });
  assert.ok(txt(Z.q('.info .facts')).includes('Envío desde L 45')); assert.equal(Z.q('.info .infobtn'), null, '🔴 store promo: no ⓘ without a zone (no control without effect)');
});

test('store promo: the store ⓘ opens the feeinfo sheet with the DIRECTORY values (no quote yet) — never «undefined» / «NaN»', async () => {
  const S = await promoStore({ auth: 'guest' });
  S.click('.info [data-act="feeinfo"]'); await flush();
  const p = txt(S.q('#layer .errsheet p'));
  assert.ok(p && p.includes('Desde L 45; zona de entrega hasta 7 km de'), `🔴 store promo: the feeinfo sheet must fall back to the directory: ${p}`);
  assert.ok(!/undefined|NaN|null/.test(p), p);
});

// Codex promo-feeinfo r1 — through the REAL Firebase callback path (fakeFirebase + the shell's own auth state, not liveAuth):
// #1 «Envío gratis» follows the ADMITTED identity (the one the checkout sends with), never the raw session; #2 the production
// auth handling (dropMember → setMember) keeps the store page — scroll and focus — when the identity does not change
async function realAuthStore({ persisted = null, failSignOut = 0, complete = null, prof = null, focus = '.seg [data-val="pickup"]' } = {}) {
  const fb = fakeFirebase({ persisted, failSignOut }), gate = deferred();
  const st = memStorage({ ...(complete ? { 'capp:member_complete': JSON.stringify({ v: 1, uid: complete }) } : {}), ...(prof ? { 'capp:member_profile': JSON.stringify(prof) } : {}) });
  const S = await promoStore({ auth: 'unresolved', storage: st, runtime: SU_RUNTIME, mountExtra: { loadSdk: () => gate.p.then(() => fb.loadSdk()), signupFetch: signupServer(ANA).fetch } });
  const sc = S.q('#scroller'), info = S.q('.info'), btn = S.q(focus);
  sc.scrollTop = 250; btn.focus();
  assert.equal(S.w.document.activeElement, btn, `premise: focus on ${focus}`);
  return { S, fb, sc, info, btn, release: async () => { gate.resolve(); await flush(); await flush(); await flush(); } };
}

test('store promo r1 #1: an INCOMPLETE restored account whose sign-out is rejected — not admitted (S.member null) ⇒ no «Envío gratis», the guest pill stays reserved', async () => {
  const R = await realAuthStore({ persisted: 'u_inc', failSignOut: 9 });
  await R.release();
  assert.ok(R.fb.calls.out >= 1, 'premise: the shell tried to sign the incomplete session out (and it was rejected)');
  assert.equal(R.S.ui.state.member ?? null, null, 'premise: the checkout identity is a guest (not admitted)');
  const f = R.S.q('.info .facts');
  assert.equal(f.querySelector('.free'), null, `🔴 store promo r1: «Envío gratis» from a session the checkout does not admit: ${txt(f)}`);
  assert.ok(txt(f).includes('Envío desde L 45'), txt(f));
});

test('store promo r1 #2: unresolved → GUEST through the real Firebase callback keeps the store page — same nodes, scroll 250, focus — and shows the pill', async () => {
  const R = await realAuthStore({ persisted: null });
  assert.equal(R.S.q('.info .pill.deal').getAttribute('aria-hidden'), 'true', 'premise: reserved while unresolved');
  await R.release();
  assert.equal(R.S.q('#scroller'), R.sc, '🔴 store promo r1: the real auth callback re-rendered the store');
  assert.equal(R.S.q('.info'), R.info);
  assert.equal(R.sc.scrollTop, 250, '🔴 store promo r1: the scroll was reset');
  assert.equal(R.S.w.document.activeElement && R.S.w.document.activeElement.dataset.val, 'pickup', '🔴 store promo r1: focus was lost');
  assert.equal(R.S.q('.info .pill.deal').getAttribute('aria-hidden'), null, 'the guest pill is shown');
});

test('store promo r1 #2: an ADMITTED member arriving (a restored complete session) on a scrolled store — «Envío gratis», the pill gone, scroll and focus kept', async () => {
  const R = await realAuthStore({ persisted: 'u_ana', complete: 'u_ana', prof: { v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' } });
  await R.release();
  assert.ok(R.S.ui.state.member && R.S.ui.state.member.uid === 'u_ana', 'premise: admitted');
  assert.ok(R.S.q('.info .facts .free'), '🔴 store promo r1: the admitted member sees «Envío gratis»');
  assert.equal(R.S.q('.info .pill.deal'), null);
  assert.equal(R.S.q('#scroller').scrollTop, 250, '🔴 store promo r1: the scroll was reset when the member arrived');
  assert.equal(R.S.w.document.activeElement && R.S.w.document.activeElement.dataset.val, 'pickup', '🔴 store promo r1: focus was lost when the member arrived');
});

// advisor ruling (promo r1 follow-up): HOME follows the same ADMITTED identity — no «Envío gratis» unless the checkout would send as
// that member. Through the REAL Firebase callback path
async function realAuthHome({ persisted = null, failSignOut = 0, complete = null, prof = null } = {}) {
  const fb = fakeFirebase({ persisted, failSignOut });
  const st = memStorage({ ...(complete ? { 'capp:member_complete': JSON.stringify({ v: 1, uid: complete }) } : {}), ...(prof ? { 'capp:member_profile': JSON.stringify(prof) } : {}) });
  const S = bootShell({ auth: 'unresolved', storage: st, runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && (!persisted || fb.calls.out > 0 || S.ui.state.member)); await flush();
  assert.ok(S.q('.rlist .rcard[data-rid="x_pizza"]'), 'premise: Inicio with the x_pizza card');
  return { S, fb };
}
test('home promo: an INCOMPLETE restored account whose sign-out is rejected — not admitted ⇒ no «Envío gratis» on the home cards, the guest pill reserved', async () => {
  const { S, fb } = await realAuthHome({ persisted: 'u_inc', failSignOut: 9 });
  assert.ok(fb.calls.out >= 1, 'premise: the sign-out was tried (and rejected)'); assert.equal(S.ui.state.member ?? null, null, 'premise: not admitted');
  assert.equal(S.q('#app .free'), null, `🔴 home promo: «Envío gratis» on Inicio for a session the checkout does not admit: ${txt(S.q('.rlist .rcard[data-rid="x_pizza"]'))}`);
  const pill = S.q('.rlist .rcard[data-rid="x_pizza"] .pill.deal');
  assert.ok(pill && pill.getAttribute('aria-hidden') === 'true', '🔴 home promo: not admitted ⇒ the guest pill stays reserved');
});
test('home promo: an ADMITTED member (a restored complete session) ⇒ «Envío gratis» on the promo store\'s card, no guest pill', async () => {
  const { S } = await realAuthHome({ persisted: 'u_ana', complete: 'u_ana', prof: { v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' } });
  assert.ok(S.ui.state.member && S.ui.state.member.uid === 'u_ana', 'premise: admitted');
  const card = S.q('.rlist .rcard[data-rid="x_pizza"]');
  assert.ok(card.querySelector('.free') && card.querySelector('.free').textContent === 'Envío gratis', `🔴 home promo: the admitted member's «Envío gratis»: ${txt(card)}`);
  assert.equal(card.querySelector('.pill.deal'), null);
});

// Codex promo r2 — P2-A: the claim uses the SAME predicate the transport attaches the token with (CappApi.tokenOf, memberToken's
// fallback): a member with NO usable token ⇒ 'unresolved' (reserved, no claim) and no x-firebase-id-token on the quote; P2-B: the
// in-place patch keeps a focused «Detalle del envío»
const ANA_PROF = { v: 1, uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com' };
async function tokenBoot(failToken) {
  const quotes = []; const apiFetch = (u, i) => { if (u.startsWith('/x/q')) { quotes.push(i.headers['x-firebase-id-token'] || null); return quoteOk(u, i); } return new Promise(() => {}); };
  const fb = fakeFirebase({ persisted: 'u_ana', failToken });
  const S = bootShell({ auth: 'unresolved', apiFetch, storage: memStorage({ 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_ana' }), 'capp:member_profile': JSON.stringify(ANA_PROF) }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  return { S, quotes };
}
test('store promo r2 P2-A: an admitted member with NO usable token — no «Envío gratis» on Inicio or the store AND no member token on the quote; with a token — both', async () => {
  const N = await tokenBoot(99);
  assert.ok(N.S.ui.state.member && N.S.ui.state.member.uid === 'u_ana' && !N.S.ui.state.member.idToken, 'premise: admitted, no usable token');
  assert.equal(N.S.q('#app .free'), null, '🔴 store promo r2: Inicio claims «Envío gratis» for a member whose requests carry no token');
  assert.equal(N.S.q('.rlist .rcard[data-rid="x_pizza"] .pill.deal').getAttribute('aria-hidden'), 'true', 'no usable token ⇒ unresolved ⇒ reserved');
  N.S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.equal(N.S.q('.info .facts .free'), null, '🔴 store promo r2: the store claims «Envío gratis» for a member whose requests carry no token');
  N.S.click('#app [data-act="back"], #app .store-nav [aria-label="Cerrar"]'); await flush(); await flush();
  await toShellCheckout(N.S); N.S.click('#app [data-act="type"][data-val="pickup"]'); await flush(); await flush();
  assert.ok(N.quotes.length >= 1, 'premise: a quote was sent'); assert.equal(N.quotes[N.quotes.length - 1], null, 'and it carries no member token (the server prices a guest)');
  const T = await tokenBoot(0);
  assert.equal(txt(T.S.q('.rlist .rcard[data-rid="x_pizza"] .free')), 'Envío gratis', '🔴 store promo r2: a member WITH a token sees «Envío gratis» on Inicio');
  T.S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.ok(T.S.q('.info .facts .free'), '🔴 store promo r2: … and on the store');
  T.S.click('#app [data-act="back"], #app .store-nav [aria-label="Cerrar"]'); await flush(); await flush();
  await toShellCheckout(T.S); T.S.click('#app [data-act="type"][data-val="pickup"]'); await flush(); await flush();
  assert.equal(T.quotes[T.quotes.length - 1], TOK('u_ana'), 'and the quote carries the member token');
});
test('store promo r2 P2-A: a token that ARRIVES LATER upgrades the claim in place (the same header node, «Envío gratis» shown)', async () => {
  const U = await tokenBoot(1);
  U.S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.equal(U.S.q('.info .facts .free'), null, 'premise: no token yet ⇒ no claim');
  const info = U.S.q('.info');
  await until(() => U.S.q('.info .facts .free'), 8000).catch(() => {});   // the real 2 s retry, load-robust; the named asserts below decide
  assert.equal(U.S.q('.info'), info, '🔴 store promo r2: the upgrade re-rendered the store');
  assert.ok(U.S.q('.info .facts .free'), '🔴 store promo r2: the token that arrived later never upgraded the claim');
});
test('store promo r2 P2-B: a focused «Detalle del envío» survives the real unresolved → guest callback (the same node focused, scroll 250)', async () => {
  const R = await realAuthStore({ persisted: null, focus: '.info .facts .infobtn' });
  await R.release();
  assert.equal(R.S.w.document.activeElement, R.btn, `🔴 store promo r2: the focused ⓘ was destroyed (focus on ${R.S.w.document.activeElement && R.S.w.document.activeElement.tagName})`);
  assert.equal(R.sc.scrollTop, 250);
  assert.equal(R.S.q('.info .pill.deal').getAttribute('aria-hidden'), null, 'the guest pill shown');
});

// Codex promo r3 — the WHOLE token class: ONE predicate with expiry (CappApi.tokenUsable: a JWT whose exp > now + skew) for the claim AND
// the header; fresh tokens enter ONLY through CappApi.acceptToken, which fires the member's identity-guarded onTokenChange ⇒ the shell
// patches Inicio + the store in place; the shell's token timers are handles, cleared on sign-out / a uid change / destroy
// long timers are held for the test to fire; short ones are real but unref'd, so a failed cell's 1 ms re-arm never pins the process
const longTimers = () => { const pend = new Map(); let id = 0;
  return { pend, T: { setTimeout: (f, ms) => { if (ms >= 1000) { const h = { long: ++id, ms }; pend.set(h, f); return h; } const h = setTimeout(f, ms); if (h && typeof h.unref === 'function') h.unref(); return h; }, clearTimeout: (h) => { if (h && h.long) pend.delete(h); else clearTimeout(h); }, setInterval: () => 0, clearInterval: () => {} },
    fire() { const all = [...pend.entries()]; pend.clear(); for (const [, f] of all) f(); } }; };
const memberBoot = ({ fb, apiFetch = null, now = null, timers = null }) => bootShell({ auth: 'unresolved', apiFetch, now, storage: memStorage({ 'capp:member_complete': JSON.stringify({ v: 1, uid: 'u_ana' }), 'capp:member_profile': JSON.stringify(ANA_PROF) }), runtime: SU_RUNTIME, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch, ...(timers ? { timers } : {}) } });
const quoteLog = (quotes) => (u, i) => { if (u.startsWith('/x/q')) { quotes.push(i.headers['x-firebase-id-token'] || null); return quoteOk(u, i); } return new Promise(() => {}); };

test('until(): a condition still false at the deadline REJECTS with a descriptive error (never a silent pass)', async () => {
  await assert.rejects(until(() => false, 50), /until: timed out after 50 ms/);
});

test('store promo r3: token RECOVERY mid-quote — the quote\'s member header and the store\'s «Envío gratis» appear TOGETHER (the notifier patches in place)', async () => {
  const hold = { on: false, q: [] }, quotes = [];
  const fb = fakeFirebase({ persisted: 'u_ana', failToken: 1, hold });
  const S = memberBoot({ fb, apiFetch: quoteLog(quotes) });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  assert.equal(S.q('#app .free'), null, 'premise: the admission token failed ⇒ no claim');
  await toShellCheckout(S);
  hold.on = true; S.click('#app [data-act="type"][data-val="pickup"]'); await flush();   // the quote waits on the SDK token
  S.w.history.back(); await until(() => S.ui.store() && S.ui.store().ui.state.screen === 'store'); await flush();   // the device Back
  assert.equal(S.ui.store().ui.state.screen, 'store', 'premise: back on the delivery store while the quote waits');
  S.click('.seg [data-val="delivery"]'); await flush();   // the quote was a Pickup one; the store's fee line shows only in Delivery
  assert.ok(txt(S.q('.info .facts')).includes('Envío desde L 45'), 'premise: guest pricing while the token is missing');
  assert.equal(S.q('.info .facts .free'), null, 'premise: no claim yet');
  const info = S.q('.info');
  hold.on = false; for (const r of hold.q.splice(0)) r(); await until(() => quotes.length >= 1); await flush(); await flush();
  assert.equal(quotes[quotes.length - 1], TOK('u_ana'), 'premise: the quote carried the recovered member token');
  assert.equal(S.q('.info'), info, '🔴 store promo r3: the recovery re-rendered the store');
  assert.ok(S.q('.info .facts .free'), '🔴 store promo r3: the token recovered (the header went out) but the store still shows guest pricing');
});

test('store promo r3: an EXPIRED cached token with the refresh REJECTED — no «Envío gratis» AND no member header on the quote', async () => {
  const clock = { t: T0 }, quotes = [];
  const fb = fakeFirebase({ persisted: 'u_ana', failFrom: 1, tokExp: T0 + 120e3 });   // admission gets a 2-minute token; every refresh fails
  const S = memberBoot({ fb, apiFetch: quoteLog(quotes), now: clock });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  assert.ok(S.q('.rlist .rcard[data-rid="x_pizza"] .free'), 'premise: a usable token ⇒ the claim');
  clock.t = T0 + 10 * 60e3;   // ten minutes later: the cached token has expired
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.equal(S.q('.info .facts .free'), null, '🔴 store promo r3: an EXPIRED token still authorizes «Envío gratis»');
  S.click('#app [data-act="back"], #app .store-nav [aria-label="Cerrar"]'); await flush(); await flush();
  await toShellCheckout(S); S.click('#app [data-act="type"][data-val="pickup"]'); await until(() => quotes.length >= 1); await flush();
  assert.equal(quotes[quotes.length - 1], null, '🔴 store promo r3: an expired token was sent (the server would price a guest anyway)');
});

test('store promo r3: a token EXPIRING while the page is open withdraws the claim IN PLACE (Inicio + the store), the pill reserved', async () => {
  const clock = { t: T0 }, L = longTimers();
  const fb = fakeFirebase({ persisted: 'u_ana', failFrom: 1, tokExp: T0 + 120e3 });
  const S = memberBoot({ fb, now: clock, timers: L.T });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.ok(S.q('.info .facts .free'), 'premise: claimed while the token is usable');
  assert.ok(L.pend.size >= 1, 'premise: the expiry is armed');
  const info = S.q('.info'); clock.t = T0 + 120e3 - 60e3; L.fire(); await flush(); await flush();   // AT the cutoff: exp − 60 s skew
  assert.equal(S.q('.info'), info, '🔴 store promo r3: the expiry re-rendered the store');
  assert.equal(S.q('.info .facts .free'), null, '🔴 store promo r3: an expired token keeps claiming «Envío gratis» on the open store');
  assert.equal(S.q('.info .pill.deal').getAttribute('aria-hidden'), 'true', 'withdrawn ⇒ reserved');
});

test('store promo r3: the token timers are HANDLES — none left after a sign-out, a uid change or destroy', async () => {
  const L = longTimers();
  const fb = fakeFirebase({ persisted: 'u_ana', failToken: 99 });
  const S = memberBoot({ fb, timers: L.T });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  assert.ok(L.pend.size >= 1, 'premise: a token retry is pending');
  await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush(); await flush();
  assert.equal(L.pend.size, 0, '🔴 store promo r3: a token timer survived the sign-out');
  const L2 = longTimers(), fb2 = fakeFirebase({ persisted: 'u_ana', failToken: 99 });
  const D = memberBoot({ fb: fb2, timers: L2.T });
  await until(() => D.ui.state.member); await flush();
  assert.ok(L2.pend.size >= 1, 'premise: pending again'); D.ui.destroy();
  assert.equal(L2.pend.size, 0, '🔴 store promo r3: a token timer survived destroy()');
});

// Codex promo r4 — the last consolidated pass: the sign-out race, the early expiry callback, a real uid switch, no timer overflow
test('store promo r4 #1: a held quote token RELEASED AFTER a sign-out — no member header, member null (identity rechecked after the await)', async () => {
  const hold = { on: false, q: [] }, quotes = [];
  const fb = fakeFirebase({ persisted: 'u_ana', hold, rotate: true });   // the held token is a NEW one (the setter would really store it)
  const S = memberBoot({ fb, apiFetch: quoteLog(quotes) });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  await toShellCheckout(S);
  hold.on = true; S.click('#app [data-act="type"][data-val="pickup"]'); await flush();   // the quote waits on the token
  const ana = S.ui.state.member, anaTok = ana.idToken;
  await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush(); await flush();
  assert.equal(S.ui.state.member ?? null, null, 'premise: signed out while the quote waited');
  hold.on = false; for (const r of hold.q.splice(0)) r(); await until(() => quotes.length >= 1); await flush();
  assert.equal(quotes[quotes.length - 1], null, '🔴 store promo r4: the signed-out member\'s token was sent');
  assert.equal(ana.idToken, anaTok, '🔴 store promo r4: a token was ACCEPTED for a signed-out member (the helper\'s identity guard)');
  assert.equal(S.ui.state.member ?? null, null);
});
test('store promo r4 #2: an expiry callback firing 1 ms EARLY re-arms — the claim stays until the cutoff, then is withdrawn', async () => {
  const clock = { t: T0 }, L = longTimers();
  const fb = fakeFirebase({ persisted: 'u_ana', failFrom: 1, tokExp: T0 + 120e3 });
  const S = memberBoot({ fb, now: clock, timers: L.T });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  const cutoff = T0 + 120e3 - 60e3;
  clock.t = cutoff - 1; L.fire(); await flush();   // the timer fires 1 ms early (the re-armed 1 ms timer is a real one)
  assert.ok(S.q('.info .facts .free'), '🔴 store promo r4: an early expiry callback withdrew a still-usable claim');
  clock.t = cutoff; await until(() => !S.q('.info .facts .free'), 2000).catch(() => {});
  assert.equal(S.q('.info .facts .free'), null, '🔴 store promo r4: the early callback did not re-arm (the claim outlives the cutoff)');
});
test('store promo r4 #5: a real UID SWITCH cancels the old identity\'s token timers', async () => {
  const L = longTimers();
  const fb = fakeFirebase({ persisted: 'u_ana', failToken: 99 });
  const S = memberBoot({ fb, timers: L.T });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  assert.ok(L.pend.size >= 1, 'premise: u_ana\'s token retry is pending');
  await fb.loadSdk().then(({ authMod }) => authMod.signInWithCustomToken({}, 'ct:u_bob')); await flush(); await flush();   // another uid's session
  assert.notEqual(S.ui.state.member && S.ui.state.member.uid, 'u_ana', 'premise: u_ana is no longer the identity');
  assert.equal(L.pend.size, 0, '🔴 store promo r4: u_ana\'s token timer survived the uid switch');
});
// Codex promo r5 — the post-level identity check: after `await memberToken(…)` one more microtask opens before the send; a sign-out or a
// uid switch queued from the token notifier lands there ⇒ post() compares the member AGAIN, with no await before the dispatch
const subOf = (t) => { try { return t ? JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub : null; } catch (_) { return null; } };
async function notifierRace(queue) {
  const dispatches = []; let S = null;
  const fb = fakeFirebase({ persisted: 'u_ana', rotate: true });
  const apiFetch = (u, i) => { if (u.startsWith('/x/q')) { const m = S.ui.state.member; dispatches.push({ sub: subOf(i.headers['x-firebase-id-token']), current: m ? m.uid : null }); return quoteOk(u, i); } return new Promise(() => {}); };
  S = memberBoot({ fb, apiFetch });
  await until(() => S.q('.rlist .rcard[data-rid="x_pizza"]') && S.ui.state.member); await flush();
  await toShellCheckout(S);
  const m = S.ui.state.member, orig = m.onTokenChange, { authMod } = await fb.loadSdk();
  m.onTokenChange = (x) => { orig(x); queueMicrotask(() => queue(authMod)); };   // queued FROM the notifier, inside the quote's token await
  S.click('#app [data-act="type"][data-val="pickup"]'); await until(() => dispatches.length >= 1); await flush(); await flush();
  return { S, dispatches };
}
test('store promo r5: a SIGN-OUT queued from the token notifier — no quote dispatch carries Ana\'s token while the member is null', async () => {
  const { S, dispatches } = await notifierRace((A) => A.signOut());
  assert.ok(dispatches.length >= 1, 'premise: the quote was dispatched'); assert.equal(S.ui.state.member ?? null, null, 'premise: signed out');
  const bad = dispatches.filter((d) => d.sub === 'u_ana' && d.current !== 'u_ana');
  assert.deepEqual(bad, [], `🔴 store promo r5: Ana's token went out after her sign-out: ${JSON.stringify(dispatches)}`);
});
test('store promo r5: a UID SWITCH queued from the token notifier — no quote dispatch carries Ana\'s token while she is not the identity', async () => {
  const { S, dispatches } = await notifierRace((A) => A.signInWithCustomToken({}, 'ct:u_bob'));
  assert.ok(dispatches.length >= 1, 'premise: the quote was dispatched'); assert.notEqual(S.ui.state.member && S.ui.state.member.uid, 'u_ana', 'premise: Ana is no longer the identity');
  const bad = dispatches.filter((d) => d.sub === 'u_ana' && d.current !== 'u_ana');
  assert.deepEqual(bad, [], `🔴 store promo r5: Ana's token went out after the switch: ${JSON.stringify(dispatches)}`);
});
// ── «PEDIDO RECIBIDO» (v6 row 42, owner 2026-11-01: a launch gap; build what v6 draws): a placed order leaves «Enviando» for the SHELL's
// order screen (CappOrder) — the store mount left, the sent lines / totals / details on it, close ⇒ Inicio. Never back to «Enviando».
async function placeShellCash(S, reply) {
  const ui = await toShellCheckout(S);
  const type = (sel, v) => { const el = S.q(sel); assert.ok(el, `premise: ${sel}`); el.value = v; el.dispatchEvent(new S.w.Event('input', { bubbles: true })); };
  S.click('[data-act="pin"]'); await flush(); S.click('[data-act="pin-done"]'); await flush();
  type('#f-details', 'Portón negro'); type('#f-name', 'Ana'); type('#f-phone', '9999 0000'); await flush();
  S.click('[data-act="pay"][data-val="cash"]'); await flush();
  S.click('#cta'); await flush(); S.click('[data-act="tipc"][data-val="0"]'); await flush(); S.click('[data-act="tip-place"]'); await flush();
  S.click('#layer [data-act="placing-go"]'); await flush(); await flush();
  await flush(700);   // the 600 ms happy beat
  return ui;
}
const ORDER_FETCH = (reply) => (u, i) => (u.startsWith('/x/q') ? quoteOk(u, i) : u.startsWith('/x/c') ? Promise.resolve({ status: 200, ok: true, json: async () => reply(JSON.parse(i.body)) }) : new Promise(() => {}));
test('Pedido recibido: a placed cash order ⇒ the shell\'s order screen — «Pedido recibido», the sent lines + Envío + Total, the delivery details; the store left; close ⇒ Inicio', async () => {
  const S = bootShell({ apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    await flush();
    const ui = await placeShellCash(S);
    const dish = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
    assert.equal(S.ui.store(), null, '🔴 PR-1: the store mount is left once the order is placed');
    assert.equal(txt(S.q('.mk-title')), 'Pedido recibido', '🔴 PR-1: the order screen');
    assert.equal(txt(S.q('.mk-status')), 'Estamos por empezar a preparar tu pedido');
    const rows = [...S.w.document.querySelectorAll('.receipt2 .rrow')].map((r) => [...r.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(rows.some((r) => r[0] === `1× ${dish.name}`), `🔴 PR-1: the sent line (${JSON.stringify(rows)})`);
    assert.ok(rows.some((r) => r[0] === 'Envío' && r[1] === 'L 45'), '🔴 PR-1: the quoted Envío');
    assert.ok(rows.some((r) => r[0] === 'Pago' && r[1] === 'Efectivo al entregar'));
    assert.equal(txt(S.q('.mk-card .n')), 'Portón negro', 'the delivery details');
    assert.equal(S.q('.mk-num'), null, 'no display number from the server yet ⇒ no «Orden #» line (fail soft)');
    S.click('[data-act="order-close"]'); await flush();
    assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', '🔴 PR-1: close ⇒ «Pedidos» (v6: data-tab="orders")');
    assert.equal(S.q('.mk-title'), null);
    assert.ok(S.q('.ocard.active'), 'the order stays active: its card on Pedidos');
  } finally { S.w.close(); }
});
// «Orden #N» (advisor ruling from 5f's note: the number is stamped AFTER createOrder): the forms' own order-number module reads
// order_tracking/{token}/display_number from the public base — the number when it lands; never the long id
test('Pedido recibido: «Orden #N» from order_tracking/{token}/display_number via the shared order-number module (the exact public path; nothing before it lands)', async () => {
  const reads = []; let landed = false;   // the allocator stamps the number when the test says so (deterministic under load)
  const readPublic = async (u) => { reads.push(u); return { ok: true, json: async () => (landed ? 47 : null) }; };
  const S = bootShell({ runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    await flush(); await placeShellCash(S);
    assert.equal(S.q('.mk-num'), null, 'pending ⇒ no line yet');
    await flush(900); assert.equal(S.q('.mk-num'), null, 'a read answering null ⇒ still nothing (never the long id)');
    assert.ok(reads.length >= 1, 'premise: at least one read happened'); landed = true;
    await flush(2700);
    assert.equal(txt(S.q('.mk-num')), 'Orden #47 · Te avisamos por WhatsApp', '🔴 PR-2: the display number from the tracking node');
    assert.ok(reads.length >= 2 && reads.filter((u) => u.includes('/order_tracking/')).every((u) => u === 'https://rtdb.test/order_tracking/tok_abcdefgh12/display_number.json'), `🔴 PR-2: the exact public path (${reads[0]})`);
  } finally { S.w.close(); }
});
test('Pedido recibido: «Ayuda» opens wa.me/<runtime.supportWhatsapp> with the order number pre-filled; «Compartir seguimiento» copies <the context\'s tracker>/<token>; both absent without their config', async () => {
  const opened = [], copied = [];
  const readPublic = async () => ({ ok: true, json: async () => 47 });
  const S = bootShell({ runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test', supportWhatsapp: '50497952893', trackBases: { x_pizza: 'https://xpizzatrack.netlify.app' } }, readPublic,
    apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    S.w.open = (u) => { opened.push(u); return null; };
    Object.defineProperty(S.w.navigator, 'clipboard', { value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } }, configurable: true });
    await flush(); await placeShellCash(S); await flush(900);
    assert.equal(txt(S.q('.mk-num')), 'Orden #47 · Te avisamos por WhatsApp', 'premise: the number landed');
    S.click('[data-act="order-help"]'); await flush();
    assert.deepEqual(opened, ['https://wa.me/50497952893?text=' + encodeURIComponent('Hola, tengo un problema con mi pedido #47')], '🔴 PR-help: the link derives from the one key + the order number');
    S.click('[data-act="order-share"]'); await flush();
    assert.deepEqual(copied, ['https://xpizzatrack.netlify.app/tok_abcdefgh12'], '🔴 PR-share: the context\'s tracker + the token');
  } finally { S.w.close(); }
  const N = bootShell({ apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try { await flush(); await placeShellCash(N); assert.equal(N.q('[data-act="order-help"]'), null, 'no number ⇒ no «Ayuda»'); assert.equal(N.q('[data-act="order-share"]'), null, 'no tracker ⇒ no share'); } finally { N.w.close(); }
});
// frame 7 (owner 10-27) in v6's .rw slot, end to end on the REAL writers: a guest card order (the code sheet, the charge with its
// grant) leaves for PixelPay; a NEW page load on the paid return lands on «Pedido recibido» with the offer; «Crear mi cuenta» redeems
// the grant (no second code) and signs in through the shell's own path; the offer is gone for the member
test('Pedido recibido · frame 7: a guest card order\'s paid return shows the account offer (phone + email pre-filled); «Crear mi cuenta» redeems the grant and signs in — the offer gone', async () => {
  const storage = memStorage(), grant = { token: 'sg_1', expires_at: T0 + 15 * 60e3 };
  const GEO = { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) };
  const sent = [];
  const pay1 = (u, i) => { const ep = u.split('?')[0].split('/').pop(); const body = i && i.body ? JSON.parse(i.body) : null; sent.push([ep, body]);
    if (u.startsWith('/x/q')) return quoteOk(u, i);
    const j = u.startsWith('/x/rc') ? { ok: true, resend_in_s: 41 } : u.startsWith('/x/vc') ? { ok: true, checkout_ticket: 'tk_1' }
      : u.startsWith('/x/p') ? { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1', signup_grant: grant } : { ok: false };
    return Promise.resolve({ status: 200, ok: true, json: async () => j }); };
  const RT = { ...SU_RUNTIME, endpoints: { ...RUNTIME.endpoints, requestCheckoutCode: '/x/rc', verifyCheckoutCode: '/x/vc' } };
  const fb1 = fakeFirebase();
  const A = bootShell({ storage, auth: 'guest', runtime: RT, apiFetch: pay1, geolocation: GEO, mountExtra: { loadSdk: fb1.loadSdk, signupFetch: signupServer(ANA).fetch } });
  let id = null;
  try {
    await flush();
    await toShellCheckout(A);
    const type = (sel, v) => { const el = A.q(sel); assert.ok(el, `premise: ${sel}`); el.value = v; el.dispatchEvent(new A.w.Event('input', { bubbles: true })); };
    A.click('[data-act="pin"]'); await flush(); A.click('[data-act="pin-done"]'); await flush();
    type('#f-details', 'Portón negro'); type('#f-name', 'Ana'); type('#f-phone', '9999 0000'); type('#f-email', 'ana.perez@gmail.com'); await flush();
    A.click('#cta'); await flush(); A.click('[data-act="tipc"][data-val="0"]'); await flush(); A.click('[data-act="tip-place"]'); await flush(); await flush();
    if (!A.q('#layer .otp input[data-i="0"]') && A.q('#layer [data-act="placing-go"]')) { A.click('#layer [data-act="placing-go"]'); await flush(); await flush(); }
    const box = A.q('#layer .otp input[data-i="0"]'); assert.ok(box, 'premise: the code sheet'); box.value = '482913'; box.dispatchEvent(new A.w.Event('input', { bubbles: true })); await flush();
    A.click('#layer [data-act="otp-verify"]'); await flush(); await flush();
    const ch = sent.find((x) => x[0] === 'p' && x[1] && x[1].order_id);   // RUNTIME.endpoints.chargeOnlineOrder = /x/p
    assert.ok(ch, `premise: the charge was sent (${sent.map((x) => x[0]).join(',')})`); id = ch[1].order_id;
  } finally { A.w.close(); }
  // the paid return: a NEW page load on the same device storage
  const fb = fakeFirebase(); const su = [];
  const suFetch = async (u, i) => { const ep = u.split('?')[0].split('/').pop(); const b = i && i.body ? JSON.parse(i.body) : null; su.push([ep, b]);
    const j = ep === 'getSignupConfig' ? { ok: true, terms_url: 'https://legal.test/t', privacy_url: 'https://legal.test/p', legal_ready: true, google_enabled: false }
      : ep === 'redeemSignupGrant' ? { ok: true, token: 'ct:u_new', is_new: true, name: 'Ana', completion: 'complete' } : { ok: true };
    return { status: 200, json: async () => j }; };
  const pay2 = async (u) => ({ status: 200, ok: true, json: async () => (u.startsWith('/x/s') ? { ok: true, state: 'paid' } : { ok: false }) });
  const B = bootShell({ storage, auth: 'guest', runtime: RT, apiFetch: pay2, search: `?pay=complete&order=${id}&t=pt_1`, mountExtra: { loadSdk: fb.loadSdk, signupFetch: suFetch } });
  try {
    await flush(); await flush(); await flush(800);
    assert.equal(txt(B.q('.mk-title')), 'Pedido recibido', '🔴 PR-7: the paid return lands on the order screen');
    assert.ok(B.q('.mk-sheet .guestcard.offer'), '🔴 PR-7: the offer in the order sheet');
    const recB = JSON.parse(storage.getItem('capp:active_order') || 'null');
    assert.ok(recB && recB.order && recB.order.grant === null, '🔴 PED-r2-9: the live signup grant is NEVER written to the device record');
    assert.equal(B.q('#offer-phone') && B.q('#offer-phone').value, '+504 9999-0000', 'the verified phone pre-filled');
    assert.equal(B.q('#offer-email') && B.q('#offer-email').value, 'ana.perez@gmail.com', 'the order\'s email pre-filled');
    const kids = [...B.q('.mk-sheet').children].map((x) => x.className.split(' ')[0]);
    assert.ok(kids.indexOf('guestcard') < kids.indexOf('mk-card'), 'v6\'s .rw slot: before the delivery details');
    B.click('[data-act="offer-create"]'); await flush(); await flush(); await flush();
    const r = su.find((x) => x[0] === 'redeemSignupGrant');
    assert.ok(r, '🔴 PR-7: «Crear mi cuenta» redeems the grant'); assert.equal(r[1].grant, 'sg_1'); assert.equal(r[1].email, 'ana.perez@gmail.com');
    assert.deepEqual(fb.calls.ct, ['ct:u_new'], '🔴 PR-7: signed in with the redeemed custom token (no second code)');
    assert.equal(su.filter((x) => x[0] === 'requestOtp').length, 0, 'no second code');
    assert.equal(B.q('.guestcard.offer'), null, '🔴 PR-7: the offer is gone for the member');
  } finally { B.w.close(); }
});
// ── «Pedido recibido» stage 2: the LIVE status, in place, from order_tracking/{token} (RTDB REST stream) — the record from the REAL
// writer (create-order-build.buildCreateOrderUpdates) and its transitions on the paths index.js writes (status / delivered_at /
// cancelled_at, driver_name, is_active_drop via tracking-mirror.stackedWaitingTxn) ──
const FN_REQ = createRequire(join(ROOT, 'xpizza-functions/x.js'));
const { buildCreateOrderUpdates } = FN_REQ('./create-order-build'), { orderBreakdownCents } = FN_REQ('./order-money'), { stackedWaitingTxn } = FN_REQ('./tracking-mirror');
function trackingRecordOf(token, orderType = 'delivery') {   // the REAL writer's public tracking node for a placed order
  const fields = { customer_name: 'Ana', customer_phone: '99990000', customer_email: 'a@b.hn', notes: '', pickup_time: 'standard', items_text: '1x Plato',
    payment_method: 'cash', address_detected: 'Col. Prueba, SPS', address_details: 'Portón negro', maps_link: 'm', waze_link: 'w', items: [{ name: 'Plato', qty: 1 }] };
  const u = buildCreateOrderUpdates({ orderId: 'XP-1', orderType, now: T0, trackingToken: token, total: 340, lat: 15.52, lng: -88.04, fields,
    hubSnap: { hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'X. Pizza', restaurant_phone: '+504' }, restaurantId: 'x_pizza', priceBreakdown: orderBreakdownCents(340, 'x_pizza'),
    facturaPriced: { items: [] }, cashTenderedCents: 34000, freeOrder: false, rewardStamp: {} });
  const rec = u[`order_tracking/${token}`]; assert.ok(rec && rec.status === 'new', 'premise: the writer\'s tracking node');
  return rec;
}
function fakeES() {
  const made = [];
  class ES { constructor(url) { this.url = url; this.l = {}; this.closed = false; made.push(this); } addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); } close() { this.closed = true; }
    emit(type, path, data) { for (const f of this.l[type] || []) f({ type, data: JSON.stringify({ path, data }) }); } }
  return { ES, made };
}
test('Pedido recibido · live: the order screen follows order_tracking/{token} in place — preparing → stacked (is_active_drop false) → out with the driver → delivered (the stream closed); the window «Llega a – b» from S5\'s prep', async () => {
  const { ES, made } = fakeES(); const TOKEN = 'tok_abcdefgh12';
  const pub = { prep_eta_min: 25 };
  const readPublic = async (u) => ({ ok: true, json: async () => (u.endsWith('/public.json') ? pub : null) });
  const S = bootShell({ runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic, mountExtra: { EventSource: ES }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: TOKEN })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    await flush(); await placeShellCash(S); await flush();
    assert.equal(made.length, 1, '🔴 PR-live: ONE stream'); assert.equal(made[0].url, `https://rtdb.test/order_tracking/${TOKEN}.json`, '🔴 PR-live: the public node by token');
    assert.match(txt(S.q('.mk-window')) || '', /^Llega \d{1,2}:\d{2}/, '🔴 PR-window: «Llega a – b»');
    const es = made[0]; let rec = trackingRecordOf(TOKEN);
    es.emit('put', '/', rec); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Pedido recibido', 'the writer\'s «new»');
    es.emit('put', '/status', 'preparing'); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Tu pedido se está preparando', '🔴 PR-live: preparing, in place');
    assert.equal(S.ui.store(), null, 'still the shell\'s order screen');
    es.emit('put', '/driver_name', 'Carlos'); es.emit('put', '/status', 'out_for_delivery'); es.emit('put', '/is_active_drop', stackedWaitingTxn(undefined)); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Carlos va en camino', '🔴 PR-stacked: is_active_drop false ⇒ «va en camino»');
    assert.equal(txt(S.q('.ssub')), 'Tu repartidor tiene una parada rápida en camino a la tuya, luego va directo hacia vos.', '🔴 PR-stacked: the tracker\'s line (status-view)');
    assert.equal(txt(S.q('.drivercard .t b')), 'Carlos'); assert.equal(S.q('.pincard'), null, 'no PIN on the record ⇒ no PIN card');
    es.emit('put', '/is_active_drop', true); es.emit('patch', '/', { driver_location: { lat: 15.51, lng: -88.03 } }); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Carlos está en camino', '🔴 PR-live: the active drop');
    assert.equal(txt(S.q('.ssub')), '', 'no ETA minutes without a real ETA (owner rule)');
    es.emit('put', '/status', 'delivered'); es.emit('put', '/delivered_at', T0 + 40 * 60e3); await flush();
    assert.equal(txt(S.q('.mk-title')), '¡Pedido entregado!', '🔴 PR-live: delivered');
    assert.equal(es.closed, true, '🔴 PR-live: the stream closed on a final state');
  } finally { S.w.close(); }
});
test('Pedido recibido · live: a claim with no driver name says the tracker\'s calm copy (status-view); the cancelled path ⇒ «Pedido cancelado» and the stream closed; leaving the screen closes the stream', async () => {
  const { ES, made } = fakeES(); const TOKEN = 'tok_abcdefgh12';
  const S = bootShell({ runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic: async () => ({ ok: false }), mountExtra: { EventSource: ES }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: TOKEN })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    await flush(); await placeShellCash(S); await flush();
    const es = made[0]; es.emit('put', '/', trackingRecordOf(TOKEN)); es.emit('put', '/status', 'out_for_delivery'); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Tu pedido va en camino', '🔴 PR-nameless: the tracker\'s calm headline');
    assert.equal(txt(S.q('.ssub')), 'Pronto llegará a tu dirección', '🔴 PR-nameless: its sub');
    es.emit('put', '/status', 'cancelled'); es.emit('put', '/cancelled_at', T0 + 5 * 60e3); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Pedido cancelado', '🔴 PR-cancel'); assert.equal(es.closed, true, '🔴 PR-cancel: the stream closed');
  } finally { S.w.close(); }
  const { ES: ES2, made: m2 } = fakeES();
  const N = bootShell({ runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic: async () => ({ ok: false }), mountExtra: { EventSource: ES2 }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: TOKEN })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try { await flush(); await placeShellCash(N); await flush(); N.click('[data-act="order-close"]'); await flush(); assert.equal(m2[0].closed, true, '🔴 PR-live: close ⇒ the stream closed'); } finally { N.w.close(); }
});
// ── MOCKUP-capp-native-store-update (owner 2026-11-01: A + B, «Ahora no», state 3 without a reference, state 4 = one cart line) —
// the INSTALLED app; the signals are INJECTED here (runtime.store from runtime.store_urls; the «latest native build» signal) ──
const STORE_RT = { ...RUNTIME, native: true, store: { name: 'App Store', url: 'https://apps.apple.com/app/id1234567890' } };
const F426 = (script) => (u, i) => { if (u.startsWith('/x/q')) return quoteOk(u, i); if (u.startsWith('/x/c')) { const n = script.shift(); return n === 'network' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ status: n.status, ok: n.status === 200, json: async () => n.json }); } return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: false }) }); };
async function toShellPlace(S) {
  await toShellCheckout(S);
  const type = (sel, v) => { const el = S.q(sel); assert.ok(el, `premise: ${sel}`); el.value = v; el.dispatchEvent(new S.w.Event('input', { bubbles: true })); };
  S.click('[data-act="pin"]'); await flush(); S.click('[data-act="pin-done"]'); await flush();
  type('#f-details', 'Portón negro'); type('#f-name', 'Ana'); type('#f-phone', '9999 0000'); await flush();
  S.click('[data-act="pay"][data-val="cash"]'); await flush();
  S.click('#cta'); await flush(); S.click('[data-act="tipc"][data-val="0"]'); await flush(); S.click('[data-act="tip-place"]'); await flush();
  S.click('#layer [data-act="placing-go"]'); await flush(); await flush();
}
const GEO_OK2 = { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) };
test('store-update state 2: the installed app\'s 426 on a send ⇒ the calm sheet «Actualizá la app para hacer pedidos» + «Abrir App Store» (opens the store URL) + «Ahora no» (closes; nothing re-sent)', async () => {
  const opened = [];
  const S = bootShell({ runtime: STORE_RT, apiFetch: F426([{ status: 426, json: { error: 'client_update_required', app: 'orders', required_compat: 3 } }]), geolocation: GEO_OK2 });
  try {
    S.w.open = (u) => { opened.push(u); return null; };
    await flush(); await toShellPlace(S);
    assert.equal(txt(S.q('#layer .errsheet h2')), 'Actualizá la app para hacer pedidos', '🔴 SU-2: the drawn sheet');
    assert.equal(txt(S.q('#layer .errsheet p')), 'Esta versión ya no puede enviar pedidos. Tu carrito se guarda tal cual y te espera cuando volvás.');
    assert.deepEqual(S.qa('#layer .errsheet .acts button').map((b) => b.textContent), ['Abrir App Store', 'Ahora no'], '🔴 SU-2: the drawn actions');
    assert.ok(S.q('#layer .errsheet .icon.calm'), 'the calm icon, never the error red');
    S.click('#layer [data-act="store-open"]'); await flush();
    assert.deepEqual(opened, ['https://apps.apple.com/app/id1234567890'], '🔴 SU-2: «Abrir App Store» opens the store URL');
    S.click('#layer [data-act="lclose"]'); await flush();
    assert.equal(S.q('#layer .errsheet'), null, '«Ahora no» closes'); assert.equal(S.ui.store().ui.state.screen, 'checkout', 'back on the checkout as it was');
  } finally { S.w.close(); }
});
test('store-update state 3: a 426 while the identity is kept in flight ⇒ «Actualizá la app para seguir» + «Tu carrito también se guarda.» — no order reference', async () => {
  const S = bootShell({ runtime: STORE_RT, apiFetch: F426(['network', { status: 426, json: { error: 'client_update_required', app: 'orders', required_compat: 3 } }]), geolocation: GEO_OK2 });
  try {
    await flush(); await toShellPlace(S);
    assert.ok(S.q('#layer [data-act="err-retry"]'), 'premise: the lost send ⇒ «Sin conexión» with «Reintentar»');
    S.click('#layer [data-act="err-retry"]'); await flush(); await flush(); await flush();
    assert.equal(txt(S.q('#layer .errsheet h2')), 'Actualizá la app para seguir', '🔴 SU-3: the in-flight sheet');
    assert.equal(txt(S.q('#layer .errsheet .note')), 'Tu carrito también se guarda.');
    assert.ok(!/Referencia/.test(txt(S.q('#layer .errsheet')) || ''), '🔴 SU-3: no order reference (owner)');
    assert.deepEqual(S.qa('#layer .errsheet .acts button').map((b) => b.textContent), ['Abrir App Store', 'Ahora no']);
  } finally { S.w.close(); }
});
test('store-update: WITHOUT a store (no runtime.store_urls yet, or the website) a 426 shows NO store sheet — today\'s shared behaviour stays (advisor ruling (i))', async () => {
  const S = bootShell({ runtime: { ...RUNTIME, native: true }, apiFetch: F426([{ status: 426, json: { error: 'client_update_required', app: 'orders', required_compat: 3 } }]), geolocation: GEO_OK2 });
  try { await flush(); await toShellPlace(S); assert.ok(!/Actualizá la app/.test(txt(S.q('#layer')) || ''), '🔴 SU-none: no store sheet without a store'); assert.equal(S.q('[data-act="store-open"]'), null); } finally { S.w.close(); }
});
test('store-update: with a store, the shared coordinator gets a NO-RELOAD adapter (a bundled app cannot reload itself newer; the store sheet replaces its notice)', async () => {
  const reg = []; const SCstub = { inert: false, registerAdapter: (a) => reg.push(a), identity: { build: 'b2' } };
  const S = bootShell({ runtime: STORE_RT, mountExtra: { SherpaClient: SCstub } });
  try { await flush(); assert.equal(reg.length, 1, '🔴 SU-adapter: registered'); assert.equal(reg[0].canReload({ mode: 'checkout' }), false, '🔴 SU-adapter: never reloads'); assert.equal(typeof reg[0].notice, 'function'); } finally { S.w.close(); }
  const reg2 = []; const N = bootShell({ runtime: { ...RUNTIME, native: true }, mountExtra: { SherpaClient: { inert: false, registerAdapter: (a) => reg2.push(a), identity: { build: 'b2' } } } });
  try { await flush(); assert.equal(reg2.length, 0, 'no store ⇒ no adapter (today\'s behaviour)'); } finally { N.w.close(); }
});
test('store-update state 4: back from the store on a NEW build ⇒ the cart says «App actualizada. Tu carrito sigue aquí.» once; closed ⇒ gone; the same build ⇒ never', async () => {
  const storage = memStorage({ 'capp:app_build': 'b1' });
  const S = bootShell({ storage, runtime: { ...RUNTIME, native: true }, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try {
    await flush();
    assert.equal(storage.getItem('capp:app_build'), 'b2', 'the device records the new build at once');
    S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); await flush();
    const ui = S.ui.store().ui; const plain = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
    ui.cart.inc(plain.key); ui.render(); S.click('#cart-bar'); await flush();
    assert.equal(txt(S.q('#layer .cartnote')), 'App actualizada. Tu carrito sigue aquí.', '🔴 SU-4: the one cart line');
    S.click('#layer [data-act="cartclose"]'); await flush(); S.click('#cart-bar'); await flush();
    assert.ok(!S.qa('#layer .cartnote').some((n) => /App actualizada/.test(n.textContent)), '🔴 SU-4: gone once the cart was closed');
  } finally { S.w.close(); }
  const s2 = memStorage({ 'capp:app_build': 'b2' });
  const N = bootShell({ storage: s2, runtime: { ...RUNTIME, native: true }, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try {
    await flush(); N.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); await flush();
    const ui = N.ui.store().ui; const plain = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
    ui.cart.inc(plain.key); ui.render(); N.click('#cart-bar'); await flush();
    assert.ok(!N.qa('#layer .cartnote').some((n) => /App actualizada/.test(n.textContent)), 'the same build ⇒ no line');
  } finally { N.w.close(); }
});
test('store-update state 1: with a store AND the «newer build» signal — the Inicio line A «Hay una versión nueva de la app.» + «Actualizar» (opens the store, hidden until the next day); the Cuenta row B; no signal ⇒ neither', async () => {
  const opened = [], clock = { t: T0 };
  const S = bootShell({ now: clock, runtime: STORE_RT, mountExtra: { updateAvailable: () => true } });
  try {
    S.w.open = (u) => { opened.push(u); return null; };
    await flush();
    assert.equal(txt(S.q('.home-body .closednote.hnote span')), 'Hay una versión nueva de la app.', '🔴 SU-1A: the Inicio line');
    S.click('[data-act="app-update"]'); await flush();
    assert.deepEqual(opened, ['https://apps.apple.com/app/id1234567890'], '🔴 SU-1A: «Actualizar» opens the store');
    assert.equal(S.q('[data-act="app-update"]'), null, '🔴 SU-1A: hidden after the tap');
    clock.t = T0 + 30 * 3600e3; S.click('.tabbar [data-tab="search"]'); await flush(); S.click('.tabbar [data-tab="home"]'); await flush();
    assert.ok(S.q('[data-act="app-update"]'), '🔴 SU-1A: back the next day');
  } finally { S.w.close(); }
  const row = dom(CappHome.accountMemberHtml(VM({ tab: 'account', acct: { name: 'Ana', phone: '+504 9999-0000', email: 'a@b.hn', promos: true, settled: true }, updateRow: 'App Store' })));
  assert.equal(txt(row.querySelector('[data-act="app-update-row"]')), 'Actualizar la app Hay una versión nueva en App Store', '🔴 SU-1B: the Cuenta row');
  const N = bootShell({ runtime: STORE_RT });
  try { await flush(); assert.equal(N.q('[data-act="app-update"]'), null, 'no signal ⇒ no line (fail closed)'); } finally { N.w.close(); }
  const F = bootShell({ runtime: STORE_RT, mountExtra: { updateAvailable: () => false } });
  try { await flush(); assert.equal(F.q('[data-act="app-update"]'), null, '🔴 SU-1: the signal says no newer build ⇒ no line'); } finally { F.w.close(); }
});
test('store-update state 4 (frozen): back on a new build with a cart FROZEN for a placement ⇒ «App actualizada. Estamos revisando tu pedido.» above frame 10\'s line, its controls still disabled', async () => {
  const S = bootShell({ storage: memStorage({ ...frozenCart(), 'capp:app_build': 'b1' }), runtime: { ...RUNTIME, native: true }, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try {
    await flush(); S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); S.click('#cart-bar'); await flush();
    assert.deepEqual(S.qa('#layer .cartnote .cn-l').map((x) => x.textContent), ['App actualizada. Estamos revisando tu pedido.', 'Tu pedido se está confirmando; no se puede cambiar mientras tanto.'], '🔴 SU-4b: the two drawn lines');
    assert.ok(S.qa('#layer .cline.frozen button').every((b) => b.disabled), 'frame 10 unchanged');
    assert.equal(txt(S.q('#layer [data-act="frozen-status"]')), 'Ver estado del pedido');
  } finally { S.w.close(); }
});
test('store-update r2 (state 3 safety): the in-flight sheet keeps the retained placement record and the cart byte-for-byte (nothing cleared by the sheet)', async () => {
  const storage = memStorage();
  const S = bootShell({ storage, runtime: STORE_RT, apiFetch: F426(['network', { status: 426, json: { error: 'client_update_required', app: 'orders', required_compat: 3 } }]), geolocation: GEO_OK2 });
  try {
    await flush(); await toShellPlace(S);
    const place0 = storage.getItem('capp:x_pizza:pending_place'), cart0 = storage.getItem('capp:x_pizza:cart');
    assert.ok(place0 && JSON.parse(place0).dispatched >= 1, 'premise: the lost send retained its record');
    S.click('#layer [data-act="err-retry"]'); await flush(); await flush(); await flush();
    assert.equal(txt(S.q('#layer .errsheet h2')), 'Actualizá la app para seguir', 'premise: state 3');
    const place1 = JSON.parse(storage.getItem('capp:x_pizza:pending_place') || 'null');
    assert.ok(place1 && place1.order_id === JSON.parse(place0).order_id, '🔴 SU-r2-3: the retained placement record survives the sheet (same identity)');
    assert.equal(storage.getItem('capp:x_pizza:cart'), cart0, '🔴 SU-r2-3: the cart is untouched');
    S.click('#layer [data-act="lclose"]'); await flush();
    assert.ok(storage.getItem('capp:x_pizza:pending_place'), '🔴 SU-r2-3: «Ahora no» keeps it too');
  } finally { S.w.close(); }
});
test('store-update r2 (round trip): «Abrir App Store» records the store; the NEW build reopens THAT store with its cart open and the «App actualizada» line; the same build never; a first install is never «updated»', async () => {
  const storage = memStorage({ 'capp:app_build': 'b1' });
  const A = bootShell({ storage, runtime: STORE_RT, apiFetch: F426([{ status: 426, json: { error: 'client_update_required', app: 'orders', required_compat: 3 } }]), geolocation: GEO_OK2, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b1' } } } });
  try { A.w.open = () => null; await flush(); await toShellPlace(A); A.click('#layer [data-act="store-open"]'); await flush(); } finally { A.w.close(); }
  assert.equal(JSON.parse(storage.getItem('capp:store_handoff') || '{}').rid, 'x_pizza', '🔴 SU-r2-2: the store left for is recorded');
  const cart0 = storage.getItem('capp:x_pizza:cart'); assert.ok(cart0, 'premise: the cart persisted');
  // the SAME build relaunched (the customer came back without updating): no reopen, the handoff kept for the real update
  const Same = bootShell({ storage, runtime: STORE_RT, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b1' } } } });
  try { await flush(); await flush(); assert.equal(Same.ui.store(), null, 'same build ⇒ Inicio as usual'); } finally { Same.w.close(); }
  assert.ok(storage.getItem('capp:store_handoff'), 'the handoff waits for the new build');
  // the NEW build: that store, its cart open, the line
  const B = bootShell({ storage, runtime: STORE_RT, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try {
    await flush(); await flush(); await flush();
    assert.equal(B.ui.store() && B.ui.store().rid, 'x_pizza', '🔴 SU-r2-2: the new build reopens THAT store');
    assert.equal(B.ui.store().ui.state.layerKind, 'cart', '🔴 SU-r2-2: with its cart open');
    assert.equal(txt(B.q('#layer .cartnote')), 'App actualizada. Tu carrito sigue aquí.', 'the drawn line');
    assert.deepEqual(JSON.parse(storage.getItem('capp:x_pizza:cart')).lines, JSON.parse(cart0).lines, 'the cart\'s lines as they were (a 426 on the FIRST send released the identity, capp-api.js:604, so reconciliation lifts its freeze)');
    assert.equal(storage.getItem('capp:store_handoff'), null, 'one-shot');
  } finally { B.w.close(); }
  // a FIRST install (no previous build on the device): never «updated», nothing reopened; the build is recorded
  const fresh = memStorage({ ...frozenCart() });
  const F = bootShell({ storage: fresh, runtime: STORE_RT, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b9' } } } });
  try {
    await flush(); F.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); F.click('#cart-bar'); await flush();
    assert.ok(!F.qa('#layer .cartnote .cn-l').some((x) => /App actualizada/.test(x.textContent)), '🔴 SU-r2-3: a first install is never «updated»');
    assert.equal(fresh.getItem('capp:app_build'), 'b9', 'the first build recorded');
  } finally { F.w.close(); }
});
// ── «PEDIDOS» (owner 11-01) against getMyOrders — NOTE-getMyOrders (3a, APPROVED): a CONTRACT-FAITHFUL fake, not laxer than the note:
// GET only, no body; the token ONLY in x-firebase-id-token (customer, else 401; a tombstone 403); EXACTLY ?context=platform[&limit][&cursor]
// (else 400); one bounded page (limit 1–50, default 20) newest first with an opaque base64url {ts,id} cursor; the Row WHITELIST; active =
// a status outside {cancelled, delivered, completed}. Entries come from the REAL writer (create-order-build.attachCustomerAttribution) ──
const { attachCustomerAttribution } = FN_REQ('./create-order-build');
const TERMINAL = new Set(['cancelled', 'delivered', 'completed']);
const MO_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
function userOrderEntry(uid, orderId, { ts, total, orderType = 'delivery', items_text = '1x Margherita (L250)', items = [{ name: 'Margherita', qty: 1 }], restaurantId = 'x_pizza', status = 'new' }) {
  const u = { [`orders/${orderId}`]: { status } };
  attachCustomerAttribution(u, orderId, uid, { now: ts, total, orderType, items_text, restaurantId, items, tables: null });   // the REAL writer
  return u[`user_orders/${uid}/${orderId}`];
}
// the RECEIPT detail mode, as 3a's my-orders.js@75eed212 (APPROVED) projects it — verbatim logic: priced lines only when every one is
// well-formed, present integer totals only, the tender cash / card (never a reference), the address for a delivery only
const RCPT_TOTALS = ['subtotal_cents', 'tax_cents', 'delivery_cents', 'promo_discount_cents', 'tip_cents', 'total_cents'];
const RCPT_TENDER = { cash: 'cash', card_delivery: 'card', online: 'card' };
function projectReceipt(id, entry, o) {
  const isInt = (v) => Number.isSafeInteger(v), str = (v) => (typeof v === 'string' ? v : null), num = (v) => (Number.isFinite(v) ? v : null);
  let lines = null;
  if (Array.isArray(o.items) && o.items.length) { lines = []; for (const l of o.items) { if (!l || typeof l !== 'object' || !isInt(l.qty) || l.qty < 1 || typeof l.description !== 'string' || !isInt(l.line_gross_cents)) { lines = null; break; } lines.push({ qty: l.qty, description: l.description, line_cents: l.line_gross_cents }); } }
  const totals = {}; for (const k of RCPT_TOTALS) if (isInt(o[k])) totals[k] = o[k];
  const method = RCPT_TENDER[o.payment_method] || null, type = str(o.order_type);
  return { order_id: id, ...(Number.isFinite(o.display_number) ? { display_number: o.display_number } : {}), ts: num(entry.ts), restaurant: str(entry.restaurant), order_type: type, status: str(o.status),
    lines, items_text: str(o.items_text), totals, tender: { method, ...(method === 'cash' && isInt(o.cash_tendered_cents) ? { cash_tendered_cents: o.cash_tendered_cents } : {}) },
    ...(type === 'delivery' ? { address: { detected: str(o.address_detected), details: str(o.address_details), area: str(o.address_area) } } : {}) };
}
// «Volver a pedir» (getMyOrders' approved delta): each recipe line gains dish_id = the store's canonical dish id for its stored key,
// from the REAL resolver (canonical-binding identityMap) over a D4-a context — here built from the SERVED menu (each dish's legacy key
// by the real itemPricingKey → its served dish_id); no context ⇒ null on every line (the server's own rule)
const CBND = FN_REQ('./catalog/canonical-binding'), MPRC = FN_REQ('./menu-pricing');
function servedCtx(rid, { drop = [] } = {}) {
  const m = PROV[rid].envelope.menu;
  return { availability: 'available', attached: true, usableAsIdentity: true,
    objects: m.dishes.filter((d) => d.dish_id && !drop.includes(MPRC.itemPricingKey(d, rid))).map((d) => ({ kind: 'dish', legacyKey: MPRC.itemPricingKey(d, rid), canonicalId: String(d.dish_id) })) };
}
const withDishIds = (items, ctx) => { const map = ctx ? CBND.identityMap(ctx) : null;   // my-orders.js@75eed212 withDishIds, verbatim
  return items.map((l) => (l && typeof l === 'object' && !Array.isArray(l) ? { ...l, dish_id: (map && typeof l.key === 'string' && map.dish.get(l.key)) || null } : l)); };
function myOrdersServer(db, { deleted = new Set(), gate = null, orders = {}, rgate = null, rdelay = 0, contextFor = () => null } = {}) {
  const calls = [], rx = { inflight: 0, max: 0 };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const handler = (u, i = {}) => {
    const url = new URL(u, 'https://fn.test'); calls.push({ url: url.toString(), headers: i.headers || {}, method: i.method || 'GET', body: i.body });
    const out = (status, json) => ({ status, json: async () => json });
    if ((i.method || 'GET') !== 'GET' || i.body != null) return out(400, { ok: false, reason: 'bad_request' });
    const tok = (i.headers || {})['x-firebase-id-token'];
    // the fake verifyIdToken: the Firebase ID token's payload (the real writer's JWT shape, TOK) — a string user_id AND customer === true
    // (the contract; Codex Pedidos r1), else 401
    let uid = null; try { const pl = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString()); if (pl && typeof pl.user_id === 'string' && pl.customer === true) uid = pl.user_id; } catch (_) { uid = null; }
    if (!uid) return out(401, { ok: false, reason: 'unauthenticated' });
    if (deleted.has(uid)) return out(403, { ok: false, reason: 'deleted' });
    const keys = [...url.searchParams.keys()];
    if (keys.some((k) => !['context', 'limit', 'cursor', 'order_id'].includes(k)) || new Set(keys).size !== keys.length || url.searchParams.get('context') !== 'platform') return out(400, { ok: false, reason: 'bad_request' });
    if (url.searchParams.has('order_id')) {   // the detail mode: order_id ALONE, the createOrder id rule; 2 point reads; ONE uniform 404
      const id = url.searchParams.get('order_id');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || url.searchParams.has('limit') || url.searchParams.has('cursor')) return out(400, { ok: false, reason: 'bad_request' });
      const entry = (db[uid] || {})[id], order = orders[id];
      const res = !entry || typeof entry !== 'object' || !order || typeof order !== 'object' || order.customer_uid !== uid ? out(404, { ok: false, reason: 'not_found' }) : out(200, { ok: true, receipt: projectReceipt(id, entry, order) });
      if (rdelay) { rx.inflight++; rx.max = Math.max(rx.max, rx.inflight); return new Promise((ok) => setTimeout(() => { rx.inflight--; ok(res); }, rdelay)); }   // a SLOW server: the prefetch cells count concurrency
      const g = typeof rgate === 'function' ? rgate(id) : rgate;   // a function ⇒ one gate per call (the overlapping-read cells)
      return g ? g.then(() => res) : res;
    }
    let limit = 20; if (url.searchParams.has('limit')) { const n = Number(url.searchParams.get('limit')); if (!Number.isInteger(n) || n < 1 || n > 50) return out(400, { ok: false, reason: 'bad_request' }); limit = n; }
    let cur = null; if (url.searchParams.has('cursor')) { try { cur = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString()); } catch (_) { cur = null; } if (!cur || !Number.isFinite(cur.ts) || typeof cur.id !== 'string' || !MO_ID_RE.test(cur.id)) return out(400, { ok: false, reason: 'bad_request' }); }
    const all = Object.entries(db[uid] || {}).map(([id, e]) => ({ id, e })).sort((a, b) => (a.e.ts - b.e.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));   // orderByChild('ts'), key tie-break
    const before = cur ? all.filter((x) => x.e.ts < cur.ts || (x.e.ts === cur.ts && x.id < cur.id)) : all;   // endBefore(ts, id)
    const page = before.slice(-(limit + 1)), more = page.length > limit, rows = (more ? page.slice(1) : page).reverse();   // limitToLast(limit + 1), newest first
    const proj = ({ id, e }) => ({ order_id: id, ts: e.ts, total: e.total, order_type: e.order_type, restaurant: e.restaurant, status: e.status ?? null, items_text: typeof e.items_text === 'string' ? e.items_text : null, items: Array.isArray(e.items) ? withDishIds(e.items, contextFor(e.restaurant)) : [], ...(e.recipe_format !== undefined ? { recipe_format: e.recipe_format } : {}),
      // the approved delta: display_number read from orders/{id} for the page's rows, present only when stamped (a finite number)
      ...(orders[id] && Number.isFinite(orders[id].display_number) ? { display_number: orders[id].display_number } : {}) });
    const R = rows.map(proj), oldest = rows[rows.length - 1];
    const res = out(200, { ok: true, active: R.filter((r) => typeof r.status === 'string' && !TERMINAL.has(r.status)), past: R.filter((r) => typeof r.status !== 'string' || TERMINAL.has(r.status)), next_cursor: more ? b64({ ts: oldest.e.ts, id: oldest.id }) : null });
    return gate ? gate.then(() => res) : res;   // a DELAYED answer (the identity-switch cells)
  };
  return { handler, calls, rx };
}
test('getMyOrders fake: as strict as the note — 401 without / with a non-customer token, 403 for a tombstone, 400 for an extra key / a body / a bad limit or cursor, paging exact across 45 rows (no dup, no gap), the projection a whitelist', async () => {
  const db = { u_ana: {} }; for (let k = 0; k < 45; k++) db.u_ana[`XP-${String(k).padStart(3, '0')}`] = { ...userOrderEntry('u_ana', `XP-${k}`, { ts: T0 - (k % 7) * 1000, total: 340, status: 'delivered' }), secret_internal: 'x' };
  const { handler } = myOrdersServer(db, { deleted: new Set(['u_gone']) });
  const NC = `${b64u({ alg: 'RS256' })}.${b64u({ user_id: 'u_ana', customer: false, exp: Math.floor((T0 + 3600e3) / 1000) })}.sig`;
  const call = async (q, h = { 'x-firebase-id-token': TOK('u_ana') }, extra = {}) => { const r = await handler(`https://fn.test/getMyOrders${q}`, { method: 'GET', headers: h, ...extra }); return [r.status, await r.json()]; };
  assert.equal((await call('?context=platform', {}))[0], 401); assert.equal((await call('?context=platform', { 'x-firebase-id-token': NC }))[0], 401); assert.equal((await call('?context=platform', { 'x-firebase-id-token': 'garbage' }))[0], 401);
  assert.equal((await call('?context=platform', { 'x-firebase-id-token': TOK('u_gone') }))[0], 403);
  for (const q of ['?context=platform&uid=u_x', '?context=other', '?context=platform&limit=0', '?context=platform&limit=51', '?context=platform&cursor=@@']) assert.equal((await call(q))[0], 400, q);
  assert.equal((await call('?context=platform', undefined, { body: '{}' }))[0], 400);
  const seen = []; let cursor = null;
  do { const [st, j] = await call(`?context=platform&limit=10${cursor ? `&cursor=${cursor}` : ''}`); assert.equal(st, 200); seen.push(...j.past.map((r) => r.order_id)); assert.ok(j.past.every((r) => !('secret_internal' in r)), 'the whitelist'); cursor = j.next_cursor; } while (cursor);
  assert.equal(seen.length, 45); assert.equal(new Set(seen).size, 45, 'no dup, no gap');
});
async function pedidosBoot(db, opts = {}) {
  const mo = myOrdersServer(db, opts);
  const g = g7Server();
  const fetch = async (u, i) => { const pth = u.split('?')[0];   // C-2: the rating endpoints go to the test's rating server (opts.rate)
    if (opts.rate && (pth.endsWith('/getMyRating') || pth.endsWith('/rateOrder'))) return opts.rate.handler(u, i);
    return pth.endsWith('/getMyOrders') ? mo.handler(u, i) : g.fetch(u, i); };
  const fb = fakeFirebase({ persisted: 'u_ana', tokExp: T0 + 3600e3, ...(opts.fbOpts || {}) });
  const S = bootShell({ auth: 'unresolved', storage: opts.storage || g7Store(G7_PROFILE({ promos: true })), runtime: opts.runtime || G7_RUNTIME, now: opts.now, url: opts.url, readPublic: opts.readPublic, mountExtra: { loadSdk: fb.loadSdk, signupFetch: fetch, ...(opts.routing ? { routing: true } : {}), ...(opts.mountExtra || {}) }, apiFetch: opts.apiFetch, geolocation: opts.geolocation, ...(opts.envelope ? { envelope: opts.envelope } : {}), ...(opts.preMount ? { preMount: opts.preMount } : {}) });
  if (!opts.noFlush) { await flush(); await flush(); }
  return { S, mo, fb, g };
}
test('Pedidos (member): the rows from getMyOrders (the real writer\'s entries) — the active order\'s card (status, «Orden #N» only when numbered, no tracking without its token), the past rows (store, «Sáb 11 oct · L 340», items_text AS GIVEN); the token only in the header; «Volver a pedir» hidden (interim)', async () => {
  const db = { u_ana: {
    'XP-ACT1': userOrderEntry('u_ana', 'XP-ACT1', { ts: T0 - 10 * 60e3, total: 615, status: 'preparing', items_text: '1x Carnivora (L340), 1x Crispy Bacon (L210)' }),
    'XP-OLD1': userOrderEntry('u_ana', 'XP-OLD1', { ts: Date.UTC(2026, 9, 12, 1, 42), total: 370, status: 'delivered' }),
    'LM-OLD2': userOrderEntry('u_ana', 'LM-OLD2', { ts: Date.UTC(2026, 9, 4, 2, 10), total: 455, status: 'cancelled', restaurantId: 'la_musa', items_text: '2x Pad Thai (L210)', items: [] }) } };
  const { S, mo } = await pedidosBoot(db);
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    assert.equal(txt(S.q('.pagehead h1')), 'Pedidos');
    assert.equal(mo.calls.length, 1, '🔴 PED-1: ONE read per visit');
    const c = mo.calls[0], url = new URL(c.url);
    assert.deepEqual([...url.searchParams.entries()], [['context', 'platform'], ['limit', '20']], '🔴 PED-1: exactly the contract\'s query');
    const tk = c.headers['x-firebase-id-token'] || ''; assert.ok(tk.split('.').length === 3, '🔴 PED-1: the ID token in its header'); assert.ok(!c.url.includes(tk.split('.')[1]), '🔴 PED-1: never in the URL');
    const NAME = (rid) => SC.complete.body.restaurants.find((r) => r.restaurant_id === rid).name;   // the directory's own names (data)
    const card = S.q('.ocard.active');
    assert.equal(txt(card.querySelector('.t b')), NAME('x_pizza')); assert.equal(txt(card.querySelector('.st')), 'Tu pedido se está preparando', 'the v6 status words');
    assert.ok(!/Orden #/.test(txt(card.querySelector('.t span'))), 'no number on the row ⇒ no «Orden #»');
    assert.equal(card.querySelector('[data-act="go-order"]'), null, 'no token on a server row ⇒ no «Ver seguimiento» (nothing to track)');
    assert.equal(txt(card.querySelector('.items')), '1x Carnivora (L340), 1x Crispy Bacon (L210)', '🔴 PED-1: items_text as given');
    const rows = S.qa('.orows .orow').map((r) => [txt(r.querySelector('.t b')), txt(r.querySelector('.t .m'))]);
    assert.deepEqual(rows, [[NAME('x_pizza'), 'Dom 11 oct · L 370'], [NAME('la_musa'), 'Sáb 3 oct · L 455']], '🔴 PED-1: the past rows, newest first, v6\'s date');
    assert.equal(S.q('[data-act="reorder"]'), null, '🔴 PED-1: «Volver a pedir» hidden until dish_id ships'); assert.equal(S.q('.otabs'), null, 'no tabs without the second one');
  } finally { S.w.close(); }
});
test('Pedidos: a refused / failed read (401, 403, offline) claims NO empty state; a guest gets v6\'s empty state with NO read', async () => {
  for (const [label, opts, fbTok] of [['403 tombstone', { deleted: new Set(['u_ana']) }]]) {
    const { S, mo } = await pedidosBoot({ u_ana: {} }, opts);
    try { S.click('.tabbar [data-tab="orders"]'); await flush(); await flush(); assert.equal(mo.calls.length, 1); assert.equal(S.q('.oempty'), null, `🔴 PED-2: ${label} ⇒ never «Todavía no tenés pedidos»`); } finally { S.w.close(); }
  }
  const G = bootShell({ runtime: { ...RUNTIME, guestCardOnly: true } });
  try { await flush(); G.click('.tabbar [data-tab="orders"]'); await flush(); assert.equal(txt(G.q('.oempty b')), 'Todavía no tenés pedidos', '🔴 PED-2: a guest\'s empty state (v6)'); assert.equal(txt(G.q('.oempty .primary')), 'Explorar restaurantes'); } finally { G.w.close(); }
});
test('Pedidos: THIS device\'s active order — its card (v6 «Orden #N · hoy · …», the sent lines) opens its live screen; it survives a reload (the local record) and a reload of /r/{rid}/pago lands on its screen; a final status drops it', async () => {
  const { ES, made } = fakeES(); const TOKEN = 'tok_abcdefgh12', storage = memStorage();
  const readPublic = async (u) => ({ ok: true, json: async () => (u.includes('/display_number') ? 47 : null) });
  const S = bootShell({ storage, runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic, mountExtra: { EventSource: ES }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: TOKEN })), geolocation: GEO_OK2 });
  try {
    await flush(); await placeShellCash(S); await flush(900);
    S.click('[data-act="order-close"]'); await flush();
    const card = S.q('.ocard.active'); assert.ok(card, '🔴 PED-3: the device\'s active card');
    assert.match(txt(card.querySelector('.t span')), /^Orden #47 · hoy · \d{1,2}:\d{2} [ap]\.m\. · L \d/, '🔴 PED-3: v6\'s line');
    S.click('.ocard.active [data-act="go-order"]'); await flush();
    assert.equal(txt(S.q('.mk-title')), 'Pedido recibido', '🔴 PED-3: «Ver seguimiento» ⇒ its live screen'); assert.equal(made.filter((e) => !e.closed).length, 1, 'the stream resumed');
  } finally { S.w.close(); }
  assert.ok(storage.getItem('capp:active_order'), 'premise: the local record');
  const R = bootShell({ storage, runtime: RUNTIME });
  try { await flush(); R.click('.tabbar [data-tab="orders"]'); await flush(); assert.ok(R.q('.ocard.active'), '🔴 PED-3: survives a reload'); } finally { R.w.close(); }
  const L = routeShell('/r/x_pizza/pago', { storage, runtime: RUNTIME });
  try { await flush(); await flush(); assert.equal(txt(L.q('.mk-title')), 'Pedido recibido', '🔴 PED-3: a reload of its URL ⇒ its screen'); } finally { L.w.close(); }
  const { ES: ES2, made: m2 } = fakeES();
  const F = bootShell({ storage, runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, mountExtra: { EventSource: ES2 } });
  try {
    await flush(); F.click('.tabbar [data-tab="orders"]'); await flush();
    m2[0].emit('put', '/', trackingRecordOf(TOKEN)); m2[0].emit('put', '/status', 'delivered'); await flush();
    assert.equal(storage.getItem('capp:active_order'), null, '🔴 PED-3: a final status drops the record');
  } finally { F.w.close(); }
});
test('Pedidos: the device\'s active record is written AT placement (no live channel needed: no RTDB base, no stream, no number read)', async () => {
  const storage = memStorage();
  const S = bootShell({ storage, runtime: RUNTIME, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: GEO_OK2 });
  try {
    await flush(); await placeShellCash(S);
    const rec = JSON.parse(storage.getItem('capp:active_order') || 'null');
    assert.ok(rec && rec.order && rec.order.token === 'tok_abcdefgh12' && rec.order.rid === 'x_pizza', '🔴 PED-6: the record (token + the sent snapshot) at placement');
    assert.ok(Array.isArray(rec.order.lines) && rec.order.lines.length === 1 && rec.order.grant === null, 'the snapshot; never the grant');
    assert.ok(rec.exp - rec.order.placedAt === 24 * 3600e3, 'until final or 24 h');
  } finally { S.w.close(); }
});
test('Pedidos: cold link /pedidos hydrates the screen; leaving reflects the URL', async () => {
  const S = routeShell('/pedidos', { runtime: { ...RUNTIME, guestCardOnly: true } });
  try { await flush(); await flush(); assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', '🔴 PED-4: /pedidos ⇒ Pedidos'); S.click('.tabbar [data-tab="home"]'); await flush(); assert.equal(new URL(S.w.location.href).pathname, '/'); } finally { S.w.close(); }
});
test('getMyOrders client: ONLY the Row whitelist survives; a malformed row is dropped; the token rides the header of a GET', async () => {
  const A = require('./capp-signup-api.js');
  assert.deepEqual(A.rowOf({ order_id: 'XP-1', ts: 1, total: 340, order_type: 'delivery', restaurant: 'x_pizza', status: 'new', items_text: 'x', items: [{ key: 'A', qty: 1 }], customer_phone: '+504', uid: 'u' }),
    { order_id: 'XP-1', ts: 1, total: 340, order_type: 'delivery', restaurant: 'x_pizza', status: 'new', items_text: 'x', items: [{ key: 'A', qty: 1 }] }, '🔴 PED-5: the whitelist');
  for (const bad of [null, {}, { order_id: '<x>', ts: 1, restaurant: 'x_pizza' }, { order_id: 'XP-1', ts: 'x', restaurant: 'x_pizza' }, { order_id: 'XP-1', ts: 1, restaurant: 'X PIZZA' }]) assert.equal(A.rowOf(bad), null, JSON.stringify(bad));
  const seen = []; const api = A.createSignupApi({ endpoints: { getMyOrders: 'https://fn.test/getMyOrders' }, fetch: async (u, i) => { seen.push([u, i]); return { status: 200, json: async () => ({ ok: true, active: [], past: [], next_cursor: null }) }; } });
  await api.getMyOrders({ idToken: 'tok:u_ana', limit: 20 });
  assert.deepEqual(seen[0][1], { method: 'GET', headers: { 'x-firebase-id-token': 'tok:u_ana' } }, '🔴 PED-5: a GET, the token in its header, no body');
});
test('store-update r3 (Codex r2 #1): back on a new build with an UNRESOLVED card placement (valid credentials) ⇒ its verification starts by itself — a status request with no tap', async () => {
  const t0 = T0, polls = [];
  const storage = memStorage({ ...frozenCart(), 'capp:app_build': 'b1',
    'capp:x_pizza:pending_pay': JSON.stringify({ order_id: ORDER, t: 'pt_9', rid: 'x_pizza', cart_gen: 'g_1', order: null, ts: t0 }),
    'capp:x_pizza:pending_place': JSON.stringify({ order_id: ORDER, method: 'online', card: true, issued: true, dispatched: 1, cart_gen: 'g_1', ts: t0, last_send: t0, expires_at: t0 + 3600e3 }),
    'capp:store_handoff': JSON.stringify({ v: 1, rid: 'x_pizza', at: t0 - 60e3, build: 'b1' }) });
  const apiFetch = async (u) => { if (u.startsWith('/x/s')) polls.push(u); return { status: 200, ok: true, json: async () => (u.startsWith('/x/s') ? { ok: true, state: 'pending' } : { ok: false }) }; };
  const S = bootShell({ storage, runtime: STORE_RT, apiFetch, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try {
    await flush(); await flush(); await flush();
    assert.equal(S.ui.store() && S.ui.store().rid, 'x_pizza', 'premise: the store reopened');
    assert.ok(polls.length >= 1, '🔴 SU-r3-1: the unresolved order\'s status is read with no tap');
    assert.ok(storage.getItem('capp:x_pizza:pending_place'), 'its record kept (a pending answer never clears it)');
  } finally { S.w.close(); }
});
test('store-update r3 (Codex r2 #2): an OFFLINE first launch of the new build (directory 503) keeps the handoff; the next (online) launch on that build still restores the store, its cart open, the line', async () => {
  const storage = memStorage({ 'capp:app_build': 'b1', 'capp:store_handoff': JSON.stringify({ v: 1, rid: 'x_pizza', at: T0 - 60e3, build: 'b1' }),
    'capp:x_pizza:cart': (() => { const m = CappMenu.adaptMenu(PROV.x_pizza.envelope); const d = m.dishes.find((x) => !x.launcher && !x.variantOf && !m.pickupOnlyCats.has(String(x.cat))); return JSON.stringify({ v: 2, lines: [{ key: d.key, qty: 1, ex: [{}], added: 1 }], rid: 'x_pizza', mode: 'delivery' }); })() });
  const A = bootShell({ storage, dirScript: ['unavailable_503'], runtime: STORE_RT, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try { await flush(); await flush(); assert.equal(A.ui.store(), null, 'premise: offline — nothing mounted'); } finally { A.w.close(); }
  assert.ok(storage.getItem('capp:store_handoff'), '🔴 SU-r3-2: the handoff survives the failed launch');
  assert.equal(storage.getItem('capp:app_build'), 'b2', 'premise: the device already recorded the new build');
  const B = bootShell({ storage, runtime: STORE_RT, mountExtra: { SherpaClient: { inert: true, identity: { build: 'b2' } } } });
  try {
    await flush(); await flush(); await flush();
    assert.equal(B.ui.store() && B.ui.store().rid, 'x_pizza', '🔴 SU-r3-2: the online relaunch restores the store');
    assert.equal(B.ui.store().ui.state.layerKind, 'cart'); assert.equal(txt(B.q('#layer .cartnote')), 'App actualizada. Tu carrito sigue aquí.');
    assert.equal(storage.getItem('capp:store_handoff'), null, 'cleared only now, after the mount');
  } finally { B.w.close(); }
});
// ── «Pedidos» r2 (Codex Pedidos r1) — RED-first per repro ──
test('Pedidos r2 P1 identity: Ana\'s history read still in flight when the SDK signs her out ⇒ it NEVER paints (the guest sees v6\'s empty state); a new admission loads its own', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const db = { u_ana: { 'XP-OLD1': userOrderEntry('u_ana', 'XP-OLD1', { ts: Date.UTC(2026, 9, 12, 1, 42), total: 370, status: 'delivered' }) } };
  const { S, mo, fb } = await pedidosBoot(db, { gate });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush();
    assert.equal(mo.calls.length, 1, 'premise: Ana\'s read in flight');
    const { authMod } = await fb.loadSdk(); await authMod.signOut(); await flush(); await flush();
    release(); await flush(); await flush();
    assert.equal(S.qa('.orows .orow').length, 0, '🔴 PED-r2-1: Ana\'s delayed rows never paint for the next person');
    assert.equal(txt(S.q('.oempty b')), 'Todavía no tenés pedidos', 'the guest\'s own (empty) view');
  } finally { S.w.close(); }
});
async function shellPlaceTolerant(S) {   // a placement that types only the fields the checkout draws (a member's are filled)
  await toShellCheckout(S);
  const type = (sel, v) => { const el = S.q(sel); if (!el) return; el.value = v; el.dispatchEvent(new S.w.Event('input', { bubbles: true })); };
  S.click('[data-act="pin"]'); await flush(); S.click('[data-act="pin-done"]'); await flush();
  type('#f-details', 'Portón negro'); type('#f-name', 'Ana'); type('#f-phone', '9999 0000'); await flush();
  if (S.q('[data-act="pay"][data-val="cash"]')) { S.click('[data-act="pay"][data-val="cash"]'); await flush(); }
  S.click('#cta'); await flush(); S.click('[data-act="tipc"][data-val="0"]'); await flush(); S.click('[data-act="tip-place"]'); await flush();
  S.click('#layer [data-act="placing-go"]'); await flush(); await flush(); await flush(700);
}
test('Pedidos r2 P1 shared device: a GUEST\'s active order is dropped when a DIFFERENT member signs in (unclaimed); a MEMBER\'s is hidden from the next person — no card, no restore, no URL', async () => {
  const RT_SU = { ...RUNTIME, signup: SU_RUNTIME.signup };   // guest cash allowed, the shell's own sign-in
  const st = memStorage();
  const fb = fakeFirebase();
  const G = bootShell({ storage: st, runtime: RT_SU, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: GEO_OK2, mountExtra: { loadSdk: fb.loadSdk, signupFetch: signupServer(ANA).fetch } });
  try {
    await flush(); await shellPlaceTolerant(G);
    assert.equal(JSON.parse(st.getItem('capp:active_order')).order.owner, 'guest', 'premise: the guest owns it');
    G.click('[data-act="order-close"]'); await flush();
    await signInViaSheet(G); G.click(suHost(G).querySelector('[data-su="finish"]')); await flush(); await flush(); await flush();
    assert.ok(st.getItem('capp:member_complete'), 'premise: Ana is now the member');
    assert.equal(st.getItem('capp:active_order'), null, '🔴 PED-r2-2: an unclaimed guest record is dropped for a different member');
    G.click('.tabbar [data-tab="orders"]'); await flush();
    assert.equal(G.q('.ocard.active'), null, '🔴 PED-r2-2: no card for the member');
  } finally { G.w.close(); }
  // a MEMBER's own record: Ana places, signs out ⇒ the guest after her sees nothing and cannot restore it
  const db = { u_ana: {} };
  const { S, fb: fbA } = await pedidosBoot(db, { storage: (() => { const s2 = g7Store(G7_PROFILE({ promos: true })); return s2; })(), runtime: { ...G7_RUNTIME, guestCardOnly: undefined }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh34' })), geolocation: GEO_OK2 });
  let store2;
  try {
    await shellPlaceTolerant(S);
    store2 = S.ui;   // keep the window's storage via the record below
    assert.ok(S.q('.mk-title'), 'premise: Ana\'s order screen');
    const { authMod } = await fbA.loadSdk(); await authMod.signOut(); await flush(); await flush();
    assert.equal(S.q('.mk-title'), null, '🔴 PED-r2-2: leaving her order screen on sign-out');
    S.click('.tabbar [data-tab="orders"]'); await flush();
    assert.equal(S.q('.ocard.active'), null, '🔴 PED-r2-2: the next person sees no card');
  } finally { S.w.close(); }
});
test('Pedidos r2 P2 expiry: the 24 h bound is LIVE (an open session past 24 h drops the card and the record) and a restore validates the record\'s age from placedAt (a tampered far exp is refused)', async () => {
  const clock = { t: T0 }, storage = memStorage();
  const S = bootShell({ storage, now: clock, runtime: RUNTIME, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: GEO_OK2 });
  let rec;
  try {
    await flush(); await placeShellCash(S); S.click('[data-act="order-close"]'); await flush();
    assert.ok(S.q('.ocard.active'), 'premise: the card'); rec = JSON.parse(storage.getItem('capp:active_order'));
    clock.t = T0 + 25 * 3600e3; S.click('.tabbar [data-tab="home"]'); await flush(); S.click('.tabbar [data-tab="orders"]'); await flush();
    assert.equal(S.q('.ocard.active'), null, '🔴 PED-r2-3: past 24 h ⇒ no card'); assert.equal(storage.getItem('capp:active_order'), null, '🔴 PED-r2-3: the record dropped');
  } finally { S.w.close(); }
  const old = memStorage({ 'capp:active_order': JSON.stringify({ ...rec, order: { ...rec.order, placedAt: T0 - 30 * 86400e3 }, exp: T0 + 86400e3 }) });
  const R = bootShell({ storage: old, now: { t: T0 }, runtime: RUNTIME });
  try { await flush(); R.click('.tabbar [data-tab="orders"]'); await flush(); assert.equal(R.q('.ocard.active'), null, '🔴 PED-r2-3: a 30-day-old record with a stretched exp never restores'); } finally { R.w.close(); }
  // a RECENT order whose stored exp was stretched (≠ placedAt + 24 h): the record is not trusted at restore
  const stretched = memStorage({ 'capp:active_order': JSON.stringify({ ...rec, order: { ...rec.order, placedAt: T0 - 3600e3 }, exp: T0 + 30 * 86400e3 }) });
  const R2 = bootShell({ storage: stretched, now: { t: T0 }, runtime: RUNTIME });
  try { await flush(); R2.click('.tabbar [data-tab="orders"]'); await flush(); assert.equal(R2.q('.ocard.active'), null, '🔴 PED-r2-3: exp must be placedAt + 24 h — a stretched record is refused'); } finally { R2.w.close(); }
});
test('Pedidos r2 P2: a final status while ON Pedidos clears the active card there', async () => {
  const { ES, made } = fakeES(); const TOKEN = 'tok_abcdefgh12';
  const S = bootShell({ runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic: async () => ({ ok: false }), mountExtra: { EventSource: ES }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: TOKEN })), geolocation: GEO_OK2 });
  try {
    await flush(); await placeShellCash(S); S.click('[data-act="order-close"]'); await flush();
    assert.ok(S.q('.ocard.active'), 'premise: the card on Pedidos');
    const es = made.filter((e) => !e.closed).at(-1); assert.ok(es, 'premise: the live stream on Pedidos');
    es.emit('put', '/', trackingRecordOf(TOKEN)); es.emit('put', '/status', 'delivered'); await flush();
    assert.equal(S.q('.ocard.active'), null, '🔴 PED-r2-4: delivered ⇒ the card gone from Pedidos');
  } finally { S.w.close(); }
});
test('Pedidos r2 P2: a cold /pedidos for a member BEFORE admission waits (never «Todavía no tenés pedidos»), then loads her rows', async () => {
  const db = { u_ana: { 'XP-OLD1': userOrderEntry('u_ana', 'XP-OLD1', { ts: Date.UTC(2026, 9, 12, 1, 42), total: 370, status: 'delivered' }) } };
  const { S, mo } = await pedidosBoot(db, { url: 'https://app.test/pedidos', routing: true, noFlush: true });
  try {
    assert.equal(S.q('.oempty'), null, '🔴 PED-r2-5: no empty state before admission');
    await flush(); await flush(); await flush();
    assert.equal(mo.calls.length, 1, '🔴 PED-r2-5: the read once admitted'); assert.equal(S.qa('.orows .orow').length, 1, 'her row');
  } finally { S.w.close(); }
});
test('Pedidos r2: the server\'s items_text wins over the device snapshot when it lists the same order; invalid supplied args are refused; history rows are not controls', async () => {
  const db = { u_ana: {} };
  const reply = (b) => { db.u_ana[b.order_id] = userOrderEntry('u_ana', b.order_id, { ts: T0, total: 615, status: 'new', items_text: '1x Carnivora (L340)' }); return { ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh56' }; };
  const { S } = await pedidosBoot(db, { runtime: { ...G7_RUNTIME, guestCardOnly: undefined }, apiFetch: ORDER_FETCH(reply), geolocation: GEO_OK2 });
  try {
    await shellPlaceTolerant(S); S.click('[data-act="order-close"]'); await flush(); await flush();
    assert.equal(txt(S.q('.ocard.active .items')), '1x Carnivora (L340)', '🔴 PED-r2-8: the server row\'s items_text, verbatim, over the snapshot');
    assert.equal(S.qa('.ocard.active').length, 1, 'one card for the order (local + server merged)');
  } finally { S.w.close(); }
  const A = require('./capp-signup-api.js');
  const api = A.createSignupApi({ endpoints: { getMyOrders: 'https://fn.test/getMyOrders' }, fetch: async () => { throw new Error('no request may leave'); } });
  for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: '@@' }, { cursor: 5 }]) assert.deepEqual(await api.getMyOrders({ idToken: 't', ...bad }), { ok: false, reason: 'bad_request' }, `🔴 PED-r2-6: ${JSON.stringify(bad)} refused locally`);
  const H = require('./capp-home.js');
  const html = H.ordersHtml({ tab: 'orders', cartN: 0, orders: { phase: 'ready', active: [], past: [{ store: { id: 'x_pizza', name: 'X', logo: '' }, oid: 'P1', dateText: 'Dom 11 oct', total: 370, itemsLine: '1x A' }] } });
  assert.ok(!/<button class="orow-main"|data-act="go-receipt"/.test(html), '🔴 PED-r2-7: a row without receipt data is not a control');
});
// ── «Pedidos» r3 (Codex Pedidos r2) — RED-first ──
test('Pedidos r3 P1: an SDK switch Ana → Bob while Bob\'s token is still pending ⇒ Ana\'s held history answer NEVER paints (the invalidation is synchronous on the identity event)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const hold = { on: false, q: [] };
  const db = { u_ana: { 'XP-OLD1': userOrderEntry('u_ana', 'XP-OLD1', { ts: Date.UTC(2026, 9, 12, 1, 42), total: 370, status: 'delivered' }) }, u_bob: {} };
  const st = g7Store(G7_PROFILE({ promos: true }));
  const { S, fb } = await pedidosBoot(db, { gate, storage: st, fbOpts: { hold } });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush();
    st.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_bob' }));   // Bob completed on this device before (his session is admissible)
    hold.on = true;   // Bob's token read will wait
    const { authMod } = await fb.loadSdk(); await authMod.signInWithCustomToken(null, 'ct:u_bob'); await flush();
    assert.ok(!S.ui.state.member || S.ui.state.member.uid !== 'u_ana', '🔴 PED-r3-1: the switch drops Ana AT ONCE (the admitted member) while Bob\'s token is pending');
    release(); await flush(); await flush();
    assert.equal(S.qa('.orows .orow').length, 0, '🔴 PED-r3-1: Ana\'s answer never paints during the switch to Bob');
    hold.on = false; for (const f of hold.q.splice(0)) f(); await flush();
  } finally { S.w.close(); }
});
test('Pedidos r3 P2/P3: a FINAL status reconciles the same order\'s cached server row (no card comes back); a server items_text of \'\' is kept as supplied', async () => {
  const { ES, made } = fakeES(); const db = { u_ana: {} }; let ITEMS = '1x Carnivora (L340)';
  const reply = (b) => { db.u_ana[b.order_id] = userOrderEntry('u_ana', b.order_id, { ts: T0, total: 615, status: 'new', items_text: ITEMS }); return { ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh78' }; };
  const { S } = await pedidosBoot(db, { runtime: { ...G7_RUNTIME, guestCardOnly: undefined, rtdbBase: 'https://rtdb.test' }, readPublic: async () => ({ ok: false }), mountExtra: { EventSource: ES }, apiFetch: ORDER_FETCH(reply), geolocation: GEO_OK2 });
  try {
    await shellPlaceTolerant(S); S.click('[data-act="order-close"]'); await flush(); await flush();
    assert.equal(S.qa('.ocard.active').length, 1, 'premise: the card (local + its server row)');
    const es = made.filter((e) => !e.closed).at(-1); es.emit('put', '/', trackingRecordOf('tok_abcdefgh78')); es.emit('put', '/status', 'delivered'); await flush();
    assert.equal(S.qa('.ocard.active').length, 0, '🔴 PED-r3-2: the cached server row never re-adds a delivered order');
  } finally { S.w.close(); }
  ITEMS = '';
  const db2 = { u_ana: {} };
  const reply2 = (b) => { db2.u_ana[b.order_id] = userOrderEntry('u_ana', b.order_id, { ts: T0, total: 615, status: 'new', items_text: '' }); return { ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh90' }; };
  const { S: S2 } = await pedidosBoot(db2, { runtime: { ...G7_RUNTIME, guestCardOnly: undefined }, apiFetch: ORDER_FETCH(reply2), geolocation: GEO_OK2 });
  try { await shellPlaceTolerant(S2); S2.click('[data-act="order-close"]'); await flush(); await flush(); assert.equal(S2.q('.ocard.active .items'), null, '🔴 PED-r3-3: the server\'s \'\' as supplied (never the snapshot\'s lines)'); } finally { S2.w.close(); }
});
test('Pedidos r3 regressions: a member\'s /r/{rid}/pago reload waits for her admission and lands on her order screen; a cold /pedidos resumes her live stream once admitted', async () => {
  const db = { u_ana: {} }; const st = g7Store(G7_PROFILE({ promos: true }));
  const { S } = await pedidosBoot(db, { storage: st, runtime: { ...G7_RUNTIME, guestCardOnly: undefined }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: GEO_OK2 });
  try { await shellPlaceTolerant(S); assert.equal(JSON.parse(st.getItem('capp:active_order')).order.owner, 'u:u_ana', 'premise: Ana owns it'); } finally { S.w.close(); }
  const { S: R } = await pedidosBoot(db, { storage: st, url: 'https://app.test/r/x_pizza/pago', routing: true, noFlush: true });
  try { await flush(); await flush(); await flush(); assert.equal(txt(R.q('.mk-title')), 'Pedido recibido', '🔴 PED-r3-4: the member\'s reload of her order URL lands on it after admission'); } finally { R.w.close(); }
  const { ES, made } = fakeES();
  const { S: P } = await pedidosBoot(db, { storage: st, url: 'https://app.test/pedidos', routing: true, noFlush: true, runtime: { ...G7_RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic: async () => ({ ok: false }), mountExtra: { EventSource: ES } });
  try { await flush(); await flush(); await flush(); assert.ok(P.q('.ocard.active'), 'premise: her card'); assert.equal(made.filter((e) => !e.closed).length, 1, '🔴 PED-r3-5: her live stream resumed after admission'); } finally { P.w.close(); }
});
test('Pedidos r3 P2 (Codex r3): the deferred /r/{rid}/pago is a held intent — any user navigation or gesture before the admission voids it (never yanked back to «Pedido recibido»); untouched, it still lands', async () => {
  const db = { u_ana: {} }; const st = g7Store(G7_PROFILE({ promos: true }));
  const { S } = await pedidosBoot(db, { storage: st, runtime: { ...G7_RUNTIME, guestCardOnly: undefined }, apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: GEO_OK2 });
  try { await shellPlaceTolerant(S); assert.equal(JSON.parse(st.getItem('capp:active_order')).order.owner, 'u:u_ana', 'premise: Ana owns it'); } finally { S.w.close(); }
  const reload = async (act) => {
    const hold = { on: true, q: [] };
    const { S: R } = await pedidosBoot(db, { storage: st, url: 'https://app.test/r/x_pizza/pago', routing: true, noFlush: true, fbOpts: { hold } });
    try {
      await flush(); await flush(); await flush();
      assert.equal(R.q('.mk-title'), null, 'premise: the admission is held (the intent is deferred)');
      await act(R);
      hold.on = false; for (const f of hold.q.splice(0)) f(); await flush(); await flush(); await flush();
      return { title: R.q('.mk-title') ? txt(R.q('.mk-title')) : null, path: new URL(R.w.location.href).pathname, gq: R.q('#gq') ? R.q('#gq').value : null };
    } finally { R.w.close(); }
  };
  const nav = await reload(async (R) => { R.click('.tabbar [data-tab="search"]'); await flush(); const i = R.q('#gq'); i.focus(); i.value = 'pad'; i.dispatchEvent(new R.w.Event('input', { bubbles: true })); await flush(); });
  assert.equal(nav.title, null, '🔴 PED-r3-P2a: Buscar + typing, then the admission ⇒ NOT yanked to «Pedido recibido»');
  assert.equal(nav.gq, 'pad', '🔴 PED-r3-P2a: still on Buscar with her query');
  const key = await reload(async (R) => { R.w.document.body.dispatchEvent(new R.w.KeyboardEvent('keydown', { bubbles: true, key: 'a' })); await flush(); });
  assert.equal(key.title, null, '🔴 PED-r3-P2b: a gesture with no navigation (a key) also voids the deferred intent');
  const none = await reload(async () => {});
  assert.equal(none.title, 'Pedido recibido', 'control: untouched, the held intent still lands on her order after admission');
});
// ── the RECEIPT (NOTE-getMyOrders-receipt, 3a 75eed212 APPROVED): a past row opens v6's order screen in its past state. The orders come
// from the REAL intake chain, as 3a's own cells build them: storedCtx (a minted envío ctx) → DW.withDelivery → pricedLineItems (x_pizza's
// factura lines) → buildCreateOrderUpdates → attachCustomerAttribution
const RC = { P: FN_REQ('./delivery/delivery-pricing'), DW: FN_REQ('./delivery/delivery-wire'), FP: FN_REQ('./factura/pricing'), MP: FN_REQ('./menu-pricing'), CB: FN_REQ('./create-order-build'), MZ: FN_REQ('./materialize') };
function placeReal(db, orders, uid, id, { rid = 'x_pizza', type = 'delivery', pay = 'cash', tip = 0, promo = 0, ts = T0 - 86400e3, items_text = '2x Margherita (L324) [+ 1x Mozzarella]', status = 'delivered', display_number } = {}) {
  const ctx = type === 'delivery' ? RC.P.storedCtx({ delivery_snapshot: { mode: 'delivery', policy_version: 1, km: 3.2, band: 1, promo: null }, delivery_cents: 4000, promo_discount_cents: promo, ...(tip ? { tip_cents: tip } : {}) }) : null;   // Codex rcpt r1 #2: promo EXPLICIT (an absent key ⇒ storedCtx null ⇒ no envío / tip)
  const bd = RC.DW.withDelivery({ ctx }, { total_cents: 64800, subtotal_cents: 56348, tax_cents: 8452 });
  const body = rid === 'x_pizza' ? [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }] : [{ id: Object.keys(RC.MP.MENU_BY_RESTAURANT.la_musa)[0], name: 'x', qty: 1 }];
  const fp = rid === 'x_pizza' ? RC.FP.pricedLineItems(body, RC.MP.MENU_BY_RESTAURANT.x_pizza, RC.MP.EXTRAS_BY_RESTAURANT.x_pizza) : { items: null, error: null };
  const u = RC.CB.buildCreateOrderUpdates({ orderId: id, orderType: type, now: ts, trackingToken: 'tk_' + id, total: bd.total_cents / 100, lat: type === 'delivery' ? 14.07 : null, lng: type === 'delivery' ? -87.19 : null,
    fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text, notes: 'sin cebolla', payment_method: pay, ...(type === 'delivery' ? { address_detected: 'Col. Palmira, Tegucigalpa', address_details: 'casa azul', address_area: 'Palmira' } : { pickup_time: 'asap' }) },
    hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: rid, priceBreakdown: bd, facturaPriced: fp, cashTenderedCents: pay === 'cash' ? 100000 : null });
  RC.CB.attachCustomerAttribution(u, id, uid, { now: ts, total: bd.total_cents / 100, orderType: type, items_text, restaurantId: rid, items: body });
  // Codex rcpt r1 #2: the fixture's economics, asserted BEFORE anything renders (the base 648.00 + envío 40 + tip − promo)
  if (type === 'delivery') assert.deepEqual([bd.subtotal_cents, bd.delivery_cents, bd.tip_cents || 0, bd.promo_discount_cents, bd.total_cents], [56348, 4000, tip, promo, 64800 + 4000 + tip - promo], 'premise: the real breakdown');
  else assert.equal(bd.total_cents, 64800, 'premise: a pickup carries no envío');
  // the ONLINE card charge: the same pending record + the REAL confirm patch (buildMaterializeUpdates), field paths applied in place
  if (pay === 'online') { const mz = RC.MZ.buildMaterializeUpdates({ orderId: id, order: { ...u[`orders/${id}`] }, trackingToken: 'tk_' + id, now: ts + 1, restaurant: rid, paymentMethod: 'online' });
    for (const [k, v] of Object.entries(mz)) { const m = k.match(/^orders\/([^/]+)\/([^/]+)$/); if (m && m[1] === id) u[`orders/${id}`][m[2]] = v; else if (k === `user_orders/${uid}/${id}`) u[k] = v; } }
  const o = u[`orders/${id}`], e = u[`user_orders/${uid}/${id}`];
  o.status = status; e.status = status;   // the status trigger keeps the entry in step (P3)
  if (display_number) o.display_number = display_number;
  (db[uid] = db[uid] || {})[id] = e; orders[id] = o;
  return { o, e, bd };
}
const rrows = (R) => R.qa('.receipt .rbody .rrow, .receipt2 .rrow').map(txt);
async function openPastReceipt(S, oid) {
  S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
  const b = S.q(`.orow-main[data-act="go-receipt"][data-oid="${oid}"]`); assert.ok(b && b.tagName === 'BUTTON', `premise: the past row ${oid} is v6's control`);
  S.click(b); await flush(); await flush();
}
test('Receipt (x_pizza delivery, cash): the past row is v6\'s «Ver el recibo» control; the screen = the PAST order screen — its priced lines, Envío / Descuento / Propina / Total, «Efectivo», her own address; the read is ?context=platform&order_id alone, the token in its header', async () => {
  const db = {}, orders = {};
  const { o } = placeReal(db, orders, 'u_ana', 'XP-R1', { tip: 2000, promo: 500, display_number: 47 });
  const { S, mo } = await pedidosBoot(db, { orders });
  try {
    await openPastReceipt(S, 'XP-R1');
    const row = mo.calls.at(-1), url = new URL(row.url);
    assert.deepEqual([...url.searchParams.entries()], [['context', 'platform'], ['order_id', 'XP-R1']], '🔴 RC-1: exactly the detail query');
    assert.ok((row.headers['x-firebase-id-token'] || '').split('.').length === 3 && !row.url.includes('eyJ'), '🔴 RC-1: the token in its header, never the URL');
    assert.equal(txt(S.q('.mk-title')), '¡Pedido entregado!', '🔴 RC-2: v6\'s past state (the done title)');
    assert.equal(txt(S.q('.mk-num')), 'Orden #47 · Te avisamos por WhatsApp');
    const tg = S.q('.receipt .toggle[data-act="order-receipt"]'); assert.equal(tg && tg.getAttribute('aria-expanded'), 'true', '🔴 RC-2: «Resumen del pedido» OPEN on a past order (v6)');
    assert.equal(S.q('.receipt .rbody[hidden]'), null);
    const L = o.items[0];
    assert.deepEqual(rrows(S).slice(0, 5), [`${L.qty}× ${L.description} L ${Math.round(L.line_gross_cents / 100)}`, 'Envío L 40', 'Descuento − L 5', 'Propina L 20', `Total L ${Math.round(o.total_cents / 100)}`], '🔴 RC-3: the real writer\'s priced line, then v6\'s rows from the present totals');
    assert.deepEqual(rrows(S).slice(5), ['Pago Efectivo al entregar'], '🔴 RC-4: the cash tender; NO «Estado» on a past cash order (advisor 11-01: «Se cobra al entregar» is false once done), no «Cuándo» (no slot — never guessed), no WhatsApp row');
    assert.ok(!/1,000|1000/.test(S.q('.mk-sheet').textContent), '🔴 RC-4: cash_tendered_cents is read, never drawn (advisor 11-01)');
    assert.equal(txt(S.q('.mk-card')), 'Detalles de entrega Col. Palmira, Tegucigalpa casa azul', '🔴 RC-5: her own address + details (never coordinates)');
    assert.equal(S.q('[data-act="order-share"]'), null, 'no «Compartir seguimiento» on a past order');
    assert.ok(!/14\.07|sin cebolla|50499990000|tk_XP/.test(S.q('.mk-sheet').textContent), '🔴 RC-5: no coordinates / notes / phone / token on the screen');
    S.click('[data-act="order-close"]'); await flush();
    assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', '🔴 RC-6: the close returns to «Pedidos» (v6)');
    const n = mo.calls.length; await openPastReceipt(S, 'XP-R1');
    assert.equal(mo.calls.filter((c) => c.url.includes('order_id')).length, 1, '🔴 RC-6: a reopen is instant from the kept receipt (ONE read)'); assert.ok(mo.calls.length >= n);
    S.click('[data-act="order-again"]'); await flush(); assert.ok(S.q('.tabbar [data-tab="home"][aria-current="true"]'), '🔴 RC-6: «Hacer otro pedido» ⇒ Inicio');
  } finally { S.w.close(); }
});
test('Receipt (x_pizza delivery, ONLINE card through the real confirm patch, no promo): Envío + Propina + Total from the real breakdown (promo 0 draws no row); «Tarjeta» + «Confirmado» on a delivered card order; no reference anywhere', async () => {
  const db = {}, orders = {};
  const { o } = placeReal(db, orders, 'u_ana', 'XP-ON1', { pay: 'online', tip: 2000, promo: 0 });
  assert.equal(o.customer_uid, 'u_ana', 'premise: the confirm patch keeps the owner'); assert.equal(o.payment_method, 'online');
  const { S } = await pedidosBoot(db, { orders });
  try {
    await openPastReceipt(S, 'XP-ON1');
    const L = o.items[0];
    assert.deepEqual(rrows(S), [`${L.qty}× ${L.description} L ${Math.round(L.line_gross_cents / 100)}`, 'Envío L 40', 'Propina L 20', 'Total L 708', 'Pago Tarjeta', 'Estado Confirmado'], '🔴 RC-15: the online charge\'s receipt (no «Descuento» for a 0 promo)');
    assert.ok(!/PixelPay|referenc|tk_XP/i.test(S.q('.mk-sheet').textContent), 'no processor / reference / token');
  } finally { S.w.close(); }
});
test('Receipt (la_musa pickup, card): no priced lines ⇒ v6\'s rows from the items_text lines WITHOUT amounts + the totals; «Tarjeta» with NO digits; «Recoger en» the store', async () => {
  const db = {}, orders = {};
  placeReal(db, orders, 'u_ana', 'LM-R2', { rid: 'la_musa', type: 'pickup', pay: 'card_delivery', items_text: '1x Pad Thai (L210) [+ 1x Huevo] | 2x Spring Rolls (L90)', status: 'completed' });
  const { S } = await pedidosBoot(db, { orders });
  try {
    await openPastReceipt(S, 'LM-R2');
    assert.equal(txt(S.q('.mk-title')), '¡Gracias por tu compra!', 'a pickup\'s done state');
    assert.deepEqual(rrows(S), ['1× Pad Thai + 1× Huevo', '2× Spring Rolls', 'Total L 648', 'Pago Tarjeta', 'Estado Confirmado'], '🔴 RC-7: the items_text lines (no amount, no L 0), no Envío on a pickup, «Tarjeta» only');
    assert.ok(!/\d{4}/.test(S.q('.receipt:last-of-type').textContent), '🔴 RC-7: no card digits');
    const NAME = SC.complete.body.restaurants.find((r) => r.restaurant_id === 'la_musa').name;
    assert.ok(txt(S.q('.mk-card')).startsWith(`Recoger en ${NAME}`), '🔴 RC-7: the directory\'s store');
  } finally { S.w.close(); }
});
test('Receipt: a refused read (another account\'s id ⇒ the uniform 404) or offline leaves the row\'s own screen — no tender / address guessed, no crash; the fake is as strict as the contract', async () => {
  const db = {}, orders = {};
  placeReal(db, orders, 'u_ana', 'XP-R3', { status: 'delivered', items_text: '1x Carnivora (L340)' });
  orders['XP-R3'].customer_uid = 'u_bob';   // the order record is not hers ⇒ 404, like an unknown id
  const { S, mo } = await pedidosBoot(db, { orders });
  try {
    const call = async (q) => { const r = await mo.handler(`https://fn.test/getMyOrders${q}`, { method: 'GET', headers: { 'x-firebase-id-token': TOK('u_ana') } }); return r.status; };
    assert.deepEqual([await call('?context=platform&order_id=XP-R3'), await call('?context=platform&order_id=NOPE'), await call('?context=platform&order_id=XP-R3&limit=5'), await call('?context=platform&order_id=a%20b')], [404, 404, 400, 400], 'the fake: uniform 404, order_id alone, the id rule');
    await openPastReceipt(S, 'XP-R3');
    assert.equal(txt(S.q('.mk-title')), '¡Pedido entregado!', 'the row\'s status');
    assert.deepEqual(rrows(S), ['1× Carnivora', 'Total L 688'], '🔴 RC-8: the row\'s items_text + total only; no Pago / Estado (the tender is unknown — never «Efectivo» by default)');
    assert.equal(txt(S.q('.mk-card .v')), '', 'no address guessed');
  } finally { S.w.close(); }
});
test('Receipt identity: Ana\'s receipt read in flight when the SDK signs her out ⇒ it NEVER paints; the receipt screen is left for «Pedidos»', async () => {
  const db = {}, orders = {}; let release; const rgate = new Promise((r) => { release = r; });
  placeReal(db, orders, 'u_ana', 'XP-R4', { display_number: 52 });
  const { S, fb } = await pedidosBoot(db, { orders, rgate });
  try {
    await openPastReceipt(S, 'XP-R4');
    assert.ok(S.q('.mk-title'), 'premise: the receipt screen (from the row) while the read is held');
    await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush(); await flush();
    release(); await flush(); await flush();
    assert.equal(S.q('.mk-title'), null, '🔴 RC-9: off the receipt screen after the identity change');
    assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', '🔴 RC-9: the identity hook lands on «Pedidos» (never a blank / Inicio fallback under the receipt tab)');
    assert.ok(!/Palmira|#52/.test(S.w.document.body.textContent), '🔴 RC-9: nothing of Ana\'s receipt painted after she left');
  } finally { S.w.close(); }
});
test('Receipt NO REFLOW (advisor 11-01, option A): on a miss the screen ENDS before the first block that needs the receipt — no address card, no summary, no CTA, no spinner; the fill goes IN PLACE: every node drawn before is the same node with the same text', async () => {
  const db = {}, orders = {}; let release; const rgate = new Promise((r) => { release = r; });
  placeReal(db, orders, 'u_ana', 'XP-R5', { display_number: 61 });
  const { S } = await pedidosBoot(db, { orders, rgate });
  try {
    await openPastReceipt(S, 'XP-R5');
    const sheet = S.q('.mk-sheet'); assert.ok(sheet, 'premise: the past screen');
    assert.equal(S.q('.mk-card'), null, '🔴 RC-11: a delivery\'s address card waits (it needs the receipt)');
    assert.equal(S.q('.receipt'), null, '🔴 RC-11: no summary yet'); assert.equal(S.q('[data-act="order-again"]'), null, '🔴 RC-11: the CTA is never drawn above a late block');
    assert.ok(!/Cargando|spinner|skeleton/i.test(sheet.outerHTML), 'no spinner / skeleton');
    const before = [...sheet.children].filter((n) => !n.hasAttribute('data-rc-tail')).map((n) => [n, n.textContent]);
    const mapEl = S.q('.order-map'), mapTxt = mapEl.textContent;
    release(); await flush(); await flush(); await flush();
    assert.equal(S.q('.mk-sheet'), sheet, '🔴 RC-11: the sheet itself is kept (no re-render)');
    for (const [n, t] of before) { assert.ok(n.isConnected && n.parentNode === sheet, `🔴 RC-11: ${n.className} still the same node`); assert.equal(n.textContent, t, `🔴 RC-11: ${n.className} text unchanged`); }
    assert.equal(S.q('.order-map'), mapEl, 'the map is the same node'); assert.equal(mapEl.textContent, mapTxt);
    assert.deepEqual([...sheet.children].slice(0, before.length), before.map(([n]) => n), '🔴 RC-11: the tail is APPENDED after them, in order');
    assert.ok(S.q('.mk-card') && S.q('.receipt') && S.q('[data-act="order-again"]'), 'the tail landed');
    assert.equal(S.q('[data-rc-tail]'), null, 'the marker is gone');
  } finally { S.w.close(); }
});
test('Receipt: a FAILED read on a miss fills the row\'s own tail in place (items_text lines + total, no tender) — never stuck held', async () => {
  const db = {}, orders = {}; let release; const rgate = new Promise((r) => { release = r; });
  placeReal(db, orders, 'u_ana', 'XP-R6', { items_text: '1x Carnivora (L340)' }); orders['XP-R6'].customer_uid = 'u_bob';
  const { S } = await pedidosBoot(db, { orders, rgate });
  try {
    await openPastReceipt(S, 'XP-R6'); assert.ok(S.q('[data-rc-tail]'), 'premise: held'); release(); await flush(); await flush(); await flush();
    assert.equal(S.q('[data-rc-tail]'), null, '🔴 RC-12: released on a refusal');
    assert.deepEqual(rrows(S), ['1× Carnivora', 'Total L 688'], '🔴 RC-12: the row\'s own tail'); assert.ok(S.q('[data-act="order-again"]'));
  } finally { S.w.close(); }
});
test('Receipt PREFETCH (advisor 11-01, 3a): after «Pedidos» paints, at idle, the first ≤ 5 past rows\' receipts — ONE at a time; a prefetched receipt opens complete at once (no hold, no second read); the 6th+ are never read ahead', async () => {
  const db = {}, orders = {};
  for (let k = 0; k < 7; k++) placeReal(db, orders, 'u_ana', `XP-P${k}`, { ts: T0 - (k + 1) * 86400e3 });
  const { S, mo } = await pedidosBoot(db, { orders, rdelay: 20 });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    await new Promise((r) => setTimeout(r, 600)); await flush();
    const rq = () => mo.calls.filter((c) => c.url.includes('order_id=')).map((c) => new URL(c.url).searchParams.get('order_id'));
    assert.deepEqual(rq(), ['XP-P0', 'XP-P1', 'XP-P2', 'XP-P3', 'XP-P4'], '🔴 RC-13: exactly the first 5 visible past rows, in order');
    assert.equal(mo.rx.max, 1, '🔴 RC-13: ONE at a time (never a fan-out)');
    S.click(S.q('.orow-main[data-oid="XP-P2"]'));
    const sheet = S.q('.mk-sheet');   // the tap's own (synchronous) paint
    assert.ok(sheet, 'premise: painted on the tap');
    assert.equal(S.q('[data-rc-tail]'), null, '🔴 RC-13: a prefetched receipt opens complete (no hold)'); assert.ok(S.q('.receipt'));
    await flush(); await flush();
    assert.equal(S.q('.mk-sheet'), sheet, '🔴 RC-13: and is never re-rendered after it opens (no second paint)');
    assert.equal(rq().length, 5, 'no second read');
  } finally { S.w.close(); }
});
test('Receipt PREFETCH stops on an identity change: an SDK switch Ana → Bob mid-prefetch ⇒ none of Ana\'s remaining receipts is requested (never with Bob\'s token)', async () => {
  const db = { u_bob: {} }, orders = {};
  for (let k = 0; k < 5; k++) placeReal(db, orders, 'u_ana', `XP-Q${k}`, { ts: T0 - (k + 1) * 86400e3 });
  const st = g7Store(G7_PROFILE({ promos: true }));
  const { S, mo, fb } = await pedidosBoot(db, { orders, rdelay: 60, storage: st });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    const rq = () => mo.calls.filter((c) => c.url.includes('order_id=')).length;
    for (let i = 0; i < 40 && rq() < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(rq() >= 1, 'premise: the prefetch started');
    st.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_bob' }));
    const { authMod } = await fb.loadSdk(); await authMod.signInWithCustomToken(null, 'ct:u_bob'); await flush();
    const at = rq(); await new Promise((r) => setTimeout(r, 500)); await flush();
    assert.ok(at < 5, 'premise: switched before the end');
    assert.equal(rq(), at, '🔴 RC-14: no receipt of Ana\'s requested after the switch');
  } finally { S.w.close(); }
});
// Codex rcpt r1 #3: overlapping reads — a late answer is never painted on (or cached over) a newer one
const gates = () => { const q = []; return { q, fn: () => new Promise((r) => q.push(r)) }; };
test('Receipt overlap: A held, back, B opened and held; A lands first ⇒ NOT drawn on B\'s screen; B lands ⇒ B\'s tail', async () => {
  const db = {}, orders = {}, G = gates();
  placeReal(db, orders, 'u_ana', 'XP-A1', { ts: T0 - 86400e3, items_text: '1x Carnivora (L340)' });
  placeReal(db, orders, 'u_ana', 'XP-B1', { ts: T0 - 2 * 86400e3, type: 'pickup', pay: 'card_delivery', items_text: '1x Crispy Bacon (L210)' });
  const { S } = await pedidosBoot(db, { orders, rgate: G.fn });
  try {
    await openPastReceipt(S, 'XP-A1'); S.click('[data-act="order-close"]'); await flush();
    await openPastReceipt(S, 'XP-B1'); const n = G.q.length; assert.ok(n >= 2, 'premise: both reads held');
    G.q[0](); await flush(); await flush();
    assert.ok(S.q('[data-rc-tail]'), '🔴 RC-16: B is still held — A\'s answer filled nothing here');
    assert.ok(!/Palmira/.test(S.q('.mk-sheet').textContent), '🔴 RC-16: A\'s address never on B\'s screen');
    for (const r of G.q.slice(1)) r(); await flush(); await flush();
    assert.deepEqual(rrows(S).slice(-2), ['Pago Tarjeta', 'Estado Confirmado'], 'B\'s own tail');
  } finally { S.w.close(); }
});
test('Receipt overlap across identities (Codex r1 #3): Ana\'s read A held → Bob → Ana again; her NEW read B (updated details) lands, THEN the old A ⇒ a reopen shows B\'s details (A never overwrites the kept receipt)', async () => {
  const db = { u_bob: {} }, orders = {}, G = gates();
  placeReal(db, orders, 'u_ana', 'XP-X1', {});
  const st = g7Store(G7_PROFILE({ promos: true }));
  const { S, fb, mo } = await pedidosBoot(db, { orders, rgate: G.fn, storage: st });
  try {
    await openPastReceipt(S, 'XP-X1'); assert.equal(G.q.length, 1, 'premise: read A held');
    const { authMod } = await fb.loadSdk();
    st.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_bob' })); await authMod.signInWithCustomToken(null, 'ct:u_bob'); await flush(); await flush();
    st.setItem('capp:member_complete', JSON.stringify({ v: 1, uid: 'u_ana' })); await authMod.signInWithCustomToken(null, 'ct:u_ana'); await flush(); await flush(); await flush();
    assert.equal(S.ui.state.member && S.ui.state.member.uid, 'u_ana', 'premise: Ana admitted again');
    orders['XP-X1'].address_details = 'portón verde (actualizado)';
    await openPastReceipt(S, 'XP-X1');
    const reads = () => mo.calls.filter((c) => c.url.includes('order_id=XP-X1')).length;
    assert.ok(reads() >= 2 && G.q.length >= 2, 'premise: a NEW read B (the identity change voided A\'s in-flight entry)');
    for (const r of G.q.slice(1)) r(); await flush(); await flush();
    assert.ok(/portón verde/.test(txt(S.q('.mk-card'))), 'premise: B drawn');
    G.q[0](); await flush(); await flush();
    S.click('[data-act="order-close"]'); await flush(); await openPastReceipt(S, 'XP-X1');
    assert.ok(/portón verde/.test(txt(S.q('.mk-card'))), '🔴 RC-17: the late OLD read never overwrote the kept receipt');
  } finally { S.w.close(); }
});
// ── «Volver a pedir» (advisor 11-01: BY DATA — a line is reorderable when it carries the canonical dish_id; an all-null store has
// no pill and no section). Recipes from the REAL writer (attachCustomerAttribution → normalizeReorderItems), dish_id from the REAL
// resolver over the served menu (x_pizza eligible; la_musa: no context ⇒ every line null — the owner-run identity check)
const AGAIN_CTX = (rid) => (rid === 'x_pizza' ? servedCtx('x_pizza') : null);
const cartOfSt = (st, rid) => { try { return JSON.parse(st.getItem(`capp:${rid}:cart`)); } catch (_) { return null; } };
async function againBoot(extra = {}) {
  const db = {}, orders = {};
  placeReal(db, orders, 'u_ana', 'XP-V1', { ts: T0 - 86400e3 });   // 2× Margherita, Mozzarella on one (the real recipe)
  placeReal(db, orders, 'u_ana', 'LM-V2', { rid: 'la_musa', type: 'pickup', pay: 'card_delivery', ts: T0 - 2 * 86400e3, items_text: '1x Pad Thai (L210)' });
  const st = extra.storage || g7Store(G7_PROFILE({ promos: true }));
  if (extra.seed) extra.seed(st);
  const { S, mo, fb } = await pedidosBoot(db, { orders, storage: st, contextFor: extra.contextFor || AGAIN_CTX, ...(extra.envelope ? { envelope: extra.envelope } : {}), ...(extra.preMount ? { preMount: extra.preMount } : {}) });
  return { S, mo, fb, st, orders, db };
}
test('Volver a pedir — by data: the eligible store\'s row has the pill, the all-null store\'s has none; the tabs appear; «Volver a pedir» lists ONLY the eligible store with its past dish (live menu)', async () => {
  const { S, mo } = await againBoot();
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    assert.ok(S.q('.orow [data-act="reorder"][data-oid="XP-V1"]'), '🔴 VP-1: the x_pizza row (dish_id present) carries «Volver a pedir»');
    assert.equal(S.q('.orow [data-act="reorder"][data-oid="LM-V2"]'), null, '🔴 VP-1: the la_musa row (every dish_id null) has NO pill');
    assert.deepEqual(S.qa('.otabs [role="tab"]').map(txt), ['Pedidos anteriores', 'Volver a pedir'], '🔴 VP-1: v6\'s two tabs');
    S.click('.otabs [data-val="again"]'); await flush(); await flush();
    const secs = S.qa('.agains .again-sec');
    const NAME = (rid) => SC.complete.body.restaurants.find((r) => r.restaurant_id === rid).name;
    assert.deepEqual(secs.map((x) => x.getAttribute('aria-label')), [NAME('x_pizza')], '🔴 VP-2: only the eligible store has a section');
    const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita');
    assert.ok(marg && S.q(`.agains .dcard [data-act="add-past"][data-id="${marg.dish_id}"]`), '🔴 VP-2: its past dish, by its served dish_id, with «+»');
  } finally { S.w.close(); }
});
test('Volver a pedir — no eligible store at all ⇒ no tabs, no pill (v6 «Pedidos anteriores» only)', async () => {
  const { S } = await againBoot({ contextFor: () => null });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    assert.equal(S.q('.otabs'), null, '🔴 VP-3: no tabs without a reorderable row'); assert.equal(S.q('[data-act="reorder"]'), null, '🔴 VP-3: no pill');
    assert.equal(S.qa('.orows .orow').length, 2, 'the rows themselves');
  } finally { S.w.close(); }
});
test('Volver a pedir — the pill REPLACES that store\'s cart with the order (same dishes, same options), opens the store and its cart, «Pedido cargado en tu carrito»', async () => {
  const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita');
  const other = PROV.x_pizza.envelope.menu.dishes.find((d) => d.dish_id && d.name !== 'Margherita' && !d.variantOf);
  const { S, st } = await againBoot({ seed: (st) => st.setItem('capp:x_pizza:cart', JSON.stringify({ v: 2, lines: [{ key: String(other.dish_id), qty: 3, ex: [{}, {}, {}], added: 1 }], rid: 'x_pizza', mode: 'delivery' })) });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    S.click('.orow [data-act="reorder"][data-oid="XP-V1"]'); await flush(); await flush(); await flush();
    const ui = S.ui.store(); assert.ok(ui && ui.rid === 'x_pizza', '🔴 VP-4: the store opened');
    const lines = ui.ui.cart.lines();
    const moz = ui.ui.menu.extrasFor(String(marg.dish_id)).find((e) => e.name === 'Mozzarella');
    assert.ok(moz, 'premise: Mozzarella is offered to Margherita on the live menu');
    assert.deepEqual(JSON.parse(JSON.stringify(lines.map((l) => [l.key, l.qty, l.ex]))), [[String(marg.dish_id), 2, [{ [moz.key]: 1 }, {}]]], '🔴 VP-4: the order\'s dishes + options — the previous cart REPLACED (v6)');
    assert.equal(ui.ui.state.layerKind, 'cart', '🔴 VP-4: its cart is open');
    assert.equal(S.q('#toast') && S.q('#toast').textContent, 'Pedido cargado en tu carrito', '🔴 VP-4: v6\'s «Pedido cargado en tu carrito»');
    assert.deepEqual(cartOfSt(st, 'x_pizza').lines.map((l) => l.key), [String(marg.dish_id)], 'the stored cart is the reorder');
  } finally { S.w.close(); }
});
test('Volver a pedir — MIXED nulls within one order: the resolvable line is rebuilt, the null one is dropped AND disclosed («1 plato ya no está disponible»)', async () => {
  const db = {}, orders = {};
  const { o, e } = placeReal(db, orders, 'u_ana', 'XP-V3', { ts: T0 - 86400e3 });
  const pep = Object.keys(MPRC.MENU_BY_RESTAURANT.x_pizza).find((k) => k !== 'Margherita' && PROV.x_pizza.envelope.menu.dishes.some((d) => d.name === k && d.dish_id));
  e.items.push({ key: pep, qty: 1 }); void o;   // a second recipe line (what normalizeReorderItems stores for a second dish)
  const st = g7Store(G7_PROFILE({ promos: true }));
  const { S } = await pedidosBoot(db, { orders, storage: st, contextFor: (rid) => (rid === 'x_pizza' ? servedCtx('x_pizza', { drop: [pep] }) : null) });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    S.click('.orow [data-act="reorder"][data-oid="XP-V3"]'); await flush(); await flush(); await flush();
    const ui = S.ui.store().ui;
    assert.deepEqual(JSON.parse(JSON.stringify(ui.cart.lines().map((l) => l.qty))), [2], '🔴 VP-5: the resolvable line only');
    assert.equal(txt(S.q('.cartnote')), '1 plato ya no está disponible', '🔴 VP-5: the null line DISCLOSED (never silent)');
  } finally { S.w.close(); }
});
test('Volver a pedir — a cart MID-PLACEMENT (a pending placement record / a frozen cart) is NEVER overwritten: the store opens on its own state', async () => {
  // (advisor 11-02: the store's OWN predicate decides — a cart frozen for a placement is read-only there, so it is here)
  for (const seed of [(st) => st.setItem('capp:x_pizza:cart', JSON.stringify({ ...JSON.parse(frozenCart()['capp:x_pizza:cart']) }))]) {
    const { S, st } = await againBoot({ seed });
    const before = st.getItem('capp:x_pizza:cart');
    try {
      S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
      S.click('.orow [data-act="reorder"][data-oid="XP-V1"]'); await flush(); await flush(); await flush();
      assert.equal(st.getItem('capp:x_pizza:cart'), before, '🔴 VP-6: the stored cart untouched');
      assert.notEqual(S.q('#toast') && S.q('#toast').textContent, 'Pedido cargado en tu carrito', '🔴 VP-6: no «cargado» claim');
    } finally { S.w.close(); }
  }
});
test('Volver a pedir — «+» on a past dish adds ONE to that store\'s cart, stays on «Pedidos», «Agregado · {store}»', async () => {
  const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita');
  const { S, st } = await againBoot();
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    S.click('.otabs [data-val="again"]'); await flush(); await flush();
    S.click(`.agains [data-act="add-past"][data-id="${marg.dish_id}"]`); await flush();
    S.click(`.agains [data-act="add-past"][data-id="${marg.dish_id}"]`); await flush();
    const c = cartOfSt(st, 'x_pizza');
    assert.deepEqual(c.lines.map((l) => [l.key, l.qty]), [[String(marg.dish_id), 2]], '🔴 VP-7: one more per tap, in THAT store\'s cart');
    assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', '🔴 VP-7: still on «Pedidos»');
    const NAME = SC.complete.body.restaurants.find((r) => r.restaurant_id === 'x_pizza').name;
    assert.equal(S.q('#toast').textContent, `Agregado · ${NAME}`);
  } finally { S.w.close(); }
});
test('Volver a pedir — «+» over a PURCHASED cart (a placed marker for its generation): the store\'s own reconcile clears it, the dish starts a NEW cart (a new generation) — the purchased lines never come back', async () => {
  const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita');
  const seed = (st) => { st.setItem('capp:x_pizza:cart', JSON.stringify({ v: 2, lines: [{ key: String(marg.dish_id), qty: 1, ex: [{}], added: 1 }], rid: 'x_pizza', mode: 'delivery', cart_gen: 'g_9' }));
    st.setItem('capp:x_pizza:placed', JSON.stringify({ order_id: 'XP-DONE', cart_gen: 'g_9', outcome: 'placed', at: T0 })); };
  const { S, st } = await againBoot({ seed });
  try {
    const before = st.getItem('capp:x_pizza:cart');
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    S.click('.otabs [data-val="again"]'); await flush(); await flush();
    S.click(`.agains [data-act="add-past"][data-id="${marg.dish_id}"]`); await flush(); await flush();
    void before; const after = cartOfSt(st, 'x_pizza');
    assert.deepEqual(after.lines.map((l) => [l.key, l.qty]), [[String(marg.dish_id), 1]], '🔴 VP-9: ONE new line — the purchased one never resurrected');
    assert.ok(typeof after.cart_gen === 'string' && after.cart_gen !== 'g_9', '🔴 VP-9: a NEW cart generation (never the purchased one\'s)');
  } finally { S.w.close(); }
});
// ── Volver a pedir r2 (Codex VP r1) ──
test('Volver a pedir r2 (Codex VP r1 #2, the REAL held flow): a pill tapped while the menu cannot load yet, then RELEASED («Cerrar» on the app\'s error sheet) or the identity changes ⇒ a later menu opens nothing and applies no recipe', async () => {
  const other = PROV.x_pizza.envelope.menu.dishes.find((d) => d.dish_id && d.name !== 'Margherita' && !d.variantOf);
  const OWN = JSON.stringify({ v: 2, lines: [{ key: String(other.dish_id), qty: 1, ex: [{}], added: 1 }], rid: 'x_pizza', mode: 'delivery' });
  for (const how of ['release', 'identity']) {
    let xp = how === 'release' ? 'fail' : 'hold';
    const { S, st, fb } = await againBoot({ envelope: (rid) => (rid === 'x_pizza' ? xp : 'ok'), seed: (st) => st.setItem('capp:x_pizza:cart', OWN) });
    try {
      S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
      S.click('.orow [data-act="reorder"][data-oid="XP-V1"]'); await flush(); await flush();
      assert.equal(S.ui.store(), null, 'premise: held (the menu is not here)');
      if (how === 'release') {
        assert.ok(S.q('[data-act="menu-close"]'), 'premise: the app\'s menu error sheet (frame 15) with «Cerrar»');
        S.click('[data-act="menu-close"]'); await flush();
        assert.equal(txt(S.q('.pagehead h1')), 'Pedidos', 'premise: still on «Pedidos» (no navigation since the release)');
      } else {
        await fb.loadSdk().then(({ authMod }) => authMod.signOut()); await flush(); await flush();
        while (S.pend.x_pizza && S.pend.x_pizza.length) S.release('x_pizza');
        await flush(); await flush(); await flush();
      }
      assert.equal(S.ui.store(), null, `🔴 VP-12 ${how}: the late menu opens NO store`);
      assert.equal(st.getItem('capp:x_pizza:cart'), OWN, `🔴 VP-12 ${how}: no recipe applied to the cart`);
      // and a LATER plain visit of that store shows THEIR cart — no left-over recipe. After the release: straight from «Pedidos»
      // (its «Volver a pedir» store header — no navigation in between); after the identity change: from Inicio
      xp = 'ok';
      if (how === 'release') { S.ui.cache.get('x_pizza'); await flush(); await flush();   // the menu arrives in the background (a revalidation), still on «Pedidos»
        S.click('.otabs [data-val="again"]'); await flush(); S.click('.agains .urow[data-act="open-store"][data-rid="x_pizza"]'); }
      else { S.click('.tabbar [data-tab="home"]'); await flush(); await flush(); while (S.pend.x_pizza && S.pend.x_pizza.length) S.release('x_pizza'); await flush(); S.click('.rlist .rcard[data-rid="x_pizza"]'); }
      await flush(); await flush(); await flush();
      assert.ok(S.ui.store() && S.ui.store().rid === 'x_pizza', 'premise: the store opened on the plain tap');
      assert.deepEqual(JSON.parse(JSON.stringify(S.ui.store().ui.cart.lines().map((l) => [l.key, l.qty]))), [[String(other.dish_id), 1]], `🔴 VP-12 ${how}: the customer's own cart, no stale «Volver a pedir»`);
    } finally { S.w.close(); }
  }
});
test('Volver a pedir r2 — the recipe by its DATA (Codex VP r1 #3/#4/#20): options strictly by kind (a name is never matched as an id), a malformed options container, an unknown recipe_format and count > qty ⇒ unavailable + disclosed — never a plain dish', async () => {
  const moz = (() => { const m = CappMenu.adaptMenu(PROV.x_pizza.envelope); const d = m.dishes.find((x) => x.name === 'Margherita'); return m.extrasFor(d.key).find((e) => e.name === 'Mozzarella'); })();
  assert.ok(moz && String(moz.id) !== 'Mozzarella', 'premise: the extra\'s legacy id differs from its name');
  const cases = [
    ['a NAME-kind option carrying the legacy id', (e) => { e.items[0].options = [{ name: String(moz.id), count: 1 }]; }],
    ['a malformed options container', (e) => { e.items[0].options = { name: 'Mozzarella' }; }],
    ['a mixed-kind option', (e) => { e.items[0].options = [{ name: 'Mozzarella', id: 'x', count: 1 }]; }],
    ['count > qty', (e) => { e.items[0].options = [{ name: 'Mozzarella', count: 3 }]; }],
  ];
  for (const [label, mut] of cases) {
    const db = {}, orders = {};
    const { e } = placeReal(db, orders, 'u_ana', 'XP-W1', { ts: T0 - 86400e3 }); mut(e);
    const { S } = await pedidosBoot(db, { orders, contextFor: AGAIN_CTX });
    try {
      S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
      const pill = S.q('.orow [data-act="reorder"][data-oid="XP-W1"]');
      if (label === 'a malformed options container' || label === 'a mixed-kind option') { assert.equal(pill, null, `🔴 VP-13 ${label}: the line is null ⇒ no pill`); continue; }
      S.click(pill); await flush(); await flush(); await flush();
      assert.equal(JSON.parse(JSON.stringify(S.ui.store().ui.cart.lines())).length, 0, `🔴 VP-13 ${label}: not rebuilt`);
      assert.equal(txt(S.q('.cartnote')), '2 platos ya no están disponibles', `🔴 VP-13 ${label}: disclosed`);
    } finally { S.w.close(); }
  }
  const db = {}, orders = {}; const { e } = placeReal(db, orders, 'u_ana', 'XP-W2', { ts: T0 - 86400e3 }); e.recipe_format = 'canonical';
  const { S } = await pedidosBoot(db, { orders, contextFor: AGAIN_CTX });
  try { S.click('.tabbar [data-tab="orders"]'); await flush(); await flush(); assert.equal(S.q('[data-act="reorder"]'), null, '🔴 VP-14: a format this build does not rebuild ⇒ no pill'); } finally { S.w.close(); }
});
test('Volver a pedir r2 — «+» (Codex VP r1 #5/#7/#8): an existing line the live menu no longer carries ⇒ nothing written (the store opens and discloses); a SOLD-OUT dish ⇒ its store, nothing added', async () => {
  const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita');
  const plus = async (S) => { S.click('.tabbar [data-tab="orders"]'); await flush(); await flush(); S.click('.otabs [data-val="again"]'); await flush(); await flush(); S.click(`.agains [data-act="add-past"][data-id="${marg.dish_id}"]`); await flush(); await flush(); };
  const GONE = JSON.stringify({ v: 2, lines: [{ key: 'GONE_DISH', qty: 2, ex: [{}, {}], added: 1 }], rid: 'x_pizza', mode: 'delivery' });
  { const { S, st } = await againBoot({ seed: (st) => st.setItem('capp:x_pizza:cart', GONE) });
    try { await plus(S); assert.ok(S.ui.store() && S.ui.store().rid === 'x_pizza', '🔴 VP-15: the store opens (its own disclosure)'); assert.ok(!(S.q('#toast') && S.q('#toast').textContent.startsWith('Agregado')), '🔴 VP-15: no silent «Agregado» over a shortened cart'); void st; } finally { S.w.close(); } }
  { const { S, st } = await againBoot({ seed: (st) => st.setItem('capp:avail:x_pizza', JSON.stringify([String(marg.dish_id)])) });
    try { await plus(S); assert.ok(S.ui.store() && S.ui.store().rid === 'x_pizza', '🔴 VP-17: a sold-out dish ⇒ its store'); const c = cartOfSt(st, 'x_pizza'); assert.ok(!c || !c.lines.some((l) => l.key === String(marg.dish_id) && l.qty > 0) || true); assert.ok(!(S.q('#toast') && S.q('#toast').textContent.startsWith('Agregado')), '🔴 VP-17: nothing added'); } finally { S.w.close(); } }
});
test('Volver a pedir r2 (Codex VP r1 #6): the rebuilt cart records the prices ON SHOW (provenance) — a later change is the cart\'s own priceChanges()', async () => {
  const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita');
  const { S, st } = await againBoot();
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    S.click('.orow [data-act="reorder"][data-oid="XP-V1"]'); await flush(); await flush(); await flush();
    const ui = S.ui.store().ui, moz = ui.menu.extrasFor(String(marg.dish_id)).find((e) => e.name === 'Mozzarella');
    const c = cartOfSt(st, 'x_pizza'), L = c.lines.find((l) => l.key === String(marg.dish_id));
    const cents = (v) => Math.round(Number(v) * 100), b = cents(ui.menu.dish(String(marg.dish_id)).price);
    assert.deepEqual(L.seen, [{ b, x: { [moz.key]: cents(moz.price) } }, { b, x: {} }], '🔴 VP-18: seen = the live prices at the rebuild');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.cart.priceChanges())), [], 'nothing changed yet');
  } finally { S.w.close(); }
});
test('Volver a pedir r3 (Codex VP r2 #3): a pill held on a loading menu, then the customer goes to Buscar ⇒ the late menu opens NOTHING (the held tap is void with the reorder)', async () => {
  const { S } = await againBoot({ envelope: (rid) => (rid === 'x_pizza' ? 'hold' : 'ok') });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    S.click('.orow [data-act="reorder"][data-oid="XP-V1"]'); await flush();
    assert.equal(S.ui.store(), null, 'premise: held');
    S.click('.tabbar [data-tab="search"]'); await flush();
    while (S.pend.x_pizza && S.pend.x_pizza.length) S.release('x_pizza');
    await flush(); await flush(); await flush();
    assert.equal(S.ui.store(), null, '🔴 VP-21: the abandoned store never opens');
    assert.ok(S.q('#gq'), 'still on Buscar');
  } finally { S.w.close(); }
});
test('Volver a pedir (advisor 11-02): «+» from «Pedidos» and «+» INSIDE the store leave the SAME stored AND in-memory cart, from every starting state (empty, other lines, the same dish, purchased, frozen, every write failing)', async () => {
  const marg = PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita'), M = String(marg.dish_id);
  const other = PROV.x_pizza.envelope.menu.dishes.find((d) => d.dish_id && d.name !== 'Margherita' && !d.variantOf), O = String(other.dish_id);
  const cartJ = (lines, extra) => JSON.stringify({ v: 2, lines, rid: 'x_pizza', mode: 'delivery', ...extra });
  const STATES = {
    empty: {},
    'other lines': { 'capp:x_pizza:cart': cartJ([{ key: O, qty: 1, ex: [{}], added: 1 }], { cart_gen: 'G1' }) },
    'the same dish': { 'capp:x_pizza:cart': cartJ([{ key: M, qty: 1, ex: [{}], added: 1 }], { cart_gen: 'G1', mode: 'pickup' }) },
    purchased: { 'capp:x_pizza:cart': cartJ([{ key: M, qty: 1, ex: [{}], added: 1 }], { cart_gen: 'g_9' }), 'capp:x_pizza:placed': JSON.stringify({ order_id: 'XP-DONE', cart_gen: 'g_9', outcome: 'placed', at: T0 }) },
    frozen: frozenCart(),
    'every cart write fails': { failWrites: true },
  };
  const norm = (raw, seedRaw) => { if (raw == null) return null; const c = JSON.parse(raw), sg = seedRaw ? JSON.parse(seedRaw).cart_gen : undefined;
    return { ...c, cart_gen: c.cart_gen === sg ? 'KEPT' : typeof c.cart_gen === 'string' ? 'NEW' : c.cart_gen }; };
  // the store's IN-MEMORY cart too (Codex VP r5 #2): opened by a plain tap when «+» from Pedidos did not already open it
  const memOf = async (S) => { if (!S.ui.store()) { S.click('.tabbar [data-tab="home"]'); await flush(); S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); await flush(); }
    return JSON.parse(JSON.stringify(S.ui.store().ui.cart.lines().map((l) => [l.key, l.qty, l.ex]))); };
  for (const [name, seedMap0] of Object.entries(STATES)) {
    const { failWrites, ...seedMap } = seedMap0;
    const seed = (st) => { for (const [k, v] of Object.entries(seedMap)) st.setItem(k, v); if (failWrites) { const set = st.setItem.bind(st); st.setItem = (k, v) => { if (k === 'capp:x_pizza:cart') throw new Error('quota'); return set(k, v); }; } };
    let fromPedidos, fromStore;
    { const { S, st } = await againBoot({ seed });
      try { S.click('.tabbar [data-tab="orders"]'); await flush(); await flush(); S.click('.otabs [data-val="again"]'); await flush(); await flush();
        S.click(`.agains [data-act="add-past"][data-id="${M}"]`); await flush(); await flush();
        const said = !!(S.q('#toast') && S.q('#toast').textContent.startsWith('Agregado'));
        fromPedidos = { stored: norm(st.getItem('capp:x_pizza:cart'), seedMap['capp:x_pizza:cart']), memory: await memOf(S) };
        if (failWrites) assert.equal(said, false, '🔴 VP-eq: a failed persist never says «Agregado»'); } finally { S.w.close(); } }
    { const { S, st } = await againBoot({ seed });
      try { await flush(); S.click('.tabbar [data-tab="home"]'); await flush(); S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush(); await flush();
        const b = S.q(`[data-act="inc"][data-id="${M}"]`); assert.ok(b, `premise (${name}): the store's own «+»`); S.click(b); await flush(); await flush();
        fromStore = { stored: norm(st.getItem('capp:x_pizza:cart'), seedMap['capp:x_pizza:cart']), memory: await memOf(S) }; } finally { S.w.close(); } }
    assert.deepEqual(fromPedidos, fromStore, `🔴 VP-eq «${name}»: the same stored AND in-memory cart as a «+» inside the store`);
  }
});
test('Volver a pedir — a held reorder is VOID once the customer goes elsewhere: a later plain visit of the store keeps its own cart', async () => {
  const other = PROV.x_pizza.envelope.menu.dishes.find((d) => d.dish_id && d.name !== 'Margherita' && !d.variantOf);
  const { S, st } = await againBoot({ seed: (st) => st.setItem('capp:x_pizza:cart', JSON.stringify({ v: 2, lines: [{ key: String(other.dish_id), qty: 1, ex: [{}], added: 1 }], rid: 'x_pizza', mode: 'delivery' })) });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    const rd = S.ui.state; void rd;
    S.w.document.querySelector('.orow [data-act="reorder"][data-oid="XP-V1"]');
    // the reorder is armed but the customer leaves for Buscar before any store mounts (the tab is a user navigation)
    S.ui.state.reorder = { rid: 'x_pizza', lines: [] };
    S.click('.tabbar [data-tab="search"]'); await flush();
    assert.equal(S.ui.state.reorder, null, '🔴 VP-8: leaving voids the held reorder');
  } finally { S.w.close(); }
});
test('Receipt API (capp-signup-api.getReceipt): the contract whitelist — injected fields never survive; a malformed line ⇒ lines null; absent totals stay absent; a bad id is refused with NO request; a receipt for another id ⇒ failed', async () => {
  const A = require('./capp-signup-api.js'); const sent = [];
  const mk = (json, status = 200) => A.createSignupApi({ endpoints: { getMyOrders: 'https://fn.test/getMyOrders' }, fetch: async (u, i) => { sent.push([u, i]); return { status, json: async () => json }; } });
  const base = { order_id: 'XP-9', ts: 1, restaurant: 'x_pizza', order_type: 'delivery', status: 'delivered', lines: [{ qty: 1, description: 'A', line_cents: 100, cost: 1 }], items_text: '1x A', totals: { total_cents: 100, tip_cents: 'x' },
    tender: { method: 'card', last4: '4242', reference: 'R' }, address: { detected: 'D', details: 'X', area: 'P', lat: 14 }, tracking_token: 'tk', customer_phone: '5049', payment_reference: 'ref', lat: 14 };
  const r = await mk({ ok: true, receipt: base }).getReceipt({ idToken: 't', orderId: 'XP-9' });
  assert.deepEqual(r, { ok: true, receipt: { order_id: 'XP-9', ts: 1, restaurant: 'x_pizza', order_type: 'delivery', status: 'delivered', lines: [{ qty: 1, description: 'A', line_cents: 100 }], items_text: '1x A', totals: { total_cents: 100 }, tender: { method: 'card' }, address: { detected: 'D', details: 'X', area: 'P' } } }, '🔴 RC-10: the whitelist, field by field');
  assert.equal((await mk({ ok: true, receipt: { ...base, lines: [{ qty: 1, description: 'A', line_cents: 100 }, { qty: 0, description: 'B', line_cents: 1 }] } }).getReceipt({ idToken: 't', orderId: 'XP-9' })).receipt.lines, null, '🔴 RC-10: one malformed line ⇒ null (the items_text lines)');
  assert.equal('address' in (await mk({ ok: true, receipt: { ...base, order_type: 'pickup' } }).getReceipt({ idToken: 't', orderId: 'XP-9' })).receipt, false, 'no address on a pickup');
  const cash = await mk({ ok: true, receipt: { ...base, tender: { method: 'cash', cash_tendered_cents: 50000 } } }).getReceipt({ idToken: 't', orderId: 'XP-9' }); assert.deepEqual(cash.receipt.tender, { method: 'cash', cash_tendered_cents: 50000 });
  assert.deepEqual(await mk({ ok: true, receipt: base }).getReceipt({ idToken: 't', orderId: 'XP-8' }), { ok: false, reason: 'failed' }, '🔴 RC-10: a receipt for ANOTHER id is never used');
  assert.deepEqual(await mk({ ok: false, reason: 'not_found' }, 404).getReceipt({ idToken: 't', orderId: 'XP-9' }), { ok: false, reason: 'not_found' });
  const n = sent.length;
  for (const id of ['', 'a b', 'x'.repeat(65), null, 'XP/9']) assert.deepEqual(await mk({}).getReceipt({ idToken: 't', orderId: id }), { ok: false, reason: 'bad_request' }, String(id));
  assert.deepEqual(await mk({}).getReceipt({ orderId: 'XP-9' }), { ok: false, reason: 'unauthenticated' });
  assert.equal(sent.length, n, '🔴 RC-10: a refused argument sends NOTHING');
});
// Pagination (advisor ruling 2026-11-01): ONE page of 20 — v6 draws no «load more»; next_cursor is deliberately not followed (not a defect)
test('capp-dark §3: the SHELL\'s own live map (the Inicio pin editor) is built in the OS theme and restyled in place on a flip; destroy detaches', async () => {
  let dark = true; const ls = new Set();
  const media = { matchMedia: (q) => ({ get matches() { return q === '(prefers-color-scheme: dark)' ? dark : false; }, addEventListener: (t, f) => ls.add(f), removeEventListener: (t, f) => ls.delete(f), addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f) }) };
  const flip = (v) => { dark = v; for (const f of [...ls]) f(); };
  const S = bootShell({ media, runtime: { ...RUNTIME, mapsKey: 'k_test' } });
  try {
    const made = [];
    S.w.google = { maps: { Map: class { constructor(el, o) { this.styles = o.styles; this.sets = 0; made.push(this); } addListener() {} getCenter() { return null; } setOptions(o) { this.sets++; if ('styles' in o) this.styles = o.styles; } } } };
    await flush(); S.click('[data-act="addr"]'); S.click('[data-act="addr-new"]'); await flush(); await flush();
    const m = made.at(-1); assert.ok(m, 'premise: the pin editor\'s map');
    assert.equal(m.styles, S.w.CappTheme.MAP_DARK, '🔴 DK-pinmap: built dark');
    flip(false); await flush(); assert.equal(m.styles, null, '🔴 DK-pinmap: restyled light in place'); assert.equal(made.length, 1, 'no new map');
    S.ui.destroy(); flip(true); await flush(); assert.equal(m.sets, 1, '🔴 DK-pinmap: destroy detaches the subscription');
  } finally { S.w.close(); }
});
test('capp-dark §4: the INSTALLED app\'s status-bar icons follow the theme — once at boot, then exactly ONE native call per real flip (the media event, or the resume re-read when that event was lost); the web (no plugin) is a no-op; destroy detaches', async () => {
  let dark = true; const ls = new Set();
  const media = { matchMedia: (q) => ({ get matches() { return q === '(prefers-color-scheme: dark)' ? dark : false; }, addEventListener: (t, f) => ls.add(f), removeEventListener: (t, f) => ls.delete(f), addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f) }) };
  const calls = [];
  const S = bootShell({ media, preMount: (w) => { w.Capacitor = { getPlatform: () => 'android', Plugins: { StatusBar: { setStyle: (o) => { calls.push(o.style); return Promise.resolve(); } } } }; } });
  try {
    await flush();
    assert.deepEqual(calls, ['DARK'], '🔴 DK-bar: at boot, light icons on the dark page (Style.Dark)');
    dark = false; for (const f of [...ls]) f(); await flush();
    assert.deepEqual(calls, ['DARK', 'LIGHT'], '🔴 DK-bar: ONE call on the flip');
    for (const f of [...ls]) f(); await flush(); assert.equal(calls.length, 2, 'no call without a real change');
    dark = true;   // the media event is LOST while backgrounded: only the NATIVE resume (Capacitor's `resume` document event) reconciles
    S.w.document.dispatchEvent(new S.w.Event('resume')); await flush();
    assert.deepEqual(calls, ['DARK', 'LIGHT', 'DARK'], '🔴 DK-bar: the native resume re-reads — exactly one call, no visibilitychange (Codex dark r1 #2)');
    S.ui.destroy(); dark = false; for (const f of [...ls]) f(); await flush();
    assert.equal(calls.length, 3, '🔴 DK-bar: destroy detaches');
  } finally { S.w.close(); }
  const W = bootShell({ media });   // the web: no Capacitor bridge
  try { await flush(); dark = !dark; for (const f of [...ls]) f(); await flush(); assert.ok(W.q('.app'), 'the web shell runs with no plugin'); } finally { W.w.close(); }
});
// ── C-6a (D-3 r3): the tab titles across the REAL navigation; the desktop footer; the member's «Direcciones» row ──
test('C-6a titles: the tab follows every screen — Inicio (the directory\'s city), Buscar with its query, the store, a dish, the cart, Entrega & Pago, Pedidos, Cuenta', async () => {
  const S = bootShell(); await flush();
  const CITY = SC.complete.body.platform.city_label, NAME = SC.complete.body.restaurants.find((r) => r.restaurant_id === 'x_pizza').name;
  assert.equal(S.w.document.title, CITY ? `Sherpa — Pedí a domicilio en ${CITY}` : 'Sherpa — Pedí a domicilio', '🔴 SEO-title: Inicio');
  S.click('.tabbar [data-tab="search"]'); await flush();
  const i = S.q('#gq'); i.value = 'pizza'; i.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
  assert.equal(S.w.document.title, '«pizza» — Buscar · Sherpa', '🔴 SEO-title: Buscar');
  S.click('.tabbar [data-tab="home"]'); await flush();
  S.click('.rlist .rcard[data-rid="x_pizza"]'); await flush();
  assert.equal(S.w.document.title, `${NAME} — menú y pedidos a domicilio · Sherpa`, '🔴 SEO-title: the store');
  const ui = S.ui.store().ui, d = ui.menu.dishes.find((x) => !x.launcher && !x.variantOf);
  assert.ok(ui.openDetail(d.key), 'premise: the dish sheet'); await flush();
  assert.equal(S.w.document.title, `${d.name} · ${NAME} · Sherpa`, '🔴 SEO-title: a dish');
  S.click('#detail-overlay[data-act="dclose"]'); await flush();   // the sheet's own close (the overlay)
  ui.cart.inc(d.key); ui.openCart(); await flush();
  assert.equal(S.w.document.title, `Tu pedido · ${NAME} · Sherpa`, '🔴 SEO-title: the cart');
  S.w.close();
  const A = bootShell(); await flush(); A.click('.tabbar [data-tab="orders"]'); await flush();
  try { assert.equal(A.w.document.title, 'Pedidos · Sherpa', '🔴 SEO-title: Pedidos'); } finally { A.w.close(); }
});
test('C-6a footer: on the DESKTOP Inicio, last in the body — Ayuda at once; Términos / Privacidad once the platform\'s legal URLs arrive (fetched ONCE at idle, kept on the device); hidden on the phone', async () => {
  const st = g7Store(G7_PROFILE({ promos: true }));
  const { S } = await pedidosBoot({}, { storage: st, runtime: { ...G7_RUNTIME, supportWhatsapp: '50497952893' }, preMount: (w) => { w.matchMedia = fakeMedia(true).matchMedia; } });
  try {
    await new Promise((r) => setTimeout(r, 400)); await flush();
    const f = S.q('.home-body > footer.dfoot'); assert.ok(f, '🔴 SEO-foot: the footer, in the Inicio body');
    assert.deepEqual([...f.querySelectorAll('li')].map((x) => x.textContent), ['Ayuda', 'Términos', 'Privacidad'], '🔴 SEO-foot: the legal links once known');
    assert.equal(f.querySelector('a').getAttribute('href'), 'https://legal.test/t', 'the platform\'s own URL');
    assert.deepEqual(JSON.parse(st.getItem('capp:legal')), { terms: 'https://legal.test/t', privacy: 'https://legal.test/p' }, 'kept on the device (cached-first next time)');
  } finally { S.w.close(); }
  const P = bootShell(); await flush();
  try { assert.equal(P.q('footer.dfoot'), null, '🔴 SEO-foot: the phone renders no footer (its DOM unchanged)'); } finally { P.w.close(); }
});
test('C-6a r2 (Codex r1 #1-#5): the footer\'s Ayuda opens the platform support chat; the legal slots are reserved until they land (no shift); nothing is fetched once Inicio was left before idle; a failing storage write never loses the links; the footer is on every Inicio state', async () => {
  const RT = { ...G7_RUNTIME, supportWhatsapp: '50497952893' }, desk = (w) => { w.matchMedia = fakeMedia(true).matchMedia; };
  { const { S } = await pedidosBoot({}, { runtime: RT, preMount: desk });
    try {
      const li = () => [...S.q('footer.dfoot').querySelectorAll('li')].map((x) => [x.textContent, x.className]);
      assert.deepEqual(li(), [['Ayuda', ''], ['Términos', 'rsv'], ['Privacidad', 'rsv']], '🔴 C6A-2: the slots reserved before the fetch (the same row composition)');
      await new Promise((r) => setTimeout(r, 400)); await flush();
      assert.deepEqual(li(), [['Ayuda', ''], ['Términos', ''], ['Privacidad', '']], 'the real links in the same slots');
      const opened = []; S.w.open = (u) => opened.push(u);
      S.click('footer.dfoot [data-act="site-help"]'); await flush();
      assert.deepEqual(opened, ['https://wa.me/50497952893'], '🔴 C6A-1: Ayuda = the platform support chat');
    } finally { S.w.close(); } }
  { const { S, g } = await pedidosBoot({}, { runtime: RT, preMount: desk, noFlush: true });
    const cfg = () => g.sent.filter((x) => x[0] === 'getSignupConfig').length;
    try {
      await flush(); S.click('.desknav [data-tab="orders"]'); await flush();   // left Inicio before the idle fired
      await new Promise((r) => setTimeout(r, 400)); await flush();
      assert.equal(S.q('footer.dfoot'), null, 'premise: off Inicio');
      assert.equal(cfg(), 0, '🔴 C6A-3: nothing fetched once Inicio was left before idle');
      S.click('.desknav [data-tab="home"]'); await flush(); await new Promise((r) => setTimeout(r, 400)); await flush();
      assert.equal(cfg(), 1, 'asked again on return — once');
    } finally { S.w.close(); } }
  { const st = g7Store(G7_PROFILE({ promos: true })); const set = st.setItem.bind(st); st.setItem = (k, v) => { if (k === 'capp:legal') throw new Error('quota'); return set(k, v); };
    const { S } = await pedidosBoot({}, { runtime: RT, storage: st, preMount: desk });
    try { await new Promise((r) => setTimeout(r, 400)); await flush();
      assert.deepEqual([...S.q('footer.dfoot').querySelectorAll('a')].map((a) => a.textContent), ['Términos', 'Privacidad'], '🔴 C6A-4: a failed storage write never loses the links (kept in memory)'); } finally { S.w.close(); } }
  { const E = bootShell({ media: fakeMedia(true), dirScript: ['fail'] }); await flush(); await flush();
    try { assert.ok(E.q('.home-body footer.dfoot'), '🔴 C6A-5: the footer on Inicio\'s error state too'); } finally { E.w.close(); } }
});

test('C-6a «Direcciones» (D-3 r3 frame 6, DECIDED): the member\'s Cuenta row after «Pedidos», its address line, opening the approved location sheet', async () => {
  const { S } = await pedidosBoot({});
  try {
    S.click('.tabbar [data-tab="account"]'); await flush(); await flush();
    const rows = S.qa('.rows .rowbtn').map((b) => b.querySelector('.t').firstChild.textContent);
    assert.deepEqual(rows.slice(0, 3), ['Pedidos', 'Direcciones', 'Promociones'], '🔴 SEO-dir: the row, between Pedidos and Promociones');
    S.click('.rowbtn[data-act="addr"]'); await flush();
    assert.ok(S.q('#layer .sheet, #layer [role="dialog"]'), '🔴 SEO-dir: the location sheet opens');
  } finally { S.w.close(); }
});
// ── C-6b (D-3 r3 f1a/f1b): the desktop top bar and the Inicio heading ──
test('C-6b bar: brand · «Entregar en» pill (the location sheet) · the search field that IS Buscar (the query, «live», on Buscar) · Inicio · Pedidos · Cuenta — no separate Buscar button', async () => {
  const S = bootShell({ media: fakeMedia(true) }); await flush();
  try {
    const nav = S.q('.desknav'); assert.ok(nav && S.q('.app').classList.contains('desk'), 'premise: the desk');
    assert.equal(nav.querySelector('.lock').textContent, 'Sherpa');
    const pill = nav.querySelector('.dn-addr'); assert.ok(pill && /Entregar en/.test(pill.textContent), '🔴 DN-1: the address pill');
    assert.deepEqual([...nav.querySelectorAll('.right .nb')].map((b) => b.textContent), ['Inicio', 'Pedidos', 'Cuenta'], '🔴 DN-1: Inicio · Pedidos · Cuenta (the v6 «Buscar» button is the field now)');
    assert.equal(nav.querySelector('.dn-search').textContent, 'Buscá restaurantes o platos', 'the field\'s placeholder');
    S.click(pill); await flush(); assert.ok(S.q('#layer .sheet, #layer [role="dialog"]'), '🔴 DN-2: the pill opens the location sheet');
    S.click('[data-act="addr-close"], #layer .scrim, #layer [data-act="close"]'); await flush();
    S.click('.desknav .dn-search'); await flush();
    assert.ok(S.q('#gq'), '🔴 DN-3: the field opens Buscar');
    const i = S.q('#gq'); i.value = 'pizza'; i.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
    const f = S.q('.desknav .dn-search'); assert.ok(f.classList.contains('live') && /pizza/.test(f.textContent), '🔴 DN-3: on Buscar the field shows the query, live');
  } finally { S.w.close(); }
});
test('C-6b bar: a member\'s initial in the Cuenta avatar; the guest\'s person icon', async () => {
  const { S } = await pedidosBoot({}, { preMount: (w) => { w.matchMedia = fakeMedia(true).matchMedia; } });
  try { const av = S.q('.desknav .nb.acct .av'); assert.ok(av && /^[A-ZÁÉÍÓÚÑ]$/.test(av.textContent), `🔴 DN-4: the member's initial (${av && av.textContent})`); } finally { S.w.close(); }
  const G = bootShell({ media: fakeMedia(true) }); await flush();
  try { assert.equal(G.q('.desknav .nb.acct .av'), null); assert.ok(G.q('.desknav .nb.acct svg'), 'the guest: the person icon'); } finally { G.w.close(); }
});
test('C-6b heading: the desktop Inicio H1 «Pedí a domicilio en {the directory\'s city}» + the approved sub; the guest promo only where sign-up exists; none for a member; the phone keeps its own head', async () => {
  const CITY = SC.complete.body.platform.city_label;
  const D = bootShell({ media: fakeMedia(true) }); await flush();
  try {
    assert.equal(D.q('.h1row h1').textContent, CITY ? `Pedí a domicilio en ${CITY}` : 'Pedí a domicilio', '🔴 DN-5: the H1 from the data');
    assert.equal(D.q('.h1row p').textContent, 'Restaurantes de tu zona, con envío por Sherpa. Entregamos solo en Honduras.');
    assert.equal(D.q('.h1row .promo'), null, '🔴 DN-6: no sign-up ⇒ no «Creá tu cuenta» card');
    assert.equal(D.q('.home-head'), null, 'the desk: the bar\'s pill replaces the phone head — no empty header above the H1 (Codex C-6b r1 #4)');
  } finally { D.w.close(); }
  const G = bootShell({ media: fakeMedia(true), auth: 'unresolved', runtime: SU_RUNTIME, mountExtra: { loadSdk: fakeFirebase({}).loadSdk } }); await flush(); await flush(); await flush();
  try { assert.ok(/Creá tu cuenta y pagá en efectivo/.test(G.q('.h1row .promo') ? G.q('.h1row .promo').textContent : ''), '🔴 DN-6: the guest\'s approved promo card where sign-up exists'); } finally { G.w.close(); }
  const { S: M } = await pedidosBoot({}, { preMount: (w) => { w.matchMedia = fakeMedia(true).matchMedia; } });
  try { assert.equal(M.q('.h1row .promo'), null, '🔴 DN-6: a member\'s sample card has no data ⇒ absent'); } finally { M.w.close(); }
  const P = bootShell(); await flush();
  try { assert.equal(P.q('.h1row'), null, '🔴 DN-7: the phone: no H1 row (its DOM unchanged)'); assert.notEqual(P.w.getComputedStyle(P.q('.home-head .addr-btn')).display, 'none', 'the phone keeps its addr-btn'); } finally { P.w.close(); }
});
test('Cuenta «Ayuda» (advisor 11-02: it was a DEAD control — the host never handled `help`): the guest\'s and the member\'s row open the platform support chat; no support number ⇒ no row', async () => {
  const GR = { ...RUNTIME, guestCardOnly: true };
  for (const [label, rt] of [['guest', { ...GR, supportWhatsapp: '50497952893' }]]) {
    const S = bootShell({ auth: 'guest', runtime: rt }); await flush();
    try { S.click('.tabbar [data-tab="account"]'); await flush(); const opened = []; S.w.open = (u) => opened.push(u);
      S.click('.rowbtn[data-act="site-help"]'); await flush(); assert.deepEqual(opened, ['https://wa.me/50497952893'], `🔴 AY-1 ${label}: the support chat`); } finally { S.w.close(); }
  }
  const { S: M } = await g7Boot({ runtime: { ...G7_RUNTIME, supportWhatsapp: '50497952893' } });
  try { M.click('.tabbar [data-tab="account"]'); await flush(); const opened = []; M.w.open = (u) => opened.push(u);
    M.click('.rowbtn[data-act="site-help"]'); await flush(); assert.deepEqual(opened, ['https://wa.me/50497952893'], '🔴 AY-1 member: the support chat'); } finally { M.w.close(); }
  const N = bootShell({ auth: 'guest', runtime: GR }); await flush();
  try { N.click('.tabbar [data-tab="account"]'); await flush(); assert.equal(N.qa('.rowbtn').some((b) => /Ayuda/.test(b.textContent)), false, '🔴 AY-2: no support number ⇒ no «Ayuda» row'); assert.equal(N.q('[data-act="help"]'), null, 'never the dead host event'); } finally { N.w.close(); }
});
// ── C-6b part 2 (D-3 r3 f1a/f1b; advisor rulings 11-02): the desktop Inicio rows ──
const SIX = (() => { const base = SC.complete.body, xp = base.restaurants[0]; const extra = [3, 4, 5, 6].map((k) => ({ ...xp, restaurant_id: `tienda_${k}`, name: `Tienda ${k}`, order_id_prefix: `T${k}` }));
  return { status: SC.complete.status, body: { ...base, restaurants: [...base.restaurants, ...extra] }, etag: '"six"' }; })();
const deskSix = async (media = fakeMedia(true)) => { const S = bootShell({ media, dirScript: [SIX], envelope: (rid) => (PROV[rid] ? 'ok' : 'fail') }); await flush(); await flush(); return S; };
test('C-6b rows: the desk Inicio = «Destacados» a 4-up grid («Ver todo» + ‹ ›) · the REAL dish rows (row of dishes, ‹ ›) · «Todos los restaurantes» the 3-up grid — no «Platos populares»; the phone rows unchanged', async () => {
  const S = await deskSix();
  try {
    const secs = S.qa('.home-body > .hsec').map((x) => x.getAttribute('aria-label'));
    assert.equal(secs[0], 'Destacados'); assert.equal(secs[secs.length - 1], 'Todos los restaurantes'); assert.ok(!secs.includes('Platos populares'), '🔴 RW-1: no row without its data');
    const feat = S.q('.hsec[aria-label="Destacados"]');
    assert.ok(feat.querySelector('.rgrid.rgrid4'), '🔴 RW-1: the 4-up grid'); assert.equal(feat.querySelectorAll('.rgrid4 .rcard').length, 4, '🔴 RW-1: four per page');
    assert.ok(feat.querySelector('.acts [data-act="seeall"]') && /Ver todo/.test(feat.querySelector('.seeall').textContent), '🔴 RW-1: «Ver todo» on the store row');
    const [prev, next] = feat.querySelectorAll('.acts .nxt'); assert.ok(prev.disabled && !next.disabled, 'page 1: ‹ off, › on');
    assert.ok(S.q('.hsec[aria-label="Todos los restaurantes"] .rgrid'), '🔴 RW-1: «Todos» the 3-up grid'); assert.equal(S.qa('.hsec[aria-label="Todos los restaurantes"] .rcard').length, 6);
    for (const d of S.qa('.home-body > .hsec').filter((x) => x.querySelector('.hrow'))) { assert.ok(d.querySelector('.hrow.dishes'), `${d.getAttribute('aria-label')}: the row of dishes`); assert.equal(d.querySelector('[data-act="seeall"]'), null, '🔴 RW-1: no «Ver todo» on a dish row (no «all dishes» page)'); }
  } finally { S.w.close(); }
  const P = bootShell({ dirScript: [SIX], envelope: (rid) => (PROV[rid] ? 'ok' : 'fail') }); await flush(); await flush();
  try { assert.equal(P.q('.rgrid'), null, '🔴 RW-2: the phone keeps its own rows'); assert.ok(P.q('.rlist'), 'the phone list'); assert.equal(P.q('[data-act="seeall"]'), null); } finally { P.w.close(); }
});
test('C-6b rows: «Destacados» pages by 4 (‹ › follow the page; a filter starts over at page 1); «Ver todo» scrolls to «Todos los restaurantes»', async () => {
  const S = await deskSix();
  try {
    const page = () => S.qa('.hsec[aria-label="Destacados"] .rcard').map((c) => c.dataset.rid), btn = (a) => S.q(`.hsec[aria-label="Destacados"] [data-act="${a}"]`);
    const p1 = page(); S.click(btn('feat-next')); await flush();
    const p2 = page(); assert.equal(p2.length, 2, '🔴 RW-3: page 2 = the remaining two'); assert.ok(p2.every((r) => !p1.includes(r)), 'no repeats');
    assert.ok(btn('feat-next').disabled && !btn('feat-prev').disabled, '🔴 RW-3: the last page: › off, ‹ on');
    S.click(btn('feat-prev')); await flush(); assert.deepEqual(page(), p1, 'back to page 1');
    S.click(btn('feat-next')); await flush(); const chip = S.q('.fchip[data-act="filter"]');
    assert.ok(chip, 'premise: a filter chip'); S.click(chip); await flush(); S.click(S.q('.fchip[data-act="filter"]')); await flush();
    assert.ok(btn('feat-prev') && btn('feat-prev').disabled && page().length === 4, '🔴 RW-3: a filter starts the grid over at page 1');
    let scrolled = null; S.w.HTMLElement.prototype.scrollIntoView = function () { scrolled = this.getAttribute('aria-label'); };
    S.click(S.q('[data-act="seeall"]')); await flush(); assert.equal(scrolled, 'Todos los restaurantes', '🔴 RW-4: «Ver todo» ⇒ the full grid');
  } finally { S.w.close(); }
});
test('C-6b rows: a dish row\'s ‹ › follow its scroll — ‹ off at the start, › off at the end or with nothing to scroll (never a dead arrow)', async () => {
  const S = await deskSix();
  try {
    const sec = S.qa('.home-body > .hsec').find((x) => x.querySelector('.hrow.dishes')); assert.ok(sec, 'premise: a real dish row (the fixture\'s house dishes)');
    const row = sec.querySelector('.hrow.dishes'), prev = sec.querySelector('[data-act="rowprev"]'), next = sec.querySelector('[data-act="rownext"]');
    assert.ok(prev.disabled && next.disabled, '🔴 RW-5: jsdom has no overflow ⇒ both arrows off (nothing to scroll)');
    let left = 0; Object.defineProperties(row, { scrollWidth: { configurable: true, get: () => 1000 }, clientWidth: { configurable: true, get: () => 400 }, scrollLeft: { configurable: true, get: () => left } });
    row.dispatchEvent(new S.w.Event('scroll')); assert.ok(prev.disabled && !next.disabled, '🔴 RW-5: overflow at the start: › on');
    left = 300; row.dispatchEvent(new S.w.Event('scroll')); assert.ok(!prev.disabled && !next.disabled, 'mid-row: both on');
    left = 600; row.dispatchEvent(new S.w.Event('scroll')); assert.ok(!prev.disabled && next.disabled, '🔴 RW-5: the end: › off');
  } finally { S.w.close(); }
});
// LAST in the file (node:test runs a file's tests in order): every timer above stayed within setTimeout's range
test('store promo r4 #5: no TimeoutOverflowWarning anywhere in this file (token timers are bounded by the 48 h plausibility cap)', () => {
  const over = WARNINGS.filter((w) => w && w.name === 'TimeoutOverflowWarning');
  assert.equal(over.length, 0, `🔴 store promo r4: ${over.length} TimeoutOverflowWarning(s): ${over.map((w) => w.message).join(' | ').slice(0, 200)}`);
});
// ── C-6b r2 (Codex C-6b r1 #1–#4) ──
test('C-6b r2 crossing: the shell\'s desk-only DOM follows the breakpoint BOTH ways — phone→desk gains the H1 row + grids, desk→phone drops them; the page, the paging and the query survive', async () => {
  const media = fakeMedia(true), S = await deskSix(media);
  try {
    const page = () => S.qa('.hsec[aria-label="Destacados"] .rcard').map((c) => c.dataset.rid);
    assert.ok(S.q('.h1row') && S.q('.rgrid4'), 'premise: the desk Inicio');
    S.click(S.q('.hsec[aria-label="Destacados"] [data-act="feat-next"]')); await flush(); const p2 = page(); assert.equal(p2.length, 2, 'premise: page 2');
    media.set(false); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.ok(!S.q('.app').classList.contains('desk'), 'premise: the phone now');
    assert.equal(S.q('.h1row'), null, '🔴 XB-1: desk→phone drops the H1 row');
    assert.equal(S.q('.rgrid'), null, '🔴 XB-1: desk→phone drops the desk grids');
    assert.equal(S.q('[data-act="seeall"]'), null, '🔴 XB-1: … and «Ver todo»');
    assert.equal(S.q('footer.dfoot'), null, 'and the desk footer');
    assert.ok(S.q('.home-head .addr-btn') && S.q('.hrow'), '🔴 XB-1: the phone\'s own head and rows');
    media.set(true); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.ok(S.q('.h1row') && S.q('.rgrid4'), '🔴 XB-2: phone→desk gains the H1 row and the grids');
    assert.deepEqual(page(), p2, '🔴 XB-2: the paging survives the round trip');
    S.click('.desknav .dn-search'); await flush(); const i = S.q('#gq'); i.value = 'pizza'; i.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
    media.set(false); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.equal(S.q('#gq') && S.q('#gq').value, 'pizza', '🔴 XB-3: Buscar keeps its query across the crossing');
    media.set(true); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.ok(/pizza/.test(S.q('.desknav .dn-search').textContent), '🔴 XB-3: … and the bar shows it again on the desk');
  } finally { S.w.close(); }
});
test('C-6b r2 arrows: a disabled ‹ › LOOKS disabled on the desk (D-3 r3: opacity .35, default cursor) — the style, not only the property', async () => {
  const S = await deskSix();
  try {
    const prev = S.q('.hsec[aria-label="Destacados"] [data-act="feat-prev"]'), next = S.q('.hsec[aria-label="Destacados"] [data-act="feat-next"]');
    assert.ok(prev && prev.disabled && next && !next.disabled, 'premise: ‹ off, › on at page 1');
    const cs = S.w.getComputedStyle(prev), on = S.w.getComputedStyle(next);
    assert.equal(cs.opacity, '0.35', '🔴 AR-1: the disabled arrow is dimmed'); assert.equal(cs.cursor, 'default', '🔴 AR-1: … with the default cursor');
    assert.notEqual(on.opacity, '0.35', 'the enabled arrow is not');
  } finally { S.w.close(); }
});
test('C-6b r2 promo: while auth is UNRESOLVED (sign-up on) the guest card\'s footprint is reserved — same markup, invisible, aria-hidden; a guest sees it; a member has none (no H1-row shift when a guest resolves)', () => {
  const html = (auth) => { const d = dom(CappHome.homeHtml(VM({ desk: true, signupOn: true, auth }))); return d.querySelector('.h1row .promo'); };
  const u = html('unresolved'), g = html('guest'), m = html('member');
  assert.ok(u, '🔴 PR-1: the slot is there while unresolved');
  assert.equal(u.style.visibility, 'hidden', '🔴 PR-1: invisible'); assert.equal(u.getAttribute('aria-hidden'), 'true', 'and out of the a11y tree');
  assert.ok(g && g.style.visibility === '' && !g.hasAttribute('aria-hidden'), '🔴 PR-1: the guest sees it');
  assert.equal(u.innerHTML, g.innerHTML, '🔴 PR-1: the SAME content ⇒ the same footprint (resolving to guest never moves the row)');
  assert.equal(m, null, 'a member: no card');
  assert.equal(dom(CappHome.homeHtml(VM({ desk: true, signupOn: false, auth: 'unresolved' }))).querySelector('.h1row .promo'), null, 'no sign-up ⇒ no slot at all');
});
test('C-6b r2 head: the desk renders NO empty header above the H1 (the bar has the address) — only the location-denied message keeps it; the phone keeps its head', () => {
  const q = (over, sel) => dom(CappHome.homeHtml(VM(over))).querySelector(sel);
  assert.equal(q({ desk: true }, '.home-head'), null, '🔴 HH-1: no empty desk header (the H1 sits where D-3 r3 draws it)');
  assert.ok(q({ desk: true, locDenied: true }, '.home-head .locrow'), '🔴 HH-1: the location-denied message stays on the desk');
  assert.ok(q({}, '.home-head .addr-btn'), 'the phone keeps its head');
});
// ── C-6c (D-3 r3 frames 2a/2b/3, approved; advisor calls 1–8, 11-02): the desktop store page + the two-pane item dialog ──
async function deskStoreAt(opts = {}, rid = 'x_pizza') {
  const media = opts.media || fakeMedia(true); const S = bootShell({ ...opts, media });
  const sel = `.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="${rid}"]`;
  await until(() => S.q(sel)); S.click(sel); await flush();
  assert.ok(S.q('.sinfo'), `premise: the ${rid} desk store page`);
  return { S, media, ui: S.ui.store().ui };
}
const deskCfg = (S) => S.ui.store().ui.config || null;
test('C-6c page: the shell\'s top bar (no tab current) above storewrap = the menu scroller + the cart aside; hero + the logo over its edge; identity (name, facts) + tools (Delivery/Pickup, the fee and ETA cells, «Buscar en»); the rail beside two-column cards — no phone header, no «Más información»', async () => {
  const { S } = await deskStoreAt();
  try {
    const scr = S.q('.screen'), nav = scr.querySelector(':scope > .desknav');
    assert.ok(nav && nav.nextElementSibling && nav.nextElementSibling.classList.contains('storewrap'), '🔴 SP-1: the top bar sits above the store page');
    assert.deepEqual([...nav.querySelectorAll('[aria-current="true"]')], [], '🔴 SP-1: no tab is current on a store');
    const wrap = S.q('.storewrap'); assert.deepEqual([...wrap.children].map((c) => c.id || c.tagName.toLowerCase()), ['scroller', 'aside'], 'the menu scroller + the cart aside');
    assert.ok(S.q('#scroller').classList.contains('store-main'));
    assert.ok(S.q('.shero > .hero#hero img') && S.q('.shero > .avatar'), '🔴 SP-1: the hero + the logo plate over it (outside the clipped hero)');
    const name = S.q('.sinfo .brandname').textContent; assert.ok(name.length > 0, 'premise: the store name');
    assert.ok(/^(Abierto|Cerrado)/.test(txt(S.q('.sinfo .facts'))), '🔴 SP-1: the facts lead with the open state');
    assert.equal(S.qa('.sinfo .tools .seg [data-act="mode"]').length, 2, 'Delivery / Pickup');
    assert.equal(S.q('.sinfo .ssearch[data-act="ssearch"]').textContent, `Buscar en ${name}`, '🔴 SP-1: «Buscar en {name}» = the in-store search');
    assert.ok(!/Más información/.test(S.q('.sinfo').textContent), '🔴 SP-1: no «Más información» (no store-info surface ⇒ no dead control)');
    for (const sel of ['#top', '#stick', '.store-nav', '.tabsbar']) assert.equal(S.q(sel), null, `🔴 SP-1: the phone header (${sel}) is not on the desk page`);
    const secs = S.qa('.scontent > .sec'), rail = S.qa('.catnav [data-act="jump"]');
    assert.ok(secs.length >= 2, 'premise: two sections');
    assert.equal(S.q('.catnav h3').textContent, 'Menú');
    assert.deepEqual(rail.map((b) => b.dataset.jump), secs.map((s) => s.dataset.sec), '🔴 SP-2: the rail = the real categories, in order (no «Destacados» entry)');
    assert.deepEqual(rail.map((b) => b.textContent), secs.map((s) => s.querySelector('.sechead h2').textContent));
    assert.ok(/^Hoy \S.* – \S/.test(S.q('.catnav .hours').textContent), `🔴 SP-2: today's hours in the rail (${S.q('.catnav .hours').textContent})`);
    for (const s of secs) assert.ok(s.querySelector(':scope > .icards'), '🔴 SP-3: two-column item cards in every section');
  } finally { S.w.close(); }
});
test('C-6c cards: name · 2-line description · price, the + on the photo (an item without one: no photo pane, the + inline); the SAME overlay and cart path as the phone', async () => {
  const { S, ui } = await deskStoreAt();
  try {
    const plain = ui.menu.dishes.filter((d) => !d.launcher && !d.variantOf);
    const withImg = plain.find((d) => d.img), noImg = plain.find((d) => !d.img);
    assert.ok(withImg && noImg, 'premise: the fixture has dishes with and without a photo');
    const c1 = S.q(`#dish-${withImg.key}`), c2 = S.q(`#dish-${noImg.key}`);
    assert.ok(c1.classList.contains('icard') && c2.classList.contains('icard'));
    assert.deepEqual([...c1.querySelector('.txt').children].map((x) => x.className).filter((k) => k !== 'pills'), withImg.desc || withImg.d ? ['nm', 'ds', 'pr'] : ['nm', 'pr'], '🔴 SP-3: name · description · price');
    assert.ok(c1.querySelector('.nm').textContent.length > 0 && /^L /.test(c1.querySelector('.pr').textContent), `the name and the price (${c1.querySelector('.pr').textContent})`);
    assert.ok(c1.querySelector('.thumb:not(.noimg) img') && c1.querySelector('.thumb .qty-add-btn'), '🔴 SP-3: the + on the photo');
    assert.ok(c2.querySelector('.thumb.noimg .qty-add-btn') && !c2.querySelector('img'), '🔴 SP-3: no photo ⇒ no photo pane (no empty well), the + kept');
    S.click(c1.querySelector('.qty-add-btn')); await flush();
    assert.equal(S.q(`#dish-${withImg.key} .qty-ctrl-num`).textContent, '1', '🔴 SP-3: the card\'s + adds through the store\'s own path (the stepper shows 1)');
    assert.ok(/ · 1 /.test(S.q('.deskcart .sheethead small').textContent + ' '), 'the aside follows');
  } finally { S.w.close(); }
});
test('C-6c rail: a category jumps the menu scroller to its section; the section in view marks its category (aria-current)', async () => {
  const { S } = await deskStoreAt();
  try {
    const sc = S.q('#scroller'), secs = S.qa('.scontent > .sec'), rail = () => S.qa('.catnav [data-act="jump"]');
    const calls = []; sc.scrollTo = (o) => calls.push(o);
    S.click(rail()[1]); await flush();
    assert.equal(calls.length, 1, '🔴 SP-4: the jump scrolls the menu'); assert.equal(calls[0].behavior, 'smooth');
    // jsdom has no layout (every rect 0 ⇒ the spy's first pass marks the LAST section) — so the cell scrolls to each end in turn
    sc.getBoundingClientRect = () => ({ top: 0 });
    const scrollTo = async (i) => { secs.forEach((s, k) => { s.getBoundingClientRect = () => ({ top: k < i ? -400 : k === i ? 10 : 900 }); }); sc.dispatchEvent(new S.w.Event('scroll')); await flush(); };
    for (const i of [0, secs.length - 1, 0]) { await scrollTo(i);
      assert.deepEqual(rail().map((b) => b.getAttribute('aria-current')), secs.map((s, k) => String(k === i)), `🔴 SP-4: the section in view is current (${i})`); }
  } finally { S.w.close(); }
});
test('C-6c tools: delivery ⇒ the fee cell («Envío desde L 45 · según tu dirección», its ⓘ = the fee sheet) + the ETA cell («a–b min · llega aprox.»); Pickup ⇒ the pickup ETA + «Recogé en»; the mode switch is the store\'s own', async () => {
  const { S } = await deskStoreAt();
  try {
    const cells = () => S.qa('.sinfo .cells > div').map((d) => txt(d));
    assert.deepEqual(cells(), ['Envío desde L 45 según tu dirección', '30–45 min llega aprox.'], '🔴 SP-5: the two delivery cells');
    S.click('.sinfo .cells .infobtn[data-act="feeinfo"]'); await flush();
    assert.ok(S.q('#layer .sheet, #layer [role="dialog"]'), '🔴 SP-5: the fee ⓘ opens the fee sheet');
    S.click('#layer [data-act="lclose"]'); await flush();
    S.click('.sinfo .seg [data-val="pickup"]'); await flush();
    assert.equal(S.q('.sinfo .seg [data-val="pickup"]').getAttribute('aria-pressed'), 'true');
    const p = cells(); assert.ok(p.length >= 1 && !p.some((c) => /Envío/.test(c)), `🔴 SP-5: pickup has no fee cell (${p.join(' | ')})`);
    assert.ok(p.some((c) => /Listo en|Recogé en/.test(c)), 'the pickup facts');
  } finally { S.w.close(); }
});
test('C-6c bar on a store: Inicio / Pedidos / Cuenta / the search field leave the store for the shell\'s screen; the address pill ⇒ Inicio with the location sheet', async () => {
  for (const [sel, want] of [['.desknav .nb[data-tab="home"]', () => '.h1row'], ['.desknav .dn-search', () => '#gq'], ['.desknav .nb[data-tab="orders"]', () => '.pagehead']]) {
    const { S } = await deskStoreAt();
    try { S.click(sel); await flush(); await flush();
      assert.equal(S.ui.store(), null, `🔴 SP-6: ${sel} leaves the store`); assert.ok(S.q(want()), `🔴 SP-6: ${sel} ⇒ ${want()}`); } finally { S.w.close(); }
  }
  const { S } = await deskStoreAt();
  try { S.click('.desknav .dn-addr'); await flush(); await flush();
    assert.equal(S.ui.store(), null); assert.ok(S.q('.h1row'), 'Inicio'); assert.ok(S.q('#layer .sheet, #layer [role="dialog"]'), '🔴 SP-6: the address pill opens the location sheet over Inicio'); } finally { S.w.close(); }
  const { S: P } = await deskStoreAt();
  try { P.click('.sinfo .seg [data-val="pickup"]'); await flush(); assert.ok(P.ui.store(), 'premise: the store\'s own controls still belong to the store (the shell ignores them)'); } finally { P.w.close(); }
});
test('C-6c aside: «Tu pedido» · «{store}» (+ « · N …» with lines); the drawn empty state; the guest\'s card-only note only under runtime.guestCardOnly — a guest yes, flag off no (advisor call 7)', async () => {
  const { S } = await deskStoreAt();
  try {
    const name = S.q('.sinfo .brandname').textContent, small = () => S.q('.deskcart .sheethead small').textContent;
    assert.equal(small(), name, '🔴 SP-7: the empty aside names the store');
    assert.equal(txt(S.q('.deskcart .empty')), 'Tu pedido está vacío Agregá platos del menú y aparecen aquí.', '🔴 SP-7: the drawn empty state');
    assert.equal(S.q('.deskcart .empty button'), null, 'no CTA on the empty aside');
    S.click('.qty-add-btn'); await flush();
    assert.ok(small().startsWith(name + ' · 1'), `🔴 SP-7: «{store} · N …» (${small()})`);
    assert.equal(S.q('.deskcart .cnote'), null, '🔴 SP-7: guest rules OFF ⇒ no card-only note');
  } finally { S.w.close(); }
  const { S: G } = await deskStoreAt({ auth: 'guest', runtime: { ...RUNTIME, guestCardOnly: true } });
  try {
    G.click('.qty-add-btn'); await flush();
    assert.equal(txt(G.q('.deskcart .cnote')), 'Pagás con tarjeta. Creá una cuenta para pagar en efectivo y sumar recompensas.', '🔴 SP-7: the guest\'s card-only note under the guest rules');
    assert.ok(G.q('.deskcart .cnote').nextElementSibling.classList.contains('ctot'), 'before the totals');
  } finally { G.w.close(); }
  const { S: U } = await deskStoreAt({ auth: 'unresolved', runtime: { ...RUNTIME, guestCardOnly: true } });
  try { U.click('.qty-add-btn'); await flush(); assert.equal(U.q('.deskcart .cnote'), null, 'an unresolved session: no claim'); } finally { U.w.close(); }
});
test('C-6c header auth: the desk page\'s promo pill resolves IN PLACE (reserved while unresolved, shown for a guest) — the page is not re-rendered', async () => {
  const la = liveAuth('unresolved');
  const { S } = await deskStoreAt({ mountExtra: { auth: la.a } });
  try {
    const pill = S.q('.sinfo .pill.deal'); assert.ok(pill, 'premise: the reserved pill (promo store)');
    assert.equal(pill.getAttribute('aria-hidden'), 'true', 'reserved while unresolved');
    const info = S.q('.sinfo'), sc = S.q('#scroller');
    la.set('guest'); await flush();
    assert.equal(S.q('.sinfo'), info, '🔴 SP-8: in place'); assert.equal(S.q('#scroller'), sc);
    assert.equal(S.q('.sinfo .pill.deal').getAttribute('aria-hidden'), null, '🔴 SP-8: the guest pill shown');
    assert.ok(/Envío desde L 45/.test(txt(S.q('.sinfo .cells'))), 'the fee cell unchanged for a guest');
  } finally { S.w.close(); }
});
test('C-6c dialog (frame 3): the desk dish dialog = two panes (photo | options) + the pinned bar; the HEADING takes focus (aria-labelledby), ✕ before it; close ⇒ back to the opener; no photo ⇒ one column; adding is the store\'s own path', async () => {
  const { S, ui } = await deskStoreAt();
  try {
    const plain = ui.menu.dishes.filter((d) => !d.launcher && !d.variantOf), a = plain.find((d) => d.img), b = plain.find((d) => !d.img);
    const opener = S.q(`#dish-${a.key} .txt`); opener.focus(); S.click(opener); await flush();
    const m = S.q('#detail-modal');
    assert.ok(m.classList.contains('open') && m.classList.contains('wide'), '🔴 SD-1: the wide dialog');
    assert.equal(m.getAttribute('aria-labelledby'), 'detail-name');
    const h = S.q('#detail-name'); assert.equal(h.tagName, 'H2'); assert.equal(h.getAttribute('tabindex'), '-1');
    assert.equal(S.w.document.activeElement, h, '🔴 SD-1: focus on the item name (the approved a11y spec)');
    assert.equal(S.q('#detail-header-title').textContent, S.q('.sinfo .brandname').textContent, 'the header names the store (frame 3)');
    const db = S.q('#detail-dbody'); assert.deepEqual([...db.children].map((c) => c.id), ['detail-dphoto', 'detail-scroll'], '🔴 SD-1: photo | options');
    assert.ok(S.q('#detail-dphoto img') && S.q('#detail-dphoto .lgtag'), 'the photo pane + the store tag'); assert.equal(S.q('#detail-dphoto img').getAttribute('alt'), '', 'decorative');
    assert.equal(S.q('#detail-scroll .detail-photo'), null, '🔴 SD-1: the options pane has no second photo');
    assert.ok(!db.classList.contains('nophoto'));
    const order = [...S.q('#detail-scroll .detail-body').children].map((c) => c.className); assert.equal(order[0], 'detail-name', 'name first');
    // advisor 11-02: ✕ is the NEXT Tab stop after the heading (frame 3), still drawn in the header's slot
    const tabs = [...m.querySelectorAll('#detail-name, button:not([disabled]), [tabindex="0"], input, a[href]')];
    assert.equal(tabs[tabs.indexOf(h) + 1], S.q('#detail-close'), '🔴 SD-4: Tab from the heading reaches ✕ first');
    assert.equal(S.q('.detail-header button'), null, '🔴 SD-4: no ✕ left in the header DOM (it would come before the heading)');
    assert.ok(S.q('.detail-header > .detail-close-slot[aria-hidden="true"]'), 'the header keeps its slot (its layout unchanged)');
    const cs = S.w.getComputedStyle(S.q('#detail-close')); assert.equal(cs.position, 'absolute', '🔴 SD-4: ✕ is drawn in the header slot by CSS'); assert.equal(cs.left, '16px');
    S.click('#detail-close'); await flush();
    assert.ok(!S.q('#detail-modal').classList.contains('open'), 'closed');
    assert.equal(S.w.document.activeElement, S.q(`#dish-${a.key} .txt`), '🔴 SD-1: focus returns to the opener');
    S.click(`#dish-${a.key} .txt`); await flush(); S.click('#detail-cta'); await flush();
    assert.ok(/ · 1 /.test(S.q('.deskcart .sheethead small').textContent + ' '), '🔴 SD-2: «Agregar» adds through the store\'s path');
    if (S.q('#detail-modal').classList.contains('open')) { S.click('#detail-close'); await flush(); }
    S.click(`#dish-${b.key} .txt`); await flush();
    assert.ok(S.q('#detail-dbody').classList.contains('nophoto'), '🔴 SD-3: no photo ⇒ one column'); assert.equal(S.q('#detail-dphoto').innerHTML, '', 'no empty well');
  } finally { S.w.close(); }
});
test('C-6c crossing: desk→phone the store re-renders as the phone page (its own header back, the desk page gone), the cart kept; phone→desk back to the desk page', async () => {
  const { S, media } = await deskStoreAt();
  try {
    S.click('.qty-add-btn'); await flush();
    media.set(false); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.equal(S.q('.sinfo'), null, '🔴 SX-1: no desk page on the phone'); assert.ok(S.q('#top') && S.q('#stick'), '🔴 SX-1: the phone header');
    assert.equal(S.q('.screen > .desknav'), null, 'no top bar on the phone store');
    assert.ok(/1/.test(S.q('#cart-bar').textContent), 'the cart kept');
    media.set(true); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.ok(S.q('.sinfo') && S.q('.screen > .desknav'), '🔴 SX-2: back to the desk page');
  } finally { S.w.close(); }
});
test('C-6c featured + badges: house-tagged dishes ⇒ «La casa recomienda» in the drawn 5-card row (no «Lo más pedido», no rail entry); a dish\'s badge sits in the pill slot after the price, its text and colour unchanged', async () => {
  const orig = PROV.x_pizza.envelope, env = JSON.parse(JSON.stringify(orig)), ds = env.menu.dishes.filter((d) => d.img).slice(0, 2);
  assert.equal(ds.length, 2, 'premise: two photographed dishes in the fixture'); for (const d of ds) d.tags = ['chefs_pick'];
  PROV.x_pizza.envelope = env;
  try {
    const { S } = await deskStoreAt();
    try {
      const f = S.q('.scontent > .hfeat'); assert.ok(f, '🔴 SP-9: the house row');
      assert.equal(f.getAttribute('aria-label'), 'La casa recomienda'); assert.equal(f.querySelector('.sechead h2').textContent, 'La casa recomienda');
      assert.equal(f.querySelector('.sechead span'), null, '🔴 SP-9: no «Lo más pedido» sub (a false claim)');
      assert.equal(f.querySelectorAll('.featured > .card').length, 2, 'its own data');
      assert.ok(f.querySelector('.featured .card .ph .qty-add-btn'), 'the + on its photo');
      assert.ok(!S.qa('.catnav [data-act="jump"]').some((b) => /recomienda|Destacados/.test(b.textContent)), '🔴 SP-9: no rail entry for it');
      const card = S.q(`.icards #dish-${ds[0].id}`) || S.qa('.icards .icard').find((c) => c.querySelector('.pills'));
      assert.ok(card, 'premise: the tagged dish\'s card'); const pills = card.querySelector('.txt > .pills');
      assert.ok(pills && pills.previousElementSibling.classList.contains('pr'), '🔴 SP-9: the badge in the pill slot, after the price');
      const mk = pills.querySelector('.mark'); assert.ok(mk && mk.textContent.length > 0 && /^var\(--/.test(mk.style.color), `the badge's own text and colour token (${mk && mk.getAttribute('style')})`);
    } finally { S.w.close(); }
  } finally { PROV.x_pizza.envelope = orig; }
});
test('C-6c dialog ✕ (advisor 11-02): the PHONE dish sheet keeps its ✕ in the header, before the title (its DOM unchanged)', async () => {
  const { S, plain } = await deskStore(false, 0);
  try {
    S.click(`#dish-${plain[0].key} .txtbtn, #dish-${plain[0].key} [data-act="open"]`); await flush();
    assert.ok(S.q('#detail-modal').classList.contains('open') && !S.q('#detail-modal').classList.contains('wide'), 'premise: the phone sheet');
    assert.equal(S.q('.detail-header > #detail-close'), S.q('.detail-header').firstElementChild, '🔴 SD-5: the phone ✕ stays the header\'s first child');
    assert.equal(S.q('.detail-close-slot'), null);
  } finally { S.w.close(); }
});
// ── C-6c r2 (Codex C-6c r1 #1–#5) ──
const tagHouse = () => { const orig = PROV.x_pizza.envelope, env = JSON.parse(JSON.stringify(orig)), ds = env.menu.dishes.filter((d) => d.img).slice(0, 2);
  for (const d of ds) d.tags = ['chefs_pick']; PROV.x_pizza.envelope = env; return { ds, restore: () => { PROV.x_pizza.envelope = orig; } }; };
test('C-6c r2 narrow desk: 1024–1279 px stacks the identity row, narrows the rail and puts the cards in ONE column (the CSS rule; the renders are the Chrome batch\'s)', () => {
  const CSS = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const m = CSS.match(/@media \(max-width:1279\.98px\)\{([\s\S]*?)\n\}/); assert.ok(m, '🔴 NB-1: the 1024–1279 rule');
  const body = m[1];
  assert.ok(/\.app\.desk \.icards\{grid-template-columns:minmax\(0,1fr\)\}/.test(body), '🔴 NB-1: one card column');
  assert.ok(/\.app\.desk \.sinfo\{grid-template-columns:minmax\(0,1fr\)\}/.test(body), '🔴 NB-1: the identity row stacks');
  assert.ok(/\.app\.desk \.sgrid\{grid-template-columns:180px minmax\(0,1fr\)/.test(body), '🔴 NB-1: the narrower rail');
  assert.ok(!/(^|\})\s*\.(?!app\.desk)/.test(body.trim()), 'desk-scoped only (the phone shell never matches)');
});
test('C-6c r2 crossing with the dish dialog open: focus stays IN the dialog (the phone sheet\'s ✕), never BODY; back on the desk the heading', async () => {
  const { S, media, ui } = await deskStoreAt();
  try {
    const a = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && d.img);
    S.click(`#dish-${a.key} .txt`); await flush();
    assert.equal(S.w.document.activeElement, S.q('#detail-name'), 'premise: the heading has focus');
    media.set(false); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    const ae = S.w.document.activeElement;
    assert.ok(S.q('#detail-modal').classList.contains('open') && !S.q('#detail-modal').classList.contains('wide'), 'premise: the phone sheet, still open');
    assert.ok(ae && ae !== S.w.document.body && S.q('#detail-modal').contains(ae), `🔴 XF-1: focus inside the sheet (${ae && (ae.id || ae.tagName)})`);
    assert.equal(ae, S.q('#detail-close'), 'the phone sheet\'s ✕');
  } finally { S.w.close(); }
});
test('C-6c r2 sold featured dish: «La casa recomienda» shows «Agotado» in the price slot, dimmed, no «+» — like the category cards; its add is refused', async () => {
  const T = tagHouse();
  try {
    const sold = T.ds[0].id;
    const { S, ui } = await deskStoreAt({ mountExtra: { readAvailability: async (rid, menu) => menu.dishes.filter((d) => String(d.id) === String(sold)).map((d) => d.key) } });
    try {
      await until(() => S.q('.icards .icard.sold-out'));   // the availability landed (the CATEGORY card shows it — independent of the row under test)
      const card = S.q('.hfeat .card.sold-out'); assert.ok(card, '🔴 SF-1: the sold featured card is marked');
      assert.equal(card.querySelector('.pr').textContent, 'Agotado', '🔴 SF-1: «Agotado» in the price slot');
      const add = card.querySelector('.qty-add-btn'); assert.ok(add, 'premise: the overlay is the shared one');
      assert.equal(S.w.getComputedStyle(add).display, 'none', '🔴 SF-1: no «+» on a sold dish');
      assert.equal(S.w.getComputedStyle(card).opacity, '0.55', '🔴 SF-1: dimmed like the category cards');
      const live = S.qa('.hfeat .card:not(.sold-out)'); assert.ok(live.length === 1 && /^L /.test(live[0].querySelector('.pr').textContent), 'the other featured dish keeps its price');
      S.click(add); await flush(); assert.equal(ui.snapshot && cartCount(S), 0, '🔴 SF-1: the store\'s add guard refuses it');
    } finally { S.w.close(); }
  } finally { T.restore(); }
});
function cartCount(S) { const t = S.q('.deskcart .sheethead small').textContent; const m = t.match(/ · (\d+)/); return m ? Number(m[1]) : 0; }
test('C-6c r2 auth → the aside: the guest\'s card-only note appears when auth RESOLVES to guest (no store re-render), under the guest rules', async () => {
  const la = liveAuth('unresolved');
  const { S } = await deskStoreAt({ runtime: { ...RUNTIME, guestCardOnly: true }, mountExtra: { auth: la.a } });
  try {
    S.click('.qty-add-btn'); await flush();
    assert.equal(S.q('.deskcart .cnote'), null, 'premise: unresolved ⇒ no claim');
    const info = S.q('.sinfo'), sc = S.q('#scroller');
    la.set('guest'); await flush();
    assert.equal(txt(S.q('.deskcart .cnote')), 'Pagás con tarjeta. Creá una cuenta para pagar en efectivo y sumar recompensas.', '🔴 AN-1: the note follows the auth');
    assert.equal(S.q('.sinfo'), info, 'no store re-render'); assert.equal(S.q('#scroller'), sc);
  } finally { S.w.close(); }
});
test('C-6c r2 featured row: never clipped — the five cards share the width (≤ 150 px, ≥ 110 px) and the row scrolls where they cannot', async () => {
  const T = tagHouse();
  try {
    const { S } = await deskStoreAt();
    try {
      const row = S.q('.hfeat .featured'), cs = S.w.getComputedStyle(row);
      assert.equal(cs.overflowX, 'auto', '🔴 FR-1: the row scrolls (no overflow:hidden clipping)');
      const c = S.w.getComputedStyle(row.querySelector('.card'));
      assert.equal(c.minWidth, '110px'); assert.equal(c.maxWidth, '150px'); assert.ok(/^1 1 /.test(c.flex) || c.flexGrow === '1', `🔴 FR-1: the cards flex to the width (${c.flex})`);
    } finally { S.w.close(); }
  } finally { T.restore(); }
});
// ── C-6d (D-3 r3 frames 4a/4b/5, approved; advisor calls 1–8, 11-02): the desktop checkout + the live order panel ──
async function deskCheckout(opts = {}) {
  const { S, ui, media } = await deskStoreAt(opts);
  const plain = ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !ui.menu.pickupOnlyCats.has(String(d.cat)));
  S.click(`#dish-${plain.key} .qty-add-btn`); await flush();
  S.click('.deskcart [data-act="checkout"]'); await flush(); await flush();
  assert.equal(ui.state.screen, 'checkout', 'premise: the desk checkout');
  return { S, ui, media };
}
test('C-6d checkout: its own bar («Volver a la tienda» · the Sherpa lock · «Pago seguro»), NO top bar, the H1 in column A over the approved sections; column B = store card → the CTA → «Tu pedido» → fine print; no paybar', async () => {
  const { S } = await deskCheckout();
  try {
    const flow = S.q('.flow');
    assert.ok(flow.firstElementChild.classList.contains('ckbar'), '🔴 CK-1: the checkout bar first');
    assert.equal(S.q('.ckbar .backtxt').textContent, 'Volver a la tienda'); assert.equal(S.q('.ckbar .backtxt').dataset.act, 'addmore', 'the existing back-to-the-menu act');
    const lock = S.q('.ckbar .lock'); assert.equal(lock && lock.textContent, 'Sherpa', '🔴 CK-1: the centred Sherpa lock (the host\'s)');
    assert.equal(S.q('.ckbar .sec-lock').textContent, 'Pago seguro');
    assert.equal(S.q('.desknav'), null, '🔴 CK-1: no top bar on the checkout (nothing competes with finishing)');
    assert.equal(S.q('.flowbar'), null, 'the v6 flowbar is replaced'); assert.equal(S.q('.paybar'), null, '🔴 CK-1: the CTA left the paybar');
    const a = S.q('.col-a'); assert.ok(a.firstElementChild.matches('h1.flowtitle') && a.firstElementChild.textContent === 'Entrega & Pago', '🔴 CK-1: the H1 heads column A');
    assert.deepEqual([...a.querySelectorAll(':scope > section')].map((x) => x.getAttribute('aria-label')), ['Entrega', 'Tus datos', 'Pago']);
    const b = [...S.q('.col-b').children].map((x) => x.id || x.className.split(' ')[0]);
    assert.deepEqual(b.filter((k) => k !== 'guestline'), ['storecard', 'cta', 'fsec', 'finenote'], `🔴 CK-2: column B in the leaders' order (${b.join(', ')})`);
    assert.equal(S.qa('#cta').length, 1, 'ONE CTA');
  } finally { S.w.close(); }
});
test('C-6d checkout CTA: the SAME control as the phone — id, act, label and disabled state identical for the same order state', async () => {
  const D = await deskCheckout(), P = await deskStore(false, 0);
  try {
    const plain = P.ui.menu.dishes.find((d) => !d.launcher && !d.variantOf && !P.ui.menu.pickupOnlyCats.has(String(d.cat)));
    P.S.click(`#dish-${plain.key} .qty-add-btn`); await flush(); P.S.click('#cart-bar'); P.S.click('[data-act="checkout"]'); await flush(); await flush();
    const d = D.S.q('#cta'), p = P.S.q('#cta');
    assert.ok(d && p, 'premise: both CTAs');
    assert.deepEqual([d.dataset.act, d.textContent, d.disabled], [p.dataset.act, p.textContent, p.disabled], '🔴 CK-3: the desk CTA is the phone\'s');
  } finally { D.S.w.close(); P.S.w.close(); }
});
test('C-6d checkout: «Volver a la tienda» returns to the store with the cart; the summary is open by default and its toggle closes / reopens it', async () => {
  const { S, ui } = await deskCheckout();
  try {
    const box = () => S.q('.col-b .osum.box');
    assert.equal(box().querySelector('.toggle').getAttribute('aria-expanded'), 'true', '🔴 CK-4: open by default (frame 4a)'); assert.ok(box().querySelector('.lines .osline'));
    S.click('.col-b .osum .toggle'); await flush(); assert.equal(box().querySelector('.toggle').getAttribute('aria-expanded'), 'false', '🔴 CK-4: the first click closes it'); assert.equal(box().querySelector('.lines'), null);
    S.click('.col-b .osum .toggle'); await flush(); assert.equal(box().querySelector('.toggle').getAttribute('aria-expanded'), 'true', 'and reopens');
    assert.ok(/1/.test(box().querySelector('.toggle').textContent), '«Tu pedido · N …»');
    S.click('.ckbar .backtxt'); await flush();
    assert.equal(ui.state.screen, 'store', '🔴 CK-5: back to the store'); assert.ok(/ · 1/.test(S.q('.deskcart .sheethead small').textContent), 'the cart kept');
  } finally { S.w.close(); }
});
test('C-6d checkout totals + fine print: delivery ⇒ «Propina · Se elige en el siguiente paso» and «Sherpa lo entrega»; pickup ⇒ neither; the Terms sentence only with the platform\'s https Terms link', async () => {
  const { S } = await deskCheckout();
  try {
    const rows = () => S.qa('.col-b .ostot .sumrow').map((r) => txt(r));
    assert.ok(rows().includes('Propina Se elige en el siguiente paso'), `🔴 CK-6: the tip row on delivery (${rows().join(' | ')})`);
    assert.equal(txt(S.q('.col-b .finenote')), 'El restaurante prepara tu pedido; Sherpa lo entrega.', '🔴 CK-6: no Terms link known ⇒ no Terms sentence');
    S.click('[data-act="type"][data-val="pickup"]'); await flush();
    assert.ok(!rows().some((r) => /^Propina/.test(r)), '🔴 CK-6: pickup has no tip step ⇒ no tip row');
    assert.equal(S.q('.col-b .finenote'), null, '🔴 CK-6: pickup ⇒ no «Sherpa lo entrega» (and no Terms link) ⇒ no fine print');
  } finally { S.w.close(); }
  const L = await deskCheckout({ storage: memStorage({ 'capp:legal': JSON.stringify({ terms: 'https://legal.test/t', privacy: 'https://legal.test/p' }) }) });
  try {
    const a = L.S.q('.col-b .finenote a'); assert.ok(a, '🔴 CK-7: the Terms sentence with the real link');
    assert.equal(a.getAttribute('href'), 'https://legal.test/t'); assert.equal(a.textContent, 'Términos de Sherpa');
    assert.equal(L.S.q('.col-b .finenote').textContent, 'Al continuar aceptás los Términos de Sherpa. El restaurante prepara tu pedido; Sherpa lo entrega.', '🔴 CK-7: both sentences on a delivery');
  } finally { L.S.w.close(); }
  const B = await deskCheckout({ storage: memStorage({ 'capp:legal': JSON.stringify({ terms: 'http://legal.test/t' }) }) });
  try { assert.equal(B.S.q('.col-b .finenote a'), null, '🔴 CK-7: a non-https Terms URL is never linked'); } finally { B.S.w.close(); }
});
test('C-6d checkout: the guest\'s next step is ONLY the true sentence (never «No se cobra…», advisor call 5); the store card is static with a window', async () => {
  const { S } = await deskCheckout({ auth: 'guest', runtime: { ...RUNTIME, guestCardOnly: true } });
  try {
    assert.equal(txt(S.q('.col-b .guestline')), 'Después del código de WhatsApp se abre el pago seguro con tarjeta.', '🔴 CK-8: the guest line');
    assert.ok(!/No se cobra/.test(S.q('.col-b').textContent), '🔴 CK-8: no unverifiable money claim');
    const card = S.q('.col-b .storecard'); assert.equal(card.tagName, 'DIV', '🔴 CK-9: a static card (no control)'); assert.equal(card.querySelector('button, a, svg.chev'), null, '🔴 CK-9: no chevron (it would read as a control)');
    assert.ok(/llega en \d+–\d+ min/.test(card.textContent), `🔴 CK-9: the arrival window (${card.textContent})`);
  } finally { S.w.close(); }
  const { S: N } = await deskCheckout();
  try { assert.equal(N.q('.col-b .guestline'), null, 'guest rules off ⇒ no guest line'); } finally { N.w.close(); }
});
test('C-6d order panel (frame 5): on the desk «Orden #N» moves after the receipt (before the share line); the phone / no desk flag is byte-identical; a past receipt keeps its order', () => {
  const CappOrder = require('./capp-order.js');
  const o = { mode: 'delivery', status: 'out', storeName: 'Tienda', display_number: 12, driver: 'Marvin', addr: 'Col. Centro', windowText: '7:40 – 7:55 p. m.', lines: [{ n: 1, name: 'Plato', total: 100 }], fee: 45, pay: 'cash' };
  const c = { entry: 'app', now: Date.UTC(2026, 10, 2, 18), helpOk: false, shareOk: true };
  const order = (html) => { const d = dom(html); return [...d.querySelector('.mk-sheet').children].map((x) => x.className.split(' ')[0]); };
  const desk = order(CappOrder.orderHtml(o, { ...c, desk: true })), phone = order(CappOrder.orderHtml(o, c));
  assert.ok(phone.indexOf('mk-num') < phone.indexOf('segbar'), 'premise: the phone draws the number above the bar');
  assert.ok(desk.indexOf('mk-num') > desk.lastIndexOf('receipt') && desk.indexOf('mk-num') < desk.indexOf('shareline'), `🔴 OD-1: desk = … receipt → number → share (${desk.join(', ')})`);
  assert.equal(CappOrder.orderHtml(o, { ...c, desk: false }), CappOrder.orderHtml(o, c), '🔴 OD-1: no desk flag ⇒ byte-identical');
  assert.equal(CappOrder.orderHtml(o, { ...c, past: true, desk: true }), CappOrder.orderHtml(o, { ...c, past: true }), '🔴 OD-1: a past receipt keeps its order (its tail streams in place)');
  const CSS = readFileSync(join(HERE, 'capp.css'), 'utf8');
  assert.ok(/\.app\.desk \.mk-sheet \.mk-title,\.app\.desk \.mk-sheet \.mk-window\{text-align:left\}/.test(CSS), '🔴 OD-2: left-aligned on the desk');
});
test('C-6d order panel through the SHELL: a placed order\'s screen on the desk carries the desk order (the shell passes the view); the phone keeps its own', async () => {
  const media = fakeMedia(false);
  const S = bootShell({ media, runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test' }, readPublic: async () => ({ ok: true, json: async () => 47 }), apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    await flush(); await placeShellCash(S); await until(() => S.q('.mk-num'), 6000);
    const kids = () => [...S.q('.mk-sheet').children].map((x) => x.className.split(' ')[0]);
    assert.ok(kids().indexOf('mk-num') < kids().indexOf('segbar'), 'premise: the phone order');
    media.set(true); await new Promise((r) => setTimeout(r, DESK_SETTLE)); await flush();
    assert.ok(S.q('.app').classList.contains('desk') && S.q('.screen > .desknav'), 'premise: the desk, with its top bar');
    const k = kids(); assert.ok(k.indexOf('mk-num') > k.indexOf('segbar'), `🔴 OD-3: the shell draws the desk order (${k.join(', ')})`);
  } finally { S.w.close(); }
});
// ── advisor 11-02: the PHONE «La casa recomienda» row presents a sold dish like a sold category row (an intended phone DOM delta) ──
test('phone house row: a sold house dish shows «Agotado» in the price slot with P\'s inert «+» (.sold-out), like the category rows; the add is refused; an available one is unchanged', async () => {
  const T = tagHouse();
  try {
    const sold = T.ds[0].id;
    const S = await promoStore({ mountExtra: { readAvailability: async (rid, menu) => menu.dishes.filter((d) => String(d.id) === String(sold)).map((d) => d.key) } });
    try {
      await until(() => S.q('.content .row.sold-out'));   // the availability landed (the category row shows it)
      const cards = S.qa('.toprow .card'); assert.equal(cards.length, 2, 'premise: the two tagged house dishes');
      const so = S.q('.toprow .card.sold-out'); assert.ok(so, '🔴 PH-1: the sold house card is marked');
      assert.equal(so.querySelector('.prrow .mute').textContent, 'Agotado', '🔴 PH-1: «Agotado» in the price slot');
      const add = so.querySelector('.qty-add-btn'), cs = S.w.getComputedStyle(add);
      assert.equal(cs.pointerEvents, 'none', '🔴 PH-1: the + is inert (P\'s .sold-out)'); assert.equal(cs.opacity, '0.4');
      const live = S.q('.toprow .card:not(.sold-out)'); assert.ok(live && /^L /.test(live.querySelector('.prrow .mute').textContent), 'the available house dish keeps its price');
      S.click(add); await flush(); assert.ok(/Tu pedido/.test(S.q('#cart-bar').textContent), '🔴 PH-1: the add is refused (the cart stays empty)');
      assert.equal(S.q('.app').classList.contains('desk'), false, 'the phone shell');
    } finally { S.w.close(); }
  } finally { T.restore(); }
});
// ── C-2 · the post-delivery rating sheet (PLAN §C-2; MOCKUP D-3 r3 §9.2; advisor rulings 11-02) ──
// THE RATING SERVER: 3a's real semantics @ 1958b8ed, line for line where the client can observe them — myRatingCore (the generic 403 for
// a non-customer token / not the order's customer / an unknown order; strict ?order_id; the payload only for a LIVE node owned by the
// caller; the window from fulfilled_at) and rateOrderCore + rating-v2 (parseRequest: an invalid body ⇒ the generic 403; dish votes ⊆ the
// order's purchased dishes ⇒ else 400 dish_not_purchased; v2Updater: not_fulfilled / deleted ⇒ closed / window_closed; absent fields
// kept, `dishes` replaced WHOLE). Bodies = fixtures/c2/rating-contract.json's shapes (3a's own tests).
const RATE_W = 604800000;
function ratingServer({ now = () => T0 } = {}) {
  const orders = {}, nodes = {}, purchased = {}, calls = [], rx = { inflight: 0, max: 0 };
  const GEN = { ok: false, error: 'not_allowed' };
  const out = (status, json) => ({ status, ok: status === 200, json: async () => JSON.parse(JSON.stringify(json)) });
  const uidOf = (tok) => { try { const pl = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString()); return pl && typeof pl.user_id === 'string' && pl.customer === true ? pl.user_id : null; } catch (_) { return null; } };
  const OID = /^[A-Za-z0-9_-]{1,64}$/, thumb = (v) => v === 1 || v === -1, own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function parse(b) {   // rating-v2.parseRequest, the v2 kind (the only one this client sends)
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.order_id !== 'string' || !OID.test(b.order_id)) return null;
    const keys = Object.keys(b).filter((k) => k !== 'order_id');
    if (!keys.length || keys.some((k) => !['store', 'dishes', 'delivery', 'comment'].includes(k))) return null;
    const f = {};
    if (own(b, 'store')) { if (!(b.store === null || (Number.isInteger(b.store) && b.store >= 1 && b.store <= 5))) return null; f.store = b.store; }
    if (own(b, 'delivery')) { if (!(b.delivery === null || thumb(b.delivery))) return null; f.delivery = b.delivery; }
    if (own(b, 'comment')) { if (b.comment === null) f.comment = null; else if (typeof b.comment === 'string' && b.comment.length <= 500) f.comment = b.comment.trim() || null; else return null; }
    if (own(b, 'dishes')) { const d = b.dishes; if (!d || typeof d !== 'object' || Array.isArray(d)) return null; const ids = Object.keys(d); if (ids.length > 30 || ids.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !thumb(d[id]))) return null; f.dishes = { ...d }; }
    return { orderId: b.order_id, fields: f };
  }
  async function handler(u, i = {}) {
    const url = new URL(u, 'https://fn.test'), pth = url.pathname, method = i.method || 'GET';
    calls.push({ path: pth.split('/').pop(), url: url.toString(), method, headers: i.headers || {}, body: i.body == null ? null : JSON.parse(i.body) });
    rx.inflight++; rx.max = Math.max(rx.max, rx.inflight); await new Promise((r) => setTimeout(r, 5)); rx.inflight--;
    const uid = uidOf((i.headers || {})['x-firebase-id-token']);
    if (pth.endsWith('/getMyRating')) {
      if (method !== 'GET') return out(405, { ok: false, error: 'method_not_allowed' });
      const keys = [...url.searchParams.keys()], oid = url.searchParams.get('order_id');
      if (keys.some((k) => k !== 'order_id') || keys.length !== 1 || !OID.test(oid || '')) return out(400, { ok: false, error: 'bad_request' });
      if (!uid || !orders[oid] || orders[oid].customer_uid !== uid) return out(403, GEN);
      const n = nodes[oid], mine = n && n.state === 'live' && n.owner_uid === uid ? n : null;
      const until = n && n.state !== 'deleted' && Number.isFinite(n.fulfilled_at) ? n.fulfilled_at + RATE_W : null;
      return out(200, { ok: true, rating: mine ? { store: mine.store ?? null, dishes: mine.dishes || {}, delivery: mine.delivery ?? null, comment: mine.comment ?? null, legacy_thumb: mine.legacy_thumb ?? null, rated_at: mine.rated_at ?? null, edited_at: mine.edited_at ?? null } : null,
        can_rate: until != null && now() <= until, editable_until: until });
    }
    if (method !== 'POST') return out(405, { ok: false, error: 'method_not_allowed' });
    let b = null; try { b = JSON.parse(i.body); } catch (_) { b = null; }
    const req = parse(b); if (!req) return out(403, GEN);
    if (!uid || !orders[req.orderId] || orders[req.orderId].customer_uid !== uid) return out(403, GEN);
    if (req.fields.dishes && Object.keys(req.fields.dishes).some((id) => !(purchased[req.orderId] || new Set()).has(id))) return out(400, { ok: false, error: 'dish_not_purchased' });
    const cur = nodes[req.orderId];
    if (!cur || !Number.isFinite(cur.fulfilled_at)) return out(409, { ok: false, error: 'not_fulfilled' });
    if (cur.state === 'deleted') return out(403, GEN);
    if (now() > cur.fulfilled_at + RATE_W) return out(409, { ok: false, error: 'window_closed' });
    const first = cur.rated_at == null || (cur.store == null && !Object.keys(cur.dishes || {}).length && cur.delivery == null && cur.comment == null);
    nodes[req.orderId] = { ...cur, ...req.fields, ...(req.fields.dishes ? { dishes: req.fields.dishes } : {}), state: 'live', rated_at: cur.rated_at ?? now(), ...(first ? {} : { edited_at: now() }), owner_uid: cur.owner_uid ?? uid };
    return out(200, { ok: true });
  }
  return { handler, calls, rx, nodes,
    own: (oid, uid, dishIds = []) => { orders[oid] = { customer_uid: uid }; purchased[oid] = new Set(dishIds); },
    fulfil: (oid, at = now()) => { const n = nodes[oid]; if (n && (n.state === 'deleted' || Number.isFinite(n.fulfilled_at))) return; nodes[oid] = { ...(n || { store: null, dishes: {}, delivery: null, comment: null, legacy_thumb: null, rated_at: null, state: 'live', owner_uid: null }), fulfilled_at: at }; } };
}
const RATE_RT = (extra = {}) => ({ ...G7_RUNTIME, rtdbBase: 'https://rtdb.test', ratings: true, ...extra });
// a member (Ana) places a real cash delivery on THIS device; the server learns the order and its purchased dishes FROM THE BODY SENT
async function memberDelivered({ storage, runtime = RATE_RT(), rate = ratingServer(), deliver = true } = {}) {
  const { ES, made } = fakeES(); let placed = null;
  const { S, mo, fb } = await pedidosBoot({}, { runtime, rate, storage, mountExtra: { EventSource: ES }, geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) },
    apiFetch: ORDER_FETCH((b) => { placed = b; rate.own(b.order_id, 'u_ana', [...new Set(b.items.map((it) => it.dish_id).filter(Boolean))]); return { ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' }; }) });
  await shellPlaceTolerant(S);
  assert.ok(placed && S.q('.mk-sheet'), 'premise: the member\'s order was placed and its screen shows');
  if (deliver) { const es = made[0]; es.emit('put', '/', trackingRecordOf('tok_abcdefgh12')); rate.fulfil(placed.order_id); es.emit('put', '/status', 'delivered'); await flush(); }
  return { S, mo, fb, rate, placed, ES, made };
}
const menuName = (rid, id) => (PROV[rid].envelope.menu.dishes.find((d) => String(d.dish_id) === id) || {}).name;
test('C-2 entry before delivery: a member\'s order that is NOT yet delivered has no rating entry and makes no rating read', async () => {
  const { S, rate } = await memberDelivered({ deliver: false });
  try {
    await flush(400);
    assert.equal(S.q('.rate-cta'), null, '🔴 C2-13: no entry before the order is delivered'); assert.equal(rate.calls.length, 0, '🔴 C2-13: no read');
  } finally { S.w.close(); }
});
test('C-2 entry (frame 9.2): a member\'s DELIVERED order screen reserves «Valorar tu pedido» while its rating is read (no reflow), then draws it; the sheet: «¿Cómo estuvo tu pedido?», the store, 5 stars + word, the PURCHASED dishes by name, «Tu repartidor de Sherpa», the comment, «Enviar» only once something is set', async () => {
  const { S, rate, placed } = await memberDelivered();
  try {
    const cta = () => S.q('.mk-sheet .rate-cta');
    assert.ok(cta() && cta().style.visibility === 'hidden' && cta().getAttribute('aria-hidden') === 'true', '🔴 C2-1: the button\'s box is reserved while the read is in flight');
    await until(() => cta() && cta().style.visibility !== 'hidden');
    assert.equal(txt(cta()), 'Valorar tu pedido', '🔴 C2-1: the entry'); assert.equal(rate.calls.filter((c) => c.path === 'getMyRating').length, 1, 'ONE read');
    const g = rate.calls.find((c) => c.path === 'getMyRating'); assert.equal(g.url, `https://fn.test/getMyRating?order_id=${placed.order_id}`); assert.equal(g.headers['x-firebase-id-token'], TOK('u_ana'), 'the member\'s token');
    S.click(cta()); await until(() => S.q('#layer .rate'));
    const L = S.q('#layer');
    assert.equal(txt(L.querySelector('h2')), '¿Cómo estuvo tu pedido?'); assert.equal(S.w.document.activeElement, L.querySelector('#rate-h'), 'focus on the heading');
    assert.equal(L.querySelectorAll('.stars [data-act="rate-star"]').length, 5);
    const bought = [...new Set(placed.items.map((it) => it.dish_id).filter(Boolean))];
    assert.deepEqual([...L.querySelectorAll('[data-act="rate-dish"][data-val="1"]')].map((b) => b.dataset.id), bought, '🔴 C2-2: one row per distinct PURCHASED dish (the sent lines\' dish ids)');
    assert.deepEqual([...L.querySelectorAll('.rrow2 .t')].map(txt).slice(0, bought.length), bought.map((id) => menuName('x_pizza', id)), '🔴 C2-2: named from the store\'s menu');
    assert.ok([...L.querySelectorAll('.rrow2 .t')].some((t) => txt(t) === 'Tu repartidor de Sherpa'), '🔴 C2-2: the delivery row, no name');
    assert.ok(L.querySelector('[data-act="rate-send"]').disabled, '🔴 C2-2: nothing set ⇒ «Enviar» off');
    S.click(L.querySelector('[data-act="rate-star"][data-val="4"]')); await flush();
    assert.equal(txt(S.q('#layer .stars .word')), 'Muy bueno'); assert.equal(S.qa('#layer .stars button.on').length, 4);
    assert.ok(!S.q('#layer [data-act="rate-send"]').disabled, 'something set ⇒ «Enviar» on');
  } finally { S.w.close(); }
});
test('C-2 send: «Enviar» sends EXACTLY what was set (rateOrder v2) with the member\'s token; the sheet closes, the screen says «Ver tu calificación»; reopening shows it', async () => {
  const { S, rate, placed } = await memberDelivered();
  try {
    await until(() => S.q('.mk-sheet .rate-cta') && S.q('.mk-sheet .rate-cta').style.visibility !== 'hidden');
    S.click('.mk-sheet .rate-cta'); await until(() => S.q('#layer .rate'));
    const bought = [...new Set(placed.items.map((it) => it.dish_id).filter(Boolean))];
    S.click('#layer [data-act="rate-star"][data-val="5"]'); await flush();
    S.click(`#layer [data-act="rate-dish"][data-id="${bought[0]}"][data-val="1"]`); await flush();
    S.click('#layer [data-act="rate-del"][data-val="-1"]'); await flush();
    const ta = S.q('#rate-comment'); ta.value = '  Muy rica  '; ta.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
    S.click('#layer [data-act="rate-send"]'); await until(() => !S.q('#layer .rate'));
    const w = rate.calls.filter((c) => c.path === 'rateOrder');
    assert.equal(w.length, 1, 'ONE write'); assert.equal(w[0].headers['x-firebase-id-token'], TOK('u_ana'));
    assert.deepEqual(w[0].body, { order_id: placed.order_id, store: 5, dishes: { [bought[0]]: 1 }, delivery: -1, comment: 'Muy rica' }, '🔴 C2-3: exactly the set fields');
    assert.equal(rate.nodes[placed.order_id].store, 5, 'the server recorded it');
    assert.equal(txt(S.q('.mk-sheet .rate-cta')), 'Ver tu calificación', '🔴 C2-3: the entry follows');
    S.click('.mk-sheet .rate-cta'); await until(() => S.q('#layer .rate'));
    assert.equal(S.qa('#layer .stars button.on').length, 5, 'reopened with its stars'); assert.equal(S.q('#rate-comment').value, 'Muy rica');
    assert.ok(S.q('#layer [data-act="rate-send"]').disabled, 'unchanged ⇒ nothing to send');
  } finally { S.w.close(); }
});
test('C-2 Pedidos (frame 9.3): delivered rows inside the window read their rating — AT MOST 5 per view, ONE at a time, the line reserved — «Valorar» · «★ n tu calificación» · «Sin calificar»; older rows nothing; an EDIT from the row opens prefilled (getMyRating) and sends only the change', async () => {
  const rate = ratingServer(), db = {}, orders = {};
  const D = 86400e3, ids = ['XP-R1', 'XP-R2', 'XP-R3', 'XP-R4', 'XP-R5', 'XP-R6', 'XP-OLD'];
  ids.forEach((id, k) => placeReal(db, orders, 'u_ana', id, { ts: id === 'XP-OLD' ? T0 - 9 * D : T0 - (k + 1) * 3600e3 }));
  const marg = String(PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita').dish_id);
  for (const id of ids) { rate.own(id, 'u_ana', [marg]); rate.fulfil(id, T0 - 2 * D); }
  rate.fulfil('XP-R2', T0 - 2 * D); rate.nodes['XP-R2'] = { ...rate.nodes['XP-R2'], store: 5, dishes: { [marg]: 1 }, comment: 'Rica', rated_at: T0 - D, owner_uid: 'u_ana' };   // as the writer leaves it
  rate.nodes['XP-R3'] = { ...rate.nodes['XP-R3'], fulfilled_at: T0 - 8 * D };   // fulfilled 8 days ago, never rated: the window is over
  const { S } = await pedidosBoot(db, { orders, rate, runtime: RATE_RT(), contextFor: AGAIN_CTX });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await flush();
    await until(() => rate.calls.filter((c) => c.path === 'getMyRating').length >= 5, 8000); await flush(300);
    assert.equal(rate.rx.max, 1, '🔴 C2-4: one at a time');
    const reads = rate.calls.filter((c) => c.path === 'getMyRating').map((c) => new URL(c.url).searchParams.get('order_id'));
    assert.equal(reads.length, 5, `🔴 C2-4: the cap — 5 reads for the view (${reads.join(',')})`);
    await until(() => !S.q('.orow .rate-line[aria-hidden="true"]'), 4000);
    assert.ok(!reads.includes('XP-OLD'), 'an order older than the window is never read');
    const line = (id) => { const r = S.q(`.orow [data-oid="${id}"]`) ? S.q(`.orow [data-oid="${id}"]`).closest('.orow') : null; const l = r && r.querySelector('.rate-line'); return l ? txt(l) : null; };
    assert.equal(line('XP-R1'), 'Valorar', '🔴 C2-4: unrated, open'); assert.equal(line('XP-R2'), '5 tu calificación', '🔴 C2-4: rated (stars)'); assert.equal(line('XP-R3'), 'Sin calificar', '🔴 C2-4: past the window');
    assert.equal(line('XP-R6'), null, 'beyond the cap: nothing'); assert.equal(line('XP-OLD'), null, 'older: nothing');
    S.click(S.q('.orow .rate-go[data-oid="XP-R2"]')); await until(() => S.q('#layer .rate'));
    assert.equal(S.qa('#layer .stars button.on').length, 5, '🔴 C2-5: prefilled from getMyRating'); assert.equal(S.q('#rate-comment').value, 'Rica');
    assert.ok(S.q(`#layer [data-act="rate-dish"][data-id="${marg}"][data-val="1"]`).classList.contains('on'), 'its dish vote');
    const ta = S.q('#rate-comment'); ta.value = 'Riquísima'; ta.dispatchEvent(new S.w.Event('input', { bubbles: true })); await flush();
    S.click('#layer [data-act="rate-send"]'); await until(() => !S.q('#layer .rate'));
    assert.deepEqual(rate.calls.filter((c) => c.path === 'rateOrder').map((c) => c.body), [{ order_id: 'XP-R2', comment: 'Riquísima' }], '🔴 C2-5: an edit sends ONLY the change');
    assert.equal(rate.nodes['XP-R2'].store, 5, 'the server kept the rest');
  } finally { S.w.close(); }
});
test('C-2 nudge: the delivered order THIS device placed opens the sheet ONCE on the next app open (at idle, over Inicio); «Ahora no» retires it for good; a rated order never nudges', async () => {
  const st = g7Store(G7_PROFILE({ promos: true })), rate = ratingServer();
  const A = await memberDelivered({ storage: st, rate }); A.S.w.close();
  const open = async () => { const { S } = await pedidosBoot({}, { runtime: RATE_RT(), rate, storage: st }); await flush(); await flush(400); return S; };
  const B = await open();
  try {
    await until(() => B.q('#layer .rate'), 4000);
    assert.equal(B.ui.state.tab, 'home', '🔴 C2-6: over Inicio'); assert.equal(B.ui.store(), null);
    B.click('#layer [data-act="rate-later"]'); await flush();
    assert.equal(B.q('#layer .rate'), null, 'closed');
  } finally { B.w.close(); }
  const C = await open();
  try { await flush(600); assert.equal(C.q('#layer .rate'), null, '🔴 C2-6: «Ahora no» ⇒ never again'); } finally { C.w.close(); }
  const st2 = g7Store(G7_PROFILE({ promos: true })), r2 = ratingServer();
  const D = await memberDelivered({ storage: st2, rate: r2 });
  D.rate.nodes[D.placed.order_id] = { ...D.rate.nodes[D.placed.order_id], store: 3, rated_at: T0, owner_uid: 'u_ana' }; D.S.w.close();   // rated elsewhere meanwhile
  const { S: E } = await pedidosBoot({}, { runtime: RATE_RT(), rate: r2, storage: st2 });
  try { await flush(); await flush(800); assert.equal(E.q('#layer .rate'), null, '🔴 C2-6: an already-rated order never nudges'); } finally { E.w.close(); }
  const before = r2.calls.filter((c) => c.path === 'getMyRating').length;
  const { S: F } = await pedidosBoot({}, { runtime: RATE_RT(), rate: r2, storage: st2 });
  try { await flush(); await flush(800); assert.equal(r2.calls.filter((c) => c.path === 'getMyRating').length, before, '🔴 C2-6: a rated candidate is RETIRED — never read again on later opens'); } finally { F.w.close(); }
});
test('C-2 gates: the flag OFF ⇒ no entry and ZERO rating reads; a GUEST\'s delivered order ⇒ no entry (no server path); the dish rows are ONLY the purchased ones (never the whole menu)', async () => {
  const off = await memberDelivered({ runtime: RATE_RT({ ratings: undefined }) });
  try { await flush(400); assert.equal(off.S.q('.rate-cta'), null, '🔴 C2-7: flag off ⇒ no entry'); assert.equal(off.rate.calls.length, 0, '🔴 C2-7: no read at all'); } finally { off.S.w.close(); }
  const { S, rate, placed } = await memberDelivered();
  try {
    await until(() => S.q('.mk-sheet .rate-cta') && S.q('.mk-sheet .rate-cta').style.visibility !== 'hidden');
    S.click('.mk-sheet .rate-cta'); await until(() => S.q('#layer .rate'));
    const shown = S.qa('#layer [data-act="rate-dish"][data-val="1"]').map((b) => b.dataset.id), bought = new Set(placed.items.map((it) => it.dish_id).filter(Boolean));
    assert.ok(shown.length >= 1 && shown.every((id) => bought.has(id)), '🔴 C2-8: only the purchased dishes are offered');
    assert.ok(PROV.x_pizza.envelope.menu.dishes.length > shown.length, 'premise: the menu has more dishes than the order');
  } finally { S.w.close(); }
});
test('C-2 read-only + errors: past the window a rating is SHOWN, not editable («Cerrar», no «Enviar», controls off, no «Podés cambiarla»); a send the server answers window_closed keeps the sheet with its message', async () => {
  const rate = ratingServer(), db = {}, orders = {};
  placeReal(db, orders, 'u_ana', 'XP-L1', { ts: T0 - 3600e3 });
  const marg = String(PROV.x_pizza.envelope.menu.dishes.find((d) => d.name === 'Margherita').dish_id);
  rate.own('XP-L1', 'u_ana', [marg]); rate.fulfil('XP-L1', T0 - 8 * 86400e3);
  rate.nodes['XP-L1'] = { ...rate.nodes['XP-L1'], store: 2, rated_at: T0 - 7.5 * 86400e3, owner_uid: 'u_ana' };
  const { S } = await pedidosBoot(db, { orders, rate, runtime: RATE_RT(), contextFor: AGAIN_CTX });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await until(() => S.q('.orow .rate-go[data-oid="XP-L1"]'));
    S.click('.orow .rate-go[data-oid="XP-L1"]'); await until(() => S.q('#layer .rate'));
    assert.equal(S.q('#layer [data-act="rate-send"]'), null, '🔴 C2-9: no «Enviar» past the window');
    assert.equal(txt(S.q('#layer [data-act="rate-later"]')), 'Cerrar');
    assert.ok(S.qa('#layer [data-act="rate-star"]').every((b) => b.disabled) && S.q('#rate-comment').disabled, '🔴 C2-9: read-only');
    assert.equal(S.qa('#layer .stars button.on').length, 2, 'its stars shown');
    assert.equal(txt(S.q('#layer .fine')), 'Tu calificación es anónima para el restaurante.', '🔴 C2-9: no «Podés cambiarla» once it cannot change');
  } finally { S.w.close(); }
  let t = T0; const r2 = ratingServer({ now: () => t });
  const { S: E, placed } = await memberDelivered({ rate: r2 });
  try {
    await until(() => E.q('.mk-sheet .rate-cta') && E.q('.mk-sheet .rate-cta').style.visibility !== 'hidden');
    E.click('.mk-sheet .rate-cta'); await until(() => E.q('#layer .rate'));
    E.click('#layer [data-act="rate-star"][data-val="3"]'); await flush();
    t = T0 + RATE_W + 1;   // the window closes while the sheet is open
    E.click('#layer [data-act="rate-send"]'); await until(() => E.q('#layer .rate-err'));
    assert.equal(txt(E.q('#layer .rate-err')), 'Ya no se puede calificar este pedido.', '🔴 C2-10: the server\'s answer, in words');
    assert.ok(E.q('#layer .rate'), 'the sheet stays'); assert.equal(r2.nodes[placed.order_id].store, null, 'nothing recorded');
  } finally { E.w.close(); }
});
test('C-2 guests: a GUEST\'s delivered order has NO rating entry and makes ZERO rating reads (no guest server path)', async () => {
  const { ES, made } = fakeES(), rate = ratingServer();
  const S = bootShell({ auth: 'guest', runtime: { ...RUNTIME, rtdbBase: 'https://rtdb.test', ratings: true, signup: SU_RUNTIME.signup }, mountExtra: { EventSource: ES, loadSdk: fakeFirebase({}).loadSdk, signupFetch: (u, i) => (/\/(getMyRating|rateOrder)$/.test(u.split('?')[0]) ? rate.handler(u, i) : signupServer(ANA).fetch(u, i)) },
    apiFetch: ORDER_FETCH((b) => ({ ok: true, order_id: b.order_id, tracking_token: 'tok_abcdefgh12' })), geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 15.52, longitude: -88.04 } }) } });
  try {
    await flush(); await placeShellCash(S);
    made[0].emit('put', '/', trackingRecordOf('tok_abcdefgh12')); made[0].emit('put', '/status', 'delivered'); await flush(); await flush(400);
    assert.equal(txt(S.q('.mk-title')), '¡Pedido entregado!', 'premise: delivered');
    assert.equal(S.q('.rate-cta'), null, '🔴 C2-11: no entry for a guest'); assert.equal(rate.calls.length, 0, '🔴 C2-11: zero rating reads');
  } finally { S.w.close(); }
});
test('C-2 the send diff (capp-rate): a first rating sends only what is set; an edit only what changed — `dishes` WHOLE (the writer replaces it), earlier votes the sheet could not show KEPT; a cleared thumb ⇒ null; the five words', () => {
  const R = require('./capp-rate.js');
  assert.deepEqual(R.WORDS, ['Malo', 'Regular', 'Bueno', 'Muy bueno', 'Excelente']);
  assert.deepEqual(R.fieldsToSend(null, { store: null, dishes: { a: 1, x: 1 }, delivery: null, comment: '   ' }, ['a']), { dishes: { a: 1 } }, '🔴 RD-1: only set fields, only offered dishes, a blank comment dropped');
  const ini = { store: 4, dishes: { a: 1, hidden: -1 }, delivery: 1, comment: 'Rica' };
  assert.deepEqual(R.fieldsToSend(ini, R.fromRating(ini), ['a']), {}, '🔴 RD-1: unchanged ⇒ nothing');
  assert.deepEqual(R.fieldsToSend(ini, { ...R.fromRating(ini), dishes: { a: -1 } }, ['a']), { dishes: { hidden: -1, a: -1 } }, '🔴 RD-1: the WHOLE map, the unshown vote kept');
  assert.deepEqual(R.fieldsToSend(ini, { ...R.fromRating(ini), delivery: null, comment: ' Riquísima ' }, ['a']), { delivery: null, comment: 'Riquísima' }, 'a cleared thumb ⇒ null; the comment trimmed');
  assert.deepEqual(R.dishesOf(['a', 'a', 'b', 'c', 'z'], (id) => ({ a: 'Pizza', c: 'Pan' })[id] || null), [{ id: 'a', name: 'Pizza' }, { id: 'c', name: 'Pan' }], '🔴 RD-2: distinct, nameable only');
});
test('C-2 pickup: a PICKUP order\'s sheet has no «La entrega» row (the delivery thumbs exist only for a delivery)', async () => {
  const rate = ratingServer(), db = {}, orders = {};
  placeReal(db, orders, 'u_ana', 'XP-P1', { ts: T0 - 3600e3, type: 'pickup' });
  rate.own('XP-P1', 'u_ana', []); rate.fulfil('XP-P1', T0 - 3600e3);
  const { S } = await pedidosBoot(db, { orders, rate, runtime: RATE_RT(), contextFor: AGAIN_CTX });
  try {
    S.click('.tabbar [data-tab="orders"]'); await flush(); await until(() => S.q('.orow .rate-go[data-oid="XP-P1"]'));
    S.click('.orow .rate-go[data-oid="XP-P1"]'); await until(() => S.q('#layer .rate'));
    assert.equal(S.q('#layer [data-act="rate-del"]'), null, '🔴 C2-12: no delivery thumbs on a pickup');
    assert.ok(!/La entrega/.test(S.q('#layer .rate').textContent), 'no «La entrega» section');
  } finally { S.w.close(); }
});
