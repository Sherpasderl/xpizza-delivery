'use strict';
// DISH PHOTOS A2 step 9 (PLAN-dish-photos r2 §2.2 E-P3 + amendment 2026-10-27; advisor rulings #2/#3) — the fields getEditableCatalog
// ADDS. Each one is OMITTED when empty / off, so a restaurant without photo data gets today's response byte-for-byte.
//   photos           the draft map (exactly what editCatalog stored)
//   photoPreviews    {[pid]: {card, hero, expiresAt?}} for EVERY pid the draft map references AND every pid of the ACTIVE version's
//                    meta/photos (amendment), resolved by the pid's REGISTRY state, never by version membership (Codex r2 P2-3):
//                      published → public URLs https://storage.googleapis.com/<the public bucket>/photos/{rid}/{pid}-*.webp, no expiry
//                      draft     → 1 h signed GETs of drafts/{rid}/{pid}-*.webp (+ expiresAt; the portal re-reads at expiresAt − 5 min)
//                      anything else (deleting / deleted / no doc) → no preview (the portal shows P5, never a broken image)
//                    No public bucket configured (A0 pending) → no public URL is ever emitted. A signing failure omits that one preview.
//   legacyPreviews   {[itemKey]: {card}} for every item whose legacy image the public menu serves today (public-photos.js's own rule,
//                    called per item — that module is untouched): the record photo_registry/{rid}/legacy/{sha256(url)[:32]} written by
//                    the owner's backfill tool gives the PUBLIC-bucket copy; no record (or no bucket) → the key with NO url (neutral
//                    fallback). Firestore only — reads never contact Storage (§2.8). Shown only while in use (flag on or photo
//                    data present) so the dark deploy changes no response.
//   photosEnabled    true only while PHOTOS_UPLOADS is on (B shows the uploader only then)
//   photosPending    true when the draft map differs from the active one (the editor's «a rename publishes alone» hint)
const crypto = require('crypto');
const { buildPhotos } = require('../catalog/public-photos');
const PS = require('./photo-state');
const PREVIEW_TTL_MS = 60 * 60 * 1000;

function legacyUrlFor(item, base) {
  if (!base || !item || !item.display || item.display.id === undefined || item.display.id === null) return null;
  try {
    const out = buildPhotos({ items: [item] }, base);
    const e = out[String(item.display.id)];
    return e && typeof e.card === 'string' ? e.card : null;
  } catch (_) { return null; }
}
const legacyHashOf = (url) => crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
const publicUrl = (bucket, rid, pid, kind) => `https://storage.googleapis.com/${bucket}/photos/${rid}/${pid}-${kind}.webp`;

async function editablePhotoFields({ rid, now, enabled, publicBucket, legacyBase, items, draftMap, activeEntries, registry, legacyRecords, signRead }) {
  const out = {};
  if (draftMap && Object.keys(draftMap).length) out.photos = draftMap;

  const pids = [...new Set([...PS.referencedPids(draftMap), ...PS.referencedPids(activeEntries)])].sort();
  const previews = {};
  for (const pid of pids) {
    const st = registry && registry[pid];
    if (st === 'published') {
      if (publicBucket) previews[pid] = { card: publicUrl(publicBucket, rid, pid, 'card'), hero: publicUrl(publicBucket, rid, pid, 'hero') };
    } else if (st === 'draft') {
      const exp = now + PREVIEW_TTL_MS;
      try { previews[pid] = { card: await signRead(`drafts/${rid}/${pid}-card.webp`, exp), hero: await signRead(`drafts/${rid}/${pid}-hero.webp`, exp), expiresAt: exp }; }
      catch (e) { console.warn('photo_preview_sign_failed', JSON.stringify({ rid, pid, error: String((e && e.message) || e).slice(0, 120) })); }
    }
  }
  if (Object.keys(previews).length) out.photoPreviews = previews;

  const legacy = {};
  for (const it of Array.isArray(items) ? items : []) {
    const url = legacyUrlFor(it, legacyBase);
    if (!url || typeof it.key !== 'string') continue;
    const rec = legacyRecords && legacyRecords[legacyHashOf(url)];
    legacy[it.key] = publicBucket && rec && typeof rec.card_url === 'string' ? { card: rec.card_url } : {};
  }
  // DARK GATE (5f, disclosed): legacy images exist on most menus today, so emitting this unconditionally would change every
  // response at the dark deploy. It is shown only when it can be used — the uploader is on, or photo data already exists.
  const inUse = enabled === true || pids.length > 0 || !!(draftMap && Object.keys(draftMap).length) || !!(activeEntries && Object.keys(activeEntries).length);
  if (inUse && Object.keys(legacy).length) out.legacyPreviews = legacy;

  if (enabled === true) out.photosEnabled = true;
  if (!PS.sameStates(draftMap, activeEntries)) out.photosPending = true;
  return out;
}

module.exports = { editablePhotoFields, legacyUrlFor, legacyHashOf, publicUrl, PREVIEW_TTL_MS };
