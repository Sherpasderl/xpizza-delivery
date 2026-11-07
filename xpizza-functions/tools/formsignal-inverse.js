'use strict';
// PLAN 3 (docs/superpowers/plans/2026-10-26-form-signal-counter.md) — the test-only index.js INVERSE for formSignal.
// PLAN 3 adds ONE delimited block at the END of index.js,
//   "\n/* formsignal:begin */ … /* formsignal:end */\n"
// and nothing else (no existing line moves, so no R3 call site shifts). unapplyFormSignalIndex removes it (exactly once,
// both delimiters, begin before end), returning BASE:index.js byte-for-byte (formsignal-wiring.guard). It is the NEWEST
// layer: every index.js chain and every fold applies it FIRST (innermost), before PLAN 2's menu-warm inverse.
const BASE = 'bd777b6d';
const BEGIN = '/* formsignal:begin */';
const END = '/* formsignal:end */';

function unapplyFormSignalIndex(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`formsignal block not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('formsignal block not found exactly once (a second delimiter)');
  if (e < b) throw new Error('formsignal block delimiters out of order');
  const start = b - 1;
  if (src[start] !== '\n') throw new Error('formsignal block is not preceded by its blank-line separator');
  const stop = e + END.length;
  if (src[stop] !== '\n') throw new Error('formsignal block is not followed by its trailing newline');
  return src.slice(0, start) + src.slice(stop + 1);
}

module.exports = { BASE, BEGIN, END, unapplyFormSignalIndex };
