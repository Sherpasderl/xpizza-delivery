// «Envío» step 1 (PLAN-portal-envio-step1 r2 §1, §4; C2, C3) — the MAP SITE (xpizza-portal-map/, its own Netlify site and origin).
// Run: node --test xpizza-portal/envio-map-site.test.mjs
//   • its committed copies are byte-identical to their ONE source (the protocol module, the portal's Figtree latin face) and the sync tool writes them;
//   • its headers: the Maps CSP on THIS origin only, framed only by the portal, no X-Frame-Options, no build command;
//   • the key is dispatch's Maps key (same referrer-restricted browser key; compared, never printed);
//   • the overlay model: 256-vertex rings, the outside hole, the mockup's labels and pins, scaled by u = W/640;
//   • the frame's life (C2) with fake Google Maps classes: listener before `listening`; ready only after tilesloaded; failures once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
  const FACE = 'figtree-latin.8330490a01.woff2';   // the portal's ONE critical file (its preload), owner 11-13: Figtree everywhere
  assert.ok(read(join(MAP, 'fonts', FACE)).equals(read(join(DIR, 'fonts', FACE))), 'font copy drifted');
  const sync = readFileSync(join(DIR, '..', 'xpizza-functions', 'tools', 'sync-client.js'), 'utf8');
  assert.ok(sync.includes("path.join(ROOT, 'xpizza-portal', 'envio-map-protocol.js'), path.join(ROOT, 'xpizza-portal-map', 'envio-map-protocol.js')"));
  assert.ok(sync.includes(`'${FACE}'), path.join(ROOT, 'xpizza-portal-map', 'fonts', '${FACE}')`));
  const css = readFileSync(join(MAP, 'map.css'), 'utf8');
  // the map's @font-face IS the portal's generated latin rule, byte for byte (the one pipeline decides its descriptors)
  const portalFace = (readFileSync(join(DIR, 'portal-fonts.css'), 'utf8').match(/@font-face\{font-family:'Figtree';[^}]*figtree-latin\.[0-9a-f]{10}\.woff2[^}]*\}/) || [])[0];
  assert.ok(portalFace && css.includes(portalFace), 'the map\'s face is the portal\'s generated latin rule, verbatim');
  assert.deepEqual(readdirSync(join(MAP, 'fonts')).filter((n) => n.endsWith('.woff2')), [FACE], 'exactly the one face file (Archivo has left)');
  assert.match(css, /--body:'Figtree',system-ui,-apple-system,'Segoe UI',sans-serif;--disp:var\(--body\)/, 'the map\'s tokens: one family');
  assert.doesNotMatch(css, /Archivo|Söhne/, 'no Archivo / Söhne left');
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
  assert.deepEqual(E.parent.posted.slice(2).map(([m]) => m.kind), ['failed']);   // after listening + hello (Z2)
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

// Codex HIGH r1 P2 — the embedded map joins the contrast coverage: every ring label's TEXT clears 4.5:1 on its own label box (the
// labels carry information — «fuera de su alcance» included — they are not disabled controls), in every map style (hybrid does not
// restyle the label boxes)
test('map labels: every .rings .rl … text fill clears 4.5:1 on the label box (.rings .rl rect), every style', () => {
  const css = readFileSync(join(DIR, '..', 'xpizza-portal-map', 'map.css'), 'utf8');
  const lum = (h) => { const x = h.replace('#', ''); const c = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const box = /\.rings \.rl rect\{[^}]*fill:(#[0-9A-Fa-f]{6})/.exec(css);
  assert.ok(box, 'premise: the label box fill');
  assert.ok(!/\.rl[^{]*rect\{[^}]*fill:/.test(css.replace(box[0], '')), 'no other rule repaints a label box (the one ground)');
  const texts = [...css.matchAll(/([^{}]*\.rl[^{}]*text)\{[^}]*fill:(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1].trim(), m[2]]);
  assert.ok(texts.length >= 3, `premise: the label text rules (${texts.length})`);
  for (const [sel, fill] of texts) assert.ok(ratio(fill, box[1]) >= 4.5, `${sel}: ${fill} on ${box[1]} = ${ratio(fill, box[1]).toFixed(2)}:1 ≥ 4.5`);
});

// ── Z2 — the map CHILD's drawing (PLAN-portal-zones-protocol-v3 r1 §2, r2 P2-3/P2-6, r3 #181-6, r4 #185): hello after listening; the child
// only PROPOSES points (whole lists, a per-session seq) and finishes; the parent decides. drawController is the pure state machine.
const { drawController } = await import('../xpizza-portal-map/map.js');
const S1 = 'b'.repeat(32), S2 = 'c'.repeat(32);
const P = (i) => ({ lat: 15.5 + i * 0.001, lng: -88.03 + (i % 2) * 0.001 });
const DRAW = (o = {}) => ({ session: S1, zone: null, points: [], seq: 0, ack: null, request: null, ...o });
function ctl() {
  const sent = [], timers = [];
  const c = drawController({ send: (kind, body) => sent.push({ kind, ...body }), schedule: (f, ms) => { timers.push({ f, ms }); return timers.length; }, cancel: (h) => { if (timers[h - 1]) timers[h - 1].f = null; } });
  const runTimers = () => { const t = timers.splice(0); for (const x of t) if (x.f) x.f(); };
  return { c, sent, runTimers };
}

test('Z2 child: `hello{proto:3}` right after `listening` (the old portal drops it; the new one renders v3 only after it)', async () => {
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps });
  assert.deepEqual(E.parent.posted.slice(0, 2).map(([m, o]) => [m.kind, m.v, o]), [['listening', 1, MP.PORTAL_ORIGIN], ['hello', 2, MP.PORTAL_ORIGIN]], '🔴 hello after listening');
  assert.deepEqual(E.parent.posted[1][0], { v: 2, mount: M, kind: 'hello', proto: 3 });
});

test('Z2 child: taps add points ONLY while a session is open — each a WHOLE list with a higher seq; a repeated tap and a 25th point are ignored', () => {
  const { c, sent } = ctl();
  c.tap(P(0));
  assert.equal(sent.length, 0, 'no session: nothing');
  c.onRender(DRAW());
  c.tap(P(0)); c.tap(P(1)); c.tap(P(1));
  assert.deepEqual(sent.map((m) => [m.kind, m.seq, m.points.length]), [['draft_points', 1, 1], ['draft_points', 2, 2]], '🔴 whole lists, seq 1, 2; the repeat ignored');
  assert.equal(sent[1].session, S1);
  for (let i = 2; i < 30; i++) c.tap(P(i));
  assert.equal(sent[sent.length - 1].points.length, 24, '🔴 never more than 24');
});

test('Z2 child: an older echo never replaces newer local points; a newer parent list is adopted', () => {
  const { c, sent } = ctl();
  c.onRender(DRAW());
  c.tap(P(0)); c.tap(P(1)); c.tap(P(2));
  c.onRender(DRAW({ points: [P(0)], seq: 1 }));
  c.tap(P(3));
  assert.equal(sent[sent.length - 1].points.length, 4, '🔴 the older echo (seq 1) did not replace the local list');
  assert.equal(sent[sent.length - 1].seq, 4);
});

test('Z2 child: tapping vertex 1 sends finish (the whole list, a new seq); another vertex is ignored (owner 11-19: no removal by tapping)', () => {
  const { c, sent } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 4; i++) c.tap(P(i));
  c.tapVertex(2);
  assert.equal(sent.filter((m) => m.kind === 'finish').length, 0, '🔴 vertex 3: nothing');
  c.tapVertex(0);
  const f = sent[sent.length - 1];
  assert.deepEqual([f.kind, f.seq, f.points.length], ['finish', 5, 4], '🔴 finish, seq 5, the final list (vertex 1 not repeated)');
});

test('Z2 child (r3): the finish retries with the SAME seq every 500 ms until an ack names it; accepted ⇒ inert (no more taps)', () => {
  const { c, sent, runTimers } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.tapVertex(0);
  runTimers(); runTimers();
  assert.deepEqual(sent.filter((m) => m.kind === 'finish').map((m) => m.seq), [4, 4, 4], '🔴 retries carry the same seq');
  c.onRender(DRAW({ points: [P(0), P(1), P(2)], seq: 4, ack: { session: S1, seq: 4, outcome: 'accepted' } }));
  const n = sent.length;
  runTimers(); c.tap(P(9)); c.tapVertex(0);
  assert.equal(sent.length, n, '🔴 settled: no retry, the closed shape takes no taps');
});

test('Z2 child (r3): rejected ⇒ the retry stops and the session stays editable; the next finish has a higher seq', () => {
  const { c, sent, runTimers } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.tapVertex(0);
  c.onRender(DRAW({ points: [P(0), P(1), P(2)], seq: 4, ack: { session: S1, seq: 4, outcome: 'rejected', line: 'self_cross' } }));
  runTimers();
  assert.equal(sent.filter((m) => m.kind === 'finish').length, 1, 'no retry after the verdict');
  c.tap(P(5));
  assert.equal(sent[sent.length - 1].kind, 'draft_points', '🔴 still editable');
  c.tapVertex(0);
  assert.equal(sent[sent.length - 1].seq, 6, 'a higher seq');
});

test('Z2 child (r4): every ack lost through the WHOLE budget ⇒ UNCONFIRMED — never a new seq, never a new finish of its own, inert', () => {
  const { c, sent, runTimers } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.tapVertex(0);
  for (let i = 0; i < 15; i++) runTimers();
  const fins = sent.filter((m) => m.kind === 'finish');
  assert.equal(fins.length, 10, '🔴 the budget: 10 tries');
  assert.ok(fins.every((m) => m.seq === 4), 'all the same (session, seq)');
  c.tap(P(7)); c.tapVertex(0);
  assert.equal(sent.filter((m) => m.kind === 'finish').length, 10, '🔴 inert: no taps, no new finish');
});

test('Z2 child (r4): UNCONFIRMED reconciles from the parent\'s renders — same session without the ack ⇒ ONE resend (same seq); the ack settles; null settles as ended', () => {
  const { c, sent, runTimers } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.tapVertex(0);
  for (let i = 0; i < 15; i++) runTimers();
  const n = sent.length;
  c.onRender(DRAW({ points: [P(0), P(1), P(2)], seq: 3 }));
  assert.equal(sent.length, n + 1, '🔴 the parent never got it: one more, same seq');
  assert.deepEqual([sent[n].kind, sent[n].seq], ['finish', 4]);
  c.onRender(DRAW({ points: [P(0), P(1), P(2)], seq: 4, ack: { session: S1, seq: 4, outcome: 'accepted' } }));
  for (let i = 0; i < 3; i++) runTimers();
  assert.equal(sent.length, n + 1, 'settled: nothing more');
  const k = ctl();
  k.c.onRender(DRAW()); for (let i = 0; i < 3; i++) k.c.tap(P(i)); k.c.tapVertex(0);
  for (let i = 0; i < 15; i++) k.runTimers();
  k.c.onRender(null);
  assert.equal(k.c.view(), null, '🔴 settled as ended: nothing left to paint');
  const m = k.sent.length; k.runTimers(); k.c.tap(P(1));
  assert.equal(k.sent.length, m, '🔴 the parent moved on (no session): settled as ended, nothing sent');
});

test('Z2 child: the parent\'s «Terminar» (request: finish) ⇒ ONE finish with the local list', () => {
  const { c, sent } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.onRender(DRAW({ points: [P(0), P(1), P(2)], seq: 3, request: 'finish' }));
  c.onRender(DRAW({ points: [P(0), P(1), P(2)], seq: 3, request: 'finish' }));
  assert.deepEqual(sent.filter((m) => m.kind === 'finish').map((m) => [m.seq, m.points.length]), [[4, 3]], '🔴 one finish for the request');
});

test('Z2 child: EDITING — a handle drag sends ONLY at its end, as a finish (the parent commits on it); a tap inside a drawn zone asks to edit it', () => {
  const { c, sent } = ctl();
  c.tapZone('z_aaaaaaaa');
  assert.deepEqual(sent, [{ kind: 'edit_request', zone: 'z_aaaaaaaa' }], '🔴 no session: the tap asks');
  c.onRender(DRAW({ zone: 'z_aaaaaaaa', points: [P(0), P(1), P(2), P(3)] }));
  c.tapZone('z_bbbbbbbb');
  assert.equal(sent.length, 1, 'a session open: no other request');
  c.tap(P(9));
  assert.equal(sent.length, 1, 'an EDITING session takes no new points by tapping');
  c.dragEnd(2, P(7));
  const f = sent[sent.length - 1];
  assert.deepEqual([f.kind, f.seq, f.points[2]], ['finish', 1, P(7)], '🔴 the drag end is the finish, with the moved vertex');
});

test('Z2 child: a DRAWING handle drag sends draft_points at its end (never on every move)', () => {
  const { c, sent } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.dragEnd(1, P(8));
  const d = sent[sent.length - 1];
  assert.deepEqual([d.kind, d.seq, d.points[1]], ['draft_points', 4, P(8)], '🔴 one whole list at the drag end');
});

test('Z2 child: a new session (or none) drops the old one\'s retry — never a finish for an ended session', () => {
  const { c, sent, runTimers } = ctl();
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.tapVertex(0);
  c.onRender(DRAW({ session: S2 }));
  const n = sent.length; runTimers();
  assert.equal(sent.length, n, '🔴 the old session\'s retry stopped');
});

test('Z2 child: a v3 render is v2 + zones + drawing — the limit ring and the map type are kept (never read as v1)', async () => {
  const z = [{ id: 'z_aaaaaaaa', name: 'Sector A', points: [P(0), P(1), { lat: 15.503, lng: -88.031 }] }];
  const v3 = MP.renderMessage({ mount: M, view: 'reset', theme: 'light', hub: HUB, name: 'La Musa', others: [], bands: [{ km: 3, fee: 4000, ok: true, out: false }],
    mapType: 'hybrid', limit: { km: 3, capped: false, name: 'La Musa' }, zones: z, drawing: null });
  const m = overlayModel(v3, flat(640), 1);
  assert.ok(m.rings.some((r) => r.cls === 'ring rlim'), '🔴 the limit ring stays');
  assert.equal(m.zones.length, 1, 'the zone is drawn'); assert.equal(m.zones[0].label.text, 'Sector A'); assert.ok(m.zones[0].d.endsWith('Z'));
  assert.equal(m.draw, null, 'no session');
  const E = fakeEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.fromParent(v3); await tick();
  assert.equal(E.maps.made[0].opts.mapTypeId, 'hybrid', '🔴 the map type of a v3 render');
});

test('Z2 child: the session is painted from the child\'s own list — open: the dashed edges + the dotted close preview + numbered handles (1 in green); the edited zone is drawn as the session', () => {
  const z = [{ id: 'z_aaaaaaaa', name: 'Sector A', points: [P(0), P(1), { lat: 15.503, lng: -88.031 }] }];
  const v3 = MP.renderMessage({ mount: M, view: 'keep', theme: 'light', hub: HUB, name: 'La Musa', others: [], bands: [], mapType: 'roadmap', limit: null, zones: z, drawing: null });
  const open = overlayModel(v3, flat(640), 1, { session: S1, zone: null, points: [P(0), P(1), P(2)], closed: false, editable: true });
  assert.ok(open.draw && !open.draw.d.endsWith('Z') && open.draw.closing, '🔴 open: a polyline and the close preview');
  assert.deepEqual(open.draw.vtx.map((v) => [v.n, v.first]), [[1, true], [2, false], [3, false]]);
  const editing = overlayModel(v3, flat(640), 1, { session: S1, zone: 'z_aaaaaaaa', points: z[0].points, closed: false, editable: true });
  assert.equal(editing.zones.length, 0, 'the edited zone is drawn once — as the session');
  assert.ok(editing.draw.d.endsWith('Z') && editing.draw.closing === null, 'a zone being edited is closed');
});

// ── Codex #204 (child) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// P2-1: the REAL handlers — mousedown → mouseup → click without movement on vertex 1 is a CLICK (finish), not a drag; a real drag
// (movement past the threshold) is a drag. A fake projection (1 px per 1e-5°) and a DOM stub that paints.
function liveEnv() {
  const E = fakeEnv();
  const stub = () => ({ ownerDocument: E.doc, style: { setProperty() {} }, setAttribute() {}, append() {}, replaceChildren() {}, remove() {}, textContent: '' });
  E.doc.createElementNS = stub;
  const num = (v) => (typeof v === 'function' ? v() : v);
  E.maps.OverlayView.prototype.getProjection = () => ({ fromLatLngToDivPixel: (ll) => ({ x: num(ll.lng) * 1e5, y: -num(ll.lat) * 1e5 }) });
  const ev = (q) => ({ latLng: { lat: () => q.lat, lng: () => q.lng } });
  const fire = (t, q) => { for (const f of [...(E.maps.made[0].ls[t] || [])]) f(q ? ev(q) : undefined); };
  const kinds = () => E.parent.posted.map(([m]) => m.kind);
  return { E, fire, kinds };
}
const v3With = (drawing) => MP.renderMessage({ mount: M, view: 'keep', theme: 'light', hub: HUB, name: 'La Musa', others: [], bands: [], mapType: 'roadmap', limit: null, zones: [], drawing });
test('#204-P2 child: an unmoved press on vertex 1 (mousedown → mouseup → click) is a CLICK — the finish, never a drag', async () => {
  const { E, fire, kinds } = liveEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.fromParent(v3With(DRAW())); await tick();
  for (const q of [P(0), P(1), P(2)]) fire('click', q);
  assert.deepEqual(kinds().filter((k) => k === 'draft_points').length, 3, 'premise: three taps through the real click handler');
  const jitter = { lat: P(0).lat + 0.000001, lng: P(0).lng };   // 0.1 px: a hand's tremor, far under the drag threshold
  fire('mousedown', P(0)); fire('mousemove', jitter); fire('mouseup', jitter); fire('click', P(0));
  assert.equal(kinds()[kinds().length - 1], 'finish', '🔴 the click on vertex 1 closes the shape (a tremor is not a drag)');
});
test('#204-P2b child (EDITING): an unmoved click on a vertex is nothing; a REAL drag (past the threshold) sends the finish at its end', async () => {
  const { E, fire, kinds } = liveEnv();
  boot({ win: E.win, doc: E.doc, loadMaps: E.loadMaps }); await tick();
  E.fromParent(v3With(DRAW({ zone: 'z_aaaaaaaa', points: [P(0), P(1), P(2), P(3)] }))); await tick();
  const n = kinds().length;
  fire('mousedown', P(1)); fire('mouseup', P(1)); fire('click', P(1));
  assert.equal(kinds().length, n, '🔴 an unmoved click on a handle is not an edit');
  const far = { lat: P(1).lat + 0.002, lng: P(1).lng };
  fire('mousedown', P(1)); fire('mousemove', far); fire('mouseup', far); fire('click', far);
  const last = E.parent.posted[E.parent.posted.length - 1][0];
  assert.deepEqual([last.kind, last.points[1]], ['finish', far], '🔴 the drag end is the finish, with the moved vertex');
  assert.equal(kinds().filter((k) => k === 'finish').length, 1, 'and the click after the drag adds nothing');
});

// P3-1: UNCONFIRMED (and any non-editable session) shows NO handles and no close preview; the exhaustion itself repaints
test('#204-P3 child: retries exhausted ⇒ the view says unconfirmed, the overlay draws no handles, and the change is announced (repaint)', () => {
  let changes = 0;
  const sent = [], timers = [];
  const c = drawController({ send: (kind, body) => sent.push({ kind, ...body }), schedule: (f) => { timers.push(f); return timers.length; }, cancel: () => {}, onChange: () => { changes += 1; } });
  c.onRender(DRAW());
  for (let i = 0; i < 3; i++) c.tap(P(i));
  c.tapVertex(0);
  const before = changes;
  for (let i = 0; i < 15; i++) { const t = timers.splice(0); for (const f of t) f(); }
  assert.equal(c.view().unconfirmed, true, 'the presentation state is exposed');
  assert.ok(changes > before, '🔴 the exhaustion asks for a repaint');
  const v3 = MP.renderMessage({ mount: M, view: 'keep', theme: 'light', hub: HUB, name: 'La Musa', others: [], bands: [], mapType: 'roadmap', limit: null, zones: [], drawing: null });
  const m = overlayModel(v3, flat(640), 1, c.view());
  assert.deepEqual([m.draw.vtx.length, m.draw.closing], [0, null], '🔴 no handles, no close preview');
});

// ── Z2 fix (a), PLAN-portal-zones-z2-fixes-r0 route 1 (advisor 11-20): a press on a HANDLE switches the map's own panning off AT ONCE (Google
// starts its pan on the first move, so a switch after 4 px of mousemove never came — the real-browser trace); panning comes back on EVERY end
// path; a press off a handle never touches it; #204's click-vs-drag threshold unchanged
function panEnv() {
  const env = liveEnv();
  const wl = {};
  const add = env.E.win.addEventListener.bind(env.E.win);
  env.E.win.addEventListener = (t, f, o) => { (wl[t] = wl[t] || []).push(f); add(t, f, o); };
  const fireWin = (t) => { for (const f of [...(wl[t] || [])]) f({ type: t }); };
  const panOf = () => { const opts = env.E.maps.made[0].calls.filter(([k]) => k === 'options').map(([, o]) => o).filter((o) => 'gestureHandling' in o); return opts.length ? opts[opts.length - 1].gestureHandling : 'cooperative'; };
  return { ...env, fireWin, panOf };
}
async function editing(env) {
  boot({ win: env.E.win, doc: env.E.doc, loadMaps: env.E.loadMaps }); await tick();
  env.E.fromParent(v3With(DRAW({ zone: 'z_aaaaaaaa', points: [P(0), P(1), P(2), P(3)] }))); await tick();
}
test('Z2 fix (a): a press on a handle switches the map\'s panning off BEFORE any move; a press off a handle never does', async () => {
  const env = panEnv(); await editing(env);
  env.fire('mousedown', { lat: 15.6, lng: -88.1 });
  assert.equal(env.panOf(), 'cooperative', 'a press off every handle leaves the map\'s own pan alone');
  env.fire('mouseup', { lat: 15.6, lng: -88.1 });
  env.fire('mousedown', P(1));
  assert.equal(env.panOf(), 'none', '🔴 the press on a handle stops Google\'s pan at once (mouse AND touch: gestureHandling)');
});
for (const [path, end] of [
  ['the release over the map', (env) => env.fire('mouseup', P(1))],
  ['a release OFF the map (pointerup on the window)', (env) => env.fireWin('pointerup')],
  ['pointercancel', (env) => env.fireWin('pointercancel')],
  ['touchend', (env) => env.fireWin('touchend')],
  ['touchcancel', (env) => env.fireWin('touchcancel')],
  ['the window losing focus', (env) => env.fireWin('blur')],
  ['the session ending mid-press (the parent renders no session)', (env) => env.E.fromParent(v3With(null))],
]) {
  test(`Z2 fix (a): panning comes back on EVERY end path — ${path}`, async () => {
    const env = panEnv(); await editing(env);
    env.fire('mousedown', P(1));
    assert.equal(env.panOf(), 'none', 'premise: the press holds the pan');
    end(env); await tick();
    assert.equal(env.panOf(), 'cooperative', `🔴 the map is never left unpannable (${path})`);
  });
}
test('Z2 fix (a): a drag released OFF the map still commits (the window\'s pointerup ends it with the last moved point)', async () => {
  const env = panEnv(); await editing(env);
  const far = { lat: P(1).lat + 0.002, lng: P(1).lng };
  env.fire('mousedown', P(1)); env.fire('mousemove', far); env.fireWin('pointerup'); await tick();
  const last = env.E.parent.posted[env.E.parent.posted.length - 1][0];
  assert.deepEqual([last.kind, last.points[1]], ['finish', far], '🔴 the drag end is the finish');
  assert.equal(env.panOf(), 'cooperative');
  env.fire('mouseup', far);
  assert.equal(env.kinds().filter((k) => k === 'finish').length, 1, 'the map\'s own late mouseup adds nothing (one end per press)');
});
test('Z2 fix (a): a cancelled press commits nothing (pointercancel mid-drag: the shape stays)', async () => {
  const env = panEnv(); await editing(env);
  const n = env.kinds().length;
  env.fire('mousedown', P(1)); env.fire('mousemove', { lat: P(1).lat + 0.002, lng: P(1).lng }); env.fireWin('pointercancel'); await tick();
  assert.equal(env.kinds().length, n, '🔴 nothing sent for a cancelled gesture');
});
// Codex #237 P2-1: a CANCELLED drag must not swallow the next intentional click — the click suppression belongs only to a drag that COMMITS
test('#237 a drag cancelled mid-press (pointercancel / blur) leaves the next click on vertex 1 working — it closes the shape', async () => {
  for (const cancel of ['pointercancel', 'blur']) {
    const env = panEnv();
    boot({ win: env.E.win, doc: env.E.doc, loadMaps: env.E.loadMaps }); await tick();
    env.E.fromParent(v3With(DRAW())); await tick();
    for (const q of [P(0), P(1), P(2)]) env.fire('click', q);
    env.fire('mousedown', P(1)); env.fire('mousemove', { lat: P(1).lat + 0.002, lng: P(1).lng }); env.fireWin(cancel); await tick();
    env.fire('mousedown', P(0)); env.fire('mouseup', P(0)); env.fire('click', P(0));
    assert.equal(env.kinds()[env.kinds().length - 1], 'finish', `🔴 the first click on vertex 1 after a ${cancel} acts`);
  }
});
test('#237 after a CANCELLED drag the next tap OFF the handles adds its point (the commit-only rule — this press never reaches the reset)', async () => {
  const env = panEnv();
  boot({ win: env.E.win, doc: env.E.doc, loadMaps: env.E.loadMaps }); await tick();
  env.E.fromParent(v3With(DRAW())); await tick();
  for (const q of [P(0), P(1), P(2)]) env.fire('click', q);
  env.fire('mousedown', P(1)); env.fire('mousemove', { lat: P(1).lat + 0.002, lng: P(1).lng }); env.fireWin('pointercancel'); await tick();
  const n = env.kinds().filter((k) => k === 'draft_points').length;
  env.fire('click', { lat: 15.51, lng: -88.02 });
  assert.equal(env.kinds().filter((k) => k === 'draft_points').length, n + 1, '🔴 the tap after a cancelled drag adds its point');
});
test('#237 a drag COMMITTED off the map (no click follows its release) does not swallow the next click on a handle (the new-press reset)', async () => {
  const env = panEnv();
  boot({ win: env.E.win, doc: env.E.doc, loadMaps: env.E.loadMaps }); await tick();
  env.E.fromParent(v3With(DRAW())); await tick();
  for (const q of [P(0), P(1), P(2)]) env.fire('click', q);
  env.fire('mousedown', P(1)); env.fire('mousemove', { lat: P(1).lat + 0.002, lng: P(1).lng }); env.fireWin('pointerup'); await tick();
  env.fire('mousedown', P(0)); env.fire('mouseup', P(0)); env.fire('click', P(0));
  assert.equal(env.kinds()[env.kinds().length - 1], 'finish', '🔴 the first click on vertex 1 after a drag released off the map acts');
});
