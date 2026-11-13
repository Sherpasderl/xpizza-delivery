// «Envío» step 1 (PLAN-portal-envio-step1 r2 §1, §4; C2, C3) — the MAP SITE (xpizza-portal-map/, its own Netlify site and origin).
// Run: node --test xpizza-portal/envio-map-site.test.mjs
//   • its committed copies are byte-identical to their ONE source (the protocol module, the Archivo face) and the sync tool writes them;
//   • its headers: the Maps CSP on THIS origin only, framed only by the portal, no X-Frame-Options, no build command;
//   • the key is dispatch's Maps key (same referrer-restricted browser key; compared, never printed);
//   • the overlay model: 256-vertex rings, the outside hole, the mockup's labels and pins, scaled by u = W/640;
//   • the frame's life (C2) with fake Google Maps classes: listener before `listening`; ready only after tilesloaded; failures once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIR } from './ventas-harness.mjs';
import * as MP from './envio-map-protocol.js';
import * as G from '../xpizza-portal-map/envio-geometry.js';

const MAP = join(DIR, '..', 'xpizza-portal-map');
const read = (p) => readFileSync(p);
globalThis.window = undefined;   // map.js only self-boots in a browser
const { overlayModel, boot } = await import('../xpizza-portal-map/map.js');

test('the map site\'s copies are byte-identical to their one source, and the sync tool writes them', () => {
  assert.ok(read(join(MAP, 'envio-map-protocol.js')).equals(read(join(DIR, 'envio-map-protocol.js'))), 'protocol copy drifted — run node xpizza-functions/tools/sync-client.js');
  assert.ok(read(join(MAP, 'fonts', 'archivo-latin.7150c0ec5a.woff2')).equals(read(join(DIR, 'fonts', 'archivo-latin.7150c0ec5a.woff2'))), 'font copy drifted');
  const sync = readFileSync(join(DIR, '..', 'xpizza-functions', 'tools', 'sync-client.js'), 'utf8');
  assert.ok(sync.includes("path.join(ROOT, 'xpizza-portal', 'envio-map-protocol.js'), path.join(ROOT, 'xpizza-portal-map', 'envio-map-protocol.js')"));
  assert.ok(sync.includes("'archivo-latin.7150c0ec5a.woff2'), path.join(ROOT, 'xpizza-portal-map', 'fonts', 'archivo-latin.7150c0ec5a.woff2')"));
  const css = readFileSync(join(MAP, 'map.css'), 'utf8');
  assert.ok(css.includes('url(fonts/archivo-latin.7150c0ec5a.woff2)') && existsSync(join(MAP, 'fonts', 'archivo-latin.7150c0ec5a.woff2')));
});

test('headers: the Maps CSP lives on THIS origin only; framed only by the portal; no X-Frame-Options; no build command', () => {
  const toml = readFileSync(join(MAP, 'netlify.toml'), 'utf8');
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)[1];
  assert.equal(csp, "default-src 'none'; script-src 'self' https://maps.googleapis.com https://*.gstatic.com; img-src 'self' data: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; connect-src https://*.googleapis.com https://*.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; worker-src blob:; frame-src https://*.google.com; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors https://sherpa-portal.netlify.app");
  assert.ok(!/X-Frame-Options/.test(toml.replace(/#.*$/gm, '')), 'no XFO: it would conflict with frame-ancestors');
  assert.ok(!/^\s*command\s*=/m.test(toml), 'no build command (static files only)');
  assert.ok(/Referrer-Policy = "strict-origin-when-cross-origin"/.test(toml));
  // the portal's side: its CSP + only the one frame-src, and XFO DENY kept
  const ptoml = readFileSync(join(DIR, 'netlify.toml'), 'utf8');
  assert.ok(/frame-src https:\/\/sherpa-portal-map\.netlify\.app;/.test(ptoml) && /frame-ancestors 'none'/.test(ptoml) && /X-Frame-Options = "DENY"/.test(ptoml));
  assert.ok(!/maps\.googleapis|unsafe-inline|unsafe-eval/.test(/Content-Security-Policy = "([^"]+)"/.exec(ptoml)[1]), 'the portal\'s own policy admits no Maps');
  const html = readFileSync(join(MAP, 'map.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/<style|style=/.test(html), 'no inline script or style');
  assert.ok(/<script type="module" src="map\.js"><\/script>/.test(html) && /href="map\.css"/.test(html));
});

test('the key is dispatch\'s Maps key (the same referrer-restricted browser key) — compared, never printed', () => {
  const key = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };
  const mine = key(readFileSync(join(MAP, 'map.js'), 'utf8'), /const MAPS_KEY = '(AIza[0-9A-Za-z_-]{35})';/);
  const dispatch = key(readFileSync(join(DIR, '..', 'xpizza-dispatch-mobile', 'index.html'), 'utf8'), /const mapsApiKey = "(AIza[0-9A-Za-z_-]{35})";/);
  assert.ok(mine && dispatch, 'both keys present');
  assert.ok(mine === dispatch, 'map.js uses dispatch\'s Maps key');
  const proto = readFileSync(join(DIR, 'envio-map-protocol.js'), 'utf8') + readFileSync(join(DIR, 'envio.js'), 'utf8');
  assert.ok(!/AIza/.test(proto), 'the key never reaches the portal or the protocol');
});

// a flat projection around the hub at the zoom map.js would set (enough to read the model; the geometry suite proves the zoom)
const HUB = { lat: 15.5041, lng: -88.0385 };
function flat(W) {
  const ppk = G.pixelsPerKm(W);
  return (p) => ({ x: 1000 + (p.lng - HUB.lng) * 111.32 * Math.cos(HUB.lat * Math.PI / 180) * ppk, y: 1000 - (p.lat - HUB.lat) * 110.574 * ppk });
}
// v2 (what the portal sends): each band's `out`, the map type, the limit (defaults: nothing beyond, «Mapa», no limit)
const render = (bands, extra = {}) => MP.renderMessage({ mount: 'a'.repeat(32), view: 'reset', theme: 'light', hub: HUB, name: 'La Musa', others: [{ lat: 15.5075, lng: -88.0398 }],
  bands: bands.map((b) => ({ out: false, ...b })), mapType: 'roadmap', limit: null, ...extra });
// v1 (an older portal): step 1's exact shape
const renderV1 = (bands) => ({ v: 1, mount: 'a'.repeat(32), kind: 'render', view: 'reset', theme: 'light', hub: HUB, name: 'La Musa', others: [], bands });

test('overlayModel: rings inner→outer with the last VALID one outer, the outside hole, the mockup\'s pills, pins, the name — scaled by u', () => {
  const u = 540 / 640;
  const m = overlayModel(render([{ km: 3, fee: 4000, ok: true }, { km: 6, fee: 5000, ok: true }, { km: 12, fee: 9000, ok: false }]), flat(540), u);
  assert.deepEqual(m.rings.map((r) => r.cls), ['ring outer', 'ring', 'ring bad']);
  assert.equal((m.rings[0].d.match(/L/g) || []).length, 255, '256 vertices');
  assert.ok(m.outside.startsWith('M') && m.outside.endsWith(m.rings[0].d), 'the shade is a rect with the OUTER ring as its hole');
  assert.deepEqual(m.labels.map((l) => [l.cls, l.text, Math.round(l.w)]), [['rl', '3 km · L 40', Math.round(90 * u)], ['rl outer', '6 km · L 50 · límite', Math.round(150 * u)], ['rl bad', '12 km · fuera del límite', Math.round(160 * u)]]);
  const p = flat(540);
  const ne = p(G.labelAnchor(HUB, 3, false)), c = p(HUB);
  assert.ok(Math.abs(m.labels[0].x - ne.x) < 1e-9 && ne.x > c.x && ne.y < c.y, 'band labels on the NE diagonal');
  assert.ok(m.labels[2].x < c.x && m.labels[2].y > c.y, 'the refused label on the SW diagonal');
  assert.equal(m.pins.length, 1);
  assert.deepEqual([Math.round(m.name.x - c.x), Math.round(m.name.y - c.y)], [Math.round(14 * u), Math.round(-26 * u)]);
  // the 3 km ring's radius in px = 24·W/640 per km (the mockup's scale)
  const east = p(G.destination(HUB, 90, 3000));
  assert.ok(Math.abs(east.x - c.x - G.pixelsPerKm(540) * 3) < 0.5);
  assert.deepEqual(overlayModel(render([]), flat(540), u).rings, [], 'no bands: no rings, no shade');
  assert.deepEqual(overlayModel(render([], { hub: null }), flat(540), u), { rings: [], outside: null, labels: [], pins: [], name: null }, 'no pin: nothing');
});

// ── the frame's life with fake Google Maps classes ──────────────────────────────────────────────────────────────────────
function fakeEnv({ hash = `#m=${'a'.repeat(32)}`, direct = false, load = 'ok', width = 640 } = {}) {
  const order = [];
  const listeners = {};
  const parent = { posted: [], postMessage(m, o) { order.push('post'); this.posted.push([m, o]); } };
  const win = { location: { hash }, addEventListener(t, f) { order.push(`listen:${t}`); (listeners[t] = listeners[t] || []).push(f); },
    ResizeObserver: class { constructor(cb) { win.__ro = cb; } observe() {} } };
  win.parent = direct ? win : parent;
  const box = { clientWidth: width, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const doc = { getElementById: () => box, createElementNS: () => ({ setAttribute() {}, style: { setProperty() {} }, replaceChildren() {}, remove() {} }) };
  const maps = {
    made: [],
    LatLng: class { constructor(lat, lng) { this.lat = lat; this.lng = lng; } },
    OverlayView: class { setMap(m) { this.map = m; } getProjection() { return null; } getPanes() { return { overlayLayer: { append() {} } }; } },
    Map: class {
      constructor(el, opts) { this.opts = opts; this.calls = []; this.ls = {}; maps.made.push(this); }
      addListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); return { remove: () => { this.ls[t] = this.ls[t].filter((x) => x !== f); } }; }
      fire(t) { for (const f of [...(this.ls[t] || [])]) f(); }
      setCenter(c) { this.calls.push(['center', c]); }
      setZoom(z) { this.calls.push(['zoom', z]); this.fire('zoom_changed'); }
      setOptions(o) { this.calls.push(['options', o]); }
      setMapTypeId(t) { this.calls.push(['type', t]); }
    },
  };
  const loadMaps = () => (load === 'ok' ? Promise.resolve(maps) : Promise.reject(new Error(load === 'load' ? 'The Google Maps JavaScript API could not load.' : 'nope')));
  const fromParent = (data, { origin = MP.PORTAL_ORIGIN, source = parent } = {}) => (listeners.message || []).forEach((f) => f({ origin, source, data }));
  return { win, doc, parent, maps, loadMaps, order, fromParent, box };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const M = 'a'.repeat(32);
const B = [{ km: 3, fee: 4000, ok: true }];

test('C2 child: the listener exists BEFORE `listening` (sent to the portal origin); off-shape / wrong-origin / wrong-source renders are dropped', async () => {
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps });
  assert.deepEqual(E.order.slice(0, 2), ['listen:message', 'post']);
  assert.deepEqual(E.parent.posted[0], [{ v: 1, mount: M, kind: 'listening' }, MP.PORTAL_ORIGIN]);
  await tick();
  E.fromParent(render(B), { origin: MP.MAP_ORIGIN });
  E.fromParent(render(B), { source: {} });
  E.fromParent({ ...render(B), mount: 'b'.repeat(32) });
  E.fromParent({ ...render(B), extra: 1 });
  assert.equal(E.maps.made.length, 0);
  E.fromParent(render(B)); await tick();
  assert.equal(E.maps.made.length, 1);
  const o = E.maps.made[0].opts;
  assert.deepEqual(o.center, G.cameraCenter(HUB));
  assert.equal(o.zoom, G.zoomFor(640, HUB.lat));
  assert.equal(o.isFractionalZoomEnabled, true);
  assert.equal(o.gestureHandling, 'cooperative');
});

test('C2 child: `ready` only after the Map exists AND its first tiles loaded — once', async () => {
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps });
  await tick();
  assert.ok(!E.parent.posted.some(([m]) => m.kind === 'ready'), 'not before a render built the Map');
  E.fromParent(render(B)); await tick();
  assert.ok(!E.parent.posted.some(([m]) => m.kind === 'ready'), 'not before tiles');
  E.maps.made[0].fire('tilesloaded'); E.maps.made[0].fire('tilesloaded');
  assert.equal(E.parent.posted.filter(([m]) => m.kind === 'ready').length, 1);
  E.win.gm_authFailure();
  assert.ok(!E.parent.posted.some(([m]) => m.kind === 'failed'), 'a failure after ready is not reported');
});

test('C2 child: the key refused AFTER the Map was built → `failed`, and tiles that still load never turn it into `ready`', async () => {
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.fromParent(render(B)); await tick();
  E.win.gm_authFailure();
  E.maps.made[0].fire('tilesloaded');
  assert.deepEqual(E.parent.posted.slice(1).map(([m]) => m.kind), ['failed']);
});

test('C2 child failures, each sent once with its cause: script load error, import rejection, the key refused (gm_authFailure)', async () => {
  for (const [load, cause] of [['load', 'load_error'], ['reject', 'import_rejected']]) {
    const E = fakeEnv({ load });
    boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick(); await tick();
    assert.deepEqual(E.parent.posted.filter(([m]) => m.kind === 'failed').map(([m]) => m.cause), [cause]);
  }
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.win.gm_authFailure(); E.win.gm_authFailure();
  E.fromParent(render(B)); await tick();
  assert.deepEqual(E.parent.posted.filter(([m]) => m.kind === 'failed').map(([m]) => m.cause), ['auth_failure']);
  assert.equal(E.maps.made.length, 0, 'nothing is built after a failure');
});

test('C2 child: opened directly (not framed) or without a mount id → idle: nothing listens, nothing is sent', () => {
  for (const env of [fakeEnv({ direct: true }), fakeEnv({ hash: '' }), fakeEnv({ hash: '#m=xyz' })]) {
    assert.deepEqual(boot({ win: env.win, doc: env.doc, loadMaps: env.loadMaps }), { idle: true });
    assert.equal(env.parent.posted.length, 0);
  }
});

test('view: `reset` re-centres and re-zooms; `keep` doesn\'t; a resize re-fits only while the owner hasn\'t zoomed or panned', async () => {
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.fromParent(render(B)); await tick();
  const map = E.maps.made[0];
  E.fromParent({ ...render([{ km: 4, fee: 4000, ok: true }]), view: 'keep' }); await tick();
  assert.equal(map.calls.length, 0, 'keep: no camera move');
  E.fromParent(render(B)); await tick();
  assert.deepEqual(map.calls.map((c) => c[0]), ['center', 'zoom'], 'reset: centre + zoom (programmatic: not a user move)');
  E.box.clientWidth = 320; E.win.__ro();
  assert.deepEqual(map.calls.slice(-1)[0], ['zoom', G.zoomFor(320, HUB.lat)], 'resize re-fits 24·W/640');
  map.fire('dragstart');
  const n = map.calls.length;
  E.box.clientWidth = 390; E.win.__ro();
  assert.equal(map.calls.length, n, 'after the owner moved the map, a resize doesn\'t snap it back');
});


// ── ENVÍO v3 A2 / A4 (PLAN-portal-envio-v3-ui r5 §2; MOCKUP-portal-envio-v3-limit): the restaurant's limit, bands beyond it, the styles ──
test('A2 overlayModel: the limit is the SOLID ink ring at its km with «Límite de {restaurante} · {km} km»; bands beyond it greyed «· fuera de su alcance»; the shade starts at the limit', () => {
  const u = 540 / 640;
  const bands = [{ km: 3, fee: 4000, ok: true }, { km: 6, fee: 5000, ok: true }, { km: 10, fee: 8000, ok: true, out: true }];
  const m = overlayModel(render(bands, { limit: { km: 7, capped: false, name: 'La Musa' } }), flat(540), u);
  assert.deepEqual(m.rings.map((r) => r.cls), ['ring beyond', 'ring', 'ring', 'ring rlim'], 'fee rings outer→inner (no «outer» once a limit is drawn), the band beyond greyed, the limit ring last (on top)');
  const ring7 = (() => { const p = flat(540); const pts = G.ringPath(HUB, 7).map(p); return `M${pts.map((q) => `${Math.round(q.x * 100) / 100} ${Math.round(q.y * 100) / 100}`).join('L')}Z`; })();
  assert.equal(m.rings[3].d, ring7, 'the limit ring is the overlay’s own path at limit.km');
  assert.ok(m.outside.endsWith(ring7), 'the outside shade starts at the limit, not at the table’s top');
  assert.deepEqual(m.labels.map((l) => [l.cls, l.text, Math.round(l.w)]),
    [['rl', '3 km · L 40', Math.round(90 * u)], ['rl', '6 km · L 50', Math.round(90 * u)], ['rl beyond', '10 km · L 80 · fuera de su alcance', Math.round(190 * u)], ['rl lim', 'Límite de La Musa · 7 km', Math.round(170 * u)]]);
  const p = flat(540), east = p(G.destination(HUB, 90, 7000)), lim = m.labels[3];
  assert.ok(Math.abs(lim.x - east.x) < 1e-9 && Math.abs(lim.y - east.y) < 1e-9, 'the limit label sits on the limit ring, due east (clear of the NE band labels)');
});
test('A4 overlayModel: a capped limit says «· tope de la tabla» (the wider pill); no limit keeps step 1’s «· límite» outer ring', () => {
  const u = 1;
  const capped = overlayModel(render([{ km: 3, fee: 4000, ok: true }, { km: 8, fee: 6000, ok: true }], { limit: { km: 8, capped: true, name: 'La Musa' } }), flat(640), u);
  assert.deepEqual(capped.labels.slice(-1).map((l) => [l.cls, l.text, Math.round(l.w)]), [['rl lim', 'Límite de La Musa · 8 km · tope de la tabla', 250]]);
  assert.deepEqual(capped.rings.map((r) => r.cls), ['ring', 'ring', 'ring rlim']);
  const none = overlayModel(render([{ km: 3, fee: 4000, ok: true }, { km: 6, fee: 5000, ok: true }]), flat(640), u);
  assert.deepEqual(none.rings.map((r) => r.cls), ['ring outer', 'ring'], 'no limit: step 1’s drawing, unchanged');
  assert.deepEqual(none.labels.map((l) => l.text), ['3 km · L 40', '6 km · L 50 · límite']);
});
test('A2 styles: «Mapa» = roadmap, no styles; «Simple» = today’s LIGHT styles on roadmap; «Satélite» = hybrid; a switch re-styles the SAME map (no new Map, no camera move); data-maptype on the root; v1 is drawn «Simple»', async () => {
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.fromParent(render(B)); await tick();
  const map = E.maps.made[0];
  assert.equal(map.opts.mapTypeId, 'roadmap', '«Mapa»: roadmap');
  assert.equal(map.opts.styles, null, '«Mapa»: no styles');
  assert.equal(map.opts.clickableIcons, false); assert.equal(map.opts.mapTypeControl, undefined, 'Google’s own type control stays off (disableDefaultUI)');
  assert.equal(map.opts.disableDefaultUI, true);
  assert.equal(E.box.attrs['data-maptype'], 'roadmap');
  map.calls.length = 0;
  E.fromParent({ ...render(B), view: 'keep', mapType: 'hybrid' }); await tick();
  assert.deepEqual(map.calls, [['options', { styles: null }], ['type', 'hybrid']], '«Satélite»: hybrid on the same map, camera kept');
  assert.equal(E.box.attrs['data-maptype'], 'hybrid');
  map.calls.length = 0;
  E.fromParent({ ...render(B), view: 'keep', mapType: 'simple' }); await tick();
  assert.equal(map.calls[0][0], 'options'); assert.ok(Array.isArray(map.calls[0][1].styles) && map.calls[0][1].styles.length > 0, '«Simple»: the LIGHT styles array');
  assert.deepEqual(map.calls[1], ['type', 'roadmap']);
  map.calls.length = 0;
  E.fromParent({ ...render(B), view: 'keep', mapType: 'simple' }); await tick();
  assert.deepEqual(map.calls, [], 'the same type again: nothing re-styled');
  assert.equal(E.maps.made.length, 1, 'one Map across every switch');
  const E1 = fakeEnv();
  boot({ win: E1.win, doc: E1.doc, loadMaps: E1.loadMaps }); await tick();
  E1.fromParent(renderV1(B)); await tick();
  assert.equal(E1.maps.made.length, 1, 'a v1 render is drawn');
  assert.equal(E1.maps.made[0].opts.mapTypeId, 'roadmap'); assert.ok(Array.isArray(E1.maps.made[0].opts.styles) && E1.maps.made[0].opts.styles.length > 0, 'v1 → «Simple»');
});
test('the loader asks Google for Spanish labels', () => {
  assert.match(readFileSync(join(MAP, 'map.js'), 'utf8'), /language: "es"/, 'language es on the bootstrap loader');
});
