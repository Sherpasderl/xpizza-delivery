"use strict";
// ── form-live-status — THE LIVE "PEDIDO RECIBIDO" SCREEN, shared by every order form (PLAN-S5 §3–§4) ──
//
// After a confirmed order, showSuccess() hands this module the order's tracking token. One controller per confirmation:
//   - subscribes to order_tracking/{token} through account.js's own lazy Firebase loader (window.__ACCOUNT.ensureFirebase —
//     guest-safe: the node is public-read), and paints the segbar + status line from status-view.js's presentStatus, the
//     same decisions the tracker makes;
//   - paints the ARRIVAL line: a window ("Llega 7:35 – 7:50 p. m.") built from the measured prep (restaurants/{rid}/public/
//     prep_stats, else the public prep_eta_min, else a neutral 30) + a traffic drive estimate (≤ 2 Directions requests per
//     confirmation, else 12 min), anchored at the order's created_at; after pickup the timestamp ETA ("Llega en ~N min");
//     an overdue window becomes honest status copy; with no estimate at all, the static fallback;
//   - draws the map (the page's own Maps loader; an illustrated layer until Maps is ready, or for good if it never is).
// (The receipt, the details card and the Ayuda chip are painted by showSuccess itself, so a scheduled confirmation has them.)
// Ownership: start() replaces the current controller; stop() / stopAll() unsubscribe and clear the three named timers
// (deadlineTimer, mapsWaitTimer, etaTimer). Every async continuation and callback re-checks the controller's generation, so
// an older order's late work can never paint a newer confirmation. Every boundary is caught: a failure here paints the
// fallback line and never touches the receipt, the rewards card, the order number, the order or the payment state.
// Brand-agnostic: the store coords come from the page's own constants, everything else from the order's public records.
//
// Same bytes load as a classic browser script AND a Node module (no ESM), like the other shared form modules.

const LIVE_STATUS = Object.freeze({
  TOKEN_RE: /^[A-Za-z0-9_-]{8,128}$/,
  STALE_MS: 72 * 3600000,      // a prep_stats summary older than this is treated as absent
  MIN_N: 8,                    // a bucket with fewer eligible orders is ignored
  NEUTRAL_PREP: { median: 30, p80: 40 },
  DRIVE_FALLBACK_MIN: 12,
  MAPS_WAIT_MS: 5000,          // mapsWaitTimer: how long to wait for the page's Maps loader
  ETA_TICK_MS: 60000,          // etaTimer: the post-pickup countdown re-render
  DEADLINE_SLACK_MS: 1000,     // deadlineTimer fires 1 s after the displayed window end
  MAX_DIRECTIONS: 2,           // per confirmation: one at placement, one at the ready transition
  TZ: 'America/Tegucigalpa',
});
// OWNER-APPROVED copy (2026-10-14) — pinned by the copy-parity tests.
const LIVE_COPY = Object.freeze({
  OVERDUE: 'Está tardando un poco más de lo normal. Te dejaremos saber por WhatsApp en cuanto salga.',
  FALLBACK: 'Te avisaremos por WhatsApp en cuanto tu pedido salga.',
  WAS_CANCELLED: 'Tu pedido fue cancelado',
  DONE_DELIVERY: 'Entregado',
  DONE_PICKUP: 'Recogido',
  READY_PICKUP: 'Listo para recoger',
});

// ── pure: time ──
const MIN_MS = 60000, FIVE_MS = 5 * MIN_MS;
// the nearest 5-minute mark (a tie rounds up); Tegucigalpa's offset is a whole hour, so absolute ms round like local time
const r5 = (ms) => Math.floor((ms + FIVE_MS / 2) / FIVE_MS) * FIVE_MS;
const r5d = (min) => Math.floor((min + 2.5) / 5) * 5;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
let _fmt = null;
function tzParts(ms) {
  if (!_fmt) _fmt = new Intl.DateTimeFormat('en-US', { timeZone: LIVE_STATUS.TZ, hour: 'numeric', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = {}; for (const x of _fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { h: Number(p.hour) % 24, m: Number(p.minute), wd: p.weekday };
}
function clockOf(ms) { const { h, m } = tzParts(ms); return { hm: `${(h % 12) || 12}:${String(m).padStart(2, '0')}`, ap: h >= 12 ? 'p. m.' : 'a. m.' }; }
// "7:35 – 7:50 p. m." (one period) / "11:50 a. m. – 12:05 p. m." (across noon or midnight)
function fmtRange(lo, hi) { const a = clockOf(lo), b = clockOf(hi); return a.ap === b.ap ? `${a.hm} – ${b.hm} ${b.ap}` : `${a.hm} ${a.ap} – ${b.hm} ${b.ap}`; }
// the bucket of the prep-stats job (prep-stats.js): weekday/weekend × late 22–4 / morning 5–10 / lunch 11–15 / dinner 16–21
function bucketAt(ms) {
  const { h, wd } = tzParts(ms);
  const part = h < 5 ? 'late' : h < 11 ? 'morning' : h < 16 ? 'lunch' : h < 22 ? 'dinner' : 'late';
  return `${(wd === 'Sat' || wd === 'Sun') ? 'weekend' : 'weekday'}_${part}`;
}

// ── pure: estimates ──
// prep for an order anchored at A: the measured bucket (fresh, n ≥ 8) → the public prep_eta_min (p80 = +10) → neutral 30/40
function prepFor(pub, anchorMs, nowMs) {
  const st = pub && pub.prep_stats;
  if (st && Number.isFinite(st.updated_at) && nowMs - st.updated_at <= LIVE_STATUS.STALE_MS) {
    const b = st[bucketAt(anchorMs)];
    if (b && Number.isFinite(b.median_min) && Number.isFinite(b.p80_min) && Number.isFinite(b.n) && b.n >= LIVE_STATUS.MIN_N) return { median: b.median_min, p80: b.p80_min, tier: 'measured' };
  }
  const p = pub && pub.prep_eta_min;
  if (Number.isFinite(p) && p > 0) return { median: p, p80: p + 10, tier: 'configured' };
  return { median: LIVE_STATUS.NEUTRAL_PREP.median, p80: LIVE_STATUS.NEUTRAL_PREP.p80, tier: 'neutral' };
}
// the window for a stage, or null. drive in minutes (delivery); pickup has none.
function windowFor({ stage, anchorMs, prep, driveMin, readyAt, pickup }) {
  if (stage === 'placement') {
    const low = r5(anchorMs + (prep.median + (pickup ? 0 : driveMin)) * MIN_MS);
    return { low, high: low + clamp(r5d(prep.p80 - prep.median), 10, 20) * MIN_MS };
  }
  if (stage === 'ready' && !pickup && Number.isFinite(readyAt)) {
    const low = r5(readyAt + driveMin * MIN_MS);
    return { low, high: low + 10 * MIN_MS };
  }
  return null;
}
// which stage a tracking record is in
function stageOf(rec, pickup) {
  const s = (rec && rec.status) || 'new';
  if (s === 'cancelled' || s === 'delivered' || s === 'completed') return 'terminal';
  if (s === 'out_for_delivery') return pickup ? 'terminal' : 'ofd';
  if (s === 'ready') return pickup ? 'ready' : (Number.isFinite(rec.ready_at) ? 'ready' : 'placement');
  return 'placement';
}
// the arrival line for a state → { text, deadline } (deadline: when the displayed window ends, else null)
function arrivalFor({ rec, pickup, stage, prep, driveMin, anchorMs, overdue, v }) {
  const s = (rec && rec.status) || 'new';
  if (stage === 'terminal') {
    if (s === 'cancelled') return { text: LIVE_COPY.WAS_CANCELLED, deadline: null };
    return { text: pickup ? LIVE_COPY.DONE_PICKUP : LIVE_COPY.DONE_DELIVERY, deadline: null };
  }
  if (stage === 'ofd') {
    if (rec.driver_name && rec.is_active_drop === false) return { text: v.sub, deadline: null };   // stacked: the tracker's copy, no number
    return { text: v.etaMin ? `Llega en ~${v.etaMin} min` : 'En ruta a tu dirección', deadline: null };
  }
  if (overdue) return { text: LIVE_COPY.OVERDUE, deadline: null };
  if (stage === 'ready' && pickup) return { text: LIVE_COPY.READY_PICKUP, deadline: null };
  const w = windowFor({ stage, anchorMs, prep, driveMin, readyAt: rec && rec.ready_at, pickup });
  if (!w) return { text: LIVE_COPY.FALLBACK, deadline: null };
  return { text: `${pickup ? 'Listo para recoger' : 'Llega'} ${fmtRange(w.low, w.high)}`, deadline: w.high };
}
// the status line under the segbar: the tracker's sub-line; after pickup its headline (the arrival line carries the ETA)
const statusLineOf = (v, rec) => (((rec && rec.status) === 'out_for_delivery') ? v.headline : v.sub);

// ── the controller ──
let __liveGen = 0;
let __liveCurrent = null;
const liveDoc = () => (typeof document !== 'undefined' ? document : null);
const liveWin = () => (typeof window !== 'undefined' ? window : null);

function liveEls() {
  const d = liveDoc(); const $ = (id) => (d ? d.getElementById(id) : null);
  return { arrival: $('success-sub'), seg: $('ls-seg'), status: $('ls-status'), map: $('ls-map'), canvas: $('ls-map-canvas'),
     storeLabel: $('ls-store-label'),
    pickupStore: $('ls-pickup-store'), receiptStore: $('ls-receipt-store') };
}

function livePaintSeg(el, v) {
  if (!el) return;
  el.textContent = '';
  for (const node of v.segs) {
    const s = liveDoc().createElement('span');
    if (node === 'done') s.className = 'done';
    else if (node && typeof node === 'object') { s.className = 'on'; s.style.setProperty('--p', String(node.a)); }
    el.appendChild(s);
  }
}

// Map resources (codex S5 build r1 P2-5): an EXTERNAL stop (replacement, "Hacer otro pedido", pagehide) detaches the overlays and
// the polyline and drops the map binding; a terminal SELF-stop (delivered / cancelled) keeps the map on screen.
function liveDisposeMap(c) {
  if (!c || !c.map) return;
  c.mapDisposed = true;
  for (const ov of c.map.overlays || []) { try { ov.setMap(null); } catch (_) {} }
  try { if (c.map.polyline) c.map.polyline.setMap(null); } catch (_) {}
  c.map = null;
}
function liveStopCtl(c, dispose = true) {
  if (!c) return;
  if (dispose) liveDisposeMap(c);
  if (c.stopped) return;
  c.stopped = true;
  try { if (c.unsub) c.unsub(); } catch (_) {}
  c.unsub = null;
  for (const k of ['deadlineTimer', 'mapsWaitTimer', 'etaTimer']) { if (c[k] != null) { try { clearTimeout(c[k]); } catch (_) {} c[k] = null; } }
  if (__liveCurrent === c) __liveCurrent = null;
}
// the LAST controller stays reachable for disposal: a terminal self-stop keeps its map on screen until the next reset / replacement
let __liveLast = null;
function stopAll() { liveStopCtl(__liveCurrent); liveDisposeMap(__liveLast); }
// (codex S5 build r1 P1) the live-status DOM back to a blank slate: nothing of a previous confirmation (segbar, status line, store
// labels, the live map) survives into the next one — start() begins with it, "Hacer otro pedido" and a scheduled confirmation call it.
function resetLiveScreen() {
  stopAll();
  const e = liveEls();
  if (e.seg) e.seg.textContent = '';
  if (e.status) e.status.textContent = '';
  for (const el of [e.storeLabel, e.pickupStore, e.receiptStore]) if (el) { el.textContent = ''; el.hidden = true; }
  if (e.canvas) e.canvas.textContent = '';
  if (e.map) e.map.classList.remove('ls-map--live');
}

function start(opts) {
  resetLiveScreen();
  const o = opts || {};
  const c = { gen: ++__liveGen, stopped: false, unsub: null, deadlineTimer: null, mapsWaitTimer: null, etaTimer: null,
    token: (typeof o.token === 'string' && LIVE_STATUS.TOKEN_RE.test(o.token)) ? o.token : null,
    pickup: o.orderType === 'pickup', store: o.store || null, dest: o.dest || null,
    anchor: Number.isFinite(o.anchorFallbackMs) ? o.anchorFallbackMs : Date.now(),
    rec: null, pub: null, pubDone: false, rid: null, drive: { placement: null, ready: null }, dirCount: 0, dirInFlight: false,
    overdueStage: null, lastStage: null, map: null, mapDisposed: false, label: '', directionsRequested: { placement: false, ready: false } };
  __liveCurrent = c; __liveLast = c;
  const liveAlive = () => !c.stopped && __liveCurrent === c && c.gen === __liveGen;
  const liveGuard = (fn) => { try { if (liveAlive()) fn(); } catch (_) { try { livePaintFallback(); } catch (__) {} } };
  const els = liveEls();

  function livePaintFallback() {
    if (!liveAlive()) return;
    if (els.arrival) els.arrival.textContent = LIVE_COPY.FALLBACK;
  }
  function liveDriveMin(stage) {
    const d = (stage === 'ready' || stage === 'ofd') ? (c.drive.ready != null ? c.drive.ready : c.drive.placement) : c.drive.placement;
    return d != null ? d : LIVE_STATUS.DRIVE_FALLBACK_MIN;
  }
  function liveRender() {
    if (!liveAlive()) return;
    const rec = c.rec || { status: 'new', order_type: c.pickup ? 'pickup' : 'delivery' };
    const stage = stageOf(rec, c.pickup);
    if (stage !== c.lastStage) { c.overdueStage = null; c.lastStage = stage; }
    const pres = { ...rec, order_type: rec.order_type || (c.pickup ? 'pickup' : 'delivery'), fallback_drive_min: liveDriveMin('ofd'), now: Date.now() };
    const v = livePresent({ ...pres, gen2: true });   // F4: the segbar + status line are the tracker's gen2 words (S5 BC2 parity)
    const vArrival = livePresent(pres);              // …the ARRIVAL line keeps today's decision, unchanged (codex build r1 P2)
    livePaintSeg(els.seg, v);
    if (els.status) els.status.textContent = statusLineOf(v, rec) || '';
    // the arrival line: a window needs the first snapshot AND the public leaf read (or its failure); until then the fallback
    const ready = !!c.rec && c.pubDone;
    let a;
    if (!ready && stage !== 'terminal' && stage !== 'ofd') a = { text: LIVE_COPY.FALLBACK, deadline: null };
    else a = arrivalFor({ rec, pickup: c.pickup, stage, prep: prepFor(c.pub, c.anchor, Date.now()), driveMin: liveDriveMin(stage), anchorMs: c.anchor, overdue: c.overdueStage === stage, v: vArrival });
    if (els.arrival) els.arrival.textContent = a.text;
    // deadlineTimer — ONE, re-armed per window paint, at the DISPLAYED end + 1 s; fires even with no new snapshot
    if (c.deadlineTimer != null) { clearTimeout(c.deadlineTimer); c.deadlineTimer = null; }
    if (a.deadline != null) {
      c.deadlineTimer = setTimeout(() => liveGuard(() => { c.deadlineTimer = null; if (stageOf(c.rec || {}, c.pickup) === stage) { c.overdueStage = stage; liveRender(); } }),
        Math.max(0, a.deadline + LIVE_STATUS.DEADLINE_SLACK_MS - Date.now()));
    }
    // etaTimer — the post-pickup countdown
    if (c.etaTimer != null) { clearTimeout(c.etaTimer); c.etaTimer = null; }
    if (stage === 'ofd') c.etaTimer = setTimeout(() => liveGuard(() => { c.etaTimer = null; liveRender(); }), LIVE_STATUS.ETA_TICK_MS);
    if (stage === 'terminal' && c.rec) liveStopCtl(c, false);   // delivered / collected / cancelled: painted once, then nothing more (the map stays)
  }
  function livePresent(r) { return liveWin().StatusView.presentStatus(r); }

  // ── the store label (map pin, "Recoger en", "Resumen del pedido · …") ──
  function livePaintLabel() {
    if (!liveAlive()) return;
    const p = c.pub || {};
    const dn = typeof p.display_name === 'string' && p.display_name.trim() ? p.display_name.trim() : null;
    const bn = typeof p.branch_name === 'string' && p.branch_name.trim() ? p.branch_name.trim() : null;
    const td = c.rec && typeof c.rec.restaurant_display_name === 'string' && c.rec.restaurant_display_name.trim() ? c.rec.restaurant_display_name.trim() : null;
    const label = dn ? (bn ? `${dn} · ${bn}` : dn) : (td || '');
    c.label = label;
    if (els.storeLabel) { els.storeLabel.textContent = label; els.storeLabel.hidden = !label; }
    if (els.pickupStore) { els.pickupStore.textContent = label; els.pickupStore.hidden = !label; }
    if (els.receiptStore) { els.receiptStore.textContent = (dn || td) ? `· ${dn || td}` : ''; els.receiptStore.hidden = !(dn || td); }
    if (c.map && c.map.label) { c.map.label.textContent = label; c.map.label.hidden = !label; }   // codex r1 P2-2: the VISIBLE overlay follows
  }

  // ── Directions: ≤ 2 per confirmation (placement + the ready transition), in-flight suppressed, never after pickup ──
  // RECONCILED against the CURRENT stage (codex S5 build r1 P2-3) whenever something could change the answer: Maps becoming
  // available, every snapshot, and an outstanding request completing — so a request is never issued after pickup and a ready
  // transition that happened while a placement request was in flight is never lost.
  function liveReconcileDrive() {
    if (!liveAlive() || c.pickup || !c.dest || !c.store || c.dirInFlight) return;
    const stage = stageOf(c.rec || { status: 'new' }, c.pickup);
    if (stage === 'placement') liveRequestDrive('placement');
    else if (stage === 'ready') liveRequestDrive('ready');
  }
  function liveRequestDrive(which) {
    if (!liveAlive() || c.pickup || !c.dest || !c.store || c.dirInFlight || c.dirCount >= LIVE_STATUS.MAX_DIRECTIONS || c.directionsRequested[which]) return;
    const g = liveWin().google;
    if (!(g && g.maps && typeof g.maps.DirectionsService === 'function')) return;
    c.directionsRequested[which] = true; c.dirCount += 1; c.dirInFlight = true;
    try {
      new g.maps.DirectionsService().route({
        origin: { lat: c.store.lat, lng: c.store.lng }, destination: { lat: c.dest.lat, lng: c.dest.lng },
        travelMode: g.maps.TravelMode.DRIVING, drivingOptions: { departureTime: new Date(), trafficModel: 'bestguess' },
      }, (res, status) => {
        c.dirInFlight = false;
        liveGuard(() => {
          const leg = status === 'OK' && res && res.routes && res.routes[0] && res.routes[0].legs && res.routes[0].legs[0];
          // the approved contract: a valid TRAFFIC duration only (codex r1 P2-4) — a duration-only answer keeps the 12-min fallback
          const sec = leg && leg.duration_in_traffic && leg.duration_in_traffic.value;
          if (Number.isFinite(sec) && sec > 0) { c.drive[which] = Math.max(1, Math.round(sec / 60)); liveRender(); }
          liveReconcileDrive();   // a stage that moved while this request was outstanding
        });
      });
    } catch (_) { c.dirInFlight = false; }
  }

  // ── the map: the page's own Maps loader; the illustrated layer stays until (and unless) Maps is ready ──
  function liveDrawMap() {
    if (!liveAlive() || c.map || !els.canvas || !c.store) return;
    const g = liveWin().google; if (!(g && g.maps && typeof g.maps.Map === 'function')) return;
    const map = new g.maps.Map(els.canvas, { center: c.store, zoom: 15, disableDefaultUI: true, gestureHandling: 'cooperative', clickableIcons: false, keyboardShortcuts: false });
    c.map = { map, overlays: [], polyline: null };
    const Overlay = function (pos, node) { this.pos = pos; this.node = node; };
    Overlay.prototype = new g.maps.OverlayView();
    // overlay callbacks are guarded by THIS controller's disposal (codex r1 P2-5): a retained callback of a replaced map is inert
    Overlay.prototype.onAdd = function () { if (c.mapDisposed) return; this.getPanes().overlayMouseTarget.appendChild(this.node); };
    Overlay.prototype.draw = function () { if (c.mapDisposed) return; const p = this.getProjection().fromLatLngToDivPixel(new g.maps.LatLng(this.pos.lat, this.pos.lng)); if (p) { this.node.style.left = p.x + 'px'; this.node.style.top = p.y + 'px'; } };
    Overlay.prototype.onRemove = function () { if (this.node.parentNode) this.node.parentNode.removeChild(this.node); };
    const pin = (html) => { const n = liveDoc().createElement('div'); n.className = 'ls-pin'; n.innerHTML = html; return n; };
    const store = pin('<div class="ls-label"></div><div class="ls-dot"></div>');
    c.map.label = store.querySelector('.ls-label'); c.map.label.textContent = c.label; c.map.label.hidden = !c.label;
    const add = (ov) => { c.map.overlays.push(ov); ov.setMap(map); };
    add(new Overlay(c.store, store));
    if (!c.pickup && c.dest) {
      add(new Overlay(c.dest, pin('<div class="ls-home"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg></div>')));
      c.map.polyline = new g.maps.Polyline({ map, path: [c.store, c.dest], strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.55, strokeColor: '#1E1B18', scale: 2 }, offset: '0', repeat: '9px' }] });
      const b = new g.maps.LatLngBounds(); b.extend(c.store); b.extend(c.dest); map.fitBounds(b, { top: 70, bottom: 50, left: 40, right: 40 });
    }
    if (els.map) els.map.classList.add('ls-map--live');
  }
  function liveWhenMaps() {
    const g = liveWin().google;
    if (g && g.maps && typeof g.maps.Map === 'function') { liveDrawMap(); liveReconcileDrive(); return; }
    // mapsWaitTimer — the page loads Maps async; poll briefly, then keep the illustrated layer and the drive fallback
    const t0 = Date.now();
    const liveTick = () => liveGuard(() => {
      c.mapsWaitTimer = null;
      const gg = liveWin().google;
      if (gg && gg.maps && typeof gg.maps.Map === 'function') { liveDrawMap(); liveReconcileDrive(); liveRender(); return; }
      if (Date.now() - t0 < LIVE_STATUS.MAPS_WAIT_MS) c.mapsWaitTimer = setTimeout(liveTick, 250);
    });
    c.mapsWaitTimer = setTimeout(liveTick, 250);
  }

  function liveOnSnap(rec) {
    c.rec = rec || null;
    if (rec && Number.isFinite(rec.created_at)) c.anchor = rec.created_at;   // the placement anchor: created_at, never `now`
    if (rec && typeof rec.restaurant_id === 'string' && rec.restaurant_id && !c.rid) { c.rid = rec.restaurant_id; liveReadPublic(); }
    else if (rec && !c.rid && !c.pubDone) { c.pubDone = true; }   // no restaurant id → no public leaf (the configured fallbacks)
    liveReconcileDrive();   // the ready transition (the first ready_at snapshot) → the second (and last) request; never after pickup
    livePaintLabel();
    liveRender();
  }

  let fb = null;
  function liveReadPublic() {
    if (!fb || !c.rid) return;
    let p;
    try { p = fb.dbMod.get(fb.dbMod.ref(fb.db, 'restaurants/' + c.rid + '/public')); } catch (_) { c.pubDone = true; return; }
    Promise.resolve(p).then((snap) => liveGuard(() => { c.pub = (snap && typeof snap.val === 'function') ? snap.val() : null; c.pubDone = true; livePaintLabel(); liveRender(); }),
      () => liveGuard(() => { c.pubDone = true; liveRender(); }));
  }

  // first paint: synchronous, no network (the fallback line + the status for a just-placed order)
  liveGuard(() => { livePaintLabel(); liveRender(); });
  liveGuard(liveWhenMaps);
  if (!c.token) return { stop() { liveStopCtl(c); } };   // no token (a token-less return): the static fallback, no subscription

  (async () => {
    const W = liveWin();
    if (!(W.__ACCOUNT && typeof W.__ACCOUNT.ensureFirebase === 'function')) { liveGuard(livePaintFallback); return; }
    const f = await W.__ACCOUNT.ensureFirebase();
    if (!liveAlive()) return;                                              // gen check AFTER the await
    fb = f;
    const r = f.dbMod.ref(f.db, 'order_tracking/' + c.token);
    const unsub = f.dbMod.onValue(r, (snap) => liveGuard(() => liveOnSnap(snap.val())), () => liveGuard(livePaintFallback));
    if (!liveAlive()) { try { unsub(); } catch (_) {} return; }            // stopped while subscribing
    c.unsub = unsub;
  })().catch(() => liveGuard(livePaintFallback));
  return { stop() { liveStopCtl(c); } };
}

const FormLiveStatus = { start, stopAll, resetLiveScreen, windowFor, prepFor, arrivalFor, stageOf, statusLineOf, fmtRange, bucketAt, r5, r5d, LIVE_STATUS, LIVE_COPY };
if (typeof module !== "undefined" && module.exports) module.exports = FormLiveStatus;
if (typeof window !== "undefined") { window.FormLiveStatus = FormLiveStatus; }
