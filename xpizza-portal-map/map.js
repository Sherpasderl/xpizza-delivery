// «Envío» step 1 (PLAN-portal-envio-step1 r2 §1, §4; build conditions C2, C3) — the MAP SITE's one script
// (https://sherpa-portal-map.netlify.app/map.html, framed by the portal; its own origin, its own CSP; no Firebase, no auth, no
// fetch of ours). It draws what the portal tells it and reports listening / ready / failed — nothing it sends can authorize anything.
//
//   • Startup (C2): install the listener, THEN send `listening`; draw the latest `render`; send `ready` only after the Map exists
//     and its first tiles loaded. Load errors, an import rejection and gm_authFailure (the key refused) send `failed` once.
//   • Geometry: every ring vertex, the outside hole and the label anchors from envio-geometry.js (the server's 6,371,000 m sphere,
//     256 segments); drawn as ONE SVG overlay projected per vertex, styled exactly as the approved mockup (dashes, fills, pills,
//     pins) and scaled with the box (u = W / 640 px per mockup unit). Initial / reset view: 24·W/640 px per server km, the pin at
//     the mockup's (320, 270); the owner may zoom and pan after it.
import * as G from './envio-geometry.js';
import * as MP from './envio-map-protocol.js';

const MAPS_KEY = 'AIzaSyAuzSLAELV_MaK2xeXrNjS6_lhNXmD_Y0A';   // the Maps Platform browser key dispatch ships (referrer-restricted; never sent by postMessage)
const SPAN = 4000;                 // the overlay covers ±SPAN px around the hub: wide enough for the outside shade at any zoom used here
// the light base map: POIs, transit and most labels muted so the green rings read (dispatch's styles-array pattern, no Map ID)
const LIGHT = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8A8A8E' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#F3F3EF' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#F1F2EC' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#DCE8EE' }] },
];
const NS = 'http://www.w3.org/2000/svg';
const PIN_D = (x, y, u) => `M${x} ${y - 24 * u}c${-7 * u} 0 ${-12 * u} ${5 * u} ${-12 * u} ${12 * u} 0 ${9 * u} ${12 * u} ${24 * u} ${12 * u} ${24 * u}s${12 * u} ${-15 * u} ${12 * u} ${-24 * u}c0 ${-7 * u} ${-5 * u} ${-12 * u} ${-12 * u} ${-12 * u}z`;

// ── the overlay, as data (pure: tested with a fake projection) ────────────────────────────────────────────────────────────
// msg: a validated render; project({lat,lng}) → {x,y} in the overlay's own pixels; u: px per mockup unit (W / 640).
// → { rings: [{ d, cls }], outside: d | null, labels: [{ x, y, w, text, cls }], pins: [{ x, y, cls }], name: { x, y, text } | null }
export function overlayModel(msg, project, u) {
  const out = { rings: [], outside: null, labels: [], pins: [], name: null };
  if (!msg || !msg.hub) return out;
  const hub = msg.hub, c = project(hub);
  const pathOf = (km) => { const pts = G.ringPath(hub, km).map(project); return `M${pts.map((p) => `${r2(p.x)} ${r2(p.y)}`).join('L')}Z`; };
  const valid = msg.bands.filter((b) => b.ok), bad = msg.bands.filter((b) => !b.ok);
  if (valid.length) {
    const outer = valid[valid.length - 1];
    out.outside = `M${r2(c.x - SPAN)} ${r2(c.y - SPAN)}H${r2(c.x + SPAN)}V${r2(c.y + SPAN)}H${r2(c.x - SPAN)}Z${pathOf(outer.km)}`;
    for (let i = valid.length - 1; i >= 0; i--) out.rings.push({ d: pathOf(valid[i].km), cls: i === valid.length - 1 ? 'ring outer' : 'ring' });
  }
  for (const b of bad) out.rings.push({ d: pathOf(b.km), cls: 'ring bad' });
  valid.forEach((b, i) => {
    const outer = i === valid.length - 1, p = project(G.labelAnchor(hub, b.km, false));
    out.labels.push({ x: p.x, y: p.y, w: (outer ? 150 : 90) * u, cls: outer ? 'rl outer' : 'rl', text: `${b.km} km · L ${b.fee / 100}${outer ? ' · límite' : ''}` });
  });
  for (const b of bad) { const p = project(G.labelAnchor(hub, b.km, true)); out.labels.push({ x: p.x, y: p.y, w: 160 * u, cls: 'rl bad', text: `${b.km} km · fuera del límite` }); }
  for (const o of msg.others) { const p = project(o); out.pins.push({ x: p.x, y: p.y, cls: 'opin' }); }
  out.name = msg.name ? { x: c.x + 14 * u, y: c.y - 26 * u, text: msg.name } : null;
  out.hubPx = c;
  return out;
}
const r2 = (n) => Math.round(n * 100) / 100;

function paint(svg, model, u) {
  const doc = svg.ownerDocument;
  const mk = (tag, attrs, text) => { const n = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; };
  svg.style.setProperty('--u', String(u));
  const kids = [];
  if (model.outside) kids.push(mk('path', { class: 'outside', d: model.outside }));
  for (const r of model.rings) kids.push(mk('path', { class: r.cls, d: r.d }));
  for (const l of model.labels) {
    const g = mk('g', { class: l.cls });
    g.append(mk('rect', { x: r2(l.x - l.w / 2), y: r2(l.y - 11 * u), width: r2(l.w), height: r2(22 * u), rx: r2(6 * u) }), mk('text', { x: r2(l.x), y: r2(l.y + 4 * u) }, l.text));
    kids.push(g);
  }
  for (const p of model.pins) kids.push(mk('circle', { class: p.cls, cx: r2(p.x), cy: r2(p.y), r: r2(4.5 * u) }));
  if (model.hubPx) {
    const { x, y } = model.hubPx;
    kids.push(mk('path', { class: 'pin', d: PIN_D(x, y, u) }), mk('circle', { class: 'pindot', cx: r2(x), cy: r2(y - 12 * u), r: r2(4 * u) }));
  }
  if (model.name) kids.push(mk('text', { class: 'pl', x: r2(model.name.x), y: r2(model.name.y) }, model.name.text));
  svg.replaceChildren(...kids);
}

// ── Maps JS: Google's bootstrap loader, as dispatch loads it (same key) ────────────────────────────────────────────────────
function defaultLoad(win, doc) {
  /* eslint-disable */
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = doc, b = win; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a); })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)); })({ key: MAPS_KEY, v: "weekly" });
  /* eslint-enable */
  return win.google.maps.importLibrary('maps').then(() => win.google.maps);
}

// ── the frame's life ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function boot({ win = window, doc = document, loadMaps = defaultLoad } = {}) {
  const mount = MP.mountFromHash(win.location.hash);
  if (!mount || !win.parent || win.parent === win) return { idle: true };   // opened directly: an empty box, nothing else
  const parent = win.parent;
  const box = doc.getElementById('map');
  const send = (kind, cause) => { try { parent.postMessage(MP.childMessage(kind, mount, cause), MP.PORTAL_ORIGIN); } catch (_) { /* the portal is gone */ } };
  const st = { latest: null, maps: null, map: null, layer: null, failed: false, ready: false, userMoved: false, programmatic: false, width: 0 };
  const fail = (cause) => { if (st.failed || st.ready) return; st.failed = true; send('failed', cause); };

  win.addEventListener('message', (ev) => {
    const m = MP.acceptFromParent(ev, { parentWindow: parent, mount });
    if (!m) return;
    st.latest = m;
    apply();
  });
  win.gm_authFailure = () => fail('auth_failure');
  send('listening');   // after the listener exists (C2)

  Promise.resolve().then(() => loadMaps(win, doc)).then((maps) => { st.maps = maps; apply(); },
    (e) => fail(e && /could not load/.test(String(e.message)) ? 'load_error' : 'import_rejected'));

  const W = () => Math.max(1, box.clientWidth || 640);
  function resetView() {
    const hub = st.latest.hub;
    st.programmatic = true;
    st.map.setCenter(G.cameraCenter(hub));
    st.map.setZoom(G.zoomFor(W(), hub.lat));
    st.programmatic = false;
    st.userMoved = false;
    st.width = W();
  }
  function apply() {
    if (st.failed || !st.maps || !st.latest || !st.latest.hub) { if (st.layer) st.layer.setModel(null); return; }
    if (!st.map) { build(); return; }
    if (st.latest.view === 'reset') resetView();
    st.layer.setModel(st.latest);
  }
  function build() {
    const maps = st.maps, hub = st.latest.hub;
    st.map = new maps.Map(box, {
      center: G.cameraCenter(hub), zoom: G.zoomFor(W(), hub.lat), isFractionalZoomEnabled: true,
      disableDefaultUI: true, zoomControl: true, gestureHandling: 'cooperative', clickableIcons: false, keyboardShortcuts: false, styles: LIGHT,
    });
    st.width = W();
    st.map.addListener('dragstart', () => { st.userMoved = true; });
    st.map.addListener('zoom_changed', () => { if (!st.programmatic) st.userMoved = true; });
    const once = st.map.addListener('tilesloaded', () => { if (once && once.remove) once.remove(); if (st.failed || st.ready) return; st.ready = true; send('ready'); });
    class RingLayer extends maps.OverlayView {
      constructor() { super(); this.model = null; this.svg = doc.createElementNS(NS, 'svg'); this.svg.setAttribute('class', 'rings'); }
      setModel(m) { this.model = m; this.draw(); }
      onAdd() { this.getPanes().overlayLayer.append(this.svg); }
      onRemove() { this.svg.remove(); }
      draw() {
        const proj = this.getProjection && this.getProjection();
        if (!proj || !this.model || !this.model.hub) { this.svg.replaceChildren(); return; }
        const h = proj.fromLatLngToDivPixel(new maps.LatLng(this.model.hub.lat, this.model.hub.lng));
        const left = h.x - SPAN, top = h.y - SPAN;
        Object.assign(this.svg.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${2 * SPAN}px`, height: `${2 * SPAN}px`, overflow: 'visible' });
        const project = (p) => { const q = proj.fromLatLngToDivPixel(new maps.LatLng(p.lat, p.lng)); return { x: q.x - left, y: q.y - top }; };
        const u = W() / G.MOCK.w;
        paint(this.svg, overlayModel(this.model, project, u), u);
      }
    }
    st.layer = new RingLayer();
    st.layer.setMap(st.map);
    st.layer.setModel(st.latest);
    if (typeof win.ResizeObserver === 'function') {
      new win.ResizeObserver(() => { if (!st.map || W() === st.width) return; if (!st.userMoved) resetView(); else st.width = W(); st.layer.draw(); }).observe(box);
    }
  }
  return { idle: false, state: st };
}

if (typeof window !== 'undefined' && !window.__envioMapTest) boot();
