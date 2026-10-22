'use strict';
// S8 — the ledger's SCOPE, statically (the emulator suite proves it at runtime: test/driver-ledger.emulator.test.js cell 12).
// The driver payable ledger never reads or writes cash-to-remit / cuadre, never scans /orders whole, writes only under its
// own paths, and carries no bank field anywhere. Run: node driver-ledger/scope.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DIR = __dirname;
const files = fs.readdirSync(DIR).filter((f) => /\.js$/.test(f) && !/\.test\.js$/.test(f));
assert.deepStrictEqual(files.sort(), ['functions.js', 'ledger-core.js', 'ledger-store.js', 'pay-gate.js'], 'premise: the module set this guard covers');
const code = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const all = files.map((f) => [f, code(f)]);

for (const [f, s] of all) {
  const m = /cuadre|cash|shift|computeShiftCash|remit/i.exec(s);
  assert.strictEqual(m, null, `🔴 ${f} references cash-to-remit / cuadre: ${m && m[0]}`);
  const b = /\b(bank|iban|account_number|cuenta|routing|swift)\b/i.exec(s);
  const t = /\btip_/.exec(s);
  assert.strictEqual(t, null, `🔴 ${f} carries a tip field before S2 (the census write sentinel: tips are not implemented): ${t && t[0]}`);
  assert.strictEqual(b, null, `🔴 ${f} names a bank field: ${b && b[0]}`);
}
ok('no ledger module references cash-to-remit / cuadre, and none names a bank field');

const store = code('ledger-store.js');
const refs = [...store.matchAll(/db\.ref\(([`'][^`']+[`'])\)/g)].map((m) => m[1].slice(1, -1));
assert.ok(refs.length >= 4, `non-vacuity: ${refs.length} ref() paths`);
const allowed = /^driver_ledger_weeks(\/|$)|^platform_config\/driver_pay$|^orders$/;
for (const p of refs) assert.ok(allowed.test(p), `🔴 ledger-store touches an unexpected path: ${p}`);
const ordersUses = [...store.matchAll(/db\.ref\('orders'\)([^;]*)/g)].map((m) => m[1]);
assert.ok(ordersUses.length >= 1 && ordersUses.every((u) => /^\.orderByChild\('delivered_at'\)\.startAt\([^)]*\)\.endAt\(/.test(u)), `🔴 /orders is read other than through the bounded delivered_at query: ${JSON.stringify(ordersUses)}`);
ok(`ledger-store touches only its own paths, its config and /orders (${refs.length} refs); /orders only via the bounded orderByChild('delivered_at').startAt(…).endAt(…) range`);

console.log(`\ndriver-ledger scope.guard: ${n} passed`);
