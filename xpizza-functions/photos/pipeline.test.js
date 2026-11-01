'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 «Processing», §2.7, §4.1 «Image»; BUILD-ORDER A1 step 2) — the sharp pipeline over REAL
// encoded fixtures built here with sharp itself (deterministic; no binary fixture files in the repo).
// Run: node photos/pipeline.test.js
const assert = require('assert');
const sharp = require('sharp');
// a spy on the module the pipeline will lazily require: every sharp(...) construction is counted, then delegated
let SHARP_CALLS = 0;
{ const real = sharp; const spy = function (...a) { SHARP_CALLS += 1; return real(...a); }; Object.assign(spy, real); require.cache[require.resolve('sharp')].exports = spy; }
const { processImage, PIPELINE } = require('./pipeline');
const { sniffImage } = require('./sniff');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// WATCHDOG (advisor ruling 2026-10-27, after mutants p4/p8 hung at 0 % CPU under a 100+ load): the suite normally takes ~10 s; past
// 120 s it reports a named failure and SIGKILLs itself, so a wedged native (libvips) thread can never turn a mutant run into a hang
const WATCHDOG = setTimeout(() => { console.error('pipeline: FAILED — watchdog (120 s)'); process.kill(process.pid, 'SIGKILL'); }, 120000);
WATCHDOG.unref();
const FULL = { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 0, y: 0, w: 960, h: 600 } };
// a non-uniform image (a gradient + a marker block) so crops and orientation are observable in the pixels
async function photo(w, h, fmt = 'jpeg', opts = {}) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3; raw[i] = (x * 255 / w) | 0; raw[i + 1] = (y * 255 / h) | 0; raw[i + 2] = (x < 40 && y < 40) ? 255 : 0;
  }
  let s = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  if (opts.exif) s = s.withExif(opts.exif);
  if (opts.orientation) s = s.withMetadata({ orientation: opts.orientation });
  return s[fmt](fmt === 'jpeg' ? { quality: 90 } : {}).toBuffer();
}
const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || `UNCODED:${e.message}`; } };

(async () => {
  assert.deepStrictEqual([PIPELINE.LIMIT_INPUT_PIXELS, PIPELINE.CARD, PIPELINE.HERO], [40000000, [800, 600], [1280, 800]], 'PIPE-CONSTANTS');

  // ── the happy path: JPEG / PNG / WEBP in → two WEBP out at the exact sizes, a content-id pid, deterministic ──
  for (const fmt of ['jpeg', 'png', 'webp']) {
    const src = await photo(1600, 1200, fmt);
    const r = await processImage(src, { card: { x: 0, y: 0, w: 1600, h: 1200 }, hero: { x: 0, y: 100, w: 1600, h: 1000 } });
    for (const [k, [w, h]] of [['card', [800, 600]], ['hero', [1280, 800]]]) {
      const m = await sharp(r[k]).metadata();
      assert.deepStrictEqual([m.format, m.width, m.height], ['webp', w, h], `PIPE-OUT ${fmt} ${k}`);
      assert.strictEqual(sniffImage(r[k]), 'webp', `PIPE-OUT-SNIFF ${fmt} ${k}`);
    }
    assert.match(r.pid, /^[0-9a-f]{32}$/, `PIPE-PID-SHAPE ${fmt}`);
    const again = await processImage(src, { card: { x: 0, y: 0, w: 1600, h: 1200 }, hero: { x: 0, y: 100, w: 1600, h: 1000 } });
    assert.ok(again.card.equals(r.card) && again.hero.equals(r.hero) && again.pid === r.pid, `PIPE-DETERMINISTIC ${fmt}`);
  }
  const a = await photo(1600, 1200); const b = await photo(1600, 1200, 'png');
  const ra = await processImage(a, FULL); const rb = await processImage(a, { card: { x: 8, y: 0, w: 800, h: 600 }, hero: FULL.hero });
  assert.notStrictEqual(ra.pid, rb.pid, 'PIPE-PID-FOLLOWS-CONTENT (another crop → another pid)');
  const rh = await processImage(a, { card: FULL.card, hero: { x: 16, y: 0, w: 960, h: 600 } });
  assert.notStrictEqual(ra.pid, rh.pid, 'PIPE-PID-COVERS-HERO (a hero-only change → another pid)');
  assert.ok((await processImage(b, FULL)).pid, 'png processes');
  ok('JPEG / PNG / WEBP → card 800×600 + hero 1280×800 WEBP; pid = 32-hex content id, deterministic, follows the crop');

  // ── metadata never survives: a GPS-tagged phone-style JPEG ──
  {
    const gps = await photo(1600, 1200, 'jpeg', { exif: { IFD0: { Make: 'PhoneCo', Model: 'P1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '15/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '88/1 1/1 0/1' } } });
    const mi = await sharp(gps).metadata();
    assert.ok(mi.exif && mi.exif.includes(Buffer.from('PhoneCo')), 'premise: the input carries EXIF (make + GPS IFD)');
    const r = await processImage(gps, FULL);
    for (const k of ['card', 'hero']) {
      const m = await sharp(r[k]).metadata();
      assert.ok(!m.exif && !m.xmp && !m.icc && !m.iptc, `PIPE-NO-METADATA ${k}`);
      assert.ok(!r[k].includes(Buffer.from('PhoneCo')) && !r[k].includes(Buffer.from('GPS')), `PIPE-NO-EXIF-BYTES ${k}`);
    }
    ok('EXIF/GPS present in the input, absent from both outputs (no exif / xmp / icc / iptc; no make or GPS bytes)');
  }

  // ── orientation 6 (rotate 90° CW): crops are in the ORIENTED space ──
  {
    const stored = await photo(1200, 1600, 'jpeg', { orientation: 6 });   // stored 1200×1600, displays as 1600×1200
    const m = await sharp(stored).metadata();
    assert.deepStrictEqual([m.width, m.height, m.orientation], [1200, 1600, 6], 'premise: stored portrait with orientation 6');
    const r = await processImage(stored, FULL);   // FULL is valid only in the oriented 1600×1200 space
    assert.match(r.pid, /^[0-9a-f]{32}$/, 'PIPE-ORIENT-ACCEPTS-ORIENTED-CROPS');
    assert.strictEqual(await codeOf(processImage(stored, { card: { x: 0, y: 0, w: 1200, h: 900 }, hero: { x: 0, y: 0, w: 1440, h: 900 } })), 'ok', 'oriented 1600-wide hero fits');
    assert.strictEqual(await codeOf(processImage(stored, { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 0, y: 0, w: 1920, h: 1200 } })), 'bad_crop', 'PIPE-ORIENT-BOUNDS-ARE-ORIENTED (1920 > oriented width)');
    ok('orientation 6: the image is auto-oriented first; crop bounds are checked in the oriented 1600×1200 space');
  }

  // ── terminal codes ──
  {
    const jpg = await photo(1600, 1200);
    const gif = await sharp({ create: { width: 600, height: 500, channels: 3, background: '#c00' } }).gif().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><rect width="900" height="700"/></svg>');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
    const html = Buffer.from('<!doctype html><title>x</title><script>alert(1)</script>');
    const truncated = jpg.subarray(0, Math.floor(jpg.length / 2));
    for (const [label, buf] of [['GIF', gif], ['SVG', svg], ['HEIC', heic], ['HTML named .jpg', html], ['zero bytes', Buffer.alloc(0)], ['truncated JPEG', truncated]])
      assert.strictEqual(await codeOf(processImage(buf, FULL)), 'bad_type', `PIPE-BAD-TYPE ${label}`);
    // §2.7: a non-sniffed input never reaches libvips at all (it would parse SVG / HEIC / GIF headers if asked)
    for (const [label, buf] of [['GIF', gif], ['SVG', svg], ['HEIC', heic], ['HTML named .jpg', html], ['zero bytes', Buffer.alloc(0)]]) {
      const before = SHARP_CALLS; await codeOf(processImage(buf, FULL));
      assert.strictEqual(SHARP_CALLS, before, `PIPE-NO-DECODE-BEFORE-SNIFF ${label}`);
    }
    // a PNG whose bytes were renamed .jpg is still a PNG (sniffed, decoded AS png) — names never matter
    assert.strictEqual(await codeOf(processImage(await photo(1600, 1200, 'png'), FULL)), 'ok', 'PIPE-SNIFF-NOT-NAME');
    for (const [w, h, want] of [[499, 440, 'too_small'], [500, 439, 'too_small'], [500, 440, 'ok']]) {
      const img = await photo(w, h);
      const crops = { card: { x: 0, y: 0, w: 400, h: 300 }, hero: { x: 0, y: 0, w: 496, h: 310 } };
      assert.strictEqual(await codeOf(processImage(img, crops)), want, `PIPE-MIN-SIZE ${w}x${h}`);
    }
    assert.strictEqual(await codeOf(processImage(jpg, { card: { x: 0, y: 0, w: 800, h: 800 }, hero: FULL.hero })), 'bad_crop', 'PIPE-BAD-CROP');
    ok('bad_type: GIF / SVG / HEIC / HTML / zero / truncated; too_small: 499×440 + 500×439 (500×440 ok); bad_crop on a wrong aspect');
  }

  // ── decompression bomb: 40 MP accepted, 40 MP + 1 refused before decode (too_large) ──
  {
    const atLimit = await sharp({ create: { width: 8000, height: 5000, channels: 3, background: '#888' } }).png({ compressionLevel: 9 }).toBuffer();
    const over = await sharp({ create: { width: 40000001, height: 1, channels: 3, background: '#888' } }).png({ compressionLevel: 9 }).toBuffer().catch(() => null)
      || await sharp({ create: { width: 8001, height: 5000, channels: 3, background: '#888' } }).png({ compressionLevel: 9 }).toBuffer();
    const crops = { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 0, y: 0, w: 1280, h: 800 } };
    assert.strictEqual(await codeOf(processImage(atLimit, crops)), 'ok', 'PIPE-40MP-OK');
    assert.strictEqual(await codeOf(processImage(over, crops)), 'too_large', 'PIPE-40MP-PLUS-REFUSED');
    ok('limitInputPixels: an 8000×5000 (40 MP) image processes; one over 40 MP is refused as too_large');
  }

  // ── animated WEBP → the FIRST frame only ──
  {
    const red = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const blue = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#0000ff' } }).png().toBuffer();
    const anim = await sharp([red, blue], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const ma = await sharp(anim, { pages: -1 }).metadata();
    assert.strictEqual(ma.pages, 2, 'premise: a 2-frame animated WEBP');
    const r = await processImage(anim, { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 0, y: 50, w: 800, h: 500 } });
    const { data } = await sharp(r.card).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 200 && data[2] < 60, `PIPE-ANIMATED-FIRST-FRAME (red, got ${data[0]},${data[1]},${data[2]})`);
    assert.strictEqual((await sharp(r.card).metadata()).pages || 1, 1, 'PIPE-OUTPUT-SINGLE-FRAME');
    // the oriented size is ONE frame (800×600), not the stacked frames: a crop reaching into a second frame is out of bounds
    assert.strictEqual(await codeOf(processImage(anim, { card: { x: 0, y: 400, w: 400, h: 300 }, hero: { x: 0, y: 0, w: 496, h: 310 } })), 'bad_crop', 'PIPE-ANIMATED-HEIGHT-IS-ONE-FRAME');
    ok('animated WEBP: only the first frame is decoded; outputs are single-frame');
  }

  // ── polyglot: a JPEG with an HTML/script payload appended → sanitised by re-encoding (only decoded pixels survive) ──
  {
    const poly = Buffer.concat([await photo(1600, 1200), Buffer.from('<html><script>alert("x")</script></html>PK\x03\x04payload')]);
    assert.strictEqual(sniffImage(poly), 'jpeg', 'premise: the polyglot sniffs as JPEG');
    const r = await processImage(poly, FULL);
    for (const k of ['card', 'hero']) {
      assert.ok(!r[k].includes(Buffer.from('<script')) && !r[k].includes(Buffer.from('PK\x03\x04')), `PIPE-POLYGLOT-SANITISED ${k}`);
      assert.strictEqual((await sharp(r[k]).metadata()).format, 'webp', `PIPE-POLYGLOT-CLEAN-WEBP ${k}`);
    }
    ok('polyglot JPEG+HTML+ZIP → two clean WEBPs: no script, no zip bytes (sanitised by re-encode, not "detected")');
  }

  console.log(`pipeline: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('pipeline: FAILED —', e && e.stack || e); process.exit(1); });
