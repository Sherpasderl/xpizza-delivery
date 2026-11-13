// «Envío» step 1 (PLAN-portal-envio-step1 r2 §1b + build condition C2) — the messages between the portal and the map site
// (https://sherpa-portal-map.netlify.app, its own origin). ONE source: xpizza-portal-map/envio-map-protocol.js is a byte copy, so
// both sides validate with the same code.
//
//   • Each side accepts a message only from the other's exact origin AND window (event.source) AND the per-mount id.
//   • Both sides send with the exact targetOrigin, never '*'.
//   • Portal → map: one `render` — geometry, theme, and (v2) the map type and the limit facts. Map → portal: `listening`, `ready`, `failed` (an enum cause). Nothing
//     the map sends can save, fetch, read credentials or run anything: the portal only shows or hides one line with it.
//   • Startup (C2): the portal listens before it creates the frame; the map installs its listener, then sends `listening`; the
//     portal answers with the latest `render`; the map builds and sends `ready` after its first tiles. `listening` never clears
//     the portal's 8 s deadline — only `ready` does.

export const PORTAL_ORIGIN = 'https://sherpa-portal.netlify.app';
export const MAP_ORIGIN = 'https://sherpa-portal-map.netlify.app';
export const LIMITS = Object.freeze({ name: 80, others: 500, bands: 21, km: 100, fee: 15000 });
const CHILD_KINDS = ['listening', 'ready', 'failed'];
const CAUSES = ['load_error', 'auth_failure', 'import_rejected'];
const MOUNT = /^[0-9a-f]{32}$/;

const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
const keysAre = (o, ks) => plain(o) && Object.keys(o).length === ks.length && ks.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const isPoint = (p) => keysAre(p, ['lat', 'lng']) && num(p.lat) && num(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
const bandCore = (b) => num(b.km) && b.km > 0 && b.km <= LIMITS.km && Number.isInteger(b.fee) && b.fee >= 0 && b.fee <= LIMITS.fee && typeof b.ok === 'boolean';
const isBand = (b) => keysAre(b, ['km', 'fee', 'ok']) && bandCore(b);
// ENVÍO v3 (protocol v2, PLAN-portal-envio-v3-ui r5 §2): each band also says whether it lies beyond the restaurant's limit
const isBand2 = (b) => keysAre(b, ['km', 'fee', 'ok', 'out']) && bandCore(b) && typeof b.out === 'boolean';
export const MAP_TYPES = Object.freeze(['simple', 'roadmap', 'hybrid']);
const isLimit = (l) => l === null || (keysAre(l, ['km', 'capped', 'name']) && num(l.km) && l.km > 0 && l.km <= LIMITS.km && typeof l.capped === 'boolean'
  && typeof l.name === 'string' && l.name.length <= LIMITS.name);

export function newMountId(cryptoObj) {
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') throw new Error('envio map: no crypto');
  return Array.from(cryptoObj.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
// the frame URL's fragment `#m=<id>` → the id, or null
export function mountFromHash(hash) {
  const m = /^#m=([0-9a-f]{32})$/.exec(typeof hash === 'string' ? hash : '');
  return m ? m[1] : null;
}

const RENDER_V1 = ['v', 'mount', 'kind', 'view', 'theme', 'hub', 'name', 'others', 'bands'];
const RENDER_V2 = [...RENDER_V1, 'mapType', 'limit'];
// v1 (step 1's shape, exactly) or v2 (+ mapType, limit, each band's `out`) — never a mix
export function isRender(m, mount) {
  const v2 = plain(m) && m.v === 2;
  if (!(v2 ? keysAre(m, RENDER_V2) : keysAre(m, RENDER_V1) && m.v === 1)) return false;
  return m.kind === 'render'
    && MOUNT.test(mount || '') && m.mount === mount && (m.view === 'keep' || m.view === 'reset') && (m.theme === 'light' || m.theme === 'dark')
    && (m.hub === null || isPoint(m.hub)) && typeof m.name === 'string' && m.name.length <= LIMITS.name
    && Array.isArray(m.others) && m.others.length <= LIMITS.others && m.others.every(isPoint)
    && Array.isArray(m.bands) && m.bands.length <= LIMITS.bands && m.bands.every(v2 ? isBand2 : isBand)
    && (!v2 || (MAP_TYPES.includes(m.mapType) && isLimit(m.limit)));
}
// the portal sends v2 only
export function renderMessage({ mount, view, theme, hub, name, others, bands, mapType, limit }) {
  const m = { v: 2, mount, kind: 'render', view, theme, hub, name, others, bands, mapType, limit };
  if (!isRender(m, mount)) throw new Error('envio map: bad render');
  return m;
}

export function isChildMessage(m, mount) {
  if (!plain(m) || m.v !== 1 || !MOUNT.test(mount || '') || m.mount !== mount || !CHILD_KINDS.includes(m.kind)) return false;
  return m.kind === 'failed' ? keysAre(m, ['v', 'mount', 'kind', 'cause']) && CAUSES.includes(m.cause) : keysAre(m, ['v', 'mount', 'kind']);
}
export function childMessage(kind, mount, cause) {
  const m = kind === 'failed' ? { v: 1, mount, kind, cause } : { v: 1, mount, kind };
  if (!isChildMessage(m, mount)) throw new Error('envio map: bad child message');
  return m;
}

// the portal's receiver: the map origin, the frame's own window, this mount — else null
export function acceptFromChild(event, { frameWindow, mount }) {
  if (!event || event.origin !== MAP_ORIGIN || !frameWindow || event.source !== frameWindow) return null;
  return isChildMessage(event.data, mount) ? event.data : null;
}
// the map's receiver: the portal origin, window.parent, this mount — else null
export function acceptFromParent(event, { parentWindow, mount }) {
  if (!event || event.origin !== PORTAL_ORIGIN || !parentWindow || event.source !== parentWindow) return null;
  return isRender(event.data, mount) ? event.data : null;
}
