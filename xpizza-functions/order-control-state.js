// ── D4-c4 — "Pausar pedidos": the ONE pure interpretation of the pause switch (PLAN-D4c4 rev 13 §0.1/§0.2/§0.7) ──────
//
// Shared, byte-identical, by the functions (order-control.js, scheduled-release-core.js), the owner CLI
// (tools/order-control.js) and dispatch (xpizza-dispatch/order-control-state.js — a committed copy kept in sync by
// `npm run sync:client`; order-control-state-sync.guard.test.js fails on any drift). A classic script (no module syntax):
// Node requires it, the browser loads it with a plain <script src> and finds it at `window.OrderControlState`.
//
// The switch: RTDB `order_control/{rid}/current`. RTDB drops null children, so an indefinite pause is `{paused:true}`
// with `until` ABSENT. Decision order (§0.1), with NO coercion:
//   (a) node absent                         → OPEN
//   (b) `paused` absent or not a boolean    → UNKNOWN
//   (c) `paused === false`                  → OPEN (`until` ignored)
//   (d) `paused === true`: `until` absent   → PAUSED (no expiry)
//                          `until` finite   → PAUSED iff now < until, else OPEN (the auto-resume — no writer)
//                          anything else    → UNKNOWN
// The request's control decision: OPEN → none; PAUSED → 'paused' (423 ordering_paused); UNKNOWN → 'unavailable'
// (the retryable 503). Nothing here reads a clock, a database or the DOM — `now` is always passed in.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderControlState = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OPEN = 'open';
  var PAUSED = 'paused';
  var UNKNOWN = 'unknown';

  var PAUSED_DETAIL = 'Este restaurante no está recibiendo pedidos en este momento. Probá de nuevo más tarde.';
  var UNAVAILABLE_DETAIL = 'Tuvimos un problema momentáneo, probá de nuevo.';
  var REFUSALS = Object.freeze({
    paused: Object.freeze({ status: 423, body: Object.freeze({ error: 'ordering_paused', detail: PAUSED_DETAIL }) }),
    // the existing retryable class (as the identity-read failure: same `error`, `retryable: true`, Retry-After 2)
    unavailable: Object.freeze({ status: 503, retryAfter: '2', body: Object.freeze({ error: 'Service temporarily unavailable', detail: UNAVAILABLE_DETAIL, retryable: true }) }),
  });

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // `current` (the raw value read at order_control/{rid}/current; null/undefined = absent) at time `now` (ms epoch)
  // → { state: 'open'|'paused'|'unknown', until: <ms>|null }   (until is set only for a timed PAUSED)
  function effectiveState(current, now) {
    if (current === null || current === undefined) return { state: OPEN, until: null };
    if (!isObject(current) || typeof current.paused !== 'boolean') return { state: UNKNOWN, until: null };
    if (current.paused === false) return { state: OPEN, until: null };
    if (current.until === undefined) return { state: PAUSED, until: null };
    if (typeof current.until === 'number' && isFinite(current.until)) {
      return now < current.until ? { state: PAUSED, until: current.until } : { state: OPEN, until: null };
    }
    return { state: UNKNOWN, until: null };
  }

  // the request's control decision: null (admit) | 'paused' | 'unavailable'
  function decisionOf(state) {
    if (state === PAUSED) return 'paused';
    if (state === UNKNOWN) return 'unavailable';
    return null;
  }

  /* chargeOnlineOrder PRE-GATE (§3 + §0.2), from the decision and the preliminary classification `cls`
     (classifyHostedAttempt's result; null when the classifier failed):
       no decision                  → admit, nothing armed (today's path);
       classifier failed            → refuse 'unavailable' (retryable 503 before reserving — a retry re-classifies);
       fresh (willIssueFreshUrl)    → refuse with the decision (423 / 503), nothing reserved;
       anything else (reuse, in_progress, already_paid, closed, conflict) → admit — no state refuses reuse — and ARM the
                                      race guard with the decision, so a drift to a fresh issuance inside the state
                                      machine is refused with THIS request's kind. */
  function chargePreGate(decision, cls) {
    if (!decision) return { refuse: null, arm: null };
    if (cls === null || cls === undefined) return { refuse: 'unavailable', arm: null };
    if (cls.willIssueFreshUrl === true) return { refuse: decision, arm: null };
    return { refuse: null, arm: decision };
  }

  // §3a/§0.7 the scheduled-release hold: null (release as today) | { cause: 'paused' | 'unavailable' }
  function releaseHold(decision) {
    return decision ? { cause: decision } : null;
  }

  return {
    OPEN: OPEN, PAUSED: PAUSED, UNKNOWN: UNKNOWN,
    PAUSED_DETAIL: PAUSED_DETAIL, UNAVAILABLE_DETAIL: UNAVAILABLE_DETAIL, REFUSALS: REFUSALS,
    effectiveState: effectiveState, decisionOf: decisionOf, chargePreGate: chargePreGate, releaseHold: releaseHold,
  };
}));
