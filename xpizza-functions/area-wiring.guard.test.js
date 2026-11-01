'use strict';
// Order colonia (PLAN-colonia-address-area r1, Codex r2 APPROVED) — hot-file wiring guard (index.js inverse-fold invariant; see
// memory index-js-inverse-fold-invariant). The slice's hunks on byte-pinned files are SAME-LINE (tools/area-inverse.js, composed
// INNERMOST into every index.js fold guard and every create-order-build.js module pin). This guard proves:
//   (i)   unapplyAreaIndex(index.js) / unapplyAreaModule(create-order-build.js) === e051df4c BYTE-FOR-BYTE, with sensitivity, and
//         no line inserted;
//   (ii)  STRUCTURALLY: the field is computed ONLY in validateOrderPayload, through addressAreaFrom, behind the inline delivery
//         predicate; both writers are conditional; nothing reads address_detected / address_details to produce it;
//   (iii) charge-inputs classifies address_area as NON-charge (so the reward fingerprint stays defined).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const stripComments = require('./tools/strip-comments');
const { HUNKS, FILES, BASE, unapplyAreaIndex, unapplyAreaModule } = require('./tools/area-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');   // this slice is the NEWEST: nothing composes on top
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── (i) the inverse ──
{
  const live = require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(read('index.js')))))))))))); const baseIdx = baseOf('index.js');   // DRYRUN R-WIRE (2e): 10 cross-side layers innermost (the line-67 AST read stays raw)
  assert.strictEqual(unapplyAreaIndex(live), baseIdx, `🔴 index.js minus the colonia hunks is not ${BASE}:index.js`);
  assert.notStrictEqual(live, baseIdx, 'non-vacuity: the slice is present in index.js');
  assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'index.js same-line: no line inserted');
  const h = HUNKS.find((x) => x.file === 'index.js');
  assert.throws(() => unapplyAreaIndex(live.replace(h.now, h.now.replace('addressAreaFrom', 'addressAreaFrm'))), /exactly once/, 'index.js: a byte INSIDE a hunk');
  assert.throws(() => unapplyAreaIndex(live + h.now), /exactly once/, 'index.js: a DUPLICATED hunk');
  assert.throws(() => unapplyAreaIndex(live.replace(h.now, '')), /exactly once/, 'index.js: a MISSING hunk');
  assert.notStrictEqual(unapplyAreaIndex(live.replace('function sanitizeText(', 'function  sanitizeText(')), baseIdx, 'index.js: a byte OUTSIDE every hunk fails the base pin');

  assert.deepStrictEqual([...FILES], ['create-order-build.js']);
  for (const f of FILES) {
    const src = read(f); const base = baseOf(f);
    assert.strictEqual(unapplyAreaModule(f, src), base, `🔴 ${f} minus the colonia hunks is not ${BASE}:${f}`);
    assert.notStrictEqual(src, base, `non-vacuity: ${f} carries the slice`);
    assert.strictEqual(src.split('\n').length, base.split('\n').length, `${f} same-line: no line inserted`);
    const m = HUNKS.find((x) => x.file === f);
    assert.throws(() => unapplyAreaModule(f, src.replace(m.now, m.now.replace('address_area', 'address_aera'))), /exactly once/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyAreaModule(f, src + m.now), /exactly once/, `${f}: a DUPLICATED hunk`);
    assert.notStrictEqual(unapplyAreaModule(f, src.replace("'use strict';", "'use strict'; ")), base, `${f}: a byte OUTSIDE every hunk fails the base pin`);
  }
  assert.strictEqual(unapplyAreaModule('unlisted-module.js', 'x'), 'x', 'an unlisted module passes through');
  ok(`inverse: unapplyAreaIndex / unapplyAreaModule → ${BASE} byte-for-byte (${HUNKS.length} same-line hunks over index.js + ${FILES.join(', ')}); inside / duplicated / missing / outside each detected`);
}

// ── (i-b) the charge-inputs line inverse (Codex colonia r1 P2-2): removes ONLY the address_area NON_CHARGE_FIELDS entry ──
{
  const CIV = require('./tools/area-charge-inputs-inverse');
  const src = read(CIV.FILE); const base = baseOf(CIV.FILE);
  assert.strictEqual(CIV.BASE, BASE, 'the same base as area-inverse');
  assert.strictEqual(CIV.unapplyAreaChargeInputs(src), base, `🔴 ${CIV.FILE} minus the address_area entry is not ${BASE}:${CIV.FILE}`);
  assert.notStrictEqual(src, base, `non-vacuity: ${CIV.FILE} carries the entry`);
  assert.strictEqual(src.split('\n').length, base.split('\n').length + 1, 'exactly ONE line inserted by the slice');
  assert.ok(/^  entry_mode: /m.test(CIV.unapplyAreaChargeInputs(src)), 'entry_mode (S3b) stays');
  assert.throws(() => CIV.unapplyAreaChargeInputs(src.replace(CIV.LINE, CIV.LINE.replace('display only', 'display-only'))), /exactly once/, 'a byte INSIDE the entry');
  assert.throws(() => CIV.unapplyAreaChargeInputs(src + CIV.LINE), /exactly once/, 'a DUPLICATED entry');
  assert.throws(() => CIV.unapplyAreaChargeInputs(base), /exactly once/, 'a MISSING entry');
  assert.notStrictEqual(CIV.unapplyAreaChargeInputs(src.replace("'use strict';", "'use strict'; ")), base, 'a byte OUTSIDE the entry fails the base pin');
  assert.strictEqual(CIV.unapplyAreaChargeInputsModule('index.js', 'x'), 'x', 'any other module passes through');
}
ok(`charge-inputs line inverse: unapplyAreaChargeInputs → ${BASE}:catalog/charge-inputs.js byte-for-byte (one line, entry_mode kept); inside / duplicated / missing / outside each detected`);

// ── (ii) structure ──
{
  const idx = stripComments(read('index.js')); const cob = stripComments(read('create-order-build.js'));
  const uses = (src) => (src.match(/address_area/g) || []).length;
  const v0 = idx.indexOf('function validateOrderPayload('); const v1 = idx.indexOf('return { errors, total, lat, lng, fields };', v0);
  assert.ok(v0 > 0 && v1 > v0, 'premise: validateOrderPayload');
  const validator = idx.slice(v0, v1);
  assert.ok(/address_area: body\.order_type === 'delivery' \? require\('\.\/address-area'\)\.addressAreaFrom\(body\.address_area\) : ''/.test(validator), 'the field = addressAreaFrom(body.address_area) behind the inline delivery predicate, in validateOrderPayload');
  assert.ok(/if \(fields\.address_area\) pendingOrderRecord\.address_area = fields\.address_area;/.test(idx), 'chargeOnlineOrder writes it ONLY when kept');
  assert.ok(/if \(fields\.address_area\) orderRecord\.address_area = fields\.address_area;/.test(cob), 'buildCreateOrderUpdates writes it ONLY when kept');
  assert.strictEqual(uses(idx), 5, 'index.js: address_area appears ONLY in the validator (key + body read) and the conditional pending writer (3)');
  assert.strictEqual(uses(cob), 3, 'create-order-build.js: ONLY the conditional writer');
  const areaExpr = validator.slice(validator.indexOf('address_area:')).split('\n')[0];
  assert.ok(areaExpr.length > 20 && !/address_detected|address_details/.test(areaExpr), 'no derivation from address_detected / address_details');
  for (const f of ['materialize.js', 'whatsapp.js', 'factura/build-record.js', 'order-dedup.js', 'pixelpay-charge.js', 'catalog/canonical-binding.js']) {
    assert.strictEqual(uses(stripComments(read(f))), 0, `${f} does not read address_area (display-only for the driver)`);
  }
}
ok('structure: computed ONLY in validateOrderPayload via addressAreaFrom behind `body.order_type === \'delivery\'`; both writers conditional; no free-text derivation; materialize / WhatsApp / factura / dedup / PixelPay hash / canonical binding never read it');

// ── (iii) charge-input census ──
{
  const CI = require('./catalog/charge-inputs');
  assert.ok(Object.prototype.hasOwnProperty.call(CI.NON_CHARGE_FIELDS, 'address_area') && !CI.CHARGE_INPUT_FIELDS.includes('address_area'), 'address_area is NON-charge');
  const body = { order_id: 'XP-1', restaurant_id: 'x_pizza', items: [], order_type: 'delivery', lat: 15.5, lng: -88, address_detected: 'A', address_details: 'B' };
  const fp = CI.chargeInputsFingerprint(body);
  assert.ok(fp, 'premise: a fingerprint');
  assert.strictEqual(CI.chargeInputsFingerprint({ ...body, address_area: 'Colonia Trejo' }), fp, 'present area → the SAME fingerprint');
  assert.strictEqual(CI.chargeInputsFingerprint({ ...body, address_area: 'Res. Los Castaños' }), fp, 'changed area → the SAME fingerprint');
}
ok('charge-inputs: address_area is NON-charge — absent / present / changed give the SAME fingerprint (bound reuse stays reachable)');

console.log(`\narea-wiring.guard: OK (${n})`);
