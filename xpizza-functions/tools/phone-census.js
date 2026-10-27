#!/usr/bin/env node
'use strict';
// INTL PHONE S-core step 3 — the owner's PHONE CENSUS (read-only). Run BEFORE flipping config/phone_wire_strict:
//
//   node tools/phone-census.js --project xpizza-delivery [--days 30]
//
// Classes every order created in the window by what the strict wire contract would do with its stored customer_phone, per restaurant.
// flip_safe:true ⇔ nothing in the window would be rejected. Output is COUNTS ONLY (no phone, digits, hash or order id).
// Reads only (one ranged read of /orders on the indexed created_at). Writes nothing anywhere.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // --project mandatory, before any client
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const C = require('./phone-census-core');

const parsed = C.parseArgs(process.argv.slice(2));
if (!parsed.ok) { console.error(`phone-census: REFUSED — ${parsed.error}`); process.exit(2); }

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });

(async () => {
  const now = Date.now();
  const since = now - parsed.days * 86400e3;
  const orders = (await admin.database().ref('orders').orderByChild('created_at').startAt(since).once('value')).val() || {};
  console.log(JSON.stringify({ project: PROJECT_ID, generated_at: new Date(now).toISOString(), ...C.aggregate(orders, { nowMs: now, days: parsed.days }) }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('phone-census FAILED:', e && e.code ? e.code : 'error'); process.exit(1); });
