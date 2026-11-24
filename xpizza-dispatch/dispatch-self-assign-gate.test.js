// xpizza-dispatch/dispatch-self-assign-gate.test.js
//
// CTA audit #2 — «A mí» (self-assign) must go through the SAME confirm-to-override gate as every other
// assignment. Before the fix the «A mí» button called XPD.assignOrderToDriver(oid, uid) DIRECTLY, skipping
// the full / en-route / unreachable confirm cascade that the picker rows enforce — so a dispatcher-driver
// could self-stack a 3rd order (or assign while en-route / unreachable) with no guard.
//
// The fix: one shared cascade confirmAssignOverride({full,enRoute,unreachable}) + a classifier
// classifyDriverForAssign(uid), used by BOTH the picker rows and «A mí». One path, no special case.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// extract a top-level `function <name>(` … up to its closing brace at column 0 (the desktop idiom)
const fnSrc = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? null : src.slice(start, end + 2);
};

// ── the shared cascade exists and behaves (full → en-route → unreachable, in that priority) ──
{
  const src = fnSrc(html, 'confirmAssignOverride');
  assert.ok(src, 'confirmAssignOverride is a top-level function');
  // EXACT prompt text (Codex #227 P3): assert.equal on the whole message, so a mutant that appends to a
  // prompt (e.g. + ' MUTATED COPY') produces a different argument and dies here.
  const MSG = {
    full: 'Este repartidor ya tiene 2 pedidos (al límite). ¿Asignar de todas formas?',
    enRoute: 'Este repartidor ya salió a entregar (en camino). ¿Asignar de todas formas?',
    unreachable: 'Este repartidor no tiene notificaciones activadas. ¿Asignar de todas formas?',
  };
  // §6: the cascade now runs through styledConfirm (async). Stub it, capture the opts; the exact message is
  // the dialog BODY, the override button «Asignar igual». The exact-body asserts keep the P3 mutant dead.
  const calls = [];
  const make = (ret) => new Function('styledConfirm', `${src}\n; return confirmAssignOverride;`)((opts) => { calls.push(opts); return Promise.resolve(ret); });

  calls.length = 0;
  assert.equal(await make(false)({ full: true, enRoute: false, unreachable: false }), false, 'decline on full → does not proceed');
  assert.equal(calls.length, 1); assert.equal(calls[0].body, MSG.full, 'exact full-driver prompt as the dialog body');
  assert.equal(calls[0].confirmLabel, 'Asignar igual', 'the override button is «Asignar igual»');

  calls.length = 0;
  assert.equal(await make(true)({ full: true }), true, 'accept on full → proceeds');

  calls.length = 0;
  await make(false)({ enRoute: true });
  assert.equal(calls[0].body, MSG.enRoute, 'exact en-route prompt');

  calls.length = 0;
  await make(false)({ unreachable: true });
  assert.equal(calls[0].body, MSG.unreachable, 'exact unreachable prompt');

  calls.length = 0;
  assert.equal(await make(false)({ full: false, enRoute: false, unreachable: false }), true, 'no flag → proceeds without asking');
  assert.equal(calls.length, 0, 'a clean driver is never prompted');

  calls.length = 0;
  await make(false)({ full: true, enRoute: true, unreachable: true });
  assert.equal(calls[0].body, MSG.full, 'full takes priority over en-route/unreachable');
  assert.equal(calls.length, 1, 'only one prompt, the highest-priority reason');
  ok('confirmAssignOverride: full→en-route→unreachable cascade via styledConfirm, «Asignar igual», clean driver never prompted');
}

// ── the classifier mirrors the picker's rules (full = 2 distinct active orders, en-route by status, unreachable by push) ──
{
  const src = fnSrc(html, 'classifyDriverForAssign');
  assert.ok(src, 'classifyDriverForAssign is a top-level function');
  const build = (allDrivers, allTasks, reachable) =>
    new Function('allDrivers', 'allTasks', 'hasPushReachability', `${src}\n; return classifyDriverForAssign;`)(
      allDrivers, allTasks, (d) => reachable(d));

  // 2 distinct active order_ids → full
  const full = build(
    { me: { status: 'available' } },
    { a_pickup: { assigned_driver_id: 'me', order_id: 'A', status: 'assigned' },
      a_delivery: { assigned_driver_id: 'me', order_id: 'A', status: 'assigned' },
      b_delivery: { assigned_driver_id: 'me', order_id: 'B', status: 'assigned' } },
    () => true)('me');
  assert.deepEqual(full, { full: true, enRoute: false, unreachable: false }, '2 distinct order_ids → full');

  // completed/cancelled tasks don't count toward the load
  const notFull = build(
    { me: { status: 'available' } },
    { a_delivery: { assigned_driver_id: 'me', order_id: 'A', status: 'completed' },
      b_delivery: { assigned_driver_id: 'me', order_id: 'B', status: 'cancelled' } },
    () => true)('me');
  assert.equal(notFull.full, false, 'completed/cancelled tasks are not active load');

  const enRoute = build({ me: { status: 'en_route_delivery' } }, {}, () => true)('me');
  assert.deepEqual(enRoute, { full: false, enRoute: true, unreachable: false }, 'en_route_delivery → enRoute');

  const unreachable = build({ me: { status: 'available' } }, {}, () => false)('me');
  assert.equal(unreachable.unreachable, true, 'no push reachability → unreachable');

  const clean = build({ me: { status: 'available' } }, {}, () => true)('me');
  assert.deepEqual(clean, { full: false, enRoute: false, unreachable: false }, 'clean driver → no confirm needed');
  ok('classifyDriverForAssign: full (2 distinct active orders), en-route, unreachable — mirrors the picker');
}

// ── routing: «A mí» runs the gate BEFORE assigning (reproduces the bypass bug on the old code) ──
{
  const selfStart = html.indexOf("[data-assign-self]");
  assert.ok(selfStart > -1, 'located the self-assign wiring');
  const selfBlock = html.slice(selfStart, html.indexOf("'Asignado a ti'", selfStart));
  assert.ok(selfBlock.includes('confirmAssignOverride(') && selfBlock.includes('classifyDriverForAssign('),
    '«A mí» routes through confirmAssignOverride(classifyDriverForAssign(...))');
  assert.ok(selfBlock.indexOf('confirmAssignOverride(') < selfBlock.indexOf('XPD.assignOrderToDriver'),
    'the gate runs BEFORE the server assign (a decline must block it)');
  ok('«A mí» runs the shared gate before XPD.assignOrderToDriver');
}

// ── one source: the picker rows use the SAME shared cascade (no duplicated confirm() strings) ──
{
  const pStart = html.indexOf("querySelectorAll('[data-driver-uid]')");
  assert.ok(pStart > -1, 'located the picker row wiring');
  const pBlock = html.slice(pStart, html.indexOf('await assignOrder(', pStart));
  assert.ok(pBlock.includes('confirmAssignOverride('), 'picker rows call the shared confirmAssignOverride');
  ok('picker rows share the same confirmAssignOverride cascade (one source)');
}

console.log(`dispatch-self-assign-gate: OK (${n})`);
