// A PEER'S REAL MODULE, loaded from a PINNED git ref (advisor 11-14: «compose 3a's REAL projectReceipt from its ref» — not yet in this
// base). The module AND every relative file it requires come from that SAME commit (one consistent tree, never mixed with this base's
// copies); packages resolve from this repo's node_modules. Nothing is written to disk. A mutant planted on the on-disk copy never
// reaches a ref-loaded module — mutate the peer's tree, not this one.
import { execFileSync } from 'node:child_process';
import { createRequire, Module } from 'node:module';
import { createHash } from 'node:crypto';
import { join, dirname, posix } from 'node:path';

export function refLoader(root, ref) {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('refLoader: a full commit sha');
  const cache = new Map();
  const blobOf = (rel) => { try { return execFileSync('git', ['cat-file', 'blob', `${ref}:${rel}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (_) { return null; } };
  const find = (rel) => { for (const c of [rel, rel + '.js', rel + '.json', rel + '/index.js']) { const b = blobOf(c); if (b) return { rel: c, b }; } throw new Error(`refLoader: ${rel} not at ${ref.slice(0, 9)}`); };
  function load(want) {
    const { rel, b } = find(want);
    if (cache.has(rel)) return cache.get(rel).exports;
    const file = join(root, rel), m = new Module(file);
    m.filename = file; m.paths = Module._nodeModulePaths(dirname(file));
    cache.set(rel, m);
    if (rel.endsWith('.json')) { m.exports = JSON.parse(b.toString('utf8')); m.loaded = true; return m.exports; }
    const pkg = createRequire(file);
    m.require = (id) => (id.startsWith('./') || id.startsWith('../') ? load(posix.normalize(posix.join(posix.dirname(rel), id))) : pkg(id));
    m._compile(b.toString('utf8'), file); m.loaded = true;
    return m.exports;
  }
  return {
    require: (rel) => load(rel),
    // = git hash-object of the file at the ref (the pin cell compares it with the fixtures' recorded blob)
    blob: (rel) => { const b = blobOf(rel); return b ? createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex') : null; },
  };
}
