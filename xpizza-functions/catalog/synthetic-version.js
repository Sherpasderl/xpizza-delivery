'use strict';
// ---------------------------------------------------------------------------
// A minimal, VALID publish candidate — the synthetic menu the version/lease/flip tests publish when
// what they are exercising is the machinery, not a real brand's data.
//
// It lives in its own module because two suites need it and only one of them can run here: the
// emulator suite (the pre-cutover gate, which needs a live Firestore) and the offline publish-path
// suite. A copy in each is a copy that rots in the one nobody runs — and "the emulator fixtures were
// updated but would fail if run" is exactly the finding this is answering. Shared, the offline suite
// publishes and rolls back these very fixtures on every `npm test`, so they cannot go stale silently.
//
// The shapes are the validator's, and the two id rules are easy to get backwards:
//   • a DISH id is a positive INTEGER outside la_musa (the x_pizza form interpolates it bare into an
//     inline handler), while the dish's pricing KEY is its name.
//   • an EXTRA id is a STRING handle — `EXTRAS.find(e => e.id === id)` compares against what came
//     back out of the DOM — while the extra's pricing key is, again, its name.
// ---------------------------------------------------------------------------
function mkVersion(menu, extras = {}) {
  const item = ([key, price], idx) => ({
    key, price, display: { id: idx + 1, name: key, cat: 'main', price, desc: key, emoji: '🍕', color: '#ffffff' },
  });
  const extra = ([key, price]) => ({ key, price, display: { id: `h_${key}`, name: key, cat: 'Extras', price } });
  const items = Object.entries(menu).map(item);
  const extraRecords = Object.entries(extras).map(extra);
  return {
    items,
    structure: {
      schema_version: 2,
      item_order: items.map((i) => i.key),
      extra_order: extraRecords.map((e) => e.key),
      categories: [{ id: 'main' }],
      ...(extraRecords.length ? {
        extra_categories: ['Extras'],
        // 1A Task 8: a menu that sells options must say who is offered them.
        exposure: { category_allow: { main: ['Extras'] }, item_overrides: {} },
      } : {}),
    },
    extras,
    extraRecords,
    source_sha: 'test',
  };
}

module.exports = { mkVersion };
