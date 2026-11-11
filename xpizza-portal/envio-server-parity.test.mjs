// «Envío» step 1 (PLAN-portal-envio-step1 r2 §5, Codex r1 F5) — the screen's band rules EQUAL the server's. Run:
//   node --test xpizza-portal/envio-server-parity.test.mjs
// The server side is 5f's REAL writer validator (xpizza-functions/delivery/pricing-admin-core.js validateWrite, whole lempiras
// since 0021632f), never a copy. Over a generated domain — valid tables, every single-rule violation, negatives, malformed
// numbers, duplicate / decreasing km, the empty table, 21 bands, extra / missing keys, non-hundred cents — the screen accepts a
// table exactly when the server would, and every body the screen builds passes the server.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { acceptsBands, rowsFromBands, toBody, validate } from './envio-logic.js';

const require = createRequire(import.meta.url);
const { validateWrite, CAPS } = require('../xpizza-functions/delivery/pricing-admin-core.js');
const serverAccepts = (bands) => validateWrite({ expected_policy_version: 3, bands }).ok === true;

const KMS = [0.5, 1, 2.5, 3, 6, 9.5, 10, 0, -1, 0.25, 2.3, 10.5, 12, 1e-9, NaN, Infinity, '3', null];
const CENTS = [0, 100, 4000, 15000, 15100, 250, 1, -100, 4000.5, NaN, '4000', null, 2 ** 53];

function* domain() {
  yield [];
  for (const km of KMS) for (const cents of CENTS) yield [{ max_km: km, cents }];
  for (const km of KMS) yield [{ max_km: 3, cents: 4000 }, { max_km: km, cents: 6000 }];
  yield [{ max_km: 3, cents: 4000 }, { max_km: 3, cents: 5000 }];                     // duplicate km
  yield [{ max_km: 6, cents: 4000 }, { max_km: 3, cents: 5000 }];                     // decreasing
  yield [{ max_km: 3, cents: 4000, extra: 1 }];                                      // extra key
  yield [{ max_km: 3 }];                                                             // missing key
  yield [{ cents: 4000 }];
  yield [null]; yield ['3']; yield [[3, 4000]];
  for (const n of [1, 19, 20, 21, 25]) yield Array.from({ length: n }, (_, i) => ({ max_km: (i + 1) / 2, cents: 1000 }));
  yield Array.from({ length: 20 }, (_, i) => ({ max_km: 0.5 + i * 0.5, cents: 15000 }));
  for (const top of [9.5, 10, 10.5]) yield [{ max_km: 1, cents: 0 }, { max_km: top, cents: 15000 }];
  yield 'bands'; yield null; yield {};
}

test('the server validator is the whole-lempira, .5 km one these rules mirror', () => {
  assert.deepStrictEqual(CAPS, { max_bands: 20, max_km: 10, max_cents: 15000, km_step: 0.5 });
  assert.strictEqual(serverAccepts([{ max_km: 3, cents: 250 }]), false, 'whole lempiras on the server (cents % 100)');
});

test('UI accepts ≡ server accepts, over the whole domain', () => {
  let n = 0, yes = 0;
  for (const bands of domain()) {
    n++;
    const ui = acceptsBands(bands), srv = serverAccepts(bands);
    if (srv) yes++;
    assert.strictEqual(ui, srv, `disagree on ${JSON.stringify(bands)}: ui ${ui}, server ${srv}`);
  }
  assert.ok(n > 250 && yes > 30 && n - yes > 200, `non-vacuity: ${n} tables, ${yes} accepted`);
});

test('every body the screen builds from typed rows passes the server; every table it refuses, the server refuses too', () => {
  const typed = [
    [['3', '40'], ['6,5', '60'], ['10', '150']], [['0.5', '0']], [['9.5', '150'], ['10', '150']],
    [['3', '40.5']], [['3', '151']], [['10.5', '40']], [['2.3', '40']], [['3', ''], ['', '40']], [['6', '40'], ['6', '50']],
  ];
  for (const t of typed) {
    const rows = t.map(([km, fee]) => ({ km, fee }));
    const v = validate(rows);
    if (v.valid) assert.strictEqual(validateWrite(toBody(rows, 3)).ok, true, JSON.stringify(t));
    else assert.strictEqual(serverAccepts(v.bands), false, JSON.stringify(t));
  }
});

test('a stored table round-trips through the screen unchanged (no silent rounding)', () => {
  for (const bands of domain()) {
    if (!serverAccepts(bands)) continue;
    assert.deepStrictEqual(toBody(rowsFromBands(bands), 3).bands, bands);
  }
});
