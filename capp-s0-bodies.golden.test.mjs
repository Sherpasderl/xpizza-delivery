// CUSTOMER APP S0-test — REQUEST-BODY GOLDENS, byte-exact, per brand (PLAN-shared-order-form.FINAL §5 S0, §7 oracle 1).
//
// What it proves: what each LIVE form sends to quoteOrder / createOrder / chargeOnlineOrder / quoteRedemption
// for the approved matrix, captured from the real forms (the real writers) against catalogs published through
// the real publish path and served as getPublicMenu serves them. The shared renderer must reproduce these
// bodies while dark; any approved behavioural delta lands as an explicit, reviewed golden change, never a
// silent re-capture.
//
// Matrix (each brand): A cash delivery · B cash pickup · C card delivery · D RTN on · E scheduled ·
// F email blank · G reward redemption (x_pizza punch / la_musa points). Every cell's cart = the first priced
// dish ×2 + the first extra its modal offers (a real click). Third brand (r3_synth): A and C, PROVISIONAL —
// rendered on the declared x_pizza fork until the S1 shared renderer exists.
//
// Masks: ONE list (capture.mjs MASKS); a masked field must be present and well-formed or the capture throws.
// No network: a recorder installed BEFORE the page's first script sees every fetch (start-up included);
// XHR/WebSocket/EventSource/sendBeacon are trapped; every request must be one this rig knows. EVERY request
// is kept (only byte-identical consecutive repeats collapse) and every raw body is leak-checked.
// Reward cells: the real quoteRedemptionCore over the published catalog and a provisioned balance.
//
// Run:   node capp-s0-bodies.golden.test.mjs            (check)
//        node capp-s0-bodies.golden.test.mjs --write    (re-capture from the CURRENT forms; review the diff)
import assert from 'node:assert';
import { readFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { closeAll, counter } from './form-harness.mjs';
import { provisionBrand, driveCell, recordCell, lastOf, PLAN_ETAG, MASKS } from './xpizza-functions/contract/capp/capture.mjs';
import { provisionThirdBrand, materializeFork, removeFork, transformList } from './xpizza-functions/contract/capp/third-brand-fork.mjs';

const GOLDEN = new URL('./capp-s0-bodies.golden.json', import.meta.url);
const WRITE = process.argv.includes('--write');
const { ok, count } = counter();
const LEAK = /x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i;
// A real brand's requests must never carry the OTHER brand's literals (its own are its data).
const OTHER = { x_pizza: /la_musa|lamusa|La Musa/i, la_musa: /x_pizza|xpizza|X\.? ?Pizza/i };
// Every raw request body the window sent — not just the last per endpoint — is checked.
function leakIn(rec, re) { for (const r of rec.raw) { const s = r.rawBody || ''; const m = re.exec(s); if (m) return `${r.endpoint}: ${m[0]}`; } return null; }

const BRANDS = [
  { rid: 'x_pizza', dir: 'xpizza-orders', reward: 'punch', marker: 'xpizza_acct' },
  { rid: 'la_musa', dir: 'la-musa-orders', reward: 'points', marker: 'lamusa_acct' },
];
const CELLS = [
  { id: 'A-cash-delivery', need: ['quoteOrder', 'createOrder'] },
  { id: 'B-cash-pickup', pickup: true, need: ['createOrder'] },
  { id: 'C-card-delivery', card: true, need: ['quoteOrder', 'chargeOnlineOrder'] },
  { id: 'D-rtn', rtn: true, need: ['createOrder'] },
  { id: 'E-scheduled', scheduled: true, need: ['createOrder'] },
  { id: 'F-email-blank', email: '', need: ['createOrder'] },
  { id: 'G-reward', reward: true, need: ['quoteRedemption', 'createOrder'] },
];
const THIRD_CELLS = ['A-cash-delivery', 'C-card-delivery'];

const plain = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  const got = { cells: {} };

  for (const B of BRANDS) {
    const prov = await provisionBrand(B.rid);
    assert.strictEqual(prov.etag, PLAN_ETAG[B.rid], `${B.rid}: the seeded real publish reproduces the plan §10 etag (got ${prov.etag})`);
    ok(`${B.rid}: catalog published through the real path, etag = plan §10 ${prov.etag.slice(1, 9)}…`);
    for (const C of CELLS) {
      const cell = { ...C, reward: C.reward ? B.reward : undefined, marker: B.marker };
      const { w, extra } = await driveCell(B.dir, prov, cell);
      assert.strictEqual(extra, true, `${B.rid}/${C.id}: non-vacuity — the cart carries an extra (the extras path ran)`);
      const rec = recordCell(w);
      for (const ep of C.need) assert.ok(lastOf(rec, ep), `${B.rid}/${C.id}: non-vacuity — ${ep} was sent (${rec.requests.map((r) => r.endpoint).join(',')})`);
      assert.strictEqual(leakIn(rec, OTHER[B.rid]), null, `${B.rid}/${C.id}: a request body carries the OTHER brand's literal`);
      for (const r of rec.raw.filter((x) => ['createOrder', 'chargeOnlineOrder', 'quoteOrder', 'quoteRedemption'].includes(x.endpoint))) {
        assert.strictEqual(r.body.restaurant_id, B.rid, `${B.rid}/${C.id}: ${r.endpoint} carries restaurant_id = ${B.rid} (§A1)`);
      }
      for (const r of rec.raw.filter((x) => ['createOrder', 'chargeOnlineOrder'].includes(x.endpoint))) assert.ok(r.body.order_id.startsWith('PZX-'), `${B.rid}/${C.id}: the live brands keep the PZX- prefix (§A3 ruling)`);
      if (C.reward) {
        const q = rec.raw.filter((r) => r.endpoint === 'quoteRedemption');
        assert.ok(q.length >= 1, `${B.rid}/${C.id}: the reward was quoted`);
        const send = lastOf(rec, 'createOrder');
        assert.ok(send.body.redeem && send.body.quote_token === '<masked:quote_token>', `${B.rid}/${C.id}: the send carries the reward AND the real issuer's verified quote token`);
      }
      got.cells[`${B.rid}/${C.id}`] = { requests: rec.requests };
    }
    ok(`${B.rid}: ${CELLS.length} cells captured, each with its required requests, zero network escapes, every request known`);
  }

  // ── THIRD BRAND (PROVISIONAL) ──
  const third = await provisionThirdBrand();
  const fork = materializeFork(third);
  try {
    assert.strictEqual(fork.entries.length, transformList(third.rid).length, 'third brand: every declared transform applied');
    assert.strictEqual(fork.changedLines, fork.entries.reduce((s, e) => s + e.lines, 0), 'third brand: the fork differs in exactly the declared lines');
    ok(`third brand ${third.rid}: fork = x_pizza page + ${fork.entries.length} declared transforms, exactly ${fork.changedLines} changed line(s), nothing else`);
    // The list is enforced, not advisory: an unused entry, or a wrong line count, refuses to materialize.
    assert.throws(() => materializeFork(third, [...transformList(third.rid), { file: 'index.html', find: 'NO SUCH TEXT ANYWHERE', to: 'x', lines: 1 }]), /unused transform/);
    assert.throws(() => materializeFork(third, transformList(third.rid).map((e) => (e.find === 'alt="X Pizza"' ? { ...e, lines: 2 } : e))), /matched 1 line\(s\), declared 2/);
    materializeFork(third);
    ok('third brand: an unused transform entry and a mis-declared line count each refuse to materialize the fork');
    for (const id of THIRD_CELLS) {
      const C = CELLS.find((c) => c.id === id);
      const { w, extra } = await driveCell(fork.dir, third, C);
      assert.strictEqual(extra, false, 'third brand: premise — its catalog publishes no extras (contract/third-brand.js)');
      const rec = recordCell(w);
      for (const ep of C.need) assert.ok(lastOf(rec, ep), `${third.rid}/${id}: non-vacuity — ${ep} was sent`);
      assert.strictEqual(leakIn(rec, LEAK), null, `${third.rid}/${id}: a request body leaks another brand's literal`);
      for (const r of rec.raw.filter((x) => x.body && Array.isArray(x.body.items))) {
        assert.ok(r.body.items.length > 0 && r.body.items.every((i) => /^R3 /.test(i.name)), `${third.rid}/${id}: ${r.endpoint} carries the third brand's renamed dishes only`);
      }
      // §A1 (closed in S0-prod): the third brand's identity reaches the server on EVERY quote and send.
      for (const r of rec.raw.filter((x) => ['createOrder', 'chargeOnlineOrder', 'quoteOrder'].includes(x.endpoint))) {
        assert.strictEqual(r.body.restaurant_id, third.rid, `${third.rid}/${id}: ${r.endpoint} carries restaurant_id = ${third.rid} (§A1)`);
      }
      // §A3: its order ids carry ITS prefix (data), not x_pizza's.
      for (const r of rec.raw.filter((x) => ['createOrder', 'chargeOnlineOrder'].includes(x.endpoint))) assert.ok(r.body.order_id.startsWith('RTS-'), `${third.rid}/${id}: order_id prefix is the third brand's (${r.body.order_id.slice(0, 4)})`);
      got.cells[`${third.rid}/${id} (PROVISIONAL)`] = { requests: rec.requests };
    }
    ok(`third brand: ${THIRD_CELLS.length} PROVISIONAL cells — no x_pizza/la_musa literal in any body; restaurant_id = ${third.rid} on every quote/send (§A1); order ids RTS- (§A3)`);
  } finally { removeFork(); try { rmdirSync(new URL('./node_modules', import.meta.url)); } catch (_) {} }

  got.masks = MASKS.map((m) => ({ name: m.name, path: m.path.join('.'), applies: String(m.applies), why: m.why }));
  const doc = { _about: 'Customer App S0-test request-body goldens. Captured from the CURRENT forms by capp-s0-bodies.golden.test.mjs --write; never hand-edit.', ...plain(got) };

  if (WRITE) {
    writeFileSync(GOLDEN, JSON.stringify(doc, null, 2) + '\n');
    console.log(`\nWROTE ${GOLDEN.pathname} (${Object.keys(got.cells).length} cells) — review the diff before committing`);
  } else {
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    assert.deepStrictEqual(Object.keys(doc.cells).sort(), Object.keys(want.cells).sort(), 'the cell set matches the golden');
    for (const k of Object.keys(want.cells)) assert.deepStrictEqual(doc.cells[k], want.cells[k], `${k}: request bodies differ from the golden (re-capture only for an APPROVED change)`);
    assert.deepStrictEqual(doc.masks, want.masks, 'the declared mask list matches the golden');
    ok(`${Object.keys(want.cells).length} cells byte-equal to capp-s0-bodies.golden.json (masks: ${MASKS.map((m) => m.name).join(', ')})`);
  }
  console.log(`\ncapp-s0-bodies.golden: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('capp-s0-bodies.golden FAILED:', (e && e.stack) || e); closeAll(); removeFork(); process.exit(1); });
