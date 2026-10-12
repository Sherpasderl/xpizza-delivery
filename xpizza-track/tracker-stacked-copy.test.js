'use strict';
// RUNTIME-REAL tracker test for the SEGMENTED progress bar + unified headline (replaces the old 4-step
// timeline + banner + driver card). Instead of regex-matching the HTML (blind to runtime), we SLICE the real
// render status section out of xpizza-track/index.html and EXECUTE it against a fake DOM for every order
// state + pickup, asserting the segment model (done/active+fill/pending), the single headline + sub-line, the
// avatar, and the driver-card copy / no-map / ETA / map LOGIC (the shipped core, unchanged).
//
// DYNAMIC-GATE HARDENING: the slice starts at the REAL outer `const status = …` and runs the WHOLE status
// branch (incl. pickup + the out_for_delivery + data.driver_name gates), so "avatar/map/eta appear ONLY for
// an OFD order with a driver, and a non-OFD status gets the right segments and NO driver chrome" is proven
// dynamically, not by co-location.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ── Slice the render status section: from the real outer `const status` to the render-closing brace ──
const START = 'const status = data.status || \'new\';';
const END = '\n    }\n\n    // Collapsible';   // the render-closing `    }` (excluded from the body)
const a = html.indexOf(START);
assert.ok(a !== -1, 'slice START present (render status section found)');
const b = html.indexOf(END, a);
assert.ok(b !== -1, 'slice END present (render close found)');
const slice = html.slice(a, b);   // a valid function body (render\'s own `    }` excluded)

// Pull the REAL fmtTime helper so the executed render uses it (not a test re-implementation).
const fa = html.indexOf('function fmtTime(');
assert.ok(fa !== -1, 'fmtTime helper present');
const fmtTimeSrc = html.slice(fa, html.indexOf('\n    }', fa) + '\n    }'.length);

const OWNER_WAITING = 'Tu repartidor tiene una parada rápida en camino a la tuya, luego va directo hacia vos.';
assert.ok(!html.includes('está terminando una entrega que queda en camino'), 'superseded stacked copy gone');

// ── Fake DOM ──
function mkEl(id) {
  const classes = new Set(); const style = {};
  const el = {
    id, children: [], _text: '', hidden: false, _style: style, _classes: classes,
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') el.children.length = 0; },
    appendChild(c) { el.children.push(c); return c; },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : f; on ? classes.add(c) : classes.delete(c); },
    },
    style: {
      setProperty: (k, v) => { style[k] = v; }, getPropertyValue: (k) => style[k],
      get opacity() { return style.opacity; }, set opacity(v) { style.opacity = v; },
    },
  };
  return el;
}

function render(data) {
  const reg = {};
  const getEl = (id) => (reg[id] || (reg[id] = mkEl(id)));
  const document = { getElementById: getEl, createElement: () => mkEl() };
  const calls = { refreshDriverEta: 0, updateDriverMap: 0, computeEta: 0, hideDriverMap: 0 };
  const hideDriverMap = () => { calls.hideDriverMap++; };
  const refreshDriverEta = () => { calls.refreshDriverEta++; };
  const updateDriverMap = () => { calls.updateDriverMap++; };
  const computeEta = (d) => { calls.computeEta++; return d.__eta; };
  const requestAnimationFrame = (fn) => fn();   // run synchronously so fill --p is set when we inspect
  // eslint-disable-next-line no-new-func
  const fn = new Function('data', 'document', 'hideDriverMap', 'refreshDriverEta', 'updateDriverMap',
    'computeEta', 'requestAnimationFrame',
    `${fmtTimeSrc}\nlet etaIsActive = false; ${slice}; return etaIsActive;`);
  // Early-return branches (cancelled / pickup) return undefined; normalize to the boolean etaIsActive they left.
  const etaIsActive = fn(data, document, hideDriverMap, refreshDriverEta, updateDriverMap, computeEta, requestAnimationFrame) ?? false;
  const segbar = reg['segbar'] || mkEl('segbar');
  const title = reg['driver-name'] || mkEl('driver-name');
  const sub = reg['driver-eta'] || mkEl('driver-eta');
  const avatar = reg['driver-avatar'] || mkEl('driver-avatar');
  // each segment → 'done' | {a} | 'pending'
  const segs = segbar.children.map((seg) => {
    if (seg._classes.has('done')) return 'done';
    if (seg._classes.has('active')) return { a: Number(seg.children[0]._style['--p']) };
    return 'pending';
  });
  return {
    segs, etaIsActive, calls,
    title: title._text, titleSuccess: title._classes.has('success'), titleDanger: title._classes.has('danger'),
    sub: sub._text, subBig: sub._classes.has('big'),
    avatarShown: avatar.hidden === false, avatarChar: avatar._text,
    barOpacity: segbar._style.opacity,
    liveHidden: (reg['updated-text'] ? reg['updated-text']._classes.has('hidden') : null),
  };
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const segClasses = (r) => r.segs.map((s) => (s === 'done' ? 'done' : s === 'pending' ? 'pending' : 'active'));
const activeFill = (r) => { const i = r.segs.findIndex((s) => typeof s === 'object'); return i < 0 ? null : r.segs[i].a; };

// ═══ DELIVERY states ═══
let r = render({ status: 'new' });
assert.deepEqual(segClasses(r), ['active', 'pending', 'pending', 'pending', 'pending']); ok('new: 5 segs, seg1 active');
assert.equal(r.title, 'Recibimos tu pedido'); assert.equal(r.sub, 'Estamos por empezar a preparar tu pedido'); ok('new: headline + sub');
assert.ok(!r.avatarShown && r.calls.updateDriverMap === 0); ok('new: no avatar, no map');

r = render({ status: 'preparing' });
assert.deepEqual(segClasses(r), ['done', 'active', 'pending', 'pending', 'pending']); assert.equal(activeFill(r), .55); ok('preparing: seg1 done, seg2 active(.55)');
assert.equal(r.title, 'Tu pedido se está preparando'); assert.equal(r.sub, 'Te avisaremos cuando vaya en camino'); ok('preparing: headline + sub');

r = render({ status: 'ready' });   // delivery ready = still preparing (awaiting driver)
assert.deepEqual(segClasses(r), ['done', 'active', 'pending', 'pending', 'pending']); ok('ready(delivery): same as preparing');
assert.equal(r.title, 'Tu pedido se está preparando'); ok('ready(delivery): preparing headline');

// OFD ACTIVE drop → map + tightening ETA + seg3 active(.5)
r = render({ status: 'out_for_delivery', driver_name: 'Elmer', is_active_drop: true, driver_location: { lat: 15.5, lng: -88 } });
assert.deepEqual(segClasses(r), ['done', 'done', 'active', 'pending', 'pending']); assert.equal(activeFill(r), .5); ok('OFD active: seg3 active(.5)');
assert.equal(r.title, 'Elmer está en camino'); assert.ok(r.subBig); ok('OFD active: "{name} está en camino", sub big');
assert.ok(r.avatarShown && r.avatarChar === 'E'); ok('OFD active: avatar E');
assert.equal(r.calls.updateDriverMap, 1); assert.equal(r.calls.refreshDriverEta, 1); assert.equal(r.etaIsActive, true); ok('OFD active: live map + ETA armed');

// OFD STACKED-WAITING → owner copy, NO map, NO countdown, smaller fill(.35)
r = render({ status: 'out_for_delivery', driver_name: 'Elmer', is_active_drop: false });
assert.deepEqual(segClasses(r), ['done', 'done', 'active', 'pending', 'pending']); assert.equal(activeFill(r), .35); ok('OFD stacked: seg3 active(.35) — smaller than active');
assert.equal(r.title, 'Elmer va en camino'); ok('OFD stacked: "{name} va en camino"');
assert.equal(r.sub, OWNER_WAITING); assert.ok(!r.subBig); ok('OFD stacked: owner parada copy, not big');
assert.equal(r.calls.updateDriverMap, 0); assert.equal(r.calls.refreshDriverEta, 0); assert.equal(r.calls.computeEta, 0); assert.equal(r.etaIsActive, false); ok('OFD stacked: NO map, NO ETA, NO countdown');
assert.ok(r.avatarShown); ok('OFD stacked: avatar shown');
// ⛔ the bar must NOT advance to Llegando and must NOT reveal the quick stop on the bar
assert.equal(r.segs[3], 'pending'); assert.equal(r.segs[4], 'pending'); ok('OFD stacked: never advances to Llegando (segs 4-5 pending)');

// OFD NEUTRAL (no is_active_drop) → ETA fallback, no map
r = render({ status: 'out_for_delivery', driver_name: 'Elmer', __eta: 8 });
assert.deepEqual(segClasses(r), ['done', 'done', 'active', 'pending', 'pending']); assert.equal(activeFill(r), .5); ok('OFD neutral: seg3 active(.5)');
assert.equal(r.title, 'Elmer está en camino'); assert.equal(r.sub, 'Llega en ~8 min'); assert.ok(r.subBig); ok('OFD neutral: ETA sub big');
assert.equal(r.calls.updateDriverMap, 0); ok('OFD neutral: no map yet');
r = render({ status: 'out_for_delivery', driver_name: 'Elmer', __eta: null });
assert.equal(r.sub, 'En ruta a tu dirección'); ok('OFD neutral (no eta): "En ruta a tu dirección"');

// OFD no driver yet
r = render({ status: 'out_for_delivery' });
assert.deepEqual(segClasses(r), ['done', 'done', 'active', 'pending', 'pending']); ok('OFD no-driver: seg3 active');
assert.equal(r.title, 'Tu pedido va en camino'); assert.ok(!r.avatarShown); assert.equal(r.calls.updateDriverMap, 0); ok('OFD no-driver: no avatar, no map');

// DELIVERED (Delta 2: warm phrase + " · Entregado " + lowercase am/pm time via the shared fmtTime)
r = render({ status: 'delivered', delivered_at: new Date(2026, 0, 1, 14, 5).getTime() });
assert.deepEqual(segClasses(r), ['done', 'done', 'done', 'done', 'done']); ok('delivered: all 5 green');
assert.equal(r.title, '¡Pedido entregado!'); assert.ok(r.titleSuccess); ok('delivered: title "¡Pedido entregado!" + success');
assert.equal(r.sub, '¡Buen provecho! · Entregado 2:05 pm'); ok('delivered: "¡Buen provecho! · Entregado 2:05 pm" (warm + lowercase time)');
assert.equal(r.liveHidden, true); ok('delivered: live-updates line hidden (terminal)');
r = render({ status: 'delivered' });   // no delivered_at → warm phrase alone (no dangling "· Entregado")
assert.equal(r.sub, '¡Buen provecho!'); ok('delivered (no time): "¡Buen provecho!" alone');
r = render({ status: 'completed', delivered_at: new Date(2026, 0, 1, 14, 5).getTime() });
assert.deepEqual(segClasses(r), ['done', 'done', 'done', 'done', 'done']); assert.equal(r.sub, '¡Buen provecho! · Entregado 2:05 pm'); ok('completed: same as delivered (incl. timestamp)');

// CANCELLED (unchanged copy)
r = render({ status: 'cancelled' });
assert.deepEqual(segClasses(r), ['pending', 'pending', 'pending', 'pending', 'pending']); assert.equal(r.barOpacity, '0.4'); ok('cancelled: 5 pending, bar dimmed');
assert.equal(r.title, 'Pedido cancelado'); assert.ok(r.titleDanger); ok('cancelled: danger headline');
assert.equal(r.sub, 'Si pagaste por adelantado, te contactaremos sobre el reembolso'); ok('cancelled: refund sub');

// ═══ PICKUP states (byte-equivalent behaviour to today; 3 segments) ═══
r = render({ status: 'new', order_type: 'pickup' });
assert.deepEqual(segClasses(r), ['active', 'pending', 'pending']); ok('pickup new: 3 segs, seg1 active');
assert.equal(r.title, 'Recibimos tu pedido'); ok('pickup new: headline');
r = render({ status: 'preparing', order_type: 'pickup' });
assert.deepEqual(segClasses(r), ['done', 'active', 'pending']); assert.equal(r.sub, 'Te avisaremos cuando esté listo'); ok('pickup preparing: seg2 active, "esté listo" sub');
r = render({ status: 'ready', order_type: 'pickup', restaurant_id: 'la_musa' });
assert.deepEqual(segClasses(r), ['done', 'done', 'done']); assert.ok(r.titleSuccess); ok('pickup ready: 3 green, success');
assert.equal(r.title, '¡Tu pedido está listo para recoger!'); assert.equal(r.sub, 'Pasá por La Musa a recogerlo'); ok('pickup ready: Listo copy, brand name');
r = render({ status: 'delivered', order_type: 'pickup', delivered_at: new Date(2026, 0, 1, 14, 5).getTime() });
assert.deepEqual(segClasses(r), ['done', 'done', 'done']); ok('pickup delivered: 3 green');
assert.equal(r.title, '¡Gracias por tu compra!'); assert.equal(r.sub, 'Recogido a las 2:05 PM'); ok('pickup delivered: thanks + timestamp (today\'s copy)');
r = render({ status: 'cancelled', order_type: 'pickup' });
assert.deepEqual(segClasses(r), ['pending', 'pending', 'pending']); ok('pickup cancelled: 3 pending');

// ═══ DYNAMIC-GATE HARDENING: avatar/map/eta are gated on OFD + driver, proven across states ═══
for (const st of ['new', 'preparing', 'delivered', 'cancelled']) {
  const x = render({ status: st, driver_name: 'Elmer', is_active_drop: true, driver_location: { lat: 15.5, lng: -88 } });
  assert.ok(!x.avatarShown, `${st}: NO avatar even with driver data present (gated on OFD)`);
  assert.equal(x.calls.updateDriverMap, 0, `${st}: NO map even with driver data (gated on OFD)`);
  assert.equal(x.etaIsActive, false, `${st}: ETA disarmed (gated on OFD)`);
}
ok('dynamic gate: a non-OFD status never shows avatar/map/ETA even when driver fields are present');
// and the OFD gate itself: driver chrome appears only WITH a driver name
{
  const withD = render({ status: 'out_for_delivery', driver_name: 'Elmer', is_active_drop: true, driver_location: { lat: 15.5, lng: -88 } });
  const noD = render({ status: 'out_for_delivery' });
  assert.ok(withD.avatarShown && !noD.avatarShown); ok('dynamic gate: OFD avatar iff driver_name present');
}

console.log(`tracker-segbar: OK (${n} cases)`);
