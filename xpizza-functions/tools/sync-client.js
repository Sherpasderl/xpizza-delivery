'use strict';
// P-SELFUPDATE CP2 — copy the canonical shared browser module (<repo>/platform/client/sherpa-client.js) into EVERY
// manifest site folder, byte-for-byte (advisor ruling CP2 Q3). Netlify publishes each folder on its own, so each needs
// its own committed copy. pselfupdate-client-sync.guard.test.js fails on any drift.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'platform', 'client', 'sherpa-client.js');
const folders = [...new Set(require(path.join(ROOT, 'platform', 'sites.json')).deployments.map((d) => d.folder))];
for (const f of folders) fs.copyFileSync(SRC, path.join(ROOT, f, 'sherpa-client.js'));
// PLAN-avail-identity (capp readAvailability): the ONE availability key encoder + 86 decision rule (canonical in xpizza-functions,
// byte-identical across forms / KDS / server) → the customer app's folder (the platform orders deployment), so the app decides
// availability exactly as the forms and the server do (capp-guards pins each copy byte-identical to its source)
for (const f of [...new Set(require(path.join(ROOT, 'platform', 'sites.json')).deployments.filter((d) => d.app === 'orders' && d.context === 'platform').map((d) => d.folder))])
  for (const m of ['avail-key.js', 'availability-reducer.js']) fs.copyFileSync(path.join(ROOT, 'xpizza-functions', m), path.join(ROOT, f, m));
// the order-form adapter: only the `orders` deployments' folders — the FORMS, not the customer app (context 'platform'), whose
// own adapter is customer-app/capp-self-update.js (the forms' adapter depends on form globals; PLAN-capp-S2-r4 §2.2)
const ORDER_SRC = path.join(ROOT, 'platform', 'client', 'order-self-update.js');
const orderFolders = [...new Set(require(path.join(ROOT, 'platform', 'sites.json')).deployments.filter((d) => d.app === 'orders' && d.context !== 'platform').map((d) => d.folder))];
for (const f of orderFolders) fs.copyFileSync(ORDER_SRC, path.join(ROOT, f, 'order-self-update.js'));
// D4-c4: the ONE pause-state interpretation (functions + CLI) → dispatch's committed copy (order-control-state-sync.guard.test.js)
fs.copyFileSync(path.join(ROOT, 'xpizza-functions', 'order-control-state.js'), path.join(ROOT, 'xpizza-dispatch', 'order-control-state.js'));
console.log(`sync-client: copied sherpa-client.js into ${folders.length} site folders, order-self-update.js into ${orderFolders.length}, order-control-state.js into xpizza-dispatch`);
