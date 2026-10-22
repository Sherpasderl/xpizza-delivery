'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §6 + §11 A5) — the ops group's COPIED helpers stay equal to their live
// sources. Every check reads the LIVE source file on every run (never a frozen fixture).
//   1. portal/pause-reasons.js   — Set-equal to merchant/merchant-location.js's PAUSE_REASONS.
//   2. portal/location-name.js   — displayName's function source equals catalog/portal-reads.js's; both behave the same.
//   3. lib/hn-date.js            — hnDateISO's function source AND its two constants equal factura/build-record.js's; outputs
//                                   equal across the Honduras day / month / year boundaries.
//   4. portal/reset-list.js      — (a) the parse body equals index.js's resetItemAvailability block under EXACTLY the A5
//                                   normalizations; (b) the resolve statement equals availability-reset.js's; (c) behaviour:
//                                   every env case through the REAL runAvailabilityReset iterates exactly effectiveResetList(env).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(FN, f), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// the source text of `function <name>(…) { … }` (balanced braces from the first `{`)
function fnSource(src, name) {
  const a = src.indexOf(`function ${name}(`);
  assert.ok(a >= 0 && src.indexOf(`function ${name}(`, a + 1) === -1, `${name}: declared exactly once`);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  return src.slice(a, i + 1);
}
const lineOf = (src, prefix) => {
  const ls = src.split('\n').filter((l) => l.startsWith(prefix));
  assert.strictEqual(ls.length, 1, `exactly one line starting ${JSON.stringify(prefix)}`);
  return ls[0];
};

(async () => {
  // ── 1 ──
  const live = require('../merchant/merchant-location').PAUSE_REASONS;
  const copy = require('./pause-reasons').PAUSE_REASONS;
  assert.ok(live instanceof Set && copy instanceof Set && live.size > 0);
  assert.deepStrictEqual([...copy].sort(), [...live].sort(), '🔴 the portal pause reasons drifted from the handheld allowlist');
  ok(`pause-reasons: Set-equal to merchant-location's PAUSE_REASONS (${copy.size} reasons)`);

  // ── 2 ──
  assert.strictEqual(fnSource(read('portal/location-name.js'), 'displayName'), fnSource(read('catalog/portal-reads.js'), 'displayName'),
    '🔴 location-name.displayName drifted from portal-reads.displayName');
  const fake = (v) => ({ ref: () => ({ get: async () => ({ val: () => v }) }) });
  // portal-reads does not export displayName: evaluate its live source text the same way
  // eslint-disable-next-line no-new-func
  const liveDisplayName = new Function(`return (async ${fnSource(read('catalog/portal-reads.js'), 'displayName')});`)();
  const { displayName } = require('./location-name');
  for (const v of ['Sucursal Norte', '  ', '', null, 7, undefined, { a: 1 }, ' Centro ']) {
    assert.strictEqual(await displayName(fake(v), 'rid_x'), await liveDisplayName(fake(v), 'rid_x'), `displayName(${JSON.stringify(v)})`);
  }
  ok('location-name: displayName source-equal to portal-reads.js; same output on 8 fixtures');

  // ── 3 ──
  const fr = read('factura/build-record.js'), hd = read('lib/hn-date.js');
  assert.strictEqual(fnSource(hd, 'hnDateISO'), fnSource(fr, 'hnDateISO'), '🔴 hnDateISO body drifted');
  for (const c of ['const HN_OFFSET_MS = ', 'const pad2 = ']) assert.strictEqual(lineOf(hd, c), lineOf(fr, c), `🔴 ${c.trim()} drifted`);
  const A = require('../factura/build-record').hnDateISO, B = require('../lib/hn-date').hnDateISO;
  const cases = [];
  for (const iso of ['2026-10-19T05:59:59.999Z', '2026-10-19T06:00:00.000Z', '2026-11-01T05:59:59.999Z', '2026-11-01T06:00:00.000Z',
    '2027-01-01T05:59:59.999Z', '2027-01-01T06:00:00.000Z', '2028-02-29T12:00:00.000Z', '2028-03-01T05:59:59.999Z']) cases.push(Date.parse(iso));
  for (let h = 0; h < 48; h++) cases.push(Date.parse('2026-12-31T00:00:00.000Z') + h * 3600000);
  for (const t of cases) assert.strictEqual(B(t), A(t), `hnDateISO(${new Date(t).toISOString()})`);
  assert.strictEqual(B(Date.parse('2026-10-19T05:59:59.999Z')), '2026-10-18');
  assert.strictEqual(B(Date.parse('2026-10-19T06:00:00.000Z')), '2026-10-19');
  // the allocation trigger keys the counter with hnDateISO(liveTs) — the same import we copy
  assert.ok(/const \{ hnDateISO \} = require\('\.\/factura\/build-record'\);/.test(read('index.js')) && /counters\/order_display_seq\/\$\{restaurantId\}\/\$\{day\}/.test(read('index.js')),
    'premise: index.js keys counters/order_display_seq by factura hnDateISO');
  ok(`hn-date: function + both constants source-equal to factura/build-record.js; equal on ${cases.length} instants across day / month / year boundaries`);

  // ── 4 ──
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const idx = read('index.js');
  const a = idx.indexOf('    let restaurants;\n    try {\n      const raw = process.env.AVAILABILITY_RESET_RESTAURANTS;');
  assert.ok(a > 0 && idx.indexOf('    let restaurants;\n    try {\n      const raw = process.env.AVAILABILITY_RESET_RESTAURANTS;', a + 1) === -1, 'premise: the job parse block, once');
  const end = idx.indexOf('\n    }\n', idx.indexOf('} catch (e) {', a)) + '\n    }'.length;
  let liveParse = idx.slice(a, end);
  // the A5 normalizations, in order, applied to BOTH texts
  const A5 = (s) => {
    let t = s.split('process.env.AVAILABILITY_RESET_RESTAURANTS').join('env.AVAILABILITY_RESET_RESTAURANTS');   // (1)
    const ce = t.match(/\n\s*console\.error\([^;]*\);/g) || [];
    assert.ok(ce.length <= 1, 'at most one console.error in the block');
    t = t.replace(/\n\s*console\.error\([^;]*\);/, '');                                                          // (2)
    return norm(t);                                                                                                  // (3)
  };
  assert.strictEqual((liveParse.match(/console\.error\(/g) || []).length, 1, 'premise: the live block logs once (the copy omits it)');
  const rl = read('portal/reset-list.js');
  const copyParse = rl.slice(rl.indexOf('    let restaurants;'), rl.indexOf('    return restaurants;'));
  assert.strictEqual(A5(copyParse), A5(liveParse), '🔴 the reset-list parse copy drifted from index.js (after the A5 normalizations)');
  const liveResolve = lineOf(read('availability-reset.js'), '  const restaurants = Array.isArray(deps.restaurants)');
  const resolveNorm = (s) => norm(s.split('deps.restaurants').join('r').replace(/^\s*const restaurants =/, 'return'));
  const copyResolve = lineOf(rl, '  return Array.isArray(r)');
  assert.strictEqual(norm(copyResolve), resolveNorm(liveResolve), '🔴 the reset-list resolve copy drifted from availability-reset.js');
  {
    // the normalizations are not vacuous: a changed byte in either live text fails
    assert.notStrictEqual(A5(liveParse.replace('typeof x === \'string\'', 'typeof x === \'number\'')), A5(copyParse));
    assert.notStrictEqual(resolveNorm(liveResolve.replace('.length ?', '.length > 1 ?')), norm(copyResolve));
  }
  // behaviour through the REAL job loop: which rids it iterates for each env
  const { runAvailabilityReset } = require('../availability-reset');
  const { effectiveResetList, parseResetEnv } = require('./reset-list');
  // eslint-disable-next-line no-new-func
  const liveParseFn = new Function('process', `${liveParse.replace(/console\.error\([^;]*\);/, '')}\n return restaurants;`);
  const iterated = async (restaurants) => {
    const res = await runAvailabilityReset({ db: { ref: () => { throw new Error('stub'); } }, ServerValue: {}, now: 0, restaurants, log: { error() {}, warn() {}, log() {} } });
    return res.map((r) => r.rid);
  };
  const envs = [undefined, '', '[]', '["a"]', '["a","b"]', '{"a":1}', '["a",1]', 'a,b', '["a","a"]', '[""]', 'null', '"x"', '[ "x_y" ]'];
  for (const raw of envs) {
    const env = raw === undefined ? {} : { AVAILABILITY_RESET_RESTAURANTS: raw };
    const jobParsed = liveParseFn({ env });
    assert.deepStrictEqual(parseResetEnv(env), jobParsed, `parse(${JSON.stringify(raw)})`);
    assert.deepStrictEqual(effectiveResetList(env), await iterated(jobParsed), `effective(${JSON.stringify(raw)}) = what the real job iterates`);
  }
  ok(`reset-list: parse + resolve source-equal under exactly the A5 normalizations (process.env→env, the one console.error dropped, whitespace; deps.restaurants→r, const restaurants =→return); ${envs.length} env cases match the real runAvailabilityReset`);

  console.log(`\nops-helpers.guard: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
