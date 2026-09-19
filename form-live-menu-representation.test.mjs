// Portal 1D FIX — the live-menu representation gate: a version bump must never blackhole the menu.
// Run: node form-live-menu-representation.test.mjs
//
// 🔴 THE INCIDENT THIS FILE EXISTS FOR. D1 bumped the served body's representation_version from 1b.1
// to 1d.1 — an ADDITIVE change both forms parse perfectly. The adapter exact-matched that string and
// returned null on every live menu from that moment, SILENTLY, because the refusal sat above the only
// logged path. Both brands quietly fell back to the frozen embedded bundle: 1B's live display had been
// off since the D1 deploy, and because the bundle carries no ids, no order carried one — which is what
// D3's heartbeat finally surfaced as "every order absent".
//
// So the tests here are about two properties, and the second is the one that would have caught it
// months earlier: the version alone must never refuse, and NO refusal may be silent.
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];

/* A real served body, in the shape getPublicMenu actually returns — built from the page's own live
   menu so it is the thing the real applier validates, with identity laid on as D1's overlay does. */
function servedBody(dir, w, { version = '1d.1', withIds = true, rid = BRAND[dir].rid } = {}) {
  const menu = BRAND[dir].menu(w);
  menu.dishes = menu.dishes.map((d) => (withIds ? { ...d, dish_id: `ID_dish_${d.id}` } : { ...d }));
  menu.extras = menu.extras.map((e) => (withIds ? { ...e, extra_id: `ID_extra_${e.id}` } : { ...e }));
  return { rid, representation_version: version, menu };
}

/* Capture the page's console.warn — the refusals and the marker log are console events, and "it was
   loud" is precisely what this file has to assert. */
function captureWarn(w) {
  const seen = [];
  const orig = w.console.warn;
  w.console.warn = (...a) => { seen.push(a.map(String).join(' ')); };
  return { seen, restore: () => { w.console.warn = orig; }, has: (k) => seen.some((l) => l.includes(k)) };
}

(async () => {
  for (const dir of DIRS) {
    // ── 1. 🔴 THE REGRESSION — A VERSION CHANGE ALONE APPLIES, AND SAYS SO ────────────────────
    /* The exact bug. An unknown version on an otherwise-good body must be ACCEPTED (the structural
       test decides acceptance) and must LOG. Two assertions, and the file would be worthless without
       both: accepted-but-silent would repeat the invisibility, refused-but-loud would repeat the
       outage. */
    {
      const w = loadForm(dir); await settle();
      const cap = captureWarn(w);
      const body = servedBody(dir, w, { version: '1e.1' });     // a version this form has never seen
      const out = w.__LIVE_MENU_ADAPTER.validateSnapshot(body);
      cap.restore();

      assert.ok(out, '🔴 a version-string change ALONE refused the menu — this is the outage, exactly');
      assert.strictEqual(out, body.menu, 'and it returns the menu it was given');
      assert.ok(cap.has('menu_representation_changed'),
        '🔴 …and it must be LOUD: an unexpected representation that applies silently is how the next bump goes unnoticed');
      assert.ok(cap.seen.some((l) => l.includes('1e.1')), 'the log names what it actually got');
      assert.ok(!cap.has('menu_snapshot_refused'), 'a version mismatch is not a refusal');
      ok(`${dir}: an unknown representation version APPLIES and logs menu_representation_changed`);
      closeAll();
    }

    // ── 2. THE CURRENT VERSION IS ACCEPTED SILENTLY ──────────────────────────────────────────
    {
      const w = loadForm(dir); await settle();
      const cap = captureWarn(w);
      const out = w.__LIVE_MENU_ADAPTER.validateSnapshot(servedBody(dir, w));   // 1d.1, the live one
      cap.restore();
      assert.ok(out, 'the live representation is accepted');
      assert.ok(!cap.has('menu_representation_changed'),
        'non-vacuity: the marker log fires on a MISMATCH, not on every apply — otherwise cell 1 proves nothing');
      ok(`${dir}: the current representation applies with no marker warning`);
      closeAll();
    }

    // ── 3. 🔴 EVERY REFUSAL IS LOUD, AND EACH NAMES ITS OWN REASON ───────────────────────────
    /* The property whose absence made this class invisible for weeks. A refusal that returns null
       without a word is indistinguishable from a network miss: there is nothing to watch, nothing to
       alarm on, and no way to tell "the merchant published something bad" from "the request failed". */
    {
      const w = loadForm(dir); await settle();
      const good = servedBody(dir, w);
      const cases = {
        raw_not_object: null,
        rid_mismatch: { ...good, rid: 'someone_elses_brand' },
        menu_missing: { rid: good.rid, representation_version: '1d.1' },
        structural: { ...good, menu: { ...good.menu, dishes: [{ id: 1, name: '', price: 0 }] } },
      };
      const reasons = [];
      for (const [reason, body] of Object.entries(cases)) {
        const cap = captureWarn(w);
        const out = w.__LIVE_MENU_ADAPTER.validateSnapshot(body);
        cap.restore();
        assert.strictEqual(out, null, `${reason}: must still be refused`);
        assert.ok(cap.has('menu_snapshot_refused'), `🔴 ${reason}: refused SILENTLY — the defect class that hid this incident`);
        assert.ok(cap.seen.some((l) => l.includes(reason)),
          `🔴 ${reason}: the log must name THIS reason, not a generic one — "refused" without which check is barely better than silence (saw: ${cap.seen.join(' | ')})`);
        reasons.push(reason);
      }
      assert.strictEqual(new Set(reasons).size, 4, 'four distinct reasons');
      ok(`${dir}: all 4 refusal paths log a DISTINCT reason — no silent null remains`);
      closeAll();
    }

    // ── 4. THE STRUCTURAL TEST STILL BITES ───────────────────────────────────────────────────
    /* Dropping the version gate must not have loosened acceptance. These are bodies liveMenuPrepare
       genuinely cannot consume, and they must still be refused — at the CURRENT version, so the
       refusal is the structure talking and not a version mismatch in disguise. */
    {
      const w = loadForm(dir); await settle();
      const good = servedBody(dir, w);
      const broken = {
        'a dish with an empty id': [{ ...good.menu.dishes[0], id: '' }],
        'a dish with a zero price': [{ ...good.menu.dishes[0], price: 0 }],
        'two dishes sharing an id': [good.menu.dishes[0], { ...good.menu.dishes[1], id: good.menu.dishes[0].id }],
      };
      for (const [label, dishes] of Object.entries(broken)) {
        const cap = captureWarn(w);
        const out = w.__LIVE_MENU_ADAPTER.validateSnapshot({ ...good, menu: { ...good.menu, dishes } });
        cap.restore();
        assert.strictEqual(out, null, `🔴 ${label}: acceptance was loosened — the structural test must still refuse this`);
        assert.ok(cap.has('structural'), `${label}: …loudly, with the typed reason`);
      }
      ok(`${dir}: ${Object.keys(broken).length} structurally-invalid bodies are still refused at the CURRENT version`);
      closeAll();
    }

    // ── 5. 🔴 THE COMPOSITION THE BUG BROKE — A LIVE BODY'S IDS REACH AN EMITTED CART ─────────
    /* End to end, through the real pieces: served body → the real adapter → the real applier → MENU →
       a cart line added through the form's own control → redeemCartItems(). This is the chain the
       outage severed, and asserting it here is what makes "the fix works" a measurement rather than a
       claim about a string comparison. */
    {
      const w = loadForm(dir); await settle();
      const body = servedBody(dir, w);
      const accepted = w.__LIVE_MENU_ADAPTER.validateSnapshot(body);
      assert.ok(accepted, 'premise — the live body is accepted');

      const prepared = w.liveMenuPrepare(accepted);
      w.liveMenuGlobalSet('MENU', prepared.MENU);
      w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
      await settle();
      assert.ok(prepared.MENU.every((d) => d.dish_id), '🔴 the applied MENU carries an id on every dish');

      const dish = prepared.MENU.find((d) => d.price > 0);
      w.chg(dish.id, 1); await settle();
      w.toggleDetailExtra(prepared.EXTRAS[0].id, dish.id, 0); await settle();

      const emitted = w.redeemCartItems();
      assert.ok(emitted.length > 0, 'premise — the cart has a line');
      assert.ok(emitted[0].dish_id,
        '🔴 the emitted cart line carries dish_id — this is what D3 saw as absent on every live order');
      assert.ok(emitted[0].extras[0] && emitted[0].extras[0].extra_id,
        '🔴 …and the nested option carries extra_id');
      /* 🔴 MONEY SAFETY IS SERVER-RECOMPUTE, NOT EQUALITY — and stated that way because the looser
         claim ("charged == confirmed") is false: 1C deliberately honours a price DROP and has a
         no-token grace path. What actually protects the customer here is that the server prices this
         cart from its OWN tables, by legacy key, ignoring every price and every id the form put on the
         wire. So turning the live menu back on cannot change what is charged — the cart that now
         carries ids prices to exactly what the server's tables say. */
      const rid = BRAND[dir].rid;
      const priced = computeServerTotal(emitted, rid, { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });
      assert.ok(!priced.error, `${dir}: the live-applied cart prices server-side (${priced.error})`);
      assert.ok(priced.total > 0, `${dir}: …to a real amount (${priced.total})`);
      const stripped = JSON.parse(JSON.stringify(emitted)).map((l) => {
        const { dish_id, extras, ...r } = l;
        return { ...r, extras: (extras || []).map(({ extra_id, ...e }) => e) };
      });
      assert.deepStrictEqual(computeServerTotal(stripped, rid, { restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] }), priced,
        `🔴 ${dir}: the identity the live menu restored changed the SERVER's total — it must price from its own tables by legacy key`);
      ok(`${dir}: a live body's ids reach the emitted cart, and the server's total is unmoved by them (${priced.total})`);
      closeAll();
    }
  }

  // ── 6. BOTH FORMS CARRY THE IDENTICAL ADAPTER ────────────────────────────────────────────────
  {
    const { readFileSync } = await import('node:fs');
    const slice = (dir) => {
      const src = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
      const i = src.indexOf('validateSnapshot: function (raw)');
      return src.slice(i, src.indexOf('\n  },', i));
    };
    const [a, b] = DIRS.map(slice);
    assert.ok(a.length > 400, 'premise — the adapter was located');
    assert.strictEqual(a, b, '🔴 the two forms\' adapters have drifted — this fix must be byte-identical in both');
    /* Comments stripped before the gate check — the note beside that comparison QUOTES the old line
       verbatim (`it used to read …`), which is deliberate and is also exactly what a naive grep
       mistakes for the defect. It did: this assertion failed on its own documentation. */
    const code = a.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(!/representation_version !== LIVE_MENU_REPRESENTATION\)\s*return/.test(code),
      '🔴 the version GATE is back — a version mismatch must never refuse');
    assert.ok(/representation_version !== LIVE_MENU_REPRESENTATION\)\s*\{/.test(code),
      'non-vacuity: the comparison still EXISTS — it logs instead of refusing, and a detector that passed on its absence would miss that too');
    assert.ok(/menu_representation_changed/.test(code), 'the marker is kept as observability');
    for (const dir of DIRS) {
      const src = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
      assert.ok(src.includes("const LIVE_MENU_REPRESENTATION = '1d.1';"), `${dir}: the marker tracks the current representation`);
    }
    ok('both forms carry the identical adapter, with the gate gone and the marker kept');
  }

  console.log(`\nform-live-menu-representation: ${count()} checks passed across both forms`);
  closeAll();
  process.exit(0);
})().catch((e) => { console.error('form-live-menu-representation FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
