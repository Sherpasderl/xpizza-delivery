'use strict';
// F4 — the DECLARED delta between the tracker's golden and its frozen pre-F4 copy (BUILD-tracker-F4 §7).
// Run: node xpizza-track/tracker-status.delta.test.js
// Every field of every cell must equal the pre-F4 golden EXCEPT exactly these declared changes (the fixtures carry no mx, so
// status-view.js's gen2 fallbacks apply: is_active_drop === true / === false, and driver_name as the name):
//   • harness metadata, every snapshot: no `computeEta` field (the helper is gone); `path` gains '.info/serverTimeOffset';
//   • CALM (option B) — a name, no live location: headline "Tu pedido va en camino", sub "Con Carlos · pronto llegará a tu
//     dirección", class ssub (was ssub big); avatar, map, segments unchanged;
//   • WAITING without a name (is_active_drop false): "Tu repartidor va en camino", the stacked copy, class ssub, segment 3 at .35;
//   • LIVE cells whose sub-line showed a countdown now say "En ruta a tu dirección" (no offset and no route answer in the
//     harness → no minutes); headline, avatar, map and segments unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pre = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracker-status.golden.pre-f4.json'), 'utf8'));
const now = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracker-status.golden.json'), 'utf8'));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const STACKED = 'Tu repartidor tiene una parada rápida en camino a la tuya, luego va directo hacia vos.';
const CALM_B = ['ofd/driver/active-bad-loc', 'ofd/driver/active-no-loc', 'ofd/driver/unknown',
  ...['undefined', 7].flatMap((e) => ['undefined', 3, 15].map((a) => `eta/unknown/eta=${e}/ago=${a}`))];
const WAITING = ['ofd/no-driver/stacked'];
const LIVE_SUB = ['undefined', 7].flatMap((e) => ['undefined', 3, 15].map((a) => `eta/active/eta=${e}/ago=${a}`));
const UNCHANGED_OFD = ['delivery/out_for_delivery', 'ofd/driver/active', 'ofd/driver/active-no-dest', 'ofd/driver/stacked', 'ofd/no-driver',
  'ofd/driver/active/2-snapshots'];

assert.deepStrictEqual(Object.keys(now).sort(), Object.keys(pre).sort(), 'the same cells (none added, none removed)');
const snaps = (x) => (Array.isArray(x) ? x : [x]);
const clone = (x) => JSON.parse(JSON.stringify(x));

function expected(key, s0) {
  const s = clone(s0);
  delete s.computeEta;
  s.path = [...s.path, '.info/serverTimeOffset'];
  if (CALM_B.includes(key)) {
    s['driver-name'] = { ...s['driver-name'], text: 'Tu pedido va en camino' };
    s['driver-eta'] = { ...s['driver-eta'], cls: 'ssub', text: 'Con Carlos · pronto llegará a tu dirección' };
  } else if (WAITING.includes(key)) {
    s['driver-name'] = { ...s['driver-name'], text: 'Tu repartidor va en camino' };
    s['driver-eta'] = { ...s['driver-eta'], cls: 'ssub', text: STACKED };
    s.segbar.kids[2].kids[0].style['--p'] = '0.35';
  } else if (LIVE_SUB.includes(key)) {
    s['driver-eta'] = { ...s['driver-eta'], text: 'En ruta a tu dirección' };
  }
  return s;
}

let changed = 0;
for (const key of Object.keys(pre)) {
  const a = snaps(pre[key]); const b = snaps(now[key]);
  assert.strictEqual(b.length, a.length, `${key}: the same snapshot count`);
  a.forEach((s0, i) => {
    const exp = expected(key, s0);
    assert.deepStrictEqual(b[i], exp, `🔴 ${key}[${i}]: differs from the pre-F4 golden beyond the declared delta`);
    if (JSON.stringify({ ...s0, computeEta: undefined, path: undefined }) !== JSON.stringify({ ...b[i], computeEta: undefined, path: undefined })) changed += 1;
  });
}
ok(`every field of all ${Object.keys(pre).length} cells equals the pre-F4 golden except the declared delta (metadata + ${CALM_B.length} calm-B + ${WAITING.length} waiting + live sub-lines)`);

// non-vacuity: the declared cells really changed, and the unchanged OFD cells really did not
for (const key of [...CALM_B, ...WAITING]) assert.notDeepStrictEqual(snaps(now[key])[0]['driver-name'], snaps(pre[key])[0]['driver-name'], `${key}: changed`);
for (const key of LIVE_SUB.filter((k) => k !== 'eta/active/eta=undefined/ago=undefined')) assert.notStrictEqual(snaps(now[key])[0]['driver-eta'].text, snaps(pre[key])[0]['driver-eta'].text, `${key}: the countdown is gone`);
for (const key of UNCHANGED_OFD) assert.deepStrictEqual(snaps(now[key]).map((s) => s['driver-eta']), snaps(pre[key]).map((s) => s['driver-eta']), `${key}: unchanged`);
assert.ok(changed >= CALM_B.length + WAITING.length + 5, `non-vacuity: rendered changes are present (${changed})`);
ok('non-vacuity: every declared cell changed; the six unchanged out_for_delivery cells kept their sub-line');

// no countdown anywhere in the new golden, and the helper is gone from the page
assert.ok(!JSON.stringify(now).includes('Llega en ~'), '🔴 a countdown survived in the golden (the harness has no route answer)');
assert.ok(!/function computeEta\b|\bcomputeEta\(/.test(html) && !/fallback_drive_min/.test(html), '🔴 computeEta / the 12-minute fallback is still in the page');
ok('no "Llega en ~" in any cell; computeEta and fallback_drive_min are gone from index.html');

console.log(`\ntracker-status.delta: OK (${n})`);
