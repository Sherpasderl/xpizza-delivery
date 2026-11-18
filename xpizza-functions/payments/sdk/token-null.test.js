'use strict';
// fix/sdk-token-null-5f (owner ruling 11-18, card items 2; D4c-grill/privacy-5f/PLAN-card-token-cleanup.md (b)) — the reusable card
// token on payment_sdk/{oid}.token is NULLED once nothing can read it: the order is finished (status delivered/completed, payment_terminal,
// or a committed cancel / expiry — payment_cancel) AND the record is closed (not open / adjusting, no lock, no unanswered money op) AND the vault no longer owes a
// read (the winning attempt did not ask to save, or rec.vault.state is set). token_hash (per attempt) is KEPT. ONE CAS on the
// record, in the sweeper right after the vault step. Real coordinator + real sweeper + real cards on the honest RTDB model; the
// provider is the fake adapter. Run: node payments/sdk/token-null.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const C = require('./coordinator');
const K = require('./cards');
const SW = require('./sweeper');
const T0 = 1_800_000_000_000;   // 2027-01-15
const H = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DISP = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
const OID = 'tn_order_1';
const world = (script = {}) => {
  const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tn_rest', customer_uid: 'uid_A', customer_name: 'Ana Pérez', total_cents: 100, pay_deadline_at: T0 + 900000 } } });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => T0, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, verifyIdToken: async () => ({ uid: 'uid_A' }) };
  return { db, fake, deps, rec: () => db.getAt(`payment_sdk/${OID}`), ord: () => db.getAt(`orders/${OID}`) };
};
const card = (save) => ({ card_ref: 'new', display: DISP, save, vault_gen: 0 });
const place = async (w, token, save) => {
  const p = await C.placeOriginal(w.deps, { orderId: OID, attempt_id: 'att_tn_place_00000001', token, amount_cents: 100, card: card(save) });
  assert.strictEqual(p.outcome, 'placed', 'premise: the real coordinator placed the order');
  assert.strictEqual(w.rec().token, token, 'premise: the record carries the token');
};
const deliver = async (w) => { await w.db.ref(`orders/${OID}/status`).set('delivered'); };
const hashes = (w) => Object.values(w.rec().attempts || {}).map((a) => a.token_hash);

(async () => {
  await cell('TN-NULL-NO-SAVE', async (L) => {
    const w = world(); await place(w, 'T-nosave', false); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(w.ord().payment_terminal && w.rec().phase === 'frozen', `${L}: premise — the real sweeper settled the delivered order`);
    assert.strictEqual(w.rec().token, undefined, `${L}: a terminal, closed order with no save ⇒ the token is gone`);
    assert.deepStrictEqual(hashes(w), [H('T-nosave')], `${L}: the attempt's token_hash is kept`);
  });
  await cell('TN-NULL-AFTER-VAULT', async (L) => {
    const w = world(); await place(w, 'T-save', true); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().vault && w.rec().vault.state, 'done', `${L}: premise — the vault step ran on this visit`);
    const cards = Object.values(w.db.getAt('customer_cards/uid_A/cards') || {});
    assert.ok(cards.length === 1 && cards[0].token === 'T-save', `${L}: the saved card got the token BEFORE it was nulled`);
    assert.strictEqual(w.rec().token, undefined, `${L}: the same visit nulls the record's token once the vault is settled`);
    assert.deepStrictEqual(hashes(w), [H('T-save')], `${L}: token_hash kept`);
  });
  await cell('TN-KEPT-WHILE-VAULT-OWED', async (L) => {
    const w = world(); await place(w, 'T-owed', true); await deliver(w);
    await C.settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.ord().payment_terminal && !(w.rec().vault && w.rec().vault.state), `${L}: premise — terminal, the vault not yet run`);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: a save still owed ⇒ kept`);
    assert.strictEqual(w.rec().token, 'T-owed', `${L}: the vault can still read it`);
    await K.completeVaultForOrder(w.deps, OID);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'nulled', `${L}: once the vault is settled ⇒ nulled`);
    assert.strictEqual(w.rec().token, undefined, `${L}: gone`);
  });
  await cell('TN-NULL-CANCELLED', async (L) => {
    const w = world(); await place(w, 'T-cancel', false);
    const c = await C.cancelSdkOrder(w.deps, { orderId: OID });
    assert.ok(w.ord().payment_cancel && w.rec().phase === 'cancelled' && !w.ord().payment_terminal, `${L}: premise — a committed cancel (${c && c.outcome}), never payment_terminal`);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().token, undefined, `${L}: a cancelled order's token does not stay forever`);
    assert.deepStrictEqual(hashes(w), [H('T-cancel')], `${L}: token_hash kept`);
  });
  await cell('TN-KEPT-WHILE-OPEN', async (L) => {
    const w = world(); await place(w, 'T-open', false);
    await SW.visitDueOrder(w.deps, OID);
    assert.ok(!w.ord().payment_terminal && w.rec().phase === 'open', `${L}: premise — a live (placed, not terminal) order`);
    assert.strictEqual(w.rec().token, 'T-open', `${L}: an open order keeps its token (a decrease re-authorizes with it)`);
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: not terminal ⇒ kept`);
  });
  await cell('TN-KEPT-RECORD-NOT-CLOSED', async (L) => {
    const w = world(); await place(w, 'T-lock', false); await deliver(w);
    await C.settleTerminal(w.deps, { orderId: OID });
    await w.db.ref(`payment_sdk/${OID}/lock`).set({ op_id: 'op_x', at: T0 });   // a money operation in flight
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'kept', `${L}: a locked record ⇒ kept`);
    assert.strictEqual(w.rec().token, 'T-lock', `${L}: kept`);
  });
  await cell('TN-IDEMPOTENT', async (L) => {
    const w = world(); await place(w, 'T-idem', false); await deliver(w);
    await SW.visitDueOrder(w.deps, OID);
    const v = w.rec().version;
    assert.strictEqual(await K.nullSpentToken(w.deps, OID), 'none', `${L}: nothing left to null`);
    await SW.visitDueOrder(w.deps, OID);
    assert.strictEqual(w.rec().version, v, `${L}: a later visit writes nothing (no version bump)`);
  });
  // every reader of a record's token is known (Codex #149 r1 P2): a CENSUS of every `.token` / `['token']` / destructured `token`
  // access — ANY receiver (an alias included) — by AST, across EVERY non-test file of xpizza-functions that reads a payment_sdk path
  // (the literal, or the record / coordinator readers), the file set derived by grep at run time (a new reader file joins it). Each
  // site is pinned by file + exact line text: a new or moved reader must be reviewed against the null rule (PLAN (b)).
  const FN = path.join(__dirname, '..', '..');
  const { execFileSync } = require('child_process');
  const acorn = require('acorn');
  const readerFiles = () => [...new Set([
    ...execFileSync('git', ['grep', '-l', 'payment_sdk', '--', '*.js', ':!*.test.js', ':!test/**'], { cwd: FN, encoding: 'utf8' }).split('\n'),
    ...execFileSync('git', ['grep', '-l', '-E', "require\\(['\"][./a-z/]*(payments/sdk/)?(record|coordinator)['\"]\\)|readRecord\\(", '--', '*.js', ':!*.test.js', ':!test/**'], { cwd: FN, encoding: 'utf8' }).split('\n'),
  ])].filter(Boolean).sort();
  const isTok = (k, computed) => (!computed && k.type === 'Identifier' && k.name === 'token') || (k.type === 'Literal' && k.value === 'token');
  function tokenSites(files, read) {
    const out = [];
    for (const f of files) {
      const src = read(f); const lines = src.split('\n');
      const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true, allowReturnOutsideFunction: true });
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n.type !== 'string') return;
        if (n.type === 'MemberExpression' && isTok(n.property, n.computed)) out.push(`${f} | ${lines[n.loc.start.line - 1].trim()}`);
        if (n.type === 'ObjectPattern') for (const q of n.properties) if (q.type === 'Property' && isTok(q.key, q.computed)) out.push(`${f} | ${lines[q.loc.start.line - 1].trim()}`);
        for (const [k, v] of Object.entries(n)) if (k !== 'loc') walk(v);
      };
      walk(ast);
    }
    return out.sort();
  }
  const REVIEWED = [
    'payments/sdk/cards.js | async function completeVault(deps, { uid, token, token_hash: h, display: rawDisplay, vault_gen: gen }) {',   // a card write's own argument
    'payments/sdk/cards.js | const token = rec.token;',                                                                                   // the vault (owed ⇒ kept)
    'payments/sdk/cards.js | delete x.token; out = \'nulled\';',                                                                         // the null itself
    'payments/sdk/cards.js | if (!isObj(c) || typeof c.token !== \'string\' || expiredNow(c, deps.clock())) return null;',               // a SAVED card (customer_cards)
    'payments/sdk/cards.js | if (typeof x.token !== \'string\') return undefined;',                                                      // the null itself
    'payments/sdk/cards.js | return { card_id: cardId, token: c.token, token_hash: c.token_hash, display: { brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year } };',   // a SAVED card
    'payments/sdk/coordinator.js | async function placeOriginal(deps, { orderId, attempt_id, token, amount_cents, authentication_identifier = null, card = null }) {',   // the claim's argument
    'payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token: rec.token, amount_cents: need, op_id: opId, ref: orderId }),',   // increase (refused, owner 11-10)
    'payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token: rec.token, amount_cents: new_total_cents, op_id: opId, ref: orderId }),',   // decrease (open only)
    'payments/sdk/coordinator.js | rec.token = token;',                                                                                    // the claim write
    'payments/sdk/finish.js | token = s.token; card = { display: s.display, save: false, card_ref: `saved:${s.card_id}` };',             // a SAVED card resolved
  ].sort();
  const realRead = (f) => fs.readFileSync(path.join(FN, f), 'utf8');
  await cell('TN-READERS-CENSUS', async (L) => {
    const files = readerFiles();
    assert.ok(files.includes('payments/sdk/coordinator.js') && files.includes('ledger/projector.js') && files.length >= 15, `${L}: premise — the reader file set spans the repo (${files.length} files)`);
    assert.deepStrictEqual(tokenSites(files, realRead), REVIEWED, `${L}: every token access in a payment_sdk reader is a reviewed site (file + exact line) — a new one needs the null rule reviewed`);
  });
  // negative controls: each planted reader must change the census
  const plant = (file, text) => (f) => (f === file ? `${realRead(f)}\n${text}\n` : realRead(f));
  await cell('TN-READERS-CENSUS-ALIAS', async (L) => {
    for (const t of ['function z(rec) { const paymentRecord = rec; return paymentRecord.token; }', "function z(rec) { const r2 = rec; return r2['token']; }", 'function z(rec) { const { token } = rec; return token; }', 'function z(rec) { return rec?.token; }']) {
      assert.notDeepStrictEqual(tokenSites(readerFiles(), plant('payments/sdk/cards.js', t)), REVIEWED, `${L}: an aliased / computed / destructured / optional reader in cards.js is caught: ${t}`);
    }
  });
  await cell('TN-READERS-CENSUS-OUTSIDE', async (L) => {
    assert.notDeepStrictEqual(tokenSites(readerFiles(), plant('ledger/projector.js', 'function z(snap) { return snap.val().token; }')), REVIEWED, `${L}: a reader outside payments/sdk (ledger) is caught`);
    const files = [...readerFiles(), 'virtual-new-reader.js'];
    const read = (f) => (f === 'virtual-new-reader.js' ? "const z = async (db, id) => (await db.ref(`payment_sdk/${id}`).once('value')).val().token;" : realRead(f));
    assert.notDeepStrictEqual(tokenSites(files, read), REVIEWED, `${L}: a NEW file reading payment_sdk with a token access is caught`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\ntoken-null: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stderr.write(`token-null: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
