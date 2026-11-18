'use strict';
// The ONE offer rules module shared by the server and the capp (advisor 11-14, interface agreed with capp): pure, no requires.
//   OR-BOGO:    bogoSaving(unitsCents, freePerOrder) — dearest first, every 2nd free, at most freePerOrder; any input order; odd counts;
//               the input never mutated
//   OR-WINDOW:  inWindow(schedule, nowMs) — start ≤ now < end (end null = open), HN days, the minute window, the overnight wrap and the
//               week-end wrap; a malformed start ⇒ false
//   OR-PARITY:  weeklyIntervals and inWindow give EXACTLY what the pre-extraction code gave (marketing/offer-model.js weeklyIntervals and
//               marketing/offer-price.js liveAt, read from git at b62765981 / the branch's pre-change commit) over a sweep of schedules
//               and instants — the move changes no behaviour
// Run: node marketing/offer-rules.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const OR = require('./offer-rules');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const H = 3600000; const DAY = 86400000;
const hn = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h + 6, mi);   // an HN wall-clock instant

// OR-BOGO
const u = [100, 400, 200, 300];
assert.strictEqual(OR.bogoSaving([], 1), 0);
assert.strictEqual(OR.bogoSaving([500], 3), 0, 'one unit: nothing free');
assert.strictEqual(OR.bogoSaving([300, 100, 200], 5), 200, 'odd count: 300,200,100 ⇒ the 2nd (200) free; the 3rd has no pair');
assert.strictEqual(OR.bogoSaving(u, 1), 300, 'freePerOrder 1: 400,300 ⇒ 300');
assert.strictEqual(OR.bogoSaving(u, 2), 400, 'freePerOrder 2: 300 + 100');
assert.strictEqual(OR.bogoSaving(u, 9), 400, 'the cap never exceeds the pairs');
assert.deepStrictEqual(u, [100, 400, 200, 300], 'the input is never mutated');
assert.strictEqual(OR.bogoSaving([200, 200, 200, 200, 200], 2), 400, 'equal prices');
ok('OR-BOGO: dearest first, every 2nd free, ≤ freePerOrder; odd counts; any order; input untouched');

// OR-WINDOW (2026-11-16 is a Monday)
const all = { start: hn(2026, 11, 1), end: null, days: [0, 1, 2, 3, 4, 5, 6], window: null };
assert.strictEqual(OR.inWindow(all, hn(2026, 11, 16, 12)), true);
assert.strictEqual(OR.inWindow({ ...all, start: hn(2026, 11, 16, 12) }, hn(2026, 11, 16, 12)), true, 'start ≤ now');
assert.strictEqual(OR.inWindow({ ...all, start: hn(2026, 11, 16, 12) }, hn(2026, 11, 16, 12) - 1), false, 'before the start');
assert.strictEqual(OR.inWindow({ ...all, end: hn(2026, 11, 16, 12) }, hn(2026, 11, 16, 12)), false, 'now < end (the end is exclusive)');
assert.strictEqual(OR.inWindow({ ...all, days: [2] }, hn(2026, 11, 16, 12)), false, 'Monday is not a Tuesday-only day');
const lunch = { ...all, days: [1], window: { from: 11 * 60, to: 14 * 60 } };
assert.deepStrictEqual([OR.inWindow(lunch, hn(2026, 11, 16, 10, 59)), OR.inWindow(lunch, hn(2026, 11, 16, 11)), OR.inWindow(lunch, hn(2026, 11, 16, 13, 59)), OR.inWindow(lunch, hn(2026, 11, 16, 14))], [false, true, true, false], 'the minute window [from, to)');
const night = { ...all, days: [5], window: { from: 21 * 60, to: 2 * 60 } };   // Friday 21:00 → 02:00
assert.deepStrictEqual([OR.inWindow(night, hn(2026, 11, 20, 23)), OR.inWindow(night, hn(2026, 11, 21, 1, 59)), OR.inWindow(night, hn(2026, 11, 21, 2)), OR.inWindow(night, hn(2026, 11, 21, 23))], [true, true, false, false], 'overnight wrap: Friday night runs into Saturday 02:00, not Saturday night');
const weekend = { ...all, days: [6], window: { from: 23 * 60, to: 60 } };     // Saturday 23:00 → Sunday 01:00 (the week's end)
assert.deepStrictEqual([OR.inWindow(weekend, hn(2026, 11, 21, 23, 30)), OR.inWindow(weekend, hn(2026, 11, 22, 0, 30)), OR.inWindow(weekend, hn(2026, 11, 22, 1))], [true, true, false], 'the week-end wrap');
for (const bad of [{ ...all, start: undefined }, { ...all, start: 'x' }, null]) assert.strictEqual(OR.inWindow(bad, hn(2026, 11, 16, 12)), false, `malformed ${JSON.stringify(bad)}`);
ok('OR-WINDOW: start ≤ now < end, HN days, the minute window, the overnight and week-end wraps; malformed ⇒ false');

// OR-PARITY — the pre-extraction code, from git, against the module
const ROOT = path.join(__dirname, '..');
const show = (rev, f) => execFileSync('git', ['show', `${rev}:xpizza-functions/${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-parity-'));
fs.writeFileSync(path.join(tmp, 'offer-model.js'), show('b62765981', 'marketing/offer-model.js'));
const oldOM = require(path.join(tmp, 'offer-model.js'));
const PRE = 'f992c28a7';   // the last commit before the extraction that touched marketing/offer-price.js
const oldPriceSrc = show(PRE, 'marketing/offer-price.js');
assert.ok(/function liveAt\(c, nowMs\) \{/.test(oldPriceSrc) && !/offer-rules/.test(oldPriceSrc), `premise: ${PRE.slice(0, 9)} holds the pre-extraction liveAt`);
const liveAtSrc = oldPriceSrc.slice(oldPriceSrc.indexOf('function liveAt(c, nowMs) {'), oldPriceSrc.indexOf('\n}\n', oldPriceSrc.indexOf('function liveAt(c, nowMs) {')) + 2);
const oldLiveAt = new Function('OM', 'HN_OFFSET_MS', 'DAY_MS', `${liveAtSrc}\nreturn liveAt;`)(oldOM, 6 * H, DAY);   // eslint-disable-line no-new-func
let checked = 0;
const windows = [null, { from: 0, to: 1439 }, { from: 11 * 60, to: 14 * 60 }, { from: 21 * 60, to: 2 * 60 }, { from: 23 * 60, to: 60 }, { from: 600, to: 599 }, { from: 1, to: 0 }];
const dayss = [[0], [6], [1, 3, 5], [0, 1, 2, 3, 4, 5, 6], [5, 6]];
for (const window of windows) for (const days of dayss) {
  const s = { start: hn(2026, 11, 10), end: hn(2026, 11, 30), days, window };
  assert.deepStrictEqual(OR.weeklyIntervals(s), oldOM.weeklyIntervals(s), `weeklyIntervals parity ${JSON.stringify(s)}`);
  for (let t = hn(2026, 11, 9, 22); t < hn(2026, 12, 1, 2); t += 37 * 60000) {
    assert.strictEqual(OR.inWindow(s, t), oldLiveAt({ schedule: s }, t), `inWindow ≡ liveAt at ${new Date(t).toISOString()} ${JSON.stringify(s)}`);
    checked += 1;
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
ok(`OR-PARITY: weeklyIntervals ≡ 3a's b62765981 implementation and inWindow ≡ the pre-extraction liveAt (${checked} instants × schedules)`);

console.log(`offer-rules: OK (${n})`);
