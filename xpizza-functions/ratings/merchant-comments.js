'use strict';
// S-A(d) (PLAN §S-A(d); NOTE-S-Ad-merchant-comments-build, approved 2026-11-02) — getMerchantRatingComments: the P-1 merchant view of
// its customers' rating COMMENTS, anonymous, with BOUNDED work. GET ?rid=<rid>[&cursor=<opaque>]   Authorization: Bearer <ID token>
//   → 200 { ok, comments: [{ comment, store }], cursor } | 400 | 401 | 403 | 405 | 429 | 503
// AUTHORIZATION — the portal's sequence (portal/ops-core): a verified ID token; a customer / handheld token refused BEFORE any read;
//   then resolveAccess(…, rid) — the caller's membership ON THAT rid — and can(access, 'stats.read') (owner / owner_retired / manager).
//   A membership outage is 503, never a lower role. No rating read happens before the caller is authorized.
// READ — the mandatory server-only index rating_index/{rid}/{key} (rating-v2 indexKey: newest fulfilment first): ONE
//   orderByKey().startAfter(k).limitToFirst(CANDIDATES) query, then the candidates' AUTHORITY through rating-v2.readCountable (live AND
//   owner not tombstoned — the reader contract) at bounded concurrency, the node's restaurant_id RE-VERIFIED against the tenant, a
//   non-empty comment only, at most PAGE returned. The cursor continues from the LAST SCANNED key even when the page is empty, so
//   stale / withdrawn / deleted entries never force a full-history scan.
// PRIVACY — each comment is exactly { comment, store }: no order id, identity, delivery thumb, dishes, timestamps or index keys (no
//   dates at all: a date plus a low-volume merchant's own order times re-links a comment to its order — advisor ruling C). The cursor
//   is SEALED (AES-256-GCM, a fresh IV each time) over { rid, uid, k } with a key HKDF-derived from OTP_SALT under its own label (domain
//   separated from the phone hash; no new owner secret) — it reveals no order id and is refused for another rid, another caller, or
//   after tampering. An OTP_SALT rotation voids outstanding cursors: harmless, they are short-lived (the client restarts at page 1).
// THE CUT-OVER (Calificaciones v2, PLAN-3a-merchant-reviews-v2 r6.1 §2, r6.2 §1 + §3, r5 §2): v1 is the ANONYMOUS, pre-cut-over band
//   only. A node is served iff post_cutover !== true (the writers' stamp, no clock trusted) AND disclosure !== 1 AND, once
//   platform_config/ratings/disclosure_cutover_at exists, rated_at (the FIRST submission) < cut-over − CUTOVER_MARGIN_MS.
//   The cut-over: a memoized VALIDATED value is used as is (it is immutable); otherwise the leaf is read before the scan — an error or a
//   malformed value ⇒ 503; ABSENT ⇒ the scan runs and the leaf is re-read ONCE after the candidate reads (an activation committed
//   meanwhile is applied to the read candidates); absence is never cached. Reads: +2 before go-live, +1 cold, +0 memoized.
const crypto = require('crypto');
const V2 = require('./rating-v2');
const RC = require('./ratings-config');
const { resolveAccess, can } = require('../access/membership');

const CAP = 'stats.read';
const CANDIDATES = 60;     // index keys scanned per call (the candidate-read cap C)
const PAGE = 20;           // comments returned per call
const CONCURRENCY = 8;     // authoritative node reads in flight
// an EXPLICIT limiter policy — checkRateLimit requires it (without one it throws inside its transaction and fails OPEN; Codex S-F r1 #1)
const RATE = Object.freeze({ windowMs: 60 * 1000, max: 30 });
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // platform-manifest RID_RE
// the cursor's length bound is DERIVED from the largest payload it can seal (Codex run 3 #1: a fixed 400 refused a valid 408-char
// cursor): the longest rid (40), the longest caller uid the access layer admits (128 chars, membership isPathUid) at WORST-CASE JSON
// escaping (6 bytes per char — a control char as \u00XX), and the longest index key (13 + 1 + 64) → iv 12 + tag 16 + ciphertext.
const MAX_SEALED_BYTES = 12 + 16 + Buffer.byteLength(JSON.stringify({ v: 1, rid: 'r'.repeat(40), uid: '\u0001'.repeat(128), k: `${'9'.repeat(13)}-${'O'.repeat(64)}` }), 'utf8');
const MAX_CURSOR_CHARS = Math.ceil((MAX_SEALED_BYTES * 4) / 3);
const CURSOR_RE = new RegExp(`^[A-Za-z0-9_-]{40,${MAX_CURSOR_CHARS}}$`);
const HKDF_INFO = 'sherpa/rating-comments-cursor/v1';
const AAD = Buffer.from('rating-comments-cursor/v1');

const deriveKey = (salt) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(salt, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32));
function seal(key, payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
// → the last scanned index key, or null for ANY failure (malformed, tampered, another rid / caller, a rotated key)
function open(key, token, rid, uid) {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); d.setAAD(AAD); d.setAuthTag(raw.subarray(12, 28));
    const p = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!p || p.v !== 1 || p.rid !== rid || p.uid !== uid || typeof p.k !== 'string' || !V2.INDEX_KEY_RE.test(p.k)) return null;
    return p.k;
  } catch (_) { return null; }
}

const reply = (status, body) => ({ status, body });
const UNAVAILABLE = () => reply(503, { ok: false, reason: 'unavailable', retryable: true });
const CUT_LEAF = `${RC.PATH}/disclosure_cutover_at`;
// the cut-over leaf → { cut: <ms> } | { absent: true } | { fail: true } (a read error or a malformed value: fail closed)
async function readCutover(db) {
  let v;
  try { v = (await db.ref(CUT_LEAF).once('value')).val(); } catch (_) { return { fail: true }; }
  if (v === null || v === undefined) return { absent: true };
  return RC.validCutover(v) ? { cut: v } : { fail: true };
}
// the v1 band: never a stamped or disclosed node; with a cut-over, only a first submission strictly before cut-over − margin
const preBand = (nd, cut) => nd.post_cutover !== true && nd.disclosure !== 1
  && (cut === null || (Number.isFinite(nd.rated_at) && nd.rated_at < cut - RC.CUTOVER_MARGIN_MS));
const qstr = (v) => (typeof v === 'string' ? v : null);

async function merchantRatingCommentsCore({ db, verifyIdToken, checkRateLimit, salt, memo = {} }, req) {
  if (req.method !== 'GET') return reply(405, { ok: false, reason: 'method_not_allowed' });
  const header = (typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return reply(401, { ok: false, reason: 'unauthenticated' });
  let dec;
  try { dec = await verifyIdToken(token); } catch (_) { return reply(401, { ok: false, reason: 'unauthenticated' }); }
  if (!dec || typeof dec.uid !== 'string' || !dec.uid) return reply(401, { ok: false, reason: 'unauthenticated' });
  if (dec.customer === true || dec.handheld === true) return reply(403, { ok: false, reason: 'not_authorized' });
  const ctx = { uid: dec.uid, token: dec };

  const q = req.query && typeof req.query === 'object' ? req.query : {};
  const keys = Object.keys(q);
  const rid = qstr(q.rid); const cur = q.cursor === undefined ? undefined : qstr(q.cursor);
  if (!rid || !RID_RE.test(rid) || keys.some((k) => k !== 'rid' && k !== 'cursor') || cur === null || (cur !== undefined && !CURSOR_RE.test(cur))) return reply(400, { ok: false, reason: 'bad_request' });

  const rl = await checkRateLimit(db, 'merchant_rating_comments', dec.uid, RATE);
  if (!rl || rl.allowed !== true) return reply(429, { ok: false, reason: 'rate_limited', retry_after: (rl && rl.retryAfterSec) || 60 });

  let access;
  try { access = await resolveAccess({ db }, ctx, rid); } catch (_) { access = { ok: false, code: 'unavailable' }; }
  if (access && access.ok !== true && access.code === 'unavailable') return reply(503, { ok: false, reason: 'unavailable', retryable: true });
  if (!access || access.ok !== true || !can(access, CAP)) return reply(403, { ok: false, reason: 'not_authorized' });

  const s = salt();
  if (typeof s !== 'string' || s.length < 32) return reply(503, { ok: false, reason: 'unavailable', retryable: true });
  const key = deriveKey(s);
  let after = null;
  if (cur !== undefined) { after = open(key, cur, rid, dec.uid); if (!after) return reply(400, { ok: false, reason: 'bad_cursor' }); }

  let cut = Number.isSafeInteger(memo.cut) ? memo.cut : null;
  if (cut === null) {
    const c = await readCutover(db);
    if (c.fail) return UNAVAILABLE();
    if (c.cut) { cut = c.cut; memo.cut = c.cut; }
  }
  const firstAbsent = cut === null;

  let query = V2.indexRef(db, rid).orderByKey();
  if (after) query = query.startAfter(after);
  const snap = await query.limitToFirst(CANDIDATES).once('value');
  const entries = [];
  snap.forEach((c) => { entries.push([c.key, c.val()]); });

  const comments = []; let lastScanned = null; let stoppedEarly = false;
  for (let i = 0; i < entries.length && !stoppedEarly; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY);
    const nodes = await Promise.all(chunk.map(([k, oid]) => (typeof oid === 'string' && V2.ORDER_ID_RE.test(oid) && V2.INDEX_KEY_RE.test(k) && k.endsWith(`-${oid}`)
      ? V2.readCountable(db, oid) : null)));
    for (let j = 0; j < chunk.length; j++) {
      lastScanned = chunk[j][0];
      const nd = nodes[j];
      if (nd && nd.restaurant_id === rid && typeof nd.comment === 'string' && nd.comment.trim() && preBand(nd, cut)) {
        comments.push({ comment: nd.comment, store: Number.isInteger(nd.store) && nd.store >= 1 && nd.store <= 5 ? nd.store : null, _nd: nd });
        if (comments.length >= PAGE) { stoppedEarly = j < chunk.length - 1 || i + CONCURRENCY < entries.length; break; }
      }
    }
  }
  // absent before the scan ⇒ ONE re-read after the candidate reads: every candidate was read before it, so an activation it does not
  // see came after them; one it does see is applied to the already-read candidates (a short page still advances the cursor)
  let page = comments;
  if (firstAbsent) {
    const c = await readCutover(db);
    if (c.fail) return UNAVAILABLE();
    if (c.cut) { memo.cut = c.cut; page = comments.filter((x) => preBand(x._nd, c.cut)); }
  }
  // exhausted ⇔ fewer than CANDIDATES keys came back AND every one of them was scanned
  const exhausted = entries.length < CANDIDATES && !stoppedEarly;
  const cursor = exhausted || !lastScanned ? null : seal(key, { v: 1, rid, uid: dec.uid, k: lastScanned });
  return reply(200, { ok: true, comments: page.map(({ comment, store }) => ({ comment, store })), cursor });
}

function makeMerchantRatingComments({ getDatabase, getAuth, checkRateLimit, salt = () => process.env.OTP_SALT }) {
  const memo = {};   // the validated cut-over, per instance (immutable once written; absence is never stored)
  return {
    async getMerchantRatingComments(req, res) {
      res.set('Cache-Control', 'no-store');
      let out;
      try { out = await merchantRatingCommentsCore({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t), checkRateLimit, salt, memo }, req); }
      catch (e) { console.error('getMerchantRatingComments', e && e.message); out = reply(503, { ok: false, reason: 'unavailable', retryable: true }); }
      res.status(out.status).json(out.body);
    },
  };
}

module.exports = { makeMerchantRatingComments, merchantRatingCommentsCore, CANDIDATES, PAGE, CONCURRENCY, CAP, RATE, MAX_CURSOR_CHARS, CURSOR_RE,
  _cursor: { deriveKey, seal, open } };   // the sealing primitives, exported for the deterministic cursor cells (no runtime caller)
