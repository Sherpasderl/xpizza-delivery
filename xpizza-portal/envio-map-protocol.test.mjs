// «Envío» step 1 (PLAN-portal-envio-step1 r2 §1b + build condition C2) — the portal ↔ map-site messages. ONE module validates both
// directions; the map site carries a byte copy. Run: node --test xpizza-portal/envio-map-protocol.test.mjs
// Geometry and theme only travel to the map; only listening / ready / failed come back. Nothing the map sends can authorize anything.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  PORTAL_ORIGIN, MAP_ORIGIN, LIMITS, newMountId, mountFromHash, renderMessage, isRender, childMessage, isChildMessage,
  acceptFromChild, acceptFromParent,
} from './envio-map-protocol.js';
import * as P from './envio-map-protocol.js';   // Z2 (protocol v3): read through the namespace, so each new cell fails at ITS assertion

const M = 'a'.repeat(32);
const HUB = { lat: 15.5075, lng: -88.0398 };
// ENVÍO v3 (PLAN-portal-envio-v3-ui r5 §2; map-look delta r1): the portal sends protocol v2 only — the map type and the limit facts
// the map draws (`limit`, each band's `out`); the map site accepts v1 (drawn «Simple») and v2
const okRender = () => renderMessage({ mount: M, view: 'reset', theme: 'light', hub: HUB, name: 'X. Pizza', others: [{ lat: 15.5041, lng: -88.0385 }],
  bands: [{ km: 3, fee: 4000, ok: true, out: false }, { km: 12, fee: 9000, ok: false, out: false }], mapType: 'roadmap', limit: { km: 3, capped: false, name: 'X. Pizza' } });
const V1 = () => ({ v: 1, mount: M, kind: 'render', view: 'reset', theme: 'light', hub: HUB, name: 'X. Pizza', others: [], bands: [{ km: 3, fee: 4000, ok: true }] });

test('the two origins are the production literals', () => {
  assert.strictEqual(PORTAL_ORIGIN, 'https://sherpa-portal.netlify.app');
  assert.strictEqual(MAP_ORIGIN, 'https://sherpa-portal-map.netlify.app');
  assert.deepStrictEqual(LIMITS, { name: 80, others: 500, bands: 21, km: 100, fee: 15000 });
});

test('mount ids: 128 random bits as 32 lowercase hex, carried in the frame URL fragment', () => {
  const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
  const id = newMountId({ getRandomValues: (a) => { a.set(bytes(a.length)); return a; } });
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.strictEqual(mountFromHash(`#m=${id}`), id);
  for (const bad of ['', '#', '#m=', `#m=${id}x`, `#m=${id.toUpperCase()}`, `#x=${id}`, `#m=${id}&y=1`, null, undefined]) assert.strictEqual(mountFromHash(bad), null, String(bad));
  assert.throws(() => newMountId(null), /crypto/);
});

test('renderMessage(): exact keys, typed, bounded; the result is what isRender() accepts', () => {
  const r = okRender();
  assert.deepStrictEqual(Object.keys(r), ['v', 'mount', 'kind', 'view', 'theme', 'hub', 'name', 'others', 'bands', 'mapType', 'limit']);
  assert.strictEqual(r.v, 2); assert.strictEqual(r.kind, 'render');
  assert.ok(isRender(r, M));
  assert.ok(!isRender(r, 'b'.repeat(32)), 'another mount');
  assert.ok(isRender(renderMessage({ mount: M, view: 'keep', theme: 'dark', hub: null, name: '', others: [], bands: [], mapType: 'simple', limit: null }), M), 'no pin, no bands, no limit');
  for (const t of ['simple', 'roadmap', 'hybrid']) assert.ok(isRender({ ...r, mapType: t }, M), `mapType ${t}`);
  assert.ok(isRender({ ...r, limit: { km: 8, capped: true, name: 'La Musa' } }, M), 'a capped limit');
});

test('isRender() drops anything off-shape, whole', () => {
  const r = okRender();
  const bad = [
    { ...r, v: 3 }, { ...r, v: 1 }, { ...r, kind: 'ready' }, { ...r, extra: 1 }, (({ mapType, ...x }) => x)(r), (({ limit, ...x }) => x)(r),
    { ...r, mapType: 'terrain' }, { ...r, mapType: 'satellite' }, { ...r, mapType: null },
    { ...r, limit: { km: 3, capped: false } }, { ...r, limit: { km: 0, capped: false, name: 'x' } }, { ...r, limit: { km: 101, capped: false, name: 'x' } },
    { ...r, limit: { km: 3, capped: 'no', name: 'x' } }, { ...r, limit: { km: 3, capped: false, name: 'x'.repeat(81) } }, { ...r, limit: { km: 3, capped: false, name: 'x', z: 1 } }, { ...r, limit: [] },
    { ...r, bands: [{ km: 3, fee: 0, ok: true }] }, { ...r, bands: [{ km: 3, fee: 0, ok: true, out: 1 }] }, (({ theme, ...x }) => x)(r), { ...r, view: 'zoom' }, { ...r, theme: 'blue' },
    { ...r, hub: { lat: 91, lng: 0 } }, { ...r, hub: { lat: 0, lng: 181 } }, { ...r, hub: { lat: NaN, lng: 0 } }, { ...r, hub: { lat: 1, lng: 2, z: 3 } },
    { ...r, hub: { lat: '15', lng: -88 } }, { ...r, name: 'x'.repeat(81) }, { ...r, name: 5 },
    { ...r, others: Array.from({ length: 501 }, () => HUB) }, { ...r, others: [{ lat: 1 }] }, { ...r, others: {} },
    { ...r, bands: Array.from({ length: 22 }, (_, i) => ({ km: i + 1, fee: 0, ok: true, out: false })) },
    { ...r, bands: [{ km: 0, fee: 0, ok: true, out: false }] }, { ...r, bands: [{ km: 100.5, fee: 0, ok: true, out: false }] }, { ...r, bands: [{ km: Infinity, fee: 0, ok: true, out: false }] },
    { ...r, bands: [{ km: 3, fee: 15001, ok: true, out: false }] }, { ...r, bands: [{ km: 3, fee: -1, ok: true, out: false }] }, { ...r, bands: [{ km: 3, fee: 1.5, ok: true, out: false }] },
    { ...r, bands: [{ km: 3, fee: 0, ok: 'yes', out: false }] }, { ...r, bands: [{ km: 3, fee: 0, ok: true, out: false, x: 1 }] },
    null, 'render', [], Object.assign(Object.create({ inherited: 1 }), r),
  ];
  bad.forEach((m, i) => assert.ok(!isRender(m, M), `case ${i}`));
  assert.throws(() => renderMessage({ ...r, bands: [{ km: 0, fee: 0, ok: true, out: false }] }), /render/);
});

test('v1 is still ACCEPTED (an older portal; the map draws it «Simple») — exactly v1\'s shape, nothing of v2 mixed in', () => {
  assert.ok(isRender(V1(), M), 'a v1 render');
  for (const bad of [{ ...V1(), mapType: 'simple' }, { ...V1(), limit: null }, { ...V1(), bands: [{ km: 3, fee: 4000, ok: true, out: false }] }, { ...V1(), v: 0 }]) {
    assert.ok(!isRender(bad, M), `v1 mixed with v2: ${JSON.stringify(bad).slice(0, 80)}`);
  }
  assert.ok(acceptFromParent({ origin: PORTAL_ORIGIN, source: 'P', data: V1() }, { parentWindow: 'P', mount: M }), 'the map site accepts a v1 render');
});

test('child messages: listening / ready / failed(cause enum), exact keys, bound to the mount', () => {
  for (const k of ['listening', 'ready']) {
    const m = childMessage(k, M);
    assert.deepStrictEqual(m, { v: 1, mount: M, kind: k });
    assert.ok(isChildMessage(m, M));
  }
  for (const c of ['load_error', 'auth_failure', 'import_rejected']) assert.ok(isChildMessage(childMessage('failed', M, c), M));
  assert.throws(() => childMessage('failed', M, 'timeout'), /child/);
  assert.throws(() => childMessage('save', M), /child/);
  const bad = [{ v: 1, mount: M, kind: 'ready', x: 1 }, { v: 1, mount: M, kind: 'failed' }, { v: 1, mount: M, kind: 'failed', cause: 'evil' },
    { v: 1, mount: M, kind: 'ready', cause: 'load_error' }, { v: 1, mount: 'b'.repeat(32), kind: 'ready' }, { v: 1, mount: M, kind: 'render' }, null];
  bad.forEach((m, i) => assert.ok(!isChildMessage(m, M), `case ${i}`));
});

test('acceptFromChild(): the map origin AND the iframe\'s own window AND the mount, or nothing', () => {
  const frame = {}, other = {};
  const ev = (o) => ({ origin: MAP_ORIGIN, source: frame, data: childMessage('ready', M), ...o });
  assert.deepStrictEqual(acceptFromChild(ev({}), { frameWindow: frame, mount: M }), { v: 1, mount: M, kind: 'ready' });
  assert.strictEqual(acceptFromChild(ev({ origin: PORTAL_ORIGIN }), { frameWindow: frame, mount: M }), null);
  assert.strictEqual(acceptFromChild(ev({ origin: 'null' }), { frameWindow: frame, mount: M }), null);
  assert.strictEqual(acceptFromChild(ev({ source: other }), { frameWindow: frame, mount: M }), null);
  assert.strictEqual(acceptFromChild(ev({}), { frameWindow: null, mount: M }), null);
  assert.strictEqual(acceptFromChild(ev({ data: childMessage('ready', 'b'.repeat(32)) }), { frameWindow: frame, mount: M }), null);
});

test('acceptFromParent(): the portal origin AND window.parent AND the mount, or nothing', () => {
  const parent = {}, other = {};
  const ev = (o) => ({ origin: PORTAL_ORIGIN, source: parent, data: okRender(), ...o });
  assert.ok(acceptFromParent(ev({}), { parentWindow: parent, mount: M }));
  assert.strictEqual(acceptFromParent(ev({ origin: MAP_ORIGIN }), { parentWindow: parent, mount: M }), null);
  assert.strictEqual(acceptFromParent(ev({ source: other }), { parentWindow: parent, mount: M }), null);
  assert.strictEqual(acceptFromParent(ev({}), { parentWindow: parent, mount: null }), null);
  assert.strictEqual(acceptFromParent(ev({ data: { ...okRender(), mount: 'b'.repeat(32) } }), { parentWindow: parent, mount: M }), null);
});

// ── Z2 · protocol v3 (PLAN-portal-zones-protocol-v3 r1 §2 + r2 P2-3 / P2-6 + r3 #181-6 + r4) ─────────────────────────────────────────────
// Portal → map: render v3 = v2 + `zones` (the draft's zones the map draws) + `drawing` (null | the live session: its points, the last
// accepted seq, the parent's ack for the last finish, a «Terminar» request). Map → portal (v2 children): hello{proto:3}, draft_points,
// finish, edit_request. Structural only: the shape rules are zone-shape.js's (the server's), never the protocol's.
const S1 = 'b'.repeat(32), S2 = 'c'.repeat(32);
const ZP = (n, lat = 15.5, lng = -88.03) => Array.from({ length: n }, (_, i) => ({ lat: lat + i * 0.001, lng: lng + (i % 2) * 0.001 }));
const ZONE = () => ({ id: 'z_ab12cd34', name: 'Río', points: ZP(4) });
const DRAW = (o = {}) => ({ session: S1, zone: null, points: ZP(2), seq: 2, ack: null, request: null, ...o });
const V2F = () => { const { v, kind, ...f } = okRender(); return f; };
const v3 = (o = {}) => ({ ...okRender(), v: 3, zones: [ZONE()], drawing: DRAW(), ...o });

test('Z2 the zone limits: 8 zones, 24 points, a 30-character name, seq ≤ 10⁶', () => {
  assert.deepStrictEqual(P.ZONE_LIMITS, { zones: 8, points: 24, name: 30, seq: 1e6 }, '🔴 ZONE_LIMITS');
});

test('Z2 render v3: the exact key set; zones and drawing validated; v1 / v2 still valid', () => {
  assert.strictEqual(isRender(v3(), M), true, '🔴 a well-formed v3 render is valid');
  assert.strictEqual(isRender(v3({ drawing: null, zones: [] }), M), true, 'no session, no zones');
  assert.strictEqual(isRender(V1(), M), true, 'v1 still valid'); assert.strictEqual(isRender(okRender(), M), true, 'v2 still valid');
  const bad = {
    'v3 without drawing': (() => { const m = v3(); delete m.drawing; return m; })(),
    'v2 carrying zones': { ...okRender(), zones: [] },
    'an extra key': { ...v3(), extra: 1 },
    'a zone id off the server pattern': v3({ zones: [{ ...ZONE(), id: 'z_AB12CD34' }] }),
    'a zone with 2 points': v3({ zones: [{ ...ZONE(), points: ZP(2) }] }),
    'a zone with 25 points': v3({ zones: [{ ...ZONE(), points: ZP(25) }] }),
    'a 31-character name': v3({ zones: [{ ...ZONE(), name: 'x'.repeat(31) }] }),
    'an empty name': v3({ zones: [{ ...ZONE(), name: '' }] }),
    'nine zones': v3({ zones: Array.from({ length: 9 }, (_, i) => ({ ...ZONE(), id: `z_${String(i).padStart(8, 'a')}` })) }),
    'two zones with one id': v3({ zones: [ZONE(), ZONE()] }),
    'a zone with an extra key': v3({ zones: [{ ...ZONE(), color: 'red' }] }),
    'a NaN point': v3({ zones: [{ ...ZONE(), points: [...ZP(3), { lat: NaN, lng: 1 }] }] }),
    'a bad session': v3({ drawing: DRAW({ session: 'B'.repeat(32) }) }),
    'drawing with an extra key': v3({ drawing: { ...DRAW(), finished_seq: 1 } }),
    'drawing with 25 points': v3({ drawing: DRAW({ points: ZP(25) }) }),
    'a fractional seq': v3({ drawing: DRAW({ seq: 1.5 }) }),
    'a seq past 10⁶': v3({ drawing: DRAW({ seq: 1e6 + 1 }) }),
    'a negative seq': v3({ drawing: DRAW({ seq: -1 }) }),
    'an unknown request': v3({ drawing: DRAW({ request: 'save' }) }),
    'a bad zone in drawing': v3({ drawing: DRAW({ zone: 'zone1' }) }),
    'a rejected ack without its line': v3({ drawing: DRAW({ ack: { session: S1, seq: 2, outcome: 'rejected' } }) }),
    'an accepted ack with a line': v3({ drawing: DRAW({ ack: { session: S1, seq: 2, outcome: 'accepted', line: 'self_cross' } }) }),
    'a line off the enum': v3({ drawing: DRAW({ ack: { session: S1, seq: 2, outcome: 'rejected', line: 'nope' } }) }),
    'an unknown outcome': v3({ drawing: DRAW({ ack: { session: S1, seq: 2, outcome: 'saved' } }) }),
    'an ack for another session': v3({ drawing: DRAW({ ack: { session: S2, seq: 2, outcome: 'accepted' } }) }),
    'an ack seq 0': v3({ drawing: DRAW({ ack: { session: S1, seq: 0, outcome: 'accepted' } }) }),
  };
  for (const [why, m] of Object.entries(bad)) assert.strictEqual(isRender(m, M), false, `🔴 refused: ${why}`);
  for (const ack of [{ session: S1, seq: 2, outcome: 'accepted' }, { session: S1, seq: 2, outcome: 'ended' },
    ...P.ACK_LINES.map((line) => ({ session: S1, seq: 2, outcome: 'rejected', line }))]) assert.strictEqual(isRender(v3({ drawing: DRAW({ ack }) }), M), true, JSON.stringify(ack));
  assert.deepStrictEqual(P.ACK_LINES, ['min_points', 'self_cross', 'max_points', 'too_big', 'out_of_range'], 'the five shape problems (plan r2 P2-7)');
  assert.strictEqual(isRender(v3({ drawing: DRAW({ request: 'finish' }) }), M), true, '«Terminar» asks the map for its finish');
  assert.strictEqual(isRender(v3({ drawing: DRAW({ zone: 'z_ab12cd34', seq: 0 }) }), M), true, 'an EDITING session opened by the portal, nothing accepted yet');
});

test('Z2 renderMessage: zones / drawing ⇒ v3; without them the v2 it sends today', () => {
  const m3 = renderMessage({ ...V2F(), zones: [ZONE()], drawing: null });
  assert.strictEqual(m3.v, 3, '🔴 v3 when zones / drawing are given');
  assert.deepStrictEqual(Object.keys(m3), ['v', 'mount', 'kind', 'view', 'theme', 'hub', 'name', 'others', 'bands', 'mapType', 'limit', 'zones', 'drawing']);
  assert.strictEqual(renderMessage(V2F()).v, 2, 'unchanged: v2');
  assert.throws(() => renderMessage({ ...V2F(), zones: [ZONE()] }), /bad render/, 'zones without drawing is not a render');
  assert.throws(() => renderMessage({ ...V2F(), zones: [ZONE(), ZONE()], drawing: null }), /bad render/);
});

test('Z2 the map\'s v2 messages: hello{proto:3}, draft_points, finish, edit_request — exact keys, else refused', () => {
  const ok = {
    hello: { v: 2, mount: M, kind: 'hello', proto: 3 },
    draft_points: { v: 2, mount: M, kind: 'draft_points', session: S1, seq: 1, points: [] },
    finish: { v: 2, mount: M, kind: 'finish', session: S1, seq: 1e6, points: ZP(24) },
    edit_request: { v: 2, mount: M, kind: 'edit_request', zone: 'z_ab12cd34' },
  };
  for (const [k, m] of Object.entries(ok)) assert.strictEqual(isChildMessage(m, M), true, `🔴 ${k} is valid`);
  const bad = {
    'hello as v1': { ...ok.hello, v: 1 }, 'hello proto 2': { ...ok.hello, proto: 2 }, 'hello extra key': { ...ok.hello, x: 1 },
    'v2 listening': { v: 2, mount: M, kind: 'listening' }, 'an unknown kind': { ...ok.draft_points, kind: 'commit' },
    'a bad session': { ...ok.draft_points, session: 'x' }, 'seq 0': { ...ok.draft_points, seq: 0 }, 'seq past 10⁶': { ...ok.finish, seq: 1e6 + 1 },
    'a fractional seq': { ...ok.finish, seq: 2.5 }, 'a string seq': { ...ok.finish, seq: '3' }, '25 points': { ...ok.finish, points: ZP(25) },
    'a NaN point': { ...ok.draft_points, points: [{ lat: NaN, lng: 0 }] }, 'a point with an extra key': { ...ok.draft_points, points: [{ lat: 1, lng: 1, z: 0 }] },
    'a delta, not a list': { ...ok.draft_points, points: { add: { lat: 1, lng: 1 } } }, 'no points': (() => { const m = { ...ok.finish }; delete m.points; return m; })(),
    'another mount': { ...ok.finish, mount: 'd'.repeat(32) }, 'no mount': (() => { const m = { ...ok.hello }; delete m.mount; return m; })(),
    'edit_request bad zone': { ...ok.edit_request, zone: 'z_1' }, 'edit_request extra key': { ...ok.edit_request, points: [] },
  };
  for (const [why, m] of Object.entries(bad)) assert.strictEqual(isChildMessage(m, M), false, `🔴 refused: ${why}`);
  assert.deepStrictEqual(P.mapMessage('finish', M, { session: S1, seq: 3, points: ZP(3) }), { v: 2, mount: M, kind: 'finish', session: S1, seq: 3, points: ZP(3) });
  assert.deepStrictEqual(P.mapMessage('hello', M), ok.hello);
  assert.throws(() => P.mapMessage('finish', M, { session: S1, seq: 0, points: [] }), /bad map message/);
  const frame = {};
  const ev = (origin, data, source = frame) => ({ origin, source, data });
  assert.deepStrictEqual(acceptFromChild(ev(MAP_ORIGIN, ok.finish), { frameWindow: frame, mount: M }), ok.finish, 'accepted from the map, its frame, this mount');
  assert.strictEqual(acceptFromChild(ev('https://evil.example', ok.finish), { frameWindow: frame, mount: M }), null, 'a finish from another origin is dropped');
  assert.strictEqual(acceptFromChild(ev(MAP_ORIGIN, ok.finish, {}), { frameWindow: frame, mount: M }), null, 'another window: dropped');
});
