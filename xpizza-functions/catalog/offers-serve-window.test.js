'use strict';
// The public offers read (offers-serve inWindowNow → the directory flag) CALLS the ONE offer rules module (advisor 11-14, rule 4):
//   OSW-CALLS:  catalog/offers-serve.js requires ../marketing/offer-rules and no longer computes the window itself
//   OSW-PARITY: inWindowNow ≡ the pre-extraction implementation (catalog/offers-serve.js at 9a6d4a78d, 3a's capp-offers tip) over a sweep
//               of validated schedules (OM.scheduleOf, as publicOffer builds them) and instants — the move changes no behaviour
// Run: node catalog/offers-serve-window.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const OS = require('./offers-serve');
const OM = require('../marketing/offer-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, 'offers-serve.js'), 'utf8');
assert.ok(/require\('\.\.\/marketing\/offer-rules'\)/.test(src) && !/OM\.weeklyIntervals\(/.test(src), '🔴 OSW-CALLS: offers-serve calls the one offer rules module');
ok('OSW-CALLS: offers-serve requires marketing/offer-rules and computes no window of its own');

const old = execFileSync('git', ['show', '9a6d4a78d:xpizza-functions/catalog/offers-serve.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
const body = old.slice(old.indexOf('function inWindowNow(schedule, nowMs) {'), old.indexOf('\n}\n', old.indexOf('function inWindowNow(schedule, nowMs) {')) + 2);
assert.ok(/OM\.weeklyIntervals/.test(body), 'premise: 9a6d4a78d holds the pre-extraction inWindowNow');
const oldInWindowNow = new Function('OM', 'HN_OFFSET_MS', `${body}\nreturn inWindowNow;`)(OM, 6 * 3600000);   // eslint-disable-line no-new-func
const hn = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h + 6, mi);
let checked = 0;
const windows = [null, { from: 0, to: 1439 }, { from: 660, to: 840 }, { from: 1260, to: 120 }, { from: 1380, to: 60 }, { from: 600, to: 599 }];
const dayss = [[0], [6], [1, 3, 5], [0, 1, 2, 3, 4, 5, 6], [5, 6]];
for (const window of windows) for (const days of dayss) for (const end of [null, hn(2026, 11, 30)]) {
  const s = OM.stripNulls(OM.scheduleOf({ days, start: hn(2026, 11, 10), end, window }));
  assert.ok(s && Array.isArray(s.days), `premise: a validated schedule ${JSON.stringify({ days, window, end })}`);
  for (let t = hn(2026, 11, 9, 22); t < hn(2026, 12, 1, 2); t += 41 * 60000) {
    assert.strictEqual(OS.inWindowNow(s, t), oldInWindowNow(s, t), `OSW-PARITY at ${new Date(t).toISOString()} ${JSON.stringify(s)}`);
    checked += 1;
  }
}
ok(`OSW-PARITY: inWindowNow ≡ the 9a6d4a78d implementation (${checked} instant × schedule checks)`);
console.log(`offers-serve-window: OK (${n})`);
