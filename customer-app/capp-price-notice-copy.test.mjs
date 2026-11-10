// Customer app — the Plan 5 price-notice COPY, one source with the forms (PLAN-capp-S7a r3.4-2; APPROVED as a plan). The pin's
// baseline is a COMMITTED fixture, fixtures/price-notice-text.body.txt: the exact bytes between the braces of the forms'
// `priceNoticeText`, taken from commit b8ba8467 (feat(forms): cart price-change notice), where xpizza-orders/index.html:2167 and
// la-musa-orders/index.html:2509 carry the identical body — 132 bytes, sha-256 f3a81b9e…bdb0. That commit is not in this base,
// so the fixture is the baseline; when a base DOES carry the forms' helper, each form is pinned to it too.
// Run: node --test customer-app/capp-price-notice-copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = readFileSync(join(HERE, 'fixtures/price-notice-text.body.txt'));
const FIXTURE_SHA = 'f3a81b9e7dd7dcbe02a7e8ea02702f6886e22a5ff35646134c4190d77b53bdb0';
// Codex perf-core r1 #8: PRESENCE is detected loosely (any spacing), EXTRACTION strictly; present-but-not-extractable FAILS
const PRESENT = /function\s+priceNoticeText\s*\(/g;
const EXTRACT = /function\s+priceNoticeText\s*\(\s*e\s*\)\s*\{([^}]*)\}/g;
const bodies = (src) => [...src.matchAll(EXTRACT)].map((m) => m[1]);
// one form source → 'absent' | 'ok' | throws (present but not exactly one extractable, non-empty body equal to the fixture)
function checkForm(label, src) {
  const present = (src.match(PRESENT) || []).length;
  if (!present) return 'absent';
  const b = bodies(src);
  assert.equal(present, 1, `🔴 ${label}: exactly one priceNoticeText (${present} present)`);
  assert.equal(b.length, 1, `🔴 ${label}: present but not extractable`);
  assert.ok(b[0].length > 0, `🔴 ${label}: a non-empty body`);
  assert.ok(sameAsFixture(b[0]), `🔴 ${label}: differs from the fixture: ${JSON.stringify(b[0])}`);
  return 'ok';
}
const capp = () => readFileSync(join(HERE, 'capp-checkout.js'), 'utf8');
const sameAsFixture = (body) => Buffer.from(body, 'utf8').equals(FIXTURE);

test('r3.4-2: the fixture is exactly the b8ba8467 body — 132 bytes, sha-256 f3a81b9e…bdb0 (the pin cannot drift silently)', () => {
  assert.equal(FIXTURE.length, 132);
  assert.equal(createHash('sha256').update(FIXTURE).digest('hex'), FIXTURE_SHA);
});

test('r3.4-2: the capp priceNoticeText body is BYTE-EQUAL to the fixture (exactly one, non-empty)', () => {
  const b = bodies(capp());
  assert.equal(b.length, 1, 'exactly one priceNoticeText in capp-checkout.js');
  assert.ok(b[0].length > 0);
  assert.ok(sameAsFixture(b[0]), `🔴 the capp copy drifted from the forms': ${JSON.stringify(b[0])}`);
});

test('r3.4-2: where a form carries the helper in THIS base, exactly one extractable non-empty body per form, each equal to the fixture', () => {
  for (const f of ['xpizza-orders/index.html', 'la-musa-orders/index.html']) {
    const p = join(ROOT, f);
    assert.ok(existsSync(p), `premise: ${f} exists`);
    if (checkForm(f, readFileSync(p, 'utf8')) === 'absent') console.log(`    ${f}: priceNoticeText not in base (pre-Plan-5) — the fixture alone pins the copy`);
  }
});

test('r3.4-2 NEGATIVE CONTROLS (Codex perf-core r1 #8): a present helper with the WRONG COPY, or one that cannot be extracted, FAILS', () => {
  // the controls inject into a form WITHOUT the helper: on a base that already carries Plan 5 (main's b8ba8467 composed in), the
  // form's own priceNoticeText is removed first — otherwise every injection trips «exactly one» before the check under test
  const src = readFileSync(join(ROOT, 'xpizza-orders/index.html'), 'utf8');
  const base = src.replace(/function\s+priceNoticeText\s*\([^)]*\)\s*\{[^}]*\}/g, '');
  assert.equal((base.match(PRESENT) || []).length, 0, 'premise: the control base carries no priceNoticeText');
  const wrong = base + "\nfunction priceNoticeText(e) { return 'WRONG COPY'; }\n";
  assert.throws(() => checkForm('wrong-copy', wrong), /differs from the fixture/, '🔴 a WRONG COPY injection is caught (any spacing)');
  const odd = base + "\nfunction priceNoticeText (e, x) { return 'x'; }\n";
  assert.throws(() => checkForm('unextractable', odd), /present but not extractable/, '🔴 present but unextractable fails, never "not in base"');
  const right = base + `\nfunction priceNoticeText(e){${FIXTURE.toString('utf8')}}\n`;
  assert.equal(checkForm('right', right), 'ok', 'premise: the fixture body itself passes');
});

test('r3.4-2 NEGATIVE CONTROL: a one-character copy mutation of the capp body is caught by the same comparison', () => {
  const mutated = capp().replace("' + e.name + ': antes L '", "' + e.name + ': ante L '");
  assert.notEqual(mutated, capp(), 'premise: the mutation applied');
  const b = bodies(mutated);
  assert.equal(b.length, 1);
  assert.equal(sameAsFixture(b[0]), false, '🔴 the comparison must fail on a mutated copy');
});

test('r3.4-2: the shared copy renders the approved sentence', async () => {
  const { priceNoticeText } = createRequire(import.meta.url)('./capp-checkout.js');
  assert.equal(priceNoticeText({ name: 'Carnivora', from: 340, to: 366 }), 'Cambió el precio de Carnivora: antes L 340, ahora L 366.');
});
