'use strict';
// F4 — the order forms are UNAFFECTED (BUILD-tracker-F4 §0.4, T6). Run: node xpizza-track/status-view-forms.test.js
// status-view.js is shared with both order forms' S5 "Pedido recibido" screen. Ruling A (S5 BC2 parity): the forms pass gen2, so
// their STATUS LINE is the tracker's words (proven against the tracker's golden in s5-live-status.test.mjs §6); their ARRIVAL line
// reads etaMin from their own measured drive minutes and must be byte-identical to pre-F4. Here: without gen2 the module deep-equals
// the PRE-F4 module (S5 5a7e9bdc) on a broad matrix; with gen2 + measured drive minutes, etaMin equals pre-F4; the three copies stay
// byte-identical.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const copies = ['xpizza-track', 'xpizza-orders', 'la-musa-orders'].map((d) => fs.readFileSync(path.join(ROOT, d, 'status-view.js'), 'utf8'));
assert.ok(copies.every((c) => c === copies[0]), '🔴 the three status-view.js copies differ');
ok('the three status-view.js copies (tracker + both forms) are byte-identical');

const preSrc = execFileSync('git', ['show', '5a7e9bdc:xpizza-track/status-view.js'], { cwd: __dirname, encoding: 'utf8' });
// loaded in THIS realm (a vm context's objects would fail deepStrictEqual on prototypes alone)
const load = (src) => { const m = { exports: {} }; new Function('module', 'exports', src)(m, m.exports); return m.exports.presentStatus; };
const PRE = load(preSrc);
const NOW = require('./status-view.js').presentStatus;

const NOWMS = 1_800_000_000_000;
const statuses = ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'weird', undefined];
const drivers = [{}, { driver_name: 'Carlos' }, { driver_name: 'Carlos', is_active_drop: true, driver_location: { lat: 15.5, lng: -88 } },
  { driver_name: 'Carlos', is_active_drop: true }, { driver_name: 'Carlos', is_active_drop: false }, { is_active_drop: false },
  { is_active_drop: true, driver_location: { lat: 15.5, lng: -88 } }, { driver_name: 'Carlos', mx: { mode: 'live', name: 'Otro' } }];
const etas = [{}, { fallback_drive_min: 9, picked_up_at: NOWMS - 3 * 60000 }, { fallback_drive_min: 25, picked_up_at: NOWMS - 30 * 60000 },
  { delivery_eta_min: 7 }, { picked_up_at: NOWMS - 60000 }];
let cells = 0;
for (const status of statuses) for (const order_type of ['delivery', 'pickup']) for (const d of drivers) for (const e of etas) {
  const r = { status, order_type, delivered_at: NOWMS - 5 * 60000, restaurant_display_name: 'La Musa', now: NOWMS, ...d, ...e };
  assert.deepStrictEqual(NOW(r), PRE(r), `🔴 presentStatus without gen2 changed for ${JSON.stringify(r)}`);
  cells += 1;
}
ok(`presentStatus WITHOUT gen2 deep-equals the pre-F4 module on ${cells} inputs (status × type × driver fields × ETA inputs)`);

// ruling A (BC2 parity): the forms call WITH gen2 and their measured drive minutes — their arrival input (etaMin) is the pre-F4
// value for every input that supplies a finite fallback_drive_min; the tracker (no drive minutes) gets none
let etaCells = 0;
for (const status of statuses) for (const d of drivers) for (const e of etas) {
  if (!Number.isFinite(e.fallback_drive_min)) continue;
  const r = { status, order_type: 'delivery', now: NOWMS, ...d, ...e };
  assert.strictEqual(NOW({ ...r, gen2: true }).etaMin, PRE(r).etaMin, `🔴 the forms' etaMin changed under gen2 for ${JSON.stringify(r)}`);
  assert.strictEqual(NOW({ ...r, fallback_drive_min: undefined, gen2: true }).etaMin, null, 'the tracker (no drive minutes) never gets a countdown');
  etaCells += 1;
}
ok(`with gen2 + their measured drive minutes, the forms' etaMin equals pre-F4 on ${etaCells} inputs; the tracker's call (none supplied) gets null`);

// codex build r1 P2 — the forms' COMPLETE arrival output is unchanged: liveRender feeds arrivalFor the NON-gen2 presentation
// (only the segbar + status line take gen2). Pre-F4 form-live-status + status-view vs today's, over the grid incl. mx-present /
// contradictory records (the documented rollback window).
const FL = require('../xpizza-orders/form-live-status.js');
const flPreSrc = execFileSync('git', ['show', '5a7e9bdc:xpizza-orders/form-live-status.js'], { cwd: __dirname, encoding: 'utf8' });
const FLPRE = (() => { const m = { exports: {} }; new Function('module', 'exports', 'window', flPreSrc)(m, m.exports, undefined); return m.exports; })();
const flSrc = fs.readFileSync(path.join(ROOT, 'xpizza-orders', 'form-live-status.js'), 'utf8');
assert.ok(/const vArrival = livePresent\(pres\);/.test(flSrc) && /overdue: c\.overdueStage === stage, v: vArrival \}\);/.test(flSrc) && !/const pres = \{[^}]*gen2/.test(flSrc),
  '🔴 liveRender must compute the arrival line from the non-gen2 presentation');
const mxCases = [{}, { mx: { mode: 'neutral', name: 'Carlos' } }, { mx: { mode: 'live', name: 'Otro' } }, { mx: { mode: 'waiting', name: null } }];
let arrCells = 0;
for (const status of ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled']) for (const d of drivers) for (const m of mxCases) for (const e of etas) {
  const rec = { status, order_type: 'delivery', ready_at: NOWMS - 60000, ...d, ...m, ...e };
  const args = (M, P) => ({ rec, pickup: false, stage: M.stageOf(rec, false), prep: M.prepFor({ prep_eta_min: 20 }, 0, 0), driveMin: 20, anchorMs: 0, overdue: false,
    v: P({ ...rec, fallback_drive_min: 20, now: NOWMS }) });
  assert.deepStrictEqual(FL.arrivalFor(args(FL, NOW)), FLPRE.arrivalFor(args(FLPRE, PRE)), `🔴 the forms' arrival output changed for ${JSON.stringify(rec)}`);
  arrCells += 1;
}
ok(`the forms' COMPLETE arrival output equals pre-F4 on ${arrCells} inputs (status × driver fields × mx present / contradictory × ETA inputs)`);
{ // non-vacuity: feeding the gen2 presentation would leak the calm copy (codex's case) — the guard above matters
  const rec = { status: 'out_for_delivery', order_type: 'delivery', driver_name: 'Carlos', is_active_drop: false, mx: { mode: 'neutral', name: 'Carlos' } };
  const leak = FL.arrivalFor({ rec, pickup: false, stage: 'ofd', prep: null, driveMin: 20, anchorMs: 0, overdue: false, v: NOW({ ...rec, fallback_drive_min: 20, gen2: true, now: NOWMS }) }).text;
  const kept = FL.arrivalFor({ rec, pickup: false, stage: 'ofd', prep: null, driveMin: 20, anchorMs: 0, overdue: false, v: NOW({ ...rec, fallback_drive_min: 20, now: NOWMS }) }).text;
  assert.ok(/Con Carlos/.test(leak) && /parada rápida/.test(kept), `non-vacuity: gen2 would leak (${leak}); the kept arrival is the stacked copy (${kept})`);
}
ok('non-vacuity: with the gen2 presentation the arrival line would leak "Con Carlos…"; the non-gen2 one keeps "parada rápida"');

// non-vacuity: the same matrix WITH gen2 really differs somewhere (the tracker path is distinct)
const differs = statuses.some((status) => drivers.some((d) => JSON.stringify(NOW({ status, order_type: 'delivery', now: NOWMS, ...d, gen2: true })) !== JSON.stringify(PRE({ status, order_type: 'delivery', now: NOWMS, ...d }))));
assert.ok(differs, 'non-vacuity: gen2 changes the tracker output');
ok('non-vacuity: with gen2 the out_for_delivery decisions differ (the tracker path is distinct)');

console.log(`\nstatus-view-forms: OK (${n})`);
