'use strict';
// ── form-apply — APPLYING A LIVE MENU WITHOUT EVER SHOWING HALF OF ONE (Portal 1B Task 6) ─────────
//
// 🔴 WHERE THE HALF-MENU RISK ACTUALLY LIVES NOW. The coordinator (form-live-menu.js) refuses a
// malformed snapshot whole and retains the last good one, so nothing half-formed reaches this point.
// But it commits `applied` BEFORE calling onApply — deliberately, so a throwing render cannot wedge it
// in `fetching` forever — and that decision relocates the risk rather than removing it: from "half a
// menu in memory" to "half a menu ON SCREEN". A render that throws in the middle leaves some tiles
// showing the new snapshot and the rest showing the old one, with the globals somewhere in between.
// New dishes at old prices is the DOM-level version of exactly the outcome this whole slice exists to
// prevent.
//
// SO THE APPLY IS ALL-OR-NOTHING, and it is worth being precise about where that guarantee comes from,
// because "prepare everything first, then commit" is only half of it:
//
//   1. PREPARE IS COMPLETE AND PURE. Everything that can REJECT a snapshot — shape, completeness,
//      cross-references — happens before anything is touched, and produces the new values without
//      installing them. A rejected snapshot therefore costs nothing: the prior menu simply stands.
//
//   2. THE COMMIT HAS A RESTORE POINT. Preparation cannot make the commit infallible: it assigns
//      several globals, drives the form's own renderers, and reconciles the cart, and any of those can
//      throw for reasons no validation predicted. So the state that commit will touch is captured
//      FIRST, and any failure puts all of it back. The guarantee is rollback, not optimism.
//
//   The capture is taken before PREPARE, not before commit. Prepare is supposed to be pure, but
//   "supposed to be" is not a guarantee, and one capture is cheap insurance against a preparation step
//   that mutates something on its way to throwing.
//
// AND THE APPLY DOES NOT ALWAYS RUN. Two states where replacing the menu would be wrong rather than
// merely awkward:
//
//   DEFERRED — a modal or the checkout is open, or a submit is in flight. Swapping the menu under a
//   customer mid-decision moves what they are reading; swapping it mid-submit races the thing being
//   submitted. The snapshot is held and applied when the form goes idle. Only the LATEST is held: an
//   older one waiting behind a newer one has nothing to contribute.
//
//   IGNORED — the order is submitted or complete. That cart is now a receipt, a retry, or a completed
//   order, and a menu update has nothing to say about it. This is terminal: nothing re-opens it, and a
//   pending snapshot is dropped rather than kept for a form that will never be idle again.
//
// UMD-lite (no `export`), canonical here, byte-identical copy in la-musa-orders/ — same discipline as
// form-cart.js and form-live-menu.js, with a drift test.
function createMenuApplier(options) {
  const { prepare, commit, capture, restore, isBusy, isTerminal, log } = options || {};
  for (const hook of ['prepare', 'commit', 'capture', 'restore']) {
    if (typeof (options || {})[hook] !== 'function') throw new Error(`createMenuApplier: ${hook} is required`);
  }
  const busy = typeof isBusy === 'function' ? isBusy : () => false;
  const terminal = typeof isTerminal === 'function' ? isTerminal : () => false;
  const note = typeof log === 'function' ? log : () => {};

  let pending = null;       // the newest snapshot that could not be applied yet
  let lastError = null;
  let fatal = null;         // a rollback that itself failed — the one state this cannot recover from
  let applied = 0, deferred = 0, refused = 0;

  function attempt(snapshot) {
    // 🔴 CAPTURED BEFORE PREPARE. See the header: prepare is meant to be pure, and the capture is what
    // makes that a guarantee rather than an assumption.
    const point = capture();
    try {
      const prepared = prepare(snapshot);
      if (!prepared) throw new Error('apply_prepare_empty');
      commit(prepared);
      lastError = null; applied += 1;
      note('menu_applied', { applied });
      return 'applied';
    } catch (e) {
      try {
        restore(point);
      } catch (re) {
        // Rollback failed. The screen may now agree with nothing, and pretending otherwise would be
        // worse than saying so — a caller can reload rather than keep serving an unknown page.
        fatal = re;
        note('menu_apply_rollback_failed', { error: String((re && re.message) || re) });
        return 'broken';
      }
      lastError = e; refused += 1;
      note('menu_apply_refused', { error: String((e && e.message) || e) });
      return 'refused';
    }
  }

  function apply(snapshot) {
    if (terminal()) { pending = null; return 'ignored'; }
    if (busy()) {
      // LATEST ONLY. A queue here would replay a stale menu after a newer one, which is the same
      // out-of-order application the coordinator already refuses one layer up.
      pending = snapshot; deferred += 1;
      note('menu_apply_deferred', { deferred });
      return 'deferred';
    }
    /* 🔴 AND A SNAPSHOT THAT APPLIES SUPERSEDES ANY HELD ONE TOO. The latest-only rule above covers
       two snapshots arriving while BUSY; it did not cover one arriving while idle on top of an older
       one already held. The sequence that broke it: A arrives during a modal (held) → the modal closes
       → B arrives and applies → a later flush replays A over B, and the customer ends up looking at the
       OLDER menu. Never-backward has to hold across both paths, not just the one where both snapshots
       are deferred. Cleared before the attempt, so even a refusal cannot leave A waiting behind. */
    pending = null;
    return attempt(snapshot);
  }

  // Called when the form goes idle — a modal closes, checkout closes, a submit finishes.
  function flush() {
    if (!pending) return 'idle';
    if (terminal()) { pending = null; return 'ignored'; }
    if (busy()) return 'deferred';
    const snapshot = pending;
    pending = null;                       // cleared BEFORE the attempt, so a refusal cannot re-run forever
    return attempt(snapshot);
  }

  const hasPending = () => pending !== null;
  const state = () => ({ pending: pending !== null, lastError, fatal, counts: { applied, deferred, refused } });

  return { apply, flush, hasPending, state };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createMenuApplier };
if (typeof window !== 'undefined') window.createMenuApplier = createMenuApplier;
