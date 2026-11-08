'use strict';
// ---------------------------------------------------------------------------
// PLATFORM-PENDING STAMP (BRIEF-portal-stale-draft-clobber, F-1 ruled (a) 2026-11-07) — the provenance of Sherpa-written
// draft fields, so a merchant's «Volver al menú publicado» can never silently discard them.
//
// The 11-02 loss: migrate-menu-structure --write added display fields to the DRAFT before LIVE had them; the portal saw an
// unpublishable draft, offered the reset, and the reset (correctly version-checked) replaced the draft with live — Sherpa's
// fields gone. A draft that differs from live cannot tell "Sherpa wrote ahead of live" from "live was rolled back behind the
// draft" (the reset's documented recovery), so the difference alone must NOT block the reset. The stamp says WHO wrote WHAT:
//
//   restaurants/{rid}/meta/platform_pending  { v: 1, by, at, fields: [path, …] }   (server-only: meta/* is default-deny)
//
//   • stampPlatformPending — the ONE helper every Sherpa draft writer calls, INSIDE its draft-writing transaction (reads first,
//     as Firestore requires). Fields LIVE already carries are not stamped (nothing of Sherpa's can be lost by going back).
//   • gapsIn — the ABSENT-ONLY rule of the migration rows (catalog/menu-structure-rows premigrationGaps): a stamped field is
//     pending while live does not CARRY it (any value counts); a record live no longer has carries nothing → not a gap.
//   • A MALFORMED stamp fails CLOSED (a lock) — and is never silent: one log line + ONE deduped owner alert
//     (dispatcher_alerts/platform_pending_malformed_<rid>, created once), recovered with the owner CLI tools/platform-pending.js.
//   • resolvePlatformPending — read the stamp, compute its gaps against live; NO gaps ⇒ live carries everything ⇒ the stamp
//     is cleared (a transaction that deletes it only if it is still the stamp that was evaluated). Called by the reset (a
//     writer) and by Sherpa's publish tools after they publish; getEditableCatalog stays READ-ONLY and only reports.
// The reset REFUSES 409 platform_changes_pending while gaps remain. Paths are the migration report's own:
//   structure.<field> · item[<key>].display.<field> · extra[<key>].display.<field>
// ---------------------------------------------------------------------------
const { encodeUpdateTime } = require('./source-store');
const pendingRefOf = (db, rid) => db.collection('restaurants').doc(rid).collection('meta').doc('platform_pending');
const PATH_RE = /^(?:structure\.([A-Za-z_][A-Za-z0-9_]*)|(item|extra)\[(.{1,200})\]\.display\.([A-Za-z_][A-Za-z0-9_]*))$/;   // keys are names (spaces allowed)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

function parsePath(p) {
  const m = typeof p === 'string' ? PATH_RE.exec(p) : null;
  if (!m) throw Object.assign(new Error(`platform_pending_bad_path: ${JSON.stringify(p)}`), { code: 'platform_pending_bad_path' });
  return m[1] ? { kind: 'structure', field: m[1] } : { kind: m[2], key: m[3], field: m[4] };
}

// PURE. live = a SOURCE-shaped document ({ items, extras, structure }) → the stamped paths live does not carry yet.
function gapsIn(live, fields) {
  const out = [];
  for (const p of fields || []) {
    const t = parsePath(p);
    if (t.kind === 'structure') { if (!has(live && live.structure, t.field)) out.push(p); continue; }
    const list = (live && Array.isArray(live[t.kind === 'item' ? 'items' : 'extras'])) ? live[t.kind === 'item' ? 'items' : 'extras'] : [];
    const rec = list.find((r) => isObj(r) && r.key === t.key);
    if (!rec) continue;                                  // live no longer has the record: nothing of it to carry
    if (!has(rec.display, t.field)) out.push(p);
  }
  return out;
}

// INSIDE the caller's transaction, BEFORE its first write. → { stamped: [path] } (the fields live lacks; [] ⇒ nothing written
// unless an earlier stamp already exists, which is kept). `live`: the live SOURCE now (null ⇒ every field is stamped).
async function stampPlatformPending(tx, { db, rid, by, fields, live = null, now = Date.now() }) {
  if (typeof by !== 'string' || !by) throw new Error('platform_pending_by_required');
  if (!Array.isArray(fields)) throw new Error('platform_pending_fields_required');
  for (const p of fields) parsePath(p);                  // a malformed path refuses before anything is written
  const ref = pendingRefOf(db, rid);
  const cur = await tx.get(ref);
  const prev = cur && cur.exists && isObj(cur.data()) && Array.isArray(cur.data().fields) ? cur.data().fields : [];
  const stamped = live ? gapsIn(live, fields) : fields.slice();
  if (!stamped.length) return { stamped: [] };
  const union = [...new Set([...prev, ...stamped])].sort();
  tx.set(ref, { v: 1, by, at: now, fields: union });
  return { stamped };
}

// → null (no stamp) | { fields, by, at } | { malformed: true } (fails CLOSED: treated as pending by resolve)
async function readPlatformPending(db, rid) {
  const snap = await pendingRefOf(db, rid).get();
  if (!snap || !snap.exists) return null;
  const d = snap.data();
  if (!isObj(d) || !Array.isArray(d.fields) || !d.fields.every((p) => { try { parsePath(p); return true; } catch (_) { return false; } })) return { malformed: true };
  // the doc's own write time identifies THIS stamp: the clear deletes only the stamp it evaluated (Codex r1 P1-2 — a replacement
  // with the very same paths is a NEW stamp and must survive)
  return { fields: d.fields, by: d.by, at: d.at, updateTime: snap.updateTime ? encodeUpdateTime(snap.updateTime) : null };
}

// → { pending: false } | { pending: false, cleared: true } | { pending: true, fields: [gap…] }
async function resolvePlatformPending(db, rid, live) {
  const st = await readPlatformPending(db, rid);
  if (!st) return { pending: false };
  if (st.malformed) return { pending: true, fields: [], malformed: true };
  const gaps = gapsIn(live, st.fields);
  if (gaps.length) return { pending: true, fields: gaps };
  // live carries every stamped field: clear it — only if it is still the stamp just evaluated, by its WRITE TIME (any rewrite in
  // between, even one with the same paths, is a newer stamp and stays)
  const ref = pendingRefOf(db, rid);
  let deleted = false;
  await db.runTransaction(async (tx) => {
    deleted = false;
    const now = await tx.get(ref);
    if (now && now.exists && st.updateTime !== null && now.updateTime && encodeUpdateTime(now.updateTime) === st.updateTime) { tx.delete(ref); deleted = true; }
  });
  if (deleted) return { pending: false, cleared: true };
  // a NEWER stamp landed in between: it stays, and its own gaps decide (one re-read, no second clear — no loop)
  const again = await readPlatformPending(db, rid);
  if (!again) return { pending: false };
  if (again.malformed) return { pending: true, fields: [], malformed: true };
  const g2 = gapsIn(live, again.fields);
  return g2.length ? { pending: true, fields: g2 } : { pending: false };
}

// A malformed stamp is a PERMANENT lock until someone acts (nothing can compute its gaps): one log line and ONE owner alert, keyed by
// rid so a repeat (every portal load, every refused reset) re-finds it instead of piling up. Created once (first-seen ts kept); an
// RTDB transaction may run speculatively on null first, so `created` is decided by the LAST run. Best effort for the caller.
const malformedAlertRef = (rtdb, rid) => rtdb.ref(`dispatcher_alerts/platform_pending_malformed_${rid}`);
async function raiseMalformedAlert(rtdb, rid, now = Date.now()) {
  console.error('platform_pending_malformed', JSON.stringify({ rid }));
  let created = false;
  await malformedAlertRef(rtdb, rid).transaction((cur) => {
    created = cur == null;
    return cur == null ? { type: 'platform_pending_malformed', kind: 'platform_pending_malformed', rid, ts: now, detail: 'the menu is locked by an unreadable platform-pending stamp: run tools/platform-pending.js status / clear' } : cur;
  });
  return { created };
}

module.exports = { pendingRefOf, parsePath, gapsIn, stampPlatformPending, readPlatformPending, resolvePlatformPending, malformedAlertRef, raiseMalformedAlert };
