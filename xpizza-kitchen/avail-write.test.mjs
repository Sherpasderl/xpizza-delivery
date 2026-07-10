// KDS Phase 2b — the availability WRITE contract golden (KDS_2B_PLAN #4/#10/#11 + the R1 #5 carve-out).
//
// Two proofs, both against the REAL code (no re-implementation):
//   A. SHAPE + ATOMICITY — loads the real xpizza-delivery.js (firebase stubbed so every update()/ref() is
//      spyable) and asserts XPD.setItemAvailability performs ONE atomic multi-path update() carrying EXACTLY
//      the two nodes with EXACTLY the shapes the deployed RTDB .validate accepts:
//        item_availability/{availKey} = { available:<bool>, updated_at:<serverTimestamp> }   (hasOnly!)
//        availability_audit/{availKey} = { available, updated_at, updated_by }                (uid ONLY here)
//      + availKey encoding applied, host-agnostic rid, and setOrderStatus writes ONLY orders/{id}.{status}.
//   B. THE CARVE-OUT — the KDS write surface is EXACTLY THREE RTDB paths and nothing else. A source scan of
//      the inline KDS module proves it invokes NO SDK write-helper besides setOrderStatus + setItemAvailability
//      (so no fourth path is reachable), and the runtime union of those two helpers' written nodes equals
//      exactly the three allowed patterns — FAILING if a fourth ever appears.
//
// Run: node avail-write.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── firebase stub (a single module exporting every name the SDK imports) ──────────
// ref(db, path) → { path } (root ref when path is undefined → ''). update(ref, obj) is recorded.
// serverTimestamp() → a unique SENTINEL so we can assert updated_at carries the sentinel (a NUMBER at
// runtime — the .validate's updated_at.isNumber()), never a literal.
const TS = Object.freeze({ __serverTimestamp: true });
const writes = [];                 // { scope, payload } per update()
const stubSrc = `
export const __TS = ${JSON.stringify(TS)};
export const __writes = globalThis.__fbWrites;
export function initializeApp() { return {}; }
export function getAuth() { return {}; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; }
export function getDatabase() { return {}; }
export function ref(_db, path) { return { path: path == null ? "" : path }; }
export function onValue() { return () => {}; }
export function set(r, v) { globalThis.__fbWrites.push({ scope: r.path, payload: { __set: v } }); return Promise.resolve(); }
export function update(r, obj) { globalThis.__fbWrites.push({ scope: r.path, payload: obj }); return Promise.resolve(); }
export function get() { return Promise.resolve({ val: () => null, exists: () => false }); }
export function remove(r) { globalThis.__fbWrites.push({ scope: r.path, payload: { __remove: true } }); return Promise.resolve(); }
export function runTransaction() { return Promise.resolve({ committed: true, snapshot: { val: () => null } }); }
export function serverTimestamp() { return globalThis.__fbTS; }
export function off() {}
`;
globalThis.__fbWrites = writes;
globalThis.__fbTS = TS;

// window.availKey — the classic-script global the SDK helper reads. Load the REAL avail-key.js.
await import('data:text/javascript,' + encodeURIComponent(readFileSync(new URL('./avail-key.js', import.meta.url), 'utf8')));
assert.equal(typeof globalThis.availKey, 'function', 'avail-key.js global loaded');

// host → x_pizza (kdsRestaurantFromHost default) so setOrderStatus takes the plain no-get path
globalThis.location = { hostname: 'xpizza-kitchen.example' };

// ── load the REAL SDK, rewriting ONLY its firebase CDN imports to the stub (order-filter.js kept real) ──
// encodeURIComponent leaves apostrophes literal; since this URL is embedded INTO the single-quoted SDK
// import specifier, force-encode any ' (%27) so it can't prematurely close that string.
const stubUrl = ('data:text/javascript,' + encodeURIComponent(stubSrc)).replace(/'/g, '%27');
let sdk = readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
sdk = sdk
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, stubUrl)
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-auth\.js/g, stubUrl)
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-database\.js/g, stubUrl)
  .replace(/from '\.\/order-filter\.js'/g, `from '${new URL('./order-filter.js', import.meta.url).href}'`);
const XPD = await import('data:text/javascript,' + encodeURIComponent(sdk));
XPD.initDelivery({});
ok('real xpizza-delivery.js loaded with firebase stubbed (order-filter kept real)');

// ═══════════ A. setItemAvailability — ONE atomic 2-path write, exact shapes ═══════════
writes.length = 0;
await XPD.setItemAvailability('x_pizza', 'Cacio e Pepe.NY', false, 'uid-123');
assert.equal(writes.length, 1, 'setItemAvailability performs EXACTLY ONE update() (atomic — both nodes in one write)');
const w = writes[0];
assert.equal(w.scope, '', 'the write is a ROOT multi-path update (ref(db)) — atomic across both nodes');
const key = globalThis.availKey('Cacio e Pepe.NY');
assert.ok(key.includes('%2E'), 'availKey encodes the "." (%2E) — the RTDB-forbidden char');
const availPath = `restaurants/x_pizza/item_availability/${key}`;
const auditPath = `restaurants/x_pizza/availability_audit/${key}`;
assert.deepEqual(Object.keys(w.payload).sort(), [auditPath, availPath].sort(), 'the update touches EXACTLY the two nodes — public flag + private audit — keyed by availKey');

// public node — EXACTLY { available, updated_at } (the .validate hasOnly(['available','updated_at']))
assert.deepEqual(Object.keys(w.payload[availPath]).sort(), ['available', 'updated_at'], 'item_availability node = EXACTLY {available, updated_at} — matches .validate hasOnly');
assert.strictEqual(w.payload[availPath].available, false, 'available is a boolean (isBoolean)');
assert.strictEqual(w.payload[availPath].updated_at, TS, 'updated_at is the serverTimestamp sentinel (isNumber at runtime)');
assert.ok(!('updated_by' in w.payload[availPath]), 'the PUBLIC node NEVER carries updated_by (no staff-identity leak)');

// audit node — { available, updated_at, updated_by } (the ONLY place uid goes)
assert.deepEqual(Object.keys(w.payload[auditPath]).sort(), ['available', 'updated_at', 'updated_by'], 'availability_audit node = {available, updated_at, updated_by}');
assert.strictEqual(w.payload[auditPath].updated_by, 'uid-123', 'the audit node carries the staff uid (private trail)');
assert.strictEqual(w.payload[auditPath].updated_at, TS, 'both nodes share the ONE serverTimestamp sentinel');
ok('setItemAvailability: ONE atomic update; public={available,updated_at} (validate-exact), audit adds updated_by; availKey applied');

// host-agnostic — the same helper writes la_musa paths with no hardcoding
writes.length = 0;
await XPD.setItemAvailability('la_musa', 'dimsum_01', true, 'uid-9');
assert.deepEqual(Object.keys(writes[0].payload).sort(), ['restaurants/la_musa/availability_audit/dimsum_01', 'restaurants/la_musa/item_availability/dimsum_01'].sort(), 'host-agnostic — a la_musa rid writes la_musa nodes');
assert.strictEqual(writes[0].payload['restaurants/la_musa/item_availability/dimsum_01'].available, true, 'available:true round-trips');
ok('setItemAvailability is host-agnostic (x_pizza AND la_musa) — rid is a parameter, nothing hardcoded');

// a missing availKey global must SURFACE (never a half-write)
const savedKey = globalThis.availKey; delete globalThis.availKey;
await assert.rejects(() => XPD.setItemAvailability('x_pizza', 'X', false, 'u'), /availKey unavailable/, 'no availKey global → throws (caller reverts), never a half-write');
globalThis.availKey = savedKey;
ok('missing availKey global → throws before any write (no half-write)');

// setOrderStatus writes ONLY orders/{id} with {status}
writes.length = 0;
const wrote = await XPD.setOrderStatus('PZX-1', 'ready');
assert.equal(wrote, true, 'setOrderStatus returns true (wrote) on x_pizza');
assert.equal(writes.length, 1, 'setOrderStatus = ONE update()');
assert.equal(writes[0].scope, 'orders/PZX-1', 'scoped to orders/{id}');
assert.deepEqual(writes[0].payload, { status: 'ready' }, 'setOrderStatus writes ONLY {status} — the order-lifecycle contract, unchanged');
ok('setOrderStatus writes ONLY orders/{id}.{status} (the first of the three allowed paths, untouched)');

// ═══════════ B. THE CARVE-OUT — the KDS write surface is EXACTLY THREE paths, fails on a 4th ═══════════
// Runtime union of the two KDS write helpers' written NODES, normalized to patterns.
const norm = (p) => p
  .replace(/^orders\/[^/]+/, 'orders/{id}')
  .replace(/^restaurants\/[^/]+\/item_availability\/[^/]+$/, 'restaurants/{rid}/item_availability/{key}')
  .replace(/^restaurants\/[^/]+\/availability_audit\/[^/]+$/, 'restaurants/{rid}/availability_audit/{key}');
const nodesOf = (wr) => wr.scope === '' ? Object.keys(wr.payload) : [wr.scope];
writes.length = 0;
await XPD.setOrderStatus('PZX-2', 'preparing');
await XPD.setItemAvailability('x_pizza', 'Margherita', false, 'u');
const surface = new Set(writes.flatMap(nodesOf).map(norm));
const ALLOWED = ['orders/{id}', 'restaurants/{rid}/item_availability/{key}', 'restaurants/{rid}/availability_audit/{key}'];
assert.deepEqual([...surface].sort(), [...ALLOWED].sort(), 'the KDS write surface is EXACTLY the three allowed RTDB paths — a fourth node would FAIL this');
ok('KDS write surface = EXACTLY 3 RTDB paths (orders/{id}.status + item_availability + availability_audit)');

// Source carve-out: the inline KDS module invokes NO SDK write-helper besides the two allowed. Derive the
// FULL set of SDK write-helpers (exported fns whose body calls a mutator), then intersect with the module's
// XPD.* usage — anything beyond {setOrderStatus, setItemAvailability} means a 4th write path is reachable.
const sdkSrc = readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
const writers = new Set();
const fnRe = /export\s+(?:async\s+)?function\s+(\w+)/g;
const marks = [];
for (let m; (m = fnRe.exec(sdkSrc)); ) marks.push({ name: m[1], idx: m.index });
for (let i = 0; i < marks.length; i++) {
  const body = sdkSrc.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : sdkSrc.length);
  if (/\b(update|set|remove|runTransaction)\s*\(/.test(body)) writers.add(marks[i].name);
}
assert.ok(writers.has('setOrderStatus') && writers.has('setItemAvailability'), 'sanity: the two allowed helpers are genuine writers');
assert.ok(writers.has('cancelOrder') && writers.has('assignOrderToDriver'), 'sanity: the writer-detector finds the OTHER SDK writers too (so the scan is real)');

const modText = readFileSync(new URL('./index.html', import.meta.url), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const usedXpd = new Set([...modText.matchAll(/XPD\.(\w+)\s*\(/g)].map(m => m[1]));
const forbiddenWritersUsed = [...usedXpd].filter(m => writers.has(m) && m !== 'setOrderStatus' && m !== 'setItemAvailability');
assert.deepEqual(forbiddenWritersUsed, [], `the KDS module invokes NO SDK writer beyond the two allowed (found: ${forbiddenWritersUsed.join(', ') || 'none'})`);
assert.ok(usedXpd.has('setOrderStatus') && usedXpd.has('setItemAvailability'), 'the KDS module DOES wire both allowed write helpers (panel + status path present)');
ok('source carve-out: KDS module calls ONLY setOrderStatus + setItemAvailability among ALL SDK writers (a 4th writer would fail)');

console.log(`avail-write: OK (${n} cases)`);
