'use strict';
// PLAN-A A-1 — catalog/text-version.js unit tests. Run: node catalog/text-version.test.js
//   · textVersionOf: absent → legacy; 'a8' → a8; ANY other present value (incl. null, '', 'A8', 'legacy', numbers,
//     objects) → binding_format_invalid (advisor Q2) — on both the order and the reservation field.
//   · paidTextFor: legacy === int10's sanitizeText(items_text, 1500) byte-for-byte, using index.js's OWN sanitizeText
//     (lifted from the source, not re-typed); 'a8' === the untruncated sanitized text.
//   · markerFields: 'a8' → exactly { field: 'a8' }; everything else → {} (never a default, never a malformed value).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TV = require('./text-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// index.js's own sanitizeText (the real writer of fields.items_text), lifted verbatim from the source
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const m = src.match(/\nfunction sanitizeText\(v, maxLen = 500\) \{[\s\S]*?\n\}\n/);
assert.ok(m, 'index.js still defines sanitizeText(v, maxLen = 500)');
const sanitizeText = new Function(`${m[0]}; return sanitizeText;`)();

// ── textVersionOf ──
{
  for (const field of [TV.ORDER_FIELD, TV.RESERVATION_FIELD]) {
    assert.deepStrictEqual(TV.textVersionOf({}, field), { ok: true, version: 'legacy' });
    assert.deepStrictEqual(TV.textVersionOf({ other: 'a8' }, field), { ok: true, version: 'legacy' });
    assert.deepStrictEqual(TV.textVersionOf({ [field]: undefined }, field), { ok: true, version: 'legacy' });
    assert.deepStrictEqual(TV.textVersionOf(null, field), { ok: true, version: 'legacy' });
    assert.deepStrictEqual(TV.textVersionOf(undefined, field), { ok: true, version: 'legacy' });
    assert.deepStrictEqual(TV.textVersionOf({ [field]: 'a8' }, field), { ok: true, version: 'a8' });
    for (const bad of [null, '', 'A8', 'a8 ', 'legacy', 'a9', 8, true, {}, ['a8']]) {
      assert.deepStrictEqual(TV.textVersionOf({ [field]: bad }, field), { ok: false, reason: 'binding_format_invalid' }, `${field}=${JSON.stringify(bad)}`);
    }
  }
  // the default field is the order's; the reservation's field is never read by default
  assert.deepStrictEqual(TV.textVersionOf({ payment_fingerprint_text_version: 'a8' }), { ok: true, version: 'a8' });
  assert.deepStrictEqual(TV.textVersionOf({ text_version: 'bogus' }), { ok: true, version: 'legacy' });
  // an inherited property is not a marker
  assert.deepStrictEqual(TV.textVersionOf(Object.create({ payment_fingerprint_text_version: 'a8' })), { ok: true, version: 'legacy' });
  ok("textVersionOf: absent → legacy; 'a8' → a8; every other present value → binding_format_invalid (both fields)");
}

// ── paidTextFor ──
{
  const samples = [
    '', 'x', '  1x Carnivora (L340)  ', '1x <b>Pizza</b>\n\tExtra', 'a'.repeat(1499), 'a'.repeat(1500), 'a'.repeat(1501),
    ' '.repeat(10) + 'b'.repeat(1600) + ' '.repeat(10), '<'.repeat(20) + 'c'.repeat(1495), 'é'.repeat(2000), '😀'.repeat(900),
  ];
  for (const raw of samples) {
    const full = sanitizeText(raw, Infinity);
    assert.strictEqual(TV.paidTextFor('legacy', full), sanitizeText(raw, 1500), `legacy === int10 for ${JSON.stringify(raw).slice(0, 40)}`);
    assert.strictEqual(TV.paidTextFor('a8', full), full);
  }
  assert.strictEqual(TV.paidTextFor('legacy', null), '');
  assert.strictEqual(TV.paidTextFor('a8', undefined), '');
  // non-vacuity: the two candidates DIFFER past the legacy bound, and agree within it
  const long = sanitizeText('d'.repeat(1700), Infinity);
  assert.notStrictEqual(TV.paidTextFor('a8', long), TV.paidTextFor('legacy', long));
  assert.strictEqual(TV.paidTextFor('legacy', long).length, TV.LEGACY_PAID_TEXT_MAX);
  assert.strictEqual(TV.LEGACY_PAID_TEXT_MAX, 1500);
  ok("paidTextFor: legacy === index.js sanitizeText(items_text, 1500) byte-for-byte (11 samples incl. trims, strips, surrogates); 'a8' = untruncated");
}

// ── markerFields + the hard-wired write mode ──
{
  assert.deepStrictEqual(TV.markerFields('a8'), { payment_fingerprint_text_version: 'a8' });
  assert.deepStrictEqual(TV.markerFields('a8', TV.RESERVATION_FIELD), { text_version: 'a8' });
  for (const v of ['legacy', undefined, null, '', 'A8', 'x']) {
    assert.deepStrictEqual(TV.markerFields(v), {});
    assert.deepStrictEqual(TV.markerFields(v, TV.RESERVATION_FIELD), {});
  }
  // round trip: what markerFields writes, textVersionOf reads back as the same version
  for (const v of ['legacy', 'a8']) {
    assert.deepStrictEqual(TV.textVersionOf(TV.markerFields(v)), { ok: true, version: v });
    assert.deepStrictEqual(TV.textVersionOf(TV.markerFields(v, TV.RESERVATION_FIELD), TV.RESERVATION_FIELD), { ok: true, version: v });
  }
  assert.strictEqual(TV.WRITE_MODE, 'legacy');
  ok("markerFields: 'a8' → exactly the marker, everything else → {}; round-trips through textVersionOf; WRITE_MODE = 'legacy'");
}

console.log(`\ntext-version.test: OK (${n})`);
