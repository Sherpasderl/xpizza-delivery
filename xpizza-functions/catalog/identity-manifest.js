'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-b — THE IDENTITY MANIFEST (PLAN-D4b §E). Built and tested now; first production publication at D4-c.
//
// /menus/{rid} — today's KDS manifest: dish-only, published by publish-menus.mjs from a CODE PROXY of the catalog —
// is NOT touched by anything here. An open old KDS renders and actions EVERY row of /menus/{rid}, so it must not
// change. This module writes a SEPARATE node, `menus_identity/{rid}`, which today's KDS never reads:
//     { versionId, seq, rows: [{ kind, key, label, category, cid|null }] }   — dishes AND extras
// generated from the LIVE published version through ONE consistent read (the D4-a context writer's read: pointer +
// record + payload in one read-only transaction, content_hash rechecked). `cid` is present only when that version's
// D4-a context is usable-as-identity (intact + registry-confirmed + complete). One node = one atomic write.
//
// PUBLICATION PROTOCOL (§E.3): validate ALL restaurants before writing ANY; write each node with an RTDB transaction
// conditioned on the EXACT value observed before it (a concurrent publisher's write aborts ours — a lost update is
// impossible); a repeat run is idempotent (no write when the node already equals the new one); and every write is
// read back and compared after the SAME normalisation RTDB applies (null fields removed, empty containers absent).
// Restaurants are enumerated by the brand-agnostic registry reader, never a list in code.
//
// THE DIVERGENCE REPORT (§E.4) is the only thing D4-b runs in production: it compares the live version's dish
// [{key,label,category}] (served order) with the published /menus/{rid} projected to the same three fields, and
// REPORTS any difference. It writes nothing.
// ---------------------------------------------------------------------------
const { canonicalJson } = require('./canonical-json');
const { buildContext, identityPairs } = require('./catalog-context');
const { readActiveSnapshot } = require('./context-writer');
const { sanitize } = require('./restaurant-registry');

const MANIFEST_PATH = 'menus_identity';

// RTDB's own normalisation: a null field is not stored and a container left empty is not stored.
function rtdbNormalize(v) {
  if (v === null || v === undefined || typeof v !== 'object') return v === undefined ? null : v;
  const out = Array.isArray(v) ? [] : {};
  for (const k of Object.keys(v)) { const c = rtdbNormalize(v[k]); if (c !== null) { if (Array.isArray(out)) out.push(c); else out[k] = c; } }
  return Object.keys(out).length ? out : null;
}
const sameNode = (a, b) => canonicalJson(rtdbNormalize(a)) === canonicalJson(rtdbNormalize(b));

// ── Generation: the live version → { ok, node } | { ok:false, reason } ───────────────────────────────
async function buildIdentityManifest({ db, rid, verifier, now = Date.now }) {
  const snap = await readActiveSnapshot(db, rid);
  if (snap.ptr.version === null) return { ok: false, rid, reason: 'no_active_version' };
  if (snap.missing) return { ok: false, rid, reason: 'active_version_missing' };
  const versionId = snap.ptr.version;
  const ctx = buildContext({ rid, versionId, record: snap.record, items: snap.items, extras: snap.extras, structure: snap.structure });
  if (!ctx.built || ctx.contentIntegrity.state !== 'intact') return { ok: false, rid, reason: 'content_integrity', detail: ctx.contentIntegrity && (ctx.contentIntegrity.reason || ctx.contentIntegrity.state) };
  // usable-as-identity, judged exactly as the request side judges it: intact + confirmed (unexpired) + complete
  let usable = false;
  if (ctx.complete === true && verifier) {
    const e = await verifier.verify(rid, identityPairs(ctx));
    usable = e.state === 'confirmed' && now() <= e.expiresAt;
  }
  const byKey = { dish: new Map(), extra: new Map() };
  for (const r of snap.items) byKey.dish.set(r.data && r.data.key, r.data);
  for (const r of snap.extras) byKey.extra.set(r.data && r.data.key, r.data);
  const rows = ctx.objects.map((o) => {
    const d = byKey[o.kind].get(o.legacyKey);
    const cat = d && d.display && typeof d.display.cat === 'string' && d.display.cat ? d.display.cat : null;
    return { kind: o.kind, key: o.legacyKey, label: o.label, category: cat, cid: usable ? o.canonicalId : null };
  });
  for (const r of rows) if (typeof r.key !== 'string' || !r.key || typeof r.label !== 'string' || !r.label) return { ok: false, rid, reason: 'row_invalid', detail: r.key };
  return { ok: true, rid, node: { versionId, seq: ctx.seq, rows }, usableAsIdentity: usable };
}

// ── Publication: validate all → conditional, idempotent, read-back-verified write per restaurant ─────
async function publishIdentityManifests({ db, rtdb, listIds, verifier, now = Date.now, onBeforeWrite = null }) {
  const rids = sanitize(await listIds());
  const built = [];
  for (const rid of rids) built.push(await buildIdentityManifest({ db, rid, verifier, now }));
  const invalid = built.filter((b) => !b.ok);
  if (invalid.length) return { ok: false, written: [], invalid: invalid.map((b) => ({ rid: b.rid, reason: b.reason, detail: b.detail || null })) };
  const results = [];
  for (const b of built) {
    const ref = rtdb.ref(`${MANIFEST_PATH}/${b.rid}`);
    const observed = (await ref.get()).val();
    if (sameNode(observed, b.node)) { results.push({ rid: b.rid, outcome: 'idempotent' }); continue; }
    if (typeof onBeforeWrite === 'function') await onBeforeWrite(b.rid);   // test seam: a concurrent publisher lands here
    let decision = null;
    const res = await ref.transaction((cur) => {
      // The Admin SDK may first call with null (its uncached local view): a null-probe makes the server re-run this
      // with the real value; if the node truly IS null now, someone deleted it since we looked → reported a conflict.
      if (cur === null && observed !== null) { decision = 'probe'; return null; }
      if (!sameNode(cur, observed)) { decision = 'conflict'; return undefined; }   // someone wrote since we looked → never overwrite
      decision = 'committed';
      return b.node;
    }, undefined, false);
    if (decision !== 'committed' || !(res && res.committed)) { results.push({ rid: b.rid, outcome: 'conflict' }); continue; }
    const back = (await ref.get()).val();
    results.push({ rid: b.rid, outcome: sameNode(back, b.node) ? 'committed' : 'readback_mismatch', usableAsIdentity: b.usableAsIdentity });
  }
  const ok = results.every((r) => r.outcome === 'committed' || r.outcome === 'idempotent');
  return { ok, written: results.filter((r) => r.outcome === 'committed').map((r) => r.rid), results, invalid: [] };
}

// ── §E.4 the READ-ONLY divergence report: live dishes vs the published /menus/{rid} proxy ─────────────
const project = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ key: String(r && r.key), label: String(r && r.label), category: String(r && r.category) }));
async function divergenceReport({ db, rtdb, listIds }) {
  const rids = sanitize(await listIds());
  const report = [];
  for (const rid of rids) {
    const snap = await readActiveSnapshot(db, rid);
    if (snap.ptr.version === null || snap.missing) { report.push({ rid, status: 'no_live_version' }); continue; }
    const ctx = buildContext({ rid, versionId: snap.ptr.version, record: snap.record, items: snap.items, extras: snap.extras, structure: snap.structure });
    if (!ctx.built) { report.push({ rid, status: 'live_unbuildable' }); continue; }
    const byKey = new Map(snap.items.map((r) => [r.data && r.data.key, r.data]));
    const live = project(ctx.objects.filter((o) => o.kind === 'dish').map((o) => ({ key: o.legacyKey, label: o.label, category: (byKey.get(o.legacyKey) || {}).display && byKey.get(o.legacyKey).display.cat })));
    const publishedRaw = (await rtdb.ref(`menus/${rid}`).get()).val();
    if (publishedRaw === null) { report.push({ rid, status: 'proxy_unpublished', live: live.length }); continue; }
    const published = project(Object.values(Array.isArray(publishedRaw) ? publishedRaw : publishedRaw || {}));
    const pk = new Set(published.map((r) => r.key)), lk = new Set(live.map((r) => r.key));
    const onlyLive = live.filter((r) => !pk.has(r.key)).map((r) => r.key);
    const onlyProxy = published.filter((r) => !lk.has(r.key)).map((r) => r.key);
    const pmap = new Map(published.map((r) => [r.key, r]));
    const changed = live.filter((r) => pmap.has(r.key) && (pmap.get(r.key).label !== r.label || pmap.get(r.key).category !== r.category))
      .map((r) => ({ key: r.key, live: { label: r.label, category: r.category }, proxy: { label: pmap.get(r.key).label, category: pmap.get(r.key).category } }));
    const orderDiffers = !onlyLive.length && !onlyProxy.length && canonicalJson(live.map((r) => r.key)) !== canonicalJson(published.map((r) => r.key));
    const diverged = onlyLive.length > 0 || onlyProxy.length > 0 || changed.length > 0 || orderDiffers;
    report.push({ rid, status: diverged ? 'diverged' : 'identical', live: live.length, proxy: published.length, onlyLive, onlyProxy, changed, orderDiffers });
  }
  return report;
}

module.exports = { buildIdentityManifest, publishIdentityManifests, divergenceReport, rtdbNormalize, sameNode, MANIFEST_PATH };
