import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agingBaselineMs, agingSeconds, formatAging } from './dispatch-aging.js';

// P2-1 (codex r1): the DESKTOP Torre serialized `created_at` into `data-aging`, and the 1 s timer
// recomputed from it — so a released scheduled order rendered release-based ("8:00") then flipped to
// placement-based ("5h") on the next tick. The fix serializes `agingBaselineMs(o)`. This drives the
// REAL colaCard (Cola) and agedOrd (En Fila) renderers over a released order, parses the real
// data-aging they emit, then runs the REAL aging-timer callback over it, asserting the age stays
// release-based through the tick. Reverting either serialization to created_at makes the ticked age
// read "5h" and fails this test.

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

const sliceFn = (sig) => { const s = html.indexOf(sig); assert.ok(s > -1, `${sig} present`); return html.slice(s, html.indexOf('\n}', s) + 2); };
const colaCardSrc = sliceFn('function colaCard(e, showSelfBtn) {');
// En Fila: `const agedOrd = (o, itemsHtml) => { ... };`
const agedStart = html.indexOf('const agedOrd = (o, itemsHtml) => {');
const agedOrdSrc = html.slice(agedStart, html.indexOf('\n  };', agedStart) + 4);
assert.ok(agedStart > -1 && agedOrdSrc.includes('data-aging'), 'located agedOrd (En Fila)');
// The real aging-tick callback body.
const tickStart = html.indexOf("document.querySelectorAll('[data-aging]').forEach");
const tickSrc = html.slice(tickStart, html.indexOf('});', tickStart) + 3);
assert.ok(tickStart > -1 && tickSrc.includes('el.dataset.aging') && tickSrc.includes('formatAging'), 'located the real aging timer');

// Build the two real renderers in one scope; badge/aging deps are real, everything else inert.
const prelude = `
  const deliveryRisk = () => ({ band: 'green', level: 'ok' });
  const etaSnapshots = { baseline: () => null };
  const etaCache = {};
  const isCashPayment = () => false;
  const allTasks = {};
  const allDrivers = {};
  const isStalledAssignment = () => false;
  const expandedOrderIds = new Set();
  const displayOrderLabel = (o) => '#' + o.order_id;
  const scheduledBadge = () => '';
  const renderOrderExpanded = () => '';
  const agingBand = () => 'green';
`;
const renderers = new Function('agingBaselineMs', 'agingSeconds', 'formatAging', 'escapeHtml',
  `${prelude}\n${colaCardSrc}\n${agedOrdSrc}\n; return { colaCard, agedOrd };`)(agingBaselineMs, agingSeconds, formatAging, escapeHtml);

// The real timer, applied to a parsed DOM shim.
const runTick = new Function('document', 'formatAging', 'agingSeconds', `${tickSrc}`);
const applyTick = (els) => {
  const document = { querySelectorAll: () => els };
  runTick(document, formatAging, agingSeconds);
};
// Parse <span class="ord-age ..." data-aging="X">Y</span> → a tickable element shim.
const parseAge = (htmlStr) => {
  const m = htmlStr.match(/class="ord-age[^"]*"\s+data-aging="([^"]*)">([^<]*)</);
  assert.ok(m, 'rendered card has an ord-age span with data-aging');
  return { dataset: { aging: m[1] }, textContent: m[2] };
};

// A released scheduled order: released 8 min ago, placed 5 h before release.
const NOW = Date.now();
const released = {
  order_id: 'o1187', customer_name: 'Rodrigo Fúnez', status: 'new',
  released_at: NOW - 8 * 60 * 1000, created_at: NOW - 5 * 3600 * 1000,
  scheduled_for: NOW + 90 * 60 * 1000, total: 430, items_text: '2× Pizza', payment_method: 'cash',
};

for (const [surface, render] of [
  ['Cola', (o) => renderers.colaCard({ order: o, band: 'green', buckets: new Set(), primary: 'unassigned' }, false)],
  ['En Fila', (o) => renderers.agedOrd(o, 'items')],
]) {
  test(`${surface}: a released scheduled order ages from release at render AND after the 1 s tick (not placement)`, () => {
    const el = parseAge(render(released));
    // Serialized baseline is released_at, not created_at.
    assert.equal(el.dataset.aging, String(released.released_at), `${surface} serializes released_at into data-aging`);
    assert.notEqual(el.dataset.aging, String(released.created_at), `${surface} does NOT serialize created_at`);
    // Initial render is release-based (~8 min → "M:SS", under an hour).
    assert.match(el.textContent, /^[0-9]:[0-9]{2}$|^[0-9]+:[0-9]{2}$/, `${surface} initial age is minutes:seconds (release-based), got "${el.textContent}"`);
    const before = el.textContent;
    // The REAL timer tick must keep it release-based — the bug flipped it to "5h".
    applyTick([el]);
    assert.doesNotMatch(el.textContent, /h$|d$/, `${surface} ticked age is NOT hours/days (placement) — got "${el.textContent}"`);
    assert.ok(Number(el.textContent.split(':')[0]) <= 9, `${surface} ticked age stays ~8 min (release-based), got "${el.textContent}" (was "${before}")`);
  });
}

// An ASAP order (no released_at) is unchanged: it still ages from created_at, before and after the tick.
test('ASAP order (no released_at) still serializes created_at and ticks from placement — unchanged', () => {
  const asap = { ...released, released_at: undefined };
  const el = parseAge(renderers.colaCard({ order: asap, band: 'green', buckets: new Set(), primary: 'unassigned' }, false));
  assert.equal(el.dataset.aging, String(asap.created_at), 'ASAP serializes created_at (agingBaselineMs falls back)');
  applyTick([el]);
  assert.match(el.textContent, /h$/, 'ASAP placed 5h ago reads "5h" — ASAP aging unchanged');
});
