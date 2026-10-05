// Portal 1D · D4-b — THE SHARED 86 REDUCER (PLAN-D4b §C; relay hard constraint 3; advisor ruling Q6).
// Run: node d4b-availability.test.mjs
//   1. any_false PARITY: the four D4-b readers reproduce the 79 decisions frozen from the UNMODIFIED readers.
//   2. DRIFT: the three surface copies are byte-identical to xpizza-functions/availability-reducer.js.
//   3. LOAD GUARD: both forms and the KDS load the reducer BEFORE any code that decides, and it is callable;
//   4. …and REMOVING the <script src> FAILS the guard, rather than silently failing open.
//   5. newest_wins: the spec cases, against the module only (INACTIVE in every reader).
//   6. the KDS CONCURRENT two-tablet scenario reproduces today's trace step for step (any_false machinery unchanged).
//   7. the dormant pending overlay (newest_wins only): ack, reject, concurrent writer.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { computeDecisions } from './d4b-availability-readers.mjs';
import { kdsTrace } from './d4b-kds-avail-trace.mjs';
import { loadForm, loadAvail, settle, OPEN } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const R = require('./availability-reducer');
const { availKey } = require('./avail-key');
const PARITY = JSON.parse(readFileSync(new URL('./xpizza-functions/catalog/d4b-availability-parity.golden.json', import.meta.url), 'utf8'));
const KDS_TRACE = JSON.parse(readFileSync(new URL('./xpizza-functions/catalog/d4b-kds-avail-trace.golden.json', import.meta.url), 'utf8'));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

try {
  // ── 1. PARITY ────────────────────────────────────────────────────────────────────────────────────
  assert.strictEqual(PARITY._provenance.captured_at_commit, '717f97e911774aa03fa285b54ee5af576067ba1a');
  const now = await computeDecisions();
  let count = 0;
  for (const reader of Object.keys(PARITY.decisions)) {
    for (const [c, want] of Object.entries(PARITY.decisions[reader])) {
      assert.deepStrictEqual(now[reader][c], want, `🔴 ${reader}.${c} changed from today's decision`);
      count += 1;
    }
    assert.deepStrictEqual(Object.keys(now[reader]).sort(), Object.keys(PARITY.decisions[reader]).sort(), `${reader}: same case set`);
  }
  assert.strictEqual(PARITY.decisions.x_pizza_form['history.old_false_new_true'], true, 'premise — the mixed-history case newest_wins would flip is SOLD OUT today');
  assert.strictEqual(R.decide([{ available: false, updated_at: 100 }, { available: true, updated_at: 200 }], 'newest_wins'), false, 'sensitivity — newest_wins WOULD flip it, so the parity is not vacuous');
  ok(`any_false parity: ${count} decisions of the four D4-b readers (server gate, both forms, KDS) equal the frozen 717f97e goldens, incl. mixed historical keys, malformed entries and read failures`);

  // ── 2. DRIFT ─────────────────────────────────────────────────────────────────────────────────────
  const canonical = read('./xpizza-functions/availability-reducer.js');
  for (const d of ['xpizza-orders', 'la-musa-orders', 'xpizza-kitchen']) {
    assert.strictEqual(read(`./${d}/availability-reducer.js`), canonical, `🔴 ${d}/availability-reducer.js drifted from the canonical file`);
  }
  ok('the three surface copies are byte-identical to xpizza-functions/availability-reducer.js');

  // ── 3. LOAD GUARD — the reducer is loaded before anything that decides, and callable ─────────────
  // A form/KDS that lost the reducer would make isSoldOut throw into its catch → "available": sold-out
  // silently OFF. So the wiring is asserted on the real pages.
  const guard = (w, label) => {
    assert.strictEqual(typeof (w.availabilityReducer && w.availabilityReducer.decide), 'function', `🔴 ${label}: window.availabilityReducer.decide is not loaded`);
    assert.strictEqual(w.availabilityReducer.decide([{ available: false }], 'any_false'), true, `${label}: the loaded reducer decides`);
  };
  const tagOrder = (html, label, decider) => {
    const tag = html.search(/<script src="availability-reducer\.js(\?v=\d+)?"><\/script>/);
    const firstUse = html.indexOf(decider);
    assert.ok(tag >= 0, `🔴 ${label}: no <script src="availability-reducer.js">`);
    assert.ok(firstUse > tag, `🔴 ${label}: ${decider} appears BEFORE the reducer is loaded`);
  };
  for (const [dir, rid, dish, key] of [['xpizza-orders', 'x_pizza', { id: 2, name: 'Carnivora' }, 'Carnivora'], ['la-musa-orders', 'la_musa', { id: 'dimsum_01', name: 'W' }, 'dimsum_01']]) {
    const html = read(`./${dir}/index.html`);
    tagOrder(html, dir, 'function isSoldOut(');
    const w = loadForm(dir); await settle();
    guard(w, dir);
    await loadAvail(w, { [availKey(key)]: { available: false, updated_at: 1 } });
    assert.strictEqual(w.isSoldOut(dish), true, `${dir}: the real page decides sold-out through the loaded reducer`);
    void rid;
  }
  {
    const html = read('./xpizza-kitchen/index.html');
    tagOrder(html, 'xpizza-kitchen', 'function isItemOff(');
    assert.ok(html.indexOf('src="avail-key.js?v=1"') < html.indexOf('src="availability-reducer.js?v=1"'), 'KDS: loaded right after avail-key, in the same block');
  }
  ok('load guard: both forms and the KDS load availability-reducer.js BEFORE the code that decides; on the real form pages it is callable and decides');

  // ── 4. REMOVING THE <script src> FAILS THE GUARD (never a silent fail-open) ─────────────────────────
  for (const [dir, dish, key] of [['xpizza-orders', { id: 2, name: 'Carnivora' }, 'Carnivora'], ['la-musa-orders', { id: 'dimsum_01', name: 'W' }, 'dimsum_01']]) {
    const w = loadForm(dir, { omit: ['availability-reducer.js'] }); await settle();
    assert.throws(() => guard(w, dir), /not loaded/, `🔴 ${dir}: the guard did NOT catch a missing reducer`);
    await loadAvail(w, { [availKey(key)]: { available: false, updated_at: 1 } });
    assert.strictEqual(w.isSoldOut(dish), false, 'premise — WHY the guard exists: without it the page fails OPEN (a sold-out item reads available)');
    const stripped = read(`./${dir}/index.html`).replace(/<script src="availability-reducer\.js"><\/script>/, '');
    assert.throws(() => tagOrder(stripped, dir, 'function isSoldOut('), /no <script src/, `${dir}: the static check fails too`);
  }
  assert.throws(() => tagOrder(read('./xpizza-kitchen/index.html').replace(/<script src="availability-reducer\.js\?v=1"><\/script>/, ''), 'xpizza-kitchen', 'function isItemOff('), /no <script src/);
  ok('removing <script src="availability-reducer.js"> FAILS the guard (forms: page-level and static; KDS: static) — the fail-open it would cause is shown, not hidden');

  // ── 5. newest_wins spec (module only — inactive everywhere) ──────────────────────────────────────
  const NW = (entries) => R.decide(entries, 'newest_wins');
  const cases = [
    ['no entries → available', [], false],
    ['only absent → available', [undefined, null], false],
    ['newest true wins over older false', [{ available: false, updated_at: 100 }, { available: true, updated_at: 200 }], false],
    ['newest false wins over older true', [{ available: true, updated_at: 100 }, { available: false, updated_at: 200 }], true],
    ['tie at max, differing values → sold out', [{ available: true, updated_at: 200 }, { available: false, updated_at: 200 }], true],
    ['tie at max, same value true → available', [{ available: true, updated_at: 200 }, { available: true, updated_at: 200 }], false],
    ['invalid-timestamp true is ignored', [{ available: false, updated_at: 100 }, { available: true, updated_at: 'x' }], true],
    ['invalid-timestamp true alone → available', [{ available: true }], false],
    ['missing-timestamp false → sold out', [{ available: true, updated_at: 900 }, { available: false }], true],
    ['negative / fractional timestamps are invalid', [{ available: true, updated_at: -1 }, { available: true, updated_at: 1.5 }], false],
    ['same-millisecond cross-key, differing → sold out', [{ available: false, updated_at: 500 }, { available: true, updated_at: 500 }], true],
    ['future-dated true dominates (why §C.4(a) server-time rules gate activation)', [{ available: false, updated_at: 100 }, { available: true, updated_at: 9e15 }], false],
    ['malformed values carry no information', [{ available: 'false', updated_at: 999 }, { available: 0, updated_at: 999 }, 'x', 5], false],
  ];
  for (const [label, entries, want] of cases) assert.strictEqual(NW(entries), want, `newest_wins: ${label}`);
  for (const junk of [null, undefined, 'x', 5, {}, [[]]]) { assert.strictEqual(R.decide(junk, 'any_false'), false); assert.strictEqual(R.decide(junk, 'newest_wins'), false); }
  assert.strictEqual(R.decide([{ available: false }], 'some_unknown_mode'), true, 'an unknown mode decides as any_false — never open');
  assert.deepStrictEqual([...R.MODES], ['any_false', 'newest_wins']);
  ok(`newest_wins: ${cases.length} spec cases (tie, invalid true ignored, invalid false → sold out, same-ms cross-key, future-dated) against the module only; junk never throws; an unknown mode is any_false`);

  // ── 6. KDS concurrent two-tablet scenario, any_false: today's trace, step for step ───────────────────
  const trace = await kdsTrace(read('./xpizza-kitchen/index.html'), { reducerSrc: read('./xpizza-kitchen/availability-reducer.js') });
  assert.strictEqual(KDS_TRACE.steps.length, 7);
  assert.deepStrictEqual(trace, KDS_TRACE.steps, '🔴 the KDS render / pending / revert / next-toggle trace changed');
  assert.ok(KDS_TRACE.steps[4].panel !== KDS_TRACE.steps[3].panel, 'premise — the trace is sensitive (the revert visibly changes the panel)');
  ok('KDS any_false: the concurrent two-tablet scenario (A pending, B writes the same key, A rejected → revert, next toggle) renders and toggles exactly as today\'s KDS — 7 steps equal the 717f97e trace');

  // ── 7. The dormant pending overlay (newest_wins only) ──────────────────────────────────────────────
  {
    const o = R.createOverlay();
    const committed = [{ available: true, updated_at: 100 }];
    o.set('K', false, 200);
    assert.strictEqual(o.view('K', committed), true, 'pending off shows SOLD OUT before the ack');
    assert.strictEqual(o.view('K', [{ available: false, updated_at: 210 }]), true, 'ack (matching value at/after the pending time)…');
    assert.strictEqual(o.has('K'), false, '…settles the pending entry');
    o.set('K', true, 300);
    // a CONCURRENT writer lands an OLDER-than-pending false: not an ack — pending still shown
    assert.strictEqual(o.view('K', [{ available: false, updated_at: 250 }]), false);
    assert.strictEqual(o.has('K'), true);
    o.reject('K');
    assert.strictEqual(o.view('K', [{ available: false, updated_at: 250 }]), true, 'after the reject the COMMITTED state shows (the other tablet\'s false)');
  }
  ok('dormant pending overlay (newest_wins only): pending shown until ack, a concurrent older write is not an ack, reject falls back to the committed state');

  console.log(`d4b-availability: OK (${n})`);
  for (const d of OPEN.splice(0)) { try { d.window.close(); } catch (_) {} }
  process.exit(0);
} catch (e) {
  console.error('d4b-availability FAILED:', e);
  process.exit(1);
}
