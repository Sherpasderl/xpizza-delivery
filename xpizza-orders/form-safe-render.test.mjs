// Portal 1B Task 8 — the safe-render helpers, exhaustively.
// Run: node --test xpizza-orders/form-safe-render.test.mjs
//
// 🔴 A REJECTION MATRIX, asserting the EXACT result per case — not merely "it changed something".
// The gate found the forms' fixture was card-only, and the helpers themselves were only ever exercised
// through it; a helper tested only via one render path is a helper tested for one of its jobs. Each row
// below states what must come back, because "not the input" is satisfied by returning the wrong thing
// too: an over-rejecting URL policy turns a legitimate merchant photo into a placeholder, which is a
// silent outage of exactly the thing the merchant is looking at.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { safeText, safeImgUrl, safeColor } = require('./form-safe-render.js');

test('safeText — the five metacharacters, and nothing else touched', () => {
  const cases = [
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['"><b>', '&quot;&gt;&lt;b&gt;'],
    ["it's", 'it&#039;s'],
    ['a & b', 'a &amp; b'],
    ['Pizza Carnívora — L340', 'Pizza Carnívora — L340'],   // accents, dashes and digits pass through
    ['', ''], [null, ''], [undefined, ''], [0, '0'], [340, '340'],
  ];
  for (const [input, want] of cases) assert.strictEqual(safeText(input), want, `safeText(${JSON.stringify(input)})`);
  // Ampersand first, or the escapes escape each other: & → &amp; must not then re-escape.
  assert.strictEqual(safeText('&lt;'), '&amp;lt;', 'an already-escaped string is escaped once more, not mangled');
});

test('safeImgUrl — ACCEPTS every ordinary shape a merchant photo takes', () => {
  const accept = [
    'photos/pizza.jpg', 'images/a-b_c.png', '/img/a.png', 'a/b/c.png',
    'images/a%20b.png',                       // percent-encoded — ordinary, and was over-rejected
    'images/', '/',                           // trailing slash / bare root — ordinary, and was over-rejected
    'https://cdn.test/a.png',
    'HTTPS://cdn.test/a.png',                 // scheme case — ordinary, and was over-rejected
    'https://cdn.test/a.png?v=1&w=2',
    'https://cdn.test/a.png#frag',
    'https://cdn.test:8443/a.png',
    'https://[::1]/a.png',                    // IPv6 host
  ];
  for (const u of accept) assert.strictEqual(safeImgUrl(u), u, `must ACCEPT ${JSON.stringify(u)} — over-rejection hides a real photo`);
});

test('safeImgUrl — REJECTS to the empty string, so every caller falls back to its placeholder', () => {
  const reject = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>', 'blob:https://x/y', 'vbscript:x', 'file:///etc/passwd',
    'http://x/p.png',                          // mixed content on an https checkout
    '//evil.com/x.png',                        // protocol-relative: a different origin
    'x" onerror="alert(1)', "x' onerror='alert(1)", 'a`b', 'a\\b',
    '../../secret.png', 'images/../../secret.png',
    '<script>', 'a b.png',
  ];
  for (const u of reject) assert.strictEqual(safeImgUrl(u), '', `must REJECT ${JSON.stringify(u)}`);
  for (const u of [null, undefined, '']) assert.strictEqual(safeImgUrl(u), '', 'absent is empty');
});

test('safeColor — accepts a constrained grammar, falls back otherwise', () => {
  const fb = '#C8321A';
  for (const c of ['#fff', '#C8321A', '#12345678', 'rgb(1,2,3)', 'rgba(1,2,3,0.5)', 'red', 'darkslateblue'])
    assert.strictEqual(safeColor(c, fb), c, `must ACCEPT ${JSON.stringify(c)}`);
  for (const c of [
    'red;background:url(javascript:alert(1))', 'expression(alert(1))', '" onload="alert(1)',
    'url(x)', '#12', '#xyzxyz', 'rgb(1,2)', 'javascript:x', '</style><script>', null, undefined, '',
  ]) assert.strictEqual(safeColor(c, fb), fb, `must FALL BACK on ${JSON.stringify(c)}`);
  /* A bare word IS an accepted shape — an unknown CSS keyword renders as nothing and cannot contain a
     quote, semicolon or paren, so there is nothing to escape. The no-fallback case therefore has to use
     a value that is genuinely rejected. (My first version asserted 'nope' was rejected, which said more
     about my expectation than about the grammar.) */
  assert.strictEqual(safeColor('url(x)', undefined), '', 'no fallback given → empty, never the input');
  assert.strictEqual(safeColor('mediumspringgreen', '#000'), 'mediumspringgreen', 'a real keyword is kept');
});
