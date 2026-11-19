'use strict';
// Z2 §A (PLAN-portal-zones-protocol-v3-r4; Codex #181/#185 acceptance; advisor 11-19) — the pure shape check MOVED out of
// delivery/zones.js into delivery/zone-shape.js is BEHAVIOUR-IDENTICAL. OLD = zones.js at BASE (main, before the move) compiled from
// git; NEW = today's zones.js (which requires zone-shape.js). Every answer is compared STRUCTURALLY and strictly: Object.is on every
// leaf (so -0 and NaN count), the same own keys in the same order (absent keys and array holes count), the same array length and
// prototype, and a thrown error by its message. (Raw v8.serialize bytes are NOT the criterion: they also encode V8's internal
// int-vs-double element kind, which differs between two call sites of identical arithmetic — an artifact, not behaviour.)
//   (1) the REAL corpora: every call delivery/zones.test.js and delivery/zones-writer.test.js make into zones.js (recorded by the
//       test/_zones-recorder.js preload while those tests run green), replayed through OLD and NEW;
//   (2) seeded random lists: portal-form input for normalizeInput (on- and off-grid, |lat| around 60, box / span edges, duplicates,
//       crossings, malformed points), stored-form lists for storedProblem (off-grid values NEVER normalized), pins for inZone, and
//       toPortal / sha / sameLogical over the accepted lists;
//   (3) CAPS (values AND key order) and the export list.
// Run: node delivery/zone-shape-equivalence.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const Module = require('module');
const { execFileSync, spawnSync } = require('child_process');
const BASE = '31f05c8a4';
const FN = path.join(__dirname, '..');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const oldSrc = execFileSync('git', ['show', `${BASE}:xpizza-functions/delivery/zones.js`], { cwd: FN, encoding: 'utf8', maxBuffer: 1 << 26 });
assert.ok(!/zone-shape/.test(oldSrc), `premise: ${BASE}'s zones.js predates the extraction`);
const OLD = (() => { const file = path.join(__dirname, '__zones-at-base.js'); const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(__dirname); m._compile(oldSrc, file); return m.exports; })();
const NEW = require('./zones');
assert.ok(/require\('\.\/zone-shape'\)/.test(fs.readFileSync(path.join(__dirname, 'zones.js'), 'utf8')), 'premise: today\'s zones.js requires the extracted module');

const clone = (x) => v8.deserialize(v8.serialize(x));
const outcome = (f, args) => { try { return { v: f(...clone(args)) }; } catch (e) { return { threw: String(e && e.message) }; } };
let compared = 0;
// the first path where two answers differ (Object.is on leaves, so -0 / NaN count) — for the failure message
function firstDiff(a, b, at = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return `${at}: ${String(a)} vs ${String(b)}`;
  if (Array.isArray(a) && a.length !== b.length) return `${at} length: ${a.length} vs ${b.length}`;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${at}: a different prototype`;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join() !== kb.join()) return `${at} keys: [${ka}] vs [${kb}]`;
  for (const k of ka) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
  return null;
}
function same(fn, args, where) {
  const a = outcome(OLD[fn], args); const b = outcome(NEW[fn], args);
  const d = firstDiff(a, b);
  if (d) assert.fail(`🔴 ZONE-SHAPE-EQUIV (${where}): ${fn} — first difference ${d}\n  args: ${JSON.stringify(args).slice(0, 300)}`);
  compared++; return b;
}

// ── (3) CAPS and the exports ──
assert.strictEqual(JSON.stringify(NEW.CAPS), JSON.stringify(OLD.CAPS), '🔴 ZONE-SHAPE-EQUIV: CAPS (values and key order)');
assert.ok(Object.isFrozen(NEW.CAPS), 'CAPS stays frozen');
assert.deepStrictEqual(Object.keys(NEW), Object.keys(OLD), '🔴 ZONE-SHAPE-EQUIV: the export list');
ok(`CAPS ${JSON.stringify(NEW.CAPS)} and the export list are identical`);

// ── (1) the REAL corpora ──
const real = { calls: 0, byFn: {} };
for (const t of ['delivery/zones.test.js', 'delivery/zones-writer.test.js']) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zones-rec-')), 'calls.b64');
  const env = { ...process.env, ZONES_RECORD_OUT: out }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['-r', path.join(FN, 'test', '_zones-recorder.js'), t], { cwd: FN, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, `premise: ${t} runs green under the recorder (${(r.stderr || r.stdout || '').slice(-400)})`);
  const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean) : [];
  assert.ok(lines.length >= 20, `non-vacuity: ${t} recorded ${lines.length} calls`);
  for (const l of lines) { const { fn, args } = v8.deserialize(Buffer.from(l, 'base64')); same(fn, args, t); real.calls++; real.byFn[fn] = (real.byFn[fn] || 0) + 1; }
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
}
assert.ok(real.byFn.normalizeInput && real.byFn.storedProblem && real.byFn.inZone, `non-vacuity: the corpora reach the writer, the reader and inZone (${JSON.stringify(real.byFn)})`);
ok(`the REAL corpora: ${real.calls} recorded calls replayed, every answer identical (${JSON.stringify(real.byFn)})`);

// ── (2) seeded random ──
let seed = 0x5a0e5; const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const CENTERS = [15.5, 14.07, 0, -33.4, 59.9, 59.95, 60, -60, 59.99999, 60.000001, -60.0000005, 61, 89.9];
const RADII_EDGE = [5e-7, 1e-6, 3e-6, 0.0899, 0.08994, 0.09, 0.1, 0.17, 0.18, 0.36, 0.5, 2];   // grid / box / span edges
const RADII_OK = [1e-4, 5e-4, 0.002, 0.01, 0.03, 0.05, 0.08];                                    // well inside the 20 km box
const radius = () => pick(rnd() < 0.6 ? RADII_OK : RADII_EDGE);
function shape() {
  const lat0 = (rnd() < 0.6 ? pick([15.5, 14.07, 0, -33.4, 45.1]) : pick(CENTERS)) + (rnd() < 0.5 ? (rnd() - 0.5) * 0.01 : 0); const lng0 = rnd() < 0.1 ? pick([179.99, -179.99, 180, -180]) : (rnd() - 0.5) * 340;
  const rLat = radius(), rLng = rnd() < 0.3 ? rLat * pick([1, 2, 2.1, 0.5]) : radius();
  const k = rnd() < 0.08 ? pick([0, 1, 2, 25, 26]) : 3 + Math.floor(rnd() * 22);
  let ang = Array.from({ length: k }, () => rnd() * 2 * Math.PI); if (rnd() < 0.85) ang.sort((a, b) => a - b);
  let pts = ang.map((a) => [lat0 + rLat * Math.sin(a), lng0 + rLng * Math.cos(a)]);
  const m = rnd() < 0.5 ? 1 : rnd();   // half the shapes are left as drawn
  if (m < 0.08 && pts.length > 1) pts.splice(1, 0, [...pts[0]]);                                                   // consecutive duplicate
  else if (m < 0.14 && pts.length > 2) pts[2] = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];      // collinear
  else if (m < 0.2 && pts.length > 3) [pts[1], pts[2]] = [pts[2], pts[1]];                                        // a crossing
  else if (m < 0.24) pts = [[lat0, lng0], [lat0 + rLat, lng0 + rLng], [lat0, lng0 + rLng], [lat0 + rLat * 0.3, lng0]];   // an asymmetric bow-tie
  else if (m < 0.27) pts = [[lat0, lng0], [lat0 + rLat, lng0], [lat0 + 2 * rLat, lng0]];                         // zero area
  else if (m < 0.29 && pts.length) pts[0] = [lat0 + 1e-6 * 0.5, lng0];                                            // a half-grid nudge
  return pts;
}
const ids = () => `z_${Math.floor(rnd() * 36 ** 8).toString(36).padStart(8, '0')}`;
const GOOD = ['Centro', 'Mercado', ' Barrio Sur ', 'Zona Río', 'x'.repeat(30), 'Bajo 😀'];
const BAD = ['centro', '', 'x'.repeat(31), 'Río\u0000', 'Malo \ud800'];   // 'centro' folds onto 'Centro'
const nameAt = (j) => (rnd() < 0.85 ? GOOD[j % GOOD.length] : pick(BAD));
let lists = 0, accepted = 0, pins = 0; const codes = {};
for (let i = 0; i < 6000; i++) {
  const z = Array.from({ length: rnd() < 0.05 ? 9 : (rnd() < 0.6 ? 1 : 2 + Math.floor(rnd() * 2)) }, (_, j) => ({ id: rnd() < 0.05 ? pick(['z_SHORT', 7, null, 'z_abcdefgh']) : ids(), name: nameAt(j), pts: shape() }));
  // the portal form → normalizeInput (rounding happens here, and only here)
  const portal = z.map((x) => ({ id: x.id, name: x.name, points: x.pts.map(([lat, lng]) => (rnd() < 0.003 ? pick([{ lat, lng, x: 1 }, { lat: String(lat), lng }, { lat: NaN, lng }, { lat: -0, lng: -0 }, [lat, lng], null]) : { lat, lng })) }));
  if (rnd() < 0.02) portal.push(pick([null, 'z', { id: 'z_abcdefgh', name: 'A' }]));
  const norm = same('normalizeInput', [portal], `random #${i}`); lists++;
  if (norm.v && !norm.v.ok) { const c = `${norm.v.problem}/${norm.v.field}`; codes[c] = (codes[c] || 0) + 1; }
  // the stored form → storedProblem: values sometimes OFF the grid (never normalized), sometimes on it
  const stored = z.map((x) => ({ id: x.id, name: x.name, points: x.pts.map(([lat, lng]) => (rnd() < 0.85 ? [r6(lat), r6(lng)] : [lat, lng])) }));
  same('storedProblem', [stored], `random #${i}`); same('storedProblem', [rnd() < 0.5 ? undefined : null], 'absent');
  if (norm.v && norm.v.ok) {
    accepted++;
    const zs = norm.v.zones;
    same('toPortal', [zs], `random #${i}`); same('sha', [zs], `random #${i}`); same('sameLogical', [zs, stored], `random #${i}`);
    for (let j = 0; j < 12; j++) {
      const p = pick(zs[0].points); const q = pick(zs[0].points);
      const pin = pick([{ lat: p[0], lng: p[1] }, { lat: (p[0] + q[0]) / 2, lng: (p[1] + q[1]) / 2 }, { lat: p[0] + (rnd() - 0.5) * 1e-3, lng: p[1] + (rnd() - 0.5) * 1e-3 }, { lat: 61, lng: 0 }, { lat: NaN, lng: 0 }, null, { lat: p[0] + 1e-7, lng: p[1] }]);
      same('inZone', [zs, pin], `random #${i} pin`); pins++;
    }
  }
}
assert.ok(accepted >= 800 && lists - accepted >= 800, `non-vacuity: the random lists hit both sides (${accepted} accepted of ${lists})`);
for (const c of ['zones/points', 'zone_caps/points', 'zone_out_of_range/points', 'zones/name', 'zones/id']) assert.ok(codes[c] >= 5, `non-vacuity: the refusal ${c} is exercised (${JSON.stringify(codes)})`);
ok(`seeded random: ${lists} lists (${accepted} accepted) + ${pins} pins — every answer identical; refusals ${JSON.stringify(codes)}`);
console.log(`\nzone-shape-equivalence: OK (${n}) — ${compared} answers compared`);
