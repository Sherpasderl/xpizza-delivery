'use strict';
// PLAN-3a-capp-push-tokens r0 (APPROVED 11-14; contract = capp PLAN-capp-push-r1 §6b, reconciled; Codex push r1 fixes) — the customer's
// push DEVICES and notification PREFS, for the capp's «Notificaciones». Member-only through member-auth (a customer token, never a
// handheld; none of the three tombstones), the ID token in a HEADER (x-firebase-id-token) — never a URL or a body (rule 20). ?context=platform.
//   POST registerCustomerPushToken   { token, platform: 'ios'|'android', app_build, install_id, pedidos, promociones }
//                                    → 200 { ok, prefs: { pedidos, promociones, rev } } | 409 token_in_use
//   POST unregisterCustomerPushToken { token }                                                  → 200 { ok }   (idempotent)
//   POST setCustomerPushPrefs        { pedidos, promociones, expected_rev }                    → 200 { ok, prefs } | 409 stale_prefs { prefs }
//   GET  getCustomerPushPrefs                                         → 200 { ok, prefs | null, limits } (marketing/push-policy) | 503
//   all → 400 bad_request | 401 unauthenticated | 403 deleted | 405 | 429 rate_limited | 503 unavailable
// STORAGE, server-only (rules .read/.write false):
//   customer_push_tokens/{sha256(token)} = { uid, token, platform, app_build, install_id, at, claim }   ONE record per token (every change
//     is ONE transaction on ONE path — the merchant H1c model); a person's devices = orderByChild('uid').equalTo(uid) (.indexOn uid),
//     ≤ DEVICE_MAX (the oldest evicted). EVERY registration (a refresh too) gets a NEW claim, so a late cleanup of an older one (an FCM
//     prune, an eviction, a deletion's drain) never removes it (compare-and-clear). A token held by ANOTHER uid moves only for the SAME
//     installation (install_id: a uid switch / a shared phone); a replay from another installation ⇒ 409 token_in_use, untouched.
//   customer_push_prefs/{uid} = { rev, pedidos, promociones, at, offers_consent }   ONCE per person (the sender reads it per uid).
//     A register only INITIALIZES it (rev 1) when absent — it never rewrites prefs or consent (a refresh never re-consents after a
//     withdrawal on another device). setPrefs is a rev CAS (expected_rev; stale ⇒ 409 stale_prefs). Owner ruling 11-14: the «Ofertas de
//     Sherpa» switch IS the consent, per CHANNEL — each change of promociones writes offers_consent = { channel: 'push', value,
//     copy_version, at } (on = given, off = withdrawn); the sender gates on pushOffersConsented(prefs), never the email/WhatsApp consent.
// DELETION (signup-endpoints deleteAccountCore — deleteAccount AND the 180-day sweep): the account's atomic update installs the prefs
//   FENCE { _deleted: at } (every prefs txn aborts on it ⇒ nothing resurrects); THEN the person's devices are discovered and DRAINED
//   (compare-and-clear on uid + claim — a shared device another account re-registered meanwhile is never removed). A register racing a
//   deletion re-checks the tombstones after its write and clears its own claim; the sender (5f) also refuses a tombstoned uid.
// The token never appears in a response, a URL or a log.
const crypto = require('crypto');
const MA = require('./member-auth');
const PP = require('./marketing/push-policy');

const DEVICE_MAX = 10;
const TOKENS = 'customer_push_tokens';
const PREFS = 'customer_push_prefs';
const FENCE = '_deleted';
// the version of the «Ofertas de Sherpa» switch's sub-line copy the person saw (capp's copy; bumped with it — pinned in the contract)
const PUSH_OFFERS_COPY_VERSION = 'push-offers-1';
const PLATFORMS = Object.freeze(['ios', 'android']);
const RATE_WRITE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 30 });   // an EXPLICIT limiter policy (checkRateLimit fails OPEN without one)
const RATE_READ = Object.freeze({ windowMs: 60 * 1000, max: 60 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const vToken = (t) => (typeof t === 'string' && t.length >= 1 && t.length <= 4096 && !/\s/.test(t) ? t : null);
const vBuild = (b) => (typeof b === 'string' && b.length >= 1 && b.length <= 32 && /^[A-Za-z0-9._+-]+$/.test(b) ? b : null);
const vInstall = (i) => (typeof i === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(i) ? i : null);
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newClaim = () => crypto.randomBytes(12).toString('hex');
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const fenced = (v) => isObj(v) && v[FENCE] != null;
const prefsOf = (v) => (isObj(v) && !fenced(v) && typeof v.pedidos === 'boolean' && typeof v.promociones === 'boolean' && Number.isSafeInteger(v.rev)
  ? { pedidos: v.pedidos, promociones: v.promociones, rev: v.rev } : null);
const consentOf = (prev, promociones, t) => (isObj(prev) && prev.channel === 'push' && prev.value === promociones ? prev
  : { channel: 'push', value: promociones, copy_version: PUSH_OFFERS_COPY_VERSION, at: t });

// a person's registrations → [{ hash, claim, at }] (the cap and the deletion's drain read this)
async function devicesOf(db, uid) {
  const snap = await db.ref(TOKENS).orderByChild('uid').equalTo(uid).once('value');
  const all = snap.val() || {};
  return Object.entries(all).filter(([h, r]) => /^[a-f0-9]{64}$/.test(h) && isObj(r) && r.uid === uid).map(([hash, r]) => ({ hash, claim: r.claim, at: Number.isFinite(r.at) ? r.at : 0 }));
}

// compare-and-clear ONE registration (the sender's FCM terminal-error prune, the eviction, the race cleanup): removed only while the record
// still carries `claim` (and, when given, `uid`). → true when this call removed it
async function pruneCustomerToken(db, hash, claim, uid = null) {
  if (!/^[a-f0-9]{64}$/.test(String(hash)) || typeof claim !== 'string' || !claim) return false;
  let removed = false;
  await db.ref(`${TOKENS}/${hash}`).transaction((cur) => {
    removed = false;
    if (cur === null) return null;   // null-first: commits only if the server is null too, else re-runs on the record
    if (isObj(cur) && cur.claim === claim && (uid === null || cur.uid === uid)) { removed = true; return null; }
    return undefined;
  });
  return removed;
}

// the deletion's DRAIN (after its atomic update installed the fence): every registration of `uid` discovered NOW, each removed only while
// it still names this uid and the claim seen (a shared device another account re-registered meanwhile is kept). → the count removed
async function drainPushFor(db, uid) {
  let n = 0;
  for (const d of await devicesOf(db, uid)) if (await pruneCustomerToken(db, d.hash, d.claim, uid)) n += 1;
  return n;
}

// THE sender's gate for an offer push (5f's sender): the person's PUSH-channel consent is given — never the email / WhatsApp consent
function pushOffersConsented(prefs) {
  const c = isObj(prefs) ? prefs.offers_consent : null;
  return isObj(prefs) && !fenced(prefs) && prefs.promociones === true && isObj(c) && c.channel === 'push' && c.value === true;
}

const hasBody = (req) => {
  const b = req.body;
  return (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) || (b != null && (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length > 0));
};
const contextOk = (req) => { const q = isObj(req.query) ? req.query : {}; return q.context === 'platform' && Object.keys(q).every((k) => k === 'context'); };

function makeCustomerPush({ getDatabase, getAuth, checkRateLimit, now = () => Date.now() }) {
  const verify = (t) => getAuth().verifyIdToken(t);
  const BAD = { status: 400, body: { ok: false, reason: 'bad_request' } };
  const DELETED = { status: 403, body: { ok: false, reason: 'deleted' } };
  // → { uid, db } | { status, body } (Retry-After set on res)
  async function admit(req, res, bucket, policy) {
    const uid = await MA.verifiedMemberUid(typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, verify);
    if (!uid) return { status: 401, body: { ok: false, reason: 'unauthenticated' } };
    const db = getDatabase();
    const rl = await checkRateLimit(db, bucket, uid, policy);
    if (!rl || rl.allowed !== true) { res.set('Retry-After', String((rl && rl.retryAfterSec) || 60)); return { status: 429, body: { ok: false, reason: 'rate_limited' } }; }
    if (await MA.isMemberTombstoned(db, uid)) return DELETED;
    return { uid, db };
  }
  const handle = (name, method, fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== method) return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
      if (!contextOk(req)) return res.status(400).json(BAD.body);
      const out = await fn(req, res);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error(name, e && e.code ? e.code : 'error');
      return res.status(503).json({ ok: false, reason: 'unavailable', retryable: true });
    }
  };

  const registerCustomerPushToken = handle('registerCustomerPushToken', 'POST', async (req, res) => {
    const b = req.body;
    if (!exactKeys(b, ['token', 'platform', 'app_build', 'install_id', 'pedidos', 'promociones']) || !vToken(b.token) || !PLATFORMS.includes(b.platform)
      || !vBuild(b.app_build) || !vInstall(b.install_id) || typeof b.pedidos !== 'boolean' || typeof b.promociones !== 'boolean') return BAD;
    const a = await admit(req, res, 'push_register', RATE_WRITE);
    if (!a.uid) return a;
    const { db, uid } = a;
    const t = now();
    const hash = hashOf(b.token);
    const claim = newClaim();   // EVERY registration rotates the claim
    let inUse = false;
    const tx = await db.ref(`${TOKENS}/${hash}`).transaction((cur) => {
      inUse = false;
      if (isObj(cur) && cur.uid !== uid && cur.install_id !== b.install_id) { inUse = true; return undefined; }   // a replay from another installation
      return { uid, token: b.token, platform: b.platform, app_build: b.app_build, install_id: b.install_id, at: t, claim };
    });
    if (inUse) return { status: 409, body: { ok: false, reason: 'token_in_use' } };
    if (!(tx && tx.committed)) return { status: 503, body: { ok: false, reason: 'unavailable', retryable: true } };
    // the prefs: INITIALIZED only when absent — a register never rewrites prefs or consent; the deletion fence aborts
    let wasFenced = false;
    const pt = await db.ref(`${PREFS}/${uid}`).transaction((cur) => {
      wasFenced = fenced(cur);
      if (cur === null) return { rev: 1, pedidos: b.pedidos, promociones: b.promociones, at: t, offers_consent: consentOf(null, b.promociones, t) };
      return undefined;   // present (or fenced): untouched
    });
    // the cap: the oldest registrations beyond DEVICE_MAX are evicted (compare-and-clear on their claim; never this one)
    const devs = (await devicesOf(db, uid)).filter((d) => d.hash !== hash).sort((x, y) => x.at - y.at);
    for (const d of devs.slice(0, Math.max(0, devs.length - (DEVICE_MAX - 1)))) await pruneCustomerToken(db, d.hash, d.claim, uid);
    // a deletion that landed meanwhile (its fence, or a tombstone): this registration is cleared — never left behind
    if (wasFenced || (await MA.isMemberTombstoned(db, uid))) { await pruneCustomerToken(db, hash, claim, uid); return DELETED; }
    const stored = prefsOf(pt && pt.snapshot ? pt.snapshot.val() : null) || prefsOf((await db.ref(`${PREFS}/${uid}`).once('value')).val());
    return { status: 200, body: { ok: true, prefs: stored } };
  });

  const unregisterCustomerPushToken = handle('unregisterCustomerPushToken', 'POST', async (req, res) => {
    const b = req.body;
    if (!exactKeys(b, ['token']) || !vToken(b.token)) return BAD;
    const a = await admit(req, res, 'push_register', RATE_WRITE);
    if (!a.uid) return a;
    await a.db.ref(`${TOKENS}/${hashOf(b.token)}`).transaction((cur) => {
      if (cur === null) return null;
      return isObj(cur) && cur.uid === a.uid ? null : undefined;   // ONLY the caller's own registration — another person's device is never touched
    });
    return { status: 200, body: { ok: true } };
  });

  const setCustomerPushPrefs = handle('setCustomerPushPrefs', 'POST', async (req, res) => {
    const b = req.body;
    if (!exactKeys(b, ['pedidos', 'promociones', 'expected_rev']) || typeof b.pedidos !== 'boolean' || typeof b.promociones !== 'boolean'
      || !Number.isSafeInteger(b.expected_rev) || b.expected_rev < 0) return BAD;
    const a = await admit(req, res, 'push_prefs', RATE_WRITE);
    if (!a.uid) return a;
    const t = now();
    let why = null; let current = null;
    // ONE rev-CAS transaction; the deletion FENCE aborts it (a setPrefs racing a deletion never resurrects prefs or consent)
    const tx = await a.db.ref(`${PREFS}/${a.uid}`).transaction((cur) => {
      why = null; current = null;
      if (fenced(cur)) { why = 'deleted'; return undefined; }
      const rev = cur === null ? 0 : (Number.isSafeInteger(cur && cur.rev) ? cur.rev : -1);
      if (rev !== b.expected_rev) { why = 'stale'; current = prefsOf(cur); return cur === null ? null : undefined; }   // null-first: re-runs on the real node
      return { rev: rev + 1, pedidos: b.pedidos, promociones: b.promociones, at: t, offers_consent: consentOf(cur && cur.offers_consent, b.promociones, t) };
    });
    if (why === 'deleted') return DELETED;
    if (why === 'stale') return { status: 409, body: { ok: false, reason: 'stale_prefs', prefs: current } };
    if (!(tx && tx.committed)) return { status: 503, body: { ok: false, reason: 'unavailable', retryable: true } };
    return { status: 200, body: { ok: true, prefs: prefsOf(tx.snapshot.val()) } };
  });

  const getCustomerPushPrefs = handle('getCustomerPushPrefs', 'GET', async (req, res) => {
    if (hasBody(req)) return BAD;
    const a = await admit(req, res, 'push_prefs_read', RATE_READ);
    if (!a.uid) return a;
    const [p, limits] = await Promise.all([a.db.ref(`${PREFS}/${a.uid}`).once('value'), PP.readPushPolicy(a.db)]);
    if (!limits) return { status: 503, body: { ok: false, reason: 'unavailable', retryable: true } };   // a bad / unreadable configured policy: fail closed
    return { status: 200, body: { ok: true, prefs: prefsOf(p.val()), limits } };
  });

  return { registerCustomerPushToken, unregisterCustomerPushToken, setCustomerPushPrefs, getCustomerPushPrefs };
}

module.exports = { makeCustomerPush, drainPushFor, pruneCustomerToken, pushOffersConsented, PUSH_OFFERS_COPY_VERSION, hashOf, DEVICE_MAX, TOKENS, PREFS, FENCE, RATE_WRITE, RATE_READ };
