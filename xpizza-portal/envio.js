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
import { registerView, toast } from './shell.js';
import { token } from './auth.js';
import { getDeliveryPricingRaw, setDeliveryPricingRaw } from './api.js';
import { el, svg, button, OFFLINE } from './ops-dom.js';
import * as EL from './envio-logic.js';
import * as MP from './envio-map-protocol.js';

const CACHE = (uid) => `sherpa.portal.envio.${uid}`;
const TIMING = { deadlineMs: 8000 };   // the map's absolute load deadline (Codex r1 F7); tests shorten it through _envioTiming
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
});
const ic = (k) => svg(...I[k]);
const COPY = Object.freeze({
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
  maxMulti: (n) => ` Aplica a sus ${n} sucursales, desde el pin de cada una.`, maxCapPh: (top) => ` Máximo ${top} km.`,
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
  S.banner = null; S.attempt = null; S.phase = null; S.confirm = null; S.picker = null; S.status = 'idle'; S.floor = 0;
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
function adoptBody(b) {
  S.loaded = EL.loadedState(b);
  raiseFloor(bodyVersion(b));
  S.branchesUnavailable = !Array.isArray(b.branches);
  S.branchesRaw = Array.isArray(b.branches) ? b.branches : [];
  S.restaurants = EL.restaurantsOf(S.branchesRaw);
  S.limitEdits = {};
  S.rows = EL.rowsFromBands(S.loaded.kind === 'policy' ? S.loaded.bands : []);
  refreshEntries();
  if (!S.pick || !S.entries.some((e) => e.rid === S.pick)) S.pick = EL.defaultPick(S.entries);
  S.note = null;
}
// ── ENVÍO v3: the restaurant's maximum distance (PLAN r5 §1, §1d) ──
// the table's top as EDITED (the last drawable band), the per-branch pending set, and the picker lines that follow both
function curTop() { const ok = EL.mapBands(S.rows || []).filter((b) => b.ok); return ok.length ? ok[ok.length - 1].km : null; }
const pendingNow = () => EL.pendingLimits(S.restaurants, S.limitEdits, curTop());
const limitDirty = () => Object.keys(pendingNow()).length > 0;
// an edited field with a line holds Guardar (the field shows the line; no other text)
const limitInvalid = () => S.restaurants.some((r) => Object.prototype.hasOwnProperty.call(S.limitEdits, r.key) && !!EL.limitProblem(S.limitEdits[r.key], curTop()));
function refreshEntries() {
  const p = pendingNow();
  S.entries = EL.pickerEntries(S.branchesRaw.map((b) => (Object.prototype.hasOwnProperty.call(p, b.rid) ? { ...b, max_km: p[b.rid], limit_invalid: false } : b)), curTop());
}
const pickedRestaurant = () => S.restaurants.find((r) => r.rids.includes(S.pick)) || null;
async function load({ fresh } = {}) {
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
  const keepDraft = !fresh && (S.attempt || limitDirty() || limitInvalid() || (S.rows && S.loaded && S.loaded.kind === 'policy' && EL.isDirty(S.rows, S.loaded.bands)));
  if (keepDraft) {
    // the draft wins on screen; the CAS catches a newer server version at save. The directory still refreshes.
    S.branchesUnavailable = !Array.isArray(res.body.branches);
    S.branchesRaw = Array.isArray(res.body.branches) ? res.body.branches : S.branchesRaw;
    refreshEntries();
  } else {
    adoptBody(res.body);
    if (fresh) S.banner = null;
  }
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
  const body = EL.toBody(S.rows, S.loaded.version, EL.limitsFor(pending));
  const was = S.loaded.kind === 'policy' ? S.loaded.bands.map((b) => ({ ...b })) : [];
  const loadedTop = was.length ? was[was.length - 1].max_km : null;
  const changes = EL.limitChanges(S.restaurants, pending, loadedTop);
  S.confirm = Object.freeze({ body: Object.freeze({ expected_policy_version: body.expected_policy_version, bands: Object.freeze(body.bands.map((b) => Object.freeze({ ...b }))),
    ...(body.limits ? { limits: Object.freeze(body.limits.map((e) => Object.freeze({ ...e }))) } : {}) }), was: Object.freeze(was),
  limitRows: Object.freeze(changes.rows.map((r) => Object.freeze({ ...r }))), limitCallouts: Object.freeze([...changes.callouts]) });
  render();
}
function startSave() {
  const c = S.confirm;
  if (S.attempt || !c) return;
  S.attempt = EL.startAttempt({ uid: S.uid, sessionGen: S.gen, expectedVersion: c.body.expected_policy_version, bands: c.body.bands, limits: c.body.limits || [] });
  send(S.attempt);
}
async function send(attempt) {
  const g = snap();
  S.phase = 'sending'; S.banner = null; render();
  let res;
  try {
    res = await setDeliveryPricingRaw({ token, assertLive: g.assertLive, body: { expected_policy_version: attempt.expectedVersion, bands: attempt.sentBands, ...(attempt.sentLimits.length ? { limits: attempt.sentLimits } : {}) } });
  } catch (err) {
    if (!g.alive() || S.attempt !== attempt) return;
    // withheld before sending (no token / obsolete): nothing landed
    const wasOpen = !!S.confirm;
    S.phase = 'not_landed'; S.banner = 'error'; S.confirm = null; render(); if (wasOpen) focusAfterEnvioClose(); return;
  }
  if (!g.alive() || S.attempt !== attempt) return;
  // Codex r1 F2: only the clean success contract is final; anything else is resolved by a fresh GET (the claim is kept as a hint)
  if (EL.classifyPost(attempt, res) === 'saved') { outcome(attempt, 'saved'); return; }
  lastClaim = { attempt, claim: EL.postClaim(res) };
  recover(attempt);
}
// the POST's claim stays with ITS attempt, so a «Reintentar» after a failed recovery GET still reads it
let lastClaim = { attempt: null, claim: null };
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
      const version = attempt.expectedVersion + 1;
      raiseFloor(version);
      S.loaded = { kind: 'policy', version, bands: attempt.sentBands.map((b) => ({ ...b })) };
      S.rows = EL.rowsFromBands(S.loaded.bands);
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
      toast(COPY.saved);
      return;
    }
    case 'superseded': case 'conflict':
      S.attempt = null; S.phase = null; S.banner = 'conflict';
      S.rows = EL.rowsFromBands(S.loaded && S.loaded.kind === 'policy' ? S.loaded.bands : []);
      render(); return;
    case 'current_malformed':
      S.attempt = null; S.phase = null; S.banner = null;
      load({ fresh: true }); return;
    case 'forbidden': revoke(); return;
    case 'refused': case 'unauthenticated':
      if (o === 'refused') console.warn('envio save: refused');
      S.attempt = null; S.phase = null; S.banner = 'error'; render(); return;
    case 'not_landed': S.phase = 'not_landed'; S.banner = 'error'; render(); return;
    case 'unknown': S.phase = 'unknown'; S.banner = 'error'; render(); return;
    default: S.phase = 'unknown'; S.banner = 'error'; render();
  }
}
function retry() {
  const a = S.attempt;
  if (!a) { S.banner = null; render(); return; }
  if (S.phase === 'not_landed') send(a);
  else if (S.phase === 'unknown') recover(a);
}
// Codex r1 F3: only a RESOLVED state can be discarded — no attempt, or one a fresh GET proved never landed (not_landed)
const attemptUnresolved = () => !!S.attempt && S.phase !== 'not_landed';
function discard() {
  if (attemptUnresolved()) return;
  bump();   // a late answer for a request of the dropped state is ignored (the map has its own lifetime: F6)
  S.attempt = null; S.phase = null; S.banner = null; S.confirm = null; S.note = null;
  S.rows = EL.rowsFromBands(S.loaded && S.loaded.kind === 'policy' ? S.loaded.bands : []);
  render();
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
  return MP.renderMessage({ mount: S.map.mount, view, theme: themeNow(), hub: p && p.hub ? { lat: p.hub.lat, lng: p.hub.lng } : null,
    name: p ? p.label.slice(0, MP.LIMITS.name) : '', others, bands, mapType: S.mapType, limit });
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
  paintMapBox();
}
function startMap(box) {
  if (S.map || typeof window === 'undefined') return;
  let mount;
  try { mount = MP.newMountId(window.crypto); } catch (_) { return; }
  // Codex r1 F6: the frame's listener lives as long as THIS frame (S.map === m), not as long as one request generation: a
  // discard / reload bumps the generation, the map stays; every session end (sign-out, revocation, unmount) stops the frame
  const m = { frame: null, mount, deadline: null, listening: false, ready: false, failed: false, onMsg: null, postedPick: undefined };
  m.onMsg = (event) => {
    if (S.map !== m || !S.root) return;
    const msg = MP.acceptFromChild(event, { frameWindow: m.frame && m.frame.contentWindow, mount });
    if (!msg) return;
    if (msg.kind === 'listening') { m.listening = true; postRender('reset'); return; }   // never clears the deadline
    if (msg.kind === 'ready') { if (m.failed) return; m.ready = true; clearTimeout(m.deadline); paintMapBox(); return; }
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
  m.deadline = setTimeout(() => mapFailed('timeout'), TIMING.deadlineMs);   // absolute, from load start
  f.src = `${MP.MAP_ORIGIN}/map.html#m=${mount}`;
  box.append(f);
}
function stopMap() {
  const m = S.map;
  if (!m) return;
  S.map = null;
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
  paintBanner(); paintBands(); paintPicker(); paintMax(); paintMapBox(); paintLegend(); paintBar(); paintConfirm();
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
  left.append(sb, callout);
  // map
  const sm = el('section', 'esec envmap');
  const mh = el('h3', null, COPY.mapH); const mhint = el('span', 'ehint'); mhint.append(ic('ring'), document.createTextNode(COPY.mapHint)); mh.append(mhint);
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
  sm.append(mh, fld, refs.max, refs.map, refs.legend, refs.mapNote);
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
    const r = button('btn', COPY.reload, () => { S.banner = null; load({ fresh: true }); });
    r.prepend(ic('reload'));
    box = errbox(COPY.conflictT, COPY.conflictP, r);
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
function afterEdit() { refreshEntries(); paintBands(); paintPicker(); paintMax(); paintMapBox(); paintLegend(); paintBar(); postRender('keep'); }
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
  R0.maxNoteT.textContent = capped ? COPY.capped(top, r.stored) : '';
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
  r.pick.disabled = !S.entries.length;
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
      dr.append(el('span', 'k', row.label), v, el('span', 'echip echg', 'Cambia'));
      ll.append(dr);
    }
    lb.append(ll);
    body.append(lb);
  }
  const lines = [...(EL.limitCallout(d.limit, S.restaurants) || []), ...S.confirm.limitCallouts];
  for (const line of lines) {
    const c = el('div', 'ecallout');
    const t = el('div', null, line);
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
    if (sel.uid !== S.uid) { S.attempt = null; S.phase = null; }
    S.uid = sel.uid;
    S.host = host;
    S.root = el('div', 'envio');
    host.replaceChildren(S.root);
    S.refs = null;
    // Codex r1 F3: an attempt kept from before leaving shows with its own draft and is reconciled FIRST (a fresh GET)
    const held = S.attempt && S.attempt.uid === S.uid && S.loaded ? S.attempt : null;
    const cached = S.uid ? store.get(CACHE(S.uid)) : null;
    if (held) S.status = 'ready';
    else if (cached) { adoptBody(cached); S.status = 'ready'; } else { S.status = 'loading'; S.rows = [{ km: '', fee: '' }]; }
    render();
    load();
    if (held && S.phase !== 'not_landed') recover(held);
  },
  unmount() {
    bump();
    dropPage();
    // Codex r1 F3: an attemptUnresolved attempt (and its draft) outlives the view for this session; everything else is per visit
    S.confirm = null; S.picker = null; S.note = null;
    if (!S.attempt) { S.phase = null; S.banner = null; }
    if (S.host) S.host.replaceChildren();
    S.host = null; S.root = null; S.status = 'idle';
  },
  canLeave: () => !S.attempt && !limitDirty() && !limitInvalid() && !(S.rows && S.loaded && S.loaded.kind === 'policy' && EL.isDirty(S.rows, S.loaded.bands)),
  // Codex r2 F3: an attempt kept while the view is unmounted holds the shell's reload guard (selection / self-update)
  pending: () => !!S.attempt,
});

export const _envioState = S;   // test-only view of the state (never read by the page)
export const _envioTiming = TIMING;   // test-only: the suite shortens the 8 s deadline (the page never writes it)
