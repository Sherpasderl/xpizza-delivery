'use strict';
/* R3 P1-b — the FUNCTION-BOUNDARY INVOCATION RECORDER (codex P1-b b12 r1 P1-1). Installed on the loaded index.js module
 * BEFORE any scenario invocation, it wraps every exported Cloud Function — the export itself (HTTP / callable / CloudEvent
 * handler) AND its `.run` — so ANY invocation path (the scheduler's trigger fan-out, a page router, a direct `.run()`, a
 * callable dispatch) is recorded at the boundary. The log claims COMPLETE only when every function export was wrapped,
 * the recorder was installed before the first invocation it could have missed, and nothing replaced a wrapper since. */
const MARK = Symbol.for('r3.fnRecorder');
function isFn(x) { return typeof x === 'function' || (x && typeof x.run === 'function'); }

function installFnRecorder(mod, { invocationsBefore = 0 } = {}) {
  const sink = { names: [], calls: [], wrapped: [], unwrapped: [], invocationsBefore, installedAt: Date.now() };
  const rec = (name) => { sink.calls.push(name); if (!sink.names.includes(name)) sink.names.push(name); };
  for (const name of Object.keys(mod)) {
    const orig = mod[name];
    if (!isFn(orig)) continue;
    if (orig[MARK]) { sink.wrapped.push(name); continue; }
    let w;
    if (typeof orig === 'function') { w = function (...a) { rec(name); return orig.apply(this, a); }; }
    else { w = Object.create(Object.getPrototypeOf(orig)); }
    for (const k of Reflect.ownKeys(orig)) { if (k === 'length' || k === 'name' || k === 'prototype' || k === 'arguments' || k === 'caller') continue; try { Object.defineProperty(w, k, Object.getOwnPropertyDescriptor(orig, k)); } catch (_) { /* non-configurable */ } }
    if (typeof orig.run === 'function') { const run = orig.run; w.run = function (...a) { rec(name); return run.apply(orig, a); }; }
    Object.defineProperty(w, MARK, { value: name });
    try { mod[name] = w; } catch (_) { /* read-only export */ }
    (mod[name] === w ? sink.wrapped : sink.unwrapped).push(name);
  }
  // COMPLETE: every function export is (still) a recorder wrapper, and nothing was invoked before installation
  sink.complete = () => sink.invocationsBefore === 0 && sink.unwrapped.length === 0 && Object.keys(mod).filter((n) => isFn(mod[n])).every((n) => mod[n] && mod[n][MARK] === n);
  return sink;
}
module.exports = { installFnRecorder, MARK };
