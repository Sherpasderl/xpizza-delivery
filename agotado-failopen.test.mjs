// Behavioral fail-open test for the order-form Agotado overlay (KDS 2b · KDS_2B_PLAN.md §5).
// loadAvailability() reads /restaurants/{rid}/item_availability. The load-bearing rule: an UNREADABLE
// node (fetch throws OR non-OK) ⇒ EVERY item available — a DB hiccup must never leave a sellable item
// disabled from a stale prior load. This runs the REAL loadAvailability extracted from each form under a
// stubbed fetch + a prior "sold-out" itemAvail, and asserts it resets to {} (all available) + re-applies.
// Run: node agotado-failopen.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Extract loadAvailability's body and run it in a controlled scope: itemAvail is a reassigned free var,
// so we thread it through a state object; applyAvailability is spied; fetch + AVAIL_URL are injected.
async function runLoad(formHtml, { fetchImpl, priorItemAvail }) {
  const m = formHtml.match(/async function loadAvailability\(\)\{([\s\S]*?)\n\}/);
  assert.ok(m, 'loadAvailability() not found in form');
  const body = m[1];
  // Sanity: the body must only touch the vars we inject (else the extraction would miss a dependency).
  assert.ok(!/\b(document|MENU|window\.availKey|soldOutById)\b/.test(body),
    'loadAvailability body references an un-injected global — the extraction harness would be unsound');
  const state = { itemAvail: priorItemAvail, applied: 0 };
  // loadAvailability calls applyAvailability() immediately after EVERY itemAvail assignment (incl. the
  // non-OK path, which then `return`s), so capture the value there — a trailing capture would miss the
  // early-return paths.
  const fn = new Function('state', 'AVAIL_URL', 'fetch', `
    let itemAvail = state.itemAvail;
    const applyAvailability = () => { state.applied++; state.itemAvail = itemAvail; };
    return (async () => {
      ${body}
      state.itemAvail = itemAvail;   // fallback capture (a path that set itemAvail without applying)
    })();
  `);
  await fn(state, 'http://x/item_availability.json', fetchImpl);
  return state;
}

for (const form of ['xpizza-orders', 'la-musa-orders']) {
  const html = readFileSync(new URL(`./${form}/index.html`, import.meta.url), 'utf8');
  const priorSoldOut = () => ({ Sopressatta: { available: false }, Pepperoni: { available: false } });

  // (1) fetch THROWS after a prior successful load that had items sold-out → reset to all-available
  {
    const s = await runLoad(html, { fetchImpl: async () => { throw new Error('db hiccup'); }, priorItemAvail: priorSoldOut() });
    assert.deepStrictEqual(s.itemAvail, {}, `${form}: fetch throw ⇒ itemAvail reset to {} (no stale sold-out)`);
    assert.ok(s.applied >= 1, `${form}: applyAvailability re-applied after the throw (UI re-enabled)`);
    ok(`${form}: read ERROR after a sold-out load ⇒ every item available (itemAvail={}, re-applied)`);
  }
  // (2) fetch resolves NON-OK → reset to all-available
  {
    const s = await runLoad(html, { fetchImpl: async () => ({ ok: false }), priorItemAvail: priorSoldOut() });
    assert.deepStrictEqual(s.itemAvail, {}, `${form}: non-OK ⇒ itemAvail reset to {} (fail-open)`);
    assert.ok(s.applied >= 1, `${form}: applyAvailability re-applied after non-OK`);
    ok(`${form}: non-OK response ⇒ every item available (itemAvail={}, re-applied)`);
  }
  // (3) control — a successful read still APPLIES the real flags (fail-open didn't break the happy path)
  {
    const flags = { Sopressatta: { available: false } };
    const s = await runLoad(html, { fetchImpl: async () => ({ ok: true, json: async () => flags }), priorItemAvail: {} });
    assert.deepStrictEqual(s.itemAvail, flags, `${form}: OK read ⇒ itemAvail = the live flags (happy path intact)`);
    assert.ok(s.applied >= 1, `${form}: applyAvailability applied on a successful read`);
    ok(`${form}: successful read still applies the real 86 flags (fail-open didn't regress the happy path)`);
  }
}

console.log(`\nagotado-failopen: OK (${n} cases)`);
