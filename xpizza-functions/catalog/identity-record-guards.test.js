'use strict';
// Portal 1D · D4-c1 — the SHIP CONTRACT, structurally (PLAN-D4c1 rev 7 §6). Goldens are computed from
// `git show 2745be5:<file>` (the base this slice was cut from), NEVER from this tree.
//
//   • index.js       = base + EXACTLY two additive blocks (the identity lazy-inits; the three new exports). Every existing
//                      handler — every order-path handler, writeCatalogContextOnMirror, reconcileCatalogContexts — is
//                      byte-identical because the whole file minus those two blocks is byte-identical.
//   • catalog-context.js = base + EXACTLY the §5 zero-kind hunk.
//   • NEW zero-diff pins: pricing-tables.js, identity-bootstrap.js, every order-path module in codex c1 r7's reader census,
//     the D4-a context modules, the publish/migration/backfill tools. (The D4-a pins in context-guards.test.js — incl. the
//     publisher pin on catalog-publish.js — stay UNCHANGED and run in the same chain.)
//   • The new modules write ONLY catalog_ctx/{rid}/{versionId} (one transaction) and their own cursors (CAS); brand-free;
//     bounded; nothing on the order / price path imports them.
const assert = require('assert');
const crypto = require('crypto');
const fsys = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const read = (f) => fsys.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

try {
  // ── index.js = base + exactly two additive blocks ─────────────────────────────────────────────────────────────
  {
    const BASE_INDEX = '86bd2aab1370089551d9fe488c5ceb7e47866812f8453d949bd8c65005173604';   // 2745be5:xpizza-functions/index.js
    const idx = read('index.js');
    const cut = (s, startMarker, endMarker) => {
      const a = s.indexOf(startMarker); const b = s.indexOf(endMarker, a);
      assert.ok(a > 0 && b > a, `markers present: ${startMarker.slice(0, 40)}`);
      assert.strictEqual(s.indexOf(startMarker, a + 1), -1, 'each block occurs once');
      return s.slice(0, a) + s.slice(b);
    };
    let base = cut(idx, '// 1D D4-c1 — content-addressed identity records', '\n// Never throws AND never returns null');
    base = base.replace('}\n\n// Never throws AND never returns null', '}\n\n// Never throws AND never returns null');
    base = cut(base, '// 1D D4-c1 — a NEW, separate identity-only trigger', 'exports.sweepStalePending = onSchedule(');
    assert.strictEqual(sha(base), BASE_INDEX, '🔴 index.js changed OUTSIDE the two additive D4-c1 blocks');
    // sensitivity: a one-character change anywhere else is detected
    assert.notStrictEqual(sha(base.replace('exports.createOrder', 'exports.createOrdeR')), BASE_INDEX);
    for (const fn of ['writeIdentityRecordOnMirror', 'reconcileIdentityRecords', 'verifyIdentityRecords']) assert.ok(idx.includes(`exports.${fn} =`), fn);
  }
  ok('index.js = base 2745be5 + EXACTLY two additive blocks (identity lazy-inits; the 3 new exports): every existing handler — createOrder, charge, quotes, writeCatalogContextOnMirror, reconcileCatalogContexts, … — is byte-identical; a one-character change elsewhere is detected');

  // ── catalog-context.js = base + exactly the §5 hunk ───────────────────────────────────────────────────────────
  {
    const BASE_CTX = 'f2b83369fc75dad56bffa0bf3dc0a6489faf30437bd050a1562ae756fda25260';
    const now = read('catalog/catalog-context.js');
    const newHunk = now.slice(now.indexOf('    // (c) — the completeness half of usable-as-identity.'), now.indexOf("      && ids.wellFormed && ids.unique && labels.state === 'complete';"));
    const oldHunk = "    // (c) — the completeness half of usable-as-identity.\n    const complete = certified && coverage.dish.state === 'full' && coverage.extra.state === 'full'\n";
    assert.strictEqual(sha(now.replace(newHunk, oldHunk)), BASE_CTX, '🔴 catalog-context.js changed beyond the zero-kind predicate');
    assert.ok(/const kindComplete = \(c\) => c\.total === 0 \|\| c\.state === 'full';/.test(now));
  }
  ok('catalog-context.js = base + EXACTLY the §5 hunk (`kindComplete = total === 0 || state === "full"` per kind); coverage reporting, certification, ids, labels and integrity are byte-unchanged');

  // ── NEW zero-diff pins ───────────────────────────────────────────────────────────────────────────────────────
  {
    const PINS = {
      'catalog/pricing-tables.js': '6dcb412766a3fb1c401edbf9ef773489304c8912ef6b19a116c97d65c73cecb3',
      'catalog/identity-bootstrap.js': '7768d507029284abe810361e09b09029d2d05bb5308863b86a71263bf8ffe860',
      'menu-pricing.js': 'da097212d15c95553d5c71d12e0e04f6c7756b32ab58ccbe74840eecf76d7b55',
      'rewards-redeem.js': '45452f8b2587345fabaf48f6ef312d414ae4bd743e662f8e6e025820e10b6e43',
      'rewards-redeem-config.js': 'fc8b513041899a3a067f5912e59ddd583d19151afe344224e03cd079abdc5961',
      'rewards-redeem-pricing.js': 'f870fc0d86420cad7d17afce50184dd3a7963676be0269732422fc91d8fb9e9c',
      'reorder-normalize.js': '069f43efaaf2e3cf3218fb4b7d3b92b3e92d725cf6d83f6d16f841cb986dae36',
      'create-order-build.js': 'b767f06f0cebd56fb0c88b8bf9fa03e13f5fad06d10050e79affd5b67758d5a7',
      'rewards-redeem-intake.js': '5afd5198f502178c59e55de1c1264849503299e0870af630b425db05ed8e6a48',
      'createorder-classify.js': '9f9e0d7e4261f8e0cb1320b3568a6ab67a2e49334218651c9161524df2cd6f5e',
      'quote-issue.js': '864fe3648e939c94574285c98ac4c28152c028ba886e069e95908db4aae43b3b',
      'compute-server-net.js': '34da15123209f4ee3cb785f50cfd2a69b6b5b5c95dec07955eddf941f8f3a846',
      'token-gate.js': 'c5f06c2fd7eb38cb17ab36e4157f826c96bc01bb3238a66cc47310b94fd852d3',
      'catalog/context-writer.js': '9ab5bda964e12d8765d6a671aff91cf5936240e4720f8125d1119e8e8d260fe5',
      'catalog/context-source.js': '04276ab1c11172cd8b9d8f0ffe85b2b3d4660838844e58a00a864b2f846a2efc',
      'catalog/context-fk.js': '54d8dcaf9f414f495fb549973fed22b5b921847dd71ead0f26922529c5eb9c11',
    };
    /* 1D D4-c2a (PLAN-D4c2a rev 9 §6 guards): identity-bootstrap.js = this pin + EXACTLY the c2a blocks between the unique
       delimiters; removing them reproduces the pinned sha byte for byte. Every other pin stays whole. */
    const C2A = /[ \t]*\/\* c2a-evidence:begin \*\/[\s\S]*?\/\* c2a-evidence:end \*\/\n?/g;
    const C2A_BLOCKS = { 'catalog/identity-bootstrap.js': 3 };
    const baseOf = (f) => {
      const src = read(f);
      if (!C2A_BLOCKS[f]) return src;
      const begins = (src.match(/\/\* c2a-evidence:begin \*\//g) || []).length;
      assert.strictEqual(begins, C2A_BLOCKS[f], `🔴 ${f}: expected exactly ${C2A_BLOCKS[f]} c2a blocks, found ${begins}`);
      assert.strictEqual((src.match(/\/\* c2a-evidence:end \*\//g) || []).length, begins, `🔴 ${f}: unbalanced c2a delimiters`);
      return src.replace(C2A, '');
    };
    for (const [f, want] of Object.entries(PINS)) assert.strictEqual(sha(baseOf(f)), want, `🔴 ${f} changed — D4-c1 must not modify it (c2a may only ADD delimited blocks to identity-bootstrap.js)`);
    assert.notStrictEqual(sha(`${read('catalog/pricing-tables.js')} `), PINS['catalog/pricing-tables.js'], 'sensitivity');
    {
      const boot = read('catalog/identity-bootstrap.js');
      const planted = boot.replace('async function reconcileLegacyOrphans(', 'async function reconcileLegacyOrphanS(');
      assert.notStrictEqual(planted, boot, 'sensitivity premise');
      assert.notStrictEqual(sha(planted.replace(C2A, '')), PINS['catalog/identity-bootstrap.js'], 'sensitivity: a one-byte change OUTSIDE the c2a blocks is detected');
      assert.notStrictEqual(boot.replace(C2A, ''), boot, 'non-vacuity: the c2a blocks are present and removed');
    }
  }
  ok('NEW zero-diff pins (vs 2745be5): pricing-tables.js, identity-bootstrap.js (= pin + exactly the 3 delimited c2a blocks), the order-path modules of codex r7\'s census (menu-pricing, rewards-redeem[-config|-pricing|-intake], reorder-normalize, create-order-build, createorder-classify, quote-issue, compute-server-net, token-gate) and the D4-a context modules (context-writer/-source/-fk) are byte-identical');

  // ── The new modules: what they write, and nothing else ───────────────────────────────────────────────────────
  const NEW = ['catalog/identity-record.js', 'catalog/identity-record-writer.js', 'catalog/identity-record-verifier.js'];
  const code = Object.fromEntries(NEW.map((f) => [f, strip(read(f))]));
  {
    const writes = /\b(tx|batch|b|vref|ref|docRef|snapRef|db|rtdb|fs|cref|rref)\.(set|update|delete|create|push|remove)\(|\.(ref|child|doc)\([^)]*\)\.(set|update|delete|create|push|remove)\(|\.batch\(\)/;
    for (const [f, src] of Object.entries(code)) assert.ok(!writes.test(src), `🔴 ${f} performs a datastore write other than its transactions`);
    for (const w of ["rtdb.ref('x').set({})", 'cref.remove()', 'tx.update(vref, {})', 'db.batch()']) assert.ok(writes.test(w), `sensitivity: ${w}`);
    assert.strictEqual((code['catalog/identity-record.js'].match(/\.transaction\(/g) || []).length, 0, 'the pure core does no I/O');
    const wr = code['catalog/identity-record-writer.js'];
    assert.strictEqual((wr.match(/\.transaction\(/g) || []).length, 2, 'the writer: ONE node transaction + ONE cursor CAS transaction');
    // the node transaction runs on the write's GATED rtdb handle (codex c1 build r4: no I/O starts past the deadline)
    assert.ok(/const grtdb = gateIo\(rtdb, g, 'write'\);/.test(wr), 'the write\'s rtdb handle is the gated one');
    assert.ok(/nodeRefOf\(grtdb, rid, versionId\)\.transaction\(/.test(wr) && /const nodeRefOf = \(rtdb, rid, versionId\) => rtdb\.ref\(`\$\{IDENTITY_PATH\}\/\$\{rid\}\/\$\{versionId\}`\)/.test(wr));
    assert.ok(/IDENTITY_PATH = 'catalog_ctx'/.test(code['catalog/identity-record.js']));
    // codex c1 build r5 (d) — a REGRESSION TRIPWIRE for raw handles by closure (a textual heuristic, NOT binding-aware
    // closure analysis; codex r6): in the writer and verifier, every bare `db` / `rtdb` must match one of the audited
    // contexts below — a parameter definition, the first argument of gateIo(), an argument to a function that REQUIRES a
    // gate and wraps at once (readVersionSnapshot / loadVersionNode / d4aProjection), a builder taking an already-gated
    // handle, or versionPage's own body (scoped to that function, after its requireGated). A new raw use such as
    // `rtdb.ref(…).get()` trips it; the runtime guarantee is the gate plus the below-gate instrument, not this scan.
    const ALLOWED = [
      /\bgateIo\((db|rtdb),/g, /\b(db|rtdb): gateIo\(/g, /\b(readVersionSnapshot|loadVersionNode|d4aProjection)\((db|rtdb),/g,
      /= \((db|rtdb), rid, versionId\) => (db|rtdb)\./g,
      /\basync function versionPage\(db, rid, position, limit\) \{\s*requireGated\(db, 'versionPage'\);\s*let q = db\.collection\(/g,   // scoped to versionPage
      /\{ db, rtdb, now/g, /^\s*db, rtdb, now = Date\.now,/gm, /GATED io handles \{ db, rtdb \}/g,
    ];
    const bareLeft = (src) => { let t = src; for (const re of ALLOWED) t = t.replace(re, ''); return (t.match(/(^|[^.\w$])(db|rtdb)\b(?!\s*:)/gm) || []).length; };
    for (const f of ['catalog/identity-record-writer.js', 'catalog/identity-record-verifier.js']) assert.strictEqual(bareLeft(code[f]), 0, `🔴 ${f}: a raw db / rtdb handle is used outside the gate`);
    for (const planted of ["const s = await rtdb.ref('x').get();", 'return readVersionDocs(db, rid, v);', 'const q = db.collection("x");', 'let q = db.collection("x");']) assert.ok(bareLeft(planted) > 0, `sensitivity: ${planted}`);
    assert.strictEqual((code['catalog/identity-record-verifier.js'].match(/\.transaction\(/g) || []).length, 0, 'the verifier writes only through casCursor');
    for (const [f, src] of Object.entries(code)) {
      assert.ok(!/catalog_snapshot_ctx|CONTEXT_PATH|active_snapshot|makeRtdbMirror\(|publishVersion|rollbackVersion|bootstrapIdentityStamps|flipPointer/.test(src), `🔴 ${f} references a D4-a / publish artifact`);
      // catalog_snapshot is READ (the mirror rung), never written
      for (const m of src.matchAll(/catalog_snapshot\/\$\{rid\}[^`]*`\)\.(\w+)\(/g)) assert.strictEqual(m[1], 'get', `${f}: catalog_snapshot is only read`);
    }
    // Firestore: read-only transactions only
    for (const [f, src] of Object.entries(code)) for (const m of src.matchAll(/runTransaction\([\s\S]*?\}, \{ readOnly: true \}\)/g)) assert.ok(m[0]);
    assert.strictEqual((code['catalog/identity-record-writer.js'].match(/runTransaction\(/g) || []).length, 1);
    assert.ok(/\}, \{ readOnly: true \}\);/.test(code['catalog/identity-record-writer.js']), 'the one Firestore transaction is read-only');
  }
  ok('the new modules write ONLY catalog_ctx/{rid}/{versionId} (one transaction) and their own cursors (one CAS); the pure core does no I/O; catalog_snapshot is only READ; no reference to catalog_snapshot_ctx, active_snapshot, makeRtdbMirror, publish/rollback/bootstrap/flip; the one Firestore transaction is read-only');

  // ── brand-free + bounded + not on the request path ──────────────────────────────────────────────────────────
  {
    for (const [f, src] of Object.entries(code)) {
      assert.ok(!/x_pizza|la_musa|xpizza|lamusa/i.test(src), `🔴 ${f} names a restaurant`);
      assert.ok(!/(restaurantId|rid)\s*[!=]==?\s*['"`]/.test(src), `🔴 ${f} branches on a restaurant id literal`);
    }
    const idx = read('index.js');
    const block = idx.slice(idx.indexOf('exports.writeIdentityRecordOnMirror'), idx.indexOf('exports.sweepStalePending'));
    assert.ok(!/x_pizza|la_musa/.test(block) && (block.match(/makeFirestoreRegistryReader\(getFirestore\(\)\)/g) || []).length === 2, 'both schedules enumerate the Firestore registry');
    assert.ok(!/retry:\s*true/.test(block), 'no platform retry');
    assert.ok(/writeIdentityRecordOnMirror = onValueWritten\(\s*\{ ref: '\/catalog_snapshot\/\{rid\}'[^}]*maxInstances: \d+/.test(block), 'a separate trigger on the mirror path, instance-capped');
    assert.ok(/reconcileIdentityRecords = onSchedule\(\s*\{[^}]*maxInstances: 1/.test(block) && /verifyIdentityRecords = onSchedule\(\s*\{[^}]*maxInstances: 1/.test(block));
    const Wm = require('./identity-record-writer');
    const Vm = require('./identity-record-verifier');
    const Rm = require('./identity-record');
    assert.ok(Wm.IDENTITY_TRIGGER_DEADLINE_MS === 45000 && Wm.IDENTITY_TRIGGER_DEADLINE_MS < Wm.IDENTITY_TRIGGER_TIMEOUT_S * 1000, 'trigger: 45 s deadline < 60 s timeout');
    assert.ok(Wm.IDENTITY_RECONCILE_INTERVAL === 'every 30 minutes' && Wm.IDENTITY_RECONCILE_TIMEOUT_S === 300 && Wm.IDENTITY_RECONCILE_TIMEOUT_S * 1000 < Wm.IDENTITY_RECONCILE_INTERVAL_MS);
    assert.ok(Wm.IDENTITY_RUN_BUDGET_MS === 240000 && Wm.IDENTITY_RUN_BUDGET_MS < Wm.IDENTITY_RECONCILE_TIMEOUT_S * 1000, 'run budget 240 s < the function timeout');
    assert.deepStrictEqual([Wm.IDENTITY_RESTAURANT_BUDGET_MS, Wm.IDENTITY_RUNG_DEADLINE_MS, Wm.IDENTITY_PAGE_SIZE, Wm.IDENTITY_PAGE_CONCURRENCY], [60000, 30000, 25, 2], 'the plan\'s per-restaurant / rung / page / concurrency bounds');
    assert.ok(Vm.IDENTITY_VERIFY_INTERVAL === 'every 30 minutes' && Vm.IDENTITY_LOAD_TIMEOUT_MS === 1500 && Vm.IDENTITY_VERIFY_TIMEOUT_S * 1000 < 30 * 60 * 1000);
    assert.deepStrictEqual([Rm.MAX_RECORDS, Rm.NODE_CAP_BYTES], [8, 8 * Rm.RECORD_BOUND_BYTES + 4096]);
    // TOTAL schedule bound (codex build r1 B2): listing + restaurant-cursor read + run budget + last-restaurant slack + final CAS
    const total = Wm.IDENTITY_LIST_DEADLINE_MS + Wm.CURSOR_OP_DEADLINE_MS + Wm.IDENTITY_RUN_BUDGET_MS + 50 + Wm.CURSOR_OP_DEADLINE_MS;
    assert.ok(total < Wm.IDENTITY_RECONCILE_TIMEOUT_S * 1000 && total < Vm.IDENTITY_VERIFY_TIMEOUT_S * 1000, `both schedules' total bound ${total} ms < their 300 s function timeout`);
    // checkpoint reserve (codex build r2 B1): inside the restaurant budget (never adds to the total), work gets the rest
    const wd = Wm.workDeadline(Wm.makeDeadline(Wm.IDENTITY_RESTAURANT_BUDGET_MS), Wm.CURSOR_OP_DEADLINE_MS);
    assert.ok(wd.reserve === Wm.CURSOR_OP_DEADLINE_MS && wd.remaining() <= Wm.IDENTITY_RESTAURANT_BUDGET_MS - wd.reserve && wd.remaining() > 0, 'reserve = one cursor-op deadline (5 s) inside the 60 s restaurant budget');
    assert.strictEqual(Wm.workDeadline(Wm.makeDeadline(100), 5000).reserve, 50, 'a small budget: the reserve is at most half, so work still happens');
    // own resources: the D4-a invokers' options are unchanged (index.js pin above) and the new ones are separate exports
    assert.ok(!/contextWriter\(\)/.test(block), 'the new functions never call the D4-a writer');
    // NOT on the request path: only index.js's lazy inits and the three modules import them
    const walk = (dir) => fsys.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? []
      : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(c?js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const importers = walk(ROOT).filter((f) => !/\.test\.|test\//.test(path.relative(ROOT, f)))
      .filter((f) => /require\(['"][./]*(catalog\/)?identity-record(-writer|-verifier)?['"]\)/.test(fsys.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f)).sort();
    assert.deepStrictEqual(importers, ['catalog/identity-record-verifier.js', 'catalog/identity-record-writer.js', 'index.js'], '🔴 only the background invokers import the identity modules');
    const idxCode = strip(idx);
    for (const [call, want] of [['identityWriter().', 2], ['identityVerifier().', 1]]) {
      const all = idxCode.split(call).length - 1;
      const inBlock = strip(block).split(call).length - 1;
      assert.deepStrictEqual([all, inBlock], [want, want], `${call} is called ONLY from the new exports`);
    }
  }
  ok('brand-free (no restaurant literal / rid branch in the new modules or invokers); both schedules enumerate the Firestore registry; no platform retry; instance-capped; bounds = the plan\'s (trigger 45 s < 60 s, 30-min schedules with 300 s timeouts, 240 s run, 60 s/restaurant, 30 s rungs, page 25, concurrency 2, 1,500 ms load, ≤ 8 records, node cap 8 × bound + 4 KB); only index.js\'s new exports reach the identity modules — nothing on the order / price path');

  console.log(`identity-record-guards: OK (${n})`);
} catch (e) {
  console.error('identity-record-guards FAILED:', e);
  process.exit(1);
}
