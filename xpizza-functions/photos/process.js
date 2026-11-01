'use strict';
// DISH PHOTOS A1 step 5 (PLAN-dish-photos r2 §2.2 E-P2, §2.6) — photoProcess's CORE: deps-injected, no HTTP, no globals.
//   1. flag / shape / authorize (every call)
//   2. CLAIM (one transaction on photo_uploads/{uploadId}): the caller's own {rid, uid}; done → the stored result (same crops) or
//      op_conflict; failed → its stored code; processing with a LIVE lease → in_progress; attempts ≥ 3 → terminal unavailable; else
//      state processing + claim {id, lease_until: now + 90 s, crops_hash}, attempts + 1
//   3. PINNED object: metadata once (absent → upload_missing; size > 10 MB → too_large), then a generation-matched, byte-capped
//      download (over the cap → too_large; replaced → upload_missing)
//   4. the pipeline (photos/pipeline.js): its typed errors are TERMINAL; anything else is transient
//   5. registry pre-check: a pid in `deleting` with a live lease (+60 s) → release our lease, in_progress (no objects written)
//   6. completion objects drafts/{rid}/{pid}-{card,hero}.webp, CREATE-ONLY (exists ⇒ same bytes by construction ⇒ fine)
//   7. ONE completion transaction: our claim must still hold; upload → done {pid}; registry create-if-absent (draft) — published
//      is NEVER reset; deleted → draft with fresh generations (reuse); deleting past lease + 60 s → take-over to draft
//   8. only after that commit: delete the upload object (best effort; the bucket lifecycle rule is the backstop)
// Transient failures release the lease and keep `attempts`; the 3rd attempt's failure is terminal `unavailable`.
const crypto = require('crypto');
const { errorBody, ERRORS } = require('./errors');
const { uploadObjectPath, UPLOAD_MAX_BYTES } = require('./signer');

const LEASE_MS = 90 * 1000;
const MAX_ATTEMPTS = 3;
const DELETING_GRACE_MS = 60 * 1000;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const RID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL = new Set(['too_large', 'bad_type', 'too_small', 'bad_crop', 'upload_missing']);

const fail = (code) => ({ status: ERRORS[code].status, body: errorBody(code) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rect = (r) => (isObj(r) ? [r.x, r.y, r.w, r.h] : null);
const cropsHash = (c) => crypto.createHash('sha256').update(JSON.stringify({ card: rect(c.card), hero: rect(c.hero) })).digest('hex').slice(0, 32);
const draftPath = (rid, pid, kind) => `drafts/${rid}/${pid}-${kind}.webp`;
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

async function preview(deps, rid, pid) {
  const exp = deps.now() + PREVIEW_TTL_MS;
  return { card: await deps.signRead(draftPath(rid, pid, 'card'), exp), hero: await deps.signRead(draftPath(rid, pid, 'hero'), exp), expiresAt: exp };
}

async function photoProcessCore(deps, { uid, rid, uploadId, crops }) {
  const { db, storage, now, newClaimId, photosEnabled, authorize, processImage } = deps;
  if (!photosEnabled()) return fail('photos_disabled');
  if (typeof uid !== 'string' || !UID_RE.test(uid) || typeof rid !== 'string' || !RID_RE.test(rid)
    || typeof uploadId !== 'string' || !ID_RE.test(uploadId) || !isObj(crops) || !isObj(crops.card) || !isObj(crops.hero)) return fail('bad_request');
  let auth;
  try { auth = await authorize({ uid, rid }); } catch (_) { auth = { ok: false, code: 'unavailable' }; }
  if (!auth || auth.ok !== true) return fail(auth && auth.code === 'not_authorized' ? 'not_authorized' : 'unavailable');

  const upRef = db.collection('photo_uploads').doc(uploadId);
  const hash = cropsHash(crops);
  const claimId = newClaimId();

  // ── 2. claim ──
  let c;
  try {
    c = await db.runTransaction(async (tx) => {
      const s = await tx.get(upRef);
      if (!s.exists) return { code: 'upload_missing' };
      const d = s.data();
      if (d.rid !== rid || d.uid !== uid) return { code: 'not_authorized' };
      if (d.state === 'done') return d.crops_hash === hash ? { done: d.result.pid } : { code: 'op_conflict' };
      if (d.state === 'failed') return { code: d.code };
      if (d.state === 'processing' && d.claim && d.claim.lease_until > now()) return { code: 'in_progress' };
      if ((d.attempts || 0) >= MAX_ATTEMPTS) { tx.set(upRef, { ...without(d, 'claim'), state: 'failed', code: 'unavailable' }); return { code: 'unavailable' }; }
      tx.set(upRef, { ...d, state: 'processing', claim: { id: claimId, lease_until: now() + LEASE_MS, crops_hash: hash }, attempts: (d.attempts || 0) + 1 });
      return { go: d };
    });
  } catch (_) { return fail('unavailable'); }
  if (c.code) return fail(c.code);
  if (c.done) return { status: 200, body: { pid: c.done, preview: await preview(deps, rid, c.done) } };
  const doc = c.go;
  const attemptsNow = (doc.attempts || 0) + 1;

  // settle the claim (only while it is still ours): release (transient), fail (terminal)
  const settle = async (next) => {
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(upRef); const d = s.exists ? s.data() : null;
        if (!d || !d.claim || d.claim.id !== claimId) return;
        tx.set(upRef, { ...without(d, 'claim'), ...next });
      });
    } catch (_) { /* the lease expires on its own */ }
  };
  const terminal = async (code) => { await settle({ state: 'failed', code }); return fail(code); };
  const transient = async () => {
    if (attemptsNow >= MAX_ATTEMPTS) return terminal('unavailable');
    await settle({ state: 'issued' }); return fail('unavailable');
  };

  // ── 3. the pinned object ──
  const objPath = uploadObjectPath(rid, uploadId);
  let buf;
  try {
    const m = await storage.metadata(objPath);
    if (!m) return terminal('upload_missing');
    if (m.size > UPLOAD_MAX_BYTES) return terminal('too_large');
    buf = await storage.download(objPath, { generation: m.generation, maxBytes: UPLOAD_MAX_BYTES });
  } catch (e) {
    if (e && e.code === 'too_large') return terminal('too_large');
    if (e && e.code === 'generation_mismatch') return terminal('upload_missing');
    return transient();
  }

  // ── 4. the pipeline ──
  let out;
  try { out = await processImage(buf, crops); } catch (e) {
    if (e && e.photo && TERMINAL.has(e.code)) return terminal(e.code);
    return transient();
  }
  const { pid } = out;
  const regRef = db.collection('photo_registry').doc(rid).collection('pids').doc(pid);
  const deletingLive = (r) => r && r.state === 'deleting' && r.claim && now() <= r.claim.lease_until + DELETING_GRACE_MS;

  // ── 5. the registry RESERVATION (codex r1 P1-2) — BEFORE any derivative is created or reused. One transaction: a live `deleting` claim →
  // in_progress; otherwise this processor takes ownership (`reserve: {id, until}`) and bumps last_ref_at, so a sweeper that scanned
  // earlier can no longer claim (its claim requires the scanned last_ref_at, and skips a live reservation). A new pid becomes `draft`;
  // draft / published keep their state; a `deleted` (or expired-`deleting`) pid is REUSED as `draft` with its stale generations cleared —
  // the objects are re-created below and only their live generations are ever recorded.
  try {
    const rsv = await db.runTransaction(async (tx) => {
      const rs = await tx.get(regRef); const r = rs.exists ? rs.data() : null; const t = now();
      if (r && deletingLive(r)) return { code: 'in_progress' };
      const reserve = { id: claimId, until: t + LEASE_MS };
      if (!r) tx.set(regRef, { state: 'draft', last_ref_at: t, generations: {}, created_at: t, reserve });
      else if (r.state === 'draft' || r.state === 'published') tx.set(regRef, { ...r, last_ref_at: t, reserve });
      else tx.set(regRef, { ...without(r, 'claim'), state: 'draft', last_ref_at: t, generations: {}, reserve });
      return {};
    });
    if (rsv.code) { await settle({ state: 'issued' }); return fail('in_progress'); }
  } catch (_) { return transient(); }

  // ── 6. completion objects (create-only) ──
  let gens;
  try {
    const card = await storage.createIfAbsent(draftPath(rid, pid, 'card'), out.card, { contentType: 'image/webp' });
    const hero = await storage.createIfAbsent(draftPath(rid, pid, 'hero'), out.hero, { contentType: 'image/webp' });
    gens = { draft_card: card.generation, draft_hero: hero.generation };
    // codex r1 P1-2: completion records only LIVE generations — both objects must still exist at exactly these generations
    const [mc, mh] = [await storage.metadata(draftPath(rid, pid, 'card')), await storage.metadata(draftPath(rid, pid, 'hero'))];
    if (!mc || !mh || String(mc.generation) !== String(gens.draft_card) || String(mh.generation) !== String(gens.draft_hero)) return transient();
  } catch (_) { return transient(); }

  // ── 7. the completion transaction ──
  let done;
  try {
    done = await db.runTransaction(async (tx) => {
      const [us, rs] = [await tx.get(upRef), await tx.get(regRef)];
      const u = us.exists ? us.data() : null;
      if (u && u.state === 'done') return { pid: u.result.pid };
      if (!u || !u.claim || u.claim.id !== claimId) return { code: 'in_progress' };   // fenced out
      const r = rs.exists ? rs.data() : null;
      const t = now();
      // codex r1 P1-2: only the processor that still OWNS the reservation completes; a deleted / deleting / re-reserved entry is never written
      if (!r || !r.reserve || r.reserve.id !== claimId || (r.state !== 'draft' && r.state !== 'published')) return { code: 'in_progress', release: true };
      tx.set(regRef, { ...without(r, 'reserve'), last_ref_at: t, generations: { ...(r.generations || {}), ...gens } });   // published is NEVER reset
      tx.set(upRef, { ...without(u, 'claim'), state: 'done', result: { pid }, crops_hash: hash });
      return { pid };
    });
  } catch (_) { return transient(); }
  if (done.code) { if (done.release) await settle({ state: 'issued' }); return fail(done.code); }

  // ── 8. after the commit ──
  try { await storage.remove(objPath); } catch (_) { /* the lifecycle rule is the backstop */ }
  return { status: 200, body: { pid: done.pid, preview: await preview(deps, rid, done.pid) } };
}

module.exports = { photoProcessCore, cropsHash, LEASE_MS, MAX_ATTEMPTS, DELETING_GRACE_MS, PREVIEW_TTL_MS };
