// MOCKUP-capp-native-icon-splash — renders the brand SVGs (platform/native/brand-assets.js) to the PNGs a native build needs, with
// headless Chrome's own screenshot mode (no npm dependency). Opaque pieces (the App Store / Play / legacy icons) are re-encoded WITHOUT
// an alpha channel (App Store Connect refuses an icon with alpha); transparent pieces keep RGBA. Every output is verified: its size
// and its alpha against manifest.json. A Chrome run — schedule it (load1 < 30).
//   CHROME=/path/to/chrome node platform/native/render-brand-assets.mjs [--dir customer-app-native/native-assets/brand]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── PNG: read the header, and re-encode an RGBA PNG as RGB (8-bit, non-interlaced only — what Chrome writes) ──
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunks(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const out = []; let o = 8;
  while (o < buf.length) { const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8); out.push({ type, data: buf.subarray(o + 8, o + 8 + len) }); o += 12 + len; }
  return out;
}
export function pngInfo(buf) {
  const h = chunks(buf).find((c) => c.type === 'IHDR').data;
  const colorType = h[9];
  return { w: h.readUInt32BE(0), h: h.readUInt32BE(4), depth: h[8], colorType, interlace: h[12], alpha: colorType === 4 || colorType === 6 };
}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function unfilter(raw, w, h, bpp) {
  const stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : NaN;
      if (Number.isNaN(pred)) throw new Error(`bad PNG filter ${f}`);
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return out;
}
// RGBA → RGB, refusing a pixel that is not fully opaque (an opaque asset must BE opaque; nothing is silently flattened)
export function stripAlpha(buf) {
  const info = pngInfo(buf);
  if (!info.alpha) return buf;
  if (info.colorType !== 6 || info.depth !== 8 || info.interlace !== 0) throw new Error('only 8-bit non-interlaced RGBA is re-encoded');
  const idat = Buffer.concat(chunks(buf).filter((c) => c.type === 'IDAT').map((c) => c.data));
  const px = unfilter(zlib.inflateSync(idat), info.w, info.h, 4);
  const rgb = Buffer.alloc((info.w * 3 + 1) * info.h);
  for (let y = 0; y < info.h; y++) {
    rgb[y * (info.w * 3 + 1)] = 0;
    for (let x = 0; x < info.w; x++) {
      const s = (y * info.w + x) * 4, d = y * (info.w * 3 + 1) + 1 + x * 3;
      if (px[s + 3] !== 255) throw new Error(`pixel (${x},${y}) is not opaque — an opaque asset must be drawn opaque`);
      rgb[d] = px[s]; rgb[d + 1] = px[s + 1]; rgb[d + 2] = px[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(info.w, 0); ihdr.writeUInt32BE(info.h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rgb, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function chromePath() {
  const c = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(c)) throw new Error(`Chrome not found at ${c} (set CHROME)`);
  return c;
}
function render(chrome, svgFile, outPng, w, h, transparent) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
  try {
    // the SVG is the whole page at its own size (no margins); a transparent background for the alpha pieces
    const html = path.join(tmp, 'p.html');
    fs.writeFileSync(html, `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${transparent ? 'transparent' : '#fff'}}img{display:block;width:${w}px;height:${h}px}</style></head><body><img src="${new URL('file://' + svgFile).href}"></body></html>`);
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`,
      ...(transparent ? ['--default-background-color=00000000'] : []), '--allow-file-access-from-files', `--user-data-dir=${path.join(tmp, 'ud')}`, `--screenshot=${outPng}`, new URL('file://' + html).href], { stdio: 'ignore', timeout: 60000 });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--dir');
  const dir = path.resolve(i >= 0 ? argv[i + 1] : path.join(HERE, '..', '..', 'customer-app-native', 'native-assets', 'brand'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const chrome = chromePath(), done = [];
  for (const [name, meta] of Object.entries(manifest.files)) {
    const svg = path.join(dir, name), png = path.join(dir, name.replace(/\.svg$/, '.png'));
    render(chrome, svg, png, meta.w, meta.h, meta.alpha);
    let b = fs.readFileSync(png);
    if (!meta.alpha) { b = stripAlpha(b); fs.writeFileSync(png, b); }
    const info = pngInfo(b);
    if (info.w !== meta.w || info.h !== meta.h) throw new Error(`${name}: rendered ${info.w}×${info.h}, expected ${meta.w}×${meta.h}`);
    if (info.alpha !== meta.alpha) throw new Error(`${name}: alpha ${info.alpha}, expected ${meta.alpha}`);
    done.push(`${path.basename(png)} ${info.w}×${info.h}${info.alpha ? ' RGBA' : ' RGB'}`);
  }
  console.log(`render-brand-assets: ${done.length} PNGs\n  ${done.join('\n  ')}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
