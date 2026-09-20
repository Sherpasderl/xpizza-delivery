#!/usr/bin/env node
'use strict';
/* Refuse to run the portal suites with their declared dependencies missing, and SAY WHY.
 *
 * 🔴 WHY THIS EXISTS. xpizza-portal declares acorn and acorn-walk and its node_modules is gitignored,
 * so a fresh checkout NEVER has them. The suites then die with ERR_MODULE_NOT_FOUND from inside
 * wiring-ast.mjs, which reads like a broken import in the portal code rather than a missing install —
 * I misread it exactly that way and reported it as a dependency bug that needed declaring, when the
 * declaration was already there. Two checkouts had it uninstalled at the same time and neither knew.
 *
 * This does NOT excuse the failure. A missing install means those suites are not running, which is
 * the state the whole gate sweep exists to make visible. It stays red — it just stops lying about
 * what is wrong.
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const PORTAL = path.join(__dirname, '..', '..', 'xpizza-portal');
const manifest = path.join(PORTAL, 'package.json');

if (!fs.existsSync(manifest)) {
  console.error(`\n🔴 portal preflight — no package.json at ${PORTAL}`);
  console.error('   The portal test scripts point at a directory that is not there.\n');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const declared = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
// Resolve AS THE PORTAL WOULD: node walks up from xpizza-portal, so a copy sitting in
// xpizza-functions/node_modules does not count and must not make this pass.
const resolver = createRequire(path.join(PORTAL, 'package.json'));
const missing = declared.filter((d) => { try { resolver.resolve(d); return false; } catch { return true; } });

if (missing.length) {
  console.error(`\n🔴 PORTAL SUITES CANNOT RUN — ${missing.length} declared dependenc${missing.length === 1 ? 'y is' : 'ies are'} not installed.\n`);
  console.error(`   missing   : ${missing.join(', ')}`);
  console.error(`   directory : ${PORTAL}`);
  console.error(`   fix       : npm --prefix "${PORTAL}" install\n`);
  console.error('   That directory\'s node_modules is GITIGNORED, so every fresh checkout needs this');
  console.error('   install — it is not a one-off. Without it these suites do not run at all, which');
  console.error('   is a real gap in coverage, not a skippable inconvenience.\n');
  process.exit(1);
}
