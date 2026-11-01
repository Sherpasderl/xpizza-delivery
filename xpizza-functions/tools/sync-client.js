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
// the order-form adapter: only the `orders` deployments' folders — the FORMS, not the customer app (context 'platform'), whose
// own adapter is customer-app/capp-self-update.js (the forms' adapter depends on form globals; PLAN-capp-S2-r4 §2.2)
const ORDER_SRC = path.join(ROOT, 'platform', 'client', 'order-self-update.js');
const orderFolders = [...new Set(require(path.join(ROOT, 'platform', 'sites.json')).deployments.filter((d) => d.app === 'orders' && d.context !== 'platform').map((d) => d.folder))];
for (const f of orderFolders) fs.copyFileSync(ORDER_SRC, path.join(ROOT, f, 'order-self-update.js'));
// D4-c4: the ONE pause-state interpretation (functions + CLI) → dispatch's committed copy (order-control-state-sync.guard.test.js)
fs.copyFileSync(path.join(ROOT, 'xpizza-functions', 'order-control-state.js'), path.join(ROOT, 'xpizza-dispatch', 'order-control-state.js'));
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2): the ONE rate reader → the functions (ledger, owner CLI) + the driver app
for (const dst of ['xpizza-functions', 'xpizza-driver']) fs.copyFileSync(path.join(ROOT, 'platform', 'client', 'pay-rate.js'), path.join(ROOT, dst, 'pay-rate.js'));
// PLAN-guest-checkout-server §1.4: the ONE cart signature → the functions + every platform-context orders deployment (cart-sig-sync.guard.test.js)
const CART_SIG_SRC = path.join(ROOT, 'platform', 'client', 'cart-sig.js');
const cartSigFolders = ['xpizza-functions', ...new Set(require(path.join(ROOT, 'platform', 'sites.json')).deployments.filter((d) => d.app === 'orders' && d.context === 'platform').map((d) => d.folder))];
for (const f of cartSigFolders) fs.copyFileSync(CART_SIG_SRC, path.join(ROOT, f, 'cart-sig.js'));
console.log(`sync-client: copied sherpa-client.js into ${folders.length} site folders, order-self-update.js into ${orderFolders.length}, order-control-state.js into xpizza-dispatch, pay-rate.js into xpizza-functions + xpizza-driver, cart-sig.js into ${cartSigFolders.length} folders`);
