// Task 2 — RENDERING-SAFETY CONTENT CONSTRAINTS.
//
// 1A ships merchant-authored data to the CURRENT, UNSAFE renderers. 1B fixes the render layer; until
// then the only place an XSS payload can be stopped is before it is activated, so these constraints
// are part of what a publish means.
//
// The two sinks are DIFFERENT and a check for one does not cover the other:
//   body      — la-musa-orders/index.html:2162 interpolates names/descs into innerHTML
//   attribute — xpizza-orders/index.html:1731 interpolates p.name into alt="${p.name}" UNESCAPED,
//               where `" onmouseover="alert(1)` has no angle brackets and still executes
const { test } = require('node:test');
const assert = require('node:assert');
const { checkValue, assertDisplaySafe, FIELD_SINKS, SINK_PROVENANCE } = require('./display-safety');
const { formSource, readLiteral } = require('./form-menu-source');

test('🔴 BODY context rejects markup — the La Musa innerHTML sink', () => {
  for (const payload of [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    'Pizza <b>bold</b>',
    'a > b',
    '<',
  ]) assert.ok(checkValue(payload, 'body'), `🔴 body must reject: ${payload}`);
  // entity sequences that decode to angle brackets, in case a value is ever decoded before insertion
  for (const payload of ['&lt;img onerror=x&gt;', '&#60;script&#62;', '&#x3c;script&#x3e;']) {
    assert.ok(checkValue(payload, 'body'), `🔴 body must reject the decoded form of: ${payload}`);
  }
  // ...and accepts the real world, including the ampersands that are actually in the menu
  for (const ok of ['Sweet Corn & Calabrian Chili', 'NY Slice · 18"', 'Soups & Salads', 'Pad Thai - Pollo', 'Cervezas']) {
    assert.strictEqual(checkValue(ok, 'body'), null, `body must accept a real name: ${ok}`);
  }
});

test('🔴 ATTRIBUTE context rejects a quote breakout with NO angle brackets — the X.Pizza alt= sink', () => {
  // The case a markup-only check misses entirely.
  assert.ok(checkValue('" onmouseover="alert(1)', 'attribute'),
    '🔴 a double-quote breakout must be rejected — it injects an executable handler with no tag');
  assert.ok(checkValue("' onmouseover='alert(1)", 'attribute'), '🔴 and a single-quote breakout');
  assert.ok(checkValue('x` onload=`y', 'attribute'), '🔴 and a backtick, for templated attributes');
  // a body-only check would pass all three — pin that, so the two contexts can never be collapsed
  for (const payload of ['" onmouseover="alert(1)', "' onmouseover='alert(1)"]) {
    assert.strictEqual(checkValue(payload, 'body'), null,
      'premise: these carry NO markup, which is exactly why body alone is not enough');
  }
  assert.strictEqual(checkValue('Sweet Corn & Calabrian Chili', 'attribute'), null, 'and real names still pass');
});

test('🔴 IDENTIFIER context rejects a handler breakout — the inline onclick sinks of BOTH brands', () => {
  // la_musa: onclick="chg('<id>',1)"     — a single quote breaks out
  // x_pizza: onclick="openDetailModal(<id>)" — UNQUOTED, so anything non-numeric is code
  for (const payload of ["1');alert(1);//", '1);alert(1)//', 'a b', 'a.b', 'a<b', 'a"b', "a'b", 'a;b', 'a,b', '']) {
    assert.ok(checkValue(payload, 'identifier'), `🔴 identifier must reject: ${JSON.stringify(payload)}`);
  }
  for (const ok of ['rice_03', 'noodle_01_pollo', '1', '42', 'e12', 'soups_salads', 'cat-1']) {
    assert.strictEqual(checkValue(ok, 'identifier'), null, `identifier must accept a real id: ${ok}`);
  }
});

test('🔴 URL and COLOR contexts reject what their sinks would execute', () => {
  for (const payload of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://evil/x.png', '" onerror="alert(1)', '../../etc/passwd']) {
    assert.ok(checkValue(payload, 'url'), `🔴 url must reject: ${payload}`);
  }
  // Pin the REASON for a scheme, not just the rejection. Every scheme contains a colon, so the
  // character-set rule would refuse these anyway — asserting only "rejected" left the scheme rule
  // deletable with the suite green, and the message is what tells a merchant what they did.
  assert.match(checkValue('javascript:alert(1)', 'url'), /scheme/, '🔴 a scheme is rejected AS a scheme');
  assert.match(checkValue('//evil.example/x.png', 'url'), /protocol-relative/, '🔴 and a protocol-relative URL as itself');
  assert.match(checkValue('../secrets.png', 'url'), /upward/, '🔴 and traversal as traversal');
  for (const ok of ['img/pizza.png', 'assets/dishes/pad-thai.jpg', 'x.png']) {
    assert.strictEqual(checkValue(ok, 'url'), null, `url must accept a real path: ${ok}`);
  }
  for (const payload of ['red; background:url(javascript:alert(1))', 'expression(alert(1))', '#12', 'rgb(1,2,3)']) {
    assert.ok(checkValue(payload, 'color'), `🔴 color must reject: ${payload}`);
  }
  for (const ok of ['#C8321A', '#fff', '#12345678']) assert.strictEqual(checkValue(ok, 'color'), null, `color must accept: ${ok}`);
});

test('🔴 the sink map is enumerated from the REAL renderers, with provenance', () => {
  // A sink table nobody can trace back to a line of shipped code is a guess. Each entry names the
  // file and line it was read from, and every field the constraint covers must have one.
  for (const [kind, fields] of Object.entries(FIELD_SINKS)) {
    for (const [field, ctx] of Object.entries(fields)) {
      assert.ok(['body', 'attribute', 'identifier', 'url', 'color', 'numeric', 'boolean', 'identifier_list'].includes(ctx), `${kind}.${field}: unknown context ${ctx}`);
      const prov = SINK_PROVENANCE[`${kind}.${field}`];
      assert.ok(prov && /index\.html:\d+/.test(prov), `🔴 ${kind}.${field} has no sink provenance — where does this value actually land?`);
    }
  }
  // the two the gate names explicitly must be covered, in the right contexts
  assert.strictEqual(FIELD_SINKS.item.name, 'attribute', '🔴 an item name reaches alt="${p.name}" — attribute context');
  assert.strictEqual(FIELD_SINKS.item.desc, 'body', '🔴 a description reaches innerHTML — body context');
  assert.strictEqual(FIELD_SINKS.item.id, 'identifier', '🔴 an item id reaches an inline handler');
  assert.strictEqual(FIELD_SINKS.category.id, 'identifier', '🔴 a category id reaches an inline handler');
  // 🔴 The one the first cut missed entirely: a variant spec was not enumerated at all, and its
  // basePrice reaches TWO unescaped body sinks. Typed as a number, because that is what it is —
  // and a number cannot carry markup, which closes the injection by construction rather than by
  // filtering characters out of a string that should never have been one.
  assert.strictEqual(FIELD_SINKS.variant.basePrice, 'numeric', '🔴 variant basePrice is a NUMBER');
  assert.ok(checkValue('<img src=x onerror=alert(1)>', 'numeric'), '🔴 markup in a numeric field is refused');
  assert.ok(checkValue('307', 'numeric'), '...and so is a numeric STRING — the sink concatenates, it does not coerce safely');
  assert.strictEqual(checkValue(307, 'numeric'), null, 'a real number passes');
  assert.ok(/UNESCAPED/.test(SINK_PROVENANCE['variant.basePrice']), 'and its provenance records why it matters');
});

test('🔴 assertDisplaySafe rejects a record, naming the field and the sink', () => {
  assert.throws(() => assertDisplaySafe({ id: 1, name: '<img src=x onerror=alert(1)>' }, 'item', 'x_pizza/1'),
    /display_unsafe.*name/, '🔴 body markup in a name');
  assert.throws(() => assertDisplaySafe({ id: 1, name: '" onmouseover="alert(1)' }, 'item', 'x_pizza/1'),
    /display_unsafe.*name/, '🔴 attribute breakout in a name');
  assert.throws(() => assertDisplaySafe({ id: "1');alert(1);//", name: 'ok' }, 'item', 'la_musa/x'),
    /display_unsafe.*id/, '🔴 handler breakout in an id');
  assert.doesNotThrow(() => assertDisplaySafe({ id: 'rice_03', name: 'Arroz & Pollo', desc: 'con salsa', color: '#C8321A' }, 'item', 'la_musa/rice_03'));
});

test('🔴 every real display record of BOTH brands passes — the constraint is satisfiable today', () => {
  // A safety rule that rejects the live menu is not a safety rule, it is an outage. This is the
  // non-vacuity half of every assertion above.
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = formSource(rid);
    for (const d of readLiteral(src, 'MENU')) assertDisplaySafe(d, 'item', `${rid}/${d.id}`);
    for (const e of readLiteral(src, 'EXTRAS')) assertDisplaySafe(e, 'extra', `${rid}/extra/${e.id}`);
    if (rid === 'la_musa') for (const c of readLiteral(src, 'CATEGORIES')) assertDisplaySafe(c, 'category', `${rid}/cat/${c.id}`);
  }
});

test('🔴 safety NEVER stringifies — the wrong type is not a safe value', () => {
  // The validator's type phase catches these first, which is the right order and also means these
  // rules cannot be killed through it. Asserted here directly, because the whole class of bugs was
  // String(value) turning `{}` into "[object Object]" — a value that passes every content rule and
  // renders as "[object Object]" on a menu.
  for (const context of ['body', 'attribute', 'identifier', 'url', 'color']) {
    assert.match(checkValue({}, context) || '', /must be a string/, `🔴 ${context}: an object is not a safe string`);
    assert.match(checkValue([], context) || '', /must be a string/, `🔴 ${context}: an array is not a safe string`);
    assert.match(checkValue(true, context) || '', /must be a string/, `🔴 ${context}: a boolean is not a safe string`);
  }
  // ...while a finite number IS safe anywhere: x_pizza interpolates a numeric dish id bare into an
  // inline handler, and a number can neither carry markup nor close a quote.
  assert.strictEqual(checkValue(2, 'identifier'), null, 'a finite number is safe');
  assert.ok(checkValue(NaN, 'identifier'), 'but NaN is not a number anything should render');
  // list entries are typed too — [7] must not become ["7"]
  assert.match(checkValue([7], 'identifier_list') || '', /non-string entry/, '🔴 a non-string list entry is refused as such');
});
