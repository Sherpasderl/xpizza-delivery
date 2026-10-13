'use strict';
/* R3 §5a — THE GOOGLE MAPS BOUNDARY DOUBLE (dispatch desktop R2, tracker R8). The Maps JS API is an external SDK loaded
 * by a remote <script> that jsdom never fetches; the pages await it before starting. This double is a SEND-BOUNDARY-style
 * stub, disclosed as such: it draws nothing, and it RECORDS what the page hands the map that a person would read — every
 * InfoWindow's content (a reader site: dispatch's map info window) and every Marker's title / label / position — so those
 * strings are asserted like any other reader output. Routing (DirectionsService) resolves to an empty, valid result.
 */
function installGoogleMaps(win) {
  const rec = { infoWindows: [], markers: [], maps: 0 };
  class MVC { constructor() { this._l = {}; } addListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return { remove() {} }; } set(k, v) { this[k] = v; } get(k) { return this[k]; } bindTo() {} }
  class LatLng { constructor(a, b) { if (a && typeof a === 'object') { this._lat = a.lat; this._lng = a.lng; } else { this._lat = a; this._lng = b; } } lat() { return this._lat; } lng() { return this._lng; } toJSON() { return { lat: this._lat, lng: this._lng }; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Size { constructor(w, h) { this.width = w; this.height = h; } }
  class LatLngBounds { constructor() { this.pts = []; } extend(p) { this.pts.push(p); return this; } isEmpty() { return !this.pts.length; } getCenter() { return new LatLng(0, 0); } contains() { return true; } }
  class MVCArray { constructor() { this.a = []; } push(x) { this.a.push(x); return this.a.length; } clear() { this.a = []; } getArray() { return this.a; } getLength() { return this.a.length; } forEach(f) { this.a.forEach(f); } }
  class Map extends MVC { constructor(el, opts) { super(); rec.maps += 1; this.el = el; this.opts = opts; this.controls = new Proxy({}, { get: (t, k) => (t[k] || (t[k] = new MVCArray())) }); } setCenter() {} panTo() {} setZoom() {} getZoom() { return 13; } fitBounds() {} getBounds() { return new LatLngBounds(); } setOptions() {} getCenter() { return new LatLng(0, 0); } }
  class Marker extends MVC {
    constructor(opts = {}) { super(); this.opts = opts; this.map = opts.map || null; this.entry = { title: opts.title || null, label: opts.label || null, position: opts.position || null }; rec.markers.push(this.entry); }
    setMap(m) { this.map = m; this.entry.removed = !m; } setPosition(p) { this.entry.position = p; } getPosition() { const p = this.entry.position; return p instanceof LatLng ? p : new LatLng(p || {}); }
    setTitle(t) { this.entry.title = t; } setLabel(l) { this.entry.label = l; } setIcon() {} setZIndex() {} setOpacity() {} setVisible(v) { this.entry.visible = v; } getMap() { return this.map; }
  }
  class InfoWindow extends MVC {
    constructor(opts = {}) { super(); this.content = opts.content || null; this.entry = { content: null, opened: 0 }; rec.infoWindows.push(this.entry); }
    setContent(c) { this.content = c; this.entry.content = typeof c === 'string' ? c : (c && c.outerHTML) || String(c); }
    open() { this.entry.opened += 1; } close() { this.entry.closed = true; }
  }
  class Circle extends MVC { constructor(o) { super(); this.o = o; } setMap() {} setCenter() {} setRadius() {} }
  class Polyline extends MVC { constructor(o) { super(); this.o = o; } setMap() {} setPath() {} }
  class DirectionsService { route(_req, cb) { const res = { routes: [], status: 'ZERO_RESULTS' }; if (cb) { cb(res, 'ZERO_RESULTS'); return undefined; } return Promise.reject(Object.assign(new Error('ZERO_RESULTS'), { code: 'ZERO_RESULTS' })); } }
  class DirectionsRenderer extends MVC { setMap() {} setDirections() {} setOptions() {} }
  class OverlayView extends MVC { setMap() {} getPanes() { return { overlayLayer: win.document.createElement('div'), floatPane: win.document.createElement('div'), overlayMouseTarget: win.document.createElement('div') }; } getProjection() { return { fromLatLngToDivPixel: () => ({ x: 0, y: 0 }) }; } }
  // P1: the order form's reverse geocode — deterministic (a scenario sets rec.geocodeAddress), every request recorded
  class Geocoder { geocode(req, cb) { rec.geocodes = (rec.geocodes || []).concat([req]); const res = [{ formatted_address: rec.geocodeAddress || 'Col. Río de Piedras, San Pedro Sula, Honduras' }]; if (cb) { win.setTimeout(() => cb(res, 'OK'), 0); return undefined; } return Promise.resolve({ results: res }); } }
  const maps = {
    Geocoder, Map, Marker, InfoWindow, MVCArray, Point, Size, Circle, Polyline, LatLng, LatLngBounds, DirectionsService, DirectionsRenderer, OverlayView,
    SymbolPath: { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1 }, TravelMode: { DRIVING: 'DRIVING' }, Animation: { DROP: 1, BOUNCE: 2 },
    ControlPosition: { TOP_RIGHT: 3, RIGHT_BOTTOM: 9, LEFT_TOP: 1 }, MapTypeId: { ROADMAP: 'roadmap' },
    event: { trigger() {}, addListener: (o, ev, fn) => (o && o.addListener ? o.addListener(ev, fn) : { remove() {} }), clearListeners() {}, addListenerOnce: (o, ev, fn) => (o && o.addListener ? o.addListener(ev, fn) : { remove() {} }) },
    geometry: { spherical: { computeDistanceBetween: () => 0, computeHeading: () => 0, interpolate: (a) => a } },
  };
  maps.importLibrary = async () => maps;
  maps.marker = { AdvancedMarkerElement: Marker };
  win.google = { maps };
  return rec;
}

module.exports = { installGoogleMaps };
