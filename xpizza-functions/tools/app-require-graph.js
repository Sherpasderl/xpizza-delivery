'use strict';
// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §6 "Isolation") — TEST-ONLY preload (`node -r ./tools/app-require-graph.js`).
// Records the APPLICATION require graph of the process: every local module loaded (path relative to the functions
// dir, node_modules excluded) and every npm package / Node builtin that a LOCAL module requires directly. Modules a
// framework package loads for itself (firebase-admin's, firebase-functions' own internals) are framework-owned and not
// part of the application graph. `appRequireGraph()` is exposed on globalThis for the child that prints it.
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const local = new Set();
const npm = new Set();
const isLocal = (f) => typeof f === 'string' && f.startsWith(ROOT + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`);
const pkgOf = (req) => (req.startsWith('@') ? req.split('/').slice(0, 2).join('/') : req.split('/')[0]);

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const out = origLoad.apply(this, arguments);
  try {
    const parentFile = parent && parent.filename;
    if (isLocal(parentFile) && !parentFile.endsWith(path.join('tools', 'app-require-graph.js'))) {
      if (request.startsWith('.') || path.isAbsolute(request)) {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (isLocal(resolved)) local.add(path.relative(ROOT, resolved));
      } else if (parentFile.endsWith('[eval]')) {
        /* the driver script (`node -e`) is not application code: its own packages (http for a probe request) are not
           recorded; the local entry it requires (index.js) is, above. */
      } else if (Module.isBuiltin(request)) {
        npm.add(`node:${request.replace(/^node:/, '')}`);
      } else {
        npm.add(pkgOf(request));
      }
    }
  } catch (_) { /* recording must never change loading */ }
  return out;
};

globalThis.appRequireGraph = () => ({ local: [...local].sort(), npm: [...npm].sort() });
