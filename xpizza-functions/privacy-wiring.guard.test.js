'use strict';
// fix/privacy-gaps-5f — the privacy layer's own pin: every owned file (index.js + whatsapp.js log lines, signup-endpoints.js deletion fence,
// payments/sdk/cards.js vault fence check) minus the privacy hunks === BASE:<file> byte-for-byte; the layer is non-vacuous, detects a
// tampered or duplicated hunk, passes other files through; and every reader that peels ledgers1 peels the privacy layer FIRST, directly
// on its raw source (the newest layer: generated against main = asm11). The behaviour itself is pinned by tools/pii-log.guard and
// deletion-tombstone D1–D5. Run: node privacy-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyPrivacyModule } = require('./tools/privacy-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'PRIVACY: non-vacuity — the layer owns files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `PRIVACY: non-vacuity — ${F} carries the privacy hunks`);
  assert.strictEqual(unapplyPrivacyModule(F, disk), base, `PRIVACY: 🔴 ${F} minus the privacy hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyPrivacyModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `PRIVACY: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyPrivacyModule(F, disk + h.now), /occurs 2 times/, `PRIVACY: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyPrivacyModule('tb-unowned.js', 'x\n'), 'x\n', 'PRIVACY: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} privacy hunks === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  // Codex #133 r1 (5): the inverse is GENERATED, so a regeneration that carried a real code change along (e.g. `data.sent = true;`)
  // would keep both this pin and DRVC green. Two locks: (a) the APPROVED MANIFEST — the base, the owned files and the sha256 of every
  // hunk — is pinned HERE, so any regeneration is a visible edit of this guard; (b) a CONTENT rule — every line a hunk adds or removes is
  // a comment, a PURE console.* statement (tools/log-stmt: AST, no side-effecting argument), or one of the enumerated NON-LOG lines below,
  // each pinned by its exact text (the deletion fence key, the vault fence check, and three log-helper consts). Control: a planted
  // non-log line, or a log call with a side-effecting argument, in a regenerated hunk is RED.
  const crypto = require('crypto');
  const { isPureLogStatement } = require('./tools/log-stmt');
  const MANIFEST = Object.freeze({
    base: '31f05c8a40c35fe0c442be8839593954c3afc8b1',
    files: ['index.js', 'whatsapp.js', 'signup-endpoints.js', 'payments/sdk/cards.js'],
    hunks: [
  '61b7262179326cb0ffd9d71ce5a3bae98033e4e8850a7a73f2fc811d29e00e19',   // index.js
  '2bd5919d9f225529d1bcbb988df84ad1787152736de822cba8ed97cbdbdd6d7d',   // index.js
  '35342ddcdf654a09d59635f096a91f5843f2f9195ea4b35ba09cb78b1dc57a51',   // index.js
  '8ff83710256698c494bc4d8dc310ec929045fd17b25d10cf6a119387a42da640',   // index.js
  '3b3e9da8e207a704cf00591b56212b42e760668f12c97766091aec0a7c9b9909',   // index.js
  '5527c713f76dbf55c89671fca994d78d43343772aa2c78ce1e13049dc84f8b5b',   // index.js
  'b51f00a7ce14c6dc0f78ee8329a84acfe5e379b491093129efffa62e75e513b4',   // index.js
  '50ad63f77c92fcdec586d86a9269a802a62c2395c1b1b729637bc87234ed759a',   // index.js
  'cfb5ed63b652a824ea9e98e273d01356de0657300d24719e214ae5616fe17ce0',   // index.js
  '040360fca7b812c657e8e5b368722cdba56cefad78eacc40625ca3df0643db75',   // index.js
  '53b64e10c586919795787d033eb3e7d153947fa28ef6d29ea3375fac2bfd5908',   // index.js
  '8344d5ce2426ed38eb37092cbd60cd23aa8554e1d2563dc94109ee679972212e',   // index.js
  '23d9fc6add0a10f62a9212241ce4886ddaaf8b69959b72f6d6849599f5921bcd',   // index.js
  '8a9b9b860c39a8d0482ee445c16d2b3ad0cf6148b6aabfb5563079cdba89d126',   // index.js
  '30e266459a6f409f79b09d231339c4af6fffe602317849beb37f563899527ed6',   // index.js
  'cae7c8f2f8386d6ca0dcde41c29f84db61cb15856a0ffea123df1ae629d56e71',   // index.js
  'a22666b22b3df679e491660f7caecc803e29f2f1ce461fbed1cf779c538bd63e',   // index.js
  'f8c91205cab5cf9d56735d166d7ea1976242f07dfea4d0a9dd3d26de3cd39f95',   // whatsapp.js
  '8746d49c4cf602528b716ca22554105f8527b07ecc4e0d4e7f5e88bba86ed1a5',   // whatsapp.js
  'b572897d42f5b856b558937b197c773016c8d1d4ea8ffa6b2b0c8f416a2d2cd7',   // whatsapp.js
  'e0dfcb9656ca27a383d0e459fed46a7115b4fb1d1fd6936fa83b64f44d32992a',   // whatsapp.js
  'da325ed91ddc343f305d4c5685ea8c6bdc75cbef0727721834783f5b48f50e10',   // signup-endpoints.js
  'c8eb1883e14e93c3d36f649da87fee578269a29d1b1a7d64e90b92bfacd5c6cd',   // signup-endpoints.js
  'a38163cb885c336bda75f3caec54a192918fa2dfff862d5a49225f0003335848',   // payments/sdk/cards.js
  '3f3e6520f798f53379963cfcd93ad0c0299eab3c36f42c256009a5254ce1c327',   // payments/sdk/cards.js
    ],
  });
  const NON_LOG = [
  ["index.js", "now", "    const why = email ? 'not a staff email' : 'no email';   // rule 20: never the address itself"],
  ["whatsapp.js", "now", "    const digits = cleaned.length;   // rule 20: never the number itself"],
  ["whatsapp.js", "now", "      const code = data && data.error ? 'provider_error' : 'http_error';   // rule 20: never the number or the provider's raw response"],
  ["signup-endpoints.js", "now", "  await db.ref().update({ ...ACCOUNT.accountDeleteUpdates(uid, null, at, { fenceAt: at }), [`user_private/${uid}`]: { deleted_at: at }, [`user_favorites/${uid}`]: { _deleted: at }, [`customer_cards/${uid}`]: { _deleted: at }, [`ratings_redact_pending/${uid}/at`]: now, ...audienceIdsGone });   // r4: `at` only — a fence's version v is never clobbered"],
  ["signup-endpoints.js", "was", "  await db.ref().update({ ...ACCOUNT.accountDeleteUpdates(uid, null, at, { fenceAt: at }), [`user_private/${uid}`]: { deleted_at: at }, [`user_favorites/${uid}`]: { _deleted: at }, [`ratings_redact_pending/${uid}/at`]: now, ...audienceIdsGone });   // r4: `at` only — a fence's version v is never clobbered"],
  ["payments/sdk/cards.js", "now", "    if (isObj(cur) && cur._deleted !== undefined) { outcome = 'dropped'; return undefined; }   // the account-deletion fence (signup-endpoints deleteAccountCore): never a card after deletion"],
  ];
  const shaOf = (h) => crypto.createHash('sha256').update(`${h.file}\0${h.now}\0${h.was}`).digest('hex');
  // the multiset of lines one side has that the other lacks
  const minus = (a, b) => { const left = [...b]; return a.filter((l) => { const i = left.indexOf(l); if (i < 0) return true; left.splice(i, 1); return false; }); };
  function contentProblems(hunks) {
    const bad = []; const used = new Set();
    for (const h of hunks) {
      const now = h.now.split('\n').filter((l) => l !== ''); const was = h.was.split('\n').filter((l) => l !== '');
      for (const [side, line] of [...minus(now, was).map((l) => ['now', l]), ...minus(was, now).map((l) => ['was', l])]) {
        if (/^\s*\/\//.test(line) || isPureLogStatement(line)) continue;
        const k = NON_LOG.findIndex(([f, sd, t]) => f === h.file && sd === side && t === line);
        if (k < 0) bad.push(`${h.file} (${side}): ${line.trim().slice(0, 120)}`); else used.add(k);
      }
    }
    return { bad, unused: NON_LOG.map((x, i) => i).filter((i) => !used.has(i)) };
  }
  assert.deepStrictEqual({ base: BASE, files: [...FILES], hunks: HUNKS.map(shaOf) }, { base: MANIFEST.base, files: MANIFEST.files, hunks: MANIFEST.hunks },
    'PRIVACY: 🔴 MANIFEST — the generated inverse is not the approved one (base, files or a hunk changed): a regeneration needs review and a new pin here');
  const live = contentProblems(HUNKS);
  assert.deepStrictEqual(live.bad, [], `PRIVACY: 🔴 CONTENT — a privacy hunk changes a line that is neither a pure log statement nor an enumerated non-log line:\n  ${live.bad.join('\n  ')}`);
  assert.deepStrictEqual(live.unused, [], 'PRIVACY: every enumerated NON-LOG line is still in a hunk (no stale allowance)');
  // controls: a regenerated hunk carrying a planted state change goes RED on both locks
  const h0 = HUNKS.find((h) => h.file === 'whatsapp.js' && h.now.includes('msg id='));
  assert.ok(h0, 'premise: the whatsapp msg-id hunk exists');
  for (const [label, now] of [
    ['a planted statement', h0.now + '    data.sent = true;\n'],
    ['an assignment inside a log argument', h0.now.replace('${data.id || \'n/a\'}', '${(data.sent = true, data.id)}')],
    ['a side-effecting call inside a log argument', h0.now.replace('${data.id || \'n/a\'}', '${markSent(data)}')],
    ['a statement hidden after a log on the same line', h0.now.replace(/;\n$/, '; data.sent = true;\n')],
  ]) {
    assert.notStrictEqual(now, h0.now, `control premise: ${label} is planted`);
    const planted = HUNKS.map((h) => (h === h0 ? { ...h, now } : h));
    assert.ok(contentProblems(planted).bad.length === 1, `PRIVACY: 🔴 CONTENT control — ${label} in a regenerated hunk must be caught`);
    assert.notDeepStrictEqual(planted.map(shaOf), MANIFEST.hunks, `PRIVACY: 🔴 MANIFEST control — ${label} changes the pinned manifest`);
  }
  assert.ok(isPureLogStatement("console.log(`x: ${orderId} (${n.toFixed(2)}km)`, e && e.message);") && !isPureLogStatement('const a = 1;') && !isPureLogStatement("console.log(')'); x = 1;"),
    'log-stmt: a pure log passes; a const, and a statement hidden behind a ")" in a string, do not');
}
ok(`the approved MANIFEST is pinned (base, ${FILES.length} files, ${HUNKS.length} hunk sha256s); every changed line is a pure log statement or one of the enumerated non-log lines; planted state changes go RED`);
{
  // inside every ledgers1 peel's argument, each raw source (a readFileSync, a local read() helper or a foldPortalSplit call) is privacy-peeled first
  const close = (s, j) => { let d = 1; while (d) { const c = s[j]; if (c === '(') d += 1; else if (c === ')') d -= 1; j += 1; } return j; };
  const files = git(['grep', '-l', 'unapplyLedgerS1Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/(ledgers1|privacy)-module-inverse\.js$|(^|\/)privacy-wiring\.guard\.test\.js$/.test(f));
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /unapplyLedgerS1Module\(/g; let m;
    while ((m = re.exec(s))) {
      const end = close(s, m.index + m[0].length);
      const arg = s.slice(m.index + m[0].length, end - 1);
      const src = /(?:fs\.|fsys\.)?readFileSync\(|(?<![\w.])read\(|foldPortalSplit\(/g; let q;   // a local read(f) helper is a raw read too
      while ((q = src.exec(arg))) if (!/unapplyPrivacyModule\([^,]*,\s*(require\('fs'\)\.|require\('[./]*tools\/portal-split'\)\.)?$/.test(arg.slice(0, q.index))) bare.push(`${f}@${m.index}`);
    }
  }
  assert.ok(files.length > 50, `PRIVACY: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `PRIVACY: 🔴 a raw source inside a ledgers1 peel that is not privacy-peeled first: ${bare.join(', ')}`);
  ok(`every raw source inside a ledgers1 peel in ${files.length} readers is privacy-peeled first`);
}
console.log(`privacy-wiring guard: OK (${n})`);
