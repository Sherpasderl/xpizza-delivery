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

// Submit reconciliation (§5). Decides the next UI from the callable outcome + a FRESH post-submit read.
// A stale PRE-request snapshot must never be passed here — only a fresh read. Returns:
//   'deactivated' | 'reauth' | 'field-error' | 'waiting' | 'app' | 'retry' | 'recoverable-wait'
function reconcileAfterSubmit(outcome) {
  const { ok, errorMessage, freshMeta, freshRec } = outcome;
  const errorCode = normalizeCode(outcome.errorCode);
  if (!ok) {
    if (errorCode === 'permission-denied' && /desactivada/i.test(errorMessage || '')) return 'deactivated';
    if (errorCode === 'permission-denied') return 'reauth';   // non-deactivation denial (e.g. revoked/expired session)
    if (errorCode === 'unauthenticated') return 'reauth';
    if (errorCode === 'invalid-argument') return 'field-error';
  }
  // Reconcile from the FRESH read for both success and the remaining errors.
  if (freshMeta === 'valid' && freshRec) {
    if (freshRec.deactivated === true) return 'deactivated';
    if (freshRec.state === 'profile_submitted') return 'waiting';   // includes a lost-response commit
    if (freshRec.state === 'active') return 'app';
    if (freshRec.state === 'pending') return ok ? 'waiting' : 'retry'; // ok+still-pending = ack now; error+fresh-pending = resubmit
  }
  // Acknowledged submission with no reconcilable read yet -> show waiting optimistically (next read decides).
  if (ok) return 'waiting';
  // Could not confirm (read failed) -> recoverable waiting with pull-to-refresh, never a dead-end or false retry.
  return 'recoverable-wait';
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
// Read-once companion CONTROLLER — the single source of truth for the orchestration (flag/account state,
// read-once sequencing, async-session safety, E2 teardown, submit reconciliation). PURE of DOM/Firebase:
// every side effect goes through the injected `env`. index.html builds `env` from the real DOM + SDK; tests
// build it from fakes. `decide()` is pure and is what render() calls synchronously.
//   env = {
//     getUid()         -> uid | null
//     readFlag()       -> Promise<boolean>     (throws on read error)
//     readAccount(uid) -> Promise<rawValue>    (throws on read error)
//     submit(fields)   -> Promise<{ok}>        (throws HttpsError-shaped {code,message})
//     clearDraft()     -> void     (optional; called when the account leaves 'pending')
//     localTeardown()  -> void|Promise  (LOCAL-only; must not block — the host fires server calls detached)
//     signOut()        -> Promise
//     bootSettled()    -> Promise  (resolves when THIS session's legacy boot has settled, success OR failure — P1-1)
//     rerender()       -> void     (the host's render(); it calls decide() synchronously and shows the screen)
//     flagDeadlineMs   -> number   (optional; default 3000 — the flag read's deadline, P1-5)
//   }
// The HOST owns ALL DOM. The controller owns state + read-once sequencing + the PURE decision. render() calls
// decide(); refresh()/submit() update state then rerender(). triggerDeactivate() does teardown+sign-out only.
// ============================================================================
const FLAG_READ_DEADLINE_MS = 3000;
function makeCompanionController(env) {
  const S = { flag: null, account: { meta: 'unresolved' }, lastValid: null, prevValid: null,
    tag: null, seq: 0, tornDown: false, deactReason: false, submitInFlight: false, submitState: null };

  function resetSession() {
    S.tag = {}; S.seq = 0; S.flag = null; S.account = { meta: 'unresolved' };
    S.lastValid = null; S.prevValid = null; S.tornDown = false; S.submitInFlight = false;
    S.submitState = null; S.deactReason = false;   // P2-10: a new login clears the deactivation reason + submit barrier
    return S.tag;
  }
  function effective() {
    if (S.account.meta === 'valid') return S.account;
    if ((S.account.meta === 'error' || S.account.meta === 'unresolved') && S.lastValid) return S.lastValid;
    return S.account;
  }
  // The flag read, bounded by a deadline (P1-5): a slow/hung read resolves false (disabled) rather than retaining
  // the previous enabled state; a late real value loses the race and is ignored.
  function readFlagBounded() {
    const ms = env.flagDeadlineMs || FLAG_READ_DEADLINE_MS;
    return Promise.race([
      Promise.resolve().then(() => env.readFlag()).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), ms)),
    ]);
  }
  // PURE decision — render() calls this synchronously. Returns an action descriptor; never a side effect.
  //   action: 'legacy' (today's render; `suspended` overlays the inline notice) | 'deactivate' | 'activated'
  //           | 'show' with view ∈ 'onboarding'|'waiting'|'submitting'|'neutral-hold'
  function decide() {
    if (S.flag !== true) return { action: 'legacy', suspended: false };          // inert ⇒ byte-identical
    const acct = effective();
    const d = companionDecision(true, acct);
    // Terminal account states win outright (a fresh read supersedes any submit barrier).
    if (d === 'deactivated') return { action: 'deactivate', suspended: false };
    if (d === 'suspended') return { action: 'legacy', suspended: true };
    if (d === 'app') return isApprovalTransition(S.prevValid, acct) ? { action: 'activated', suspended: false } : { action: 'legacy', suspended: false };
    if (d === 'waiting') return { action: 'show', view: 'waiting', suspended: false };     // profile_submitted
    if (d === 'neutral-hold') return { action: 'show', view: 'neutral-hold', suspended: false };
    // Here d is 'onboarding' (pending) or 'legacy' (unresolved/error with no last-valid). A submission barrier
    // (P1-7) persists across ordinary renders so a subscription update or a transient read error can't drop an
    // acknowledged submission back to the checklist without a fresh confirming read.
    if (S.submitState === 'submitting') return { action: 'show', view: 'submitting', suspended: false };
    if (S.submitState === 'waiting' || S.submitState === 'recoverable-wait') return { action: 'show', view: 'waiting', suspended: false };
    if (d === 'onboarding') return { action: 'show', view: 'onboarding', suspended: false };   // null or 'retry' → allow (re)submit
    return { action: 'legacy', suspended: false };
  }
  async function refresh() {
    if (!env.getUid()) return;
    const tag = S.tag, seq = ++S.seq;
    if (env.bootSettled) { try { await env.bootSettled(); } catch (_) { /* boot failed — still proceed */ } }   // P1-1
    if (S.tag !== tag || S.seq !== seq) return;                 // NEW-3: discard stale/superseded
    let flag = false;
    try { flag = await readFlagBounded(); } catch (_) { flag = false; }
    if (S.tag !== tag || S.seq !== seq) return;                 // NEW-3
    if (flag !== true) { S.flag = false; S.submitState = null; env.rerender(); return; }   // flag off ⇒ legacy; no pending companion action survives (P1-5)
    let meta = 'error', cls = null;
    try { cls = classifyAccount(await env.readAccount(env.getUid())); meta = cls.meta; } catch (_) { meta = 'error'; }
    if (S.tag !== tag || S.seq !== seq) return;                 // NEW-3
    S.flag = true;
    if (meta === 'valid') {
      if (S.lastValid) S.prevValid = S.lastValid;
      S.lastValid = cls; S.account = cls;
      if (cls.state !== 'pending') { S.submitState = null; if (env.clearDraft) env.clearDraft(); }   // the real transition supersedes the submit barrier
    } else { S.account = { meta }; }
    env.rerender();
  }
  // Single-shot teardown + sign-out (no DOM). Session- AND flag-guarded (P1-2/P1-5): a stale teardown after B
  // logs in, or a flag that flipped off mid-teardown, must NEVER sign out.
  async function triggerDeactivate() {
    if (S.tornDown || S.flag !== true) return;
    const tag = S.tag;
    S.tornDown = true; S.deactReason = true;
    try { await env.localTeardown(); } catch (_) { /* best-effort, non-blocking */ }
    if (S.tag !== tag || S.flag !== true) return;   // B logged in OR flag off during teardown → do NOT sign out
    try { await env.signOut(); } catch (_) { /* onLogout() still routes to E2 via deactReason */ }
  }
  function onWriteDenied(err) {
    if (S.flag !== true) return undefined;
    const c = String((err && (err.code || err.message)) || '');
    if (/permission_denied|permission-denied/i.test(c)) return refresh();   // one-shot re-read; E2 only if it confirms
    return undefined;
  }
  // Returns the reconciled outcome ('deactivated'|'reauth'|'field-error'|'retry'|'waiting'|'app'|'recoverable-wait'
  // |'flag-off'|undefined if superseded). The barrier/waiting eligibility is held in S.submitState (P1-7); the
  // confirming read participates in S.seq so it shares ONE ordering with refresh (P1-6).
  async function submit(fields) {
    if (S.submitInFlight) return undefined;
    S.submitInFlight = true; S.submitState = 'submitting';
    const tag = S.tag, seq = ++S.seq;
    env.rerender();                                   // show "Enviando…" immediately (via decide → 'submitting')
    let ok = false, errorCode = null, errorMessage = null;
    try { const res = await env.submit(fields); ok = !!(res && res.ok); }
    catch (e) { errorCode = (e && e.code) || ''; errorMessage = (e && e.message) || ''; }
    if (S.tag !== tag) return undefined;                                   // new session — do NOT touch current state (P1-2)
    if (S.seq !== seq) { S.submitState = null; return undefined; }         // superseded by a refresh (same session) — drop
    if (ok) { S.submitState = 'waiting'; env.rerender(); }                 // acknowledge success IMMEDIATELY (P1-7), before the read
    let freshMeta = 'error', freshRec = null;
    try { const c = classifyAccount(await env.readAccount(env.getUid())); freshMeta = c.meta; freshRec = c; } catch (_) { freshMeta = 'error'; }
    if (S.tag !== tag) return undefined;                                   // new session (P1-2)
    if (S.seq !== seq) { S.submitState = null; return undefined; }         // superseded
    S.submitInFlight = false;
    if (freshMeta === 'valid') { if (S.lastValid) S.prevValid = S.lastValid; S.lastValid = freshRec; S.account = freshRec; if (freshRec.state !== 'pending' && env.clearDraft) env.clearDraft(); }
    const outcome = reconcileAfterSubmit({ ok, errorCode, errorMessage, freshMeta, freshRec });
    if (S.flag !== true) { S.submitState = null; env.rerender(); return 'flag-off'; }   // flag flipped off mid-submit → never act under flag-off (P1-5)
    if (outcome === 'deactivated') { S.submitState = null; await triggerDeactivate(); env.rerender(); return 'deactivated'; }
    if (outcome === 'waiting') S.submitState = 'waiting';
    else if (outcome === 'recoverable-wait') S.submitState = 'recoverable-wait';
    else if (outcome === 'retry') S.submitState = 'retry';                 // decide() → onboarding, allowing resubmit
    else S.submitState = null;                                            // 'app' / 'reauth' / 'field-error' — barrier cleared; host handles reauth/field
    env.rerender();
    return outcome;
  }
  function onLogout() { return S.deactReason === true; }   // host shows E2 if true, else login
  function clearDeactReason() { S.deactReason = false; }
  // After the "Activado" transient is shown, advance prevValid so decide() stops returning 'activated'
  // (the transition is observed exactly once; the next render routes to the normal app).
  function consumeApprovalTransition() { S.prevValid = S.lastValid; }

  return { resetSession, refresh, submit, onWriteDenied, onLogout, clearDeactReason, triggerDeactivate, consumeApprovalTransition, decide, _state: S };
}

export {
  KNOWN_STATES,
  classifyAccount,
  companionDecision,
  isApprovalTransition,
  reconcileAfterSubmit,
  isDeactivatedDenial,
  sessionCurrent,
  isLatestRefresh,
  makeCompanionController,
};
