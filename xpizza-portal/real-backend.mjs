// The REAL catalog backend for the portal's cells (moved verbatim from structure-s3.test.mjs; used by it and by structure-s4-ui):
// 5f's chain over one store — the seed stored → the real publishVersion → the real identity bootstrap → getEditableCatalogCore /
// editCatalogCore, the caller through the real authorizeCatalogEdit; the portal's api.js request bodies travel verbatim. `freq` is the
// functions tree it runs: this repo's, or a snapshot of a peer's pinned commit (s4Snapshot — approach (A), advisor 11-13).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const clone = (v) => JSON.parse(JSON.stringify(v));
// the ONE stub every cell shares: the platform-structure switches, as 5f's own cells inject them (choice-compare.test.js:11)
export function installSwitches(freq, get) {
  const p = freq.resolve('./catalog/platform-structure');
  const real = freq('./catalog/platform-structure');
  freq.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), ...get() }) } };
}
// approach (A): the peer's functions tree at a PINNED commit, as `git archive` writes it — in a temp dir (node_modules linked to this
// repo's), removed when the process ends; nothing is written in any worktree
export function s4Snapshot(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'portal-s4ref-'));
  // the functions tree and the two order forms its seed reads (catalog/form-menu-source.js:31-32), paths from the repo root
  const tar = execFileSync('git', ['archive', '--format=tar', ref, 'xpizza-functions', 'xpizza-orders/index.html', 'la-musa-orders/index.html'], { cwd: join(DIR, '..'), maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  symlinkSync(join(DIR, '..', 'xpizza-functions', 'node_modules'), join(dir, 'xpizza-functions', 'node_modules'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  return createRequire(join(dir, 'xpizza-functions', 'package.json'));
}

export async function makeBackend(freq, rid) {
  const { buildSourceFromCode } = freq('./tools/seed-source-store');
  const { makeDb } = freq('./catalog/firestore-fake');
  const { createFakeDb } = freq('./merchant/_fake-db');
  const { Timestamp } = freq('firebase-admin/firestore');
  const { sourceRefOf } = freq('./catalog/source-store');
  const { publishVersion } = freq('./catalog/catalog-publish');
  const { readPublishBaseline, buildPublishCandidate } = freq('./tools/publish-version');
  const { bootstrapIdentityStamps } = freq('./catalog/identity-bootstrap');
  const { getActiveVersionId } = freq('./catalog/catalog-firestore');
  const { authorizeCatalogEdit } = freq('./catalog/catalog-edit-auth');
  const { editCatalogCore } = freq('./catalog/edit-catalog-handler');
  const { getEditableCatalogCore } = freq('./catalog/portal-reads');
  const PR = freq('./catalog/publish-request');
  const U = 'uOwnerS3';
  const fsdb = makeDb();
  const rtdb = createFakeDb({ brands: { [rid]: { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } } },
    restaurants: { [rid]: { identity: { name: rid } } }, brand_members: { [rid]: { owners: { [U]: { granted_at: 1 } } } } });
  const seed = clone(buildSourceFromCode(rid));
  await fsdb.collection('restaurants').doc(rid).set({ pricing_key_mode: seed.key_mode });
  await sourceRefOf(fsdb, rid).set(seed);
  { const b = await readPublishBaseline(fsdb, rid, { fromStore: true }); const { input, expected } = buildPublishCandidate(rid, b, { source_sha: 's3ui' }); await publishVersion(fsdb, rid, input, { expected }); }
  assert.equal((await bootstrapIdentityStamps(fsdb, rid)).stamped, true, `premise: the real bootstrap stamped ${rid}`);
  const readActiveBuilt = async () => PR.readActiveBuiltFrom(fsdb, rid);
  const authorize = (r, q) => authorizeCatalogEdit({ db: rtdb, verifyIdToken: async () => ({ uid: U }) }, q, r);
  const rq = (m, auth) => ({ method: m, query: { restaurantId: rid }, get: (h) => (String(h).toLowerCase() === 'authorization' ? auth : undefined) });
  const toPrecondition = (v) => { if (typeof v !== 'string') return v; const [a, b] = v.split('.'); return /^\d+$/.test(a || '') && /^\d+$/.test(b || '') ? new Timestamp(Number(a), Number(b)) : v; };
  const addProductIo = freq('./catalog/add-product-io').addProductIo({ fs: fsdb, rtdb });
  const read = await getEditableCatalogCore({ db: rtdb, fsdb, readActiveVersionId: getActiveVersionId, readActiveBuilt, authorize, now: () => 6000 }, rq('GET', 'Bearer t'));
  assert.equal(read.status, 200, `premise: the editable read (${JSON.stringify(read.body).slice(0, 200)})`);
  const calls = [];
  // the portal's fetch → the real save core (the URL, method, headers and JSON body as api.js sent them)
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/editCatalog', `only the save is expected here, got ${u.pathname}`);
    const body = JSON.parse(opts.body);
    calls.push(body);
    const r = await editCatalogCore({ db: fsdb, authorize, readActiveBuilt, toPrecondition, addProduct: addProductIo }, body, rq('POST', opts.headers && opts.headers.Authorization));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => clone(r.body) };
  };
  return { read: read.body, fetch, calls };
}
