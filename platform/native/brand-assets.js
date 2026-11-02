'use strict';
// MOCKUP-capp-native-icon-splash (owner 2026-11-01: option A «Celeste», mark only, the opening animation later) — the customer app's
// icon + launch-screen SOURCES, generated from ONE copy of the Sola geometry (the mockup's <symbol id="sola"> / "sola-mono", verbatim)
// and the mockup's production table (§«Producción»: colours per piece). Pure + deterministic: SVG strings only; the PNGs are rendered
// from these files by render-brand-assets.mjs (headless Chrome). Brand-agnostic: the Sherpa mark only — no restaurant anywhere.
//   node platform/native/brand-assets.js [--out customer-app-native/native-assets/brand]   (writes the SVGs + manifest.json)
const fs = require('fs');
const path = require('path');

// the mockup's geometry, byte for byte (viewBox 0 0 48 48): the ring, the north and south needles, the pivot
const RING = 'M24 9.2 A14.8 14.8 0 1 1 24 38.8 A14.8 14.8 0 1 1 24 9.2';
const NORTH = 'M24 12.6L27.3 24L20.7 24Z';
const SOUTH = 'M27.3 24L24 31.6L20.7 24Z';
const RING_W = 3.4, PIVOT_R = 1.7;

// the mockup's palettes (.cA, .cDark; the table's «Splash claro / oscuro»)
const PALETTE = Object.freeze({
  light: { bg: '#8EC0FF', m1: '#14306B', m2: '#FFFFFF' },   // A · Celeste: fondo Celeste, aro + sur Marino, norte blanco
  dark: { bg: '#0D1B3E', m1: '#8EC0FF', m2: '#FFFFFF' },    // iOS Dark / splash oscuro: fondo Noche, aro + sur Celeste, norte blanco
  // iOS Tinted is delivered in greys on transparent (the system tints): the mockup's preview greys (.cTint #C9D3E6 / #F4F6FA) taken to
  // their luminance-equal neutral greys
  tinted: { bg: null, m1: '#D2D2D2', m2: '#F6F6F6' },
});

// the mark in a box: (x, y) top-left and `size` the side of the 48-unit symbol square, in the output's units
function mark(p, x, y, size) {
  const k = size / 48;
  const t = `translate(${x} ${y}) scale(${k})`;
  // the pivot is the background colour (the mockup's var(--bg)); on transparent it is a HOLE (the mono symbol's mask)
  if (p.bg) {
    return `<g transform="${t}"><path d="${RING}" stroke="${p.m1}" stroke-width="${RING_W}" fill="none" stroke-linecap="round"/><path d="${NORTH}" fill="${p.m2}"/><path d="${SOUTH}" fill="${p.m1}"/><circle cx="24" cy="24" r="${PIVOT_R}" fill="${p.bg}"/></g>`;
  }
  return `<g transform="${t}" mask="url(#pivot-hole)"><path d="${RING}" stroke="${p.m1}" stroke-width="${RING_W}" fill="none" stroke-linecap="round"/><path d="${NORTH}" fill="${p.m2}"/><path d="${SOUTH}" fill="${p.m1}"/></g>`;
}
// the mockup's own mask (#pivot-hole, in the SYMBOL's 48-unit space — the masked group carries the transform, so its user space is
// the symbol's), the stroke's overhang included
const HOLE = `<defs><mask id="pivot-hole" maskUnits="userSpaceOnUse" x="-4" y="-4" width="56" height="56"><rect x="-4" y="-4" width="56" height="56" fill="#fff"/><circle cx="24" cy="24" r="${PIVOT_R}" fill="#000"/></mask></defs>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>\n`;
const full = (n, p) => svg(n, n, `<rect width="${n}" height="${n}" fill="${p.bg}"/>${mark(p, 0, 0, n)}`);   // iOS: the mark fills the tile (the ring = 69 % of the side)

// Android adaptive (108 dp canvas): the mark at 72/108 (inside the 66 dp safe zone); px = dp × 4 at xxxhdpi
function androidFg(n) { const s = n * 72 / 108, o = (n - s) / 2; return svg(n, n, mark(PALETTE.light, o, o, s)); }
function androidMono(n) { const s = n * 72 / 108, o = (n - s) / 2, p = { bg: null, m1: '#FFFFFF', m2: '#FFFFFF' }; return svg(n, n, HOLE + mark(p, o, o, s)); }
function tinted(n) { return svg(n, n, HOLE + mark(PALETTE.tinted, 0, 0, n)); }
// the launch-screen mark alone (iOS storyboard image @1x 104 / @2x 208 / @3x 312; the background is the colour) — transparent around it
function splashMark(n, p) { return svg(n, n, mark(p, 0, 0, n)); }
// Android 12+ windowSplashScreenAnimatedIcon: a 240 dp canvas, the mark at ~48/108 of it (the mockup's production note)
function splashIcon(n, p) { const s = n * 48 / 108, o = (n - s) / 2; return svg(n, n, mark(p, o, o, s)); }
// the Capacitor 2732 splash (Android < 12 + the SplashScreen plugin; advisor 11-01: DERIVE it): the mark at 104/390 of the width
// (the mockup's 104 px on a 390 px phone), centred, on the splash background — the same composition as the launch screen
function splashFull(n, p) { const s = n * 104 / 390, o = (n - s) / 2; return svg(n, n, `<rect width="${n}" height="${n}" fill="${p.bg}"/>${mark(p, o, o, s)}`); }

// every file a build needs (the mockup's «Producción» list) → [name, svg, { w, h, alpha }]
function files() {
  const L = PALETTE.light, D = PALETTE.dark;
  return [
    ['ios-icon-1024.svg', full(1024, L), { w: 1024, h: 1024, alpha: false }],
    ['ios-icon-dark-1024.svg', full(1024, D), { w: 1024, h: 1024, alpha: false }],
    ['ios-icon-tinted-1024.svg', tinted(1024), { w: 1024, h: 1024, alpha: true }],
    ['android-foreground-432.svg', androidFg(432), { w: 432, h: 432, alpha: true }],
    ['android-monochrome-432.svg', androidMono(432), { w: 432, h: 432, alpha: true }],
    ['android-legacy-192.svg', full(192, L), { w: 192, h: 192, alpha: false }],
    ['play-store-512.svg', full(512, L), { w: 512, h: 512, alpha: false }],
    ['splash-mark-light-104.svg', splashMark(104, L), { w: 104, h: 104, alpha: true }],
    ['splash-mark-light-208.svg', splashMark(208, L), { w: 208, h: 208, alpha: true }],
    ['splash-mark-light-312.svg', splashMark(312, L), { w: 312, h: 312, alpha: true }],
    ['splash-mark-dark-104.svg', splashMark(104, D), { w: 104, h: 104, alpha: true }],
    ['splash-mark-dark-208.svg', splashMark(208, D), { w: 208, h: 208, alpha: true }],
    ['splash-mark-dark-312.svg', splashMark(312, D), { w: 312, h: 312, alpha: true }],
    ['android-splash-icon-light-960.svg', splashIcon(960, L), { w: 960, h: 960, alpha: true }],
    ['android-splash-icon-dark-960.svg', splashIcon(960, D), { w: 960, h: 960, alpha: true }],
    ['splash-2732.svg', splashFull(2732, L), { w: 2732, h: 2732, alpha: false }],
    ['splash-dark-2732.svg', splashFull(2732, D), { w: 2732, h: 2732, alpha: false }],
  ];
}
// the colour resources (no PNG): the Android icon background and the two launch-screen backgrounds
const COLORS = Object.freeze({ icon_background: PALETTE.light.bg, splash_background: PALETTE.light.bg, splash_background_night: PALETTE.dark.bg });

function write(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { source: 'MOCKUP-capp-native-icon-splash (option A «Celeste», owner 2026-11-01)', colors: COLORS, files: {} };
  for (const [name, s, meta] of files()) { fs.writeFileSync(path.join(outDir, name), s); manifest.files[name] = meta; }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = { RING, NORTH, SOUTH, RING_W, PIVOT_R, PALETTE, COLORS, files, write, mark };
if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(__dirname, '..', '..', 'customer-app-native', 'native-assets', 'brand');
  const m = write(path.resolve(out));
  console.log(`brand-assets: ${Object.keys(m.files).length} SVGs + manifest.json → ${out}`);
}
