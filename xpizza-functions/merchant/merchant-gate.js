'use strict';
// H1a C-1 — the two server-only gates that keep the handheld DARK until the activation tool (A1) flips them:
//   platform_config/handheld_pairing_enabled === true   → device pairing / token minting (A1 sets it only after F2(c))
//   restaurants/{rid}/order_surface ∈ {'kds','handheld'} → which surface serves a location's orders (absent = 'kds')
// Brand activation gates INTAKE only (PLAN-multi-location §3.4); it is deliberately not read here.

async function readVal(db, path) { return (await db.ref(path).once('value')).val(); }

const unavailable = (cause) => Object.assign(new Error(`unavailable: ${cause}`), { code: 'unavailable' });

// Fail closed: anything but an explicit boolean true — including a read failure — keeps pairing off.
async function pairingEnabled(db) {
  try { return (await readVal(db, 'platform_config/handheld_pairing_enabled')) === true; } catch (_) { return false; }
}

// 'handheld' only for the exact string; absent or malformed → 'kds' (today's behaviour). A read failure is NOT 'kds' — it
// throws `unavailable`, so a callable refuses rather than guessing which surface owns the location.
async function surfaceOf(db, rid) {
  let v;
  try { v = await readVal(db, `restaurants/${rid}/order_surface`); } catch (e) { throw unavailable(e.message); }
  return v === 'handheld' ? 'handheld' : 'kds';
}

// BC1 — A1 may switch a location to 'handheld' only when no identity there is BOTH kitchen and dispatcher (the KDS status
// rule clause refuses kitchen writes, but a dispatcher-role write would still pass). Pure; A1 supplies the two uid lists.
function dualRoleConflicts(kitchenUids, dispatcherUids) {
  const d = new Set(dispatcherUids || []);
  return [...new Set(kitchenUids || [])].filter((u) => d.has(u)).sort();
}

module.exports = { pairingEnabled, surfaceOf, dualRoleConflicts };
