// The S2 SBS fixtures are as strict as the contract (Codex capp r1/r2 P2): every placeSdkOrder violation of CONTRACT-sdk-checkout §2.1
// is refused (the route throws ⇒ unmapped ⇒ the SBS run fails), never «placed»; §1.1 authority and A3 ownership answer as the contract
// says. The positive side — the REAL client's body passes — is every S2 placement scene of `sbs.mjs --set s2`.
// Run: node --test review/capp-sbs/fixtures.probe.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { s2Extra, memberToken, memberExtra, placeBodyViolations } from './fixtures.mjs';

const CF = 'https://us-central1-p.cloudfunctions.net/';
const AUTH = { Authorization: `Bearer ${memberToken()}` };
const ORDER = { order_id: 'XP-1', restaurant_id: 'la_musa', customer_name: 'Ana', customer_phone: '96123344', items_text: '1x Pan de ajo', order_type: 'delivery', items: [{ name: 'Pan de ajo', qty: 1 }] };
const BASE = { ...ORDER, attempt_id: 'att_' + 'a'.repeat(32), replaces_order_id: null };
const SAVED = { kind: 'saved', card_id: 'c_visa' };
const NEW = { kind: 'new', sdk_token: 'tok_x', save: true, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2099 } };
const place = (body, headers = AUTH) => { const x = s2Extra({}); try { const r = x({ method: 'POST', headers, postData: JSON.stringify(body) }, new URL(CF + 'placeSdkOrder')); return r ? r.status : 'unmapped'; } catch (e) { return 'refused: ' + e.message; } };

test('placeSdkOrder: the valid shapes are placed (saved + new)', () => {
  assert.equal(place({ ...BASE, card: SAVED }), 200);
  assert.equal(place({ ...BASE, card: NEW }), 200);
});

test('placeSdkOrder: every §2.1 VALUE violation is refused, never placed (Codex r2 P2 #1)', () => {
  const bad = {
    'sdk_token null': { ...BASE, card: { ...NEW, sdk_token: null } },
    'sdk_token empty': { ...BASE, card: { ...NEW, sdk_token: '' } },
    'save "yes"': { ...BASE, card: { ...NEW, save: 'yes' } },
    'authentication_identifier 42': { ...BASE, card: { ...NEW, authentication_identifier: 42 } },
    'display {}': { ...BASE, card: { ...NEW, display: {} } },
    'display extra key': { ...BASE, card: { ...NEW, display: { ...NEW.display, cvv: '123' } } },
    'display.brand': { ...BASE, card: { ...NEW, display: { ...NEW.display, brand: 'diners' } } },
    'display.last4': { ...BASE, card: { ...NEW, display: { ...NEW.display, last4: '42' } } },
    'display.exp_month 13': { ...BASE, card: { ...NEW, display: { ...NEW.display, exp_month: 13 } } },
    'display.exp_year past': { ...BASE, card: { ...NEW, display: { ...NEW.display, exp_year: 2001 } } },
    'display.exp_year 2-digit': { ...BASE, card: { ...NEW, display: { ...NEW.display, exp_year: 28 } } },
    'saved card_id empty': { ...BASE, card: { kind: 'saved', card_id: '' } },
    'saved extra key': { ...BASE, card: { ...SAVED, x: 1 } },
    'card.kind': { ...BASE, card: { kind: 'wallet' } },
    'attempt_id short': { ...BASE, attempt_id: 'x', card: SAVED },
    'attempt_id charset': { ...BASE, attempt_id: 'att_' + '!'.repeat(20), card: SAVED },
    'replaces_order_id absent': (() => { const { replaces_order_id, ...b } = BASE; return { ...b, card: SAVED }; })(),
    'replaces_order_id 7': { ...BASE, replaces_order_id: 7, card: SAVED },
    'a client amount': { ...BASE, amount_cents: 100, card: SAVED },
    'order_type': { ...BASE, order_type: 'drone', card: SAVED },
    'order_id format': { ...BASE, order_id: 'XP 1/..', card: SAVED },
    'items empty': { ...BASE, items: [], card: SAVED },
    'restaurant_id': { ...BASE, restaurant_id: '', card: SAVED },
  };
  for (const [what, body] of Object.entries(bad)) assert.match(String(place(body)), /^refused: placeSdkOrder 400/, `🔴 FX-2.1 ${what}: refused`);
});

test('placeSdkOrder: each priced-order field the server requires (validateOrderPayload, read from index.js) is required here', () => {
  const missing = placeBodyViolations({ attempt_id: BASE.attempt_id, replaces_order_id: null, card: SAVED }).filter((v) => v.startsWith('missing '));
  assert.ok(missing.length >= 5, `premise: the server's required list was read (${missing.join(', ')})`);
  for (const f of missing.map((v) => v.slice('missing '.length))) {
    const { [f]: _, ...b } = BASE;
    assert.match(String(place({ ...b, card: SAVED })), /^refused: placeSdkOrder 400/, `🔴 FX-2.1 missing ${f}: refused`);
  }
});

test('§1.1 authority and A3 ownership', () => {
  assert.equal(place({ ...BASE, card: SAVED }, {}), 401, 'no token ⇒ 401');
  assert.equal(place({ ...BASE, card: SAVED }, { Authorization: 'Bearer nope' }), 401, 'a foreign token ⇒ 401');
  assert.equal(place({ ...BASE, card: { kind: 'saved', card_id: 'c_other' } }), 409, 'A3: not this member\'s card ⇒ the identical 409');
});

// Codex asm9b P3: the last-tip route answers as the REAL handler does (my-last-tip.js @990cf8c4, read from git with its member-auth),
// over Codex's schedule — every method, and stored values inside and outside the handler's CENTS_MAX bound.
// Mutants (harness-local: the shared catalogue may not name the harness, SBS-1): from xpizza-functions,
//   node tools/mutation-sweep.js --mutants=../../review/capp-sbs/fixtures.mutants.json   (a leading «.» resolves from tools/)
test('getMyLastTip: the fixture = the real handler (405 for a non-GET; null outside 0..CENTS_MAX)', async () => {
  const { execFileSync } = await import('node:child_process'), { mkdtempSync, writeFileSync } = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { createRequire } = await import('node:module');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lasttip-'));
  for (const f of ['my-last-tip.js', 'member-auth.js']) writeFileSync(path.join(dir, f), execFileSync('git', ['show', `990cf8c4:xpizza-functions/${f}`], { cwd: new URL('../..', import.meta.url).pathname }));
  const H = createRequire(path.join(dir, 'x.js'))('./my-last-tip.js');
  const real = async (method, stored) => {
    const snap = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v !== undefined });
    const db = { ref: (p) => ({ once: async () => snap(p === 'user_private/u_ana/last_tip' && stored !== undefined ? { cents: stored } : undefined) }) };
    const { getMyLastTip } = H.makeMyLastTip({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (t) => (t === memberToken() ? { uid: 'u_ana', customer: true } : Promise.reject(new Error('bad'))) }), checkRateLimit: async () => ({ allowed: true }) });
    let out = null; const res = { set() {}, status: (s) => ({ json: (b) => { out = { status: s, body: b }; } }) };
    await getMyLastTip({ method, query: { context: 'platform' }, body: undefined, get: (h) => (h === 'x-firebase-id-token' ? memberToken() : undefined) }, res);
    return out;
  };
  const fixture = (method, stored) => {
    const r = memberExtra({ lastTip: stored === undefined ? null : stored })({ method, headers: { 'x-firebase-id-token': memberToken() } }, new URL(CF + 'getMyLastTip?context=platform'));
    return { status: r.status, body: r.body };
  };
  assert.equal(H.CENTS_MAX, 200000, 'premise: the handler\'s bound');
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) for (const stored of [undefined, 0, 1250, 200000, 200001, -1, 12.5]) {
    assert.deepEqual(fixture(method, stored), await real(method, stored), `🔴 P3: ${method} with stored ${stored} — the fixture answers as the handler`);
  }
});
