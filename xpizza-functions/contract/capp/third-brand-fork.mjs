// CUSTOMER APP S0-test — THE THIRD BRAND, REALLY PROVISIONED, ON A DECLARED FORK (PROVISIONAL until S1).
//
// SERVER SIDE (real writers): contract/third-brand.js publishThirdBrand → the real publishVersion (source
// store → shared builder → verify-before-flip) into catalog/firestore-fake, then the real buildPublicMenu,
// wrapped exactly as getPublicMenu sends it (index.js `{ rid, representation_version, menu }`), and the
// real generateFormBundle + spliceBundle for the embedded bundle. Every dish key and name is renamed
// ("R3 …"), so code that looks a dish up in x_pizza's tables BY NAME fails visibly.
//
// Minting is SEEDED (the plan-fixtures/gen-fixtures2.js allocator: sha256("det:"+counter) bytes in place of
// crypto.randomBytes, reset before the publish), so dish_ids and the etag are identical every run. The
// seed is installed ONLY around the publish and restored after it.
//
// CLIENT SIDE: there is no shared renderer before S1, so the third brand renders on a COPY of the x_pizza
// fork in a git-ignored dir, changed by ONE declared transform list and nothing else. The copy is verified
// to differ from the source in exactly the declared lines (count per entry and in total); an entry that
// matches nothing, or matches a different number of lines than declared, throws. In S1 these cells
// re-point at the shared renderer.
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readInlineConfig, configBlockLines } from './brand-config.mjs';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const FN = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(FN, '..');

export const SOURCE_DIR = 'xpizza-orders';
export const FORK_DIR = 'node_modules/.capp-third/r3-orders';   // git-ignored (node_modules), relative to the repo root

function seededMint(fn) {
  const real = crypto.randomBytes;
  let ctr = 0;
  crypto.randomBytes = (n) => {
    const out = Buffer.alloc(n);
    for (let off = 0, blk = 0; off < n; blk += 1) {
      const h = crypto.createHash('sha256').update(`det:${ctr}:${blk}`).digest();
      const take = Math.min(h.length, n - off); h.copy(out, off, 0, take); off += take;
    }
    ctr += 1;
    return out;
  };
  return Promise.resolve().then(fn).finally(() => { crypto.randomBytes = real; });
}

// Provision the third brand through the real publish path; returns what the endpoint and the page would carry.
export async function provisionThirdBrand() {
  const { makeDb } = require(join(FN, 'catalog/firestore-fake'));
  const T = require(join(FN, 'contract/third-brand'));
  const { buildPublicMenu } = require(join(FN, 'catalog/public-menu'));
  const { getRestaurantMenu } = require(join(FN, 'catalog/catalog-menu'));
  const { generateFormBundle } = require(join(FN, 'catalog/generate-form-bundle'));
  const db = makeDb();
  const pub = await seededMint(() => T.publishThirdBrand(db));
  const menu = await buildPublicMenu(db, T.THIRD, { known: new Set([T.THIRD]), isActive: async () => true });
  const envelope = { rid: menu.rid, representation_version: menu.representation_version, menu: menu.body };   // index.js getPublicMenu body
  const bundle = generateFormBundle(T.THIRD, await getRestaurantMenu(db, T.THIRD));
  return { rid: T.THIRD, versionId: pub.versionId, renamed: pub.renamed, etag: menu.etag, envelope, bundle };
}

/* THE ONE DECLARED TRANSFORM LIST. Each entry rewrites whole LINES of one file: `find` must occur on exactly
   `lines` lines (else it throws), and `to` replaces it on those lines. The `bundle` entry is the real
   spliceBundle over the generated-bundle block; the `config` entry swaps the page's RESTAURANT-CONFIG data for
   the third brand's (the same line, only its JSON payload changes). Since S0-prod every identity value the
   page CODE reads comes from that block, so what remains are the static markup literals the S1 renderer
   will own. Everything else is x_pizza's page, unchanged, which is the point of a PROVISIONAL cell. */
export function thirdConfig(rid, xpizzaConfig) {
  const c = JSON.parse(JSON.stringify(xpizzaConfig));
  return { ...c, rid, display_name: 'R3 Synthetic', map: { latitude: 14.1, longitude: -87.2, radius_km: 8 }, order_id_prefix: 'RTS-',
    storage_keys: { pending_pay: 'r3synth_pending_pay', account_marker: 'r3synth_acct', account_intent: 'r3synth_acct_intent' } };
}
export function transformList(rid) {
  return [
    { file: 'index.html', config: true },
    { file: 'index.html', find: '<title>X Pizza — Pedido en línea</title>', to: '<title>R3 Synthetic — Pedido en línea</title>', lines: 1 },
    { file: 'index.html', find: '<div class="pickup-store-name">X Pizza</div>', to: '<div class="pickup-store-name">R3 Synthetic</div>', lines: 1 },
    { file: 'index.html', find: 'alt="X Pizza"', to: 'alt="R3 Synthetic"', lines: 1 },
    { file: 'index.html', find: 'alt="X Pizza logo"', to: 'alt="R3 Synthetic logo"', lines: 1 },
    { file: 'index.html', bundle: true },
  ];
}

function applyEntry(text, e, ctx) {
  const lines = text.split('\n');
  if (e.config) {
    const { index, config } = ctx.readInlineConfig(text, 'x_pizza fork source');
    lines[index] = ctx.configBlockLines(thirdConfig(ctx.rid, JSON.parse(JSON.stringify(config))))[1];   // the ONE emitter, the third brand's data
    return { text: lines.join('\n'), touched: [index] };
  }
  if (e.bundle) {
    const out = ctx.spliceBundle(text, ctx.bundle, 'r3').split('\n');
    if (out.length !== lines.length) throw new Error(`capp third-brand: the bundle splice changed the LINE COUNT of ${e.file} (${lines.length} → ${out.length})`);
    const touched = out.map((l, i) => (l !== lines[i] ? i : -1)).filter((i) => i >= 0);
    if (touched.length === 0) throw new Error('capp third-brand: the bundle entry changed nothing (unused transform)');
    return { text: out.join('\n'), touched };
  }
  const touched = [];
  const out = lines.map((l, i) => { if (!l.includes(e.find)) return l; touched.push(i); return l.split(e.find).join(e.to); });
  if (touched.length !== e.lines) throw new Error(`capp third-brand: transform ${JSON.stringify(e.find)} in ${e.file} matched ${touched.length} line(s), declared ${e.lines}${touched.length === 0 ? ' (unused transform)' : ''}`);
  return { text: out.join('\n'), touched };
}

/* Materialize the fork: copy the source folder's files, apply the list, then PROVE the copy differs from the
   source in exactly the declared lines (an independent line-by-line comparison against the union the
   entries reported). Returns { dir, entries, changedLines }. */
export function materializeFork(prov, list = transformList(prov.rid)) {
  const { spliceBundle } = require(join(FN, 'catalog/splice-form-bundle'));
  const src = join(ROOT, SOURCE_DIR);
  const dst = join(ROOT, FORK_DIR);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) if (statSync(join(src, f)).isFile()) writeFileSync(join(dst, f), readFileSync(join(src, f)));
  const touchedBy = {};
  const report = [];
  for (const e of list) {
    const p = join(dst, e.file);
    const r = applyEntry(readFileSync(p, 'utf8'), e, { spliceBundle, bundle: prov.bundle, readInlineConfig, configBlockLines, rid: prov.rid });
    for (const i of r.touched) { const k = `${e.file}:${i}`; if (touchedBy[k]) throw new Error(`capp third-brand: line ${k} is touched by two entries`); touchedBy[k] = true; }
    writeFileSync(p, r.text);
    report.push({ file: e.file, what: e.bundle ? 'bundle' : e.config ? 'config' : e.find, lines: r.touched.length });
  }
  // Independent check: every differing line between source and fork is one an entry declared.
  let changed = 0;
  for (const f of readdirSync(src)) {
    if (!statSync(join(src, f)).isFile()) continue;
    const a = readFileSync(join(src, f), 'utf8').split('\n'); const b = readFileSync(join(dst, f), 'utf8').split('\n');
    if (a.length !== b.length) throw new Error(`capp third-brand: ${f} line count differs (${a.length} vs ${b.length})`);
    a.forEach((l, i) => { if (l !== b[i]) { changed += 1; if (!touchedBy[`${f}:${i}`]) throw new Error(`capp third-brand: ${f}:${i + 1} differs but no declared entry touched it`); } });
  }
  const declared = report.reduce((s, r) => s + r.lines, 0);
  if (changed !== declared) throw new Error(`capp third-brand: ${changed} line(s) differ, the list declares ${declared}`);
  return { dir: FORK_DIR, entries: report, changedLines: changed };
}

export function removeFork() { try { rmSync(join(ROOT, FORK_DIR), { recursive: true, force: true }); } catch (_) {} try { rmSync(join(ROOT, 'node_modules/.capp-third'), { recursive: true, force: true }); } catch (_) {} }
