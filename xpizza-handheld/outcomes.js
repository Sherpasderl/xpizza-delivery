// H1b T3 — the ONE result table (PLAN-H1b T3, codex P2-8): an H1a application result ({ok:true…} | {ok:false, code}) or a thrown
// callable error (error.code, any 'functions/' prefix stripped) → { class: ok | retry | terminal | auth, code }.
// Anything unknown is terminal with code 'error' — fail closed: never retried forever, never treated as success.
const RETRY = new Set(['unavailable', 'deadline-exceeded', 'internal']);
const TERMINAL = new Set(['stale_state', 'op_conflict', 'driver_assigned', 'cap_reached', 'not_served', 'not_found', 'bad_stored_state',
  'already_requested', 'bad_input', 'invalid-argument', 'permission-denied', 'forbidden', 'failed-precondition', 'not_enabled']);
const AUTH = new Set(['unauthenticated']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strip = (c) => (typeof c === 'string' ? c.replace(/^functions\//, '') : null);

export function classify(x) {
  if (isObj(x) && x.ok === true) return { class: 'ok', code: null };
  let code = null;
  if (x instanceof TypeError) return { class: 'retry', code: 'network' };          // fetch-level failure: no response at all
  if (x instanceof Error || (isObj(x) && x.ok === false)) code = strip(x.code);
  if (code && AUTH.has(code)) return { class: 'auth', code };
  if (code && RETRY.has(code)) return { class: 'retry', code };
  if (code && TERMINAL.has(code)) return { class: 'terminal', code };
  return { class: 'terminal', code: 'error' };
}
