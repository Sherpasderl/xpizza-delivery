// postact-route.js — PURE routing decision for the Inicio (b) post-activation checklist. The host (index.html
// render()) owns the device "checklist-pending" flag + the DOM; this is the pure predicate it consults so the
// behaviour is unit-testable (render() is not importable, and onboarding-host.test.js is frozen under slice 3).
//
// Inputs:
//   activeEnabled — the companion account is state==='active' && enabled===true (read from companion._state.lastValid).
//   action        — companion.decide().action: 'activated' on an OBSERVED profile_submitted→active transition, else
//                   'legacy' for an already-active driver (no transition observed on this device).
//   priorPending  — whether the device checklist-pending flag is ALREADY set for this uid (read before this call).
//
// Returns { setPending, showChecklist }:
//   setPending    — the host should set the device flag now (only on the fresh, observed transition).
//   showChecklist — the host should render the post-activation checklist (else fall through to the app).
//
// The guard that matters (owner): an already-active driver with no device flag — EVERYONE on upgrade — gets
// action 'legacy' and priorPending false, so showChecklist is false and they go straight to the app. The checklist
// shows ONLY after a transition observed on THIS device (action 'activated' → setPending) and stays until the host
// clears the flag on «Terminar» (next render: action 'legacy', priorPending false → app). A suspended account has
// activeEnabled false, so it never lands here.
export function postActRoute(activeEnabled, action, priorPending) {
  const setPending = !!activeEnabled && action === 'activated';
  const showChecklist = !!activeEnabled && (!!priorPending || setPending);
  return { setPending, showChecklist };
}
