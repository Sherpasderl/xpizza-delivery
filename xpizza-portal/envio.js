// «Envío» step 1 (PLAN-portal-envio-step1 r2, approved with build conditions C1–C3; MOCKUP-portal-envio-v2-APPROVED.html) — the
// Sherpa-admin delivery-fee screen: ONE platform-wide distance table, a real Google map on its own origin, a confirm diff, CAS.
// Registered on the shell in the admin-only 'Sherpa' group. Only a platform admin sees it — a DISPLAY hint (E1 platform_admin);
// the server decides every request (getDeliveryPricing / setDeliveryPricing: platform_admins/{uid}).
//
//   • First paint from the session cache (sherpa.portal.envio.{uid}); one GET revalidates silently. No await before paint.
//   • Every decision is envio-logic.js's (validation, body, diff, picker, loaded states, save outcomes). This file is the DOM.
//   • Typing never rebuilds the row it is in (the caret stays); add / remove rebuild the rows.
//   • SAVE: an immutable attempt, editing frozen while it exists. SAVED only on a parsed 200 with expected + 1; anything else after
//     sending is UNKNOWN → a FRESH GET decides (saved / not landed → «Reintentar» resends the SAME attempt / conflict). A failed
//     recovery stays UNKNOWN and «Reintentar» re-reads first — never a blind resend (money rule 17).
//   • Session (Codex r1 F4, C1): every async continuation is bound to a generation; revoke() / sign-out / unmount bump it FIRST, then
//     clear state, cache, the frame and its deadline — a late answer can never repaint, re-cache or say «Tarifas guardadas».
//   • The map: an iframe on https://sherpa-portal-map.netlify.app (its own CSP; this shell only frames it). envio-map-protocol.js:
//     exact origin + source + mount id; the parent listens BEFORE it creates the frame; `listening` → the latest render; only
//     `ready` clears the absolute 8 s deadline (C2). On failure: ONE line in the box + one console.warn (no fallback renderer).
import { registerView, toast, goto } from './shell.js';
import { token } from './auth.js';
import { getDeliveryPricingRaw, setDeliveryPricingRaw } from './api.js';
import { el, svg, button, OFFLINE } from './ops-dom.js';
import * as EL from './envio-logic.js';
import * as MP from './envio-map-protocol.js';

const CACHE = (uid) => `sherpa.portal.envio.${uid}`;
const TIMING = { deadlineMs: 8000, finishMs: 2000 };   // Z2: «Terminar» waits ≤ 2 s for the map's finish (r2 P2-6)   // the map's absolute load deadline (Codex r1 F7); tests shorten it through _envioTiming
const NAV_ICON = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 3v2M12 19v2M3 12h2M19 12h2';
const I = Object.freeze({
  lock: [{ tag: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 }, 'M8 11V7a4 4 0 0 1 8 0v4'],
  ring: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }],
  info: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 8v5M12 16h.01'],
  x: ['M6 6l12 12M18 6L6 18'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  pin: ['M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z', { tag: 'circle', cx: 12, cy: 10, r: 2.5 }],
  search: [{ tag: 'circle', cx: 11, cy: 11, r: 7 }, 'M20 20l-3.5-3.5'],
  check: ['M5 12l5 5 9-10'],
  reload: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
  pencil: ['M4 20h4l10-10-4-4L4 16v4zM13 7l4 4'],   // ENVÍO step 2: the approved v2 zones card's «Renombrar»
  hatch: ['M-2 4L4 -2M-2 10L10 -2M-2 16L16 -2M-2 22L22 -2M4 26L26 4M10 26L26 10M16 26L26 16'],   // the zone swatch's diagonals
});
const ic = (k) => svg(...I[k]);
const COPY = Object.freeze({
  // ENVÍO step 2 — the «Zonas sin entrega» card, the approved v2 mockup's own words (owner 11-10)
  zonesH: 'Zonas sin entrega', zonesHint: 'Para todos los restaurantes', zonesDraw: 'Dibujar zona',
  // Z2 — drawing mode, the approved v2 page verbatim (frame 1b, note 12)
  drawingHint: 'Dibujando una zona', drawTool: 'Tocá el mapa para marcar cada punto. Para cerrar la zona, tocá el primer punto o «Terminar».',
  drawCancel: 'Cancelar', drawFinish: 'Terminar',
  zonesHelp: 'Áreas donde no entregamos aunque estén dentro del límite, por seguridad de los repartidores. Dibujalas sobre el mapa.',
  h1: 'Envío', pill: 'Área de Sherpa',
  lede: 'Una sola tarifa por distancia para todos los restaurantes; cada uno con su distancia máxima. La paga el cliente en la app de Sherpa y se mide en línea recta desde el pin de cada sucursal.',
  ledePh: 'Una tarifa por distancia para todos; cada restaurante con su distancia máxima. Se mide en línea recta desde el pin de cada sucursal.',
  bandsH: 'Tarifas de envío', bandsHint: 'Iguales para todos los restaurantes', bandsHintPh: 'Iguales para todos', hasta: 'Hasta', tarifa: 'Tarifa', add: 'Agregar tramo',
  limit: 'Distancia máxima de la tabla', limitAll: '· el último tramo', limitValid: '· el último tramo válido',
  help: 'Los tramos van de menor a mayor distancia, en lempiras enteros. Hasta 20 tramos, hasta 10 km y hasta L 150 por tramo. Ningún restaurante entrega más allá del último tramo.',
  helpPh: 'De menor a mayor distancia, lempiras enteros. Hasta 20 tramos, 10 km y L 150 por tramo.',
  calloutB: 'Las tarifas aplican a todos los restaurantes de Sherpa', calloutT: ', también a los que se sumen después. Lo único por restaurante es su distancia máxima, en el mapa.',
  mapH: 'Mapa', mapHint: 'Anillos desde el pin', pickLab: 'Restaurante o sucursal', search: 'Buscar restaurante o sucursal',
  mapNote: 'Los anillos se mueven mientras editás los tramos o la distancia máxima. Son distancias en línea recta: no siguen las calles.',
  mapNotePh: 'Los anillos se mueven mientras editás. Distancias en línea recta.',
  mapCap: (name, km) => (km === null || km === undefined ? `Anillos desde el pin de ${name}. Línea recta, no calles.` : `Anillos desde el pin de ${name}. Entrega hasta ${km} km.`),   // the mockup's own fallback (no reach known)
  mapFail: 'No se pudo cargar el mapa.', noPin: 'Esta sucursal no tiene ubicación todavía.', noBranches: 'No pudimos cargar las sucursales.',
  // ENVÍO v3 A2 (Changed): «Límite del restaurante» + «Tramo fuera de su alcance» replace «Límite de entrega»; «Tramo rechazado» kept
  legend: [['Tramo de tarifa', 'band'], ['Límite del restaurante', 'rlim'], ['Tramo fuera de su alcance', 'beyond'], ['Fuera del límite', 'out'], ['Otras sucursales', 'other']],
  legendBad: [['Tramo de tarifa', 'band'], ['Límite del restaurante', 'rlim'], ['Tramo rechazado', 'bad']],
  styleAria: 'Estilo del mapa', styles: [['simple', 'Simple'], ['roadmap', 'Mapa'], ['hybrid', 'Satélite']],
  discard: 'Descartar', save: 'Guardar',
  cTitle: 'Confirmar cambios de envío',
  cLede: 'Así queda el envío. Aplica a los pedidos nuevos de la app desde que guardés; los pedidos ya cotizados mantienen su tarifa.',
  cLedePh: 'Aplica a los pedidos nuevos de la app desde que guardés; los ya cotizados mantienen su tarifa.',
  cTramos: 'Tarifas · iguales para todos los restaurantes', cLimits: 'Distancia máxima por restaurante', cBack: 'Volver', cSave: 'Guardar cambios', saved: 'Envío guardado',
  // ENVÍO v3 — the restaurant's maximum distance (A1 / A4; copy table «New»)
  maxLab: 'Distancia máxima de ', maxHelp: 'Este restaurante entrega hasta esta distancia. Las tarifas son las mismas para todos.',
  maxMulti: (n) => ` Aplica a sus ${n} sucursales, desde el pin de cada una.`, maxCapPh: (top) => ` Máximo ${top}\u00a0km.`,   /* the number and its unit stay on one line (slot-1114 D4) */
  maxCap: 'máximo ', maxLess: '0.5 km menos', maxMore: '0.5 km más', maxAria: 'Distancia máxima, en km',
  capped: (top, km) => `Hoy entrega hasta ${top} km: la tabla no llega más lejos. Si la tabla vuelve a crecer, recupera sus ${km} km.`,
  conflictT: 'Alguien más cambió las tarifas, recargá', conflictP: 'Tus cambios no se guardaron. Recargá para ver la versión actual y volvé a editar sobre ella.', reload: 'Recargar',
  errT: 'No se pudieron guardar las tarifas', errP: 'Tus cambios siguen acá. Revisá tu internet y volvé a intentar; si sigue igual, escribinos.', retry: 'Reintentar',
  forbidden: 'No tenés acceso a esta sección.',
});
const L = (cents) => `L ${cents / 100}`;

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const S = {
  gen: 0, uid: null, host: null, root: null,
  loaded: null,            // envio-logic loadedState: { kind: 'policy', version, bands } | { kind: 'malformed', … } | { kind: 'unreadable' }
  rows: null, note: null,  // the draft rows [{ km, fee }] (typed text), and the last «Dejá al menos un tramo.» note
  entries: [], branchesUnavailable: false, pick: null,
  restaurants: [], branchesRaw: [],   // ENVÍO v3: restaurantsOf(the GET's branches) as LOADED, and the raw rows (the picker follows the edits)
  mapType: 'roadmap',      // ENVÍO v3 A2: the viewer's map style (localStorage only — never the draft, the dirty state or a request)
  limitEdits: {},          // ENVÍO v3: { restaurantKey → typed text } (the per-branch pending set derives from it: EL.pendingLimits)
  status: 'idle',          // idle | loading | ready | offline | forbidden
  banner: null,            // null | 'conflict' | 'error'
  attempt: null, phase: null,   // the frozen save attempt and where it stands: sending | recovering | unknown | not_landed
  confirm: null,           // Codex r1 F1: the REVIEWED body while the confirm is open (frozen): { body, was }; the POST is built from it
  picker: null,            // { q, hi } while open
  floor: 0,                // Codex r1 F4: the newest policy version this session adopted or confirmed — an older read is never adopted
  inerted: [],             // Codex r1 F1: the background nodes the open confirm made inert (released on EVERY exit)
  map: null,               // { frame, mount, deadline, listening, ready, failed, onMsg }
  zones: null,             // ENVÍO step 2: envio-logic zonesFromBody(the read) — { zones | null, editable, lock, caps }; fail closed
  zonesDraft: null,        // Z1b: the zones as edited (a copy of the read's list), compared with the server's sameZones
  feesBase: null,          // #184: the bands an unsent fee draft was edited against (null = no readable policy) — owned by the draft, not S.loaded
  zonesLastGood: null,     // #180: the last READABLE stored list — a kept draft's comparison while a read is unreadable
  zoneEdit: null,          // Z1b: { id, value, line } — the row being renamed in place
  zoneRemove: null,        // Z1b: the zone id whose «Quitar zona» confirm is open
  drawing: null,           // Z2: the live drawing session — { session, zone, points, seq, ack, request } (never draft; ends with any world end)
  zonesFail: null,         // Z1b: a save outcome about the zones — { kind: 'locked' | 'hours' | 'refused', branches, key, zoneId }
  refs: null,
};
function snap() {
  const g = { gen: S.gen, uid: S.uid };
  g.alive = () => g.gen === S.gen && g.uid === S.uid && !!S.root;
  g.assertLive = () => { if (!g.alive()) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); };
  return g;
}
const store = {
  get(k) { try { const v = sessionStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (_) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* not worth failing over */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch (_) { /* nothing to do */ } },
};
// only what the screen reads goes to the cache (never history)
const cacheable = (b) => ({
  ...(b.current_malformed === true ? { current_malformed: true, policy_version_raw: b.policy_version_raw } : { policy_version: b.policy_version, bands: b.bands }),
  ...(Array.isArray(b.branches) ? { branches: b.branches } : { branches_unavailable: true }),
});

// C1: the generation moves FIRST, then everything that a late continuation could have touched is cleared
function bump() { S.gen += 1; }
function clearSession({ dropCache }) {
  bump();
  stopMap();
  if (dropCache && S.uid) store.del(CACHE(S.uid));
  S.loaded = null; S.rows = null; S.note = null; S.entries = []; S.branchesUnavailable = false; S.pick = null;
  S.restaurants = []; S.branchesRaw = []; S.limitEdits = {}; S.feesBase = null;   // Codex HIGH r1 P2: ALL v3 state ends with the session
  S.banner = null; S.attempt = null; S.phase = null; S.confirm = null; S.picker = null; S.status = 'idle'; S.floor = 0;
  // ENVÍO step 2 (found fixing #180): the zones state ends with the session too — another admin never inherits an unsent zones draft
  S.zones = null; S.zonesDraft = null; S.zonesLastGood = null; S.zoneEdit = null; S.zoneRemove = null; S.zonesFail = null;
  closeEnvioLayer();
}
function revoke() {
  const wasShowing = !!S.root;
  const wasOpen = !!S.confirm;   // Codex r3 F1: a revocation that closes the confirm lands focus on the forbidden message
  clearSession({ dropCache: true });
  if (wasShowing) {
    S.status = 'forbidden'; render();
    const box = wasOpen && S.root && S.root.querySelector('.eerr');
    if (box) { box.tabIndex = -1; box.focus(); }
  }
}

document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  if (uid !== S.uid) clearSession({ dropCache: false });   // the shell's clearPersisted drops the old uid's cache
  else bump();
  S.uid = uid;
});

// ── load ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const bodyVersion = (b) => { const v = b && (b.current_malformed === true ? b.policy_version_raw : b.policy_version); return Number.isSafeInteger(v) && v >= 0 ? v : null; };
const raiseFloor = (v) => { if (Number.isSafeInteger(v) && v > S.floor) S.floor = v; };
// Codex #186 — the ONE place the table is reset to a base: the rows and the base they are judged against (S.feesBase) move TOGETHER, so
// no path can reset one without the other. `loaded` = the base: a policy ⇒ its bands; anything else (malformed, none) ⇒ an empty
// table and no base (then any typed value is a draft). User edits change S.rows only — never the base.
function resetRowsTo(loaded) {
  const bands = loaded && loaded.kind === 'policy' ? loaded.bands : null;
  S.rows = EL.rowsFromBands(bands || []);
  S.feesBase = bands;
}
function adoptBody(b) {
  S.loaded = EL.loadedState(b);
  S.zones = EL.zonesFromBody(b);
  if (S.zones.zones !== null) S.zonesLastGood = S.zones.zones;
  S.zonesDraft = S.zones.zones === null ? null : S.zones.zones.map((z) => ({ id: z.id, name: z.name, points: z.points.map((pt) => ({ lat: pt.lat, lng: pt.lng })) }));
  S.zoneEdit = null; S.zoneRemove = null; S.zonesFail = null;
  raiseFloor(bodyVersion(b));
  S.branchesUnavailable = !Array.isArray(b.branches);
  S.branchesRaw = Array.isArray(b.branches) ? b.branches : [];
  S.restaurants = EL.restaurantsOf(S.branchesRaw);
  S.limitEdits = {};
  resetRowsTo(S.loaded);
  refreshEntries();
  if (!S.pick || !S.entries.some((e) => e.rid === S.pick)) S.pick = EL.defaultPick(S.entries);
  S.note = null;
}
// ── ENVÍO v3: the restaurant's maximum distance (PLAN r5 §1, §1d) ──
// the table's top as EDITED (the last drawable band), the per-branch pending set, and the picker lines that follow both
function curTop() { const ok = EL.mapBands(S.rows || []).filter((b) => b.ok); return ok.length ? ok[ok.length - 1].km : null; }
const pendingNow = () => EL.pendingLimits(S.restaurants, S.limitEdits, curTop());
const limitDirty = () => Object.keys(pendingNow()).length > 0;
// ENVÍO step 2, Z1b: the zones draft differs from the read (the server's own logical equality)
// the stored list a zones draft is judged against: the read's, else the LAST READABLE one (#180: while the server node is unreadable the
// kept draft is still dirty against what it was edited on)
const zonesBaseList = () => (S.zones && S.zones.zones) || S.zonesLastGood || null;
const zonesDirty = () => !!(S.zonesDraft && zonesBaseList() && !EL.sameZones(S.zonesDraft, zonesBaseList()));
// an edited field with a line holds Guardar (the field shows the line; no other text)
const limitInvalid = () => S.restaurants.some((r) => Object.prototype.hasOwnProperty.call(S.limitEdits, r.key) && !!EL.limitProblem(S.limitEdits[r.key], curTop()));
function refreshEntries() {
  const p = pendingNow();
  S.entries = EL.pickerEntries(S.branchesRaw.map((b) => (Object.prototype.hasOwnProperty.call(p, b.rid) ? { ...b, max_km: p[b.rid], limit_invalid: false } : b)), curTop());
}
const pickedRestaurant = () => S.restaurants.find((r) => r.rids.includes(S.pick)) || null;
// #184: judged against the DRAFT's own base (S.feesBase), never the loaded kind — a malformed read cannot make an edit «clean»;
// with no readable policy as its base, any typed value is a draft
const feesDirty = () => !!(S.rows && (S.feesBase ? EL.isDirty(S.rows, S.feesBase) : S.rows.some((r) => String(r.km).trim() || String(r.fee).trim())));
// Codex #179 P2-1..3 — the ONE place a server read is applied: every caller (a load, the recovery read of a landed save, a mount from
// the cache) adopts server truth here and keeps what the admin has NOT sent. `discard` = the admin asked to drop the draft («Recargar»
// after a conflict, the malformed re-read); `landed` = the attempt this read confirms (what it SENT is server truth now; the rest stays).
// Unsent fee / limit edits keep their base version (S.loaded): the CAS still catches a newer server write at save. `cached` = the
// session cache's body, which never carries the zones or their lock (cacheable): it says nothing about them, so their state stays.
function applyRead(b, { discard = false, landed = null, cached = false } = {}) {
  // Codex #204 P1 (plan r1 §8): ANY applied read ends the transient drawing session and its pending messages — a session opened on one
  // version never commits against the next (an EDITING finish would overwrite another admin's newer zone without a conflict)
  endDrawing();
  // Codex #180 (owner 11-19, A) — THREE invariants: (1) any dirty draft (fees, limits OR zones) keeps its own CAS base (S.loaded) —
  // a newer read never moves it, so «Guardar» against a newer server conflicts; (2) the read floor ALWAYS advances on a read the screen
  // accepts, independent of the draft (a delayed older read can never unlock a live lock); (3) only `discard` clears a draft — an
  // unreadable read (current_malformed) keeps it, separately from the server state.
  const zonesState = cached && !discard && S.zones ? { zones: S.zones, draft: S.zonesDraft } : null;
  if (!cached) raiseFloor(bodyVersion(b));
  if (discard) { adoptBody(b); return; }
  const keepZones = zonesDirty() && !(landed && landed.sentZones) ? S.zonesDraft.map((z) => ({ id: z.id, name: z.name, points: z.points.map((pt) => ({ ...pt })) })) : null;
  const keepDraft = !landed && !!(S.attempt || limitDirty() || limitInvalid() || feesDirty() || keepZones);
  if (keepDraft) {
    // the draft wins on screen on its own base; the directory and the zones lock follow the server
    S.branchesUnavailable = !Array.isArray(b.branches);
    S.branchesRaw = Array.isArray(b.branches) ? b.branches : S.branchesRaw;
    S.zones = EL.zonesFromBody(b);
    if (S.zones.zones !== null) S.zonesLastGood = S.zones.zones;
    // an unreadable server node becomes the base the draft replaces (the v3 malformed path: «Guardá una tabla nueva…»), never a wipe
    if (b.current_malformed === true) S.loaded = EL.loadedState(b);
    refreshEntries();
  } else adoptBody(b);
  if (zonesState) { S.zones = zonesState.zones; S.zonesDraft = zonesState.draft; return; }
  if (keepZones) S.zonesDraft = keepZones;   // kept even when this read's zones are unreadable (shown again by the next good read)
}
async function load({ discard = false } = {}) {
  const g = snap();
  let res;
  try { res = await getDeliveryPricingRaw({ token, assertLive: g.assertLive }); } catch (err) { if (!g.alive()) return; res = { transport: true }; }
  if (!g.alive()) return;
  if (res.status === 403) { revoke(); return; }
  if (res.status !== 200 || !res.body) {
    if (!S.loaded) { S.status = 'offline'; render(); }
    return;
  }
  // Codex r1 F4: a read OLDER than what this session already adopted or saved (read before a save, delivered after it) is
  // neither cached nor adopted
  const rv = bodyVersion(res.body);
  if (rv !== null && rv < S.floor) { if (S.status !== 'ready') { S.status = 'ready'; render(); } return; }
  store.set(CACHE(S.uid), cacheable(res.body));
  applyRead(res.body, { discard });
  if (discard) S.banner = null;
  S.status = 'ready';
  render();
}

// ── save ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Codex r1 F1: «Guardar» captures the REVIEWED body (frozen) — the summary and the POST both come from it, never from the live rows
function openEnvioConfirm() {
  if (S.attempt || S.confirm || !S.loaded || S.loaded.version === null || S.loaded.version === undefined) return;
  const bar = barState();
  if (!bar.canSave && !(S.loaded.kind === 'malformed' && EL.validate(S.rows).valid && !limitInvalid())) return;
  const pending = pendingNow();
  const body = EL.toBody(S.rows, S.loaded.version, EL.limitsFor(pending), zonesDirty() ? S.zonesDraft : undefined);   // zones only when changed
  const was = S.loaded.kind === 'policy' ? S.loaded.bands.map((b) => ({ ...b })) : [];
  const loadedTop = was.length ? was[was.length - 1].max_km : null;
  const changes = EL.limitChanges(S.restaurants, pending, loadedTop);
  S.confirm = Object.freeze({ body: Object.freeze({ expected_policy_version: body.expected_policy_version, bands: Object.freeze(body.bands.map((b) => Object.freeze({ ...b }))),
    ...(body.limits ? { limits: Object.freeze(body.limits.map((e) => Object.freeze({ ...e }))) } : {}),
    ...(body.no_delivery_zones ? { no_delivery_zones: Object.freeze(body.no_delivery_zones.map((z) => Object.freeze({ ...z, points: Object.freeze(z.points.map((pt) => Object.freeze({ ...pt }))) }))) } : {}) }), was: Object.freeze(was),
  limitRows: Object.freeze(changes.rows.map((r) => Object.freeze({ ...r }))), limitCallouts: Object.freeze([...changes.callouts]) });
  render();
}
function startSave() {
  const c = S.confirm;
  if (S.attempt || !c) return;
  S.zonesFail = null;
  S.attempt = EL.startAttempt({ uid: S.uid, sessionGen: S.gen, expectedVersion: c.body.expected_policy_version, bands: c.body.bands, limits: c.body.limits || [],
    zones: c.body.no_delivery_zones });
  send(S.attempt);
}
async function send(attempt) {
  const g = snap();
  S.phase = 'sending'; S.banner = null; render();
  let res;
  try {
    res = await setDeliveryPricingRaw({ token, assertLive: g.assertLive, body: { expected_policy_version: attempt.expectedVersion, bands: attempt.sentBands, ...(attempt.sentLimits.length ? { limits: attempt.sentLimits } : {}),
      ...(attempt.sentZones ? { no_delivery_zones: attempt.sentZones } : {}) } });   // ENVÍO step 2: the zones only when the reviewed body had them
  } catch (err) {
    if (!g.alive() || S.attempt !== attempt) return;
    // withheld before sending (no token / obsolete): nothing landed
    const wasOpen = !!S.confirm;
    S.phase = 'not_landed'; S.banner = 'error'; S.confirm = null; render(); if (wasOpen) focusAfterEnvioClose(); return;
  }
  if (!g.alive() || S.attempt !== attempt) return;
  // Codex r1 F2: only the clean success contract is final; anything else is resolved by a fresh GET (the claim is kept as a hint)
  if (EL.classifyPost(attempt, res) === 'saved') { outcome(attempt, 'saved'); return; }
  lastClaim = { attempt, claim: EL.postClaim(res), body: res && res.body && typeof res.body === 'object' ? res.body : null, key: EL.zonesRefusalKey(res) };
  recover(attempt);
}
// the POST's claim stays with ITS attempt, so a «Reintentar» after a failed recovery GET still reads it
let lastClaim = { attempt: null, claim: null, body: null, key: null };
async function recover(attempt) {
  const g = snap();
  S.phase = 'recovering'; render();
  let res;
  try { res = await getDeliveryPricingRaw({ token, assertLive: g.assertLive }); } catch (_) { res = { transport: true }; }
  if (!g.alive() || S.attempt !== attempt) return;
  outcome(attempt, EL.classifyRecovery(attempt, res, lastClaim.attempt === attempt ? lastClaim.claim : null), res);
}
// Codex r2 F1: an outcome that closes the confirm puts focus somewhere meaningful — the result box, else Guardar (bar shown),
// else the page heading — never <body>
function focusAfterEnvioClose() {
  if (!S.root) return;
  const a = document.activeElement;
  if (a && a !== document.body && S.root.contains(a)) return;
  const box = S.refs && S.refs.banner.querySelector('.eerr');
  if (box) { box.tabIndex = -1; box.focus(); return; }
  if (S.refs && S.refs.bar.classList.contains('show') && !S.refs.save.disabled) { S.refs.save.focus(); return; }
  const h = S.root.querySelector('h1');
  if (h) h.focus();
}
function outcome(attempt, o, recoveryRes) {
  const wasOpen = !!S.confirm;
  try { settleEnvioOutcome(attempt, o, recoveryRes); } finally { if (wasOpen) focusAfterEnvioClose(); }
}
function settleEnvioOutcome(attempt, o, recoveryRes) {
  S.confirm = null;
  switch (o) {
    case 'saved': {
      // Codex HIGH r1 P1: a verdict reached through the RECOVERY GET adopts that read WHOLE — its bands, every branch's limit and its
      // version, atomically (another admin's write in the same version is server truth, never overwritten later by a stale screen)
      const rb = recoveryRes && recoveryRes.status === 200 && recoveryRes.body && typeof recoveryRes.body === 'object' && bodyVersion(recoveryRes.body) !== null ? recoveryRes.body : null;
      if (rb) {
        applyRead(rb, { landed: attempt });
        S.attempt = null; S.phase = null; S.banner = null;
        store.set(CACHE(S.uid), cacheable(rb));
        render();
        toast(attempt.sentZones ? EL.zonesCopy('savedBoth') : COPY.saved);
        return;
      }
      const version = attempt.expectedVersion + 1;
      raiseFloor(version);
      // ENVÍO step 2: the sent zones ARE the stored ones now (the same transaction); unsent ⇒ the stored list is untouched
      if (attempt.sentZones && S.zones) { S.zones = { ...S.zones, zones: attempt.sentZones.map((z) => ({ id: z.id, name: z.name, points: z.points.map((pt) => ({ ...pt })) })) }; S.zonesDraft = S.zones.zones.map((z) => ({ ...z, points: z.points.map((pt) => ({ ...pt })) })); }
      S.loaded = { kind: 'policy', version, bands: attempt.sentBands.map((b) => ({ ...b })) };
      resetRowsTo(S.loaded);
      // ENVÍO v3: the sent limits ARE the stored ones now (the same transaction): fold them into the loaded rows, nothing left pending
      const sent = new Map(attempt.sentLimits.map((e) => [e.rid, e.km]));
      const landed = (rows) => rows.map((b) => (sent.has(b.rid) ? { ...b, max_km: sent.get(b.rid), limit_invalid: false } : b));
      S.branchesRaw = landed(S.branchesRaw);
      S.restaurants = EL.restaurantsOf(S.branchesRaw);
      S.limitEdits = {};
      refreshEntries();
      S.attempt = null; S.phase = null; S.banner = null;
      const c = store.get(CACHE(S.uid)) || {};
      store.set(CACHE(S.uid), { ...c, current_malformed: undefined, policy_version_raw: undefined, policy_version: version, bands: S.loaded.bands,
        ...(Array.isArray(c.branches) ? { branches: landed(c.branches) } : {}) });
      render();
      toast(attempt.sentZones ? EL.zonesCopy('savedBoth') : COPY.saved);
      return;
    }
    // ENVÍO step 2 (addendum D): a restaurant is open — nothing landed; the draft stays; the panel names who
    case 'zones_locked':
      S.attempt = null; S.phase = null; S.banner = null;
      S.zonesFail = { kind: 'locked', branches: lastClaim.attempt === attempt && lastClaim.body && Array.isArray(lastClaim.body.branches) ? lastClaim.body.branches : [] };
      render(); return;
    case 'superseded': case 'conflict':
      S.attempt = null; S.phase = null; S.banner = 'conflict';
      resetRowsTo(S.loaded);
      render(); return;
    case 'forbidden': revoke(); return;
    case 'refused': case 'unauthenticated':
      if (o === 'refused') console.warn('envio save: refused');
      // ENVÍO step 2 (addendum F): the server refused the zones list — its own panel, the draft kept
      if (o === 'refused' && lastClaim.attempt === attempt && lastClaim.claim === 'zones_refused') {
        S.attempt = null; S.phase = null; S.banner = null;
        S.zonesFail = { kind: 'refused', key: lastClaim.key, zoneId: lastClaim.body && typeof lastClaim.body.zone_id === 'string' ? lastClaim.body.zone_id : null };
        render(); return;
      }
      S.attempt = null; S.phase = null; S.banner = 'error'; render(); return;
    case 'not_landed':
      // ENVÍO step 2 (addendum E): the hours could not be read — nothing landed; «Reintentar» resends the same attempt
      if (lastClaim.attempt === attempt && lastClaim.claim === 'hours_unavailable') { S.phase = 'not_landed'; S.banner = null; S.zonesFail = { kind: 'hours' }; render(); return; }
      S.phase = 'not_landed'; S.banner = 'error'; render(); return;
    case 'unknown': S.phase = 'unknown'; S.banner = 'error'; render(); return;
    default: S.phase = 'unknown'; S.banner = 'error'; render();
  }
}
function retry() {
  const a = S.attempt;
  if (!a) { S.banner = null; render(); return; }
  S.zonesFail = null;
  if (S.phase === 'not_landed') send(a);
  else if (S.phase === 'unknown') recover(a);
}
// Codex r1 F3: only a RESOLVED state can be discarded — no attempt, or one a fresh GET proved never landed (not_landed)
const attemptUnresolved = () => !!S.attempt && S.phase !== 'not_landed';
function discard() {
  if (attemptUnresolved()) return;
  bump();   // a late answer for a request of the dropped state is ignored (the map has its own lifetime: F6)
  S.attempt = null; S.phase = null; S.banner = null; S.confirm = null; S.note = null;
  resetRowsTo(S.loaded);
  S.limitEdits = {};   // Codex HIGH r1 P2: the limit edits go too — the field, the picker and the map follow the loaded limits again
  // ENVÍO step 2: the zones draft goes back to the read too
  S.zonesDraft = S.zones && S.zones.zones ? S.zones.zones.map((z) => ({ ...z, points: z.points.map((pt) => ({ ...pt })) })) : null;
  S.zoneEdit = null; S.zoneRemove = null; S.zonesFail = null;
  refreshEntries();
  render();
}
// ENVÍO step 2 (addendum D): «Guardar solo las tarifas» — the same reviewed fees WITHOUT the zones (envio-logic feesOnlyBody: the server
// keeps the stored zones and never reads hours for it), as a NEW attempt; the zones draft stays
function saveFeesOnly() {
  const v = S.loaded && S.loaded.kind === 'policy' ? S.loaded.version : null;
  if (S.attempt || v === null || !EL.validate(S.rows).valid || limitInvalid()) return;
  const body = EL.toBody(S.rows, v, EL.limitsFor(pendingNow()));
  S.zonesFail = null;
  S.attempt = EL.startAttempt({ uid: S.uid, sessionGen: S.gen, expectedVersion: body.expected_policy_version, bands: body.bands, limits: body.limits || [] });
  send(S.attempt);
}

// ── map frame (C2) ──────────────────────────────────────────────────────────────────────────────────────────────────────
function themeNow() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; }
}
const pickedEntry = () => S.entries.find((e) => e.rid === S.pick) || null;
// the picked branch's effective reach (its pending edit, else its stored value, capped by the table top as edited); a flagged branch: null
function pickedReach() {
  const b = S.branchesRaw.find((x) => x && x.rid === S.pick); if (!b) return null;
  const p = pendingNow();
  if (Object.prototype.hasOwnProperty.call(p, b.rid)) return EL.effectiveKm(p[b.rid], curTop());
  if (b.limit_invalid === true) return null;
  return EL.effectiveKm(Number.isFinite(b.max_km) ? b.max_km : null, curTop());
}
// ENVÍO v3 A2 / A4 (protocol v2): the limit the map draws = the picked branch's effective reach, capped when its stored value sits
// above the table (and no edit is pending); each band says whether it lies beyond that reach
function pickedLimit() {
  const reach = pickedReach(), r = pickedRestaurant();
  if (reach === null || !r) return null;
  const b = S.branchesRaw.find((x) => x && x.rid === S.pick), top = curTop();
  const capped = !Object.prototype.hasOwnProperty.call(pendingNow(), S.pick) && !!b && Number.isFinite(b.max_km) && top !== null && b.max_km > top;
  return { km: reach, capped, name: r.name.slice(0, MP.LIMITS.name) };
}
function renderMessage(view) {
  const p = pickedEntry();
  const others = S.entries.filter((e) => e.rid !== S.pick && e.hub).slice(0, MP.LIMITS.others).map((e) => ({ lat: e.hub.lat, lng: e.hub.lng }));
  const limit = pickedLimit();
  const bands = EL.mapBands(S.rows || []).map((b) => ({ km: b.km, fee: b.fee, ok: b.ok, out: !!(limit && b.ok && b.km > limit.km) }));
  const base = { mount: S.map.mount, view, theme: themeNow(), hub: p && p.hub ? { lat: p.hub.lat, lng: p.hub.lng } : null,
    name: p ? p.label.slice(0, MP.LIMITS.name) : '', others, bands, mapType: S.mapType, limit };
  if (!S.map.v3) return MP.renderMessage(base);
  // Z2 (protocol v3, only after THIS document's hello): the draft's zones the map draws, and the drawing session (null: none)
  const zones = (S.zonesDraft || []).map((z) => ({ id: z.id, name: z.name, points: z.points.map((q) => ({ lat: q.lat, lng: q.lng })) }));
  const d = S.drawing;
  return MP.renderMessage({ ...base, zones, drawing: d ? { session: d.session, zone: d.zone, points: d.points.map((q) => ({ lat: q.lat, lng: q.lng })), seq: d.seq, ack: d.ack, request: d.request } : null });
}
// ENVÍO v3 A2: the viewer's map style — read once per mount from localStorage (a throwing / unknown value → «Mapa»), written on a pick
const STYLE_KEY = 'sherpa.envio.mapView';
const STYLE_OK = new Set(COPY.styles.map(([t]) => t));
function readStyle() { try { const v = window.localStorage.getItem(STYLE_KEY); return STYLE_OK.has(v) ? v : 'roadmap'; } catch (_) { return 'roadmap'; } }
function pickStyle(t, focus) {
  if (!STYLE_OK.has(t)) return;
  if (t !== S.mapType) {
    S.mapType = t;
    try { window.localStorage.setItem(STYLE_KEY, t); } catch (_) { /* the choice just isn't remembered */ }
    postRender('keep');
  }
  paintStyle();
  if (focus && S.refs) { const b = S.refs.mstyleBtns.find((x) => x.dataset.st === t); if (b) b.focus(); }
}
function paintStyle() {
  const r = S.refs; if (!r) return;
  for (const b of r.mstyleBtns) { const on = b.dataset.st === S.mapType; b.setAttribute('aria-checked', String(on)); b.classList.toggle('mson', on); b.tabIndex = on ? 0 : -1; }
}
function postRender(view) {
  const m = S.map;
  if (!m || !m.listening || m.failed || !m.frame.contentWindow) return;
  const v = m.postedPick !== S.pick ? 'reset' : view;   // a branch the map hasn't shown yet always recentres
  m.postedPick = S.pick;
  try { m.frame.contentWindow.postMessage(renderMessage(v), MP.MAP_ORIGIN); } catch (e) { console.warn('envio map: post', e && e.message); }
}
function mapFailed(cause) {
  const m = S.map;
  if (!m || m.failed || m.ready) return;
  m.failed = true;
  clearTimeout(m.deadline);
  console.warn(`envio map: ${cause}`);
  paintMapBox(); paintDraw();
}
function startMap(box) {
  if (S.map || typeof window === 'undefined') return;
  let mount;
  try { mount = MP.newMountId(window.crypto); } catch (_) { return; }
  // Codex r1 F6: the frame's listener lives as long as THIS frame (S.map === m), not as long as one request generation: a
  // discard / reload bumps the generation, the map stays; every session end (sign-out, revocation, unmount) stops the frame
  const m = { frame: null, mount, deadline: null, listening: false, ready: false, failed: false, v3: false, onMsg: null, postedPick: undefined,
    pending: null, frameReq: null, rateT: 0, rateN: 0, io: null, seen: false };   // (b): the box's observer, and whether it has been seen   // Z2: the coalesced draft_points (the latest seq), its frame callback, the 30/s window
  m.onMsg = (event) => {
    if (S.map !== m || !S.root) return;
    const msg = MP.acceptFromChild(event, { frameWindow: m.frame && m.frame.contentWindow, mount });
    if (!msg) return;
    // Z2 (r2 P2-5, r3): `listening` = a child DOCUMENT announcing itself (a same-frame reload too) — the mount starts over for it: `failed`
    // cleared FIRST, protocol back to v2, not ready, and a document after the first gets its own 8 s deadline; then the v2 render.
    // `listening` never clears the deadline (C2)
    if (msg.kind === 'listening') {
      const again = m.listening || m.failed || m.ready;
      m.failed = false; m.v3 = false; m.ready = false; m.listening = true;
      if (again) { clearTimeout(m.deadline); m.deadline = m.seen ? setTimeout(() => mapFailed('timeout'), TIMING.deadlineMs) : null; paintMapBox(); }   // (b): a box never seen waits for its first sight
      postRender('reset'); paintDraw();
      return;
    }
    if (msg.kind === 'hello') { m.v3 = true; postRender('keep'); paintDraw(); return; }
    if (msg.kind === 'draft_points') { if (m.v3) queuePoints(m, msg); return; }
    if (msg.kind === 'finish') { if (m.v3) onFinish(m, msg); return; }
    if (msg.kind === 'edit_request') { if (m.v3) startEditing(msg.zone); return; }   // v3 only after THIS document's hello: its `listening` reset v3 first
    if (msg.kind === 'ready') { if (m.failed) return; m.ready = true; clearTimeout(m.deadline); paintMapBox(); paintDraw(); return; }
    if (msg.kind === 'failed') mapFailed(msg.cause);
  };
  window.addEventListener('message', m.onMsg);   // listening BEFORE the frame exists
  S.map = m;
  const f = el('iframe', 'mapframe');
  f.setAttribute('title', 'Mapa');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  f.addEventListener('error', () => mapFailed('frame_error'));
  m.frame = f;
  // PLAN-portal-zones-z2-fixes-r0 (b): the deadline starts when the map box is first SEEN — Chrome throttles an off-screen cross-origin frame
  // (Maps never fires tilesloaded), so a deadline from load failed every phone whose map sat below the fold (proven in Chrome, 11-20). The
  // frame itself is still created at once (C2: listening first). No IntersectionObserver ⇒ today's timing (from load).
  const arm = () => { if (S.map !== m || m.ready || m.failed) return; m.deadline = setTimeout(() => mapFailed('timeout'), TIMING.deadlineMs); };
  if (typeof window.IntersectionObserver === 'function') {
    m.io = new window.IntersectionObserver((entries) => {
      // Codex #237 P2-2: a SIGHT is a visible slice — an entry merely touching the viewport edge (isIntersecting, ratio 0) is not one
      if (!entries.some((e) => e.isIntersecting && e.intersectionRatio > 0) || S.map !== m) return;
      m.io.disconnect(); m.io = null; m.seen = true; arm();
    }, { threshold: 0.01 });
    m.io.observe(box);
  } else { m.seen = true; arm(); }
  f.src = `${MP.MAP_ORIGIN}/map.html#m=${mount}`;
  box.append(f);
}
function stopMap() {
  const m = S.map;
  if (!m) return;
  S.map = null;
  if (m.io) { m.io.disconnect(); m.io = null; }   // (b): an observer still waiting for its first sight goes with its frame
  if (S.drawing) { clearTimeout(S.drawing.reqT); S.drawing = null; }   // Z2: a session belongs to its frame — it goes with it (no render: no frame)
  dropFrame(m.frameReq);
  clearTimeout(m.deadline);
  if (typeof window !== 'undefined') window.removeEventListener('message', m.onMsg);
  if (m.frame) m.frame.remove();
}

// ── render ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function phText(dk, ph) { const f = document.createDocumentFragment(); f.append(el('span', 'dk', dk), el('span', 'ph', ph)); return f; }
function topBlock() {
  const top = el('div', 'top');
  const left = el('div');
  const h = el('h1');
  const pl = el('span', 'epill');
  pl.append(ic('lock'), document.createTextNode(COPY.pill));
  h.append(document.createTextNode(COPY.h1), pl);
  h.tabIndex = -1;
  const lede = el('p', 'lede');
  lede.append(phText(COPY.lede, COPY.ledePh));
  left.append(h, lede);
  top.append(left);
  return top;
}
function errbox(title, detail, action) {
  const box = el('div', 'eerr');
  box.setAttribute('role', 'alert');
  box.append(ic('info'));
  const t = el('div');
  t.append(el('b', null, title));
  if (detail) t.append(el('p', null, detail));
  box.append(t);
  if (action) box.append(action);
  return box;
}

// Tab cycles INSIDE the open confirm (WAI-ARIA modal, as the Sucursales modal does): the enabled controls are computed live,
// so a busy-disabled «Guardar tarifas» is skipped; with none enabled, Tab goes nowhere (advisor 11-11, real-Chrome probe)
function wrapEnvioConfirmTab(e, dialog) {
  const f = Array.from(dialog.querySelectorAll('input, button')).filter((n) => !n.disabled);
  if (!f.length) { e.preventDefault(); return; }
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
}
// Codex r1 F1: the open confirm makes every sibling on its path up to <body> inert (focus can't leave it); EVERY exit releases them
function inertEnvioBackground(layer) {
  releaseInert();
  for (let n = layer; n && n.parentElement && n !== document.body; n = n.parentElement) {
    for (const sib of n.parentElement.children) if (sib !== n && !sib.hasAttribute('inert')) { sib.setAttribute('inert', ''); S.inerted.push(sib); }
  }
}
function releaseInert() { for (const n of S.inerted) n.removeAttribute('inert'); S.inerted = []; }
function closeEnvioLayer() { releaseInert(); if (S.refs && S.refs.layer) S.refs.layer.replaceChildren(); }
// Codex r1 F5: a page that replaces the editor drops its references, so the next render rebuilds it (never paints detached nodes)
function dropPage() { closeEnvioLayer(); stopMap(); document.removeEventListener('click', onDocClick); S.refs = null; }
function render() {
  if (!S.root) return;
  const R = S.root;
  if (S.status === 'forbidden') { dropPage(); R.replaceChildren(topBlock(), errbox(COPY.forbidden, null, null)); return; }
  if (S.status === 'offline') {
    dropPage();
    R.replaceChildren(topBlock(), errbox(OFFLINE[0], OFFLINE[1], button('btn', COPY.retry, () => { S.status = 'loading'; render(); load(); })));
    return;
  }
  if (!S.refs) buildPage();
  paintBanner(); paintBands(); paintPicker(); paintMax(); paintMapBox(); paintLegend(); paintZones(); paintBar(); paintConfirm();
  postRender('keep');   // Codex r1 F6: every adoption / restoration reaches the map
}

function buildPage() {
  S.mapType = readStyle();   // ENVÍO v3 A2: the viewer's map style, read once per mount
  const R = S.root;
  const refs = {};
  refs.banner = el('div');
  const grid = el('div', 'grid2');
  const left = el('div', 'dcol'), right = el('div', 'dcol');
  // bands
  const sb = el('section', 'esec envbands');
  const h3 = el('h3', null, COPY.bandsH); const hh = el('span', 'ehint'); hh.append(phText(COPY.bandsHint, COPY.bandsHintPh)); h3.append(hh);
  refs.bands = el('div', 'bands');
  refs.add = button('eadd', COPY.add, () => {
    const next = EL.addRow(S.rows); if (!next) return;
    S.rows = next; S.note = null; paintBands({ rebuild: true });
    const ins = refs.bands.querySelectorAll('input[data-f="km"]'); if (ins.length) ins[ins.length - 1].focus();
    afterEdit();
  });
  refs.add.prepend(ic('plus'));
  refs.bnote = el('p', 'efnote'); refs.bnote.setAttribute('role', 'status');
  refs.limit = el('div', 'limit');
  refs.limitLab = el('span'); refs.limitNote = el('span', 'efnote'); refs.limitVal = el('b');
  refs.limitLab.append(document.createTextNode(`${COPY.limit} `), refs.limitNote);
  refs.limit.append(refs.limitLab, refs.limitVal);
  const help = el('p', 'ehelp'); help.append(phText(COPY.help, COPY.helpPh));
  sb.append(h3, refs.bands, refs.add, refs.bnote, refs.limit, help);
  const callout = el('div', 'ecallout envcallout');
  const ct = el('div'); ct.append(el('b', null, COPY.calloutB), document.createTextNode(COPY.calloutT));
  callout.append(ic('info'), ct);
  // ENVÍO step 2, Z1 — «Zonas sin entrega» (the approved v2 card; the addendum's server states A–C)
  const sz = el('section', 'esec envzones');
  const zh = el('h3', null, COPY.zonesH); refs.zonesHint = el('span', 'ehint', COPY.zonesHint); zh.append(refs.zonesHint);
  refs.zonesLock = el('div');
  refs.zonesList = el('div', 'zlist');
  refs.zonesDraw = button('railadd', COPY.zonesDraw, () => startDrawing()); refs.zonesDraw.prepend(ic('plus'));
  refs.zonesNotes = el('div');
  refs.zonesNameNote = el('p', 'efnote', EL.zonesCopy('nameNote'));   // note 13: under the list, only while a drawn zone is named
  sz.append(zh, el('p', 'ehelp', COPY.zonesHelp), refs.zonesLock, refs.zonesList, refs.zonesDraw, refs.zonesNotes);
  left.append(sb, callout, sz);
  // map
  const sm = el('section', 'esec envmap');
  const mh = el('h3', null, COPY.mapH); const mhint = el('span', 'ehint'); mhint.append(ic('ring'), document.createTextNode(COPY.mapHint)); mh.append(mhint);
  refs.mapHint = mhint; refs.pickFld = null;
  const fld = el('div', 'fld pickfld');
  fld.append(el('span', 'elab', COPY.pickLab));
  refs.pick = el('button', 'pick'); refs.pick.type = 'button';
  refs.pick.setAttribute('aria-haspopup', 'listbox'); refs.pick.setAttribute('aria-expanded', 'false');
  refs.pickName = el('b'); refs.pickSub = el('span'); refs.pickChev = el('span', 'pchev', '▾');
  const pk = el('span', 'pk'); pk.append(refs.pickName, refs.pickSub);
  refs.pick.append(ic('pin'), pk, refs.pickChev);
  refs.pick.addEventListener('click', () => (S.picker ? closeBranchPicker(true) : openBranchPicker()));
  refs.menu = el('div', 'pickmenu hidden');
  fld.append(refs.pick, refs.menu);
  // ENVÍO v3 A1 / A4: the restaurant's maximum distance (MOCKUP .maxfld: label, the .5 stepper around the .inp cell, the «máximo» chip,
  // the help, the quiet sand capped note, the field's line)
  refs.max = el('div', 'maxfld');
  refs.maxLab = el('span', 'elab');
  refs.maxStep = el('div', 'step');
  refs.maxDec = button('sb', '', () => stepMax(-0.5)); refs.maxDec.setAttribute('aria-label', COPY.maxLess); refs.maxDec.append(ic('minus'));
  refs.maxInc = button('sb', '', () => stepMax(0.5)); refs.maxInc.setAttribute('aria-label', COPY.maxMore); refs.maxInc.append(ic('plus'));
  const mi = el('label', 'inp sinp');   // the stepper's cell: its own class (the portal's .inp under another chain is a colour crossing)
  refs.maxIn = el('input'); refs.maxIn.setAttribute('inputmode', 'decimal'); refs.maxIn.setAttribute('aria-label', COPY.maxAria);
  refs.maxIn.addEventListener('input', () => { const r0 = pickedRestaurant(); if (!r0) return; S.limitEdits = { ...S.limitEdits, [r0.key]: refs.maxIn.value }; afterEdit(); });
  mi.append(refs.maxIn, el('span', null, 'km'));
  refs.maxCap = el('span', 'stepcap'); refs.maxCapB = el('b'); refs.maxCap.append(document.createTextNode(COPY.maxCap), refs.maxCapB);
  refs.maxStep.append(refs.maxDec, mi, refs.maxInc, refs.maxCap);
  refs.maxHelp = el('p', 'efnote');
  refs.maxLine = el('p', 'ferr hidden'); refs.maxLine.setAttribute('role', 'status');
  refs.maxNote = el('div', 'capnote sand hidden'); refs.maxNoteT = el('span'); refs.maxNote.append(refs.maxNoteT);   // plan r5 §0 A4: no icon
  refs.max.append(refs.maxLab, refs.maxStep, refs.maxHelp, refs.maxLine, refs.maxNote);
  refs.map = el('div', 'emap');
  refs.mapLine = el('p', 'mapline hidden'); refs.mapLine.setAttribute('role', 'status');
  // the mockup's in-map caption (.mz); above Google's logo row, which Maps terms keep visible (advisor ruling (a), 11-11)
  refs.mapCap = el('span', 'emz hidden');
  // ENVÍO v3 A2: the style control «Simple · Mapa · Satélite» (top-left over the map; a real radiogroup, roving tabindex, ← / →)
  refs.mstyle = el('div', 'mstyle'); refs.mstyle.setAttribute('role', 'radiogroup'); refs.mstyle.setAttribute('aria-label', COPY.styleAria);
  refs.mstyleBtns = COPY.styles.map(([t, label], i) => {
    const b = button('', label, () => pickStyle(t, false)); b.setAttribute('role', 'radio'); b.dataset.st = t;
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const n = COPY.styles.length, j = (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? n - 1 : 1)) % n;
      pickStyle(COPY.styles[j][0], true);
    });
    return b;
  });
  refs.mstyle.append(...refs.mstyleBtns);
  refs.map.append(refs.mstyle, refs.mapLine, refs.mapCap);
  refs.legend = el('div', 'legend');
  refs.mapNote = el('p', 'efnote');
  // Z2 frame 1b: the drawing tool line under the map — the hint, «Cancelar», «Terminar»
  refs.mtool = el('div', 'mtool hidden');
  refs.drawCancel = button('btn ghost', COPY.drawCancel, () => endDrawing());
  refs.drawFinish = button('btn accent', COPY.drawFinish, () => requestFinish());
  refs.drawNote = el('span', 'efnote', COPY.drawTool);
  refs.drawLine = el('p', 'ferr'); refs.drawLine.setAttribute('role', 'alert');   // a refused shape: the approved red one-liner (note 12)
  refs.mtool.append(refs.drawNote, refs.drawCancel, refs.drawFinish);
  refs.pickFld = fld; refs.dimmed = [sb, callout];   // note 12: the picker and the left cards dim (the shape is global)
  sm.append(mh, fld, refs.max, refs.map, refs.mtool, refs.legend, refs.mapNote);
  right.append(sm);
  grid.append(left, right);
  // save bar + confirm layer (fixed / overlay: placement in the DOM doesn't move them)
  refs.bar = el('div', 'rbar');
  refs.barDot = el('span', 'ebdot'); refs.barText = el('span', 'rb-t');
  const sp = el('div', 'rb-sp');
  refs.discard = button('btn ghost', COPY.discard, discard);
  refs.save = button('btn accent', COPY.save, openEnvioConfirm);
  sp.append(refs.discard, refs.save);
  refs.bar.append(refs.barDot, refs.barText, sp);
  refs.layer = el('div');
  R.replaceChildren(topBlock(), refs.banner, grid, refs.bar, refs.layer);
  S.refs = refs;
  document.removeEventListener('click', onDocClick);
  document.addEventListener('click', onDocClick);
}
function onDocClick(e) {
  if (!S.picker || !S.refs) return;
  const t = e.target;
  if (t && t.closest && t.closest('.pickfld')) return;
  closeBranchPicker(false);
}

function paintBanner() {
  const b = S.refs.banner;
  const L0 = S.loaded;
  let box = null;
  if (S.banner === 'conflict') {
    const r = button('btn', COPY.reload, () => { S.banner = null; load({ discard: true }); });
    r.prepend(ic('reload'));
    box = errbox(COPY.conflictT, COPY.conflictP, r);
  } else if (S.zonesFail) {
    box = zonesFailBox();
  } else if (S.banner === 'error') {
    box = errbox(COPY.errT, COPY.errP, button('btn', COPY.retry, retry));
  } else if (L0 && L0.kind === 'malformed') {
    const [t, p] = L0.message.split(/(?<=\.) /);
    box = errbox(t, p, null);
  } else if (L0 && L0.kind === 'unreadable') {
    box = errbox(EL.COPY.malformedRepair.split(/(?<=\.) /)[0], EL.COPY.malformedRepair.split(/(?<=\.) /)[1], null);
  }
  b.replaceChildren(...(box ? [box] : []));
}

// ENVÍO step 2 — the zones save outcomes (addendum D–F): D a restaurant open (who and why; «Entendido», and «Guardar solo las tarifas»
// when the fees changed too), E the hours unreadable («Reintentar», approved), F the server refused the list («Revisar zona»)
function zonesFailBox() {
  const f = S.zonesFail;
  const box = el('div', 'eerr envzfail'); box.setAttribute('role', 'alert');
  const t = el('div');
  const acts = el('div', 'ebtns');
  if (f.kind === 'locked') {
    const lb = el('p'); lb.append(phText(EL.zonesCopy('lockedSaveBody'), EL.zonesCopy('lockedSaveBodyPh')));   // frame H: the phone's shorter body
    t.append(el('b', null, EL.zonesCopy('lockedSaveTitle')), lb);
    // the blocking branches (addendum D .blist): one line each — the name, then the status as a dot + word; > 3 ⇒ «y N más»
    const list = el('div', 'blist');
    for (const b of f.branches.slice(0, 3)) {
      const row = el('div', 'zbrow');   // the mockup's .brow look, its own class (.brow is S2's review row: no colour crossing)
      const st = el('span', `st ${b.reason === 'open' ? 'open' : 'unk'}`); st.append(el('i'), document.createTextNode(EL.zonesCopy(b.reason === 'open' ? 'branchOpen' : 'branchHours')));
      // frame D: «Sin horario válido · Revisar en Sucursales» (phone H: «Revisar») — the link opens THAT branch's page (rule 14, advisor 11-19)
      if (b.reason !== 'open') { const go = el('a', 'zblink'); go.href = '#'; go.append(phText(EL.zonesCopy('branchHoursLink'), EL.zonesCopy('branchHoursLinkPh'))); go.addEventListener('click', (e) => { e.preventDefault(); goto('suc', { rid: b.rid }); }); st.append(document.createTextNode(' \u00b7 '), go); }
      // «Restaurante · Sucursal» as the mockup draws it (slot 11-15, advisor: rule 16b — two restaurants' «Sucursal 1» never read the same);
      // the 409 names the branch only (rid + location_name), so the restaurant comes from the loaded branch list
      const br = S.branchesRaw.find((x) => x && x.rid === b.rid);
      const rest = br && typeof br.brand_name === 'string' && br.brand_name.trim() ? br.brand_name.trim() : null;
      const loc = b.location_name || b.name || b.rid;
      row.append(el('span', 'k', rest ? `${rest} · ${loc}` : `${loc}`), st);
      list.append(row);
    }
    if (f.branches.length > 3) list.append(el('div', 'bmore', EL.zonesCopy('branchesMore', { n: f.branches.length - 3 })));
    t.append(list);
    acts.append(button('btn ghost', EL.zonesCopy('understood'), () => { S.zonesFail = null; render(); }));
    const feesChanged = !!(S.loaded && S.loaded.kind === 'policy' && (EL.isDirty(S.rows, S.loaded.bands) || limitDirty()));
    if (feesChanged) acts.append(button('btn accent', EL.zonesCopy('feesOnly'), saveFeesOnly));
  } else if (f.kind === 'hours') {
    t.append(el('b', null, EL.zonesCopy('hoursSaveTitle')), el('p', null, EL.zonesCopy('hoursSaveBody')));
    acts.append(button('btn', COPY.retry, retry));
  } else {
    // frame F names the refused zone; a 400 that names none (a list-level problem) has no drawn title yet (refusedTitleBare)
    const zn = f.zoneId && (S.zonesDraft || []).find((z) => z.id === f.zoneId);
    const title = f.key === 'zones.caps' ? EL.zonesCopy('capsTitle') : zn ? EL.zonesCopy('refusedTitle', { nombre: zn.name }) : EL.zonesCopy('refusedTitleBare');
    t.append(el('b', null, title), el('p', null, EL.zonesCopy(f.key === 'zones.caps' ? 'capsBody' : 'refusedBody')));
    acts.append(button('btn', EL.zonesCopy('reviewZone'), () => {
      S.zonesFail = null; render();
      const row = f.zoneId && S.refs ? [...S.refs.zonesList.querySelectorAll('.zrow')].find((r) => r.dataset.zone === f.zoneId) : null;
      const b = row && row.querySelector('button.ib'); if (b) b.focus();
    }));
  }
  box.append(ic('info'), t, acts);
  return box;
}
const frozen = () => S.status !== 'ready' || !!S.attempt || S.banner === 'conflict' || !S.loaded || S.loaded.kind === 'unreadable'
  || (S.loaded.kind === 'malformed' && !S.loaded.canSave);
function paintBands({ rebuild } = {}) {
  const r = S.refs;
  const rows = S.rows || [];
  // before the first answer the rows are reserved space only: no rule speaks yet
  const quiet = S.status !== 'ready';
  const v0 = EL.validate(rows);
  const v = quiet ? { ...v0, rows: v0.rows.map(() => ({ kmErr: null, feeErr: null })), invalidCount: 0 } : v0;
  const lock = frozen();
  const existing = r.bands.querySelectorAll('.band');
  if (rebuild || existing.length !== rows.length) {
    const head = el('div', 'bhead');
    head.append(el('span'), el('span', 'elab', COPY.hasta), el('span', 'elab', COPY.tarifa), el('span'));
    const list = rows.map((row, i) => bandRow(i));
    r.bands.replaceChildren(head, ...list);
  }
  r.bands.querySelectorAll('.band').forEach((node, i) => {
    const row = rows[i], e = v.rows[i];
    const km = node.querySelector('input[data-f="km"]'), fee = node.querySelector('input[data-f="fee"]');
    if (km.value !== row.km && document.activeElement !== km) km.value = row.km;
    if (fee.value !== row.fee && document.activeElement !== fee) fee.value = row.fee;
    km.disabled = lock; fee.disabled = lock;
    node.querySelector('.bdel').disabled = lock;
    node.querySelector('.bn').textContent = String(i + 1);
    km.parentElement.classList.toggle('bad', !!e.kmErr);
    fee.parentElement.classList.toggle('bad', !!e.feeErr);
    const msg = e.kmErr || e.feeErr;
    let berr = node.querySelector('.berr');
    const id = `envberr${i}`;
    if (msg) {
      if (!berr) { berr = el('span', 'berr'); berr.id = id; berr.setAttribute('role', 'alert'); node.append(berr); }
      if (berr.textContent !== msg) berr.replaceChildren(ic('info'), document.createTextNode(msg));
    } else if (berr) berr.remove();
    for (const [inp, bad] of [[km, !!e.kmErr], [fee, !!e.feeErr]]) {
      if (bad) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', id); } else { inp.removeAttribute('aria-invalid'); inp.removeAttribute('aria-describedby'); }
    }
  });
  r.add.disabled = lock || !v.canAdd;
  if (quiet) { r.limitNote.textContent = COPY.limitAll; r.limitVal.textContent = '—'; r.bnote.classList.add('hidden'); return; }
  const note = !v.canAdd ? v.addNote : S.note;
  r.bnote.textContent = note || '';
  r.bnote.classList.toggle('hidden', !note);
  r.limitNote.textContent = v.invalidCount > 0 ? COPY.limitValid : COPY.limitAll;
  r.limitVal.textContent = v.limitKm === null ? '—' : `${v.limitKm} km`;
}
function bandRow(i) {
  const node = el('div', 'band');
  const n = el('span', 'bn', String(i + 1));
  const kmL = el('label', 'inp'); const km = el('input'); km.dataset.f = 'km'; km.inputMode = 'decimal'; km.setAttribute('inputmode', 'decimal'); km.autocomplete = 'off';
  km.setAttribute('aria-label', `Hasta, tramo ${i + 1}, en km`);
  kmL.append(km, el('span', null, 'km'));
  const feeL = el('label', 'inp'); const fee = el('input'); fee.dataset.f = 'fee'; fee.setAttribute('inputmode', 'numeric'); fee.autocomplete = 'off';
  fee.setAttribute('aria-label', `Tarifa, tramo ${i + 1}, en lempiras`);
  feeL.append(el('span', null, 'L'), fee);
  const del = el('button', 'bdel'); del.type = 'button'; del.title = 'Quitar tramo'; del.setAttribute('aria-label', `Quitar tramo ${i + 1}`); del.append(ic('x'));
  const idx = () => Array.prototype.indexOf.call(node.parentElement.querySelectorAll('.band'), node);
  km.addEventListener('input', () => { S.rows = S.rows.map((r, j) => (j === idx() ? { ...r, km: km.value } : r)); S.note = null; afterEdit(); });
  fee.addEventListener('input', () => { S.rows = S.rows.map((r, j) => (j === idx() ? { ...r, fee: fee.value } : r)); S.note = null; afterEdit(); });
  del.addEventListener('click', () => {
    const at = idx();
    const res = EL.removeRow(S.rows, at);
    S.rows = res.rows; S.note = res.note;
    paintBands({ rebuild: true });
    const dels = S.refs.bands.querySelectorAll('.bdel');
    if (dels.length) dels[Math.min(at, dels.length - 1)].focus();
    afterEdit();
  });
  node.append(n, kmL, feeL, del);
  return node;
}
function afterEdit() { refreshEntries(); paintBands(); paintPicker(); paintMax(); paintMapBox(); paintLegend(); paintZones(); paintBar(); postRender('keep'); }
// ENVÍO step 2, Z1 — the zones card from the read: the rows (name · «N puntos · dentro de X km» from the picked pin), the lock's callout
// (B: a restaurant open; C: hours unknown / unavailable, with a fresh read), the notes. Rename / remove are on only when the server says
// the zones are editable; «Dibujar zona» waits for the map's drawing (Z2, protocol v3)
function paintZones() {
  const r = S.refs;
  if (!r || !r.zonesList) return;
  const z = S.zones || { zones: null, editable: false, lock: { reason: 'unavailable', branches: [] } };
  const hub = (S.entries.find((e) => e.rid === S.pick) || {}).hub || null;
  const canEdit = z.editable && !frozen() && !S.drawing;   // Z2: no rename / remove while a shape is drawn
  r.zonesLock.replaceChildren();
  if (z.zones !== null && !z.editable && z.lock) {
    const open = z.lock.reason === 'open';
    const co = el('div', `ecallout${open ? ' sand' : ''}`);
    const t = el('div');   // frame H: the open lock's title and body shorten on the phone
    const tb = el('b'); tb.append(open ? phText(EL.zonesCopy('lockedTitle'), EL.zonesCopy('lockedTitlePh')) : document.createTextNode(EL.zonesCopy('hoursTitle')));
    t.append(tb, document.createTextNode(' '), open ? phText(EL.zonesCopy('lockedBody'), EL.zonesCopy('lockedBodyPh')) : document.createTextNode(EL.zonesCopy('hoursBody')));
    co.append(ic('info'), t);
    if (!open) co.append(button('btn ghost sm', EL.zonesCopy('recheck'), () => load()));   // re-reads the lock; unsent edits stay (#179 P2-3)
    r.zonesLock.append(co);
  }
  r.zonesList.replaceChildren();
  for (const zone of S.zonesDraft || []) {
    const editing = S.zoneEdit && S.zoneEdit.id === zone.id;
    const row = el('div', `zrow${editing ? ' editing' : ''}`); row.dataset.zone = zone.id;
    const sw = el('span', 'zsw'); sw.append(ic('hatch'));
    if (editing) {
      // rename in place (v2 «.zrow.editing»): Enter keeps it in the draft, Esc cancels; empty / too long / a taken name stay here
      const zoneName = el('input'); zoneName.type = 'text'; zoneName.value = S.zoneEdit.value; zoneName.setAttribute('aria-label', 'Nombre de la zona');   // v2 verbatim (Codex #179 inline-copy audit)
      zoneName.addEventListener('input', () => { S.zoneEdit = { ...S.zoneEdit, value: zoneName.value }; });
      zoneName.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); S.zoneEdit = null; paintZones(); focusZone(zone.id, 'Renombrar'); }
        else if (e.key === 'Enter') { e.preventDefault(); zoneRenameSave(zone.id); }
      });
      row.append(sw, zoneName);
      r.zonesList.append(row);
      if (S.zoneEdit.line) { const l = el('p', 'ferr', S.zoneEdit.line); l.setAttribute('role', 'alert'); r.zonesList.append(l); }
      continue;
    }
    const km = EL.zoneReachKm(zone, hub);
    const k = el('span', 'k', zone.name);
    k.append(el('span', 's', `${zone.points.length} puntos${km === null ? '' : ` \u00b7 dentro de ${km} km`}`));
    const ren = button('ib', '', () => { S.zoneEdit = { id: zone.id, value: zone.name, line: null }; paintZones(); const i0 = r.zonesList.querySelector('.zrow.editing input'); if (i0) { i0.focus(); i0.select(); } });
    ren.title = 'Renombrar'; ren.setAttribute('aria-label', `Renombrar ${zone.name}`); ren.append(ic('pencil'));
    const rem = button('ib', '', () => { S.zoneRemove = zone.id; paintZoneRemove(); });
    rem.title = 'Quitar'; rem.setAttribute('aria-label', `Quitar ${zone.name}`); rem.append(ic('x'));
    ren.disabled = !canEdit; rem.disabled = !canEdit;
    row.append(sw, k, ren, rem);
    r.zonesList.append(row);
  }
  if (S.drawing && S.drawing.closed) r.zonesList.append(...namingRow());
  if (S.drawing && S.drawing.closed) r.zonesList.after(r.zonesNameNote); else r.zonesNameNote.remove();
  // addendum G: at the cap the hint is the count («8 de 8») and «Dibujar zona» says why it is off
  const atCap = !!(z.caps && S.zonesDraft && S.zonesDraft.length >= z.caps.zones_max);
  r.zonesHint.textContent = atCap ? EL.zonesCopy('capCount') : COPY.zonesHint;
  paintDraw();
  r.zonesNotes.replaceChildren();
  const note = (t) => r.zonesNotes.append(el('p', 'efnote', t));
  if (z.zones === null) note(EL.zonesCopy('unreadable'));
  else { if (z.editable) note(EL.zonesCopy('editableNote')); if (atCap) note(EL.zonesCopy('capDraw')); }   // no note below the cap: the approved frames draw none (advisor 11-19)
}
// note 13 — the drawn zone's naming row, in the list (no modal): typing updates it in place (no repaint under the caret); «Listo» is on
// for a valid name, a long or taken one says why (the rename's rules, zoneNameLine)
function namingRow() {
  const d = S.drawing;
  const row = el('div', 'zrow editing');
  const sw = el('span', 'zsw'); sw.append(ic('hatch'));
  const inp = el('input'); inp.type = 'text'; inp.value = d.name; inp.placeholder = EL.zonesCopy('namePh'); inp.setAttribute('aria-label', EL.zonesCopy('namePh'));
  const cancel = button('btn ghost', EL.zonesCopy('nameCancel'), () => endDrawing());
  const done = button('btn accent', EL.zonesCopy('nameDone'), () => commitDrawn());
  const err = el('p', 'ferr hidden'); err.setAttribute('role', 'alert');
  const sync = () => {
    const { line } = zoneNameLine(inp.value, null);
    done.disabled = !!line;
    const say = line && inp.value.trim() ? line : '';   // an empty name just keeps «Listo» off (frame 1b draws no line for it)
    err.textContent = say; err.classList.toggle('hidden', !say);
  };
  inp.addEventListener('input', () => { d.name = inp.value; sync(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !done.disabled) { e.preventDefault(); commitDrawn(); } else if (e.key === 'Escape') { e.preventDefault(); endDrawing(); } });
  row.append(sw, inp, cancel, done);
  sync();
  return [row, err];
}
const focusZone = (id, title) => { const row = S.refs && [...S.refs.zonesList.querySelectorAll('.zrow')].find((x) => x.dataset.zone === id); const b = row && row.querySelector(`button.ib[title="${title}"]`); if (b) b.focus(); };
// the server's name rules, before the save (zones.js normalizeInput): trimmed, 1..name_max, unique case-folded
function zoneNameLine(raw, id) {
  const name = String(raw).replace(/\s+/g, ' ').trim();
  const max = S.zones && S.zones.caps ? S.zones.caps.name_max : 30;
  let line = null;
  if (!name) line = EL.zonesCopy('nameEmpty');
  else if (name.length > max) line = EL.zonesCopy('nameLong');
  else if ((S.zonesDraft || []).some((z) => z.id !== id && String(z.name).trim().toLowerCase() === name.toLowerCase())) line = EL.zonesCopy('nameTaken');
  return { name, line };
}
function zoneRenameSave(id) {
  const e = S.zoneEdit;
  if (!e || e.id !== id) return;
  // Codex #179 P3: judged as the server judges the name this sends (delivery/zones.js normalizeInput + compactProblem): 1..name_max
  // UTF-16 units, unique by toLowerCase() alone (no accent folding). The client only collapses whitespace runs before sending, so a
  // pasted tab / newline (a control character the server refuses) never reaches it; the server judges exactly the string sent.
  const { name, line } = zoneNameLine(e.value, id);
  if (line) { S.zoneEdit = { ...e, line }; paintZones(); const i0 = S.refs.zonesList.querySelector('.zrow.editing input'); if (i0) i0.focus(); return; }
  S.zonesDraft = S.zonesDraft.map((z) => (z.id === id ? { ...z, name } : z));
  S.zoneEdit = null;
  afterEdit();
  focusZone(id, 'Renombrar');
}
// «Quitar zona» (v2 note 11: the portal's small modal) — «Cancelar» focused; «Quitar» drops the zone from the draft
function paintZoneRemove() {
  const id = S.zoneRemove;
  const host = S.refs && S.refs.layer;
  if (!host) return;
  const close = (refocus) => { S.zoneRemove = null; host.replaceChildren(); releaseInert(); if (refocus) focusZone(id, 'Quitar'); };
  const scrim = el('div', 'scrim show');
  const m = el('div', 'modal sm envzrm'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'envzrmt');
  const zr = (S.zonesDraft || []).find((z) => z.id === id);
  const h = el('h2', null, EL.zonesCopy('removeTitle', { nombre: zr ? zr.name : '' })); h.id = 'envzrmt';
  const head = el('div', 'mhead'); head.append(h, el('p', null, EL.zonesCopy('removeBody')));
  const foot = el('div', 'mfoot');
  const zoneRmCancel = button('btn ghost', 'Cancelar', () => close(true));
  const zoneRmGo = button('btn ghost danger', 'Quitar', () => { S.zonesDraft = (S.zonesDraft || []).filter((z) => z.id !== id); close(false); afterEdit(); });
  foot.append(zoneRmCancel, zoneRmGo);
  m.append(head, foot);
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } });
  scrim.append(m);
  host.replaceChildren(scrim);
  inertEnvioBackground(host);
  zoneRmCancel.focus();
}
// ENVÍO v3 A1 / A4 — the field for the picked branch's restaurant: the edit text, else its stored value (none → the table top; a flagged
// restaurant: empty, «—»); «+» off at the cap; the line for an edited text; the sand note when the STORED value stays above the top
function shownMax(r, top) {
  if (Object.prototype.hasOwnProperty.call(S.limitEdits, r.key)) return S.limitEdits[r.key];
  if (r.invalid) return '';
  const v = r.stored === null ? top : r.stored;
  return v === null ? '' : String(v);
}
function stepMax(delta) {
  const r = pickedRestaurant(); const top = curTop();
  if (!r || !r.editable || top === null) return;
  const cur = EL.snapHalf(shownMax(r, top));
  const base = cur === null ? (delta > 0 ? 0 : top) : cur;
  const next = Math.min(top, Math.max(0.5, base + delta));
  S.limitEdits = { ...S.limitEdits, [r.key]: String(next) };
  if (S.refs) S.refs.maxIn.value = String(next);
  afterEdit();
}
function paintMax() {
  const R0 = S.refs; if (!R0) return;
  const r = pickedRestaurant(); const top = curTop();
  R0.max.classList.toggle('hidden', !r);
  if (!r) return;
  R0.maxLab.textContent = `${COPY.maxLab}${r.name}`;
  const text = shownMax(r, top);
  if (document.activeElement !== R0.maxIn) R0.maxIn.value = text;
  R0.maxIn.placeholder = r.invalid ? '—' : '';
  R0.maxIn.readOnly = !r.editable;
  const edited = Object.prototype.hasOwnProperty.call(S.limitEdits, r.key);
  const line = edited ? EL.limitProblem(text, top) : null;
  const num = EL.snapHalf(text);
  R0.maxDec.disabled = !r.editable || top === null || (num !== null && num <= 0.5);
  R0.maxInc.disabled = !r.editable || top === null || (num !== null && num >= top);
  R0.maxCapB.textContent = top === null ? '—' : `${top} km`;
  R0.maxHelp.replaceChildren();
  const help = `${COPY.maxHelp}${r.n > 1 ? COPY.maxMulti(r.n) : ''}`;
  R0.maxHelp.append(phText(help, `${help}${top === null ? '' : COPY.maxCapPh(top)}`));
  R0.maxLine.textContent = line || ''; R0.maxLine.classList.toggle('hidden', !line);
  R0.maxIn.setAttribute('aria-invalid', line ? 'true' : 'false');
  const capped = !edited && !r.invalid && r.stored !== null && top !== null && r.stored > top;
  // the capped note leads in bold (MOCKUP-portal-envio-v3 A4): «Hoy entrega hasta {top} km:» then the rest of the one sentence
  const capText = capped ? COPY.capped(top, r.stored) : '';
  const capCut = capText.indexOf(': ');
  R0.maxNoteT.replaceChildren(...(capCut > 0 ? [el('b', null, capText.slice(0, capCut + 1)), document.createTextNode(capText.slice(capCut + 1))] : [document.createTextNode(capText)]));
  R0.maxNote.classList.toggle('hidden', !capped);
}

function paintLegend() {
  const r = S.refs;
  const refused = EL.mapBands(S.rows || []).filter((b) => !b.ok);
  const items = refused.length ? COPY.legendBad : COPY.legend;
  r.legend.replaceChildren(...items.map(([t, k]) => { const s = el('span'); s.append(el('i', `lg-${k}`), document.createTextNode(t)); return s; }));
  r.mapNote.replaceChildren();
  if (refused.length) r.mapNote.textContent = `El tramo de ${refused[0].km} km no se dibuja como entrega: queda fuera del máximo de 10 km.`;
  else r.mapNote.append(phText(COPY.mapNote, COPY.mapNotePh));
}

// ── Z2 — the drawing session (PLAN-portal-zones-protocol-v3 r2 P2-3 / P2-4, frame 1b) ─────────────────────────────────────────────
// canDraw(): protocol v3 for THIS child document, the map ready and not failed, a drawable pin picked, the zones editable (the lock open),
// below the zones cap (a NEW zone only — editing adds none), and nothing frozen (no outstanding attempt, no conflict, a readable policy).
// It gates «Dibujar zona», an edit_request, and every commit.
// Codex #206 — ONE focus rule for every session transition: the focused control is noted before the repaint; if the repaint hid, removed
// or disabled it, the focus moves to the transition's target (a control the transition leaves visible). Focus elsewhere — the map frame,
// another card — is never moved. Codex #208: judged and resolved from the FINAL DOM — after the whole synchronous repaint (an adoption's
// render() rebuilds the list after its endDrawing), the target re-queried by its stable key (a zone id, the page's current refs).
// hidden BY THIS PAGE: a `.hidden` ancestor inside the envio root (the shell's own wrappers are not the page's business)
const hiddenHere = (el) => { const h = el.closest('.hidden'); return !!h && !!S.root && S.root.contains(h); };
function transition(paint, target) {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  paint();
  if (!a || a === document.body) return;
  Promise.resolve().then(() => {   // a microtask: after the whole synchronous repaint
    const now = document.activeElement;
    if (now !== a && now !== document.body) return;   // the person moved the focus meanwhile
    if (a.isConnected && !hiddenHere(a) && a.disabled !== true) return;   // still a usable control: nothing lost
    const t = target();
    if (t && t.isConnected && !hiddenHere(t) && !t.disabled) t.focus();
  });
}
const zoneBtn = (id, title) => { const row = S.refs && [...S.refs.zonesList.querySelectorAll('.zrow')].find((x) => x.dataset.zone === id); return row ? row.querySelector(`button.ib[title="${title}"]`) : null; };
function canDraw(isNew = true) {
  const m = S.map, z = S.zones, p = pickedEntry();
  return !!(m && m.v3 && m.ready && !m.failed && globalThis.ZoneShape && p && p.hub && z && z.zones !== null && z.editable && z.caps
    && (!isNew || (S.zonesDraft || []).length < z.caps.zones_max) && !frozen());
}
function startDrawing() {
  if (S.drawing || !canDraw()) return;
  let session;
  try { session = MP.newMountId(window.crypto); } catch (_) { return; }   // 16 random bytes, the mount id's own minting
  S.drawing = { session, zone: null, points: [], seq: 0, ack: null, request: null, closed: false, line: null, name: '' };
  // the list follows the session (rename / remove off) — paintZones paints the draw state too; «Dibujar zona» hides: the tool line takes the focus
  transition(() => { paintZones(); postRender('keep'); }, () => S.refs && S.refs.drawCancel);
}
// draft_points (r1 §4–§5, r2 P2-6): only for the live session and a higher seq; a WHOLE list replaces the session's points (never the
// draft). Coalesced: the latest pending message is applied at most once per animation frame and 30 times a second per mount (beyond
// that, dropped until the next second — safe: whole lists, and the commit never depends on them). Re-validated when applied.
const nextFrame = (f) => (typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(f) : setTimeout(f, 16));
const dropFrame = (h) => { if (h === null) return; if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(h); clearTimeout(h); };
const livePoints = (msg) => { const d = S.drawing; return !!(d && !d.closed && msg.session === d.session && msg.seq > d.seq); };
function queuePoints(m, msg) {
  if (!livePoints(msg) || (m.pending && m.pending.seq >= msg.seq)) return;
  m.pending = msg;
  if (m.frameReq === null) m.frameReq = nextFrame(() => flushPoints(m));
}
function flushPoints(m) {
  m.frameReq = null;
  const msg = m.pending; m.pending = null;
  if (!msg || S.map !== m || !livePoints(msg)) return;
  const now = Date.now();
  if (now - m.rateT >= 1000) { m.rateT = now; m.rateN = 0; }
  if (m.rateN >= 30) return;
  m.rateN += 1;
  S.drawing.points = msg.points.map((q) => ({ lat: q.lat, lng: q.lng })); S.drawing.seq = msg.seq;
  paintDraw(); postRender('keep');
}
// the shape a finish proposes, judged by THE server's check (the synced zone-shape.js, input normalization then stored validation) →
// null (the server would take it) | the problem's approved line key (envio-map-protocol ACK_LINES)
function shapeLine(points) {
  const ZS = globalThis.ZoneShape;
  if (points.length < ZS.CAPS.points_min) return 'min_points';
  if (points.length > ZS.CAPS.points_max) return 'max_points';
  const pr = ZS.pointsProblem(points.map((q) => ZS.normalizePoint(q)));
  if (!pr) return null;
  return pr.problem === 'zone_out_of_range' ? 'out_of_range' : pr.problem === 'zone_caps' ? 'too_big' : 'self_cross';
}
const LINE_COPY = { min_points: 'drawMin', self_cross: 'drawCross', max_points: 'pointsCapTool', too_big: 'drawBig' };   // out_of_range: the frame-F panel
// finish (r3 #181-6, r4): NEVER coalesced — applied on receipt, superseding the session's pending draft_points. The first finish for
// (session, seq) runs ONE transition: refused ⇒ the session stays open with its line (ack rejected); taken ⇒ a new zone waits for its
// name (ack accepted; nothing in the draft before «Listo»). A duplicate re-sends the SAME ack (never a second change); a finish for an
// ended session gets a render saying there is no session — both at most once per 250 ms per mount.
function reAck(m) {
  const now = Date.now();
  if (now - (m.ackT || 0) < 250) return;
  m.ackT = now; postRender('keep');
}
function onFinish(m, msg) {
  const d = S.drawing;
  if (!d || msg.session !== d.session) { reAck(m); return; }
  if (d.ack && d.ack.seq === msg.seq) { reAck(m); return; }
  if (d.closed || msg.seq <= d.seq) return;
  clearTimeout(d.reqT);   // a pending draft_points needs no cancelling: re-validated at its flush (the shape closed, or a lower seq), it is dropped
  d.points = msg.points.map((q) => ({ lat: q.lat, lng: q.lng })); d.seq = msg.seq; d.request = null;
  const line = shapeLine(d.points);
  d.ack = line ? { session: d.session, seq: msg.seq, outcome: 'rejected', line } : { session: d.session, seq: msg.seq, outcome: 'accepted' };
  d.line = line;
  // r2 P2-7: beyond |lat| 60 (not reachable in practice) the backstop is the frame-F refusal panel, not an inline line; a later finish clears it
  if (S.zonesFail && S.zonesFail.drawn) S.zonesFail = null;
  if (line === 'out_of_range') S.zonesFail = { kind: 'refused', key: 'zones.invalid', zoneId: d.zone, drawn: true };
  if (S.refs) paintBanner();
  if (!line && d.zone !== null) {
    // EDITING commits on its finish (the drag end): that zone's points in the draft, ONCE — the session ends (a late duplicate meets no
    // session and only gets the render saying so); re-checked at the commit
    if (!canDraw(false)) { endDrawing(); return; }
    const ZS = globalThis.ZoneShape;
    const points = d.points.map((q) => { const g = ZS.normalizePoint(q); return { lat: g[0], lng: g[1] }; });
    S.zonesDraft = S.zonesDraft.map((z) => (z.id === d.zone ? { ...z, points } : z));
    clearTimeout(d.reqT); S.drawing = null;
    transition(() => { afterEdit(); paintDraw(); }, () => zoneBtn(d.zone, 'Renombrar'));
    return;
  }
  if (!line) d.closed = true;
  // a new zone closed: the tool line hides — a focus there moves to the naming input
  transition(() => { paintDraw(); paintZones(); postRender('keep'); }, () => S.refs && S.refs.zonesList.querySelector('.zrow.editing input'));
}
// «Listo» (note 13): the named zone joins the draft ONCE — a client-minted id (the server's pattern, unique in the draft), the points on
// the 6-decimal grid; the session ends. Re-checked at the commit: a predicate gone false ends the session as «Cancelar»
function mintZoneId() {
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const id = `z_${Array.from(window.crypto.getRandomValues(new Uint8Array(8)), (b) => A[b % 36]).join('')}`;
    if (!(S.zonesDraft || []).some((z) => z.id === id)) return id;
  }
}
function commitDrawn() {
  const d = S.drawing;
  if (!d || !d.closed) return;
  if (!canDraw()) { endDrawing(); return; }
  const { name, line } = zoneNameLine(d.name, null);
  if (line) return;
  const ZS = globalThis.ZoneShape;
  const points = d.points.map((q) => { const g = ZS.normalizePoint(q); return { lat: g[0], lng: g[1] }; });
  const id = mintZoneId();
  S.zonesDraft = [...(S.zonesDraft || []), { id, name, points }];
  clearTimeout(d.reqT); S.drawing = null;
  transition(() => { afterEdit(); paintDraw(); }, () => zoneBtn(id, 'Renombrar'));   // the naming row goes: the new zone's own row
}
// the portal's «Terminar» (r2 P2-6): it never closes anything itself — it asks the map for its finish (the final whole list) and waits
// ≤ TIMING.finishMs; unanswered, the request is withdrawn and the session stays open with no change
function requestFinish() {
  const d = S.drawing;
  if (!d || d.closed) return;
  d.request = 'finish';
  clearTimeout(d.reqT);
  d.reqT = setTimeout(() => { if (S.drawing === d && d.request) { d.request = null; postRender('keep'); } }, TIMING.finishMs);
  postRender('keep');
}
// EDITING (r2 P2-3): the map ASKS (a tap on a drawn zone's outline); the portal opens a session only under the predicate, only for a zone
// the draft holds, and only when none is open — the map never edits a zone the portal has not opened
function startEditing(id) {
  const zone = (S.zonesDraft || []).find((z) => z.id === id);
  if (S.drawing || !zone || !canDraw(false)) return;
  let session;
  try { session = MP.newMountId(window.crypto); } catch (_) { return; }
  S.drawing = { session, zone: id, points: zone.points.map((q) => ({ lat: q.lat, lng: q.lng })), seq: 0, ack: null, request: null, closed: false, line: null, name: '' };
  transition(() => { paintZones(); postRender('keep'); }, () => S.refs && S.refs.drawCancel);
}
// «Cancelar» (and every end that commits nothing): the session goes — with any coalesced message — and the draft is untouched. The list
// follows (Codex #204 P2-2); a focus the end hides moves to «Dibujar zona» (an edit: that zone's «Renombrar») — the one rule (#206)
function endDrawing() {
  const d = S.drawing;
  if (!d) return;
  clearTimeout(d.reqT);
  S.drawing = null;
  if (S.zonesFail && S.zonesFail.drawn) S.zonesFail = null;   // a drawn shape's frame-F panel goes with its session
  if (S.map) { S.map.pending = null; dropFrame(S.map.frameReq); S.map.frameReq = null; }
  transition(() => { paintZones(); if (S.refs) paintBanner(); postRender('keep'); }, () => (d.zone !== null ? zoneBtn(d.zone, 'Renombrar') : S.refs && S.refs.zonesDraw));
}
function paintDraw() {
  // r2 P2-4: the predicate is re-checked on every repaint (every map, read, save or lock change reaches here) — false mid-session ⇒ the
  // session ends as «Cancelar» (a new zone keeps its cap rule; an edit has none). ONE place: no path ends a session on its own.
  if (S.drawing && !canDraw(S.drawing.zone === null)) { endDrawing(); return; }
  const r = S.refs;
  if (!r || !r.mtool) return;
  const on = !!S.drawing;
  const full = on && S.drawing.points.length >= MP.ZONE_LIMITS.points;   // addendum G: the 24th point — the hint counts, the tool line says the cap
  // Codex #204 P3-2: EDITING says what editing does (drag a point; a drag end saves it to the draft) — never the drawing instructions
  const editing = on && S.drawing.zone !== null;
  const ez = editing ? (S.zonesDraft || []).find((z) => z.id === S.drawing.zone) : null;
  const hint = !on ? null : editing ? EL.zonesCopy('editHint', { nombre: ez ? ez.name : '' }) : full ? EL.zonesCopy('pointsCap') : COPY.drawingHint;
  r.mapHint.replaceChildren(...(on ? [document.createTextNode(hint)] : [ic('ring'), document.createTextNode(COPY.mapHint)]));
  r.drawNote.textContent = editing ? EL.zonesCopy('editTool') : full ? EL.zonesCopy('pointsCapTool') : COPY.drawTool;
  r.drawFinish.classList.toggle('hidden', editing);   // a drag end commits an edit: nothing to «Terminar»
  r.mapHint.classList.toggle('drawhint', on);
  r.map.classList.toggle('drawing', on);
  r.mtool.classList.toggle('hidden', !on || S.drawing.closed);
  const line = on && S.drawing.line && S.drawing.line !== 'out_of_range' ? EL.zonesCopy(LINE_COPY[S.drawing.line]) : null;   // out_of_range: frame F (onFinish)
  if (line) { r.drawLine.textContent = line; if (!r.drawLine.isConnected) r.mtool.after(r.drawLine); } else r.drawLine.remove();
  r.zonesDraw.classList.toggle('hidden', on);
  r.zonesDraw.disabled = !canDraw();
  r.pickFld.classList.toggle('dim', on);
  for (const n of r.dimmed) n.classList.toggle('dim', on);
  r.pick.disabled = on || !S.entries.length;
}
function paintMapBox() {
  const r = S.refs;
  if (!r) return;
  const p = pickedEntry();
  let line = null;
  if (S.branchesUnavailable && !S.entries.length) line = COPY.noBranches;
  else if (p && !p.hub) line = COPY.noPin;
  else if (S.map && S.map.failed) line = COPY.mapFail;
  r.mapLine.textContent = line || '';
  r.mapLine.classList.toggle('hidden', !line);
  r.map.classList.toggle('nomap', !!line);
  r.mstyle.classList.toggle('hidden', !!line);   // no map, no style control
  paintStyle();
  r.mapCap.textContent = !line && p && p.hub ? COPY.mapCap(p.label, pickedReach()) : '';
  r.mapCap.classList.toggle('hidden', !!line || !(p && p.hub));
  if (p && p.hub && S.status === 'ready' && !S.map) { setTimeout(() => { if (S.root && !S.map) startMap(r.map); }, 0); }
}

function paintPicker() {
  const r = S.refs;
  const p = pickedEntry();
  r.pickName.textContent = p ? p.label : COPY.pickLab;
  r.pickSub.textContent = p ? p.sub : '';
  r.pick.disabled = !!S.drawing || !S.entries.length;   // Z2: the picker is off while drawing (paintDraw)
  r.pick.setAttribute('aria-expanded', S.picker ? 'true' : 'false');
  r.pickChev.textContent = S.picker ? '▴' : '▾';
  r.menu.classList.toggle('hidden', !S.picker);
  if (S.picker) paintMenu();
}
function openBranchPicker() {
  S.picker = { q: '', hi: 0 };
  const r = S.refs;
  const search = el('div', 'psearch');
  const inp = el('input'); inp.placeholder = COPY.search; inp.setAttribute('aria-label', COPY.search); inp.autocomplete = 'off';
  // Codex r1 F8: a combobox that owns a listbox; the highlighted option is announced through aria-activedescendant
  inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-expanded', 'true'); inp.setAttribute('aria-autocomplete', 'list');
  inp.setAttribute('aria-controls', 'envplist');
  search.append(ic('search'), inp);
  r.pinput = inp;
  r.plist = el('div', 'plist'); r.plist.id = 'envplist'; r.plist.setAttribute('role', 'listbox'); r.plist.setAttribute('aria-label', COPY.pickLab);
  r.pmore = el('div', 'pmore hidden');
  r.menu.replaceChildren(search, r.plist, r.pmore);
  inp.addEventListener('input', () => { S.picker.q = inp.value; S.picker.hi = 0; paintMenu(); });
  inp.addEventListener('keydown', (e) => {
    const f = EL.filterEntries(S.entries, S.picker.q, S.pick);
    if (e.key === 'ArrowDown') { e.preventDefault(); S.picker.hi = Math.min(S.picker.hi + 1, f.shown.length - 1); paintMenu(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.picker.hi = Math.max(S.picker.hi - 1, 0); paintMenu(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = f.shown[S.picker.hi]; if (it) choose(it.rid); }
    else if (e.key === 'Escape') { e.preventDefault(); closeBranchPicker(true); }
  });
  paintPicker();
  inp.focus();
}
function paintMenu() {
  const r = S.refs;
  const f = EL.filterEntries(S.entries, S.picker.q, S.pick);
  r.plist.replaceChildren(...(f.empty ? [el('div', 'pmore pnone', f.empty)] : f.shown.map((e, i) => {
    const b = el('button', `pitem${e.current ? ' pcur' : ''}${i === S.picker.hi ? ' phi' : ''}`);
    b.type = 'button'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', e.current ? 'true' : 'false');
    b.id = `envopt-${i}`; b.tabIndex = -1;
    const pt = el('span', 'pt', e.name);
    if (e.loc) pt.append(document.createTextNode(' '), el('span', null, `· ${e.loc}`));
    b.append(el('span', 'pi', e.initial), pt);
    if (e.current) b.append(ic('check'));
    b.addEventListener('click', () => choose(e.rid));
    return b;
  })));
  r.pmore.textContent = f.more || '';
  r.pmore.classList.toggle('hidden', !f.more);
  if (f.shown.length && !f.empty) r.pinput.setAttribute('aria-activedescendant', `envopt-${Math.min(S.picker.hi, f.shown.length - 1)}`);
  else r.pinput.removeAttribute('aria-activedescendant');
}
function closeBranchPicker(refocus) {
  S.picker = null;
  paintPicker();
  if (refocus) S.refs.pick.focus();
}
function choose(rid) {
  S.pick = rid;
  closeBranchPicker(true);
  paintMax();   // the field follows the picked branch's restaurant (found by Codex HIGH r1 P1's cell: it kept the previous restaurant's)
  paintMapBox();
  postRender('reset');
}

function paintBar() {
  const r = S.refs;
  const L0 = S.loaded;
  if (!L0 || S.banner === 'conflict' || L0.kind === 'unreadable' || (L0.kind === 'malformed' && !L0.canSave)) { r.bar.classList.remove('show'); return; }
  const bar = barState();
  const malformedValid = L0.kind === 'malformed' && EL.validate(S.rows).valid && !limitInvalid();
  const show = bar.state !== 'clean' || malformedValid || !!S.attempt;
  r.bar.classList.toggle('show', show);
  r.barDot.classList.toggle('ered', bar.state === 'invalid');
  r.barText.textContent = bar.state === 'invalid' ? bar.text : EL.COPY.dirty;
  if (bar.state !== 'invalid' && zonesDirty()) { const sx = EL.zonesBarSuffix(S.zonesDraft, S.zones.zones); const sp = el('span'); sp.append(' \u00b7 ', phText(sx.dk, sx.ph)); r.barText.append(sp); }   // ENVÍO step 2: the zones' share
  r.save.disabled = !!S.attempt || !(bar.canSave || malformedValid);
  r.discard.disabled = attemptUnresolved();
}

// ENVÍO v3 (A5 note): the bar covers bands AND limits; an invalid band keeps step 1's «Corregí …»; an invalid field holds Guardar under
// «Cambios sin guardar» (the field shows its own line — no new bar text)
function barState() {
  const L0 = S.loaded;
  const bar = EL.saveBar(S.rows, L0 && L0.kind === 'policy' ? L0.bands : []);
  if (bar.state === 'invalid') return bar;
  if (limitInvalid()) return { state: 'dirty', text: EL.COPY.dirty, canSave: false };
  if (bar.state === 'clean' && limitDirty()) return { state: 'dirty', text: EL.COPY.dirty, canSave: true };
  if (bar.state === 'clean' && zonesDirty()) return { state: 'dirty', text: EL.COPY.dirty, canSave: true };   // ENVÍO step 2
  return bar;
}
function paintConfirm() {
  const r = S.refs;
  if (!S.confirm) { closeEnvioLayer(); return; }
  const busy = S.phase === 'sending' || S.phase === 'recovering';
  if (r.layer.firstChild && r.confirmSave) { r.confirmSave.disabled = busy; r.confirmSave.setAttribute('aria-busy', busy ? 'true' : 'false'); r.confirmBack.disabled = busy; return; }
  const d = EL.confirmDiff(S.confirm.was, S.confirm.body.bands);
  const scrim = el('div', 'scrim show');
  const m = el('div', 'modal'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'envctitle');
  const head = el('div', 'mhead'); const h2 = el('h2', null, COPY.cTitle); h2.id = 'envctitle';
  const lp = el('p'); lp.append(phText(COPY.cLede, COPY.cLedePh));
  head.append(h2, lp);
  const body = el('div', 'mbody');
  const blk = el('div'); blk.append(el('div', 'elab', COPY.cTramos));
  const list = el('div', 'edrows');
  for (const row of d.rows) {
    const dr = el('div', 'edrow');
    const v = el('span', 'v');
    if (row.tag === 'Cambia') v.append(el('span', 'dwas', L(row.was)), document.createTextNode(L(row.now)));
    else if (row.tag === 'Quitado') v.append(el('span', 'dwas', L(row.was)));
    else v.textContent = L(row.now);
    const chip = { Igual: 'esame', Cambia: 'echg', Nuevo: 'enew', Quitado: 'edel' }[row.tag];
    dr.append(el('span', 'k', `Hasta ${row.km} km`), v, el('span', `echip ${chip}`, row.tag));
    list.append(dr);
  }
  blk.append(list);
  body.append(blk);
  // ENVÍO v3 A3: «Distancia máxima por restaurante» — one row per branch whose maximum moved (was → now, «Cambia»)
  if (S.confirm.limitRows.length) {
    const lb = el('div'); lb.append(el('div', 'elab', COPY.cLimits));
    const ll = el('div', 'edrows');
    for (const row of S.confirm.limitRows) {
      const dr = el('div', 'edrow');
      const v = el('span', 'v');
      if (row.was !== null) v.append(el('span', 'dwas', `${row.was} km`));
      v.append(document.createTextNode(`${row.now} km`));
      dr.append(el('span', 'epi', String(row.label || '').charAt(0).toUpperCase()), el('span', 'k', row.label), v, el('span', 'echip echg', 'Cambia'));   // SBS 11-13: the mockup's initial
      ll.append(dr);
    }
    lb.append(ll);
    body.append(lb);
  }
  // the step-1 table-top callout stays as approved; a v3 limit callout leads with its own sentence in bold (MOCKUP-portal-envio-v3 A3)
  const limitLines = new Set(S.confirm.limitCallouts);
  const lines = [...(EL.limitCallout(d.limit, S.restaurants) || []), ...S.confirm.limitCallouts];
  for (const line of lines) {
    const c = el('div', 'ecallout');
    const t = el('div');
    const cut = limitLines.has(line) ? line.indexOf('. ') : -1;
    if (cut > 0) t.append(el('b', null, line.slice(0, cut + 1)), document.createTextNode(line.slice(cut + 1)));
    else t.textContent = line;
    c.append(ic('info'), t);
    body.append(c);
  }
  const foot = el('div', 'mfoot');
  const back = () => { S.confirm = null; render(); if (S.refs) S.refs.save.focus(); };
  r.confirmBack = button('btn ghost', COPY.cBack, back);
  r.confirmSave = button('btn accent', COPY.cSave, startSave);
  r.confirmSave.disabled = busy;
  foot.append(r.confirmBack, r.confirmSave);
  m.append(head, body, foot);
  scrim.append(m);
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !(S.phase === 'sending' || S.phase === 'recovering')) { back(); return; }
    if (e.key === 'Tab') wrapEnvioConfirmTab(e, m);
  });
  r.layer.replaceChildren(scrim);
  inertEnvioBackground(r.layer);
  r.confirmBack.focus();
}

// ── registration ────────────────────────────────────────────────────────────────────────────────────────────────────────
registerView({
  id: 'envio',
  group: 'Sherpa',
  admin: true,
  label: 'Envío',
  icon: NAV_ICON,
  visible: (sel) => !!sel && sel.platform_admin === true,
  revoke,
  mount(host, sel) {
    bump();
    const otherUser = sel.uid !== S.uid;
    if (otherUser) { S.attempt = null; S.phase = null; }
    S.uid = sel.uid;
    S.host = host;
    S.root = el('div', 'envio');
    host.replaceChildren(S.root);
    S.refs = null;
    // Codex r1 F3: an attempt kept from before leaving shows with its own draft and is reconciled FIRST (a fresh GET)
    const held = S.attempt && S.attempt.uid === S.uid && S.loaded ? S.attempt : null;
    const cached = S.uid ? store.get(CACHE(S.uid)) : null;
    if (held) S.status = 'ready';
    // #179 P2-1: a draft left on a link out survives (the same adoption path; another admin ⇒ discard)
    else if (cached) { applyRead(cached, { discard: otherUser, cached: true }); S.status = 'ready'; } else { S.status = 'loading'; resetRowsTo(null); }
    render();
    load();
    if (held && S.phase !== 'not_landed') recover(held);
  },
  unmount() {
    bump();
    dropPage();
    // Codex r1 F3: an attemptUnresolved attempt outlives the view for this session. Codex #179 (advisor 11-19, ONE rule): so does an unsent
    // draft — fees, limits and zones are kept (S.rows / S.limitEdits / S.zonesDraft) and re-adopted through applyRead at the next mount,
    // on their CAS base version (S.loaded), shown by the «Sin guardar» bar; the confirm, picker and note are per visit
    S.confirm = null; S.picker = null; S.note = null;
    if (!S.attempt) { S.phase = null; S.banner = null; }
    if (S.host) S.host.replaceChildren();
    S.host = null; S.root = null; S.status = 'idle';
  },
  canLeave: () => !S.attempt && !limitDirty() && !limitInvalid() && !feesDirty() && !zonesDirty(),   // #179 P2-1: an unsent zones draft holds it too
  // Codex r2 F3: an attempt kept while the view is unmounted holds the shell's reload guard (selection / self-update)
  pending: () => !!S.attempt,
});

export const _envioState = S;   // test-only view of the state (never read by the page)
export const _envioTiming = TIMING;   // test-only: the suite shortens the 8 s deadline (the page never writes it)
