'use strict';
/**
 * Portal 1D · D4-P1 Slice A — THE IDENTITY STAMP IS NOT MERCHANT-VISIBLE CONTENT.
 * Run: `node catalog/d4p1-stamp-exclusion.test.js`
 *
 * 🔴 WHY BOTH EXCLUSIONS EXIST, AND WHY THEY ARE ONE SLICE. `display` is fully hashed and fully
 * diffed, and D4-P1 puts a server-owned `identity_id` inside it. Left alone, that has two separate
 * consequences and neither is cosmetic:
 *   · the content fingerprint would change for every object the bootstrap pass stamps — a menu that
 *     nobody edited would read as "the menu changed" to every cache and every downstream consumer;
 *   · the merchant diff would show a merchant their ENTIRE menu as modified, by a field they never
 *     set, cannot see, and cannot act on — and the edit token binds that diff, so it would also
 *     change what the merchant is asked to approve.
 * Both are the same mistake (treating identity as content), so they are proven together.
 */
const assert = require('assert');
const { contentHash, servedPayload } = require('./content-hash');
const { catalogDiff } = require('./catalog-edit');
const { catalogSnapshot } = require('./generate-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-stamp-exclusion: FAILED — exited without completing'); process.exitCode = 1; } });

const clone = (v) => JSON.parse(JSON.stringify(v));
/* Originated from the REAL catalog, not a literal: a hand-built record can omit the very field whose
   handling is under test, and then the exclusion is proven about a shape production never serves. */
const REAL = catalogSnapshot('x_pizza');
const payloadOf = (items, extras) => servedPayload({ rid: 'x_pizza', schema_version: 2, items, extras, structure: { item_order: items.map((i) => i.key) } });
const stamp = (recs, val) => recs.map((r, i) => ({ ...r, display: { ...r.display, identity_id: typeof val === 'function' ? val(i) : val } }));

// ── 1. THE STAMP DOES NOT MOVE THE CONTENT FINGERPRINT ────────────────────────────────────────
{
  const items = clone(REAL.items).slice(0, 6);
  const extras = clone(REAL.extraRecords || []).slice(0, 3);
  assert.ok(items.length && items[0].display, 'premise — real records with a display');

  const bare = contentHash(payloadOf(items, extras));
  const stamped = contentHash(payloadOf(stamp(items, (i) => `IDDISH${i}`), stamp(extras, (i) => `IDEXTRA${i}`)));
  assert.strictEqual(stamped, bare,
    '🔴 stamping moved the served-content fingerprint — the bootstrap pass would read as a menu change to every cache');

  // …and it is still a real hash of real content: a genuine change must move it.
  const changed = clone(items); changed[0].display.name = `${changed[0].display.name} (new)`;
  assert.notStrictEqual(contentHash(payloadOf(changed, extras)), bare,
    '🔴 SENSITIVITY: the hash does not respond to a real display change — it would be excluding everything, not just the stamp');
  const repriced = clone(items); repriced[0].price += 1;
  assert.notStrictEqual(contentHash(payloadOf(repriced, extras)), bare, '🔴 …nor to a price change');
  ok(`the stamp is excluded from the content hash on items AND extras, and a real name/price change still moves it`);
}

// ── 2. A DISPLAY WITH NO STAMP HASHES EXACTLY AS IT ALWAYS DID ────────────────────────────────
/* Pre-P1 versions carry no stamp, and they must hash byte-identically after this change or every
   existing fingerprint in the database silently becomes wrong. */
{
  const items = clone(REAL.items).slice(0, 6);
  const before = payloadOf(items, []);
  assert.deepStrictEqual(before.items.map((r) => r.display), items.map((r) => r.display),
    '🔴 an unstamped display was rewritten by the projection — pre-P1 fingerprints would all shift');
  ok('an unstamped display passes through the projection untouched — pre-P1 fingerprints are unchanged');
}

// ── 3. THE MERCHANT NEVER SEES THE STAMP AS A CHANGE ──────────────────────────────────────────
{
  const live = { items: clone(REAL.items).slice(0, 5), extras: {} };
  const draft = { items: stamp(clone(live.items), (i) => `STAMPED${i}`), extras: {} };

  const d = catalogDiff(live, draft);
  const surfaced = [...(d.changed || []), ...(d.added || []), ...(d.removed || []), ...(d.renamed || [])];
  assert.deepStrictEqual(surfaced, [],
    `🔴 the identity stamp surfaced as a merchant change — a merchant would be shown their whole menu as edited: ${JSON.stringify(d)}`);

  // SENSITIVITY: a real display edit on the same shape still surfaces, so the skip is narrow.
  const realEdit = { items: clone(draft.items), extras: {} };
  realEdit.items[0].display = { ...realEdit.items[0].display, name: `${realEdit.items[0].display.name} X` };
  const d2 = catalogDiff(live, realEdit);
  const surfaced2 = [...(d2.changed || []), ...(d2.added || []), ...(d2.removed || []), ...(d2.renamed || [])];
  assert.ok(surfaced2.length > 0,
    '🔴 SENSITIVITY: a genuine display edit no longer surfaces either — DISPLAY_SKIP is swallowing real changes');
  ok('a stamped-only draft shows the merchant NO change, while a genuine display edit still surfaces');
}

FINISHED = true;
console.log(`\nd4p1-stamp-exclusion: ${n} checks passed`);
