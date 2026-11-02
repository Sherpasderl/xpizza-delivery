// MOCKUP-capp-native-icon-splash (option A «Celeste», owner 2026-11-01) — the brand sources are the mockup's geometry and palettes, the
// committed SVGs are the generator's output (no drift), and the opaque re-encode drops alpha without changing a pixel. No Chrome here.
// Run: node platform/native/brand-assets.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripAlpha, pngInfo } from './render-brand-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..', '..');
const require = createRequire(import.meta.url);
const B = require('./brand-assets.js');
const DIR = path.join(ROOT, 'customer-app-native', 'native-assets', 'brand');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// 1. the geometry = the mockup's <symbol id="sola"> (MOCKUP-capp-native-icon-splash.html:136-141), byte for byte
assert.equal(B.RING, 'M24 9.2 A14.8 14.8 0 1 1 24 38.8 A14.8 14.8 0 1 1 24 9.2');
assert.equal(B.NORTH, 'M24 12.6L27.3 24L20.7 24Z'); assert.equal(B.SOUTH, 'M27.3 24L24 31.6L20.7 24Z');
assert.equal(B.RING_W, 3.4); assert.equal(B.PIVOT_R, 1.7);
ok('the Sola geometry is the mockup\'s symbol, byte for byte');

// 2. the palettes = the mockup's production table (A · Celeste; iOS Dark; the splash light / dark)
assert.deepEqual(B.PALETTE.light, { bg: '#8EC0FF', m1: '#14306B', m2: '#FFFFFF' }, '🔴 A · Celeste: fondo Celeste, aro + sur Marino, norte blanco');
assert.deepEqual(B.PALETTE.dark, { bg: '#0D1B3E', m1: '#8EC0FF', m2: '#FFFFFF' }, '🔴 iOS Dark / splash oscuro: fondo Noche, aro + sur Celeste, norte blanco');
assert.deepEqual(B.COLORS, { icon_background: '#8EC0FF', splash_background: '#8EC0FF', splash_background_night: '#0D1B3E' });
ok('palettes: A light, the dark variant, the splash backgrounds Celeste / Noche (the table)');

// 3. sizes + the ring's share of the tile (69 %) + the Android safe zone (66 dp)
const F = Object.fromEntries(B.files().map(([name, , meta]) => [name, meta]));
assert.deepEqual(Object.keys(F).sort(), ['android-foreground-432.svg', 'android-legacy-192.svg', 'android-monochrome-432.svg', 'android-splash-icon-dark-960.svg', 'android-splash-icon-light-960.svg',
  'ios-icon-1024.svg', 'ios-icon-dark-1024.svg', 'ios-icon-tinted-1024.svg', 'play-store-512.svg', 'splash-mark-dark-104.svg', 'splash-mark-dark-208.svg', 'splash-mark-dark-312.svg',
  'splash-mark-light-104.svg', 'splash-mark-light-208.svg', 'splash-mark-light-312.svg']);
for (const [k, v] of Object.entries({ 'ios-icon-1024.svg': false, 'ios-icon-dark-1024.svg': false, 'play-store-512.svg': false, 'android-legacy-192.svg': false, 'ios-icon-tinted-1024.svg': true, 'android-foreground-432.svg': true, 'android-monochrome-432.svg': true }))
  assert.equal(F[k].alpha, v, `${k}: alpha ${v} (the App Store / Play icons carry NO alpha)`);
const ringOuter = (14.8 + B.RING_W / 2) * 2 / 48;
assert.ok(Math.abs(ringOuter - 0.69) < 0.005, `the ring = 69 % of the side (${ringOuter})`);
assert.ok(72 * ringOuter <= 66, `the Android mark at 72/108 keeps the ring inside the 66 dp safe zone (${(72 * ringOuter).toFixed(1)} dp)`);
assert.ok(104 * ringOuter > 71 && 104 * ringOuter < 72, 'the launch mark at 104 px ⇒ the ring 71 px (the mockup)');
ok('sizes, alpha per piece, the ring 69 %, the Android safe zone, the 104 px launch mark (ring 71 px)');

// 4. NO DRIFT: the committed SVGs + manifest are exactly the generator's output
for (const [name, svg] of B.files()) assert.equal(fs.readFileSync(path.join(DIR, name), 'utf8'), svg, `🔴 ${name} drifted from brand-assets.js — run it again`);
const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
assert.deepEqual(man.colors, B.COLORS); assert.deepEqual(man.files, F);
ok('the committed SVGs and manifest.json = the generator\'s output (one source)');

// 5. brand-agnostic: the Sherpa mark only — no restaurant id or name in any source
for (const f of fs.readdirSync(DIR)) { const t = fs.readFileSync(path.join(DIR, f), 'utf8'); assert.ok(!/x[_. ]?pizza|la[_ ]musa/i.test(t), `🔴 ${f}: a restaurant literal`); }
ok('no restaurant literal in any brand source');

// 6. the opaque re-encode: an RGBA PNG (built here, filter 0 rows) → RGB with the SAME pixels; a non-opaque pixel is REFUSED
function rgbaPng(w, h, px) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcT = new Int32Array(256).map((_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([SIG, ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
}
const px = Buffer.from([0x8E, 0xC0, 0xFF, 255, 0x14, 0x30, 0x6B, 255, 255, 255, 255, 255, 0x0D, 0x1B, 0x3E, 255]);   // 2×2, all opaque
const rgb = stripAlpha(rgbaPng(2, 2, px));
const info = pngInfo(rgb);
assert.deepEqual([info.w, info.h, info.colorType, info.alpha], [2, 2, 2, false], '🔴 RGB, no alpha channel');
const SIGLEN = 8; let o = SIGLEN, idat = []; while (o < rgb.length) { const len = rgb.readUInt32BE(o), t = rgb.toString('ascii', o + 4, o + 8); if (t === 'IDAT') idat.push(rgb.subarray(o + 8, o + 8 + len)); o += 12 + len; }
const back = zlib.inflateSync(Buffer.concat(idat));
assert.deepEqual([...back], [0, 0x8E, 0xC0, 0xFF, 0x14, 0x30, 0x6B, 0, 255, 255, 255, 0x0D, 0x1B, 0x3E], '🔴 the same pixels');
const holey = Buffer.from(px); holey[7] = 128;
assert.throws(() => stripAlpha(rgbaPng(2, 2, holey)), /not opaque/, '🔴 a translucent pixel in an opaque asset is refused, never flattened');
ok('the opaque re-encode: RGBA → RGB with identical pixels; a translucent pixel refused');

console.log(`brand-assets: OK (${n})`);
