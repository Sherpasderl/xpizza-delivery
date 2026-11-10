'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 «Processing», §2.7) — the ONLY gate on what a stored upload may be decoded as.
// Magic bytes, never the declared Content-Type, never a file name: JPEG FF D8 FF · PNG 89 50 4E 47 0D 0A 1A 0A · WEBP RIFF????WEBP.
// Anything else (GIF, SVG, HTML, HEIC, a WAVE RIFF, truncated, empty) → null, which the pipeline turns into terminal `bad_type`.
// The pipeline then decodes the bytes AS the sniffed format only (libvips would happily decode SVG or HEIC if asked).

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

module.exports = { sniffImage };
