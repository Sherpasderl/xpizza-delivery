'use strict';
// ── signup-endpoints — the HTTP surface of customer signup phase 1 (PLAN-signup-email-social r3 + BC1–BC3) ──
//
// index.js only wraps these handlers in onRequest (CORS = ACCOUNT_ORIGINS) and calls the three hooks below from the existing
// endpoints; every decision lives in signup-core.js. Dependencies are injected (db, auth, restaurant registry, rate limiter,
// env, Google verifier) so the emulator suites drive the real handlers.
//
//   googleStart      POST {restaurant_id, session_id}              → {ok, nonce} | {ok:false, reason}
//   googleSignIn     POST {restaurant_id, session_id, id_token}    → {ok, linked:true, token, name} | {ok, linked:false, ticket, email, name}
//   completeProfile  POST {restaurant_id, email, accept_terms, promos}  (customer ID token) → {ok} | {ok:false, reason}
//   setPromos        POST {restaurant_id, value}                         (customer ID token) → {ok} | {ok:false, reason}
//                    platform: POST {context:'platform', value}          (customer ID token) → {ok, value} (the stored value) | {ok:false, reason}
//   getSignupConfig  GET  ?restaurant_id=                           → {terms_url, privacy_url, legal_ready, google_enabled, email_login_enabled}
// PLAN-guest-checkout-server S3a: every endpoint above takes EITHER restaurant_id (the forms, byte-identical) OR context:'platform'
// (the customer app → consent/_platform, platform_config/legal, GOOGLE_OAUTH_AUDIENCES__PLATFORM); both / neither → 400.
// ADDITIVE for the platform only: googleSignIn linked → + completion, profile; completeProfile accepts + name (both scopes).
// Hooks (index.js): bindOtpTicket (requestOtp, only with a link_ticket), redeemOtpTicket (verifyOtp, only with a link_ticket),
// refreshActivity (verifyOtp, BC3 — bounded, fail-open), deleteAccountCore (deleteAccount + the inactivity sweep), pruneDeadLinks.
const crypto = require('crypto');
const S = require('./signup-core');

const SIGNUP_RATE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 30 });   // per IP, per endpoint family — like requestOtp's soft cap
const ACTIVITY_DEADLINE_MS = 1500;   // BC3: the phone-login activity refresh never delays the login past this

// The OTP challenge id: derived from THIS code's server record (code_hash + expires_at — unique per issued code), so no new
// field is written to the otp node and a later code (a new record) is a different challenge.
const challengeIdOf = (otp) => (otp && typeof otp.code_hash === 'string' && otp.code_hash ? S.sha256(`${otp.code_hash}:${otp.expires_at}`) : null);

function makeSignup({ getDatabase, getAuth, resolveRid, checkRateLimit, env = process.env, oauthClient = null, now = () => Date.now() }) {
  const signupRidOf = (raw) => { const r = resolveRid(raw); return r && !r.error && !r.defaulted && r.restaurantId ? r.restaurantId : null; };   // a KNOWN rid, explicitly sent — never a default brand
  // PLAN-guest-checkout-server S3a: EITHER a known restaurant_id (the forms — today's exact path, the key `context` absent) OR
  // context:'platform' (the customer app) — never both, never neither. → the scope (a rid or '_platform') | null (bad_request)
  const scopeOf = (o) => {
    const src = o || {};
    if (!Object.prototype.hasOwnProperty.call(src, 'context')) return signupRidOf(src.restaurant_id);   // the forms: today's exact path
    // Codex S3 r1 P2: EXACTLY one selector — the restaurant_id KEY at all (null included) refuses a platform request
    return src.context === 'platform' && !Object.prototype.hasOwnProperty.call(src, 'restaurant_id') ? S.PLATFORM_SCOPE : null;
  };
  const isPlatform = (scope) => scope === S.PLATFORM_SCOPE;
  const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const limited = async (db, family, req, res) => {
    const { allowed, retryAfterSec } = await checkRateLimit(db, `signup_${family}`, ipOf(req), SIGNUP_RATE);
    if (allowed) return false;
    res.set('Retry-After', String(retryAfterSec)); res.status(429).json({ ok: false, reason: 'rate_limited' }); return true;
  };
  let client = oauthClient;
  const verifierFor = (rid) => {
    const audiences = S.audiencesFor(rid, env);
    if (!client) { const { OAuth2Client } = require('google-auth-library'); client = new OAuth2Client(); }
    return (idToken) => S.verifyGoogleIdToken(idToken, { audiences, client });
  };
  // the caller's own customer uid from its Firebase ID token (never a client-supplied uid); a tombstoned uid is refused
  const customerOf = async (req, db) => {
    const t = req.get('x-firebase-id-token'); if (!t) return null;
    try {
      const dec = await getAuth().verifyIdToken(t);
      if (!dec || dec.customer !== true || typeof dec.uid !== 'string') return null;
      if ((await db.ref(`deleted_uids/${dec.uid}`).once('value')).exists()) return null;
      return dec.uid;
    } catch (_) { return null; }
  };

  const googleStart = async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {}; const db = getDatabase(); const rid = scopeOf(b);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'google', req, res)) return;
      if (!S.audiencesFor(rid, env)) return res.status(200).json({ ok: false, reason: 'google_unconfigured' });
      const r = await S.startGoogle(db, { rid, sessionId: b.session_id, now: now() });
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { console.error('googleStart', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const googleSignIn = async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {}; const db = getDatabase(); const rid = scopeOf(b);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'google', req, res)) return;
      if (!S.audiencesFor(rid, env)) return res.status(200).json({ ok: false, reason: 'google_unconfigured' });
      const r = await S.googleSignIn(db, { idToken: b.id_token, sessionId: b.session_id, rid, now: now(), verify: verifierFor(rid) });
      if (!r.ok) return res.status(200).json({ ok: false, reason: r.reason });
      if (r.linked) {
        const token = await getAuth().createCustomToken(r.uid, { customer: true });   // the SAME claim as verifyOtp's
        const name = (await db.ref(`user_profiles/${r.uid}/name`).once('value')).val() || null;
        if (isPlatform(rid)) {   // S3a ADDITIVE (the app only; the forms' answer is byte-identical): no RTDB read needed after sign-in
          const [completion, profile] = await Promise.all([S.completionState(db, r.uid, rid, env), S.profileOf(db, r.uid, rid)]);
          return res.status(200).json({ ok: true, linked: true, token, name, completion, profile });
        }
        return res.status(200).json({ ok: true, linked: true, token, name });
      }
      return res.status(200).json({ ok: true, linked: false, ticket: r.ticket, email: r.email, name: r.name });
    } catch (e) { console.error('googleSignIn', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const completeProfile = async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {}; const db = getDatabase(); const rid = scopeOf(b);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'profile', req, res)) return;   // codex build r1 P2-9: like the other account endpoints
      const uid = await customerOf(req, db); if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      // S3a ADDITIVE `name` (1..80, trimmed): written server-side so the app needs no Database SDK; the forms never send it
      const nm = b.name === undefined ? undefined : (typeof b.name === 'string' ? b.name.trim() : '');
      if (nm !== undefined && !(nm.length >= 1 && nm.length <= 80)) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const r = await S.completeProfile(db, { uid, rid, email: b.email, acceptTerms: b.accept_terms, promos: b.promos, now: now() });
      if (r.ok && nm !== undefined) await db.ref(`user_profiles/${uid}/name`).set(nm);
      return res.status(r.ok ? 200 : (r.reason === 'deleted' ? 403 : 400)).json(r);
    } catch (e) { console.error('completeProfile', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const setPromos = async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {}; const db = getDatabase(); const rid = scopeOf(b);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'profile', req, res)) return;
      const uid = await customerOf(req, db); if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      // the platform (the app's member Cuenta): + `value`, the stored choice read back from the committed record; the forms: unchanged
      const r = isPlatform(rid) ? await S.setPromos(db, { uid, rid, value: b.value, now: now(), confirm: true }) : await S.setPromos(db, { uid, rid, value: b.value, now: now() });
      return res.status(r.ok ? 200 : (r.reason === 'deleted' ? 403 : 400)).json(r);
    } catch (e) { console.error('setPromos', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const getSignupConfig = async (req, res) => {
    try {
      if (req.method !== 'GET') return res.status(405).json({ ok: false });
      const rid = scopeOf(req.query);
      if (!rid) { res.set('Cache-Control', 'no-store'); return res.status(400).json({ ok: false, reason: 'bad_request' }); }
      const cfg = await S.signupConfig(getDatabase(), rid, env);
      res.set('Cache-Control', 'public, max-age=60');
      return res.status(200).json({ ok: true, ...cfg });
    } catch (e) { console.error('getSignupConfig', e && e.message); res.set('Cache-Control', 'no-store'); return res.status(500).json({ ok: false }); }
  };

  return { googleStart, googleSignIn, completeProfile, setPromos, getSignupConfig };
}

// ── hooks called from the existing endpoints ──
// requestOtp, ONLY when the body carries a link_ticket: bind it to this phone + this code's challenge. Never changes the
// uniform response; any failure leaves the ticket unbound (verifyOtp then logs in by phone with no link).
async function bindOtpTicket(db, { body, restaurantId, phoneHash, otpRecord, now }) {
  try {
    const t = body && body.link_ticket;
    if (typeof t !== 'string' || !S.SIGNUP.ID_RE.test(t)) return false;
    const challengeId = challengeIdOf(otpRecord);
    if (!challengeId) return false;
    return await S.bindTicket(db, { ticketId: t, sessionId: body.session_id, rid: restaurantId, phoneHash, challengeId, now });
  } catch (e) { console.warn('requestOtp: link ticket bind failed —', e && e.message); return false; }
}
// verifyOtp, ONLY when the body carries a link_ticket, AFTER the code was consumed and the uid resolved: redeem the ticket
// (bound to this phone + this exact code + session + brand) and link. Returns the response's `link` value; a failure after
// consumption leaves the ticket consumed (a fresh Google attempt is needed — no repair path).
async function redeemOtpTicket(db, { body, uid, phoneHash, rid, consumedOtp, now }) {
  try {
    const t = body && body.link_ticket;
    if (typeof t !== 'string' || !S.SIGNUP.ID_RE.test(t)) return 'invalid';
    const got = await S.redeemTicket(db, { ticketId: t, sessionId: body.session_id, rid, phoneHash, challengeId: challengeIdOf(consumedOtp), uid, now });
    if (!got) return 'invalid';
    const { link } = await S.linkIdentity(db, { kind: got.kind, key: got.key, uid, now });
    if ((link === 'linked' || link === 'noop') && got.email) await S.noteProviderEmail(db, uid, got.email, got.kind);
    return link;
  } catch (e) { console.warn('verifyOtp: link failed —', e && e.message); return 'invalid'; }
}
// BC3: the phone login's activity refresh — the aborting transaction, bounded, fail-open (never errors or delays the login)
async function refreshActivity(db, uid, nowMs, deadlineMs = ACTIVITY_DEADLINE_MS) {
  let timer;
  try {
    await Promise.race([S.touchActivity(db, uid, nowMs).catch(() => false), new Promise((r) => { timer = setTimeout(r, deadlineMs); })]);
  } catch (_) { /* fail-open */ } finally { clearTimeout(timer); }
}
// ONE deletion core (deleteAccount AND the inactivity sweep) — security backlog r2 (Codex r1 P1-b/P1-c, advisor rulings):
//   the sweep first CLAIMS the account on user_profiles/{uid} (S.sweepClaim — linearized with every login's gate; a fresher login
//   ⇒ abort, nothing written); then ONE multi-path update writes BOTH tombstones (user_private/{uid} = {deleted_at}, BC2 — the node
//   REPLACED, so every Admin txn on it still aborts — and deleted_uids/{uid}, the ONE tombstone every server check reads) TOGETHER
//   with today's removals: no window with one tombstone and not the other, nor a removed profile without a tombstone. A retry keeps
//   the FIRST deletion instant. phone_index is removed by a CAS (only while it still names this uid — a login may have repointed it
//   to a fresh uid). Then the auth_links rows, then the refresh tokens revoked — best-effort, deadline-bounded, FAIL-OPEN (the
//   deletion is complete), a failure LOGGED + ALERTED with an allowlisted reason. An already-minted ID token stays valid ≤ 1 h: the
//   tombstones remain the hard guard. Returns false when the sweep lost to a fresher login (nothing written, nothing revoked).
const REVOKE_DEADLINE_MS = 1500;
const defaultRevoke = (uid) => require('firebase-admin/auth').getAuth().revokeRefreshTokens(uid);
async function deleteAccountCore(db, ACCOUNT, { uid, phoneHash, now, sweepCutoff = null, revoke = defaultRevoke, revokeDeadlineMs = REVOKE_DEADLINE_MS }) {
  if (sweepCutoff != null) {
    const la = (await db.ref(`user_private/${uid}/last_active`).once('value')).val();
    if (typeof la === 'number' && la >= sweepCutoff) return false;   // a recent (pre-gate, Google-era) activity still spares it
    if ((await S.sweepClaim(db, uid, sweepCutoff, now)) !== 'claimed') return false;
  }
  await redactRatings(db, uid);   // S-A1: BEFORE the removals (user_orders names the account's orders); idempotent on a retry
  const prior = (await db.ref(`user_private/${uid}/deleted_at`).once('value')).val();
  const at = typeof prior === 'number' ? prior : now;
  await db.ref().update({ ...ACCOUNT.accountDeleteUpdates(uid, null, at), [`user_private/${uid}`]: { deleted_at: at } });
  if (phoneHash) await db.ref(`phone_index/${phoneHash}`).transaction((cur) => (cur === null ? null : (cur === uid ? null : undefined)));
  await S.removeLinks(db, uid);
  await revokeSessions(db, uid, now, revoke, revokeDeadlineMs);
  return true;
}
// S-A1 (PLAN §S-A (d)): account deletion REDACTS the account's ratings IN PLACE — ratings_v2/{orderId} for every order in its own
// history gets state=deleted (terminal) with comment + owner_uid nulled, ONE transaction per node, so the vote leaves every aggregate
// and the node remains only as the deletion fence. Runs before the history is removed; re-running is a no-op (already deleted).
async function redactRatings(db, uid) {
  const ids = Object.keys((await db.ref(`user_orders/${uid}`).once('value')).val() || {});
  const V2 = require('./ratings/rating-v2');
  for (const id of ids) {
    if (!V2.ORDER_ID_RE.test(id)) continue;
    await db.ref(`ratings_v2/${id}`).transaction(V2.deletionUpdater({}));
  }
  return ids.length;
}
// the persisted / logged reason is an ALLOWLISTED code — never an error message (it can carry PII)
const REVOKE_REASON_CODES = new Set(['auth/user-not-found', 'auth/internal-error', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/insufficient-permission', 'app/network-error']);
const reasonOf = (e) => (e && typeof e === 'object' ? (REVOKE_REASON_CODES.has(e.code) ? e.code : 'revoke_failed') : 'unknown');
const withDeadline = (p, ms) => { let t = null; return Promise.race([Promise.resolve(p).then(() => 'ok'), new Promise((res) => { t = setTimeout(() => res('timeout'), ms); })]).finally(() => clearTimeout(t)); };
async function revokeSessions(db, uid, now, revoke, deadlineMs) {
  let reason = null;
  try { if ((await withDeadline(Promise.resolve().then(() => revoke(uid)), deadlineMs)) !== 'ok') reason = 'timeout'; } catch (e) { reason = reasonOf(e); }
  if (reason == null) return true;
  console.error(`deleteAccountCore: revokeRefreshTokens FAILED for ${uid} (${reason}) — deletion complete; tombstones guard until the ID token expires`);
  try {   // create-only (a retry never rewrites the first alert), and bounded too: a hanging alert write never blocks the deletion
    const w = await withDeadline(db.ref(`dispatcher_alerts/account_revoke_failed_${uid}`).transaction((cur) => (cur == null ? { type: 'account_revoke_failed', uid, reason, created_at: now } : undefined)), deadlineMs);
    if (w !== 'ok') console.error(`deleteAccountCore: the revoke-failure alert write for ${uid}: timeout (${deadlineMs}ms) — the log line above stands`);
  } catch (e) { console.error(`deleteAccountCore: the revoke-failure alert for ${uid} failed (${reasonOf(e)})`); }
  return false;
}
// Codex r2 P2: the phone's uid CLAIM, create-if-absent in ONE transaction (the same contract as signup-platform's claimUid) —
// a concurrent first login on another path converges on the winner's uid; an existing entry is adopted, never overwritten.
// A fresh uid is drawn ONLY to create (slot 69b045de, the signup-http forms differential): a returning login reads its entry and
// draws nothing, as the base did (it drew only in `if (!uid)`), so the forms' uid stream is byte-identical. The draw is memoized:
// the Admin SDK runs the updater first on an uncached null, so a merely-lazy draw would still consume one for an existing entry.
// (signup-platform's claimUid draws eagerly: a new path, no byte-identity duty — advisor 2026-11-01.)
async function claimPhoneUid(db, pHash, newUid) {
  const ref = db.ref(`phone_index/${pHash}`);
  const seen = (await ref.get()).val();
  if (typeof seen === 'string' && seen) return seen;
  let cand = null;
  const tx = await ref.transaction((cur) => (typeof cur === 'string' && cur ? undefined : (cand = cand || newUid())));
  const uid = tx.committed ? cand : tx.snapshot.val();
  if (typeof uid !== 'string' || !uid) throw new Error('claimPhoneUid: phone_index unreadable');
  return uid;
}
// THE login uid (security backlog r2, Codex r1 P1-a, advisor ruling 2), for every phone login path (forms verifyOtp, platform
// verifyOtp, redeemSignupGrant): the uid phone_index names is used ONLY if it is live — the gate (S.loginTouch) bumps last_login on
// a live profile; a profile a sweep CLAIMED, or a TOMBSTONED uid with NO profile, is never handed to a login: a FRESH uid is
// minted and phone_index CAS-repointed (only while it still names the dead uid — concurrent logins converge on one fresh uid).
// A REVIVED account (profile present, no claim — a stale tombstone; the owner migration repairs it) is LIVE: it keeps its uid.
// An untombstoned uid with no profile (a brand-new uid) passes through: the caller creates the profile, as today.
// FAIL-CLOSED: an infra failure propagates — the caller answers its generic retryable error and mints nothing.
async function loginUid(db, { pHash, uid, now, newUid }) {
  let cur = uid;
  for (let i = 0; i < 4; i += 1) {
    const g = await S.loginTouch(db, cur, now);
    if (g === 'live') return cur;
    if (g === 'absent' && !(await S.isTombstoned(db, cur))) return cur;
    const cand = newUid();
    const tx = await db.ref(`phone_index/${pHash}`).transaction((v) => (v === null || v === cur ? cand : undefined));
    cur = tx.committed ? cand : tx.snapshot.val();
    if (typeof cur !== 'string' || !cur) throw new Error('loginUid: phone_index unreadable');
  }
  throw new Error('loginUid: no live uid after bounded retries');
}
// the periodic sweep's residual cleanup, run EVERY time (codex build r1 P2-10 — also when no profiles remain): links to
// deleted accounts, expired challenges / tickets
async function pruneResidual(db, now = Date.now()) {
  return { deadLinks: await pruneDeadLinks(db), expired: await S.pruneExpired(db, now), tombstones: await backfillDeletedUids(db) };
}
// security backlog 2026-11-01: an account tombstoned in user_private BEFORE the sweep wrote deleted_uids gets it now (its OWN
// deleted_at), create-if-absent — so every deleted_uids-only check refuses it too. Live / revived accounts are never touched.
async function backfillDeletedUids(db) {
  const rows = (await db.ref('user_private').orderByChild('deleted_at').startAt(0).once('value')).val() || {};
  let added = 0;
  for (const [uid, row] of Object.entries(rows)) {
    if (!row || typeof row.deleted_at !== 'number') continue;
    // r2 (Codex P1-a): ONLY a uid with NO profile — a profile present is a LIVE (revived) account carrying a stale tombstone (the
    // owner migration repairs it). No re-read needed: every login path refuses a tombstoned uid with no profile (loginUid), the
    // client-writable profile rule denies on either tombstone, and nothing else creates a profile at an existing uid.
    if ((await db.ref(`user_profiles/${uid}`).once('value')).exists()) continue;
    let wrote = false;
    await db.ref(`deleted_uids/${uid}`).transaction((cur) => { wrote = false; if (cur != null) return undefined; wrote = true; return row.deleted_at; });
    if (wrote) added += 1;
  }
  return added;
}
// a link that raced a deletion points at a tombstoned uid — inert at login, removed here
async function pruneDeadLinks(db) {
  let removed = 0;
  for (const kind of ['google', 'email']) {
    const rows = (await db.ref(`auth_links/${kind}`).once('value')).val() || {};
    for (const [key, row] of Object.entries(rows)) {
      if (!row || typeof row.uid !== 'string') continue;
      if (!(await db.ref(`user_private/${row.uid}/deleted_at`).once('value')).exists()) continue;
      let hit = false;
      await db.ref(`auth_links/${kind}/${key}`).transaction((cur) => { hit = false; if (cur === null) return null; if (cur.uid !== row.uid) return; hit = true; return null; });
      if (hit) removed += 1;
    }
  }
  return removed;
}

module.exports = { redactRatings, makeSignup, bindOtpTicket, redeemOtpTicket, refreshActivity, deleteAccountCore, revokeSessions, claimPhoneUid, loginUid, backfillDeletedUids, REVOKE_DEADLINE_MS, REVOKE_REASON_CODES, pruneDeadLinks, pruneResidual, challengeIdOf, SIGNUP_RATE, ACTIVITY_DEADLINE_MS };
