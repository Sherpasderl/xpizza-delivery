'use strict';
// feat/reward-groups-5f — the reward-groups layer's own pin: catalog/choice-compare.js minus the layer's hunks === BASE byte-for-byte; the layer
// is non-vacuous, detects a tampered or duplicated hunk, passes other files through; the APPROVED MANIFEST (base, files, sha256 of every hunk)
// is pinned HERE, so a regenerated inverse carrying anything else is a visible edit of this guard (the Codex #133 lesson); and every reader
// that peels extrasflip peels this layer FIRST, directly as the extrasflip peel's source (the extrasflip hunks contain the guard this slice
// rewrites). The behaviour itself is pinned by catalog/reward-group-guard.test.js RG-READ-*. Run: node rewardgroups-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyRewardGroupsModule } = require('./tools/rewardgroups-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'REWARDGROUPS: non-vacuity — the layer owns files');
for (const F of FILES) {
  const raw = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const disk = require('./tools/s4sect-module-inverse').unapplyS4sectModule(F, raw);   // asm13 merge: S4's s4sect sits ABOVE this layer on choice-compare.js (peeled first, the owner rule); a raw variable (d4-wiring's INNER rule)
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `REWARDGROUPS: non-vacuity — ${F} carries the hunks`);
  assert.strictEqual(unapplyRewardGroupsModule(F, disk), base, `🔴 REWARDGROUPS-BASE: ${F} minus the reward-groups hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyRewardGroupsModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `REWARDGROUPS: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyRewardGroupsModule(F, disk + h.now), /occurs 2 times/, `REWARDGROUPS: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyRewardGroupsModule('tb-unowned.js', 'x\n'), 'x\n', 'REWARDGROUPS: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} reward-groups hunks === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const MANIFEST = Object.freeze({
    base: '31f05c8a40c35fe0c442be8839593954c3afc8b1',
    files: ['catalog/choice-compare.js'],
    hunks: [
    '7acf41537c67497cb4e637cf3565e429d43933427aeb99b44a9263cdc6b26f75',
    '7a654cac60b274cd732150277d0dd2b6d20d6a62f4a2126ac17c1e341d6f9b6a',
    '352d3a6809e1ca17d261caa0b46bf0366ab4bfe95f85ec49bdc3d90497197ece',
    'e7bd2ea42d1381382e15adbb25e47e5c53650002a80173107f7d2a390661d5d3',
    ],
  });
  const shaOf = (h) => crypto.createHash('sha256').update(`${h.file}\0${h.now}\0${h.was}`).digest('hex');
  assert.deepStrictEqual({ base: BASE, files: [...FILES], hunks: HUNKS.map(shaOf) }, { base: MANIFEST.base, files: MANIFEST.files, hunks: MANIFEST.hunks },
    '🔴 REWARDGROUPS-MANIFEST: the generated inverse is not the approved one (base, files or a hunk changed): a regeneration needs review and a new pin here');
  const planted = HUNKS.map((h, i) => (i === 0 ? { ...h, now: `${h.now}  x.sent = true;\n` } : h));
  assert.notDeepStrictEqual(planted.map(shaOf), MANIFEST.hunks, 'REWARDGROUPS: MANIFEST control — a planted line in a regenerated hunk changes the pin');
  ok(`the approved MANIFEST is pinned (base, ${FILES.length} file, ${HUNKS.length} hunk sha256s); a planted line changes it`);
}
{
  // every extrasflip peel's SOURCE argument is the reward-groups peel (a literal first argument naming another file is exempt: nothing to peel)
  const OWNED = new Set(FILES);
  const files = git(['grep', '-l', 'unapplyExtrasflipModule(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/(extrasflip|rewardgroups)-module-inverse\.js$|(^|\/)rewardgroups-wiring\.guard\.test\.js$/.test(f));
  const argEnd = (s, i, comma) => { let d = 0; for (; i < s.length; i += 1) { const c = s[i];
    if (c === "'" || c === '"') { const q = c; i += 1; while (s[i] !== q) { if (s[i] === '\\') i += 1; i += 1; } continue; }
    if (c === '`') { i += 1; let t = 0; while (!(s[i] === '`' && t === 0)) { if (s[i] === '\\') i += 1; else if (s.startsWith('${', i)) { t += 1; i += 1; } else if (s[i] === '}' && t) t -= 1; i += 1; } continue; }
    if ('([{'.includes(c)) d += 1; else if (')]}'.includes(c)) { if (!d) return i; d -= 1; } else if (c === ',' && !d && comma) return i; }
    throw new Error('unbalanced'); };
  const bare = []; let peels = 0;
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    if (f === 'extrasflip-wiring.guard.test.js') {   // the layer guard's own raw read
      if (!/const disk = require\('\.\/tools\/rewardgroups-module-inverse'\)\.unapplyRewardGroupsModule\(F, require\('\.\/tools\/s4sect-module-inverse'\)\.unapplyS4sectModule\(F, require\('\.\/tools\/mrr-module-inverse'\)\.unapplyMrrModule\(F, require\('\.\/tools\/cpark-module-inverse'\)\.unapplyCparkModule\(F, require\('\.\/tools\/ratt-module-inverse'\)\.unapplyRattModule\(F, require\('\.\/tools\/statscmp-module-inverse'\)\.unapplyStatsCmpModule\(F, require\('\.\/tools\/dirwire-module-inverse'\)\.unapplyDirwireModule\(F, require\('\.\/tools\/salesmulti-module-inverse'\)\.unapplySalesMultiModule\(F, require\('\.\/tools\/d4-intake-inverse'\)\.unapplyD4Module\(F, /.test(s)) bare.push(`${f}: its raw read`);
      continue;
    }
    const re = /unapplyExtrasflipModule\(/g; let m;
    while ((m = re.exec(s))) {
      const a0 = m.index + m[0].length; const ca = argEnd(s, a0, true); const A = s.slice(a0, ca).trim();
      const lit = /^'([^']*)'$/.exec(A); if (lit && !OWNED.has(lit[1])) continue;
      const B = s.slice(ca + 1, argEnd(s, ca + 1, false)).trim();
      if (!/^require\('[./]*tools\/rewardgroups-module-inverse'\)\.unapplyRewardGroupsModule\(/.test(B) || !B.startsWith(`require(`) || !B.includes(`unapplyRewardGroupsModule(${A}, `)) bare.push(`${f}@${m.index}`); else peels += 1;
    }
  }
  assert.ok(files.length > 40 && peels > 40, `REWARDGROUPS: non-vacuity (${files.length} readers, ${peels} peels)`);
  assert.deepStrictEqual(bare, [], `🔴 REWARDGROUPS-WIRING: an extrasflip peel whose source is not reward-groups-peeled first: ${bare.join(', ')}`);
  ok(`every extrasflip peel in ${files.length} readers (${peels} peels) takes the reward-groups peel as its source`);
}
console.log(`rewardgroups-wiring guard: OK (${n})`);
