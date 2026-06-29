/**
 * D2 — Structural invariant guard for the /restaurants RTDB rules (Phase 0, Step 1).
 *
 * Load-bearing invariant (cascade-safe Option B): config-plane identity is client-readable
 * ONLY at /restaurants/$restaurant_id/identity, and NO .read/.write grant exists at the
 * /restaurants or $restaurant_id ANCESTOR levels — because RTDB read/write rules cascade and
 * an ancestor grant cannot be revoked at a child, so an ancestor grant would silently expose
 * the sensitive factura_config subtree.
 *
 * This guard runs offline against the canonical rules file (no emulator). It is wired into
 * `npm test` and `npm run check:rules` (which the database predeploy hook runs), so a future
 * edit that violates the invariant fails CI and aborts deploy before any rules upload.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const r = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules.restaurants;

assert(r, 'FAIL: /restaurants stanza missing from canonical rules');

// (1) No grant key at the /restaurants level — even a `false` deny is forbidden here, because an
//     ancestor .read/.write key is a latent footgun (a later flip to a grant would cascade).
assert(!('.read' in r) && !('.write' in r), 'FAIL: .read/.write key present at /restaurants');

// (2) No grant key at the $restaurant_id level (same reason).
const rid = r['$restaurant_id'];
assert(rid, 'FAIL: /restaurants/$restaurant_id missing');
assert(!('.read' in rid) && !('.write' in rid), 'FAIL: .read/.write key present at $restaurant_id');

// (3) The ONLY truthy .read/.write grants under /restaurants live at $restaurant_id/identity.
//     Explicit `false` denies (e.g. factura_config) are allowed anywhere and never flagged.
(function walk(node, segs) {
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '.read' || k === '.write') {
      if (v === false) continue; // explicit deny is fine anywhere
      assert.deepStrictEqual(
        segs,
        ['$restaurant_id', 'identity'],
        `FAIL: truthy ${k} grant at /restaurants/${segs.join('/') || '(root)'} ` +
          `— only $restaurant_id/identity may grant`
      );
    } else if (k !== '.validate') {
      walk(v, segs.concat(k));
    }
  }
})(r, []);

console.log('restaurants-rules.guard: OK (invariant holds — no ancestor grant; only identity grants)');
