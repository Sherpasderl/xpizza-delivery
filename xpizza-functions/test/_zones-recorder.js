'use strict';
// Z2 §A (PLAN-portal-zones-protocol-v3-r4; advisor 11-19) — a PRELOAD (node -r) that records every call the zones tests make into
// delivery/zones.js (normalizeInput / storedProblem / inZone / toPortal / sha / sameLogical), one v8-serialized base64 line per call
// (NaN, -0, Infinity, undefined and sparse arrays survive, which JSON would not), to ZONES_RECORD_OUT. The
// equivalence test (delivery/zone-shape-equivalence.test.js) replays these REAL inputs through the old and the extracted module.
const fs = require('fs');
const v8 = require('v8');
const path = require('path');
const Module = require('module');
const OUT = process.env.ZONES_RECORD_OUT;
const TARGET = path.join(__dirname, '..', 'delivery', 'zones.js');
const NAMES = ['normalizeInput', 'storedProblem', 'inZone', 'toPortal', 'sha', 'sameLogical'];
const load = Module._load;
let wrapped = null;
Module._load = function (request, parent, isMain) {
  const out = load.apply(this, arguments);
  let file; try { file = Module._resolveFilename(request, parent, isMain); } catch (_) { return out; }
  if (file !== TARGET) return out;
  if (!wrapped) {
    wrapped = { ...out };
    for (const k of NAMES) {
      const f = out[k];
      wrapped[k] = function (...args) {
        try { fs.appendFileSync(OUT, v8.serialize({ fn: k, args }).toString('base64') + '\n'); } catch (_) { /* an unserializable arg (a function): skipped */ }
        return f.apply(this, args);
      };
    }
  }
  return wrapped;
};
