'use strict';
// Portal 1D · D4-P1 — THE PRE-P1 CONTROL CAPTURE (§8a), kept for provenance, NOT run by CI.
//
// 🔴 IT LIVES IN test/, NOT tools/, DELIBERATELY. rtdb-init.test.js scans tools/ and requires every
// RTDB-touching CLI there to pin databaseURL from the shared constant — the guard that catches an
// owner-run tool pointed at the wrong database instance. This is not one of those: it is an
// emulator-only capture harness that takes its app from index.js and is never run against
// production. Filing it under tools/ would have made it claim to be a production CLI, and the guard
// correctly refused it. (It refused it on the FIRST npm test after I added it, which is the guard
// doing exactly its job.)
//
// 🔴 THIS MUST NEVER BE RE-RUN AGAINST P1 CODE. It produced catalog/d4p1-order-precontrol.golden.json
// on pristine pre-P1 code (dc7d9f7). Re-running it now would rewrite the control to agree with
// whatever P1 currently does, which is the one thing the control exists to refuse. It is committed so
// the golden is auditable and reproducible from a pre-P1 checkout — not so it can be regenerated.
//
// It drives the REAL createOrder handler against real emulators and captures the STORED order twice,
// diffing the two to discover which fields are volatile rather than assuming a list.
const http = require('http');
const express = require('express');
const { execSync } = require('child_process');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'capture-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const SECRET = process.env.MAKE_SECRET;

const realWhatsapp = require('../whatsapp');
const r = require.resolve('../whatsapp');
require.cache[r] = { id: r, filename: r, loaded: true, exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }, children: [], paths: [] };

const app = require('../index.js');
const admin = require('firebase-admin');
const db = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');

const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2,
  delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: res.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}

// 🔴 CATALOG-AUTHORITATIVE, NOT THE RETIRED CODE PRICE TABLES. An earlier version of this cart read
// the pre-2c in-code price constants and catalog/no-code-authority.guard.test.js refused the file —
// correctly: pricing from them would mean the control was captured against a source the server no
// longer treats as authoritative. The catalog is the source; the names and prices below come out of it.
// (Written as line comments deliberately: the guard strips `//` before scanning but not `/* */`, so a
// block comment explaining the rule trips the very rule it explains.)
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
let seq = 0;
const cartFor = (rid) => {
  const snap = catalogSnapshot(rid);
  const [i0, i1] = snap.items;
  const e0 = snap.extras[0];
  const line = (rec, qty, extras) => (rid === 'la_musa'
    ? { id: rec.display.id, name: rec.display.name, cat: rec.display.cat, qty, price: rec.price, extras }
    : { name: rec.display.name, qty, price: rec.price, extras });
  return [
    line(i0, 2, [rid === 'la_musa'
      ? { id: e0.display.id, name: e0.display.name, price: e0.price, qty: 1 }
      : { instance: 0, name: e0.display.name, price: e0.price }]),
    line(i1, 1, []),
  ];
};

const bodyFor = (rid, orderId) => ({
  restaurant_id: rid, order_id: orderId, customer_name: 'Control', customer_phone: `9999${String(2000 + (seq += 1))}`,
  items_text: 'control order', order_type: 'pickup', payment_method: 'cash', items: cartFor(rid),
});

(async () => {
  const { publishVersion } = require('../catalog/catalog-publish');
  for (const rid of ['x_pizza', 'la_musa']) {
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'd4p1-control' });
    await publishVersion(fs, rid, input, { expected: { activeVersionId: null } });
    await db.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
  }
  const out = { _provenance: { captured_from: execSync('git rev-parse HEAD').toString().trim(),
    what: 'PRE-P1 control captured through the REAL createOrder handler (§8a). Never regenerate.' }, brands: {} };

  for (const rid of ['x_pizza', 'la_musa']) {
    // TWO captures of the same logical order → whatever differs is volatile and gets normalized.
    const caps = [];
    for (let i = 0; i < 2; i += 1) {
      const id = `CTL-${rid}-${i}`;
      const res = await post(app.createOrder, bodyFor(rid, id));
      if (res.status !== 200) throw new Error(`${rid}: control order failed ${res.status}: ${res.text}`);
      caps.push((await db.ref(`orders/${id}`).once('value')).val());
    }
    const volatile = [];
    const walk = (a, b, path) => {
      const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        const va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
        if (va && vb && typeof va === 'object' && typeof vb === 'object') walk(va, vb, p);
        else if (JSON.stringify(va) !== JSON.stringify(vb)) volatile.push(p);
      }
    };
    walk(caps[0], caps[1], '');
    out.brands[rid] = { stored_order: caps[0], volatile_fields: volatile.sort() };
  }
  require('fs').writeFileSync(process.env.CAPTURE_OUT, JSON.stringify(out, null, 2));
  console.log('CAPTURE OK ->', process.env.CAPTURE_OUT);
  process.exit(0);
})().catch((e) => { console.error('CAPTURE FAILED:', (e && e.stack) || e); process.exit(1); });
