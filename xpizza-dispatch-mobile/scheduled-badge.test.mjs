import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { slotLabel } from './slot-format.js';
import { agingBaselineMs, agingSeconds } from './dispatch-aging.js';

// «Programado» badge on RELEASED scheduled orders (dispatch-lite). A scheduled order keeps
// `scheduled_for` after it releases to a live status, but every indicator was keyed on
// status === 'scheduled', so a released order looked identical to an ASAP order.
//
// This EXTRACTS the real passHTML + openDetail + hasSlot + slotLabelSafe + minutesOf + icClock from
// index.html and runs them over orders produced by the REAL release writer. Aging is NOT stubbed:
// the real minutesOf (agingBaselineMs→agingSeconds) computes "min" from released_at. The slot TEXT
// is the real slotLabel. Byte-equality of the ASAP / pre-release render is asserted against the
// e2266b24 parent renderer, so the badge additions cannot change a non-badge order's bytes.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

const sliceFn = (src, sig) => { const s = src.indexOf(sig); assert.ok(s > -1, `${sig} present`); return src.slice(s, src.indexOf('\n}', s) + 2); };
const sliceConst = (src, sig) => { const s = src.indexOf(sig); assert.ok(s > -1, `${sig} present`); return src.slice(s, src.indexOf('\n', s)); };

const passHTMLSrc = sliceFn(html, 'function passHTML(id, order){');
const openDetailSrc = sliceFn(html, 'function openDetail(orderId){');
const hasSlotSrc = sliceConst(html, 'const hasSlot =');
const slotSafeSrc = sliceConst(html, 'const slotLabelSafe =');
const minutesOfSrc = sliceConst(html, 'const minutesOf =');
const icClockSrc = sliceConst(html, 'const icClock =');

assert.ok(passHTMLSrc.includes('showSched') && passHTMLSrc.includes('has-sched'), 'passHTML carries the badge wiring');
assert.ok(openDetailSrc.includes('class="sched"') && openDetailSrc.includes('data-close="1"'), 'openDetail carries the badge + full sheet');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

// Shared inert stubs for every helper orthogonal to the badge; real aging + real slot/formatter injected.
// `passSrc`/`openSrc` are swappable so the SAME scope renders both the branch and the e2266b24 parent.
function buildFrom(passSrc, openSrc) {
  let captured = '';
  const openSheet = (h) => { captured = h; };
  const stubs = `
    const openPass = null;
    const XPD = { isStalePing: () => false };
    const DRIVER_STATUS_ES = {};
    const SECTION_LABELS = { encurso: 'En camino', completados: 'Completado' };
    const IC_STORE = '', IC_PLUS = '', IC_CHECK = '[check]', IC_PHONE = '';
    const levelOf = (id, o) => o._lv || 'calm';
    const sectionForOrder = (o) => o._section || 'encurso';
    const displayDriverId = () => null;
    const assignedDriverId = () => null;
    const canReassign = () => false;
    const oneLineItems = () => 'items';
    const paymentLine = () => '';
    const dotVar = () => 'var(--ink3)';
    const stateParts = () => ({ lead: 'Repartidor', tail: 'en camino' });
    const brandKey = () => 'lm';
    const brandMark = () => 'M';
    const brandName = () => 'La Musa';
    const displayLabel = (id) => '#' + id;
    const doneClock = () => '';
    const driverColorVar = () => '#000';
    const pipeHTML = () => '';
    const timelineHTML = () => '';
    const renderOrderItems = () => '';
  `;
  const body = `${stubs}
    ${icClockSrc}
    ${hasSlotSrc}
    ${slotSafeSrc}
    ${minutesOfSrc}
    ${passSrc}
    ${openSrc}
    return { passHTML, openDetail };
  `;
  // eslint-disable-next-line no-new-func
  const mk = (STORE) => new Function('slotLabel', 'agingBaselineMs', 'agingSeconds', 'STORE', 'escapeHtml', 'openSheet', body)(slotLabel, agingBaselineMs, agingSeconds, STORE, escapeHtml, openSheet);
  return {
    card: (STORE, id) => mk(STORE).passHTML(id, STORE.orders[id] || STORE.scheduled[id]),
    detail: (STORE, id) => { captured = ''; mk(STORE).openDetail(id); return captured; },
  };
}
const branch = buildFrom(passHTMLSrc, openDetailSrc);

// The e2266b24 parent renderers, for byte-equality of non-badge output.
const baseHtml = execSync('git show e2266b24:xpizza-dispatch-mobile/index.html', { cwd: here + '/..', maxBuffer: 50 * 1024 * 1024 }).toString();
const base = buildFrom(sliceFn(baseHtml, 'function passHTML(id, order){'), sliceFn(baseHtml, 'function openDetail(orderId){'));

// ── the REAL release writer, run against an in-memory DB, is the source of the released order ──
const require = createRequire(import.meta.url);
const { releaseOne } = require('../xpizza-functions/scheduled-release-core.js');

function makeDb(initial) {
  const root = JSON.parse(JSON.stringify(initial));
  const get = (p) => (p ? p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), root) : root);
  const set = (p, v) => { const ks = p.split('/').filter(Boolean); let o = root; for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] ??= {}; o = o[ks[i]]; } const last = ks[ks.length - 1]; if (v === null) delete o[last]; else o[last] = v; };
  const ref = (p = '') => ({
    async transaction(fn) { const cur = get(p) ?? null; const res = fn(cur); if (res === undefined) return { committed: false, snapshot: { val: () => get(p) ?? null } }; set(p, res); return { committed: true, snapshot: { val: () => res } }; },
    async update(obj) { if (!p) { for (const [k, v] of Object.entries(obj)) set(k, v); } else { const cur = get(p) || {}; for (const [k, v] of Object.entries(obj)) { if (v === null) delete cur[k]; else cur[k] = v; } set(p, cur); } },
    async once() { return { val: () => get(p) ?? null }; },
  });
  return { ref, get };
}

const OPEN_ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { start: '00:00', end: '23:59' }]));

// Release a scheduled order with `now` chosen so released_at lands `agoMin` minutes in the past.
async function releasedOrder({ agoMin, rid = 'la_musa' }) {
  const now = Date.now() - agoMin * 60 * 1000;
  const SF = Date.now() + 90 * 60 * 1000;                 // a real future slot
  const scheduled = {
    status: 'scheduled', release_at: now - 1000, scheduled_for: SF, restaurant_id: rid,
    created_at: now - 5 * 3600 * 1000,                    // placed 5h before release
    customer_name: 'Rodrigo Fúnez', customer_phone: '+504 3345-7788', order_type: 'delivery',
    total: 430, items_text: '2× Pizza', address_detected: 'Res. Villas del Sol',
    hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'La Musa', restaurant_display_name: 'La Musa',
  };
  const db = makeDb({ orders: { o1187: scheduled }, restaurants: { [rid]: { identity: { hours: OPEN_ALL_DAY } } } });
  const res = await releaseOne({ db, genToken: () => 'tok', restaurantFallback: { lat: 15.5, lng: -88.0, name: 'La Musa', phone: '' } }, { orderId: 'o1187', now, claimId: 'c1' });
  assert.equal(res.released, true, 'the real writer materialized the order');
  return { order: db.get('orders/o1187'), now, SF };
}

// ── hasSlot predicate (the status-independent key) ───────────────────────────
test('hasSlot is true only for a finite POSITIVE scheduled_for, independent of status', () => {
  const hasSlot = new Function(`${hasSlotSrc}; return hasSlot;`)();
  assert.equal(hasSlot({ scheduled_for: Date.now() }), true);
  assert.equal(hasSlot({ scheduled_for: String(Date.now()) }), true, 'numeric string coerces');
  assert.equal(hasSlot({}), false, 'ASAP (no field) → false');
  assert.equal(hasSlot({ scheduled_for: null }), false, 'null → false (Number(null)===0 must NOT count)');
  assert.equal(hasSlot({ scheduled_for: 0 }), false, 'epoch 0 → false (no spurious 1970 badge)');
  assert.equal(hasSlot({ scheduled_for: NaN }), false);
  assert.equal(hasSlot(null), false, 'null order never throws');
});

// ── writer→renderer: the REAL released order renders the badge across the 4 live statuses, ──
// ── with the "min" computed from released_at by the REAL minutesOf (aging not stubbed) ───────
test('released scheduled order (real writer) shows the badge + release-based min across new/preparing/ready/out_for_delivery', async () => {
  const { order, SF } = await releasedOrder({ agoMin: 8 });     // released 8 min ago → min === 8
  assert.ok(Number.isFinite(order.released_at), 'writer stamped a numeric released_at');
  assert.equal(order.scheduled_for, SF, 'writer retained scheduled_for');
  assert.equal(order.status, 'new', 'writer materialized to a live status');
  const want = slotLabel(order.scheduled_for, Date.now());
  assert.ok(want.length > 0, 'real formatter produced a slot label');

  for (const status of ['new', 'preparing', 'ready', 'out_for_delivery']) {
    const o = { ...order, status };
    const STORE = { orders: { o1187: o }, scheduled: {}, drivers: {}, tasks: {} };
    const card = branch.card(STORE, 'o1187');
    assert.match(card, /class="peek has-sched"/, `[${status}] card peek marked has-sched`);
    assert.ok(card.includes('Programado') && card.includes(want), `[${status}] card badge shows the real slot`);
    assert.match(card, /<b>8<\/b><s>min<\/s>/, `[${status}] live min = 8, computed from released_at (not stubbed)`);

    const sheet = branch.detail(STORE, 'o1187');
    assert.match(sheet, /<span class="sched">/, `[${status}] sheet carries the pill`);
    assert.ok(sheet.includes(want), `[${status}] sheet badge shows the same real slot`);
    assert.ok(sheet.includes('>8<'), `[${status}] sheet top-right chip keeps the live min (8)`);
  }
});

// ── ASAP: no badge, and byte-identical to the e2266b24 render (card AND detail) ──────────────
test('ASAP order renders no badge and is byte-identical to the e2266b24 render (card + detail)', () => {
  const STORE = { orders: { o2: { customer_name: 'Marcela Zelaya', status: 'preparing', total: 200, created_at: Date.now() - 12 * 60 * 1000, order_type: 'delivery' } }, scheduled: {}, drivers: {}, tasks: {} };
  const card = branch.card(STORE, 'o2');
  assert.doesNotMatch(card, /has-sched/, 'no has-sched');
  assert.doesNotMatch(card, /class="sched"/, 'no pill on the card');
  assert.doesNotMatch(branch.detail(STORE, 'o2'), /class="sched"/, 'no pill in the sheet');
  assert.equal(branch.card(STORE, 'o2'), base.card(STORE, 'o2'), 'ASAP card byte-identical to e2266b24');
  assert.equal(branch.detail(STORE, 'o2'), base.detail(STORE, 'o2'), 'ASAP detail byte-identical to e2266b24');
});

// ── pre-release scheduled: today's rendering (slot in the time column, no pill), byte-identical ─
test('pre-release scheduled keeps today’s rendering and is byte-identical to the e2266b24 render (card + detail)', () => {
  const SF = Date.now() + 90 * 60 * 1000;
  const STORE = { orders: {}, scheduled: { o3: { customer_name: 'Rodrigo Fúnez', status: 'scheduled', scheduled_for: SF } }, drivers: {}, tasks: {} };
  const want = slotLabel(SF, Date.now());
  const card = branch.card(STORE, 'o3');
  assert.doesNotMatch(card, /has-sched/, 'pre-release carries no pill');
  assert.ok(card.includes('class="t rd"') && card.includes(want), 'slot shows in the lilac time column');
  assert.doesNotMatch(branch.detail(STORE, 'o3'), /class="sched"/, 'no pill in the pre-release sheet');
  assert.equal(branch.card(STORE, 'o3'), base.card(STORE, 'o3'), 'pre-release card byte-identical to e2266b24');
  assert.equal(branch.detail(STORE, 'o3'), base.detail(STORE, 'o3'), 'pre-release detail byte-identical to e2266b24');
});

// ── persistence through completados (mockup rule: appears "hasta Completados") ────────────────
test('a delivered scheduled order still shows the badge (persists through completados)', async () => {
  const { order } = await releasedOrder({ agoMin: 40 });
  const o = { ...order, status: 'delivered', delivered_at: Date.now(), _lv: 'done', _section: 'completados' };
  const card = branch.card({ orders: { o1187: o }, scheduled: {}, drivers: {}, tasks: {} }, 'o1187');
  assert.match(card, /class="peek has-sched"/, 'done scheduled card still peeks with the badge');
  assert.ok(card.includes('Programado'), 'badge persists after delivery');
  assert.doesNotMatch(card, /<s>min<\/s>/, 'done card shows the check, not a min counter — badge independent of the time column');
});

// ── aging baseline: released_at preferred, created_at fallback (ASAP unchanged) ───────────────
test('agingBaselineMs prefers released_at for a released scheduled order; ASAP still ages from created_at', () => {
  const placed = 1_700_000_000_000;
  const released = placed + 3 * 3600 * 1000;
  assert.equal(agingBaselineMs({ created_at: placed, released_at: released }), released, 'released scheduled → age from release');
  assert.equal(agingBaselineMs({ created_at: placed }), placed, 'ASAP (no released_at) → created_at, UNCHANGED');
  assert.equal(agingBaselineMs({ released_at: released }), released, 'released_at alone is honored');
  assert.equal(agingBaselineMs({}), null, 'neither field → null (contract preserved)');
  assert.equal(agingBaselineMs(null), null, 'null order → null');
  assert.equal(agingBaselineMs({ created_at: placed, released_at: NaN }), placed, 'non-finite released_at falls back');
});
