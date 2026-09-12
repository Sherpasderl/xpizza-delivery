'use strict';
// ── form-live-menu — the shared LIVE-MENU COORDINATOR (Portal 1B Task 3) ──────────────────────────
//
// The form already has a menu: the bundle spliced into its HTML, correct as of the last deploy.
// Everything here is an UPGRADE on that, and every failure mode therefore has the same obligation —
// leave the customer looking at a menu that is WHOLE and COHERENT, even if it is older than the
// catalog. Three outcomes are not acceptable, and each is a plausible result of ordinary network
// behaviour rather than of a bug:
//
//   A BLANK MENU        — a 304 answering a body this client never rendered, or an empty snapshot
//                         applied because "200" was treated as "fine".
//   HALF A MENU         — a body that parsed but did not validate, applied collection by collection.
//   A MENU GOING BACK   — two requests in flight (a visibility change, a timer, a manual refresh) and
//                         the OLDER one landing last. Nothing about that looks like an error to
//                         anyone; the customer simply sees yesterday's prices.
//
// UMD-lite, like avail-key.js: no `export` keyword, so the same bytes are a valid Node module (the
// tests `require` it) and a classic browser <script> (the forms read window.createLiveMenu). This
// file is the canonical copy — la-musa-orders/form-live-menu.js must stay byte-identical, and a
// drift test asserts it.
//
// THE ADAPTER IS THE BRAND SEAM. The two forms differ materially (x_pizza numeric ids and prices by
// NAME, la_musa string ids and prices by id, variant launchers, subcats), and none of that belongs
// here. The adapter validates a snapshot, diffs two of them, and — in Tasks 4-5 — answers questions
// about identity. It is REQUIRED: a coordinator that cannot validate would apply whatever arrived.
function createLiveMenu(options) {
  const { url, fetchImpl, onApply, adapter, now } = options || {};
  if (!adapter) throw new Error('createLiveMenu: an adapter is required — without one, every response would be applied unchecked');
  if (typeof adapter.validateSnapshot !== 'function') throw new Error('createLiveMenu: the adapter must provide validateSnapshot');
  /* 🔴 A MISSING fetchImpl USED TO LOOK EXACTLY LIKE BEING OFFLINE. Calling `undefined` throws, the
     throw is caught by the network handler, and the feed reports `network: ...` forever — a wiring
     mistake wearing the costume of a transient outage, which is the most expensive kind to diagnose
     because every symptom says "retry". It cost a full debugging pass during the Task 6 integration.
     Stated as a contract instead, like the adapter above: absent means refused, loudly, at construction. */
  if (typeof fetchImpl !== 'function') throw new Error('createLiveMenu: fetchImpl is required — without one every attempt reports a network failure that never happened');
  const clock = typeof now === 'function' ? now : () => Date.now();

  // WHAT THE CUSTOMER IS CURRENTLY LOOKING AT. `etag` lives HERE, beside the snapshot it validates,
  // and never on its own: a stored validator with no applied body would make the next request
  // conditional on a representation this client cannot render, and the 304 that came back would be
  // an instruction to display nothing.
  let applied = { source: 'bundle', snapshot: null, etag: null, at: null };
  let phase = 'bundle';                  // bundle | fetching | live | retained
  let issued = 0;                        // monotonic; the ONLY thing that decides which response wins
  let lastAttemptAt = null;
  let lastError = null;

  const state = () => ({
    phase,
    source: applied.source,
    etag: applied.etag,
    snapshot: applied.snapshot,
    lastAttemptAt,
    lastAppliedAt: applied.at,
    lastError,
    inFlight: issued,
  });

  // A failure NEVER touches `applied`. That one line is the whole retain policy: the first failure
  // leaves the bundle because the bundle is what is applied, and a later failure leaves the last-good
  // live snapshot for exactly the same reason. There is no branch to get wrong.
  function fail(reason) {
    lastError = reason;
    phase = 'retained';
    return state();
  }

  async function refresh() {
    const mine = ++issued;
    phase = 'fetching';
    lastAttemptAt = clock();

    const headers = {};
    // Conditional ONLY when we hold the body that validator describes.
    if (applied.source === 'live' && applied.etag) headers['If-None-Match'] = applied.etag;

    let res;
    try {
      res = await fetchImpl(url, { headers, method: 'GET' });
    } catch (e) {
      if (mine !== issued) return state();              // a stale failure must not move anything
      return fail(`network: ${String((e && e.message) || e).slice(0, 120)}`);
    }
    // 🔴 STALENESS IS CHECKED BEFORE ANYTHING ELSE IS DECIDED. An older response must not apply, must
    // not fail, and must not change the phase — a newer request is still the one that gets to speak.
    if (mine !== issued) return state();

    if (res && res.status === 304) {
      // We only ask conditionally when we hold the body, so a 304 can only be honest if we do. If it
      // is not, keeping what we have is the answer — never "apply nothing and call it success".
      if (applied.source === 'live' && applied.snapshot) { phase = 'live'; lastError = null; return state(); }
      return fail('304 for a representation this client has never applied');
    }
    if (!res || !res.ok) return fail(`status ${res ? res.status : 'none'}`);

    let raw;
    try {
      raw = await res.json();
    } catch (e) {
      if (mine !== issued) return state();
      return fail('body was not JSON');
    }
    if (mine !== issued) return state();

    // ATOMIC. The adapter either hands back a whole snapshot or it does not; a refused body is
    // indistinguishable from a network failure, and in particular leaves no validator behind — a
    // stored etag for a body we refused would make the next request conditional on it.
    let snapshot = null;
    try {
      snapshot = adapter.validateSnapshot(raw);
    } catch (e) {
      return fail(`snapshot refused: ${String((e && e.message) || e).slice(0, 120)}`);
    }
    if (!snapshot) return fail('snapshot refused by the adapter');

    const etag = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('etag') : null;
    const diff = typeof adapter.diff === 'function' ? adapter.diff(applied.snapshot, snapshot) : null;

    // Applied BEFORE the callback: if the form's own render throws, the coordinator must still know
    // that this snapshot is what is showing, or every later refresh would be conditional on a
    // validator whose body never went up.
    applied = { source: 'live', snapshot, etag: etag || null, at: clock() };
    phase = 'live';
    lastError = null;
    try {
      if (typeof onApply === 'function') onApply(snapshot, diff);
    } catch (e) {
      // The render blew up. That is the form's problem to report, not a reason to wedge the
      // coordinator in `fetching` and freeze the menu for the rest of the session.
      lastError = `onApply threw: ${String((e && e.message) || e).slice(0, 120)}`;
    }
    return state();
  }

  function start() {
    phase = 'bundle';
    return refresh();
  }

  return { start, refresh, state };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createLiveMenu };
if (typeof window !== 'undefined') window.createLiveMenu = createLiveMenu;
