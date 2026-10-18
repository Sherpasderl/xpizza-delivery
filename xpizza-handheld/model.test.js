// H1b T1 — model.js, every decision ported from the approved prototype (spec/P-prototipo.dc.html renderVals). Fixtures are
// real /orders shapes (items_text, customer_name, prep, no_answer, handheld_answered, reject_outcome) for a third synthetic
// brand ('tb_'), never a production literal. Run with TZ=America/Tegucigalpa (package.json sets it).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './model.js';

const MIN = 60000;
const T = Date.UTC(2026, 9, 18, 1, 20);           // 19:20 in Tegucigalpa (UTC−6) → fmt '7:20'
const order = (id, over = {}) => ({ id, order_id: id, restaurant_id: 'tb_norte', status: 'new', order_type: 'delivery', display_number: 47,
  customer_name: 'Andrea M.', items_text: '2x Baleada con huevo y aguacate | 1x Pollo frito 3 piezas [Sin picante] | 1x Horchata grande',
  total: 485, payment_method: 'online', created_at: T, ...over });
const fullPrep = (acceptedAt, committed, extra = 0, extraFields = {}) => ({ committed_min: committed, extra_min: extra, accepted_at: acceptedAt,
  ready_at: acceptedAt + (committed + extra) * MIN, ...extraFields });

test('fmt: 12-hour clock without am/pm, as the prototype', () => {
  assert.equal(M.fmt(T), '7:20');
  assert.equal(M.fmt(T + 45 * MIN), '8:05');
  assert.equal(M.fmt(Date.UTC(2026, 9, 18, 18, 0)), '12:00');
  assert.equal(M.fmt(null), '--');
});

test('orderView: number, type, items with mods, note, pay line — from the real order fields', () => {
  const v = M.orderView(order('o1', { notes: 'Sin cebolla en las baleadas, por favor' }));
  assert.equal(v.num, '47');
  assert.equal(v.title, '#47 · Entrega');
  assert.equal(v.cust, 'Andrea M.');
  assert.deepEqual(v.items, [
    { q: '2×', name: 'Baleada con huevo y aguacate', mod: '', hasMod: false },
    { q: '1×', name: 'Pollo frito 3 piezas', mod: 'Sin picante', hasMod: true },
    { q: '1×', name: 'Horchata grande', mod: '', hasMod: false }]);
  assert.equal(v.qty, 4);
  assert.equal(v.note, '«Sin cebolla en las baleadas, por favor»');
  assert.equal(v.payLine, 'L 485 · pagado con tarjeta');
  assert.equal(v.sub, '4 productos · L 485 · Andrea M.');
  const p = M.orderView(order('abcdef123456', { display_number: undefined, order_type: 'pickup', payment_method: 'cash', notes: '' }));
  assert.equal(p.title, '#123456 · Pickup');
  assert.equal(p.payLine, 'L 485 · paga en efectivo al recoger');
  assert.equal(p.hasNote, false);
  assert.equal(M.orderView(order('o2', { payment_method: 'cash' })).payLine, 'L 485 · paga en efectivo al recibir');
  // a bracketed extras group containing ' | ' stays ONE item (the KDS bracket-aware split)
  assert.equal(M.orderView(order('o3', { items_text: '2x Pizza [Pizza 1: extra | Pizza 2: extra] | 1x Soda' })).items.length, 2);
  assert.equal(M.orderView(order('o4', { items_text: '' })).qty, 0);
});

test('queues: only new | preparing | ready; nuevos oldest first; prep by ready_at; listos by ready_marked_at; scheduled hidden', () => {
  const orders = {
    a: order('a', { created_at: T + 2 * MIN }), b: order('b', { created_at: T }),
    c: order('c', { status: 'preparing', prep: fullPrep(T, 30) }), d: order('d', { status: 'preparing', prep: fullPrep(T, 15) }),
    e: order('e', { status: 'preparing' }),                                   // no prep → last
    f: order('f', { status: 'ready', prep: { ready_marked_at: T + 9 * MIN } }), g: order('g', { status: 'ready', prep: fullPrep(T, 10, 0, { ready_marked_at: T + 3 * MIN }) }),
    h: order('h', { status: 'scheduled' }), i: order('i', { status: 'releasing' }), j: order('j', { status: 'cancelled' }), k: order('k', { status: 'delivered' }),
  };
  const q = M.queues(orders);
  assert.deepEqual(q.nuevos.map((o) => o.id), ['b', 'a']);
  assert.deepEqual(q.prep.map((o) => o.id), ['d', 'c', 'e']);
  assert.deepEqual(q.listos.map((o) => o.id), ['g', 'f']);
  assert.deepEqual(M.queues([]), { nuevos: [], prep: [], listos: [] });
});

test('lateTag: the prototype ladder', () => {
  assert.deepEqual(M.lateTag(12), { cls: '', label: 'Faltan 12 min' });
  assert.deepEqual(M.lateTag(5), { cls: 'soon', label: 'Faltan 5 min' });
  assert.deepEqual(M.lateTag(0), { cls: 'late', label: 'Listo ahora' });
  assert.deepEqual(M.lateTag(-3), { cls: 'late', label: 'Atrasado 3 min' });
  assert.deepEqual(M.lateTag(null), { cls: '', label: '--' });
});

test('ladderStrip: server stamps only — an old order with no stamps is neutral; red wins; malformed is neutral', () => {
  const stamp = { at: T, op_id: 'op_x' };
  assert.equal(M.ladderStrip(order('o', { created_at: T - 60 * MIN })), null);
  assert.deepEqual(M.ladderStrip(order('o', { no_answer: { dispatch_notified: stamp } })), { tone: 'amber', text: 'Despacho avisado · aceptá o rechazá' });
  assert.deepEqual(M.ladderStrip(order('o', { no_answer: { paused: stamp } })), { tone: 'red', text: 'Sucursal en pausa · este pedido sigue esperando' });
  assert.equal(M.ladderStrip(order('o', { no_answer: { dispatch_notified: stamp, paused: stamp } })).tone, 'red');
  for (const bad of [{ dispatch_notified: true }, { paused: { at: 'x' } }, 'x', { dispatch_notified: { op_id: 'a' } }]) assert.equal(M.ladderStrip(order('o', { no_answer: bad })), null);
});

test('newCard: tag and ring from age (display), colour and ladder line from stamps', () => {
  const o = order('o', { created_at: T });
  assert.deepEqual(pick(M.newCard(o, { nowMs: T, opened: false }), ['tag', 'tagCls', 'ringColor', 'ladder', 'ringOff']),
    { tag: 'Nuevo', tagCls: 'new', ringColor: '#15181E', ladder: 'Despacho en 2 min', ringOff: '81.68' });
  assert.deepEqual(pick(M.newCard(o, { nowMs: T + 3 * MIN, opened: false }), ['tag', 'tagCls', 'ringColor']),
    { tag: 'Sin abrir · 3 min', tagCls: 'late', ringColor: '#15181E' }, 'age alone never colours the ring');
  const amber = order('o', { created_at: T, no_answer: { dispatch_notified: { at: T, op_id: 'a' } } });
  assert.deepEqual(pick(M.newCard(amber, { nowMs: T + 3 * MIN, opened: true }), ['tag', 'ringColor', 'ladder']),
    { tag: 'Abierto · sin decidir', ringColor: '#C58A12', ladder: 'Despacho avisado · pausa en 2 min' });
  const red = order('o', { created_at: T, no_answer: { paused: { at: T, op_id: 'p' } } });
  assert.deepEqual(pick(M.newCard(red, { nowMs: T + 9 * MIN }), ['ringColor', 'ladder', 'ringOff']),
    { ringColor: '#B42318', ladder: 'Pausamos la sucursal por falta de respuesta', ringOff: '0.00' });
  assert.equal(M.newCard(o, { nowMs: T + 9 * MIN }).ladder, 'Despacho en 1 min', 'a late server never shows 0 or negative');
  assert.equal(M.newCard(o, { nowMs: null }).tag, 'Nuevo', 'unknown clock → no age');
});

test('newCard for a rejected-but-new order: cancelling vs the manual-review tag', () => {
  const rej = { kind: 'rejected', at: T, by: 'hh', op_id: 'op' };
  assert.equal(M.newCard(order('o', { handheld_answered: rej }), { nowMs: T }).tag, 'Cancelando…');
  const man = M.newCard(order('o', { handheld_answered: rej, reject_outcome: { state: 'manual_review', at: T, op_id: 'op', by: 'handler' } }), { nowMs: T });
  assert.deepEqual(pick(man, ['tag', 'ladder', 'ringColor', 'ringOff']), { tag: 'Despacho termina la cancelación', ladder: 'Despacho termina la cancelación', ringColor: '#15181E', ringOff: '81.68' });
});

test('chips / clampPrep / busyExplain', () => {
  assert.deepEqual(M.chips(18).map((c) => [c.label, c.value]), [['−5', 13], ['18', 18], ['+5', 23], ['+10', 28], ['+15', 33]]);
  assert.deepEqual(M.chips(8).map((c) => [c.value, c.dis]), [[5, true], [8, false], [13, false], [18, false], [23, false]]);
  assert.deepEqual(M.chips(88).map((c) => [c.value, c.dis]), [[83, false], [88, false], [90, true], [90, true], [90, true]]);
  assert.equal(M.clampPrep(3), 5); assert.equal(M.clampPrep(120), 90); assert.equal(M.clampPrep(22), 22);
  assert.equal(M.clampPrep(NaN), null); assert.equal(M.clampPrep('20'), null);
  assert.equal(M.busyExplain(18, 15), '33 = 18 de siempre + 15 de Ocupado');
  assert.equal(M.busyExplain(18, 0), '');
  assert.equal(M.acceptLabel(33), 'Aceptar · listo en 33 min');
});

test('effectiveBusy: H1a semantics (add ∈ {10,15,20}, finite until, now < until)', () => {
  assert.equal(M.effectiveBusy({ add_min: 15, until: T + MIN }, T), 15);
  assert.equal(M.effectiveBusy({ add_min: 15, until: T }, T), 0);
  for (const bad of [null, { add_min: 12, until: T + MIN }, { add_min: 15, until: 'x' }, { add_min: 15 }]) assert.equal(M.effectiveBusy(bad, T), 0);
});

test('pill + banners: offline > paused > busy > open; auto pause copy; unknown control reads as paused', () => {
  assert.deepEqual(pick(M.pill({ offline: true, control: null, nowMs: T }), ['cls', 'label']), { cls: 'off', label: 'Sin conexión' });
  assert.deepEqual(pick(M.pill({ offline: false, control: null, nowMs: T }), ['cls', 'label', 'mode']), { cls: '', label: 'Abierto', mode: 'open' });
  const busy = M.pill({ offline: false, control: { busy: { add_min: 15, until: T + 30 * MIN, since: T - 30 * MIN } }, nowMs: T });
  assert.deepEqual(pick(busy, ['cls', 'label', 'mode', 'busyAdd', 'ringAria', 'busyText']),
    { cls: 'busy', label: 'Ocupado', mode: 'busy', busyAdd: 15, ringAria: 'Quedan 30 min de Ocupado', busyText: 'Ocupado +15 min · hasta 7:50' });
  assert.equal(busy.ringOff, '20.42');
  const timed = M.pill({ offline: false, control: { current: { paused: true, until: T + 30 * MIN, by: 'own' } }, nowMs: T });
  assert.deepEqual(pick(timed, ['cls', 'label', 'mode', 'pauseText']), { cls: 'pz', label: 'Pausado', mode: 'paused', pauseText: 'Pedidos pausados · hasta 7:50' });
  assert.equal(M.pill({ offline: false, control: { current: { paused: true, by: 'sistema' } }, nowMs: T }).pauseText,
    'Pausamos la sucursal porque nadie respondió. No entran pedidos nuevos.');
  assert.equal(M.pill({ offline: false, control: { current: { paused: true, until: T - 1 } }, nowMs: T }).mode, 'open', 'an expired timed pause is open');
  assert.equal(M.pill({ offline: false, control: { current: { paused: 'yes' } }, nowMs: T }).mode, 'paused', 'UNKNOWN fails closed');
  assert.equal(M.pill({ offline: false, control: { current: { paused: true, until: T + MIN }, busy: { add_min: 10, until: T + MIN } }, nowMs: T }).mode, 'paused');
});

test('canMore: preparing, online, no driver, extra < 30, valid full prep', () => {
  const p = order('o', { status: 'preparing', prep: fullPrep(T, 20, 25) });
  assert.equal(M.canMore(p, false, false), true);
  assert.equal(M.canMore(p, true, false), false);
  assert.equal(M.canMore(p, false, true), false);
  assert.equal(M.canMore(order('o', { status: 'preparing', prep: fullPrep(T, 20, 30) }), false, false), false);
  assert.equal(M.canMore(order('o', { status: 'preparing', prep: { ready_marked_at: T } }), false, false), false);
  assert.equal(M.canMore(order('o', { status: 'ready', prep: fullPrep(T, 20) }), false, false), false);
  assert.deepEqual(M.moreChips(order('o', { status: 'preparing', prep: fullPrep(T, 20, 20) })).map((c) => [c.value, c.dis]), [[5, false], [10, false], [15, true]]);
});

test('rejectState: from persisted state only', () => {
  const rej = { kind: 'rejected', at: T, by: 'hh', op_id: 'op' };
  const out = (state) => ({ state, at: T, op_id: 'op', by: 'handler' });
  assert.equal(M.rejectState(order('o', { status: 'cancelled' })), 'cancelled');
  assert.equal(M.rejectState(order('o', { status: 'cancelled', handheld_answered: rej })), 'cancelled');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej, reject_outcome: out('cancelled') })), 'cancelled');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej, reject_outcome: out('refund_pending') })), 'cancelled');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej, reject_outcome: out('manual_review') })), 'manual');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej, reject_outcome: out('not_cancelable') })), 'manual', 'H1a r1 P2-4: Despacho finishes it');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej, reject_outcome: out('referred_recon') })), 'manual');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej })), 'cancelling');
  assert.equal(M.rejectState(order('o', { handheld_answered: rej, reject_outcome: out('weird') })), 'cancelling');
  assert.equal(M.rejectState(order('o', { reject_outcome: out('cancelled') })), null, 'an outcome without a rejected answer → null');
  assert.equal(M.rejectState(order('o', { handheld_answered: { kind: 'accepted' } })), null);
  assert.equal(M.rejectState(order('o')), null);
});

test('alarmSet: sorted ids of new orders with no handheld_answered', () => {
  const orders = [order('z'), order('a'), order('m', { handheld_answered: { kind: 'rejected' } }), order('p', { status: 'preparing' })];
  assert.deepEqual(M.alarmSet(orders), ['a', 'z']);
  assert.deepEqual(M.alarmSet({}), []);
});

test('prepCard / readyCard / driverView: real first name or a nameless fallback; at-restaurant; ETA only when computed', () => {
  const none = { assigned: false, firstName: null, atRestaurant: false, etaMs: null };
  const named = { assigned: true, firstName: 'Ana', atRestaurant: false, etaMs: null };
  const eta = { assigned: true, firstName: 'Ana', atRestaurant: false, etaMs: T + 22 * MIN };   // arrives 7:42
  const nameless = { assigned: true, firstName: null, atRestaurant: false, etaMs: T + 22 * MIN };
  const here = { assigned: true, firstName: 'Ana', atRestaurant: true, etaMs: T + 22 * MIN };
  const prep = order('o', { status: 'preparing', prep: fullPrep(T, 20) });
  const c = M.prepCard(prep, { nowMs: T + 17 * MIN, driver: none });
  assert.deepEqual(pick(c, ['time', 'tag', 'tagCls', 'tmColor', 'driver']), { time: '7:40', tag: 'Faltan 3 min', tagCls: 'soon', tmColor: '#15181E', driver: 'Repartidor programado' });
  const late = M.prepCard(prep, { nowMs: T + 23 * MIN, driver: named });
  assert.deepEqual(pick(late, ['tag', 'tmColor', 'driver']), { tag: 'Atrasado 3 min', tmColor: '#9A1C12', driver: 'Ana asignado' }, 'no ETA → the name only, never a guessed time');
  assert.equal(M.prepCard(prep, { nowMs: T, driver: eta }).driver, 'Ana asignado · llega 7:42');
  assert.equal(M.prepCard(prep, { nowMs: T, driver: nameless }).driver, 'Repartidor asignado · llega 7:42');
  assert.equal(M.prepCard(prep, { nowMs: T, driver: here }).driver, 'Ana está en el local');
  assert.equal(M.prepCard(order('o', { status: 'preparing', order_type: 'pickup', prep: fullPrep(T, 20) }), { nowMs: T }).driver, 'El cliente pasa a recoger');
  assert.deepEqual(pick(M.prepCard(order('o', { status: 'preparing' }), { nowMs: T }), ['time', 'tag', 'driver']), { time: '--', tag: '--', driver: 'Repartidor programado' }, 'no driver info → unassigned');
  const rdy = (o = {}) => order('o', { status: 'ready', prep: { ready_marked_at: T + 5 * MIN }, ...o });
  assert.deepEqual(pick(M.readyCard(rdy(), { nowMs: T + 5 * MIN, driver: none }), ['tag', 'line', 'lineCls', 'isPickup']), { tag: 'Listo 7:25', line: 'Buscando repartidor ahora', lineCls: '', isPickup: false });
  assert.deepEqual(pick(M.readyCard(rdy(), { nowMs: T + 19 * MIN, driver: eta }), ['line', 'lineCls']), { line: 'Ana llega en 3 min', lineCls: 'ok' });
  assert.equal(M.readyCard(rdy(), { nowMs: T + 22 * MIN + 1, driver: eta }).line, 'Ana llega en 1 min', 'a passed ETA never shows 0 or negative');
  assert.equal(M.readyCard(rdy(), { nowMs: T, driver: named }).line, 'Ana asignado');
  assert.equal(M.readyCard(rdy(), { nowMs: T, driver: here }).line, 'Ana está en el local');
  assert.equal(M.readyCard(rdy({ order_type: 'pickup' }), {}).line, 'Esperando al cliente');
  // detail
  assert.deepEqual(M.driverView(order('o', { status: 'preparing' }), none, T), { name: 'Repartidor programado', sub: '' });
  assert.deepEqual(M.driverView(order('o', { status: 'ready' }), none, T), { name: 'Buscando repartidor', sub: 'Lo pedimos ahora mismo' });
  assert.deepEqual(M.driverView(order('o', { status: 'preparing' }), named, T), { name: 'Ana', sub: '' });
  assert.deepEqual(M.driverView(order('o', { status: 'preparing' }), eta, T), { name: 'Ana', sub: 'Asignado · llega 7:42' });
  assert.deepEqual(M.driverView(order('o', { status: 'ready' }), eta, T + 19 * MIN), { name: 'Ana', sub: 'En camino · llega en 3 min' });
  assert.deepEqual(M.driverView(order('o', { status: 'preparing' }), nameless, T), { name: 'Repartidor asignado', sub: 'Asignado · llega 7:42' });
  assert.deepEqual(M.driverView(order('o', { status: 'ready' }), here, T), { name: 'Ana', sub: 'Ana está en el local' });
  // detail info line (Más tiempo locked)
  const prepO = order('o', { status: 'preparing', prep: fullPrep(T, 20, 0) });
  assert.equal(M.detailInfo(prepO, { offline: false, driver: named }), 'Ana ya va en camino: la hora ya no se puede mover. Si te atrasás, avisale a Despacho.');
  assert.equal(M.detailInfo(prepO, { offline: false, driver: { ...nameless, etaMs: null } }), 'El repartidor ya va en camino: la hora ya no se puede mover. Si te atrasás, avisale a Despacho.');
  assert.equal(M.detailInfo(prepO, { offline: true, driver: none }), 'Sin conexión no se puede pedir más tiempo ni escribirle al cliente. «Listo» se guarda y se envía al volver.');
  assert.equal(M.detailInfo(order('o', { status: 'preparing', prep: fullPrep(T, 20, 30) }), { offline: false, driver: none }), 'Ya sumaste 30 min. Para más tiempo, hablá con Despacho.');
  assert.equal(M.detailInfo(order('o', { status: 'ready' }), { offline: true, driver: none }), 'Sin conexión. Se envía al volver.');
  assert.equal(M.detailInfo(prepO, { offline: false, driver: none }), '');
});

test('driverInfo: normalizes merchantOrderState fail-closed (unknown → unassigned / null / false); ETA is supplied separately', () => {
  const loc = { lat: 15.5, lng: -88.02, at: T };
  assert.deepEqual(M.driverInfo({ driver_assigned: true, driver_first_name: 'Ana', driver_at_restaurant: true, driver_location: loc }, T + 9 * MIN),
    { assigned: true, firstName: 'Ana', atRestaurant: true, location: loc, etaMs: T + 9 * MIN });
  assert.deepEqual(M.driverInfo({ driver_assigned: true, driver_first_name: '  ', driver_at_restaurant: 'yes', driver_location: { lat: 'x' } }),
    { assigned: true, firstName: null, atRestaurant: false, location: null, etaMs: null });
  assert.deepEqual(M.driverInfo({ driver_assigned: 'x', driver_first_name: 'Ana', driver_at_restaurant: true, driver_location: loc }, T),
    { assigned: false, firstName: null, atRestaurant: false, location: null, etaMs: null }, 'not assigned → nothing else is believed');
  assert.deepEqual(M.driverInfo(null), { assigned: false, firstName: null, atRestaurant: false, location: null, etaMs: null });
  assert.equal(M.driverInfo({ driver_assigned: true, driver_first_name: 'Ana' }, NaN).etaMs, null);
});

test('brand-agnostic: model.js carries no restaurant or brand literal', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('./model.js', import.meta.url), 'utf8');
  for (const lit of ['x_pizza', 'xpizza', 'la_musa', 'Fonda Mirador', 'Carlos']) assert.ok(!src.includes(lit), lit);
});

function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

test('applyPending: queued accept / more / ready (and an undo-window Listo) overlay the feed, as the prototype moves cards at once', () => {
  const orders = { a: order('a'), b: order('b', { status: 'preparing', prep: fullPrep(T, 20) }), c: order('c', { status: 'preparing', prep: fullPrep(T, 15) }) };
  const items = [
    { action: 'accept', order_id: 'a', payload: { prep_min: 25 }, enqueued_at: T + MIN },
    { action: 'more', order_id: 'b', payload: { add_min: 10 }, enqueued_at: T + 2 * MIN },
    { action: 'ready', order_id: 'a', payload: null, enqueued_at: T + 3 * MIN },
    { action: 'accept', order_id: 'zz', payload: { prep_min: 20 }, enqueued_at: T },          // not in the feed → ignored
  ];
  const v = M.applyPending(orders, items, [{ order_id: 'c', at: T + 4 * MIN }]);
  assert.deepEqual([v.a.status, v.a.prep.ready_marked_at, v.a.prep.committed_min, v.a._pending], ['ready', T + 3 * MIN, 25, true]);
  assert.deepEqual([v.b.prep.extra_min, v.b.prep.ready_at, v.b._pending], [10, T + 30 * MIN, true]);
  assert.deepEqual([v.c.status, v.c.prep.ready_marked_at, v.c._pending, v.c._undo], ['ready', T + 4 * MIN, false, true]);
  assert.equal(v.zz, undefined);
  assert.equal(orders.a.status, 'new', 'the feed itself is never mutated');
  // the server already moved on (accepted elsewhere / cancelled) → the overlay never resurrects a stale step
  const moved = M.applyPending({ a: order('a', { status: 'cancelled' }) }, [{ action: 'accept', order_id: 'a', payload: { prep_min: 20 }, enqueued_at: T }], []);
  assert.equal(moved.a.status, 'cancelled');
});
