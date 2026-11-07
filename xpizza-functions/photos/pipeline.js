'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 «Processing» / «Completion», §2.7) — bytes in → { card, hero, pid } out, or a typed
// terminal error (too_large / bad_type / too_small / bad_crop). Pure apart from CPU: no I/O, no clock, no randomness.
//   1. sniff the magic bytes; decode AS that format only (libvips would decode SVG / HEIC / GIF if asked) → else bad_type
//   2. header check: width × (page) height > 40 MP → too_large BEFORE any pixel is decoded; libvips' limitInputPixels backs it up
//   3. decode the FIRST page only, failOn:'error' (truncated / corrupt → bad_type), auto-orient (EXIF), into a raw pixel buffer —
//      from here on only decoded pixels exist: EXIF / XMP / ICC / GPS and any appended polyglot payload are gone
//   4. the oriented size must be ≥ 500×440 (too_small); the crops must pass crops.js in that oriented space (bad_crop)
//   5. card 800×600 + hero 1280×800, encoded WEBP afresh (withMetadata is never called)
//   6. pid = a content id of the two outputs (identical inputs + crops ⇒ identical pid, which makes completion idempotent)
// sharp is required LAZILY inside processImage (advisor ruling 2026-10-26): loading this module costs nothing on any order path.
const crypto = require('crypto');
const { sniffImage } = require('./sniff');
const { validateCrops, checkMinSize } = require('./crops');
const { photoError } = require('./errors');

const PIPELINE = Object.freeze({
  LIMIT_INPUT_PIXELS: 40000000,
  CARD: Object.freeze([800, 600]),
  HERO: Object.freeze([1280, 800]),
  WEBP: Object.freeze({ quality: 82, effort: 4 }),
});

const classify = (e) => (/pixel limit/i.test(String(e && e.message)) ? photoError('too_large', 'pixel limit') : photoError('bad_type', String(e && e.message).slice(0, 120)));

async function processImage(buf, crops) {
  const fmt = sniffImage(buf);
  if (!fmt) throw photoError('bad_type', 'magic bytes');
  const sharp = require('sharp');
  const opts = { limitInputPixels: PIPELINE.LIMIT_INPUT_PIXELS, failOn: 'error', pages: 1, page: 0 };

  let meta;
  try { meta = await sharp(buf, opts).metadata(); } catch (e) { throw classify(e); }
  if (meta.format !== fmt) throw photoError('bad_type', `sniffed ${fmt}, decoded ${meta.format}`);
  const pageH = meta.pageHeight || meta.height;
  if (!(meta.width > 0 && pageH > 0)) throw photoError('bad_type', 'no dimensions');
  if (meta.width * pageH > PIPELINE.LIMIT_INPUT_PIXELS) throw photoError('too_large', 'over 40 MP');

  let data, info;
  try { ({ data, info } = await sharp(buf, opts).rotate().raw().toBuffer({ resolveWithObject: true })); }
  catch (e) { throw classify(e); }
  const W = info.width, H = info.height;
  if (!checkMinSize(W, H)) throw photoError('too_small', `${W}x${H}`);
  const v = validateCrops(crops, W, H);
  if (!v.ok) throw photoError('bad_crop', v.detail);

  const base = sharp(data, { raw: { width: W, height: H, channels: info.channels } });
  const render = (r, [w, h]) => base.clone().extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .resize(w, h, { fit: 'fill' }).webp({ ...PIPELINE.WEBP }).toBuffer();
  const [card, hero] = await Promise.all([render(crops.card, PIPELINE.CARD), render(crops.hero, PIPELINE.HERO)]);

  const h = crypto.createHash('sha256');
  for (const b of [card, hero]) { const len = Buffer.alloc(4); len.writeUInt32BE(b.length); h.update(len); h.update(b); }
  return { card, hero, pid: h.digest('hex').slice(0, 32) };
}

module.exports = { processImage, PIPELINE };
