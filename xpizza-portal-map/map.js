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
// ENVÍO v3 A2 (map-look delta r1): «Simple» = today's LIGHT styles on roadmap; «Mapa» = Google's roadmap; «Satélite» = hybrid. A v1
// render (an older portal) is drawn «Simple», as step 1 drew it.
const typeOf = (m) => (m && m.v >= 2 ? m.mapType : 'simple');   // v3 (Z2) is v2 + zones + drawing
const styleFor = (t) => (t === 'hybrid' ? { styles: null, mapTypeId: 'hybrid' } : { styles: t === 'simple' ? LIGHT : null, mapTypeId: 'roadmap' });
const NS = 'http://www.w3.org/2000/svg';
const PIN_D = (x, y, u) => `M${x} ${y - 24 * u}c${-7 * u} 0 ${-12 * u} ${5 * u} ${-12 * u} ${12 * u} 0 ${9 * u} ${12 * u} ${24 * u} ${12 * u} ${24 * u}s${12 * u} ${-15 * u} ${12 * u} ${-24 * u}c0 ${-7 * u} ${-5 * u} ${-12 * u} ${-12 * u} ${-12 * u}z`;

// ── the overlay, as data (pure: tested with a fake projection) ────────────────────────────────────────────────────────────
// msg: a validated render; project({lat,lng}) → {x,y} in the overlay's own pixels; u: px per mockup unit (W / 640).
// → { rings: [{ d, cls }], outside: d | null, labels: [{ x, y, w, text, cls }], pins: [{ x, y, cls }], name: { x, y, text } | null,
//     zones: [{ d, label: { x, y, text } }], draw: null | { d, closing: d | null, vtx: [{ x, y, n, first }] } }
// live (Z2): the drawing session as the child holds it (drawController.view()) — drawn over the zones, the edited zone in its place
export function overlayModel(msg, project, u, live = null) {
  const out = { rings: [], outside: null, labels: [], pins: [], name: null };
  if (!msg || !msg.hub) return out;
  if (msg.v === 3 || live) { out.zones = []; out.draw = null; }   // Z2 only: a v1 / v2 model is step 1's, unchanged
  const poly = (ps, close) => `M${ps.map(project).map((p) => `${r2(p.x)} ${r2(p.y)}`).join('L')}${close ? 'Z' : ''}`;
  if (msg.v === 3) {
    for (const z of msg.zones) {
      if (live && live.zone === z.id) continue;
      const c0 = project({ lat: z.points.reduce((a, q) => a + q.lat, 0) / z.points.length, lng: z.points.reduce((a, q) => a + q.lng, 0) / z.points.length });
      out.zones.push({ d: poly(z.points, true), label: { x: c0.x, y: c0.y, w: Math.max(60, z.name.length * 7 + 18) * u, text: z.name } });
    }
  }
  if (live && live.points.length) {
    const closed = live.closed || live.zone !== null;
    // Codex #204 P3-1: handles and the close preview only while the session takes edits (never UNCONFIRMED, closed or waiting on a finish)
    const handles = live.editable === true;
    out.draw = { d: poly(live.points, closed), closing: handles && !closed && live.points.length >= 2 ? poly([live.points[live.points.length - 1], live.points[0]], false) : null,
      vtx: handles ? live.points.map((q, i) => { const p = project(q); return { x: p.x, y: p.y, n: i + 1, first: i === 0 }; }) : [] };
  }
  const hub = msg.hub, c = project(hub);
  const pathOf = (km) => { const pts = G.ringPath(hub, km).map(project); return `M${pts.map((p) => `${r2(p.x)} ${r2(p.y)}`).join('L')}Z`; };
  const valid = msg.bands.filter((b) => b.ok), bad = msg.bands.filter((b) => !b.ok);
  // ENVÍO v3 A2 / A4 (protocol v2): the restaurant's own limit — the SOLID ink ring at limit.km, the shade starting there; the fee
  // rings stay dashed and a band beyond it (the portal's `out`) is greyed. No limit (v1, or none sent): step 1's drawing, unchanged.
  const lim = msg.v >= 2 && msg.limit ? msg.limit : null;
  const beyondOf = (b) => !!(lim && b.out === true);
  if (valid.length) {
    const last = valid.length - 1;
    out.outside = `M${r2(c.x - SPAN)} ${r2(c.y - SPAN)}H${r2(c.x + SPAN)}V${r2(c.y + SPAN)}H${r2(c.x - SPAN)}Z${pathOf(lim ? lim.km : valid[last].km)}`;
    for (let i = last; i >= 0; i--) out.rings.push({ d: pathOf(valid[i].km), cls: `ring${!lim && i === last ? ' outer' : ''}${beyondOf(valid[i]) ? ' beyond' : ''}` });
    if (lim) out.rings.push({ d: pathOf(lim.km), cls: 'ring rlim' });
  }
  for (const b of bad) out.rings.push({ d: pathOf(b.km), cls: 'ring bad' });
  valid.forEach((b, i) => {
    const outer = !lim && i === valid.length - 1, beyond = beyondOf(b), p = project(G.labelAnchor(hub, b.km, false));
    out.labels.push({ x: p.x, y: p.y, w: (outer ? 150 : beyond ? 190 : 90) * u, cls: `rl${outer ? ' outer' : ''}${beyond ? ' beyond' : ''}`,
      text: `${b.km} km · L ${b.fee / 100}${outer ? ' · límite' : beyond ? ' · fuera de su alcance' : ''}` });
  });
  for (const b of bad) { const p = project(G.labelAnchor(hub, b.km, true)); out.labels.push({ x: p.x, y: p.y, w: 160 * u, cls: 'rl bad', text: `${b.km} km · fuera del límite` }); }
  if (lim && valid.length) {   // on the limit ring, due east: clear of the NE band labels and the SW refused ones
    const p = project(G.destination(hub, 90, lim.km * 1000));
    out.labels.push({ x: p.x, y: p.y, w: (lim.capped ? 250 : 170) * u, cls: 'rl lim', text: `Límite de ${lim.name} · ${lim.km} km${lim.capped ? ' · tope de la tabla' : ''}` });
  }
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
  // Z2 — the no-delivery zones (hatched, outlined, labelled) and the drawing session (dashed ink edges, the dotted close preview, the
  // numbered handles, vertex 1 in green) — the approved v2 page's .zone / .zl / .draw-edge / .draw-close / .vtx
  for (const z of model.zones || []) {
    kids.push(mk('path', { class: 'zone', d: z.d }));
    const g = mk('g', { class: 'zl' });
    g.append(mk('rect', { x: r2(z.label.x - z.label.w / 2), y: r2(z.label.y - 10 * u), width: r2(z.label.w), height: r2(20 * u), rx: r2(6 * u) }), mk('text', { x: r2(z.label.x), y: r2(z.label.y + 4 * u) }, z.label.text));
    kids.push(g);
  }
  if (model.draw) {
    kids.push(mk('path', { class: 'draw-edge', d: model.draw.d }));
    if (model.draw.closing) kids.push(mk('path', { class: 'draw-close', d: model.draw.closing }));
    for (const v of model.draw.vtx) kids.push(mk('circle', { class: `vtx${v.first ? ' first' : ''}`, cx: r2(v.x), cy: r2(v.y), r: r2(6 * u) }), mk('text', { class: 'vtx-n', x: r2(v.x), y: r2(v.y - 9 * u) }, String(v.n)));
  }
  svg.replaceChildren(...kids);
}

// ── Z2 — drawing (PLAN-portal-zones-protocol-v3 r1 §2, r2 P2-3 / P2-6, r3 #181-6, r4 #185) ─────────────────────────────────────────────
// The child only PROPOSES: whole point lists with a per-session seq (draft_points), a finish, an edit_request. The PARENT mints sessions,
// judges every shape and is authoritative; this state machine follows its renders. A finish retries with the SAME (session, seq) every
// RETRY_MS until a render's ack names it (accepted ⇒ inert; rejected ⇒ editable again; ended / no session ⇒ dropped). After TRIES with no
// ack the session is UNCONFIRMED: inert, never a new seq, never a new finish of its own; each later render either settles it (its ack, a
// null drawing, another session) or — the same session still open with no ack — gets that finish ONCE more (same seq).
export const DRAW_LIMITS = Object.freeze({ points: 24, RETRY_MS: 500, TRIES: 10 });
const samePt = (a, b) => !!a && !!b && a.lat === b.lat && a.lng === b.lng;
const copyPts = (ps) => ps.map((q) => ({ lat: q.lat, lng: q.lng }));
export function drawController({ send, schedule = setTimeout, cancel = clearTimeout, onChange = () => {} }) {
  let s = null;   // { session, zone, points, seq, closed, finish: null | { seq, points, tries, timer }, unconfirmed }
  const editable = () => !!s && !s.closed && !s.finish && !s.unconfirmed;
  const post = (kind) => send(kind, { session: s.session, seq: s.seq, points: copyPts(s.points) });
  const postFinish = () => send('finish', { session: s.session, seq: s.finish.seq, points: copyPts(s.finish.points) });
  function stop() { if (s && s.finish && s.finish.timer) { cancel(s.finish.timer); s.finish.timer = null; } }
  function retry() {
    if (!s || !s.finish) return;
    s.finish.timer = null;
    if (s.finish.tries >= DRAW_LIMITS.TRIES) { s.unconfirmed = true; onChange(); return; }   // Codex #204 P3-1: inert now — repaint (no handles)
    s.finish.tries += 1; postFinish();
    s.finish.timer = schedule(retry, DRAW_LIMITS.RETRY_MS);
  }
  function finish() {
    if (!editable()) return;
    s.seq += 1;
    s.finish = { seq: s.seq, points: copyPts(s.points), tries: 1, timer: null };
    postFinish();
    s.finish.timer = schedule(retry, DRAW_LIMITS.RETRY_MS);
  }
  function settle(outcome) {
    stop(); s.finish = null; s.unconfirmed = false;
    if (outcome === 'accepted') s.closed = true;
    else if (outcome === 'ended') s = null;
  }
  return {
    view: () => (s ? { session: s.session, zone: s.zone, points: copyPts(s.points), closed: s.closed, unconfirmed: s.unconfirmed, editable: editable() } : null),
    onRender(d) {
      if (!d || (s && d.session !== s.session)) { stop(); s = null; }   // no session, or another one: the old one is over (ended)
      if (!d) return;
      if (!s) s = { session: d.session, zone: d.zone, points: copyPts(d.points), seq: d.seq, closed: false, finish: null, unconfirmed: false };
      else if (d.seq > s.seq) { s.points = copyPts(d.points); s.seq = d.seq; }   // an older echo never replaces newer local points
      const a = d.ack;
      if (s.finish && a && a.session === s.session && a.seq === s.finish.seq) settle(a.outcome);
      else if (s.unconfirmed) postFinish();   // r4: the same session, still no ack for it ⇒ ONCE more per render, the same seq
      if (d.request === 'finish' && editable()) finish();
    },
    // a tap on the map (DRAWING only): a new vertex — never a repeat of the last one, never a 25th
    tap(pt) {
      if (!editable() || s.zone !== null || s.points.length >= DRAW_LIMITS.points || samePt(s.points[s.points.length - 1], pt)) return;
      s.points.push({ lat: pt.lat, lng: pt.lng }); s.seq += 1; post('draft_points');
    },
    // a tap on vertex 1 closes (DRAWING); a tap on any other vertex is ignored (owner 11-19: no removal by tapping)
    tapVertex(i) { if (editable() && s.zone === null && i === 0 && s.points.length) finish(); },
    // a handle's drag END (never each move): DRAWING proposes the list; EDITING's drag end IS its finish (the parent commits on it)
    dragEnd(i, pt) {
      if (!editable() || !s.points[i]) return;
      s.points[i] = { lat: pt.lat, lng: pt.lng };
      if (s.zone === null) { s.seq += 1; post('draft_points'); } else finish();
    },
    // a tap inside a drawn zone with no session open: ASK the parent to edit it (it decides)
    tapZone(id) { if (!s) send('edit_request', { zone: id }); },
  };
}

// ── Maps JS: Google's bootstrap loader, as dispatch loads it (same key) ────────────────────────────────────────────────────
function defaultLoad(win, doc) {
  /* eslint-disable */
  (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = doc, b = win; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a); })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)); })({ key: MAPS_KEY, v: "weekly", language: "es" });
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
  const st = { latest: null, maps: null, map: null, layer: null, failed: false, ready: false, userMoved: false, programmatic: false, width: 0, type: null,
    cursor: null, press: null, drag: null, justDragged: false, panHeld: false };   // Z2: the drawing cursor, a handle being dragged, the click that ends a drag
  const fail = (cause) => { if (st.failed || st.ready) return; st.failed = true; send('failed', cause); };
  // Z2: the map's v2 messages (hello, draft_points, finish, edit_request) — the exact portal origin, never '*'
  const sendMap = (kind, body) => { try { parent.postMessage(MP.mapMessage(kind, mount, body), MP.PORTAL_ORIGIN); } catch (_) { /* the portal is gone */ } };
  const BASE_GESTURE = 'cooperative';   // the map's own gestures — held to 'none' only while a handle is pressed (holdPan / endPress)
  const ctl = drawController({ send: sendMap, onChange: () => { if (st.layer) st.layer.draw(); cursor(); } });
  st.ctl = ctl;

  win.addEventListener('message', (ev) => {
    const m = MP.acceptFromParent(ev, { parentWindow: parent, mount });
    if (!m) return;
    st.latest = m;
    ctl.onRender(m.v === 3 ? m.drawing : null);   // a v1 / v2 render: no session (the parent never sent v3 to this document)
    { const v = ctl.view(); if (!v || !v.editable) endPress(false); }   // the session ended / went inert mid-press: the pan back, nothing committed
    apply();
  });
  win.gm_authFailure = () => fail('auth_failure');
  send('listening');   // after the listener exists (C2)
  sendMap('hello');    // Z2: protocol v3 offered; an older portal drops it (its exact v1 key sets)

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
    const t = typeOf(st.latest);
    if (t !== st.type) {   // a style switch: the SAME map re-styled — no new Map, no reload, the camera kept
      const o = styleFor(t);
      st.map.setOptions({ styles: o.styles }); st.map.setMapTypeId(o.mapTypeId);
      st.type = t; box.setAttribute('data-maptype', o.mapTypeId);
    }
    if (st.latest.view === 'reset') resetView();
    st.layer.setModel(st.latest);
    cursor();
  }
  // Z2: the crosshair while a new zone takes taps (frame 1b); only on a change (setOptions is not free)
  function cursor() {
    const v = ctl.view(), want = v && v.editable && v.zone === null ? 'crosshair' : null;
    if (st.map && want !== st.cursor) { st.cursor = want; st.map.setOptions({ draggableCursor: want }); }
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const ptOf = (ll) => ({ lat: r6(ll.lat()), lng: r6(ll.lng()) });
  // the vertex under a press (≤ 12 mockup px), from the overlay's projection — -1 when none
  function vertexAt(ll) {
    const v = ctl.view(), proj = st.layer && st.layer.getProjection && st.layer.getProjection();
    if (!v || !proj) return -1;
    const at = proj.fromLatLngToDivPixel(ll), u = W() / G.MOCK.w;
    return v.points.findIndex((q) => { const p = proj.fromLatLngToDivPixel(new st.maps.LatLng(q.lat, q.lng)); return Math.hypot(p.x - at.x, p.y - at.y) <= 12 * u; });
  }
  // the drawn zone under a tap (ray casting on lat / lng)
  function zoneAt(pt) {
    const zs = st.latest && st.latest.v === 3 ? st.latest.zones : [];
    const inside = (ps) => { let k = false; for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) { const a = ps[i], b = ps[j]; if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lng < ((b.lng - a.lng) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lng) k = !k; } return k; };
    const z = zs.find((x) => inside(x.points));
    return z ? z.id : null;
  }
  function wireDrawing() {
    st.map.addListener('click', (e) => {
      if (!e || !e.latLng || st.justDragged) { st.justDragged = false; return; }
      if (ctl.view()) { const i = vertexAt(e.latLng); if (i !== -1) ctl.tapVertex(i); else ctl.tap(ptOf(e.latLng)); }
      else { const z = zoneAt(ptOf(e.latLng)); if (z) ctl.tapZone(z); }
      st.layer.draw(); cursor();
    });
    // a handle drag: the map's own pointer events; the session hears only the END (r1 §5: never on every move). Codex #204 P2-1: a press
    // becomes a DRAG only once the pointer moves past DRAG_PX (mockup px) — an unmoved press is a CLICK, left to the click handler
    const DRAG_PX = 4;
    const pxOf = (ll) => { const proj = st.layer && st.layer.getProjection && st.layer.getProjection(); return proj ? proj.fromLatLngToDivPixel(ll) : null; };
    // PLAN-portal-zones-z2-fixes-r0 (a) route 1: a press on a HANDLE switches the map's own panning off AT ONCE (Google starts its pan on the
    // first move, so the old switch — after 4 px of mousemove — never came: the real-browser trace). gestureHandling covers touch as well as
    // the mouse. A press elsewhere never touches it.
    st.map.addListener('mousedown', (e) => {
      st.justDragged = false;   // Codex #237 / #238: EVERY map press starts clean — a stale suppression never swallows the next click, on a handle or not
      const v = ctl.view();
      if (!e || !e.latLng || !v || !v.editable) return;
      const i = vertexAt(e.latLng);
      if (i === -1) return;
      st.press = { i, at: pxOf(e.latLng) };
      holdPan();
    });
    st.map.addListener('mousemove', (e) => {
      if (!st.press || !e || !e.latLng) return;
      if (!st.drag) {
        const now = pxOf(e.latLng), u = W() / G.MOCK.w;
        if (!now || !st.press.at || Math.hypot(now.x - st.press.at.x, now.y - st.press.at.y) <= DRAG_PX * u) return;
        st.drag = { i: st.press.i, pt: ptOf(e.latLng) };
      }
      st.drag.pt = ptOf(e.latLng); st.layer.draw();
    });
    st.map.addListener('mouseup', () => endPress(true));
    // EVERY other end path gives the pan back (advisor 11-20): a release OFF the map or a finger lift commits the drag; a cancel or the window
    // losing focus commits nothing (the shape stays)
    for (const t of ['pointerup', 'touchend', 'mouseup']) win.addEventListener(t, () => endPress(true), true);
    for (const t of ['pointercancel', 'touchcancel', 'blur']) win.addEventListener(t, () => endPress(false), true);
  }
  // the pan, held while a handle is pressed — restored to the map's base on EVERY end (endPress, the session ending)
  function holdPan() { if (st.panHeld || !st.map) return; st.panHeld = true; st.map.setOptions({ gestureHandling: 'none' }); }
  // ONE end for a press (idempotent: the first end path wins, a later one finds nothing): the pan back; a drag committed only if `commit`
  function endPress(commit) {
    const d = st.drag;
    st.press = null; st.drag = null;
    if (st.panHeld) { st.panHeld = false; st.map.setOptions({ gestureHandling: BASE_GESTURE }); }
    if (!d) return;   // no movement: a click (the click handler decides)
    // Codex #237 P2-1: only a drag that COMMITS swallows the click its release produces; a cancelled one leaves the next click alone
    if (commit) { st.justDragged = true; ctl.dragEnd(d.i, d.pt); }
    st.layer.draw(); cursor();
  }
  function build() {
    const maps = st.maps, hub = st.latest.hub;
    st.type = typeOf(st.latest);
    const look = styleFor(st.type);
    st.map = new maps.Map(box, {
      center: G.cameraCenter(hub), zoom: G.zoomFor(W(), hub.lat), isFractionalZoomEnabled: true,
      disableDefaultUI: true, zoomControl: true, gestureHandling: BASE_GESTURE, clickableIcons: false, keyboardShortcuts: false,
      styles: look.styles, mapTypeId: look.mapTypeId,
    });
    box.setAttribute('data-maptype', look.mapTypeId);
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
        let live = ctl.view();
        if (live && st.drag) live = { ...live, points: live.points.map((q, i) => (i === st.drag.i ? st.drag.pt : q)) };   // the handle follows the pointer
        paint(this.svg, overlayModel(this.model, project, u, live), u);
      }
    }
    st.layer = new RingLayer();
    st.layer.setMap(st.map);
    st.layer.setModel(st.latest);
    wireDrawing(); cursor();
    if (typeof win.ResizeObserver === 'function') {
      new win.ResizeObserver(() => { if (!st.map || W() === st.width) return; if (!st.userMoved) resetView(); else st.width = W(); st.layer.draw(); }).observe(box);
    }
  }
  return { idle: false, state: st };
}

if (typeof window !== 'undefined' && !window.__envioMapTest) boot();
