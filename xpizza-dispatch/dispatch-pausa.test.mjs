import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// «Pausa» desktop dispatch-center UI: the guarded on_break label, the card metaText preserving «En pausa · N
// min» alongside connectivity/load (real cascade), the picker BLOCK (disabled row + «En pausa» tag + no
// knum) with knum numbering the ENABLED rows only (digit↔badge), and the refusal toast.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
function fn(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error('fn not found: ' + name);
  let i = src.indexOf('{', at), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) break; } }
  return src.slice(at, i + 1);
}
const NOW = 1_700_000_000_000;
const FakeDate = { now: () => NOW };
const pausaLabel = new Function('Date', `${fn(html, 'pausaLabel')}; return pausaLabel;`)(FakeDate);

// ── P3-3: pausaLabel edge-case matrix ────────────────────────────────────────
test('pausaLabel: finite-guard + minutes, no coercion/negative/NaN (P3-3)', () => {
  assert.equal(pausaLabel({ break_since: NOW }), 'En pausa', 'just started → no tail');
  assert.equal(pausaLabel({ break_since: NOW - 59_999 }), 'En pausa', '59,999 ms → 0 min → no tail');
  assert.equal(pausaLabel({ break_since: NOW - 60_000 }), 'En pausa · 1 min', '60,000 ms → 1 min (boundary)');
  assert.equal(pausaLabel({ break_since: NOW - 42 * 60_000 }), 'En pausa · 42 min', '42 min');
  assert.equal(pausaLabel({ break_since: NOW + 60_000 }), 'En pausa', 'future → no negative tail');
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, '123', '5 min', {}, [], true])
    assert.equal(pausaLabel({ break_since: bad }), 'En pausa', `non-finite (${String(bad)}) → «En pausa»`);
  assert.equal(pausaLabel({}), 'En pausa', 'missing → «En pausa»');
});

// ── P2-1: the card metaText keeps «En pausa · N min», appending connectivity/load only where it applies ──
function metaOf({ d, gpsDark = false, push = true, hasOrders = false, orders = 0 }) {
  const block = html.slice(html.indexOf('let metaText;'), html.indexOf('else metaText = statusLabel;') + 'else metaText = statusLabel;'.length);
  return new Function('d', 'gpsDark', 'hasPushReachability', 'hasOrders', 'ordersForDriver', 'pausaLabel', 'statusLabel',
    `${block}; return metaText;`)(d, gpsDark, () => push, hasOrders, { length: orders }, pausaLabel, 'STATUS');
}
test('card metaText: «En pausa · N min» survives connectivity, token appended ONLY where it applies (P2-1)', () => {
  const d = { active: true, status: 'on_break', break_since: NOW - 5 * 60_000 };
  assert.equal(metaOf({ d }), 'En pausa · 5 min', 'fresh GPS + push + no orders → pause label ALONE (no invented token)');
  assert.equal(metaOf({ d, gpsDark: true }), 'En pausa · 5 min · Sin señal', 'GPS-dark → « · Sin señal» alongside');
  assert.equal(metaOf({ d, push: false }), 'En pausa · 5 min · Sin notificaciones', 'no-push → « · Sin notificaciones» alongside');
  assert.equal(metaOf({ d, hasOrders: true, orders: 2 }), 'En pausa · 5 min · 2 activas', 'load → « · N activas» alongside');
  // non-paused unchanged
  assert.equal(metaOf({ d: { active: true, status: 'available' }, gpsDark: true }), 'Sin señal', 'non-paused + GPS-dark → «Sin señal» (unchanged)');
});

// ── P2-2 + BLOCK: the picker row-map — paused rows disabled + «En pausa» tag + no knum; enabled rows number 1..9 ──
function renderRows(drivers) {
  const span = html.slice(html.indexOf('let knumSeq = 0;'), html.indexOf("}).join('');", html.indexOf('let knumSeq = 0;')) + "}).join('');".length);
  let captured = '';
  const sink = {}; Object.defineProperty(sink, 'innerHTML', { set(v) { captured = v; } });
  new Function('$', 'drivers', 'ordersByDriver', 'hasPushReachability', 'formatDistance', 'getDotClass', 'escapeHtml',
    `${span}`)(() => sink, drivers, {}, () => true, () => '1 km', () => '', escapeHtml);
  // split into per-row records
  return [...captured.matchAll(/<button type="button"[\s\S]*?<\/button>/g)].map((m) => {
    const b = m[0];
    return {
      uid: (b.match(/data-driver-uid="([^"]*)"/) || [])[1],
      disabled: /data-driver-uid="[^"]*" disabled/.test(b),
      paused: /class="picker-row paused/.test(b),
      knum: (b.match(/<span class="knum" aria-hidden="true">(\d+)<\/span>/) || [])[1] || null,
      tag: (b.match(/<span class="status-pill [^"]*">([^<]*)<\/span>/) || [])[1],
    };
  });
}
const drv = (uid, status) => ({ uid, driver: { status, name: uid }, distBase: 1, distCust: 1, stale: false });

test('picker row-map: paused rows disabled + «En pausa» tag + no knum; knum numbers ENABLED rows only (P2-2/BLOCK)', () => {
  // MIXED: available, paused, available, paused, available
  const rows = renderRows([drv('a0', 'available'), drv('p1', 'on_break'), drv('a2', 'available'), drv('p3', 'on_break'), drv('a4', 'available')]);
  assert.deepEqual(rows.filter((r) => r.paused).map((r) => r.uid), ['p1', 'p3'], 'the paused rows are the on_break drivers');
  for (const r of rows.filter((r) => r.paused)) {
    assert.ok(r.disabled, `${r.uid} paused row is disabled`);
    assert.equal(r.knum, null, `${r.uid} paused row has NO knum badge`);
    assert.equal(r.tag, 'En pausa', `${r.uid} shows the «En pausa» tag`);
  }
  // enabled rows keep their order and are numbered 1,2,3 (paused skipped, no dead numbers)
  assert.deepEqual(rows.filter((r) => !r.paused).map((r) => [r.uid, r.knum]), [['a0', '1'], ['a2', '2'], ['a4', '3']], 'badges number ENABLED rows in display order; paused do not advance the counter');
  rows.filter((r) => !r.paused).forEach((r) => assert.ok(!r.disabled, `${r.uid} enabled row not disabled`));
});

test('picker row-map: ALL-PAUSED → every row disabled, zero knum badges', () => {
  const rows = renderRows([drv('p0', 'on_break'), drv('p1', 'on_break')]);
  assert.ok(rows.every((r) => r.disabled && r.knum === null), 'all rows disabled, no badges');
});

test('picker row-map: knum caps at 9 enabled rows', () => {
  const rows = renderRows(Array.from({ length: 11 }, (_, i) => drv('a' + i, 'available')));
  assert.deepEqual(rows.map((r) => r.knum), ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, null], 'first 9 enabled get badges; the rest none');
});

test('assignFailMsg(on_break) → «El repartidor está en pausa»', () => {
  const assignFailMsg = new Function(`${fn(html, 'assignFailMsg')}; return assignFailMsg;`)();
  assert.equal(assignFailMsg('on_break'), 'El repartidor está en pausa');
  assert.equal(assignFailMsg('already_assigned'), 'Ya fue asignada a otro repartidor', 'other reasons unchanged');
});
