'use strict';

/**
 * Dep-free tests for the config-plane reader (restaurant-config.js). Fake RTDB; deterministic via
 * injected `now`. Covers fresh/cache/fail-closed, no-poison, TTL boundary, and 3a inertness.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { getIdentity, hubSnapshot, TTL_MS, _cache } = require('./restaurant-config');

const VALID = {
  name: 'X Pizza', hub_lat: 15.5, hub_lng: -88.0, phone: '+50497952893',
  whatsapp_instance: 'i1', whatsapp_enabled: true, delivery_radius_km: 7,
  hours: { sun: { open: false } }, active: true, version: 1,
};

// Fake db: programmable single response per .once() via setNext({val}|{missing}|{error}).
function makeDb() {
  const db = {
    _next: null,
    ref() {
      return {
        once: async () => {
          const n = db._next;
          if (!n) throw new Error('fake: no _next');
          if (n.error) throw n.error;
          const exists = !n.missing;
          return { exists: () => exists, val: () => (n.missing ? null : n.val) };
        },
      };
    },
    setNext(n) { db._next = n; return db; },
  };
  return db;
}

const db = makeDb();
const RID = 'x_pizza';
const reset = () => _cache.clear();
const failsClosed = async (pr) => {
  await assert.rejects(pr, (e) => e.statusCode === 503 && e.retryable === true);
};
let pass = 0;
const t = (label) => { pass++; console.log(`  ✓ ${pass} ${label}`); };

(async () => {
  // 1) fresh valid -> _source 'fresh', caches identity + version
  reset(); db.setNext({ val: VALID });
  let r = await getIdentity(db, RID, 1000);
  assert.equal(r._source, 'fresh'); assert.equal(r.hub_lat, 15.5);
  assert.equal(_cache.get(RID).version, 1);
  t('fresh valid -> caches');

  // 2) read-fail + warm cache (within TTL) -> 'cache'
  db.setNext({ error: new Error('rtdb down') });
  r = await getIdentity(db, RID, 1000 + 10_000);
  assert.equal(r._source, 'cache'); assert.equal(r.hub_lat, 15.5);
  t('read-fail + warm cache -> serves cache');

  // 3) stale past TTL (read-fail) -> 503
  db.setNext({ error: new Error('rtdb down') });
  await failsClosed(getIdentity(db, RID, 1000 + TTL_MS + 1));
  t('stale past TTL -> 503');

  // 4) cold cache + unreadable -> 503
  reset(); db.setNext({ error: new Error('rtdb down') });
  await failsClosed(getIdentity(db, RID, 5000));
  t('cold + unreadable -> 503');

  // 5) missing identity + cold cache -> 503
  reset(); db.setNext({ missing: true });
  await failsClosed(getIdentity(db, RID, 5000));
  t('missing + cold -> 503');

  // 6) missing identity + warm cache -> serves cache
  reset(); db.setNext({ val: VALID }); await getIdentity(db, RID, 1000);
  db.setNext({ missing: true });
  r = await getIdentity(db, RID, 1000 + 5_000);
  assert.equal(r._source, 'cache');
  t('missing + warm cache -> serves cache');

  // 7) deleted-while-warm, past TTL -> 503
  db.setNext({ missing: true });
  await failsClosed(getIdentity(db, RID, 1000 + TTL_MS + 1));
  t('deleted + past TTL -> 503');

  // 8) active:false fresh AND cached -> returns normally (caller gates)
  reset(); db.setNext({ val: { ...VALID, active: false } });
  r = await getIdentity(db, RID, 2000);
  assert.equal(r.active, false); assert.equal(r._source, 'fresh');
  db.setNext({ error: new Error('down') });
  r = await getIdentity(db, RID, 2000 + 1000);
  assert.equal(r.active, false); assert.equal(r._source, 'cache');
  t('active:false returns normally (fresh + cached)');

  // 9/10) cache refresh after a hit; version change replaces cached identity+version
  reset(); db.setNext({ val: VALID }); await getIdentity(db, RID, 1000);
  db.setNext({ val: { ...VALID, hub_lat: 16.0, version: 2 } });
  r = await getIdentity(db, RID, 9000);
  assert.equal(r._source, 'fresh'); assert.equal(r.hub_lat, 16.0);
  assert.equal(_cache.get(RID).version, 2); assert.equal(_cache.get(RID).fetched_at, 9000);
  t('refresh after hit replaces cached identity + version');

  // 11) malformed fresh does NOT poison a good cache
  reset(); db.setNext({ val: VALID }); await getIdentity(db, RID, 1000);
  db.setNext({ val: { ...VALID, hub_lat: 'oops' } }); // routing-invalid
  r = await getIdentity(db, RID, 1000 + 2000);
  assert.equal(r._source, 'cache'); assert.equal(r.hub_lat, 15.5); // prior good
  assert.equal(_cache.get(RID).version, 1); assert.equal(_cache.get(RID).identity.hub_lat, 15.5);
  t('malformed fresh does not poison good cache');

  // 12) exact TTL boundary: age===TTL serves cache; age===TTL+1 -> 503
  reset(); db.setNext({ val: VALID }); await getIdentity(db, RID, 1000);
  db.setNext({ error: new Error('down') });
  r = await getIdentity(db, RID, 1000 + TTL_MS); // age == TTL
  assert.equal(r._source, 'cache');
  db.setNext({ error: new Error('down') });
  await failsClosed(getIdentity(db, RID, 1000 + TTL_MS + 1)); // age == TTL+1
  t('exact TTL_MS boundary');

  // 13) reader-extension (#1): the fields 3b relies on are validated; malformed fresh is NOT cached.
  for (const bad of [
    { ...VALID, delivery_radius_km: undefined },
    { ...VALID, delivery_radius_km: NaN },
    { ...VALID, name: '' },
    { ...VALID, phone: 123 },
    { ...VALID, hub_lat: 'x' },
  ]) {
    reset(); db.setNext({ val: bad });
    await failsClosed(getIdentity(db, RID, 1000)); // malformed + cold cache -> 503 (not cached)
  }
  t('reader extension: malformed delivery_radius_km/name/phone/hub not cached (-> 503)');

  // 14) hubSnapshot allowlist (#2): exactly the 4 snapshot fields, no reader-metadata leak.
  const snap = hubSnapshot({ ...VALID, _source: 'fresh', _fetched_at: 1, active: true, version: 9, hours: {} });
  assert.deepEqual(Object.keys(snap).sort(), ['hub_lat', 'hub_lng', 'restaurant_name', 'restaurant_phone']);
  assert.equal(snap.restaurant_name, VALID.name);
  assert.equal(snap.restaurant_phone, VALID.phone);
  t('hubSnapshot allowlist: 4 fields only, no metadata leak');

  // 15) wiring check (3b): the reader is now imported by index.js (the order-creation paths).
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert(/require\(\s*['"]\.\/restaurant-config['"]\s*\)/.test(idx),
    'index.js must import restaurant-config (3b wires the reader into the order-creation paths)');
  t('wiring check: index.js imports the reader');

  console.log(`restaurant-config: OK (${pass} cases)`);
})().catch((e) => { console.error('restaurant-config: FAIL\n', e); process.exit(1); });
