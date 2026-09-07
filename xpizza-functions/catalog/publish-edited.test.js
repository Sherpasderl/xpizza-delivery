'use strict';
// Portal 2b-1 Task 4 — publishEdited: the only path that moves live prices without a code yardstick.
// Run: node catalog/publish-edited.test.js
//
// 2a could always ask "does the store equal the code?". Here divergence is the point, so that question
// is gone and four things carry the weight instead:
//
//   THE TOKEN RE-MATCH — a publish may land ONLY the exact draft that was reviewed, against the exact
//   live version it was reviewed against, showing the exact diff that was shown. Everything else (a
//   draft edited since, someone else's publish in between, a forged or replayed token) rejects.
//
//   THE EXACT-MATCH ACK — a large change is confirmable but never silent, and never blindly. The caller
//   must echo back the precise {key,surface} set the server flagged; `true` cannot satisfy it, and
//   neither can a subset or a superset.
//
//   THE FISCAL GATE — an x_pizza menu edit changes the SAR factura, so it needs an owner acknowledgement
//   on top of staff approval. la_musa issues its own fiscal documents and needs none.
//
//   VERIFY-BEFORE-FLIP — inherited from 2a and untouched: a build that cannot be re-read moves no pointer.
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { publishEditedCore } = require('./publish-edited-handler');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('publish-edited: FAILED — exited without completing'); process.exitCode = 1; } });

const T_DRAFT = '2026-09-07T12:00:00.000000Z';
const ACTIVE = 'v-active-7';
const allow = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const asRole = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@x.hn` });

const srcOf = (rid, mutate) => { const s = JSON.parse(JSON.stringify(buildSourceFromCode(rid))); if (mutate) mutate(s); return s; };
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const setPrice = (key, val) => (s) => { const it = s.items.find((x) => x.key === key); it.price = val; it.display.price = val; };

// A harness that holds a live version + a draft, and records every publish attempt.
function harness(rid, draftSrc, { activeVersionId = ACTIVE, draftUpdateTime = T_DRAFT, publishImpl = null } = {}) {
  const liveSrc = srcOf(rid);
  const state = { publishes: [], draft: draftSrc, draftUpdateTime, activeVersionId };
  return {
    state,
    deps: {
      db: {},
      authorize: allow,
      readActiveBuilt: async () => ({ built: builtOf(liveSrc, rid), versionId: state.activeVersionId }),
      readDraft: async () => ({ source: state.draft, updateTime: state.draftUpdateTime }),
      publishVersion: async (_db, r, input) => {
        state.publishes.push({ rid: r, input });
        if (publishImpl) return publishImpl(input);
        return { versionId: 'v-new-8', item_count: input.items.length, extra_count: Object.keys(input.extras).length };
      },
    },
    // the token a healthy editCatalog would have minted for this exact state
    tokenFor: (over = {}) => {
      const diff = catalogDiff(builtOf(liveSrc, rid), builtOf(state.draft, rid));
      const st = { rid, baseActiveVersionId: state.activeVersionId, sourceUpdateTime: state.draftUpdateTime, sourceHash: sha256(state.draft), diff, ...over };
      return { token: issueEditToken(st), diff };
    },
  };
}
const ackFor = (diff) => diff.largeChangeSet.map((l) => ({ key: l.key, surface: l.surface }));

(async () => {
  // ── (1) THE HAPPY PATH — and it publishes a store that DIVERGES from code, which is the point ──
  {
    const h = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
    const { token, diff } = h.tokenFor();
    assert.strictEqual(diff.largeChangeSet.length, 0, 'premise: a modest change needs no ack');
    const r = await publishEditedCore(h.deps, { restaurantId: 'la_musa', token }, {});
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.versionId, 'v-new-8', 'the new version id comes back');
    assert.strictEqual(h.state.publishes.length, 1, 'exactly one publish');
    const published = h.state.publishes[0].input;
    assert.strictEqual(published.items.find((i) => i.key === 'dimsum_01').price, 250, 'and it carries the EDITED price — no code yardstick blocked it');
    assert.ok(published.structure && published.extras, 'with structure and extras (publishVersion verifies before it flips)');
  }
  ok('a matching token publishes the edited draft — a store that diverges from code is exactly what this path is for');

  // ── (2) THE TOKEN RE-MATCH. Each of these is a publish landing something nobody reviewed. ──────
  {
    const cases = [
      ['the draft moved after the review', (h) => { h.state.draftUpdateTime = '2026-09-07T13:00:00.000000Z'; }],
      ['the draft CONTENT changed under the same time', (h) => { h.state.draft = srcOf('la_musa', setPrice('dimsum_01', 999)); }],
      ['someone else published in between', (h) => { h.state.activeVersionId = 'v-active-8'; }],
    ];
    for (const [label, drift] of cases) {
      const h = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
      const { token } = h.tokenFor();
      drift(h);
      const r = await publishEditedCore(h.deps, { restaurantId: 'la_musa', token }, {});
      assert.strictEqual(r.status, 409, `${label} → 409`);
      assert.strictEqual(r.body.error, 'edit_superseded', `${label} → edit_superseded`);
      assert.strictEqual(h.state.publishes.length, 0, `${label} → NOTHING published, no pointer moved`);
    }
    // forged / absent / replayed-shape tokens
    for (const [label, tok] of [['a forged token', 'deadbeef'.repeat(8)], ['no token', undefined], ['an empty token', ''], ['a non-string token', { a: 1 }]]) {
      const h = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
      const r = await publishEditedCore(h.deps, { restaurantId: 'la_musa', token: tok }, {});
      assert.ok(r.status === 409 || r.status === 400, `${label} → rejected (${r.status})`);
      assert.strictEqual(h.state.publishes.length, 0, `${label} → nothing published`);
    }
    // THE STATE MUST COME FROM THE SERVER, never from the request. If the handler let the body supply
    // baseActiveVersionId or sourceUpdateTime, a caller could hand back exactly the values the token was
    // minted for and the re-match would compare the token against itself — passing while the live
    // version and the draft have both moved on.
    for (const claim of ['baseActiveVersionId', 'sourceUpdateTime', 'sourceHash']) {
      const hc = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
      const minted = { baseActiveVersionId: hc.state.activeVersionId, sourceUpdateTime: hc.state.draftUpdateTime, sourceHash: sha256(hc.state.draft) };
      const { token } = hc.tokenFor();
      hc.state.activeVersionId = 'v-moved-9';                       // someone else published
      hc.state.draftUpdateTime = '2026-09-07T23:00:00.000000Z';     // and the draft moved
      const r = await publishEditedCore(hc.deps, { restaurantId: 'la_musa', token, ...{ [claim]: minted[claim] } }, {});
      assert.strictEqual(r.status, 409, `a caller-supplied ${claim} must not satisfy the re-match`);
      assert.strictEqual(r.body.error, 'edit_superseded', `${claim} → still superseded`);
      assert.strictEqual(hc.state.publishes.length, 0, `${claim} → nothing published`);
    }
    // ...and ALL of them at once, which is the case that actually bypasses: overriding one field still
    // trips on the others, so a per-field test cannot tell a hardened handler from a credulous one.
    {
      const hc = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
      const minted = { baseActiveVersionId: hc.state.activeVersionId, sourceUpdateTime: hc.state.draftUpdateTime, sourceHash: sha256(hc.state.draft) };
      const { token } = hc.tokenFor();
      hc.state.activeVersionId = 'v-moved-9';
      hc.state.draftUpdateTime = '2026-09-07T23:00:00.000000Z';
      const r = await publishEditedCore(hc.deps, { restaurantId: 'la_musa', token, ...minted }, {});
      assert.strictEqual(r.status, 409, 'supplying EVERY bound field must still not satisfy the re-match — the state comes from the server');
      assert.strictEqual(hc.state.publishes.length, 0, 'and nothing is published');
    }

    // a token minted for the OTHER brand must not publish this one
    const hx = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 320)));
    const cross = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
    const r2 = await publishEditedCore(cross.deps, { restaurantId: 'la_musa', token: hx.tokenFor().token }, {});
    assert.strictEqual(r2.status, 409, 'a token for x_pizza must not publish la_musa');
    assert.strictEqual(cross.state.publishes.length, 0, 'and nothing is published');
    ok(`all ${cases.length} drift cases + 4 malformed/forged + a cross-brand token reject with NOTHING published`);
  }

  // ── (3) THE EXACT-MATCH ACK. Confirmable, never silent, never blind. ─────────────────────────
  {
    const big = srcOf('x_pizza', setPrice('Margherita', 2990));   // the fat-finger
    const h = harness('x_pizza', big);
    const { token, diff } = h.tokenFor();
    assert.ok(diff.largeChangeSet.length >= 1, 'premise: this trips the sanity set');
    const exact = ackFor(diff);

    const bad = [
      ['no ack at all', undefined],
      ['a blind true', true],
      ['a blind "yes" string', 'yes'],
      ['an empty array', []],
      ['a SUPERSET (acking things never flagged)', [...exact, { key: 'Pepperoni', surface: 'item' }]],
      ['the right key on the WRONG surface', exact.map((e) => ({ ...e, surface: 'extra' }))],
      ['keys only, no surface', exact.map((e) => ({ key: e.key }))],
      ['a bare string list', exact.map((e) => e.key)],
      // TYPE CONFUSION: objects whose key/surface are not strings but stringify to the right values.
      // Without a type check these coerce into a matching identifier inside a template literal.
      ['non-string fields that stringify to a match', exact.map((e) => ({ key: { toString: () => e.key }, surface: { toString: () => e.surface } }))],
      ['an array-wrapped key that stringifies to a match', exact.map((e) => ({ key: [e.key], surface: [e.surface] }))],
    ];
    for (const [label, ack] of bad) {
      const r = await publishEditedCore(h.deps, { restaurantId: 'x_pizza', token, acknowledgedChanges: ack, fiscalAck: true }, {});
      assert.strictEqual(r.status, 400, `${label} → 400`);
      assert.strictEqual(r.body.error, 'large_change_unconfirmed', `${label} → large_change_unconfirmed`);
      assert.strictEqual(h.state.publishes.length, 0, `${label} → nothing published`);
    }
    // a PARTIAL ack, on a diff with two flagged changes
    const two = harness('x_pizza', srcOf('x_pizza', (s) => { setPrice('Margherita', 2990)(s); setPrice('Pepperoni', 3990)(s); }));
    const t2 = two.tokenFor();
    assert.strictEqual(t2.diff.largeChangeSet.length, 2, 'premise: two flagged changes');
    const partial = await publishEditedCore(two.deps, { restaurantId: 'x_pizza', token: t2.token, acknowledgedChanges: [ackFor(t2.diff)[0]], fiscalAck: true }, {});
    assert.strictEqual(partial.body.error, 'large_change_unconfirmed', 'acking ONE of two flagged changes is not acking the set');
    assert.strictEqual(two.state.publishes.length, 0, 'and nothing is published');

    // the exact set, in any order, proceeds
    const r = await publishEditedCore(h.deps, { restaurantId: 'x_pizza', token, acknowledgedChanges: [...exact].reverse(), fiscalAck: true }, {});
    assert.strictEqual(r.status, 200, `the exact set must proceed (got ${r.status} ${JSON.stringify(r.body)})`);
    assert.strictEqual(h.state.publishes.length, 1, 'and it publishes');
    ok(`the ack must be the EXACT flagged set: ${bad.length} blind/empty/superset/mis-surfaced forms and a partial ack all rejected; the exact set (any order) proceeds`);
  }
  {
    // ...and when nothing is flagged, no ack is needed at all — the gate must not become paperwork.
    const h = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
    const r = await publishEditedCore(h.deps, { restaurantId: 'la_musa', token: h.tokenFor().token }, {});
    assert.strictEqual(r.status, 200, 'an ordinary change needs no acknowledgement');
    ok('a change that trips nothing needs no ack — the gate is for scary changes, not for every edit');
  }

  // ── (4) THE FISCAL GATE — x_pizza only ───────────────────────────────────────────────────────
  {
    const h = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 320)));
    const { token, diff } = h.tokenFor();
    assert.strictEqual(diff.largeChangeSet.length, 0, 'premise: nothing flagged, so ONLY the fiscal gate is in play');
    // Falsey forms AND truthy-but-not-true ones. A client sending the string "false", or a 1, or an
    // empty object, is a real bug class — every one of those is truthy, so a `!fiscalAck` check would
    // treat it as an owner acknowledgement that nobody gave.
    for (const [label, ack] of [
      ['absent', undefined], ['false', false], ['null', null], ['an empty string', ''], ['zero', 0],
      ['the STRING "false"', 'false'], ['the string "no"', 'no'], ['1', 1], ['an empty object', {}], ['an empty array', []],
    ]) {
      const r = await publishEditedCore(h.deps, { restaurantId: 'x_pizza', token, fiscalAck: ack }, {});
      assert.strictEqual(r.status, 403, `x_pizza with fiscalAck ${label} → 403`);
      assert.strictEqual(r.body.error, 'fiscal_ack_required', `x_pizza with fiscalAck ${label} → fiscal_ack_required`);
      assert.strictEqual(h.state.publishes.length, 0, `x_pizza with fiscalAck ${label} → nothing published`);
    }
    const r = await publishEditedCore(h.deps, { restaurantId: 'x_pizza', token, fiscalAck: true }, {});
    assert.strictEqual(r.status, 200, 'with the acknowledgement it publishes');

    // ── THE ACKNOWLEDGEMENT MUST COME FROM AN OWNER ──────────────────────────────────────────
    // A boolean anyone can send is not an owner acknowledgement. The whole point of the fiscal gate is
    // that a PERSON with legal responsibility for the SAR document signed off; if any dispatcher or
    // kitchen-staff member can set the flag, the gate records a signature nobody gave.
    for (const role of ['dispatcher', 'staff']) {
      const hr = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 320)));
      const rr = await publishEditedCore({ ...hr.deps, authorize: asRole(role) }, { restaurantId: 'x_pizza', token: hr.tokenFor().token, fiscalAck: true }, {});
      assert.strictEqual(rr.status, 403, `a ${role} sending fiscalAck:true → 403`);
      assert.strictEqual(rr.body.error, 'not_owner', `a ${role} sending fiscalAck:true → not_owner, DISTINCT from fiscal_ack_required`);
      assert.strictEqual(hr.state.publishes.length, 0, `a ${role} publishes nothing`);
    }
    // NEITHER CONDITION IS SUFFICIENT ALONE: an owner without the acknowledgement is still refused, and
    // refused as a MISSING ACK rather than as a permissions problem — the two are different fixes.
    const hNoAck = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 320)));
    const rNoAck = await publishEditedCore(hNoAck.deps, { restaurantId: 'x_pizza', token: hNoAck.tokenFor().token }, {});
    assert.strictEqual(rNoAck.body.error, 'fiscal_ack_required', 'an owner without the ack is refused for the ack, not for the tier');
    // ...and a non-owner without the ack is told the thing they can actually act on: they are not the owner
    const hNeither = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 320)));
    const rNeither = await publishEditedCore({ ...hNeither.deps, authorize: asRole('dispatcher') }, { restaurantId: 'x_pizza', token: hNeither.tokenFor().token }, {});
    assert.strictEqual(rNeither.body.error, 'not_owner', 'a non-owner with no ack is told they are not the owner (acking would not help them)');
    // an owner of the OTHER brand is not an owner here — the tier is per-restaurant, and authorize is
    // what enforces that, so a role of 'owner' arriving for the wrong rid can only come from a bug
    ok('the fiscal ack must come from an OWNER: dispatcher/staff sending fiscalAck:true are refused as not_owner, and neither condition alone suffices');

    // la_musa issues its own fiscal documents, so it must NOT be gated — a gate that applied to every
    // brand would be paperwork nobody can satisfy for a merchant with no platform factura.
    const l = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
    const rl = await publishEditedCore(l.deps, { restaurantId: 'la_musa', token: l.tokenFor().token }, {});
    assert.strictEqual(rl.status, 200, 'la_musa publishes with no fiscalAck');
    assert.strictEqual(l.state.publishes.length, 1, 'and really publishes');
    // ...and la_musa is untouched by the OWNER requirement too — it has no platform factura, so an
    // owner tier would gate a merchant on a document they do not owe. Every tier still publishes it.
    for (const role of ['dispatcher', 'staff']) {
      const lm = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)));
      const rm = await publishEditedCore({ ...lm.deps, authorize: asRole(role) }, { restaurantId: 'la_musa', token: lm.tokenFor().token }, {});
      assert.strictEqual(rm.status, 200, `la_musa: a ${role} publishes normally — the owner gate is x_pizza-only`);
      assert.strictEqual(lm.state.publishes.length, 1, `la_musa: a ${role} really publishes`);
    }
    ok('x_pizza requires fiscalAck === true (10 falsey AND truthy-but-not-true forms refused, incl. the string "false"); la_musa, which issues its own facturas, is not gated');
  }

  // ── (5) ORDER OF THE GATES. A gate that runs after the publish is not a gate. ────────────────
  {
    const h = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 2990)));
    const { token } = h.tokenFor();
    // every gate failing at once: auth is checked first, and nothing downstream runs
    const rAuth = await publishEditedCore({ ...h.deps, authorize: async () => ({ ok: false, status: 401, error: 'missing_bearer_token' }) },
      { restaurantId: 'x_pizza', token }, {});
    assert.strictEqual(rAuth.status, 401, 'auth first');
    assert.strictEqual(rAuth.body.error, 'missing_bearer_token', 'with its own typed error');
    assert.strictEqual(h.state.publishes.length, 0, 'nothing published');
    // a stale token beats a missing ack: the token is re-matched before the ack is even considered,
    // so a superseded edit is never reported as "you forgot to confirm"
    const stale = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 2990)));
    const st = stale.tokenFor();
    stale.state.activeVersionId = 'v-moved';
    const rs = await publishEditedCore(stale.deps, { restaurantId: 'x_pizza', token: st.token, fiscalAck: true }, {});
    assert.strictEqual(rs.body.error, 'edit_superseded', 'a superseded edit reports as superseded, not as an unconfirmed change');
    // and the fiscal gate is evaluated BEFORE anything is published, not after
    const fx = harness('x_pizza', srcOf('x_pizza', setPrice('Margherita', 320)));
    await publishEditedCore(fx.deps, { restaurantId: 'x_pizza', token: fx.tokenFor().token }, {});
    assert.strictEqual(fx.state.publishes.length, 0, 'the fiscal gate refuses BEFORE publishVersion is ever called');
    ok('gate order: auth → token → ack → fiscal → publish; each refuses before anything is written');
  }

  // ── (6) VERIFY-BEFORE-FLIP is inherited, not bypassed ────────────────────────────────────────
  {
    const h = harness('la_musa', srcOf('la_musa', setPrice('dimsum_01', 250)), {
      publishImpl: () => { throw new Error('publish_verify_structure_mismatch: la_musa/v-new'); },
    });
    const r = await publishEditedCore(h.deps, { restaurantId: 'la_musa', token: h.tokenFor().token }, {});
    assert.strictEqual(r.status, 500, 'a build that fails verification is a server error, not a silent success');
    assert.strictEqual(r.body.error, 'publish_failed', 'typed');
    assert.ok(/verify_structure|mismatch/.test(r.body.detail || ''), 'and the reason is surfaced');
    ok('verify-before-flip still governs: a build that cannot be re-read fails the publish (2a behaviour, untouched)');
  }

  // ── (7) THE DRAFT IS RE-VALIDATED SERVER-SIDE before it becomes live ─────────────────────────
  // A token is not a licence to skip checking. And an INVALID draft must report as invalid, not as an
  // unconfirmed large change: a zero price trips the sanity set too, and telling someone "confirm this
  // change" invites them to try acknowledging their way past a price that can never publish.
  {
    const corrupt = srcOf('la_musa', (s) => { const it = s.items.find((x) => x.key === 'dimsum_01'); it.price = 0; it.display.price = 0; });
    const h = harness('la_musa', corrupt);
    const r = await publishEditedCore(h.deps, { restaurantId: 'la_musa', token: h.tokenFor().token }, {});
    assert.strictEqual(r.status, 400, 'a corrupt draft is refused at publish time too');
    assert.strictEqual(r.body.error, 'invalid_source', 'and reports as INVALID, not as an unconfirmed change');
    assert.strictEqual(h.state.publishes.length, 0, 'and nothing is published');
    // even with a correct acknowledgement of the flagged zero, it stays unpublishable
    const withAck = await publishEditedCore(h.deps, {
      restaurantId: 'la_musa', token: h.tokenFor().token, acknowledgedChanges: ackFor(h.tokenFor().diff),
    }, {});
    assert.strictEqual(withAck.body.error, 'invalid_source', 'an acknowledgement cannot make an invalid price publishable');
    assert.strictEqual(h.state.publishes.length, 0, 'still nothing published');
    ok('an invalid draft reports as invalid and cannot be acknowledged past — validation precedes the derived gates');
  }

  // ── (9) THE WRAPPER. index.js cannot be imported here, so its plumbing is asserted structurally.
  //        A handler that is never exported, or wired to a permissive stub, passes every test above.
  {
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    for (const [id, mod] of [['publishEditedCore', 'catalog\\/publish-edited-handler'], ['publishVersion: publishVersionForEdit', 'catalog\\/catalog-publish'], ['sourceRefOf: sourceRefOfForEdit', 'catalog\\/source-store']]) {
      assert.ok(new RegExp(`\\{[^}]*${id.replace(/[:\s]/g, '\\s*[:\\s]?\\s*')}[^}]*\\}\\s*=\\s*require\\('\\./${mod}'\\)`).test(CODE), `index.js must import ${id}`);
    }
    assert.ok(/exports\.publishEdited = onRequest\(/.test(CODE), 'publishEdited must actually be exported');
    assert.ok(/await publishEditedCore\(\{/.test(CODE), 'and delegate to the TESTED core');
    assert.ok(/authorizeCatalogEdit\(\{ db: getDatabase\(\), verifyIdToken: \(t\) => getAuth\(\)\.verifyIdToken\(t\) \}, req, rid\)/.test(CODE),
      'wired to the REAL verifier and membership db, not a stub');
    // the REAL publisher, so verify-before-flip actually governs in production
    assert.ok(/publishVersion: publishVersionForEdit/.test(CODE), 'wired to the REAL publishVersion (verify-before-flip + atomic flip)');
    assert.ok(/mirror: makeRtdbMirrorForEdit\(getDatabase\(\)\)/.test(CODE), 'and to the REAL RTDB mirror, so a portal publish feeds the disaster fallback like any other');
    // the draft's updateTime must come from the SNAPSHOT, or the token binds to something invented
    const draftFn = CODE.slice(CODE.indexOf('async function readDraftForEdit'), CODE.indexOf('exports.publishEdited'));
    assert.ok(/snap\.updateTime/.test(draftFn), 'the bound updateTime must come from the document snapshot');
    assert.ok(/if \(!snap\.exists\) return \{ source: null/.test(draftFn), 'and an absent draft must surface as absent, not as an empty object');
    ok('the index.js wrapper is exported, delegates to the tested core, and injects the real verifier, publisher and mirror');
  }

  console.log(`publish-edited: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
