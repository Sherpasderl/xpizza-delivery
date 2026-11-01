#!/usr/bin/env node
'use strict';
// DISH PHOTOS A2 step 12b — the OWNER's one-time LEGACY BACKFILL (run at the photos launch, after A0 created the public bucket):
//
//   node tools/photos-legacy-backfill.js --project xpizza-delivery --rid <rid> [--rid <rid> …] [--out <dir>]            # DRY RUN
//   node tools/photos-legacy-backfill.js --project xpizza-delivery --rid <rid> --apply                                  # the owner
//
// DRY RUN (default): reads each restaurant's ACTIVE catalog, fetches every legacy dish image the public menu serves today (HTTPS, from that
// restaurant's OWN order-site origin only, ≤ 10 MB, 20 s), re-encodes it (photos/legacy-encode.js: centre 4:3 800×600 WEBP) and writes a
// CONTACT SHEET — <out>/<rid>/contact.html with every before/after pair — for the owner to review BEFORE any --apply (the crop changes images
// the restaurants already show). Nothing is uploaded or recorded.
// --apply: create-only uploads to the PUBLIC bucket (PHOTOS_PUBLIC_BUCKET env) photos/{rid}/legacy/<hash>-card.webp, then the Firestore
// records photo_registry/{rid}/legacy/{hash}. Idempotent (an existing record is skipped). Reports per rid: copied / already present /
// unresolvable / same image. The project is NEVER inferred (require-project, --project mandatory) — a refusal touches nothing.
const fs = require('fs');
const path = require('path');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // before any client
const { backfillRid } = require('./photos-legacy-backfill-core');

function parseArgs(argv) {
  const out = { rids: [], apply: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { i++; continue; }
    if (a.startsWith('--project=')) continue;
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--rid' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(argv[i + 1] || '')) { out.rids.push(argv[++i]); continue; }
    if (a === '--out' && argv[i + 1]) { out.out = argv[++i]; continue; }
    return { error: `unknown or malformed argument ${JSON.stringify(a)}` };
  }
  if (!out.rids.length) return { error: 'at least one --rid is required' };
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.error) { console.error(`photos-legacy-backfill: REFUSED — ${args.error}`); process.exit(2); }

const admin = require('firebase-admin');
admin.initializeApp({ projectId: PROJECT_ID });
const fsdb = admin.firestore();
const { assetBaseFor } = require('../catalog/public-photos');
const { PLATFORM } = require('../platform-manifest');
const { readActiveBuiltFrom } = require('../catalog/publish-request');
const { encodeLegacy } = require('../photos/legacy-encode');
const MAX_BYTES = 10 * 1024 * 1024;

async function fetchFrom(origin, url) {
  if (new URL(url).origin !== origin || !url.startsWith('https://')) throw new Error('not this restaurant\'s order-site origin');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'error' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('over 10 MB');
    return buf;
  } finally { clearTimeout(t); }
}

(async () => {
  const bucketName = (process.env.PHOTOS_PUBLIC_BUCKET || '').trim();
  const outDir = args.out || path.join(process.cwd(), `legacy-backfill-${Date.now()}`);
  const summary = [];
  for (const rid of args.rids) {
    const base = assetBaseFor(rid, PLATFORM.sites);
    const origin = base ? new URL(base).origin : null;
    const recRef = (h) => fsdb.collection('photo_registry').doc(rid).collection('legacy').doc(h);
    const r = await backfillRid(rid, { apply: args.apply }, {
      readItems: async () => (await readActiveBuiltFrom(fsdb, rid)).built.items,
      legacyBase: () => base, publicBucket: bucketName, now: () => Date.now(),
      readRecord: async (_r, h) => { const s = await recRef(h).get(); return s.exists ? s.data() : null; },
      fetchImage: (url) => fetchFrom(origin, url),
      encode: encodeLegacy,
      upload: async (_r, h, buf) => {
        const file = admin.storage().bucket(bucketName).file(`photos/${rid}/legacy/${h}-card.webp`);
        try { await file.save(buf, { resumable: false, contentType: 'image/webp', preconditionOpts: { ifGenerationMatch: 0 }, metadata: { cacheControl: 'public, max-age=31536000, immutable' } }); }
        catch (e) { if (!(e && (e.code === 412 || e.code === '412'))) throw e; }
        const [m] = await file.getMetadata();
        return { generation: String(m.generation) };
      },
      writeRecord: (_r, h, rec) => recRef(h).set(rec),
      writeSheet: async (_r, rows) => {
        const dir = path.join(outDir, rid); fs.mkdirSync(dir, { recursive: true });
        const cells = rows.map((x) => {
          if (x.before) { fs.writeFileSync(path.join(dir, `${x.hash}-before.bin`), x.before); fs.writeFileSync(path.join(dir, `${x.hash}-after.webp`), x.after); }
          const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
          return `<tr><td>${esc(x.key)}</td><td>${esc(x.status)}${x.error ? ` — ${esc(x.error)}` : ''}</td><td>${x.before ? `<img src="${x.hash}-before.bin" height="150">` : ''}</td><td>${x.after ? `<img src="${x.hash}-after.webp" height="150">` : ''}</td></tr>`;
        }).join('\n');
        fs.writeFileSync(path.join(dir, 'contact.html'), `<!doctype html><meta charset="utf-8"><title>${rid} legacy backfill (dry run)</title><table border="1" cellpadding="6"><tr><th>dish</th><th>status</th><th>before</th><th>after (800×600)</th></tr>\n${cells}\n</table>\n`);
      },
    });
    summary.push(r);
  }
  console.log(JSON.stringify({ project: PROJECT_ID, mode: args.apply ? 'apply' : 'dry_run', ...(args.apply ? {} : { contact_sheets: outDir }), restaurants: summary.map((s) => ({ rid: s.rid, counts: s.counts, unresolvable: s.rows.filter((x) => x.status === 'unresolvable') })) }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('photos-legacy-backfill FAILED:', e && e.message); process.exit(1); });
