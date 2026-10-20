#!/usr/bin/env node
// TRACKER FIXES (BUILD-tracker-fixes §3.3) — compare two canonical golden captures.
//   node test/tracker-golden-compare.mjs <expected.json> <actual.json> [--allow <delta-list.json>]
// Exit 0 = equal (journeys/steps/fields), 1 = a difference (listed per journey/step/path), 2 = usage.
// --allow: a reviewed field-level delta list [{journey, step, path, from, to, reason}] — EXACTLY those changes must occur and nothing else may differ (flag-ON proof; codex build r1 P2-4).
// --self-test: proves the comparator FAILS on a changed field and on an extra side effect (BUILD §3.3 comparator self-test).
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export function diffCaptures(a, b) {
  const out = [];
  const ja = (a && a.journeys) || {}, jb = (b && b.journeys) || {};
  for (const j of new Set([...Object.keys(ja), ...Object.keys(jb)])) {
    const sa = ja[j] || [], sb = jb[j] || [];
    if (sa.length !== sb.length) out.push({ journey: j, step: null, path: '(step count)', a: sa.length, b: sb.length });
    for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
      const step = (sa[i] || sb[i] || {}).step;
      (function walk(x, y, p) {
        if (isDeepStrictEqual(x, y)) return;
        if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
          for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${p}/${k}`);
          return;
        }
        out.push({ journey: j, step, path: p || '/', a: x === undefined ? '(absent)' : x, b: y === undefined ? '(absent)' : y });
      })(sa[i], sb[i], '');
    }
  }
  return out;
}

// A reviewed delta must name journey, step, path AND the exact from/to values (canonical form) — a path-only entry would let ANY
// value through at that path, so it is never accepted.
export function isAllowed(allow, d) {
  return allow.some((x) => x.journey === d.journey && x.step === d.step && x.path === d.path
    && 'from' in x && 'to' in x && isDeepStrictEqual(x.from, d.a) && isDeepStrictEqual(x.to, d.b));
}

// codex build r1 P2-4: EXACT correspondence — every reviewed delta must actually occur (journey, step, path AND the pinned from/to);
// an expected change that did not happen means the candidate lost a reviewed fix, which is as RED as an unexpected change.
export function missingExpected(allow, diffs) {
  return allow.filter((x) => !diffs.some((d) => d.journey === x.journey && d.step === x.step && d.path === x.path
    && isDeepStrictEqual(x.from, d.a) && isDeepStrictEqual(x.to, d.b)));
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    const base = { journeys: { native: [{ step: 'pickup', tracking: { status: 'out_for_delivery', driver_name: 'Uno' }, side_effects: [['whatsapp', '+504', 'x', 'tb_centro']] }] } };
    const same = JSON.parse(JSON.stringify(base));
    if (diffCaptures(base, same).length !== 0) throw new Error('self-test: identical captures reported different');
    const changed = JSON.parse(JSON.stringify(base)); changed.journeys.native[0].tracking.driver_name = 'Dos';
    const d1 = diffCaptures(base, changed);
    if (!(d1.length === 1 && d1[0].path === '/tracking/driver_name')) throw new Error(`self-test: a changed field was not detected exactly (${JSON.stringify(d1)})`);
    const extra = JSON.parse(JSON.stringify(base)); extra.journeys.native[0].side_effects.push(['webpush', 'e', 'p']);
    const d2 = diffCaptures(base, extra);
    if (d2.length < 1 || !d2.some((d) => d.path.startsWith('/side_effects'))) throw new Error(`self-test: an extra side effect was not detected (${JSON.stringify(d2)})`);
    // a reviewed delta is pinned to its exact journey + step + path + from + to: the SAME path with a DIFFERENT value is not allowed
    const pinned = [{ journey: 'native', step: 'pickup', path: '/tracking/driver_name', from: 'Uno', to: 'Dos', reason: 't' }];
    if (!isAllowed(pinned, d1[0])) throw new Error('self-test: the exact reviewed delta was not allowed');
    const other = JSON.parse(JSON.stringify(base)); other.journeys.native[0].tracking.driver_name = 'Tres';
    if (isAllowed(pinned, diffCaptures(base, other)[0])) throw new Error('self-test: a reviewed path with a DIFFERENT value was allowed');
    if (isAllowed([{ path: '/tracking/driver_name', reason: 't' }], d1[0])) throw new Error('self-test: an unpinned (path-only) entry was accepted');
    // codex build r1 P2-4: with a reviewed delta list, EVERY listed change must occur — a missing expected change is RED
    const expectAll = [{ journey: 'native', step: 'pickup', path: '/tracking/driver_name', from: 'Uno', to: 'Dos', reason: 't' }];
    if (missingExpected(expectAll, diffCaptures(base, changed)).length !== 0) throw new Error('self-test: a present expected change was reported missing');
    if (missingExpected(expectAll, diffCaptures(base, same)).length !== 1) throw new Error('self-test: a MISSING expected change was not detected (baseline vs itself must fail under the list)');
    console.log('tracker-golden-compare self-test: OK (identical → equal; changed field → exactly that path; extra side effect → detected; reviewed deltas pinned to journey/step/path/from/to)');
    return 0;
  }
  if (argv.length < 2) { console.error('usage: tracker-golden-compare.mjs <expected.json> <actual.json> [--allow <deltas.json>] | --self-test'); return 2; }
  const [ea, eb] = [JSON.parse(fs.readFileSync(argv[0], 'utf8')), JSON.parse(fs.readFileSync(argv[1], 'utf8'))];
  const ai = argv.indexOf('--allow');
  const allow = ai >= 0 ? JSON.parse(fs.readFileSync(argv[ai + 1], 'utf8')) : [];
  const allowed = (d) => isAllowed(allow, d);
  const diffs = diffCaptures(ea, eb);
  const unexpected = diffs.filter((d) => !allowed(d));
  const missing = missingExpected(allow, diffs);
  for (const d of unexpected) console.log(`DIFF ${d.journey} · ${d.step} · ${d.path}: ${JSON.stringify(d.a)} → ${JSON.stringify(d.b)}`);
  for (const x of missing) console.log(`MISSING expected delta ${x.journey} · ${x.step} · ${x.path}: ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)} (${x.reason})`);
  const bad = unexpected.length + missing.length;
  console.log(`tracker-golden-compare: ${bad ? 'DIFFERENT' : 'EQUAL'} (${diffs.length} difference(s), ${diffs.length - unexpected.length} allowed by the reviewed delta list, ${missing.length} expected delta(s) missing)`);
  return bad ? 1 : 0;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
