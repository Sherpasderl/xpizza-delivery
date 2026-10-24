import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { slotLabel } from './slot-format.js';
import { agingBaselineMs } from './dispatch-aging.js';

// «Programado» badge on RELEASED scheduled orders (dispatch-lite). A scheduled order keeps
// `scheduled_for` after it releases to a live status, but every indicator was keyed on
// status === 'scheduled', so a released 5:30 pm order looked identical to an ASAP order.
//
// This EXTRACTS the real passHTML + openDetail + hasSlot + slotLabelSafe + icClock from index.html
// and runs them over real order shapes. The badge gating (hasSlot && !isProg on the card,
// hasSlot && !isScheduled in the sheet) and the slot TEXT (the real slotLabel, imported above and
// also injected to back slotLabelSafe) are the genuine pieces; every orthogonal helper is an inert
// stub that cannot make the badge appear or change its text, so the assertions originate from the
// real render, not from the harness. The slot is always derived from scheduled_for via the real
// formatter — a hand-built "Hoy 5:30 PM" could not pass.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

const sliceFn = (sig) => {
  const start = html.indexOf(sig);
  assert.ok(start > -1, `${sig} present in index.html`);
  return html.slice(start, html.indexOf('\n}', start) + 2);
};
const sliceConst = (sig) => {
  const start = html.indexOf(sig);
  assert.ok(start > -1, `${sig} present in index.html`);
  return html.slice(start, html.indexOf('\n', start));
};

const passHTMLSrc = sliceFn('function passHTML(id, order){');
const openDetailSrc = sliceFn('function openDetail(orderId){');
const hasSlotSrc = sliceConst('const hasSlot =');
const slotSafeSrc = sliceConst('const slotLabelSafe =');
const icClockSrc = sliceConst('const icClock =');

assert.ok(passHTMLSrc.includes('showSched') && passHTMLSrc.includes('has-sched'), 'passHTML carries the badge wiring');
assert.ok(openDetailSrc.includes('class="sched"') && openDetailSrc.includes('data-close="1"'), 'openDetail carries the badge + full sheet');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

// Build a scope where the badge-relevant pieces are REAL (hasSlot, slotLabelSafe→slotLabel, icClock,
// the gating booleans, the templates) and everything orthogonal is an inert stub.
function build(STORE) {
  let captured = '';
  const openSheet = (h) => { captured = h; };
  const body = `
    const openPass = null;
    const XPD = { isStalePing: () => false };
    const DRIVER_STATUS_ES = {};
    const SECTION_LABELS = { encurso: 'En camino', completados: 'Completado' };
    const IC_STORE = '', IC_PLUS = '', IC_CHECK = '[check]', IC_PHONE = '';
    const levelOf = (id, o) => o._lv || 'calm';
    const minutesOf = (o) => (o._min == null ? 8 : o._min);
    const sectionForOrder = (o) => o._section || 'encurso';
    const displayDriverId = () => null;
    const assignedDriverId = () => null;
    const canReassign = () => false;
    const oneLineItems = () => 'items';
    const paymentLine = () => '';
    const dotVar = () => 'var(--ink3)';
    const stateParts = () => ({ lead: 'Daniela', tail: 'en camino' });
    const brandKey = () => 'lm';
    const brandMark = () => 'M';
    const brandName = () => 'La Musa';
    const displayLabel = (id) => '#' + id;
    const doneClock = () => '';
    const driverColorVar = () => '#000';
    const pipeHTML = () => '';
    const timelineHTML = () => '';
    const renderOrderItems = () => '';
    ${icClockSrc}
    ${hasSlotSrc}
    ${slotSafeSrc}
    ${passHTMLSrc}
    ${openDetailSrc}
    return { passHTML, openDetail };
  `;
  // eslint-disable-next-line no-new-func
  const api = new Function('slotLabel', 'STORE', 'escapeHtml', 'openSheet', body)(slotLabel, STORE, escapeHtml, openSheet);
  return {
    card: (id) => api.passHTML(id, STORE.orders[id] || STORE.scheduled[id]),
    detail: (id) => { captured = ''; api.openDetail(id); return captured; },
  };
}

const NOW = Date.now();
const SF = NOW + 95 * 60 * 1000;          // a real future slot; wording comes from the real formatter
const expectedSlot = () => slotLabel(SF, Date.now());   // independent, same formatter the badge uses

// ── hasSlot predicate (the status-independent key) ───────────────────────────
test('hasSlot is true only for a finite scheduled_for, independent of status', () => {
  const hasSlot = new Function(`${hasSlotSrc}; return hasSlot;`)();
  assert.equal(hasSlot({ scheduled_for: SF }), true);
  assert.equal(hasSlot({ scheduled_for: String(SF) }), true, 'numeric string coerces (matches Number(...))');
  assert.equal(hasSlot({}), false, 'ASAP (no field) → false');
  assert.equal(hasSlot({ scheduled_for: null }), false, 'null → false (Number(null)===0 must NOT count)');
  assert.equal(hasSlot({ scheduled_for: 0 }), false, 'epoch 0 → false (no spurious 1970 badge)');
  assert.equal(hasSlot({ scheduled_for: NaN }), false);
  assert.equal(hasSlot(null), false, 'null order never throws');
});

// ── released scheduled order: live time + persistent badge, card AND sheet ───
test('released scheduled order renders the badge on both card and sheet, with the real slot text', () => {
  const t = build({ orders: { o1: { customer_name: 'Rodrigo Fúnez', status: 'preparing', scheduled_for: SF, total: 430 } }, scheduled: {}, drivers: {}, tasks: {} });
  const card = t.card('o1');
  const want = expectedSlot();
  assert.ok(want.length > 0, 'the real formatter produced a slot label');
  assert.match(card, /class="peek has-sched"/, 'card peek is marked has-sched (peek grows for the third row)');
  assert.match(card, /<span class="sched">/, 'card carries the Programado pill');
  assert.ok(card.includes('Programado') && card.includes(want), `card badge shows the real slot "${want}"`);
  assert.match(card, /<b>8<\/b><s>min<\/s>/, 'the LIVE min column is kept (badge complements, never replaces it)');

  const sheet = t.detail('o1');
  assert.match(sheet, /<span class="sched">/, 'sheet carries the Programado pill under the name');
  assert.ok(sheet.includes(want), `sheet badge shows the same real slot "${want}"`);
  assert.ok(sheet.includes('>8<'), 'sheet top-right chip keeps the live min');
  assert.ok(!/<b>Programado<\/b>/.test(sheet.replace(/class="sched"[\s\S]*?<\/span>/, '')), 'Estado tile is the live label, not "Programado" (released, not pre-release)');
});

// ── ASAP order: byte-identical, no badge anywhere ────────────────────────────
test('ASAP order (no scheduled_for) renders no badge on card or sheet', () => {
  const t = build({ orders: { o2: { customer_name: 'Marcela Zelaya', status: 'preparing', total: 200 } }, scheduled: {}, drivers: {}, tasks: {} });
  const card = t.card('o2');
  assert.doesNotMatch(card, /has-sched/, 'no has-sched class');
  assert.doesNotMatch(card, /class="sched"/, 'no pill on the card');
  assert.doesNotMatch(t.detail('o2'), /class="sched"/, 'no pill in the sheet');
});

// ── pre-release scheduled: today's rendering, slot in the time column, no pill ─
test('pre-release scheduled keeps today’s rendering: slot in the time column, no duplicate pill', () => {
  const t = build({ orders: {}, scheduled: { o3: { customer_name: 'Rodrigo Fúnez', status: 'scheduled', scheduled_for: SF } }, drivers: {}, tasks: {} });
  const want = expectedSlot();
  const card = t.card('o3');
  assert.doesNotMatch(card, /has-sched/, 'pre-release carries no pill (isProg) — unchanged');
  assert.doesNotMatch(card, /class="sched"/, 'no pill pill on a pre-release card');
  assert.ok(card.includes('class="t rd"') && card.includes(want), 'the slot still shows in the lilac time column');

  const sheet = t.detail('o3');
  assert.doesNotMatch(sheet, /class="sched"/, 'no pill in the pre-release sheet (chip already shows the slot)');
  assert.ok(sheet.includes('Programado'), 'Estado tile reads "Programado" pre-release (unchanged)');
  assert.ok(sheet.includes(want), 'the top-right chip shows the slot pre-release');
});

// ── persistence through completados (mockup rule: appears "hasta Completados") ─
test('a delivered scheduled order still shows the badge (persists through completados)', () => {
  const t = build({ orders: { o4: { customer_name: 'Rodrigo Fúnez', status: 'delivered', scheduled_for: SF, total: 430, _lv: 'done', _section: 'completados' } }, scheduled: {}, drivers: {}, tasks: {} });
  const card = t.card('o4');
  assert.match(card, /class="peek has-sched"/, 'done scheduled card still peeks with the badge');
  assert.ok(card.includes('Programado') && card.includes(expectedSlot()), 'badge persists after delivery');
  assert.doesNotMatch(card, /<s>min<\/s>/, 'done card shows the check, not a min counter — badge is independent of the time column');
});

// ── aging baseline: released_at preferred, created_at fallback (ASAP unchanged) ─
test('agingBaselineMs prefers released_at for a released scheduled order; ASAP still ages from created_at', () => {
  const placed = 1_700_000_000_000;               // created hours before release
  const released = placed + 3 * 3600 * 1000;      // stamped at release
  assert.equal(agingBaselineMs({ created_at: placed, released_at: released }), released, 'released scheduled → age from release');
  assert.equal(agingBaselineMs({ created_at: placed }), placed, 'ASAP (no released_at) → created_at, UNCHANGED');
  assert.equal(agingBaselineMs({ released_at: released }), released, 'released_at alone is honored');
  assert.equal(agingBaselineMs({}), null, 'neither field → null (contract preserved)');
  assert.equal(agingBaselineMs(null), null, 'null order → null');
  assert.equal(agingBaselineMs({ created_at: placed, released_at: NaN }), placed, 'non-finite released_at falls back to created_at');
});
