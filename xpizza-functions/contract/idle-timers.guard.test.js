'use strict';
// R3 §5a — THE IDLE-TIMER ALLOWLIST GUARD (static; in the npm test chain; codex r4 P1-2). Every reviewed idle entry in
// contract/idle-timers.json must still bind its page's CURRENT source: exactly one call site with the same kind, delay,
// enclosing function and callback source hash, an unchanged helper closure, and NO write / network effect in what the
// callback executes. A changed callback, helper or delay → RED here (and not exempt in the harness) until re-reviewed.
// Re-review: node contract/idle-timers.js --print <page dir>
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveEntries, timerSites, loadEntries, FILE } = require('./idle-timers');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-IDLE-TIMERS ${m}`;
const REPO = path.join(__dirname, '..', '..');
const DIRS = Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8'))).filter((k) => k !== '_doc');

let total = 0;
for (const dir of DIRS) {
  const entries = loadEntries(dir); total += entries.length;
  const { active, stale, sites } = resolveEntries(dir, entries);
  assert.deepStrictEqual(stale.map((s) => `${s.entry.at} ${s.entry.callback.slice(0, 50)}: ${s.why}`), [], FAIL(`${dir}: reviewed idle entries no longer bind the current source — re-review, then update contract/idle-timers.json`));
  for (const e of active) {
    const site = sites.find((s) => s.cbHash === e.cbHash && s.kind === e.kind && s.delay === e.delay && s.site === e.site);
    assert.ok(e.reason && e.reason.trim(), FAIL(`${dir} ${e.at}: no reason`));
    assert.deepStrictEqual(site.effects, [], FAIL(`${dir} ${e.at} (${e.callback.slice(0, 40)}): an IDLE timer's execution reaches a write / network call`));
    assert.deepStrictEqual(e.effects, [], FAIL(`${dir} ${e.at}: the reviewed entry records effects`));
  }
  const keys = entries.map((e) => `${e.kind}|${e.delay}|${e.cbHash}`);
  assert.strictEqual(new Set(keys).size, keys.length, FAIL(`${dir}: duplicate entries`));
}
ok(`${total} reviewed idle entries across ${DIRS.length} pages each bind exactly one current call site (kind + delay + site + callback sha256), an unchanged helper closure, and NO write / network effect in what they execute`);

// premise — the effects scan SEES writes: the KDS completion write (700 ms timer → XPD.setOrderStatus → update) and the
// driver diagnostics flush (fetch); and the 2nd (render-only) completion timer has none
const k = timerSites('xpizza-kitchen').filter((s) => s.site === 'startCompletion');
assert.ok(k.length === 2 && k.filter((s) => s.effects.some((e) => /SDK write.*setOrderStatus > update/.test(e))).length === 1, FAIL(`premise — the KDS completion write is not seen by the effects scan (${JSON.stringify(k.map((s) => s.effects))})`));
const dr = timerSites('xpizza-driver').find((s) => s.site === '_diagRetry');
assert.ok(dr && dr.effects.some((e) => /^fetch\(\)/.test(e)), FAIL('premise — the driver diagnostics fetch is not seen'));
ok('premise: the effects scan sees the KDS completion write (startCompletion 700 ms → setOrderStatus → update; the render-only twin has none) and the driver diagnostics fetch');

// negatives — in-memory edits (never written): each voids the exemption
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const kh = read('xpizza-kitchen/index.html'); const sv = read('xpizza-kitchen/scheduled-view.js');
const neg = [
  ['updateClock gains a write', { 'xpizza-kitchen/index.html': kh.replace('function updateClock() {', "function updateClock() { XPD.setOrderStatus('probe', 'completed');") }, /no call site with this kind/, true],
  ['a HELPER of updateClock changes (scheduled-view.js dayKey)', { 'xpizza-kitchen/scheduled-view.js': sv.replace(/function dayKey\(ms, tz\) \{/, 'function dayKey(ms, tz) { ms = ms + 1;') }, /helper closure changed/, false],
  ['a helper of updateClock gains a write (renderScheduled → fetch)', { 'xpizza-kitchen/index.html': kh.replace('function renderScheduled() {', "function renderScheduled() { fetch('/probe', { method: 'POST' });") }, /helper closure changed/, true],
  ['updateClock\'s delay changes', { 'xpizza-kitchen/index.html': kh.replace('setInterval(updateClock, 1000);', 'setInterval(updateClock, 900);') }, /no call site with this kind/, false],
];
for (const [label, overrides, re, wantsEffect] of neg) {
  assert.ok(Object.entries(overrides).every(([f, c]) => c !== read(f)), FAIL(`negative "${label}": the in-memory edit did not apply`));
  const { stale } = resolveEntries('xpizza-kitchen', loadEntries('xpizza-kitchen'), { overrides });
  const hit = stale.find((s) => s.entry.callback.startsWith('function updateClock()'));
  assert.ok(hit && re.test(hit.why), FAIL(`negative "${label}": the updateClock entry kept its exemption (${JSON.stringify(stale.map((s) => s.why))})`));
  if (wantsEffect) {
    const site = timerSites('xpizza-kitchen', { overrides }).find((s) => s.cb.startsWith('function updateClock()') && s.delay === 1000);
    assert.ok(site && site.effects.length, FAIL(`negative "${label}": the effects scan missed the added write`));
  }
}
ok(`negatives (in memory) void the exemption: ${neg.map((x) => x[0]).join('; ')} — the added writes are also seen by the effects scan`);

console.log(`\nr3-idle-timers guard: OK (${n})`);
