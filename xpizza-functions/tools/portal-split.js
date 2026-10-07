'use strict';
// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §6 "Guards") — the INVERSE of the portal split. TEST-ONLY.
//
// The five portal functions, paymentAlert, the Admin init, PORTAL_ORIGINS and the stats keyer moved out of index.js
// VERBATIM (the one in-block edit: relative require specifiers './x' → '../x' inside portal/functions.js's marked
// blocks). `foldPortalSplit()` puts every moved region back at its original site, taking the text FROM THE MOVED
// FILES, removes the early branch, and returns "index.js as one file". Every anchor must occur EXACTLY once, else it
// throws — an inverse that silently skipped a site would reconstruct something that merely looks right.
//
// Uses: (1) the guard asserts fold(candidate) is byte-identical to the integration parent's index.js — which proves
// the moved code is verbatim (identity-record-guards.test.js); (2) the structural tests that read index.js to check
// the portal handlers' wiring read this folded view, so they keep asserting the SAME properties against the code that
// actually runs (it is extracted from portal/functions.js, not from a copy).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORTAL_TARGETS = ['getMyRestaurants', 'getEditableCatalog', 'editCatalog', 'publishEdited', 'getSalesStats'];
const REQUIRE_REWRITES = 12;   // the exact count of './' → '../' specifier rewrites in the three moved blocks (advisor Q1=A)

const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

function once(hay, needle, label) {
  const a = hay.indexOf(needle);
  if (a === -1 || hay.indexOf(needle, a + 1) !== -1) throw new Error(`portal-split: ${label} must occur exactly once`);
  return a;
}
function replaceOnce(hay, needle, repl, label) {
  const a = once(hay, needle, label);
  return hay.slice(0, a) + repl + hay.slice(a + needle.length);
}
// the text strictly between `start` and `end` (both exactly once)
function between(hay, start, end, label) {
  const a = once(hay, start, `${label} start`) + start.length;
  const b = hay.indexOf(end, a);
  if (b === -1) throw new Error(`portal-split: ${label} end`);
  return hay.slice(a, b);
}

// The moved regions, read from the moved files (the source of truth for the reconstruction).
function movedRegions(root = ROOT) {
  const admin = read(root, 'lib/admin.js');
  const pay = read(root, 'lib/payment-alert.js');
  const orig = read(root, 'portal/origins.js');
  const keyer = read(root, 'stats/keyer.js');
  const portal = read(root, 'portal/functions.js');

  const ADMIN = admin.slice(once(admin, 'initializeApp({', 'lib/admin.js init'));   // the init statement ends the file
  const PAY = between(pay, "const { ServerValue } = require('firebase-admin/database');\n\n", '\nmodule.exports = { paymentAlert };\n', 'lib/payment-alert.js');
  const ORIG = orig.slice(once(orig, 'const PORTAL_ORIGINS = [\n', 'portal/origins.js'), orig.indexOf('\nmodule.exports = { PORTAL_ORIGINS };\n'));
  const STATS_STATE = between(keyer, "const { loadStatsSecret, makeCustomerKeyer } = require('./stats-identity');\n", '\nmodule.exports = { statsKeyer, _statsLiveCache };\n', 'stats/keyer.js');

  const blocks = {};
  let rewrites = 0;
  for (const tag of ['A', 'B', 'C']) {
    const open = portal.slice(once(portal, `// ⟪moved:${tag} `, `portal block ${tag} open`));
    const body = open.slice(open.indexOf('\n') + 1, open.indexOf(`// ⟪/moved:${tag}⟫\n`));
    // THE inverse rule — exactly the forward rewrite, reversed, and nothing else.
    blocks[tag] = body.replace(/require\('\.\.\//g, () => { rewrites += 1; return "require('./"; });
  }
  return { ADMIN, PAY, ORIG, STATS_STATE, blocks, rewrites };
}

const TOP_START = '// ── PORTAL SPEED P1 — ISOLATED PORTAL ENTRYPOINTS';
const TOP_END = "  module.exports = require('./portal/functions');\n  return;\n}\n\n";

function foldPortalSplit(root = ROOT, idx = read(root, 'index.js')) {
  const m = movedRegions(root);
  if (m.rewrites !== REQUIRE_REWRITES) throw new Error(`portal-split: ${m.rewrites} require specifiers rewritten, expected exactly ${REQUIRE_REWRITES}`);
  if (once(idx, TOP_START, 'early branch') !== 0) throw new Error('portal-split: the early branch must be the very top of index.js');
  let s = idx.slice(once(idx, TOP_END, 'early branch end') + TOP_END.length);
  s = replaceOnce(s, "require('./lib/admin');   // PORTAL SPEED P1: the ONE Admin app — initializeApp moved verbatim to lib/admin.js (shared with portal/functions.js)\n", m.ADMIN, 'admin site');
  s = replaceOnce(s, "const { paymentAlert } = require('./lib/payment-alert');   // PORTAL SPEED P1: moved verbatim; the SAME function object portal/functions.js uses\n", m.PAY, 'paymentAlert site');
  s = replaceOnce(s, "const { PORTAL_ORIGINS } = require('./portal/origins');   // PORTAL SPEED P1: the literal moved verbatim to portal/origins.js\n", m.ORIG, 'PORTAL_ORIGINS site');
  s = replaceOnce(s,
    "// PORTAL SPEED P1: the Portal 2b-1 block (editCatalog, publishEdited) moved verbatim to portal/functions.js.\n"
    + "const portalFunctions = require('./portal/functions');\n"
    + 'exports.editCatalog = portalFunctions.editCatalog;\n'
    + 'exports.publishEdited = portalFunctions.publishEdited;\n', m.blocks.A, 'block A site');
  s = replaceOnce(s,
    "// PORTAL SPEED P1: the Portal 2b-2a block (getMyRestaurants, getEditableCatalog) moved verbatim to portal/functions.js.\n"
    + 'exports.getMyRestaurants = portalFunctions.getMyRestaurants;\n'
    + 'exports.getEditableCatalog = portalFunctions.getEditableCatalog;\n', m.blocks.B, 'block B site');
  s = replaceOnce(s, "const { statsKeyer } = require('./stats/keyer');   // PORTAL SPEED P1: the lazy keyer + live cache moved verbatim to stats/keyer.js (ONE instance, shared with getSalesStats)\n",
    "const { getSalesStatsCore, makeLiveCache } = require('./stats/stats-api');\n"
    + "const { loadStatsSecret, makeCustomerKeyer } = require('./stats/stats-identity');\n" + m.STATS_STATE, 'stats keyer site');
  s = replaceOnce(s,
    '// PORTAL SPEED P1: getSalesStats moved verbatim to portal/functions.js.\n'
    + 'exports.getSalesStats = portalFunctions.getSalesStats;\n', m.blocks.C, 'block C site');
  return s;
}

module.exports = { foldPortalSplit, movedRegions, PORTAL_TARGETS, REQUIRE_REWRITES };
