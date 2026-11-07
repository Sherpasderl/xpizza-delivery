'use strict';
// ORCHESTRATION O1b T1b (PLAN-orch-o1b r3 §3 T1b, Codex r1 #3) — owner-brand discovery independent of locations, and the DRAFT
// binding: a draft is real only when its node names the brand AND the brand's op-id mapping for the draft's op points back to
// this rid. Drafts are OWNER-only (brand.locations); no location capability ever applies to a draft.
// Run: node branches/drafts.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const M = require('../access/membership');
const D = require('./drafts');
const S = require('./branch-store');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('drafts: FAILED — exited without completing'); process.exitCode = 1; } });

const g = { granted_at: 1, granted_by: 'x' };
const H7 = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '09:00', end: '18:00' }]));
const draft = (brand, opId, name, over = {}) => ({ brand_id: brand, location_name: name, phone: '+50431234567', hours: H7, prep_default_min: 20, created_at: 1, created_by: 'ownerB2', op_id: opId, inc: 'c1', ...over });
const NOW = 1_800_000_000_000;
// tb2: a brand whose ONLY branch is a draft (created by the O1a writer) — plus a forged draft and a draft whose mapping points away
function world() {
  return createFakeDb({
    brands: {
      tb: { name: 'TB', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 1 } },
      tb2: { name: 'TB Dos', active: true, locations: { tb2_sur: 'staged' }, activation: { state: 'off', since: 1 }, projection_gen: 1 },
    },
    restaurants: {
      tb_centro: { identity: { brand_id: 'tb', location_name: 'Centro' } },
      tb2_sur: { identity: { brand_id: 'tb2', location_name: 'Sur' } },
      tb2_norte: { draft: draft('tb2', 'op_norte', 'Norte') },
      tb2_forged: { draft: draft('tb2', 'op_none', 'Forged') },              // no mapping at all
      tb2_away: { draft: draft('tb2', 'op_away', 'Away') },                  // its mapping names another rid
      tb_plaza: { draft: draft('tb', 'op_plaza', 'Plaza') },                 // brand tb's draft
    },
    branch_op_ids: {
      tb2: { op_norte: { payload_hash: 'h', inc: 'c1', candidate: 'tb2_norte', rid: 'tb2_norte' }, op_away: { payload_hash: 'h', inc: 'c1', rid: 'tb2_elsewhere' } },
      tb: { op_plaza: { payload_hash: 'h', inc: 'c1', rid: 'tb_plaza' } },
    },
    brand_members: { tb: { owners: { ownerTB: g }, managers: { tb_centro: { mgrCen: g } } }, tb2: { owners: { ownerB2: g }, managers: { tb2_sur: { mgrSur: g } } } },
    member_of: {
      ownerTB: { brands: { tb: 'owner' } },
      ownerB2: { brands: { tb2: 'owner' } },
      staleOwn: { brands: { tb2: 'owner' } },                                // index entry, NO forward grant
      mgrSur: { locations: { tb2_sur: 'manager' } },
      junkyy: { brands: { 'Bad-Id': 'owner', tb: 'admin' } },
    },
  });
}
const ctx = (uid, token = {}) => ({ uid, token });

(async () => {
  // ── 1. owner-brand discovery: forward-grant verified, independent of locations ──
  {
    const db = world();
    assert.deepStrictEqual(await M.myOwnerBrands({ db }, ctx('ownerB2')), [{ brand_id: 'tb2', activation: 'off' }], 'OWNER-BRANDS lists the brand');
    const stale = []; assert.deepStrictEqual(await M.myOwnerBrands({ db, onStale: (x) => stale.push(x.kind) }, ctx('staleOwn')), [], 'a stale index entry (no forward grant) → not listed');
    assert.deepStrictEqual(stale, ['stale_owner']);
    assert.deepStrictEqual(await M.myOwnerBrands({ db }, ctx('mgrSur')), [], 'a manager owns no brand');
    const junk = []; assert.deepStrictEqual(await M.myOwnerBrands({ db, onStale: (x) => junk.push(x.kind) }, ctx('junkyy')), []);
    assert.deepStrictEqual(junk.sort(), ['malformed_brand_entry', 'malformed_brand_entry']);
    await assert.rejects(M.myOwnerBrands({ db }, ctx('ownerB2', { customer: true })), /forbidden/, 'a customer token');
    const down = world(); down.failReads.add('member_of');
    await assert.rejects(M.myOwnerBrands({ db: down }, ctx('ownerB2')), /injected read failure/, 'a read failure THROWS (an outage, never an empty answer)');
    // a brand whose only branch is a draft (no listed location at all is not a valid brand; the draft's brand IS listed here)
    ok('myOwnerBrands: forward-grant verified, location-independent; stale / malformed entries dropped; a read failure throws');
  }

  // ── 2. the draft binding ──
  {
    const db = world();
    assert.deepStrictEqual((await D.draftBinding(db, 'tb2', 'tb2_norte')).ok, true, 'DRAFT-BOUND a real draft');
    for (const [rid, why] of [['tb2_forged', 'no mapping'], ['tb2_away', 'mapping names another rid'], ['tb_plaza', 'another brand\'s draft'], ['tb2_sur', 'an identity, not a draft'], ['tb2_none', 'absent']]) {
      assert.deepStrictEqual(await D.draftBinding(db, 'tb2', rid), { ok: false }, `DRAFT-UNBOUND ${why}`);
    }
    assert.deepStrictEqual((await D.draftsOfBrand(db, 'tb2')).map((x) => x.rid), ['tb2_norte'], 'DRAFTS-LISTED only the bound draft');
    assert.deepStrictEqual((await D.draftsOfBrand(db, 'tb')).map((x) => x.rid), ['tb_plaza']);
    ok('draftBinding / draftsOfBrand: a draft counts only when it names the brand AND the brand\'s op-id mapping points back to it');
  }

  // ── 3. drafts are owner-only; no location capability applies to a draft ──
  {
    const db = world();
    const loc = await M.resolveAccess({ db }, ctx('ownerB2'), 'tb2_norte');
    assert.deepStrictEqual([loc.state, loc.caps], ['unknown', []], 'DRAFT-NO-LOCATION-CAPS: a draft rid resolves to no location state, no caps');
    assert.strictEqual((await M.resolveBrandAccess({ db }, ctx('ownerB2'), 'tb2')).ok, true, 'its brand owner holds brand.locations');
    assert.strictEqual((await M.resolveBrandAccess({ db }, ctx('mgrSur'), 'tb2')).ok, false, 'a manager of a sibling branch does not');
    assert.strictEqual((await M.resolveBrandAccess({ db }, ctx('ownerTB'), 'tb2')).ok, false, 'an owner of another brand does not');
    ok('drafts are owner-only: no location caps on a draft rid; brand.locations only for its brand\'s owner');
  }

  // ── 4. the delete re-binds under the brand lock ──
  {
    const db = world();
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb2_away', brandId: 'tb2', now: NOW, clock: () => NOW, bind: true }), { ok: false, error: 'not_a_draft' }, 'DELETE-REBIND a draft whose mapping points away');
    assert.ok(db.get('restaurants/tb2_away/draft'), 'nothing removed');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb2_forged', brandId: 'tb2', now: NOW + 1, clock: () => NOW + 1, bind: true }), { ok: false, error: 'not_a_draft' }, 'a forged draft (no mapping)');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_plaza', brandId: 'tb2', now: NOW + 2, clock: () => NOW + 2, bind: true }), { ok: false, error: 'not_a_draft' }, 'another brand\'s draft');
    // the Sherpa CLI path (no bind) keeps O1a's behaviour: an orphan draft (no mapping — what `check` reports) is still removable
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb2_forged', brandId: 'tb2', now: NOW + 3, clock: () => NOW + 3 }), { ok: true }, 'CLI-ORPHAN-DELETABLE');
    assert.strictEqual(db.get('restaurants/tb2_forged'), null);
    ok('a PORTAL delete (bind) re-binds under the lock: a draft whose op-id mapping does not point back to it is not_a_draft, nothing removed; the CLI (no bind) still removes an orphan');
  }

  // ── Codex build r1 #7: an ALIAS mapping pointing at a valid draft → no duplicate row, reported ──
  {
    const db = world();
    db.put('branch_op_ids/tb2/op_alias', { payload_hash: 'h2', inc: 'c9', rid: 'tb2_norte' });
    const skips = [];
    const rows = await D.draftsOfBrand(db, 'tb2', { onSkip: (x) => skips.push(x) });
    assert.deepStrictEqual(rows.map((x) => x.rid), ['tb2_norte'], 'DRAFTS-NO-ALIAS-DUP one row');
    assert.deepStrictEqual(skips, [{ kind: 'alias_mapping', op_id: 'op_alias', rid: 'tb2_norte' }], 'the alias is reported');
    ok('draftsOfBrand iterates the mapping ENTRIES: a stale alias mapping is skipped and reported, never a duplicate row');
  }

  FINISHED = true;
  console.log(`\ndrafts: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
