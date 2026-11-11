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
  pin: ['M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z', { tag: 'circle', cx: 12, cy: 10, r: 2.5 }],
  search: [{ tag: 'circle', cx: 11, cy: 11, r: 7 }, 'M20 20l-3.5-3.5'],
  check: ['M5 12l5 5 9-10'],
  reload: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
});
const ic = (k) => svg(...I[k]);
const COPY = Object.freeze({
  h1: 'Envío', pill: 'Área de Sherpa',
  lede: 'Una sola tarifa por distancia para todos los restaurantes. La paga el cliente en la app de Sherpa; se mide en línea recta desde el pin de cada sucursal.',
  ledePh: 'Una sola tarifa por distancia para todos los restaurantes. Se mide en línea recta desde el pin de cada sucursal.',
  bandsH: 'Tarifa por distancia', bandsHint: 'Igual para todos los restaurantes', hasta: 'Hasta', tarifa: 'Tarifa', add: 'Agregar tramo',
  limit: 'Límite de entrega', limitAll: '· el último tramo', limitValid: '· el último tramo válido',
  help: 'Los tramos van de menor a mayor distancia, en lempiras enteros. Hasta 20 tramos, hasta 10 km y hasta L 150 por tramo. Más allá del último tramo no se entrega.',
  helpPh: 'De menor a mayor distancia, lempiras enteros. Hasta 20 tramos, 10 km y L 150 por tramo.',
  calloutB: 'Aplica a todos los restaurantes de Sherpa', calloutT: ', también a los que se sumen después. No hay nada que configurar por restaurante.',
  mapH: 'Mapa', mapHint: 'Anillos desde el pin', pickLab: 'Ver anillos desde…', search: 'Buscar restaurante o sucursal',
  mapNote: 'Los anillos se mueven mientras editás los tramos. Son distancias en línea recta: no siguen las calles.',
  mapNotePh: 'Los anillos se mueven mientras editás los tramos. Distancias en línea recta.',
  mapCap: (name) => `Anillos desde el pin de ${name}. Línea recta, no calles.`,
  mapFail: 'No se pudo cargar el mapa.', noPin: 'Esta sucursal no tiene ubicación todavía.', noBranches: 'No pudimos cargar las sucursales.',
  legend: [['Tramo de tarifa', 'band'], ['Límite de entrega', 'limit'], ['Fuera del límite', 'out'], ['Otras sucursales', 'other']],
  legendBad: [['Tramo de tarifa', 'band'], ['Límite de entrega', 'limit'], ['Tramo rechazado', 'bad']],
  discard: 'Descartar', save: 'Guardar',
  cTitle: 'Confirmar tarifas de envío',
  cLede: 'Así queda el envío para todos los restaurantes. Aplica a los pedidos nuevos de la app desde que guardés; los pedidos ya cotizados mantienen su tarifa.',
  cLedePh: 'Aplica a los pedidos nuevos de la app desde que guardés; los ya cotizados mantienen su tarifa.',
  cTramos: 'Tramos', cBack: 'Volver', cSave: 'Guardar tarifas', saved: 'Tarifas guardadas',
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
  status: 'idle',          // idle | loading | ready | offline | forbidden
  banner: null,            // null | 'conflict' | 'error'
  attempt: null, phase: null,   // the frozen save attempt and where it stands: sending | recovering | unknown | not_landed
  confirm: false, picker: null, // picker: { q, hi } while open
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
  S.banner = null; S.attempt = null; S.phase = null; S.confirm = false; S.picker = null; S.status = 'idle';
}
function revoke() {
  const wasShowing = !!S.root;
  clearSession({ dropCache: true });
  if (wasShowing) { S.status = 'forbidden'; render(); }
}

document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  if (uid !== S.uid) clearSession({ dropCache: false });   // the shell's clearPersisted drops the old uid's cache
  else bump();
  S.uid = uid;
});

// ── load ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function adoptBody(b) {
  S.loaded = EL.loadedState(b);
  S.branchesUnavailable = !Array.isArray(b.branches);
  S.entries = EL.pickerEntries(b.branches);
  if (!S.pick || !S.entries.some((e) => e.rid === S.pick)) S.pick = EL.defaultPick(S.entries);
  S.rows = EL.rowsFromBands(S.loaded.kind === 'policy' ? S.loaded.bands : []);
  S.note = null;
}
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
  store.set(CACHE(S.uid), cacheable(res.body));
  const keepDraft = !fresh && (S.attempt || (S.rows && S.loaded && S.loaded.kind === 'policy' && EL.isDirty(S.rows, S.loaded.bands)));
  if (keepDraft) {
    // the draft wins on screen; the CAS catches a newer server version at save. The directory still refreshes.
    S.branchesUnavailable = !Array.isArray(res.body.branches);
    S.entries = EL.pickerEntries(res.body.branches);
  } else {
    adoptBody(res.body);
    if (fresh) S.banner = null;
  }
  S.status = 'ready';
  render();
}

// ── save ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function startSave() {
  if (S.attempt || !S.loaded || S.loaded.version === null || S.loaded.version === undefined) return;
  const bar = EL.saveBar(S.rows, S.loaded.kind === 'policy' ? S.loaded.bands : []);
  if (!bar.canSave && !(S.loaded.kind === 'malformed' && EL.validate(S.rows).valid)) return;
  const body = EL.toBody(S.rows, S.loaded.version);
  S.attempt = EL.startAttempt({ uid: S.uid, sessionGen: S.gen, expectedVersion: body.expected_policy_version, bands: body.bands });
  send(S.attempt);
}
async function send(attempt) {
  const g = snap();
  S.phase = 'sending'; S.banner = null; render();
  let res;
  try {
    res = await setDeliveryPricingRaw({ token, assertLive: g.assertLive, body: { expected_policy_version: attempt.expectedVersion, bands: attempt.sentBands } });
  } catch (err) {
    if (!g.alive() || S.attempt !== attempt) return;
    // withheld before sending (no token / obsolete): nothing landed
    S.phase = 'not_landed'; S.banner = 'error'; S.confirm = false; render(); return;
  }
  if (!g.alive() || S.attempt !== attempt) return;
  outcome(attempt, EL.classifyPost(attempt, res));
}
async function recover(attempt) {
  const g = snap();
  S.phase = 'recovering'; render();
  let res;
  try { res = await getDeliveryPricingRaw({ token, assertLive: g.assertLive }); } catch (_) { res = { transport: true }; }
  if (!g.alive() || S.attempt !== attempt) return;
  outcome(attempt, EL.classifyRecovery(attempt, res), res);
}
function outcome(attempt, o, recoveryRes) {
  S.confirm = false;
  switch (o) {
    case 'saved': {
      const version = attempt.expectedVersion + 1;
      S.loaded = { kind: 'policy', version, bands: attempt.sentBands.map((b) => ({ ...b })) };
      S.rows = EL.rowsFromBands(S.loaded.bands);
      S.attempt = null; S.phase = null; S.banner = null;
      const c = store.get(CACHE(S.uid)) || {};
      store.set(CACHE(S.uid), { ...c, current_malformed: undefined, policy_version_raw: undefined, policy_version: version, bands: S.loaded.bands });
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
      if (o === 'refused') console.warn('envio save: refused', recoveryRes && recoveryRes.body && recoveryRes.body.field);
      S.attempt = null; S.phase = null; S.banner = 'error'; render(); return;
    case 'not_landed': S.phase = 'not_landed'; S.banner = 'error'; render(); return;
    case 'unknown':
      if (S.phase === 'recovering') { S.phase = 'unknown'; S.banner = 'error'; render(); return; }
      recover(attempt); return;
    default: S.phase = 'unknown'; S.banner = 'error'; render();
  }
}
function retry() {
  const a = S.attempt;
  if (!a) { S.banner = null; render(); return; }
  if (S.phase === 'not_landed') send(a);
  else if (S.phase === 'unknown') recover(a);
}
function discard() {
  bump();   // a late answer for the dropped attempt is ignored
  S.attempt = null; S.phase = null; S.banner = null; S.confirm = false; S.note = null;
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
function renderMessage(view) {
  const p = pickedEntry();
  const others = S.entries.filter((e) => e.rid !== S.pick && e.hub).slice(0, MP.LIMITS.others).map((e) => ({ lat: e.hub.lat, lng: e.hub.lng }));
  return MP.renderMessage({ mount: S.map.mount, view, theme: themeNow(), hub: p && p.hub ? { lat: p.hub.lat, lng: p.hub.lng } : null,
    name: p ? p.label.slice(0, MP.LIMITS.name) : '', others, bands: EL.mapBands(S.rows || []) });
}
function postRender(view) {
  const m = S.map;
  if (!m || !m.listening || m.failed || !m.frame.contentWindow) return;
  try { m.frame.contentWindow.postMessage(renderMessage(view), MP.MAP_ORIGIN); } catch (e) { console.warn('envio map: post', e && e.message); }
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
  const g = snap();
  const m = { frame: null, mount, deadline: null, listening: false, ready: false, failed: false, onMsg: null };
  m.onMsg = (event) => {
    if (!g.alive() || S.map !== m) return;
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

function render() {
  if (!S.root) return;
  const R = S.root;
  if (S.status === 'forbidden') { stopMap(); R.replaceChildren(topBlock(), errbox(COPY.forbidden, null, null)); hideBar(); return; }
  if (S.status === 'offline') {
    stopMap();
    R.replaceChildren(topBlock(), errbox(OFFLINE[0], OFFLINE[1], button('btn', COPY.retry, () => { S.status = 'loading'; render(); load(); })));
    hideBar(); return;
  }
  if (!S.refs) buildPage();
  paintBanner(); paintBands(); paintPicker(); paintMapBox(); paintLegend(); paintBar(); paintConfirm();
}

function buildPage() {
  const R = S.root;
  const refs = {};
  refs.banner = el('div');
  const grid = el('div', 'grid2');
  const left = el('div', 'dcol'), right = el('div', 'dcol');
  // bands
  const sb = el('section', 'esec envbands');
  const h3 = el('h3', null, COPY.bandsH); h3.append(el('span', 'ehint', COPY.bandsHint));
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
  refs.pick.addEventListener('click', () => (S.picker ? closePicker(true) : openPicker()));
  refs.menu = el('div', 'pickmenu hidden'); refs.menu.setAttribute('role', 'listbox');
  fld.append(refs.pick, refs.menu);
  refs.map = el('div', 'emap');
  refs.mapLine = el('p', 'mapline hidden'); refs.mapLine.setAttribute('role', 'status');
  // the mockup's in-map caption (.mz); above Google's logo row, which Maps terms keep visible (advisor ruling (a), 11-11)
  refs.mapCap = el('span', 'emz hidden');
  refs.map.append(refs.mapLine, refs.mapCap);
  refs.legend = el('div', 'legend');
  refs.mapNote = el('p', 'efnote');
  sm.append(mh, fld, refs.map, refs.legend, refs.mapNote);
  right.append(sm);
  grid.append(left, right);
  // save bar + confirm layer (fixed / overlay: placement in the DOM doesn't move them)
  refs.bar = el('div', 'rbar');
  refs.barDot = el('span', 'ebdot'); refs.barText = el('span', 'rb-t');
  const sp = el('div', 'rb-sp');
  refs.discard = button('btn ghost', COPY.discard, discard);
  refs.save = button('btn accent', COPY.save, () => { if (!S.attempt) { S.confirm = true; render(); } });
  sp.append(refs.discard, refs.save);
  refs.bar.append(refs.barDot, refs.barText, sp);
  refs.layer = el('div');
  R.replaceChildren(topBlock(), refs.banner, grid, refs.bar, refs.layer);
  S.refs = refs;
  document.addEventListener('click', onDocClick);
}
function onDocClick(e) {
  if (!S.picker || !S.refs) return;
  const t = e.target;
  if (t && t.closest && t.closest('.pickfld')) return;
  closePicker(false);
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
function afterEdit() { paintBands(); paintLegend(); paintBar(); postRender('keep'); }

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
  r.mapCap.textContent = !line && p && p.hub ? COPY.mapCap(p.label) : '';
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
function openPicker() {
  S.picker = { q: '', hi: 0 };
  const r = S.refs;
  const search = el('div', 'psearch');
  const inp = el('input'); inp.placeholder = COPY.search; inp.setAttribute('aria-label', COPY.search); inp.autocomplete = 'off';
  search.append(ic('search'), inp);
  r.plist = el('div', 'plist');
  r.pmore = el('div', 'pmore hidden');
  r.menu.replaceChildren(search, r.plist, r.pmore);
  inp.addEventListener('input', () => { S.picker.q = inp.value; S.picker.hi = 0; paintMenu(); });
  inp.addEventListener('keydown', (e) => {
    const f = EL.filterEntries(S.entries, S.picker.q, S.pick);
    if (e.key === 'ArrowDown') { e.preventDefault(); S.picker.hi = Math.min(S.picker.hi + 1, f.shown.length - 1); paintMenu(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.picker.hi = Math.max(S.picker.hi - 1, 0); paintMenu(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = f.shown[S.picker.hi]; if (it) choose(it.rid); }
    else if (e.key === 'Escape') { e.preventDefault(); closePicker(true); }
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
    const pt = el('span', 'pt', e.name);
    if (e.loc) pt.append(document.createTextNode(' '), el('span', null, `· ${e.loc}`));
    b.append(el('span', 'pi', e.initial), pt);
    if (e.current) b.append(ic('check'));
    b.addEventListener('click', () => choose(e.rid));
    return b;
  })));
  r.pmore.textContent = f.more || '';
  r.pmore.classList.toggle('hidden', !f.more);
}
function closePicker(refocus) {
  S.picker = null;
  paintPicker();
  if (refocus) S.refs.pick.focus();
}
function choose(rid) {
  S.pick = rid;
  closePicker(true);
  paintMapBox();
  postRender('reset');
}

function hideBar() { const b = S.refs && S.refs.bar; if (b) b.classList.remove('show'); }
function paintBar() {
  const r = S.refs;
  const L0 = S.loaded;
  if (!L0 || S.banner === 'conflict' || L0.kind === 'unreadable' || (L0.kind === 'malformed' && !L0.canSave)) { r.bar.classList.remove('show'); return; }
  const bar = EL.saveBar(S.rows, L0.kind === 'policy' ? L0.bands : []);
  const malformedValid = L0.kind === 'malformed' && EL.validate(S.rows).valid;
  const show = bar.state !== 'clean' || malformedValid || !!S.attempt;
  r.bar.classList.toggle('show', show);
  r.barDot.classList.toggle('ered', bar.state === 'invalid');
  r.barText.textContent = bar.state === 'invalid' ? bar.text : EL.COPY.dirty;
  r.save.disabled = !!S.attempt || !(bar.canSave || malformedValid);
  r.discard.disabled = S.phase === 'sending' || S.phase === 'recovering';
}

function paintConfirm() {
  const r = S.refs;
  if (!S.confirm) { r.layer.replaceChildren(); return; }
  const busy = S.phase === 'sending' || S.phase === 'recovering';
  if (r.layer.firstChild && r.confirmSave) { r.confirmSave.disabled = busy; r.confirmSave.setAttribute('aria-busy', busy ? 'true' : 'false'); r.confirmBack.disabled = busy; return; }
  const was = S.loaded && S.loaded.kind === 'policy' ? S.loaded.bands : [];
  const now = EL.validate(S.rows).bands || [];
  const d = EL.confirmDiff(was, now);
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
  if (d.limit) {
    const c = el('div', 'ecallout');
    const t = el('div');
    const { from: a, to: b } = d.limit;
    if (a === null) t.append(document.createTextNode('El límite de entrega queda en '), el('b', null, `${b} km`), document.createTextNode(' para todos los restaurantes.'));
    else {
      t.append(document.createTextNode('El límite de entrega pasa de '), el('b', null, `${a} km`), document.createTextNode(' a '), el('b', null, `${b} km`),
        document.createTextNode(' para todos los restaurantes.'));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      t.append(el('span', 'dk', ` Las direcciones entre ${lo} y ${hi} km ${b > a ? 'ya se pueden' : 'ya no se pueden'} pedir desde que guardés.`));
    }
    c.append(ic('info'), t);
    body.append(c);
  }
  const foot = el('div', 'mfoot');
  r.confirmBack = button('btn ghost', COPY.cBack, () => { S.confirm = false; render(); S.refs.save.focus(); });
  r.confirmSave = button('btn accent', COPY.cSave, startSave);
  r.confirmSave.disabled = busy;
  foot.append(r.confirmBack, r.confirmSave);
  m.append(head, body, foot);
  scrim.append(m);
  scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !(S.phase === 'sending' || S.phase === 'recovering')) { S.confirm = false; render(); S.refs.save.focus(); } });
  r.layer.replaceChildren(scrim);
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
    S.uid = sel.uid;
    S.host = host;
    S.root = el('div', 'envio');
    host.replaceChildren(S.root);
    S.refs = null;
    const cached = S.uid ? store.get(CACHE(S.uid)) : null;
    if (cached) { adoptBody(cached); S.status = 'ready'; } else { S.status = 'loading'; S.rows = [{ km: '', fee: '' }]; }
    render();
    load();
  },
  unmount() {
    bump();
    stopMap();
    document.removeEventListener('click', onDocClick);
    S.attempt = null; S.phase = null; S.confirm = false; S.picker = null; S.banner = null; S.note = null;
    if (S.host) S.host.replaceChildren();
    S.host = null; S.root = null; S.refs = null; S.status = 'idle';
  },
  canLeave: () => !S.attempt && !(S.rows && S.loaded && S.loaded.kind === 'policy' && EL.isDirty(S.rows, S.loaded.bands)),
});

export const _envioState = S;   // test-only view of the state (never read by the page)
export const _envioTiming = TIMING;   // test-only: the suite shortens the 8 s deadline (the page never writes it)
