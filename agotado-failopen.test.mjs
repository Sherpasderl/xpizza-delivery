// Behavioral test for the order-form Agotado overlay's availability polling (KDS 2b · KDS_2B_PLAN.md §5).
// Two load-bearing rules on loadAvailability():
//   FAIL-OPEN — an unreadable node (fetch throws OR non-OK) ⇒ EVERY item available (never leave a sellable
//               item disabled from a stale prior load).
//   SEQUENCE  — overlapping polls: only the LATEST request may mutate state; a superseded (older/slow/failed)
//               response does nothing, so it can't clobber a newer poll's applied flags.
// This runs the REAL loadAvailability extracted from each form, in a SHARED scope (so availSeq + itemAvail
// persist across overlapping calls), under a controllable fetch. Run: node agotado-failopen.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const defer = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));

// Extract loadAvailability's body and instantiate it in a shared scope. availSeq + itemAvail are module-
// scope in the real form; here they live in the Function closure. applyAvailability() is called after every
// itemAvail assignment (incl. the non-OK path that then `return`s), so we capture state there. fetch routes
// through state.fetchImpl so a test can control it (and swap it per call for the overlap case).
function makeForm(html) {
  const m = html.match(/async function loadAvailability\(\)\{([\s\S]*?)\n\}/);
  assert.ok(m, 'loadAvailability() not found in form');
  const body = m[1];
  assert.ok(!/\b(document|MENU|window\.availKey|soldOutById)\b/.test(body),
    'loadAvailability body references an un-injected global — the harness would be unsound');
  assert.ok(/availSeq/.test(body), 'loadAvailability must reference availSeq (the sequence guard)');
  const state = { itemAvail: {}, applied: 0, fetchImpl: null };
  const api = new Function('state', 'AVAIL_URL', `
    let availSeq = 0;
    let itemAvail = state.itemAvail;
    const applyAvailability = () => { state.applied++; state.itemAvail = itemAvail; };
    const fetch = (...a) => state.fetchImpl(...a);
    async function loadAvailability(){ ${body}
    }
    return { loadAvailability, setPrior: (v) => { itemAvail = v; state.itemAvail = v; } };
  `)(state, 'http://x/item_availability.json');
  return { state, ...api };
}

for (const form of ['xpizza-orders', 'la-musa-orders']) {
  const html = readFileSync(new URL(`./${form}/index.html`, import.meta.url), 'utf8');
  const soldOut = () => ({ Sopressatta: { available: false }, Pepperoni: { available: false } });

  // ── FAIL-OPEN ──
  { // (1) fetch THROWS after a prior sold-out load → reset to all-available
    const f = makeForm(html); f.setPrior(soldOut());
    f.state.fetchImpl = async () => { throw new Error('db hiccup'); };
    await f.loadAvailability();
    assert.deepStrictEqual(f.state.itemAvail, {}, `${form}: read error ⇒ itemAvail reset to {} (no stale sold-out)`);
    ok(`${form}: read ERROR after a sold-out load ⇒ every item available (fail-open)`);
  }
  { // (2) fetch resolves NON-OK → reset to all-available
    const f = makeForm(html); f.setPrior(soldOut());
    f.state.fetchImpl = async () => ({ ok: false });
    await f.loadAvailability();
    assert.deepStrictEqual(f.state.itemAvail, {}, `${form}: non-OK ⇒ itemAvail reset to {} (fail-open)`);
    ok(`${form}: non-OK response ⇒ every item available (fail-open)`);
  }
  { // (3) control — a successful read still applies the real 86 flags (happy path intact)
    const f = makeForm(html); const flags = { Sopressatta: { available: false } };
    f.state.fetchImpl = async () => ({ ok: true, json: async () => flags });
    await f.loadAvailability();
    assert.deepStrictEqual(f.state.itemAvail, flags, `${form}: OK read ⇒ itemAvail = the live flags (happy path intact)`);
    ok(`${form}: successful read applies the real 86 flags (fail-open didn't regress the happy path)`);
  }

  // ── SEQUENCE GUARD — an older failed poll completing AFTER a newer successful one must not clobber it ──
  {
    const f = makeForm(html);
    const dA = defer(), dB = defer();
    let call = 0;
    f.state.fetchImpl = () => { call++; return call === 1 ? dA.promise : dB.promise; };
    const pA = f.loadAvailability();   // A: seq=1, awaits dA
    const pB = f.loadAvailability();   // B: seq=2, awaits dB   (both ++availSeq synchronously → availSeq=2)
    const fresh = { Sopressatta: { available: false } };
    dB.resolve({ ok: true, json: async () => fresh });   // B (newer) succeeds first → applies fresh flags
    await pB; await tick();
    assert.deepStrictEqual(f.state.itemAvail, fresh, `${form}: B (newer) applied its flags`);
    dA.reject(new Error('slow fail'));                   // A (older) fails LATE → its catch guard (seq 1 !== 2) must skip the reset
    await pA; await tick();
    assert.deepStrictEqual(f.state.itemAvail, fresh, `${form}: A (older, failed) did NOT clobber B — sequence guard held`);
    ok(`${form}: overlapping polls — a stale failed poll can't clear a newer poll's fresh flags`);
  }
}

console.log(`\nagotado-failopen: OK (${n} cases)`);
