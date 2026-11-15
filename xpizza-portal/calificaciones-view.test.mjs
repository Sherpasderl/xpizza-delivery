// P-1 «Calificaciones» — the VIEW, built EXACT to MOCKUP-portal-calificaciones.html (advisor 11-13: drawing half GO; owner sign-off on the
// strings pending). The REAL getMerchantRatingComments core over the real writers (calificaciones-harness.mjs), the portal's real api.js,
// the view in jsdom. Every string the mockup PROPOSES is a placeholder ⟦cal.key⟧ until the owner approves it; the SHIP GATE cell below is
// RED until then, by design. The figures follow the approved contract (advisor 11-13): the first page's `stats` — {rating_avg,
// rating_count} ⇒ the two figures; null ⇒ the under-10 sentence; ABSENT ⇒ no box (3a's f5cad194, read-only from its
// ref). Run: node --test calificaciones-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = dirname(fileURLToPath(import.meta.url));
import { SEED, fakeDb, order, server, tokenOf, JSDOM, fetchRatingComments } from './calificaciones-harness.mjs';

const { V2, AG, ratingsOf } = await import('./calificaciones-harness.mjs');
const { calificacionesTab, CAL_COPY, calCopy } = await import('./calificaciones.js');

const settle = (n = 30) => new Promise((r) => { let i = 0; const go = () => (++i >= n ? r() : setTimeout(go, 0)); go(); });
const P = (k) => `⟦cal.${k}⟧`;
// a page with the mount the Rendimiento tab gives it; `wrap` edits the endpoint's answer (the stats contract, a failure)
function page(db, { who = 'ownerX', rid = 'x_pizza', wrap, hold } = {}) {
  const win = new JSDOM('<!doctype html><div id="pane"></div>').window;
  globalThis.document = win.document; globalThis.window = win;
  const srv = server(db);
  globalThis.fetch = async (url, opts) => {
    if (hold) await hold.p;
    const res = await srv.fetch(url, opts);
    if (!wrap) return res;
    const w = await wrap(res);
    return w || res;
  };
  const el = win.document.getElementById('pane');
  calificacionesTab.mount(el, { rid, token: tokenOf(who), scopeLabel: 'Sucursal Centro' });
  return { el, srv, $: (s) => el.querySelector(s), $$: (s) => [...el.querySelectorAll(s)] };
}
const withStats = (stats) => async (res) => {
  if (!res.ok) return null;
  const body = await res.json();
  return { ok: true, status: 200, json: async () => (body.cursor === undefined ? body : { ...body, stats }) };
};
const firstOnly = (stats) => { let first = true; return async (res) => { if (!first || !res.ok) return null; first = false; const b = await res.json(); return { ok: true, status: 200, json: async () => ({ ...b, stats }) }; }; };
async function rated(n, db = fakeDb(SEED)) { for (let i = 0; i < n; i++) await order(db, `XPZ-v${i}`, { at: 10000 + i * 10, comment: `Comentario ${i}`, store: 1 + (i % 5) }); return db; }
const hold = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };

test('first paint: the final layout\'s boxes as quiet bars; the scope, the section title and the anonymity line are real from the start', async () => {
  const h = hold();
  const v = page(await rated(3), { hold: h });
  const root = v.$('.calif');
  assert.ok(root, 'the view root');
  assert.equal(v.$('.calif-scope').textContent, 'Sucursal Centro', 'the branch, stated once');
  assert.ok(v.$('.calif-scope svg'), 'the building icon');
  assert.equal(v.$('.sect h2').textContent, 'Lo que dicen tus clientes', 'approved title, literal');
  assert.equal(v.$('.sect .subl').textContent, P('anon'));
  assert.equal(v.$('[aria-busy="true"]') !== null, true);
  assert.equal(v.$$('.kfigs.sk .kfig').length, 2); assert.equal(v.$$('.clist .skrow').length, 5); assert.ok(v.$('.pager .skb.b'));
  assert.ok(v.$$('.clist .skrow').every((r) => r.querySelector(':scope > .skb.c') && r.querySelector('.skl .skb.a') && r.querySelector('.skl .skb.s') && r.querySelector('.skl .skb.t')), 'the bones mirror the new row: a disc, a name bar, a stars bar, a text bar');
  h.release(); await settle();
  assert.equal(v.$('[aria-busy="true"]'), null, 'rows replace the bars');
  assert.equal(v.$$('.crow').length, 3);
});

test('the figures follow the contract: {avg, count} ⇒ two figures; null ⇒ the under-10 sentence in the SAME box; ABSENT ⇒ no box', async () => {
  const db = await rated(3);
  const a = page(db, { wrap: firstOnly({ rating_avg: 4.6, rating_count: 128 }) }); await settle();
  const figs = a.$$('.kfigs.surface .kfig');
  assert.equal(a.$('.kfigs.surface.say'), null);
  assert.deepEqual(figs.map((f) => f.querySelector('.kl').textContent), ['Calificación promedio', 'Calificaciones']);
  assert.deepEqual(figs.map((f) => f.querySelector('.kn').firstChild.textContent), ['4.6', '128']);
  assert.deepEqual(figs.map((f) => f.querySelector('.kn small').textContent), [P('avgOf'), P('countTotal')]);
  const b = page(db, { wrap: firstOnly(null) }); await settle();
  assert.equal(b.$('.kfigs.surface.say .ksay').textContent, P('under10'), '🔴 below 10: the honest sentence, never a 0');
  assert.equal(b.$('.kfigs.surface.say .kl').textContent, 'Calificación promedio');
  const c = page(db, { wrap: async (res) => { const b = await res.json(); delete b.stats; return { ok: true, status: 200, json: async () => b }; } }); await settle();
  assert.equal(c.$('.kfigs'), null, '🔴 no stats key: no box at all (never a guess)');
  assert.equal(c.$$('.crow').length, 3, 'the list is drawn regardless');
});

test('empty: the plain two lines at the list\'s edge, no pager', async () => {
  const db = fakeDb(SEED); await order(db, 'XPZ-x', { at: 1000 });
  const v = page(db); await settle();
  assert.equal(v.$('.cempty b').textContent, P('emptyTitle')); assert.equal(v.$('.cempty p').textContent, P('emptyBody'));
  assert.equal(v.$('.pager'), null); assert.equal(v.$$('.crow').length, 0);
});

test('no access (403): the line + who can grant it — nothing else drawn, no retry', async () => {
  const v = page(await rated(2), { who: 'ownerM' }); await settle();
  assert.equal(v.$('.cerr b').textContent, P('deniedTitle')); assert.equal(v.$('.cerr p').textContent, P('deniedBody'));
  assert.equal(v.$('.cerr button'), null, 'no retry'); assert.equal(v.$('.kfigs'), null); assert.equal(v.$('.clist'), null); assert.equal(v.$('.sect'), null);
});

test('error (503 / 429 / network): the line + «Reintentar» in the list area; a retry reads again', async () => {
  const db = await rated(4);
  let fail = true;
  const v = page(db, { wrap: async (res) => (fail ? { ok: false, status: 503, json: async () => ({ ok: false, reason: 'unavailable' }) } : null) });
  await settle();
  assert.equal(v.$('.cerr b').textContent, P('errTitle')); assert.equal(v.$('.cerr p').textContent, P('errBody'));
  const btn = v.$('.cerr button'); assert.ok(btn); assert.equal(btn.textContent, P('retry'));
  assert.equal(v.$('.cerr').getAttribute('role'), 'alert');
  fail = false; btn.click(); await settle();
  assert.equal(v.$('.cerr'), null); assert.equal(v.$$('.crow').length, 4, 'retry: the list');
});

test('paging: «Ver más comentarios» turns into «Cargando…» in place (disabled), appends below; at the end a muted line replaces it', async () => {
  const v = page(await rated(45)); await settle();
  assert.equal(v.$$('.crow').length, 20);
  const h = hold();
  let btn = v.$('.pager button');
  assert.equal(btn.textContent, P('more'));
  globalThis.fetch = ((orig) => async (u, o) => { await h.p; return orig(u, o); })(globalThis.fetch);
  btn.click(); await settle(5);
  assert.equal(btn.disabled, true); assert.equal(btn.textContent, P('loading'), '🔴 the same button, in place');
  h.release(); await settle();
  assert.equal(v.$$('.crow').length, 40);
  btn = v.$('.pager button'); assert.equal(btn.textContent, P('more')); assert.equal(btn.disabled, false);
  btn.click(); await settle();
  assert.equal(v.$$('.crow').length, 45);
  assert.equal(v.$('.pager button'), null); assert.equal(v.$('.pager .endl').textContent, P('end'));
});

test('a LATER page that fails keeps the rows shown; the pager area carries the error line + «Reintentar», which continues', async () => {
  const db = await rated(45);
  let fail = false;
  const v = page(db, { wrap: async () => (fail ? { ok: false, status: 503, json: async () => ({ ok: false }) } : null) });
  await settle();
  fail = true; v.$('.pager button').click(); await settle();
  assert.equal(v.$$('.crow').length, 20, 'what is shown stays');
  assert.equal(v.$('.pager .cerr b').textContent, P('errTitle'));
  fail = false; v.$('.pager .cerr button').click(); await settle();
  assert.equal(v.$$('.crow').length, 40); assert.equal(v.$('.pager .cerr'), null);
});

test('a row (the colour delta, owner 11-14): the anonymous disc + «Cliente», the yellow stars, the comment clamped with «Leer más» / «Leer menos»; no name, date, tag or dish (PLAN-3a r2)', async () => {
  const v = page(await rated(1)); await settle();
  const row = v.$('.crow');
  assert.equal(row.tagName, 'DIV');
  const av = row.querySelector(':scope > .cav');
  assert.ok(av && av.classList.contains('anon') && av.getAttribute('aria-hidden') === 'true', 'the neutral disc (every rating today is anonymous)');
  assert.ok(av.querySelector('svg path') && av.querySelector('svg circle'), 'the person glyph, never initials');
  const body = row.querySelector(':scope > .cbody');
  assert.equal(body.querySelector('.chd .cname.anon').textContent, 'Cliente', 'the drawn name of an anonymous rating');
  const st = body.querySelector('.stars'); assert.equal(st.getAttribute('aria-label'), '1 de 5 estrellas');
  assert.equal(st.querySelectorAll('svg path').length, 5, 'the star shape inline (the portal has no sprite)');
  assert.equal(st.querySelectorAll('svg.e').length, 4, 'four outlined empties');
  const p = body.querySelector('.ctxt'); assert.ok(p.classList.contains('clamp')); assert.equal(p.textContent, 'Comentario 0');
  const more = body.querySelector('button.qact.cmore'); assert.equal(more.textContent, P('readMore')); assert.equal(more.getAttribute('aria-expanded'), 'false');
  more.click();
  assert.ok(!p.classList.contains('clamp')); assert.equal(more.textContent, P('readLess')); assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...body.children].map((c) => c.className), ['chd', 'stars', 'ctxt', 'qact cmore'], 'header · stars · text · expander — 🔴 no tag, dishes or date until PLAN-3a r2 serves them');
});
test('the colour delta\'s stars (owner 11-14 «A shape, yellow stars»): filled #FFD60A with a #E3A800 hairline in light, #FFD60A in dark; empties outlined in --mute2', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  const block = (sel) => { const i = css.indexOf(sel); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };
  const tok = (b, k) => (b.match(new RegExp(`--${k}:([^;]+);`)) || [])[1];
  const light = block(':root, :root[data-theme="light"]{'), dark = block(':root[data-theme="dark"]{'), sys = block('@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){');
  assert.deepEqual([tok(light, 'star'), tok(light, 'star-line')], ['#FFD60A', '#E3A800'], 'light');
  assert.deepEqual([tok(dark, 'star'), tok(dark, 'star-line')], ['#FFD60A', '#FFD60A'], 'dark');
  assert.deepEqual([tok(sys, 'star'), tok(sys, 'star-line')], ['#FFD60A', '#FFD60A'], 'system dark');
  assert.match(css, /\.calif \.stars svg\{[^}]*fill:var\(--star\);stroke:var\(--star-line\)/, 'the filled stars');
  assert.match(css, /\.calif \.stars svg\.e\{fill:none;stroke:var\(--mute2\)/, 'the empties');
});


test('copy: the approved strings are literal; every other string is a ⟦cal.key⟧ placeholder until the owner approves the mockup', () => {
  for (const [k, v] of Object.entries({ title: 'Lo que dicen tus clientes', avg: 'Calificación promedio', count: 'Calificaciones' })) assert.equal(calCopy(k), v);
  assert.equal(calCopy('anon'), P('anon'));
  assert.equal(calificacionesTab.id, 'calificaciones'); assert.equal(calificacionesTab.label, 'Calificaciones');
});

// THE SHIP GATE: red while ANY string is a placeholder — the branch cannot ride a train before the owner approves the mockup's copy
test('SHIP GATE: no placeholder ships — every Calificaciones string is owner-approved text', () => {
  const pending = Object.entries(CAL_COPY).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders still pending owner approval: ${pending.join(', ')}`);
});

// 3a's contract (f5cad194, loaded read-only from its ref by the harness): the REAL first page, end to end through the view
const publishFor = async (db, rid, ids) => {   // public_stats/{rid} through the REAL chain (3a's own test): readCountable → the producer
  const ratings = []; for (const id of ids) ratings.push(await V2.readCountable(db, id));
  db.set(`public_stats/${rid}`, AG.publish({ rid, nowMs: 50000, buckets: {}, ratings, priceOf: () => null, firstServedAt: 1000 }));
};
test('the REAL first page: ≥ 10 published ⇒ the producer\'s figures; below 10 ⇒ the under-10 sentence; a later page has no key', async () => {
  const db = await rated(22);
  await publishFor(db, 'x_pizza', Array.from({ length: 22 }, (_, i) => `XPZ-v${i}`));
  const want = ratingsOf(db.get('public_stats/x_pizza'));
  assert.ok(want && want.rating_count === 22, 'premise: the producer published');
  const v = page(db); await settle();
  assert.deepEqual(v.$$('.kfigs.surface .kfig .kn').map((n) => n.firstChild.textContent), [String(want.rating_avg), '22'], '🔴 the published figures');
  v.$('.pager button').click(); await settle();
  assert.equal(v.$$('.crow').length, 22); assert.equal(v.$$('.kfigs').length, 1, 'a later page (no stats key) leaves the box as it is');
  const few = page(await rated(9)); await settle();
  assert.equal(few.$('.kfigs.surface.say .ksay').textContent, P('under10'), '🔴 stats: null ⇒ the honest sentence');
});

test('the REAL first page on a stats-read OUTAGE: the key is absent ⇒ no box; the comments still show', async () => {
  const db = await rated(3);
  const ref = db.ref;
  db.ref = (p) => (String(p).startsWith('public_stats') ? { once: async () => { throw Object.assign(new Error('x'), { code: 'unavailable' }); } } : ref(p));
  const err = console.error; console.error = () => {};
  try {
    const v = page(db); await settle();
    assert.equal(v.$('.kfigs'), null, '🔴 an outage never draws a box (never a guess, never «fewer than 10»)');
    assert.equal(v.$$('.crow').length, 3);
  } finally { console.error = err; }
});

test('the REAL first page on INVALID published stats (≥ 10 with an average out of range): the key is absent ⇒ no box; the comments still show', async () => {
  const db = await rated(12);
  await publishFor(db, 'x_pizza', Array.from({ length: 12 }, (_, i) => `XPZ-v${i}`));
  assert.ok(ratingsOf(db.get('public_stats/x_pizza')), 'premise: a valid published doc first');
  db.set('public_stats/x_pizza/rating_avg', 9);   // a corrupt average with a count ≥ 10
  const err = console.error; console.error = () => {};
  try {
    const v = page(db); await settle();
    assert.equal(v.$('.kfigs'), null, '🔴 invalid data never draws a box (never a guess, never «fewer than 10»)');
    assert.equal(v.$$('.crow').length, 12);
  } finally { console.error = err; }
});

test('the REAL first page on a NON-OBJECT published doc (a number, a string, an array): the key is absent ⇒ no box', async () => {
  const err = console.error; console.error = () => {};
  try {
    for (const bad of [7, 'x', [1, 2], true]) {
      const db = await rated(2);
      db.set('public_stats/x_pizza', bad);
      const v = page(db); await settle();
      assert.equal(v.$('.kfigs'), null, `🔴 ${JSON.stringify(bad)}: no box (never «fewer than 10»)`);
      assert.equal(v.$$('.crow').length, 2);
    }
  } finally { console.error = err; }
});
