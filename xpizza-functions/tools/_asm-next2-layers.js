'use strict';
// DRYRUN ASSEMBLY HELPER (2e, next-train dry run on main 51dc55ab; TRAIN-NEXT2 obligation A4: re-cut at the real assembly).
// The next train's NEW module layers, in assembly order (oldest → newest):
//   hostedrace (claim fix + extra-pay) → alertsan (sanitize) → p5a → sd, sb (3a)
// Newest innermost: a guard for an OLDER layer must strip every NEWER layer first, then its own, and compare with its base.
//   stripNewer(file, src)            strip ALL next-train layers (for the last train's guards: s4hours, intl, checkout, photos, mem512)
//   stripNewer(file, src, 'p5a')     strip only the layers NEWER than p5a (sb, sd) — for p5a's own guard
// Each step is the layer's own inverse; an inverse that does not own `file` passes it through unchanged.
const NEWEST_FIRST = [
  ['sb', (f, s) => (f === 'index.js' ? require('./sb-inverse').unapplySbIndex(s) : s)],
  ['sd', (f, s) => (f === 'index.js' ? require('./sd-inverse').unapplySdIndex(s) : require('./sd-inverse').unapplySdModuleIfAny(f, s))],
  ['p5a', (f, s) => require('./p5a-inverse').unapplyP5aModule(f, s)],
  ['alertsan', (f, s) => require('./alertsan-module-inverse').unapplyAlertSanModule(f, s)],
  ['hostedrace', (f, s) => require('./hostedrace-module-inverse').unapplyHostedRaceModule(f, s)],
];
function stripNewer(file, src, upTo = null) {
  let out = src;
  for (const [name, fn] of NEWEST_FIRST) {
    if (name === upTo) return out;
    out = fn(file, out);
  }
  if (upTo !== null) throw new Error(`_asm-next2-layers: unknown layer ${upTo}`);
  return out;
}
//   stripLayers(file, src, ['p5a', 'alertsan', 'hostedrace'])   strip exactly the NAMED layers, still newest-first
//   (for a guard whose chain already strips the newer ones itself, e.g. 3a's sd(sb(…)) composed in at the merge)
function stripLayers(file, src, names) {
  for (const n of names) if (!NEWEST_FIRST.some(([x]) => x === n)) throw new Error(`_asm-next2-layers: unknown layer ${n}`);
  let out = src;
  for (const [name, fn] of NEWEST_FIRST) if (names.includes(name)) out = fn(file, out);
  return out;
}
module.exports = { stripNewer, stripLayers, LAYERS: NEWEST_FIRST.map(([n]) => n) };
