'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 E-P2 + the 2026-10-27 amendment) — the crop rules, PURE.
// Rects are integers in the pixel space of the EXIF-ORIENTED image: x,y ≥ 0, x+w ≤ W, y+h ≤ H. Aspect card 4:3, hero 16:10,
// each within ±0.5 %. Minimum crop card 400×300, hero 496×310 (amended from 512×320, which no 500×440 image could hold).
// Every refusal is the ONE terminal code `bad_crop` (the portal validates crops before sending; the server never trusts it).

const CROP_SPECS = Object.freeze({
  card: Object.freeze({ ratio: 4 / 3, minW: 400, minH: 300 }),
  hero: Object.freeze({ ratio: 16 / 10, minW: 496, minH: 310 }),
});
const ASPECT_TOLERANCE = 0.005;
const MIN_W = 500;
const MIN_H = 440;
const RECT_KEYS = ['h', 'w', 'x', 'y'];

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (detail) => ({ ok: false, code: 'bad_crop', detail });

function rectErrors(name, r, W, H) {
  const spec = CROP_SPECS[name];
  if (!isObj(r)) return `${name}: not an object`;
  const keys = Object.keys(r).sort();
  if (keys.length !== 4 || keys.some((k, i) => k !== RECT_KEYS[i])) return `${name}: keys must be exactly x,y,w,h`;
  if (!RECT_KEYS.every((k) => isInt(r[k]))) return `${name}: non-integer`;
  if (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0) return `${name}: negative or empty`;
  if (r.x + r.w > W || r.y + r.h > H) return `${name}: out of bounds`;
  if (Math.abs(r.w / r.h / spec.ratio - 1) > ASPECT_TOLERANCE) return `${name}: aspect`;
  if (r.w < spec.minW || r.h < spec.minH) return `${name}: under minimum`;
  return null;
}

// → { ok: true } | { ok: false, code: 'bad_crop', detail }
function validateCrops(crops, W, H) {
  if (!isObj(crops)) return refuse('crops: not an object');
  const keys = Object.keys(crops).sort();
  if (keys.length !== 2 || keys[0] !== 'card' || keys[1] !== 'hero') return refuse('crops: keys must be exactly card,hero');
  for (const name of ['card', 'hero']) {
    const e = rectErrors(name, crops[name], W, H);
    if (e) return refuse(e);
  }
  return { ok: true };
}

// the minimum ORIENTED image size (terminal `too_small` below it)
const checkMinSize = (W, H) => isInt(W) && isInt(H) && W >= MIN_W && H >= MIN_H;

module.exports = { validateCrops, checkMinSize, CROP_SPECS, ASPECT_TOLERANCE, MIN_W, MIN_H };
