'use strict';
// S4 C′ (PLAN-capp-S4-r4 §2 / r5) — the test-only index.js INVERSE for the schedule_only hook.
// S4 adds ONE delimited segment to the END of quoteOrder's existing clientIp line (no line is added or moved, so no R3
// call site shifts):
//   "<clientIp line> /* s4hours:begin */ if (body.schedule_only === true && …handle(…)) return; /* s4hours:end */"
// unapplyS4HoursIndex removes exactly " /* s4hours:begin */ … /* s4hours:end */" (once, begin before end, on ONE line),
// returning BASE:index.js byte-for-byte (s4hours-wiring.guard). It is the NEWEST layer: every index.js chain and every
// fold applies it FIRST (innermost), before formsignal's inverse.
const BASE = '638d42f5';
const BEGIN = ' /* s4hours:begin */ ';
const END = ' /* s4hours:end */';

function unapplyS4HoursIndex(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`s4hours segment not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('s4hours segment not found exactly once (a second delimiter)');
  if (e < b) throw new Error('s4hours segment delimiters out of order');
  const stop = e + END.length;
  if (src.slice(b, stop).includes('\n')) throw new Error('s4hours segment spans more than one line');
  if (src[stop] !== '\n') throw new Error('s4hours segment is not at the end of its line');
  return src.slice(0, b) + src.slice(stop);
}

module.exports = { BASE, BEGIN, END, unapplyS4HoursIndex };
