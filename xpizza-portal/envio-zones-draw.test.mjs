// «Envío» zones Z2 — drawing on the map, the PARENT side (PLAN-portal-zones-protocol-v3 r1 §2/§6, r2 P2-3..P2-6, r3, r4; Codex #187
// APPROVED). The page is the REAL app over the shipped index.html; the server is 5f's REAL getDeliveryPricingCore (envio-harness).
// The map child is played by the test through the real protocol module (exact origin, the frame's window, this mount).
// Run: node --test --test-force-exit envio-zones-draw.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './ventas-harness.mjs';
import { server, page, posted, POLICY, B3, CORE } from './envio-harness.mjs';
import { childMessage, mapMessage } from './envio-map-protocol.js';
import { zonesCopy } from './envio-logic.js';
const P = (k, vars) => zonesCopy(k, vars);   // the shipped string, or its ⟦zones.key⟧ placeholder while the owner has not approved it
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { createRequire } from 'node:module';
// the ORACLE: the SERVER's own module (3a's delivery/zone-shape.js) — a mutant in the portal's copy is a behaviour failure, not a premise one
const SERVER_SHAPE = createRequire(import.meta.url)('../xpizza-functions/delivery/zone-shape.js');
// the page's classic script, as index.html loads it: the PORTAL's byte copy of 3a's delivery/zone-shape.js (globalThis.ZoneShape)
runInThisContext(readFileSync(new URL('./zone-shape.js', import.meta.url), 'utf8'));

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOSED = Object.fromEntries(DAYS.map((d) => [d, { open: false }]));
const ID = (name, location) => ({ name, phone: '+50499990000', active: true, version: 1, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 8,
  location_name: location, brand_id: `b_${name}`, hours: CLOSED });
const WORLD = () => ({ ids: ['r_uno', 'r_dos'], restaurants: { r_uno: { identity: ID('Uno', 'Centro') }, r_dos: { identity: ID('Dos', 'Norte') } },
  brands: { b_Uno: { name: 'Uno' }, b_Dos: { name: 'Dos' } } });
const r6 = (x) => Number(x.toFixed(6));
const SQ = (lat, lng, d = 0.01) => [[lat, lng], [lat, r6(lng + d)], [r6(lat + d), r6(lng + d)], [r6(lat + d), lng]];
const STORED = [{ id: 'z_aaaaaaaa', name: 'Sector A', points: SQ(15.52, -88.02) }];
const AS_SENT = STORED.map((z) => ({ id: z.id, name: z.name, points: z.points.map(([lat, lng]) => ({ lat, lng })) }));

async function open() {
  const p = await page({ srv: server({ policy: { ...POLICY(3, B3), no_delivery_zones: STORED }, world: WORLD() }) });
  await p.signIn(); await p.open(); await settle(60);
  return p;
}
const last = (out) => out[out.length - 1][0];
const listening = (p) => p.fromMap(childMessage('listening', p.mount()));
const hello = (p) => p.fromMap(mapMessage('hello', p.mount()));

// ── r2 P2-5 / r3: a fresh negotiation per child DOCUMENT ───────────────────────────────────────────────────────────────────
test('Z2 negotiation: `listening` ⇒ a v2 render; a hello{proto:3} after it ⇒ v3, carrying the draft\'s zones and no session', async () => {
  const p = await open();
  const out = posted(p);
  listening(p); await settle();
  assert.equal(last(out).v, 2, 'listening is answered in v2');
  hello(p); await settle();
  assert.equal(last(out).v, 3, '🔴 after this document\'s hello the parent renders v3');
  assert.deepEqual(last(out).zones, AS_SENT, 'the draft\'s zones');
  assert.equal(last(out).drawing, null, 'no session');
});

test('Z2 a hello BEFORE this document\'s `listening` is dropped: v2 only', async () => {
  const p = await open();
  const out = posted(p);
  hello(p); await settle();
  assert.equal(out.length, 0, 'nothing is rendered to a document that has not said listening');
  listening(p); await settle();
  assert.equal(last(out).v, 2);
  p.type(1, 'km', '7'); await settle();
  assert.equal(last(out).v, 2, '🔴 the early hello did not enable v3');
});

test('Z2 (m6) a same-frame reload with NO hello (a v2 child) ⇒ v2 renders only, from its `listening` on', async () => {
  const p = await open();
  const out = posted(p);
  listening(p); hello(p); await settle();
  assert.equal(last(out).v, 3, 'premise: v3 with the first document');
  listening(p); await settle();
  assert.equal(last(out).v, 2, '🔴 the new document is answered in v2');
  p.type(1, 'km', '7'); await settle();
  assert.equal(last(out).v, 2, '🔴 and stays v2 without its own hello');
});

test('Z2 (m9) a failed child → a same-frame healthy child: its `listening` clears `failed`, its `ready` makes the map live', async () => {
  const p = await open();
  const out = posted(p);
  listening(p); await settle();
  p.fromMap(childMessage('failed', p.mount(), 'load_error')); await settle();
  assert.ok(p.text().includes('No se pudo cargar el mapa.'), 'premise: the mount failed');
  const n = out.length;
  listening(p); await settle();
  assert.equal(out.length, n + 1, '🔴 the healthy document gets its render');
  assert.equal(last(out).v, 2);
  p.fromMap(childMessage('ready', p.mount())); await settle();
  assert.ok(!p.text().includes('No se pudo cargar el mapa.'), '🔴 no «Mapa no disponible» left behind');
});

test('Z2 the reset restarts the 8 s deadline for the new document', async () => {
  const p = await open();
  p.mods.envio._envioTiming.deadlineMs = 300;
  listening(p); p.fromMap(childMessage('ready', p.mount())); await settle();
  listening(p); await settle();   // a same-frame reload: not ready again, a fresh deadline
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(p.text().includes('No se pudo cargar el mapa.'), '🔴 the reloaded document must reach ready within its own deadline');
});

// ── r2 P2-4 canDraw() + frame 1b: «Dibujar zona» → drawing mode; «Cancelar» discards ────────────────────────────────────────
const drawBtn = (p) => p.d.querySelector('section.envzones button.railadd');
const mapSec = (p) => p.d.querySelector('section.envmap');
const live = async (p) => { listening(p); hello(p); p.fromMap(childMessage('ready', p.mount())); await settle(); };
const SESSION = /^[0-9a-f]{32}$/;
// eight valid stored zones (on the 6-decimal grid — an off-grid value makes the whole stored list unreadable)
const EIGHT = () => Array.from({ length: 8 }, (_, i) => ({ id: `z_${'abcdefgh'[i].repeat(8)}`, name: `Sector ${i}`, points: SQ(r6(15.40 + i * 0.02), -88.02) }));
async function openWith(policy, world = WORLD()) {
  const p = await page({ srv: server({ policy, world }) });
  await p.signIn(); await p.open(); await settle(60);
  return p;
}

test('Z2 «Dibujar zona» is on only when the map speaks v3 for THIS document AND is ready (r2 P2-4)', async () => {
  const p = await open();
  assert.equal(drawBtn(p).disabled, true, 'no map yet');
  listening(p); await settle();
  assert.equal(drawBtn(p).disabled, true, 'listening (v2)');
  hello(p); await settle();
  assert.equal(drawBtn(p).disabled, true, '🔴 v3 but not ready');
  p.fromMap(childMessage('ready', p.mount())); await settle();
  assert.equal(drawBtn(p).disabled, false, '🔴 v3 and ready: drawing may start');
  listening(p); await settle();
  assert.equal(drawBtn(p).disabled, true, 'a same-frame reload: off again until its hello and ready');
});

test('Z2 «Dibujar zona» stays off at the cap (8 zones) even with a live v3 map', async () => {
  const eight = EIGHT();
  const p = await openWith({ ...POLICY(3, B3), no_delivery_zones: eight });
  await live(p);
  assert.equal(p.d.querySelector('section.envzones h3 .ehint').textContent, '8 de 8', 'premise: the eight zones were read (the card counts them)');
  assert.equal(drawBtn(p).disabled, true, '🔴 at the cap');
});

test('Z2 «Dibujar zona» ⇒ drawing mode EXACT to frame 1b; the v3 render carries the new session', async () => {
  const p = await open();
  const out = posted(p);
  await live(p);
  drawBtn(p).click(); await settle();
  const m = mapSec(p);
  assert.equal(m.querySelector('h3 .ehint').textContent, 'Dibujando una zona', '🔴 the map\'s hint (frame 1b)');
  assert.ok(m.querySelector('.emap').classList.contains('drawing'), 'the map in drawing mode');
  const tool = m.querySelector('.mtool');
  assert.ok(tool && !tool.classList.contains('hidden'), 'the tool line');
  assert.equal(tool.querySelector('.efnote').textContent, 'Tocá el mapa para marcar cada punto. Para cerrar la zona, tocá el primer punto o «Terminar».');
  assert.deepEqual([...tool.querySelectorAll('button')].map((b) => [b.textContent, b.className]), [['Cancelar', 'btn ghost'], ['Terminar', 'btn accent']]);
  assert.ok(drawBtn(p).classList.contains('hidden'), '«Dibujar zona» is not drawn while a session is open (frame 1b)');
  assert.equal(p.d.querySelector('section.envmap button.pick').disabled, true, 'the picker dims: the shape is global (note 12)');
  const d = last(out).drawing;
  assert.ok(d && SESSION.test(d.session), '🔴 a minted session');
  assert.deepEqual({ ...d, session: 's' }, { session: 's', zone: null, points: [], seq: 0, ack: null, request: null });
});

test('Z2 «Cancelar» ends the session: back to the card, the map\'s render says no session, nothing in the draft', async () => {
  const p = await open();
  const out = posted(p);
  await live(p);
  drawBtn(p).click(); await settle();
  [...mapSec(p).querySelectorAll('.mtool button')].find((b) => b.textContent === 'Cancelar').click(); await settle();
  assert.equal(last(out).drawing, null, '🔴 the session ended');
  assert.ok(mapSec(p).querySelector('.mtool').classList.contains('hidden'));
  assert.ok(!mapSec(p).querySelector('.emap').classList.contains('drawing'));
  assert.equal(mapSec(p).querySelector('h3 .ehint').textContent, 'Anillos desde el pin');
  assert.ok(!drawBtn(p).classList.contains('hidden') && !drawBtn(p).disabled, '«Dibujar zona» is back');
  assert.deepEqual(last(out).zones, AS_SENT, 'the draft is unchanged');
});

// ── r2 P2-6 / r1 §4–§5: draft_points — the live session only, a higher seq only, a WHOLE list; coalesced (≤ 1 per frame, ≤ 30/s) ──────
const pts = (n, lat = 15.53, lng = -88.05) => Array.from({ length: n }, (_, i) => ({ lat: r6(lat + (i % 2) * 0.004), lng: r6(lng + i * 0.003) }));
const drawPts = (p, session, seq, points) => p.fromMap(mapMessage('draft_points', p.mount(), { session, seq, points }));
async function drawing(p) { const out = posted(p); await live(p); drawBtn(p).click(); await settle(); return { out, session: last(out).drawing.session }; }

test('Z2 draft_points replaces the live session\'s points (a whole list) and the render echoes its seq', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  drawPts(p, session, 1, pts(1)); await settle(60);
  drawPts(p, session, 2, pts(2)); await settle(60);
  assert.deepEqual(last(out).drawing.points, pts(2), '🔴 the session holds the whole list');
  assert.equal(last(out).drawing.seq, 2, 'the echoed seq');
  assert.deepEqual(last(out).zones, AS_SENT, 'never a draft change');
});

test('Z2 (m4 / m5) dropped: another session, an older or equal seq, no session at all', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  drawPts(p, session, 5, pts(3)); await settle(60);
  drawPts(p, 'f'.repeat(32), 9, pts(4)); await settle(60);
  assert.deepEqual(last(out).drawing.points, pts(3), '🔴 a draft_points from another session changes nothing');
  drawPts(p, session, 5, pts(5)); await settle(60);
  drawPts(p, session, 4, pts(6)); await settle(60);
  assert.deepEqual(last(out).drawing.points, pts(3), '🔴 a replayed or older seq changes nothing');
  [...mapSec(p).querySelectorAll('.mtool button')].find((b) => b.textContent === 'Cancelar').click(); await settle();
  drawPts(p, session, 6, pts(7)); await settle(60);
  assert.equal(last(out).drawing, null, 'a draft_points from an ended session changes nothing');
});

test('Z2 a flood is coalesced: 20 in one burst ⇒ the latest seq, far fewer renders than messages', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  const n0 = out.length;
  for (let i = 1; i <= 20; i++) drawPts(p, session, i, pts(Math.min(i, 24)));
  await settle(120);
  assert.equal(last(out).drawing.seq, 20, 'the latest seq wins');
  assert.ok(out.length - n0 <= 3, `🔴 coalesced: ${out.length - n0} renders for 20 messages`);
});

test('Z2 at 24 points the map hint is «24 de 24 puntos» and the tool line says the cap (addendum G)', async () => {
  const p = await open();
  const { session } = await drawing(p);
  drawPts(p, session, 1, pts(24)); await settle(60);
  assert.equal(mapSec(p).querySelector('h3 .ehint').textContent, '24 de 24 puntos', '🔴 the map hint at the cap');
  assert.equal(mapSec(p).querySelector('.mtool .efnote').textContent, 'Máximo 24 puntos por zona. Cerrá la zona o quitá un punto.');
  drawPts(p, session, 2, pts(23)); await settle(60);
  assert.equal(mapSec(p).querySelector('h3 .ehint').textContent, 'Dibujando una zona', 'below the cap: the drawing hint again');
});

// ── r3 #181-6 / r4: finish — never coalesced; the shape check (the synced zone-shape.js) before any draft change; a REPEATABLE ack ───
const finish = (p, session, seq, points) => p.fromMap(mapMessage('finish', p.mount(), { session, seq, points }));
const GOOD = pts(4, 15.53, -88.05).map((q, i) => [{ lat: 15.53, lng: -88.05 }, { lat: 15.53, lng: -88.04 }, { lat: 15.54, lng: -88.04 }, { lat: 15.54, lng: -88.05 }][i]);
// the SERVER suite's asymmetric bow-tie (delivery/zones.test.js: non-zero area, so only the SIMPLE rule refuses it)
const BOWTIE = [{ lat: 15.5, lng: -88.03 }, { lat: 15.509, lng: -88.02 }, { lat: 15.5, lng: -88.02 }, { lat: 15.506, lng: -88.03 }];
const nameRow = (p) => p.d.querySelector('section.envzones .zrow.editing');
const toolLine = (p) => mapSec(p).querySelector('.mtool + p.ferr');

test('Z2 a valid finish ⇒ accepted ONCE; the naming row opens EXACT to note 13; nothing enters the draft before «Listo»', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  finish(p, session, 3, GOOD); await settle();
  assert.deepEqual(last(out).drawing.ack, { session, seq: 3, outcome: 'accepted' }, '🔴 the accepted ack');
  assert.deepEqual(last(out).drawing.points, GOOD, 'the finish\'s final list');
  const row = nameRow(p);
  assert.ok(row, '🔴 the naming row (note 13: in the list, no modal)');
  const inp = row.querySelector('input');
  assert.equal(inp.placeholder, 'Nombre de la zona'); assert.equal(inp.getAttribute('aria-label'), 'Nombre de la zona'); assert.equal(inp.value, '');
  assert.deepEqual([...row.querySelectorAll('button')].map((b) => [b.textContent, b.className]), [['Cancelar', 'btn ghost'], ['Listo', 'btn accent']]);
  assert.equal(row.querySelector('button.accent').disabled, true, '«Listo» waits for a name');
  assert.equal(p.d.querySelector('section.envzones .zlist + p.efnote').textContent, 'Nombrá la zona para ubicarla después. Hasta 30 caracteres.');
  assert.deepEqual(last(out).zones, AS_SENT, 'nothing in the draft yet');
});

test('Z2 «Listo» commits the drawn zone ONCE (a z_ id, the name, the grid points); the session ends; the bar says «1 zona nueva»', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  finish(p, session, 3, GOOD); await settle();
  const inp = nameRow(p).querySelector('input');
  inp.value = 'Río Norte'; inp.dispatchEvent(new p.w.Event('input')); await settle();
  nameRow(p).querySelector('button.accent').click(); await settle();
  const z = last(out).zones;
  assert.equal(z.length, 2, '🔴 the draft holds the new zone');
  assert.match(z[1].id, /^z_[a-z0-9]{8}$/); assert.equal(z[1].name, 'Río Norte'); assert.deepEqual(z[1].points, GOOD);
  assert.equal(last(out).drawing, null, 'the session ended (committed)');
  assert.equal(nameRow(p), null);
  assert.ok(p.bar().textContent.includes('1 zona nueva'), 'note 13: the save bar');
  finish(p, session, 3, GOOD); await settle(300);
  assert.equal(last(out).zones.length, 2, 'a late duplicate finish adds nothing');
});

test('Z2 a self-crossing finish (the server\'s asymmetric bow-tie) ⇒ rejected + its line; no draft change; the session stays open', async () => {
  const p = await open();
  assert.ok(globalThis.ZoneShape, 'premise: the page loaded the synced zone-shape.js');
  assert.deepEqual(SERVER_SHAPE.pointsProblem(BOWTIE.map((q) => [q.lat, q.lng])), { problem: 'zones', field: 'points' }, 'premise: the real core refuses it');
  const { out, session } = await drawing(p);
  finish(p, session, 4, BOWTIE); await settle();
  assert.deepEqual(last(out).drawing.ack, { session, seq: 4, outcome: 'rejected', line: 'self_cross' }, '🔴 the rejected ack');
  assert.equal(toolLine(p) && toolLine(p).textContent, 'La zona se cruza a sí misma. Mové un punto.', '🔴 the approved inline line');
  assert.equal(nameRow(p), null, 'no naming row');
  assert.ok(mapSec(p).querySelector('.emap').classList.contains('drawing'), 'still drawing');
  assert.deepEqual(last(out).zones, AS_SENT, 'no draft change');
  finish(p, session, 5, GOOD); await settle();
  assert.equal(last(out).drawing.ack.outcome, 'accepted', 'a later finish (higher seq) can still close it');
  assert.equal(toolLine(p), null, 'the line goes with it');
});

test('Z2 the other refusals: fewer than 3 points, a box over 20 km — each its approved line', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  finish(p, session, 1, GOOD.slice(0, 2)); await settle();
  assert.equal(last(out).drawing.ack.line, 'min_points');
  assert.equal(toolLine(p).textContent, 'Marcá al menos 3 puntos.', '🔴 too few');
  const BIG = [{ lat: 15.4, lng: -88.2 }, { lat: 15.4, lng: -87.9 }, { lat: 15.6, lng: -87.9 }, { lat: 15.6, lng: -88.2 }];
  finish(p, session, 2, BIG); await settle();
  assert.equal(last(out).drawing.ack.line, 'too_big');
  assert.equal(toolLine(p).textContent, 'La zona es demasiado grande: hasta 20 km de lado.', '🔴 too big');
});

test('Z2 (m8) a lost accepted ack converges: the duplicate finish gets the SAME ack again (no second change); 20 duplicates stay bounded', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  finish(p, session, 3, GOOD); await settle();
  const n = out.length;
  finish(p, session, 3, GOOD); await settle();
  assert.equal(out.length, n + 1, '🔴 the duplicate is re-acknowledged');
  assert.deepEqual(last(out).drawing.ack, { session, seq: 3, outcome: 'accepted' });
  const n2 = out.length;
  for (let i = 0; i < 20; i++) finish(p, session, 3, GOOD);
  await settle();
  assert.ok(out.length - n2 <= 1, `≤ one re-send per 250 ms (${out.length - n2})`);
  assert.equal(p.d.querySelectorAll('section.envzones .zrow.editing').length, 1, 'one naming row');
});

test('Z2 (m7) finish-before-flush: a pending draft_points is superseded — the finish\'s list is what closes', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  drawPts(p, session, 1, pts(2));
  finish(p, session, 2, GOOD);   // no settle between: the draft_points is still pending — and the finish must not wait for the frame
  assert.equal(last(out).drawing.ack && last(out).drawing.ack.outcome, 'accepted', '🔴 the finish closes it at once (never coalesced, Codex #204: asserted BEFORE the frame flush)');
  await settle(80);
  assert.deepEqual(last(out).drawing.points, GOOD, 'the finish\'s list');
});

test('Z2 a finish for an ended session changes nothing: the render says there is no session', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  [...mapSec(p).querySelectorAll('.mtool button')].find((b) => b.textContent === 'Cancelar').click(); await settle();
  const n = out.length;
  finish(p, session, 3, GOOD); await settle();
  assert.equal(nameRow(p), null, '🔴 no naming row');
  assert.ok(out.length >= n + 1 && last(out).drawing === null, 'the child is told: no session (r4 — it settles as ended)');
  assert.deepEqual(last(out).zones, AS_SENT);
});

// ── r2 P2-6: the portal's «Terminar» asks the map for its finish (the commit only ever comes from a finish), bounded at 2 s ────────────
const terminar = (p) => [...mapSec(p).querySelectorAll('.mtool button')].find((b) => b.textContent === 'Terminar');
test('Z2 «Terminar» asks the map (request: finish); the map\'s finish closes the shape', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  drawPts(p, session, 1, GOOD); await settle(60);
  terminar(p).click(); await settle();
  assert.equal(last(out).drawing.request, 'finish', '🔴 the render asks for the finish');
  assert.equal(nameRow(p), null, 'nothing closes on the portal\'s own press');
  finish(p, session, 2, GOOD); await settle();
  assert.equal(last(out).drawing.request, null, 'answered');
  assert.ok(nameRow(p), 'the finish closed it');
});

test('Z2 «Terminar» with no answer within the bound: the request clears, the session stays open, nothing changes', async () => {
  const p = await open();
  p.mods.envio._envioTiming.finishMs = 200;
  const { out, session } = await drawing(p);
  drawPts(p, session, 1, GOOD); await settle(60);
  terminar(p).click(); await settle();
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(last(out).drawing.request, null, '🔴 the unanswered request is withdrawn');
  assert.equal(last(out).drawing.session, session, 'the session is still open');
  assert.equal(nameRow(p), null); assert.deepEqual(last(out).zones, AS_SENT);
});

// ── r2 P2-3 EDITING: entered ONLY through a portal-authorized edit_request; commits on the drag-end finish (r4: exactly once) ──────────
const editReq = (p, zone) => p.fromMap(mapMessage('edit_request', p.mount(), { zone }));
const EDITED = [{ lat: 15.52, lng: -88.02 }, { lat: 15.52, lng: -88.01 }, { lat: 15.531, lng: -88.01 }, { lat: 15.53, lng: -88.02 }];

test('Z2 edit_request opens an EDITING session on a draft zone (its points); an unknown zone, or with a session open, is refused', async () => {
  const p = await open();
  const out = posted(p);
  await live(p);
  editReq(p, 'z_zzzzzzzz'); await settle();
  assert.equal(last(out).drawing, null, 'a zone the draft does not hold: no session');
  editReq(p, 'z_aaaaaaaa'); await settle();
  const d = last(out).drawing;
  assert.ok(d && SESSION.test(d.session), '🔴 the portal mints the session');
  assert.equal(d.zone, 'z_aaaaaaaa'); assert.deepEqual(d.points, AS_SENT[0].points, 'that zone\'s draft points');
  editReq(p, 'z_aaaaaaaa'); await settle();
  assert.equal(last(out).drawing.session, d.session, 'a second request while one is open changes nothing');
});

test('Z2 an EDITING drag-end finish puts the edited points in the draft ONCE; the session ends; a late duplicate only re-acks (r4)', async () => {
  const p = await open();
  const out = posted(p);
  await live(p);
  editReq(p, 'z_aaaaaaaa'); await settle();
  const { session } = last(out).drawing;
  finish(p, session, 1, EDITED); await settle();
  assert.deepEqual(last(out).zones[0].points, EDITED, '🔴 the draft carries the edited shape');
  assert.equal(last(out).zones.length, 1, 'no new zone');
  assert.equal(last(out).drawing, null, 'the session ended');
  assert.ok(p.bar().textContent.includes('zonas'), 'the zones change is unsaved work (Z1\'s bar)');
  await new Promise((r) => setTimeout(r, 260));
  finish(p, session, 1, EDITED.map((q) => ({ lat: q.lat, lng: r6(q.lng + 0.001) }))); await settle();
  assert.deepEqual(last(out).zones[0].points, EDITED, '🔴 a late duplicate makes no second edit');
});

test('Z2 a refused edit (the bow-tie) keeps the zone and the session: rejected + the line', async () => {
  const p = await open();
  const out = posted(p);
  await live(p);
  editReq(p, 'z_aaaaaaaa'); await settle();
  const { session } = last(out).drawing;
  finish(p, session, 1, BOWTIE); await settle();
  assert.deepEqual(last(out).drawing.ack, { session, seq: 1, outcome: 'rejected', line: 'self_cross' }, '🔴 rejected');
  assert.deepEqual(last(out).zones, AS_SENT, 'the zone is unchanged');
  assert.equal(toolLine(p).textContent, 'La zona se cruza a sí misma. Mové un punto.');
});

test('Z2 editing is allowed at the zones cap (it adds no zone)', async () => {
  const eight = EIGHT();
  const p = await openWith({ ...POLICY(3, B3), no_delivery_zones: eight });
  const out = posted(p);
  await live(p);
  editReq(p, 'z_aaaaaaaa'); await settle();
  assert.ok(last(out).drawing, '🔴 an EDITING session at 8 of 8');
});

// ── r2 P2-4 / r1 §8: a session ends as «Cancelar» when the predicate turns false or its world ends — nothing half-drawn is ever kept ────
const inDrawing = (p) => mapSec(p).querySelector('.emap').classList.contains('drawing');
test('Z2 a same-frame reload (`listening`) ends the session; the old session\'s late finish changes nothing', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  listening(p); await settle();
  assert.equal(inDrawing(p), false, '🔴 the session ended with the document');
  hello(p); p.fromMap(childMessage('ready', p.mount())); await settle();
  assert.equal(last(out).drawing, null, 'the new document is told: no session');
  finish(p, session, 3, GOOD); await settle();
  assert.equal(nameRow(p), null, 'the old session\'s finish is dropped');
});

// r2 P2-4's «ready-then-failed» is UNREACHABLE: the child never reports `failed` after `ready` (map.js fail() — envio-map-site C2) and
// the parent ignores one (envio-view «a failure AFTER ready is ignored»); a session needs `ready`, so the reachable end is a replaced
// document (the `listening` cell above).
test('Z2 leaving the page discards an unnamed closed shape; back on the page: no session, only committed zones', async () => {
  const p = await open();
  const { session } = await drawing(p);
  finish(p, session, 3, GOOD); await settle();
  assert.ok(nameRow(p), 'premise: closed, waiting for its name');
  p.d.getElementById('navprod').click(); await settle(20);
  await p.open(); await settle(60);
  assert.equal(nameRow(p), null, '🔴 the unnamed shape is gone');
  assert.equal(p.mods.envio._envioState.drawing, null, 'no session survives the page');
  assert.deepEqual((p.mods.envio._envioState.zonesDraft || []).map((z) => z.id), ['z_aaaaaaaa'], 'the draft holds only committed zones');
});

test('Z2 another person signing in ends the session (the frame and its session go with the world)', async () => {
  const p = await open();
  await drawing(p);
  await p.signIn('uOther');
  assert.equal(p.mods.envio._envioState.drawing, null, '🔴 no session for the next person');
});

test('Z2 a save starting (the page frozen) ends an open session — the open shape is never sent', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  finish(p, session, 3, GOOD); await settle();
  const inp = nameRow(p).querySelector('input'); inp.value = 'Uno'; inp.dispatchEvent(new p.w.Event('input'));
  nameRow(p).querySelector('button.accent').click(); await settle();
  drawBtn(p).click(); await settle();
  assert.ok(inDrawing(p), 'premise: a second shape is being drawn');
  p.btn('Guardar', p.bar()).click(); await settle();
  p.btn('Guardar cambios').click(); await settle(80);
  assert.equal(inDrawing(p), false, '🔴 the save ended the open session');
  assert.equal(last(out).drawing, null);
});

// ── Codex #204 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// P1: ANY applied read ends the transient session (and its pending messages) — a session opened on cached v3 never commits against v4
test('#204-P1 an EDITING session opened on the cached v3 ends when v4 is adopted; its late finish changes nothing; v4\'s zone stands', async () => {
  const p = await open();
  p.d.getElementById('navprod').click(); await settle(20);
  const V4 = [{ id: 'z_aaaaaaaa', name: 'Sector A', points: SQ(15.6, -88.1) }];
  await p.srv.db.ref(CORE.PATH).set({ ...POLICY(4, B3), no_delivery_zones: V4 });   // another admin saved v4 while we were away
  let release; p.srv.hold.get = new Promise((r) => { release = r; });
  await p.open(); await settle(30);   // the cached v3 is on screen; the fresh GET is held
  const out = posted(p);
  await live(p);
  editReq(p, 'z_aaaaaaaa'); await settle();
  const { session } = last(out).drawing;
  assert.deepEqual(last(out).drawing.points, AS_SENT[0].points, 'premise: editing the CACHED v3 shape');
  p.srv.hold.get = null; release(); await settle(80);   // v4 arrives and is adopted
  assert.equal(p.mods.envio._envioState.drawing, null, '🔴 the adoption ended the session');
  finish(p, session, 1, EDITED); await settle();
  const z = p.mods.envio._envioState.zonesDraft.find((x) => x.id === 'z_aaaaaaaa');
  assert.deepEqual(z.points.map((q) => [q.lat, q.lng]), V4[0].points, '🔴 v4\'s zone stands — the old editor never overwrites it');
  assert.equal(p.bar().classList.contains('show'), false, 'nothing unsaved');
});

// P2-2: every session transition repaints the list (rename / remove follow the session) and puts the focus somewhere sensible
const zbtns = (p) => [...p.d.querySelectorAll('section.envzones .zrow:not(.editing) button.ib')];
test('#204-P2 starting a drawing turns rename / remove off; «Cancelar» on the naming row removes the row and its note, turns them back on, focuses «Dibujar zona»', async () => {
  const p = await open();
  const { session } = await drawing(p);
  assert.ok(zbtns(p).length && zbtns(p).every((b) => b.disabled), '🔴 drawing: rename / remove off');
  finish(p, session, 3, GOOD); await settle();
  [...nameRow(p).querySelectorAll('button')].find((b) => b.textContent === 'Cancelar').click(); await settle();
  assert.equal(nameRow(p), null, '🔴 the naming row is gone');
  assert.equal(p.d.querySelector('section.envzones .zlist + p.efnote'), null, 'its note too');
  assert.ok(zbtns(p).every((b) => !b.disabled), '🔴 rename / remove are back');
  assert.equal(p.d.activeElement, drawBtn(p), 'the focus returns to «Dibujar zona»');
});
test('#204-P2b cancelling an EDITING session turns rename / remove back on and focuses that zone\'s «Renombrar»', async () => {
  const p = await open();
  const out = posted(p);
  await live(p);
  editReq(p, 'z_aaaaaaaa'); await settle();
  assert.ok(zbtns(p).every((b) => b.disabled), 'premise: off while editing');
  [...mapSec(p).querySelectorAll('.mtool button')].find((b) => b.textContent === 'Cancelar').click(); await settle();
  assert.equal(last(out).drawing, null);
  assert.ok(zbtns(p).every((b) => !b.disabled), '🔴 back on');
  assert.equal(p.d.activeElement && p.d.activeElement.title, 'Renombrar', 'the edited zone\'s rename');
});

// P3-2: EDITING says what editing does (drag a point) — never the drawing instructions it ignores; no «Terminar» (a drag end commits)
test('#204-P3 EDITING shows the editing line and only «Cancelar» — never «Tocá el mapa…» or «Terminar»', async () => {
  const p = await open();
  await live(p);
  editReq(p, 'z_aaaaaaaa'); await settle();
  const tool = mapSec(p).querySelector('.mtool');
  assert.notEqual(tool.querySelector('.efnote').textContent, 'Tocá el mapa para marcar cada punto. Para cerrar la zona, tocá el primer punto o «Terminar».', '🔴 not the drawing line');
  assert.equal(tool.querySelector('.efnote').textContent, P('editTool'), 'the editing line (the owner\'s copy, or its placeholder until approved)');
  assert.equal(mapSec(p).querySelector('h3 .ehint').textContent, P('editHint', { nombre: 'Sector A' }));
  assert.deepEqual([...tool.querySelectorAll('button')].filter((b) => !b.classList.contains('hidden')).map((b) => b.textContent), ['Cancelar'], '🔴 no «Terminar»');
});

// P3-3: a shape beyond |lat| 60 is refused with the frame-F panel (r2 P2-7), not an inline line
test('#204-P3b a shape above 60° latitude ⇒ the frame-F refusal panel; no inline line; nothing in the draft', async () => {
  const p = await open();
  const { out, session } = await drawing(p);
  const NORTH = [{ lat: 61, lng: -88.05 }, { lat: 61, lng: -88.04 }, { lat: 61.01, lng: -88.04 }, { lat: 61.01, lng: -88.05 }];
  finish(p, session, 1, NORTH); await settle();
  assert.equal(last(out).drawing.ack.line, 'out_of_range');
  const box = p.d.querySelector('.envzfail');
  assert.ok(box, '🔴 the frame-F panel');
  assert.equal(box.querySelector('b').textContent, P('refusedTitleBare')); assert.equal(box.querySelector('p').textContent, P('refusedBody'));
  assert.equal(toolLine(p), null, 'no inline line for it');
  assert.deepEqual(last(out).zones, AS_SENT);
});
