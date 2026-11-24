// «Envío» step 2, Z1 — the «Zonas sin entrega» card (the approved MOCKUP-portal-envio-v2 card; the server states of
// MOCKUP-portal-envio-zones-addendum A–C; its copy is the owner-approved text in envio-logic ZONES_COPY (11-14, advisor 11-19), a key still
// null is a ⟦zones.key⟧ placeholder and the SHIP GATE stays red). The page is the REAL app over the shipped index.html; the server is 5f's REAL getDeliveryPricingCore with the
// REAL zones lock (getIdentity + the strict grace read, production's deps) over hours stored on each restaurant's identity.
// Drawing on the map is Z2 (protocol v3, PLAN-portal-zones-protocol-v3-r0): here «Dibujar zona» is off with its line.
// Run: node --test --test-force-exit envio-zones-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './ventas-harness.mjs';
import { server, page, POLICY, B3 } from './envio-harness.mjs';

const { ZONES_COPY, zonesCopy } = await import('./envio-logic.js');
const P = (k, vars) => zonesCopy(k, vars);   // the shipped string (or its ⟦zones.key⟧ placeholder while null)
// the DESKTOP wording of a node that carries a phone variant (envio.js phText: span.dk + span.ph; the ph span is hidden ≥ 560 px)
const dk = (n) => [...n.childNodes].map((c) => (c.nodeType === 3 ? c.data : c.classList && c.classList.contains('ph') ? '' : dk(c))).join('');
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
  assert.ok(notes.includes(P('editableNote')), '🔴 the editable note'); assert.equal(notes.length, 1, 'below the cap no other note: the approved frames draw none (advisor 11-19)');
  assert.ok(rows(p).every((r) => [...r.querySelectorAll('button.ib')].every((b) => !b.disabled)), 'rename / remove on');
  assert.equal(card(p).querySelector('.ecallout'), null, 'no lock callout');
});

test('B — a restaurant open (zones_lock open): the sand callout, rename / remove off; the fees stay editable', async () => {
  const p = await open(server({ policy: withZones(), world: world(OPEN, CLOSED) }));
  const co = card(p).querySelector('.ecallout.sand');
  assert.ok(co, '🔴 the lock callout');
  assert.equal(dk(co.querySelector('b')), P('lockedTitle')); assert.ok(dk(co).includes(P('lockedBody')));
  assert.equal(co.querySelector('b .ph').textContent, P('lockedTitlePh'), 'frame H: the phone title'); assert.ok(co.textContent.includes(P('lockedBodyPh')), 'frame H: the phone body');
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
  assert.ok(p.bar().classList.contains('show'), 'the bar'); assert.ok(dk(p.bar()).includes(` · ${P('barOther')}`), 'the zones suffix');
});

test('remove asks first (the small «Quitar zona» modal, «Cancelar» focused); confirming drops the row from the draft', async () => {
  const p = await open(server({ policy: withZones(), world: world(CLOSED, CLOSED) }));
  zrow(p, 'Sector B').querySelector('button.ib[title="Quitar"]').click(); await settle(5);
  const m = p.d.querySelector('.envzrm');
  assert.ok(m, '🔴 the modal'); assert.equal(m.querySelector('h2').textContent, P('removeTitle', { nombre: 'Sector B' }));
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
  // slot 11-15 (advisor, rule 16b): a lock row names the RESTAURANT and the branch, as the mockup draws it («Restaurante 2 · Sucursal 1») —
  // two restaurants' «Sucursal 1» must never read the same
  assert.deepEqual([...box.querySelectorAll('.blist .zbrow .k')].map((x) => x.textContent), ['Uno · Centro'], '«Restaurante · Sucursal»');
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

test('D2 — a branch WITHOUT valid hours in the 409: «Sin horario válido · Revisar en Sucursales» (phone «Revisar»), and the link opens THAT branch in Sucursales (addendum D/H, rule 14); the phone body', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  await srv.db.ref('restaurants/r_uno/identity/hours').set(OPEN); await srv.db.ref('restaurants/r_dos/identity/hours').remove(); srv.forgetIdentities();
  await saveAll(p);
  const box = p.d.querySelector('.envzfail');
  assert.ok(box, '🔴 the panel');
  assert.equal(dk(box.querySelector('p')), P('lockedSaveBody')); assert.equal(box.querySelector('p .ph').textContent, P('lockedSaveBodyPh'), 'frame H: the phone body');
  const rowsD = [...box.querySelectorAll('.blist .zbrow')];
  const dos = rowsD.find((r) => r.querySelector('.k').textContent === 'Dos · Norte');
  assert.ok(dos, 'the branch without hours is listed');
  assert.equal(dk(dos.querySelector('.st')), `${P('branchHours')} · ${P('branchHoursLink')}`, '🔴 frame D: the status word, then the link');
  const link = dos.querySelector('.st a.zblink');
  assert.equal(link.querySelector('.ph').textContent, P('branchHoursLinkPh'), 'frame H: «Revisar»');
  assert.equal(rowsD.find((r) => r.querySelector('.k').textContent === 'Uno · Centro').querySelector('a'), null, 'an OPEN branch has no link');
  link.click(); await settle(30);
  assert.equal(p.d.getElementById('viewsuc').classList.contains('hidden'), false, '🔴 the link opens Sucursales');
});

// F — a 400 zones refusal, from the REAL validator (delivery/zones.js normalizeInput / compactProblem) through the page's real save
// handler: the screen never sends an invalid list, so the transport alone swaps the zones the core judges (srv.rewrite). A per-zone
// problem carries zone_id ⇒ the drawn title names the zone; a list-level one has none ⇒ the title's plural (advisor 11-19); same body + action
test('F — a 400 zones refusal from the REAL validator: per-zone (zone_id) ⇒ «No se pudo guardar la zona «{nombre}»»; list-level (no zone_id) ⇒ «No se pudieron guardar las zonas»; same body + «Revisar zona»', async () => {
  const bowtie = [{ lat: 15.52, lng: -88.02 }, { lat: 15.53, lng: -88.01 }, { lat: 15.52, lng: -88.01 }, { lat: 15.53, lng: -88.02 }];   // self-crossing
  for (const [kind, rewrite, title, hasId] of [
    ['per-zone', (b) => ({ ...b, no_delivery_zones: b.no_delivery_zones.map((z) => (z.id === 'z_aaaaaaaa' ? { ...z, points: bowtie } : z)) }), P('refusedTitle', { nombre: 'Sector Norte' }), true],
    ['list-level', (b) => ({ ...b, no_delivery_zones: [...b.no_delivery_zones, null] }), P('refusedTitleBare'), false],
  ]) {
    const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
    const p = await open(srv);
    await rename(p, 'Sector A', 'Sector Norte');
    srv.rewrite = rewrite;
    await saveAll(p);
    const out = srv.answers[srv.answers.length - 1];
    assert.equal(out.status, 400, `${kind}: premise — the REAL core refused`);
    assert.equal(out.body.error, 'bad_request'); assert.equal(out.body.field, 'zones', `${kind}: a zones refusal`);
    assert.equal('zone_id' in out.body, hasId, `${kind}: premise — zone_id ${hasId ? 'present' : 'absent'} in the real answer`);
    const box = p.d.querySelector('.envzfail');
    assert.ok(box, `🔴 ${kind}: the panel`);
    assert.equal(box.querySelector('b').textContent, title, `🔴 ${kind}: the title`);
    assert.equal(box.querySelector('p').textContent, P('refusedBody'), `${kind}: the same body`);
    assert.ok([...box.querySelectorAll('button')].some((b) => b.textContent === P('reviewZone')), `${kind}: the same action`);
    assert.ok(zrow(p, 'Sector Norte'), `${kind}: the draft kept`);
  }
});

// Codex #179 P2-1..3 (draft loss): every server read the screen applies goes through ONE draft-preserving adoption — leaving and coming
// back (the «Revisar en Sucursales» link included), a fees-only save confirmed by the recovery read, «Volver a comprobar» — and an
// unsent zones draft holds the shell's leave guard
const envioView = (p) => p.mods.shell._registered.find((r) => r.id === 'envio');
test('#179 P2-1: «Revisar en Sucursales» → back to Envío keeps the zones draft; a dirty zones draft holds canLeave', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  assert.equal(envioView(p).canLeave(), false, '🔴 an unsent zones draft holds the leave guard');
  await srv.db.ref('restaurants/r_dos/identity/hours').remove(); srv.forgetIdentities();
  await saveAll(p);
  p.d.querySelector('.envzfail .zblink').click(); await settle(30);
  assert.equal(p.d.getElementById('viewsuc').classList.contains('hidden'), false, 'premise: on Sucursales');
  await p.open(); await settle(60);
  assert.ok(zrow(p, 'Sector Norte'), '🔴 the zones draft survived the round trip');
  assert.equal(zrow(p, 'Sector A'), undefined, 'not the stored name');
});
test('#179 P2-2: a fees-only save whose answer drops, confirmed by the recovery read, keeps the UNSENT zones draft', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  p.type(0, 'fee', '45'); await settle(5);
  await srv.db.ref('restaurants/r_uno/identity/hours').set(OPEN); srv.forgetIdentities();
  await saveAll(p);
  const fees = [...p.d.querySelectorAll('.envzfail button')].find((b) => b.textContent === P('feesOnly'));
  srv.fault.post = 'afterDrop';   // the server commits; the answer is lost ⇒ the recovery read decides
  fees.click(); await settle(120);
  assert.equal((await srv.node()).bands[0].cents, 4500, 'premise: the fees landed (the real core)');
  assert.ok(zrow(p, 'Sector Norte'), '🔴 the unsent zone rename is still the draft');
  assert.ok(p.bar().classList.contains('show') && dk(p.bar()).includes(P('barOther')), 'and the bar still offers it');
});
test('#179 P2-3: «Volver a comprobar» refreshes the lock and keeps an unsent fee edit', async () => {
  const srv = server({ policy: withZones(), world: world(undefined, CLOSED) });
  const p = await open(srv);
  p.type(0, 'fee', '45'); await settle(5);
  const g0 = srv.gets;
  card(p).querySelector('.ecallout button').click(); await settle(60);
  assert.equal(srv.gets, g0 + 1, 'premise: a fresh read');
  assert.equal(p.input(0, 'fee').value, '45', '🔴 the fee edit survives the recheck');
});

test('#179 P3: the client judges names as the server does — 16 emoji (32 UTF-16 units) is too long in place; an accent makes a DIFFERENT name', async () => {
  const p = await open(server({ policy: withZones(), world: world(CLOSED, CLOSED) }));
  await rename(p, 'Sector A', '😀'.repeat(16));
  const fe = card(p).querySelector('.zlist .ferr');
  assert.ok(fe && fe.textContent === P('nameLong'), '🔴 over 30 UTF-16 units is refused in place');
  key(card(p).querySelector('.zrow.editing input'), 'Escape'); await settle(5);
  await rename(p, 'Sector A', 'Séctor B');
  assert.ok(zrow(p, 'Séctor B'), '🔴 «Séctor B» ≠ «Sector B» (the server lowercases only)');
});

// Codex #180 (owner 11-19: (A), three invariants in applyRead) — Codex's own repros, through the REAL cores
const asInput = (zs) => zs.map((z) => ({ id: z.id, name: z.name, points: z.points.map(([lat, lng]) => ({ lat, lng })) }));
const away = async (p) => { p.d.getElementById('navprod').click(); await settle(20); };
test('#180 P2-1: a ZONES-ONLY draft keeps its base version — another admin saves other zones while away ⇒ «Guardar» conflicts, their zones stand', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  await away(p);
  const other = await srv.handle('setDeliveryPricing', { expected_policy_version: 3, bands: B3, no_delivery_zones: asInput([{ ...STORED[0], name: 'Remota' }, STORED[1]]) });
  assert.equal(other.status, 200, 'premise: the other admin\'s save landed (v4)');
  await p.open(); await settle(60);
  assert.ok(zrow(p, 'Sector Norte'), 'premise: the draft came back');
  await saveAll(p);
  assert.ok(p.text().includes('Alguien más cambió las tarifas, recargá'), '🔴 the CAS conflict, never a silent overwrite');
  assert.deepEqual((await srv.node()).no_delivery_zones.map((z) => z.name), ['Remota', 'Sector B'], 'their zones stand');
});
test('#180 P2-2: the read floor always advances — with fees dirty, a delayed OLDER editable read after a NEWER locked one does not unlock', async () => {
  const srv = server({ policy: withZones(), world: world(undefined, CLOSED) });   // hours unknown ⇒ locked, «Volver a comprobar» shown
  const p = await open(srv);
  p.type(0, 'fee', '45'); await settle(5);
  await srv.db.ref('restaurants/r_uno/identity/hours').set(CLOSED); srv.forgetIdentities();
  await srv.db.ref('platform_config/delivery_pricing/policy_version').set(4);   // v4: every restaurant closed ⇒ editable
  let release; srv.hold.getAfter = new Promise((r) => { release = r; });        // the v4 read is HELD after the server read it
  card(p).querySelector('.ecallout button').click(); await settle(10);
  await srv.db.ref('restaurants/r_uno/identity/hours').set(OPEN); srv.forgetIdentities();
  await srv.db.ref('platform_config/delivery_pricing/policy_version').set(5);   // v5: a restaurant open ⇒ locked
  card(p).querySelector('.ecallout button').click(); await settle(30);          // the NEWER v5 read lands first
  release(); await settle(30);                                                   // then the OLDER v4 read arrives
  assert.equal(p.mods.envio._envioState.zones.editable, false, '🔴 the older read did not unlock the zones');
  assert.ok(card(p).querySelector('.ecallout'), 'still the lock callout');
});
test('#180 P2-3: only an explicit discard clears a draft — a read reporting current_malformed keeps the zones draft; a good read shows it again', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  await away(p);
  const good = await srv.node();
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, bands: 'broken' });   // the stored node is unreadable
  await p.open(); await settle(60);
  assert.deepEqual((p.mods.envio._envioState.zonesDraft || []).map((z) => z.name), ['Sector Norte', 'Sector B'], '🔴 the closed draft survives the malformed read');
  await srv.db.ref('platform_config/delivery_pricing').set(good);
  await away(p); await p.open(); await settle(60);
  assert.ok(zrow(p, 'Sector Norte'), 'a good read shows the kept draft again');
});
test('#180 a zones draft ENDS with the session: sign out, another admin signs in ⇒ the stored zones, never the previous admin\'s draft', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED), admins: { uAdmin: true, uAdmin2: true } });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: null } })); await settle(20);
  await p.signIn('uAdmin2'); await p.open(); await settle(60);
  assert.equal(zrow(p, 'Sector Norte'), undefined, '🔴 the previous admin\'s unsent draft is gone');
  assert.ok(zrow(p, 'Sector A'), 'the stored zones');
});
// the real path: a non-saved POST is settled by the recovery read; a malformed read classifies as «conflict» (classifyRecovery) — the
// conflict panel, the zones draft kept until the admin presses «Recargar» (an explicit discard)
test('#180 a SAVE answered current_malformed: the conflict panel, and the zones draft stays until the admin discards', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  const good = await srv.node();
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, no_delivery_zones: 'broken' });   // the stored zones went unreadable before the save (the write path judges stored zones, pricing-admin-core.js:261)
  await saveAll(p);
  const out = srv.answers[srv.answers.length - 1];
  assert.equal(out.status, 409); assert.equal(out.body.error, 'current_malformed', 'premise: the REAL core refused current_malformed');
  assert.ok(p.text().includes('Alguien más cambió las tarifas, recargá'), 'the conflict panel');
  assert.deepEqual((p.mods.envio._envioState.zonesDraft || []).map((z) => z.name), ['Sector Norte', 'Sector B'], '🔴 no automatic discard on the save path');
});
// Codex #184 (owner A, invariant 3 for FEES): the draft owns its fee base — a malformed read does not make an L45 edit «clean»
test('#184 a fee draft survives TWO malformed reads (edit → malformed → malformed keeps L45)', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  p.type(0, 'fee', '45'); await settle(5);
  const good = await srv.node();
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, bands: 'broken' });
  await away(p); await p.open(); await settle(60);
  await away(p); await p.open(); await settle(60);
  assert.equal(p.mods.envio._envioState.rows[0].fee, '45', '🔴 the L45 draft survives the second malformed read');
});
test('#184 edit → malformed → a good read with a MOVED version keeps L45 and «Guardar» conflicts', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  p.type(0, 'fee', '45'); await settle(5);
  const good = await srv.node();
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, bands: 'broken' });
  await away(p); await p.open(); await settle(60);
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, policy_version: 5, bands: [{ max_km: 5, cents: 7000 }] });   // repaired by someone else, newer
  await away(p); await p.open(); await settle(60);
  assert.equal(p.input(0, 'fee').value, '45', '🔴 the L45 draft survives malformed → good');
  await saveAll(p);
  assert.ok(p.text().includes('Alguien más cambió las tarifas, recargá'), '🔴 the moved version conflicts, never a silent overwrite');
  assert.equal((await srv.node()).bands[0].cents, 7000, 'their repair stands');
});
// Codex #186: the rows and their base move TOGETHER — a discard or a conflict that resets the table also resets S.feesBase, so the next
// good read adopts the server's policy and the leave guard releases
test('#186 malformed-kept L45 → «Descartar» → a good read adopts the repaired policy; canLeave is true', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  p.type(0, 'fee', '45'); await settle(5);
  const good = await srv.node();
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, bands: 'broken' });
  await away(p); await p.open(); await settle(60);
  p.btn('Descartar', p.bar()).click(); await settle(10);
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, policy_version: 5, bands: [{ max_km: 5, cents: 7000 }] });
  await away(p); await p.open(); await settle(60);
  assert.deepEqual(p.rows(), [['5', '70']], '🔴 the repaired policy is adopted');
  assert.equal(envioView(p).canLeave(), true, '🔴 nothing unsent holds the guard (the base reset with the rows)');
});
test('#186 malformed-kept L45 → «Guardar» conflicts → a good read adopts the repaired policy; canLeave is true', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  p.type(0, 'fee', '45'); await settle(5);
  const good = await srv.node();
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, bands: 'broken' });
  await away(p); await p.open(); await settle(60);
  await srv.db.ref('platform_config/delivery_pricing').set({ ...good, policy_version: 5, bands: [{ max_km: 5, cents: 7000 }] });
  await saveAll(p);
  assert.ok(p.text().includes('Alguien más cambió las tarifas, recargá'), 'premise: the conflict');
  await away(p); await p.open(); await settle(60);
  assert.deepEqual(p.rows(), [['5', '70']], '🔴 the repaired policy is adopted after the conflict');
  assert.equal(envioView(p).canLeave(), true, '🔴 nothing unsent holds the guard (the base reset with the rows)');
});
test('#180 zone_out_of_range (the REAL validator, |lat| > 60) ⇒ the frame-F panel naming the zone, not the generic error', async () => {
  const srv = server({ policy: withZones(), world: world(CLOSED, CLOSED) });
  const p = await open(srv);
  await rename(p, 'Sector A', 'Sector Norte');
  srv.rewrite = (b) => ({ ...b, no_delivery_zones: b.no_delivery_zones.map((z) => (z.id === 'z_aaaaaaaa' ? { ...z, points: z.points.map((pt) => ({ lat: pt.lat + 46, lng: pt.lng })) } : z)) });
  await saveAll(p);
  const out = srv.answers[srv.answers.length - 1];
  assert.equal(out.status, 400); assert.equal(out.body.field, 'zone_out_of_range', 'premise: the real core refused out of range');
  const box = p.d.querySelector('.envzfail');
  assert.ok(box, '🔴 the frame-F panel');
  assert.equal(box.querySelector('b').textContent, P('refusedTitle', { nombre: 'Sector Norte' }), 'the zone named');
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
