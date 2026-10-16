// onboarding-helpers.js — PURE logic for the S1b driver-app companion (read-once model).
// No DOM, no Firebase, no timers. index.html wires the reads/screens/handlers around these.
// Contract: §10 of PLAN-S1b-BUILD-callables-ui.md. The app READS /driver_accounts/{uid} and calls
// submitDriverProfile; it NEVER writes the account node. The server (S1a rules + guard + Auth revoke)
// is the sole authority — this module only decides what the UI shows in reaction to a read.

'use strict';

const KNOWN_STATES = ['pending', 'profile_submitted', 'active', 'void'];

// Classify a raw /driver_accounts/{uid} snapshot value into a well-formed record or a meta.
//   meta: 'valid'   -> { meta, deactivated, enabled, state }
//         'missing' -> the node does not exist (null/undefined)
//         'malformed'-> present but not a usable record (wrong type / unknown state / bad combination)
// (A failed/denied READ is 'error' and a not-yet-read is 'unresolved'; those are the caller's to set —
//  this function only sees a value it successfully read.)
function classifyAccount(val) {
  if (val === null || val === undefined) return { meta: 'missing' };
  if (typeof val !== 'object' || Array.isArray(val)) return { meta: 'malformed' };
  const state = val.onboarding_state;
  if (typeof state !== 'string' || !KNOWN_STATES.includes(state)) return { meta: 'malformed' };
  const deactivated = val.deactivated === true;        // normalize absent -> false
  // `enabled` must be a real boolean for a non-deactivated record (the eligibility combination the UI keys on).
  if (!deactivated && typeof val.enabled !== 'boolean') return { meta: 'malformed' };
  const enabled = val.enabled === true;                // only strict true is "enabled"
  return { meta: 'valid', deactivated, enabled, state };
}

// The screen decision (§3 precedence). Inputs: flagEnabled (strict boolean), and an EFFECTIVE account
// (meta is one of 'unresolved'|'error'|'valid'|'missing'|'malformed'; when 'valid' it carries deactivated/enabled/state).
// Returns one of:
//   'legacy'      -> defer to the app's existing render (today's path, byte-identical)
//   'deactivated' -> E2
//   'onboarding'  -> A3 profile -> A4 checklist -> A5 practice -> Pedir aprobación (pending)
//   'waiting'     -> A6 "Esperando aprobación" (profile_submitted)
//   'suspended'   -> normal app + inline suspended notice (active & enabled===false)
//   'app'         -> normal app (active & enabled===true)
//   'neutral-hold'-> recoverable neutral hold (missing/malformed/void/unknown)
function companionDecision(flagEnabled, acct) {
  if (flagEnabled !== true) return 'legacy';                                   // row 0 — inert
  const meta = acct && acct.meta;
  if (meta === 'unresolved' || meta === 'error') return 'legacy';             // row 1 — today's UI + last valid
  if (meta !== 'valid') return 'neutral-hold';                                 // row 7 — missing/malformed
  if (acct.deactivated === true) return 'deactivated';                         // row 2
  if (acct.state === 'active' && acct.enabled === false) return 'suspended';   // row 3
  if (acct.state === 'pending') return 'onboarding';                           // row 4
  if (acct.state === 'profile_submitted') return 'waiting';                    // row 5
  if (acct.state === 'active' && acct.enabled === true) return 'app';          // row 6
  return 'neutral-hold';                                                        // void / anything else
}

// The "Activado" transient shows ONLY on the OBSERVED profile_submitted -> active&&enabled transition
// between two VALID reads. Never on initial load of an already-active account, never on suspension removal.
function isApprovalTransition(prev, next) {
  return !!prev && prev.meta === 'valid' && !!next && next.meta === 'valid'
    && prev.state === 'profile_submitted'
    && next.state === 'active' && next.enabled === true;
}

// Firebase callable errors arrive as `functions/permission-denied`, `functions/invalid-argument`, … — strip
// the `functions/` prefix so comparisons work against both the prefixed real codes and bare ones (P1-3).
function normalizeCode(code) { return String(code || '').replace(/^functions\//, ''); }

// Map a submitDriverProfile callable outcome to a host action (SIMPLIFIED — codex r2 §5: no account read here;
// one submit in flight, success → waiting, and ANY later read decides the final screen). An explicit
// deactivation message → 'deactivated' (the host shows E2; there is NO automatic sign-out). Returns:
//   'ok' | 'deactivated' | 'reauth' | 'field-error' | 'error'
function classifySubmitOutcome(ok, errorCode, errorMessage) {
  if (ok) return 'ok';
  const code = normalizeCode(errorCode);
  if (code === 'permission-denied' && /desactivada/i.test(errorMessage || '')) return 'deactivated';
  if (code === 'permission-denied' || code === 'unauthenticated') return 'reauth';
  if (code === 'invalid-argument') return 'field-error';
  return 'error';
}

// A callable/denial surfaces E2 ONLY when it positively identifies deactivation (the Spanish guard message).
// A generic permission-denied (session expired) or any other denial never implies deactivation.
function isDeactivatedDenial(errorCode, errorMessage) {
  return normalizeCode(errorCode) === 'permission-denied' && /desactivada/i.test(errorMessage || '');
}

// Async-session safety (NEW-3): an async result applies only if its captured session token is still current
// AND (for a refresh) it is the latest issued. Plain identity/counter checks — no subscription framework.
function sessionCurrent(capturedTag, currentTag) { return capturedTag != null && capturedTag === currentTag; }
function isLatestRefresh(capturedSeq, latestSeq) { return capturedSeq === latestSeq; }

// ============================================================================
// Read-once companion CONTROLLER (SIMPLIFIED — codex r2: NO automatic sign-out, no teardown, no submit barrier,
// no write-denied re-read). The server is the sole authority (S1a rules + guard + Auth disable/revoke); the UI
// only SHOWS the state. PURE of DOM/Firebase — every side effect goes through `env`. `decide()` is pure and is
// what render() calls synchronously.
//   env = {
//     getUid()       -> uid | null
//     readFlag()     -> Promise<boolean>
//     readAccount(uid) -> Promise<rawValue>
//     submit(fields) -> Promise<{ok}>   (throws HttpsError-shaped {code,message})
//     clearDraft()   -> void     (optional; called when the account leaves 'pending')
//     bootSettled()  -> Promise  (resolves when THIS session's legacy boot has settled, success OR failure — P1-1)
//     rerender()     -> void     (the host's render())
//     flagDeadlineMs -> number   (optional; default 3000)
//   }
// Flag + account are read at boot/resume/reconnect/pull-to-refresh and once after submit; a flag change takes
// effect at the NEXT read (no mid-flight re-evaluation). E2 is shown (never a programmatic sign-out) from a
// confirmed deactivated READ (decide) or an explicit callable deactivation MESSAGE (submit → 'deactivated').
// ============================================================================
const FLAG_READ_DEADLINE_MS = 3000;
function makeCompanionController(env) {
  const S = { flag: null, account: { meta: 'unresolved' }, lastValid: null, prevValid: null,
    tag: null, seq: 0, submitInFlight: false };

  function resetSession() {
    S.tag = {}; S.seq = 0; S.flag = null; S.account = { meta: 'unresolved' };
    S.lastValid = null; S.prevValid = null; S.submitInFlight = false;
    return S.tag;
  }
  function effective() {
    if (S.account.meta === 'valid') return S.account;
    if ((S.account.meta === 'error' || S.account.meta === 'unresolved') && S.lastValid) return S.lastValid;
    return S.account;
  }
  // The flag read, bounded by a deadline: a slow/hung read resolves false (today's code) rather than retaining
  // a stale enabled state; a late real value loses the race.
  function readFlagBounded() {
    const ms = env.flagDeadlineMs || FLAG_READ_DEADLINE_MS;
    return Promise.race([
      Promise.resolve().then(() => env.readFlag()).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), ms)),
    ]);
  }
  // PURE decision — render() calls this synchronously. Returns an action descriptor; never a side effect.
  //   action: 'legacy' (today's render; `suspended` overlays the inline notice) | 'deactivate' (SHOW E2, no
  //           sign-out) | 'activated' | 'show' with view ∈ 'onboarding'|'waiting'|'neutral-hold'
  function decide() {
    if (S.flag !== true) return { action: 'legacy', suspended: false };          // inert ⇒ byte-identical
    const acct = effective();
    const d = companionDecision(true, acct);
    if (d === 'deactivated') return { action: 'deactivate', suspended: false };
    if (d === 'suspended') return { action: 'legacy', suspended: true };
    if (d === 'app') return isApprovalTransition(S.prevValid, acct) ? { action: 'activated', suspended: false } : { action: 'legacy', suspended: false };
    if (d === 'waiting') return { action: 'show', view: 'waiting', suspended: false };     // profile_submitted
    if (d === 'neutral-hold') return { action: 'show', view: 'neutral-hold', suspended: false };
    if (d === 'onboarding') return { action: 'show', view: 'onboarding', suspended: false };
    return { action: 'legacy', suspended: false };   // unresolved/error with no last-valid → today's UI
  }
  async function refresh() {
    if (!env.getUid()) return;
    const tag = S.tag, seq = ++S.seq;
    if (env.bootSettled) { try { await env.bootSettled(); } catch (_) { /* boot failed — still proceed */ } }   // P1-1
    if (S.tag !== tag || S.seq !== seq) return;                 // async-session safety: discard stale/superseded
    let flag = false;
    try { flag = await readFlagBounded(); } catch (_) { flag = false; }
    if (S.tag !== tag || S.seq !== seq) return;
    if (flag !== true) { S.flag = false; env.rerender(); return; }   // flag off ⇒ today's code
    let meta = 'error', cls = null;
    try { cls = classifyAccount(await env.readAccount(env.getUid())); meta = cls.meta; } catch (_) { meta = 'error'; }
    if (S.tag !== tag || S.seq !== seq) return;
    S.flag = true;
    if (meta === 'valid') {
      if (S.lastValid) S.prevValid = S.lastValid;
      S.lastValid = cls; S.account = cls;
      if (cls.state !== 'pending' && env.clearDraft) env.clearDraft();
    } else { S.account = { meta }; }
    env.rerender();
  }
  // One submit in flight; success → the host shows waiting + does the one after-submit read, which (like any
  // later read) decides the final screen. No account read / reconcile / flag re-check here (codex r2 §5). A new
  // session beginning mid-flight discards the result (never applied to B). Returns the host action:
  //   'ok' | 'deactivated' | 'reauth' | 'field-error' | 'error' | undefined (dropped: in-flight or stale session)
  async function submit(fields) {
    if (S.submitInFlight) return undefined;
    S.submitInFlight = true;
    const tag = S.tag;
    let ok = false, errorCode = null, errorMessage = null;
    try { const res = await env.submit(fields); ok = !!(res && res.ok); }
    catch (e) { errorCode = (e && e.code) || ''; errorMessage = (e && e.message) || ''; }
    if (S.tag !== tag) return undefined;   // a new session began while in flight — do NOT touch B's state / apply A's result
    S.submitInFlight = false;
    return classifySubmitOutcome(ok, errorCode, errorMessage);
  }
  // After the "Activado" transient is shown, advance prevValid so decide() stops returning 'activated'
  // (the transition is observed exactly once; the next render routes to the normal app).
  function consumeApprovalTransition() { S.prevValid = S.lastValid; }

  return { resetSession, refresh, submit, consumeApprovalTransition, decide, _state: S };
}

export {
  KNOWN_STATES,
  classifyAccount,
  companionDecision,
  isApprovalTransition,
  classifySubmitOutcome,
  isDeactivatedDenial,
  sessionCurrent,
  isLatestRefresh,
  makeCompanionController,
};
