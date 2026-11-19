// «Envío» zones Z2 — drawing on the map, the PARENT side (PLAN-portal-zones-protocol-v3 r1 §2/§6, r2 P2-3..P2-6, r3, r4; Codex #187
// APPROVED). The page is the REAL app over the shipped index.html; the server is 5f's REAL getDeliveryPricingCore (envio-harness).
// The map child is played by the test through the real protocol module (exact origin, the frame's window, this mount).
// Run: node --test --test-force-exit envio-zones-draw.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './ventas-harness.mjs';
import { server, page, posted, POLICY, B3 } from './envio-harness.mjs';
import { childMessage, mapMessage } from './envio-map-protocol.js';

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
