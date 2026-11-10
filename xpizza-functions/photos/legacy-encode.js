'use strict';
// DISH PHOTOS A2 step 12b (advisor ruling #4) — re-encode a LEGACY dish image for the public bucket: decoded only as its sniffed format
// (photos/sniff.js: JPEG / PNG / WEBP), first frame, 40 MP cap, EXIF-oriented; a CENTRE 4:3 cover crop to 800×600; WEBP q82; metadata
// dropped (withMetadata never called). Unlike an upload (photos/pipeline.js) there is NO 500×440 minimum and NO merchant crop: legacy
// images predate both, and the owner reviews every result on the dry run's contact sheet before --apply. sharp is required lazily here.
const { sniffImage } = require('./sniff');
const MAX_PIXELS = 40 * 1000 * 1000;

async function encodeLegacy(buf) {
  const kind = Buffer.isBuffer(buf) && buf.length ? sniffImage(buf) : null;
  if (!kind) throw Object.assign(new Error('bad_type: not a JPEG, PNG or WEBP'), { code: 'bad_type' });
  const sharp = require('sharp');
  const img = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1 });
  const meta = await img.metadata();
  if (meta.format !== kind) throw Object.assign(new Error(`bad_type: sniffed ${kind}, decoded ${meta.format}`), { code: 'bad_type' });
  return img.rotate().resize(800, 600, { fit: 'cover', position: 'centre' }).webp({ quality: 82, effort: 4 }).toBuffer();
}

module.exports = { encodeLegacy };
