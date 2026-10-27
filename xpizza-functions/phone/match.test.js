'use strict';
// INTL PHONE S-match (PLAN-intl-phone r2.3 §4 → r1 §5) — phone/match.js: full-number phone comparison replacing last-8 suffix matches.
// Run: node phone/match.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'tb_fixed_salt_for_phone_differential_00000000';
const assert = require('assert');
const M = require('./match');
const W = require('../whatsapp');
const { buildCorpus } = require('./identity-corpus');
const { parseSubmitted } = require('./intl');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const corpus = buildCorpus();
const EXTRA = ['50497950000@c.us', '12197950000@c.us', '', null, undefined, 'abc', '+', 97950000];

// ── 1. storedIdentity === today's normalizePhone, on every shape, and never logs ──
let logged = 0; const w = console.warn; console.warn = () => { logged++; };
for (const x of [...corpus, ...EXTRA]) {
  const strip = typeof x === 'string' ? x.replace(/@c\.us$/, '') : x;
  assert.strictEqual(M.storedIdentity(x), quiet(() => W.normalizePhone(strip)), `MATCH-IDENTITY-PARITY ${JSON.stringify(x)}`);
}
console.warn = w;
logged = 0; console.warn = () => { logged++; };
for (const x of corpus) M.storedIdentity(x);
console.warn = w;
assert.strictEqual(logged, 0, 'MATCH-IDENTITY-NEVER-LOGS');
ok(`storedIdentity == normalizePhone (after stripping @c.us) on ${corpus.length + EXTRA.length} shapes; it never logs`);

// ── 2. samePhone: equal identities; null operands never match; equal last-8 across countries never match ──
assert.strictEqual(M.samePhone('+50497950000', '50497950000'), true, 'MATCH-HN-QUALIFIED-VS-INBOUND');
assert.strictEqual(M.samePhone('97950000', '50497950000'), true, 'MATCH-HN-BARE8-VS-INBOUND');
assert.strictEqual(M.samePhone('+504 9795-0000', '50497950000@c.us'), true, 'MATCH-HN-FORMATTED-VS-WA');
assert.strictEqual(M.samePhone('+97950000', '50497950000'), true, 'MATCH-STORED-PLUS8-STAYS-HN');
assert.strictEqual(M.samePhone('+12197950000', '12197950000'), true, 'MATCH-US');
assert.strictEqual(M.samePhone('+50297950000', '50497950000'), false, 'MATCH-CROSS-COUNTRY-SAME-SUFFIX-NEVER');
assert.strictEqual(M.samePhone('+12197950000', '50497950000'), false, 'MATCH-US-VS-HN-SAME-SUFFIX-NEVER');
for (const [a, b] of [[null, null], ['', ''], ['abc', 'abc'], [null, '50497950000'], ['50497950000', undefined], ['979500', '979500']]) assert.strictEqual(M.samePhone(a, b), false, `MATCH-NULL-OPERAND ${JSON.stringify([a, b])}`);
ok('samePhone: HN in every stored form ↔ the WhatsApp from; +8 stays HN; equal last-8 in +502 / +1 vs +504 → no match; null / invalid operands → false');

// ── 3. the differential vs today's suffix rule (index.js STATUS_CHECK @ 8a31e2a3): new ⊆ old; equal for every contract-valid order ──
const oldMatch = (orderPhone, from) => { const d = String(orderPhone).replace(/[^\d]/g, ''); return d.endsWith(from.slice(-8)) || from.endsWith(d.slice(-8)); };
const froms = [...new Set(corpus.map((x) => { const p = parseSubmitted(x); return p && p.identity; }).filter(Boolean))].slice(0, 120);
let pairs = 0, narrowed = 0;
for (const op of corpus) for (const f of froms) {
  const nw = M.samePhone(op, f), od = oldMatch(op, f); pairs++;
  assert.ok(!nw || od, `MATCH-NEW-SUBSET-OF-OLD ${op} ~ ${f}`);
  if (od && !nw) { narrowed++; if (parseSubmitted(op)) assert.ok(M.storedIdentity(op) !== f, `MATCH-VALID-ORDER-NOT-LOST ${op} ~ ${f}`); }
}
assert.ok(narrowed > 0, 'non-vacuity: some cross-country / garbage suffix matches are dropped');
ok(`differential over ${pairs} (order phone × inbound) pairs: every new match was an old match; a contract-valid order only stops matching a DIFFERENT number (${narrowed} suffix-only pairs dropped)`);

// ── 4. the mute key: identity digits ('' when not a phone) — one leaf per customer, no cross-country sharing ──
assert.strictEqual(M.muteKeyFor('50497950000@c.us'), '50497950000', 'MUTE-KEY-OUTBOUND-TO');
assert.strictEqual(M.muteKeyFor('50497950000'), '50497950000', 'MUTE-KEY-INBOUND-FROM');
assert.notStrictEqual(M.muteKeyFor('50297950000'), M.muteKeyFor('50497950000'), 'MUTE-KEY-CROSS-COUNTRY-DISTINCT');
for (const x of ['', null, 'abc', '123']) assert.strictEqual(M.muteKeyFor(x), '', `MUTE-KEY-EMPTY ${JSON.stringify(x)}`);
assert.ok(/^\d+$/.test(M.muteKeyFor('+1 219 795 0000')), 'MUTE-KEY-RTDB-SAFE');
ok("muteKeyFor: the identity digits (writer data.to and reader from agree); +502 and +504 with the same last 8 → different leaves; non-phone → ''");

// ── 5. (codex r1 #4) NO LOST MUTES AT DEPLOY: the reader checks the identity leaf AND the legacy last-8 leaf; the writer key is identity only ──
(async () => {
  const W8 = 'whatsapp_mute/tb_r1/';
  const dbOf = (tree) => { const reads = []; return { reads, ref: (p) => ({ once: async () => { reads.push(p); return { val: () => (p in tree ? tree[p] : null) }; } }) }; };
  const T = Date.UTC(2026, 9, 27, 18), from = '50497950000';
  assert.strictEqual(M.legacyMuteKeyFor('50497950000@c.us'), '97950000', 'MUTE-LEGACY-KEY-IS-TODAYS-LAST-8');
  assert.strictEqual(M.legacyMuteKeyFor(''), '', 'MUTE-LEGACY-KEY-EMPTY');
  // a legacy leaf written BEFORE the deploy still mutes AFTER it
  const legacyOnly = dbOf({ [W8 + '97950000']: { at: T - 60e3 } });
  assert.deepStrictEqual(await M.readMute(legacyOnly, 'tb_r1', from), { at: T - 60e3 }, 'MUTE-LEGACY-LEAF-STILL-MUTES');
  assert.deepStrictEqual(legacyOnly.reads.sort(), [W8 + '50497950000', W8 + '97950000'], 'MUTE-READS-BOTH-KEYS');
  // the post-deploy writer's identity leaf: ONE decision (the latest), never a second write to the legacy key
  assert.notStrictEqual(M.muteKeyFor(from), M.legacyMuteKeyFor(from), 'premise: the writer key (identity) is not the legacy key');
  const both = dbOf({ [W8 + '97950000']: { at: T - 60e3 }, [W8 + '50497950000']: { at: T } });
  assert.deepStrictEqual(await M.readMute(both, 'tb_r1', from), { at: T }, 'MUTE-ONE-ACTIVE-STATE-LATEST-WINS');
  const identityOnly = dbOf({ [W8 + '50497950000']: { at: T } });
  assert.deepStrictEqual(await M.readMute(identityOnly, 'tb_r1', from), { at: T }, 'MUTE-IDENTITY-LEAF');
  assert.strictEqual(await M.readMute(dbOf({}), 'tb_r1', from), null, 'MUTE-NONE');
  // a non-phone `from` never reads the parent node (today's '' key read whatsapp_mute/<rid>/ itself)
  const junk = dbOf({}); assert.strictEqual(await M.readMute(junk, 'tb_r1', 'abc'), null, 'MUTE-NON-PHONE-NULL');
  assert.ok(junk.reads.every((p) => !p.endsWith('/')), 'MUTE-NEVER-READS-THE-PARENT');
  // a read error propagates (the caller's existing try is FAIL-OPEN, unchanged)
  await assert.rejects(() => M.readMute({ ref: () => ({ once: async () => { throw new Error('down'); } }) }, 'tb_r1', from), /down/, 'MUTE-READ-ERROR-PROPAGATES');
  ok('readMute: identity + legacy last-8 leaves, latest wins → a pre-deploy legacy mute still mutes, the post-deploy identity mute is the ONE state; non-phone → null; errors propagate to the fail-open caller');
  console.log(`phone-match: OK (${n})`);
})().catch((e) => { console.error('phone-match: FAILED —', e && e.stack || e); process.exit(1); });
