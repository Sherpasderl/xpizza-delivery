// DISH PHOTOS B — a CONTRACT FAKE of PLAN-dish-photos r2 §2.2 (FROZEN) + its amendments of 2026-10-27, for the portal's tests
// while Part A (5f) is not built. NOT a test file and NOT served (nothing in index.html reaches it). It implements exactly the
// contract's surface and nothing the portal could lean on beyond it:
//   E-P1 photoUploadStart   {rid, op_id, contentType, bytes} → {uploadId, url, method:'PUT', headers{3 signed}, expiresAt};
//                           idempotent on {uid, rid, op_id}; op_conflict; fail-closed rate limit; tenant auth (catalog.edit)
//   the signed PUT          path-style default-bucket uploads/{rid}/{uploadId}; EXACTLY the signed headers (a missing or extra
//                           one fails); content-length-range; create-only (a second PUT → 412)
//   E-P2 photoProcess       {rid, uploadId, crops} → {pid, preview{card, hero, expiresAt}}; the claim (own upload, attempts < 3),
//                           upload_missing, the crop rules in the ORIENTED space (ints, bounds, aspect ±0.5 %, card ≥ 400×300,
//                           hero ≥ 496×310 — amended), terminal codes, idempotent completion
//   editCatalog             source.photos: keys = live item keys OR (amendment 1) a `tmp:` ref present in the SAME source's
//                           items, re-keyed to the allocated key in the returned canonical res.source.photos (rekeyTmpPhotos —
//                           ONE helper, exported with its cases for A2); pids must be attachable; flag off ⇒ a map that differs
//                           from the stored one → 409 photo_change_disabled; the diff's three-state photo lines
//   publishEdited           fiscal gate (usesPlatformFactura ⇒ fiscalAck), the version's meta/photos, registry → published
//   getEditableCatalog E-P3 photos (the draft map) / photoPreviews (every pid the draft OR the active version references, by
//                           REGISTRY state: published → public URL, no expiry; draft → signed GET, expiresAt) / legacyPreviews
//                           (amendment 2: the PUBLIC bucket's photos/{rid}/legacy/ copy) / photosEnabled — each OMITTED when empty
//   getBranchAvailability E-P4  branches[i].photos {[itemKey]: {card}} from THAT branch's active meta/photos, omitted when empty
// Scenario hooks: fake.failNext(fn, status, body), fake.holdPut(), fake.flags, fake.caps.
export const DEFAULT_BUCKET = 'xpizza-delivery.firebasestorage.app';
export const PUBLIC_BUCKET = 'xpizza-delivery-photos';     // ⚠️ PLACEHOLDER until A0 names it (netlify.toml carries the same)
const GCS = 'https://storage.googleapis.com';
const MAX = 10485760;
const FRAMES = { card: { a: 4 / 3, w: 400, h: 300 }, hero: { a: 16 / 10, w: 496, h: 310 } };
import { createHash } from 'node:crypto';
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
let seq = 0;
const nid = (p) => `${p}${(++seq).toString(36).padStart(4, '0')}`;

// ── AMENDMENT 1 (2026-10-27): the ONE re-keying rule, shared with A2's tests ───────────────────────────────────────────
// `photos` = the request's source.photos; `items` = the SAME request's items (before allocation); `allocated` = Map(tmp ref →
// allocated key). A `tmp:` key whose exact ref is an item of this request moves to its allocated key; any other tmp key (no
// matching item) → the existing validation error, never silently dropped. Non-tmp keys must be live item keys.
export function rekeyTmpPhotos(photos, items, allocated) {
  const out = {};
  const refs = new Set((items || []).filter((r) => r && typeof r.ref === 'string').map((r) => r.ref));
  const keys = new Set((items || []).filter((r) => r && typeof r.key === 'string').map((r) => r.key));
  for (const [k, e] of Object.entries(photos || {})) {
    if (typeof k === 'string' && k.startsWith('tmp:')) {
      if (!refs.has(k) || !allocated.has(k)) return { error: 'bad_source', field: 'photos', key: k };
      out[allocated.get(k)] = e;
    } else if (keys.has(k)) out[k] = e;
    else return { error: 'bad_source', field: 'photos', key: k };
  }
  return { photos: out };
}
export const REKEY_CASES = [
  { name: 'a tmp ref present in items moves to its allocated key', photos: { 'tmp:a': { state: 'pid', pid: 'P1' } }, items: [{ ref: 'tmp:a' }], allocated: [['tmp:a', 'Nueva']], want: { photos: { Nueva: { state: 'pid', pid: 'P1' } } } },
  { name: 'live keys pass through unchanged beside a re-keyed one', photos: { Pep: { state: 'removed' }, 'tmp:b': { state: 'pid', pid: 'P2' } }, items: [{ key: 'Pep' }, { ref: 'tmp:b' }], allocated: [['tmp:b', 'Otra']], want: { photos: { Pep: { state: 'removed' }, Otra: { state: 'pid', pid: 'P2' } } } },
  { name: 'a tmp key with no matching item is the validation error, never dropped', photos: { 'tmp:zz': { state: 'pid', pid: 'P3' } }, items: [{ ref: 'tmp:a' }], allocated: [['tmp:a', 'Nueva']], want: { error: 'bad_source', field: 'photos', key: 'tmp:zz' } },
  { name: 'a key that is neither a live item nor a tmp ref is refused', photos: { Ghost: { state: 'pid', pid: 'P4' } }, items: [{ key: 'Pep' }], allocated: [], want: { error: 'bad_source', field: 'photos', key: 'Ghost' } },
];

export function createPhotoFake({ rid = 'r_s', brandId = 'marca_s', draftTtlMs = 3600e3, items = [], usesPlatformFactura = false, photosEnabled = true, legacy = {}, caps = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'availability.set'] } = {}) {
  const fake = {
    rid, brandId, caps: new Set(caps), uid: 'u_owner',
    flags: { uploads: photosEnabled },
    usesPlatformFactura,
    // the published version and the draft (a source document, as editCatalog stores it; photos stored beside it)
    // section names (PLAN-public-menu-display T1), so a rename travels like the real server's: the draft's names vs the published
    active: { vid: 'v1', items: clone(items), photos: {}, categories: [{ id: 'cl', name: 'Clásicas' }] },
    draft: { items: clone(items), photos: {}, categories: [{ id: 'cl', name: 'Clásicas' }] },
    sourceUpdateTime: 'T1',
    legacy: { ...legacy },            // itemKey → true (the dish has a legacy image the public menu serves)
    uploads: new Map(),               // uploadId → doc
    objects: new Map(),               // gs path → {size, type, dims}
    registry: new Map(),              // pid → {state}
    byOp: new Map(),                  // `${uid}|${rid}|${op_id}` → uploadId
    starts: 0,
    calls: [],
    puts: [],
    _fail: new Map(),
    _hold: null,
    tokens: new Map(),
    versions: 1,
  };
  fake.failNext = (fn, status, body) => { fake._fail.set(fn, { status, body }); };
  fake.holdPut = () => { let release; const p = new Promise((r) => { release = r; }); fake._hold = p; return release; };
  const answer = (status, body) => ({ status, body });
  const err = (status, error, extra = {}) => answer(status, { error, ...extra });
  const authz = (r) => (r !== fake.rid ? err(403, 'not_authorized') : (fake.caps.has('catalog.edit') ? null : err(403, 'not_authorized')));
  const pubCard = (pid) => `${GCS}/${PUBLIC_BUCKET}/photos/${fake.rid}/${pid}-card.webp`;
  const pubHero = (pid) => `${GCS}/${PUBLIC_BUCKET}/photos/${fake.rid}/${pid}-hero.webp`;
  const draftUrl = (pid, f) => `${GCS}/${DEFAULT_BUCKET}/drafts/${fake.rid}/${pid}-${f}.webp?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=fake${++seq}`;   // a fresh signature per signing, as a real re-sign
  const legacyCard = (k) => `${GCS}/${PUBLIC_BUCKET}/photos/${fake.rid}/legacy/${Buffer.from(k).toString('hex').slice(0, 16)}-card.webp`;
  const preview = (pid) => {
    const r = fake.registry.get(pid);
    if (!r || r.state === 'deleting' || r.state === 'deleted') return null;
    return r.state === 'published' ? { card: pubCard(pid), hero: pubHero(pid) } : { card: draftUrl(pid, 'card'), hero: draftUrl(pid, 'hero'), expiresAt: Date.now() + draftTtlMs };
  };
  // the three-state of a key in a map; legacy when absent
  const st = (map, k) => (own(map, k) ? (map[k].state === 'pid' ? { kind: 'pid', pid: map[k].pid } : { kind: 'removed' }) : { kind: 'legacy' });
  const sameSt = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keyOf = (r) => (r && typeof r.key === 'string' ? r.key : null);

  // ── the endpoints ──
  const handlers = {
    photoUploadStart(b) {
      const a = authz(b.rid); if (a) return a;
      if (!fake.flags.uploads) return err(409, 'photos_disabled');
      if (typeof b.op_id !== 'string' || !b.op_id) return err(400, 'bad_request');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(b.contentType) || !Number.isInteger(b.bytes) || b.bytes < 1 || b.bytes > MAX) return err(400, 'bad_request');
      const k = `${fake.uid}|${b.rid}|${b.op_id}`;
      if (fake.byOp.has(k)) {
        const u = fake.uploads.get(fake.byOp.get(k));
        if (u.contentType !== b.contentType || u.bytes !== b.bytes) return err(409, 'op_conflict');
        return answer(200, signed(u));
      }
      if (fake.starts >= 30) return err(429, 'rate_limited', { retryable: true });   // fail-closed; 429 exactly as the server (photos/errors.js)
      fake.starts += 1;
      const u = { uploadId: nid('up'), rid: b.rid, uid: fake.uid, op_id: b.op_id, contentType: b.contentType, bytes: b.bytes, state: 'issued', attempts: 0 };
      fake.uploads.set(u.uploadId, u);
      fake.byOp.set(k, u.uploadId);
      return answer(200, signed(u));
    },
    photoProcess(b) {
      const a = authz(b.rid); if (a) return a;
      if (!fake.flags.uploads) return err(409, 'photos_disabled');
      const u = fake.uploads.get(b.uploadId);
      if (!u || u.rid !== b.rid || u.uid !== fake.uid) return err(403, 'not_authorized');
      const ch = JSON.stringify(b.crops);
      if (u.state === 'done') return u.crops === ch ? answer(200, { pid: u.result.pid, preview: preview(u.result.pid) }) : err(409, 'op_conflict');
      if (u.state === 'failed') return err(400, u.code);
      if (u.attempts >= 3) return err(503, 'unavailable', { retryable: true });
      const obj = fake.objects.get(`uploads/${u.rid}/${u.uploadId}`);
      if (!obj) return err(409, 'upload_missing');
      u.attempts += 1;
      if (obj.size > MAX) return terminal(u, 'too_large');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(obj.sniffed || obj.type)) return terminal(u, 'bad_type');
      const { W, H } = obj.dims || {};
      if (!(W >= 500 && H >= 440)) return terminal(u, 'too_small');
      const bad = cropError(b.crops, W, H);
      if (bad) return terminal(u, 'bad_crop');
      // the content id of the OUTPUTS (§2.2): a real hash of the full input — the bytes AND both crops — so different crops of
      // the same file are different pids (codex r1 #6)
      const pid = `pid_${createHash('sha256').update(`${obj.content}\u0000${ch}`).digest('hex').slice(0, 32)}`;
      if (!fake.registry.has(pid)) fake.registry.set(pid, { state: 'draft' });
      u.state = 'done'; u.crops = ch; u.result = { pid };
      fake.objects.delete(`uploads/${u.rid}/${u.uploadId}`);
      return answer(200, { pid, preview: preview(pid) });
    },
    // the READS are tenant-scoped like everything else (§2.2 / codex r1 #7): the requested restaurant must be the caller's, and
    // the caller must hold the read's capability
    getEditableCatalog(q) {
      if (q.restaurantId !== fake.rid || !fake.caps.has('catalog.read_editor')) return err(403, 'not_authorized');
      const out = { source: { restaurant_id: fake.rid, schema_version: 1, items: clone(fake.draft.items), extras: [], structure: { schema_version: 2, item_order: fake.draft.items.map((r) => keyOf(r)), categories: clone(fake.draft.categories) } },
        sourceUpdateTime: fake.sourceUpdateTime, activeVersionId: fake.active.vid, usesPlatformFactura: fake.usesPlatformFactura, renderedCategories: ['cl'] };
      if (Object.keys(fake.draft.photos).length) out.photos = clone(fake.draft.photos);
      const pids = new Set([...Object.values(fake.draft.photos), ...Object.values(fake.active.photos)].filter((e) => e.state === 'pid').map((e) => e.pid));
      const pv = {};
      for (const pid of pids) { const p = preview(pid); if (p) pv[pid] = p; }
      if (Object.keys(pv).length) out.photoPreviews = pv;
      const lg = {};
      for (const k of Object.keys(fake.legacy)) if (fake.legacy[k]) lg[k] = fake.legacy[k] === 'nourl' ? {} : { card: legacyCard(k) };
      if (Object.keys(lg).length) out.legacyPreviews = lg;
      if (fake.flags.uploads) out.photosEnabled = true;
      // pendingRenames (portal-reads.js) is NOT served: production derives it with draft-assess.assessDraft, which only accepts a
      // complete schema-2 source — this fake's catalog is not one, so it reports none (advisor ruling B, Codex held r3). Tests that
      // need a pending name make it through the page's own rename path; the server's derivation is proven by the emulator cells.
      return answer(200, out);
    },
    editCatalog(b) {
      if (!fake.caps.has('catalog.edit')) return err(403, 'not_authorized');
      if (b.restaurantId !== fake.rid) return err(403, 'not_authorized');
      if (b.baseSourceUpdateTime !== fake.sourceUpdateTime) return err(409, 'stale_edit');
      const src = b.source || {};
      const items = Array.isArray(src.items) ? src.items : [];
      // allocation: a tmp row gets a key (its name, as an x-style brand would)
      const allocated = new Map();
      const canon = items.map((r) => { if (r && typeof r.ref === 'string' && !('key' in r)) { const k = (r.display && r.display.name) || nid('k'); allocated.set(r.ref, k); return { key: k, price: r.price, display: clone(r.display) }; } return clone(r); });
      const rk = rekeyTmpPhotos(own(src, 'photos') ? src.photos : {}, items, allocated);
      if (rk.error) return err(400, rk.error, { field: rk.field, key: rk.key });
      for (const e of Object.values(rk.photos)) {
        if (!e || !['pid', 'removed'].includes(e.state)) return err(400, 'bad_source', { field: 'photos' });
        if (e.state === 'pid') { const r = fake.registry.get(e.pid); if (!r || r.state === 'deleting' || r.state === 'deleted') return err(409, 'photo_unavailable'); }
      }
      if (!fake.flags.uploads && JSON.stringify(rk.photos) !== JSON.stringify(fake.draft.photos)) return err(409, 'photo_change_disabled');
      const cats = src.structure && Array.isArray(src.structure.categories) ? src.structure.categories.filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, name: c.name })) : clone(fake.draft.categories);
      // A RENAME IS NOT MODELLED — the fake is STRICTER than production (advisor ruling B, Codex held r3): it accepts a category
      // change only when it is a pure display-name change AND everything else is deep-equal to the PUBLISHED catalog (items,
      // extras, item_order, every structure field, category metadata, photos). Anything else beside a category change → 400
      // `unmodeled_change` (production would answer rename_not_alone / structure_changed; only a LAXER fake voids a test). The
      // production rule itself is proven against the real editCatalog in the emulator cells.
      const ac = fake.active.categories;
      const catsRaw = src.structure && Array.isArray(src.structure.categories) ? src.structure.categories : null;
      if (catsRaw && JSON.stringify(catsRaw) !== JSON.stringify(ac)) {
        const noNames = (cs) => cs.map((c) => { if (!c || typeof c !== 'object') return c; const { name, ...rest } = c; return rest; });
        const rest = (s0, cs, photos) => JSON.stringify({ items: s0.items, extras: s0.extras || [], structure: { ...s0.structure, categories: noNames(cs) }, photos: photos || {} });
        const published = { items: fake.active.items, extras: [], structure: { schema_version: 2, item_order: fake.active.items.map(keyOf), categories: ac } };
        if (rest(src, catsRaw, own(src, 'photos') ? src.photos : {}) !== rest(published, ac, fake.active.photos)) {
          return err(400, 'unmodeled_change', { detail: 'the fake accepts a category change only as a pure rename of an otherwise unchanged published catalog (stricter than production)', field: 'categories' });
        }
      }
      fake.draft = { items: canon, photos: rk.photos, categories: cats };
      fake.sourceUpdateTime = `T${++fake.versions}`;
      const diff = diffOf();
      const token = nid('tok');
      fake.tokens.set(token, JSON.stringify(fake.draft));
      const source = { restaurant_id: fake.rid, schema_version: 1, items: clone(canon), extras: [], structure: { schema_version: 2, item_order: canon.map(keyOf), categories: clone(fake.draft.categories) } };
      if (Object.keys(rk.photos).length) source.photos = clone(rk.photos);
      return answer(200, { diff, token, updateTime: fake.sourceUpdateTime, source });
    },
    publishEdited(b) {
      if (!fake.caps.has('catalog.publish')) return err(403, 'not_owner');
      if (fake.tokens.get(b.token) !== JSON.stringify(fake.draft)) return err(409, 'edit_superseded');
      if (fake.usesPlatformFactura && b.fiscalAck !== true) return err(403, 'fiscal_ack_required');
      for (const e of Object.values(fake.draft.photos)) if (e.state === 'pid') fake.registry.get(e.pid).state = 'published';
      fake.active = { vid: `v${++fake.versions}`, items: clone(fake.draft.items), photos: clone(fake.draft.photos), categories: clone(fake.draft.categories) };
      fake.tokens.clear();
      return answer(200, { ok: true, versionId: fake.active.vid });
    },
    getBranchAvailability(q) {
      const scoped = q.restaurantId !== undefined ? q.restaurantId === fake.rid : q.brandId === fake.brandId;
      if (!scoped || !fake.caps.has('availability.set')) return err(403, 'not_authorized');
      const branch = { rid: fake.rid, published: true, items: fake.active.items.map((r) => ({ key: keyOf(r), name: (r.display && r.display.name) || keyOf(r), price: r.price, description: (r.display && r.display.desc) || '', category_id: 'cl', category_name: 'Clásicas' })), unavailable: [] };
      const ph = {};
      for (const [k, e] of Object.entries(fake.active.photos)) if (e.state === 'pid' && fake.registry.get(e.pid) && fake.registry.get(e.pid).state === 'published') ph[k] = { card: pubCard(e.pid) };
      if (Object.keys(ph).length) branch.photos = ph;
      return answer(200, { branches: [branch] });
    },
  };
  function terminal(u, code) { u.state = 'failed'; u.code = code; return err(400, code); }
  function cropError(crops, W, H) {
    if (!crops || typeof crops !== 'object') return 'shape';
    for (const [id, f] of Object.entries(FRAMES)) {
      const r = crops[id];
      if (!r || ![r.x, r.y, r.w, r.h].every(Number.isInteger)) return `${id}:int`;
      if (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) return `${id}:bounds`;
      if (Math.abs((r.w / r.h) / f.a - 1) > 0.005) return `${id}:aspect`;
      if (r.w < f.w || r.h < f.h) return `${id}:min`;
    }
    return null;
  }
  function signed(u) {
    return { uploadId: u.uploadId, url: `${GCS}/${DEFAULT_BUCKET}/uploads/${u.rid}/${u.uploadId}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=fake&X-Goog-Expires=600&X-Goog-SignedHeaders=content-type%3Bx-goog-content-length-range%3Bx-goog-if-generation-match&X-Goog-Signature=f${u.uploadId}`,
      method: 'PUT', headers: { 'Content-Type': u.contentType, 'x-goog-content-length-range': '1,10485760', 'x-goog-if-generation-match': '0' }, expiresAt: Date.now() + 600e3 };
  }
  // the diff against the ACTIVE version: prices, additions, and the three-state photo lines
  function diffOf() {
    const changed = [], added = [];
    const act = new Map(fake.active.items.map((r) => [keyOf(r), r]));
    for (const r of fake.draft.items) {
      const k = keyOf(r);
      if (!act.has(k)) { added.push({ surface: 'item', key: k, price: r.price }); continue; }
      if (act.get(k).price !== r.price) changed.push({ surface: 'item', key: k, field: 'price', old: act.get(k).price, new: r.price });
    }
    const keys = new Set([...Object.keys(fake.active.photos), ...Object.keys(fake.draft.photos)]);
    for (const k of [...keys].sort()) {
      const o = st(fake.active.photos, k), n = st(fake.draft.photos, k);
      if (!sameSt(o, n)) changed.push({ surface: 'item', key: k, field: 'photo', old: o, new: n });
    }
    // a section's display name, as the server's diff carries it (app.js reads surface 'category', field 'name', key, old, new)
    for (const r of renamesOf()) changed.push({ surface: 'category', key: r.id, field: 'name', old: r.from, new: r.to });
    return { changed, added, removed: [], renamed: [], largeChangeSet: added.map((a) => ({ surface: 'item', key: a.key })) };
  }
  function renamesOf() {
    const was = new Map(fake.active.categories.map((c) => [c.id, c.name]));
    return fake.draft.categories.filter((c) => was.has(c.id) && was.get(c.id) !== c.name).map((c) => ({ id: c.id, from: was.get(c.id), to: c.name }));
  }

  // ── fetch: the Functions host ──
  fake.fetchHandler = async (fn, body) => {
    fake.calls.push({ fn, body: clone(body) });
    const f = fake._fail.get(fn);
    if (f) { fake._fail.delete(fn); return f; }
    const h = handlers[fn];
    return h ? h(body || {}) : err(404, 'not_found');
  };
  // ── the browser's XMLHttpRequest, for the signed PUT ──
  fake.XHR = class FakeXHR {
    constructor() { this.upload = {}; this.headers = {}; this.status = 0; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    abort() { if (this.done) return; this.done = true; this.aborted = true; if (this.rec) this.rec.aborted = true; if (this.onabort) this.onabort(); }
    async send(body) {
      const rec = { url: this.url, method: this.method, headers: { ...this.headers }, size: body && body.size, aborted: false };
      this.rec = rec;
      fake.puts.push(rec);
      if (fake._hold) { const h = fake._hold; fake._hold = null; if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: Math.round(body.size * 0.62), total: body.size }); await h; }
      if (this.done) return;
      const f = fake._fail.get('PUT');
      const finish = (status) => { if (this.done) return; this.done = true; this.status = status; if (status === 0) { if (this.onerror) this.onerror(); } else if (this.onload) this.onload(); };
      if (f) { fake._fail.delete('PUT'); finish(f.status); return; }
      const m = new URL(this.url);
      const parts = m.pathname.split('/');            // /<bucket>/uploads/<rid>/<uploadId>
      const u = fake.uploads.get(parts[4]);
      const signedHeaders = u ? signed(u).headers : null;
      // the signature binds method, object and EXACTLY the signed headers: a missing or an extra header fails (403)
      if (!u || this.method !== 'PUT' || parts[1] !== DEFAULT_BUCKET || parts[2] !== 'uploads'
        || JSON.stringify(Object.keys(this.headers).sort()) !== JSON.stringify(Object.keys(signedHeaders).sort())
        || Object.entries(signedHeaders).some(([k, v]) => this.headers[k] !== v)) { finish(403); return; }
      if (!(body && body.size >= 1 && body.size <= MAX)) { finish(400); return; }
      const path = `uploads/${u.rid}/${u.uploadId}`;
      if (fake.objects.has(path)) { finish(412); return; }   // create-only
      if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: body.size, total: body.size });
      fake.objects.set(path, { size: body.size, type: body.type, sniffed: body.__sniffed, dims: body.__dims, content: body.__content || body.name });
      finish(200);
    }
  };
  return fake;
}
