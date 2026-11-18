'use strict';
// ---------------------------------------------------------------------------
// S3 D3 (advisor 11-13, ruling (A)) — a REWARD key the intake gate snapshot cannot classify. The cart carries no catalog
// version, so the gate asks the one authority a customer cannot be ahead of: the LIVE active pointer, read fresh (bypassing
// the 45 s pointer TTL) and bounded by the gate's own deadline, on this branch only — a classifiable reward never reads it.
//   live == the snapshot's version ⇒ the gate is current, the key is not on the menu ⇒ { removed: [keys] } → 409 menu_changed
//   live != the snapshot's version ⇒ the gate cache is behind ⇒ { unclassifiable: true } → 503 menu_updating (today)
//   a failed / timed-out read, no snapshot version (the static fallback: a pointer or menu read failure names none), no live
//   reader ⇒ { unclassifiable: true } (fail-safe). (`gates.fallback` is NOT that: it only says weekend_only_cats is unauthored.)
// The refusal is the order endpoints' own menu_changed (resolve-lines resolutionRefusal: the keyedRewardRefusal shape).
// Paid-line unknown keys (menu-gates absentFromMenu) are NOT judged here (out of scope; ledger follow-up).
// ---------------------------------------------------------------------------
const UNCLASSIFIABLE = Object.freeze({ unclassifiable: true });

async function removedOrUnclassifiable(gates, keys) {
  if (!gates || typeof gates.version !== 'string' || !gates.version || typeof gates.livePointer !== 'function') return UNCLASSIFIABLE;
  let live;
  try { live = await gates.livePointer(); } catch (e) {
    console.warn('reward_removed_live_read_failed', JSON.stringify({ error: String((e && e.message) || e).slice(0, 160) }));
    return UNCLASSIFIABLE;
  }
  if (live == null || String(live) !== gates.version) return UNCLASSIFIABLE;
  return { removed: keys.slice() };
}

const menuChangedRefusal = () => require('./resolve-lines').resolutionRefusal({ ok: false, code: 'menu_changed', at: 'redeem', index: 0 });

module.exports = { removedOrUnclassifiable, menuChangedRefusal };
