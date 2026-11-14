'use strict';
// PLAN-3a-capp-push-tokens r0 (APPROVED 11-14; contract = capp PLAN-capp-push-r1 §6b, reconciled) — the customer's push DEVICES and
// notification PREFS, for the capp's «Notificaciones». Member-only through member-auth (a customer token, never a handheld; none of
// the three tombstones), the ID token in a HEADER (x-firebase-id-token) — never a URL or a body (rule 20). Every route ?context=platform.
//   POST registerCustomerPushToken   { token, platform: 'ios'|'android', app_build, pedidos, promociones } → 200 { ok, prefs }
//   POST unregisterCustomerPushToken { token }                                                         → 200 { ok }   (idempotent)
//   POST setCustomerPushPrefs        { pedidos, promociones }                                          → 200 { ok, prefs }
//   GET  getCustomerPushPrefs                                         → 200 { ok, prefs | null, limits } (marketing/push-policy)
//   all → 400 bad_request | 401 unauthenticated | 403 deleted | 405 | 429 rate_limited | 503 unavailable
// STORAGE, server-only (rules .read/.write false):
//   customer_push_tokens/{sha256(token)} = { uid, token, platform, app_build, at, claim }   ONE record per token (every change is ONE
//     transaction on ONE path — the merchant H1c model); a person's devices = orderByChild('uid').equalTo(uid) (.indexOn uid), ≤ DEVICE_MAX
//     (the oldest `at` evicted). A token registered by another uid MOVES (a uid switch / a shared phone): it belongs to the signed-in person.
//     `claim` is new per registration (never reused), so a late cleanup of an OLD registration (an FCM prune, an eviction) never removes
//     a newer one (compare-and-clear).
//   customer_push_prefs/{uid} = { pedidos, promociones, at, offers_consent }   ONCE per person (the sender reads it per uid).
//     Owner ruling 11-14: the «Ofertas de Sherpa» push switch IS the consent — per CHANNEL. promociones needs NO email / WhatsApp promos
//     consent; each change of it writes offers_consent = { channel: 'push', value, copy_version: PUSH_OFFERS_COPY_VERSION, at } (on =
//     the consent given, off = its withdrawal; a pedidos-only change leaves the record as it was). The sender gates offer pushes on
//     pushOffersConsented(prefs) — THIS record, never the email / WhatsApp consent. Account deletion clears the node.
// DELETION: account deletion + the 180-day sweep remove every token + the prefs IN the same atomic update (account-lib
//   accountDeleteUpdates, push hashes read by pushHashesOf); a register racing a deletion re-checks the tombstones AFTER its write and
//   clears its own claim; the sender (5f) also refuses a tombstoned uid. An FCM terminal error ⇒ pruneCustomerToken(hash, claim).
// The token never appears in a response, a URL or a log; logs carry at most an 8-char hash prefix.
const crypto = require('crypto');
const MA = require('./member-auth');
const PP = require('./marketing/push-policy');

const DEVICE_MAX = 10;
// the version of the «Ofertas de Sherpa» switch's sub-line copy the person saw (capp's copy; bumped with it — pinned in the contract)
const PUSH_OFFERS_COPY_VERSION = 'push-offers-1';
const TOKENS = 'customer_push_tokens';
const PREFS = 'customer_push_prefs';
const PLATFORMS = Object.freeze(['ios', 'android']);
const RATE_WRITE = Object.freeze({ windowMs: 10 * 60 * 1000, max: 30 });   // an EXPLICIT limiter policy (checkRateLimit fails OPEN without one)
const RATE_READ = Object.freeze({ windowMs: 60 * 1000, max: 60 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const vToken = (t) => (typeof t === 'string' && t.length >= 1 && t.length <= 4096 && !/\s/.test(t) ? t : null);
const vBuild = (b) => (typeof b === 'string' && b.length >= 1 && b.length <= 32 && /^[A-Za-z0-9._+-]+$/.test(b) ? b : null);
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newClaim = () => crypto.randomBytes(12).toString('hex');
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const prefsOf = (v) => (isObj(v) && typeof v.pedidos === 'boolean' && typeof v.promociones === 'boolean' ? { pedidos: v.pedidos, promociones: v.promociones } : null);

// a person's registrations → [{ hash, claim, at }] (the deletion map and the cap read this)
async function devicesOf(db, uid) {
  const snap = await db.ref(TOKENS).orderByChild('uid').equalTo(uid).once('value');
  const all = snap.val() || {};
  return Object.entries(all).filter(([h, r]) => /^[a-f0-9]{64}$/.test(h) && isObj(r) && r.uid === uid).map(([hash, r]) => ({ hash, claim: r.claim, at: Number.isFinite(r.at) ? r.at : 0 }));
}
const pushHashesOf = async (db, uid) => (await devicesOf(db, uid)).map((d) => d.hash);

// compare-and-clear ONE registration: removed only while the record still carries `claim` (an old registration's cleanup never removes
// a newer one). The sender's FCM terminal-error prune and the eviction / race cleanups use it. → true when this call removed it
async function pruneCustomerToken(db, hash, claim) {
  if (!/^[a-f0-9]{64}$/.test(String(hash)) || typeof claim !== 'string' || !claim) return false;
  let removed = false;
  await db.ref(`${TOKENS}/${hash}`).transaction((cur) => {
    removed = false;
    if (cur === null) return null;   // null-first: commits only if the server is null too, else re-runs on the record
    if (isObj(cur) && cur.claim === claim) { removed = true; return null; }
    return undefined;
  });
  return removed;
}

// THE sender's gate for an offer push (5f's sender): the person's PUSH-channel consent is given — never the email / WhatsApp consent
function pushOffersConsented(prefs) {
  const c = isObj(prefs) ? prefs.offers_consent : null;
  return isObj(prefs) && prefs.promociones === true && isObj(c) && c.channel === 'push' && c.value === true;
}

const hasBody = (req) => {
  const b = req.body;
  return (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) || (b != null && (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length > 0));
};
const contextOk = (req) => { const q = isObj(req.query) ? req.query : {}; return q.context === 'platform' && Object.keys(q).every((k) => k === 'context'); };

function makeCustomerPush({ getDatabase, getAuth, checkRateLimit, now = () => Date.now() }) {
  const verify = (t) => getAuth().verifyIdToken(t);
  const BAD = { status: 400, body: { ok: false, reason: 'bad_request' } };
  // → { uid, db } | { status, body } (Retry-After set on res)
  async function admit(req, res, bucket, policy) {
    const uid = await MA.verifiedMemberUid(typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, verify);
    if (!uid) return { status: 401, body: { ok: false, reason: 'unauthenticated' } };
    const db = getDatabase();
    const rl = await checkRateLimit(db, bucket, uid, policy);
    if (!rl || rl.allowed !== true) { res.set('Retry-After', String((rl && rl.retryAfterSec) || 60)); return { status: 429, body: { ok: false, reason: 'rate_limited' } }; }
    if (await MA.isMemberTombstoned(db, uid)) return { status: 403, body: { ok: false, reason: 'deleted' } };
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
  // ONE transaction on the person's prefs: the consent record is rewritten only when promociones CHANGES (given / withdrawn)
  const writePrefs = (db, uid, p, t) => db.ref(`${PREFS}/${uid}`).transaction((cur) => {
    const prev = isObj(cur) && isObj(cur.offers_consent) && cur.offers_consent.channel === 'push' ? cur.offers_consent : null;
    const consent = prev && prev.value === p.promociones ? prev : { channel: 'push', value: p.promociones, copy_version: PUSH_OFFERS_COPY_VERSION, at: t };
    return { pedidos: p.pedidos, promociones: p.promociones, at: t, offers_consent: consent };
  });

  const registerCustomerPushToken = handle('registerCustomerPushToken', 'POST', async (req, res) => {
    const b = req.body;
    if (!exactKeys(b, ['token', 'platform', 'app_build', 'pedidos', 'promociones']) || !vToken(b.token) || !PLATFORMS.includes(b.platform)
      || !vBuild(b.app_build) || typeof b.pedidos !== 'boolean' || typeof b.promociones !== 'boolean') return BAD;
    const a = await admit(req, res, 'push_register', RATE_WRITE);
    if (!a.uid) return a;
    const { db, uid } = a;
    const t = now();
    const hash = hashOf(b.token);
    let claim = null;
    await db.ref(`${TOKENS}/${hash}`).transaction((cur) => {
      // this person's own registration is REFRESHED (its claim kept); absent or another person's ⇒ a NEW registration (the device moves)
      claim = isObj(cur) && cur.uid === uid && typeof cur.claim === 'string' && cur.claim ? cur.claim : newClaim();
      return { uid, token: b.token, platform: b.platform, app_build: b.app_build, at: t, claim };
    });
    const prefs = { pedidos: b.pedidos, promociones: b.promociones };
    await writePrefs(db, uid, prefs, t);
    // the cap: the oldest registrations beyond DEVICE_MAX are evicted (compare-and-clear on their claim; never this one)
    const devs = (await devicesOf(db, uid)).filter((d) => d.hash !== hash).sort((x, y) => x.at - y.at);
    for (const d of devs.slice(0, Math.max(0, devs.length - (DEVICE_MAX - 1)))) await pruneCustomerToken(db, d.hash, d.claim);
    // a deletion that landed meanwhile: this registration is cleared (the deletion's map could not see it), never left behind
    if (await MA.isMemberTombstoned(db, uid)) {
      await pruneCustomerToken(db, hash, claim);
      await db.ref(`${PREFS}/${uid}`).remove();
      return { status: 403, body: { ok: false, reason: 'deleted' } };
    }
    return { status: 200, body: { ok: true, prefs } };
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
    if (!exactKeys(b, ['pedidos', 'promociones']) || typeof b.pedidos !== 'boolean' || typeof b.promociones !== 'boolean') return BAD;
    const a = await admit(req, res, 'push_prefs', RATE_WRITE);
    if (!a.uid) return a;
    const prefs = { pedidos: b.pedidos, promociones: b.promociones };
    await writePrefs(a.db, a.uid, prefs, now());
    return { status: 200, body: { ok: true, prefs } };
  });

  const getCustomerPushPrefs = handle('getCustomerPushPrefs', 'GET', async (req, res) => {
    if (hasBody(req)) return BAD;
    const a = await admit(req, res, 'push_prefs_read', RATE_READ);
    if (!a.uid) return a;
    const [p, limits] = await Promise.all([a.db.ref(`${PREFS}/${a.uid}`).once('value'), PP.readPushPolicy(a.db)]);
    return { status: 200, body: { ok: true, prefs: prefsOf(p.val()), limits } };
  });

  return { registerCustomerPushToken, unregisterCustomerPushToken, setCustomerPushPrefs, getCustomerPushPrefs };
}

module.exports = { makeCustomerPush, pushHashesOf, pruneCustomerToken, pushOffersConsented, PUSH_OFFERS_COPY_VERSION, hashOf, DEVICE_MAX, TOKENS, PREFS, RATE_WRITE, RATE_READ };
