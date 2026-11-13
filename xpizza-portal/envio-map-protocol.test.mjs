// «Envío» step 1 (PLAN-portal-envio-step1 r2 §1b + build condition C2) — the portal ↔ map-site messages. ONE module validates both
// directions; the map site carries a byte copy. Run: node --test xpizza-portal/envio-map-protocol.test.mjs
// Geometry and theme only travel to the map; only listening / ready / failed come back. Nothing the map sends can authorize anything.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  PORTAL_ORIGIN, MAP_ORIGIN, LIMITS, newMountId, mountFromHash, renderMessage, isRender, childMessage, isChildMessage,
  acceptFromChild, acceptFromParent,
} from './envio-map-protocol.js';

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
