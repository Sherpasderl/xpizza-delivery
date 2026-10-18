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
//   getSignupConfig  GET  ?restaurant_id=                           → {terms_url, privacy_url, legal_ready, google_enabled, email_login_enabled}
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
      const b = req.body || {}; const db = getDatabase(); const rid = signupRidOf(b.restaurant_id);
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
      const b = req.body || {}; const db = getDatabase(); const rid = signupRidOf(b.restaurant_id);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'google', req, res)) return;
      if (!S.audiencesFor(rid, env)) return res.status(200).json({ ok: false, reason: 'google_unconfigured' });
      const r = await S.googleSignIn(db, { idToken: b.id_token, sessionId: b.session_id, rid, now: now(), verify: verifierFor(rid) });
      if (!r.ok) return res.status(200).json({ ok: false, reason: r.reason });
      if (r.linked) {
        const token = await getAuth().createCustomToken(r.uid, { customer: true });   // the SAME claim as verifyOtp's
        const name = (await db.ref(`user_profiles/${r.uid}/name`).once('value')).val() || null;
        return res.status(200).json({ ok: true, linked: true, token, name });
      }
      return res.status(200).json({ ok: true, linked: false, ticket: r.ticket, email: r.email, name: r.name });
    } catch (e) { console.error('googleSignIn', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const completeProfile = async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {}; const db = getDatabase(); const rid = signupRidOf(b.restaurant_id);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'profile', req, res)) return;   // codex build r1 P2-9: like the other account endpoints
      const uid = await customerOf(req, db); if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      const r = await S.completeProfile(db, { uid, rid, email: b.email, acceptTerms: b.accept_terms, promos: b.promos, now: now() });
      return res.status(r.ok ? 200 : (r.reason === 'deleted' ? 403 : 400)).json(r);
    } catch (e) { console.error('completeProfile', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const setPromos = async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {}; const db = getDatabase(); const rid = signupRidOf(b.restaurant_id);
      if (!rid) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (await limited(db, 'profile', req, res)) return;
      const uid = await customerOf(req, db); if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      const r = await S.setPromos(db, { uid, rid, value: b.value, now: now() });
      return res.status(r.ok ? 200 : (r.reason === 'deleted' ? 403 : 400)).json(r);
    } catch (e) { console.error('setPromos', e && e.message); return res.status(500).json({ ok: false }); }
  };

  const getSignupConfig = async (req, res) => {
    try {
      if (req.method !== 'GET') return res.status(405).json({ ok: false });
      const rid = signupRidOf(req.query && req.query.restaurant_id);
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
// ONE deletion core (deleteAccount AND the inactivity sweep): (i) the BC2 tombstone FIRST (the sweep's commits only while
// last_active is still older than its cutoff); (ii) today's removals, unchanged (account-lib); (iii) every auth_links row by uid.
// Returns false when the sweep's stale decision lost to a fresher login (nothing removed).
async function deleteAccountCore(db, ACCOUNT, { uid, phoneHash, now, sweepCutoff = null }) {
  const stands = await S.tombstone(db, uid, { now, staleBefore: sweepCutoff });
  if (!stands) return false;
  await db.ref().update(sweepCutoff == null ? ACCOUNT.accountDeleteUpdates(uid, phoneHash, now) : ACCOUNT.accountDeleteUpdates(uid, phoneHash));
  await S.removeLinks(db, uid);
  return true;
}
// the periodic sweep's residual cleanup, run EVERY time (codex build r1 P2-10 — also when no profiles remain): links to
// deleted accounts, expired challenges / tickets
async function pruneResidual(db, now = Date.now()) {
  return { deadLinks: await pruneDeadLinks(db), expired: await S.pruneExpired(db, now) };
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

module.exports = { makeSignup, bindOtpTicket, redeemOtpTicket, refreshActivity, deleteAccountCore, pruneDeadLinks, pruneResidual, challengeIdOf, SIGNUP_RATE, ACTIVITY_DEADLINE_MS };
