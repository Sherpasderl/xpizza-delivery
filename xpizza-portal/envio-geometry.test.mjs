// «Envío» step 1 (PLAN-portal-envio-step1 r2 §4 + build condition C3) — the map site's geometry, proven against the SERVER's own
// distance. Run: node --test xpizza-portal/envio-geometry.test.mjs
// The rings must sit where the server prices: every vertex is measured with delivery-pricing.js's real haversineKm (6,371 km), and
// the zoom is proven by PROJECTING those points through Web Mercator (Google's world coordinates), never the formula against itself.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  EARTH_M, RING_SEGMENTS, MOCK, destination, ringPath, pixelsPerKm, zoomFor, cameraCenter, labelAnchor,
} from '../xpizza-portal-map/envio-geometry.js';

const require = createRequire(import.meta.url);
const { haversineKm } = require('../xpizza-functions/delivery/delivery-pricing.js');   // the server's distance, not a copy

// the two real hub pins (seed_identity.js) and two far latitudes, so nothing passes only near San Pedro Sula
const HUBS = [{ lat: 15.5075, lng: -88.0398 }, { lat: 15.5041, lng: -88.0385 }, { lat: -33.45, lng: -70.66 }, { lat: 59.33, lng: 18.07 }];
const KMS = [0.5, 1, 2.5, 6, 9.5, 10];
const serverM = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;

// Google's Web Mercator world coordinates (256 units at zoom 0), scaled to pixels at zoom z
function project(p, z) {
  const s = 256 * 2 ** z, sin = Math.min(Math.max(Math.sin((p.lat * Math.PI) / 180), -0.9999), 0.9999);
  return { x: s * ((p.lng + 180) / 360), y: s * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) };
}
const px = (a, b, z) => { const pa = project(a, z), pb = project(b, z); return Math.hypot(pb.x - pa.x, pb.y - pa.y); };

test('the sphere is the server\'s: 6,371,000 m; rings have 256 segments', () => {
  assert.strictEqual(EARTH_M, 6371000);
  assert.strictEqual(RING_SEGMENTS, 256);
  assert.deepStrictEqual(MOCK, { w: 640, h: 520, cx: 320, cy: 270, unitsPerKm: 24 });
});

test('destination(): every point is r from the hub by the SERVER\'s haversine (≤ 0.01 m), on the asked bearing', () => {
  for (const h of HUBS) {
    for (const km of KMS) {
      for (let b = 0; b < 360; b += 15) {
        const d = destination(h, b, km * 1000);
        assert.ok(Math.abs(serverM(h, d) - km * 1000) <= 0.01, `${h.lat},${h.lng} ${km} km @${b}°: ${serverM(h, d)} m`);
      }
    }
    const n = destination(h, 0, 5000), e = destination(h, 90, 5000), s = destination(h, 180, 5000), w = destination(h, 270, 5000);
    assert.ok(n.lat > h.lat && Math.abs(n.lng - h.lng) < 1e-9, 'north moves only latitude up');
    assert.ok(s.lat < h.lat && Math.abs(s.lng - h.lng) < 1e-9, 'south moves only latitude down');
    assert.ok(e.lng > h.lng && w.lng < h.lng, 'east / west move longitude');
  }
});

test('ringPath(): 256 vertices on the server distance; the worst chord between them stays within 1 m of the ring', () => {
  for (const h of HUBS) {
    for (const km of KMS) {
      const ring = ringPath(h, km);
      assert.strictEqual(ring.length, 256);
      for (const v of ring) assert.ok(Math.abs(serverM(h, v) - km * 1000) <= 0.01);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
        const sag = km * 1000 - serverM(h, mid);
        assert.ok(sag >= -0.01 && sag <= 1, `${km} km chord sag ${sag} m`);
      }
    }
  }
});

test('pixelsPerKm = 24 × W / 640 (the mockup\'s 24 units per km in a 640-wide viewBox)', () => {
  assert.strictEqual(pixelsPerKm(640), 24);
  assert.strictEqual(pixelsPerKm(320), 12);
  assert.strictEqual(pixelsPerKm(390), 14.625);
  assert.strictEqual(pixelsPerKm(1180), 44.25);
});

test('zoomFor(): PROJECTED ring points land at 24·W/640 px per server km in every direction (≤ 0.25 %)', () => {
  for (const h of HUBS) {
    for (const W of [320, 390, 640, 760]) {
      const z = zoomFor(W, h.lat);
      for (const km of [1, 6, 10]) {
        for (const b of [0, 45, 90, 180, 270]) {
          const want = pixelsPerKm(W) * km, got = px(h, destination(h, b, km * 1000), z);
          assert.ok(Math.abs(got - want) / want <= 0.0025, `W=${W} lat=${h.lat} ${km} km @${b}°: ${got} px, want ${want}`);
        }
      }
    }
  }
  // due EAST the latitude barely moves, so Mercator adds no stretch: the scale is the constant alone. ≤ 1e-5 there tells the
  // server's sphere (2π·6,371,000/256) from Google's (2π·6,378,137/256), which is 1.12e-3 off — a 0.25 % bound would not.
  for (const h of HUBS) {
    for (const W of [320, 640]) {
      const z = zoomFor(W, h.lat), want = pixelsPerKm(W) * 10, got = px(h, destination(h, 90, 10000), z);
      assert.ok(Math.abs(got - want) / want <= 1e-5, `east, W=${W} lat=${h.lat}: ${got} px, want ${want}`);
    }
  }
  // the 10 km ring is the outer edge at the box's own size: 240 px at 640, 120 px at 320 (Codex r1 F6)
  const h = HUBS[0];
  assert.ok(Math.abs(px(h, destination(h, 90, 10000), zoomFor(640, h.lat)) - 240) < 0.6);
  assert.ok(Math.abs(px(h, destination(h, 90, 10000), zoomFor(320, h.lat)) - 120) < 0.3);
});

test('cameraCenter(): the hub projects 10 mockup units BELOW the camera centre — the pin lands at the mockup\'s (320, 270)', () => {
  for (const h of HUBS) {
    for (const W of [320, 390, 640]) {
      const z = zoomFor(W, h.lat), c = project(cameraCenter(h), z), p = project(h, z);
      const wantDy = ((MOCK.cy - MOCK.h / 2) * W) / MOCK.w;   // 10 units scaled to W
      assert.ok(Math.abs(p.y - c.y - wantDy) < 0.05, `W=${W}: ${p.y - c.y} px, want ${wantDy}`);
      assert.ok(Math.abs(p.x - c.x) < 1e-6);
    }
  }
});

test('labelAnchor(): bands on the 45° NE point of their ring, refused bands on 225° (SW), at the server distance', () => {
  const h = HUBS[0];
  const ne = labelAnchor(h, 6, false), sw = labelAnchor(h, 12, true);
  assert.ok(Math.abs(serverM(h, ne) - 6000) <= 0.01 && ne.lat > h.lat && ne.lng > h.lng);
  assert.ok(Math.abs(serverM(h, sw) - 12000) <= 0.01 && sw.lat < h.lat && sw.lng < h.lng);
  const z = zoomFor(640, h.lat), a = project(h, z), b = project(ne, z);
  assert.ok(Math.abs(Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI - 45) < 0.2, 'the NE label sits on the screen diagonal');
});

test('inputs outside the sphere\'s domain are refused, never drawn', () => {
  assert.throws(() => destination({ lat: 91, lng: 0 }, 0, 1000), /hub/);
  assert.throws(() => destination({ lat: 0, lng: NaN }, 0, 1000), /hub/);
  assert.throws(() => ringPath({ lat: 15, lng: -88 }, 0), /km/);
  assert.throws(() => ringPath({ lat: 15, lng: -88 }, -1), /km/);
  assert.throws(() => zoomFor(0, 15), /width/);
});
