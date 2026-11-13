// «Envío» step 2, Z1 — the «Zonas sin entrega» card (the approved MOCKUP-portal-envio-v2 card; the server states of
// MOCKUP-portal-envio-zones-addendum A–C; copy the addendum PROPOSES is a ⟦zones.key⟧ placeholder and the SHIP GATE stays red until the
// owner approves it). The page is the REAL app over the shipped index.html; the server is 5f's REAL getDeliveryPricingCore with the
// REAL zones lock (getIdentity + the strict grace read, production's deps) over hours stored on each restaurant's identity.
// Drawing on the map is Z2 (protocol v3, PLAN-portal-zones-protocol-v3-r0): here «Dibujar zona» is off with its line.
// Run: node --test --test-force-exit envio-zones-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './ventas-harness.mjs';
import { server, page, POLICY, B3 } from './envio-harness.mjs';

const { ZONES_COPY } = await import('./envio-logic.js');
const P = (k) => `⟦zones.${k}⟧`;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hoursAll = (start, end) => Object.fromEntries(DAYS.map((d) => [d, start ? { open: true, start, end } : { open: false }]));
const CLOSED = hoursAll(null), OPEN = hoursAll('10:00', '22:00');
// a grammar-valid identity (5f's zones-writer test ID()), with the hours the lock reads
const ID = (name, location, hours, extra = {}) => ({ name, phone: '+50499990000', active: true, version: 1, hub_lat: 15.5, hub_lng: -88.0,
  delivery_radius_km: 8, location_name: location, brand_id: `b_${name}`, ...(hours === undefined ? {} : { hours }), ...extra });
const world = (h1, h2) => ({ ids: ['r_uno', 'r_dos'],
  restaurants: { r_uno: { identity: ID('Uno', 'Centro', h1) }, r_dos: { identity: ID('Dos', 'Norte', h2) } },
  brands: { b_Uno: { name: 'Uno' }, b_Dos: { name: 'Dos' } } });
const r6 = (x) => Number(x.toFixed(6));   // the stored grid: 6 decimals (zones.js) — 15.52 + 0.01 is 15.530000000000001 in floats
const SQ = (lat, lng, d = 0.01) => [[lat, lng], [lat, r6(lng + d)], [r6(lat + d), r6(lng + d)], [r6(lat + d), lng]];
const STORED = [{ id: 'z_aaaaaaaa', name: 'Sector A', points: SQ(15.52, -88.02) }, { id: 'z_bbbbbbbb', name: 'Sector B', points: SQ(15.45, -88.0).slice(0, 3) }];
const withZones = (zones = STORED) => ({ ...POLICY(3, B3), no_delivery_zones: zones });
async function open(srv) {
  const P0 = await page({ srv });
  await P0.signIn(); await P0.open(); await settle(60);
  return P0;
}
const card = (p) => p.d.querySelector('section.envzones');
const rows = (p) => [...card(p).querySelectorAll('.zrow')];

test('the card (approved v2): the title and its hint, the help, one row per stored zone — its name, «N puntos», rename and remove', async () => {
  const p = await open(server({ policy: withZones(), world: world(CLOSED, CLOSED) }));
  const c = card(p);
  assert.ok(c, '🔴 the card');
  assert.equal(c.querySelector('h3').firstChild.textContent.trim(), 'Zonas sin entrega');
  assert.equal(c.querySelector('h3 .ehint').textContent, 'Para todos los restaurantes');
  assert.equal(c.querySelector('p.ehelp').textContent, 'Áreas donde no entregamos aunque estén dentro del límite, por seguridad de los repartidores. Dibujalas sobre el mapa.');
  assert.deepEqual(rows(p).map((r) => r.querySelector('.k').firstChild.textContent), ['Sector A', 'Sector B']);
  assert.deepEqual(rows(p).map((r) => r.querySelector('.k .s').textContent.split(' · ')[0]), ['4 puntos', '3 puntos']);
  assert.equal(rows(p)[0].querySelector('.k .s').textContent, '4 puntos · dentro de 4 km', 'the farthest vertex from the picked pin (≈ 3.97 km), rounded up');
  const [ren, rem] = rows(p)[0].querySelectorAll('button.ib');
  assert.equal(ren.title, 'Renombrar'); assert.equal(ren.getAttribute('aria-label'), 'Renombrar Sector A');
  assert.equal(rem.title, 'Quitar'); assert.equal(rem.getAttribute('aria-label'), 'Quitar Sector A');
});

test('A — every restaurant closed (zones_editable): the editable note; «Dibujar zona» off until the map can draw (Z2) with its line', async () => {
  const p = await open(server({ policy: withZones(), world: world(CLOSED, CLOSED) }));
  const draw = [...card(p).querySelectorAll('button.railadd')].find((b) => b.textContent.includes('Dibujar zona'));
  assert.ok(draw, 'the action'); assert.equal(draw.disabled, true, 'Z1: no drawing yet');
  const notes = [...card(p).querySelectorAll('.efnote')].map((n) => n.textContent);
  assert.ok(notes.includes(P('editableNote')), '🔴 the editable note'); assert.ok(notes.includes(P('mapUpdating')), 'why it is off');
  assert.ok(rows(p).every((r) => [...r.querySelectorAll('button.ib')].every((b) => !b.disabled)), 'rename / remove on');
  assert.equal(card(p).querySelector('.ecallout'), null, 'no lock callout');
});

test('B — a restaurant open (zones_lock open): the sand callout, rename / remove off; the fees stay editable', async () => {
  const p = await open(server({ policy: withZones(), world: world(OPEN, CLOSED) }));
  const co = card(p).querySelector('.ecallout.sand');
  assert.ok(co, '🔴 the lock callout');
  assert.equal(co.querySelector('b').textContent, P('lockedTitle')); assert.ok(co.textContent.includes(P('lockedBody')));
  assert.ok(rows(p).every((r) => [...r.querySelectorAll('button.ib')].every((b) => b.disabled)), 'rename / remove off');
  assert.equal(p.d.querySelector('.envbands input').disabled, false, 'the fees stay editable');
});

test('C — hours cannot be read (a restaurant without valid hours ⇒ hours_unknown; an outage ⇒ unavailable): the callout + «Volver a comprobar» re-reads', async () => {
  const srv = server({ policy: withZones(), world: world(undefined, CLOSED) });
  const p = await open(srv);
  const co = card(p).querySelector('.ecallout');
  assert.ok(co, '🔴 the callout');
  assert.equal(co.querySelector('b').textContent, P('hoursTitle')); assert.ok(co.textContent.includes(P('hoursBody')));
  const again = co.querySelector('button');
  assert.equal(again.textContent, P('recheck'));
  const g0 = srv.gets;
  again.click(); await settle(60);
  assert.equal(srv.gets, g0 + 1, 'a fresh read');
});

test('a malformed / unreadable zones list: no rows, no editing — the card says the list could not be read (fail closed)', async () => {
  const p = await open(server({ policy: withZones([{ id: 'bad', name: 'X', points: [[1, 2]] }]), world: world(CLOSED, CLOSED) }));
  assert.equal(rows(p).length, 0);
  assert.ok([...card(p).querySelectorAll('.efnote, .ecallout')].some((n) => n.textContent.includes(P('unreadable'))), '🔴 said, not silent');
});

// ── Z1b: rename / remove in the draft, the save, the outcomes (addendum D–F) ──
const zrow = (p, name) => rows(p).find((r) => r.querySelector('.k') && r.querySelector('.k').firstChild.textContent === name);
const key = (el, k) => el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
async function rename(p, from, to) {
  zrow(p, from).querySelector('button.ib[title="Renombrar"]').click(); await settle(5);
  const inp = card(p).querySelector('.zrow.editing input');
  inp.value = to; inp.dispatchEvent(new inp.ownerDocument.defaultView.Event('input', { bubbles: true }));
  key(inp, 'Enter'); await settle(5);
}
async function saveAll(p) {
  p.btn('Guardar').click(); await settle(10);
  p.btn('Guardar cambios').click(); await settle(80);
}
test('rename in place: Enter keeps it in the draft (the bar says so); empty / duplicate (case-folded) are refused in place; Esc cancels', async () => {
  const p = await open(server({ policy: withZones(), world: world(CLOSED, CLOSED) }));
  zrow(p, 'Sector A').querySelector('button.ib[title="Renombrar"]').click(); await settle(5);
  const inp = card(p).querySelector('.zrow.editing input');
  assert.equal(inp.value, 'Sector A'); assert.equal(p.d.activeElement, inp);
  key(inp, 'Escape'); await settle(5);
  assert.equal(card(p).querySelector('.zrow.editing'), null, 'Esc cancels');
  await rename(p, 'Sector A', '  ');
  assert.equal(card(p).querySelector('.zrow.editing + .ferr, .zrow.editing .ferr, .zlist .ferr').textContent, P('nameEmpty'));
  const inp2 = card(p).querySelector('.zrow.editing input'); inp2.value = 'sector b'; inp2.dispatchEvent(new inp2.ownerDocument.defaultView.Event('input', { bubbles: true })); key(inp2, 'Enter'); await settle(5);
  const taken = card(p).querySelector('.zlist .ferr');
  assert.ok(taken, '🔴 a taken name, case-folded (the server\'s rule)'); assert.equal(taken.textContent, P('nameTaken'), '🔴 a taken name, case-folded (the server\'s rule)');
  const inp3 = card(p).querySelector('.zrow.editing input'); inp3.value = 'Sector Norte'; inp3.dispatchEvent(new inp3.ownerDocument.defaultView.Event('input', { bubbles: true })); key(inp3, 'Enter'); await settle(5);
  assert.ok(zrow(p, 'Sector Norte'), '🔴 renamed in the draft');
  assert.ok(p.bar().classList.contains('show'), 'the bar'); assert.ok(p.bar().textContent.includes(P('barSuffix')), 'the zones suffix');
});

test('remove asks first (the small «Quitar zona» modal, «Cancelar» focused); confirming drops the row from the draft', async () => {
  const p = await open(server({ policy: withZones(), world: world(CLOSED, CLOSED) }));
  zrow(p, 'Sector B').querySelector('button.ib[title="Quitar"]').click(); await settle(5);
  const m = p.d.querySelector('.envzrm');
  assert.ok(m, '🔴 the modal'); assert.equal(m.querySelector('h2').textContent, P('removeTitle'));
  const bs = [...m.querySelectorAll('button')];
  assert.deepEqual(bs.map((b) => b.textContent), ['Cancelar', 'Quitar']); assert.equal(p.d.activeElement, bs[0]);
  bs[0].click(); await settle(5); assert.ok(zrow(p, 'Sector B'), 'kept');
  zrow(p, 'Sector B').querySelector('button.ib[title="Quitar"]').click(); await settle(5);
  [...p.d.querySelectorAll('.envzrm button')][1].click(); await settle(5);
  assert.equal(zrow(p, 'Sector B'), undefined, 'gone from the draft'); assert.ok(p.bar().classList.contains('show'));
});

test('save: the REVIEWED body carries the zones; the REAL writer stores them; the toast says both; a bands-only save sends no zones', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  await saveAll(p);
  const node = await srv.node();
  assert.deepEqual(node.no_delivery_zones.map((z) => z.name), ['Sector Norte', 'Sector B'], '🔴 stored by the real writer');
  assert.ok(p.d.getElementById('opstoast').textContent.includes(P('savedBoth')));
  assert.equal(card(p).querySelector('.zlist .ferr'), null);
  p.type(0, 'fee', '45'); await settle(5);
  await saveAll(p);
  assert.equal('no_delivery_zones' in srv.posts[srv.posts.length - 1], false, 'a bands-only save never sends zones');
});

test('D — a restaurant opened before the save: 409 zones_locked_while_open ⇒ the panel (who, why), the draft kept; «Guardar solo las tarifas» saves the fees only', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  p.type(0, 'fee', '45'); await settle(5);
  await srv.db.ref('restaurants/r_uno/identity/hours').set(OPEN); srv.forgetIdentities();   // Uno opens while the merchant edits
  await saveAll(p);
  const box = p.d.querySelector('.envzfail');
  assert.ok(box, '🔴 the panel'); assert.equal(box.querySelector('b, h3').textContent, P('lockedSaveTitle'));
  assert.ok(box.textContent.includes('Centro'), 'the open branch by name');
  assert.ok(zrow(p, 'Sector Norte'), 'the draft kept');
  const fees = [...box.querySelectorAll('button')].find((b) => b.textContent === P('feesOnly'));
  assert.ok(fees, 'the fees-only action (bands are dirty too)');
  fees.click(); await settle(80);
  assert.equal('no_delivery_zones' in srv.posts[srv.posts.length - 1], false, '🔴 «Guardar solo las tarifas» never sends the zones');
  const node = await srv.node();
  assert.equal(node.bands[0].cents, 4500, 'the fees landed');
  assert.deepEqual(node.no_delivery_zones.map((z) => z.name), ['Sector A', 'Sector B'], 'the zones did not');
  assert.ok(zrow(p, 'Sector Norte'), 'the zones draft is still there');
});

test('E — the hours cannot be read at the save (503 hours_unavailable): the panel, the draft kept, «Reintentar» resends the SAME attempt', async () => {
  const reg = { fresh: true };
  const W = world(CLOSED, CLOSED);
  const srv = server({ policy: withZones(), world: W, registry: async () => ({ ok: true, fresh: reg.fresh, ids: W.ids }) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  reg.fresh = false;   // the restaurant registry cannot be read fresh at save time: the lock fails closed (503)
  await saveAll(p);
  const box = p.d.querySelector('.envzfail');
  assert.ok(box, '🔴 the panel'); assert.equal(box.querySelector('b').textContent, P('hoursSaveTitle'));
  assert.ok(zrow(p, 'Sector Norte'), 'the draft kept');
  const n0 = srv.posts.length;
  reg.fresh = true;
  [...box.querySelectorAll('button')].find((b) => b.textContent === 'Reintentar').click(); await settle(80);
  assert.equal(srv.posts.length, n0 + 1, 'one resend');
  assert.deepEqual(srv.posts[srv.posts.length - 1].no_delivery_zones.map((z) => z.name), ['Sector Norte', 'Sector B'], 'the same attempt');
  assert.deepEqual((await srv.node()).no_delivery_zones.map((z) => z.name), ['Sector Norte', 'Sector B'], 'stored');
});

test('G — at the 8-zone cap: the card\'s hint says «8 de 8» and «Dibujar zona» says why it is off', async () => {
  const eight = Array.from({ length: 8 }, (_, n) => ({ id: `z_aaaaaaa${n}`, name: `Sector ${n}`, points: SQ(r6(15.52 + n * 0.02), -88.02) }));
  const p = await open(server({ policy: withZones(eight), world: world(CLOSED, CLOSED) }));
  assert.equal(rows(p).length, 8, 'premise');
  assert.equal(card(p).querySelector('h3 .ehint').textContent, P('capCount'), '🔴 the count at the cap');
  assert.ok([...card(p).querySelectorAll('.efnote')].some((n) => n.textContent === P('capDraw')), 'why the action is off');
});

// THE SHIP GATE: red while ANY zones string is a placeholder
test('SHIP GATE: no placeholder ships — every zones string is owner-approved text', () => {
  const pending = Object.entries(ZONES_COPY).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders still pending owner approval: ${pending.join(', ')}`);
});
