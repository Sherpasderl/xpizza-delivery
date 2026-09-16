// Portal 1C Task 7 — the confirmed-quote token store, as behaviour.
// Run: node --test xpizza-orders/form-confirm-quote.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { createConfirmQuote } = createRequire(import.meta.url)('./form-confirm-quote.js');

const mk = (over = {}) => {
  const calls = { requote: 0, set: 0, clear: 0 };
  let fired = null;
  const q = createConfirmQuote({
    requote: () => { calls.requote += 1; },
    now: () => 1000,
    setInterval: (fn) => { calls.set += 1; fired = fn; return 7; },
    clearInterval: () => { calls.clear += 1; },
    ...over,
  });
  return { q, calls, fire: () => fired && fired() };
};

test('a token is kept against the cart it was issued for, and attached only to that cart', () => {
  const { q } = mk();
  q.store({ ok: true, quote_token: 'TOK', net_total_cents: 29900 }, 'CART-A');
  assert.strictEqual(q.state('CART-A').freshForCart, true);
  assert.strictEqual(q.current('CART-A').net, 29900, 'the quoted net travels with the token');

  const body = { items: [1] };
  assert.strictEqual(q.attach(body, 'CART-A'), true);
  assert.strictEqual(body.quote_token, 'TOK');
  assert.deepStrictEqual(Object.keys(body).sort(), ['items', 'quote_token'], 'attach is additive only');
});

test('🔴 a cart change makes the token stale, and a stale token is NEVER attached', () => {
  const { q } = mk();
  q.store({ quote_token: 'TOK' }, 'CART-A');
  const body = { items: [2] };
  assert.strictEqual(q.attach(body, 'CART-B'), false, 'a different cart must not take this token');
  assert.deepStrictEqual(body, { items: [2] },
    '🔴 the body is untouched — a token-less send must be byte-identical to the pre-1C one');
  assert.strictEqual(q.state('CART-B').needsRefresh, true, 'and the miss is recorded for T8');
  assert.strictEqual(q.current('CART-B'), null);
  // …and the ORIGINAL cart still matches: staleness is per-cart, not a global invalidation.
  assert.strictEqual(q.attach({ }, 'CART-A'), true);
});

test('a response with no quote_token stores nothing — that is grace, not an error', () => {
  const { q } = mk();
  // The pre-1C server shape, and the shape whenever QUOTE_TOKEN_SECRET is unset.
  assert.strictEqual(q.store({ ok: true, total_cents: 29900 }, 'CART-A'), false);
  assert.strictEqual(q.state('CART-A').hasToken, false);
  const body = { items: [1] };
  assert.strictEqual(q.attach(body, 'CART-A'), false);
  assert.deepStrictEqual(body, { items: [1] }, 'and the send is unchanged from today');
  assert.strictEqual(q.state('CART-A').needsRefresh, true, 'the attach miss is still recorded');
});

test('a token-less response CLEARS a previously held token rather than leaving it to mismatch later', () => {
  const { q } = mk();
  q.store({ quote_token: 'OLD' }, 'CART-A');
  q.store({ ok: true }, 'CART-A');          // same cart, re-quoted, server now issuing token-less
  assert.strictEqual(q.state('CART-A').hasToken, false,
    'holding OLD would attach a token the server no longer stands behind');
});

test('malformed responses are refused without throwing', () => {
  const { q } = mk();
  for (const bad of [null, undefined, 'str', 42, [], {}, { quote_token: '' }, { quote_token: 123 }, { quote_token: null }]) {
    assert.strictEqual(q.store(bad, 'CART-A'), false, `${JSON.stringify(bad)} stores nothing`);
  }
  for (const bad of [null, undefined, 'str', 42]) {
    assert.strictEqual(q.attach(bad, 'CART-A'), false, 'a non-object body is refused, not crashed into');
  }
});

test('a null cart signature never matches — an unsignable cart gets no token', () => {
  const { q } = mk();
  // serverQuoteCartKey() returns null when serialization throws; that must not become a wildcard.
  q.store({ quote_token: 'TOK' }, null);
  assert.strictEqual(q.attach({}, null), false, '🔴 null must not match null');
  q.store({ quote_token: 'TOK' }, 'CART-A');
  assert.strictEqual(q.attach({}, null), false, 'and a null lookup matches no stored signature');
});

test('the silent refresh re-quotes on a cadence, does not stack, and stops on leaving checkout', () => {
  const { q, calls, fire } = mk();
  assert.strictEqual(q.scheduleRefresh(), true);
  assert.strictEqual(q.scheduleRefresh(), false, 'idempotent — the pay step re-renders on every edit');
  assert.strictEqual(calls.set, 1, 'exactly one timer');
  fire();
  assert.strictEqual(calls.requote, 1, 'the cadence re-quotes');
  assert.strictEqual(q.state('X').refreshing, true);
  assert.strictEqual(q.stopRefresh(), true);
  assert.strictEqual(calls.clear, 1, 'leaving checkout clears the timer');
  assert.strictEqual(q.stopRefresh(), false, 'and stopping twice is harmless');
});

test('the refresh cadence sits well under the 15-minute issuance window', () => {
  let ms = null;
  createConfirmQuote({ setInterval: (fn, d) => { ms = d; return 1; } }).scheduleRefresh();
  assert.ok(ms > 0 && ms <= 12 * 60 * 1000,
    `the cadence must leave real margin inside the 15-min window (got ${ms}ms)`);
  // 🔴 and it must not be derived by decoding the token — that would couple the client to the token
  // format, so a server-side change would silently break refresh timing instead of failing loudly.
  const code = readFileSync(new URL('./form-confirm-quote.js', import.meta.url), 'utf8')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/atob|JSON\.parse\s*\(\s*[^)]*token|base64|expires_at/.test(code),
    'the module must never decode the token to find its expiry');
});

test('a requote that throws cannot take the timer down with it', () => {
  const { q, fire } = mk({ requote: () => { throw new Error('offline'); } });
  q.scheduleRefresh();
  fire();                       // must not throw
  assert.strictEqual(q.state('X').refreshing, true, 'the cadence survives a failed re-quote');
});

test('reset drops the token and the timer together', () => {
  const { q, calls } = mk();
  q.store({ quote_token: 'TOK' }, 'CART-A');
  q.scheduleRefresh();
  q.reset();
  assert.strictEqual(q.state('CART-A').hasToken, false);
  assert.strictEqual(calls.clear, 1);
});
