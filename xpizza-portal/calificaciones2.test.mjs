// «Calificaciones» step 2 (PLAN-portal-calificaciones-step2 r0.1) — the PURE half against 3a's REAL reviews v2 at its pin
// (calificaciones2-harness.mjs): the period model's parity with ratings/review-window.js, the labels, the row allowlist, the Overview
// re-check and the named list's paging — every server answer produced by the real core over data from the real writers.
// Run: node --test calificaciones2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { REF, RW, UIDS, NOW, DAY, H, world, rated, named, buildBuckets, publishStats, server, tokenOf, fetchMerchantReviews } from './calificaciones2-harness.mjs';
const L = await import('./calificaciones-logic.js');
const DIR = dirname(fileURLToPath(import.meta.url));
const HN = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m, d, h + 6, mi);   // an HN wall-clock instant
const visit = (srv, { rids = ['x_pizza'], weeks = 4, stars, comment, who = 'ownerX', extra } = {}) => {
  globalThis.fetch = srv.fetch;
  return L.createReviewList({ rids, fetchPage: async ({ cursor }) => {
    const b = await fetchMerchantReviews({ rids, weeks, stars, comment, cursor, token: tokenOf(who) });
    return extra ? extra(b) : b;
  } });
};

test('the pin: REF is 3a feat/merchant-reviews-v2-3a 4adde46e4 (rev-parse), and the harness reads that tree', () => {
  assert.equal(REF, execFileSync('git', ['rev-parse', '4adde46e4'], { cwd: DIR, encoding: 'utf8' }).trim());
  assert.deepEqual([...RW.WEEKS], [...L.WEEKS], 'the same period set');
});

test('P1 PARITY: hnMonday / windowOf equal ratings/review-window.js at the pin — the boundaries, a year crossing and 400 instants', () => {
  const at = [HN(2026, 10, 15, 23, 59), HN(2026, 10, 16, 0, 0), HN(2026, 10, 16, 0, 1), HN(2026, 10, 22, 23, 59), HN(2026, 10, 23), HN(2027, 0, 4), HN(2026, 11, 31, 23, 59), NOW];
  for (let i = 0; i < 400; i += 1) at.push(Date.UTC(2026, 0, 1) + Math.floor(((i * 7919) % 1000) / 1000 * 730 * DAY) + i * 37 * 60e3);
  for (const t of at) {
    assert.equal(L.hnMonday(t), RW.hnMonday(t), `P1: hnMonday(${new Date(t).toISOString()})`);
    for (const w of L.WEEKS) assert.deepEqual(L.windowOf(w, t), RW.windowOf(w, t), `P1: windowOf(${w}, ${new Date(t).toISOString()})`);
  }
});

test('P2 the labels follow the server\'s rule: Sun 15 Nov ⇒ 26 oct – 1 nov (2 – 8 nov closes Mon 16 Nov 00:00 HN); the year only across one', () => {
  const p = (w, t) => L.periodOf(w, t);
  assert.deepEqual([p(1, NOW).range, p(4, NOW).range, p(13, NOW).range], ['26 oct – 1 nov', '5 oct – 1 nov', '3 ago – 1 nov'], 'P2: Sun 15 Nov 18:00 HN (the mockup day)');
  assert.equal(p(4, NOW).from, 'Del 5 de octubre a hoy, las más recientes primero.');
  assert.deepEqual([p(4, NOW).label, p(4, NOW).low, p(1, NOW).label, p(13, NOW).low], ['Últimas 4 semanas', 'últimas 4 semanas', 'La semana pasada', 'últimas 13 semanas']);
  assert.equal(p(1, HN(2026, 10, 15, 23, 59)).range, '26 oct – 1 nov', 'Sun 23:59 HN: still the week before');
  assert.equal(p(1, HN(2026, 10, 16)).range, '2 – 8 nov', 'P2: Mon 16 Nov 00:00 HN — 2 – 8 nov has closed (one month ⇒ named once)');
  assert.equal(p(1, HN(2026, 10, 23)).range, '9 – 15 nov');
  const jan = HN(2027, 0, 11, 9);
  assert.equal(p(4, jan).range, '7 dic 2026 – 3 ene 2027', 'P2: a range across the new year carries both years');
  assert.equal(p(4, jan).from, 'Del 7 de diciembre de 2026 a hoy, las más recientes primero.');
});

test('P3 starsLabel / ratedLabel / initialsOf — the approved wording', () => {
  assert.deepEqual([[], [5], [1], [1, 2], [3, 1, 2], [5, 4, 3, 2, 1]].map(L.starsLabel), ['Estrellas', '5 estrellas', '1 estrella', '1 y 2 estrellas', '1, 2 y 3 estrellas', '1, 2, 3, 4 y 5 estrellas']);
  assert.equal(L.ratedLabel('2026-11-11', NOW), 'Calificado el 11 nov');
  assert.equal(L.ratedLabel('2025-12-30', NOW), 'Calificado el 30 dic 2025', 'another year: named');
  assert.deepEqual(['Ana P.', 'José M.', 'Óscar T.', 'Daniela'].map(L.initialsOf), ['AP', 'JM', 'ÓT', 'D']);
});

test('P4 rows: the REAL first page ⇒ ONLY { rid, stars, comment, ratedOn, edited, customer, tone } — dishes / total / kind never reach the view', async () => {
  const db = await world();
  const [A, B] = UIDS;
  await named(db, A);
  await rated(db, A, 'XPZ-1', { at: NOW - 2 * DAY, store: 5, comment: 'Excelente' });
  await rated(db, B, 'XPZ-2', { at: NOW - 3 * DAY, store: 4, comment: undefined });
  const st = await visit(server(db)).load();
  assert.deepEqual(st.rows, [
    { rid: 'x_pizza', stars: 5, comment: 'Excelente', ratedOn: '2026-11-13', edited: false, customer: 'Ana P.', tone: st.rows[0].tone },
    { rid: 'x_pizza', stars: 4, comment: null, ratedOn: '2026-11-12', edited: false, customer: null, tone: null },
  ], 'P4: a named row and an unnamed one (no customer key ⇒ «Cliente»)');
  assert.ok(Number.isInteger(st.rows[0].tone) && st.rows[0].tone >= 0 && st.rows[0].tone <= 4, 'the served tone digit');
  // the frozen first page (3a merchant-reviews.test §24): its rows map the same way
  const frozen = JSON.parse(readFileSync(join(DIR, '..', '..', 'xpizza-D4c-grill', 'NOTE-reviews-v2-frozen-response.json'), 'utf8'));
  assert.deepEqual(frozen.reviews.map(L.reviewRow), [
    { rid: 'x_pizza', stars: 4, comment: null, ratedOn: '2026-11-02', edited: false, customer: null, tone: null },
    { rid: 'x_pizza', stars: 5, comment: 'Excelente', ratedOn: '2026-11-02', edited: false, customer: 'Ana P.', tone: 3 },
  ]);
  for (const bad of [null, {}, { rid: 'x', stars: 6, rated_on: '2026-11-02' }, { rid: 'x', stars: 3, rated_on: '2026-13-02' }, { rid: '', stars: 3, rated_on: '2026-11-02' }])
    assert.equal(L.reviewRow(bad), null, `dropped: ${JSON.stringify(bad)}`);
});

test('P5 the Overview through the REAL core: under 10 named ⇒ stars AND stars_n null; ≥ 10 ⇒ the counts (summing to stars_n); public at ≥ 10', async () => {
  const db = await world();
  const w = RW.windowOf(4, NOW);
  for (let i = 0; i < 12; i += 1) { await named(db, UIDS[i], `N${String.fromCharCode(65 + i)}`, 'Z'); }
  for (let i = 0; i < 9; i += 1) await rated(db, UIDS[i], `XPZ-o${i}`, { at: w.start + (i + 1) * DAY, store: 1 + (i % 5) });
  await buildBuckets(db); await publishStats(db);
  let st = await visit(server(db)).load();
  assert.deepEqual([st.overview.stars, st.overview.starsN, st.overview.stale], [null, null, false], 'P5: 9 named in the window ⇒ the floor');
  assert.equal(st.overview.publicOne, null, 'public_stats under 10 ⇒ no figure');
  await rated(db, UIDS[9], 'XPZ-o9', { at: w.start + 12 * DAY, store: 5 });
  await rated(db, UIDS[10], 'XPZ-o10', { at: w.start + 13 * DAY, store: 5 });
  await buildBuckets(db); await publishStats(db);
  st = await visit(server(db)).load();
  assert.deepEqual([st.overview.stars, st.overview.starsN], [{ 1: 2, 2: 2, 3: 2, 4: 2, 5: 3 }, 11], 'P5: 11 named ⇒ the per-star counts');
  assert.ok(st.overview.publicOne && st.overview.publicOne.count === 11 && st.overview.publicOne.average >= 1, 'public_stats ≥ 10 ⇒ the figure');
  // re-checks: a sum that does not match, a stale state, a malformed figure ⇒ never a guessed number
  assert.equal(L.overviewOf({ public: null, stars: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }, stars_n: 10, overview_state: 'fresh' }, ['x']).stars, null, 'a sum ≠ stars_n');
  assert.equal(L.overviewOf({ public: null, stars: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 }, stars_n: 10, overview_state: 'stale' }, ['x']).stars, null, 'stale ⇒ no bars');
  assert.equal(L.overviewOf({ public: { count: 9, average: 4 }, stars: null, stars_n: null, overview_state: 'fresh' }, ['x']).publicOne, null, 'a figure under 10');
  assert.equal(L.overviewOf({ overview_state: 'odd' }, ['x']), null, 'a malformed Overview ⇒ null');
});

test('P6 «Todas las sucursales» through the REAL core: public null + public_by_rid per branch, never combined', async () => {
  const db = await world();
  for (let i = 0; i < 10; i += 1) await rated(db, UIDS[i], `XPZ-c${i}`, { at: NOW - (20 + i) * DAY, store: 4 });
  await publishStats(db, 'x_pizza'); await publishStats(db, 'xp_sur');
  const st = await visit(server(db), { rids: ['x_pizza', 'xp_sur'] }).load();
  assert.equal(st.overview.publicOne, null, 'P6: no combined figure');
  assert.deepEqual(Object.keys(st.overview.publicByRid), ['x_pizza', 'xp_sur']);
  assert.deepEqual([st.overview.publicByRid.x_pizza.count, st.overview.publicByRid.xp_sur], [10, null], 'P6: per branch; Sur under 10 ⇒ null');
});

test('P7 paging through the REAL core: 45 named ⇒ 20 + 20 + 5, newest first; page 1\'s Overview is KEPT on cursor pages (their overview is null)', async () => {
  const db = await world();
  for (let i = 0; i < 26; i += 1) await named(db, UIDS[i], `P${String.fromCharCode(65 + i)}`, 'Q');
  for (let i = 0; i < 45; i += 1) await rated(db, UIDS[i % 26], `XPZ-p${String(i).padStart(2, '0')}`, { at: NOW - (2 + i) * H, store: 5, comment: `c${i}` });
  await buildBuckets(db); await publishStats(db);
  const srv = server(db);
  const list = visit(srv);
  let st = await list.load();
  const ov = st.overview;
  assert.ok(ov && ov.publicOne && ov.publicOne.count === 45, 'premise: page 1 carries the Overview');
  assert.deepEqual([st.rows.length, st.more], [20, true]);
  st = await list.load(); assert.deepEqual([st.rows.length, st.more], [40, true]);
  assert.deepEqual(st.overview, ov, 'P7: a cursor page never clears page 1\'s Overview');
  st = await list.load(); assert.deepEqual([st.rows.length, st.more, st.phase], [45, false, 'ready']);
  assert.deepEqual(st.rows.map((r) => r.comment), Array.from({ length: 45 }, (_, i) => `c${i}`), 'newest first, no duplicates');
  const q = srv.calls.filter((c) => c.fn === 'getMerchantReviews').map((c) => c.query);
  assert.deepEqual(q[0], { rids: 'x_pizza', weeks: '4' }, 'page 1: exactly rids + weeks (no cursor, no default filters)');
  assert.ok(q.slice(1).every((x) => typeof x.cursor === 'string'), 'later pages: the sealed cursor');
  assert.equal(srv.calls[0].headers.authorization, 'Bearer ownerX', 'the token rides in the header, never the URL');
});

test('P8 filters on the wire: stars sorted + comment; a refused cursor (another filter set\'s) restarts ONCE from page 1, without duplicates', async () => {
  const db = await world();
  await named(db, UIDS[0]);
  for (let i = 0; i < 25; i += 1) await rated(db, UIDS[0], `XPZ-f${String(i).padStart(2, '0')}`, { at: NOW - (2 + i) * H, store: 1 + (i % 2), comment: `f${i}` });
  const srv = server(db);
  globalThis.fetch = srv.fetch;
  const other = await fetchMerchantReviews({ rids: ['x_pizza'], weeks: 4, token: tokenOf('ownerX') });
  assert.equal(typeof other.cursor, 'string', 'premise: a cursor of the unfiltered list');
  let swapped = false;
  const list = L.createReviewList({ rids: ['x_pizza'], fetchPage: async ({ cursor }) => {
    const c = cursor !== undefined && !swapped ? (swapped = true, other.cursor) : cursor;   // the second page sends a cursor the filter set refuses
    return fetchMerchantReviews({ rids: ['x_pizza'], weeks: 4, stars: [2, 1], comment: 'with', cursor: c, token: tokenOf('ownerX') });
  } });
  let st = await list.load();
  assert.equal(st.rows.length, 20);
  st = await list.load();
  assert.equal(st.phase, 'ready', 'P8: the refused cursor restarted, not an error');
  assert.equal(new Set(st.rows.map((r) => r.comment)).size, st.rows.length, 'no duplicates after the restart');
  const q = srv.calls.filter((c) => c.fn === 'getMerchantReviews').map((c) => c.query);
  assert.deepEqual([q[1].stars, q[1].comment], ['1,2', 'with'], 'P8: stars sorted, comment on the wire');
  const sts = srv.calls.filter((c) => c.fn === 'getMerchantReviews').map((c) => c.status);
  assert.deepEqual(sts.slice(1), [200, 400, 200], 'P8: page 1, the refused cursor (400 bad_cursor), page 1 again');
});

test('P9 states through the REAL core: 403 another brand ⇒ denied (one call); 429 / 503 / a network failure ⇒ error; a malformed body ⇒ error', async () => {
  const db = await world();
  const srv = server(db);
  assert.equal((await visit(srv, { who: 'ownerM' }).load()).phase, 'denied', 'P9: another brand');
  assert.equal(srv.calls.length, 1, 'no retry loop on a 403');
  assert.equal((await visit(server(db, { limited: true })).load()).phase, 'error', '429');
  assert.equal((await visit(server(db, { down: true })).load()).phase, 'error', 'network');
  assert.equal((await visit(srv, { extra: (b) => ({ ...b, reviews: 'x' }) }).load()).phase, 'error', 'malformed');
  const empty = await visit(srv).load();
  assert.deepEqual([empty.phase, empty.rows.length, empty.more], ['empty', 0, false], 'no named rating ⇒ empty');
});
