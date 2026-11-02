'use strict';
// DISH PHOTOS A2 step 12b (PLAN-dish-photos amendment 2026-10-27; advisor ruling #4) — the LEGACY BACKFILL core (owner-run once at the
// photos launch). For one restaurant: every legacy dish image the public menu serves today (photos/editable-photos.js legacyUrlFor =
// catalog/public-photos.js's own rule) is fetched, re-encoded (centre 4:3 → 800×600 WEBP, metadata-free — NO 500×440 / crop rules: legacy
// images predate them), and:
//   DRY RUN (default) → nothing is uploaded or recorded; each before/after pair goes to the contact sheet for the owner to REVIEW first
//                       (cropping changes images restaurants already show).
//   --apply           → a CREATE-ONLY upload to the PUBLIC bucket photos/{rid}/legacy/<hash>-card.webp, THEN the Firestore record
//                       photo_registry/{rid}/legacy/{hash} = {card_url, source, generation, created_at} that getEditableCatalog resolves.
// <hash> = sha256 of the canonical legacy URL (first 32 hex). Idempotent: an existing record = already_present (no fetch, no upload).
// The same image named by two dishes is handled once. Any fetch / decode failure = unresolvable (reported, never uploaded).
const { legacyUrlFor, legacyHashOf } = require('../photos/editable-photos');

async function backfillRid(rid, { apply }, d) {
  const base = d.legacyBase(rid);
  if (!base) throw new Error(`no_order_site_base: ${rid} has no single order-site origin in the platform manifest`);
  const bucket = (d.publicBucket || '').trim();
  if (apply && !bucket) throw new Error('no_public_bucket: --apply needs a public bucket (public_bucket in platform/photos.json — the A0 public photo bucket)');
  const items = await d.readItems(rid);
  const rows = []; const seen = new Set();
  const counts = apply ? { copied: 0, already_present: 0, unresolvable: 0, same_image: 0 } : { would_copy: 0, already_present: 0, unresolvable: 0, same_image: 0 };
  for (const it of items) {
    const url = legacyUrlFor(it, base);
    if (!url) continue;
    const hash = legacyHashOf(url);
    if (seen.has(hash)) { rows.push({ key: it.key, hash, url, status: 'same_image' }); counts.same_image++; continue; }
    seen.add(hash);
    if (await d.readRecord(rid, hash)) { rows.push({ key: it.key, hash, url, status: 'already_present' }); counts.already_present++; continue; }
    let before, after;
    try { before = await d.fetchImage(url); after = await d.encode(before); }
    catch (e) { rows.push({ key: it.key, hash, url, status: 'unresolvable', error: String((e && e.message) || e).slice(0, 120) }); counts.unresolvable++; continue; }
    if (!apply) { rows.push({ key: it.key, hash, url, status: 'would_copy', before, after }); counts.would_copy++; continue; }
    const up = await d.upload(rid, hash, after);
    await d.writeRecord(rid, hash, { card_url: `https://storage.googleapis.com/${bucket}/photos/${rid}/legacy/${hash}-card.webp`, source: url, generation: String(up.generation), created_at: d.now() });
    rows.push({ key: it.key, hash, url, status: 'copied', before, after }); counts.copied++;
  }
  if (!apply && d.writeSheet) await d.writeSheet(rid, rows);
  return { rid, counts, rows: rows.map(({ before, after, ...r }) => r) };   // eslint-disable-line no-unused-vars
}

// the bucket GATE, before ANY read, in BOTH modes (codex photos-config r1 #1): the committed photos config must RESOLVE for the project —
// any refusal (no private entry, a project conflict, an unusable config) → { ok: false, reason } and the CLI refuses. Only a resolved
// config whose public bucket is simply NOT configured yields bucket '' (fine for the dry run; --apply then refuses in backfillRid).
function backfillBucketGate(resolve) {
  try { return { ok: true, bucket: resolve().public || '' }; } catch (e) {
    if (e && e.photosConfig) return { ok: false, reason: e.code };
    throw e;
  }
}

module.exports = { backfillRid, backfillBucketGate };
