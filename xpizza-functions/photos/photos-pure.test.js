'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 / §2.7; BUILD-ORDER A1 step 1) — the PURE pieces: magic-byte sniff, crop rules, the
// error-code table. No I/O. Run: node photos/photos-pure.test.js
const assert = require('assert');
const { sniffImage } = require('./sniff');
const { validateCrops, checkMinSize, CROP_SPECS, MIN_W, MIN_H } = require('./crops');
const E = require('./errors');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const B = (...xs) => Buffer.from(xs);

// ── sniff: JPEG FF D8 FF · PNG 89 50 4E 47 0D 0A 1A 0A · WEBP RIFF????WEBP — nothing else ──
{
  assert.strictEqual(sniffImage(B(0xFF, 0xD8, 0xFF, 0xE0, 0, 0)), 'jpeg', 'SNIFF-JPEG');
  assert.strictEqual(sniffImage(B(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0)), 'png', 'SNIFF-PNG');
  assert.strictEqual(sniffImage(Buffer.concat([Buffer.from('RIFF'), B(1, 2, 3, 4), Buffer.from('WEBPVP8 ')])), 'webp', 'SNIFF-WEBP');
  const bad = [
    ['zero bytes', Buffer.alloc(0)],
    ['two JPEG bytes', B(0xFF, 0xD8)],
    ['truncated PNG signature', B(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A)],
    ['RIFF that is not WEBP (WAVE)', Buffer.concat([Buffer.from('RIFF'), B(1, 2, 3, 4), Buffer.from('WAVE')])],
    ['GIF89a', Buffer.from('GIF89a\x01\x00\x01\x00')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['HTML named .jpg', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['HEIC (ftypheic)', Buffer.concat([B(0, 0, 0, 0x18), Buffer.from('ftypheic'), Buffer.alloc(8)])],
    ['not a buffer', 'FFD8FF'],
  ];
  for (const [label, buf] of bad) assert.strictEqual(sniffImage(buf), null, `SNIFF-REFUSES ${label}`);
  ok('sniff: JPEG / PNG / WEBP by magic bytes only; zero / truncated / WAVE-RIFF / GIF / SVG / HTML / HEIC / non-buffer → null');
}

// ── crops: integer rects in the ORIENTED space; bounds; aspect within ±0.5 %; minimums ──
{
  assert.deepStrictEqual([CROP_SPECS.card.ratio, CROP_SPECS.hero.ratio, CROP_SPECS.card.minW, CROP_SPECS.card.minH, CROP_SPECS.hero.minW, CROP_SPECS.hero.minH], [4 / 3, 16 / 10, 400, 300, 496, 310], 'CROP-SPECS (hero minimum amended to 496×310, 2026-10-27)');
  const W = 1600, H = 1200;
  const good = { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 100, y: 200, w: 1280, h: 800 } };
  assert.deepStrictEqual(validateCrops(good, W, H), { ok: true }, 'CROP-OK');
  // the ±0.5 % aspect band: 4:3 at w=1000 → h ∈ [~746.3, ~753.8]
  assert.ok(validateCrops({ ...good, card: { x: 0, y: 0, w: 1000, h: 747 } }, W, H).ok, 'CROP-ASPECT-INSIDE-BAND');
  assert.ok(!validateCrops({ ...good, card: { x: 0, y: 0, w: 1000, h: 740 } }, W, H).ok, 'CROP-ASPECT-OUTSIDE-BAND');
  // the amended hero minimum is reachable on the SMALLEST accepted image (500×440): 496×310 fits, and both crops fit together
  assert.deepStrictEqual(validateCrops({ card: { x: 0, y: 0, w: 500, h: 375 }, hero: { x: 0, y: 0, w: 496, h: 310 } }, 500, 440), { ok: true }, 'CROP-HERO-MIN-ON-MIN-IMAGE');
  const bad = [
    ['missing hero', { card: good.card }],
    ['non-object', null],
    ['extra key', { ...good, thumb: good.card }],
    ['non-integer', { ...good, card: { x: 0.5, y: 0, w: 800, h: 600 } }],
    ['string number', { ...good, card: { x: '0', y: 0, w: 800, h: 600 } }],
    ['negative x', { ...good, card: { x: -1, y: 0, w: 800, h: 600 } }],
    ['out of bounds x+w', { ...good, card: { x: 801, y: 0, w: 800, h: 600 } }],
    ['out of bounds y+h', { ...good, hero: { x: 0, y: 401, w: 1280, h: 800 } }],
    ['wrong aspect card', { ...good, card: { x: 0, y: 0, w: 800, h: 800 } }],
    ['wrong aspect hero', { ...good, hero: { x: 0, y: 0, w: 1280, h: 960 } }],
    ['card under minimum', { ...good, card: { x: 0, y: 0, w: 396, h: 297 } }],
    ['hero under minimum', { ...good, hero: { x: 0, y: 0, w: 480, h: 300 } }],
    ['zero size', { ...good, card: { x: 0, y: 0, w: 0, h: 0 } }],
    ['rect with an extra key', { ...good, card: { x: 0, y: 0, w: 800, h: 600, r: 1 } }],
  ];
  for (const [label, c] of bad) {
    const r = validateCrops(c, W, H);
    assert.strictEqual(r.ok, false, `CROP-REFUSES ${label}`);
    assert.strictEqual(r.code, 'bad_crop', `CROP-CODE ${label}`);
  }
  ok('crops: card 4:3 ≥400×300, hero 16:10 ≥496×310, integer, in bounds, aspect ±0.5 %, exact keys — every refusal is bad_crop');
}

// ── the minimum oriented size: 500×440 ──
{
  assert.deepStrictEqual([MIN_W, MIN_H], [500, 440], 'MIN-SIZE-CONST');
  assert.strictEqual(checkMinSize(500, 440), true, 'MIN-SIZE-500x440-OK');
  assert.strictEqual(checkMinSize(499, 440), false, 'MIN-SIZE-499x440');
  assert.strictEqual(checkMinSize(500, 439), false, 'MIN-SIZE-500x439');
  ok('minimum oriented size 500×440: 499×440 and 500×439 refused, 500×440 accepted');
}

// ── the error-code table: 1:1 with the approved copy (P5 / P6 in MOCKUP-portal-dish-photo.html) ──
{
  const P5 = 'No se pudo subir la foto.';
  const want = {
    too_large: { status: 400, retryable: false, copy: 'Ese archivo pesa más de 10 MB. Elegí una foto más liviana.', frame: 'P6a' },
    bad_type: { status: 400, retryable: false, copy: 'Ese archivo no es JPG, PNG ni WEBP.', frame: 'P6b' },
    too_small: { status: 400, retryable: false, copy: 'Esa foto es muy pequeña: necesita al menos 500×440 px.', frame: 'P6c' },
    unavailable: { status: 503, retryable: true, copy: P5, frame: 'P5' },
    upload_missing: { status: 404, retryable: false, copy: P5, frame: 'P5' },
    in_progress: { status: 409, retryable: true, copy: P5, frame: 'P5' },
    rate_limited: { status: 429, retryable: true, copy: P5, frame: 'P5' },
  };
  for (const [code, w] of Object.entries(want)) assert.deepStrictEqual(E.ERRORS[code], w, `ERR-TABLE ${code}`);
  // the remaining codes: no customer-facing photo copy of their own
  for (const code of ['bad_crop', 'op_conflict', 'not_authorized', 'photo_change_disabled', 'photo_publish_failed', 'photo_unavailable', 'photos_disabled', 'bad_request'])
    assert.ok(E.ERRORS[code] && Number.isInteger(E.ERRORS[code].status), `ERR-TABLE-HAS ${code}`);
  assert.strictEqual(E.ERRORS.photo_publish_failed.retryable, true, 'ERR-PUBLISH-FAILED-RETRYABLE (Q2)');
  assert.strictEqual(E.ERRORS.photo_change_disabled.status, 409, 'ERR-CHANGE-DISABLED-409 (Q2)');
  assert.deepStrictEqual([E.ERRORS.photos_disabled.status, E.ERRORS.photos_disabled.retryable], [409, false], 'ERR-PHOTOS-DISABLED (§2.8 flag off)');
  assert.deepStrictEqual([E.ERRORS.bad_request.status, E.ERRORS.bad_request.retryable, E.ERRORS.bad_request.copy], [400, false, null], 'ERR-BAD-REQUEST (malformed input; the portal never sends it)');
  // the body helper: retryable:true ONLY on the retryable codes; never a free-text detail
  assert.deepStrictEqual(E.errorBody('unavailable'), { error: 'unavailable', retryable: true }, 'ERR-BODY-RETRYABLE');
  assert.deepStrictEqual(E.errorBody('too_small'), { error: 'too_small' }, 'ERR-BODY-TERMINAL');
  assert.throws(() => E.errorBody('nope'), /unknown photo error code/, 'ERR-BODY-UNKNOWN');
  const err = E.photoError('bad_type', 'decode');
  assert.ok(err instanceof Error && err.code === 'bad_type' && err.photo === true, 'ERR-PHOTO-ERROR');
  ok('error table: P6a/b/c and P5 copy 1:1, statuses, retryable on unavailable/rate_limited/in_progress/photo_publish_failed only; body + Error helpers');
}

console.log(`photos-pure: OK (${n})`);
