'use strict';
// ── signup-core — customer signup phase 1: Google as a LOGIN METHOD on the phone account (PLAN-signup-email-social r3) ──
//
// The phone account stays THE account (verifyOtp: phone_index → u_<hex> uid → custom token). Google never creates a Firebase
// user: the client gets a Google ID token (GIS), this module verifies it, and either
//   • finds the ONE source of truth `auth_links/google/{sub} = {uid, at}` pointing at a LIVE account → that uid logs in, or
//   • issues a short-lived `link_tickets/{id}` that only a phone verification can redeem (issued → bound → consumed).
// A link is ONE create-if-absent transaction on auth_links — there is no second commit, so no partial state and no repair.
// Server-owned profile data lives in `user_private/{uid}` (owner-read, never client-written). Deletion REPLACES it with exactly
// `{deleted_at}` (BC2): a durable in-node tombstone every Admin writer's transaction aborts on (BC1 extends the profile rule).
//
// Every function takes its db / clock / verifier injected, so the emulator suite drives the real RTDB transactions.
// Brand-agnostic: the restaurant id comes from the request; audiences / legal documents come from per-brand config.
const crypto = require('crypto');

const SIGNUP = Object.freeze({
  CHALLENGE_TTL_MS: 5 * 60 * 1000,
  TICKET_TTL_MS: 10 * 60 * 1000,
  GOOGLE_ISSUERS: Object.freeze(['accounts.google.com', 'https://accounts.google.com']),
  EMAIL_MAX: 254,
  RID_RE: /^[a-z0-9][a-z0-9_-]{1,39}$/,
  SESSION_RE: /^[A-Za-z0-9_-]{20,128}$/,
  ID_RE: /^[A-Za-z0-9_-]{16,64}$/,
});
// PLAN-guest-checkout-server S3a — the customer APP's signup SCOPE. Every per-brand key (consent node, legal, Google audiences,
// challenges / tickets) takes either a restaurant id (the forms, unchanged) or this scope (the app, `context:'platform'`).
// It can never collide with a restaurant id: RID_RE requires a leading [a-z0-9].
const PLATFORM_SCOPE = '_platform';
const isScope = (s) => s === PLATFORM_SCOPE || SIGNUP.RID_RE.test(String(s || ''));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = () => crypto.randomBytes(18).toString('base64url');
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const validEmail = (e) => !!e && e.length <= SIGNUP.EMAIL_MAX && EMAIL_RE.test(e);

// ── config (server-side, per brand; never from the client) ──
// GOOGLE_OAUTH_AUDIENCES__<RID>: a comma list of OAuth client ids accepted for that brand. Unknown / empty → null (fail-closed).
// The key is derived ONLY for an id of [a-z0-9_] (upper-casing that set is collision-free — the return-URL codex P2-1 lesson:
// r3-synth must never read r3_synth's key); any other id has no key → Google fail-closed for it.
function audiencesFor(rid, env) {
  if (rid === PLATFORM_SCOPE) return listOf((env || {}).GOOGLE_OAUTH_AUDIENCES__PLATFORM);   // S3a: the app's own OAuth clients
  if (typeof rid !== 'string' || !/^[a-z0-9_]+$/.test(rid) || !SIGNUP.RID_RE.test(rid)) return null;
  return listOf((env || {})[`GOOGLE_OAUTH_AUDIENCES__${rid.toUpperCase()}`]);
}
function listOf(raw) {
  const list = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return list.length ? list : null;
}
// restaurants/{rid}/legal: { terms_url, privacy_url, terms_version, privacy_version, promos_copy_version } (admin-only)
// S3a: the platform scope reads platform_config/legal — the SAME 5-field shape, Sherpa's own documents (written by the ops CLI)
async function legalFor(db, rid) {
  if (typeof rid !== 'string' || !isScope(rid)) return null;
  const v = (await db.ref(rid === PLATFORM_SCOPE ? 'platform_config/legal' : `restaurants/${rid}/legal`).once('value')).val();
  const ok = v && typeof v.terms_url === 'string' && typeof v.privacy_url === 'string' && typeof v.terms_version === 'string' && v.terms_version
    && typeof v.privacy_version === 'string' && v.privacy_version && typeof v.promos_copy_version === 'string' && v.promos_copy_version;
  return ok ? v : null;
}
// What the sheet renders from (links, buttons). Nothing in it is authoritative on the way back.
// rollout_at (signup_config/rollout_at, set at deploy): accounts created before it are LEGACY — never routed into completion.
// Unset → null → the client keeps today's flow for everyone. google_client_id: the brand's first audience (GIS needs it).
// codex build r2 #3: NO rollout_at unless this brand's legal documents are ready — "legal not ready" = signup not rolled out
// for anyone (today's flow), so the client never sees a post-rollout account with legal off.
async function signupConfig(db, rid, env) {
  const [legal, rollout] = await Promise.all([legalFor(db, rid), db.ref('signup_config/rollout_at').once('value')]);
  const aud = audiencesFor(rid, env);
  const r = rollout.val();
  return { terms_url: legal ? legal.terms_url : null, privacy_url: legal ? legal.privacy_url : null,
    legal_ready: !!legal, google_enabled: !!aud, google_client_id: aud ? aud[0] : null,
    email_login_enabled: false,   // phase 2 turns email login on
    rollout_at: legal && isNum(r) ? r : null };
}

// ── Google ID token verification (the REAL library path; certs injectable for tests) ──
// claims must satisfy: signature + exp (the library), iss ∈ GOOGLE_ISSUERS, aud ∈ audiences, non-empty sub, email_verified === true
// (boolean), a non-empty nonce (the CALLER checks it against a live challenge). Returns { ok, sub, email, name, nonce } or
// { ok:false, reason }.
async function verifyGoogleIdToken(idToken, { audiences, client, certs }) {
  try {
    if (!Array.isArray(audiences) || !audiences.length) return { ok: false, reason: 'google_unconfigured' };
    if (typeof idToken !== 'string' || !idToken) return { ok: false, reason: 'bad_token' };
    const ticket = certs
      ? await client.verifySignedJwtWithCertsAsync(idToken, certs, audiences, SIGNUP.GOOGLE_ISSUERS)
      : await client.verifyIdToken({ idToken, audience: audiences });
    const p = ticket && ticket.getPayload ? ticket.getPayload() : null;
    if (!p) return { ok: false, reason: 'bad_token' };
    if (!SIGNUP.GOOGLE_ISSUERS.includes(p.iss)) return { ok: false, reason: 'bad_issuer' };
    if (!audiences.includes(p.aud)) return { ok: false, reason: 'bad_audience' };
    if (typeof p.sub !== 'string' || !p.sub) return { ok: false, reason: 'no_sub' };
    if (p.email_verified !== true) return { ok: false, reason: 'email_unverified' };
    if (typeof p.nonce !== 'string' || !p.nonce) return { ok: false, reason: 'nonce_mismatch' };
    return { ok: true, sub: p.sub, email: typeof p.email === 'string' ? p.email : null, name: typeof p.name === 'string' ? p.name : null, nonce: p.nonce };
  } catch (e) {
    return { ok: false, reason: 'bad_token' };
  }
}

// ── the Google challenge (nonce), bound to the client session + brand; single use ──
async function startGoogle(db, { rid, sessionId, now }) {
  if (!SIGNUP.SESSION_RE.test(String(sessionId || '')) || !isScope(rid)) return { ok: false, reason: 'bad_request' };
  const nonce = randomId();
  await db.ref(`auth_challenges/${sha256(nonce)}`).set({ session: sha256(sessionId), rid, exp: now + SIGNUP.CHALLENGE_TTL_MS, used: false });
  return { ok: true, nonce };
}
// consume the challenge (transaction): it must exist, be unused, unexpired, of THIS session and brand
async function consumeChallenge(db, { nonce, sessionId, rid, now }) {
  if (typeof nonce !== 'string' || !nonce) return false;
  let good = false;
  await db.ref(`auth_challenges/${sha256(nonce)}`).transaction((c) => {
    good = false;
    if (c === null) return null;   // the first run sees the local cache (empty) — a no-op write the server refuses if a row exists, rerun with it
    if (c.used !== false || !(c.exp > now) || c.session !== sha256(sessionId) || c.rid !== rid) return;   // abort
    good = true; return { ...c, used: true };
  });
  return good;
}

// ── liveness: a uid may log in only when its account is consistent and not tombstoned ──
async function isLive(db, uid) {
  if (typeof uid !== 'string' || !/^u_[a-f0-9]{24}$/.test(uid)) return false;
  const [priv, prof, gone] = await Promise.all([db.ref(`user_private/${uid}/deleted_at`).once('value'), db.ref(`user_profiles/${uid}`).once('value'), db.ref(`deleted_uids/${uid}`).once('value')]);
  if (priv.exists() || gone.exists()) return false;
  const p = prof.val();
  if (!p || typeof p.phone_hash !== 'string' || !p.phone_hash) return false;
  return (await db.ref(`phone_index/${p.phone_hash}`).once('value')).val() === uid;
}

// activity refresh — ONE transaction on user_private/{uid}, aborting on the tombstone
async function touchActivity(db, uid, now) {
  const r = await db.ref(`user_private/${uid}`).transaction((cur) => { if (cur && cur.deleted_at != null) return; return { ...(cur || {}), last_active: now }; });
  return !!r.committed;
}

// ── googleSignIn: a VALID link → that uid; otherwise a ticket (no profile, no index, no token) ──
async function googleSignIn(db, { idToken, sessionId, rid, now, verify }) {
  if (!SIGNUP.SESSION_RE.test(String(sessionId || '')) || !isScope(rid)) return { ok: false, reason: 'bad_request' };
  // `verify` = verifyGoogleIdToken bound to this brand's audiences; the token's nonce must be a live challenge of THIS session + brand
  const peek = await verify(idToken);
  if (!peek.ok) return { ok: false, reason: peek.reason };
  if (!(await consumeChallenge(db, { nonce: peek.nonce, sessionId, rid, now }))) return { ok: false, reason: 'nonce_mismatch' };
  const link = (await db.ref(`auth_links/google/${peek.sub}`).once('value')).val();
  if (link && typeof link.uid === 'string' && await isLive(db, link.uid)) {
    // the activity transaction is the LAST liveness check: a deletion that committed after isLive() makes it abort → REFUSE
    // (codex build r1 P1-1 — never a token for a uid whose tombstone the transaction saw)
    if (!(await touchActivity(db, link.uid, now))) return { ok: false, reason: 'account_unavailable' };
    return { ok: true, linked: true, uid: link.uid, name: peek.name };
  }
  const id = randomId();
  await db.ref(`link_tickets/${id}`).set({ kind: 'google', key: peek.sub, email: peek.email || null, rid, session: sha256(sessionId), state: 'issued', exp: now + SIGNUP.TICKET_TTL_MS });
  return { ok: true, linked: false, ticket: id, email: peek.email || null, name: peek.name || null };
}

// ── the ticket state machine: issued → bound(phone_hash, challenge_id) [→ bound] → consumed ──
async function bindTicket(db, { ticketId, sessionId, rid, phoneHash, challengeId, now }) {
  if (!SIGNUP.ID_RE.test(String(ticketId || '')) || !phoneHash || !challengeId) return false;
  let good = false;
  await db.ref(`link_tickets/${ticketId}`).transaction((t) => {
    good = false;
    if (t === null) return null;   // see consumeChallenge
    if (!(t.exp > now) || t.session !== sha256(sessionId) || t.rid !== rid) return;
    if (t.state !== 'issued' && t.state !== 'bound') return;   // consumed (or anything else) → rejected
    good = true; return { ...t, state: 'bound', phone_hash: phoneHash, challenge_id: challengeId };
  });
  return good;
}
async function redeemTicket(db, { ticketId, sessionId, rid, phoneHash, challengeId, uid, now }) {
  if (!SIGNUP.ID_RE.test(String(ticketId || ''))) return null;
  let got = null;
  await db.ref(`link_tickets/${ticketId}`).transaction((t) => {
    got = null;
    if (t === null) return null;   // see consumeChallenge
    if (t.state !== 'bound' || !(t.exp > now) || t.session !== sha256(sessionId) || t.rid !== rid) return;
    if (t.phone_hash !== phoneHash || !challengeId || t.challenge_id !== challengeId) return;
    got = { kind: t.kind, key: t.key, email: t.email || null };
    // consumed = terminal: keep NO private data (codex build r1 P2-6) — no email, provider key, phone hash, session or uid
    return { state: 'consumed', consumed_at: now, exp: t.exp };
  });
  return got;
}

// ── the link: ONE create-if-absent transaction on the single source of truth ──
async function linkIdentity(db, { kind, key, uid, now }) {
  if ((kind !== 'google' && kind !== 'email') || typeof key !== 'string' || !key) return { link: 'invalid' };
  let outcome = 'conflict';
  await db.ref(`auth_links/${kind}/${key}`).transaction((cur) => {
    if (cur == null) { outcome = 'linked'; return { uid, at: now }; }
    outcome = cur.uid === uid ? 'noop' : 'conflict';
    return;   // abort — never overwrite
  });
  return { link: outcome };
}

// ── completeProfile: ONE transaction on user_private/{uid}; aborts on the tombstone ──
// the terms + promos versions come from restaurants/{rid}/legal (server config), the timestamps from the server clock.
async function completeProfile(db, { uid, rid, email, acceptTerms, promos, now }) {
  if (acceptTerms !== true || typeof promos !== 'boolean') return { ok: false, reason: 'bad_request' };
  const em = normEmail(email);
  if (!validEmail(em)) return { ok: false, reason: 'bad_email' };
  const legal = await legalFor(db, rid);
  if (!legal) return { ok: false, reason: 'legal_unconfigured' };
  const verified = await verifiedEmailOf(db, uid, em);
  let reason = null;
  const r = await db.ref(`user_private/${uid}`).transaction((cur) => {
    if (cur && cur.deleted_at != null) { reason = 'deleted'; return; }
    reason = null;
    const consent = { ...((cur && cur.consent) || {}) };
    consent[rid] = { terms: { version: legal.terms_version, privacy_version: legal.privacy_version, at: now },
      promos: { value: promos, copy_version: legal.promos_copy_version, at: now } };
    // email_source: kept as the provider's when the customer kept the provider's email; anything typed is 'typed'
    const source = cur && cur.email === em && typeof cur.email_source === 'string' ? cur.email_source : 'typed';
    return { ...(cur || {}), email: em, email_verified: verified, email_source: source, consent, last_active: now };
  });
  return r.committed ? { ok: true } : { ok: false, reason: reason || 'aborted' };
}
// After a successful provider link: record the provider's email as the profile email ONLY when none is set yet (§3.1:
// email_source = the provider; it grants NO email-login authority). One transaction, aborting on the tombstone.
async function noteProviderEmail(db, uid, email, kind) {
  const em = normEmail(email);
  if (!validEmail(em) || (kind !== 'google')) return false;
  const r = await db.ref(`user_private/${uid}`).transaction((cur) => {
    if (cur && cur.deleted_at != null) return;
    if (cur && typeof cur.email === 'string' && cur.email) return;   // never overwrite an email the customer already has
    return { ...(cur || {}), email: em, email_verified: false, email_source: kind };
  });
  return !!r.committed;
}
// an email is VERIFIED only when an email-login link (auth_links/email/{sha256(email)}, created by our own email-code verification —
// phase 2) points at THIS uid. A Google email claim is identity, not mailbox proof (codex r1 #3), so it never sets this.
async function verifiedEmailOf(db, uid, email) {
  const row = (await db.ref(`auth_links/email/${sha256(email)}`).once('value')).val();
  return !!(row && row.uid === uid);
}
// `confirm` (the platform setPromos only — the forms never pass it, so their {ok:true} is unchanged): + the value READ BACK from the
// committed record, so the app shows what is stored, never what it asked for
async function setPromos(db, { uid, rid, value, now, confirm = false }) {
  if (typeof value !== 'boolean' || !isScope(rid)) return { ok: false, reason: 'bad_request' };
  const legal = await legalFor(db, rid);
  if (!legal) return { ok: false, reason: 'legal_unconfigured' };
  let reason = null;
  const r = await db.ref(`user_private/${uid}`).transaction((cur) => {
    if (cur === null) { reason = 'not_completed'; return null; }   // see consumeChallenge; truly absent → nothing to change
    if (cur.deleted_at != null) { reason = 'deleted'; return; }
    const consent = { ...(cur.consent || {}) };
    const prev = consent[rid];
    if (!prev || !prev.terms) { reason = 'not_completed'; return; }   // promotions change only on a completed profile of this brand
    reason = null;
    consent[rid] = { ...prev, promos: { value, copy_version: legal.promos_copy_version, at: now } };   // terms untouched
    return { ...cur, consent };
  });
  if (!(r.committed && !reason)) return { ok: false, reason: reason || 'aborted' };
  if (!confirm) return { ok: true };
  const c = r.snapshot && r.snapshot.val();
  const stored = c && c.deleted_at == null && c.consent && c.consent[rid] && c.consent[rid].promos;
  if (!(stored && typeof stored.value === 'boolean')) return { ok: false, reason: 'aborted' };
  // Codex setPromos r1 P2-1: a retried transaction's snapshot can carry a deletion committed in the same SDK batch — re-read BOTH
  // tombstones after the commit; either present ⇒ never a success. Otherwise the answer is THIS call's committed value (a later
  // toggle is its own call's answer). RESIDUAL (as S3's mint): a deletion landing after this post-check is accepted — the consent
  // write it races is not resurrected (the tombstone REPLACES user_private) and the deleted session can no longer read it.
  const [gone, del] = await Promise.all([db.ref(`deleted_uids/${uid}`).once('value'), db.ref(`user_private/${uid}/deleted_at`).once('value')]);
  if (gone.exists() || del.val() != null) return { ok: false, reason: 'aborted' };
  return { ok: true, value: stored.value };
}

// ── S3a: the server-side completion state (the forms' account.js suCompletionState, computed here so the app needs no RTDB
// read after sign-in) and the member profile the app autofills from ──
//   'off'      the rollout is not active for this scope (no rollout_at, or legal not ready), or a LEGACY account (created
//              before rollout_at) — never routed into completion;
//   'complete' this scope's terms are on record;
//   'needed'   a post-rollout account without them (the forms' 'unknown' — an unreadable profile — is 'needed' too: it must complete).
async function completionState(db, uid, scope, env) {
  const cfg = await signupConfig(db, scope, env);
  if (typeof cfg.rollout_at !== 'number' || cfg.legal_ready !== true) return 'off';
  const created = (await db.ref(`user_profiles/${uid}/created_at`).once('value')).val();
  if (!isNum(created)) return 'needed';
  if (created < cfg.rollout_at) return 'off';
  const terms = (await db.ref(`user_private/${uid}/consent/${scope}/terms`).once('value')).val();
  return terms && typeof terms === 'object' ? 'complete' : 'needed';
}
// {name, email} + `promos` (the stored consent for this scope; OMITTED when none is stored — the client treats absent as inert)
async function profileOf(db, uid, scope) {
  const [name, priv] = await Promise.all([db.ref(`user_profiles/${uid}/name`).once('value'), db.ref(`user_private/${uid}`).once('value')]);
  const p = priv.val() || {};
  const out = { name: typeof name.val() === 'string' ? name.val() : null, email: typeof p.email === 'string' && p.deleted_at == null ? p.email : null };
  const pr = p.consent && p.consent[scope] && p.consent[scope].promos;
  if (pr && typeof pr.value === 'boolean') out.promos = pr.value;
  return out;
}

// ── deletion (BC2): REPLACE user_private/{uid} with exactly {deleted_at}; an existing deleted_at is kept on retry. For the
// inactivity sweep, `staleBefore` makes the transaction commit only if last_active (when present) is still older (a login
// that refreshed it in between makes the sweep abort for this account). Returns true when the tombstone stands.
async function tombstone(db, uid, { now, staleBefore = null } = {}) {
  let stands = false;
  const r = await db.ref(`user_private/${uid}`).transaction((cur) => {
    stands = false;
    if (cur && cur.deleted_at != null) { stands = true; return { deleted_at: cur.deleted_at }; }
    if (staleBefore != null && cur && isNum(cur.last_active) && cur.last_active >= staleBefore) return;   // a fresh login → abort
    stands = true; return { deleted_at: now };
  });
  return !!r.committed && stands;
}
// ── ACCOUNT LIFECYCLE (security backlog r2, advisor ruling 1): user_profiles/{uid} is THE lifecycle node. Every login path's gate
// and the inactivity sweep's claim are transactions on it, so they LINEARIZE: whichever commits first wins.
//   loginTouch → 'live' (last_login bumped) | 'claimed' (a sweep claimed it: never hand this uid to a login) | 'absent' (no profile)
//   sweepClaim → 'claimed' (deleting_at written, or already there: a crashed run resumes) | 'fresh' (a login won) | 'absent'
// The SDK's uncached first run sees null: return null there (a no-op), never undefined (an abort would end the retry).
async function loginTouch(db, uid, now) {
  let out = 'absent';
  await db.ref(`user_profiles/${uid}`).transaction((cur) => {
    if (cur === null) { out = 'absent'; return null; }
    if (cur.deleting_at != null) { out = 'claimed'; return undefined; }
    out = 'live'; return { ...cur, last_login: now };
  });
  return out;
}
async function sweepClaim(db, uid, cutoff, now) {
  let out = 'absent';
  await db.ref(`user_profiles/${uid}`).transaction((cur) => {
    if (cur === null) { out = 'absent'; return null; }
    if (cur.deleting_at != null) { out = 'claimed'; return cur; }
    const last = Number(cur.last_login || cur.created_at || 0);
    if (!(last && last < cutoff)) { out = 'fresh'; return undefined; }   // a login (or no timestamp: fail-safe) — never swept
    out = 'claimed'; return { ...cur, deleting_at: now };
  });
  return out;
}
async function isTombstoned(db, uid) {
  const [gone, priv] = await Promise.all([db.ref(`deleted_uids/${uid}`).once('value'), db.ref(`user_private/${uid}/deleted_at`).once('value')]);
  return gone.exists() || priv.exists();
}
// every auth_links row of the account, found by the uid query, removed only if it still points at it
async function removeLinks(db, uid) {
  let removed = 0;
  for (const kind of ['google', 'email']) {
    const rows = (await db.ref(`auth_links/${kind}`).orderByChild('uid').equalTo(uid).once('value')).val() || {};
    for (const key of Object.keys(rows)) {
      let hit = false;
      await db.ref(`auth_links/${kind}/${key}`).transaction((cur) => { hit = false; if (cur === null) return null; if (cur.uid !== uid) return; hit = true; return null; });
      if (hit) removed += 1;
    }
  }
  return removed;
}
// the periodic sweep: challenges and tickets past their expiry are removed (consumed tickets already hold no private data)
async function pruneExpired(db, now) {
  let removed = 0;
  for (const node of ['auth_challenges', 'link_tickets']) {
    const rows = (await db.ref(node).orderByChild('exp').endAt(now).once('value')).val() || {};
    for (const [id, row] of Object.entries(rows)) {
      if (!row || !(row.exp <= now)) continue;
      await db.ref(`${node}/${id}`).transaction((cur) => (cur === null ? null : (cur.exp <= now ? null : undefined)));
      removed += 1;
    }
  }
  return removed;
}
// does this account hold any signup-era data (so the inactivity sweep must tombstone it)?
async function hasSignupData(db, uid) {
  if ((await db.ref(`user_private/${uid}`).once('value')).exists()) return true;
  const g = (await db.ref('auth_links/google').orderByChild('uid').equalTo(uid).limitToFirst(1).once('value')).val();
  return !!g;
}

module.exports = { SIGNUP, PLATFORM_SCOPE, isScope, loginTouch, sweepClaim, isTombstoned, completionState, profileOf, sha256, audiencesFor, legalFor, signupConfig, verifyGoogleIdToken, startGoogle, consumeChallenge, isLive,
  touchActivity, googleSignIn, bindTicket, redeemTicket, linkIdentity, completeProfile, noteProviderEmail, verifiedEmailOf, setPromos, tombstone, removeLinks, pruneExpired, hasSignupData,
  normEmail, validEmail };
