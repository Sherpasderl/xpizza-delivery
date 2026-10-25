import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// «Pausa» mobile dispatch-center UI: the on_break status label («En pausa · N min», guarded), the aligned
// DRIVER_STATUS_ES copy, the pause label surviving stale-GPS in BOTH the roster and the picker (run on the
// REAL renderers), the picker BLOCK (disabled + «En pausa» tag), and the refusal toast.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

// Brace-match a `function NAME(...) { ... }` out of the source (balanced ${} templates OK).
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

// ── P3-3: pausaLabel edge-case matrix (clock frozen) ─────────────────────────
test('pausaLabel: finite-guard + minutes, no coercion/negative/NaN (P3-3)', () => {
  assert.equal(pausaLabel({ break_since: NOW - 0 }), 'En pausa', 'just started (0 ms) → no tail');
  assert.equal(pausaLabel({ break_since: NOW - 59_999 }), 'En pausa', '59,999 ms → still 0 min → no tail');
  assert.equal(pausaLabel({ break_since: NOW - 60_000 }), 'En pausa · 1 min', '60,000 ms → 1 min (boundary)');
  assert.equal(pausaLabel({ break_since: NOW - 5 * 60_000 }), 'En pausa · 5 min', '5 min');
  assert.equal(pausaLabel({ break_since: NOW + 10 * 60_000 }), 'En pausa', 'FUTURE stamp → negative → no tail (never «-10 min»)');
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, '123', '5 min', {}, [], true])
    assert.equal(pausaLabel({ break_since: bad }), 'En pausa', `non-finite break_since (${String(bad)}) → «En pausa», no coercion`);
  assert.equal(pausaLabel({}), 'En pausa', 'missing break_since → «En pausa»');
  assert.equal(pausaLabel(null), 'En pausa', 'missing driver → «En pausa»');
});

// ── aligned copy ─────────────────────────────────────────────────────────────
test('DRIVER_STATUS_ES.on_break aligned to «En pausa» (not «En descanso»)', () => {
  const lit = html.match(/const DRIVER_STATUS_ES = \{[\s\S]*?\};/)[0];
  const map = new Function(`return ${lit.replace(/^const DRIVER_STATUS_ES = /, '').replace(/;$/, '')}`)();
  assert.equal(map.on_break, 'En pausa');
  assert.ok(!/En descanso/.test(html), 'no «En descanso» remains anywhere');
});

// ── P2-1: the roster renderer keeps «En pausa» through stale-GPS (real driverRow) ──
function mkDriverRow(deps) {
  return new Function('orderForDriver', 'DRIVER_STATUS_ES', 'XPD', 'pausaLabel', 'escapeHtml', 'displayLabel', 'driverColorVar', 'STORE', 'Date',
    `${fn(html, 'driverRow')}; return driverRow;`)(
    deps.orderForDriver, deps.DRIVER_STATUS_ES, deps.XPD, deps.pausaLabel, escapeHtml, deps.displayLabel, deps.driverColorVar, deps.STORE, FakeDate);
}
test('roster driverRow: «En pausa · N min» survives stale-GPS, «Sin señal» alongside (P2-1)', () => {
  const base = { orderForDriver: () => null, DRIVER_STATUS_ES: { on_break: 'En pausa', available: 'Disponible' }, pausaLabel, displayLabel: () => '#X', driverColorVar: () => '#000', STORE: { orders: {} } };
  const row = (status, stale, break_since) => mkDriverRow({ ...base, XPD: { isStalePing: () => stale } })('u', { status, break_since, name: 'Ana', last_ping: 0 });
  const sOf = (h) => (h.match(/<s>([^<]*)<\/s>/) || [])[1];
  assert.equal(sOf(row('on_break', false, NOW - 5 * 60_000)).split(',')[0], 'En pausa · 5 min', 'paused + fresh GPS → pause label, no «Sin señal»');
  assert.equal(sOf(row('on_break', true, NOW - 5 * 60_000)).split(',')[0], 'En pausa · 5 min · Sin señal', 'paused + stale → pause label AND «Sin señal» alongside');
  assert.equal(sOf(row('available', true, undefined)).split(',')[0], 'Sin señal', 'non-paused + stale → «Sin señal» (unchanged)');
  assert.equal(sOf(row('available', false, undefined)).split(',')[0], 'Disponible', 'non-paused + fresh → status (unchanged)');
});

// ── P2-1 + BLOCK: the picker row keeps «En pausa» and is disabled (real rowOf) ──
function mkRowOf(STORE) {
  // rowOf is a nested arrow; lift its source and close over the deps it reads.
  const src = html.slice(html.indexOf('const rowOf = (r) => {'), html.indexOf('\n  };', html.indexOf('const rowOf = (r) => {')) + 5);
  return new Function('DRIVER_STATUS_ES', 'driverColorVar', 'escapeHtml', 'fmtDist', 'STORE',
    `${src}; return rowOf;`)({ on_break: 'En pausa', available: 'Disponible' }, () => '#000', escapeHtml, () => '1 km', STORE);
}
test('picker rowOf: paused row is DISABLED + «En pausa» tag; non-paused stays enabled (P2-1 + BLOCK)', () => {
  const STORE = { drivers: { dp: { status: 'on_break' }, da: { status: 'available' } } };
  const rowOf = mkRowOf(STORE);
  const sOf = (h) => (h.match(/<s>([^<]*)<\/s>/) || [])[1];
  const pausedLive = rowOf({ id: 'dp', name: 'Paz', live: true, load: 0, distanceM: 10 });
  assert.match(pausedLive, /<button class="row" type="button" data-choose="dp" disabled>/, 'paused row carries disabled');
  assert.equal(sOf(pausedLive).split(',')[0], 'En pausa', 'paused + live → «En pausa» tag');
  const pausedStale = rowOf({ id: 'dp', name: 'Paz', live: false, load: 0, distanceM: 10 });
  assert.equal(sOf(pausedStale).split(',')[0], 'En pausa · Sin señal', 'paused + not live → «En pausa · Sin señal»');
  const normal = rowOf({ id: 'da', name: 'Ale', live: true, load: 1, distanceM: 10 });
  assert.doesNotMatch(normal, /disabled/, 'a non-paused driver stays enabled');
  assert.equal(sOf(normal).split(',')[0], 'Disponible', 'non-paused shows its status');
});

// ── refusal toast ─────────────────────────────────────────────────────────────
test('assignFailMsg(on_break) → «El repartidor está en pausa»', () => {
  const assignFailMsg = new Function(`${fn(html, 'assignFailMsg')}; return assignFailMsg;`)();
  assert.equal(assignFailMsg('on_break'), 'El repartidor está en pausa');
  assert.equal(assignFailMsg('write_failed'), 'No se pudo asignar (error de red) — reintentá', 'other reasons unchanged');
});
