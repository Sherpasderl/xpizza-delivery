import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// F6 — the collapsed lite card shows payment method + cash change (owner couldn't tell an order was cash while
// tracking → didn't know change was owed). This EXTRACTS the real paymentLine() from index.html and executes it
// against real order shapes. The change amount is derived INDEPENDENTLY here from the same expression the code and
// factura/build-record.js:109 use — Math.max(0, cash_tendered_cents - total_cents) — so a hardcoded label can't
// tautologically pass. Money format is the card-consistent 'L ' + (cents/100).toFixed(2) (matches the sheet total).

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// Extract paymentLine (top-level fn; its closing brace is column-0 '\n}', the inner if-close is indented).
const start = html.indexOf('function paymentLine(');
assert.ok(start > -1, 'paymentLine present in index.html');
const src = html.slice(start, html.indexOf('\n}', start) + 2);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));
// eslint-disable-next-line no-new-func
const paymentLine = new Function('escapeHtml', `${src}; return paymentLine;`)(escapeHtml);

const L = (cents) => 'L ' + (cents / 100).toFixed(2);

test('online → "Tarjeta · pagado": plain quiet line, no cambio, no cash chip', () => {
  const out = paymentLine({ payment_method: 'online', total_cents: 32000, cash_tendered_cents: 0 });
  assert.match(out, /Tarjeta · pagado/);
  assert.match(out, /class="ln pay online"/);
  assert.doesNotMatch(out, /cambio/);
  assert.doesNotMatch(out, /pay cash/);          // online never gets the cash chip
});

test('cash with change → "Efectivo · cambio L… · paga con L…", warm chip; change from the REAL expression', () => {
  const total_cents = 32000, cash_tendered_cents = 50000;
  const change = Math.max(0, cash_tendered_cents - total_cents);   // = 18000c → L 180.00 (factura/build-record.js:109)
  const out = paymentLine({ payment_method: 'cash', total_cents, cash_tendered_cents });
  assert.match(out, /class="ln pay cash"/);       // subtle warm chip present
  assert.ok(out.includes('Efectivo · cambio ' + L(change)), `expected "cambio ${L(change)}" in: ${out}`);
  assert.ok(out.includes('paga con ' + L(cash_tendered_cents)), `expected "paga con ${L(cash_tendered_cents)}" in: ${out}`);
  assert.ok(out.includes(L(18000)), 'change is exactly tender − total (L 180.00), derived not hardcoded');
});

test('cash exact (tender == total) → "Efectivo · paga exacto", no cambio amount; still a cash chip', () => {
  const out = paymentLine({ payment_method: 'cash', total_cents: 32000, cash_tendered_cents: 32000 });
  assert.match(out, /Efectivo · paga exacto/);
  assert.match(out, /class="ln pay cash"/);
  assert.doesNotMatch(out, /cambio/);
});

test('cash with blank tender (0) → change 0 → "paga exacto" (honesty rule: unspecified == brings no change)', () => {
  const out = paymentLine({ payment_method: 'cash', total_cents: 32000, cash_tendered_cents: 0 });
  assert.match(out, /Efectivo · paga exacto/);    // Math.max(0, 0 - 32000) = 0 → no amount, never negative/"L 0.00 cambio"
  assert.doesNotMatch(out, /cambio/);
});
