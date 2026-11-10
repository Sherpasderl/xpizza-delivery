'use strict';
// deploy-params.guard.test.js's FULL-LOAD plant (codex HIGH P2): declares one non-secret param ONLY when photos/functions.js
// loads — a module the full index.js load reaches and a FUNCTION_TARGET-isolated load (e.g. getEditableCatalog) does not.
const Module = require('module');
const orig = Module._load; let done = false;
Module._load = function patchedLoad(request, parent, isMain) {
  const out = orig.apply(this, arguments);
  if (!done) {
    let f = null; try { f = Module._resolveFilename(request, parent, isMain); } catch (_) { f = null; }
    if (f && /[\\/]photos[\\/]functions\.js$/.test(f)) { done = true; require('firebase-functions/params').defineString('TB_FULL_LOAD_PARAM', { default: '' }); }
  }
  return out;
};
