'use strict';
// DISH PHOTOS A2 step 12b — photos/legacy-encode.js: a legacy dish image → a centre 4:3 800×600 WEBP, metadata-free, decoded only as its
// sniffed format (JPEG / PNG / WEBP), first frame, 40 MP cap — but WITHOUT the upload's 500×440 / crop rules (advisor ruling #4).
// Run: node photos/legacy-encode.test.js
const assert = require('assert');
const sharp = require('sharp');
const { encodeLegacy } = require('./legacy-encode');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const WATCHDOG = setTimeout(() => { console.error('legacy-encode: FAILED — watchdog (120 s)'); process.kill(process.pid, 'SIGKILL'); }, 120000); WATCHDOG.unref();
(async () => {
  for (const [w, h, fmt] of [[1200, 400, 'jpeg'], [300, 900, 'png'], [200, 150, 'webp']]) {
    const src = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 200, b: 30 } } })[fmt]().withMetadata({ exif: { IFD0: { Artist: 'tb' } } }).toBuffer();
    const out = await encodeLegacy(src);
    const m = await sharp(out).metadata();
    assert.deepStrictEqual([m.format, m.width, m.height], ['webp', 800, 600], `LEGACY-ENC-800x600 ${w}x${h} ${fmt}`);
    assert.ok(!m.exif, `LEGACY-ENC-NO-METADATA ${fmt}`);
  }
  ok('JPEG / PNG / WEBP of any size or aspect (incl. a small 200×150 — no minimum) → a centre 4:3 800×600 WEBP, metadata dropped');
  for (const [label, buf] of [['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')], ['gif', Buffer.from('GIF89a......')], ['empty', Buffer.alloc(0)]]) {
    await assert.rejects(() => encodeLegacy(buf), /bad_type/, `LEGACY-ENC-REFUSED ${label}`);
  }
  ok('SVG / GIF / empty → bad_type (decoded only as a sniffed JPEG / PNG / WEBP)');
  console.log(`legacy-encode: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('legacy-encode: FAILED —', e && e.stack || e); process.exit(1); });
