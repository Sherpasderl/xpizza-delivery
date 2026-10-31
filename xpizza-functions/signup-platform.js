'use strict';
// ── PLAN-guest-checkout-server r4 (FINAL) §3 — the customer APP's signup family, `context:'platform'`
// (CONTRACT-capp-signup-platform-wire.md). The forms' wire is byte-identical: they never send `context`, so index.js's
// requestOtp / verifyOtp take today's path; only a body carrying `context` reaches the two OTP handlers here.
//   requestOtp  (S3a)  POST {phone(E.164), context:'platform', link_ticket?, session_id?} → always 200 {ok, cooldown:30} (uniform)
//                      | 400 {ok:false, reason:'bad_request'} (a scope other than exactly the platform)
//   verifyOtp   (S3a)  POST {phone, code, context:'platform', link_ticket?, session_id?}
//                      → 200 {ok, token, is_new, name, completion, profile, link?} | 200 {ok:false, reason, retry_in_s?}
//   redeemSignupGrant (S3b, NEW) POST {grant, context:'platform', email, name, accept_terms:true, promos} (no auth header)
//                      → 200 {ok, token, is_new, name, completion:'complete'} | 400 grant_invalid / bad_request / bad_email /
//                        legal_unconfigured | 403 deleted | 429 rate_limited | 500
//   getMyProfile (S3d, NEW) GET ?context=platform + x-firebase-id-token
//                      → 200 {ok, name, email, phone, phone_last4, consent:{terms, terms_version, promos}, completion, promos?}
//                      | 400 bad_request | 401 unauthenticated | 403 deleted | 429 | 500
// The platform scope: challenge `scope:'_platform'` written INSIDE the issuing transaction and checked INSIDE verifyConsume;
// consent/_platform; platform_config/legal; the PLATFORM sender (ULTRAMSG_*_PLATFORM + SIGNUP_OTP_TEMPLATE_PLATFORM, never a
// literal); NO signup-time welcome credit. Dependencies injected so the emulator suites drive the real handlers.
const crypto = require('crypto');
const S = require('./signup-core');
const SE = require('./signup-endpoints');
const G = require('./checkout-guest-lib');
const { parseE164 } = require('./phone-countries');

const P = S.PLATFORM_SCOPE;
const NAME_MAX = 80;
// Codex S3 r1 P2: EXACTLY one selector — a platform request carrying the restaurant_id KEY at all (null included) is refused
const isPlatformBody = (b) => !!b && b.context === 'platform' && !Object.prototype.hasOwnProperty.call(b, 'restaurant_id');
const newUid = () => 'u_' + crypto.randomBytes(12).toString('hex');
const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

// deps: { getDatabase, getAuth, checkRateLimit, env?, now?, fetchImpl?, grantSecret: () => string, sendPlatformOtp, senderConfigured, isSendConfirmed }
function makeSignupPlatform(deps) {
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const limited = async (db, req, res) => {   // the SHARED signup_profile IP family (completeProfile / setPromos)
    const { allowed, retryAfterSec } = await deps.checkRateLimit(db, 'signup_profile', ipOf(req), SE.SIGNUP_RATE);
    if (allowed) return false;
    res.set('Retry-After', String(retryAfterSec)); res.status(429).json({ ok: false, reason: 'rate_limited' }); return true;
  };
  // the phone account, found or created ATOMICALLY (two concurrent sign-ins of a new phone get the SAME uid)
  const claimUid = async (db, phoneHash) => {
    const cand = newUid();
    const tx = await db.ref(`phone_index/${phoneHash}`).transaction((cur) => (typeof cur === 'string' && cur ? undefined : cand));
    return tx.committed ? cand : tx.snapshot.val();
  };
  const isDeleted = async (db, uid) => {
    const [gone, priv] = await Promise.all([db.ref(`deleted_uids/${uid}`).once('value'), db.ref(`user_private/${uid}/deleted_at`).once('value')]);
    return gone.exists() || priv.exists();
  };
  // Codex S3 r1 P2: the profile, CREATE-IF-ABSENT in one transaction (never overwrites a profile a concurrent sign-in / grant made).
  // → { created, prof } from the FINAL run (the SDK's uncached first run sees null; the server re-runs it with the real value)
  const ensureProfile = async (db, uid, fresh, now) => {
    let created = false;
    const tx = await db.ref(`user_profiles/${uid}`).transaction((cur) => {
      created = cur === null;
      return cur === null ? fresh : { ...cur, last_login: now };
    });
    return { created, prof: tx.snapshot.val() };
  };
  // undo ONLY the profile THIS call created (same created_at + phone_hash) — after a deletion raced it
  const undoCreatedProfile = async (db, uid, fresh) => {
    await db.ref(`user_profiles/${uid}`).transaction((cur) => (cur === null ? null
      : (cur.created_at === fresh.created_at && cur.phone_hash === fresh.phone_hash ? null : undefined)));
  };

  // ── S3a requestOtp ──
  async function requestOtp(req, res, OTP) {
    const uniform = () => res.status(200).json({ ok: true, cooldown: 30 });
    try {
      const b = req.body || {};
      if (!isPlatformBody(b)) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const p = parseE164(typeof b.phone === 'string' ? b.phone : '');
      const pHash = p ? OTP.phoneHash(p.e164) : null;
      if (!pHash) return uniform();   // uniform — no enumeration
      // the platform sender config BEFORE any reservation (the Codex S1 r1 P2-3 rule): never burn the shared IP allowance / the
      // per-phone window or replace a live code for a send that cannot happen
      if (!deps.senderConfigured(env, 'SIGNUP_OTP_TEMPLATE_PLATFORM')) { console.error('requestOtp(platform): platform sender unconfigured (ULTRAMSG_*_PLATFORM / SIGNUP_OTP_TEMPLATE_PLATFORM) — nothing reserved'); return uniform(); }
      const t = now();
      const db = deps.getDatabase();
      const ipHash = crypto.createHash('sha256').update(String(req.ip || '')).digest('hex');
      const ipTx = await db.ref('otp_ip/' + ipHash).transaction((v) => OTP.ipReserve(v, t));
      if (!ipTx.committed) return uniform();
      // the GLOBAL per-phone reservation; the scope is written IN THIS transaction (never a separate, fail-open write)
      let code = null;
      const tx = await db.ref('otp/' + pHash).transaction((v) => { const r = OTP.sendReserve(v, t); code = r.code; return r.next ? { ...r.next, scope: P } : r.next; });
      if (!tx.committed || !code) return uniform();
      try { await db.ref('otp/' + pHash + '/rid').set(P); } catch (_) {}   // the contract's stash value — never defaulted to a brand
      if (b.link_ticket != null) await SE.bindOtpTicket(db, { body: b, restaurantId: P, phoneHash: pHash, otpRecord: tx.snapshot.val(), now: t });
      await deps.sendPlatformOtp(OTP.normalizePhone(p.e164), code, { env, fetchImpl: deps.fetchImpl, isSendConfirmed: deps.isSendConfirmed, templateKey: 'SIGNUP_OTP_TEMPLATE_PLATFORM' });
      return uniform();
    } catch (e) {
      console.error('requestOtp(platform)', e && e.message);
      return uniform();
    }
  }

  // ── S3a verifyOtp ──
  async function verifyOtp(req, res, OTP) {
    const fail = (reason, extra) => res.status(200).json({ ok: false, reason, ...(extra || {}) });
    try {
      const b = req.body || {};
      if (!isPlatformBody(b)) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const p = parseE164(typeof b.phone === 'string' ? b.phone : '');
      const pHash = p ? OTP.phoneHash(p.e164) : null;
      if (!pHash || !/^\d{6}$/.test(String(b.code || ''))) return fail('code_wrong');
      const t = now();
      const db = deps.getDatabase();
      const otpRef = db.ref('otp/' + pHash);
      // ONE transaction verifies the scope, expiry, attempts and code AND consumes; the reason comes from the FINAL run
      let outcome = 'fail', reason = 'code_wrong', expiresAt = 0;
      const otpTx = await otpRef.transaction((v) => {
        const r = OTP.verifyConsume(v, t, String(b.code), P);
        outcome = r.outcome;
        expiresAt = v && v.expires_at;
        if (outcome === 'ok') reason = null;
        else if (!v || v.scope !== P) reason = 'code_wrong';                     // no live platform challenge (no oracle)
        else if (v.consumed || v.expires_at < t) reason = 'code_expired';
        else if ((v.attempts || 0) >= OTP.LIMITS.MAX_ATTEMPTS || (r.next && r.next.attempts >= OTP.LIMITS.MAX_ATTEMPTS)) reason = 'too_many_attempts';
        else reason = 'code_wrong';
        return r.next;
      });
      if (outcome !== 'ok') return reason === 'too_many_attempts' ? fail(reason, { retry_in_s: Math.max(1, Math.ceil(((expiresAt || t) - t) / 1000)) }) : fail(reason);
      const uid = await claimUid(db, pHash);
      const t2 = now();
      const { created, prof } = await ensureProfile(db, uid, { phone: OTP.normalizePhone(p.e164), phone_hash: pHash, created_at: t2, last_login: t2 }, t2);
      await otpRef.remove();   // one-time use
      const token = await deps.getAuth().createCustomToken(uid, { customer: true });   // mint ONLY after verified + consumed
      // NO signup-time welcome credit for the platform scope (plan §3.1)
      await SE.refreshActivity(db, uid, t2);
      const [completion, profile] = await Promise.all([S.completionState(db, uid, P, env), S.profileOf(db, uid, P)]);
      const out = { ok: true, token, is_new: created, name: (!created && prof && prof.name) || null, completion, profile };
      if (b.link_ticket != null) out.link = await SE.redeemOtpTicket(db, { body: b, uid, phoneHash: pHash, rid: P, consumedOtp: otpTx.snapshot.val(), now: t2 });
      return res.status(200).json(out);
    } catch (e) {
      console.error('verifyOtp(platform)', e && e.message);
      return res.status(200).json({ ok: false, reason: 'code_wrong' });
    }
  }

  // ── S3b redeemSignupGrant ──
  async function redeemSignupGrant(req, res) {
    const bad = (status, reason) => res.status(status).json({ ok: false, reason });
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok: false });
      const b = req.body || {};
      // 0. validate first, with NOTHING consumed
      if (!isPlatformBody(b) || typeof b.grant !== 'string' || b.accept_terms !== true || typeof b.promos !== 'boolean') return bad(400, 'bad_request');
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!(name.length >= 1 && name.length <= NAME_MAX)) return bad(400, 'bad_request');
      const email = S.normEmail(b.email);
      if (!S.validEmail(email)) return bad(400, 'bad_email');
      const db = deps.getDatabase();
      const legal = await S.legalFor(db, P);
      if (!legal) return bad(400, 'legal_unconfigured');
      if (await limited(db, req, res)) return;
      const t = now();
      const OTP = require('./otp-lib');
      const v = G.verifyGrant(b.grant, deps.grantSecret(), t);
      if (!v.ok) return bad(400, 'grant_invalid');
      const order = (await db.ref(`orders/${v.payload.order_id}`).once('value')).val();
      const gv = order && order.guest_verified;
      // the phone is re-derived from the ORDER: its stored phone hashes to the stored hash, which the grant names
      if (!gv || typeof gv.phone !== 'string' || gv.phone_hash !== v.payload.phone_hash || OTP.phoneHash(gv.phone) !== gv.phone_hash) return bad(400, 'grant_invalid');
      // 1. claim the uid (atomic, deterministic per phone)
      const uid = await claimUid(db, gv.phone_hash);
      if (await isDeleted(db, uid)) return bad(403, 'deleted');
      // 2. record the use (single-valued uid ↔ grant); a retry RESUMES with the stored inputs + legal versions
      const fresh = { uid, at: t, inputs: { email, name, promos: b.promos },
        legal: { terms_version: legal.terms_version, privacy_version: legal.privacy_version, promos_copy_version: legal.promos_copy_version } };
      // present ⇒ ABORT: never rewritten (the same uid resumes from the stored row; another uid is refused below)
      const used = await db.ref(`grants_used/${v.payload.order_id}`).transaction((cur) => (cur === null ? fresh : undefined));
      const stored = used.snapshot.val();
      if (!stored || stored.uid !== uid) return bad(400, 'grant_invalid');
      // 3. the profile: create-if-absent with the ORDER's phone (a transaction — never overwrites; else last_login)
      const freshProfile = { phone: gv.phone, phone_hash: gv.phone_hash, created_at: t, last_login: t };
      const { created: isNew } = await ensureProfile(db, uid, freshProfile, t);
      // 4. apply ONCE — ONE transaction on user_private/{uid}, the node deletion tombstones FIRST (BC2): it ABORTS on deleted_at
      //    (Codex S3 r1 P1: a deletion that completed after step 1 is never resurrected) and writes consent + email + the per-order
      //    `grants_applied` marker together, every value from the STORED use. A replay finds the marker and changes nothing.
      const verified = await S.verifiedEmailOf(db, uid, stored.inputs.email);
      let outcome = null;
      await db.ref(`user_private/${uid}`).transaction((cur) => {
        if (cur && cur.deleted_at != null) { outcome = 'deleted'; return undefined; }
        if (cur && cur.grants_applied && cur.grants_applied[v.payload.order_id] === true) { outcome = 'already'; return undefined; }
        outcome = 'applied';
        const base = cur || {};
        return { ...base, email: stored.inputs.email, email_verified: verified, email_source: 'typed',
          consent: { ...(base.consent || {}), [P]: { terms: { version: stored.legal.terms_version, privacy_version: stored.legal.privacy_version, at: stored.at },
            promos: { value: stored.inputs.promos, copy_version: stored.legal.promos_copy_version, at: stored.at } } },
          grants_applied: { ...(base.grants_applied || {}), [v.payload.order_id]: true } };
      });
      if (outcome === 'deleted') {   // the deletion won: no consent, no token, and the profile THIS call made is undone
        if (isNew) await undoCreatedProfile(db, uid, freshProfile);
        return bad(403, 'deleted');
      }
      // the name (a different node): written by the redemption that applied; a RETRY after a failure between the apply and this
      // write fills it only while the profile has none (a member's later edit always sets a name, so it is never overwritten);
      // only ever onto a profile that still exists (a deletion's removal is never undone by it)
      await db.ref(`user_profiles/${uid}`).transaction((cur) => (cur === null ? null
        : (outcome === 'applied' || typeof cur.name !== 'string' ? { ...cur, name: stored.inputs.name } : undefined)));
      if (stored.applied !== true) await db.ref(`grants_used/${v.payload.order_id}/applied`).set(true);   // the use's bookkeeping
      // 5. mint — never for a tombstoned uid (checked immediately before; a retry after `applied` only re-mints for the claimed uid)
      if (await isDeleted(db, uid)) return bad(403, 'deleted');
      const token = await deps.getAuth().createCustomToken(uid, { customer: true });
      await SE.refreshActivity(db, uid, t);
      const nm = (await db.ref(`user_profiles/${uid}/name`).once('value')).val();
      return res.status(200).json({ ok: true, token, is_new: isNew, name: typeof nm === 'string' ? nm : null, completion: 'complete' });
    } catch (e) {
      console.error('redeemSignupGrant', e && e.message);
      return res.status(500).json({ ok: false });
    }
  }

  // ── S3d getMyProfile ──
  async function getMyProfile(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false });
      const q = req.query || {};
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      // the caller's OWN data only: exactly ?context=platform, no other parameter, no body field (never a uid / phone / email)
      if (q.context !== 'platform' || Object.keys(q).length !== 1 || Object.keys(body).length) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const db = deps.getDatabase();
      if (await limited(db, req, res)) return;
      const t = req.get('x-firebase-id-token');
      let uid = null;
      if (t) {
        try { const dec = await deps.getAuth().verifyIdToken(t); if (dec && dec.customer === true && typeof dec.uid === 'string') uid = dec.uid; } catch (_) { uid = null; }
      }
      if (!uid) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
      if (await isDeleted(db, uid)) return res.status(403).json({ ok: false, reason: 'deleted' });
      const [profS, privS, completion] = await Promise.all([db.ref(`user_profiles/${uid}`).once('value'), db.ref(`user_private/${uid}`).once('value'), S.completionState(db, uid, P, env)]);
      const prof = profS.val() || {};
      const priv = privS.val() || {};
      const c = (priv.consent && priv.consent[P]) || {};
      const phone = typeof prof.phone === 'string' ? prof.phone : null;
      const out = { ok: true, name: typeof prof.name === 'string' ? prof.name : null, email: typeof priv.email === 'string' ? priv.email : null,
        phone, phone_last4: phone ? phone.slice(-4) : null,
        consent: { terms: !!(c.terms && typeof c.terms === 'object'), terms_version: c.terms && typeof c.terms.version === 'string' ? c.terms.version : null,
          promos: !!(c.promos && c.promos.value === true) },
        completion };
      if (c.promos && typeof c.promos.value === 'boolean') out.promos = c.promos.value;   // ADDITIVE: the stored consent; omitted when none
      return res.status(200).json(out);
    } catch (e) {
      console.error('getMyProfile', e && e.message);
      return res.status(500).json({ ok: false });
    }
  }

  return { requestOtp, verifyOtp, redeemSignupGrant, getMyProfile };
}

module.exports = { makeSignupPlatform, isPlatformBody, NAME_MAX };
