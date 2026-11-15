// THE control states a portal page may paint as a FACT — exactly 5f's server enum (xpizza-functions/portal/ops-core.js controlOf
// :79–93: 'inactive' > 'paused' > 'closed' > 'open'; 'unknown' for a missing / malformed identity or control, or a failed read). ONE list,
// shared by every reader (pause-control.js, inicio-logic.js — Codex backfill r2, advisor 11-15): 'unknown', '', or any other value is
// NOT a fact — ambiguous, never a success, never «Todo en orden».
export const KNOWN_CONTROL_STATES = Object.freeze(['open', 'closed', 'paused', 'inactive']);
export const knownControl = (c) => !!c && typeof c === 'object' && KNOWN_CONTROL_STATES.includes(c.state);
