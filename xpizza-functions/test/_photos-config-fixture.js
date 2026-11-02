'use strict';
// TEST-OWNED photos-config fixture installer (PLAN-photos-public-bucket-config r5 §7, codex r5 P2): OUTSIDE the production import graph —
// only test children preload it (`node -r test/_photos-config-fixture.js`). It seeds Node's module cache for the EXACT committed config path
// photos/photos-config.js reads (CONFIG_PATH), before anything loads it. Production has no installer, setter or reader seam; the boundary
// guard (photos/photos-config-wiring.test.js) proves no production module ever loads this file.
//   TB_PHOTOS_FIXTURE = '<json>'           → that object is "the committed config"
//   TB_PHOTOS_FIXTURE_MODE = 'missing'     → requiring the config path fails as a missing file
//   TB_PHOTOS_FIXTURE_MODE = 'garbage'     → it fails as unparseable JSON
const Module = require('module');
const path = require('path');
const CONFIG_PATH = path.join(__dirname, '..', 'platform', 'photos.json');
const mode = process.env.TB_PHOTOS_FIXTURE_MODE || 'object';
if (mode === 'object') {
  const obj = JSON.parse(process.env.TB_PHOTOS_FIXTURE || 'null');
  require.cache[CONFIG_PATH] = { id: CONFIG_PATH, filename: CONFIG_PATH, loaded: true, exports: obj, children: [], paths: [] };
} else {
  const orig = Module._load;
  Module._load = function fixtureLoad(request, parent, isMain) {
    let f = null; try { f = Module._resolveFilename(request, parent, isMain); } catch (_) { f = null; }
    if (f === CONFIG_PATH) {
      if (mode === 'missing') throw Object.assign(new Error(`Cannot find module '${CONFIG_PATH}'`), { code: 'MODULE_NOT_FOUND' });
      throw new SyntaxError(`${CONFIG_PATH}: Unexpected token`);
    }
    return orig.apply(this, arguments);
  };
}
global.__TB_PHOTOS_FIXTURE_INSTALLED = mode;
