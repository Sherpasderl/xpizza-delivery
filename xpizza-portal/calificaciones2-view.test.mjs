// «Calificaciones» step 2 — the PAGE, EXACT to MOCKUP-portal-calificaciones-step2.html (owner-APPROVED 11-15; tabs 1–8), in jsdom, over
// 3a's REAL reviews v2 + v1 cores at the pin and 5f's REAL getMyBranchesCore (calificaciones2-harness.mjs), the portal's real api.js.
// Run: node --test calificaciones2-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, UIDS, NOW, CUT, DAY, H, RW, world, goLive, rated, named, rate, buildBuckets, publishStats, discovery, server, tokenOf } from './calificaciones2-harness.mjs';
const { calificacionesTab, CAL_COPY, _califState } = await import('./calificaciones.js');

const settle = (n = 40) => new Promise((r) => { let i = 0; const go = () => (++i >= n ? r() : setTimeout(go, 0)); go(); });
const W4 = RW.windowOf(4, NOW);
// a page as calificaciones-view.js mounts it ({ rid, token, scopeLabel }); `now` pins the clock the period labels read
async function page(db, { who = 'ownerX', rid = 'x_pizza', name = 'Centro', srv: so = {}, hold = {}, local = {}, e1 } = {}) {
  calificacionesTab.unmount();
  const win = new JSDOM('<!doctype html><div id="pane"></div>', { url: 'https://portal.test/' }).window;
  for (const [k, x] of Object.entries(local)) win.localStorage.setItem(k, x);
  globalThis.document = win.document; globalThis.window = win;
  const srv = server(db, { e1: e1 === undefined ? await discovery() : e1, ...so });
  Object.assign(srv.hold, hold);
  globalThis.fetch = srv.fetch;
  const el = win.document.getElementById('pane');
  calificacionesTab.mount(el, { rid, token: tokenOf(who), scopeLabel: name, now: () => NOW });
  const $ = (s) => el.querySelector(s), $$ = (s) => [...el.querySelectorAll(s)];
  const txt = (s) => ($(s) ? $(s).textContent : null);
  const pillText = (i) => $$('.cf-filt .cf-pill')[i].firstChild.textContent;
  return { win, el, srv, $, $$, txt, pillText, reviews: () => srv.calls.filter((c) => c.fn === 'getMerchantReviews') };
}
// a world with `n` NAMED ratings inside the 4-week window (the bars), public_stats published, the buckets built (the real producers)
async function populated(n = 12, { more = [], earlier = [] } = {}) {
  const db = await world({ live: false });
  for (const e of earlier) await rated(db, e.uid, e.id, { ...e, disclosure: undefined });   // the EARLIER ratings: before go-live
  await goLive(db);
  for (let i = 0; i < Math.max(n, 12); i += 1) await named(db, UIDS[i], ['Ana', 'Luis', 'Karla', 'Jorge', 'Sofía', 'Marvin', 'Daniela', 'Roberto', 'María', 'Óscar', 'Guadalupe', 'Pedro'][i] || `N${i}`, 'Pérez');
  for (let i = 0; i < n; i += 1) await rated(db, UIDS[i], `XPZ-w${String(i).padStart(2, '0')}`, { at: W4.start + (1 + i) * DAY, store: [5, 5, 4, 5, 3, 5, 2, 4, 5, 1, 5, 4][i % 12], comment: i % 3 === 2 ? undefined : `Comentario ${i}` });
  for (const m of more) await rated(db, m.uid, m.id, m);
  await buildBuckets(db); await publishStats(db);
  return db;
}

test('V1 FIRST PAINT (advisor 11-15, rule 7): the final layout before ANY answer — real pills, range, titles, sublines; bones for the data; no awaited branch read', async () => {
  const db = await populated();
  const never = new Promise(() => {});
  const p = await page(db, { hold: { getMerchantReviews: never, getMerchantRatingComments: never, getMyBranches: never } });
  assert.deepEqual([p.pillText(0), p.txt('.cf-filt .cf-vrl'), p.pillText(1)], ['Últimas 4 semanas', '5 oct – 1 nov', 'Sucursal Centro'], 'V1: the scope row is real text');
  assert.ok(p.$('.cf-filt .cf-pill').classList.contains('cf-on'), 'the period pill is filled (a value is always chosen)');
  assert.ok(p.$('.kfigs.surface.ov.sk'), 'the Overview\'s bones');
  assert.deepEqual([p.txt('.sect h2'), p.txt('.sect .subl')], ['Lo que dicen tus clientes', 'Del 5 de octubre a hoy, las más recientes primero.']);
  assert.ok(p.$$('.cf-filt.cf-sub .cf-pill').every((b) => b.disabled), 'the list filters drawn disabled until the first page lands');
  assert.equal(p.$$('.skrow:not(.v1)').length, 5, 'five row bones'); assert.equal(p.$$('.skrow.v1').length, 3, 'three earlier bones');
  assert.deepEqual([p.txt('.sect.earlier h2'), p.txt('.sect.earlier .subl')], ['Calificaciones anteriores', 'Comentarios de antes de que las calificaciones llevaran nombre. Son anónimos y no tienen fecha.']);
  assert.equal(p.txt('.sr-only'), 'Cargando calificaciones');
});

test('V1b the branch list is NEVER awaited: the reviews paint while getMyBranches is held; when it lands only the pill\'s menu fills — no node above or below moves', async () => {
  const db = await populated();
  let release; const branches = new Promise((r) => { release = r; });
  const p = await page(db, { hold: { getMyBranches: branches } });
  await settle(120);
  assert.ok(p.$$('.crow:not(.v1)').length > 0, 'V1b: the named rows painted with the branch list still pending');
  const before = { pill: p.$$('.cf-filt .cf-pill')[1].firstChild.textContent, list: p.$('.clist'), ov: p.$('.kfigs.ov') };
  assert.deepEqual([...p.$$('.cf-filt')[0].querySelectorAll('.cf-menu')[1].querySelectorAll('button')].map((b) => b.textContent), ['Todas las sucursales', 'Centro'], 'only the page\'s own branch yet');
  release(); await settle(80);
  assert.equal(p.$$('.cf-filt .cf-pill')[1].firstChild.textContent, before.pill, 'V1b: the pill\'s label unchanged');
  assert.equal(p.$('.clist'), before.list, 'V1b: the list is the SAME node (no repaint)');
  assert.equal(p.$('.kfigs.ov'), before.ov, 'V1b: the Overview is the SAME node');
  assert.deepEqual([...p.$$('.cf-filt')[0].querySelectorAll('.cf-menu')[1].querySelectorAll('button')].map((b) => b.textContent), ['Todas las sucursales', 'Centro', 'Sur'], 'V1b: the menu gained the other branch');
});

test('V2 the populated page (tab 1): the all-time figures, the bars of the window\'s NAMED ratings, named + «Cliente» rows with their meta', async () => {
  const db = await populated(12);
  await rated(db, UIDS[20], 'XPZ-anon', { at: NOW - 3 * H, store: 4, comment: 'Sin nombre' });   // a disclosed rating, no structured name
  await rated(db, UIDS[0], 'XPZ-e1', { at: NOW - 5 * H, store: 5, comment: 'Primero' });
  assert.equal((await rate(db, UIDS[0], { order_id: 'XPZ-e1', store: 4, comment: 'Editado', disclosure: 1 }, NOW - 2 * H)).httpStatus, 200, 'premise: an edit within its window');
  await buildBuckets(db); await publishStats(db);
  const p = await page(db); await settle(150);
  const kn = p.$$('.ovg.all .kn').map((n) => n.textContent);
  assert.equal(kn.length, 2); assert.match(kn[0], /^\d\.\dde 5$/, 'V2: the average, 1 dp, «de 5»'); assert.equal(kn[1], '14en total', 'the count «en total»');
  assert.equal(p.txt('.ovg.all .kbase'), 'Todas las calificaciones · desde el inicio');
  const bars = p.$('.ovg.bars');
  assert.equal(bars.dataset.mode, 'ok', 'V2: ≥ 10 named in the window ⇒ the bars');
  assert.equal(p.$$('.dist .cf-dn').map((n) => n.textContent).reduce((a, x) => a + Number(x), 0), 12, 'the five counts sum to stars_n');
  assert.equal(p.txt('.ovg.bars .kbase'), '12 calificaciones con nombre · últimas 4 semanas', 'V2: the bars\' base line');
  assert.ok(p.$$('.dist .df.pos').length === 2 && p.$$('.dist .df.neg').length === 2, 'mint 5–4★, rose 2–1★');
  const rows = p.$$('.clist:not([aria-hidden]) .crow:not(.v1)');
  const anon = rows.find((r) => r.querySelector('.cname.anon'));
  assert.ok(anon && anon.querySelector('.cav.anon svg'), 'V2: a disclosed row without a name ⇒ «Cliente» + the neutral disc');
  assert.equal(anon.querySelector('.cname').textContent, 'Cliente');
  const ana = rows.find((r) => r.querySelector('.ctxt') && r.querySelector('.ctxt').textContent === 'Editado');
  assert.ok(ana && ana.querySelector('.cname').textContent === 'Ana P.', 'V2: «Ana P.»'); assert.match(ana.querySelector('.cav').className, /^cav t[0-4]$/, 'the served tone'); assert.equal(ana.querySelector('.cav').textContent, 'AP');
  assert.equal(ana.querySelector('.stars').getAttribute('aria-label'), '4 de 5 estrellas');
  assert.equal(ana.querySelector('.cf-meta').textContent, `Calificado el ${Number(RW.hnDate(NOW - 4 * H).slice(8))} nov · editada`, 'V2: «Calificado el … · editada» (rated_on = the first submission)');
  const noComment = rows.find((r) => !r.querySelector('.ctxt'));
  assert.ok(noComment && noComment.querySelector('.cf-meta'), 'a commentless row: stars + date, no text');
  for (const r of rows) assert.ok(!/\bL \d|XPZ|total|nuevo|frecuente/.test(r.textContent), `V2: no dishes / total / order / kind: ${r.textContent}`);
});

test('V3 the period (tab 2): the menu lists the three closed-week periods with their ranges; a pick re-asks, is remembered, and the NEWEST request wins', async () => {
  const db = await populated(12);
  const p = await page(db); await settle(120);
  const btn = p.$$('.cf-filt .cf-pill')[0]; btn.click();
  const opts = [...p.$('.cf-filt .cf-menu.cf-show').querySelectorAll('button')];
  assert.deepEqual(opts.map((o) => [o.firstChild.textContent, o.querySelector('.cf-mr').textContent]), [['La semana pasada', '26 oct – 1 nov'], ['Últimas 4 semanas', '5 oct – 1 nov'], ['Últimas 13 semanas', '3 ago – 1 nov']]);
  assert.equal(opts[1].getAttribute('aria-selected'), 'true');
  let release; p.srv.hold.getMerchantReviews = new Promise((r) => { release = r; });
  opts[0].click(); await settle(20);                                   // weeks=1: held
  p.$$('.cf-filt .cf-pill')[0].click(); [...p.$('.cf-filt .cf-menu.cf-show').querySelectorAll('button')][2].click(); await settle(120);   // weeks=13 answers first
  release(); await settle(120);                                        // the OLDER answer lands last
  assert.deepEqual(p.reviews().slice(-2).map((c) => c.query.weeks), ['1', '13']);
  assert.equal(p.pillText(0), 'Últimas 13 semanas', 'V3: the newest choice');
  assert.equal(p.txt('.ovg.bars .kbase'), '12 calificaciones con nombre · últimas 13 semanas', 'V3: the stale weeks=1 answer was dropped');
  assert.deepEqual([_califState().weeks, _califState().named.st.overview.starsN], [13, 12], 'V3: the stale weeks=1 answer never reached the list state');
  assert.equal(p.win.localStorage.getItem('sherpa.portal.calif.weeks'), '13', 'Q1: remembered per browser');
  const q = await page(db, { local: { 'sherpa.portal.calif.weeks': '13' } }); await settle(60);
  assert.equal(q.pillText(0), 'Últimas 13 semanas', 'the next visit opens on it');
});

test('V4 below the floor (tab 4): fewer than 10 named in the window ⇒ the honest sentence in the bars\' slot; the figures stay; the rows still list', async () => {
  const db = await populated(6, { more: [] });
  for (let i = 0; i < 8; i += 1) await rated(db, UIDS[12 + i], `XPZ-old${i}`, { at: NOW - (60 + i) * DAY, store: 5 });   // older ratings lift public_stats to ≥ 10
  await buildBuckets(db); await publishStats(db);
  const p = await page(db); await settle(150);
  assert.equal(p.$('.ovg.bars').dataset.mode, 'floor');
  assert.equal(p.txt('.ovg.bars .ksay'), 'Todavía hay pocas calificaciones con nombre en este período. Vas a ver el detalle por estrellas cuando haya 10 o más.', 'V4: the floor sentence');
  assert.equal(p.txt('.ovg.bars .kbase'), 'Calificaciones con nombre · últimas 4 semanas', 'V4: the base line without N');
  assert.equal(p.$$('.ovg.all .kn').length, 2, 'V4: the all-time figures (their own ≥ 10)');
  assert.equal(p.$$('.clist .crow:not(.v1)').length, 6, 'the few named rows still listed');
});

test('V5 names not live yet (tab 5): no config write ⇒ ONE honest copy for the bars + the list, no filters; the earlier comments as today', async () => {
  const db = await world({ live: false });
  await rated(db, UIDS[0], 'XPZ-pre1', { at: NOW - 10 * DAY, store: 5, comment: 'Siempre bien.', disclosure: undefined });
  const p = await page(db); await settle(150);
  assert.equal(p.txt('.ovg.bars .ksay'), 'Cuando tus clientes califiquen con su nombre, vas a ver acá cuántas calificaciones hay por estrellas.', 'V5: the not-live bars copy');
  assert.deepEqual([p.txt('.cempty b'), p.txt('.cempty p')], ['Todavía no hay calificaciones con nombre', 'Cuando tus clientes califiquen con su nombre, vas a ver acá qué dijeron y cuándo.'], 'V5: the not-live list copy');
  assert.equal(p.$('.cf-filt.cf-sub'), null, 'V5: no filters (nothing to filter)');
  assert.deepEqual(p.$$('.crow.v1 .ctxt').map((n) => n.textContent), ['Siempre bien.'], 'the earlier comment');
  const v1 = p.$('.crow.v1');
  assert.ok(!v1.querySelector('.cav') && !v1.querySelector('.cname') && !v1.querySelector('.cf-meta'), 'V5: the earlier row — NO disc, NO name, NO date');
});

test('V6 the list filters (tab 3): stars (multi, the menu stays open) + comment ⇒ on the wire, the pills read the choice; the Overview is untouched; «Quitar filtros»', async () => {
  const db = await populated(12);
  const p = await page(db); await settle(150);
  const ov = p.$('.kfigs.ov').textContent;
  p.$$('.cf-filt.cf-sub .cf-pill')[0].click();
  [...p.$('.cf-filt.cf-sub .cf-menu.cf-show').querySelectorAll('button')].find((b) => b.textContent === '1 estrella').click(); await settle(80);
  assert.ok(p.$('.cf-filt.cf-sub .cf-menu.cf-show'), 'V6: the stars menu stays open across picks');
  [...p.$('.cf-filt.cf-sub .cf-menu.cf-show').querySelectorAll('button')].find((b) => b.textContent === '2 estrellas').click(); await settle(80);
  p.$$('.cf-filt.cf-sub .cf-pill')[1].click();
  let release; p.srv.hold.getMerchantReviews = new Promise((r) => { release = r; });
  [...p.$('.cf-filt.cf-sub .cf-menu.cf-show').querySelectorAll('button')].find((b) => b.textContent === 'Con comentario').click(); await settle(30);
  assert.ok(p.$('.kfigs.ov:not(.sk)') && p.$('.kfigs.ov').textContent === ov, 'V6: the Overview stays in place while the filtered list re-loads');
  assert.ok(p.$$('.skrow:not(.v1)').length > 0, 'V6: only the list shows its bones');
  release(); await settle(120);
  const last = p.reviews().at(-1).query;
  assert.deepEqual([last.stars, last.comment, last.cursor], ['1,2', 'with', undefined], 'V6: page 1 again, the filters on the wire');
  assert.deepEqual([p.$$('.cf-filt.cf-sub .cf-pill')[0].firstChild.textContent, p.$$('.cf-filt.cf-sub .cf-pill')[1].firstChild.textContent], ['1 y 2 estrellas', 'Con comentario']);
  assert.ok(p.$$('.cf-filt.cf-sub .cf-pill').every((b) => b.classList.contains('cf-on')), 'both pills filled');
  assert.equal(p.$('.kfigs.ov').textContent, ov, 'V6: the Overview is untouched by the list filters');
  assert.ok(p.$$('.clist .crow:not(.v1)').every((r) => /^[12] de 5/.test(r.querySelector('.stars').getAttribute('aria-label')) && r.querySelector('.ctxt')), 'only 1–2★ with a comment');
  p.$('.cf-filt.cf-sub .qact').click(); await settle(120);
  assert.deepEqual([p.reviews().at(-1).query.stars, p.$('.cf-filt.cf-sub .qact')], [undefined, null], 'V6: «Quitar filtros» clears both and hides');
});

test('V7 filters that match nothing (tab 6): the two lines + «Quitar filtros», no pager; the Overview and the earlier section stay', async () => {
  const db = await populated(12);
  const p = await page(db); await settle(150);
  p.$$('.cf-filt.cf-sub .cf-pill')[0].click();
  [...p.$('.cf-filt.cf-sub .cf-menu.cf-show').querySelectorAll('button')].find((b) => b.textContent === '1 estrella').click(); await settle(60);
  p.$$('.cf-filt.cf-sub .cf-pill')[1].click();
  [...p.$('.cf-filt.cf-sub .cf-menu.cf-show').querySelectorAll('button')].find((b) => b.textContent === 'Sin comentario').click(); await settle(150);
  const fe = () => p.$$('.cempty.tight').find((x) => x.querySelector('.btn'));   // the earlier section has its own (empty) box
  assert.deepEqual([fe().querySelector('b').textContent, fe().querySelector('p').textContent, fe().querySelector('.btn').textContent], ['No hay calificaciones con estos filtros.', 'Probá con otras estrellas o quitá los filtros para ver todas.', 'Quitar filtros'], 'V7');
  assert.equal(fe().nextElementSibling.matches('.sect.earlier'), true, 'V7: no pager after it — the earlier section follows');
  assert.ok(p.$('.kfigs.ov') && p.$('.sect.earlier'), 'the Overview and the earlier section stay');
  fe().querySelector('.btn').click(); await settle(150);
  assert.equal(fe(), undefined, 'cleared');
});

test('V8 paging (never automatic): 25 named ⇒ 20 + «Ver más calificaciones» → «Cargando…» in place (disabled) → appended below; the end line', async () => {
  const db = await world();
  await named(db, UIDS[0]);
  for (let i = 0; i < 25; i += 1) await rated(db, UIDS[0], `XPZ-m${String(i).padStart(2, '0')}`, { at: NOW - (2 + i) * H, store: 5, comment: `m${i}` });
  const p = await page(db); await settle(150);
  const named0 = () => p.$$('.clist .crow:not(.v1)');
  assert.equal(named0().length, 20);
  const first = named0()[0];
  const more = [...p.$$('.pager .btn')].find((b) => b.textContent === 'Ver más calificaciones');
  let release; p.srv.hold.getMerchantReviews = new Promise((r) => { release = r; });
  more.click(); await settle(10);
  assert.deepEqual([more.textContent, more.disabled, more.isConnected], ['Cargando…', true, true], 'V8: in place, disabled');
  release(); await settle(120);
  assert.equal(named0().length, 25, 'V8: appended'); assert.equal(named0()[0], first, 'V8: the rows above did not move (same nodes)');
  assert.ok(p.$$('.endl').some((x) => x.textContent === 'No hay más calificaciones.'), 'V8: the end line');
});

test('V9 «Todas las sucursales»: one figure line per branch (never combined), the bars and list over both, the earlier comments per branch via the switch', async () => {
  const db = await populated(12, { earlier: [{ uid: UIDS[13], id: 'SUR-1', rid: 'xp_sur', at: CUT - 30 * DAY, store: 3, comment: 'Desde Sur' }] });
  await publishStats(db, 'xp_sur');
  const p = await page(db); await settle(150);
  p.$$('.cf-filt .cf-pill')[1].click();
  [...p.$('.cf-filt .cf-menu.cf-show').querySelectorAll('button')].find((b) => b.textContent === 'Todas las sucursales').click(); await settle(200);
  assert.equal(p.reviews().at(-1).query.rids, 'x_pizza,xp_sur', 'V9: both rids');
  assert.deepEqual([p.pillText(1), p.$$('.cf-filt .cf-pill')[1].classList.contains('cf-on')], ['Todas las sucursales', true]);
  const lines = p.$$('.ovg.all.many .cf-brow').map((r) => r.textContent);
  assert.equal(lines.length, 2); assert.match(lines[0], /^Centro\d\.\dde 5\d+ calificaciones$/, 'V9: Centro\'s own figures'); assert.equal(lines[1], 'SurMenos de 10 calificaciones', 'V9: Sur under 10');
  assert.equal(p.txt('.ovg.all.many .kbase'), 'Todas las calificaciones · desde el inicio · por sucursal');
  const seg = p.$$('.cf-seg button');
  assert.deepEqual(seg.map((b) => [b.textContent, b.getAttribute('aria-selected'), b.classList.contains('cf-sel')]), [['Centro', 'true', true], ['Sur', 'false', false]], 'V9: the earlier comments\' branch switch');
  seg[1].click(); await settle(150);
  const v1 = p.srv.calls.filter((c) => c.fn === 'getMerchantRatingComments').at(-1);
  assert.equal(v1.query.rid, 'xp_sur', 'V9: one rid per earlier call — never merged');
  assert.deepEqual(p.$$('.crow.v1 .ctxt').map((n) => n.textContent), ['Desde Sur']);
});

test('V10 error (tab 8): the named call fails ⇒ ONE box in place of the Overview AND the list; the earlier section keeps its own content; «Reintentar» re-reads', async () => {
  const db = await populated(12, { earlier: [{ uid: UIDS[19], id: 'XPZ-pre', at: CUT - 30 * DAY, store: 4, comment: 'De antes' }] });
  const real = db.ref.bind(db); let out = true;
  db.ref = (p2 = '') => (out && String(p2).startsWith('public_stats') ? { ...real(p2), once: async () => { throw new Error('injected outage'); }, get: async () => { throw new Error('injected outage'); } } : real(p2));
  const p = await page(db); await settle(150);
  assert.deepEqual([p.txt('.cerr b'), p.txt('.cerr p')], ['No pudimos cargar las calificaciones.', 'Revisá tu conexión y volvé a intentar.'], 'V10: the error box');
  assert.equal(p.$('.kfigs.ov'), null, 'no Overview'); assert.equal(p.$$('.crow:not(.v1)').length, 0, 'no named list');
  assert.deepEqual(p.$$('.crow.v1 .ctxt').map((n) => n.textContent), ['De antes'], 'V10: the earlier section kept its own content');
  out = false;
  p.$('.cerr .btn').click(); await settle(200);
  assert.equal(p.$('.cerr'), null); assert.ok(p.$('.kfigs.ov'), 'V10: the retry re-read');
});

test('V11 both calls fail (429): ONE «Reintentar» — the earlier section shows the same box WITHOUT a second one', async () => {
  const db = await populated(12);
  const p = await page(db, { srv: { limited: true } }); await settle(150);
  const boxes = p.$$('.cerr');
  assert.equal(boxes.length, 2, 'two boxes');
  assert.deepEqual(boxes.map((b) => !!b.querySelector('.btn')), [true, false], 'V11: one retry, in the named area');
});

test('V12 no access (403): the approved step-1 line, nothing else, no retry', async () => {
  const db = await populated(12);
  const p = await page(db, { who: 'ownerM', e1: null }); await settle(150);
  assert.deepEqual([p.txt('.cerr b'), p.txt('.cerr p'), p.$('.cerr .btn')], ['Tu cuenta no puede ver las calificaciones de esta sucursal.', 'Pedile acceso a la persona dueña del restaurante.', null], 'V12');
  assert.equal(p.$('.kfigs.ov'), null); assert.equal(p.$('.sect.earlier'), null, 'V12: nothing else drawn');
});

test('V13 stale buckets (no producer run for 30 h) ⇒ the honest sentence, never stale numbers', async () => {
  const db = await populated(12);
  const p = await page(db, { srv: { now: NOW + 40 * H } }); await settle(150);
  assert.equal(p.$('.ovg.bars').dataset.mode, 'floor', 'V13: stale ⇒ no bars');
});

test('V14 a row: «Leer más» / «Leer menos» toggles the clamp with aria-expanded; the earlier row is stars + comment only', async () => {
  const db = await populated(12, { earlier: [{ uid: UIDS[19], id: 'XPZ-pre', at: CUT - 30 * DAY, store: 4, comment: 'De antes' }] });
  const p = await page(db); await settle(150);
  const row = p.$('.clist .crow:not(.v1) .ctxt').closest('.crow');
  const t = row.querySelector('.ctxt'), more = row.querySelector('.cmore');
  more.click(); assert.deepEqual([t.classList.contains('clamp'), more.textContent, more.getAttribute('aria-expanded')], [false, 'Leer menos', 'true']);
  more.click(); assert.deepEqual([t.classList.contains('clamp'), more.textContent, more.getAttribute('aria-expanded')], [true, 'Leer más', 'false']);
  const v1 = p.$('.crow.v1');
  assert.deepEqual([...v1.children].map((c) => c.className), ['stars', 'ctxt clamp', 'qact cmore'], 'V14: the earlier row');
});

// the EARLIER (v1) list keeps step 1's behaviour (its own cells retired with the step-1 page): paging, a later failure, the empty copy
const anonWorld = async (n) => {
  const db = await world({ live: false });
  for (let i = 0; i < n; i += 1) await rated(db, UIDS[i % 26], `XPZ-a${String(i).padStart(2, '0')}`, { at: CUT - (40 + i) * DAY, store: 4, comment: `antes ${i}`, disclosure: undefined });
  await goLive(db);
  return db;
};
test('V15 the earlier list pages by «Ver más comentarios anteriores» → «Cargando…» in place → appended; then «No hay más comentarios anteriores.»', async () => {
  const db = await anonWorld(25);
  const p = await page(db); await settle(200);
  assert.equal(p.$$('.crow.v1').length, 20);
  const first = p.$('.crow.v1');
  const more = p.$$('.pager .btn').find((b) => b.textContent === 'Ver más comentarios anteriores');
  let release; p.srv.hold.getMerchantRatingComments = new Promise((r) => { release = r; });
  more.click(); await settle(10);
  assert.deepEqual([more.textContent, more.disabled], ['Cargando…', true], 'V15: in place, disabled');
  release(); await settle(150);
  assert.equal(p.$$('.crow.v1').length, 25, 'V15: appended'); assert.equal(p.$('.crow.v1'), first, 'nothing above moved');
  assert.ok(p.$$('.endl').some((x) => x.textContent === 'No hay más comentarios anteriores.'), 'V15: the end line');
});
test('V16 a LATER earlier page that fails keeps the rows; its pager carries the error + «Reintentar», which continues', async () => {
  const db = await anonWorld(25);
  const p = await page(db); await settle(200);
  const real = db.ref.bind(db); let out = true;
  db.ref = (q = '') => (out && String(q).startsWith('rating_index') ? { ...real(q), orderByKey: () => { throw new Error('injected outage'); } } : real(q));
  p.$$('.pager .btn').find((b) => b.textContent === 'Ver más comentarios anteriores').click(); await settle(150);
  assert.equal(p.$$('.crow.v1').length, 20, 'V16: the rows stay');
  const box = p.$$('.pager .cerr').at(-1);
  assert.ok(box && box.querySelector('.btn'), 'V16: the error line + «Reintentar» in the pager');
  out = false; box.querySelector('.btn').click(); await settle(150);
  assert.equal(p.$$('.crow.v1').length, 25, 'V16: the retry continued from the same cursor');
});
test('V17 no earlier comment: the approved step-1 empty lines under «Calificaciones anteriores»', async () => {
  const db = await populated(12);
  const p = await page(db); await settle(150);
  const e = p.$('.sect.earlier').nextElementSibling;
  assert.deepEqual([e.querySelector('b').textContent, e.querySelector('p').textContent], ['Todavía no hay comentarios', 'Cuando tus clientes califiquen un pedido con un comentario, lo vas a ver acá.'], 'V17');
});

test('SHIP GATE: no placeholder ships — every Calificaciones string is owner-approved text', () => {
  const pending = Object.entries(CAL_COPY).filter(([, x]) => typeof x !== 'string' || !x).map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders: ${pending.join(', ')}`);
});
