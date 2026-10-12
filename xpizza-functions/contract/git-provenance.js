'use strict';
// R3 — the provenance of a recorded observation, read from git METADATA with fs only (no child_process: the page-booting
// suites may not load it — contract/harness-capabilities.guard). head = the checked-out commit; base = the origin/main
// tracking ref at record time (the integration base the observations were taken against). Works in a linked worktree.
const fs = require('fs');
const path = require('path');

function gitDirs(start) {
  let d = start;
  for (;;) {
    const g = path.join(d, '.git');
    if (fs.existsSync(g)) {
      const st = fs.statSync(g);
      const gitdir = st.isDirectory() ? g : path.resolve(d, fs.readFileSync(g, 'utf8').replace(/^gitdir:\s*/, '').trim());
      const cd = path.join(gitdir, 'commondir');
      const common = fs.existsSync(cd) ? path.resolve(gitdir, fs.readFileSync(cd, 'utf8').trim()) : gitdir;
      return { gitdir, common };
    }
    const up = path.dirname(d); if (up === d) throw new Error('git-provenance: not inside a git checkout'); d = up;
  }
}
function readRef({ gitdir, common }, ref) {
  for (const dir of [gitdir, common]) { const f = path.join(dir, ref); if (fs.existsSync(f)) { const v = fs.readFileSync(f, 'utf8').trim(); return v.startsWith('ref: ') ? readRef({ gitdir, common }, v.slice(5)) : v; } }
  const packed = path.join(common, 'packed-refs');
  if (fs.existsSync(packed)) for (const l of fs.readFileSync(packed, 'utf8').split('\n')) { const [sha, name] = l.split(' '); if (name === ref) return sha; }
  return null;
}
function provenance(start = __dirname) {
  const dirs = gitDirs(start);
  const head = readRef(dirs, 'HEAD'); const base = readRef(dirs, 'refs/remotes/origin/main');
  if (!/^[0-9a-f]{40}$/.test(head || '') || !/^[0-9a-f]{40}$/.test(base || '')) throw new Error(`git-provenance: unresolved (head ${head}, base ${base})`);
  return { head: head.slice(0, 7), base: base.slice(0, 7) };
}
module.exports = { provenance };
