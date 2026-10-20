#!/usr/bin/env node
// TRACKER FIXES (BUILD §3.3) — builds the REVIEWED flag-ON delta list from a baseline/candidate pair. Every difference must fall in
// one of the reviewed categories below (each with its reason); ANY other difference aborts — a new delta is a review decision, never
// silently allowed. Each emitted entry is pinned to journey + step + path + exact from/to (tracker-golden-compare isAllowed).
//   node tools/tracker-golden-deltas-build.mjs <baseline.json> <candidate-on.json> > test/fixtures/tracker-golden.on-deltas.json
import fs from 'node:fs';
import { diffCaptures } from '../test/tracker-golden-compare.mjs';

const ABSENT = '(absent)';
const fin = (p) => p && typeof p === 'object' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const pinsOk = (pins) => !!(pins && fin(pins.hub) && fin(pins.dest));
const TS = new Set(['picked_up_at', 'delivered_at', 'cancelled_at']);
const CATS = [
  // E1 (T4b, its own line): a LIVE mx carries mx.pins with all four coordinates finite; a non-live mx carries none
  ['mx+E1', (d) => d.path === '/tracking/mx' && d.a === ABSENT && d.b && typeof d.b === 'object' && d.b.mode === 'live' && pinsOk(d.b.pins),
    'gen-2 derived mirror mx (additive; the gen-1 page never reads it) — E1: mx.pins present while live'],
  ['mx', (d) => d.path === '/tracking/mx' && d.a === ABSENT && d.b && typeof d.b === 'object' && d.b.mode !== 'live' && d.b.pins === undefined,
    'gen-2 derived mirror mx (additive; the gen-1 page never reads it) — no pins outside live'],
  ['ts-from-order', (d) => TS.has(d.path.split('/')[2]) && d.path.startsWith('/tracking/') && d.a === `T@tracking/${d.path.split('/')[2]}` && d.b === `T@order/${d.path.split('/')[2]}`,
    'the tracker timestamp is copied from the order (one source of truth) instead of a separate server stamp'],
  ['ts-order-labels', (d) => d.path === '/_ts_order' && Array.isArray(d.a) && Array.isArray(d.b),
    'canonical timestamp ordering — follows from the tracker timestamps now equalling the order\'s (and the new mx sample_at)'],
  ['name-live-noloc', (d) => d.path === '/tracking/driver_name' && d.a === 'Uno' && d.b === ABSENT && ['pickup', 'location 1', 'location 2', 'location 3'].includes(d.step),
    'live with no location yet → legacy (null, null): no gen-1 countdown with a name and an absent flag (D-defect)'],
  ['name-terminal', (d) => d.path === '/tracking/driver_name' && d.a === 'Uno' && d.b === ABSENT && ['complete', 'dispatcher cancel', 'end (background handlers settled)'].includes(d.step) && d.journey !== 'reassign',
    'terminal → legacy name cleared (the delivered/cancelled branches never read driver_name)'],
  ['reassign-clear', (d) => d.journey === 'reassign' && ['reassign to D2', 'D2 accept', 'end (background handlers settled)'].includes(d.step)
    && ['/tracking/driver_name', '/tracking/driver_location', '/tracking/dest_lat', '/tracking/dest_lng', '/tracking/is_active_drop'].includes(d.path) && d.b === ABSENT,
    'reassigned away: the old driver\'s name, location, destination pin and active-drop flag are cleared until the new driver goes live (stale-map fix)'],
];

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const out = [], bad = [], counts = {};
for (const d of diffCaptures(a, b)) {
  const c = CATS.find(([, test]) => test(d));
  if (!c) { bad.push(d); continue; }
  counts[c[0]] = (counts[c[0]] || 0) + 1;
  out.push({ journey: d.journey, step: d.step, path: d.path, from: d.a, to: d.b, reason: `${c[0]}: ${c[2]}` });
}
if (bad.length) { console.error(`tracker-golden-deltas-build: ${bad.length} UNREVIEWED difference(s):\n${bad.map((d) => `  ${d.journey} · ${d.step} · ${d.path}: ${JSON.stringify(d.a)} → ${JSON.stringify(d.b)}`).join('\n')}`); process.exit(1); }
console.error(`tracker-golden-deltas-build: ${out.length} reviewed deltas ${JSON.stringify(counts)}`);
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
